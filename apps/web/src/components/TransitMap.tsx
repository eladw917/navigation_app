import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap, type MapLayerMouseEvent } from "maplibre-gl";
import { formatHeadway, headwayToBucket, stationHeadwayFromLines } from "../frequency";
import {
  formatNextBusIn,
  formatStopClock,
  pickNextCatchableDeparture,
} from "../formatDeparture";
import {
  fetchBoardDepartures,
  fetchTripPath,
  resolveTripPath,
  type DirectPlanResponse,
  type DirectRoute,
  type FrequencyBucket,
  type LatLng,
  type ScheduledDeparture,
  type StopDeparturesResponse,
  type TripPathResponse,
  type TripStop,
  type ValidStop,
} from "../api";

const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const EMPTY_LINE = { type: "FeatureCollection" as const, features: [] };
const RTL_TEXT_PLUGIN_URL = `${import.meta.env.BASE_URL}mapbox-gl-rtl-text.js`;

/** Hebrew/Arabic basemap labels need the RTL shaping plugin. */
function ensureRtlTextPlugin() {
  // Only register when unset — "deferred"/"loading"/"loaded" means already configured.
  if (maplibregl.getRTLTextPluginStatus() !== "unavailable") return;
  try {
    void maplibregl.setRTLTextPlugin(RTL_TEXT_PLUGIN_URL, true);
  } catch {
    // Already registered in another mount / HMR cycle.
  }
}

function isValidLngLat(p: LatLng | null | undefined): p is LatLng {
  return Boolean(
    p &&
      Number.isFinite(p.lng) &&
      Number.isFinite(p.lat) &&
      Math.abs(p.lng) <= 180 &&
      Math.abs(p.lat) <= 90,
  );
}

function appendCoordinatePoints(value: unknown, points: LatLng[]): void {
  if (!Array.isArray(value)) return;
  if (
    value.length >= 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
  ) {
    const point = { lng: value[0], lat: value[1] };
    if (isValidLngLat(point)) points.push(point);
    return;
  }
  for (const child of value) appendCoordinatePoints(child, points);
}

/** Avoid MapLibre world-zoom when padding exceeds the map container size. */
const STATION_POPUP_BOTTOM_PAD = 280;

function safeFitBounds(
  map: MapLibreMap,
  points: LatLng[],
  opts?: {
    maxZoom?: number;
    duration?: number;
    minPad?: number;
    padding?: { top?: number; bottom?: number; left?: number; right?: number };
  },
) {
  const valid = points.filter(isValidLngLat);
  if (!valid.length) return;

  map.resize();
  const w = map.getContainer().clientWidth;
  const h = map.getContainer().clientHeight;
  if (w < 40 || h < 40) return;

  const maxZoom = opts?.maxZoom ?? 15;
  const duration = opts?.duration ?? 450;
  const minPad = opts?.minPad ?? 24;
  const edge = Math.max(minPad, Math.min(72, Math.floor(Math.min(w, h) * 0.1)));
  const padding = {
    top: opts?.padding?.top ?? edge,
    bottom: opts?.padding?.bottom ?? edge,
    left: opts?.padding?.left ?? edge,
    right: opts?.padding?.right ?? edge,
  };

  if (valid.length === 1) {
    const p = valid[0]!;
    map.easeTo({
      center: [p.lng, p.lat],
      zoom: Math.min(14, maxZoom),
      duration,
      padding,
    });
    return;
  }

  const bounds = new maplibregl.LngLatBounds();
  for (const p of valid) bounds.extend([p.lng, p.lat]);
  if (bounds.isEmpty()) return;

  map.fitBounds(bounds, {
    padding,
    maxZoom,
    duration,
  });
}

function fitPaddingForPopup(reservePopup: boolean) {
  // Extra top/side room so O/D label chips stay clear of the frame and station popup.
  if (!reservePopup) return { top: 56, bottom: 48, left: 56, right: 56 };
  return { top: 88, bottom: STATION_POPUP_BOTTOM_PAD, left: 56, right: 56 };
}

function truncateMapLabel(text: string, max = 28): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/** Custom MapLibre marker: pin tip on the exact lat/lng; label floats in CSS only. */
function createEndpointMarkerElement(
  kind: "origin" | "destination",
  label: string | null | undefined,
): HTMLDivElement {
  const root = document.createElement("div");
  root.className = `endpoint-marker endpoint-marker--${kind}`;
  root.setAttribute("role", "img");
  const roleText = kind === "origin" ? "Origin" : "Destination";
  const short = label?.trim() ? truncateMapLabel(label) : null;
  root.setAttribute("aria-label", short ? `${roleText}: ${label!.trim()}` : roleText);

  const lab = document.createElement("div");
  lab.className = "endpoint-marker-label";
  const role = document.createElement("span");
  role.className = "endpoint-marker-role";
  role.textContent = kind === "origin" ? "A" : "B";
  lab.appendChild(role);
  if (short) {
    const name = document.createElement("span");
    name.className = "endpoint-marker-name";
    name.textContent = short;
    lab.appendChild(name);
  }

  const pin = document.createElement("div");
  pin.className = "endpoint-marker-pin";
  pin.setAttribute("aria-hidden", "true");

  // Label is absolutely positioned in CSS so it never shifts the geographic anchor.
  root.appendChild(lab);
  root.appendChild(pin);
  return root;
}

/** Stable option identity — ignore sample/next-departure tripId so card picks don't reload. */
function selectedOptionKey(route: DirectRoute | null | undefined): string | null {
  if (!route) return null;
  const mode = route.planMode ?? "walk_transit";
  return `${mode}:${route.routeId}:${route.boardStopId}:${route.alightStopId}`;
}

type Props = {
  origin: LatLng | null;
  destination: LatLng | null;
  /** Optional place labels shown as map annotations on the endpoint markers. */
  originLabel?: string | null;
  destinationLabel?: string | null;
  plan: DirectPlanResponse | null;
  selectedRoute: DirectRoute | null;
  planning?: boolean;
  onSelectStop?: (stopId: string | null) => void;
  /** When set, show this departure (schedule picker) if it matches the browsed trip. */
  overrideDeparture?: ScheduledDeparture | null;
  onOpenSchedule?: () => void;
  /** When set with limitWalk, stepper cannot pick stops beyond this walk budget (seconds). */
  maxWalkingSeconds?: number | null;
  limitWalk?: boolean;
  /** Fired when a line is opened/closed from the map (station tap or clear). */
  onLineActiveChange?: (active: boolean) => void;
  /** Fired when map browse resolves to a plan route (or clears). */
  onBrowseRouteChange?: (route: DirectRoute | null) => void;
};

type Station = ValidStop & { distanceMeters: number };

type ScrollEnd = "board" | "alight";

type BrowseState = {
  /** null = station picker (before a line is chosen). */
  bus: string | null;
  buses: string[];
  index: number;
  preferredStopId: string | null;
  /** Which end of the trip the ← → stepper scrolls. Defaults to boarding. */
  scrollEnd: ScrollEnd;
  /** Persisted get-on / get-off choices (kept when switching scroll end). */
  chosenBoardId: string | null;
  chosenAlightId: string | null;
};

type LineStation = {
  stopId: string;
  name: string;
  lng: number;
  lat: number;
  distanceMeters: number;
  inWalkingArea: boolean;
  isBoard: boolean;
  isAlight: boolean;
  onPath: boolean;
  stopSequence?: number;
  frequencyBucket?: FrequencyBucket;
  headwaySeconds?: number | null;
  routeFrequencies?: ValidStop["routeFrequencies"];
};

