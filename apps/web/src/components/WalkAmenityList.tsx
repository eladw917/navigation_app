import { useEffect, useState } from "react";
import type { WalkAmenity } from "../api";
import { WALK_AMENITY_LABELS, type WalkAmenityFilter } from "../walkAmenities";

const COLLAPSED_COUNT = 2;

export function WalkAmenityList({
  amenities,
  category,
  onSelect,
}: {
  amenities: WalkAmenity[];
  category: WalkAmenityFilter;
  onSelect?: (amenity: WalkAmenity) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const ids = amenities.map((a) => a.id).join("|");

  useEffect(() => {
    setExpanded(false);
  }, [ids]);

  if (category === "any") return null;
  const label = WALK_AMENITY_LABELS[category];
  if (!amenities.length) {
    return (
      <p className="popup-walk-amenities-empty">
        No {label.toLowerCase()} on this walk
      </p>
    );
  }

  const overflow = amenities.length > COLLAPSED_COUNT;
  const visible = expanded || !overflow ? amenities : amenities.slice(0, COLLAPSED_COUNT);

  return (
    <div className={`popup-walk-amenities${expanded ? " expanded" : ""}`}>
      <p className="popup-walk-amenities-label">
        {label} on this walk
      </p>
      <ul>
        {visible.map((amenity) => (
          <li key={amenity.id}>
            <button
              type="button"
              className="popup-walk-amenity"
              onClick={() => onSelect?.(amenity)}
            >
              {amenity.name}
            </button>
          </li>
        ))}
      </ul>
      {overflow ? (
        <button
          type="button"
          className="popup-walk-amenities-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Show less" : `Show all ${amenities.length}`}
        </button>
      ) : null}
    </div>
  );
}
