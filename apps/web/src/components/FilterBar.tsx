import type { PlanMode } from "../api";
import {
  FREQUENCY_MAX_OPTIONS,
  TOTAL_TIME_MAX_OPTIONS,
  type FrequencyMaxMinutes,
  type TotalTimeMaxMinutes,
} from "../mergePlans";
import { SelectChip, type SelectChipOption } from "./ui/SelectChip";

type ModeChoice = "both" | PlanMode;

type Props = {
  enabledModes: PlanMode[];
  onModesChange: (modes: PlanMode[]) => void;
  limitTotalWalk: boolean;
  walkLimitMinutes: number;
  onWalkLimitChange: (limit: boolean) => void;
  maxFrequencyMinutes: FrequencyMaxMinutes;
  onFrequencyChange: (value: FrequencyMaxMinutes) => void;
  maxTotalTimeMinutes: TotalTimeMaxMinutes;
  onTotalTimeChange: (value: TotalTimeMaxMinutes) => void;
  /** Live count of options after filters — proves filters are applying. */
  resultCount?: number | null;
  /** Filters only apply to a computed plan, so they stay inert before one exists. */
  disabled?: boolean;
};

const MODE_OPTIONS: SelectChipOption<ModeChoice>[] = [
  { value: "both", label: "Both modes" },
  { value: "walk_transit", label: "Walk → Transit" },
  { value: "transit_walk", label: "Transit → Walk" },
];

export function FilterBar({
  enabledModes,
  onModesChange,
  limitTotalWalk,
  walkLimitMinutes,
  onWalkLimitChange,
  maxFrequencyMinutes,
  onFrequencyChange,
  maxTotalTimeMinutes,
  onTotalTimeChange,
  resultCount = null,
  disabled = false,
}: Props) {
  const modeValue: ModeChoice =
    enabledModes.length === 1 ? (enabledModes[0] ?? "both") : "both";

  const walkOptions: SelectChipOption<"any" | "limit">[] = [
    { value: "limit", label: `≤ ${walkLimitMinutes} min` },
    { value: "any", label: "Any walk" },
  ];

  const freqOptions: SelectChipOption<string>[] = FREQUENCY_MAX_OPTIONS.map((mins) => ({
    value: String(mins),
    label: mins === "all" ? "Any" : `≤ ${mins} min`,
  }));

  const totalOptions: SelectChipOption<string>[] = TOTAL_TIME_MAX_OPTIONS.map((mins) => ({
    value: String(mins),
    label: `${mins} min`,
  }));

  return (
    <div className="filter-bar" role="group" aria-label="Result filters">
      <SelectChip
        icon="bus"
        label="Mode"
        value={modeValue}
        options={MODE_OPTIONS}
        disabled={disabled}
        onChange={(next) =>
          onModesChange(next === "both" ? ["walk_transit", "transit_walk"] : [next])
        }
      />
      <SelectChip
        icon="walk"
        label="Total walk"
        value={limitTotalWalk ? "limit" : "any"}
        options={walkOptions}
        disabled={disabled}
        onChange={(next) => onWalkLimitChange(next === "limit")}
      />
      <SelectChip
        icon="signal"
        label="Frequency"
        value={String(maxFrequencyMinutes)}
        options={freqOptions}
        disabled={disabled}
        onChange={(next) =>
          onFrequencyChange(
            (next === "all" ? "all" : Number(next)) as FrequencyMaxMinutes,
          )
        }
      />
      <SelectChip
        icon="clock"
        label="Total time"
        value={String(maxTotalTimeMinutes)}
        options={totalOptions}
        disabled={disabled}
        onChange={(next) => onTotalTimeChange(Number(next) as TotalTimeMaxMinutes)}
      />
      {resultCount != null ? (
        <span className="filter-result-count" aria-live="polite">
          {resultCount} option{resultCount === 1 ? "" : "s"}
        </span>
      ) : null}
    </div>
  );
}
