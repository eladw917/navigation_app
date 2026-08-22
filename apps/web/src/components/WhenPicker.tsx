import { useEffect, useRef, useState } from "react";
import {
  formatWhenChip,
  fromDatetimeLocalValue,
  israelClock,
  startOfIsraelDay,
  toDatetimeLocalValue,
} from "../departAt";
import { Icon } from "./ui/Icon";

type Props = {
  value: Date | null;
  onChange: (next: Date | null) => void;
  variant?: "control" | "summary";
};

export function WhenPicker({ value, onChange, variant = "control" }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() =>
    toDatetimeLocalValue(value ?? new Date()),
  );
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) setDraft(toDatetimeLocalValue(value ?? new Date()));
  }, [value, open]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: PointerEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function applyDraft() {
    onChange(fromDatetimeLocalValue(draft));
    setOpen(false);
  }

  function leaveNow() {
    onChange(null);
    setOpen(false);
  }

  const label = formatWhenChip(value);
  const min = toDatetimeLocalValue(startOfIsraelDay());
  const clock = israelClock(value ?? new Date());
  const maxDate = new Date(Date.now() + 14 * 86400_000);
  const max = toDatetimeLocalValue(maxDate);

  return (
    <div className={`when-picker when-picker-${variant}`} ref={wrapRef}>
      <button
        type="button"
        className={
          variant === "summary" ? "trip-summary-when" : "select-chip-trigger"
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Leave at ${label}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="clock" size={variant === "summary" ? 13 : 18} />
        {variant === "summary" ? (
          <span>{label}</span>
        ) : (
          <>
            <span className="select-chip-text">
              <span className="select-chip-label">When</span>
              <strong className="select-chip-value">{label}</strong>
            </span>
            <Icon name="chevronDown" size={14} />
          </>
        )}
      </button>
      {open ? (
        <div className="when-popover" role="dialog" aria-label="Leave at">
          <p className="schedule-popover-title">Leave at</p>
          <p className="when-popover-note">
            Next bus and frequency use this Israel time
            {value
              ? ` (${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")})`
              : " (now)"}
            .
          </p>
          <label className="when-datetime">
            <span className="sr-only">Date and time</span>
            <input
              type="datetime-local"
              value={draft}
              min={min}
              max={max}
              onChange={(e) => {
                setDraft(e.target.value);
                if (e.target.value) onChange(fromDatetimeLocalValue(e.target.value));
              }}
            />
          </label>
          <div className="schedule-popover-actions">
            <button type="button" className="linkish" onClick={leaveNow}>
              Leave now
            </button>
            <button type="button" className="schedule-apply" onClick={applyDraft}>
              Apply
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
