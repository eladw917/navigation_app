import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildOverpassQuery,
  classifyOsmTags,
  isOsmFeatureClosed,
  MAX_BBOX_SPAN_DEG,
  validateWalkAmenityBbox,
  walkAmenityCacheKey,
  __parseOverpassElementsForTests,
} from "./walkAmenities.js";

describe("walkAmenities", () => {
  it("classifies OSM tags into walk-filter categories", () => {
    assert.equal(classifyOsmTags({ amenity: "cafe" }), "cafe");
    assert.equal(classifyOsmTags({ amenity: "ice_cream" }), "cafe");
    assert.equal(classifyOsmTags({ shop: "coffee" }), "cafe");
    assert.equal(classifyOsmTags({ shop: "supermarket" }), "grocery");
    assert.equal(classifyOsmTags({ shop: "convenience" }), "grocery");
    assert.equal(classifyOsmTags({ shop: "bakery" }), "bakery");
    assert.equal(classifyOsmTags({ amenity: "pharmacy" }), "pharmacy");
    assert.equal(classifyOsmTags({ shop: "chemist" }), "pharmacy");
    assert.equal(classifyOsmTags({ amenity: "atm" }), "atm");
    assert.equal(classifyOsmTags({ amenity: "bank" }), "atm");
    assert.equal(classifyOsmTags({ leisure: "park" }), "park");
    assert.equal(classifyOsmTags({ leisure: "playground" }), "park");
    assert.equal(classifyOsmTags({ amenity: "parking" }), null);
    assert.equal(classifyOsmTags(undefined), null);
    assert.equal(classifyOsmTags({ amenity: "cafe", opening_hours: "closed" }), null);
    assert.equal(classifyOsmTags({ amenity: "cafe", disused: "yes" }), null);
    assert.equal(classifyOsmTags({ "disused:amenity": "cafe", name: "Old Cafe" }), null);
    assert.equal(classifyOsmTags({ amenity: "cafe", shop: "vacant" }), null);
  });

  it("treats OSM closed / vacant / former tags as gone", () => {
    assert.equal(isOsmFeatureClosed({ amenity: "cafe" }), false);
    assert.equal(isOsmFeatureClosed({ amenity: "cafe", opening_hours: "Mo-Fr 08:00-18:00" }), false);
    assert.equal(isOsmFeatureClosed({ amenity: "cafe", opening_hours: "closed" }), true);
    assert.equal(isOsmFeatureClosed({ amenity: "cafe", opening_hours: "off" }), true);
    assert.equal(isOsmFeatureClosed({ amenity: "cafe", disused: "yes" }), true);
    assert.equal(isOsmFeatureClosed({ amenity: "cafe", abandoned: "yes" }), true);
    assert.equal(isOsmFeatureClosed({ "disused:shop": "convenience" }), true);
    assert.equal(isOsmFeatureClosed({ shop: "vacant" }), true);
    assert.equal(isOsmFeatureClosed({ amenity: "cafe", operational_status: "closed" }), true);
    assert.equal(isOsmFeatureClosed({ amenity: "cafe", end_date: "2020" }), true);
    assert.equal(isOsmFeatureClosed({ amenity: "cafe", end_date: "2099-01-01" }), false);
  });

  it("rejects inverted, oversized, or non-Israel bounding boxes", () => {
    assert.equal(
      validateWalkAmenityBbox({ south: 32.08, west: 34.78, north: 32.1, east: 34.8 }),
      null,
    );
    assert.match(
      validateWalkAmenityBbox({ south: 32.1, west: 34.78, north: 32.08, east: 34.8 }) ?? "",
      /inverted/,
    );
    assert.match(
      validateWalkAmenityBbox({
        south: 32.0,
        west: 34.7,
        north: 32.0 + MAX_BBOX_SPAN_DEG + 0.01,
        east: 34.78,
      }) ?? "",
      /at most/,
    );
    assert.match(
      validateWalkAmenityBbox({ south: 40, west: 2, north: 40.02, east: 2.02 }) ?? "",
      /Israel/,
    );
  });

  it("builds an Overpass query that includes the bbox and filter tags", () => {
    const query = buildOverpassQuery({ south: 32.07, west: 34.77, north: 32.09, east: 34.79 });
    assert.match(query, /32\.07,34\.77,32\.09,34\.79/);
    assert.match(query, /amenity/);
    assert.match(query, /supermarket/);
    assert.match(query, /coffee/);
    assert.match(query, /leisure/);
    assert.match(query, /opening_hours"!="closed"/);
    assert.match(query, /disused"!="yes"/);
    assert.match(query, /out center/);
  });

  it("parses Overpass elements into named amenities and skips unknown tags", () => {
    const amenities = __parseOverpassElementsForTests([
      {
        type: "node",
        id: 1,
        lat: 32.08,
        lon: 34.78,
        tags: { amenity: "cafe", name: "Landwer", "name:he": "לנדוור" },
      },
      {
        type: "way",
        id: 2,
        center: { lat: 32.081, lon: 34.781 },
        tags: { leisure: "park", name: "Meir Garden" },
      },
      {
        type: "node",
        id: 3,
        lat: 32.082,
        lon: 34.782,
        tags: { amenity: "parking" },
      },
      {
        type: "node",
        id: 4,
        lat: 32.083,
        lon: 34.783,
        tags: { amenity: "cafe", name: "Gone", opening_hours: "closed" },
      },
    ]);
    assert.equal(amenities.length, 2);
    assert.equal(amenities[0]?.category, "cafe");
    assert.equal(amenities[0]?.name, "לנדוור");
    assert.equal(amenities[1]?.category, "park");
    assert.equal(amenities[1]?.id, "osm:way/2");
  });

  it("rounds cache keys so nearby boxes share a lookup", () => {
    const a = walkAmenityCacheKey({ south: 32.0801, west: 34.7801, north: 32.0901, east: 34.7901 });
    const b = walkAmenityCacheKey({ south: 32.0804, west: 34.7804, north: 32.0904, east: 34.7904 });
    assert.equal(a, b);
  });
});
