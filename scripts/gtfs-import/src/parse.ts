export function parseGtfsTimeToSeconds(value: string | null | undefined): number | null {
  if (value == null || value.trim() === "") return null;
  const match = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid GTFS time: ${value}`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (minutes > 59 || seconds > 59) {
    throw new Error(`Invalid GTFS time components: ${value}`);
  }
  return hours * 3600 + minutes * 60 + seconds;
}

export function isValidCoordinate(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

export function toOptionalInt(value: string | undefined | null): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function requireField(row: Record<string, string>, key: string): string {
  const value = row[key];
  if (value == null || value === "") {
    throw new Error(`Missing required field: ${key}`);
  }
  return value;
}
