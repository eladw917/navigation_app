import { randomUUID } from "node:crypto";
import {
  AppConfigSchema,
  DirectPlanRequestSchema,
  DirectPlanResponseSchema,
  GtfsStatusSchema,
  HealthResponseSchema,
  ISRAEL_BOUNDS,
  PlaceSearchResponseSchema,
  PlanModeSchema,
  StopDeparturesResponseSchema,
  TripPathResponseSchema,
  isInsideIsrael,
} from "@navigation/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../config.js";
import { pool } from "../db.js";
import { RATE_LIMIT_PLAN, RATE_LIMIT_SEARCH, sendCaughtError } from "../httpSecurity.js";
import { getBoardDepartures } from "../services/departures.js";
import { reverseGeocode, searchPlaces } from "../services/geocoder.js";
import { planDirect } from "../services/planner.js";
import { getTripPath, resolveTripPath } from "../services/tripPath.js";

const GtfsId = z.string().min(1).max(128);
const RouteShortName = z.string().min(1).max(32);
const PlaceQuery = z.string().min(1).max(200);

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => {
    let database = false;
    try {
      await pool.query("SELECT 1");
      database = true;
    } catch {
      database = false;
    }
    const body = {
      status: database ? ("ok" as const) : ("degraded" as const),
      database,
      timestamp: new Date().toISOString(),
    };
    HealthResponseSchema.parse(body);
    return body;
  });

  app.get("/v1/config", async () => {
    const feed = await pool.query<{ imported_at: Date }>(
      `SELECT imported_at FROM gtfs_feed_versions WHERE active = true LIMIT 1`,
    );
    const body = {
      israelBounds: ISRAEL_BOUNDS,
      defaultWalkingSeconds: env.DEFAULT_WALKING_SECONDS,
      maxWalkingSeconds: env.MAX_WALKING_SECONDS,
      endpointRadiusMeters: env.ENDPOINT_RADIUS_METERS,
      allowedRouteTypes: env.allowedRouteTypes,
      feedImportedAt: feed.rows[0] ? new Date(feed.rows[0].imported_at).toISOString() : null,
    };
    return AppConfigSchema.parse(body);
  });

  app.get("/v1/gtfs/status", async () => {
    const feed = await pool.query<{
      id: string;
      source_url: string;
      source_sha256: string;
      imported_at: Date;
      stop_count: number | null;
      route_count: number | null;
      trip_count: number | null;
      stop_time_count: number | null;
      validation_notes: string | null;
    }>(
      `SELECT id, source_url, source_sha256, imported_at, stop_count, route_count, trip_count, stop_time_count, validation_notes
       FROM gtfs_feed_versions WHERE active = true LIMIT 1`,
    );
    const active = feed.rows[0]
      ? {
          id: feed.rows[0].id,
          sourceUrl: feed.rows[0].source_url,
          sourceSha256: feed.rows[0].source_sha256,
          importedAt: new Date(feed.rows[0].imported_at).toISOString(),
          stopCount: feed.rows[0].stop_count,
          routeCount: feed.rows[0].route_count,
          tripCount: feed.rows[0].trip_count,
          stopTimeCount: feed.rows[0].stop_time_count,
          validationNotes: feed.rows[0].validation_notes,
        }
      : null;
    return GtfsStatusSchema.parse({ active, hasActiveFeed: Boolean(active) });
  });

  app.get(
    "/v1/places/search",
    {
      config: { rateLimit: RATE_LIMIT_SEARCH },
      schema: {
        querystring: z.object({
          q: PlaceQuery,
          limit: z.coerce.number().int().min(1).max(10).default(5),
        }),
      },
    },
    async (request) => {
      const { q, limit } = request.query as { q: string; limit: number };
      const controller = new AbortController();
      const onAborted = () => controller.abort();
      // Prefer "aborted" — "close" can fire for finished GETs and cancel in-flight geocoding.
      request.raw.on("aborted", onAborted);
      try {
        const results = await searchPlaces(q, limit, controller.signal);
        return PlaceSearchResponseSchema.parse({ results });
      } finally {
        request.raw.off("aborted", onAborted);
      }
    },
  );

  app.get(
    "/v1/places/reverse",
    {
      config: { rateLimit: RATE_LIMIT_SEARCH },
      schema: {
        querystring: z.object({
          lng: z.coerce.number(),
          lat: z.coerce.number(),
        }),
      },
    },
    async (request, reply) => {
      const { lng, lat } = request.query as { lng: number; lat: number };
      if (!isInsideIsrael({ lng, lat })) {
        return reply.status(400).send({ error: "Coordinates must be inside Israel bounds" });
      }
      const results = await reverseGeocode(lng, lat);
      return PlaceSearchResponseSchema.parse({ results });
    },
  );

  app.post(
    "/v1/plans/direct",
    {
      config: { rateLimit: RATE_LIMIT_PLAN },
      schema: {
        body: DirectPlanRequestSchema,
      },
    },
    async (request, reply) => {
      const body = DirectPlanRequestSchema.parse(request.body);
      if (!isInsideIsrael(body.origin) || !isInsideIsrael(body.destination)) {
        return reply.status(400).send({
          error: "Origin and destination must be inside Israel bounds",
          bounds: ISRAEL_BOUNDS,
        });
      }
      if (body.maxWalkingSeconds > env.MAX_WALKING_SECONDS) {
        return reply.status(400).send({
          error: `maxWalkingSeconds must be <= ${env.MAX_WALKING_SECONDS}`,
        });
      }

      try {
        const planned = await planDirect(body);
        const response = DirectPlanResponseSchema.parse({
          requestId: randomUUID(),
          ...planned,
        });
        return response;
      } catch (error) {
        return sendCaughtError(request, reply, error, "direct plan failed", {
          mode: body.mode,
          maxWalkingSeconds: body.maxWalkingSeconds,
        });
      }
    },
  );

  app.get(
    "/v1/departures",
    {
      schema: {
        querystring: z.object({
          stopId: GtfsId,
          alightStopId: GtfsId,
          routeShortName: RouteShortName,
          routeId: z.string().max(128).optional(),
        }),
      },
    },
    async (request, reply) => {
      const query = request.query as {
        stopId: string;
        alightStopId: string;
        routeShortName: string;
        routeId?: string;
      };
      try {
        const body = await getBoardDepartures({
          stopId: query.stopId,
          alightStopId: query.alightStopId,
          routeShortName: query.routeShortName,
          routeId: query.routeId,
        });
        return StopDeparturesResponseSchema.parse(body);
      } catch (error) {
        return sendCaughtError(request, reply, error, "departures failed", query);
      }
    },
  );

  app.get(
    "/v1/trips/:tripId/path",
    {
      schema: {
        params: z.object({ tripId: GtfsId }),
        querystring: z.object({
          boardStopId: GtfsId,
          alightStopId: GtfsId,
        }),
      },
    },
    async (request, reply) => {
      const { tripId } = request.params as { tripId: string };
      const { boardStopId, alightStopId } = request.query as {
        boardStopId: string;
        alightStopId: string;
      };
      try {
        const path = await getTripPath(tripId, boardStopId, alightStopId);
        return TripPathResponseSchema.parse(path);
      } catch (error) {
        return sendCaughtError(request, reply, error, "trip path failed", {
          tripId,
          boardStopId,
          alightStopId,
        });
      }
    },
  );

  app.get(
    "/v1/trips/resolve-path",
    {
      schema: {
        querystring: z.object({
          routeShortName: RouteShortName,
          stopId: GtfsId,
          mode: PlanModeSchema,
          endpointLng: z.coerce.number(),
          endpointLat: z.coerce.number(),
        }),
      },
    },
    async (request, reply) => {
      const query = request.query as {
        routeShortName: string;
        stopId: string;
        mode: "walk_transit" | "transit_walk";
        endpointLng: number;
        endpointLat: number;
      };
      if (!isInsideIsrael({ lng: query.endpointLng, lat: query.endpointLat })) {
        return reply.status(400).send({ error: "Endpoint must be inside Israel bounds" });
      }
      try {
        const path = await resolveTripPath({
          routeShortName: query.routeShortName,
          stopId: query.stopId,
          mode: query.mode,
          endpointLng: query.endpointLng,
          endpointLat: query.endpointLat,
        });
        return TripPathResponseSchema.parse(path);
      } catch (error) {
        return sendCaughtError(request, reply, error, "resolve trip path failed", query);
      }
    },
  );
}
