import { env } from "../config.js";
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

function roundCoord(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

function cacheKey(lng: number, lat: number, seconds: number, locationType: IsochroneLocationType): string {
  return `foot|${roundCoord(lng)}|${roundCoord(lat)}|${seconds}|${locationType}`;
}

const cache = new LruTtlCache<FeatureCollection>(200, 1000 * 60 * 30);

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

export async function fetchWalkingIsochrone(input: {
  lng: number;
  lat: number;
  rangeSeconds: number;
  locationType: IsochroneLocationType;
  signal?: AbortSignal;
}): Promise<IsochroneResult> {
  const key = cacheKey(input.lng, input.lat, input.rangeSeconds, input.locationType);
  const hit = cache.get(key);
  if (hit) {
    return { geojson: hit, cached: true, approximated: Boolean(hit.features[0]?.properties?.approximated) };
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
    cache.set(key, geojson);
    return { geojson, cached: false, approximated: false };
  } catch (error) {
    console.warn("[ors] unavailable, using circular walking approximation:", (error as Error).message);
    const geojson = approximateCircle(input.lng, input.lat, input.rangeSeconds);
    cache.set(key, geojson);
    return { geojson, cached: false, approximated: true };
  }
}

export function __resetIsochroneCacheForTests(): void {
  cache.clear();
}
