import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchBoardDepartures,
  fetchHealth,
  fetchTripPath,
  fetchWalkAmenities,
  planDirect,
  type DirectPlanResponse,
  type DirectRoute,
  type LatLng,
  type PlanMode,
  type ScheduledDeparture,
  type StopDeparturesResponse,
  type TripPathResponse,
  type WalkAmenity,
} from "../api";
import { FilterBar } from "../components/FilterBar";
import { PlaceInput } from "../components/PlaceInput";
import { RouteResults } from "../components/RouteResults";
import { SelectedRoutePanel } from "../components/SelectedRoutePanel";
import { TransitMap } from "../components/TransitMap";
import { WhenPicker } from "../components/WhenPicker";
import { Icon } from "../components/ui/Icon";
import { SelectChip } from "../components/ui/SelectChip";
import { getCurrentPosition, resolveCurrentLocation } from "../currentLocation";
import { departAtIso } from "../departAt";
import {
  applyResultFilters,
  filterPlanByCatchableDepartures,
  filterPlanByModes,
  overlayHeadwaysFromDepartures,
  roundedWalkSeconds,
  routeBadgeLabel,
  routeOptionKey,
  totalJourneySeconds,
  walkEstimateBetween,
  walkLegsSeconds,
  type FrequencyMaxMinutes,
  type TotalTimeMaxMinutes,
} from "../mergePlans";
import { pickNextCatchableDeparture } from "../formatDeparture";
import { rememberPlace } from "../placeHistory";
import { buildDemoState, isDemoUrl } from "../demo/mockPlan";
import {
  matchRouteFromUrl,
  parsePlanUrl,
  replacePlanUrl,
  type PlanUrlRoute,
  type ParsedPlanUrl,
} from "../urlState";
import {
  bboxesFromPlan,
  filterPlanByWalkAmenity,
  mergeWalkAmenities,
  type WalkAmenityFilter,
} from "../walkAmenities";

type Endpoint = { label: string; location: LatLng } | null;

const ALL_MODES: PlanMode[] = ["walk_transit", "transit_walk"];

const WALK_MINUTE_OPTIONS = [5, 10, 15, 20, 25, 30];

/** Straight-line limit — beyond this, transit planning is not offered. */
const MAX_PLAN_DISTANCE_METERS = 20_000;

function readInitialShare(): ParsedPlanUrl | null {
  if (typeof window === "undefined") return null;
  if (isDemoUrl()) return null;
  const parsed = parsePlanUrl(window.location.search);
  if (!parsed.origin && !parsed.destination && !parsed.route) return null;
  return parsed;
}

