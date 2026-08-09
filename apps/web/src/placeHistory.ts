import type { LatLng } from "./api";

export type CachedPlace = {
  id: string;
  label: string;
  location: LatLng;
};

const STORAGE_KEY = "navigationApp.placeHistory.v1";
const MAX_ITEMS = 8;

function readAll(): CachedPlace[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is CachedPlace =>
          Boolean(item) &&
          typeof item === "object" &&
          typeof (item as CachedPlace).label === "string" &&
          typeof (item as CachedPlace).location?.lng === "number" &&
          typeof (item as CachedPlace).location?.lat === "number",
      )
      .map((item) => ({
        id:
          typeof item.id === "string" && item.id
            ? item.id
            : `${item.location.lng.toFixed(5)},${item.location.lat.toFixed(5)}`,
        label: item.label,
        location: item.location,
      }))
      .slice(0, MAX_ITEMS);
  } catch {
    return [];
  }
}

function writeAll(items: CachedPlace[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_ITEMS)));
  } catch {
    // ignore quota / private mode
  }
}

export function loadPlaceHistory(): CachedPlace[] {
  return readAll();
}

export function rememberPlace(place: { label: string; location: LatLng; id?: string }): CachedPlace[] {
  const id =
    place.id ??
    `${place.location.lng.toFixed(5)},${place.location.lat.toFixed(5)}`;
  const next: CachedPlace = {
    id,
    label: place.label,
    location: place.location,
  };
  const rest = readAll().filter(
    (item) =>
      item.id !== next.id &&
      !(
        Math.abs(item.location.lng - next.location.lng) < 1e-5 &&
        Math.abs(item.location.lat - next.location.lat) < 1e-5
      ),
  );
  const items = [next, ...rest].slice(0, MAX_ITEMS);
  writeAll(items);
  return items;
}

export function filterPlaceHistory(query: string, items = readAll()): CachedPlace[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => item.label.toLowerCase().includes(q));
}
