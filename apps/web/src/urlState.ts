import type { DirectRoute, LatLng, PlanMode } from "./api";

export type PlanUrlEndpoint = { label: string; location: LatLng };

export type PlanUrlRoute = {
  mode: PlanMode;
  routeId: string;
  boardStopId: string;
  alightStopId: string;
};

export type ParsedPlanUrl = {
  origin: PlanUrlEndpoint | null;
  destination: PlanUrlEndpoint | null;
  walkMinutes: number;
  route: PlanUrlRoute | null;
};

export type PlanUrlWriteState = {
  origin: PlanUrlEndpoint | null;
  destination: PlanUrlEndpoint | null;
  walkMinutes: number;
  route: DirectRoute | null;
};

const PLAN_KEYS = ["o", "d", "ol", "dl", "w", "m", "r", "b", "a"] as const;
const DEFAULT_WALK_MINUTES = 15;
const WALK_MINUTE_OPTIONS = new Set([5, 10, 15, 20, 25, 30]);

function formatCoord(n: number): string {
  return n.toFixed(6);
}

function parseLatLng(raw: string | null): LatLng | null {
  if (!raw) return null;
  const parts = raw.split(",");
  if (parts.length !== 2) return null;
  const latRaw = parts[0];
  const lngRaw = parts[1];
  if (latRaw == null || lngRaw == null) return null;
  const lat = Number(latRaw.trim());
  const lng = Number(lngRaw.trim());
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function modeToParam(mode: PlanMode): string {
  return mode === "walk_transit" ? "wt" : "tw";
}

function paramToMode(raw: string | null): PlanMode | null {
  if (raw === "wt") return "walk_transit";
  if (raw === "tw") return "transit_walk";
  return null;
}

function parseWalkMinutes(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !WALK_MINUTE_OPTIONS.has(n)) return DEFAULT_WALK_MINUTES;
  return n;
}

export function parsePlanUrl(search: string): ParsedPlanUrl {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const originLoc = parseLatLng(params.get("o"));
  const destLoc = parseLatLng(params.get("d"));
  const ol = params.get("ol")?.trim() || "";
  const dl = params.get("dl")?.trim() || "";

  const mode = paramToMode(params.get("m"));
  const routeId = params.get("r")?.trim() || "";
  const boardStopId = params.get("b")?.trim() || "";
  const alightStopId = params.get("a")?.trim() || "";
  const route =
    mode && routeId && boardStopId && alightStopId
      ? { mode, routeId, boardStopId, alightStopId }
      : null;

  return {
    origin: originLoc
      ? { label: ol || "Shared origin", location: originLoc }
      : null,
    destination: destLoc
      ? { label: dl || "Shared destination", location: destLoc }
      : null,
    walkMinutes: parseWalkMinutes(params.get("w")),
    route,
  };
}

export function matchRouteFromUrl(
  routes: DirectRoute[],
  identity: PlanUrlRoute,
): DirectRoute | null {
  const exact = routes.find(
    (r) =>
      (r.planMode ?? "walk_transit") === identity.mode &&
      r.routeId === identity.routeId &&
      r.boardStopId === identity.boardStopId &&
      r.alightStopId === identity.alightStopId,
  );
  if (exact) return exact;
  return (
    routes.find(
      (r) =>
        r.routeId === identity.routeId &&
        r.boardStopId === identity.boardStopId &&
        r.alightStopId === identity.alightStopId,
    ) ?? null
  );
}

/** Write plan share params via replaceState. Preserves unrelated params (e.g. demo). */
export function replacePlanUrl(state: PlanUrlWriteState): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  for (const key of PLAN_KEYS) url.searchParams.delete(key);

  if (state.origin) {
    const { lat, lng } = state.origin.location;
    url.searchParams.set("o", `${formatCoord(lat)},${formatCoord(lng)}`);
    if (state.origin.label.trim()) {
      url.searchParams.set("ol", state.origin.label.trim());
    }
  }
  if (state.destination) {
    const { lat, lng } = state.destination.location;
    url.searchParams.set("d", `${formatCoord(lat)},${formatCoord(lng)}`);
    if (state.destination.label.trim()) {
      url.searchParams.set("dl", state.destination.label.trim());
    }
  }
  if (state.walkMinutes !== DEFAULT_WALK_MINUTES) {
    url.searchParams.set("w", String(state.walkMinutes));
  }
  if (state.route) {
    const mode = state.route.planMode ?? "walk_transit";
    url.searchParams.set("m", modeToParam(mode));
    url.searchParams.set("r", state.route.routeId);
    url.searchParams.set("b", state.route.boardStopId);
    url.searchParams.set("a", state.route.alightStopId);
  }

  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) {
    window.history.replaceState({}, "", next);
  }
}
