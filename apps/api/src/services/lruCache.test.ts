import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LruTtlCache } from "./lruCache.js";

describe("LruTtlCache", () => {
  it("returns cached values and evicts oldest", () => {
    const cache = new LruTtlCache<string>(2, 60_000);
    cache.set("a", "1");
    cache.set("b", "2");
    assert.equal(cache.get("a"), "1");
    cache.set("c", "3");
    assert.equal(cache.get("b"), undefined);
    assert.equal(cache.get("a"), "1");
    assert.equal(cache.get("c"), "3");
  });
});
