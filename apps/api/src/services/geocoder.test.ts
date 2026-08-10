import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildQueryVariants,
  extractHouseNumber,
  normalizeHouseNumber,
  parseAddressQuery,
  streetMatchScore,
  tokenPhraseMatch,
} from "./addressParse.js";
import { __rankPlacesForTests } from "./geocoder.js";
import type { PlaceResult } from "@navigation/contracts";

describe("addressParse", () => {
  it("parses Hebrew street + number + city", () => {
    const p = parseAddressQuery("דיזנגוף 50 תל אביב");
    assert.equal(p.street, "דיזנגוף");
    assert.equal(normalizeHouseNumber(p.housenumber), "50");
    assert.equal(p.city?.nameHe, "תל אביב");
    assert.deepEqual(p.streetTokens, ["דיזנגוף"]);
  });

  it("strips street prefixes and keeps city", () => {
    const p = parseAddressQuery("רחוב יפו 138 ירושלים");
    assert.equal(p.street, "יפו");
    assert.equal(normalizeHouseNumber(p.housenumber), "138");
    assert.equal(p.city?.nameHe, "ירושלים");
  });

  it("matches longest city key (ראשון לציון, not ראשון alone)", () => {
    const p = parseAddressQuery("הרצל 12 ראשון לציון");
    assert.equal(p.city?.nameHe, "ראשון לציון");
    assert.equal(p.street, "הרצל");
  });

  it("extracts Hebrew letter house suffixes", () => {
    assert.equal(normalizeHouseNumber(extractHouseNumber("ביאליק 12א רמת גן")), "12א");
    const p = parseAddressQuery("ביאליק 12א רמת גן");
    assert.equal(p.street, "ביאליק");
    assert.equal(normalizeHouseNumber(p.housenumber), "12א");
  });

  it("builds useful query variants without duplicates", () => {
    const variants = buildQueryVariants(parseAddressQuery("רחוב דיזנגוף 50 תל אביב"));
    assert.ok(variants.some((v) => /דיזנגוף/.test(v) && /50/.test(v) && /תל אביב/.test(v)));
    assert.equal(new Set(variants.map((v) => v.toLowerCase())).size, variants.length);
  });
});

describe("token matching", () => {
  it("does not treat יפו as a match inside יפת", () => {
    assert.equal(tokenPhraseMatch("יפת 138 תל אביב", "יפו"), false);
    assert.equal(tokenPhraseMatch("יפו 138 ירושלים", "יפו"), true);
  });

  it("scores full street token hits higher than partial", () => {
    const parsed = parseAddressQuery("יפו 138 ירושלים");
    assert.equal(streetMatchScore("יפו", "יפו, ירושלים", parsed), 3);
    assert.equal(streetMatchScore("יפת", "יפת 138, תל אביב", parsed), 0);
  });
});

describe("geocoder ranking", () => {
  const base = (partial: Partial<PlaceResult> & Pick<PlaceResult, "id" | "label" | "location">): PlaceResult => ({
    source: "nominatim",
    ...partial,
  });

  it("prefers exact house number on the matching street and city", () => {
    const ranked = __rankPlacesForTests(
      [
        base({
          id: "wrong-hn",
          label: "דיזנגוף 12, תל אביב",
          location: { lng: 34.78, lat: 32.08 },
          city: "תל אביב",
          street: "דיזנגוף",
          housenumber: "12",
        }),
        base({
          id: "exact",
          label: "דיזנגוף 50, תל אביב",
          location: { lng: 34.775, lat: 32.077 },
          city: "תל אביב",
          street: "דיזנגוף",
          housenumber: "50",
          confidence: 0.5,
        }),
        base({
          id: "wrong-city",
          label: "דיזנגוף 50, חיפה",
          location: { lng: 34.99, lat: 32.82 },
          city: "חיפה",
          street: "דיזנגוף",
          housenumber: "50",
        }),
      ],
      "דיזנגוף 50 תל אביב",
    );
    assert.equal(ranked[0]?.id, "exact");
    assert.ok(!ranked.some((r) => r.id === "wrong-city"));
  });

  it("drops יפת when querying יפו + city", () => {
    const ranked = __rankPlacesForTests(
      [
        base({
          id: "yefet",
          label: "יפת 138, תל אביב-יפו",
          location: { lng: 34.75, lat: 32.05 },
          city: "תל אביב-יפו",
          street: "יפת",
          housenumber: "138",
        }),
        base({
          id: "jaffa-street",
          label: "יפו, ירושלים",
          location: { lng: 35.22, lat: 31.78 },
          city: "ירושלים",
          street: "יפו",
        }),
      ],
      "יפו 138 ירושלים",
    );
    assert.equal(ranked[0]?.id, "jaffa-street");
    assert.ok(!ranked.some((r) => r.id === "yefet"));
  });

  it("keeps street without HN when exact number is missing in OSM", () => {
    const ranked = __rankPlacesForTests(
      [
        base({
          id: "street",
          label: "אינו שאקי, ירושלים",
          location: { lng: 35.2, lat: 31.76 },
          city: "ירושלים",
          street: "אינו שאקי",
        }),
        base({
          id: "poi",
          label: "מחוז ירושלים, ישראל",
          location: { lng: 35.2, lat: 31.75 },
        }),
      ],
      "אינו שאקי 6",
    );
    assert.equal(ranked[0]?.id, "street");
  });
});
