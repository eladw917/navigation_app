import type { PlaceResult } from "@navigation/contracts";
import { ISRAEL_BOUNDS } from "@navigation/contracts";
import { env } from "../config.js";
import { LruTtlCache } from "./lruCache.js";

const searchCache = new LruTtlCache<PlaceResult[]>(300, 1000 * 60 * 15);

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
    road?: string;
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

const CITY_ALIASES: Array<{ keys: string[]; needle: RegExp }> = [
  { keys: ["תל אביב", "תל-אביב", "תל־אביב", "tel aviv", "tel-aviv"], needle: /תל[\s\-־]?אביב|tel[\s\-]?aviv/i },
  { keys: ["ירושלים", "jerusalem"], needle: /ירושלים|jerusalem/i },
  { keys: ["חיפה", "haifa"], needle: /חיפה|haifa/i },
  { keys: ["גבעתיים", "givatayim", "givataim"], needle: /גבעתיים|givatayim|givataim/i },
  { keys: ["רמת גן", "ramat gan"], needle: /רמת\s*גן|ramat\s*gan/i },
  { keys: ["באר שבע", "beer sheva"], needle: /באר\s*שבע|beer\s*sheva/i },
  { keys: ["נתניה", "netanya"], needle: /נתניה|netanya/i },
  { keys: ["ראשון לציון", "ראשון", "rishon"], needle: /ראשון|rishon/i },
  { keys: ["פתח תקווה", "petah"], needle: /פתח\s*תקווה|petah/i },
  { keys: ["חולון", "holon"], needle: /חולון|holon/i },
  { keys: ["בת ים", "bat yam"], needle: /בת\s*ים|bat\s*yam/i },
  { keys: ["הרצליה", "herzliya"], needle: /הרצליה|herzliya/i },
  { keys: ["רעננה", "raanana"], needle: /רעננה|ra'?anana/i },
  { keys: ["כפר סבא", "kfar saba"], needle: /כפר\s*סבא|kfar\s*saba/i },
  { keys: ["רחובות", "rehovot"], needle: /רחובות|rehovot/i },
  { keys: ["אשדוד", "ashdod"], needle: /אשדוד|ashdod/i },
  { keys: ["אשקלון", "ashkelon"], needle: /אשקלון|ashkelon/i },
];

function extractHouseNumber(query: string): string | null {
  // Prefer a standalone number token (avoid years / long ids).
  const matches = [...query.matchAll(/(?:^|[\s,])(\d{1,4}[א-תa-z]?)(?=$|[\s,])/gi)];
  if (!matches.length) return null;
  return matches[matches.length - 1]?.[1] ?? null;
}

function normalizeHouseNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = String(value).trim().match(/^(\d+)/);
  return m?.[1] ?? null;
}

function cityHintFromQuery(query: string): (typeof CITY_ALIASES)[number] | null {
  const q = query.toLowerCase();
  for (const city of CITY_ALIASES) {
    if (city.keys.some((k) => q.includes(k.toLowerCase()))) return city;
  }
  return null;
}

function placeMatchesCity(place: PlaceResult, city: (typeof CITY_ALIASES)[number]): boolean {
  return city.needle.test(`${place.city ?? ""} ${place.label}`);
}

function queryStreetTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((t) => t.length >= 2 && !/^\d+[א-תa-z]?$/i.test(t))
    .filter((t) => !CITY_ALIASES.some((c) => c.keys.some((k) => k.toLowerCase() === t)));
}

function placeTokenHits(place: PlaceResult, tokens: string[]): number {
  const blob = `${place.label} ${place.street ?? ""} ${place.city ?? ""}`.toLowerCase();
  return tokens.filter((t) => blob.includes(t)).length;
}

function scorePlace(place: PlaceResult, query: string): number {
  let score = (place.confidence ?? 0.3) * 10;
  const q = query.toLowerCase().trim();
  const label = place.label.toLowerCase();
  const tokens = queryStreetTokens(query);
  const queryHn = extractHouseNumber(query);
  const placeHn = normalizeHouseNumber(place.housenumber);
  const cityHint = cityHintFromQuery(query);
  const tokenHits = placeTokenHits(place, tokens);

  if (place.street) score += 5;
  if (place.city) score += 2;
  if (label.includes(q)) score += 6;

  score += tokenHits * 3;
  if (tokens.length > 0 && tokenHits === tokens.length) score += 8;
  if (tokens.length > 0 && tokenHits === 0) score -= 45; // wrong street entirely

  if (queryHn) {
    if (placeHn === normalizeHouseNumber(queryHn)) {
      score += tokenHits > 0 ? 40 : 5; // exact number only counts on a matching street
    } else if (placeHn) {
      score -= 50;
    } else if (place.street && tokenHits > 0) {
      score += 12; // correct street, OSM missing house number
    }
  } else if (place.housenumber) {
    score += 4;
  }

  if (cityHint) {
    if (placeMatchesCity(place, cityHint)) score += 25;
    else score -= 35;
  }

  if (queryHn && place.housenumber && place.street) {
    const hn = place.housenumber.toLowerCase();
    const st = place.street.toLowerCase();
    if (label.startsWith(hn) || label.startsWith(st) || label.startsWith(`${st} ${hn}`)) score += 8;
    else score -= 6;
  }

  if (!place.street && !place.housenumber && /(ישראל|israel|מחוז)/i.test(place.label)) score -= 8;
  if (place.source === "pelias" && queryHn) score -= 12;
  if (place.source === "nominatim") score += 2;
  if (place.source === "photon") score += 1;
  return score;
}

