/** Shared frequency display helpers (mirrors API bucketing). */

export type FrequencyBucket =
  | "under_5"
  | "about_10"
  | "about_20"
  | "over_30"
  | "unknown"
  | "none";

/** Boarding pin radius matching the get-off disc. */
export const DEFAULT_PIN_RADIUS = 11;

/**
 * @param emptyWindow true when we successfully counted 0 departures in the hour
 * (as opposed to missing / failed stats).
 */
export function headwayToBucket(
  headwaySeconds: number | null | undefined,
  emptyWindow = false,
): FrequencyBucket {
  if (headwaySeconds == null || !Number.isFinite(headwaySeconds) || headwaySeconds <= 0) {
    return emptyWindow ? "none" : "unknown";
  }
  const minutes = headwaySeconds / 60;
  if (minutes < 5) return "under_5";
  if (minutes < 10) return "about_10";
  if (minutes < 20) return "about_20";
  return "over_30";
}

/**
 * Station frequency from its lines: unknown / null line headways are ignored.
 * Returns null when no line has a known frequency.
 */
export function stationHeadwayFromLines(
  lines: Array<{ headwaySeconds?: number | null } | null | undefined>,
): number | null {
  const known = lines
    .map((l) => l?.headwaySeconds)
    .filter((h): h is number => h != null && Number.isFinite(h) && h > 0);
  if (!known.length) return null;
  return Math.min(...known);
}

/** Best pin/chip bucket for a station: known headway wins, else all-none, else unknown. */
export function stationFrequencyBucket(
  lines: Array<
    | { headwaySeconds?: number | null; frequencyBucket?: FrequencyBucket }
    | null
    | undefined
  >,
): FrequencyBucket {
  const headway = stationHeadwayFromLines(lines);
  if (headway != null) return headwayToBucket(headway);
  const buckets = lines
    .map((l) => l?.frequencyBucket)
    .filter((b): b is FrequencyBucket => b != null);
  if (buckets.length > 0 && buckets.every((b) => b === "none")) return "none";
  return "unknown";
}

export function formatHeadway(
  headwaySeconds: number | null | undefined,
  bucket?: FrequencyBucket,
): string {
  if (bucket === "none") return "No buses in the next hour";
  if (headwaySeconds == null || !Number.isFinite(headwaySeconds) || headwaySeconds <= 0) {
    return "Frequency unknown";
  }
  const minutes = Math.round(headwaySeconds / 60);
  if (minutes < 5) return `About every ${Math.max(1, minutes)} min`;
  if (minutes < 10) return "About every 10 min";
  if (minutes < 20) return "About every 20 min";
  return "Every 30+ min";
}

export function bucketRadius(bucket: FrequencyBucket | string | undefined): number {
  switch (bucket) {
    case "under_5":
      return 16;
    case "about_10":
      return 14;
    case "about_20":
      return 12;
    case "over_30":
    case "unknown":
    case "none":
    default:
      return DEFAULT_PIN_RADIUS;
  }
}
