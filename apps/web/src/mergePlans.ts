import type {
  DirectPlanResponse,
  DirectRoute,
  PlanMode,
  RouteFrequency,
  ValidStop,
} from "./api";
import { headwayToBucket, stationHeadwayFromLines } from "./frequency";

function mergeRoles(
  a: ValidStop["role"],
  b: ValidStop["role"],
): ValidStop["role"] {
  if (a === b) return a;
  if (a === "both" || b === "both") return "both";
  return "both";
}

function mergeRouteFrequencies(
  a: RouteFrequency[] | undefined,
  b: RouteFrequency[] | undefined,
): RouteFrequency[] | undefined {
  if (!a?.length) return b;
  if (!b?.length) return a;
  const byName = new Map<string, RouteFrequency>();
  for (const item of [...a, ...b]) {
    const prev = byName.get(item.routeShortName);
    if (!prev) {
      byName.set(item.routeShortName, item);
      continue;
    }
    // Prefer a known headway over unknown; among known, keep the more frequent.
    const prevKnown = prev.headwaySeconds != null && prev.headwaySeconds > 0;
    const nextKnown = item.headwaySeconds != null && item.headwaySeconds > 0;
    if (nextKnown && (!prevKnown || item.headwaySeconds! < prev.headwaySeconds!)) {
      byName.set(item.routeShortName, item);
    }
  }
  return [...byName.values()];
}

function withStationFrequency(stop: ValidStop): ValidStop {
  const headwaySeconds = stationHeadwayFromLines(stop.routeFrequencies ?? []);
  return {
    ...stop,
    headwaySeconds,
    frequencyBucket: headwayToBucket(headwaySeconds),
  };
}

function tagPlan(plan: DirectPlanResponse): DirectPlanResponse {
  const mode = plan.mode;
  return {
    ...plan,
    modes: [mode],
    validStops: plan.validStops.map((s) => ({
      ...s,
      planModes: s.planModes?.length ? s.planModes : [mode],
    })),
    routes: plan.routes.map((r) => ({
      ...r,
      planMode: r.planMode ?? mode,
    })),
  };
}

function mergeStops(plans: DirectPlanResponse[]): ValidStop[] {
  const byId = new Map<string, ValidStop>();
  for (const plan of plans) {
    for (const stop of plan.validStops) {
      const mode = plan.mode;
      const existing = byId.get(stop.stopId);
      if (!existing) {
        byId.set(
          stop.stopId,
          withStationFrequency({
            ...stop,
            planModes: stop.planModes?.length ? [...stop.planModes] : [mode],
          }),
        );
        continue;
      }
      const modes = new Set([...(existing.planModes ?? []), mode, ...(stop.planModes ?? [])]);
      const buses = new Set([
        ...(existing.routeShortNames ?? []),
        ...(stop.routeShortNames ?? []),
      ]);
      byId.set(
        stop.stopId,
        withStationFrequency({
          ...existing,
          role: mergeRoles(existing.role, stop.role),
          routeShortNames: [...buses],
          planModes: [...modes],
          routeFrequencies: mergeRouteFrequencies(
            existing.routeFrequencies,
            stop.routeFrequencies,
          ),
        }),
      );
    }
  }
  return [...byId.values()];
}

