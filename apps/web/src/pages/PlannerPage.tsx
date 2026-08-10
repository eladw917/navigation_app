import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchBoardDepartures,
  fetchHealth,
  fetchTripPath,
  planDirect,
  reversePlace,
  type DirectPlanResponse,
  type DirectRoute,
  type LatLng,
  type PlanMode,
  type ScheduledDeparture,
  type StopDeparturesResponse,
  type TripPathResponse,
} from "../api";
import { FilterBar } from "../components/FilterBar";
import { PlaceInput } from "../components/PlaceInput";
import { RouteResults } from "../components/RouteResults";
import { ScheduleFilters, type ScheduleFilter } from "../components/ScheduleFilters";
import { TransitMap } from "../components/TransitMap";
import { Icon } from "../components/ui/Icon";
import { SelectChip } from "../components/ui/SelectChip";
import {
  applyResultFilters,
  filterPlanByCatchableDepartures,
  filterPlanByModes,
  FREQUENCY_MAX_OPTIONS,
  modeLabel,
  roundedWalkSeconds,
  routeBadgeLabel,
  routeOptionKey,
  totalJourneySeconds,
  TOTAL_TIME_MAX_OPTIONS,
  walkLegsSeconds,
  type FrequencyMaxMinutes,
  type TotalTimeMaxMinutes,
} from "../mergePlans";
import { pickNextCatchableDeparture } from "../formatDeparture";
import { rememberPlace } from "../placeHistory";
import { buildDemoState, isDemoUrl } from "../demo/mockPlan";

type Endpoint = { label: string; location: LatLng } | null;

const ALL_MODES: PlanMode[] = ["walk_transit", "transit_walk"];

const WALK_MINUTE_OPTIONS = [5, 10, 15, 20, 25, 30];

const DEFAULT_SCHEDULE: ScheduleFilter = {
  hoursStart: 6,
  hoursEnd: 22,
  daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
  active: false,
};

