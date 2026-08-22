import type { DirectPlanResponse, DirectRoute, LatLng, WalkAmenity } from "./api";

export type { WalkAmenity };
export type WalkAmenityCategory = WalkAmenity["category"];
export type WalkAmenityFilter = "any" | WalkAmenityCategory;

export type AmenityBBox = {
  south: number;
  west: number;
  north: number;
  east: number;
};

/** Must stay <= API MAX_BBOX_SPAN_DEG. */
const MAX_BBOX_SPAN_DEG = 0.08;
const BBOX_PAD_DEG = 0.0015;
/** How far a POI can sit off the origin↔stop (or stop↔dest) line and still count. */
export const WALK_CORRIDOR_METERS = 90;
export const PARK_CORRIDOR_METERS = 140;

export const WALK_AMENITY_OPTIONS: { value: WalkAmenityFilter; label: string }[] = [
  { value: "any", label: "Any" },
  { value: "cafe", label: "Cafe" },
  { value: "grocery", label: "Grocery" },
  { value: "bakery", label: "Bakery" },
  { value: "pharmacy", label: "Pharmacy" },
  { value: "atm", label: "ATM" },
  { value: "park", label: "Park" },
];

export const WALK_AMENITY_LABELS: Record<WalkAmenityCategory, string> = {
  cafe: "Cafe",
  grocery: "Grocery",
  bakery: "Bakery",
  pharmacy: "Pharmacy",
  atm: "ATM",
  park: "Park",
};

export function mergeWalkAmenities(lists: WalkAmenity[][]): WalkAmenity[] {
  const byId = new Map<string, WalkAmenity>();
  for (const list of lists) {
    for (const amenity of list) byId.set(amenity.id, amenity);
  }
  return [...byId.values()];
}

function appendCoordinatePoints(value: unknown, points: LatLng[]): void {
  if (!Array.isArray(value)) return;
  if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    points.push({ lng: value[0], lat: value[1] });
    return;
  }
  for (const child of value) appendCoordinatePoints(child, points);
}

function toXY(point: LatLng, origin: LatLng): { x: number; y: number } {
  const latRad = (origin.lat * Math.PI) / 180;
  return {
    x: (point.lng - origin.lng) * 111_320 * Math.cos(latRad),
    y: (point.lat - origin.lat) * 110_540,
  };
}

/** Distance from `point` to the closest location on segment `from`→`to`, in meters. */
export function pointToSegmentMeters(point: LatLng, from: LatLng, to: LatLng): number {
  const start = toXY(from, from);
  const end = toXY(to, from);
  const p = toXY(point, from);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1) return Math.hypot(p.x - start.x, p.y - start.y);
  const t = Math.max(0, Math.min(1, ((p.x - start.x) * dx + (p.y - start.y) * dy) / len2));
  return Math.hypot(p.x - (start.x + t * dx), p.y - (start.y + t * dy));
}

export function amenityOnWalk(
  amenity: WalkAmenity,
  from: LatLng,
  to: LatLng,
): boolean {
  const max = amenity.category === "park" ? PARK_CORRIDOR_METERS : WALK_CORRIDOR_METERS;
  return pointToSegmentMeters(amenity, from, to) <= max;
}

export type WalkCorridor = { from: LatLng; to: LatLng };

export function amenitiesAlongCorridors(
  amenities: WalkAmenity[],
  corridors: WalkCorridor[],
): WalkAmenity[] {
  if (!corridors.length) return [];
  const matched = new Map<string, WalkAmenity>();
  for (const amenity of amenities) {
    if (corridors.some((corridor) => amenityOnWalk(amenity, corridor.from, corridor.to))) {
      matched.set(amenity.id, amenity);
    }
  }
  return [...matched.values()];
}

/** Walking legs that belong to a station: origin→board, alight→destination, or both. */
export function stationWalkCorridors(input: {
  station: LatLng;
  origin: LatLng | null;
  destination: LatLng | null;
  kind: "board" | "alight" | "both";
}): WalkCorridor[] {
  const corridors: WalkCorridor[] = [];
  if ((input.kind === "board" || input.kind === "both") && input.origin) {
    corridors.push({ from: input.origin, to: input.station });
  }
  if ((input.kind === "alight" || input.kind === "both") && input.destination) {
    corridors.push({ from: input.station, to: input.destination });
  }
  return corridors;
}

function routeWalkCorridors(
  route: DirectRoute,
  origin: LatLng,
  destination: LatLng,
): WalkCorridor[] {
  // Straight chords — same geometry as the amenity filter. Street polylines
  // from Directions are display-only and must not change which lines match.
  return [
    { from: origin, to: { lng: route.boardLng, lat: route.boardLat } },
    { from: { lng: route.alightLng, lat: route.alightLat }, to: destination },
  ];
}

export function amenityWalkLegs(
  amenity: WalkAmenity,
  origin: LatLng,
  destination: LatLng,
  route: DirectRoute,
): { toBoard: boolean; fromAlight: boolean } {
  const [toBoard, fromAlight] = routeWalkCorridors(route, origin, destination);
  return {
    toBoard: toBoard ? amenityOnWalk(amenity, toBoard.from, toBoard.to) : false,
    fromAlight: fromAlight ? amenityOnWalk(amenity, fromAlight.from, fromAlight.to) : false,
  };
}

