import type {
  DirectPlanResponse,
  DirectRoute,
  PlanMode,
  RouteFrequency,
  StopDeparturesResponse,
  ValidStop,
} from "./api";
import {
  isNextDepartureSoon,
  pickNextCatchableDeparture,
} from "./formatDeparture";
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

/** Straight-line walk estimate between two points (same speed as journey walks). */
export function walkEstimateBetween(
  a: { lng: number; lat: number },
  b: { lng: number; lat: number },
): { meters: number; seconds: number; minutes: number } {
  const meters = haversineMeters(a, b);
  const seconds = meters / WALK_SPEED_MPS;
  return {
    meters,
    seconds,
    minutes: walkMinutesDisplayed(seconds),
  };
}

export function formatWalkDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return "—";
  if (meters < 1000) return `${Math.max(10, Math.round(meters / 10) * 10)} m`;
  const km = meters / 1000;
  return `${km >= 10 ? km.toFixed(0) : km.toFixed(1)} km`;
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

/** Displayed walk minutes — matches RouteResults / TransitMap rounding. */
export function walkMinutesDisplayed(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}

/** Walk seconds after the same minute rounding used for next-bus catchability. */
export function roundedWalkSeconds(seconds: number): number {
  return walkMinutesDisplayed(seconds) * 60;
}

