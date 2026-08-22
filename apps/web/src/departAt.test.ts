import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatWhenChip,
  fromDatetimeLocalValue,
  israelClock,
  toDatetimeLocalValue,
} from "./departAt";

describe("departAt", () => {
  it("reads Israel-local clock parts", () => {
    // 08:30 Friday in Israel (IDT, UTC+3) on 21 Aug 2026.
    const at = new Date("2026-08-21T05:30:00.000Z");
    const clock = israelClock(at);
    assert.equal(clock.dayOfWeek, 5);
    assert.equal(clock.hour, 8);
    assert.equal(clock.minute, 30);
    assert.equal(clock.nowSecs, 8 * 3600 + 30 * 60);
  });

  it("round-trips datetime-local values in Israel time", () => {
    const at = new Date("2026-08-21T05:30:00.000Z");
    const value = toDatetimeLocalValue(at);
    assert.equal(value, "2026-08-21T08:30");
    const back = fromDatetimeLocalValue(value);
    assert.equal(toDatetimeLocalValue(back), value);
  });

  it("labels a same-day pick as the clock time", () => {
    const now = new Date("2026-08-21T05:30:00.000Z");
    const later = new Date("2026-08-21T10:00:00.000Z");
    assert.equal(formatWhenChip(null, now), "Now");
    assert.equal(formatWhenChip(later, now), "13:00");
  });
});
