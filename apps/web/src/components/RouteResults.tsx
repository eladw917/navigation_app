import type { DirectRoute, LatLng, StopDeparturesResponse } from "../api";
import { formatHeadway } from "../frequency";
import { formatNextBusIn, pickNextCatchableDeparture } from "../formatDeparture";
import {
  modeLabel,
  roundedWalkSeconds,
  routeBadgeLabel,
  routeOptionKey,
  routeTypeLabel,
  totalJourneySeconds,
  walkLegsSeconds,
} from "../mergePlans";
import { Icon } from "./ui/Icon";

type Props = {
  routes: DirectRoute[];
  onSelect: (route: DirectRoute) => void;
  loading: boolean;
  showMode?: boolean;
  origin?: LatLng | null;
  destination?: LatLng | null;
  departuresByKey?: Record<string, StopDeparturesResponse>;
  departuresLoading?: boolean;
};

function formatLegMinutes(seconds: number): string {
  return `${Math.max(1, Math.round(seconds / 60))} min`;
}

function formatTotalMinutes(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes} min`;
}

function lineTitle(route: DirectRoute): string {
  return route.tripHeadsign || route.routeLongName || routeTypeLabel(route.routeType);
}

export function RouteResults({
  routes,
  onSelect,
  loading,
  showMode = false,
  origin = null,
  destination = null,
  departuresByKey = {},
  departuresLoading = false,
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

  return (
    <div className="results-panel">
      <div className="results-header">
        <h2>{routes.length} options</h2>
      </div>

      <ul className="route-list">
        {routes.map((route) => {
          const key = routeOptionKey(route);
          const total =
            origin && destination
              ? totalJourneySeconds(route, origin, destination)
              : null;
          const freq = formatHeadway(route.headwaySeconds);
          const deps = departuresByKey[key];
          const walkToBoardSecs =
            origin && destination
              ? roundedWalkSeconds(walkLegsSeconds(route, origin, destination).toBoard)
              : 0;
          const nextDep = pickNextCatchableDeparture(
            deps?.departures,
            deps?.nowSecs,
            walkToBoardSecs,
          );
          const walkLegs =
            origin && destination ? walkLegsSeconds(route, origin, destination) : null;
          const nextLabel =
            departuresLoading && !deps
              ? "…"
              : formatNextBusIn(nextDep, deps?.nowSecs);
          return (
            <li key={key}>
              <button
                type="button"
                className="route-card"
                onClick={() => onSelect(route)}
              >
                <div className="route-card-main">
                  <div className="route-top">
                    <span className="route-badge">{routeBadgeLabel(route)}</span>
                    <span className="route-name">{lineTitle(route)}</span>
                  </div>
                  {walkLegs ? (
                    <div className="route-legs" aria-label="Trip legs">
                      <span className="route-leg">
                        <Icon name="walk" size={14} />
                        {formatLegMinutes(walkLegs.toBoard)}
                      </span>
                      <span className="route-leg-dot" aria-hidden>
                        ·
                      </span>
                      <span className="route-leg">
                        <Icon name="bus" size={14} />
                        {formatLegMinutes(route.rideDurationSeconds ?? 0)}
                      </span>
                      <span className="route-leg-dot" aria-hidden>
                        ·
                      </span>
                      <span className="route-leg">
                        <Icon name="walk" size={14} />
                        {formatLegMinutes(walkLegs.fromAlight)}
                      </span>
                    </div>
                  ) : null}
                </div>

                <div className="route-card-side">
                  {total != null ? (
                    <span className="route-total">{formatTotalMinutes(total)}</span>
                  ) : null}
                  <span className="route-freq">
                    <Icon name="leaf" size={13} />
                    {freq}
                  </span>
                  <span className="route-next">
                    Next: <strong>{nextLabel ?? "—"}</strong>
                  </span>
                  {showMode && route.planMode ? (
                    <span className="route-mode muted tiny">{modeLabel(route.planMode)}</span>
                  ) : null}
                </div>

                <span className="route-card-chevron" aria-hidden>
                  <Icon name="chevronRight" size={18} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
