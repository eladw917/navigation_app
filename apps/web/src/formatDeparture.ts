import type { ScheduledDeparture } from "./api";

/** Assume the user starts walking this long after "now". */
export const DEPARTURE_PREP_SECONDS = 60;

/** HH:MM from GTFS seconds-since-midnight (may exceed 86400). */
export function formatGtfsClock(secs: number | null | undefined): string | null {
  if (secs == null || !Number.isFinite(secs)) return null;
  const daySecs = ((Math.floor(secs) % 86400) + 86400) % 86400;
  const h = Math.floor(daySecs / 3600);
  const m = Math.floor((daySecs % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Prefer departure at board / arrival at alight-style stops. */
export function formatStopClock(stop: {
  isBoard?: boolean;
  arrivalSecs?: number | null;
  departureSecs?: number | null;
}): string | null {
  const secs = stop.isBoard
    ? (stop.departureSecs ?? stop.arrivalSecs)
    : (stop.arrivalSecs ?? stop.departureSecs);
  return formatGtfsClock(secs);
}

/** Earliest clock (secs since local midnight, may exceed 86400) you can be at the board stop. */
export function earliestBoardAbsSecs(
  nowSecs: number,
  walkSecondsToBoard: number,
  prepSeconds = DEPARTURE_PREP_SECONDS,
): number {
  return nowSecs + prepSeconds + Math.max(0, walkSecondsToBoard);
}

/**
 * First departure you can catch if you start walking `prepSeconds` from now
 * and need `walkSecondsToBoard` to reach the stop.
 * Get-on clocks on a sample trip may differ — that trip is only for the shape/times of that instance.
 */
export function pickNextCatchableDeparture(
  departures: ScheduledDeparture[] | null | undefined,
  nowSecs: number | null | undefined,
  walkSecondsToBoard: number,
  prepSeconds = DEPARTURE_PREP_SECONDS,
): ScheduledDeparture | null {
  if (!departures?.length) return null;
  if (nowSecs == null || !Number.isFinite(nowSecs)) return departures[0] ?? null;
  const walkSecs = Math.max(0, walkSecondsToBoard);
  const earliest = earliestBoardAbsSecs(nowSecs, walkSecs, prepSeconds);
  for (const dep of departures) {
    // GTFS departure_secs may exceed 86400 for after-midnight trips on the service day.
    const abs = dep.dayOffset * 86400 + dep.departureSecs;
    if (abs >= earliest) return dep;
  }
  return null;
}

/** Format "in 12 min (14:32)" from a planned departure relative to query nowSecs. */
export function formatNextBusIn(
  next: Pick<ScheduledDeparture, "departureSecs" | "dayOffset" | "timeLabel"> | null | undefined,
  nowSecs: number | null | undefined,
): string | null {
  if (!next) return null;
  if (nowSecs == null || !Number.isFinite(nowSecs)) return next.timeLabel;

  const waitSecs = next.dayOffset * 86400 + next.departureSecs - nowSecs;
  if (waitSecs <= 0) return `now (${next.timeLabel})`;

  const minutes = Math.max(1, Math.round(waitSecs / 60));
  if (minutes < 60) return `in ${minutes} min (${next.timeLabel})`;

  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (rem === 0) return `in ${hours}h (${next.timeLabel})`;
  return `in ${hours}h ${rem}m (${next.timeLabel})`;
}
