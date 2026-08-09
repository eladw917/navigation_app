import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { importGtfs } from "./importGtfs.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
loadEnv({ path: path.join(root, ".env") });

async function main() {
  const args = process.argv.slice(2);
  const fixture = args.includes("--fixture");
  const zipArgIndex = args.indexOf("--zip");
  const zipPath =
    zipArgIndex >= 0
      ? path.resolve(args[zipArgIndex + 1]!)
      : fixture
        ? path.join(root, "tests/fixtures/gtfs/fixture.zip")
        : undefined;

  const databaseUrl = process.env.DATABASE_URL ?? "postgres://localhost:5432/navigation";
  const sourceUrl =
    process.env.GTFS_SOURCE_URL ??
    "https://gtfs.mot.gov.il/gtfsfiles/israel-public-transportation.zip";

  const result = await importGtfs({
    databaseUrl,
    sourceUrl: fixture ? `fixture://${zipPath}` : sourceUrl,
    zipPath,
    workDir: path.join(root, "data/gtfs/work"),
  });

  console.log(
    JSON.stringify(
      {
        feedVersionId: result.feedVersionId,
        sha256: result.sha256,
        reused: result.reused,
        counts: result.counts,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
