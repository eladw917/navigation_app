import { env } from "../config.js";
import { pool } from "../db.js";
import { LruTtlCache } from "./lruCache.js";

export type FeatureCollection = {
  type: "FeatureCollection";
  features: Array<{
    type?: string;
    geometry?: Record<string, unknown>;
    properties?: Record<string, unknown>;
    [key: string]: unknown;
  }>;
};

export type IsochroneLocationType = "start" | "destination";

export type IsochroneResult = {
  geojson: FeatureCollection;
  cached: boolean;
  approximated?: boolean;
};

/** ~11 m at equator — better hit rate without changing walk polygons meaningfully. */
function roundCoord(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

export function isochroneCacheKey(
  lng: number,
  lat: number,
  seconds: number,
  locationType: IsochroneLocationType,
): string {
  return `foot|${roundCoord(lng)}|${roundCoord(lat)}|${seconds}|${locationType}`;
}

/** L1: hot process memory. Survives only until restart. */
const memoryCache = new LruTtlCache<FeatureCollection>(500, 1000 * 60 * 60);
/** L2: Postgres — shared across restarts / deploys. */
const DB_TTL_MS = 1000 * 60 * 60 * 24 * 7;

/** ~1.25 m/s walking speed for circular fallback when ORS is unavailable. */
function approximateCircle(lng: number, lat: number, rangeSeconds: number): FeatureCollection {
  const radiusMeters = rangeSeconds * 1.25;
  const steps = 48;
  const coords: [number, number][] = [];
  const latRad = (lat * Math.PI) / 180;
  const metersPerDegLat = 111_320;
  const metersPerDegLng = 111_320 * Math.cos(latRad);
  for (let i = 0; i <= steps; i++) {
    const angle = (2 * Math.PI * i) / steps;
    const dLng = (radiusMeters * Math.cos(angle)) / metersPerDegLng;
    const dLat = (radiusMeters * Math.sin(angle)) / metersPerDegLat;
    coords.push([lng + dLng, lat + dLat]);
  }
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {
          approximated: true,
          rangeSeconds,
          note: "Circular fallback used because ORS isochrone was unavailable",
        },
        geometry: {
          type: "Polygon",
          coordinates: [coords],
        },
      },
    ],
  };
}

async function readDbCache(key: string): Promise<FeatureCollection | null> {
  try {
    const result = await pool.query<{ geojson: FeatureCollection }>(
      `SELECT geojson
       FROM isochrone_cache
       WHERE cache_key = $1
         AND expires_at > now()
         AND approximated = false
       LIMIT 1`,
      [key],
    );
    return result.rows[0]?.geojson ?? null;
  } catch (err) {
    // Table may not exist yet before migrate; fall through to ORS.
    console.warn("[isochrone-cache] read failed:", (err as Error).message);
    return null;
  }
}

async function writeDbCache(key: string, geojson: FeatureCollection): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO isochrone_cache (cache_key, geojson, approximated, expires_at)
       VALUES ($1, $2::jsonb, false, now() + make_interval(secs => $3::double precision))
       ON CONFLICT (cache_key) DO UPDATE SET
         geojson = EXCLUDED.geojson,
         approximated = false,
         created_at = now(),
         expires_at = EXCLUDED.expires_at`,
      [key, JSON.stringify(geojson), DB_TTL_MS / 1000],
    );
  } catch (err) {
    console.warn("[isochrone-cache] write failed:", (err as Error).message);
  }
}

/** Best-effort prune of expired rows (called occasionally on write). */
async function pruneExpiredDbCache(): Promise<void> {
  try {
    await pool.query(`DELETE FROM isochrone_cache WHERE expires_at <= now()`);
  } catch {
    // ignore
  }
}

export async function fetchWalkingIsochrone(input: {
  lng: number;
  lat: number;
  rangeSeconds: number;
  locationType: IsochroneLocationType;
  signal?: AbortSignal;
}): Promise<IsochroneResult> {
  const key = isochroneCacheKey(input.lng, input.lat, input.rangeSeconds, input.locationType);

  const memHit = memoryCache.get(key);
  if (memHit) {
    return {
      geojson: memHit,
      cached: true,
      approximated: Boolean(memHit.features[0]?.properties?.approximated),
    };
  }

  const dbHit = await readDbCache(key);
  if (dbHit) {
    memoryCache.set(key, dbHit);
    return { geojson: dbHit, cached: true, approximated: false };
  }

  const url = `${env.HEIGIT_ORS_BASE_URL.replace(/\/$/, "")}/v2/isochrones/foot-walking`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: env.HEIGIT_API_KEY,
        "Content-Type": "application/json",
        Accept: "application/geo+json, application/json",
      },
      body: JSON.stringify({
        locations: [[input.lng, input.lat]],
        range: [input.rangeSeconds],
        range_type: "time",
        location_type: input.locationType,
        units: "m",
      }),
      signal: input.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw Object.assign(new Error(`ORS isochrone failed (${response.status}): ${text.slice(0, 500)}`), {
        statusCode: response.status,
      });
    }

    const geojson = (await response.json()) as FeatureCollection;
    if (!geojson?.features?.length) {
      throw new Error("ORS returned an empty isochrone");
    }
    memoryCache.set(key, geojson);
    void writeDbCache(key, geojson).then(() => {
      if (Math.random() < 0.05) void pruneExpiredDbCache();
    });
    return { geojson, cached: false, approximated: false };
  } catch (error) {
    console.warn("[ors] unavailable, using circular walking approximation:", (error as Error).message);
    const geojson = approximateCircle(input.lng, input.lat, input.rangeSeconds);
    // Do not persist approximations — retry ORS on the next request.
    return { geojson, cached: false, approximated: true };
  }
}

export function __resetIsochroneCacheForTests(): void {
  memoryCache.clear();
}
