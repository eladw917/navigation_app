import { buildServer } from "./server.js";
import { env } from "./config.js";

async function main() {
  const app = await buildServer();
  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`API listening on http://${env.HOST}:${env.PORT}`);
  app.log.info(`Docs at http://localhost:${env.PORT}/docs`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
