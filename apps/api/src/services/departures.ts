import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ScheduledDeparture, StopDeparturesResponse } from "@navigation/contracts";
import { pool } from "../db.js";

const here = path.dirname(fileURLToPath(import.meta.url));

async function loadSql(name: string): Promise<string> {
  const candidates = [
    path.join(here, `../repositories/${name}`),
    path.join(here, `../../src/repositories/${name}`),
  ];
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, "utf8");
    } catch {
      // try next
    }
  }
  throw new Error(`Could not load ${name}`);
}

type DepRow = {
  day_offset: number;
  trip_id: string;
  departure_secs: number;
};

const WEEKDAY_TO_DOW: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Israel-local clock parts for GTFS service-day matching. */
export function israelLocalNow(now = new Date()): { dayOfWeek: number; nowSecs: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const dayOfWeek = WEEKDAY_TO_DOW[get("weekday")] ?? 0;
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  const second = Number(get("second"));
  return {
    dayOfWeek,
    nowSecs: hour * 3600 + minute * 60 + second,
  };
}

export function formatGtfsClock(departureSecs: number): string {
  const secs = ((departureSecs % 86400) + 86400) % 86400;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function toDeparture(row: DepRow): ScheduledDeparture {
  const dayOffset = row.day_offset === 1 ? 1 : 0;
  return {
    tripId: row.trip_id,
    departureSecs: row.departure_secs,
    dayOffset,
    timeLabel: formatGtfsClock(row.departure_secs),
    dayLabel: dayOffset === 0 ? "Today" : "Tomorrow",
  };
}

export async function getBoardDepartures(input: {
  stopId: string;
  alightStopId: string;
  routeShortName: string;
  routeId?: string | null;
}): Promise<StopDeparturesResponse> {
  const { dayOfWeek, nowSecs } = israelLocalNow();
  const tomorrowDow = (dayOfWeek + 1) % 7;
  const sql = await loadSql("boardDepartures.sql");
  const result = await pool.query<DepRow>(sql, [
    input.stopId,
    input.alightStopId,
    input.routeId ?? "",
    input.routeShortName,
    dayOfWeek,
    tomorrowDow,
  ]);

  const horizon = nowSecs + 86400;
  const seen = new Set<string>();
  const departures: ScheduledDeparture[] = [];
  for (const row of result.rows) {
    const abs = row.day_offset * 86400 + row.departure_secs;
    if (abs < nowSecs || abs >= horizon) continue;
    const key = `${row.day_offset}:${row.departure_secs}:${row.trip_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    departures.push(toDeparture(row));
  }
  departures.sort(
    (a, b) => a.dayOffset * 86400 + a.departureSecs - (b.dayOffset * 86400 + b.departureSecs),
  );

  return {
    stopId: input.stopId,
    alightStopId: input.alightStopId,
    routeId: input.routeId ?? null,
    routeShortName: input.routeShortName,
    timezone: "Asia/Jerusalem",
    nowSecs,
    nextDeparture: departures[0] ?? null,
    departures,
  };
}
