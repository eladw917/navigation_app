import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PlanMode, TripPathResponse } from "@navigation/contracts";
import { pool } from "../db.js";
import { env } from "../config.js";

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

type StopRow = {
  stop_sequence: number;
  stop_id: string;
  stop_name: string;
  lng: number;
  lat: number;
  arrival_secs: number | null;
  departure_secs: number | null;
  on_path: boolean;
  is_board: boolean;
  is_alight: boolean;
};

type ResolveRow = {
  trip_id: string;
  board_stop_id: string;
  alight_stop_id: string;
};

export async function getTripPath(
  tripId: string,
  boardStopId: string,
  alightStopId: string,
): Promise<TripPathResponse> {
  const sql = await loadSql("tripPath.sql");
  const result = await pool.query<StopRow>(sql, [tripId, boardStopId, alightStopId]);
  if (!result.rows.length) {
    const err = new Error("Trip path not found for the given trip and stops") as Error & {
      statusCode?: number;
    };
    err.statusCode = 404;
    throw err;
  }

  const stops = result.rows.map((row) => ({
    stopId: row.stop_id,
    name: row.stop_name,
    lng: Number(row.lng),
    lat: Number(row.lat),
    stopSequence: Number(row.stop_sequence),
    onPath: Boolean(row.on_path),
    isBoard: Boolean(row.is_board),
    isAlight: Boolean(row.is_alight),
    arrivalSecs: row.arrival_secs == null ? null : Number(row.arrival_secs),
    departureSecs: row.departure_secs == null ? null : Number(row.departure_secs),
  }));

  const pathCoords = stops
    .filter((s) => s.onPath)
    .map((s) => [s.lng, s.lat] as [number, number]);

  if (pathCoords.length < 2) {
    const err = new Error("Trip path needs at least board and alight stops") as Error & {
      statusCode?: number;
    };
    err.statusCode = 404;
    throw err;
  }

  const boardRow = result.rows.find((r) => r.is_board) ?? null;
  const alightRow = result.rows.find((r) => r.is_alight) ?? null;
  const boardSecs =
    boardRow?.departure_secs ?? boardRow?.arrival_secs ?? null;
  const alightSecs =
    alightRow?.arrival_secs ?? alightRow?.departure_secs ?? null;
  const rideDurationSeconds =
    boardSecs != null && alightSecs != null && Number.isFinite(boardSecs) && Number.isFinite(alightSecs)
      ? Math.max(0, Number(alightSecs) - Number(boardSecs))
      : null;

  return {
    tripId,
    boardStopId,
    alightStopId,
    stops,
    rideDurationSeconds,
    geometry: {
      type: "LineString",
      coordinates: pathCoords,
    },
  };
}

/** UI may send `3:5` (route_type:short_name) after bus/rail dedupe; GTFS stores plain `5`. */
export function parseRouteLineKey(raw: string): {
  shortName: string;
  routeType: number | null;
} {
  const m = raw.trim().match(/^(\d+):(.+)$/);
  if (m) {
    return { routeType: Number(m[1]), shortName: m[2]!.trim() };
  }
  return { routeType: null, shortName: raw.trim() };
}

export async function resolveTripPath(input: {
  routeShortName: string;
  stopId: string;
  mode: PlanMode;
  endpointLng: number;
  endpointLat: number;
}): Promise<TripPathResponse> {
  const { shortName, routeType } = parseRouteLineKey(input.routeShortName);
  const routeTypes =
    routeType != null && Number.isFinite(routeType)
      ? [routeType]
      : env.allowedRouteTypes;
  const sql = await loadSql("resolveTrip.sql");
  const result = await pool.query<ResolveRow>(sql, [
    shortName,
    input.stopId,
    input.endpointLng,
    input.endpointLat,
    env.ENDPOINT_RADIUS_METERS,
    input.mode,
    routeTypes,
  ]);
  const row = result.rows[0];
  if (!row) {
    const err = new Error(
      `No direct trip found for bus ${shortName} at this stop`,
    ) as Error & { statusCode?: number };
    err.statusCode = 404;
    throw err;
  }
  return getTripPath(row.trip_id, row.board_stop_id, row.alight_stop_id);
}
