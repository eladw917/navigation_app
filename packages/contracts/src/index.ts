import { z } from "zod";

export const PlanModeSchema = z.enum(["walk_transit", "transit_walk"]);
export type PlanMode = z.infer<typeof PlanModeSchema>;

export const LatLngSchema = z.object({
  lng: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
});
export type LatLng = z.infer<typeof LatLngSchema>;

export const DirectPlanRequestSchema = z.object({
  mode: PlanModeSchema,
  origin: LatLngSchema,
  destination: LatLngSchema,
  maxWalkingSeconds: z.number().int().min(60).max(3600).default(900),
  /** Hour of day 0–23 inclusive start (Israel local GTFS times). */
  hoursStart: z.number().int().min(0).max(23).optional(),
  /** Hour of day 1–24 exclusive end; defaults to 24 when hoursStart set. */
  hoursEnd: z.number().int().min(1).max(24).optional(),
  /** 0=Sunday … 6=Saturday. Empty/omitted = all days. */
  daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
  /** When true, hide lines/stops with no departures in the selected window. */
  filterBySchedule: z.boolean().optional(),
});
export type DirectPlanRequest = z.infer<typeof DirectPlanRequestSchema>;

export const FrequencyBucketSchema = z.enum([
  "under_5",
  "about_10",
  "about_20",
  "over_30",
  "unknown",
]);
export type FrequencyBucket = z.infer<typeof FrequencyBucketSchema>;

export const RouteFrequencySchema = z.object({
  routeShortName: z.string(),
  headwaySeconds: z.number().nullable(),
  frequencyBucket: FrequencyBucketSchema,
  departureCount: z.number().int().nonnegative(),
});
export type RouteFrequency = z.infer<typeof RouteFrequencySchema>;

export const PlaceResultSchema = z.object({
  id: z.string(),
  label: z.string(),
  location: LatLngSchema,
  confidence: z.number().min(0).max(1).optional(),
  source: z.string(),
  city: z.string().optional(),
  street: z.string().optional(),
  housenumber: z.string().optional(),
});
export type PlaceResult = z.infer<typeof PlaceResultSchema>;

export const PlaceSearchResponseSchema = z.object({
  results: z.array(PlaceResultSchema),
});
export type PlaceSearchResponse = z.infer<typeof PlaceSearchResponseSchema>;

export const ValidStopSchema = z.object({
  stopId: z.string(),
  name: z.string(),
  lng: z.number(),
  lat: z.number(),
  role: z.enum(["boarding", "alighting", "both"]),
  routeShortNames: z.array(z.string()).default([]),
  headwaySeconds: z.number().nullable().optional(),
  frequencyBucket: FrequencyBucketSchema.optional(),
  routeFrequencies: z.array(RouteFrequencySchema).optional(),
});
export type ValidStop = z.infer<typeof ValidStopSchema>;

export const DirectRouteSchema = z.object({
  routeId: z.string(),
  routeShortName: z.string().nullable(),
  routeLongName: z.string().nullable(),
  /** GTFS route_type (Israel: 0 light rail, 2 train, 3 bus). */
  routeType: z.number().int().nonnegative().optional(),
  directionId: z.number().nullable(),
  tripHeadsign: z.string().nullable(),
  tripId: z.string(),
  boardStopId: z.string(),
  boardStopName: z.string(),
  boardLng: z.number(),
  boardLat: z.number(),
  alightStopId: z.string(),
  alightStopName: z.string(),
  alightLng: z.number(),
  alightLat: z.number(),
  headwaySeconds: z.number().nullable().optional(),
  frequencyBucket: FrequencyBucketSchema.optional(),
  /** Board → alight riding time from GTFS stop_times (seconds). */
  rideDurationSeconds: z.number().nullable().optional(),
});
export type DirectRoute = z.infer<typeof DirectRouteSchema>;

export const DirectPlanResponseSchema = z.object({
  requestId: z.string(),
  feedVersion: z.object({
    id: z.string(),
    importedAt: z.string(),
    sourceSha256: z.string(),
  }),
  mode: PlanModeSchema,
  isochrone: z.object({
    type: z.literal("FeatureCollection"),
    features: z.array(z.any()),
  }),
  validStops: z.array(ValidStopSchema),
  routes: z.array(DirectRouteSchema),
  warnings: z.array(z.string()),
  meta: z.object({
    maxWalkingSeconds: z.number(),
    endpointRadiusMeters: z.number(),
    isochroneCached: z.boolean(),
    elapsedMs: z.number(),
    routeCount: z.number(),
    validStopCount: z.number(),
    hoursStart: z.number().optional(),
    hoursEnd: z.number().optional(),
    daysOfWeek: z.array(z.number()).optional(),
  }),
});
export type DirectPlanResponse = z.infer<typeof DirectPlanResponseSchema>;

