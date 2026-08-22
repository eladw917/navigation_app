import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  type WalkAmenity,
} from "../api";
import {
  amenitiesAlongCorridors,
  amenityOnWalk,
  amenityWalkLegs,
  WALK_AMENITY_LABELS,
  type WalkAmenityFilter,
} from "../walkAmenities";
import {
  getWalkRoute,
  peekWalkRoute,
  straightLineWalk,
  walkPairKey,
  type WalkRouteResult,
} from "../walkRoute";
import { WalkAmenityList } from "./WalkAmenityList";

const WALK_ROUTE_DEBOUNCE_MS = 80;

const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const EMPTY_LINE = { type: "FeatureCollection" as const, features: [] };
const RTL_TEXT_PLUGIN_URL = `${import.meta.env.BASE_URL}mapbox-gl-rtl-text.js`;
const BASEMAP_POI_LAYERS = ["poi_transit", "poi_r1", "poi_r7", "poi_r20"] as const;

/** Liberty draws a bus-on-circle POI under our stop pins — hide it so drop-offs are not a red halo. */
function hideBasemapBusPois(map: MapLibreMap) {
  const notBus: maplibregl.FilterSpecification = [
    "match",
    ["get", "class"],
    ["bus"],
    false,
    true,
  ];
  for (const id of BASEMAP_POI_LAYERS) {
    if (!map.getLayer(id)) continue;
    if (id === "poi_transit") {
      map.setFilter(id, ["==", ["get", "class"], "airport"]);
      continue;
    }
    const existing = map.getFilter(id);
    map.setFilter(
      id,
      existing ? (["all", existing, notBus] as maplibregl.FilterSpecification) : notBus,
    );
  }
}

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
function clampFramePadding(
  w: number,
  h: number,
  requested: { top: number; bottom: number; left: number; right: number },
  minPad: number,
  keepBottom = false,
) {
  const minInnerH = keepBottom
    ? Math.max(80, Math.floor(h * 0.18))
    : Math.max(180, Math.floor(h * 0.42));
  const minInnerW = Math.max(160, Math.floor(w * 0.5));
  let top = requested.top;
  let bottom = requested.bottom;
  let left = requested.left;
  let right = requested.right;

  const shrinkVertical = () => {
    const inner = h - top - bottom;
    if (inner >= minInnerH) return;
    const need = minInnerH - inner;
    const cutTop = Math.min(need, Math.max(0, top - minPad));
    top -= cutTop;
    const still = need - cutTop;
    if (still > 0 && !keepBottom) bottom = Math.max(minPad, bottom - still);
  };
  const shrinkHorizontal = () => {
    const inner = w - left - right;
    if (inner >= minInnerW) return;
    const need = minInnerW - inner;
    const cut = Math.ceil(need / 2);
    left = Math.max(minPad, left - cut);
    right = Math.max(minPad, right - cut);
  };

  shrinkVertical();
  shrinkHorizontal();

  if (keepBottom) {
    const maxBottom = Math.max(minPad, h - top - minInnerH);
    bottom = Math.min(bottom, maxBottom);
  } else {
    const extraH = Math.floor((h - top - bottom - minInnerH) / 2);
    if (extraH >= 20) {
      const inset = Math.min(48, extraH);
      top += inset;
      bottom += inset;
    }
  }

  return { top, bottom, left, right };
}

function cameraForPaddedBounds(
  map: MapLibreMap,
  bounds: maplibregl.LngLatBounds,
  padding: { top: number; bottom: number; left: number; right: number },
  maxZoom: number,
) {
  return map.cameraForBounds(bounds, { padding, maxZoom });
}

function safeFitBounds(
  map: MapLibreMap,
  points: LatLng[],
  opts?: {
    maxZoom?: number;
    minZoom?: number;
    duration?: number;
    minPad?: number;
    keepBottom?: boolean;
    padding?: { top?: number; bottom?: number; left?: number; right?: number };
  },
) {
  const valid = points.filter(isValidLngLat);
  if (!valid.length) return;

  const el = map.getContainer();
  const w = el.clientWidth;
  const h = el.clientHeight;
  const sizeKey = `${w}x${h}`;
  const sized = map as MapLibreMap & { __fitSize?: string };
  if (sized.__fitSize !== sizeKey) {
    sized.__fitSize = sizeKey;
    map.resize();
  }
  if (w < 40 || h < 40) return;

  const maxZoom = opts?.maxZoom ?? 15;
  const minZoom = opts?.minZoom ?? 12;
  const duration = opts?.duration ?? 450;
  const minPad = opts?.minPad ?? 24;
  const edge = Math.max(minPad, Math.min(72, Math.floor(Math.min(w, h) * 0.1)));
  const padding = clampFramePadding(
    w,
    h,
    {
      top: opts?.padding?.top ?? edge,
      bottom: opts?.padding?.bottom ?? edge,
      left: opts?.padding?.left ?? edge,
      right: opts?.padding?.right ?? edge,
    },
    minPad,
    opts?.keepBottom === true,
  );

  const bounds = new maplibregl.LngLatBounds();
  for (const p of valid) bounds.extend([p.lng, p.lat]);
  if (bounds.isEmpty()) return;

  const cam = cameraForPaddedBounds(map, bounds, padding, maxZoom);
  if (!cam?.center) return;
  const zoom = Math.max(minZoom, Math.min(maxZoom, cam.zoom ?? maxZoom));

  map.stop();
  map.easeTo({
    center: cam.center,
    zoom,
    bearing: cam.bearing,
    duration,
    essential: true,
  });
}

type MapFocus = "board" | "alight";

const MAP_EDGE_PAD = { top: 56, bottom: 56, left: 44, right: 44 };
const FIT_INSET = { top: 20, bottom: 20, left: 20, right: 20 };

function popupCoverPx(map: MapLibreMap, popup: HTMLElement | null): number {
  if (!popup) return 0;
  const mapBox = map.getContainer().getBoundingClientRect();
  const cardBox = popup.getBoundingClientRect();
  return Math.max(0, Math.round(mapBox.bottom - cardBox.top));
}

