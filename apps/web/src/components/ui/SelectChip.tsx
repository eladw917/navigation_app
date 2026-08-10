import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./Icon";

type IconName = Parameters<typeof Icon>[0]["name"];

export type SelectChipOption<T extends string> = {
  value: T;
  label: string;
};

type Props<T extends string> = {
  icon: IconName;
  label: string;
  value: T;
  options: SelectChipOption<T>[];
  onChange: (value: T) => void;
  /** Renders the trigger as the tall standalone control used next to Plan trip. */
  variant?: "chip" | "control";
  disabled?: boolean;
};

export function SelectChip<T extends string>({
  icon,
  label,
  value,
  options,
  onChange,
  variant = "chip",
  disabled = false,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    function onDocPointerDown(e: PointerEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
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

  return (
    <div className={`select-chip select-chip-${variant}`} ref={wrapRef}>
      <button
        type="button"
        className="select-chip-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={icon} size={variant === "control" ? 18 : 16} />
        <span className="select-chip-text">
          <span className="select-chip-label">{label}</span>
          <strong className="select-chip-value">{current?.label ?? "—"}</strong>
        </span>
        <Icon name="chevronDown" size={14} />
      </button>
      {open ? (
        <ul className="select-chip-menu" role="listbox" id={listId} aria-label={label}>
          {options.map((option) => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={option.value === value ? "active" : undefined}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