export const AppConfigSchema = z.object({
  israelBounds: z.object({
    minLng: z.number(),
    minLat: z.number(),
    maxLng: z.number(),
    maxLat: z.number(),
  }),
  defaultWalkingSeconds: z.number(),
  maxWalkingSeconds: z.number(),
  endpointRadiusMeters: z.number(),
  allowedRouteTypes: z.array(z.number()),
  feedImportedAt: z.string().nullable(),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

export const GtfsStatusSchema = z.object({
  active: z
    .object({
      id: z.string(),
      sourceUrl: z.string(),
      sourceSha256: z.string(),
      importedAt: z.string(),
      stopCount: z.number().nullable(),
      routeCount: z.number().nullable(),
      tripCount: z.number().nullable(),
      stopTimeCount: z.number().nullable(),
      validationNotes: z.string().nullable(),
    })
    .nullable(),
  hasActiveFeed: z.boolean(),
});
export type GtfsStatus = z.infer<typeof GtfsStatusSchema>;

export const HealthResponseSchema = z.object({
  status: z.enum(["ok", "degraded", "error"]),
  database: z.boolean(),
  timestamp: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const TripStopSchema = z.object({
  stopId: z.string(),
  name: z.string(),
  lng: z.number(),
  lat: z.number(),
  stopSequence: z.number().int(),
  onPath: z.boolean(),
  isBoard: z.boolean(),
  isAlight: z.boolean(),
  arrivalSecs: z.number().nullable().optional(),
  departureSecs: z.number().nullable().optional(),
});
export type TripStop = z.infer<typeof TripStopSchema>;

export const TripPathResponseSchema = z.object({
  tripId: z.string(),
  boardStopId: z.string(),
  alightStopId: z.string(),
  stops: z.array(TripStopSchema),
  /** Scheduled ride time from board departure to alight arrival (GTFS seconds). */
  rideDurationSeconds: z.number().nullable().optional(),
  geometry: z.object({
    type: z.literal("LineString"),
    coordinates: z.array(z.tuple([z.number(), z.number()])),
  }),
});
export type TripPathResponse = z.infer<typeof TripPathResponseSchema>;

/** One scheduled departure at a boarding stop (static GTFS, not realtime). */
export const ScheduledDepartureSchema = z.object({
  tripId: z.string(),
  /** Seconds since local midnight of the service day (may exceed 86400). */
  departureSecs: z.number().int().nonnegative(),
  /** 0 = service day today, 1 = tomorrow (Israel local). */
  dayOffset: z.number().int().min(0).max(1),
  /** Display clock time HH:MM in Asia/Jerusalem. */
  timeLabel: z.string(),
  dayLabel: z.enum(["Today", "Tomorrow"]),
});
export type ScheduledDeparture = z.infer<typeof ScheduledDepartureSchema>;

export const StopDeparturesResponseSchema = z.object({
  stopId: z.string(),
  alightStopId: z.string(),
  routeId: z.string().nullable(),
  routeShortName: z.string(),
  timezone: z.literal("Asia/Jerusalem"),
  /** Seconds since Israel local midnight at query time. */
  nowSecs: z.number().int().nonnegative(),
  nextDeparture: ScheduledDepartureSchema.nullable(),
  /** All board departures in the next 24 hours for this board→alight pair. */
  departures: z.array(ScheduledDepartureSchema),
});
export type StopDeparturesResponse = z.infer<typeof StopDeparturesResponseSchema>;

/** OSM amenities that can appear on a walk-to-stop / walk-from-stop corridor. */
export const WalkAmenityCategorySchema = z.enum([
  "cafe",
  "grocery",
  "bakery",
  "pharmacy",
  "atm",
  "park",
]);
export type WalkAmenityCategory = z.infer<typeof WalkAmenityCategorySchema>;

export const WalkAmenitySchema = z.object({
  id: z.string(),
  name: z.string(),
  category: WalkAmenityCategorySchema,
  lng: z.number(),
  lat: z.number(),
});
export type WalkAmenity = z.infer<typeof WalkAmenitySchema>;

export const WalkAmenitiesResponseSchema = z.object({
  amenities: z.array(WalkAmenitySchema),
  meta: z.object({
    cached: z.boolean(),
    elapsedMs: z.number(),
    source: z.string(),
  }),
});
export type WalkAmenitiesResponse = z.infer<typeof WalkAmenitiesResponseSchema>;

/** Street-network walk (ORS Directions) with a straight-line fallback. */
export const WalkRouteResponseSchema = z.object({
  from: LatLngSchema,
  to: LatLngSchema,
  distanceMeters: z.number().nonnegative(),
  durationSeconds: z.number().nonnegative(),
  geometry: z.object({
    type: z.literal("LineString"),
    coordinates: z.array(z.tuple([z.number(), z.number()])).min(2),
  }),
  meta: z.object({
    cached: z.boolean(),
    approximated: z.boolean(),
    elapsedMs: z.number(),
    source: z.enum(["ors", "straight_line"]),
  }),
});
export type WalkRouteResponse = z.infer<typeof WalkRouteResponseSchema>;

/** Approximate Israel bounding box used for request validation. */
export const ISRAEL_BOUNDS = {
  minLng: 34.2,
  minLat: 29.4,
  maxLng: 35.95,
  maxLat: 33.35,
} as const;

export function isInsideIsrael(point: LatLng): boolean {
  return (
    point.lng >= ISRAEL_BOUNDS.minLng &&
    point.lng <= ISRAEL_BOUNDS.maxLng &&
    point.lat >= ISRAEL_BOUNDS.minLat &&
    point.lat <= ISRAEL_BOUNDS.maxLat
  );
}