function cameraPaddingForCard(
  map: MapLibreMap,
  popup: HTMLElement | null,
  reservePopup: boolean,
  extraTop = 0,
) {
  const h = map.getContainer().clientHeight;
  const top = MAP_EDGE_PAD.top + extraTop;
  if (!reservePopup) {
    return { top, bottom: MAP_EDGE_PAD.bottom, left: MAP_EDGE_PAD.left, right: MAP_EDGE_PAD.right };
  }
  const cover = popupCoverPx(map, popup) + 16;
  const minInner = 80;
  const bottom = Math.min(cover, Math.max(MAP_EDGE_PAD.bottom, h - top - minInner));
  return { top, bottom, left: MAP_EDGE_PAD.left, right: MAP_EDGE_PAD.right };
}

function fitPaddingForPopup(
  popupHeight: number | null,
  reservePopup: boolean,
  extraTop = 0,
) {
  const top = MAP_EDGE_PAD.top + extraTop;
  if (!reservePopup) {
    return { top, bottom: MAP_EDGE_PAD.bottom, left: MAP_EDGE_PAD.left, right: MAP_EDGE_PAD.right };
  }
  const card = (popupHeight && popupHeight > 0 ? popupHeight : 280) + 68;
  return { top, bottom: card, left: MAP_EDGE_PAD.left, right: MAP_EDGE_PAD.right };
}

