import type { PlaceResult } from "@navigation/contracts";
import { ISRAEL_BOUNDS } from "@navigation/contracts";
import {
  buildQueryVariants,
  normalizeHouseNumber,
  normalizeText,
  parseAddressQuery,
  placeMatchesCity,
  streetMatchScore,
  tokenPhraseMatch,
  type ParsedAddress,
} from "./addressParse.js";
import { env } from "../config.js";
import { LruTtlCache } from "./lruCache.js";

const searchCache = new LruTtlCache<PlaceResult[]>(300, 1000 * 60 * 15);

const NOMINATIM_UA = "navigationApp/0.1 (Israeli walk+transit MVP; local-dev)";

type PeliasFeature = {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    id?: string;
    gid?: string;
    label?: string;
    name?: string;
    confidence?: number;
    locality?: string;
    localadmin?: string;
    street?: string;
    housenumber?: string;
    layer?: string;
  };
};

type NominatimItem = {
  place_id: number;
  lat: string;
  lon: string;
  display_name: string;
  importance?: number;
  class?: string;
  type?: string;
  address?: {
    city?: string;
    town?: string;
    village?: string;
    municipality?: string;
    suburb?: string;
    road?: string;
    pedestrian?: string;
    house_number?: string;
  };
};

type PhotonFeature = {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    osm_id?: number;
    osm_type?: string;
    name?: string;
    street?: string;
    housenumber?: string;
    city?: string;
    locality?: string;
    district?: string;
    state?: string;
    country?: string;
    countrycode?: string;
    type?: string;
  };
};

function inIsrael(lng: number, lat: number): boolean {
  return (
    lng >= ISRAEL_BOUNDS.minLng &&
    lng <= ISRAEL_BOUNDS.maxLng &&
    lat >= ISRAEL_BOUNDS.minLat &&
    lat <= ISRAEL_BOUNDS.maxLat
  );
}

