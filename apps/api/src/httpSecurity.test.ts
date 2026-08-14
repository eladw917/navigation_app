import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  caughtStatus,
  parseCorsOrigins,
  publicErrorMessage,
  resolveCorsAllowlist,
  resolveDocsEnabled,
  resolveTrustProxy,
} from "./httpSecurity.js";

describe("httpSecurity", () => {
  it("parses comma-separated CORS origins", () => {
    assert.deepEqual(parseCorsOrigins(" https://app.pages.dev, http://localhost:5173 "), [
      "https://app.pages.dev",
      "http://localhost:5173",
    ]);
  });

  it("allows localhost in development and only explicit origins in production", () => {
    assert.ok(
      resolveCorsAllowlist({ corsOrigins: "", nodeEnv: "development" }).includes(
        "http://localhost:5173",
      ),
    );
    assert.deepEqual(
      resolveCorsAllowlist({ corsOrigins: "https://app.pages.dev", nodeEnv: "production" }),
      ["https://app.pages.dev"],
    );
    assert.deepEqual(resolveCorsAllowlist({ corsOrigins: "", nodeEnv: "production" }), []);
  });

  it("hides upstream and database details from 5xx bodies", () => {
    assert.equal(
      publicErrorMessage(502, "ORS isochrone failed (403): {\"error\":\"Invalid API key\"}"),
      "Internal server error",
    );
    assert.equal(
      publicErrorMessage(500, "password authentication failed for user \"navigation\""),
      "Internal server error",
    );
    assert.equal(publicErrorMessage(400, "Coordinates must be inside Israel bounds"), "Coordinates must be inside Israel bounds");
    assert.equal(publicErrorMessage(503, "No active GTFS feed imported"), "No active GTFS feed imported");
    assert.equal(publicErrorMessage(404, "No direct trip found for bus 5 at this stop"), "No direct trip found for bus 5 at this stop");
  });

  it("preserves 4xx/503 status codes from thrown errors", () => {
    assert.equal(caughtStatus({ statusCode: 404 }), 404);
    assert.equal(caughtStatus({ statusCode: 503 }), 503);
    assert.equal(caughtStatus(new Error("boom")), 502);
  });

  it("disables docs in production unless explicitly enabled", () => {
    assert.equal(resolveDocsEnabled(undefined, "production"), false);
    assert.equal(resolveDocsEnabled(undefined, "development"), true);
    assert.equal(resolveDocsEnabled(true, "production"), true);
  });

  it("trusts proxy on loopback by default", () => {
    assert.equal(resolveTrustProxy(undefined, "127.0.0.1"), true);
    assert.equal(resolveTrustProxy(undefined, "0.0.0.0"), false);
    assert.equal(resolveTrustProxy(true, "0.0.0.0"), true);
  });
});
