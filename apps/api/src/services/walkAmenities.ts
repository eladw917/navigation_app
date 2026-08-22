import { ISRAEL_BOUNDS, type WalkAmenity, type WalkAmenityCategory } from "@navigation/contracts";
import { LruTtlCache } from "./lruCache.js";

export type BBox = {
  south: number;
  west: number;
  north: number;
  east: number;
};

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
] as const;

const OVERPASS_UA = "navigationApp/0.1 (Israeli walk+transit MVP; walk-amenity filter)";

/** ~9 km — a 30 min walk isochrone plus padding; larger boxes time out on public Overpass. */
export const MAX_BBOX_SPAN_DEG = 0.08;

/** Short TTL: Overpass is already a few minutes behind OSM; don't sit on empty/stale boxes. */
const cache = new LruTtlCache<{ amenities: WalkAmenity[]; source: string }>(80, 1000 * 60 * 5);

type OverpassElement = {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

function roundBox(value: number): number {
  return Math.round(value * 1e3) / 1e3;
}

export function walkAmenityCacheKey(bbox: BBox): string {
  return `wa|${roundBox(bbox.south)}|${roundBox(bbox.west)}|${roundBox(bbox.north)}|${roundBox(bbox.east)}`;
}

export function validateWalkAmenityBbox(bbox: BBox): string | null {
  if (
    !Number.isFinite(bbox.south) ||
    !Number.isFinite(bbox.west) ||
    !Number.isFinite(bbox.north) ||
    !Number.isFinite(bbox.east)
  ) {
    return "Bounding box must be finite numbers";
  }
  if (bbox.south >= bbox.north || bbox.west >= bbox.east) {
    return "Bounding box is inverted";
  }
  if (bbox.north - bbox.south > MAX_BBOX_SPAN_DEG || bbox.east - bbox.west > MAX_BBOX_SPAN_DEG) {
    return `Bounding box must be at most ${MAX_BBOX_SPAN_DEG} degrees on each side`;
  }
  const overlapsIsrael =
    bbox.east >= ISRAEL_BOUNDS.minLng &&
    bbox.west <= ISRAEL_BOUNDS.maxLng &&
    bbox.north >= ISRAEL_BOUNDS.minLat &&
    bbox.south <= ISRAEL_BOUNDS.maxLat;
  if (!overlapsIsrael) return "Bounding box must intersect Israel";
  return null;
}

const LIFECYCLE_PREFIXES = ["disused:", "abandoned:", "demolished:", "removed:", "was:", "razed:"] as const;

function isYes(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === "yes" || v === "true" || v === "1";
}

function isEndDatePast(raw: string): boolean {
  const trimmed = raw.trim();
  const match = trimmed.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = match[2] ? Number(match[2]) : 12;
  const day = match[3] ? Number(match[3]) : 31;
  const end = Date.UTC(year, month - 1, day, 23, 59, 59);
  return Number.isFinite(end) && end < Date.now();
}

/** OSM objects that are tagged as closed, vacant, or former businesses. */
export function isOsmFeatureClosed(tags: Record<string, string> | undefined): boolean {
  if (!tags) return false;
  const shop = tags.shop?.trim().toLowerCase();
  const amenity = tags.amenity?.trim().toLowerCase();
  if (shop === "vacant" || shop === "closed" || amenity === "vacant" || amenity === "disused") {
    return true;
  }
  if (
    isYes(tags.disused) ||
    isYes(tags.abandoned) ||
    isYes(tags.demolished) ||
    isYes(tags.razed) ||
    isYes(tags.closed)
  ) {
    return true;
  }
  for (const key of Object.keys(tags)) {
    const lower = key.toLowerCase();
    if (LIFECYCLE_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  }
  const hours = tags.opening_hours?.trim().toLowerCase() ?? "";
  if (hours === "closed" || hours === "off" || /^(?:mo-su\s+)?closed$/.test(hours)) return true;
  const status = (tags.operational_status ?? tags["opening_hours:status"] ?? "").trim().toLowerCase();
  if (status === "closed" || status === "closed_permanently" || status === "permanently_closed") {
    return true;
  }
  if (tags.end_date && isEndDatePast(tags.end_date)) return true;
  return false;
}

export function classifyOsmTags(tags: Record<string, string> | undefined): WalkAmenityCategory | null {
  if (!tags || isOsmFeatureClosed(tags)) return null;
  const amenity = tags.amenity;
  const shop = tags.shop;
  const leisure = tags.leisure;

  if (amenity === "cafe" || amenity === "ice_cream" || shop === "coffee") return "cafe";
  if (shop === "bakery" || amenity === "bakery") return "bakery";
  if (
    shop === "supermarket" ||
    shop === "convenience" ||
    shop === "greengrocer" ||
    shop === "grocery"
  ) {
    return "grocery";
  }
  if (amenity === "pharmacy" || shop === "chemist") return "pharmacy";
  if (amenity === "atm" || amenity === "bank") return "atm";
  if (leisure === "park" || leisure === "playground" || leisure === "garden") return "park";
  return null;
}

function amenityDisplayName(tags: Record<string, string>, category: WalkAmenityCategory): string {
  const named = tags["name:he"]?.trim() || tags.name?.trim() || tags["name:en"]?.trim();
  if (named) return named;
  switch (category) {
    case "cafe":
      return "Cafe";
    case "grocery":
      return "Grocery";
    case "bakery":
      return "Bakery";
    case "pharmacy":
      return "Pharmacy";
    case "atm":
      return "ATM";
    case "park":
      return "Park";
  }
}

const CLOSED_OVERPASS_FILTERS =
  '["disused"!="yes"]["abandoned"!="yes"]["opening_hours"!="closed"]["opening_hours"!="off"]';

export function buildOverpassQuery(bbox: BBox): string {
  const { south, west, north, east } = bbox;
  const box = `${south},${west},${north},${east}`;
  return `
[out:json][timeout:18];
(
  node["amenity"~"^(cafe|ice_cream|pharmacy|atm|bank|bakery)$"]${CLOSED_OVERPASS_FILTERS}(${box});
  way["amenity"~"^(cafe|ice_cream|pharmacy|atm|bank|bakery)$"]${CLOSED_OVERPASS_FILTERS}(${box});
  node["shop"~"^(supermarket|convenience|bakery|greengrocer|grocery|chemist|coffee)$"]${CLOSED_OVERPASS_FILTERS}(${box});
  way["shop"~"^(supermarket|convenience|bakery|greengrocer|grocery|chemist|coffee)$"]${CLOSED_OVERPASS_FILTERS}(${box});
  node["leisure"~"^(park|playground|garden)$"]${CLOSED_OVERPASS_FILTERS}(${box});
  way["leisure"~"^(park|playground|garden)$"]${CLOSED_OVERPASS_FILTERS}(${box});
);
out center 300;
`.trim();
}

function parseOverpassElements(elements: OverpassElement[]): WalkAmenity[] {
  const out: WalkAmenity[] = [];
  const seen = new Set<string>();
  for (const el of elements) {
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (lat == null || lng == null) continue;
    const category = classifyOsmTags(el.tags);
    if (!category) continue;
    const id = `osm:${el.type}/${el.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: amenityDisplayName(el.tags ?? {}, category),
      category,
      lng,
      lat,
    });
  }
  return out;
}

function isAbortReason(err: unknown): boolean {
  return (err as { name?: string } | undefined)?.name === "AbortError";
}

async function postOverpass(
  url: string,
  query: string,
  signal: AbortSignal,
): Promise<WalkAmenity[]> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      Accept: "application/json",
      "User-Agent": OVERPASS_UA,
    },
    body: new URLSearchParams({ data: query }),
    signal,
  });
  if (!response.ok) throw new Error(`Overpass ${response.status}`);
  const body = (await response.json()) as { elements?: OverpassElement[] };
  return parseOverpassElements(body.elements ?? []);
}

export async function fetchWalkAmenities(
  bbox: BBox,
  signal?: AbortSignal,
): Promise<{ amenities: WalkAmenity[]; cached: boolean; source: string }> {
  const key = walkAmenityCacheKey(bbox);
  const hit = cache.get(key);
  if (hit) return { amenities: hit.amenities, cached: true, source: hit.source };

  const query = buildOverpassQuery(bbox);
  let lastError: unknown;
  for (const url of OVERPASS_ENDPOINTS) {
    if (signal?.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
    const timeout = AbortSignal.timeout(12_000);
    const combined =
      signal != null && typeof AbortSignal.any === "function"
        ? AbortSignal.any([signal, timeout])
        : timeout;
    try {
      const amenities = await postOverpass(url, query, combined);
      const source = new URL(url).host;
      // Empty often means a timeout/truncation — don't freeze that for the TTL.
      if (amenities.length) cache.set(key, { amenities, source });
      return { amenities, cached: false, source };
    } catch (err) {
      lastError = err;
      if (isAbortReason(err) && signal?.aborted) throw err;
      console.warn("[walk-amenities] Overpass failed:", url, (err as Error).message);
    }
  }
  throw Object.assign(new Error("Overpass amenities unavailable"), {
    statusCode: 502,
    cause: lastError,
  });
}

export function __clearWalkAmenityCacheForTests(): void {
  cache.clear();
}

export function __parseOverpassElementsForTests(elements: OverpassElement[]): WalkAmenity[] {
  return parseOverpassElements(elements);
}
