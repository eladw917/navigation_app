import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  roundCoord,
  straightLineWalk,
  walkRouteCacheKey,
  WALK_SPEED_MPS,
} from "./orsDirections.js";

describe("walk route cache key", () => {
  it("rounds coordinates so nearby points share a key", () => {
    const a = walkRouteCacheKey(34.78101, 32.08101, 34.79102, 32.08203);
    const b = walkRouteCacheKey(34.78104, 32.08104, 34.79101, 32.08201);
    assert.equal(a, b);
    assert.equal(roundCoord(34.78004), 34.78);
  });

  it("treats opposite directions as different walks", () => {
    const forward = walkRouteCacheKey(34.78, 32.08, 34.79, 32.09);
    const reverse = walkRouteCacheKey(34.79, 32.09, 34.78, 32.08);
    assert.notEqual(forward, reverse);
  });
});

describe("straight-line walk fallback", () => {
  it("returns a two-point line and duration at the walking speed", () => {
    const from = { lng: 34.78, lat: 32.08 };
    const to = { lng: 34.79, lat: 32.08 };
    const walk = straightLineWalk(from, to);
    assert.deepEqual(walk.coordinates, [
      [from.lng, from.lat],
      [to.lng, to.lat],
    ]);
    assert.ok(walk.distanceMeters > 800 && walk.distanceMeters < 1200);
    assert.equal(walk.durationSeconds, walk.distanceMeters / WALK_SPEED_MPS);
  });
});
