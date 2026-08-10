import type {
  DirectPlanResponse,
  DirectRoute,
  LatLng,
  PlanMode,
  StopDeparturesResponse,
} from "../api";
import { routeOptionKey } from "../mergePlans";

export type DemoEndpoints = {
  origin: { label: string; location: LatLng };
  destination: { label: string; location: LatLng };
};

const DEMO_ORIGIN: LatLng = { lng: 34.7754, lat: 32.0756 };

function circleIsochrone(center: LatLng, radiusDeg = 0.012): DirectPlanResponse["isochrone"] {
  const ring: [number, number][] = [];
  for (let i = 0; i <= 24; i += 1) {
    const angle = (i / 24) * Math.PI * 2;
    ring.push([
      center.lng + radiusDeg * Math.cos(angle),
      center.lat + radiusDeg * Math.sin(angle) * 0.72,
    ]);
  }
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { planMode: "walk_transit" },
        geometry: { type: "Polygon", coordinates: [ring] },
      },
    ],
  };
}

const VALID_STOPS = [
  {
    stopId: "demo-board-1",
    name: "Ibn Gabirol / Dizengoff",
    lng: 34.7784,
    lat: 32.0761,
    role: "boarding" as const,
    routeShortNames: ["5"],
    headwaySeconds: 360,
    frequencyBucket: "under_5" as const,
  },
  {
    stopId: "demo-board-2",
    name: "Arlozorov / Ibn Gabirol",
    lng: 34.7812,
    lat: 32.0788,
    role: "boarding" as const,
    routeShortNames: ["18"],
    headwaySeconds: 420,
    frequencyBucket: "about_10" as const,
  },
  {
    stopId: "demo-board-3",
    name: "Dizengoff / Frishman",
    lng: 34.7748,
    lat: 32.0774,
    role: "both" as const,
    routeShortNames: ["63"],
    headwaySeconds: 480,
    frequencyBucket: "about_10" as const,
  },
  {
    stopId: "demo-alight-1",
    name: "Menachem Begin / Azrieli",
    lng: 34.7898,
    lat: 32.0741,
    role: "alighting" as const,
    routeShortNames: ["5"],
    headwaySeconds: 360,
    frequencyBucket: "under_5" as const,
  },
  {
    stopId: "demo-alight-2",
    name: "HaShalom / Azrieli",
    lng: 34.7915,
    lat: 32.0732,
    role: "alighting" as const,
    routeShortNames: ["18"],
    headwaySeconds: 420,
    frequencyBucket: "about_10" as const,
  },
  {
    stopId: "demo-alight-3",
    name: "Kaplan / Azrieli",
    lng: 34.7886,
    lat: 32.0726,
    role: "alighting" as const,
    routeShortNames: ["63"],
    headwaySeconds: 480,
    frequencyBucket: "about_10" as const,
  },
];

const DEMO_ROUTES: DirectRoute[] = [
  {
    routeId: "demo-5",
    routeShortName: "5",
    routeLongName: "Tel Aviv — Reading",
    routeType: 3,
    directionId: 0,
    tripHeadsign: "Reading Terminal",
    tripId: "demo-trip-5",
    boardStopId: "demo-board-1",
    boardStopName: "Ibn Gabirol / Dizengoff",
    boardLng: 34.7784,
    boardLat: 32.0761,
    alightStopId: "demo-alight-1",
    alightStopName: "Menachem Begin / Azrieli",
    alightLng: 34.7898,
    alightLat: 32.0741,
    headwaySeconds: 360,
    frequencyBucket: "under_5",
    rideDurationSeconds: 11 * 60,
    planMode: "walk_transit",
  },
  {
    routeId: "demo-18",
    routeShortName: "18",
    routeLongName: "Tel Aviv — Central Station",
    routeType: 3,
    directionId: 0,
    tripHeadsign: "Central Bus Station",
    tripId: "demo-trip-18",
    boardStopId: "demo-board-2",
    boardStopName: "Arlozorov / Ibn Gabirol",
    boardLng: 34.7812,
    boardLat: 32.0788,
    alightStopId: "demo-alight-2",
    alightStopName: "HaShalom / Azrieli",
    alightLng: 34.7915,
    alightLat: 32.0732,
    headwaySeconds: 420,
    frequencyBucket: "about_10",
    rideDurationSeconds: 14 * 60,
    planMode: "transit_walk",
  },
  {
    routeId: "demo-63",
    routeShortName: "63",
    routeLongName: "Tel Aviv — Bat Yam",
    routeType: 3,
    directionId: 1,
    tripHeadsign: "Bat Yam",
    tripId: "demo-trip-63",
    boardStopId: "demo-board-3",
    boardStopName: "Dizengoff / Frishman",
    boardLng: 34.7748,
    boardLat: 32.0774,
    alightStopId: "demo-alight-3",
    alightStopName: "Kaplan / Azrieli",
    alightLng: 34.7886,
    alightLat: 32.0726,
    headwaySeconds: 480,
    frequencyBucket: "about_10",
    rideDurationSeconds: 9 * 60,
    planMode: "walk_transit",
  },
  {
    routeId: "demo-189",
    routeShortName: "189",
    routeLongName: "Tel Aviv — Holon",
    routeType: 3,
    directionId: 0,
    tripHeadsign: "Holon",
    tripId: "demo-trip-189",
    boardStopId: "demo-board-4",
    boardStopName: "Ben Yehuda / Dizengoff",
    boardLng: 34.7719,
    boardLat: 32.0748,
    alightStopId: "demo-alight-4",
    alightStopName: "Ayalon / Shalom",
    alightLng: 34.7938,
    alightLat: 32.0738,
    headwaySeconds: 720,
    frequencyBucket: "about_20",
    rideDurationSeconds: 12 * 60,
    planMode: "transit_walk",
  },
];

