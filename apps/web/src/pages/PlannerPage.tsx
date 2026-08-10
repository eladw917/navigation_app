import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchBoardDepartures,
  fetchHealth,
  fetchTripPath,
  planDirect,
  type DirectPlanResponse,
  type DirectRoute,
  type LatLng,
  type PlanMode,
  type ScheduledDeparture,
  type StopDeparturesResponse,
  type TripPathResponse,
} from "../api";
import { PlaceInput } from "../components/PlaceInput";
import { RouteResults } from "../components/RouteResults";
import { ScheduleFilters, type ScheduleFilter } from "../components/ScheduleFilters";
import { TransitMap } from "../components/TransitMap";
import {
  applyResultFilters,
  filterPlanByCatchableDepartures,
  filterPlanByModes,
  FREQUENCY_MAX_OPTIONS,
  modeLabel,
  roundedWalkSeconds,
  routeOptionKey,
  TOTAL_TIME_MAX_OPTIONS,
  walkLegsSeconds,
  type FrequencyMaxMinutes,
  type TotalTimeMaxMinutes,
} from "../mergePlans";
import { pickNextCatchableDeparture } from "../formatDeparture";
import { rememberPlace } from "../placeHistory";

type Endpoint = { label: string; location: LatLng } | null;

const ALL_MODES: PlanMode[] = ["walk_transit", "transit_walk"];

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
  const [error, setError] = useState<string | null>(null);
  const [apiOk, setApiOk] = useState<boolean | null>(null);
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
  }, [basePlan?.requestId, routeKeysSig]);

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
  }, [selectedRoute, activeDeparture]);

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

  async function runPlan(minutes = committedMinutes, scheduleOverride?: ScheduleFilter) {
    if (!origin || !destination) {
      setError("Choose both origin and destination");
      return;
    }
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
  }

  function handleScheduleChange(next: ScheduleFilter) {
    setSchedule(next);
    if (!origin || !destination || !Object.keys(plansByMode).length) return;
    void runPlan(committedMinutes, next);
  }

  const filterButtons = (
    <div className="map-filter-stack">
      <div className="mode-row" role="group" aria-label="Result filters">
        {ALL_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            className={enabledModes.includes(mode) ? "active" : ""}
            aria-pressed={enabledModes.includes(mode)}
            onClick={() => toggleMode(mode)}
          >
            {modeLabel(mode)}
          </button>
        ))}
        <button
          type="button"
          className={`mode-total${limitTotalWalk ? " active" : ""}`}
          aria-pressed={limitTotalWalk}
          onClick={toggleTotalWalkLimit}
          title="Hide options where walk to the stop plus walk after exceeds max walking time"
        >
          Walks ≤ {committedMinutes} min
        </button>
        <button
          type="button"
          className={`mode-total${limitSoonDepartures ? " active" : ""}`}
          aria-pressed={limitSoonDepartures}
          disabled={!departuresReady && Boolean(basePlan?.routes.length)}
          onClick={() => setLimitSoonDepartures((v) => !v)}
          title="Hide options with no catchable departure within about 3 hours"
        >
          Next ≤ 3h
        </button>
      </div>
      <div className="freq-row freq-row-wide" role="group" aria-label="Max station frequency">
        <span className="freq-row-label">Max freq</span>
        {FREQUENCY_MAX_OPTIONS.map((mins) => (
          <button
            key={String(mins)}
            type="button"
            className={maxFrequencyMinutes === mins ? "active" : ""}
            aria-pressed={maxFrequencyMinutes === mins}
            title={
              mins === "all"
                ? "Show all stations, including unknown frequency"
                : mins >= 30
                  ? "Only stations with a known frequency (any headway)"
                  : `Only stations every ${mins} min or more often`
            }
            onClick={() => setMaxFrequencyMinutes(mins)}
          >
            {mins === "all" ? "All" : `≤${mins}`}
          </button>
        ))}
      </div>
      <div className="freq-row" role="group" aria-label="Max total journey time">
        <span className="freq-row-label">Total</span>
        {TOTAL_TIME_MAX_OPTIONS.map((mins) => (
          <button
            key={mins}
            type="button"
            className={maxTotalTimeMinutes === mins ? "active" : ""}
            aria-pressed={maxTotalTimeMinutes === mins}
            title={`Only options with walk + ride + walk ≤ ${mins} min`}
            onClick={() => setMaxTotalTimeMinutes(mins)}
          >
            ≤{mins}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <header className="brand">
          <p className="eyebrow">Israel · Phase 1</p>
          <h1>Walk + Transit</h1>
          <p className="lede">
            {isAdjusting
              ? "Adjust filters on the map, or start a new query."
              : "Choose origin and destination, set walking time, then plan."}
          </p>
          <p className={`api-pill ${apiOk ? "ok" : apiOk === false ? "bad" : ""}`}>
            {apiOk === null ? "Checking API…" : apiOk ? "API connected" : "API offline — run npm run dev"}
          </p>
        </header>

        <section className="controls">
          {isAdjusting && origin && destination ? (
            <>
              <div className="trip-facts" aria-label="Planned trip">
                <div className="trip-fact">
                  <span>From</span>
                  <strong>{origin.label}</strong>
                </div>
                <div className="trip-fact">
                  <span>To</span>
                  <strong>{destination.label}</strong>
                </div>
                <div className="trip-fact">
                  <span>Max walk</span>
                  <strong>{committedMinutes} min</strong>
                </div>
              </div>
              <button type="button" className="secondary" onClick={startNewQuery}>
                New query
              </button>
            </>
          ) : (
            <>
              <div className="place-pair">
                <PlaceInput
                  label="Origin"
                  valueLabel={origin?.label ?? ""}
                  onSelect={selectOrigin}
                />
                <PlaceInput
                  label="Destination"
                  valueLabel={destination?.label ?? ""}
                  onSelect={selectDestination}
                />
              </div>

              <label className="slider-block">
                <div className="slider-label">
                  <span>Max walking time</span>
                  <strong>{sliderDraft} min</strong>
                </div>
                <input
                  type="range"
                  min={5}
                  max={30}
                  step={1}
                  value={sliderDraft}
                  onChange={(e) => setSliderDraft(Number(e.target.value))}
                />
              </label>

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

              {!canPlan ? (
                <p className="loading-status">Select origin and destination to plan.</p>
              ) : null}
            </>
          )}

          {loading ? (
            <p className="loading-status" role="status" aria-live="polite">
              <span className="spinner" aria-hidden />
              Planning walk + transit…
            </p>
          ) : null}

          {error ? (
            <p className="field-error" role="alert">
              {error}
            </p>
          ) : null}

          {isAdjusting && plan ? (
            <div className="meta-box">
              <p>
                <strong>{plan.meta.validStopCount}</strong> stops · {plan.meta.routeCount} route
                options · {plan.meta.elapsedMs} ms
                {plan.meta.isochroneCached ? " · isochrone cached" : ""}
              </p>
              {plan.warnings.map((w) => (
                <p key={w} className="warn">
                  {w}
                </p>
              ))}
            </div>
          ) : null}
        </section>

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
        ) : null}
      </aside>

      <main className="map-pane">
        {isAdjusting ? (
          <div className="map-toolbar">
            {filterButtons}
            <ScheduleFilters value={schedule} onChange={handleScheduleChange} />
          </div>
        ) : null}
        <TransitMap
          origin={origin?.location ?? null}
          destination={destination?.location ?? null}
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
      </main>
    </div>
  );
}
