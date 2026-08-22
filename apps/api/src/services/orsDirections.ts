import { env } from "../config.js";
import { pool } from "../db.js";
import { LruTtlCache } from "./lruCache.js";

/** Matches isochrone circular fallback and UI walk estimates (~1.25 m/s). */
export const WALK_SPEED_MPS = 1.25;

/** Skip HeiGIT for hops shorter than this — not worth a Directions credit. */
const MIN_ROUTE_METERS = 20;
/** Street walks in this app are short; longer hops fall back to a straight line. */
const MAX_ROUTE_METERS = 8_000;

export type WalkRoutePayload = {
  coordinates: [number, number][];
  distanceMeters: number;
  durationSeconds: number;
};

export type WalkRouteResult = WalkRoutePayload & {
  cached: boolean;
  approximated: boolean;
  source: "ors" | "straight_line";
};

/** ~11 m at equator — same rounding as isochrones so nearby stops share a cache row. */
export function roundCoord(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

export function walkRouteCacheKey(
  fromLng: number,
  fromLat: number,
  toLng: number,
  toLat: number,
): string {
  return `foot-dir|${roundCoord(fromLng)}|${roundCoord(fromLat)}|${roundCoord(toLng)}|${roundCoord(toLat)}`;
}

const memoryCache = new LruTtlCache<WalkRoutePayload>(500, 1000 * 60 * 60);
const DB_TTL_MS = 1000 * 60 * 60 * 24 * 7;

export function haversineMeters(
  from: { lng: number; lat: number },
  to: { lng: number; lat: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6_371_000;
  const dLat = toRad(to.lat - from.lat);
  const dLng = toRad(to.lng - from.lng);
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function straightLineWalk(
  from: { lng: number; lat: number },
  to: { lng: number; lat: number },
): WalkRoutePayload {
  const distanceMeters = haversineMeters(from, to);
  return {
    coordinates: [
      [from.lng, from.lat],
      [to.lng, to.lat],
    ],
    distanceMeters,
    durationSeconds: distanceMeters / WALK_SPEED_MPS,
  };
}

function asLngLatPair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const lng = Number(value[0]);
  const lat = Number(value[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return [lng, lat];
}

function parseOrsGeoJson(body: unknown): WalkRoutePayload | null {
  const feature = (body as { features?: Array<Record<string, unknown>> })?.features?.[0];
  if (!feature) return null;
  const geometry = feature.geometry as { type?: string; coordinates?: unknown } | undefined;
  if (geometry?.type !== "LineString" || !Array.isArray(geometry.coordinates)) return null;
  const coordinates: [number, number][] = [];
  for (const raw of geometry.coordinates) {
    const pair = asLngLatPair(raw);
    if (pair) coordinates.push(pair);
  }
  if (coordinates.length < 2) return null;
  const properties = (feature.properties ?? {}) as {
    summary?: { distance?: number; duration?: number };
    segments?: Array<{ distance?: number; duration?: number }>;
  };
  const distanceMeters =
    Number(properties.summary?.distance ?? properties.segments?.[0]?.distance) || 0;
  const durationSeconds =
    Number(properties.summary?.duration ?? properties.segments?.[0]?.duration) || 0;
  if (!(distanceMeters > 0) || !(durationSeconds > 0)) return null;
  return { coordinates, distanceMeters, durationSeconds };
}

function isWalkRoutePayload(value: unknown): value is WalkRoutePayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as WalkRoutePayload;
  return (
    Array.isArray(payload.coordinates) &&
    payload.coordinates.length >= 2 &&
    Number.isFinite(payload.distanceMeters) &&
    Number.isFinite(payload.durationSeconds)
  );
}

async function readDbCache(key: string): Promise<WalkRoutePayload | null> {
  try {
    const result = await pool.query<{ payload: unknown }>(
      `SELECT payload
       FROM walk_route_cache
       WHERE cache_key = $1
         AND expires_at > now()
       LIMIT 1`,
      [key],
    );
    const payload = result.rows[0]?.payload;
    return isWalkRoutePayload(payload) ? payload : null;
  } catch (err) {
    console.warn("[walk-route-cache] read failed:", (err as Error).message);
    return null;
  }
}

async function writeDbCache(key: string, payload: WalkRoutePayload): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO walk_route_cache (cache_key, payload, expires_at)
       VALUES ($1, $2::jsonb, now() + make_interval(secs => $3::double precision))
       ON CONFLICT (cache_key) DO UPDATE SET
         payload = EXCLUDED.payload,
         created_at = now(),
         expires_at = EXCLUDED.expires_at`,
      [key, JSON.stringify(payload), DB_TTL_MS / 1000],
    );
  } catch (err) {
    console.warn("[walk-route-cache] write failed:", (err as Error).message);
  }
}

async function pruneExpiredDbCache(): Promise<void> {
  try {
    await pool.query(`DELETE FROM walk_route_cache WHERE expires_at <= now()`);
  } catch {
    // ignore
  }
}

function fallbackResult(
  from: { lng: number; lat: number },
  to: { lng: number; lat: number },
): WalkRouteResult {
  return {
    ...straightLineWalk(from, to),
    cached: false,
    approximated: true,
    source: "straight_line",
  };
}

export async function fetchWalkingRoute(input: {
  from: { lng: number; lat: number };
  to: { lng: number; lat: number };
  signal?: AbortSignal;
}): Promise<WalkRouteResult> {
  const from = input.from;
  const to = input.to;
  const key = walkRouteCacheKey(from.lng, from.lat, to.lng, to.lat);

  const memHit = memoryCache.get(key);
  if (memHit) {
    return { ...memHit, cached: true, approximated: false, source: "ors" };
  }

  const dbHit = await readDbCache(key);
  if (dbHit) {
    memoryCache.set(key, dbHit);
    return { ...dbHit, cached: true, approximated: false, source: "ors" };
  }

  const crowFlies = haversineMeters(from, to);
  if (crowFlies < MIN_ROUTE_METERS || crowFlies > MAX_ROUTE_METERS) {
    return fallbackResult(from, to);
  }
  if (env.HEIGIT_API_KEY === "missing") {
    return fallbackResult(from, to);
  }

  const url = `${env.HEIGIT_ORS_BASE_URL.replace(/\/$/, "")}/v2/directions/foot-walking/geojson`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: env.HEIGIT_API_KEY,
        "Content-Type": "application/json",
        Accept: "application/geo+json, application/json",
      },
      body: JSON.stringify({
        coordinates: [
          [from.lng, from.lat],
          [to.lng, to.lat],
        ],
        instructions: false,
        elevation: false,
      }),
      signal: input.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw Object.assign(new Error(`ORS directions failed (${response.status}): ${text.slice(0, 500)}`), {
        statusCode: response.status,
      });
    }

    const payload = parseOrsGeoJson(await response.json());
    if (!payload) throw new Error("ORS returned an empty walking route");
    memoryCache.set(key, payload);
    void writeDbCache(key, payload).then(() => {
      if (Math.random() < 0.05) void pruneExpiredDbCache();
    });
    return { ...payload, cached: false, approximated: false, source: "ors" };
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") throw error;
    console.warn("[ors] directions unavailable, using straight-line walk:", (error as Error).message);
    return fallbackResult(from, to);
  }
}

export function __resetWalkRouteCacheForTests(): void {
  memoryCache.clear();
}