function refineResults(places: PlaceResult[], query: string): PlaceResult[] {
  const queryHn = normalizeHouseNumber(extractHouseNumber(query));
  const cityHint = cityHintFromQuery(query);
  const tokens = queryStreetTokens(query);
  let list = places;

  if (cityHint) {
    const inCity = list.filter((p) => placeMatchesCity(p, cityHint));
    if (inCity.length) list = inCity;
  }

  if (tokens.length) {
    const matched = list.filter((p) => placeTokenHits(p, tokens) > 0);
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
    const key = `${place.location.lng.toFixed(4)}|${place.location.lat.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
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
    city: item.address?.city ?? item.address?.town ?? item.address?.village,
    street: item.address?.road,
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
  // Prefer more useful feature types for transit origins/destinations
  url.searchParams.set("dedupe", "1");

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "navigationApp/0.1 (Israeli walk+transit MVP; local-dev)",
    },
    signal,
  });
  if (!response.ok) throw new Error(`Nominatim ${response.status}`);
  const body = (await response.json()) as NominatimItem[];
  return body.map(normalizeNominatim).filter((r): r is PlaceResult => r != null);
}

async function searchPhoton(query: string, limit: number, signal?: AbortSignal): Promise<PlaceResult[]> {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("lang", "default");
  // Israel bbox: minLon,minLat,maxLon,maxLat
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

export async function searchPlaces(query: string, limit = 5, signal?: AbortSignal): Promise<PlaceResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  if (signal?.aborted) return [];
  const capped = Math.min(Math.max(limit, 1), 10);
  const key = `s5|${trimmed.toLowerCase()}|${capped}`;
  const hit = searchCache.get(key);
  if (hit) return hit;

  const hasHouseNumber = Boolean(extractHouseNumber(trimmed));
  // Pelias often returns nearby wrong house numbers for Israeli streets.
  const providers = hasHouseNumber
    ? [searchNominatim(trimmed, capped, signal), searchPhoton(trimmed, capped, signal)]
    : [
        searchNominatim(trimmed, capped, signal),
        searchPhoton(trimmed, capped, signal),
        searchPelias(trimmed, capped, signal),
      ];

  const settled = await Promise.allSettled(providers);

  if (signal?.aborted) return [];

  const merged: PlaceResult[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") merged.push(...result.value);
    else if (!isAbortReason(result.reason)) {
      console.warn("[geocoder] provider failed:", result.reason);
    }
  }

  const ranked = refineResults(
    dedupe(merged)
      .map((place) => ({ place, score: scorePlace(place, trimmed) }))
      .sort((a, b) => b.score - a.score)
      .map((x) => x.place),
    trimmed,
  ).slice(0, capped);

  if (ranked.length) searchCache.set(key, ranked);
  return ranked;
}

function isAbortReason(reason: unknown): boolean {
  if (!reason || typeof reason !== "object") return false;
  return (reason as { name?: string }).name === "AbortError";
}

export async function reverseGeocode(lng: number, lat: number, signal?: AbortSignal): Promise<PlaceResult[]> {
  try {
    return await searchNominatim(`${lat}, ${lng}`, 1, signal);
  } catch {
    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.searchParams.set("lon", String(lng));
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("format", "json");
    url.searchParams.set("addressdetails", "1");
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "navigationApp/0.1 (Israeli walk+transit MVP; local-dev)",
      },
      signal,
    });
    if (!response.ok) throw new Error(`Nominatim reverse failed (${response.status})`);
    const item = (await response.json()) as NominatimItem & { error?: string };
    if (item.error) return [];
    const normalized = normalizeNominatim(item);
    return normalized ? [normalized] : [];
  }
}

export function __clearGeocodeCacheForTests(): void {
  searchCache.clear();
}
