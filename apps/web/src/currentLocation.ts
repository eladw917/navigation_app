import { reversePlace, type LatLng } from "./api";
import { shortPlaceLabel } from "./formatPlace";

export type CurrentPlace = { label: string; location: LatLng };

export function getCurrentPosition(): Promise<LatLng> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error("Location is not available in this browser"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({ lng: pos.coords.longitude, lat: pos.coords.latitude }),
      () => reject(new Error("Could not get your location")),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  });
}

export async function resolveCurrentLocation(): Promise<CurrentPlace> {
  const location = await getCurrentPosition();
  try {
    const { results } = await reversePlace(location);
    return {
      label: results[0] ? shortPlaceLabel(results[0]) : "Current location",
      location,
    };
  } catch (err) {
    console.error("[reverse]", err);
    return { label: "Current location", location };
  }
}
