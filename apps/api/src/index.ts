import { buildServer } from "./server.js";
import { env } from "./config.js";

async function main() {
  const app = await buildServer();
  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`API listening on http://${env.HOST}:${env.PORT}`);
  if (env.docsEnabled) {
    app.log.info(`Docs at http://127.0.0.1:${env.PORT}/docs`);
  }
  if (env.HEIGIT_API_KEY === "missing") {
    app.log.warn("HEIGIT_API_KEY is unset; geocoding and isochrones use free fallbacks");
  }
  if (env.NODE_ENV === "production" && env.corsAllowlist.length === 0) {
    app.log.warn("CORS_ORIGINS is empty in production; browser origins are denied");
  }
  if (env.NODE_ENV === "production" && !["127.0.0.1", "localhost", "::1"].includes(env.HOST)) {
    app.log.warn("HOST is not loopback; terminate TLS in front and set HOST=127.0.0.1");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