export function PlannerPage() {
  const [origin, setOrigin] = useState<Endpoint>(null);
  const [destination, setDestination] = useState<Endpoint>(null);
  /** Modes visible after planning; both on by default. */
  const [enabledModes, setEnabledModes] = useState<PlanMode[]>([...ALL_MODES]);
  /** When on, hide options where walk-to-board or walk-after exceeds max walking time. */
  const [limitTotalWalk, setLimitTotalWalk] = useState(true);
  /** When on, hide options with no catchable departure within ~3 hours. Off by default. */
  const [limitSoonDepartures, setLimitSoonDepartures] = useState(false);
  /** Max station headway (min); same tiers as pin sizes. Default all = no filter. */
  const [maxFrequencyMinutes, setMaxFrequencyMinutes] =
    useState<FrequencyMaxMinutes>("all");
  /** Max walk+ride+walk journey time. */
  const [maxTotalTimeMinutes, setMaxTotalTimeMinutes] =
    useState<TotalTimeMaxMinutes>(90);
  const [plansByMode, setPlansByMode] = useState<Partial<Record<PlanMode, DirectPlanResponse>>>(
    {},
  );
  const [sliderDraft, setSliderDraft] = useState(15);
  const [committedMinutes, setCommittedMinutes] = useState(15);
  const [schedule, setSchedule] = useState<ScheduleFilter>(DEFAULT_SCHEDULE);
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
  const [error, setError] = useState<string | null>(null);
  const [apiOk, setApiOk] = useState<boolean | null>(null);
  const [demoMode, setDemoMode] = useState(() => isDemoUrl());
  const [sheetExpanded, setSheetExpanded] = useState(false);
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

  /** Walk / mode / time filters — departures are fetched for these routes. */
  const basePlan = useMemo(
    () =>
      applyResultFilters(fullPlan, {
        enabledModes,
        limitTotalWalk,
        origin: origin?.location ?? null,
        destination: destination?.location ?? null,
        maxWalkingSeconds: committedMinutes * 60,
        maxFrequencyMinutes,
        maxTotalTimeMinutes,
      }),
    [
      fullPlan,
      enabledModes,
      limitTotalWalk,
      origin?.location,
      destination?.location,
      committedMinutes,
      maxFrequencyMinutes,
      maxTotalTimeMinutes,
    ],
  );

  const routeKeysSig = useMemo(
    () => (basePlan?.routes ?? []).map(routeOptionKey).join("|"),
    [basePlan?.routes],
  );

  const departuresReady =
    !basePlan?.routes.length ||
    (!departuresLoading && departuresFetchedSig === routeKeysSig);

  /** Optional: after departures load, keep only options with a catchable departure soon. */
  const plan = useMemo(() => {
    if (!basePlan) return null;
    if (!limitSoonDepartures || !departuresReady) return basePlan;
    return filterPlanByCatchableDepartures(
      basePlan,
      departuresByKey,
      origin?.location ?? null,
      destination?.location ?? null,
    );
  }, [
    basePlan,
    limitSoonDepartures,
    departuresReady,
    departuresByKey,
    origin?.location,
    destination?.location,
  ]);

  useEffect(() => {
    fetchHealth()
      .then((h) => setApiOk(h.status === "ok" && h.database))
      .catch((err) => {
        console.error("[health]", err);
        setApiOk(false);
      });
  }, []);

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
    if (!stillThere) setSelectedRoute(null);
  }, [plan, selectedRoute]);

  useEffect(() => {
    departuresAbortRef.current?.abort();
    setActiveDeparture(null);
    setInstancePath(null);
    if (!basePlan?.routes.length) {
      setDeparturesByKey({});
      setDeparturesLoading(false);
      setDeparturesFetchedSig("");
      return;
    }
    if (demoMode) return;
    const controller = new AbortController();
    departuresAbortRef.current = controller;
    setDeparturesLoading(true);
    const routes = basePlan.routes;
    const fetchSig = routes.map(routeOptionKey).join("|");
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
  }, [basePlan?.requestId, routeKeysSig, demoMode]);

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
    if (!route) setScheduleExpanded(false);
    setSelectedRoute(route);
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

  function toggleMode(mode: PlanMode) {
    setEnabledModes((prev) => {
      if (prev.includes(mode)) {
        if (prev.length === 1) return prev;
        return prev.filter((m) => m !== mode);
      }
      return ALL_MODES.filter((m) => m === mode || prev.includes(m));
    });
  }

  function toggleTotalWalkLimit() {
    setLimitTotalWalk((prev) => !prev);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount when ?demo=1
  }, []);

  async function runPlan(minutes = committedMinutes, scheduleOverride?: ScheduleFilter) {
    if (!origin || !destination) {
      setError("Choose both origin and destination");
      return;
    }
    if (demoMode) setDemoMode(false);
    setSheetExpanded(false);
    const sched = scheduleOverride ?? schedule;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    setSelectedRoute(null);
    console.info("[plan] start", {
      modes: ALL_MODES,
      maxWalkingSeconds: minutes * 60,
      origin: origin.location,
      destination: destination.location,
      schedule: sched,
    });
    try {
      const shared = {
        origin: origin.location,
        destination: destination.location,
        maxWalkingSeconds: minutes * 60,
        hoursStart: sched.hoursStart,
        hoursEnd: sched.hoursEnd,
        daysOfWeek: sched.daysOfWeek,
        filterBySchedule: sched.active,
      };
      // Load both directions together so the first rendered map already contains
      // both walking areas and their pins.
      const [walkTransit, transitWalk] = await Promise.all([
        planDirect({ ...shared, mode: "walk_transit" }, controller.signal),
        planDirect({ ...shared, mode: "transit_walk" }, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      setCommittedMinutes(minutes);
      setSliderDraft(minutes);
      setPlansByMode({
        walk_transit: walkTransit,
        transit_walk: transitWalk,
      });
      setEnabledModes([...ALL_MODES]);
      setLimitTotalWalk(true);
      setLimitSoonDepartures(false);
      setMaxFrequencyMinutes("all");
      setMaxTotalTimeMinutes(90);
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
      if ((err as Error).name === "AbortError") return;
      const message = err instanceof Error ? err.message : "Plan failed";
      console.error("[plan] failed", err);
      setError(message);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  function selectOrigin(place: { label: string; location: LatLng }) {
    rememberPlace(place);
    setOrigin(place);
    setPlansByMode({});
    setSelectedRoute(null);
    setError(null);
  }

  function selectDestination(place: { label: string; location: LatLng }) {
    rememberPlace(place);
    setDestination(place);
    setPlansByMode({});
    setSelectedRoute(null);
    setError(null);
  }

  function clearOrigin() {
    setOrigin(null);
    setPlansByMode({});
    setSelectedRoute(null);
    setError(null);
  }

  function clearDestination() {
    setDestination(null);
    setPlansByMode({});
    setSelectedRoute(null);
    setError(null);
  }

  function swapEndpoints() {
    setOrigin(destination);
    setDestination(origin);
    setPlansByMode({});
    setSelectedRoute(null);
    setError(null);
  }

  function startNewQuery() {
    abortRef.current?.abort();
    setPlansByMode({});
    setSelectedRoute(null);
    setError(null);
    setLoading(false);
    setEnabledModes([...ALL_MODES]);
    setLimitTotalWalk(true);
    setLimitSoonDepartures(false);
    setMaxFrequencyMinutes("all");
    setMaxTotalTimeMinutes(90);
    setSchedule(DEFAULT_SCHEDULE);
    setSheetExpanded(false);
  }

  function handleScheduleChange(next: ScheduleFilter) {
    setSchedule(next);
    if (!origin || !destination || !Object.keys(plansByMode).length) return;
    void runPlan(committedMinutes, next);
  }

  async function useMyLocation() {
    if (!navigator.geolocation) {
      setError("Location is not available in this browser");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const location = { lng: pos.coords.longitude, lat: pos.coords.latitude };
        try {
          const { results } = await reversePlace(location);
          const label = results[0]?.label ?? "Current location";
          selectOrigin({ label, location });
        } catch (err) {
          console.error("[reverse]", err);
          selectOrigin({ label: "Current location", location });
        } finally {
          setLocating(false);
        }
      },
      (err) => {
        console.error("[geolocation]", err);
        setError("Could not get your location");
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
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
      <header className="top-chrome">
        <div className="app-header">
          <div className="app-brand" aria-label="Walk2Ride">
            <img className="app-logo-icon" src="/logo-icon.png" alt="" aria-hidden />
            <span className="app-logo-text">Walk2Ride</span>
          </div>
          {!demoMode && apiOk === false ? <p className="api-pill bad">API offline</p> : null}
        </div>

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
                placeholder="Starting point"
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

          <div className="search-card-actions">
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
              disabled={loading || !canPlan}
              onClick={() => {
                void runPlan(sliderDraft);
              }}
            >
              {loading ? "Planning…" : "Plan trip"}
            </button>
          </div>
        </div>

        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
      </header>

      <main className="map-pane">
        <div className="map-chrome">
          <FilterBar
            enabledModes={enabledModes}
            onModesChange={setEnabledModes}
            limitTotalWalk={limitTotalWalk}
            walkLimitMinutes={committedMinutes}
            onWalkLimitChange={setLimitTotalWalk}
            maxFrequencyMinutes={maxFrequencyMinutes}
            onFrequencyChange={setMaxFrequencyMinutes}
            maxTotalTimeMinutes={maxTotalTimeMinutes}
            onTotalTimeChange={setMaxTotalTimeMinutes}
            disabled={!isAdjusting}
          />
          {isAdjusting ? (
            <ScheduleFilters value={schedule} onChange={handleScheduleChange} />
          ) : null}
        </div>

        <TransitMap
          origin={origin?.location ?? null}
          destination={destination?.location ?? null}
          originLabel={origin?.label ?? null}
          destinationLabel={destination?.label ?? null}
          plan={isAdjusting ? plan : null}
          selectedRoute={isAdjusting ? mapSelectedRoute : null}
          planning={loading && !isAdjusting}
          overrideDeparture={activeDeparture}
          limitWalk={limitTotalWalk}
          maxWalkingSeconds={committedMinutes * 60}
          onOpenSchedule={
            isAdjusting && selectedRoute
              ? () => setScheduleExpanded(true)
              : undefined
          }
        />

        <button
          type="button"
          className="locate-fab"
          aria-label="Use my location as origin"
          disabled={locating}
          onClick={() => {
            void useMyLocation();
          }}
        >
          {locating ? <span className="spinner" aria-hidden /> : <Icon name="locate" size={20} />}
        </button>
      </main>

      <section
        className={`route-sheet${sheetExpanded ? " expanded" : " collapsed"}`}
        aria-label="Route options"
      >
        <button
          type="button"
          className="route-sheet-toggle"
          aria-expanded={sheetExpanded}
          onClick={() => setSheetExpanded((open) => !open)}
        >
          <span className="route-sheet-handle" aria-hidden />
          <span className="route-sheet-peek">{sheetPeekLabel}</span>
          <Icon name={sheetExpanded ? "chevronDown" : "chevronUp"} size={18} />
        </button>
        {sheetExpanded ? (
          <div className="route-sheet-body">
            {isAdjusting ? (
              <RouteResults
                routes={plan?.routes ?? []}
                selectedId={selectedKey}
                onSelect={handleSelectRoute}
                loading={loading}
                showMode={showModeOnCards}
                origin={origin?.location ?? null}
                destination={destination?.location ?? null}
                departuresByKey={departuresByKey}
                departuresLoading={departuresLoading}
                scheduleExpanded={scheduleExpanded}
                onOpenSchedule={() => setScheduleExpanded(true)}
                onCollapseSchedule={handleCollapseSchedule}
                activeDeparture={activeDeparture}
                onSelectDeparture={handleSelectDeparture}
                instancePath={instancePath}
                instanceLoading={instanceLoading}
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
