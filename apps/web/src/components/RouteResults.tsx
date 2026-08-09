import type {
  DirectRoute,
  LatLng,
  ScheduledDeparture,
  StopDeparturesResponse,
  TripPathResponse,
} from "../api";
import { formatHeadway } from "../frequency";
import {
  formatNextBusIn,
  formatStopClock,
  pickNextCatchableDeparture,
} from "../formatDeparture";
import { modeLabel, totalJourneySeconds, walkLegsSeconds } from "../mergePlans";

type Props = {
  routes: DirectRoute[];
  selectedId: string | null;
  onSelect: (route: DirectRoute | null) => void;
  loading: boolean;
  showMode?: boolean;
  origin?: LatLng | null;
  destination?: LatLng | null;
  departuresByKey?: Record<string, StopDeparturesResponse>;
  departuresLoading?: boolean;
  scheduleExpanded?: boolean;
  onOpenSchedule?: () => void;
  onCollapseSchedule?: () => void;
  activeDeparture?: ScheduledDeparture | null;
  onSelectDeparture?: (departure: ScheduledDeparture) => void;
  instancePath?: TripPathResponse | null;
  instanceLoading?: boolean;
};

function formatTotalMinutes(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `~${minutes} min`;
}

function busTitle(route: DirectRoute): string {
  return route.tripHeadsign || route.routeLongName || "Bus line";
}

function routeOptionKey(route: DirectRoute): string {
  const mode = route.planMode ?? "walk_transit";
  return `${mode}-${route.routeId}-${route.boardStopId}-${route.alightStopId}`;
}

export function RouteResults({
  routes,
  selectedId,
  onSelect,
  loading,
  showMode = false,
  origin = null,
  destination = null,
  departuresByKey = {},
  departuresLoading = false,
  scheduleExpanded = false,
  onOpenSchedule,
  onCollapseSchedule,
  activeDeparture = null,
  onSelectDeparture,
  instancePath = null,
  instanceLoading = false,
}: Props) {
  if (loading) {
    return <div className="results-panel muted">Planning…</div>;
  }
  if (!routes.length) {
    return (
      <div className="results-panel muted">
        No direct routes yet. Set origin, destination, and run a plan.
      </div>
    );
  }

  const selectedDepartures = selectedId ? departuresByKey[selectedId] : undefined;
  const busName = selectedDepartures?.routeShortName;

  return (
    <div className="results-panel">
      <div className="results-header">
        <h2>{routes.length} bus options</h2>
        {selectedId ? (
          <button type="button" className="linkish" onClick={() => onSelect(null)}>
            Clear selection
          </button>
        ) : null}
      </div>

      {scheduleExpanded && selectedId ? (
        <div className="schedule-expander" role="region" aria-label="Scheduled departures">
          <div className="schedule-expander-header">
            <div>
              <h3>
                {busName ? `Bus ${busName}` : "Schedule"}
                <span className="muted tiny"> · next 24h</span>
              </h3>
              <p className="muted tiny">
                {activeDeparture
                  ? `Trip departing ${activeDeparture.timeLabel}${activeDeparture.dayOffset ? " (+1)" : ""}`
                  : "Click a time for that trip’s station timeline"}
              </p>
            </div>
            <button
              type="button"
              className="schedule-collapse"
              onClick={() => onCollapseSchedule?.()}
            >
              Collapse
            </button>
          </div>
          {departuresLoading && !selectedDepartures ? (
            <p className="muted tiny">Loading times…</p>
          ) : !selectedDepartures?.departures.length ? (
            <p className="muted tiny">No departures in the next 24 hours.</p>
          ) : (
            <div className="schedule-times">
              {selectedDepartures.departures.map((dep) => {
                const active =
                  activeDeparture?.tripId === dep.tripId &&
                  activeDeparture.departureSecs === dep.departureSecs &&
                  activeDeparture.dayOffset === dep.dayOffset;
                return (
                  <button
                    key={`${dep.dayOffset}-${dep.departureSecs}-${dep.tripId}`}
                    type="button"
                    className={`schedule-time${dep.dayOffset === 1 ? " tomorrow" : ""}${active ? " active" : ""}`}
                    title={`${dep.dayLabel} · show station times`}
                    onClick={() => onSelectDeparture?.(dep)}
                  >
                    {dep.timeLabel}
                    {dep.dayOffset === 1 ? <sup>+</sup> : null}
                  </button>
                );
              })}
            </div>
          )}

          {activeDeparture ? (
            <div className="trip-timeline" aria-label="Trip station timeline">
              <div className="trip-timeline-header">
                <strong>Station times</strong>
                {instanceLoading ? <span className="muted tiny">Loading…</span> : null}
              </div>
              {instanceLoading && !instancePath ? (
                <p className="muted tiny">Loading this trip…</p>
              ) : !instancePath?.stops.length ? (
                <p className="muted tiny">Could not load this trip’s stops.</p>
              ) : (
                <ol className="trip-timeline-list">
                  {instancePath.stops.map((stop) => {
                    const clock = formatStopClock(stop);
                    return (
                      <li
                        key={`${stop.stopSequence}-${stop.stopId}`}
                        className={[
                          stop.isBoard ? "is-board" : "",
                          stop.isAlight ? "is-alight" : "",
                          stop.onPath ? "on-path" : "off-path",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                      >
                        <time>{clock ?? "—"}</time>
                        <span className="trip-timeline-name">{stop.name}</span>
                        {stop.isBoard ? <em>Board</em> : null}
                        {stop.isAlight ? <em>Get off</em> : null}
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      <ul className="route-list">
        {routes.map((route) => {
          const key = routeOptionKey(route);
          const active = selectedId === key;
          const total =
            origin && destination
              ? totalJourneySeconds(route, origin, destination)
              : null;
          const freq = formatHeadway(route.headwaySeconds);
          const deps = departuresByKey[key];
          // Match walk-leg minute rounding so next-bus skips trips you'd miss on foot.
          const walkToBoardSecs =
            origin && destination
              ? Math.max(
                  60,
                  Math.round(walkLegsSeconds(route, origin, destination).toBoard / 60) * 60,
                )
              : 0;
          const nextDep =
            active && activeDeparture
              ? activeDeparture
              : pickNextCatchableDeparture(
                  deps?.departures,
                  deps?.nowSecs,
                  walkToBoardSecs,
                );
          const nextLabel =
            departuresLoading && !deps
              ? "…"
              : formatNextBusIn(nextDep, deps?.nowSecs);
          return (
            <li key={key}>
              <button
                type="button"
                className={active ? "route-card active" : "route-card"}
                onClick={() => onSelect(active ? null : route)}
              >
                <div className="route-top">
                  <span className="route-badge">{route.routeShortName ?? route.routeId}</span>
                  <span className="route-name">{busTitle(route)}</span>
                  {total != null ? (
                    <span className="route-total">{formatTotalMinutes(total)}</span>
                  ) : null}
                </div>
                <p className="route-meta">
                  <span>{freq}</span>
                  {showMode && route.planMode ? (
                    <span className="muted"> · {modeLabel(route.planMode)}</span>
                  ) : null}
                </p>
                <p className="route-next">
                  <span>
                    Next bus <strong>{nextLabel ?? "—"}</strong>
                  </span>
                  {active && onOpenSchedule ? (
                    <button
                      type="button"
                      className="info-chip"
                      aria-label="Show all departure times"
                      aria-expanded={scheduleExpanded}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (scheduleExpanded) onCollapseSchedule?.();
                        else onOpenSchedule();
                      }}
                    >
                      i
                    </button>
                  ) : null}
                </p>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