export function routeOptionKey(route: DirectRoute): string {
  const mode = route.planMode ?? "walk_transit";
  return `${mode}-${route.routeId}-${route.boardStopId}-${route.alightStopId}`;
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

/** True when a route's line headway passes the selected max. "all" keeps every route. */
export function routePassesMaxFrequency(
  route: Pick<DirectRoute, "headwaySeconds" | "frequencyBucket">,
  maxMinutes: FrequencyMaxMinutes,
): boolean {
  if (maxMinutes === "all") return true;
  const headway = route.headwaySeconds;
  if (headway != null && Number.isFinite(headway) && headway > 0) {
    return headway / 60 <= maxMinutes;
  }
  // Fall back to API bucket when the numeric headway is missing.
  switch (route.frequencyBucket) {
    case "under_5":
      return maxMinutes >= 5;
    case "about_10":
      return maxMinutes >= 10;
    case "about_20":
      return maxMinutes >= 20;
    case "over_30":
      return maxMinutes >= 30;
    default:
      return false;
  }
}

/** True when station headway passes the selected max. "all" keeps every station. */
export function stationPassesMaxFrequency(
  stop: Pick<ValidStop, "headwaySeconds" | "routeFrequencies" | "frequencyBucket">,
  maxMinutes: FrequencyMaxMinutes,
): boolean {
  if (maxMinutes === "all") return true;
  const headway =
    stationHeadwayFromLines(stop.routeFrequencies ?? []) ?? stop.headwaySeconds ?? null;
  if (headway == null || !Number.isFinite(headway) || headway <= 0) return false;
  return headway / 60 <= maxMinutes;
}

/**
 * Keep one option per transit line: the lowest total journey time.
 * Key includes GTFS route_type so bus "1" and light rail "1" stay separate.
 * Collapses mode duplicates (Walk→Transit vs Transit→Walk) and nearby variants.
 */
export function lineDedupeKey(route: Pick<DirectRoute, "routeShortName" | "routeId" | "routeType">): string {
  const type = route.routeType ?? 3;
  const name = route.routeShortName?.trim() || route.routeId;
  return `${type}:${name}`;
}

export function routeTypeLabel(routeType: number | null | undefined): string {
  switch (routeType) {
    case 0:
      return "Light rail";
    case 2:
      return "Train";
    case 3:
      return "Bus";
    case 5:
      return "Cable / funicular";
    case 6:
      return "Aerial lift";
    case 7:
      return "Funicular";
    case 8:
      return "Share taxi";
    default:
      return "Transit";
  }
}

export function routeBadgeLabel(route: Pick<DirectRoute, "routeShortName" | "routeId" | "routeType">): string {
  const name = route.routeShortName?.trim();
  if (route.routeType === 2) return name || "Train";
  if (route.routeType === 0) return name ? `LR ${name}` : "Light rail";
  return name || route.routeId;
}

export function dedupeRoutesByBus(
  routes: DirectRoute[],
  origin: { lng: number; lat: number },
  destination: { lng: number; lat: number },
): DirectRoute[] {
  const best = new Map<string, DirectRoute>();
  for (const route of routes) {
    const key = lineDedupeKey(route);
    const prev = best.get(key);
    if (!prev) {
      best.set(key, route);
      continue;
    }
    const nextTotal = totalJourneySeconds(route, origin, destination);
    const prevTotal = totalJourneySeconds(prev, origin, destination);
    if (nextTotal < prevTotal - 0.5) {
      best.set(key, route);
      continue;
    }
    if (Math.abs(nextTotal - prevTotal) <= 0.5) {
      // Same trip shown under both modes — keep Walk→Transit as the label.
      const nextMode = route.planMode ?? "walk_transit";
      const prevMode = prev.planMode ?? "walk_transit";
      if (nextMode === "walk_transit" && prevMode !== "walk_transit") {
        best.set(key, route);
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
    // Match TransitMap routeBusName so chips / resolve use the same keys.
    const type = route.routeType ?? 3;
    const plain = route.routeShortName?.trim() || route.routeId;
    const bus = `${type}:${plain}`;
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
    // "Walks ≤ N min" = total walking (to board + after alight), matching the slider budget.
    const maxSecs = filters.maxWalkingSeconds + 0.5;
    const maxMins = Math.round(filters.maxWalkingSeconds / 60);
    routes = routes.filter((r) => {
      const legs = walkLegsSeconds(r, filters.origin!, filters.destination!);
      const total = legs.toBoard + legs.fromAlight;
      return total <= maxSecs && walkMinutesDisplayed(total) <= maxMins;
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

  // Frequency is a per-line property — filter routes, then rebuild pins from survivors.
  if (filters.maxFrequencyMinutes !== "all") {
    routes = routes.filter((r) =>
      routePassesMaxFrequency(r, filters.maxFrequencyMinutes),
    );
  }

  const byId = new Map<string, ValidStop>();

  // When walk-limited or frequency-filtered, only show ends of surviving routes.
  // Otherwise keep isochrone stops (exploration) and ensure every route has both pins.
  if (filters.limitTotalWalk || filters.maxFrequencyMinutes !== "all") {
    for (const stop of stopsFromRoutes(routes)) upsertStop(byId, stop);
  } else {
    for (const stop of fullPlan.validStops) {
      const modes = stop.planModes?.length ? stop.planModes : [fullPlan.mode];
      if (!modes.some((m) => modeSet.has(m))) continue;
      upsertStop(byId, stop);
    }
    for (const stop of stopsFromRoutes(routes)) upsertStop(byId, stop);
  }

  let validStops = [...byId.values()];
  if (filters.limitTotalWalk || filters.maxFrequencyMinutes !== "all") {
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

/**
 * Drop routes with no catchable departure soon enough to be a real plan-now option.
 * Call only after board departures have loaded; rebuilds validStops from survivors.
 */
export function filterPlanByCatchableDepartures(
  plan: DirectPlanResponse | null,
  departuresByKey: Record<string, StopDeparturesResponse>,
  origin: { lng: number; lat: number } | null,
  destination: { lng: number; lat: number } | null,
): DirectPlanResponse | null {
  if (!plan) return null;

  const routes = plan.routes.filter((route) => {
    const key = routeOptionKey(route);
    const deps = departuresByKey[key];
    if (!deps?.departures?.length) return false;
    const walkToBoardSecs =
      origin && destination
        ? roundedWalkSeconds(walkLegsSeconds(route, origin, destination).toBoard)
        : 0;
    const next = pickNextCatchableDeparture(
      deps.departures,
      deps.nowSecs,
      walkToBoardSecs,
    );
    return isNextDepartureSoon(next, deps.nowSecs);
  });

  const byId = new Map<string, ValidStop>();
  for (const stop of stopsFromRoutes(routes)) upsertStop(byId, stop);
  const validStops = [...byId.values()];

  return {
    ...plan,
    requestId: plan.requestId,
    routes,
    validStops,
    meta: {
      ...plan.meta,
      routeCount: routes.length,
      validStopCount: validStops.length,
    },
  };
}