export function PlannerPage() {
  const initialShare = useMemo(() => readInitialShare(), []);
  const pendingRouteRef = useRef<PlanUrlRoute | null>(initialShare?.route ?? null);
  const dismissedPlanIdRef = useRef<string | null>(null);

  const [origin, setOrigin] = useState<Endpoint>(() => initialShare?.origin ?? null);
  const [destination, setDestination] = useState<Endpoint>(
    () => initialShare?.destination ?? null,
  );
  /** Modes visible after planning; both on by default. */
  const [enabledModes, setEnabledModes] = useState<PlanMode[]>([...ALL_MODES]);
  /** When on, also keep trips a few minutes over the walk budget. */
  const [includeNearLimitWalk, setIncludeNearLimitWalk] = useState(false);
  /** When on, hide options with no catchable departure within ~3 hours. Off by default. */
  const [limitSoonDepartures, setLimitSoonDepartures] = useState(false);
  /** Max station headway (min); same tiers as pin sizes. Default all = no filter. */
  const [maxFrequencyMinutes, setMaxFrequencyMinutes] =
    useState<FrequencyMaxMinutes>("all");
  /** Max walk+ride+walk journey time. Default any = no cap. */
  const [maxTotalTimeMinutes, setMaxTotalTimeMinutes] =
    useState<TotalTimeMaxMinutes>("all");
  /** OSM amenity that must sit on the walk-to-stop / walk-from-stop path. */
  const [walkAmenity, setWalkAmenity] = useState<WalkAmenityFilter>("any");
  const [walkAmenities, setWalkAmenities] = useState<WalkAmenity[]>([]);
  const [walkAmenityStatus, setWalkAmenityStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [plansByMode, setPlansByMode] = useState<Partial<Record<PlanMode, DirectPlanResponse>>>(
    {},
  );
  const [sliderDraft, setSliderDraft] = useState(() => initialShare?.walkMinutes ?? 15);
  const [committedMinutes, setCommittedMinutes] = useState(
    () => initialShare?.walkMinutes ?? 15,
  );
  /** null = leave now (live Israel clock). */
  const [departAt, setDepartAt] = useState<Date | null>(null);
  const [selectedRoute, setSelectedRoute] = useState<DirectRoute | null>(null);
  const [departuresByKey, setDeparturesByKey] = useState<
    Record<string, StopDeparturesResponse>
  >({});
  const [departuresLoading, setDeparturesLoading] = useState(false);
  /** Sig of basePlan routes that the current departuresByKey was fetched for. */
  const [departuresFetchedSig, setDeparturesFetchedSig] = useState("");
  const [scheduleExpanded, setScheduleExpanded] = useState(false);
  const [activeDeparture, setActiveDeparture] = useState<ScheduledDeparture | null>(null);
  const [instancePath, setInstancePath] = useState<TripPathResponse | null>(null);
  const [instanceLoading, setInstanceLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [locating, setLocating] = useState(false);
  const [mapLocating, setMapLocating] = useState(false);
  const [mapRecenter, setMapRecenter] = useState<{
    id: number;
    location: LatLng;
  } | null>(null);
  const mapRecenterId = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [apiOk, setApiOk] = useState<boolean | null>(null);
  const [demoMode, setDemoMode] = useState(() => isDemoUrl());
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const [mapLineActive, setMapLineActive] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const departuresAbortRef = useRef<AbortController | null>(null);
  const instanceAbortRef = useRef<AbortController | null>(null);
  /** When true, do not auto-replace activeDeparture with next catchable. */
  const userPickedDepartureRef = useRef(false);

  const canPlan = Boolean(origin && destination);

  /** Full merged result from Go — filters never refetch or remesh this. */
  const fullPlan = useMemo(
    () => filterPlanByModes(plansByMode, ALL_MODES),
    [plansByMode],
  );

  const isAdjusting = Boolean(fullPlan);

  const odDistanceMeters = useMemo(() => {
    if (!origin || !destination) return null;
    return walkEstimateBetween(origin.location, destination.location).meters;
  }, [origin, destination]);

  const tooFarToPlan =
    odDistanceMeters != null && odDistanceMeters > MAX_PLAN_DISTANCE_METERS;

  const filterInputs = {
    enabledModes,
    includeNearLimitWalk,
    origin: origin?.location ?? null,
    destination: destination?.location ?? null,
    maxWalkingSeconds: committedMinutes * 60,
    maxTotalTimeMinutes,
  };

  /** Routes to fetch departures for — frequency is applied after overlay. */
  const preFreqPlan = useMemo(
    () =>
      applyResultFilters(fullPlan, {
        ...filterInputs,
        maxFrequencyMinutes: "all",
      }),
    [
      fullPlan,
      enabledModes,
      includeNearLimitWalk,
      origin?.location,
      destination?.location,
      committedMinutes,
      maxTotalTimeMinutes,
    ],
  );

  const timedPlan = useMemo(
    () => overlayHeadwaysFromDepartures(fullPlan, departuresByKey),
    [fullPlan, departuresByKey],
  );

  /** Walk / mode / time filters — frequency uses leave-at overlay when loaded. */
  const basePlan = useMemo(
    () =>
      applyResultFilters(timedPlan, {
        ...filterInputs,
        maxFrequencyMinutes,
      }),
    [
      timedPlan,
      enabledModes,
      includeNearLimitWalk,
      origin?.location,
      destination?.location,
      committedMinutes,
      maxFrequencyMinutes,
      maxTotalTimeMinutes,
    ],
  );

  const amenityPlan = useMemo(
    () =>
      filterPlanByWalkAmenity(
        basePlan,
        walkAmenityStatus === "ready" ? walkAmenities : [],
        walkAmenityStatus === "ready" ? walkAmenity : "any",
        origin?.location ?? null,
        destination?.location ?? null,
      ),
    [
      basePlan,
      walkAmenities,
      walkAmenity,
      walkAmenityStatus,
      origin?.location,
      destination?.location,
    ],
  );

  const routeKeysSig = useMemo(
    () => (preFreqPlan?.routes ?? []).map(routeOptionKey).join("|"),
    [preFreqPlan?.routes],
  );

  const departAtIsoValue = departAtIso(departAt);
  const departuresQuerySig = `${departAtIsoValue ?? "now"}|${routeKeysSig}`;

  const departuresReady =
    !preFreqPlan?.routes.length ||
    (!departuresLoading && departuresFetchedSig === departuresQuerySig);

  /** Optional: after departures load, keep only options with a catchable departure soon. */
  const plan = useMemo(() => {
    if (!amenityPlan) return null;
    if (!limitSoonDepartures || !departuresReady) return amenityPlan;
    return filterPlanByCatchableDepartures(
      amenityPlan,
      departuresByKey,
      origin?.location ?? null,
      destination?.location ?? null,
    );
  }, [
    amenityPlan,
    limitSoonDepartures,
    departuresReady,
    departuresByKey,
    origin?.location,
    destination?.location,
  ]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const check = () => {
      fetchHealth()
        .then((h) => {
          if (cancelled) return;
          setApiOk(h.status === "ok" && h.database);
          timer = window.setTimeout(check, 15_000);
        })
        .catch((err) => {
          if (cancelled) return;
          console.error("[health]", err);
          setApiOk(false);
          timer = window.setTimeout(check, 3_000);
        });
    };
    check();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  // Default origin to the device location once — user can clear / change it.
  // Shared URLs that already include an origin skip GPS so the link wins.
  useEffect(() => {
    if (demoMode || origin || !navigator.geolocation) return;
    if (initialShare?.origin) return;
    let cancelled = false;
    setLocating(true);
    void resolveCurrentLocation()
      .then((place) => {
        if (cancelled) return;
        selectOrigin(place);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("[geolocation]", err);
      })
      .finally(() => {
        if (!cancelled) setLocating(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once on mount / demo exit
  }, [demoMode]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const selectedKey = useMemo(() => {
    if (!selectedRoute) return null;
    return routeOptionKey(selectedRoute);
  }, [selectedRoute]);

  const showModeOnCards = enabledModes.length > 1 && Boolean(plan);

  const sheetPeekLabel = useMemo(() => {
    if (loading) return "Planning…";
    if (isAdjusting && plan) {
      if (selectedRoute && origin?.location && destination?.location) {
        const total = totalJourneySeconds(
          selectedRoute,
          origin.location,
          destination.location,
        );
        const mins = Math.max(1, Math.round(total / 60));
        const headsign =
          selectedRoute.tripHeadsign || selectedRoute.routeLongName || "Route";
        return `Line ${routeBadgeLabel(selectedRoute)} · ${headsign} · ${mins} min`;
      }
      const count = plan.routes.length;
      return `${count} route${count === 1 ? "" : "s"}`;
    }
    if (canPlan) return "Tap Plan trip to see routes";
    return "Choose an origin and destination";
  }, [loading, isAdjusting, plan, selectedRoute, origin, destination, canPlan]);

  const selectedDepartures = selectedKey ? departuresByKey[selectedKey] ?? null : null;
  const sheetDragStartY = useRef<number | null>(null);
  const sheetDidSwipe = useRef(false);

  useEffect(() => {
    if (!selectedRoute || !plan) return;
    const mode = selectedRoute.planMode ?? "walk_transit";
    const stillThere = plan.routes.some(
      (r) =>
        (r.planMode ?? "walk_transit") === mode &&
        r.routeId === selectedRoute.routeId &&
        r.boardStopId === selectedRoute.boardStopId &&
        r.alightStopId === selectedRoute.alightStopId,
    );
    if (!stillThere) {
      setSelectedRoute(null);
      setSheetExpanded(false);
    }
  }, [plan, selectedRoute]);

  useEffect(() => {
    departuresAbortRef.current?.abort();
    setActiveDeparture(null);
    setInstancePath(null);
    if (!preFreqPlan?.routes.length) {
      setDeparturesByKey({});
      setDeparturesLoading(false);
      setDeparturesFetchedSig("");
      return;
    }
    if (demoMode) return;
    const controller = new AbortController();
    departuresAbortRef.current = controller;
    setDeparturesLoading(true);
    const routes = preFreqPlan.routes;
    const fetchSig = `${departAtIsoValue ?? "now"}|${routes.map(routeOptionKey).join("|")}`;
    void Promise.all(
      routes.map(async (route) => {
        const key = routeOptionKey(route);
        try {
          const body = await fetchBoardDepartures(
            {
              stopId: route.boardStopId,
              alightStopId: route.alightStopId,
              routeShortName: route.routeShortName ?? route.routeId,
              routeId: route.routeId,
              at: departAtIsoValue,
            },
            controller.signal,
          );
          return [key, body] as const;
        } catch (err) {
          if ((err as Error).name === "AbortError") return null;
          console.error("[departures]", err);
          return [key, null] as const;
        }
      }),
    ).then((entries) => {
      if (controller.signal.aborted) return;
      const next: Record<string, StopDeparturesResponse> = {};
      for (const entry of entries) {
        if (!entry) continue;
        const [key, body] = entry;
        if (body) next[key] = body;
      }
      setDeparturesByKey(next);
      setDeparturesLoading(false);
      setDeparturesFetchedSig(fetchSig);
    });
    return () => controller.abort();
  }, [preFreqPlan?.requestId, routeKeysSig, demoMode, departAtIsoValue]);

  useEffect(() => {
    if (!fullPlan || demoMode) {
      setWalkAmenities([]);
      setWalkAmenityStatus("idle");
      return;
    }
    const boxes = bboxesFromPlan(
      fullPlan,
      origin?.location ?? null,
      destination?.location ?? null,
    );
    if (!boxes.length) {
      setWalkAmenities([]);
      setWalkAmenityStatus("error");
      return;
    }
    const controller = new AbortController();
    setWalkAmenityStatus("loading");
    void Promise.all(boxes.map((box) => fetchWalkAmenities(box, controller.signal)))
      .then((results) => {
        if (controller.signal.aborted) return;
        setWalkAmenities(mergeWalkAmenities(results.map((r) => r.amenities)));
        setWalkAmenityStatus("ready");
      })
      .catch((err) => {
        if ((err as Error).name === "AbortError") return;
        console.error("[walk-amenities]", err);
        if (!controller.signal.aborted) {
          setWalkAmenities([]);
          setWalkAmenityStatus("error");
        }
      });
    return () => controller.abort();
    // Isochrone identity is requestId; origin/dest are captured from that plan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullPlan?.requestId, demoMode]);

  /** Default the selected option to the next catchable trip so get-on clocks match "Next bus". */
  useEffect(() => {
    if (!selectedRoute || !selectedKey || !departuresReady) return;
    if (userPickedDepartureRef.current) return;
    const deps = departuresByKey[selectedKey];
    if (!deps) {
      setActiveDeparture(null);
      return;
    }
    const originLoc = origin?.location ?? null;
    const destLoc = destination?.location ?? null;
    const walkToBoardSecs =
      originLoc && destLoc
        ? roundedWalkSeconds(walkLegsSeconds(selectedRoute, originLoc, destLoc).toBoard)
        : 0;
    const next = pickNextCatchableDeparture(
      deps.departures,
      deps.nowSecs,
      walkToBoardSecs,
    );
    setActiveDeparture(next);
  }, [
    selectedRoute,
    selectedKey,
    departuresReady,
    departuresByKey,
    origin?.location,
    destination?.location,
  ]);

  useEffect(() => {
    if (demoMode) return;
    instanceAbortRef.current?.abort();
    if (!selectedRoute || !activeDeparture) {
      setInstancePath(null);
      setInstanceLoading(false);
      return;
    }
    const controller = new AbortController();
    instanceAbortRef.current = controller;
    setInstanceLoading(true);
    setInstancePath(null);
    void fetchTripPath(
      activeDeparture.tripId,
      selectedRoute.boardStopId,
      selectedRoute.alightStopId,
      controller.signal,
    )
      .then((path) => {
        if (!controller.signal.aborted) setInstancePath(path);
      })
      .catch((err) => {
        if ((err as Error).name === "AbortError") return;
        console.error("[trip-instance]", err);
        if (!controller.signal.aborted) setInstancePath(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setInstanceLoading(false);
      });
    return () => controller.abort();
  }, [selectedRoute, activeDeparture, demoMode]);

  /** Map uses the clicked schedule trip when set; otherwise the plan's representative trip. */
  const mapSelectedRoute = useMemo((): DirectRoute | null => {
    if (!selectedRoute) return null;
    if (!activeDeparture) return selectedRoute;
    return { ...selectedRoute, tripId: activeDeparture.tripId };
  }, [selectedRoute, activeDeparture]);

  function handleSelectRoute(route: DirectRoute | null) {
    userPickedDepartureRef.current = false;
    setActiveDeparture(null);
    setInstancePath(null);
    if (!route) {
      setScheduleExpanded(false);
      dismissedPlanIdRef.current = plan?.requestId ?? fullPlan?.requestId ?? "dismissed";
    }
    setSelectedRoute(route);
    // Map card holds the itinerary; keep the sheet as a peek so they are not duplicated.
    setSheetExpanded(false);
    if (!route) setMapLineActive(false);
  }

  function handleBrowseRoute(route: DirectRoute | null) {
    if (!route) {
      // Map cleared the line (empty map click / filter drop).
      dismissedPlanIdRef.current = plan?.requestId ?? fullPlan?.requestId ?? "dismissed";
      setSelectedRoute(null);
      setScheduleExpanded(false);
      setActiveDeparture(null);
      setInstancePath(null);
      setSheetExpanded(false);
      return;
    }
    setSelectedRoute((prev) =>
      prev && routeOptionKey(prev) === routeOptionKey(route) ? prev : route,
    );
  }

  function handleSheetTouchStart(clientY: number) {
    sheetDragStartY.current = clientY;
    sheetDidSwipe.current = false;
  }

  function handleSheetTouchEnd(clientY: number) {
    const start = sheetDragStartY.current;
    sheetDragStartY.current = null;
    if (start == null) return;
    const dy = clientY - start;
    if (Math.abs(dy) < 40) return;
    sheetDidSwipe.current = true;
    if (dy < 0) setSheetExpanded(true);
    else setSheetExpanded(false);
  }

  function handleSheetToggleClick() {
    if (sheetDidSwipe.current) {
      sheetDidSwipe.current = false;
      return;
    }
    setSheetExpanded((open) => !open);
  }

  function handleSelectDeparture(dep: ScheduledDeparture) {
    setActiveDeparture((prev) => {
      if (
        prev &&
        prev.tripId === dep.tripId &&
        prev.departureSecs === dep.departureSecs &&
        prev.dayOffset === dep.dayOffset
      ) {
        userPickedDepartureRef.current = false;
        return null;
      }
      userPickedDepartureRef.current = true;
      return dep;
    });
  }

  function handleCollapseSchedule() {
    setScheduleExpanded(false);
    userPickedDepartureRef.current = false;
    setActiveDeparture(null);
    setInstancePath(null);
  }

  function loadDemo() {
    const demo = buildDemoState();
    abortRef.current?.abort();
    departuresAbortRef.current?.abort();
    instanceAbortRef.current?.abort();
    setDemoMode(true);
    setOrigin(demo.endpoints.origin);
    setDestination(demo.endpoints.destination);
    setPlansByMode(demo.plansByMode);
    setCommittedMinutes(15);
    setSliderDraft(15);
    setSelectedRoute(demo.selectedRoute);
    setDeparturesByKey(demo.departuresByKey);
    setDeparturesLoading(false);
    setDeparturesFetchedSig(demo.departuresFetchedSig);
    setScheduleExpanded(false);
    setActiveDeparture(null);
    setInstancePath(null);
    setLoading(false);
    setError(null);
    userPickedDepartureRef.current = false;
    setSheetExpanded(false);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      for (const key of ["o", "d", "ol", "dl", "w", "m", "r", "b", "a"]) {
        url.searchParams.delete(key);
      }
      url.searchParams.set("demo", "1");
      window.history.replaceState({}, "", url);
    }
  }

  function exitDemo() {
    setDemoMode(false);
    startNewQuery();
    setOrigin(null);
    setDestination(null);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("demo");
      window.history.replaceState({}, "", url);
    }
  }

  useEffect(() => {
    if (isDemoUrl()) loadDemo();
    // Shared origin/destination only pre-fill the form — planning starts on Plan trip.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hydrate demo once from the URL
  }, []);

  /** After a plan lands, honor a shared ride encoded in m/r/b/a. */
  useEffect(() => {
    if (loading || demoMode) return;
    const pending = pendingRouteRef.current;
    if (!pending) return;
    if (!Object.keys(plansByMode).length) return;
    pendingRouteRef.current = null;
    const match = matchRouteFromUrl(fullPlan?.routes ?? [], pending);
    if (match) setSelectedRoute(match);
  }, [plansByMode, fullPlan, loading, demoMode]);

  /** Keep the address bar in sync so the current trip is shareable. */
  useEffect(() => {
    if (demoMode || loading) return;
    replacePlanUrl({
      origin,
      destination,
      walkMinutes: committedMinutes,
      route: selectedRoute,
    });
  }, [origin, destination, committedMinutes, selectedRoute, demoMode, loading]);

  async function runPlan(minutes = committedMinutes) {
    if (!origin || !destination) {
      setError("Choose both origin and destination");
      return;
    }
    const distance = walkEstimateBetween(origin.location, destination.location).meters;
    if (distance > MAX_PLAN_DISTANCE_METERS) {
      setError("Choose points within 20 km of each other");
      return;
    }
    if (demoMode) setDemoMode(false);
    setSheetExpanded(false);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const timeout =
      typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(30_000) : null;
    const signal =
      timeout && typeof AbortSignal.any === "function"
        ? AbortSignal.any([controller.signal, timeout])
        : controller.signal;
    setLoading(true);
    setError(null);
    setSelectedRoute(null);
    dismissedPlanIdRef.current = null;
    console.info("[plan] start", {
      modes: ALL_MODES,
      maxWalkingSeconds: minutes * 60,
      origin: origin.location,
      destination: destination.location,
      at: departAtIsoValue,
    });
    try {
      const shared = {
        origin: origin.location,
        destination: destination.location,
        maxWalkingSeconds: minutes * 60,
        at: departAtIsoValue,
      };
      // Load both directions together so the first rendered map already contains
      // both walking areas and their pins.
      const [walkTransit, transitWalk] = await Promise.all([
        planDirect({ ...shared, mode: "walk_transit" }, signal),
        planDirect({ ...shared, mode: "transit_walk" }, signal),
      ]);
      if (abortRef.current !== controller) return;
      setCommittedMinutes(minutes);
      setSliderDraft(minutes);
      setPlansByMode({
        walk_transit: walkTransit,
        transit_walk: transitWalk,
      });
      setEnabledModes([...ALL_MODES]);
      setIncludeNearLimitWalk(false);
      setLimitSoonDepartures(false);
      setMaxFrequencyMinutes("all");
      setMaxTotalTimeMinutes("all");
      console.info("[plan] both modes ok", {
        walkTransit: {
          stops: walkTransit.meta.validStopCount,
          routes: walkTransit.meta.routeCount,
          elapsedMs: walkTransit.meta.elapsedMs,
        },
        transitWalk: {
          stops: transitWalk.meta.validStopCount,
          routes: transitWalk.meta.routeCount,
          elapsedMs: transitWalk.meta.elapsedMs,
        },
      });
    } catch (err) {
      if (abortRef.current !== controller) return;
      if ((err as Error).name === "AbortError") {
        setError("Planning took too long. Try again.");
        return;
      }
      const message = err instanceof Error ? err.message : "Plan failed";
      console.error("[plan] failed", err);
      setError(message);
    } finally {
      if (abortRef.current === controller) setLoading(false);
    }
  }

  function cancelInFlightPlan() {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
  }

  function forgetTrip() {
    cancelInFlightPlan();
    setPlansByMode({});
    setSelectedRoute(null);
    setMapLineActive(false);
    setActiveDeparture(null);
    setInstancePath(null);
    setError(null);
    setSheetExpanded(false);
    userPickedDepartureRef.current = false;
  }

  function selectOrigin(place: { label: string; location: LatLng }) {
    rememberPlace(place);
    forgetTrip();
    setOrigin(place);
  }

  function selectDestination(place: { label: string; location: LatLng }) {
    rememberPlace(place);
    forgetTrip();
    setDestination(place);
  }

  function clearOrigin() {
    forgetTrip();
    setOrigin(null);
  }

  function clearDestination() {
    forgetTrip();
    setDestination(null);
  }

  function swapEndpoints() {
    forgetTrip();
    setOrigin(destination);
    setDestination(origin);
  }

  function startNewQuery() {
    abortRef.current?.abort();
    departuresAbortRef.current?.abort();
    instanceAbortRef.current?.abort();
    setPlansByMode({});
    setSelectedRoute(null);
    setDeparturesByKey({});
    setDeparturesLoading(false);
    setDeparturesFetchedSig("");
    setScheduleExpanded(false);
    setActiveDeparture(null);
    setInstancePath(null);
    setError(null);
    setLoading(false);
    setEnabledModes([...ALL_MODES]);
    setIncludeNearLimitWalk(false);
    setLimitSoonDepartures(false);
    setMaxFrequencyMinutes("all");
    setMaxTotalTimeMinutes("all");
    setWalkAmenity("any");
    setWalkAmenities([]);
    setWalkAmenityStatus("idle");
    setDepartAt(null);
    setSheetExpanded(false);
    setMapLineActive(false);
    userPickedDepartureRef.current = false;
    dismissedPlanIdRef.current = null;
    setSliderDraft(committedMinutes);
  }

  function planNewTrip() {
    if (demoMode) {
      exitDemo();
      return;
    }
    startNewQuery();
  }

  function handleDepartAtChange(next: Date | null) {
    userPickedDepartureRef.current = false;
    setDepartAt(next);
  }

  async function focusMapOnMyLocation() {
    if (!navigator.geolocation) {
      setError("Location is not available in this browser");
      return;
    }
    setMapLocating(true);
    try {
      const location = await getCurrentPosition();
      mapRecenterId.current += 1;
      setMapRecenter({ id: mapRecenterId.current, location });
    } catch (err) {
      console.error("[geolocation]", err);
      setError("Could not get your location");
    } finally {
      setMapLocating(false);
    }
  }

  return (
    <div className="app-shell">
      {demoMode ? (
        <div className="demo-banner" role="status">
          <span>Demo trip — sample Tel Aviv routes, not live data</span>
          <button type="button" className="linkish" onClick={exitDemo}>
            Exit demo
          </button>
        </div>
      ) : null}
      <header className={`top-chrome${isAdjusting ? " compact" : ""}`}>
        <div className="app-header">
          <div className="app-brand" aria-label="Walk2Ride">
            <img className="app-logo-icon" src="/logo-icon.png" alt="" aria-hidden />
            <span className="app-logo-text">Walk2Ride</span>
          </div>
          {!demoMode && apiOk === false ? <p className="api-pill bad">API offline</p> : null}
        </div>

        {isAdjusting ? (
          <div className="trip-summary" aria-label="Current trip">
            <div className="trip-summary-route">
              <span className="trip-summary-dot origin" aria-hidden />
              <p className="trip-summary-places">
                <span className="trip-summary-place">{origin?.label ?? "Origin"}</span>
                <span className="trip-summary-arrow" aria-hidden>
                  →
                </span>
                <span className="trip-summary-place">{destination?.label ?? "Destination"}</span>
              </p>
            </div>
            <div className="trip-summary-meta">
              <div className="trip-summary-params">
                <span className="trip-summary-param">
                  <Icon name="walk" size={13} />
                  ≤{committedMinutes} min
                </span>
                <WhenPicker
                  value={departAt}
                  onChange={handleDepartAtChange}
                  variant="summary"
                />
              </div>
              <button type="button" className="trip-summary-new" onClick={planNewTrip}>
                Plan a new trip
              </button>
            </div>
          </div>
        ) : (
          <div className="search-card">
            <div className="search-card-route">
              <div className="route-rail" aria-hidden>
                <span className="route-dot origin" />
                <span className="route-line" />
                <span className="route-dot destination" />
              </div>
              <div className="route-fields">
                <PlaceInput
                  label="Origin"
                  endpoint="origin"
                  embedded
                  placeholder={locating && !origin ? "Detecting location…" : "Starting point"}
                  valueLabel={origin?.label ?? ""}
                  onSelect={selectOrigin}
                  onClear={clearOrigin}
                />
                <div className="route-divider" aria-hidden />
                <PlaceInput
                  label="Destination"
                  endpoint="destination"
                  embedded
                  placeholder="Destination"
                  valueLabel={destination?.label ?? ""}
                  onSelect={selectDestination}
                  onClear={clearDestination}
                />
              </div>
              <button
                type="button"
                className="swap-btn"
                aria-label="Swap origin and destination"
                disabled={!origin && !destination}
                onClick={swapEndpoints}
              >
                <Icon name="swap" size={16} />
              </button>
            </div>

            {tooFarToPlan ? (
              <p className="field-error trip-too-far" role="status">
                Points are more than 20 km apart — pick a closer destination.
              </p>
            ) : null}

            <div className="search-card-actions">
              <WhenPicker value={departAt} onChange={handleDepartAtChange} />
              <SelectChip
                icon="walk"
                label="Max walk"
                variant="control"
                value={String(sliderDraft)}
                options={WALK_MINUTE_OPTIONS.map((mins) => ({
                  value: String(mins),
                  label: `${mins} min`,
                }))}
                onChange={(next) => setSliderDraft(Number(next))}
              />
              <button
                type="button"
                className="primary"
                disabled={!canPlan || tooFarToPlan}
                onClick={() => {
                  void runPlan(sliderDraft);
                }}
              >
                {loading ? "Planning…" : "Plan trip"}
              </button>
            </div>
          </div>
        )}

        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
      </header>

      <main className="map-pane">
        {isAdjusting && !selectedRoute && !mapLineActive ? (
          <div className="map-chrome">
            <FilterBar
              enabledModes={enabledModes}
              onModesChange={setEnabledModes}
              includeNearLimitWalk={includeNearLimitWalk}
              walkLimitMinutes={committedMinutes}
              onNearLimitWalkChange={setIncludeNearLimitWalk}
              maxFrequencyMinutes={maxFrequencyMinutes}
              onFrequencyChange={setMaxFrequencyMinutes}
              maxTotalTimeMinutes={maxTotalTimeMinutes}
              onTotalTimeChange={setMaxTotalTimeMinutes}
              walkAmenity={walkAmenity}
              onWalkAmenityChange={setWalkAmenity}
              resultCount={plan?.routes.length ?? 0}
            />
          </div>
        ) : null}

        <TransitMap
          origin={origin?.location ?? null}
          destination={destination?.location ?? null}
          originLabel={origin?.label ?? null}
          destinationLabel={destination?.label ?? null}
          plan={isAdjusting ? plan : null}
          walkAmenities={
            isAdjusting && walkAmenity !== "any" && walkAmenityStatus === "ready"
              ? walkAmenities.filter((a) => a.category === walkAmenity)
              : []
          }
          walkAmenityCategory={walkAmenity}
          selectedRoute={isAdjusting ? mapSelectedRoute : null}
          planning={loading}
          overrideDeparture={activeDeparture}
          departAtIso={departAtIsoValue}
          maxWalkingSeconds={committedMinutes * 60}
          recenterRequest={mapRecenter}
          onLineActiveChange={setMapLineActive}
          onBrowseRouteChange={handleBrowseRoute}
          onOpenSchedule={
            isAdjusting && selectedRoute
              ? () => {
                  setSheetExpanded(true);
                  setScheduleExpanded(true);
                }
              : undefined
          }
        />

        <button
          type="button"
          className="locate-fab"
          aria-label="Focus map on current location"
          disabled={mapLocating}
          onClick={() => {
            void focusMapOnMyLocation();
          }}
        >
          {mapLocating ? <span className="spinner" aria-hidden /> : <Icon name="locate" size={20} />}
        </button>
      </main>

      <section
        className={`route-sheet${sheetExpanded ? " expanded" : " collapsed"}${selectedRoute ? " detail" : ""}`}
        aria-label={selectedRoute ? "Selected route" : "Route options"}
      >
        <button
          type="button"
          className="route-sheet-toggle"
          aria-expanded={sheetExpanded}
          onClick={handleSheetToggleClick}
          onTouchStart={(e) => handleSheetTouchStart(e.touches[0]?.clientY ?? 0)}
          onTouchEnd={(e) => handleSheetTouchEnd(e.changedTouches[0]?.clientY ?? 0)}
        >
          <span className="route-sheet-handle" aria-hidden />
          <span className="route-sheet-peek">{sheetPeekLabel}</span>
          <Icon name={sheetExpanded ? "chevronDown" : "chevronUp"} size={18} />
        </button>
        {sheetExpanded ? (
          <div className="route-sheet-body">
            {isAdjusting && selectedRoute && origin?.location && destination?.location ? (
              <SelectedRoutePanel
                route={selectedRoute}
                origin={origin.location}
                destination={destination.location}
                originLabel={origin.label}
                destinationLabel={destination.label}
                departures={selectedDepartures}
                departuresLoading={departuresLoading}
                scheduleExpanded={scheduleExpanded}
                onOpenSchedule={() => setScheduleExpanded(true)}
                onCollapseSchedule={handleCollapseSchedule}
                activeDeparture={activeDeparture}
                onSelectDeparture={handleSelectDeparture}
                instancePath={instancePath}
                instanceLoading={instanceLoading}
                onBack={() => handleSelectRoute(null)}
                showMode={showModeOnCards}
                walkAmenities={
                  walkAmenityStatus === "ready" ? walkAmenities : []
                }
                walkAmenityCategory={walkAmenity}
              />
            ) : isAdjusting ? (
              <RouteResults
                routes={plan?.routes ?? []}
                onSelect={(route) => handleSelectRoute(route)}
                loading={loading}
                showMode={showModeOnCards}
                origin={origin?.location ?? null}
                destination={destination?.location ?? null}
                departuresByKey={departuresByKey}
                departuresLoading={departuresLoading}
              />
            ) : (
              <div className="results-panel muted results-empty">
                <p>
                  {loading
                    ? "Planning walk + transit…"
                    : canPlan
                      ? "Tap Plan trip to see routes."
                      : "Choose an origin and destination to see routes."}
                </p>
                {!loading && !isAdjusting ? (
                  <button type="button" className="secondary view-demo-btn" onClick={loadDemo}>
                    View demo trip
                  </button>
                ) : null}
              </div>
            )}
            <p className="sheet-footnote">
              Times are estimates
              {plan ? ` · ${plan.meta.routeCount} options · ${plan.meta.elapsedMs} ms` : ""}
            </p>
          </div>
        ) : null}
      </section>
    </div>
  );
}
