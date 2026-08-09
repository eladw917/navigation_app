import type { FrequencyBucket } from "@navigation/contracts";

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