function haversineMeters(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Matches API circular walking fallback (~1.25 m/s). Straight-line estimate. */
const WALK_SPEED_MPS = 1.25;

function formatWalkLeg(meters: number): string {
  const m = Math.max(0, Math.round(meters));
  const minutes = Math.max(1, Math.round(meters / WALK_SPEED_MPS / 60));
  if (m < 1000) return `${m} m · ~${minutes} min`;
  return `${(m / 1000).toFixed(1)} km · ~${minutes} min`;
}

function formatRideDuration(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds === 0) return "~0 min";
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `~${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem ? `~${hours} h ${rem} min` : `~${hours} h`;
}

function formatRideLeg(
  seconds: number | null | undefined,
  stopsRemaining: number | null,
): string | null {
  const time = formatRideDuration(seconds);
  const stopsLabel =
    stopsRemaining == null
      ? null
      : stopsRemaining === 0
        ? "at get-off"
        : stopsRemaining === 1
          ? "1 stop"
          : `${stopsRemaining} stops`;
  // Distance/stations first, duration second (same order as walk legs).
  if (time && stopsLabel) return `${stopsLabel} · ${time}`;
  return stopsLabel ?? time;
}

function stopTimeSecs(stop: {
  arrivalSecs?: number | null;
  departureSecs?: number | null;
  isBoard?: boolean;
}): number | null {
  const preferred = stop.isBoard
    ? (stop.departureSecs ?? stop.arrivalSecs)
    : (stop.arrivalSecs ?? stop.departureSecs);
  if (preferred == null || !Number.isFinite(preferred)) return null;
  return preferred;
}

function routeBusName(route: DirectRoute): string {
  // Include route_type so bus "1" and light rail "1" do not collide.
  const type = route.routeType ?? 3;
  const name = route.routeShortName?.trim() || route.routeId;
  return `${type}:${name}`;
}

/** Strip `3:5` → `5` for API calls that expect GTFS route_short_name. */
function busShortName(busKey: string): string {
  const idx = busKey.indexOf(":");
  if (idx < 0) return busKey;
  const type = busKey.slice(0, idx);
  if (/^\d+$/.test(type)) return busKey.slice(idx + 1);
  return busKey;
}

function routeMatchesBus(route: DirectRoute, bus: string): boolean {
  if (routeBusName(route) === bus) return true;
  const short = busShortName(bus);
  const routeName = route.routeShortName?.trim() || route.routeId;
  if (routeName !== short && routeName !== bus) return false;
  const typed = bus.match(/^(\d+):/);
  if (typed) {
    const type = Number(typed[1]);
    if (route.routeType != null && route.routeType !== type) return false;
  }
  return true;
}

function routeChipLabel(busKey: string): string {
  const idx = busKey.indexOf(":");
  if (idx < 0) return busKey;
  const type = Number(busKey.slice(0, idx));
  const name = busKey.slice(idx + 1);
  if (type === 2) return name || "Train";
  if (type === 0) return name ? `LR ${name}` : "Light rail";
  return name || busKey;
}

function buildBusStations(stops: ValidStop[], origin: LatLng | null): Map<string, Station[]> {
  const map = new Map<string, Station[]>();
  for (const stop of stops) {
    const distanceMeters = origin
      ? haversineMeters(origin, { lng: stop.lng, lat: stop.lat })
      : 0;
    for (const bus of stop.routeShortNames ?? []) {
      const list = map.get(bus) ?? [];
      list.push({ ...stop, distanceMeters });
      map.set(bus, list);
    }
  }
  for (const [bus, list] of map) {
    list.sort((a, b) => a.distanceMeters - b.distanceMeters || a.name.localeCompare(b.name));
    map.set(bus, list);
  }
  return map;
}

/** Pins from filtered plan routes only — board near origin, get-off near destination. */
function buildMapPins(
  routes: DirectRoute[],
  stopMeta: Map<string, ValidStop>,
  origin: LatLng | null,
  destination: LatLng | null,
  selectedBus: string | null,
  currentStation: LineStation | null,
): Array<{
  stop: LineStation;
  boardBuses: string[];
  alightBuses: string[];
}> {
  const byStop = new Map<
    string,
    { stop: LineStation; boardBuses: string[]; alightBuses: string[] }
  >();

  function ensureStop(
    stopId: string,
    name: string,
    lng: number,
    lat: number,
  ): LineStation {
    const meta = stopMeta.get(stopId);
    return {
      stopId,
      name: meta?.name ?? name,
      lng: meta?.lng ?? lng,
      lat: meta?.lat ?? lat,
      distanceMeters: origin
        ? haversineMeters(origin, { lng: meta?.lng ?? lng, lat: meta?.lat ?? lat })
        : 0,
      inWalkingArea: true,
      isBoard: false,
      isAlight: false,
      onPath: false,
      frequencyBucket: meta?.frequencyBucket,
      headwaySeconds: meta?.headwaySeconds ?? null,
      routeFrequencies: meta?.routeFrequencies,
    };
  }

  function addBus(
    stopId: string,
    name: string,
    lng: number,
    lat: number,
    bus: string,
    end: "board" | "alight",
  ) {
    let entry = byStop.get(stopId);
    if (!entry) {
      entry = {
        stop: ensureStop(stopId, name, lng, lat),
        boardBuses: [],
        alightBuses: [],
      };
      byStop.set(stopId, entry);
    }
    if (end === "board") {
      entry.stop.isBoard = true;
      if (!entry.boardBuses.includes(bus)) entry.boardBuses.push(bus);
    } else {
      entry.stop.isAlight = true;
      if (!entry.alightBuses.includes(bus)) entry.alightBuses.push(bus);
    }
  }

  const byBus = new Map<string, DirectRoute[]>();
  for (const route of routes) {
    const bus = routeBusName(route);
    if (selectedBus && bus === selectedBus) continue;
    const list = byBus.get(bus) ?? [];
    list.push(route);
    byBus.set(bus, list);
  }

  for (const [bus, busRoutes] of byBus) {
    let bestBoard: DirectRoute | null = null;
    let bestBoardDist = Number.POSITIVE_INFINITY;
    let bestAlight: DirectRoute | null = null;
    let bestAlightDist = Number.POSITIVE_INFINITY;

    for (const route of busRoutes) {
      if (origin && isValidLngLat(origin)) {
        const d = haversineMeters(origin, {
          lng: route.boardLng,
          lat: route.boardLat,
        });
        if (d < bestBoardDist) {
          bestBoardDist = d;
          bestBoard = route;
        }
      } else if (!bestBoard) {
        bestBoard = route;
      }

      if (destination && isValidLngLat(destination)) {
        const d = haversineMeters(destination, {
          lng: route.alightLng,
          lat: route.alightLat,
        });
        if (d < bestAlightDist) {
          bestAlightDist = d;
          bestAlight = route;
        }
      } else if (!bestAlight) {
        bestAlight = route;
      }
    }

    if (bestBoard) {
      addBus(
        bestBoard.boardStopId,
        bestBoard.boardStopName,
        bestBoard.boardLng,
        bestBoard.boardLat,
        bus,
        "board",
      );
    }
    if (bestAlight) {
      addBus(
        bestAlight.alightStopId,
        bestAlight.alightStopName,
        bestAlight.alightLng,
        bestAlight.alightLat,
        bus,
        "alight",
      );
    }
  }

  if (selectedBus && currentStation) {
    const entry = byStop.get(currentStation.stopId);
    if (entry) {
      if (currentStation.isAlight && !entry.alightBuses.includes(selectedBus)) {
        entry.alightBuses.push(selectedBus);
      }
      if (currentStation.isBoard && !entry.boardBuses.includes(selectedBus)) {
        entry.boardBuses.push(selectedBus);
      }
      if (!entry.boardBuses.includes(selectedBus) && !entry.alightBuses.includes(selectedBus)) {
        entry.boardBuses.push(selectedBus);
      }
      entry.stop = { ...currentStation, isBoard: entry.stop.isBoard || currentStation.isBoard, isAlight: entry.stop.isAlight || currentStation.isAlight };
    } else {
      byStop.set(currentStation.stopId, {
        stop: currentStation,
        boardBuses: currentStation.isAlight && !currentStation.isBoard ? [] : [selectedBus],
        alightBuses: currentStation.isAlight ? [selectedBus] : [],
      });
    }
  }

  for (const entry of byStop.values()) {
    entry.boardBuses.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    entry.alightBuses.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  return [...byStop.values()];
}

function pinFreqBucket(
  stop: LineStation,
  buses: string[],
  routes: DirectRoute[],
  end: "board" | "alight" | "either",
): FrequencyBucket | "unknown" {
  // Size from relevant plan buses only (unknown line freqs ignored).
  const lines = buses.map((bus) => {
    const atStop = stop.routeFrequencies?.find(
      (r) => r.routeShortName === bus || r.routeShortName === busShortName(bus),
    );
    let headwaySeconds = atStop?.headwaySeconds ?? null;
    if (headwaySeconds == null || headwaySeconds <= 0) {
      const route = routes.find((r) => {
        if (routeBusName(r) !== bus) return false;
        if (end === "alight") return r.alightStopId === stop.stopId;
        if (end === "board") return r.boardStopId === stop.stopId;
        return r.boardStopId === stop.stopId || r.alightStopId === stop.stopId;
      });
      headwaySeconds = route?.headwaySeconds ?? null;
    }
    return { headwaySeconds };
  });

  const stationHeadway = stationHeadwayFromLines(lines);
  if (stationHeadway != null) return headwayToBucket(stationHeadway);
  return "unknown";
}

function pickRouteForBus(
  routes: DirectRoute[],
  bus: string,
  preferredStopId: string | null,
  destination: LatLng | null,
  origin: LatLng | null = null,
): DirectRoute | null {
  let matches = routes.filter((r) => routeMatchesBus(r, bus));
  if (!matches.length) return null;

  if (preferredStopId) {
    const atBoard = matches.filter((r) => r.boardStopId === preferredStopId);
    if (atBoard.length) matches = atBoard;
    else {
      const atAlight = matches.filter((r) => r.alightStopId === preferredStopId);
      if (atAlight.length) matches = atAlight;
    }
  }

  if (matches.length === 1) return matches[0] ?? null;

  const sampleMode = matches[0]?.planMode;
  const anchor =
    sampleMode === "transit_walk"
      ? origin
      : destination;
  if (!anchor) return matches[0] ?? null;

  let best = matches[0]!;
  let bestDist = haversineMeters(
    sampleMode === "transit_walk"
      ? { lng: best.boardLng, lat: best.boardLat }
      : { lng: best.alightLng, lat: best.alightLat },
    anchor,
  );
  for (const route of matches.slice(1)) {
    const point =
      (route.planMode ?? sampleMode) === "transit_walk"
        ? { lng: route.boardLng, lat: route.boardLat }
        : { lng: route.alightLng, lat: route.alightLat };
    const dist = haversineMeters(point, anchor);
    if (dist < bestDist) {
      best = route;
      bestDist = dist;
    }
  }
  return best;
}

function nearestCoordIndex(
  coords: [number, number][],
  point: { lng: number; lat: number },
): number {
  let bestIdx = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < coords.length; i++) {
    const [lng, lat] = coords[i]!;
    const d = haversineMeters(point, { lng, lat });
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function buildJourneyGeoJson(
  origin: LatLng | null,
  destination: LatLng | null,
  tripPath: TripPathResponse,
  boardOverride: { lng: number; lat: number; stopId?: string } | null = null,
  alightOverride: { lng: number; lat: number; stopId?: string } | null = null,
): { type: "FeatureCollection"; features: object[] } {
  const board =
    boardOverride ??
    tripPath.stops.find((s) => s.isBoard) ??
    tripPath.stops.find((s) => s.onPath);
  const alight =
    alightOverride ??
    tripPath.stops.find((s) => s.isAlight) ??
    [...tripPath.stops].reverse().find((s) => s.onPath);
  const features: object[] = [];

  const pushWalkLeg = (
    kind: "walk" | "walkAfter",
    from: { lng: number; lat: number },
    to: { lng: number; lat: number },
  ) => {
    features.push({
      type: "Feature",
      properties: { kind },
      geometry: {
        type: "LineString",
        coordinates: [
          [from.lng, from.lat],
          [to.lng, to.lat],
        ],
      },
    });
    // Solid caps so dashed walk lines visually meet O/D pins and stop circles.
    const endKind = kind === "walk" ? "walkEnd" : "walkAfterEnd";
    for (const point of [from, to]) {
      features.push({
        type: "Feature",
        properties: { kind: endKind },
        geometry: {
          type: "Point",
          coordinates: [point.lng, point.lat],
        },
      });
    }
  };

  if (origin && board) {
    pushWalkLeg("walk", origin, { lng: board.lng, lat: board.lat });
  }

  // Prefer full trip stop coordinates so pre-board / post-alight picks still work.
  let allCoords = tripPath.stops.map((s) => [s.lng, s.lat] as [number, number]);
  if (allCoords.length < 2) {
    allCoords = tripPath.geometry.coordinates as [number, number][];
  }

  const pushLine = (kind: string, coordinates: [number, number][]) => {
    if (coordinates.length < 2) return;
    features.push({
      type: "Feature",
      properties: { kind },
      geometry: { type: "LineString", coordinates },
    });
  };

  if (board && allCoords.length >= 2) {
    const startIdx = nearestCoordIndex(allCoords, board);
    let endIdx = alight ? nearestCoordIndex(allCoords, alight) : allCoords.length - 1;
    if (endIdx < startIdx) endIdx = allCoords.length - 1;

    // Outside the selected ride: full line stays visible, but muted grey.
    pushLine("transitOutside", allCoords.slice(0, startIdx + 1));
    let rideCoords = allCoords.slice(startIdx, endIdx + 1);
    if (rideCoords.length < 2) {
      rideCoords = [
        [board.lng, board.lat],
        [alight?.lng ?? board.lng, alight?.lat ?? board.lat],
      ];
    }
    pushLine("transit", rideCoords);
    pushLine("transitOutside", allCoords.slice(endIdx));
  } else {
    pushLine("transit", allCoords);
  }

  if (destination && alight) {
    pushWalkLeg("walkAfter", { lng: alight.lng, lat: alight.lat }, destination);
  }

  return { type: "FeatureCollection", features };
}

function buildOdWalkGeoJson(
  origin: LatLng,
  destination: LatLng,
): { type: "FeatureCollection"; features: object[] } {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { kind: "walk" },
        geometry: {
          type: "LineString",
          coordinates: [
            [origin.lng, origin.lat],
            [destination.lng, destination.lat],
          ],
        },
      },
      {
        type: "Feature",
        properties: { kind: "walkEnd" },
        geometry: { type: "Point", coordinates: [origin.lng, origin.lat] },
      },
      {
        type: "Feature",
        properties: { kind: "walkEnd" },
        geometry: {
          type: "Point",
          coordinates: [destination.lng, destination.lat],
        },
      },
    ],
  };
}

function walkMinutesBetween(a: LatLng, b: LatLng): number {
  return Math.max(1, Math.round(haversineMeters(a, b) / WALK_SPEED_MPS / 60));
}

function createWalkLineLabelElement(minutes: number): HTMLDivElement {
  const root = document.createElement("div");
  root.className = "walk-line-label";
  root.setAttribute("role", "status");
  const icon = document.createElement("span");
  icon.className = "walk-line-label-icon";
  icon.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.textContent = `~${minutes} min`;
  root.append(icon, label);
  return root;
}

function tripStopsToLineStations(
  stops: TripStop[],
  origin: LatLng | null,
  walkingStopIds: Set<string>,
  stopMeta: Map<string, ValidStop>,
): LineStation[] {
  return stops.map((s) => {
    const meta = stopMeta.get(s.stopId);
    return {
      stopId: s.stopId,
      name: s.name,
      lng: s.lng,
      lat: s.lat,
      distanceMeters: origin ? haversineMeters(origin, { lng: s.lng, lat: s.lat }) : 0,
      inWalkingArea: walkingStopIds.has(s.stopId),
      isBoard: s.isBoard,
      isAlight: s.isAlight,
      onPath: s.onPath,
      stopSequence: s.stopSequence,
      frequencyBucket: meta?.frequencyBucket,
      headwaySeconds: meta?.headwaySeconds ?? null,
      routeFrequencies: meta?.routeFrequencies,
    };
  });
}

function fallbackLineStations(stations: Station[]): LineStation[] {
  return stations.map((s) => ({
    stopId: s.stopId,
    name: s.name,
    lng: s.lng,
    lat: s.lat,
    distanceMeters: s.distanceMeters,
    inWalkingArea: true,
    isBoard: s.role === "boarding" || s.role === "both",
    isAlight: s.role === "alighting" || s.role === "both",
    onPath: true,
    frequencyBucket: s.frequencyBucket,
    headwaySeconds: s.headwaySeconds ?? null,
    routeFrequencies: s.routeFrequencies,
  }));
}

function validStopToLineStation(stop: ValidStop, origin: LatLng | null): LineStation {
  return {
    stopId: stop.stopId,
    name: stop.name,
    lng: stop.lng,
    lat: stop.lat,
    distanceMeters: origin
      ? haversineMeters(origin, { lng: stop.lng, lat: stop.lat })
      : 0,
    inWalkingArea: true,
    isBoard: stop.role === "boarding" || stop.role === "both",
    isAlight: stop.role === "alighting" || stop.role === "both",
    onPath: false,
    frequencyBucket: stop.frequencyBucket,
    headwaySeconds: stop.headwaySeconds ?? null,
    routeFrequencies: stop.routeFrequencies,
  };
}

function headwayForBus(
  plan: DirectPlanResponse,
  bus: string,
  currentStation: LineStation | null,
  stopMeta: Map<string, ValidStop>,
  preferredStopId: string | null,
): number | null {
  const atCurrent = currentStation?.routeFrequencies?.find(
    (r) => r.routeShortName === bus || r.routeShortName === busShortName(bus),
  );
  if (atCurrent) return atCurrent.headwaySeconds ?? null;
  const atFocus = stopMeta
    .get(preferredStopId ?? "")
    ?.routeFrequencies?.find(
      (r) => r.routeShortName === bus || r.routeShortName === busShortName(bus),
    );
  if (atFocus) return atFocus.headwaySeconds ?? null;
  for (const stop of plan.validStops) {
    const freq = stop.routeFrequencies?.find(
      (r) => r.routeShortName === bus || r.routeShortName === busShortName(bus),
    );
    if (freq) return freq.headwaySeconds ?? null;
  }
  const route = plan.routes.find((r) => routeMatchesBus(r, bus));
  return route?.headwaySeconds ?? null;
}

export function TransitMap({
  origin,
  destination,
  originLabel = null,
  destinationLabel = null,
  plan,
  selectedRoute,
  planning = false,
  onSelectStop,
  overrideDeparture = null,
  onOpenSchedule,
  maxWalkingSeconds = null,
  limitWalk = false,
  onLineActiveChange,
  onBrowseRouteChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const originMarkerRef = useRef<maplibregl.Marker | null>(null);
  const destinationMarkerRef = useRef<maplibregl.Marker | null>(null);
  const walkLabelMarkerRef = useRef<maplibregl.Marker | null>(null);
  const browseRef = useRef<BrowseState | null>(null);
  const onSelectStopRef = useRef(onSelectStop);
  const onLineActiveChangeRef = useRef(onLineActiveChange);
  const onBrowseRouteChangeRef = useRef(onBrowseRouteChange);
  const openBrowseRef = useRef<(stopId: string, buses: string[]) => void>(() => undefined);
  const selectLineStopRef = useRef<(stopId: string) => boolean>(() => false);
  const pathAbortRef = useRef<AbortController | null>(null);
  const instanceAbortRef = useRef<AbortController | null>(null);
  const depsAbortRef = useRef<AbortController | null>(null);
  const openedFromCardRef = useRef<string | null>(null);
  const suppressMapClickRef = useRef(false);
  const originRef = useRef(origin);
  const destinationRef = useRef(destination);
  const originLabelRef = useRef(originLabel);
  const destinationLabelRef = useRef(destinationLabel);
  originRef.current = origin;
  destinationRef.current = destination;
  originLabelRef.current = originLabel;
  destinationLabelRef.current = destinationLabel;
  onSelectStopRef.current = onSelectStop;
  onLineActiveChangeRef.current = onLineActiveChange;
  onBrowseRouteChangeRef.current = onBrowseRouteChange;

  const [browse, setBrowse] = useState<BrowseState | null>(null);
  browseRef.current = browse;
  const [tripPath, setTripPath] = useState<TripPathResponse | null>(null);
  const [pathLoading, setPathLoading] = useState(false);
  const [pathError, setPathError] = useState<string | null>(null);
  const [popupDepartures, setPopupDepartures] = useState<StopDeparturesResponse | null>(null);
  const [popupDeparturesLoading, setPopupDeparturesLoading] = useState(false);
  const fittedPlanId = useRef<string | null>(null);
  const fittedPathKey = useRef<string | null>(null);

  const busStations = useMemo(
    () => buildBusStations(plan?.validStops ?? [], origin),
    [plan, origin],
  );

  const walkingStopIds = useMemo(
    () => new Set((plan?.validStops ?? []).map((s) => s.stopId)),
    [plan],
  );

  const stopMeta = useMemo(() => {
    const map = new Map<string, ValidStop>();
    for (const stop of plan?.validStops ?? []) map.set(stop.stopId, stop);
    return map;
  }, [plan]);

  const lineStations = useMemo((): LineStation[] => {
    if (!browse?.bus) return [];
    if (tripPath) {
      // Full trip: stops before board and after get-off, not only the ride segment.
      return tripStopsToLineStations(tripPath.stops, origin, walkingStopIds, stopMeta);
    }
    return fallbackLineStations(busStations.get(browse.bus) ?? []);
  }, [browse, tripPath, origin, walkingStopIds, busStations, stopMeta]);

  const recommendedBoardId = useMemo(() => {
    if (tripPath) {
      return (
        tripPath.stops.find((s) => s.isBoard)?.stopId ??
        tripPath.boardStopId ??
        null
      );
    }
    return selectedRoute?.boardStopId ?? null;
  }, [tripPath, selectedRoute]);

  const recommendedAlightId = useMemo(() => {
    if (tripPath) {
      return (
        tripPath.stops.find((s) => s.isAlight)?.stopId ??
        tripPath.alightStopId ??
        null
      );
    }
    return selectedRoute?.alightStopId ?? null;
  }, [tripPath, selectedRoute]);

  const chosenBoardId = browse?.chosenBoardId ?? recommendedBoardId;
  const chosenAlightId = browse?.chosenAlightId ?? recommendedAlightId;

  /**
   * Get on: trip start → one stop before get-off (never includes get-off).
   * When walk limit is on, only stops within the remaining walk budget from origin.
   */
  const boardScrollStations = useMemo((): LineStation[] => {
    if (!lineStations.length) return [];
    const alightIdx = chosenAlightId
      ? lineStations.findIndex((s) => s.stopId === chosenAlightId)
      : -1;
    let list =
      alightIdx > 0
        ? lineStations.slice(0, alightIdx)
        : alightIdx === 0
          ? lineStations.slice(0, 1)
          : lineStations;
    if (limitWalk && maxWalkingSeconds != null && origin && isValidLngLat(origin)) {
      const alightWalk =
        chosenAlightId && destination && isValidLngLat(destination)
          ? (() => {
              const a = lineStations.find((s) => s.stopId === chosenAlightId);
              return a
                ? haversineMeters({ lng: a.lng, lat: a.lat }, destination) / WALK_SPEED_MPS
                : 0;
            })()
          : 0;
      const budget = Math.max(0, maxWalkingSeconds - alightWalk);
      list = list.filter(
        (s) => haversineMeters(origin, { lng: s.lng, lat: s.lat }) / WALK_SPEED_MPS <= budget + 0.5,
      );
    }
    return list;
  }, [
    lineStations,
    chosenAlightId,
    limitWalk,
    maxWalkingSeconds,
    origin,
    destination,
  ]);

  /**
   * Get off: one stop after get-on → trip end (never includes get-on).
   * When walk limit is on, only stops within the remaining walk budget to destination.
   */
  const alightScrollStations = useMemo((): LineStation[] => {
    if (!lineStations.length) return [];
    const boardIdx = chosenBoardId
      ? lineStations.findIndex((s) => s.stopId === chosenBoardId)
      : -1;
    let list =
      boardIdx >= 0 && boardIdx < lineStations.length - 1
        ? lineStations.slice(boardIdx + 1)
        : boardIdx === lineStations.length - 1
          ? lineStations.slice(boardIdx)
          : lineStations;
    if (limitWalk && maxWalkingSeconds != null && destination && isValidLngLat(destination)) {
      const boardWalk =
        chosenBoardId && origin && isValidLngLat(origin)
          ? (() => {
              const b = lineStations.find((s) => s.stopId === chosenBoardId);
              return b
                ? haversineMeters(origin, { lng: b.lng, lat: b.lat }) / WALK_SPEED_MPS
                : 0;
            })()
          : 0;
      const budget = Math.max(0, maxWalkingSeconds - boardWalk);
      list = list.filter(
        (s) =>
          haversineMeters({ lng: s.lng, lat: s.lat }, destination) / WALK_SPEED_MPS <=
          budget + 0.5,
      );
    }
    return list;
  }, [
    lineStations,
    chosenBoardId,
    limitWalk,
    maxWalkingSeconds,
    origin,
    destination,
  ]);

  const scrollStations = useMemo((): LineStation[] => {
    if (!browse?.bus) return [];
    return browse.scrollEnd === "alight" ? alightScrollStations : boardScrollStations;
  }, [browse?.bus, browse?.scrollEnd, boardScrollStations, alightScrollStations]);

  // If the scroll list shrinks, keep browse.index in range.
  useEffect(() => {
    if (!browse?.bus || !scrollStations.length) return;
    if (browse.index < scrollStations.length) return;
    const next = scrollStations.length - 1;
    setBrowse((prev) => (prev ? { ...prev, index: next } : prev));
    onSelectStopRef.current?.(scrollStations[next]?.stopId ?? null);
  }, [browse?.bus, browse?.index, browse?.scrollEnd, scrollStations]);

  const focusStop = useMemo((): LineStation | null => {
    if (!browse?.preferredStopId || !plan) return null;
    const stop = stopMeta.get(browse.preferredStopId);
    return stop ? validStopToLineStation(stop, origin) : null;
  }, [browse, plan, stopMeta, origin]);

  const currentStation = useMemo(() => {
    if (!browse) return null;
    if (!browse.bus) return focusStop;
    if (!scrollStations.length) return focusStop;
    return scrollStations[Math.min(browse.index, scrollStations.length - 1)] ?? null;
  }, [browse, scrollStations, focusStop]);

  const stopHeadwaySeconds = useMemo(() => {
    if (!currentStation) return null;
    if (currentStation.headwaySeconds != null) return currentStation.headwaySeconds;
    return stopMeta.get(currentStation.stopId)?.headwaySeconds ?? null;
  }, [currentStation, stopMeta]);

  const lineHeadwaySeconds = useMemo(() => {
    if (!browse?.bus || !plan) return null;
    return headwayForBus(plan, browse.bus, currentStation, stopMeta, browse.preferredStopId);
  }, [browse, plan, currentStation, stopMeta]);

  const busFrequencyKnown = useMemo(() => {
    if (!browse || !plan) return new Map<string, boolean>();
    const map = new Map<string, boolean>();
    for (const bus of browse.buses) {
      const secs = headwayForBus(plan, bus, currentStation, stopMeta, browse.preferredStopId);
      map.set(bus, secs != null && secs > 0);
    }
    return map;
  }, [browse, plan, currentStation, stopMeta]);

  const boardStop = useMemo(() => {
    if (!browse?.bus) return null;
    if (tripPath) {
      return (
        tripPath.stops.find((s) => s.isBoard) ??
        tripPath.stops.find((s) => s.stopId === tripPath.boardStopId) ??
        null
      );
    }
    if (!plan) return null;
    const route = pickRouteForBus(
      plan.routes,
      browse.bus,
      browse.preferredStopId ?? currentStation?.stopId ?? null,
      destination,
      origin,
    );
    if (!route) return null;
    return {
      stopId: route.boardStopId,
      name: route.boardStopName,
      lng: route.boardLng,
      lat: route.boardLat,
    };
  }, [tripPath, browse, currentStation, plan, destination, origin]);

  const alightStop = useMemo(() => {
    if (!browse?.bus) return null;
    if (tripPath) {
      return (
        tripPath.stops.find((s) => s.isAlight) ??
        tripPath.stops.find((s) => s.stopId === tripPath.alightStopId) ??
        null
      );
    }
    if (!plan) return null;
    const route = pickRouteForBus(
      plan.routes,
      browse.bus,
      browse.preferredStopId ?? currentStation?.stopId ?? null,
      destination,
      origin,
    );
    if (!route) return null;
    return {
      stopId: route.alightStopId,
      name: route.alightStopName,
      lng: route.alightLng,
      lat: route.alightLat,
    };
  }, [tripPath, browse, currentStation, plan, destination, origin]);

  /** Active get-on from persisted choice (not cleared when switching to get-off). */
  const effectiveBoard = useMemo(() => {
    if (chosenBoardId) {
      const fromLine = lineStations.find((s) => s.stopId === chosenBoardId);
      if (fromLine) return fromLine;
    }
    if (browse?.scrollEnd === "board" && currentStation) return currentStation;
    return boardStop;
  }, [chosenBoardId, lineStations, browse?.scrollEnd, currentStation, boardStop]);

  /** Active get-off from persisted choice (not cleared when switching to get-on). */
  const effectiveAlight = useMemo(() => {
    if (chosenAlightId) {
      const fromLine = lineStations.find((s) => s.stopId === chosenAlightId);
      if (fromLine) return fromLine;
    }
    if (browse?.scrollEnd === "alight" && currentStation) return currentStation;
    return alightStop;
  }, [chosenAlightId, lineStations, browse?.scrollEnd, currentStation, alightStop]);

  const linePositionLabel = useMemo(() => {
    if (!currentStation || !lineStations.length) return null;
    const idx = lineStations.findIndex((s) => s.stopId === currentStation.stopId);
    if (idx < 0) return null;
    return `Stop ${idx + 1}/${lineStations.length}`;
  }, [currentStation, lineStations]);

  const walkSummary = useMemo(() => {
    if (!browse?.bus || !tripPath || !effectiveBoard || !effectiveAlight) return null;

    const walkToBoard =
      origin && isValidLngLat(origin)
        ? haversineMeters(origin, {
            lng: effectiveBoard.lng,
            lat: effectiveBoard.lat,
          })
        : null;
    const walkFromAlight =
      destination && isValidLngLat(destination)
        ? haversineMeters(
            { lng: effectiveAlight.lng, lat: effectiveAlight.lat },
            destination,
          )
        : null;

    let rideSeconds: number | null = tripPath.rideDurationSeconds ?? null;
    let stopsRemaining: number | null = null;

    const fromIdx = tripPath.stops.findIndex((s) => s.stopId === effectiveBoard.stopId);
    const toIdx = tripPath.stops.findIndex((s) => s.stopId === effectiveAlight.stopId);
    if (fromIdx >= 0 && toIdx >= fromIdx) {
      stopsRemaining = toIdx - fromIdx;
      const fromStop = tripPath.stops[fromIdx]!;
      const toStop = tripPath.stops[toIdx]!;
      const fromSecs = stopTimeSecs({ ...fromStop, isBoard: true });
      const toSecs = stopTimeSecs({ ...toStop, isBoard: false });
      if (fromSecs != null && toSecs != null) {
        rideSeconds = Math.max(0, toSecs - fromSecs);
      } else if (tripPath.rideDurationSeconds != null) {
        const boardIdx = tripPath.stops.findIndex(
          (s) => s.isBoard || s.stopId === tripPath.boardStopId,
        );
        const alightIdx = tripPath.stops.findIndex(
          (s) => s.isAlight || s.stopId === tripPath.alightStopId,
        );
        if (boardIdx >= 0 && alightIdx > boardIdx) {
          const span = alightIdx - boardIdx;
          const left = Math.max(0, alightIdx - fromIdx);
          rideSeconds = Math.round((tripPath.rideDurationSeconds * left) / span);
        }
      }
    }

    const rideLabel = formatRideLeg(rideSeconds, stopsRemaining);
    if (walkToBoard == null && walkFromAlight == null && !rideLabel) return null;
    return { walkToBoard, walkFromAlight, rideLabel };
  }, [browse?.bus, origin, destination, effectiveBoard, effectiveAlight, tripPath]);

  /**
   * Seconds to reach get-on, matching the Walk-to-stop row (rounded minutes),
   * plus the assumption that walking starts 1 minute from now (applied in pick).
   */
  const walkSecondsToBoard = useMemo(() => {
    const meters =
      walkSummary?.walkToBoard ??
      (origin && isValidLngLat(origin) && effectiveBoard
        ? haversineMeters(origin, {
            lng: effectiveBoard.lng,
            lat: effectiveBoard.lat,
          })
        : null);
    if (meters == null || !Number.isFinite(meters) || meters < 0) return 0;
    const minutes = Math.max(1, Math.round(meters / WALK_SPEED_MPS / 60));
    return minutes * 60;
  }, [walkSummary?.walkToBoard, origin, effectiveBoard]);

  const browseMatchesSelectedRoute = useMemo(() => {
    if (!browse?.bus || !selectedRoute || !effectiveBoard || !effectiveAlight) return false;
    return (
      routeMatchesBus(selectedRoute, browse.bus) &&
      selectedRoute.boardStopId === effectiveBoard.stopId &&
      selectedRoute.alightStopId === effectiveAlight.stopId
    );
  }, [browse?.bus, selectedRoute, effectiveBoard, effectiveAlight]);

  useEffect(() => {
    depsAbortRef.current?.abort();
    if (!browse?.bus || !effectiveBoard?.stopId || !effectiveAlight?.stopId) {
      setPopupDepartures(null);
      setPopupDeparturesLoading(false);
      return;
    }
    const controller = new AbortController();
    depsAbortRef.current = controller;
    setPopupDeparturesLoading(true);
    const busKey = browse.bus;
    const routeId =
      plan?.routes.find(
        (r) =>
          routeMatchesBus(r, busKey) &&
          r.boardStopId === effectiveBoard.stopId &&
          r.alightStopId === effectiveAlight.stopId,
      )?.routeId ??
      plan?.routes.find((r) => routeMatchesBus(r, busKey))?.routeId ??
      null;
    void fetchBoardDepartures(
      {
        stopId: effectiveBoard.stopId,
        alightStopId: effectiveAlight.stopId,
        routeShortName: busShortName(busKey),
        routeId,
      },
      controller.signal,
    )
      .then((body) => {
        if (controller.signal.aborted) return;
        setPopupDepartures(body);
        setPopupDeparturesLoading(false);
      })
      .catch((err) => {
        if ((err as Error).name === "AbortError") return;
        console.error("[popup-departures]", err);
        if (!controller.signal.aborted) {
          setPopupDepartures(null);
          setPopupDeparturesLoading(false);
        }
      });
    return () => controller.abort();
  }, [
    browse?.bus,
    effectiveBoard?.stopId,
    effectiveAlight?.stopId,
    plan?.requestId,
  ]);

  const activePopupDeparture = useMemo((): ScheduledDeparture | null => {
    if (!browse?.bus) return null;
    // Schedule pick is an explicit trip; otherwise next bus you can catch after walking.
    if (browseMatchesSelectedRoute && overrideDeparture) return overrideDeparture;
    return pickNextCatchableDeparture(
      popupDepartures?.departures,
      popupDepartures?.nowSecs,
      walkSecondsToBoard,
    );
  }, [
    browse?.bus,
    browseMatchesSelectedRoute,
    overrideDeparture,
    popupDepartures,
    walkSecondsToBoard,
  ]);

  const nextDepartureLabel = useMemo(() => {
    if (!browse?.bus) return null;
    if (popupDeparturesLoading && !popupDepartures) return "…";
    return formatNextBusIn(activePopupDeparture, popupDepartures?.nowSecs);
  }, [
    browse?.bus,
    activePopupDeparture,
    popupDepartures,
    popupDeparturesLoading,
  ]);

  // Align timed path with "Next bus" — planner sample tripId is only for connectivity.
  const nextInstanceTripId = activePopupDeparture?.tripId ?? null;
  const nextInstanceBoardId = effectiveBoard?.stopId ?? null;
  const nextInstanceAlightId = effectiveAlight?.stopId ?? null;
  useEffect(() => {
    if (!browse?.bus || !nextInstanceTripId || !nextInstanceBoardId || !nextInstanceAlightId) {
      return;
    }
    if (tripPath?.tripId === nextInstanceTripId) return;
    // Don't abort the initial line fetch — that race left the map with no transit line.

    const controller = new AbortController();
    instanceAbortRef.current?.abort();
    instanceAbortRef.current = controller;
    void fetchTripPath(
      nextInstanceTripId,
      nextInstanceBoardId,
      nextInstanceAlightId,
      controller.signal,
    )
      .then((path) => {
        if (controller.signal.aborted) return;
        setTripPath(path);
      })
      .catch((err) => {
        if ((err as Error).name === "AbortError") return;
        console.warn("[trip-path] next-departure instance failed", err);
        if (!controller.signal.aborted && !tripPath) {
          const raw = err instanceof Error ? err.message : "Failed to load line path";
          setPathError(`Couldn't load this line's path. ${raw.slice(0, 280)}`);
        }
      });

    return () => controller.abort();
  }, [
    browse?.bus,
    nextInstanceTripId,
    nextInstanceBoardId,
    nextInstanceAlightId,
    tripPath?.tripId,
  ]);

  const stationCount = scrollStations.length;

  function clearLineSelection() {
    pathAbortRef.current?.abort();
    pathAbortRef.current = null;
    instanceAbortRef.current?.abort();
    instanceAbortRef.current = null;
    depsAbortRef.current?.abort();
    depsAbortRef.current = null;
    openedFromCardRef.current = null;
    setBrowse(null);
    setTripPath(null);
    setPathLoading(false);
    setPathError(null);
    setPopupDepartures(null);
    setPopupDeparturesLoading(false);
    fittedPathKey.current = null;
    onSelectStopRef.current?.(null);
    onLineActiveChangeRef.current?.(false);
    onBrowseRouteChangeRef.current?.(null);
  }

  function focusScrollEnd(end: ScrollEnd) {
    if (!browse?.bus) return;
    const list = end === "alight" ? alightScrollStations : boardScrollStations;
    // Keep the already-chosen station for this end; only jump to recommended if none yet.
    const keepId =
      end === "alight"
        ? (browse.chosenAlightId ?? recommendedAlightId)
        : (browse.chosenBoardId ?? recommendedBoardId);
    if (!list.length) {
      setBrowse({
        ...browse,
        scrollEnd: end,
        index: 0,
        chosenBoardId: browse.chosenBoardId ?? recommendedBoardId,
        chosenAlightId: browse.chosenAlightId ?? recommendedAlightId,
      });
      return;
    }
    let index = keepId != null ? list.findIndex((s) => s.stopId === keepId) : -1;
    if (index < 0) index = 0;
    const stop = list[index]!;
    setBrowse({
      ...browse,
      scrollEnd: end,
      index,
      preferredStopId: stop.stopId,
      chosenBoardId: browse.chosenBoardId ?? recommendedBoardId,
      chosenAlightId: browse.chosenAlightId ?? recommendedAlightId,
    });
    onSelectStopRef.current?.(stop.stopId);
  }

  async function loadTripPathForBus(
    bus: string,
    preferredStopId: string | null,
    buses: string[],
    forcedRoute?: DirectRoute | null,
  ) {
    if (!plan) return;
    const route =
      forcedRoute ??
      pickRouteForBus(plan.routes, bus, preferredStopId, destination, origin);
    pathAbortRef.current?.abort();
    instanceAbortRef.current?.abort();
    instanceAbortRef.current = null;
    const controller = new AbortController();
    pathAbortRef.current = controller;

    const stopMeta = preferredStopId
      ? plan.validStops.find((s) => s.stopId === preferredStopId)
      : null;
    const openingAtAlight =
      Boolean(preferredStopId) &&
      (stopMeta?.role === "alighting" ||
        route?.alightStopId === preferredStopId);

    setPathLoading(true);
    setPathError(null);
    fittedPathKey.current = null;
    setBrowse({
      bus,
      buses,
      index: 0,
      preferredStopId,
      scrollEnd: openingAtAlight ? "alight" : "board",
      chosenBoardId: route?.boardStopId ?? null,
      chosenAlightId: route?.alightStopId ?? null,
    });
    // Don't draw a straight board→alight chord while the real shape loads.
    // Clearing React state (not the map source) keeps the previous line until fetch returns.
    setTripPath(null);
    if (preferredStopId) onSelectStopRef.current?.(preferredStopId);
    onLineActiveChangeRef.current?.(true);
    if (route) {
      openedFromCardRef.current = selectedOptionKey(route);
      onBrowseRouteChangeRef.current?.(route);
    }

    const routeMode =
      route?.planMode ??
      (stopMeta?.planModes?.length === 1 ? stopMeta.planModes[0]! : null) ??
      (stopMeta?.role === "alighting"
        ? "transit_walk"
        : stopMeta?.role === "boarding"
          ? "walk_transit"
          : null) ??
      plan.mode;
    const endpoint =
      routeMode === "walk_transit"
        ? destination
        : origin;

    try {
      let path: TripPathResponse;
      if (route) {
        console.info("[trip-path] start", {
          bus,
          tripId: route.tripId,
          boardStopId: route.boardStopId,
          alightStopId: route.alightStopId,
          mode: routeMode,
        });
        path = await fetchTripPath(
          route.tripId,
          route.boardStopId,
          route.alightStopId,
          controller.signal,
        );
      } else if (preferredStopId && endpoint) {
        console.info("[trip-path] resolve", { bus, preferredStopId, mode: routeMode });
        path = await resolveTripPath(
          {
            // Keep typed key (`3:5`) so API can disambiguate bus vs light rail.
            routeShortName: bus,
            stopId: preferredStopId,
            mode: routeMode,
            endpointLng: endpoint.lng,
            endpointLat: endpoint.lat,
          },
          controller.signal,
        );
      } else {
        throw new Error("No direct route for this bus");
      }

      if (controller.signal.aborted) return;
      const scrollStops = path.stops;
      const onPathStops = path.stops.filter((s) => s.onPath);
      const boardId = path.stops.find((s) => s.isBoard)?.stopId ?? path.boardStopId;
      const pathAlightId =
        path.stops.find((s) => s.isAlight)?.stopId ?? path.alightStopId;
      const boardIdx = scrollStops.findIndex((s) => s.stopId === boardId);
      const preferredIdx = preferredStopId
        ? scrollStops.findIndex((s) => s.stopId === preferredStopId)
        : -1;
      const clickedIsAlight =
        Boolean(preferredStopId) &&
        (openingAtAlight ||
          preferredStopId === pathAlightId ||
          (preferredIdx > boardIdx && boardIdx >= 0));

      const focusAlightId =
        clickedIsAlight && preferredStopId ? preferredStopId : pathAlightId;

      let scrollEnd: ScrollEnd = "board";
      let index = 0;
      let focusBoardId = boardId;
      let focusStopId: string | null = boardId;

      if (clickedIsAlight) {
        // Destination pin: open Get-off stepper on the selected station.
        scrollEnd = "alight";
        const alightSide =
          boardIdx >= 0 && boardIdx < scrollStops.length - 1
            ? scrollStops.slice(boardIdx + 1)
            : boardIdx === scrollStops.length - 1
              ? scrollStops.slice(boardIdx)
              : scrollStops;
        index = alightSide.findIndex((s) => s.stopId === focusAlightId);
        if (index < 0) index = 0;
        focusStopId = alightSide[index]?.stopId ?? focusAlightId;
        focusBoardId = boardId;
      } else {
        // Origin / default: Get-on at recommended board (list stops 1 before get-off).
        const alightIdx = scrollStops.findIndex((s) => s.stopId === focusAlightId);
        const boardSide =
          alightIdx > 0
            ? scrollStops.slice(0, alightIdx)
            : alightIdx === 0
              ? scrollStops.slice(0, 1)
              : scrollStops;
        index = boardSide.findIndex((s) => s.stopId === boardId);
        if (index < 0) index = 0;
        if (preferredStopId) {
          const preferred = boardSide.findIndex((s) => s.stopId === preferredStopId);
          if (preferred >= 0) index = preferred;
        }
        focusBoardId = boardSide[index]?.stopId ?? boardId;
        focusStopId = preferredStopId ?? focusBoardId;
      }

      console.info("[trip-path] ok", {
        bus,
        stops: path.stops.length,
        onPath: onPathStops.length,
        coords: path.geometry.coordinates.length,
        focus: scrollEnd,
      });
      setTripPath(path);
      setBrowse({
        bus,
        buses,
        index,
        preferredStopId: focusStopId,
        scrollEnd,
        chosenBoardId: focusBoardId,
        chosenAlightId: focusAlightId,
      });
      onSelectStopRef.current?.(focusStopId);
      fittedPathKey.current = null;
    } catch (err) {
      if ((err as Error).name === "AbortError") return;

      const raw = err instanceof Error ? err.message : "Failed to load line path";
      const message = raw.startsWith("Couldn't load")
        ? raw
        : `Couldn't load this line's path. ${raw.slice(0, 280)}`;
      console.error("[trip-path] failed", { bus, err });
      setPathError(message);
      setTripPath(null);
      setBrowse({
        bus,
        buses,
        index: 0,
        preferredStopId,
        scrollEnd: openingAtAlight ? "alight" : "board",
        chosenBoardId: route?.boardStopId ?? preferredStopId,
        chosenAlightId: route?.alightStopId ?? null,
      });
    } finally {
      if (!controller.signal.aborted) setPathLoading(false);
    }
  }

  openBrowseRef.current = (stopId: string, buses: string[]) => {
    if (!buses.length) return;
    const merged = [...new Set(buses)].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    );
    // Load the first line immediately so the board→get-off route appears.
    void loadTripPathForBus(merged[0]!, stopId, merged);
  };

  selectLineStopRef.current = (stopId: string) => {
    if (!browse?.bus || !lineStations.length) return false;
    const inBoard = boardScrollStations.findIndex((s) => s.stopId === stopId);
    const inAlight = alightScrollStations.findIndex((s) => s.stopId === stopId);
    if (inBoard < 0 && inAlight < 0) {
      const activeIdx = scrollStations.findIndex((s) => s.stopId === stopId);
      if (activeIdx < 0) return false;
      setBrowse({
        ...browse,
        index: activeIdx,
        preferredStopId: stopId,
        chosenBoardId:
          browse.scrollEnd === "board" ? stopId : browse.chosenBoardId,
        chosenAlightId:
          browse.scrollEnd === "alight" ? stopId : browse.chosenAlightId,
      });
      onSelectStopRef.current?.(stopId);
      return true;
    }
    const scrollEnd: ScrollEnd =
      inAlight >= 0 && (browse.scrollEnd === "alight" || inBoard < 0) ? "alight" : "board";
    const index = scrollEnd === "alight" ? inAlight : inBoard;
    setBrowse({
      ...browse,
      scrollEnd,
      index,
      preferredStopId: stopId,
      chosenBoardId: scrollEnd === "board" ? stopId : browse.chosenBoardId,
      chosenAlightId: scrollEnd === "alight" ? stopId : browse.chosenAlightId,
    });
    onSelectStopRef.current?.(stopId);
    return true;
  };

  const selectedRouteKey = selectedOptionKey(selectedRoute);

  useEffect(() => {
    if (!selectedRoute || !plan || !selectedRouteKey) return;
    if (openedFromCardRef.current === selectedRouteKey) return;
    openedFromCardRef.current = selectedRouteKey;
    const bus = routeBusName(selectedRoute);
    // Open map path focused on the boarding station for this option.
    void loadTripPathForBus(bus, selectedRoute.boardStopId, [bus], selectedRoute);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadTripPathForBus closes over latest plan/endpoints
  }, [selectedRouteKey, plan, selectedRoute]);

  useEffect(() => {
    if (selectedRouteKey) return;
    const wasFromCard = openedFromCardRef.current != null;
    openedFromCardRef.current = null;
    if (wasFromCard) {
      fittedPlanId.current = null;
      clearLineSelection();
    }
  }, [selectedRouteKey]);

  const syncEndpointMarkers = useRef(() => {
    const map = mapRef.current;
    if (!map) return;

    const syncMarker = (
      markerRef: { current: maplibregl.Marker | null },
      point: LatLng | null,
      kind: "origin" | "destination",
      label: string | null | undefined,
    ) => {
      if (!isValidLngLat(point)) {
        markerRef.current?.remove();
        markerRef.current = null;
        return;
      }
      const nextEl = createEndpointMarkerElement(kind, label);
      // Pin tip must sit on the true lat/lng at every zoom — never use a screen-pixel
      // Marker offset (that becomes hundreds of meters when zoomed out).
      const nextKey = `v2:${kind}:${label ?? ""}`;
      if (!markerRef.current) {
        markerRef.current = new maplibregl.Marker({
          element: nextEl,
          anchor: "bottom",
        });
      } else {
        const prev = markerRef.current.getElement();
        const prevKey = prev?.dataset.endpointKey ?? "";
        if (prevKey !== nextKey) {
          markerRef.current.remove();
          markerRef.current = new maplibregl.Marker({
            element: nextEl,
            anchor: "bottom",
          });
        }
      }
      markerRef.current.getElement().dataset.endpointKey = nextKey;
      // MapLibre requires coordinates before addTo — otherwise it throws and blanks the app.
      markerRef.current.setLngLat([point.lng, point.lat]);
      if (!markerRef.current.getElement().isConnected) {
        markerRef.current.addTo(map);
      }
    };

    syncMarker(originMarkerRef, originRef.current, "origin", originLabelRef.current);
    syncMarker(
      destinationMarkerRef,
      destinationRef.current,
      "destination",
      destinationLabelRef.current,
    );
  });

  /** Pre-plan only: dashed O↔D walk path + time chip on the midpoint. */
  const syncWalkPreview = useRef((showLabel: boolean) => {
    const map = mapRef.current;
    if (!map) return;
    const originPoint = originRef.current;
    const destinationPoint = destinationRef.current;
    const routeLine = map.getSource("route-line") as GeoJSONSource | undefined;
    const canDraw =
      isValidLngLat(originPoint) && isValidLngLat(destinationPoint);

    if (!canDraw) {
      routeLine?.setData(EMPTY_LINE);
      walkLabelMarkerRef.current?.remove();
      walkLabelMarkerRef.current = null;
      return;
    }

    routeLine?.setData(buildOdWalkGeoJson(originPoint, destinationPoint) as never);

    if (!showLabel) {
      walkLabelMarkerRef.current?.remove();
      walkLabelMarkerRef.current = null;
      return;
    }

    const minutes = walkMinutesBetween(originPoint, destinationPoint);
    const mid: [number, number] = [
      (originPoint.lng + destinationPoint.lng) / 2,
      (originPoint.lat + destinationPoint.lat) / 2,
    ];
    const nextKey = `walk:${minutes}:${mid[0].toFixed(5)},${mid[1].toFixed(5)}`;
    const prevKey = walkLabelMarkerRef.current?.getElement()?.dataset.walkLabelKey ?? "";
    if (!walkLabelMarkerRef.current || prevKey !== nextKey) {
      walkLabelMarkerRef.current?.remove();
      const el = createWalkLineLabelElement(minutes);
      el.dataset.walkLabelKey = nextKey;
      walkLabelMarkerRef.current = new maplibregl.Marker({
        element: el,
        anchor: "center",
      })
        .setLngLat(mid)
        .addTo(map);
    } else {
      walkLabelMarkerRef.current.setLngLat(mid);
    }
  });

  const whenMapReady = useRef((fn: () => void) => {
    const map = mapRef.current;
    if (!map) return;
    // After source updates, isStyleLoaded() can briefly be false and "load" won't
    // fire again — use idle so endpoint markers still refresh after plan clear.
    if (map.isStyleLoaded()) {
      fn();
      return;
    }
    map.once("idle", fn);
  });

  const focusEndpoints = useRef(() => {
    const map = mapRef.current;
    if (!map) return;
    const originPoint = originRef.current;
    const destinationPoint = destinationRef.current;
    const points = [originPoint, destinationPoint].filter(isValidLngLat);
    if (!points.length) return;
    requestAnimationFrame(() => {
      const live = mapRef.current;
      if (!live) return;
      safeFitBounds(live, points, {
        maxZoom: 15,
        duration: 450,
        padding: fitPaddingForPopup(false),
      });
    });
  });

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    ensureRtlTextPlugin();
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      center: [34.78, 32.08],
      zoom: 12,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    map.on("load", () => {
      map.addSource("isochrone", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "isochrone-fill",
        type: "fill",
        source: "isochrone",
        paint: {
          "fill-color": [
            "case",
            ["==", ["get", "planMode"], "transit_walk"],
            "#b91c1c",
            "#0f766e",
          ],
          "fill-opacity": 0.1,
        },
      });
      map.addLayer({
        id: "isochrone-line",
        type: "line",
        source: "isochrone",
        paint: {
          "line-color": [
            "case",
            ["==", ["get", "planMode"], "transit_walk"],
            "#b91c1c",
            "#0f766e",
          ],
          "line-width": 1.5,
          "line-opacity": 0.75,
        },
      });

      map.addSource("route-line", {
        type: "geojson",
        data: EMPTY_LINE,
      });
      map.addLayer({
        id: "route-line-transit-outside",
        type: "line",
        source: "route-line",
        filter: ["==", ["get", "kind"], "transitOutside"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#94a3b8",
          "line-width": 4,
          "line-opacity": 0.85,
        },
      });
      map.addLayer({
        id: "route-line-transit",
        type: "line",
        source: "route-line",
        filter: ["==", ["get", "kind"], "transit"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#2563eb",
          "line-width": 5.5,
          "line-opacity": 0.95,
        },
      });
      map.addLayer({
        id: "route-line-walk",
        type: "line",
        source: "route-line",
        filter: ["==", ["get", "kind"], "walk"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#16a34a",
          "line-width": 3.5,
          "line-opacity": 0.95,
          "line-dasharray": [1.8, 1.4],
        },
      });
      map.addLayer({
        id: "route-line-walk-after",
        type: "line",
        source: "route-line",
        filter: ["==", ["get", "kind"], "walkAfter"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#dc2626",
          "line-width": 3.5,
          "line-opacity": 0.95,
          "line-dasharray": [1.8, 1.4],
        },
      });
      map.addLayer({
        id: "route-line-walk-ends",
        type: "circle",
        source: "route-line",
        filter: ["==", ["get", "kind"], "walkEnd"],
        paint: {
          "circle-radius": 3.25,
          "circle-color": "#16a34a",
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#fff",
        },
      });
      map.addLayer({
        id: "route-line-walk-after-ends",
        type: "circle",
        source: "route-line",
        filter: ["==", ["get", "kind"], "walkAfterEnd"],
        paint: {
          "circle-radius": 3.25,
          "circle-color": "#dc2626",
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#fff",
        },
      });

      map.addSource("stops", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "stops-circle",
        type: "circle",
        source: "stops",
        paint: {
          // Line stops (incl. selected) stay fixed size — selection uses stroke only.
          "circle-radius": [
            "case",
            ["==", ["get", "dim"], true],
            5,
            ["==", ["get", "lineStop"], true],
            5,
            [
              "match",
              ["get", "freqBucket"],
              "under_5",
              11,
              "about_10",
              9,
              "about_20",
              7,
              "over_30",
              5,
              6.5,
            ],
          ],
          "circle-color": [
            "case",
            ["==", ["get", "dim"], true],
            "#94a3b8",
            ["==", ["get", "freqBucket"], "unknown"],
            "#94a3b8",
            [
              "match",
              ["get", "role"],
              "boarding",
              "#15803d",
              "alighting",
              "#b91c1c",
              "both",
              "#7c3aed",
              "#334155",
            ],
          ],
          // Keep stroke width constant so selection does not enlarge the pin.
          "circle-stroke-width": [
            "case",
            ["==", ["get", "dim"], true],
            1,
            2,
          ],
          "circle-stroke-color": [
            "case",
            ["==", ["get", "dim"], true],
            "rgba(255,255,255,0.55)",
            ["==", ["get", "selected"], true],
            "#0f172a",
            ["==", ["get", "freqBucket"], "unknown"],
            "rgba(255,255,255,0.9)",
            "#fff",
          ],
          "circle-opacity": [
            "case",
            ["==", ["get", "dim"], true],
            0.35,
            ["==", ["get", "freqBucket"], "unknown"],
            0.75,
            ["==", ["get", "outside"], true],
            0.55,
            1,
          ],
          "circle-stroke-opacity": [
            "case",
            ["==", ["get", "dim"], true],
            0.4,
            1,
          ],
        },
      });
      // Keep stop hits above the route line so line stations stay clickable
      map.moveLayer("route-line-transit-outside");
      map.moveLayer("route-line-transit");
      map.moveLayer("route-line-walk");
      if (map.getLayer("route-line-walk-after")) map.moveLayer("route-line-walk-after");
      if (map.getLayer("route-line-walk-ends")) map.moveLayer("route-line-walk-ends");
      if (map.getLayer("route-line-walk-after-ends")) {
        map.moveLayer("route-line-walk-after-ends");
      }
      map.moveLayer("stops-circle");

      map.on("mouseenter", "stops-circle", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "stops-circle", () => {
        map.getCanvas().style.cursor = "";
      });

      map.on("click", "stops-circle", (e: MapLayerMouseEvent) => {
        e.originalEvent.stopPropagation();
        suppressMapClickRef.current = true;
        const feature = e.features?.[0];
        if (!feature) return;
        const props = feature.properties ?? {};
        const stopId = String(props.stopId ?? "");
        if (!stopId) return;

        // MapLibre stringifies properties — treat any truthy lineStop as on-line
        const isLineStop = ["true", "1", true, 1].includes(props.lineStop as never);
        const isEndpoint =
          props.endpoint === "alight" ||
          props.endpoint === "board" ||
          String(props.endpoint ?? "") === "alight" ||
          String(props.endpoint ?? "") === "board";

        // When a line is open, move the station stepper. Otherwise open buses at this pin
        // (including red get-off pins — do not return early on a failed select).
        if (isLineStop || isEndpoint) {
          if (selectLineStopRef.current(stopId)) return;
        }

        const buses = String(props.buses ?? "")
          .split(",")
          .map((b) => b.trim())
          .filter(Boolean);
        openBrowseRef.current(stopId, buses);
      });

      map.on("click", (e) => {
        // Defer so the stops-circle handler can mark the click first
        window.setTimeout(() => {
          if (suppressMapClickRef.current) {
            suppressMapClickRef.current = false;
            return;
          }
          const hits = map.queryRenderedFeatures(e.point, { layers: ["stops-circle"] });
          if (!hits.length) clearLineSelection();
        }, 0);
      });

      syncEndpointMarkers.current();
      focusEndpoints.current();
    });

    mapRef.current = map;
    return () => {
      originMarkerRef.current?.remove();
      destinationMarkerRef.current?.remove();
      originMarkerRef.current = null;
      destinationMarkerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    // Only reset map framing / line browse when a new Go result arrives.
    clearLineSelection();
    fittedPlanId.current = null;
  }, [plan?.requestId]);

  // Filters keep requestId stable — drop the open line if it was filtered out.
  useEffect(() => {
    if (!browse?.bus || !plan) return;
    const stillThere = plan.routes.some((r) => routeBusName(r) === browse.bus);
    if (!stillThere) clearLineSelection();
  }, [plan, browse?.bus]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const clearPlanLayers = () => {
      const iso = map.getSource("isochrone") as GeoJSONSource | undefined;
      const stops = map.getSource("stops") as GeoJSONSource | undefined;
      iso?.setData({ type: "FeatureCollection", features: [] });
      stops?.setData({ type: "FeatureCollection", features: [] });
      // Keep / draw the pre-plan walking path between selected endpoints.
      syncWalkPreview.current(true);
      whenMapReady.current(() => syncEndpointMarkers.current());
    };

    if (!plan) {
      whenMapReady.current(clearPlanLayers);
    } else {
      // Planned results own the route-line source; hide the pre-plan time chip.
      walkLabelMarkerRef.current?.remove();
      walkLabelMarkerRef.current = null;
    }
  }, [plan, origin, destination]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    whenMapReady.current(() => {
      syncEndpointMarkers.current();
      if (!plan) syncWalkPreview.current(true);
      focusEndpoints.current();
    });
  }, [origin, destination, originLabel, destinationLabel, plan]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !plan) return;

    const apply = () => {
      const iso = map.getSource("isochrone") as GeoJSONSource | undefined;
      const stops = map.getSource("stops") as GeoJSONSource | undefined;
      const routeLine = map.getSource("route-line") as GeoJSONSource | undefined;
      if (!iso || !stops || !routeLine) return;

      iso.setData(plan.isochrone as never);

      if (browse?.bus && tripPath) {
        routeLine.setData(
          buildJourneyGeoJson(origin, destination, tripPath, effectiveBoard, effectiveAlight) as never,
        );
      } else if (browse?.bus && pathError) {
        routeLine.setData(EMPTY_LINE);
      } else if (browse?.bus) {
        // Line is opening — keep whatever is on the map rather than reverting to the O/D walk.
      } else if (isValidLngLat(origin) && isValidLngLat(destination)) {
        // Browse after resolve: show direct walking path between endpoints.
        routeLine.setData(buildOdWalkGeoJson(origin, destination) as never);
      } else {
        routeLine.setData(EMPTY_LINE);
      }

      const features: Array<{
        type: "Feature";
        properties: Record<string, string | boolean | number>;
        geometry: { type: "Point"; coordinates: [number, number] };
      }> = [];

      if (browse?.bus && tripPath) {
        // Line selected: only this trip's stops. Active get-on/get-off drive pin roles.
        const activeBoardId = effectiveBoard?.stopId ?? null;
        const activeAlightId = effectiveAlight?.stopId ?? null;
        const boardSeq =
          tripPath.stops.find((s) => s.stopId === activeBoardId)?.stopSequence ??
          tripPath.stops.find((s) => s.isBoard)?.stopSequence ??
          null;
        const alightSeq =
          tripPath.stops.find((s) => s.stopId === activeAlightId)?.stopSequence ??
          tripPath.stops.find((s) => s.isAlight)?.stopSequence ??
          null;
        for (const stop of tripPath.stops) {
          const isActiveBoard = activeBoardId != null && stop.stopId === activeBoardId;
          const isActiveAlight = activeAlightId != null && stop.stopId === activeAlightId;
          const beforeBoard =
            boardSeq != null &&
            stop.stopSequence < boardSeq &&
            !isActiveBoard;
          const afterAlight =
            alightSeq != null &&
            stop.stopSequence > alightSeq &&
            !isActiveAlight;
          const outsideSelectedRide =
            (beforeBoard || afterAlight) && !isActiveBoard && !isActiveAlight;
          const role = isActiveAlight
            ? "alighting"
            : isActiveBoard
              ? "boarding"
              : stop.isAlight
                ? "alighting"
                : "boarding";
          features.push({
            type: "Feature",
            properties: {
              stopId: stop.stopId,
              name: stop.name,
              role,
              selected: Boolean(isActiveBoard || isActiveAlight),
              dim: outsideSelectedRide,
              lineStop: true,
              endpoint: isActiveAlight ? "alight" : isActiveBoard ? "board" : "",
              outside: !walkingStopIds.has(stop.stopId),
              buses: browse.bus,
              freqBucket: "unknown",
            },
            geometry: {
              type: "Point",
              coordinates: [stop.lng, stop.lat],
            },
          });
        }
      } else {
        // No line selected: only plan board/alight option pins (no intermediate line stops).
        const mapPins = buildMapPins(
          plan.routes,
          stopMeta,
          origin,
          destination,
          null,
          null,
        );
        for (const { stop: s, boardBuses, alightBuses } of mapPins) {
          const role =
            alightBuses.length > 0 && boardBuses.length === 0
              ? "alighting"
              : boardBuses.length > 0 && alightBuses.length > 0
                ? "both"
                : "boarding";
          const freqBuses =
            role === "alighting"
              ? alightBuses
              : role === "boarding"
                ? boardBuses
                : [...new Set([...boardBuses, ...alightBuses])];
          const freqEnd =
            role === "alighting" ? "alight" : role === "boarding" ? "board" : "either";
          const freqBucket = pinFreqBucket(s, freqBuses, plan.routes, freqEnd);
          const buses = [...new Set([...boardBuses, ...alightBuses])];
          features.push({
            type: "Feature",
            properties: {
              stopId: s.stopId,
              name: s.name,
              role,
              selected: Boolean(
                selectedRoute &&
                  (selectedRoute.boardStopId === s.stopId ||
                    selectedRoute.alightStopId === s.stopId),
              ),
              dim: false,
              lineStop: false,
              endpoint: role === "alighting" ? "alight" : "",
              outside: !s.inWalkingArea,
              buses: buses.join(","),
              freqBucket,
            },
            geometry: {
              type: "Point",
              coordinates: [s.lng, s.lat],
            },
          });
        }
      }

      stops.setData({ type: "FeatureCollection", features });
      if (map.getLayer("stops-circle")) map.moveLayer("stops-circle");

      if (browse?.bus && tripPath) {
        // Fit once per board/alight pair — swapping to the next-departure tripId must not re-zoom.
        const pathKey = `${browse.bus}:${effectiveBoard?.stopId ?? tripPath.boardStopId}:${effectiveAlight?.stopId ?? tripPath.alightStopId}`;
        if (fittedPathKey.current !== pathKey) {
          fittedPathKey.current = pathKey;
          const points: LatLng[] = [];
          for (const coord of tripPath.geometry.coordinates) {
            const lng = coord[0];
            const lat = coord[1];
            if (Number.isFinite(lng) && Number.isFinite(lat)) {
              points.push({ lng, lat });
            }
          }
          const board = tripPath.stops.find((s) => s.isBoard);
          const alight =
            tripPath.stops.find((s) => s.isAlight) ??
            tripPath.stops.find((s) => s.stopId === tripPath.alightStopId);
          if (board) points.push({ lng: board.lng, lat: board.lat });
          if (alight) points.push({ lng: alight.lng, lat: alight.lat });
          // Frame the ride segment so board + alight stay visible (walk O/D may lie outside).
          safeFitBounds(map, points, {
            maxZoom: 14,
            duration: 500,
            padding: fitPaddingForPopup(Boolean(!selectedRoute)),
          });
        } else if (currentStation && !selectedRoute) {
          const points: LatLng[] = [];
          if (isValidLngLat(origin)) points.push(origin);
          if (isValidLngLat(destination)) points.push(destination);
          points.push({ lng: currentStation.lng, lat: currentStation.lat });
          safeFitBounds(map, points, {
            maxZoom: 14,
            duration: 350,
            padding: fitPaddingForPopup(true),
          });
        }
        return;
      }

      // While the line path is loading, keep the current view (don't zoom into the stop).
      if (browse && pathLoading) return;

      if (fittedPlanId.current !== plan.requestId) {
        fittedPlanId.current = plan.requestId;
        // Browse state: zoom out only enough to keep origin + destination in view.
        const points: LatLng[] = [];
        if (isValidLngLat(origin)) points.push(origin);
        if (isValidLngLat(destination)) points.push(destination);
        safeFitBounds(map, points, {
          maxZoom: 15,
          duration: 600,
          padding: { top: 72, bottom: 96, left: 56, right: 56 },
        });
      }

      syncEndpointMarkers.current();
    };

    whenMapReady.current(apply);
  }, [
    plan,
    selectedRoute,
    origin,
    destination,
    browse,
    currentStation,
    effectiveBoard,
    effectiveAlight,
    busStations,
    tripPath,
    pathLoading,
    pathError,
    walkingStopIds,
  ]);

  function selectBus(bus: string) {
    if (!browse || bus === browse.bus) return;
    const preferred =
      currentStation?.stopId ?? browse.preferredStopId ?? null;
    const buses = [...new Set([...browse.buses, bus])];
    void loadTripPathForBus(bus, preferred, buses);
  }

  function restoreRecommendedPath() {
    if (!browse?.bus) return;
    const boardId = recommendedBoardId;
    const route =
      selectedRoute && routeBusName(selectedRoute) === browse.bus
        ? selectedRoute
        : plan
          ? pickRouteForBus(plan.routes, browse.bus, boardId, destination, origin)
          : null;
    // Reloads path and resets stepper to recommended get-on (scrollEnd: board).
    void loadTripPathForBus(
      browse.bus,
      boardId ?? route?.boardStopId ?? null,
      browse.buses,
      route,
    );
  }

  function stepStation(delta: number) {
    if (!browse || scrollStations.length < 2) return;
    const next = Math.max(0, Math.min(scrollStations.length - 1, browse.index + delta));
    if (next === browse.index) return;
    const station = scrollStations[next]!;
    setBrowse({
      ...browse,
      index: next,
      preferredStopId: station.stopId,
      chosenBoardId:
        browse.scrollEnd === "board" ? station.stopId : browse.chosenBoardId,
      chosenAlightId:
        browse.scrollEnd === "alight" ? station.stopId : browse.chosenAlightId,
    });
    onSelectStopRef.current?.(station.stopId);
  }

  return (
    <div className="map-wrap">
      <div ref={containerRef} className="map-canvas" aria-label="Transit map" />
      {planning ? (
        <div className="map-status" role="status" aria-live="polite">
          <span className="spinner" aria-hidden />
          Planning walk + transit…
        </div>
      ) : null}
      {!planning && pathLoading ? (
        <div className="map-status" role="status" aria-live="polite">
          <span className="spinner" aria-hidden />
          Loading line path…
        </div>
      ) : null}
      {!planning && pathError && browse ? (
        <div className="map-status map-status-error" role="alert">
          {pathError}
        </div>
      ) : null}
      {browse && currentStation && !selectedRoute ? (
        <div className="bus-popup" role="dialog" aria-label="Bus station browser">
          <div className="bus-popup-toolbar">
            <div className="bus-popup-buses">
              {browse.buses.map((bus) => {
                const known = busFrequencyKnown.get(bus) === true;
                const active = bus === browse.bus;
                return (
                  <button
                    key={bus}
                    type="button"
                    className={[
                      "popup-bus",
                      active ? "active" : "",
                      known ? "" : "unknown-freq",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => selectBus(bus)}
                  >
                    {routeChipLabel(bus)}
                  </button>
                );
              })}
            </div>
            {browse.bus ? (
              <button
                type="button"
                className="bus-popup-reset"
                aria-label="Restore recommended path"
                title="Restore recommended path"
                onClick={restoreRecommendedPath}
              >
                Reset
              </button>
            ) : null}
          </div>
          {browse.bus ? (
            <>
              <p
                className={
                  lineHeadwaySeconds != null && lineHeadwaySeconds > 0
                    ? "popup-freq"
                    : "popup-freq unknown"
                }
              >
                {formatHeadway(lineHeadwaySeconds)}
              </p>
              <p className="popup-next">
                <span>
                  Next bus <strong>{nextDepartureLabel ?? "—"}</strong>
                </span>
                {onOpenSchedule && browseMatchesSelectedRoute ? (
                  <button
                    type="button"
                    className="info-chip"
                    aria-label="Show all departure times"
                    onClick={onOpenSchedule}
                  >
                    i
                  </button>
                ) : null}
              </p>

              <div className="popup-trip-ends" aria-label="Get on and get off">
                <button
                  type="button"
                  className={`popup-end board${browse.scrollEnd === "board" ? " active" : ""}`}
                  onClick={() => focusScrollEnd("board")}
                >
                  <em>Get on</em>
                  <strong>{effectiveBoard?.name ?? "…"}</strong>
                  <span>
                    {effectiveBoard && tripPath
                      ? (formatStopClock(
                          tripPath.stops.find((s) => s.stopId === effectiveBoard.stopId) ?? {
                            isBoard: true,
                          },
                        ) ?? "")
                      : ""}
                  </span>
                </button>
                <button
                  type="button"
                  className={`popup-end alight${browse.scrollEnd === "alight" ? " active" : ""}`}
                  onClick={() => focusScrollEnd("alight")}
                >
                  <em>Get off</em>
                  <strong>
                    {effectiveAlight?.name ??
                      (pathLoading ? "Loading…" : pathError ?? "Not found")}
                  </strong>
                  <span>
                    {effectiveAlight && tripPath
                      ? (formatStopClock(
                          tripPath.stops.find((s) => s.stopId === effectiveAlight.stopId) ?? {
                            isBoard: false,
                          },
                        ) ?? "")
                      : ""}
                  </span>
                </button>
              </div>

              {pathLoading ? (
                <p className="popup-muted">Loading path…</p>
              ) : null}
              <div className="bus-popup-nav">
                <button
                  type="button"
                  className="nav-arrow"
                  aria-label={
                    browse.scrollEnd === "alight"
                      ? "Previous get-off station"
                      : "Previous get-on station"
                  }
                  disabled={browse.index <= 0}
                  onClick={() => stepStation(-1)}
                >
                  ←
                </button>
                <div className="bus-popup-station">
                  <strong>
                    {browse.scrollEnd === "alight" ? "Get off · " : "Get on · "}
                    {currentStation.name}
                  </strong>
                  <span>
                    {(() => {
                      const pathStop = tripPath?.stops.find(
                        (s) => s.stopId === currentStation.stopId,
                      );
                      const clock = pathStop ? formatStopClock(pathStop) : null;
                      const parts: string[] = [];
                      if (linePositionLabel) parts.push(linePositionLabel);
                      if (clock) parts.push(clock);
                      const isRecommended =
                        currentStation.stopId ===
                        (browse.scrollEnd === "alight"
                          ? recommendedAlightId
                          : recommendedBoardId);
                      if (isRecommended) parts.push("Recommended");
                      return parts.length ? parts.join(" · ") : "On this line";
                    })()}
                  </span>
                </div>
                <button
                  type="button"
                  className="nav-arrow"
                  aria-label={
                    browse.scrollEnd === "alight"
                      ? "Next get-off station"
                      : "Next get-on station"
                  }
                  disabled={browse.index >= stationCount - 1}
                  onClick={() => stepStation(1)}
                >
                  →
                </button>
              </div>
              {walkSummary ? (
                <div className="walk-summary" aria-label="Trip time summary">
                  {walkSummary.walkToBoard != null ? (
                    <p>
                      <span>Walk to stop</span>
                      <strong>{formatWalkLeg(walkSummary.walkToBoard)}</strong>
                    </p>
                  ) : null}
                  {walkSummary.rideLabel ? (
                    <p>
                      <span>Ride</span>
                      <strong>{walkSummary.rideLabel}</strong>
                    </p>
                  ) : null}
                  {walkSummary.walkFromAlight != null ? (
                    <p>
                      <span>Walk after</span>
                      <strong>{formatWalkLeg(walkSummary.walkFromAlight)}</strong>
                    </p>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <>
              <div className="bus-popup-station bus-popup-station-solo">
                <strong>{currentStation.name}</strong>
                <span>
                  {currentStation.inWalkingArea
                    ? `${Math.round(currentStation.distanceMeters)} m from origin`
                    : "Outside walking area"}
                </span>
              </div>
              <p
                className={
                  stopHeadwaySeconds != null && stopHeadwaySeconds > 0
                    ? "popup-freq"
                    : "popup-freq unknown"
                }
              >
                {formatHeadway(stopHeadwaySeconds)}
              </p>
              <p className="popup-muted">Select a line to see its path and frequency</p>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
