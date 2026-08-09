import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { importGtfs } from "./importGtfs.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
loadEnv({ path: path.join(root, ".env") });

function usage(): never {
  console.error(`Usage: gtfs-import [options]

Options:
  --fixture              Import tests/fixtures/gtfs/fixture.zip
  --zip <path>           Import a local zip (kept on disk; staging extract still cleaned)
  --keep-work            Keep data/gtfs/work (zip + extracted txts) after import
  --keep-versions <n>    Inactive feed versions to retain (default 0)
  --no-activate          Load feed without marking it active

Postgres is the source of truth. Staging under data/gtfs/work is disposable.
`);
  process.exit(1);
}

function readFlagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith("--")) usage();
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) usage();

  const fixture = args.includes("--fixture");
  const zipFromFlag = readFlagValue(args, "--zip");
  const zipPath = zipFromFlag
    ? path.resolve(zipFromFlag)
    : fixture
      ? path.join(root, "tests/fixtures/gtfs/fixture.zip")
      : undefined;

  const keepVersionsRaw = readFlagValue(args, "--keep-versions");
  const keepInactiveVersions = keepVersionsRaw != null ? Number(keepVersionsRaw) : 0;
  if (!Number.isInteger(keepInactiveVersions) || keepInactiveVersions < 0) {
    throw new Error("--keep-versions must be a non-negative integer");
  }

  const databaseUrl = process.env.DATABASE_URL ?? "postgres://localhost:5432/navigation";
  const sourceUrl =
    process.env.GTFS_SOURCE_URL ??
    "https://gtfs.mot.gov.il/gtfsfiles/israel-public-transportation.zip";

  const result = await importGtfs({
    databaseUrl,
    sourceUrl: fixture ? `fixture://${zipPath}` : sourceUrl,
    zipPath,
    workDir: path.join(root, "data/gtfs/work"),
    keepWork: args.includes("--keep-work"),
    keepInactiveVersions,
    activate: !args.includes("--no-activate"),
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
