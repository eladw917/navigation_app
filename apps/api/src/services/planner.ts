import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DirectPlanRequest, DirectRoute, RouteFrequency, ValidStop } from "@navigation/contracts";
import { pool } from "../db.js";
import { env } from "../config.js";
import { fetchWalkingIsochrone } from "./orsIsochrone.js";
import { headwayToBucket } from "./frequency.js";
import { israelLocalNow } from "./departures.js";

const here = path.dirname(fileURLToPath(import.meta.url));

async function loadSql(name: string): Promise<string> {
  const candidates = [
    path.join(here, `../repositories/${name}`),
    path.join(here, `../../src/repositories/${name}`),
  ];
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, "utf8");
    } catch {
      // try next
    }
  }
  throw new Error(`Could not load ${name}`);
}

type RouteRow = {
  route_id: string;
  route_short_name: string | null;
  route_long_name: string | null;
  route_type: number;
  direction_id: number | null;
  trip_headsign: string | null;
  trip_id: string;
  board_stop_id: string;
  board_stop_name: string;
  board_lng: number;
  board_lat: number;
  alight_stop_id: string;
  alight_stop_name: string;
  alight_lng: number;
  alight_lat: number;
  ride_duration_seconds: number | null;
  feed_version_id: string;
  imported_at: Date;
  source_sha256: string;
};

type StopRow = {
  stop_id: string;
  stop_name: string;
  lng: number;
  lat: number;
  role: "boarding" | "alighting";
  route_short_names: string[] | null;
  feed_version_id: string;
  imported_at: Date;
  source_sha256: string;
};

type ScheduleRow = {
  kind: "stop" | "route";
  stop_id: string;
  route_short_name: string | null;
  median_headway_secs: number | null;
  sample_count: number;
  departure_count: number;
};

function polygonGeoJson(featureCollection: { features: Array<Record<string, unknown>> }): string {
  const feature = featureCollection.features[0];
  if (!feature?.geometry) {
    throw new Error("Isochrone feature missing geometry");
  }
  return JSON.stringify(feature.geometry);
}

function resolveScheduleWindow(request: DirectPlanRequest): {
  hoursStart: number;
  hoursEnd: number;
  daysOfWeek: number[];
  startSecs: number;
  endSecs: number;
} {
  const hoursStart = request.hoursStart ?? 6;
  const hoursEnd = request.hoursEnd ?? 22;
  const daysOfWeek =
    request.daysOfWeek && request.daysOfWeek.length > 0
      ? [...new Set(request.daysOfWeek)].sort((a, b) => a - b)
      : [0, 1, 2, 3, 4, 5, 6];
  const startSecs = Math.max(0, hoursStart) * 3600;
  const endSecs = Math.min(48, Math.max(hoursStart + 1, hoursEnd)) * 3600;
  return { hoursStart, hoursEnd, daysOfWeek, startSecs, endSecs };
}

/**
 * Window used for headway estimates and (when filterBySchedule) "has service" filtering.
 * Default: the next hour from Israel-local now.
 * With schedule filtering: the full selected hours range on the selected days.
 */
function resolveFrequencyWindow(request: DirectPlanRequest): {
  startSecs: number;
  endSecs: number;
  daysOfWeek: number[];
} {
  if (request.filterBySchedule) {
    const hoursStart = request.hoursStart ?? 6;
    const hoursEnd = request.hoursEnd ?? 22;
    const startHour = Math.max(0, Math.min(23, hoursStart));
    const endHour = Math.min(24, Math.max(startHour + 1, hoursEnd));
    return {
      startSecs: startHour * 3600,
      endSecs: endHour * 3600,
      daysOfWeek:
        request.daysOfWeek && request.daysOfWeek.length > 0
          ? [...new Set(request.daysOfWeek)].sort((a, b) => a - b)
          : [0, 1, 2, 3, 4, 5, 6],
    };
  }
  const { dayOfWeek, nowSecs } = israelLocalNow();
  let startSecs = nowSecs;
  let endSecs = nowSecs + 3600;
  // Stay on today's GTFS clock; near midnight use the last hour of the day.
  if (endSecs > 86400) {
    startSecs = 86400 - 3600;
    endSecs = 86400;
  }
  return { startSecs, endSecs, daysOfWeek: [dayOfWeek] };
}