function walkingCluster(
  stations: Array<{ lng: number; lat: number; inWalkingArea?: boolean }>,
  fallback: LatLng[] = [],
): LatLng[] {
  const inArea = stations.filter((s) => s.inWalkingArea === true && isValidLngLat(s));
  if (inArea.length) return inArea.map((s) => ({ lng: s.lng, lat: s.lat }));
  return fallback.filter(isValidLngLat);
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
  /** OSM places of the selected On-the-walk type (unfiltered by station). */
  walkAmenities?: WalkAmenity[];
  /** Selected amenity type; map/popup list only that category on the station walk. */
  walkAmenityCategory?: WalkAmenityFilter;
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

function formatWalkLeg(meters: number, seconds?: number): string {
  const m = Math.max(0, Math.round(meters));
  const duration = seconds ?? meters / WALK_SPEED_MPS;
  const minutes = Math.max(1, Math.round(duration / 60));
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

/** Plan get-on / get-off options for this line — not every stop on the GTFS trip. */
function plannedStationsAlongTrip(
  lineStations: LineStation[],
  plan: DirectPlanResponse,
  bus: string,
  end: "board" | "alight",
  chosenId: string | null,
  otherEndId: string | null,
  stopMeta: Map<string, ValidStop>,
  origin: LatLng | null,
): LineStation[] {
  const ids = new Set<string>();
  if (chosenId) ids.add(chosenId);
  for (const route of plan.routes) {
    if (routeBusName(route) !== bus) continue;
    ids.add(end === "board" ? route.boardStopId : route.alightStopId);
  }
  const otherIdx = otherEndId
    ? lineStations.findIndex((s) => s.stopId === otherEndId)
    : -1;
  const ordered: LineStation[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lineStations.length; i++) {
    const station = lineStations[i]!;
    if (!ids.has(station.stopId) || seen.has(station.stopId)) continue;
    if (end === "alight" && otherIdx >= 0 && i <= otherIdx && station.stopId !== chosenId) {
      continue;
    }
    if (end === "board" && otherIdx >= 0 && i >= otherIdx && station.stopId !== chosenId) {
      continue;
    }
    ordered.push(station);
    seen.add(station.stopId);
  }
  for (const id of ids) {
    if (seen.has(id)) continue;
    const fromLine = lineStations.find((s) => s.stopId === id);
    const fromMeta = stopMeta.get(id);
    const extra = fromLine ?? (fromMeta ? validStopToLineStation(fromMeta, origin) : null);
    if (!extra) continue;
    if (end === "board") ordered.unshift(extra);
    else ordered.push(extra);
    seen.add(id);
  }
  if (ordered.length) return ordered;
  const chosen = chosenId ? lineStations.find((s) => s.stopId === chosenId) : null;
  return chosen ? [chosen] : [];
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
  _destination: LatLng | null,
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
    for (const route of busRoutes) {
      addBus(
        route.boardStopId,
        route.boardStopName,
        route.boardLng,
        route.boardLat,
        bus,
        "board",
      );
      addBus(
        route.alightStopId,
        route.alightStopName,
        route.alightLng,
        route.alightLat,
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

/** Lines on the same map pin as this stop (shared best board/alight). */
function busesAtStopPin(
  routes: DirectRoute[],
  stopMeta: Map<string, ValidStop>,
  origin: LatLng | null,
  destination: LatLng | null,
  stopId: string,
  fallbackBus: string,
): string[] {
  const pin = buildMapPins(routes, stopMeta, origin, destination, null, null).find(
    (entry) => entry.stop.stopId === stopId,
  );
  const fromPin = pin ? [...new Set([...pin.boardBuses, ...pin.alightBuses])] : [];
  const buses = fromPin.includes(fallbackBus) ? fromPin : [fallbackBus, ...fromPin];
  return [...new Set(buses)].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
}

function sortBusesByFrequency(
  buses: string[],
  plan: DirectPlanResponse,
  currentStation: LineStation | null,
  stopMeta: Map<string, ValidStop>,
  preferredStopId: string | null,
): string[] {
  return [...new Set(buses)].sort((a, b) => {
    const ha = headwayForBus(plan, a, currentStation, stopMeta, preferredStopId);
    const hb = headwayForBus(plan, b, currentStation, stopMeta, preferredStopId);
    const va = ha != null && ha > 0 ? ha : Number.POSITIVE_INFINITY;
    const vb = hb != null && hb > 0 ? hb : Number.POSITIVE_INFINITY;
    if (va !== vb) return va - vb;
    return a.localeCompare(b, undefined, { numeric: true });
  });
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

function journeyFitPoints(
  origin: LatLng | null,
  destination: LatLng | null,
  tripPath: TripPathResponse,
  board: { lng: number; lat: number } | null,
  alight: { lng: number; lat: number } | null,
  walks?: {
    toBoard?: [number, number][] | null;
    fromAlight?: [number, number][] | null;
  },
): LatLng[] {
  const points: LatLng[] = [];
  const push = (lng: number, lat: number) => {
    if (Number.isFinite(lng) && Number.isFinite(lat)) points.push({ lng, lat });
  };
  if (origin && isValidLngLat(origin)) points.push(origin);
  if (destination && isValidLngLat(destination)) points.push(destination);
  if (board) push(board.lng, board.lat);
  if (alight) push(alight.lng, alight.lat);

  const allCoords =
    tripPath.geometry.coordinates.length >= 2
      ? (tripPath.geometry.coordinates as [number, number][])
      : tripPath.stops.map((s) => [s.lng, s.lat] as [number, number]);
  if (board && alight && allCoords.length >= 2) {
    const startIdx = nearestCoordIndex(allCoords, board);
    let endIdx = nearestCoordIndex(allCoords, alight);
    if (endIdx < startIdx) endIdx = allCoords.length - 1;
    for (const coord of allCoords.slice(startIdx, endIdx + 1)) {
      push(coord[0]!, coord[1]!);
    }
  }

  for (const line of [walks?.toBoard, walks?.fromAlight]) {
    if (!line) continue;
    for (const coord of line) push(coord[0]!, coord[1]!);
  }
  return points;
}

function buildJourneyGeoJson(
  origin: LatLng | null,
  destination: LatLng | null,
  tripPath: TripPathResponse,
  boardOverride: { lng: number; lat: number; stopId?: string } | null = null,
  alightOverride: { lng: number; lat: number; stopId?: string } | null = null,
  routedWalks?: {
    toBoard?: [number, number][] | null;
    fromAlight?: [number, number][] | null;
  },
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
    routed?: [number, number][] | null,
  ) => {
    const coordinates =
      routed && routed.length >= 2
        ? routed
        : ([
            [from.lng, from.lat],
            [to.lng, to.lat],
          ] as [number, number][]);
    features.push({
      type: "Feature",
      properties: { kind },
      geometry: {
        type: "LineString",
        coordinates,
      },
    });
    // Cap only at O/D — a cap on the stop sits on the station circle as a second ring.
    const endKind = kind === "walk" ? "walkEnd" : "walkAfterEnd";
    const cap = kind === "walk" ? from : to;
    features.push({
      type: "Feature",
      properties: { kind: endKind },
      geometry: {
        type: "Point",
        coordinates: [cap.lng, cap.lat],
      },
    });
  };

  if (origin && board) {
    pushWalkLeg("walk", origin, { lng: board.lng, lat: board.lat }, routedWalks?.toBoard);
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

    let rideCoords = allCoords.slice(startIdx, endIdx + 1);
    if (rideCoords.length < 2) {
      rideCoords = [
        [board.lng, board.lat],
        [alight?.lng ?? board.lng, alight?.lat ?? board.lat],
      ];
    }
    pushLine("transit", rideCoords);
  } else {
    pushLine("transit", allCoords);
  }

  if (destination && alight) {
    pushWalkLeg(
      "walkAfter",
      { lng: alight.lng, lat: alight.lat },
      destination,
      routedWalks?.fromAlight,
    );
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

/** Distinct from station pins: stops are circles (drop-off = red). Amenities are squares. */
const AMENITY_MARKER: Record<
  WalkAmenity["category"],
  { fill: string; stroke: string }
> = {
  cafe: { fill: "#f59e0b", stroke: "#78350f" },
  grocery: { fill: "#059669", stroke: "#064e3b" },
  bakery: { fill: "#fb923c", stroke: "#9a3412" },
  pharmacy: { fill: "#14b8a6", stroke: "#115e59" },
  atm: { fill: "#64748b", stroke: "#1e293b" },
  park: { fill: "#84cc16", stroke: "#3f6212" },
};

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function addAmenityMarkerImages(map: MapLibreMap) {
  const size = 64;
  for (const [category, colors] of Object.entries(AMENITY_MARKER)) {
    const id = `amenity-${category}`;
    if (map.hasImage(id)) continue;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    roundRectPath(ctx, 6, 6, size - 12, size - 12, 12);
    ctx.fillStyle = colors.fill;
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = colors.stroke;
    ctx.stroke();
    map.addImage(id, ctx.getImageData(0, 0, size, size), { pixelRatio: 2 });
  }
}

function amenitiesToGeoJson(
  amenities: WalkAmenity[],
  ctx?: {
    origin?: LatLng | null;
    destination?: LatLng | null;
    route?: DirectRoute | null;
  },
) {
  return {
    type: "FeatureCollection" as const,
    features: amenities.map((amenity) => {
      let walkNote = "On the walking path";
      if (ctx?.origin && ctx?.destination && ctx?.route) {
        const legs = amenityWalkLegs(amenity, ctx.origin, ctx.destination, ctx.route);
        walkNote =
          legs.toBoard && legs.fromAlight
            ? "On both walks"
            : legs.toBoard
              ? "On the walk to the stop"
              : legs.fromAlight
                ? "On the walk after the ride"
                : "On the walking path";
      }
      const metersFromOrigin = ctx?.origin
        ? Math.round(haversineMeters(ctx.origin, { lng: amenity.lng, lat: amenity.lat }))
        : 0;
      const metersFromDest = ctx?.destination
        ? Math.round(haversineMeters(ctx.destination, { lng: amenity.lng, lat: amenity.lat }))
        : 0;
      const meters =
        walkNote === "On the walk after the ride" && metersFromDest > 0
          ? metersFromDest
          : metersFromOrigin;
      return {
        type: "Feature" as const,
        properties: {
          id: amenity.id,
          name: amenity.name,
          category: amenity.category,
          walkNote,
          meters,
        },
        geometry: {
          type: "Point" as const,
          coordinates: [amenity.lng, amenity.lat] as [number, number],
        },
      };
    }),
  };
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
  maxWalkingSeconds: _maxWalkingSeconds = null,
  limitWalk: _limitWalk = false,
  onLineActiveChange,
  onBrowseRouteChange,
  walkAmenities = [],
  walkAmenityCategory = "any",
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const originMarkerRef = useRef<maplibregl.Marker | null>(null);
  const destinationMarkerRef = useRef<maplibregl.Marker | null>(null);
  const walkLabelMarkerRef = useRef<maplibregl.Marker | null>(null);
  const amenityPopupRef = useRef<maplibregl.Popup | null>(null);
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
  const [walkByKey, setWalkByKey] = useState<Record<string, WalkRouteResult>>({});
  const walkByKeyRef = useRef(walkByKey);
  walkByKeyRef.current = walkByKey;
  const [popupDepartures, setPopupDepartures] = useState<StopDeparturesResponse | null>(null);
  const [popupDeparturesLoading, setPopupDeparturesLoading] = useState(false);
  const [overviewFocus, setOverviewFocus] = useState<MapFocus>("board");
  const [popupHeight, setPopupHeight] = useState(0);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const boardFrameRef = useRef<LatLng[]>([]);
  const alightFrameRef = useRef<LatLng[]>([]);
  const overviewFocusRef = useRef<MapFocus>("board");
  const frameWalkWithAmenityRef = useRef<(point: LatLng) => void>(() => undefined);
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
   * Stepper lists are the plan's get-on / get-off options for this line, not the
   * full GTFS trip (terminus, earlier feeders, etc.).
   */
  const boardScrollStations = useMemo((): LineStation[] => {
    if (!browse?.bus || !plan) return [];
    return plannedStationsAlongTrip(
      lineStations,
      plan,
      browse.bus,
      "board",
      chosenBoardId,
      chosenAlightId,
      stopMeta,
      origin,
    );
  }, [browse?.bus, plan, lineStations, chosenBoardId, chosenAlightId, stopMeta, origin]);

  const alightScrollStations = useMemo((): LineStation[] => {
    if (!browse?.bus || !plan) return [];
    return plannedStationsAlongTrip(
      lineStations,
      plan,
      browse.bus,
      "alight",
      chosenAlightId,
      chosenBoardId,
      stopMeta,
      origin,
    );
  }, [browse?.bus, plan, lineStations, chosenAlightId, chosenBoardId, stopMeta, origin]);

  const scrollStations = useMemo((): LineStation[] => {
    if (!browse?.bus) return [];
    return browse.scrollEnd === "alight" ? alightScrollStations : boardScrollStations;
  }, [browse?.bus, browse?.scrollEnd, boardScrollStations, alightScrollStations]);

  // Keep the stepper on the chosen stop when the option list changes.
  useEffect(() => {
    if (!browse?.bus || !scrollStations.length) return;
    const preferred = browse.preferredStopId
      ? scrollStations.findIndex((s) => s.stopId === browse.preferredStopId)
      : -1;
    if (preferred >= 0) {
      if (preferred !== browse.index) {
        setBrowse((prev) => (prev ? { ...prev, index: preferred } : prev));
      }
      return;
    }
    if (browse.index < scrollStations.length) return;
    const next = scrollStations.length - 1;
    setBrowse((prev) => (prev ? { ...prev, index: next } : prev));
    onSelectStopRef.current?.(scrollStations[next]?.stopId ?? null);
  }, [browse?.bus, browse?.index, browse?.preferredStopId, browse?.scrollEnd, scrollStations]);

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

  const orderedBuses = useMemo(() => {
    if (!browse?.buses.length) return [];
    if (!plan) {
      return [...browse.buses].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true }),
      );
    }
    return sortBusesByFrequency(
      browse.buses,
      plan,
      currentStation,
      stopMeta,
      browse.preferredStopId,
    );
  }, [browse?.buses, browse?.preferredStopId, plan, currentStation, stopMeta]);

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

  const stationWalkAmenities = useMemo(() => {
    if (walkAmenityCategory === "any" || !walkAmenities.length) return [];
    if (!browse?.bus && !selectedRoute) return [];
    const originOk = isValidLngLat(origin);
    const destOk = isValidLngLat(destination);
    if (!originOk || !destOk) return [];
    const boardPt = effectiveBoard
      ? { lng: effectiveBoard.lng, lat: effectiveBoard.lat }
      : selectedRoute
        ? { lng: selectedRoute.boardLng, lat: selectedRoute.boardLat }
        : null;
    const alightPt = effectiveAlight
      ? { lng: effectiveAlight.lng, lat: effectiveAlight.lat }
      : selectedRoute
        ? { lng: selectedRoute.alightLng, lat: selectedRoute.alightLat }
        : null;
    const corridors: { from: LatLng; to: LatLng }[] = [];
    if (boardPt) corridors.push({ from: origin, to: boardPt });
    if (alightPt) corridors.push({ from: alightPt, to: destination });
    if (!corridors.length) return [];
    return amenitiesAlongCorridors(walkAmenities, corridors);
  }, [
    walkAmenityCategory,
    walkAmenities,
    origin,
    destination,
    browse?.bus,
    selectedRoute,
    effectiveBoard,
    effectiveAlight,
  ]);

  overviewFocusRef.current = overviewFocus;

  boardFrameRef.current = [
    ...(isValidLngLat(origin) ? [origin] : []),
    ...walkingCluster(
      boardScrollStations,
      effectiveBoard ? [{ lng: effectiveBoard.lng, lat: effectiveBoard.lat }] : [],
    ),
    ...(effectiveBoard
      ? [{ lng: effectiveBoard.lng, lat: effectiveBoard.lat }]
      : []),
    ...(!browse?.bus && plan
      ? plan.validStops
          .filter((s) => s.role !== "alighting")
          .map((s) => ({ lng: s.lng, lat: s.lat }))
      : []),
  ];
  alightFrameRef.current = [
    ...(isValidLngLat(destination) ? [destination] : []),
    ...walkingCluster(
      alightScrollStations,
      effectiveAlight ? [{ lng: effectiveAlight.lng, lat: effectiveAlight.lat }] : [],
    ),
    ...(effectiveAlight
      ? [{ lng: effectiveAlight.lng, lat: effectiveAlight.lat }]
      : []),
    ...(!browse?.bus && plan
      ? plan.validStops
          .filter((s) => s.role !== "boarding")
          .map((s) => ({ lng: s.lng, lat: s.lat }))
      : []),
  ];

  const linePositionLabel = useMemo(() => {
    if (!currentStation || !scrollStations.length) return null;
    const idx = scrollStations.findIndex((s) => s.stopId === currentStation.stopId);
    if (idx < 0) return null;
    return `${idx + 1} of ${scrollStations.length}`;
  }, [currentStation, scrollStations]);

  const walkSummary = useMemo(() => {
    if (!browse?.bus || !tripPath || !effectiveBoard || !effectiveAlight) return null;

    const boardPt = { lng: effectiveBoard.lng, lat: effectiveBoard.lat };
    const alightPt = { lng: effectiveAlight.lng, lat: effectiveAlight.lat };
    const toBoardRoute =
      origin && isValidLngLat(origin) ? walkByKey[walkPairKey(origin, boardPt)] : null;
    const fromAlightRoute =
      destination && isValidLngLat(destination)
        ? walkByKey[walkPairKey(alightPt, destination)]
        : null;

    const walkToBoard =
      toBoardRoute?.distanceMeters ??
      (origin && isValidLngLat(origin) ? haversineMeters(origin, boardPt) : null);
    const walkFromAlight =
      fromAlightRoute?.distanceMeters ??
      (destination && isValidLngLat(destination)
        ? haversineMeters(alightPt, destination)
        : null);
    const walkToBoardSeconds = toBoardRoute?.durationSeconds;
    const walkFromAlightSeconds = fromAlightRoute?.durationSeconds;

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
    return {
      walkToBoard,
      walkFromAlight,
      walkToBoardSeconds,
      walkFromAlightSeconds,
      rideLabel,
    };
  }, [browse?.bus, origin, destination, effectiveBoard, effectiveAlight, tripPath, walkByKey]);

  /**
   * Seconds to reach get-on, matching the Walk-to-stop row (rounded minutes),
   * plus the assumption that walking starts 1 minute from now (applied in pick).
   */
  const walkSecondsToBoard = useMemo(() => {
    const seconds = walkSummary?.walkToBoardSeconds;
    if (seconds != null && Number.isFinite(seconds) && seconds >= 0) {
      return Math.max(1, Math.round(seconds / 60)) * 60;
    }
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
  }, [walkSummary?.walkToBoard, walkSummary?.walkToBoardSeconds, origin, effectiveBoard]);

  useEffect(() => {
    if (!browse?.bus) return;
    if (!isValidLngLat(origin) || !isValidLngLat(destination)) return;

    const boardPt = effectiveBoard
      ? { lng: effectiveBoard.lng, lat: effectiveBoard.lat }
      : null;
    const alightPt = effectiveAlight
      ? { lng: effectiveAlight.lng, lat: effectiveAlight.lat }
      : null;

    const boardSuggested =
      Boolean(boardPt) && effectiveBoard?.stopId === recommendedBoardId;
    const alightSuggested =
      Boolean(alightPt) && effectiveAlight?.stopId === recommendedAlightId;

    const missing: { from: LatLng; to: LatLng }[] = [];
    const hydrated: Record<string, WalkRouteResult> = {};
    const straight: Record<string, WalkRouteResult> = {};

    const takeStraight = (from: LatLng, to: LatLng) => {
      const key = walkPairKey(from, to);
      if (walkByKeyRef.current[key]) return;
      straight[key] = straightLineWalk(from, to);
    };
    const takeOrs = (from: LatLng, to: LatLng) => {
      const key = walkPairKey(from, to);
      if (walkByKeyRef.current[key]) return;
      const peeked = peekWalkRoute(from, to);
      if (peeked) hydrated[key] = peeked;
      else missing.push({ from, to });
    };

    if (boardPt) {
      if (boardSuggested) takeOrs(origin, boardPt);
      else takeStraight(origin, boardPt);
    }
    if (alightPt) {
      if (alightSuggested) takeOrs(alightPt, destination);
      else takeStraight(alightPt, destination);
    }

    if (Object.keys(hydrated).length || Object.keys(straight).length) {
      setWalkByKey((prev) => ({ ...prev, ...straight, ...hydrated }));
    }
    if (!missing.length) return;

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void Promise.all(
        missing.map(async (leg) => {
          const result = await getWalkRoute(leg.from, leg.to, controller.signal);
          return [walkPairKey(leg.from, leg.to), result] as const;
        }),
      )
        .then((entries) => {
          if (controller.signal.aborted) return;
          setWalkByKey((prev) => {
            const next = { ...prev };
            for (const [key, result] of entries) next[key] = result;
            return next;
          });
        })
        .catch((err) => {
          if ((err as Error).name === "AbortError") return;
          console.warn("[walk-route]", err);
          if (controller.signal.aborted) return;
          setWalkByKey((prev) => {
            const next = { ...prev };
            for (const leg of missing) {
              const key = walkPairKey(leg.from, leg.to);
              if (!next[key]) next[key] = straightLineWalk(leg.from, leg.to);
            }
            return next;
          });
        });
    }, WALK_ROUTE_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    browse?.bus,
    recommendedBoardId,
    recommendedAlightId,
    currentStation,
    effectiveBoard,
    effectiveAlight,
    origin,
    destination,
  ]);

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
  const showStationPopup = Boolean(browse && currentStation && !planning);
  const lineSelected = Boolean(browse?.bus);
  const amenityRoute = useMemo((): DirectRoute | null => {
    if (selectedRoute) {
      const boardStation = chosenBoardId
        ? lineStations.find((s) => s.stopId === chosenBoardId)
        : null;
      const alightStation = chosenAlightId
        ? lineStations.find((s) => s.stopId === chosenAlightId)
        : null;
      return {
        ...selectedRoute,
        boardStopId: boardStation?.stopId ?? selectedRoute.boardStopId,
        boardStopName: boardStation?.name ?? selectedRoute.boardStopName,
        boardLng: boardStation?.lng ?? selectedRoute.boardLng,
        boardLat: boardStation?.lat ?? selectedRoute.boardLat,
        alightStopId: alightStation?.stopId ?? selectedRoute.alightStopId,
        alightStopName: alightStation?.name ?? selectedRoute.alightStopName,
        alightLng: alightStation?.lng ?? selectedRoute.alightLng,
        alightLat: alightStation?.lat ?? selectedRoute.alightLat,
      };
    }
    return null;
  }, [selectedRoute, lineStations, chosenBoardId, chosenAlightId]);

  useEffect(() => {
    setOverviewFocus("board");
    fittedPlanId.current = null;
    fittedPathKey.current = null;
  }, [plan?.requestId]);

  useLayoutEffect(() => {
    const el = popupRef.current;
    if (!el) {
      setPopupHeight(0);
      return;
    }
    const update = () => setPopupHeight(el.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [showStationPopup, lineSelected, browse?.scrollEnd, tripPath, stationWalkAmenities.length]);

  useEffect(() => {
    amenityPopupRef.current?.remove();
    amenityPopupRef.current = null;
  }, [currentStation?.stopId]);

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

  function setOverviewCluster(focus: MapFocus) {
    fittedPlanId.current = null;
    setOverviewFocus(focus);
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
    const station = stopMeta.get(stopId)
      ? validStopToLineStation(stopMeta.get(stopId)!, origin)
      : currentStation;
    const sorted = plan
      ? sortBusesByFrequency(buses, plan, station, stopMeta, stopId)
      : [...new Set(buses)].sort((a, b) =>
          a.localeCompare(b, undefined, { numeric: true }),
        );
    void loadTripPathForBus(sorted[0]!, stopId, sorted);
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
    const buses = sortBusesByFrequency(
      busesAtStopPin(
        plan.routes,
        stopMeta,
        origin,
        destination,
        selectedRoute.boardStopId,
        bus,
      ),
      plan,
      stopMeta.get(selectedRoute.boardStopId)
        ? validStopToLineStation(stopMeta.get(selectedRoute.boardStopId)!, origin)
        : null,
      stopMeta,
      selectedRoute.boardStopId,
    );
    // Open the list pick as a full ride on the map.
    void loadTripPathForBus(bus, selectedRoute.boardStopId, buses, selectedRoute);
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
        minZoom: 13,
        duration: 450,
        padding: fitPaddingForPopup(null, false),
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
      hideBasemapBusPois(map);
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
      map.addSource("walk-amenities", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      addAmenityMarkerImages(map);
      map.addLayer({
        id: "walk-amenities-icon",
        type: "symbol",
        source: "walk-amenities",
        layout: {
          "icon-image": [
            "match",
            ["get", "category"],
            "cafe",
            "amenity-cafe",
            "grocery",
            "amenity-grocery",
            "bakery",
            "amenity-bakery",
            "pharmacy",
            "amenity-pharmacy",
            "atm",
            "amenity-atm",
            "park",
            "amenity-park",
            "amenity-cafe",
          ],
          "icon-size": 0.5,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "icon-anchor": "center",
        },
      });
      map.addLayer({
        id: "stops-circle",
        type: "circle",
        source: "stops",
        paint: {
          // Line stops stay fixed size. Drop-off option pins are uniform;
          // boarding / both scale with frequency. Selection uses stroke only.
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
      if (map.getLayer("walk-amenities-icon")) map.moveLayer("walk-amenities-icon");
      map.moveLayer("stops-circle");

      map.on("mouseenter", "stops-circle", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "stops-circle", () => {
        map.getCanvas().style.cursor = "";
      });

      map.on("mouseenter", "walk-amenities-icon", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "walk-amenities-icon", () => {
        map.getCanvas().style.cursor = "";
      });

      map.on("click", "walk-amenities-icon", (e: MapLayerMouseEvent) => {
        e.originalEvent.stopPropagation();
        suppressMapClickRef.current = true;
        const feature = e.features?.[0];
        if (!feature || feature.geometry.type !== "Point") return;
        const coords = feature.geometry.coordinates as [number, number];
        const props = feature.properties ?? {};
        const name = String(props.name ?? "");
        const category = String(props.category ?? "") as keyof typeof WALK_AMENITY_LABELS;
        const kind = WALK_AMENITY_LABELS[category] ?? "Place";
        const walkNote = String(props.walkNote ?? "On the walking path");
        const meters = Number(props.meters ?? 0);
        amenityPopupRef.current?.remove();
        const body = document.createElement("div");
        body.className = "amenity-popup";
        const title = document.createElement("strong");
        title.textContent = name || kind;
        const meta = document.createElement("span");
        meta.textContent = name ? kind : "Place";
        const where = document.createElement("span");
        where.textContent = walkNote;
        body.append(title, meta, where);
        if (Number.isFinite(meters) && meters > 0) {
          const dist = document.createElement("span");
          const fromDest = walkNote.includes("after");
          dist.textContent = fromDest
            ? `${meters} m from destination`
            : `${meters} m from start`;
          body.append(dist);
        }
        amenityPopupRef.current = new maplibregl.Popup({
          closeButton: true,
          offset: 12,
          className: "amenity-popup-tip",
        })
          .setLngLat(coords)
          .setDOMContent(body)
          .addTo(map);
        frameWalkWithAmenityRef.current({ lng: coords[0], lat: coords[1] });
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
          const hits = map.queryRenderedFeatures(e.point, {
            layers: ["stops-circle", "walk-amenities-icon"].filter((id) =>
              Boolean(map.getLayer(id)),
            ),
          });
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
      walkLabelMarkerRef.current?.remove();
      amenityPopupRef.current?.remove();
      originMarkerRef.current = null;
      destinationMarkerRef.current = null;
      walkLabelMarkerRef.current = null;
      amenityPopupRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    // Only reset map framing / line browse when a new Go result arrives.
    clearLineSelection();
    fittedPlanId.current = null;
  }, [plan?.requestId]);

  useEffect(() => {
    if (!planning) return;
    clearLineSelection();
  }, [planning]);

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
      const amenities = map.getSource("walk-amenities") as GeoJSONSource | undefined;
      iso?.setData({ type: "FeatureCollection", features: [] });
      stops?.setData({ type: "FeatureCollection", features: [] });
      amenities?.setData({ type: "FeatureCollection", features: [] });
      amenityPopupRef.current?.remove();
      amenityPopupRef.current = null;
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
      if (plan) return;
      syncWalkPreview.current(true);
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

      const boardPt = effectiveBoard
        ? { lng: effectiveBoard.lng, lat: effectiveBoard.lat }
        : currentStation && browse?.scrollEnd !== "alight"
          ? { lng: currentStation.lng, lat: currentStation.lat }
          : null;
      const alightPt = effectiveAlight
        ? { lng: effectiveAlight.lng, lat: effectiveAlight.lat }
        : currentStation && browse?.scrollEnd === "alight"
          ? { lng: currentStation.lng, lat: currentStation.lat }
          : null;
      const boardSuggested =
        Boolean(boardPt) && effectiveBoard?.stopId === recommendedBoardId;
      const alightSuggested =
        Boolean(alightPt) && effectiveAlight?.stopId === recommendedAlightId;
      const toBoardWalk =
        origin && boardPt ? walkByKey[walkPairKey(origin, boardPt)] : null;
      const fromAlightWalk =
        destination && alightPt ? walkByKey[walkPairKey(alightPt, destination)] : null;
      const toBoardRouted =
        boardSuggested && toBoardWalk && !toBoardWalk.approximated
          ? toBoardWalk.coordinates
          : null;
      const fromAlightRouted =
        alightSuggested && fromAlightWalk && !fromAlightWalk.approximated
          ? fromAlightWalk.coordinates
          : null;
      const suggestedWalksPending =
        Boolean(browse?.bus) &&
        ((boardSuggested && origin && boardPt && !toBoardWalk) ||
          (alightSuggested && destination && alightPt && !fromAlightWalk));

      if (browse?.bus && tripPath) {
        routeLine.setData(
          buildJourneyGeoJson(origin, destination, tripPath, effectiveBoard, effectiveAlight, {
            toBoard: toBoardRouted,
            fromAlight: fromAlightRouted,
          }) as never,
        );
      } else if (browse?.bus && pathError) {
        routeLine.setData(EMPTY_LINE);
      } else if (browse?.bus) {
        // Line is opening — keep whatever is on the map rather than reverting to the O/D walk.
      } else if (isValidLngLat(origin) && isValidLngLat(destination)) {
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
        // Ride stops only (board → alight). Not the rest of the GTFS trip.
        const activeBoardId = effectiveBoard?.stopId ?? null;
        const activeAlightId = effectiveAlight?.stopId ?? null;
        for (const stop of tripPath.stops) {
          const isActiveBoard = activeBoardId != null && stop.stopId === activeBoardId;
          const isActiveAlight = activeAlightId != null && stop.stopId === activeAlightId;
          if (!stop.onPath && !isActiveBoard && !isActiveAlight) continue;
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
              dim: false,
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
              selected: false,
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
        // Boarding on top so a nearby drop-off cannot draw a red ring around a bus pin.
        const roleOrder: Record<string, number> = { alighting: 0, both: 1, boarding: 2 };
        features.sort(
          (a, b) =>
            (roleOrder[String(a.properties.role)] ?? 1) -
            (roleOrder[String(b.properties.role)] ?? 1),
        );
      }

      stops.setData({ type: "FeatureCollection", features });
      const amenitySource = map.getSource("walk-amenities") as GeoJSONSource | undefined;
      amenitySource?.setData(
        amenitiesToGeoJson(stationWalkAmenities, {
          origin,
          destination,
          route: amenityRoute,
        }) as never,
      );
      if (!stationWalkAmenities.length) {
        amenityPopupRef.current?.remove();
        amenityPopupRef.current = null;
      }
      if (map.getLayer("walk-amenities-icon")) map.moveLayer("walk-amenities-icon");
      if (map.getLayer("stops-circle")) map.moveLayer("stops-circle");

      const extraTop = browse?.bus ? 0 : 48;
      const waitingForCard = showStationPopup && popupCoverPx(map, popupRef.current) < 48;
      if (browse?.bus && (!tripPath || suggestedWalksPending || waitingForCard)) {
        syncEndpointMarkers.current();
        return;
      }
      if (!browse?.bus && waitingForCard) {
        syncEndpointMarkers.current();
        return;
      }
      const camPad = cameraPaddingForCard(
        map,
        popupRef.current,
        showStationPopup,
        extraTop,
      );

      if (browse?.bus) {
        if (!tripPath) {
          syncEndpointMarkers.current();
          return;
        }
        const onSuggested =
          effectiveBoard?.stopId === recommendedBoardId &&
          effectiveAlight?.stopId === recommendedAlightId;
        if (!onSuggested) {
          syncEndpointMarkers.current();
          return;
        }
        const pathKey = `${browse.bus}:line:${effectiveBoard?.stopId ?? tripPath.boardStopId}:${effectiveAlight?.stopId ?? tripPath.alightStopId}:${toBoardRouted?.length ?? 0}:${fromAlightRouted?.length ?? 0}`;
        if (fittedPathKey.current !== pathKey) {
          fittedPathKey.current = pathKey;
          const points = journeyFitPoints(
            origin,
            destination,
            tripPath,
            effectiveBoard,
            effectiveAlight,
            { toBoard: toBoardRouted, fromAlight: fromAlightRouted },
          );
          safeFitBounds(map, points, {
            maxZoom: 14,
            minZoom: 11,
            duration: 550,
            keepBottom: showStationPopup,
            padding: camPad,
          });
        }
        syncEndpointMarkers.current();
        return;
      }

      const overviewKey = `${plan.requestId}:${overviewFocus}`;
      if (fittedPlanId.current !== overviewKey) {
        fittedPlanId.current = overviewKey;
        const points: LatLng[] = [];
        if (overviewFocus === "alight") {
          if (isValidLngLat(destination)) points.push(destination);
        } else if (isValidLngLat(origin)) {
          points.push(origin);
        }
        for (const feature of features) {
          const role = String(feature.properties.role ?? "");
          const include =
            overviewFocus === "alight" ? role !== "boarding" : role !== "alighting";
          if (!include) continue;
          const [lng, lat] = feature.geometry.coordinates;
          if (Number.isFinite(lng) && Number.isFinite(lat)) {
            points.push({ lng, lat });
          }
        }
        safeFitBounds(map, points, {
          maxZoom: 15,
          minZoom: 13,
          duration: 600,
          padding: camPad,
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
    showStationPopup,
    stationWalkAmenities,
    overviewFocus,
    popupHeight,
    amenityRoute,
    boardScrollStations,
    alightScrollStations,
    walkByKey,
    recommendedBoardId,
    recommendedAlightId,
  ]);

  function selectBus(bus: string) {
    if (!browse || bus === browse.bus) return;
    const preferred =
      currentStation?.stopId ?? browse.preferredStopId ?? null;
    const buses = plan
      ? sortBusesByFrequency(
          [...browse.buses, bus],
          plan,
          currentStation,
          stopMeta,
          preferred,
        )
      : [...new Set([...browse.buses, bus])];
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

  function frameWholeJourney() {
    const map = mapRef.current;
    if (!map || !tripPath) return;
    fittedPathKey.current = null;
    const boardPt = effectiveBoard
      ? { lng: effectiveBoard.lng, lat: effectiveBoard.lat }
      : null;
    const alightPt = effectiveAlight
      ? { lng: effectiveAlight.lng, lat: effectiveAlight.lat }
      : null;
    const boardSuggested =
      Boolean(boardPt) && effectiveBoard?.stopId === recommendedBoardId;
    const alightSuggested =
      Boolean(alightPt) && effectiveAlight?.stopId === recommendedAlightId;
    const toBoardWalk =
      origin && boardPt ? walkByKey[walkPairKey(origin, boardPt)] : null;
    const fromAlightWalk =
      destination && alightPt ? walkByKey[walkPairKey(alightPt, destination)] : null;
    const points = journeyFitPoints(origin, destination, tripPath, boardPt, alightPt, {
      toBoard:
        boardSuggested && toBoardWalk && !toBoardWalk.approximated
          ? toBoardWalk.coordinates
          : null,
      fromAlight:
        alightSuggested && fromAlightWalk && !fromAlightWalk.approximated
          ? fromAlightWalk.coordinates
          : null,
    });
    safeFitBounds(map, points, {
      maxZoom: 14,
      minZoom: 11,
      duration: 550,
      padding: FIT_INSET,
    });
  }

  function frameWalkWithAmenity(point: LatLng) {
    const map = mapRef.current;
    if (!map) return;
    const board = effectiveBoard
      ? { lng: effectiveBoard.lng, lat: effectiveBoard.lat }
      : null;
    const alight = effectiveAlight
      ? { lng: effectiveAlight.lng, lat: effectiveAlight.lat }
      : null;
    const dummy = { id: "", name: "", category: "cafe" as const, ...point };
    const onAfter =
      alight && destination && amenityOnWalk(dummy, alight, destination);
    const onToBoard =
      board && origin && amenityOnWalk(dummy, origin, board);
    const cluster: LatLng[] = [point];
    if (onAfter && !onToBoard) {
      if (alight) cluster.push(alight);
      if (destination) cluster.push(destination);
    } else {
      if (origin) cluster.push(origin);
      if (board) cluster.push(board);
    }
    safeFitBounds(map, cluster, {
      maxZoom: 16,
      minZoom: 14,
      duration: 450,
      padding: FIT_INSET,
    });
  }
  frameWalkWithAmenityRef.current = frameWalkWithAmenity;

  return (
    <div className="map-wrap">
      <div ref={containerRef} className="map-canvas" aria-label="Transit map" />
      {plan && !planning && !browse?.bus ? (
        <div
          className="map-focus-toggle map-focus-toggle--overview"
          role="group"
          aria-label="Zoom to boarding or alighting stops"
        >
          <button
            type="button"
            className={overviewFocus === "board" ? "active" : ""}
            onClick={() => setOverviewCluster("board")}
          >
            Get on
          </button>
          <button
            type="button"
            className={overviewFocus === "alight" ? "active" : ""}
            onClick={() => setOverviewCluster("alight")}
          >
            Get off
          </button>
        </div>
      ) : null}
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
      {showStationPopup && browse && currentStation ? (
        <div
          ref={popupRef}
          className={`bus-popup${lineSelected ? "" : " compact"}`}
          role="dialog"
          aria-label={lineSelected ? "Selected bus" : "Buses at this station"}
        >
          <div className="bus-popup-toolbar">
            <div className="bus-popup-buses">
              {orderedBuses.map((bus) => {
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
                    aria-pressed={active}
                    onClick={() => selectBus(bus)}
                  >
                    {routeChipLabel(bus)}
                  </button>
                );
              })}
            </div>
            {lineSelected ? (
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
          {lineSelected ? (
            <>
              <div className="popup-headway">
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
              </div>

              <div className="popup-trip-ends">
                <div className="popup-end board">
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
                </div>
                <div className="popup-end alight">
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
                </div>
              </div>
              <button
                type="button"
                className="view-all-stops"
                disabled={!tripPath}
                onClick={frameWholeJourney}
              >
                View all stops
              </button>

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
                      <strong>
                        {formatWalkLeg(
                          walkSummary.walkToBoard,
                          walkSummary.walkToBoardSeconds,
                        )}
                      </strong>
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
                      <strong>
                        {formatWalkLeg(
                          walkSummary.walkFromAlight,
                          walkSummary.walkFromAlightSeconds,
                        )}
                      </strong>
                    </p>
                  ) : null}
                </div>
              ) : null}
              <WalkAmenityList
                amenities={stationWalkAmenities}
                category={walkAmenityCategory}
                onSelect={(amenity) =>
                  frameWalkWithAmenity({ lng: amenity.lng, lat: amenity.lat })
                }
              />
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
