import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { env } from "./config.js";
import {
  publicErrorMessage,
  RATE_LIMIT_GLOBAL,
} from "./httpSecurity.js";
import { registerRoutes } from "./routes/index.js";

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
    },
    trustProxy: env.trustProxy,
    requestIdHeader: "x-request-id",
    genReqId: () => crypto.randomUUID(),
    bodyLimit: 1_048_576,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: env.docsEnabled ? false : undefined,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  });

  const allowlist = env.corsAllowlist;
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) {
        cb(null, true);
        return;
      }
      cb(null, allowlist.includes(origin));
    },
    credentials: false,
  });
  await app.register(rateLimit, {
    max: RATE_LIMIT_GLOBAL.max,
    timeWindow: RATE_LIMIT_GLOBAL.timeWindow,
    allowList: (request) => request.url.split("?")[0] === "/health",
  });

  if (env.docsEnabled) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: "Israeli Walk + Transit API",
          description: "Phase 1.0 direct walk+transit planner using static Israeli GTFS and ORS isochrones",
          version: "0.1.0",
        },
      },
    });
    await app.register(swaggerUi, {
      routePrefix: "/docs",
    });
    app.get("/openapi.json", async () => app.swagger());
  }

  await registerRoutes(app);

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    const err = error as { statusCode?: number; message: string };
    const statusCode = err.statusCode ?? 500;
    reply.status(statusCode).send({
      error: publicErrorMessage(statusCode, err.message),
      requestId: request.id,
    });
  });

  return app;
}
