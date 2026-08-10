import type { ReactNode } from "react";

type IconName =
  | "walk"
  | "bus"
  | "clock"
  | "signal"
  | "chevronDown"
  | "chevronRight"
  | "chevronUp"
  | "swap"
  | "locate"
  | "leaf";

type Props = {
  name: IconName;
  size?: number;
  className?: string;
};

const PATHS: Record<IconName, ReactNode> = {
  walk: (
    <>
      <circle cx="13" cy="4" r="1.8" />
      <path d="M12.5 8 9.5 10l-1 4M12.5 8l2.5 1.5 1.5 3M12.5 8l-1 5 2.5 3 .5 5M11.5 13l-2.5 3-1 4" />
    </>
  ),
  bus: (
    <>
      <rect x="4" y="4" width="16" height="13" rx="2.5" />
      <path d="M4 12h16M7.5 20v-3M16.5 20v-3" />
      <circle cx="8" cy="14.5" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="16" cy="14.5" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5.2l3.2 2" />
    </>
  ),
  signal: (
    <>
      <path d="M5 19v-4M10 19v-8M15 19v-11M20 19V5" />
    </>
  ),
  chevronDown: <path d="m6 9.5 6 5.5 6-5.5" />,
  chevronRight: <path d="m9.5 6 5.5 6-5.5 6" />,
  chevronUp: <path d="m6 14.5 6-5.5 6 5.5" />,
  swap: (
    <>
      <path d="M7.5 4v16M7.5 4 4.5 7M7.5 4l3 3" />
      <path d="M16.5 20V4M16.5 20l3-3M16.5 20l-3-3" />
    </>
  ),
  locate: (
    <>
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3" />
    </>
  ),
  leaf: (
    <>
      <path d="M19 5c0 8-5 12-11 12-1 0-2-.2-3-.6" />
      <path d="M5 19c1-7 6-11 14-14" />
    </>
  ),
};

export function Icon({ name, size = 16, className }: Props) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