function mergeRoutes(plans: DirectPlanResponse[]): DirectRoute[] {
  const seen = new Set<string>();
  const out: DirectRoute[] = [];
  for (const plan of plans) {
    for (const route of plan.routes) {
      const planMode = route.planMode ?? plan.mode;
      const key = `${planMode}|${route.routeId}|${route.boardStopId}|${route.alightStopId}|${route.tripId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...route, planMode });
    }
  }
  return out;
}

/** Merge one or more single-mode plans into a display plan (tagged routes/stops). */
export function mergePlans(plans: DirectPlanResponse[]): DirectPlanResponse | null {
  const tagged = plans.filter(Boolean).map(tagPlan);
  if (!tagged.length) return null;
  if (tagged.length === 1) return tagged[0]!;

  const modes = tagged.map((p) => p.mode);
  const routes = mergeRoutes(tagged);
  const validStops = mergeStops(tagged);
  const warnings = [...new Set(tagged.flatMap((p) => p.warnings))];
  const features = tagged.flatMap((p) =>
    (p.isochrone.features ?? []).map((f) => ({
      ...f,
      properties: {
        ...((f.properties as Record<string, unknown> | undefined) ?? {}),
        planMode: p.mode,
      },
    })),
  );

  const first = tagged[0]!;
  return {
    requestId: tagged.map((p) => p.requestId).join("+"),
    mode: modes.includes("walk_transit") ? "walk_transit" : first.mode,
    modes,
    isochrone: { type: "FeatureCollection", features },
    validStops,
    routes,
    warnings,
    meta: {
      maxWalkingSeconds: first.meta.maxWalkingSeconds,
      endpointRadiusMeters: first.meta.endpointRadiusMeters,
      isochroneCached: tagged.every((p) => p.meta.isochroneCached),
      elapsedMs: Math.max(...tagged.map((p) => p.meta.elapsedMs)),
      routeCount: routes.length,
      validStopCount: validStops.length,
      hoursStart: first.meta.hoursStart,
      hoursEnd: first.meta.hoursEnd,
      daysOfWeek: first.meta.daysOfWeek,
    },
  };
}

export function filterPlanByModes(
  byMode: Partial<Record<PlanMode, DirectPlanResponse>>,
  enabled: PlanMode[],
): DirectPlanResponse | null {
  const parts = enabled
    .map((m) => byMode[m])
    .filter((p): p is DirectPlanResponse => Boolean(p));
  return mergePlans(parts);
}

export function modeLabel(mode: PlanMode): string {
  return mode === "walk_transit" ? "Walk → Transit" : "Transit → Walk";
}

/** Matches API circular walking fallback (~1.25 m/s). */
export const WALK_SPEED_MPS = 1.25;

function haversineMeters(
  a: { lng: number; lat: number },
  b: { lng: number; lat: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function walkSecondsBetween(
  a: { lng: number; lat: number },
  b: { lng: number; lat: number },
): number {
  return haversineMeters(a, b) / WALK_SPEED_MPS;
}

/** Walk to board and walk after alight, each in seconds. */
export function walkLegsSeconds(
  route: DirectRoute,
  origin: { lng: number; lat: number },
  destination: { lng: number; lat: number },
): { toBoard: number; fromAlight: number; total: number } {
  const toBoard = walkSecondsBetween(origin, {
    lng: route.boardLng,
    lat: route.boardLat,
  });
  const fromAlight = walkSecondsBetween(
    { lng: route.alightLng, lat: route.alightLat },
    destination,
  );
  return { toBoard, fromAlight, total: toBoard + fromAlight };
}

/** @deprecated prefer walkLegsSeconds — kept for call sites that only need the sum. */
export function totalWalkSeconds(
  route: DirectRoute,
  origin: { lng: number; lat: number },
  destination: { lng: number; lat: number },
): number {
  return walkLegsSeconds(route, origin, destination).total;
}

/** Walk + ride + walk, in seconds. Ride falls back to 0 when missing (still comparable by walks). */
export function totalJourneySeconds(
  route: DirectRoute,
  origin: { lng: number; lat: number },
  destination: { lng: number; lat: number },
): number {
  const walks = walkLegsSeconds(route, origin, destination);
  const ride =
    route.rideDurationSeconds != null && Number.isFinite(route.rideDurationSeconds)
      ? Math.max(0, route.rideDurationSeconds)
      : 0;
  return walks.total + ride;
}

export type FrequencyMaxMinutes = 5 | 10 | 20 | 30 | "all";

export const FREQUENCY_MAX_OPTIONS: FrequencyMaxMinutes[] = [5, 10, 20, 30, "all"];

export type TotalTimeMaxMinutes = 30 | 45 | 60 | 90;

export const TOTAL_TIME_MAX_OPTIONS: TotalTimeMaxMinutes[] = [30, 45, 60, 90];

/** True when station headway passes the selected max. "all" keeps every station. */
export function stationPassesMaxFrequency(
  stop: Pick<ValidStop, "headwaySeconds" | "routeFrequencies" | "frequencyBucket">,
  maxMinutes: FrequencyMaxMinutes,
): boolean {
  if (maxMinutes === "all") return true;
  const headway =
    stationHeadwayFromLines(stop.routeFrequencies ?? []) ?? stop.headwaySeconds ?? null;
  if (headway == null || !Number.isFinite(headway) || headway <= 0) return false;
  const minutes = headway / 60;
  // Match circle buckets: 5/10/20 are exclusive upper bounds; 30 keeps all known (incl. 30+).
  if (maxMinutes >= 30) return true;
  return minutes < maxMinutes;
}

/**
 * Keep one option per bus line: the lowest total journey time.
 * Collapses mode duplicates (Walk→Transit vs Transit→Walk) and nearby variants.
 */
export function dedupeRoutesByBus(
  routes: DirectRoute[],
  origin: { lng: number; lat: number },
  destination: { lng: number; lat: number },
): DirectRoute[] {
  const best = new Map<string, DirectRoute>();
  for (const route of routes) {
    const bus = route.routeShortName ?? route.routeId;
    const prev = best.get(bus);
    if (!prev) {
      best.set(bus, route);
      continue;
    }
    const nextTotal = totalJourneySeconds(route, origin, destination);
    const prevTotal = totalJourneySeconds(prev, origin, destination);
    if (nextTotal < prevTotal - 0.5) {
      best.set(bus, route);
      continue;
    }
    if (Math.abs(nextTotal - prevTotal) <= 0.5) {
      // Same trip shown under both modes — keep Walk→Transit as the label.
      const nextMode = route.planMode ?? "walk_transit";
      const prevMode = prev.planMode ?? "walk_transit";
      if (nextMode === "walk_transit" && prevMode !== "walk_transit") {
        best.set(bus, route);
      }
    }
  }
  return [...best.values()].sort((a, b) => {
    const da = totalJourneySeconds(a, origin, destination);
    const db = totalJourneySeconds(b, origin, destination);
    return da - db;
  });
}

export type ResultFilters = {
  enabledModes: PlanMode[];
  limitTotalWalk: boolean;
  origin: { lng: number; lat: number } | null;
  destination: { lng: number; lat: number } | null;
  maxWalkingSeconds: number;
  /** Max headway in minutes (same tiers as pin sizes). */
  maxFrequencyMinutes: FrequencyMaxMinutes;
  /** Max walk+ride+walk journey time in minutes. */
  maxTotalTimeMinutes: TotalTimeMaxMinutes;
};

function mergeStopRoles(
  a: ValidStop["role"],
  b: ValidStop["role"],
): ValidStop["role"] {
  if (a === b) return a;
  return "both";
}

function upsertStop(byId: Map<string, ValidStop>, stop: ValidStop) {
  const existing = byId.get(stop.stopId);
  if (!existing) {
    byId.set(
      stop.stopId,
      withStationFrequency({
        ...stop,
        routeShortNames: [...(stop.routeShortNames ?? [])],
        planModes: [...(stop.planModes ?? [])],
        routeFrequencies: [...(stop.routeFrequencies ?? [])],
      }),
    );
    return;
  }
  const buses = new Set([
    ...(existing.routeShortNames ?? []),
    ...(stop.routeShortNames ?? []),
  ]);
  const modes = new Set([...(existing.planModes ?? []), ...(stop.planModes ?? [])]);
  byId.set(
    stop.stopId,
    withStationFrequency({
      ...existing,
      role: mergeStopRoles(existing.role, stop.role),
      routeShortNames: [...buses],
      planModes: [...modes],
      routeFrequencies: mergeRouteFrequencies(
        existing.routeFrequencies,
        stop.routeFrequencies,
      ),
    }),
  );
}

/** Board + alight endpoints from routes (so get-off lines always have a board pin). */
function stopsFromRoutes(routes: DirectRoute[]): ValidStop[] {
  const byId = new Map<string, ValidStop>();
  for (const route of routes) {
    const bus = route.routeShortName ?? route.routeId;
    const modes = route.planMode ? [route.planMode] : [];
    const lineFreq: RouteFrequency = {
      routeShortName: bus,
      headwaySeconds: route.headwaySeconds ?? null,
      frequencyBucket: route.frequencyBucket ?? headwayToBucket(route.headwaySeconds),
      departureCount: 0,
    };
    upsertStop(byId, {
      stopId: route.boardStopId,
      name: route.boardStopName,
      lng: route.boardLng,
      lat: route.boardLat,
      role: "boarding",
      routeShortNames: [bus],
      routeFrequencies: [lineFreq],
      planModes: modes,
    });
    upsertStop(byId, {
      stopId: route.alightStopId,
      name: route.alightStopName,
      lng: route.alightLng,
      lat: route.alightLat,
      role: "alighting",
      routeShortNames: [bus],
      routeFrequencies: [lineFreq],
      planModes: modes,
    });
  }
  return [...byId.values()];
}

/**
 * Client-side filter of an already-fetched merged plan.
 * Keeps requestId stable so the map does not refit / clear selection.
 */
export function applyResultFilters(
  fullPlan: DirectPlanResponse | null,
  filters: ResultFilters,
): DirectPlanResponse | null {
  if (!fullPlan) return null;

  const modeSet = new Set(filters.enabledModes);
  let routes = fullPlan.routes.filter((r) => {
    const mode = r.planMode ?? fullPlan.mode;
    return modeSet.has(mode);
  });

  if (
    filters.limitTotalWalk &&
    filters.origin &&
    filters.destination
  ) {
    const max = filters.maxWalkingSeconds + 0.5;
    routes = routes.filter((r) => {
      const legs = walkLegsSeconds(r, filters.origin!, filters.destination!);
      // Cap each leg (walk to stop and walk after), not only the sum.
      return legs.toBoard <= max && legs.fromAlight <= max;
    });
  }

  if (filters.origin && filters.destination) {
    const maxTotal = filters.maxTotalTimeMinutes * 60 + 0.5;
    routes = routes.filter(
      (r) => totalJourneySeconds(r, filters.origin!, filters.destination!) <= maxTotal,
    );
    // One card per bus line — keep the fastest board/alight variant.
    routes = dedupeRoutesByBus(routes, filters.origin, filters.destination);
  }

  const byId = new Map<string, ValidStop>();

  if (filters.limitTotalWalk) {
    // Symmetric: only board + get-off ends of routes that pass the walk cap.
    for (const stop of stopsFromRoutes(routes)) upsertStop(byId, stop);
  } else {
    for (const stop of fullPlan.validStops) {
      const modes = stop.planModes?.length ? stop.planModes : [fullPlan.mode];
      if (!modes.some((m) => modeSet.has(m))) continue;
      upsertStop(byId, stop);
    }
    // Ensure every listed route has both a green board pin and a red get-off pin.
    for (const stop of stopsFromRoutes(routes)) upsertStop(byId, stop);
  }

  let validStops = [...byId.values()].filter((s) =>
    stationPassesMaxFrequency(s, filters.maxFrequencyMinutes),
  );
  const allowedStopIds = new Set(validStops.map((s) => s.stopId));
  routes = routes.filter(
    (r) => allowedStopIds.has(r.boardStopId) && allowedStopIds.has(r.alightStopId),
  );
  if (filters.limitTotalWalk) {
    // Stops were built from routes — drop ends that no longer have a qualifying ride.
    const routeStopIds = new Set<string>();
    for (const r of routes) {
      routeStopIds.add(r.boardStopId);
      routeStopIds.add(r.alightStopId);
    }
    validStops = validStops.filter((s) => routeStopIds.has(s.stopId));
  }

  const features = (fullPlan.isochrone.features ?? []).filter((f) => {
    const props = (f.properties ?? {}) as { planMode?: PlanMode };
    if (!props.planMode) return true;
    return modeSet.has(props.planMode);
  });

  return {
    ...fullPlan,
    // Preserve identity used by the map for fit/selection.
    requestId: fullPlan.requestId,
    modes: filters.enabledModes,
    routes,
    validStops,
    isochrone: { type: "FeatureCollection", features },
    meta: {
      ...fullPlan.meta,
      routeCount: routes.length,
      validStopCount: validStops.length,
    },
  };
}
