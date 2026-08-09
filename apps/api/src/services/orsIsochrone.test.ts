import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LruTtlCache } from "./lruCache.js";

describe("isochrone cache key behavior", () => {
  it("stores and retrieves by exact key", () => {
    const cache = new LruTtlCache<{ type: string }>(10, 60_000);
    cache.set("foot|34.78|32.08|900|start", { type: "FeatureCollection" });
    assert.deepEqual(cache.get("foot|34.78|32.08|900|start"), { type: "FeatureCollection" });
    assert.equal(cache.get("foot|34.78|32.08|900|destination"), undefined);
  });
});
