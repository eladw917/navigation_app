import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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

type MenuPos = { top: number; left: number; minWidth: number };

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
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  const listId = useId();
  const current = options.find((o) => o.value === value);

  useLayoutEffect(() => {
    if (!open || !wrapRef.current) {
      setMenuPos(null);
      return;
    }
    const place = () => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      const minWidth = Math.max(rect.width, 9.5 * 16);
      const maxLeft = window.innerWidth - minWidth - 8;
      setMenuPos({
        top: rect.bottom + 6,
        left: Math.max(8, Math.min(rect.left, maxLeft)),
        minWidth,
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
      {open && menuPos
        ? createPortal(
            <ul
              ref={menuRef}
              className="select-chip-menu select-chip-menu-portal"
              role="listbox"
              id={listId}
              aria-label={label}
              style={{
                top: menuPos.top,
                left: menuPos.left,
                minWidth: menuPos.minWidth,
              }}
            >
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
            </ul>,
            document.body,
          )
        : null}
    </div>
  );
}
