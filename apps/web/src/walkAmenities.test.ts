import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DirectRoute } from "./api";
import {
  amenityOnWalk,
  amenitiesAlongCorridors,
  filterPlanByWalkAmenity,
  pointToSegmentMeters,
  routeHasWalkAmenity,
  amenitiesAlongRouteWalks,
  stationWalkCorridors,
  type WalkAmenity,
} from "./walkAmenities";

describe("walk amenity matching", () => {
  it("measures distance to a line segment in meters", () => {
    const from = { lng: 34.78, lat: 32.08 };
    const to = { lng: 34.79, lat: 32.08 };
    const onLine = { lng: 34.785, lat: 32.08 };
    const offLine = { lng: 34.785, lat: 32.081 };
    assert.ok(pointToSegmentMeters(onLine, from, to) < 5);
    assert.ok(pointToSegmentMeters(offLine, from, to) > 80);
    assert.ok(pointToSegmentMeters(offLine, from, to) < 150);
  });

  it("counts a cafe near the walking corridor and ignores one far off it", () => {
    const from = { lng: 34.78, lat: 32.08 };
    const to = { lng: 34.79, lat: 32.08 };
    const cafe: WalkAmenity = {
      id: "osm:node/1",
      name: "Landwer",
      category: "cafe",
      lng: 34.785,
      lat: 32.0804,
    };
    const far: WalkAmenity = {
      id: "osm:node/2",
      name: "Far",
      category: "cafe",
      lng: 34.785,
      lat: 32.09,
    };
    assert.equal(amenityOnWalk(cafe, from, to), true);
    assert.equal(amenityOnWalk(far, from, to), false);
  });

  it("lists every matching place on a selected station's walking corridor", () => {
    const origin = { lng: 34.78, lat: 32.08 };
    const station = { lng: 34.79, lat: 32.08 };
    const destination = { lng: 34.8, lat: 32.07 };
    const along: WalkAmenity = {
      id: "c1",
      name: "Landwer",
      category: "cafe",
      lng: 34.785,
      lat: 32.0803,
    };
    const alsoAlong: WalkAmenity = {
      id: "c2",
      name: "Aroma",
      category: "cafe",
      lng: 34.787,
      lat: 32.0802,
    };
    const elsewhere: WalkAmenity = {
      id: "c3",
      name: "Far",
      category: "cafe",
      lng: 34.8,
      lat: 32.075,
    };
    const corridors = stationWalkCorridors({
      station,
      origin,
      destination,
      kind: "board",
    });
    const names = amenitiesAlongCorridors([along, alsoAlong, elsewhere], corridors).map(
      (a) => a.name,
    );
    assert.deepEqual(names.sort(), ["Aroma", "Landwer"]);
  });

  it("counts amenities on the walk to the stop and the walk after the ride", () => {
    const origin = { lng: 34.78, lat: 32.08 };
    const destination = { lng: 34.8, lat: 32.07 };
    const route: DirectRoute = {
      routeId: "1",
      routeShortName: "5",
      routeLongName: null,
      tripId: "t",
      boardStopId: "b",
      boardStopName: "Board",
      boardLng: 34.79,
      boardLat: 32.08,
      alightStopId: "a",
      alightStopName: "Alight",
      alightLng: 34.8,
      alightLat: 32.075,
      planMode: "walk_transit",
    };
    const cafeOnWalk: WalkAmenity = {
      id: "c1",
      name: "Cafe",
      category: "cafe",
      lng: 34.785,
      lat: 32.0802,
    };
    const cafeAtAlight: WalkAmenity = {
      id: "c2",
      name: "Other",
      category: "cafe",
      lng: 34.8,
      lat: 32.0747,
    };
    assert.equal(routeHasWalkAmenity(route, [cafeOnWalk], "cafe", origin, destination), true);
    assert.equal(routeHasWalkAmenity(route, [cafeAtAlight], "cafe", origin, destination), true);
    const both = amenitiesAlongRouteWalks(
      [route],
      [cafeOnWalk, cafeAtAlight],
      "cafe",
      origin,
      destination,
    );
    assert.deepEqual(both.map((a) => a.name).sort(), ["Cafe", "Other"]);
  });

  it("filters a plan down to matching routes", () => {
    const origin = { lng: 34.78, lat: 32.08 };
    const destination = { lng: 34.8, lat: 32.07 };
    const matching: DirectRoute = {
      routeId: "1",
      routeShortName: "5",
      routeLongName: null,
      tripId: "t1",
      boardStopId: "b",
      boardStopName: "Board",
      boardLng: 34.79,
      boardLat: 32.08,
      alightStopId: "a",
      alightStopName: "Alight",
      alightLng: 34.8,
      alightLat: 32.075,
      planMode: "walk_transit",
    };
    const other: DirectRoute = {
      ...matching,
      routeId: "2",
      tripId: "t2",
      boardStopId: "b2",
      boardLng: 34.781,
      boardLat: 32.09,
    };
    const plan = {
      requestId: "r1",
      mode: "walk_transit" as const,
      isochrone: { type: "FeatureCollection" as const, features: [] },
      validStops: [
        {
          stopId: "b",
          name: "Board",
          lng: 34.79,
          lat: 32.08,
          role: "boarding" as const,
        },
        {
          stopId: "b2",
          name: "Other",
          lng: 34.781,
          lat: 32.09,
          role: "boarding" as const,
        },
        {
          stopId: "a",
          name: "Alight",
          lng: 34.8,
          lat: 32.075,
          role: "alighting" as const,
        },
      ],
      routes: [matching, other],
      warnings: [],
      meta: {
        maxWalkingSeconds: 900,
        endpointRadiusMeters: 400,
        isochroneCached: false,
        elapsedMs: 1,
        routeCount: 2,
        validStopCount: 3,
      },
    };
    const amenities: WalkAmenity[] = [
      {
        id: "c1",
        name: "Cafe",
        category: "cafe",
        lng: 34.785,
        lat: 32.0802,
      },
    ];
    const filtered = filterPlanByWalkAmenity(plan, amenities, "cafe", origin, destination);
    assert.equal(filtered?.routes.length, 1);
    assert.equal(filtered?.routes[0]?.routeId, "1");
    assert.deepEqual(
      filtered?.validStops.map((s) => s.stopId).sort(),
      ["a", "b"],
    );
  });
});
