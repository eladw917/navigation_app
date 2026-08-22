import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bucketRadius,
  DEFAULT_PIN_RADIUS,
  formatHeadway,
  headwayToBucket,
  stationFrequencyBucket,
} from "./frequency";

describe("headwayToBucket", () => {
  it("treats missing data as unknown", () => {
    assert.equal(headwayToBucket(null), "unknown");
    assert.equal(headwayToBucket(undefined), "unknown");
    assert.equal(headwayToBucket(0), "unknown");
  });

  it("treats a counted empty window as none", () => {
    assert.equal(headwayToBucket(null, true), "none");
    assert.equal(headwayToBucket(0, true), "none");
  });
});

describe("formatHeadway", () => {
  it("distinguishes unknown from no buses in the next hour", () => {
    assert.equal(formatHeadway(null), "Frequency unknown");
    assert.equal(formatHeadway(null, "unknown"), "Frequency unknown");
    assert.equal(formatHeadway(null, "none"), "No buses in the next hour");
  });
});

describe("stationFrequencyBucket", () => {
  it("uses the most frequent known line", () => {
    assert.equal(
      stationFrequencyBucket([
        { headwaySeconds: 1200, frequencyBucket: "about_20" },
        { headwaySeconds: 240, frequencyBucket: "under_5" },
      ]),
      "under_5",
    );
  });

  it("is none only when every line is a confirmed empty hour", () => {
    assert.equal(
      stationFrequencyBucket([
        { headwaySeconds: null, frequencyBucket: "none" },
        { headwaySeconds: null, frequencyBucket: "none" },
      ]),
      "none",
    );
    assert.equal(
      stationFrequencyBucket([
        { headwaySeconds: null, frequencyBucket: "none" },
        { headwaySeconds: null, frequencyBucket: "unknown" },
      ]),
      "unknown",
    );
  });
});

describe("bucketRadius", () => {
  it("uses the drop-off disc size as the default", () => {
    assert.equal(bucketRadius("unknown"), DEFAULT_PIN_RADIUS);
    assert.equal(bucketRadius("none"), DEFAULT_PIN_RADIUS);
    assert.equal(bucketRadius("over_30"), DEFAULT_PIN_RADIUS);
    assert.ok(bucketRadius("under_5") > DEFAULT_PIN_RADIUS);
  });
});