export async function planDirect(request: DirectPlanRequest, signal?: AbortSignal) {
  const started = Date.now();
  const warnings: string[] = [];
  const walkingAnchor =
    request.mode === "walk_transit" ? request.origin : request.destination;
  const fixedEndpoint =
    request.mode === "walk_transit" ? request.destination : request.origin;
  const locationType = request.mode === "walk_transit" ? "start" : "destination";
  const schedule = resolveScheduleWindow(request);
  const frequencyWindow = resolveFrequencyWindow(request);

  const maxWalkingSeconds = Math.min(request.maxWalkingSeconds, env.MAX_WALKING_SECONDS);
  if (maxWalkingSeconds !== request.maxWalkingSeconds) {
    warnings.push(`maxWalkingSeconds capped to ${env.MAX_WALKING_SECONDS}`);
  }

  const isochrone = await fetchWalkingIsochrone({
    lng: walkingAnchor.lng,
    lat: walkingAnchor.lat,
    rangeSeconds: maxWalkingSeconds,
    locationType,
    signal,
  });
  if (isochrone.approximated) {
    warnings.push(
      "ORS isochrone unavailable; used circular walking approximation. Rotate/renew HEIGIT_API_KEY for real network isochrones.",
    );
  }

  const polygon = polygonGeoJson(isochrone.geojson);
  const sharedParams = [
    polygon,
    fixedEndpoint.lng,
    fixedEndpoint.lat,
    env.ENDPOINT_RADIUS_METERS,
    request.mode,
    env.allowedRouteTypes,
  ] as const;

  const [reachableSql, routesSql, scheduleSql] = await Promise.all([
    loadSql("reachableStops.sql"),
    loadSql("directRoutes.sql"),
    loadSql("scheduleStats.sql"),
  ]);

  const [stopsResult, routesResult] = await Promise.all([
    pool.query<StopRow>(reachableSql, [...sharedParams]),
    pool.query<RouteRow>(routesSql, [
      ...sharedParams,
      env.PLAN_RESULT_LIMIT,
      request.origin.lng,
      request.origin.lat,
      request.destination.lng,
      request.destination.lat,
      maxWalkingSeconds,
    ]),
  ]);

  if (stopsResult.rows.length === 0 && routesResult.rows.length === 0) {
    const feed = await pool.query(
      `SELECT id, imported_at, source_sha256 FROM gtfs_feed_versions WHERE active = true LIMIT 1`,
    );
    if (!feed.rows[0]) {
      throw Object.assign(new Error("No active GTFS feed imported"), { statusCode: 503 });
    }
  }

  const stopIds = stopsResult.rows.map((row) => row.stop_id);
  let scheduleRows: ScheduleRow[] = [];
  /** False only when the stats query errors/times out — empty rows still mean "no service". */
  let scheduleStatsOk = true;
  // Frequency: count departures in the window → headway = duration/count.
  // Route cards use the boarding stop; map pins use reachable stopIds. Alighting
  // endpoints that are neither are irrelevant and can multiply this query's work.
  const scheduleStopIds = [
    ...new Set([
      ...stopIds,
      ...routesResult.rows.map((route) => route.board_stop_id),
    ]),
  ];
  if (scheduleStopIds.length) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '5000ms'");
      const scheduleResult = await client.query<ScheduleRow>(scheduleSql, [
        scheduleStopIds,
        frequencyWindow.startSecs,
        frequencyWindow.endSecs,
        frequencyWindow.daysOfWeek,
      ]);
      await client.query("COMMIT");
      scheduleRows = scheduleResult.rows;
    } catch (err) {
      scheduleStatsOk = false;
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore
      }
      warnings.push("Could not compute stop frequencies from GTFS times");
      console.error("[scheduleStats]", err);
    } finally {
      client.release();
    }
  }

  const routeHeadway = new Map<string, Map<string, RouteFrequency>>();
  const stopHeadway = new Map<string, number | null>();
  const activeRoutesByStop = new Map<string, Set<string>>();

  for (const row of scheduleRows) {
    const headway =
      row.median_headway_secs == null ? null : Number(row.median_headway_secs);
    if (row.kind === "stop") {
      stopHeadway.set(row.stop_id, headway);
      continue;
    }
    if (!row.route_short_name) continue;
    const freq: RouteFrequency = {
      routeShortName: row.route_short_name,
      headwaySeconds: headway,
      frequencyBucket: headwayToBucket(headway),
      departureCount: Number(row.departure_count) || 0,
    };
    const byRoute = routeHeadway.get(row.stop_id) ?? new Map();
    byRoute.set(row.route_short_name, freq);
    routeHeadway.set(row.stop_id, byRoute);
    const active = activeRoutesByStop.get(row.stop_id) ?? new Set();
    active.add(row.route_short_name);
    activeRoutesByStop.set(row.stop_id, active);
  }

  // Apply schedule-window filtering whenever requested. Empty stats = no service in
  // the window (hide everything). If the query failed, keep unfiltered results.
  const filterActive = Boolean(request.filterBySchedule) && scheduleStatsOk;

  let validStops: ValidStop[] = stopsResult.rows.map((row) => {
    const routeFreqMap = routeHeadway.get(row.stop_id);
    const allNames = row.route_short_names ?? [];
    const activeNames = activeRoutesByStop.get(row.stop_id);
    const routeShortNames =
      filterActive && activeNames
        ? allNames.filter((name) => activeNames.has(name))
        : filterActive
          ? []
          : allNames;
    // Include every line at the stop; unknown headway stays null (excluded from station freq).
    const routeFrequencies: RouteFrequency[] = routeShortNames.map((name) => {
      const freq = routeFreqMap?.get(name);
      return (
        freq ?? {
          routeShortName: name,
          headwaySeconds: null,
          frequencyBucket: headwayToBucket(null),
          departureCount: 0,
        }
      );
    });
    const knownHeadways = routeFrequencies
      .map((r) => r.headwaySeconds)
      .filter((h): h is number => h != null && Number.isFinite(h) && h > 0);
    const fromLines = knownHeadways.length ? Math.min(...knownHeadways) : null;
    const fromStop = stopHeadway.get(row.stop_id);
    const headwaySeconds =
      fromStop != null && Number.isFinite(fromStop) && fromStop > 0 ? fromStop : fromLines;
    return {
      stopId: row.stop_id,
      name: row.stop_name,
      lng: Number(row.lng),
      lat: Number(row.lat),
      role: row.role,
      routeShortNames,
      headwaySeconds,
      frequencyBucket: headwayToBucket(headwaySeconds),
      routeFrequencies,
    };
  });

  if (filterActive) {
    validStops = validStops.filter((s) => s.routeShortNames.length > 0);
  }

  const activeRouteNames = new Set(validStops.flatMap((s) => s.routeShortNames));

  let routes: DirectRoute[] = routesResult.rows.map((row) => {
    const shortName = row.route_short_name?.trim() || null;
    const displayName = shortName ?? row.route_id;
    const freq = routeHeadway.get(row.board_stop_id)?.get(displayName);
    return {
      routeId: row.route_id,
      routeShortName: shortName,
      routeLongName: row.route_long_name,
      routeType: Number(row.route_type),
      directionId: row.direction_id,
      tripHeadsign: row.trip_headsign,
      tripId: row.trip_id,
      boardStopId: row.board_stop_id,
      boardStopName: row.board_stop_name,
      boardLng: Number(row.board_lng),
      boardLat: Number(row.board_lat),
      alightStopId: row.alight_stop_id,
      alightStopName: row.alight_stop_name,
      alightLng: Number(row.alight_lng),
      alightLat: Number(row.alight_lat),
      headwaySeconds: freq?.headwaySeconds ?? null,
      frequencyBucket: freq?.frequencyBucket ?? headwayToBucket(null),
      rideDurationSeconds:
        row.ride_duration_seconds == null ? null : Number(row.ride_duration_seconds),
    };
  });

  if (filterActive) {
    routes = routes.filter((r) => {
      const name = r.routeShortName ?? r.routeId;
      return activeRouteNames.has(name);
    });
  }

  const feedMeta = stopsResult.rows[0]
    ? {
        id: stopsResult.rows[0].feed_version_id,
        importedAt: stopsResult.rows[0].imported_at,
        sourceSha256: stopsResult.rows[0].source_sha256,
      }
    : routesResult.rows[0]
      ? {
          id: routesResult.rows[0].feed_version_id,
          importedAt: routesResult.rows[0].imported_at,
          sourceSha256: routesResult.rows[0].source_sha256,
        }
      : null;

  if (!feedMeta) {
    const feed = await pool.query<{ id: string; imported_at: Date; source_sha256: string }>(
      `SELECT id, imported_at, source_sha256 FROM gtfs_feed_versions WHERE active = true LIMIT 1`,
    );
    const row = feed.rows[0];
    if (!row) {
      throw Object.assign(new Error("No active GTFS feed imported"), { statusCode: 503 });
    }
    return {
      feedVersion: {
        id: row.id,
        importedAt: new Date(row.imported_at).toISOString(),
        sourceSha256: row.source_sha256,
      },
      mode: request.mode,
      isochrone: isochrone.geojson,
      validStops: [],
      routes: [],
      warnings,
      meta: {
        maxWalkingSeconds,
        endpointRadiusMeters: env.ENDPOINT_RADIUS_METERS,
        isochroneCached: isochrone.cached,
        elapsedMs: Date.now() - started,
        routeCount: 0,
        validStopCount: 0,
        hoursStart: schedule.hoursStart,
        hoursEnd: schedule.hoursEnd,
        daysOfWeek: schedule.daysOfWeek,
      },
    };
  }

  return {
    feedVersion: {
      id: feedMeta.id,
      importedAt: new Date(feedMeta.importedAt).toISOString(),
      sourceSha256: feedMeta.sourceSha256,
    },
    mode: request.mode,
    isochrone: isochrone.geojson,
    validStops,
    routes,
    warnings,
    meta: {
      maxWalkingSeconds,
      endpointRadiusMeters: env.ENDPOINT_RADIUS_METERS,
      isochroneCached: isochrone.cached,
      elapsedMs: Date.now() - started,
      routeCount: routes.length,
      validStopCount: validStops.length,
      hoursStart: schedule.hoursStart,
      hoursEnd: schedule.hoursEnd,
      daysOfWeek: schedule.daysOfWeek,
    },
  };
}
