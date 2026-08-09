import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
loadEnv({ path: path.join(root, ".env") });

const EnvSchema = z.object({
  DATABASE_URL: z.string().default("postgres://localhost:5432/navigation"),
  PORT: z.coerce.number().default(3010),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),
  HEIGIT_API_KEY: z.string().default("missing"),
  HEIGIT_ORS_BASE_URL: z.string().url().default("https://api.heigit.org/openrouteservice"),
  HEIGIT_PELIAS_BASE_URL: z.string().url().default("https://api.heigit.org/pelias/v1"),
  DEFAULT_WALKING_SECONDS: z.coerce.number().default(900),
  MAX_WALKING_SECONDS: z.coerce.number().default(1800),
  ENDPOINT_RADIUS_METERS: z.coerce.number().default(500),
  PLAN_RESULT_LIMIT: z.coerce.number().default(200),
  ALLOWED_ROUTE_TYPES: z.string().default("3"),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error(parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration");
}

export const env = {
  ...parsed.data,
  allowedRouteTypes: parsed.data.ALLOWED_ROUTE_TYPES.split(",")
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isFinite(n)),
  root,
};
