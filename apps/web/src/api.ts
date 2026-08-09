export type LatLng = { lng: number; lat: number };
export type PlanMode = "walk_transit" | "transit_walk";
export type FrequencyBucket = "under_5" | "about_10" | "about_20" | "over_30" | "unknown";

export type PlaceResult = {
  id: string;
  label: string;
  location: LatLng;
  confidence?: number;
  source: string;
  city?: string;
  street?: string;
  housenumber?: string;
};

export type RouteFrequency = {
  routeShortName: string;
  headwaySeconds: number | null;
  frequencyBucket: FrequencyBucket;
  departureCount: number;
};

export type ValidStop = {
  stopId: string;
  name: string;
  lng: number;
  lat: number;
  role: "boarding" | "alighting" | "both";
  routeShortNames?: string[];
  headwaySeconds?: number | null;
  frequencyBucket?: FrequencyBucket;
  routeFrequencies?: RouteFrequency[];
  /** Modes this stop came from when both walk→transit and transit→walk are shown. */
  planModes?: PlanMode[];
};

export type DirectRoute = {
  routeId: string;
  routeShortName: string | null;
  routeLongName: string | null;
  directionId: number | null;
  tripHeadsign: string | null;
  tripId: string;
  boardStopId: string;
  boardStopName: string;
  boardLng: number;
  boardLat: number;
  alightStopId: string;
  alightStopName: string;
  alightLng: number;
  alightLat: number;
  headwaySeconds?: number | null;
  frequencyBucket?: FrequencyBucket;
  /** Board → alight riding time from GTFS (seconds). */
  rideDurationSeconds?: number | null;
  /** Which plan produced this option (for filtering / trip resolve). */
  planMode?: PlanMode;
};

export type TripStop = {
  stopId: string;
  name: string;
  lng: number;
  lat: number;
  stopSequence: number;
  onPath: boolean;
  isBoard: boolean;
  isAlight: boolean;
  arrivalSecs?: number | null;
  departureSecs?: number | null;
};

export type TripPathResponse = {
  tripId: string;
  boardStopId: string;
  alightStopId: string;
  stops: TripStop[];
  rideDurationSeconds?: number | null;
  geometry: {
    type: "LineString";
    coordinates: [number, number][];
  };
};

export type ScheduledDeparture = {
  tripId: string;
  departureSecs: number;
  dayOffset: number;
  timeLabel: string;
  dayLabel: "Today" | "Tomorrow";
};

export type StopDeparturesResponse = {
  stopId: string;
  alightStopId: string;
  routeId: string | null;
  routeShortName: string;
  timezone: "Asia/Jerusalem";
  nowSecs: number;
  nextDeparture: ScheduledDeparture | null;
  departures: ScheduledDeparture[];
};

export type DirectPlanResponse = {
  requestId: string;
  mode: PlanMode;
  /** Modes included in this (possibly merged) plan. */
  modes?: PlanMode[];
  isochrone: {
    type: "FeatureCollection";
    features: Array<Record<string, unknown>>;
  };
  validStops: ValidStop[];
  routes: DirectRoute[];
  warnings: string[];
  meta: {
    maxWalkingSeconds: number;
    endpointRadiusMeters: number;
    isochroneCached: boolean;
    elapsedMs: number;
    routeCount: number;
    validStopCount: number;
    hoursStart?: number;
    hoursEnd?: number;
    daysOfWeek?: number[];
  };
};

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

function assertJsonResponse(response: Response, bodyText: string): void {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json") && bodyText.trimStart().startsWith("<")) {
    throw new Error(
      `API returned HTML instead of JSON from ${response.url}. Is the transit API running on port 3010? (Haiku on :3000/:3001 can steal those ports.)`,
    );
  }
}

async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { signal });
  const text = await response.text();
  assertJsonResponse(response, text);
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Invalid JSON from ${path}`);
  }
  if (!response.ok) {
    const err = body as { error?: string };
    throw new Error(err.error ?? `Request failed (${response.status})`);
  }
  return body as T;
}

export async function searchPlaces(query: string, limit = 5, signal?: AbortSignal) {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return apiGet<{ results: PlaceResult[] }>(`/v1/places/search?${params}`, signal);
}

export async function planDirect(
  body: {
    mode: PlanMode;
    origin: LatLng;
    destination: LatLng;
    maxWalkingSeconds: number;
    hoursStart?: number;
    hoursEnd?: number;
    daysOfWeek?: number[];
    filterBySchedule?: boolean;
  },
  signal?: AbortSignal,
): Promise<DirectPlanResponse> {
  const response = await fetch(`${API_BASE}/v1/plans/direct`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  assertJsonResponse(response, text);
  let payload: DirectPlanResponse & { error?: string };
  try {
    payload = JSON.parse(text) as DirectPlanResponse & { error?: string };
  } catch {
    throw new Error("Plan endpoint returned invalid JSON");
  }
  if (!response.ok) {
    throw new Error(payload.error ?? `Plan failed (${response.status})`);
  }
  return payload;
}

export async function fetchHealth() {
  return apiGet<{ status: string; database: boolean }>("/health");
}

export async function fetchTripPath(
  tripId: string,
  boardStopId: string,
  alightStopId: string,
  signal?: AbortSignal,
): Promise<TripPathResponse> {
  const params = new URLSearchParams({ boardStopId, alightStopId });
  return apiGet<TripPathResponse>(
    `/v1/trips/${encodeURIComponent(tripId)}/path?${params}`,
    signal,
  );
}

export async function resolveTripPath(
  input: {
    routeShortName: string;
    stopId: string;
    mode: PlanMode;
    endpointLng: number;
    endpointLat: number;
  },
  signal?: AbortSignal,
): Promise<TripPathResponse> {
  const params = new URLSearchParams({
    routeShortName: input.routeShortName,
    stopId: input.stopId,
    mode: input.mode,
    endpointLng: String(input.endpointLng),
    endpointLat: String(input.endpointLat),
  });
  return apiGet<TripPathResponse>(`/v1/trips/resolve-path?${params}`, signal);
}

export async function fetchBoardDepartures(
  input: {
    stopId: string;
    alightStopId: string;
    routeShortName: string;
    routeId?: string | null;
  },
  signal?: AbortSignal,
): Promise<StopDeparturesResponse> {
  const params = new URLSearchParams({
    stopId: input.stopId,
    alightStopId: input.alightStopId,
    routeShortName: input.routeShortName,
  });
  if (input.routeId) params.set("routeId", input.routeId);
  return apiGet<StopDeparturesResponse>(`/v1/departures?${params}`, signal);
}
