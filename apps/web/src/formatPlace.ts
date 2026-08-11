import type { PlaceResult } from "./api";

const DROP_PART =
  /^(israel|ישראל)$|מחוז|district|sub-?district|נפה|county|^\d{4,7}(-\d+)?$/i;

/**
 * Compact place label for search UI and map: street/location + city.
 * Drops zip codes, country, and district crumbs from Nominatim-style labels.
 */
export function shortPlaceLabel(place: {
  label: string;
  city?: string;
  street?: string;
  housenumber?: string;
}): string {
  const city = place.city?.trim() || undefined;
  const street = place.street?.trim() || undefined;
  const hn = place.housenumber?.trim() || undefined;

  if (street) {
    const streetPart = hn ? `${street} ${hn}` : street;
    return city ? `${streetPart}, ${city}` : streetPart;
  }

  const parts = place.label
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => !DROP_PART.test(p));

  if (parts.length === 0) return place.label.trim();
  if (parts.length === 1) return parts[0]!;

  const primary = parts[0]!;
  let secondary = parts[parts.length - 1]!;
  if (city) {
    const match = parts.find((p) => p === city || p.includes(city) || city.includes(p));
    if (match) secondary = match;
  }
  if (secondary === primary) return primary;
  return `${primary}, ${secondary}`;
}

export function shortPlaceLabelFromResult(place: PlaceResult): string {
  return shortPlaceLabel(place);
}
