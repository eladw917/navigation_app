import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  DirectRoute,
  LatLng,
  ScheduledDeparture,
  StopDeparturesResponse,
  TripPathResponse,
  WalkAmenity,
} from "../api";
import { buildItineraryText, copyText } from "../exportItinerary";
import { formatHeadway } from "../frequency";
import {
  formatNextBusIn,
  formatStopClock,
  pickNextCatchableDeparture,
} from "../formatDeparture";
import {
  modeLabel,
  roundedWalkSeconds,
  routeBadgeLabel,
  routeTypeLabel,
  totalJourneySeconds,
  walkLegsSeconds,
} from "../mergePlans";
import {
  amenitiesAlongRouteWalks,
  type WalkAmenityFilter,
} from "../walkAmenities";
import { Icon } from "./ui/Icon";
import { WalkAmenityList } from "./WalkAmenityList";

type Props = {
  route: DirectRoute;
  origin: LatLng;
  destination: LatLng;
  originLabel: string;
  destinationLabel: string;
  departures: StopDeparturesResponse | null;
  departuresLoading: boolean;
  scheduleExpanded: boolean;
  onOpenSchedule: () => void;
  onCollapseSchedule: () => void;
  activeDeparture: ScheduledDeparture | null;
  onSelectDeparture: (departure: ScheduledDeparture) => void;
  instancePath: TripPathResponse | null;
  instanceLoading: boolean;
  onBack: () => void;
  showMode?: boolean;
  walkAmenities?: WalkAmenity[];
  walkAmenityCategory?: WalkAmenityFilter;
};

type MenuPos = { top: number; left: number };

function formatLegMinutes(seconds: number): string {
  return `${Math.max(1, Math.round(seconds / 60))} min`;
}

function lineTitle(route: DirectRoute): string {
  return route.tripHeadsign || route.routeLongName || routeTypeLabel(route.routeType);
}

