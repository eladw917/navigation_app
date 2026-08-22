import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { israelLocalNow, parseClockAt } from "./departures.js";

describe("parseClockAt", () => {
  it("uses live now when omitted", () => {
    const before = Date.now();
    const parsed = parseClockAt();
    const after = Date.now();
    assert.ok(parsed.getTime() >= before - 5);
    assert.ok(parsed.getTime() <= after + 5);
  });

  it("reads an ISO instant for Israel-local GTFS clock parts", () => {
    const at = parseClockAt("2026-08-21T05:30:00.000Z");
    const clock = israelLocalNow(at);
    assert.equal(clock.dayOfWeek, 5);
    assert.equal(clock.nowSecs, 8 * 3600 + 30 * 60);
  });
});
