import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { env } from "./config.js";
import { buildServer } from "./server.js";

describe("API security headers and CORS", () => {
  it("does not reflect arbitrary Origin and sets security headers", async () => {
    const app = await buildServer();
    try {
      const denied = await app.inject({
        method: "GET",
        url: "/health",
        headers: { origin: "https://evil.example" },
      });
      assert.notEqual(denied.headers["access-control-allow-origin"], "https://evil.example");
      assert.equal(denied.headers["x-content-type-options"], "nosniff");
    } finally {
      await app.close();
    }
  });

  it("allows the local Vite origin outside production", { skip: env.NODE_ENV === "production" }, async () => {
    const app = await buildServer();
    try {
      const allowed = await app.inject({
        method: "GET",
        url: "/health",
        headers: { origin: "http://localhost:5173" },
      });
      assert.equal(allowed.headers["access-control-allow-origin"], "http://localhost:5173");
    } finally {
      await app.close();
    }
  });

  it("rejects walk-route queries outside Israel", async () => {
    const app = await buildServer();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/walk-route?fromLng=2&fromLat=40&toLng=2.01&toLat=40.01",
      });
      assert.equal(response.statusCode, 400);
    } finally {
      await app.close();
    }
  });

  it("rejects walk-amenity queries outside Israel", async () => {
    const app = await buildServer();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/walk-amenities?south=40&west=2&north=40.02&east=2.02",
      });
      assert.equal(response.statusCode, 400);
    } finally {
      await app.close();
    }
  });

  it("rejects oversized place queries", async () => {
    const app = await buildServer();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/places/search?q=${"a".repeat(201)}`,
      });
      assert.equal(response.statusCode, 400);
    } finally {
      await app.close();
    }
  });

  it("rejects invalid leave-at timestamps on departures", async () => {
    const app = await buildServer();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/departures?stopId=1&alightStopId=2&routeShortName=5&at=not-a-date",
      });
      assert.equal(response.statusCode, 400);
    } finally {
      await app.close();
    }
  });
});