function planForMode(mode: PlanMode, routes: DirectRoute[]): DirectPlanResponse {
  return {
    requestId: `demo-${mode}`,
    mode,
    modes: ["walk_transit", "transit_walk"],
    isochrone: circleIsochrone(DEMO_ORIGIN),
    validStops: VALID_STOPS,
    routes,
    warnings: [],
    meta: {
      maxWalkingSeconds: 15 * 60,
      endpointRadiusMeters: 400,
      isochroneCached: true,
      elapsedMs: 842,
      routeCount: routes.length,
      validStopCount: VALID_STOPS.length,
    },
  };
}

function mockDepartures(route: DirectRoute, minutesFromNow: number): StopDeparturesResponse {
  const now = new Date();
  const nowSecs = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  const departureSecs = nowSecs + minutesFromNow * 60;
  const hh = String(Math.floor(departureSecs / 3600) % 24).padStart(2, "0");
  const mm = String(Math.floor((departureSecs % 3600) / 60)).padStart(2, "0");
  const dep = {
    tripId: route.tripId,
    departureSecs,
    dayOffset: 0,
    timeLabel: `${hh}:${mm}`,
    dayLabel: "Today" as const,
  };
  return {
    stopId: route.boardStopId,
    alightStopId: route.alightStopId,
    routeId: route.routeId,
    routeShortName: route.routeShortName ?? route.routeId,
    timezone: "Asia/Jerusalem",
    nowSecs,
    nextDeparture: dep,
    departures: [dep],
  };
}

export function isDemoUrl(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has("demo");
}

export function buildDemoState(): {
  endpoints: DemoEndpoints;
  plansByMode: Partial<Record<PlanMode, DirectPlanResponse>>;
  departuresByKey: Record<string, StopDeparturesResponse>;
  selectedRoute: DirectRoute;
  departuresFetchedSig: string;
} {
  const endpoints: DemoEndpoints = {
    origin: {
      label: "Dizengoff St 50, Tel Aviv",
      location: DEMO_ORIGIN,
    },
    destination: {
      label: "Azrieli Center, Tel Aviv",
      location: { lng: 34.7923, lat: 32.0743 },
    },
  };

  const walkTransitRoutes = DEMO_ROUTES.filter((r) => r.planMode === "walk_transit");
  const transitWalkRoutes = DEMO_ROUTES.filter((r) => r.planMode === "transit_walk");

  const plansByMode: Partial<Record<PlanMode, DirectPlanResponse>> = {
    walk_transit: planForMode("walk_transit", walkTransitRoutes),
    transit_walk: planForMode("transit_walk", transitWalkRoutes),
  };

  const departuresByKey: Record<string, StopDeparturesResponse> = {};
  const nextMinutes = [2, 4, 7, 11];
  DEMO_ROUTES.forEach((r, i) => {
    departuresByKey[routeOptionKey(r)] = mockDepartures(r, nextMinutes[i] ?? 8);
  });

  return {
    endpoints,
    plansByMode,
    departuresByKey,
    selectedRoute: DEMO_ROUTES[0]!,
    departuresFetchedSig: DEMO_ROUTES.map(routeOptionKey).join("|"),
  };
}