export function routeHasWalkAmenity(
  route: DirectRoute,
  amenities: WalkAmenity[],
  category: WalkAmenityCategory,
  origin: LatLng,
  destination: LatLng,
): boolean {
  const corridors = routeWalkCorridors(route, origin, destination);
  return amenities.some(
    (amenity) =>
      amenity.category === category &&
      corridors.some((corridor) => amenityOnWalk(amenity, corridor.from, corridor.to)),
  );
}

export function amenitiesAlongRouteWalks(
  routes: DirectRoute[],
  amenities: WalkAmenity[],
  category: WalkAmenityCategory,
  origin: LatLng,
  destination: LatLng,
): WalkAmenity[] {
  const matched = new Map<string, WalkAmenity>();
  for (const route of routes) {
    const corridors = routeWalkCorridors(route, origin, destination);
    for (const amenity of amenities) {
      if (amenity.category !== category) continue;
      if (!corridors.some((corridor) => amenityOnWalk(amenity, corridor.from, corridor.to))) {
        continue;
      }
      matched.set(amenity.id, amenity);
    }
  }
  return [...matched.values()];
}

function clampSpan(min: number, max: number, limit: number): [number, number] {
  if (max - min <= limit) return [min, max];
  const mid = (min + max) / 2;
  const half = limit / 2;
  return [mid - half, mid + half];
}

function boxFromPoints(points: LatLng[]): AmenityBBox | null {
  if (!points.length) return null;
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
    west = Math.min(west, p.lng);
    east = Math.max(east, p.lng);
  }
  if (!Number.isFinite(south)) return null;
  south -= BBOX_PAD_DEG;
  north += BBOX_PAD_DEG;
  west -= BBOX_PAD_DEG;
  east += BBOX_PAD_DEG;
  [south, north] = clampSpan(south, north, MAX_BBOX_SPAN_DEG);
  [west, east] = clampSpan(west, east, MAX_BBOX_SPAN_DEG);
  return { south, west, north, east };
}

function boxesOverlapOrNear(a: AmenityBBox, b: AmenityBBox): boolean {
  const union = {
    south: Math.min(a.south, b.south),
    west: Math.min(a.west, b.west),
    north: Math.max(a.north, b.north),
    east: Math.max(a.east, b.east),
  };
  return (
    union.north - union.south <= MAX_BBOX_SPAN_DEG &&
    union.east - union.west <= MAX_BBOX_SPAN_DEG
  );
}

function mergeBoxes(a: AmenityBBox, b: AmenityBBox): AmenityBBox {
  return {
    south: Math.min(a.south, b.south),
    west: Math.min(a.west, b.west),
    north: Math.max(a.north, b.north),
    east: Math.max(a.east, b.east),
  };
}

function boxAroundPoint(point: LatLng, padDeg: number): AmenityBBox {
  return {
    south: point.lat - padDeg,
    north: point.lat + padDeg,
    west: point.lng - padDeg,
    east: point.lng + padDeg,
  };
}

/**
 * One bbox per isochrone (origin walk and/or destination walk).
 * Nearby polygons collapse into a single Overpass query.
 * Always include origin and destination so the alight walk is not missed
 * when only the boarding isochrone was returned.
 */
export function bboxesFromPlan(
  plan: DirectPlanResponse,
  origin: LatLng | null,
  destination: LatLng | null,
): AmenityBBox[] {
  const extras = [origin, destination].filter((p): p is LatLng => Boolean(p));
  const boxes: AmenityBBox[] = [];
  for (const feature of plan.isochrone.features ?? []) {
    const points: LatLng[] = [...extras];
    const geometry = (feature as { geometry?: { coordinates?: unknown } }).geometry;
    appendCoordinatePoints(geometry?.coordinates, points);
    const box = boxFromPoints(points);
    if (box) boxes.push(box);
  }
  const walkPad = 0.018;
  if (origin) boxes.push(boxAroundPoint(origin, walkPad));
  if (destination) boxes.push(boxAroundPoint(destination, walkPad));
  if (!boxes.length) {
    const fallback = boxFromPoints(extras);
    return fallback ? [fallback] : [];
  }

  const merged: AmenityBBox[] = [];
  for (const box of boxes) {
    const idx = merged.findIndex((existing) => boxesOverlapOrNear(existing, box));
    if (idx >= 0) merged[idx] = mergeBoxes(merged[idx]!, box);
    else merged.push(box);
  }
  return merged.map((box) => {
    const [south, north] = clampSpan(box.south, box.north, MAX_BBOX_SPAN_DEG);
    const [west, east] = clampSpan(box.west, box.east, MAX_BBOX_SPAN_DEG);
    return { south, north, west, east };
  });
}

/**
 * Keep routes whose walking leg passes a selected OSM amenity.
 * Matching uses the origin↔stop / stop↔dest chord on purpose — not the street
 * path from Directions — so the Cafe/Grocery filter does not depend on ORS
 * and does not change after a station is selected.
 */
export function filterPlanByWalkAmenity(
  plan: DirectPlanResponse | null,
  amenities: WalkAmenity[],
  category: WalkAmenityFilter,
  origin: LatLng | null,
  destination: LatLng | null,
): DirectPlanResponse | null {
  if (!plan) return null;
  if (category === "any" || !origin || !destination) return plan;

  const routes = plan.routes.filter((route) =>
    routeHasWalkAmenity(route, amenities, category, origin, destination),
  );
  const routeStopIds = new Set<string>();
  for (const route of routes) {
    routeStopIds.add(route.boardStopId);
    routeStopIds.add(route.alightStopId);
  }
  const validStops = plan.validStops.filter((stop) => routeStopIds.has(stop.stopId));
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
