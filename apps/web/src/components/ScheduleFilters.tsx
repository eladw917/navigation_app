import { useEffect, useRef, useState } from "react";

const DAY_LABELS = [
  { value: 0, short: "Sun" },
  { value: 1, short: "Mon" },
  { value: 2, short: "Tue" },
  { value: 3, short: "Wed" },
  { value: 4, short: "Thu" },
  { value: 5, short: "Fri" },
  { value: 6, short: "Sat" },
] as const;

export type ScheduleFilter = {
  hoursStart: number;
  hoursEnd: number;
  daysOfWeek: number[];
  /** True when user explicitly set hour or day filters (affects API filtering). */
  active: boolean;
};

type Props = {
  value: ScheduleFilter;
  onChange: (next: ScheduleFilter) => void;
};

function formatHour(h: number): string {
  return `${String(h).padStart(2, "0")}:00`;
}

function isHoursCustom(v: Pick<ScheduleFilter, "hoursStart" | "hoursEnd">): boolean {
  return v.hoursStart !== 6 || v.hoursEnd !== 22;
}

function isDaysCustom(days: number[]): boolean {
  return days.length < 7;
}

export function ScheduleFilters({ value, onChange }: Props) {
  const [hoursOpen, setHoursOpen] = useState(false);
  const [daysOpen, setDaysOpen] = useState(false);
  const [draftHours, setDraftHours] = useState({
    hoursStart: value.hoursStart,
    hoursEnd: value.hoursEnd,
  });
  const [draftDays, setDraftDays] = useState(value.daysOfWeek);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hoursOpen) {
      setDraftHours({ hoursStart: value.hoursStart, hoursEnd: value.hoursEnd });
    }
  }, [value.hoursStart, value.hoursEnd, hoursOpen]);

  useEffect(() => {
    if (!daysOpen) setDraftDays(value.daysOfWeek);
  }, [value.daysOfWeek, daysOpen]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setHoursOpen(false);
        setDaysOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function toggleDraftDay(day: number) {
    const set = new Set(draftDays);
    if (set.has(day)) set.delete(day);
    else set.add(day);
    const daysOfWeek = [...set].sort((a, b) => a - b);
    setDraftDays(daysOfWeek.length ? daysOfWeek : [0, 1, 2, 3, 4, 5, 6]);
  }

  function applyHours() {
    const next = {
      ...value,
      hoursStart: draftHours.hoursStart,
      hoursEnd: draftHours.hoursEnd,
      active: isHoursCustom(draftHours) || isDaysCustom(value.daysOfWeek),
    };
    onChange(next);
    setHoursOpen(false);
  }

  function applyDays() {
    const daysOfWeek = draftDays.length ? draftDays : [0, 1, 2, 3, 4, 5, 6];
    onChange({
      ...value,
      daysOfWeek,
      active: isHoursCustom(value) || isDaysCustom(daysOfWeek),
    });
    setDaysOpen(false);
  }

  const hoursLabel =
    draftHours.hoursStart === 0 && draftHours.hoursEnd === 24
      ? "All hours"
      : `${formatHour(draftHours.hoursStart)}–${formatHour(draftHours.hoursEnd)}`;

  const daysLabel =
    draftDays.length === 7
      ? "All days"
      : draftDays.map((d) => DAY_LABELS[d]?.short ?? d).join(" ");

  return (
    <div className="schedule-filters" ref={wrapRef}>
      <button
        type="button"
        className={`schedule-icon-btn ${hoursOpen || isHoursCustom(value) ? "active" : ""}`}
        aria-label="Filter by hours"
        title="Filter by hours"
        onClick={() => {
          setHoursOpen((v) => !v);
          setDaysOpen(false);
        }}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M12 7v5l3 2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>
      <button
        type="button"
        className={`schedule-icon-btn ${daysOpen || isDaysCustom(value.daysOfWeek) ? "active" : ""}`}
        aria-label="Filter by day"
        title="Filter by day"
        onClick={() => {
          setDaysOpen((v) => !v);
          setHoursOpen(false);
        }}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
          <rect x="3" y="5" width="18" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M3 10h18M8 3v4M16 3v4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>

      {hoursOpen ? (
        <div className="schedule-popover" role="dialog" aria-label="Hours filter">
          <p className="schedule-popover-title">Service hours</p>
          <p className="popup-muted">{hoursLabel}</p>
          <label className="schedule-range">
            <span>From</span>
            <input
              type="range"
              min={0}
              max={23}
              value={draftHours.hoursStart}
              onChange={(e) => {
                const hoursStart = Number(e.target.value);
                setDraftHours((prev) => ({
                  hoursStart,
                  hoursEnd: Math.max(prev.hoursEnd, hoursStart + 1),
                }));
              }}
            />
            <strong>{formatHour(draftHours.hoursStart)}</strong>
          </label>
          <label className="schedule-range">
            <span>To</span>
            <input
              type="range"
              min={1}
              max={24}
              value={draftHours.hoursEnd}
              onChange={(e) => {
                const hoursEnd = Number(e.target.value);
                setDraftHours((prev) => ({
                  hoursEnd,
                  hoursStart: Math.min(prev.hoursStart, hoursEnd - 1),
                }));
              }}
            />
            <strong>{formatHour(draftHours.hoursEnd)}</strong>
          </label>
          <div className="schedule-popover-actions">
            <button
              type="button"
              className="linkish"
              onClick={() => setDraftHours({ hoursStart: 6, hoursEnd: 22 })}
            >
              Reset 06–22
            </button>
            <button type="button" className="schedule-apply" onClick={applyHours}>
              Apply
            </button>
          </div>
        </div>
      ) : null}

      {daysOpen ? (
        <div className="schedule-popover" role="dialog" aria-label="Days filter">
          <p className="schedule-popover-title">Service days</p>
          <p className="popup-muted">{daysLabel}</p>
          <div className="day-chips">
            {DAY_LABELS.map((day) => (
              <button
                key={day.value}
                type="button"
                className={draftDays.includes(day.value) ? "day-chip active" : "day-chip"}
                onClick={() => toggleDraftDay(day.value)}
              >
                {day.short}
              </button>
            ))}
          </div>
          <div className="schedule-popover-actions">
            <button
              type="button"
              className="linkish"
              onClick={() => setDraftDays([0, 1, 2, 3, 4, 5, 6])}
            >
              All days
            </button>
            <button type="button" className="schedule-apply" onClick={applyDays}>
              Apply
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
