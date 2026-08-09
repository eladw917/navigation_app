/** Shared frequency display helpers (mirrors API bucketing). */

export type FrequencyBucket = "under_5" | "about_10" | "about_20" | "over_30" | "unknown";

export function headwayToBucket(headwaySeconds: number | null | undefined): FrequencyBucket {
  if (headwaySeconds == null || !Number.isFinite(headwaySeconds) || headwaySeconds <= 0) {
    return "unknown";
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

export function formatHeadway(headwaySeconds: number | null | undefined): string {
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
      return 11;
    case "about_10":
      return 9;
    case "about_20":
      return 7;
    case "over_30":
      return 5;
    default:
      return 6;
  }
}
