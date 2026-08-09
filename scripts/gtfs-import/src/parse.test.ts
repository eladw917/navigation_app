import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isValidCoordinate, parseGtfsTimeToSeconds } from "./parse.js";

describe("parseGtfsTimeToSeconds", () => {
  it("parses normal times", () => {
    assert.equal(parseGtfsTimeToSeconds("09:15:30"), 9 * 3600 + 15 * 60 + 30);
  });

  it("parses times beyond 24 hours", () => {
    assert.equal(parseGtfsTimeToSeconds("25:10:00"), 25 * 3600 + 10 * 60);
  });

  it("returns null for empty", () => {
    assert.equal(parseGtfsTimeToSeconds(""), null);
    assert.equal(parseGtfsTimeToSeconds(null), null);
  });

  it("rejects invalid times", () => {
    assert.throws(() => parseGtfsTimeToSeconds("9:15"));
    assert.throws(() => parseGtfsTimeToSeconds("10:70:00"));
  });
});

describe("isValidCoordinate", () => {
  it("accepts Israel-like coordinates", () => {
    assert.equal(isValidCoordinate(32.08, 34.78), true);
  });

  it("rejects out-of-range values", () => {
    assert.equal(isValidCoordinate(100, 34), false);
    assert.equal(isValidCoordinate(32, 200), false);
  });
});
