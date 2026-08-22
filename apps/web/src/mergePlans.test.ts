import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DirectPlanResponse, DirectRoute, StopDeparturesResponse } from "./api";
import {
  applyResultFilters,
  headwayFromDepartures,
  overlayHeadwaysFromDepartures,
  routeOptionKey,
  WALK_SPEED_MPS,
  type ResultFilters,
} from "./mergePlans";

function stubRoute(over: Partial<DirectRoute> = {}): DirectRoute {
  return {
    routeId: "r1",
    routeShortName: "5",
    routeLongName: "Line 5",
    routeType: 3,
    tripId: "t1",
    boardStopId: "b1",
    boardStopName: "Board",
    boardLng: 34.78,
    boardLat: 32.08,
    alightStopId: "a1",
    alightStopName: "Alight",
    alightLng: 34.79,
    alightLat: 32.08,
    headwaySeconds: 1200,
    frequencyBucket: "about_20",
    planMode: "walk_transit",
    ...over,
  };
}

function stubPlan(routes: DirectRoute[]): DirectPlanResponse {
  return {
    requestId: "req",
    mode: "walk_transit",
    isochrone: { type: "FeatureCollection", features: [] },
    validStops: [
      {
        stopId: "b1",
        name: "Board",
        lng: 34.78,
        lat: 32.08,
        role: "boarding",
        routeShortNames: ["5"],
        headwaySeconds: 1200,
        frequencyBucket: "about_20",
        routeFrequencies: [
          {
            routeShortName: "5",
            headwaySeconds: 1200,
            frequencyBucket: "about_20",
            departureCount: 3,
          },
        ],
      },
    ],
    routes,
    warnings: [],
    meta: {
      maxWalkingSeconds: 900,
      endpointRadiusMeters: 400,
      isochroneCached: false,
      elapsedMs: 1,
      routeCount: routes.length,
      validStopCount: 1,
    },
  };
}

function stubDeps(
  times: number[],
  nowSecs = 8 * 3600,
): StopDeparturesResponse {
  return {
    stopId: "b1",
    alightStopId: "a1",
    routeId: "r1",
    routeShortName: "5",
    timezone: "Asia/Jerusalem",
    nowSecs,
    nextDeparture: times.length
      ? {
          tripId: "t1",
          departureSecs: times[0],
          dayOffset: 0,
          timeLabel: "08:10",
          dayLabel: "Today",
        }
      : null,
    departures: times.map((departureSecs, i) => ({
      tripId: `t${i}`,
      departureSecs,
      dayOffset: 0,
      timeLabel: "08:00",
      dayLabel: "Today" as const,
    })),
  };
}

describe("headwayFromDepartures", () => {
  it("uses window / count for buses in the next hour", () => {
    const now = 8 * 3600;
    const deps = stubDeps(
      [now + 60, now + 10 * 60, now + 20 * 60, now + 30 * 60, now + 40 * 60, now + 50 * 60],
      now,
    );
    assert.equal(headwayFromDepartures(deps), 600);
  });

  it("returns null when nothing is due in the window", () => {
    const now = 8 * 3600;
    assert.equal(headwayFromDepartures(stubDeps([now + 2 * 3600], now)), null);
  });
});

describe("overlayHeadwaysFromDepartures", () => {
  it("rewrites route and stop frequency from fetched departures", () => {
    const route = stubRoute();
    const plan = stubPlan([route]);
    const now = 8 * 3600;
    const overlaid = overlayHeadwaysFromDepartures(plan, {
      [routeOptionKey(route)]: stubDeps(
        [now + 60, now + 6 * 60, now + 12 * 60, now + 18 * 60, now + 24 * 60, now + 30 * 60, now + 36 * 60],
        now,
      ),
    });
    assert.ok(overlaid);
    assert.equal(overlaid!.routes[0].headwaySeconds, 3600 / 7);
    assert.equal(overlaid!.routes[0].frequencyBucket, "about_10");
    assert.equal(overlaid!.validStops[0].headwaySeconds, 3600 / 7);
    assert.equal(overlaid!.validStops[0].frequencyBucket, "about_10");
  });

  it("leaves the plan unchanged when no matching departures were fetched", () => {
    const plan = stubPlan([stubRoute()]);
    assert.equal(overlayHeadwaysFromDepartures(plan, {}), plan);
  });

  it("marks a confirmed empty hour as none, not unknown", () => {
    const route = stubRoute();
    const plan = stubPlan([route]);
    const now = 8 * 3600;
    const overlaid = overlayHeadwaysFromDepartures(plan, {
      [routeOptionKey(route)]: stubDeps([now + 2 * 3600], now),
    });
    assert.ok(overlaid);
    assert.equal(overlaid!.routes[0].headwaySeconds, null);
    assert.equal(overlaid!.routes[0].frequencyBucket, "none");
    assert.equal(overlaid!.validStops[0].headwaySeconds, null);
    assert.equal(overlaid!.validStops[0].frequencyBucket, "none");
    assert.equal(overlaid!.validStops[0].routeFrequencies?.[0]?.frequencyBucket, "none");
  });
});

describe("applyResultFilters", () => {
  const origin = { lng: 34.78, lat: 32.08 };

  function destForWalkMinutes(minutes: number) {
    const meters = minutes * 60 * WALK_SPEED_MPS;
    const deltaLat = meters / ((6371000 * Math.PI) / 180);
    return { lng: origin.lng, lat: origin.lat + deltaLat };
  }

  function routeAtAlight(alight: { lng: number; lat: number }, over: Partial<DirectRoute> = {}) {
    return stubRoute({
      boardLng: origin.lng,
      boardLat: origin.lat,
      alightLng: alight.lng,
      alightLat: alight.lat,
      ...over,
    });
  }

  function baseFilters(
    dest: { lng: number; lat: number },
    over: Partial<ResultFilters> = {},
  ): ResultFilters {
    return {
      enabledModes: ["walk_transit", "transit_walk"],
      includeNearLimitWalk: false,
      origin,
      destination: dest,
      maxWalkingSeconds: 15 * 60,
      maxFrequencyMinutes: "all",
      maxTotalTimeMinutes: "all",
      ...over,
    };
  }

  it("keeps walks under the budget and drops near-limit until enabled", () => {
    const dest = origin;
    const under = destForWalkMinutes(10);
    const near = destForWalkMinutes(14);
    const over = destForWalkMinutes(22);
    const plan = stubPlan([
      routeAtAlight(under, { routeId: "under", routeShortName: "1" }),
      routeAtAlight(near, { routeId: "near", routeShortName: "2" }),
      routeAtAlight(over, { routeId: "over", routeShortName: "3" }),
    ]);

    const strict = applyResultFilters(plan, baseFilters(dest));
    assert.deepEqual(
      strict?.routes.map((r) => r.routeId),
      ["under"],
    );

    const relaxed = applyResultFilters(
      plan,
      baseFilters(dest, { includeNearLimitWalk: true }),
    );
    assert.deepEqual(
      relaxed?.routes.map((r) => r.routeId).sort(),
      ["near", "under"],
    );
  });

  it("does not cap journey time when max is any", () => {
    const dest = origin;
    const longRide = routeAtAlight(origin, {
      routeId: "long",
      rideDurationSeconds: 50 * 60,
    });
    const plan = stubPlan([longRide]);

    const anyTime = applyResultFilters(plan, baseFilters(dest));
    assert.equal(anyTime?.routes.length, 1);

    const capped = applyResultFilters(
      plan,
      baseFilters(dest, { maxTotalTimeMinutes: 30 }),
    );
    assert.equal(capped?.routes.length, 0);
  });
});