function clampConfidence(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

function scorePlace(place: PlaceResult, parsed: ParsedAddress): number {
  let score = (place.confidence ?? 0.3) * 10;
  const label = normalizeText(place.label).toLowerCase();
  const queryHn = normalizeHouseNumber(parsed.housenumber);
  const placeHn = normalizeHouseNumber(place.housenumber);
  const streetScore = streetMatchScore(place.street, place.label, parsed);

  if (place.street) score += 5;
  if (place.city) score += 2;

  // Exact free-text containment is rare for Hebrew OSM labels; keep a mild boost.
  const rawLower = parsed.normalized.toLowerCase();
  if (label.includes(rawLower) && rawLower.length >= 4) score += 4;

  if (parsed.streetTokens.length) {
    if (streetScore >= 3) score += 34;
    else if (streetScore === 2) score += 24;
    else if (streetScore === 1) score += 6;
    else score -= 45;
  }

  if (queryHn) {
    if (placeHn && placeHn === queryHn) {
      score += streetScore > 0 ? 45 : 5;
    } else if (placeHn) {
      // Wrong house number on any street is almost always a miss.
      score -= streetScore > 0 ? 55 : 30;
    } else if (place.street && streetScore > 0) {
      // Correct street, OSM missing this house number — still useful as a near match.
      score += 14;
    }
  } else if (place.housenumber) {
    score += 3;
  }

  if (parsed.city) {
    if (placeMatchesCity(place, parsed.city)) score += 28;
    else score -= 40;
  }

  if (queryHn && place.housenumber && place.street) {
    const hn = place.housenumber.toLowerCase();
    const st = place.street.toLowerCase();
    if (
      label.startsWith(hn) ||
      label.startsWith(st) ||
      label.startsWith(`${st} ${hn}`) ||
      tokenPhraseMatch(label, `${st} ${hn}`)
    ) {
      score += 8;
    }
  }

  if (!place.street && !place.housenumber && /(ישראל|israel|מחוז)/i.test(place.label)) score -= 8;
  // Prefer address-like features over admin/region blobs when the query looks like an address.
  if (parsed.street && !place.street && !place.housenumber) score -= 10;

  if (place.source === "overpass") score += 6;
  if (place.source === "pelias" && queryHn) score -= 12;
  if (place.source === "nominatim") score += 2;
  if (place.source === "photon") score += 1;
  return score;
}

function refineResults(places: PlaceResult[], parsed: ParsedAddress): PlaceResult[] {
  const queryHn = normalizeHouseNumber(parsed.housenumber);
  let list = places;

  if (parsed.city) {
    const inCity = list.filter((p) => placeMatchesCity(p, parsed.city!));
    if (inCity.length) list = inCity;
  }

  if (parsed.streetTokens.length) {
    const matched = list.filter((p) => streetMatchScore(p.street, p.label, parsed) > 0);
    if (matched.length) list = matched;
  }

  if (queryHn) {
    const exact = list.filter((p) => normalizeHouseNumber(p.housenumber) === queryHn);
    if (exact.length) {
      const streets = list.filter((p) => !p.housenumber && p.street);
      list = [...exact, ...streets];
    } else {
      list = list.filter((p) => !p.housenumber || normalizeHouseNumber(p.housenumber) === queryHn);
    }
  }

  return list;
}

function dedupe(places: PlaceResult[]): PlaceResult[] {
  const seen = new Set<string>();
  const out: PlaceResult[] = [];
  for (const place of places) {
    const hn = normalizeHouseNumber(place.housenumber) ?? "";
    const street = normalizeText(place.street ?? "").toLowerCase();
    const city = normalizeText(place.city ?? "").toLowerCase();
    // Exact addresses collapse across providers. Street-only hits collapse per city
    // (OSM returns many nearly-identical road segments).
    const identity = street && hn
      ? `hn|${street}|${hn}|${city}`
      : street
        ? `st|${street}|${city}`
        : `g|${place.location.lng.toFixed(4)}|${place.location.lat.toFixed(4)}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push(place);
  }
  return out;
}

function normalizePelias(feature: PeliasFeature): PlaceResult | null {
  const coords = feature.geometry?.coordinates;
  if (!coords || coords.length < 2) return null;
  const [lng, lat] = coords;
  if (!inIsrael(lng, lat)) return null;
  const props = feature.properties ?? {};
  return {
    id: String(props.gid ?? props.id ?? `${lng},${lat}`),
    label: props.label ?? props.name ?? `${lat}, ${lng}`,
    location: { lng, lat },
    confidence: clampConfidence(
      typeof props.confidence === "number" ? props.confidence : undefined,
    ),
    source: "pelias",
    city: props.locality ?? props.localadmin,
    street: props.street,
    housenumber: props.housenumber,
  };
}

function nominatimCity(item: NominatimItem): string | undefined {
  return (
    item.address?.city ??
    item.address?.town ??
    item.address?.village ??
    item.address?.municipality ??
    item.address?.suburb
  );
}

function normalizeNominatim(item: NominatimItem): PlaceResult | null {
  const lng = Number(item.lon);
  const lat = Number(item.lat);
  if (!inIsrael(lng, lat)) return null;
  return {
    id: `nominatim:${item.place_id}`,
    label: item.display_name,
    location: { lng, lat },
    confidence: clampConfidence(item.importance),
    source: "nominatim",
    city: nominatimCity(item),
    street: item.address?.road ?? item.address?.pedestrian,
    housenumber: item.address?.house_number,
  };
}

function photonLabel(props: NonNullable<PhotonFeature["properties"]>): string {
  const name = props.name?.trim();
  const street = props.street?.trim();
  const housenumber = props.housenumber?.trim();
  const city = (props.city ?? props.locality ?? props.district)?.trim();

  const head = (() => {
    if (name && housenumber && street && name !== street) {
      return `${name}, ${street} ${housenumber}`;
    }
    if (name && housenumber && !street) return `${name} ${housenumber}`;
    if (street && housenumber) return `${street} ${housenumber}`;
    if (name) return name;
    if (street) return street;
    return "";
  })();

  const parts = [head, city].filter(Boolean);
  const unique = [...new Set(parts.map((p) => String(p).trim()).filter(Boolean))];
  return unique.join(", ") || "Israel place";
}

function normalizePhoton(feature: PhotonFeature): PlaceResult | null {
  const coords = feature.geometry?.coordinates;
  if (!coords || coords.length < 2) return null;
  const [lng, lat] = coords;
  if (!inIsrael(lng, lat)) return null;
  const props = feature.properties ?? {};
  const cc = (props.countrycode ?? "").toLowerCase();
  if (cc && cc !== "il") return null;
  return {
    id: `photon:${props.osm_type ?? "x"}:${props.osm_id ?? `${lng},${lat}`}`,
    label: photonLabel(props),
    location: { lng, lat },
    confidence: clampConfidence(props.housenumber ? 0.9 : props.street ? 0.75 : 0.55),
    source: "photon",
    city: props.city ?? props.locality,
    street: props.street,
    housenumber: props.housenumber,
  };
}

async function searchPelias(query: string, limit: number, signal?: AbortSignal): Promise<PlaceResult[]> {
  const url = new URL(`${env.HEIGIT_PELIAS_BASE_URL.replace(/\/$/, "")}/search`);
  url.searchParams.set("text", query);
  url.searchParams.set("size", String(limit));
  url.searchParams.set("boundary.country", "ISR");
  url.searchParams.set("focus.point.lon", "34.78");
  url.searchParams.set("focus.point.lat", "32.08");
  url.searchParams.set("lang", "he");

  const response = await fetch(url, {
    headers: {
      Authorization: env.HEIGIT_API_KEY,
      Accept: "application/json",
    },
    signal,
  });
  if (!response.ok) throw new Error(`Pelias ${response.status}`);
  const body = (await response.json()) as { features?: PeliasFeature[] };
  return (body.features ?? []).map(normalizePelias).filter((r): r is PlaceResult => r != null);
}

async function searchNominatim(query: string, limit: number, signal?: AbortSignal): Promise<PlaceResult[]> {
  const q = /\bisrael\b|ישראל/i.test(query) ? query : `${query}, Israel`;
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", q);
  url.searchParams.set("format", "json");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("countrycodes", "il");
  url.searchParams.set("dedupe", "1");

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": NOMINATIM_UA,
    },
    signal,
  });
  if (!response.ok) throw new Error(`Nominatim ${response.status}`);
  const body = (await response.json()) as NominatimItem[];
  return body.map(normalizeNominatim).filter((r): r is PlaceResult => r != null);
}

/** Structured Nominatim search — much better for street + house number + city. */
async function searchNominatimStructured(
  parsed: ParsedAddress,
  limit: number,
  signal?: AbortSignal,
): Promise<PlaceResult[]> {
  if (!parsed.street) return [];
  const url = new URL("https://nominatim.openstreetmap.org/search");
  const street = parsed.housenumber ? `${parsed.housenumber} ${parsed.street}` : parsed.street;
  url.searchParams.set("street", street);
  if (parsed.city) url.searchParams.set("city", parsed.city.nameHe);
  url.searchParams.set("country", "Israel");
  url.searchParams.set("format", "json");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("countrycodes", "il");

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": NOMINATIM_UA,
    },
    signal,
  });
  if (!response.ok) throw new Error(`Nominatim structured ${response.status}`);
  const body = (await response.json()) as NominatimItem[];
  return body.map(normalizeNominatim).filter((r): r is PlaceResult => r != null);
}

async function searchPhoton(query: string, limit: number, signal?: AbortSignal): Promise<PlaceResult[]> {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("lang", "default");
  url.searchParams.set(
    "bbox",
    `${ISRAEL_BOUNDS.minLng},${ISRAEL_BOUNDS.minLat},${ISRAEL_BOUNDS.maxLng},${ISRAEL_BOUNDS.maxLat}`,
  );

  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error(`Photon ${response.status}`);
  const body = (await response.json()) as { features?: PhotonFeature[] };
  return (body.features ?? []).map(normalizePhoton).filter((r): r is PlaceResult => r != null);
}

type OverpassElement = {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

/**
 * When free-text geocoders return the street but miss the house number, ask Overpass
 * for addr:housenumber nodes/ways near a focus point (city or street hit).
 */
async function searchOverpassHouseNumber(
  parsed: ParsedAddress,
  focus: { lng: number; lat: number },
  signal?: AbortSignal,
): Promise<PlaceResult[]> {
  if (!parsed.street || !parsed.housenumber) return [];
  const hnRaw = normalizeHouseNumber(parsed.housenumber);
  if (!hnRaw) return [];
  const hn = hnRaw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // ~3.5km box around focus — enough for a city neighborhood, small enough for Overpass.
  const pad = 0.035;
  const south = focus.lat - pad;
  const west = focus.lng - pad;
  const north = focus.lat + pad;
  const east = focus.lng + pad;

  const street = parsed.street.replace(/"/g, "");
  const streetRegex = street
    .split(/\s+/)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");

  const query = `
[out:json][timeout:12];
(
  node["addr:housenumber"~"^${hn}$",i]["addr:street"~"${streetRegex}",i](${south},${west},${north},${east});
  way["addr:housenumber"~"^${hn}$",i]["addr:street"~"${streetRegex}",i](${south},${west},${north},${east});
);
out center 8;
`.trim();

  // Public Overpass is often slow/504 — never block place search for long.
  const timeout = AbortSignal.timeout(2500);
  const combined =
    signal != null && typeof AbortSignal.any === "function"
      ? AbortSignal.any([signal, timeout])
      : timeout;

  const response = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      Accept: "application/json",
      "User-Agent": NOMINATIM_UA,
    },
    body: new URLSearchParams({ data: query }),
    signal: combined,
  });
  if (!response.ok) throw new Error(`Overpass ${response.status}`);
  const body = (await response.json()) as { elements?: OverpassElement[] };
  const out: PlaceResult[] = [];
  for (const el of body.elements ?? []) {
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (lat == null || lng == null || !inIsrael(lng, lat)) continue;
    const tags = el.tags ?? {};
    const streetName = tags["addr:street"] ?? parsed.street;
    const house = tags["addr:housenumber"] ?? parsed.housenumber;
    const city = tags["addr:city"] ?? parsed.city?.nameHe;
    const label = [streetName, house, city].filter(Boolean).join(" ");
    out.push({
      id: `overpass:${el.type}/${el.id}`,
      label,
      location: { lng, lat },
      confidence: 0.92,
      source: "overpass",
      city,
      street: streetName,
      housenumber: house,
    });
  }
  return out;
}

function pickOverpassFocus(parsed: ParsedAddress, places: PlaceResult[]): { lng: number; lat: number } | null {
  if (parsed.city?.focus) return parsed.city.focus;
  const streetHit = places.find((p) => streetMatchScore(p.street, p.label, parsed) > 0);
  if (streetHit) return streetHit.location;
  return null;
}

function needsHouseNumberLookup(parsed: ParsedAddress, places: PlaceResult[]): boolean {
  const hn = normalizeHouseNumber(parsed.housenumber);
  if (!hn || !parsed.street) return false;
  return !places.some(
    (p) =>
      normalizeHouseNumber(p.housenumber) === hn && streetMatchScore(p.street, p.label, parsed) > 0,
  );
}

async function collectProviderResults(
  parsed: ParsedAddress,
  capped: number,
  signal?: AbortSignal,
): Promise<PlaceResult[]> {
  const variants = buildQueryVariants(parsed);
  const primary = variants[0] ?? parsed.normalized;
  const secondary = variants.find((v) => v !== primary);

  const hasHouseNumber = Boolean(parsed.housenumber);
  const jobs: Array<Promise<PlaceResult[]>> = [
    searchNominatim(primary, capped, signal),
    searchPhoton(primary, capped, signal),
  ];

  if (parsed.street) {
    jobs.push(searchNominatimStructured(parsed, capped, signal));
  }
  if (secondary) {
    jobs.push(searchNominatim(secondary, capped, signal));
    jobs.push(searchPhoton(secondary, capped, signal));
  }
  // Pelias often invents wrong Israeli house numbers — only use for POI / city queries.
  if (!hasHouseNumber) {
    jobs.push(searchPelias(primary, capped, signal));
  }

  const settled = await Promise.allSettled(jobs);
  const merged: PlaceResult[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") merged.push(...result.value);
    else if (!isAbortReason(result.reason)) {
      console.warn("[geocoder] provider failed:", result.reason);
    }
  }
  return merged;
}

export async function searchPlaces(query: string, limit = 5, signal?: AbortSignal): Promise<PlaceResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  if (signal?.aborted) return [];
  const capped = Math.min(Math.max(limit, 1), 10);
  const key = `s6|${trimmed.toLowerCase()}|${capped}`;
  const hit = searchCache.get(key);
  if (hit) return hit;

  const parsed = parseAddressQuery(trimmed);
  let merged = await collectProviderResults(parsed, capped, signal);
  if (signal?.aborted) return [];

  if (needsHouseNumberLookup(parsed, merged)) {
    const focus = pickOverpassFocus(parsed, merged);
    if (focus) {
      try {
        const overpassHits = await searchOverpassHouseNumber(parsed, focus, signal);
        merged.push(...overpassHits);
      } catch (err) {
        if (!isAbortReason(err)) console.warn("[geocoder] overpass failed:", err);
      }
    }
  }

  if (signal?.aborted) return [];

  const ranked = refineResults(
    dedupe(merged)
      .map((place) => ({ place, score: scorePlace(place, parsed) }))
      .sort((a, b) => b.score - a.score)
      .map((x) => x.place),
    parsed,
  ).slice(0, capped);

  if (ranked.length) searchCache.set(key, ranked);
  return ranked;
}

function isAbortReason(reason: unknown): boolean {
  if (!reason || typeof reason !== "object") return false;
  const name = (reason as { name?: string }).name;
  return name === "AbortError" || name === "TimeoutError";
}

export async function reverseGeocode(lng: number, lat: number, signal?: AbortSignal): Promise<PlaceResult[]> {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("lon", String(lng));
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("format", "json");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("zoom", "18");

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": NOMINATIM_UA,
    },
    signal,
  });
  if (!response.ok) throw new Error(`Nominatim reverse failed (${response.status})`);
  const item = (await response.json()) as NominatimItem & { error?: string };
  if (item.error) return [];
  const normalized = normalizeNominatim(item);
  return normalized ? [normalized] : [];
}

export function __clearGeocodeCacheForTests(): void {
  searchCache.clear();
}

/** Test helpers — ranking/refine without network. */
export function __rankPlacesForTests(places: PlaceResult[], query: string): PlaceResult[] {
  const parsed = parseAddressQuery(query);
  return refineResults(
    dedupe(places)
      .map((place) => ({ place, score: scorePlace(place, parsed) }))
      .sort((a, b) => b.score - a.score)
      .map((x) => x.place),
    parsed,
  );
}
