import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { roundWalkCoord, straightLineWalk, walkPairKey } from "./walkRoute";

describe("walk route client helpers", () => {
  it("rounds nearby coordinates onto the same cache key", () => {
    const a = walkPairKey({ lng: 34.78101, lat: 32.08101 }, { lng: 34.79102, lat: 32.08203 });
    const b = walkPairKey({ lng: 34.78104, lat: 32.08104 }, { lng: 34.79101, lat: 32.08201 });
    assert.equal(a, b);
    assert.equal(roundWalkCoord(34.78004), 34.78);
  });

  it("builds a two-point straight-line fallback", () => {
    const from = { lng: 34.78, lat: 32.08 };
    const to = { lng: 34.79, lat: 32.08 };
    const walk = straightLineWalk(from, to);
    assert.equal(walk.approximated, true);
    assert.deepEqual(walk.coordinates, [
      [from.lng, from.lat],
      [to.lng, to.lat],
    ]);
    assert.ok(walk.distanceMeters > 800 && walk.distanceMeters < 1200);
    assert.ok(walk.durationSeconds > 0);
  });
});
