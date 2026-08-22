import type { PlanMode } from "../api";
import {
  FREQUENCY_MAX_OPTIONS,
  NEAR_LIMIT_WALK_MINUTES,
  TOTAL_TIME_MAX_OPTIONS,
  type FrequencyMaxMinutes,
  type TotalTimeMaxMinutes,
} from "../mergePlans";
import { WALK_AMENITY_OPTIONS, type WalkAmenityFilter } from "../walkAmenities";
import { SelectChip, type SelectChipOption } from "./ui/SelectChip";

const ALL_MODES: PlanMode[] = ["walk_transit", "transit_walk"];

type ModeFilter = "all" | PlanMode;

const MODE_OPTIONS: SelectChipOption<ModeFilter>[] = [
  { value: "all", label: "Any" },
  { value: "walk_transit", label: "Walk → Transit" },
  { value: "transit_walk", label: "Transit → Walk" },
];

type Props = {
  enabledModes: PlanMode[];
  onModesChange: (modes: PlanMode[]) => void;
  includeNearLimitWalk: boolean;
  walkLimitMinutes: number;
  onNearLimitWalkChange: (include: boolean) => void;
  maxFrequencyMinutes: FrequencyMaxMinutes;
  onFrequencyChange: (value: FrequencyMaxMinutes) => void;
  maxTotalTimeMinutes: TotalTimeMaxMinutes;
  onTotalTimeChange: (value: TotalTimeMaxMinutes) => void;
  walkAmenity: WalkAmenityFilter;
  onWalkAmenityChange: (value: WalkAmenityFilter) => void;
  /** Live count of options after filters — proves filters are applying. */
  resultCount?: number | null;
};

export function FilterBar({
  enabledModes,
  onModesChange,
  includeNearLimitWalk,
  walkLimitMinutes,
  onNearLimitWalkChange,
  maxFrequencyMinutes,
  onFrequencyChange,
  maxTotalTimeMinutes,
  onTotalTimeChange,
  walkAmenity,
  onWalkAmenityChange,
  resultCount = null,
}: Props) {
  const walkOptions: SelectChipOption<"under" | "near">[] = [
    { value: "under", label: `Under ${walkLimitMinutes} min` },
    {
      value: "near",
      label: `Near-limit (+${NEAR_LIMIT_WALK_MINUTES} min)`,
    },
  ];

  const freqOptions: SelectChipOption<string>[] = FREQUENCY_MAX_OPTIONS.map((mins) => ({
    value: String(mins),
    label: mins === "all" ? "Any" : `≤ ${mins} min`,
  }));

  const totalOptions: SelectChipOption<string>[] = TOTAL_TIME_MAX_OPTIONS.map((mins) => ({
    value: String(mins),
    label: mins === "all" ? "Any" : `${mins} min`,
  }));

  const modeValue: ModeFilter =
    enabledModes.length === 1 ? enabledModes[0]! : "all";

  return (
    <div className="filter-bar" role="group" aria-label="Result filters">
      <SelectChip
        icon="swap"
        label="Mode"
        value={modeValue}
        options={MODE_OPTIONS}
        onChange={(next) =>
          onModesChange(next === "all" ? [...ALL_MODES] : [next])
        }
      />
      <SelectChip
        icon="walk"
        label="Total walk"
        value={includeNearLimitWalk ? "near" : "under"}
        options={walkOptions}
        onChange={(next) => onNearLimitWalkChange(next === "near")}
      />
      <SelectChip
        icon="signal"
        label="Frequency"
        value={String(maxFrequencyMinutes)}
        options={freqOptions}
        onChange={(next) =>
          onFrequencyChange(
            (next === "all" ? "all" : Number(next)) as FrequencyMaxMinutes,
          )
        }
      />
      <SelectChip
        icon="clock"
        label="Max journey"
        value={String(maxTotalTimeMinutes)}
        options={totalOptions}
        onChange={(next) =>
          onTotalTimeChange(
            (next === "all" ? "all" : Number(next)) as TotalTimeMaxMinutes,
          )
        }
      />
      <SelectChip
        icon="shop"
        label="On the walk"
        value={walkAmenity}
        options={WALK_AMENITY_OPTIONS}
        onChange={onWalkAmenityChange}
      />
      {resultCount != null ? (
        <span className="filter-result-count" aria-live="polite">
          {resultCount} option{resultCount === 1 ? "" : "s"}
        </span>
      ) : null}
    </div>
  );
}