function ExportMenu({
  route,
  origin,
  destination,
  originLabel,
  destinationLabel,
  nextDepartureLabel,
}: {
  route: DirectRoute;
  origin: LatLng;
  destination: LatLng;
  originLabel: string;
  destinationLabel: string;
  nextDepartureLabel: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null);
  const [copied, setCopied] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const copiedTimer = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (!open || !wrapRef.current) {
      setMenuPos(null);
      return;
    }
    const place = () => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = 10.5 * 16;
      const maxLeft = window.innerWidth - width - 8;
      setMenuPos({
        top: rect.bottom + 6,
        left: Math.max(8, Math.min(rect.right - width, maxLeft)),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDocPointerDown(e: PointerEvent) {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onDocPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    return () => {
      if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
    };
  }, []);

  async function handleCopy(kind: "link" | "text") {
    const shareUrl = typeof window !== "undefined" ? window.location.href : "";
    const text =
      kind === "link"
        ? shareUrl
        : buildItineraryText({
            originLabel,
            destinationLabel,
            origin,
            destination,
            route,
            nextDepartureLabel,
            shareUrl,
          });
    const ok = await copyText(text);
    if (!ok) return;
    setCopied(true);
    if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1600);
    setOpen(false);
  }

  return (
    <div className="route-export" ref={wrapRef}>
      <button
        type="button"
        className="export-chip"
        aria-label="Export route"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="share" size={13} />
        {copied ? "Copied" : "Export"}
      </button>
      {open && menuPos
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              className="export-menu"
              style={{ top: menuPos.top, left: menuPos.left }}
            >
              <button
                type="button"
                role="menuitem"
                className="export-menu-item"
                onClick={() => {
                  void handleCopy("link");
                }}
              >
                Copy link
              </button>
              <button
                type="button"
                role="menuitem"
                className="export-menu-item"
                onClick={() => {
                  void handleCopy("text");
                }}
              >
                Copy text
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

export function SelectedRoutePanel({
  route,
  origin,
  destination,
  originLabel,
  destinationLabel,
  departures,
  departuresLoading,
  scheduleExpanded,
  onOpenSchedule,
  onCollapseSchedule,
  activeDeparture,
  onSelectDeparture,
  instancePath,
  instanceLoading,
  onBack,
  showMode = false,
  walkAmenities = [],
  walkAmenityCategory = "any",
}: Props) {
  const walks = walkLegsSeconds(route, origin, destination);
  const total = totalJourneySeconds(route, origin, destination);
  const walkToBoardSecs = roundedWalkSeconds(walks.toBoard);
  const amenitiesOnWalk =
    walkAmenityCategory === "any"
      ? []
      : amenitiesAlongRouteWalks(
          [route],
          walkAmenities,
          walkAmenityCategory,
          origin,
          destination,
        );
  const nextDep =
    activeDeparture ??
    pickNextCatchableDeparture(departures?.departures, departures?.nowSecs, walkToBoardSecs);
  const nextLabel =
    departuresLoading && !departures
      ? "…"
      : formatNextBusIn(nextDep, departures?.nowSecs);
  const scheduleTitle = `${routeTypeLabel(route.routeType)} ${routeBadgeLabel(route)}`;

  return (
    <div className="selected-route-panel">
      <div className="selected-route-toolbar">
        <button type="button" className="linkish selected-route-back" onClick={onBack}>
          ← All options
        </button>
        <div className="selected-route-actions">
          <ExportMenu
            route={route}
            origin={origin}
            destination={destination}
            originLabel={originLabel}
            destinationLabel={destinationLabel}
            nextDepartureLabel={nextLabel ?? null}
          />
          <button
            type="button"
            className="info-chip"
            aria-label="Show all departure times"
            aria-expanded={scheduleExpanded}
            onClick={() => {
              if (scheduleExpanded) onCollapseSchedule();
              else onOpenSchedule();
            }}
          >
            i
          </button>
        </div>
      </div>

      <article className="selected-route-card">
        <div className="route-top">
          <span className="route-badge">{routeBadgeLabel(route)}</span>
          <span className="route-name">{lineTitle(route)}</span>
        </div>
        <div className="route-legs" aria-label="Trip legs">
          <span className="route-leg">
            <Icon name="walk" size={14} />
            {formatLegMinutes(walks.toBoard)}
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
            {formatLegMinutes(walks.fromAlight)}
          </span>
          <span className="selected-route-total">{formatLegMinutes(total)}</span>
        </div>
        <dl className="selected-route-stops">
          <div>
            <dt>Board</dt>
            <dd>{route.boardStopName}</dd>
          </div>
          <div>
            <dt>Alight</dt>
            <dd>{route.alightStopName}</dd>
          </div>
        </dl>
        <div className="selected-route-meta">
          <span className="route-freq">
            <Icon name="leaf" size={13} />
            {formatHeadway(route.headwaySeconds, route.frequencyBucket)}
          </span>
          <span className="route-next">
            Next: <strong>{nextLabel ?? "—"}</strong>
          </span>
          {showMode && route.planMode ? (
            <span className="route-mode muted tiny">{modeLabel(route.planMode)}</span>
          ) : null}
        </div>
        <WalkAmenityList amenities={amenitiesOnWalk} category={walkAmenityCategory} />
      </article>

      {scheduleExpanded ? (
        <div className="schedule-expander" role="region" aria-label="Scheduled departures">
          <div className="schedule-expander-header">
            <div>
              <h3>
                {scheduleTitle}
                <span className="muted tiny"> · next 24h</span>
              </h3>
              <p className="muted tiny">
                {activeDeparture
                  ? `Trip departing ${activeDeparture.timeLabel}${activeDeparture.dayOffset ? " (+1)" : ""}`
                  : "Click a time for that trip’s station timeline"}
              </p>
            </div>
            <button type="button" className="schedule-collapse" onClick={onCollapseSchedule}>
              Collapse
            </button>
          </div>
          {departuresLoading && !departures ? (
            <p className="muted tiny">Loading times…</p>
          ) : !departures?.departures.length ? (
            <p className="muted tiny">No departures in the next 24 hours.</p>
          ) : (
            <div className="schedule-times">
              {departures.departures.map((dep) => {
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
                    onClick={() => onSelectDeparture(dep)}
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
    </div>
  );
}
