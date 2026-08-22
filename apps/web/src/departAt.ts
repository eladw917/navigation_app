const TZ = "Asia/Jerusalem";

const WEEKDAY: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export type IsraelClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dayOfWeek: number;
  nowSecs: number;
};

export function israelClock(now = new Date()): IsraelClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  const second = Number(get("second"));
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour,
    minute,
    second,
    dayOfWeek: WEEKDAY[get("weekday")] ?? 0,
    nowSecs: hour * 3600 + minute * 60 + second,
  };
}

export function toDatetimeLocalValue(at: Date): string {
  const p = israelClock(at);
  const y = String(p.year);
  const m = String(p.month).padStart(2, "0");
  const d = String(p.day).padStart(2, "0");
  const hh = String(p.hour).padStart(2, "0");
  const mm = String(p.minute).padStart(2, "0");
  return `${y}-${m}-${d}T${hh}:${mm}`;
}

export function fromDatetimeLocalValue(value: string): Date {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return new Date();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  let utc = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 4; i++) {
    const got = toDatetimeLocalValue(new Date(utc));
    if (got === `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}`) {
      return new Date(utc);
    }
    const gm = got.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!gm) break;
    const gotMin =
      Number(gm[1]) * 525600 +
      Number(gm[2]) * 43800 +
      Number(gm[3]) * 1440 +
      Number(gm[4]) * 60 +
      Number(gm[5]);
    const wantMin = year * 525600 + month * 43800 + day * 1440 + hour * 60 + minute;
    utc += (wantMin - gotMin) * 60_000;
  }
  return new Date(utc);
}

export function startOfIsraelDay(now = new Date()): Date {
  const p = israelClock(now);
  const y = String(p.year);
  const m = String(p.month).padStart(2, "0");
  const d = String(p.day).padStart(2, "0");
  return fromDatetimeLocalValue(`${y}-${m}-${d}T00:00`);
}

export function formatWhenChip(at: Date | null, now = new Date()): string {
  if (!at) return "Now";
  const p = israelClock(at);
  const n = israelClock(now);
  const time = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  if (p.year === n.year && p.month === n.month && p.day === n.day) return time;
  return `${p.day}/${p.month} ${time}`;
}

export function departAtIso(at: Date | null): string | undefined {
  return at ? at.toISOString() : undefined;
}

export function departAtKey(at: Date | null): string {
  return at ? at.toISOString() : "now";
}
