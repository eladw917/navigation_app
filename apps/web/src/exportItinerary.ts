import type { DirectRoute, LatLng } from "./api";
import {
  modeLabel,
  routeBadgeLabel,
  routeTypeLabel,
  totalJourneySeconds,
  walkLegsSeconds,
  walkMinutesDisplayed,
} from "./mergePlans";

export type ItineraryInput = {
  originLabel: string;
  destinationLabel: string;
  origin: LatLng;
  destination: LatLng;
  route: DirectRoute;
  nextDepartureLabel?: string | null;
  shareUrl?: string;
};

function formatLegMinutes(seconds: number): string {
  return `${walkMinutesDisplayed(seconds)} min`;
}

export function buildItineraryText(input: ItineraryInput): string {
  const { route, origin, destination } = input;
  const walks = walkLegsSeconds(route, origin, destination);
  const total = totalJourneySeconds(route, origin, destination);
  const line = `${routeTypeLabel(route.routeType)} ${routeBadgeLabel(route)}`.trim();
  const headsign = route.tripHeadsign || route.routeLongName || "";
  const mode = route.planMode ? modeLabel(route.planMode) : null;

  const lines = [
    `Walk2Ride: ${input.originLabel} → ${input.destinationLabel}`,
    "",
    `${line}${headsign ? ` · ${headsign}` : ""}`,
    mode ? `Mode: ${mode}` : null,
    `Walk ${formatLegMinutes(walks.toBoard)} → ride ${formatLegMinutes(route.rideDurationSeconds ?? 0)} → walk ${formatLegMinutes(walks.fromAlight)}`,
    `Total ~${formatLegMinutes(total)}`,
    `Board: ${route.boardStopName}`,
    `Alight: ${route.alightStopName}`,
    input.nextDepartureLabel ? `Next: ${input.nextDepartureLabel}` : null,
    input.shareUrl ? `\n${input.shareUrl}` : null,
  ];

  return lines.filter((line): line is string => line != null).join("\n");
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
