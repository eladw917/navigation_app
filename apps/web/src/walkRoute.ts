import type { LatLng } from "./api";
import { walkEstimateBetween } from "./mergePlans";

export type WalkRouteResult = {
  coordinates: [number, number][];
  distanceMeters: number;
  durationSeconds: number;
  approximated: boolean;
};

/** Same ~11 m rounding as the API cache so client hits line up with Postgres. */
export function roundWalkCoord(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

export function walkPairKey(from: LatLng, to: LatLng): string {
  return `${roundWalkCoord(from.lng)}|${roundWalkCoord(from.lat)}|${roundWalkCoord(to.lng)}|${roundWalkCoord(to.lat)}`;
}

export function straightLineWalk(from: LatLng, to: LatLng): WalkRouteResult {
  const estimate = walkEstimateBetween(from, to);
  return {
    coordinates: [
      [from.lng, from.lat],
      [to.lng, to.lat],
    ],
    distanceMeters: estimate.meters,
    durationSeconds: estimate.seconds,
    approximated: true,
  };
}

const memory = new Map<string, WalkRouteResult>();
const inflight = new Map<string, Promise<WalkRouteResult>>();

export function peekWalkRoute(from: LatLng, to: LatLng): WalkRouteResult | null {
  return memory.get(walkPairKey(from, to)) ?? null;
}

/** Street polylines from `/v1/walk-route`. Off unless VITE_WALK_ROUTE_API=true. */
export const WALK_ROUTE_API_ENABLED =
  import.meta.env.VITE_WALK_ROUTE_API === "true";

export async function getWalkRoute(
  from: LatLng,
  to: LatLng,
  signal?: AbortSignal,
): Promise<WalkRouteResult> {
  const key = walkPairKey(from, to);
  const cached = memory.get(key);
  if (cached) return cached;

  if (!WALK_ROUTE_API_ENABLED) {
    const straight = straightLineWalk(from, to);
    memory.set(key, straight);
    return straight;
  }

  if (signal?.aborted) {
    throw Object.assign(new Error("Aborted"), { name: "AbortError" });
  }

  let pending = inflight.get(key);
  if (!pending) {
    pending = import("./api")
      .then(({ fetchWalkRoute }) => fetchWalkRoute(from, to))
      .then((response) => {
        const result: WalkRouteResult = {
          coordinates: response.geometry.coordinates,
          distanceMeters: response.distanceMeters,
          durationSeconds: response.durationSeconds,
          approximated: response.meta.approximated,
        };
        if (result.coordinates.length < 2) return straightLineWalk(from, to);
        memory.set(key, result);
        return result;
      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name === "AbortError") throw error;
        return straightLineWalk(from, to);
      })
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, pending);
  }

  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    pending
      .then((result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      })
      .catch((error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      });
  });
}

export function __resetWalkRouteMemoryForTests(): void {
  memory.clear();
  inflight.clear();
}
