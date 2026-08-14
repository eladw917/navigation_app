import type { FastifyReply, FastifyRequest } from "fastify";

export const DEV_CORS_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
] as const;

export const RATE_LIMIT_GLOBAL = { max: 60, timeWindow: "1 minute" } as const;
export const RATE_LIMIT_PLAN = { max: 20, timeWindow: "1 minute" } as const;
export const RATE_LIMIT_SEARCH = { max: 90, timeWindow: "1 minute" } as const;

const INTERNAL_ERROR_RE =
  /ORS|Pelias|Nominatim|Overpass|ECONN|ECONNREFUSED|ENOTFOUND|password|Authorization|postgres|SQLITE|ENOENT|EACCES|EPERM|stack/i;

export function parseCorsOrigins(raw: string): string[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function resolveCorsAllowlist(input: { corsOrigins: string; nodeEnv: string }): string[] {
  const extra = parseCorsOrigins(input.corsOrigins);
  if (input.nodeEnv === "production") return extra;
  return [...new Set([...DEV_CORS_ORIGINS, ...extra])];
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function resolveDocsEnabled(docsEnabled: boolean | undefined, nodeEnv: string): boolean {
  if (docsEnabled !== undefined) return docsEnabled;
  return nodeEnv !== "production";
}

export function resolveTrustProxy(trustProxy: boolean | undefined, host: string): boolean {
  if (trustProxy !== undefined) return trustProxy;
  return isLoopbackHost(host);
}

export function looksLikeInternalError(message: string): boolean {
  return INTERNAL_ERROR_RE.test(message);
}

export function publicErrorMessage(statusCode: number, message: string): string {
  if (looksLikeInternalError(message)) {
    return statusCode >= 400 && statusCode < 500 ? "Request failed" : "Internal server error";
  }
  if (statusCode >= 500 && statusCode !== 503) return "Internal server error";
  return message;
}

export function caughtStatus(error: unknown, fallback = 502): number {
  const status = (error as { statusCode?: number } | undefined)?.statusCode;
  if (status && status >= 400 && status < 600) return status;
  return fallback;
}

export function sendCaughtError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  logMsg: string,
  extra?: Record<string, unknown>,
): FastifyReply {
  const err = error as Error;
  const status = caughtStatus(error);
  request.log.error({ err, ...extra }, logMsg);
  return reply.status(status).send({
    error: publicErrorMessage(status, err.message || "Request failed"),
    requestId: request.id,
  });
}

export function optionalEnvFlag(raw: string | undefined): boolean | undefined {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}
