import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { parse } from "csv-parse";
import pg from "pg";
import unzipper from "unzipper";
import { isValidCoordinate, parseGtfsTimeToSeconds, requireField, toOptionalInt } from "./parse.js";

const { Client } = pg;

export type ImportOptions = {
  databaseUrl: string;
  sourceUrl: string;
  zipPath?: string;
  workDir?: string;
  activate?: boolean;
  /** Keep downloaded zip + extracted txts (default false — Postgres is the store). */
  keepWork?: boolean;
  /** Inactive feed versions to retain after activate (default 0). */
  keepInactiveVersions?: number;
};

export type Counts = {
  stops: number;
  routes: number;
  trips: number;
  stopTimes: number;
  agencies: number;
  calendar: number;
  calendarDates: number;
};

function parseDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function downloadZip(url: string, dest: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download GTFS: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(dest, buffer);
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  await pipeline(createReadStream(zipPath), unzipper.Extract({ path: destDir }));
}

async function* readCsvRows(filePath: string): AsyncGenerator<Record<string, string>> {
  if (!existsSync(filePath)) return;
  const parser = createReadStream(filePath).pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      quote: '"',
      escape: '"',
      trim: true,
      bom: true,
    }),
  );
  for await (const row of parser) {
    yield row as Record<string, string>;
  }
}

async function streamInsert(
  client: pg.Client,
  sqlPrefix: string,
  rowSource: AsyncIterable<unknown[]>,
  buildRow: (row: unknown[], startIndex: number) => { sql: string; nextIndex: number; values: unknown[] },
  batchSize = 1000,
): Promise<number> {
  let count = 0;
  let batch: unknown[][] = [];

  const flush = async () => {
    if (!batch.length) return;
    const values: unknown[] = [];
    const parts: string[] = [];
    let i = 1;
    for (const row of batch) {
      const built = buildRow(row, i);
      parts.push(built.sql);
      values.push(...built.values);
      i = built.nextIndex;
    }
    await client.query(`${sqlPrefix} VALUES ${parts.join(",")}`, values);
    count += batch.length;
    batch = [];
  };

  for await (const row of rowSource) {
    batch.push(row);
    if (batch.length >= batchSize) await flush();
  }
  await flush();
  return count;
}

function simplePlaceholders(columnCount: number, startIndex: number): { sql: string; nextIndex: number } {
  const placeholders: string[] = [];
  let i = startIndex;
  for (let c = 0; c < columnCount; c++) {
    placeholders.push(`$${i++}`);
  }
  return { sql: `(${placeholders.join(",")})`, nextIndex: i };
}

/** Staging files are disposable; the active feed in Postgres is the source of truth. */
function cleanupStaging(workDir: string, zipPath: string, options: {
  keepWork: boolean;
  preserveUserZip: boolean;
}): void {
  if (options.keepWork) return;
  rmSync(path.join(workDir, "extracted"), { recursive: true, force: true });
  if (!options.preserveUserZip) {
    rmSync(zipPath, { force: true });
  }
}

async function pruneInactiveFeeds(client: pg.Client, keepInactive: number): Promise<number> {
  const keep = Math.max(0, keepInactive);
  const result = await client.query(
    `WITH doomed AS (
       SELECT id
       FROM gtfs_feed_versions
       WHERE active = false
       ORDER BY imported_at DESC NULLS LAST, id
       OFFSET $1
     )
     DELETE FROM gtfs_feed_versions g
     USING doomed d
     WHERE g.id = d.id
     RETURNING g.id`,
    [keep],
  );
  return result.rowCount ?? 0;
}

export async function importGtfs(
  options: ImportOptions,
): Promise<{ feedVersionId: string; counts: Counts; sha256: string; reused: boolean }> {
  const workDir = options.workDir ?? path.resolve("data/gtfs/work");
  mkdirSync(workDir, { recursive: true });
  const preserveUserZip = Boolean(options.zipPath);
  const zipPath = options.zipPath ?? path.join(workDir, "feed.zip");
  const extractDir = path.join(workDir, "extracted");
  const keepWork = options.keepWork === true;
  const keepInactiveVersions = options.keepInactiveVersions ?? 0;

  if (options.zipPath) {
    if (!existsSync(zipPath)) throw new Error(`Zip not found: ${zipPath}`);
  } else {
    console.log(`Downloading ${options.sourceUrl}`);
    await downloadZip(options.sourceUrl, zipPath);
  }

  const sha256 = await sha256File(zipPath);

  const client = new Client({ connectionString: options.databaseUrl });
  await client.connect();

  try {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM gtfs_feed_versions WHERE source_sha256 = $1`,
      [sha256],
    );
    if (existing.rows[0]) {
      if (options.activate !== false) {
        await client.query("BEGIN");
        await client.query(`UPDATE gtfs_feed_versions SET active = false WHERE active = true`);
        await client.query(`UPDATE gtfs_feed_versions SET active = true WHERE id = $1`, [existing.rows[0].id]);
        await client.query("COMMIT");
      }
      const pruned = await pruneInactiveFeeds(client, keepInactiveVersions);
      if (pruned > 0) console.log(`Pruned ${pruned} inactive feed version(s)`);
      cleanupStaging(workDir, zipPath, { keepWork, preserveUserZip });
      return {
        feedVersionId: existing.rows[0].id,
        sha256,
        reused: true,
        counts: { stops: 0, routes: 0, trips: 0, stopTimes: 0, agencies: 0, calendar: 0, calendarDates: 0 },
      };
    }

    rmSync(extractDir, { recursive: true, force: true });
    console.log("Extracting zip...");
    await extractZip(zipPath, extractDir);

    await client.query("BEGIN");
    // Speed up bulk load inside the transaction
    await client.query("SET LOCAL synchronous_commit TO OFF");
    await client.query("SET LOCAL session_replication_role = replica");

    const versionRes = await client.query<{ id: string }>(
      `INSERT INTO gtfs_feed_versions (source_url, source_sha256, active)
       VALUES ($1, $2, false)
       RETURNING id`,
      [options.sourceUrl, sha256],
    );
    const feedVersionId = versionRes.rows[0]!.id;
    const counts: Counts = {
      stops: 0,
      routes: 0,
      trips: 0,
      stopTimes: 0,
      agencies: 0,
      calendar: 0,
      calendarDates: 0,
    };

    console.log("Importing agency...");
    counts.agencies = await streamInsert(
      client,
      `INSERT INTO gtfs_agency (
        feed_version_id, agency_id, agency_name, agency_url, agency_timezone, agency_lang, agency_phone
      )`,
      (async function* () {
        for await (const row of readCsvRows(path.join(extractDir, "agency.txt"))) {
          yield [
            feedVersionId,
            row.agency_id || "default",
            requireField(row, "agency_name"),
            row.agency_url ?? null,
            row.agency_timezone ?? null,
            row.agency_lang ?? null,
            row.agency_phone ?? null,
          ];
        }
      })(),
      (row, start) => {
        const p = simplePlaceholders(row.length, start);
        return { sql: p.sql, nextIndex: p.nextIndex, values: row };
      },
    );

    console.log("Importing stops...");
    counts.stops = await streamInsert(
      client,
      `INSERT INTO gtfs_stops (
        feed_version_id, stop_id, stop_code, stop_name, stop_desc, stop_lat, stop_lon, geom,
        location_type, parent_station, wheelchair_boarding
      )`,
      (async function* () {
        for await (const row of readCsvRows(path.join(extractDir, "stops.txt"))) {
          const lat = Number(requireField(row, "stop_lat"));
          const lon = Number(requireField(row, "stop_lon"));
          if (!isValidCoordinate(lat, lon)) {
            throw new Error(`Invalid stop coordinates for ${row.stop_id}`);
          }
          yield [
            feedVersionId,
            requireField(row, "stop_id"),
            row.stop_code ?? null,
            requireField(row, "stop_name"),
            row.stop_desc ?? null,
            lat,
            lon,
            lon,
            lat,
            toOptionalInt(row.location_type) ?? 0,
            row.parent_station || null,
            toOptionalInt(row.wheelchair_boarding),
          ];
        }
      })(),
      (row, start) => {
        let i = start;
        const sql = `($${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},ST_SetSRID(ST_MakePoint($${i++},$${i++}),4326),$${i++},$${i++},$${i++})`;
        return { sql, nextIndex: i, values: row };
      },
      500,
    );
    console.log(`  stops=${counts.stops}`);

    console.log("Importing routes...");
    counts.routes = await streamInsert(
      client,
      `INSERT INTO gtfs_routes (
        feed_version_id, route_id, agency_id, route_short_name, route_long_name,
        route_desc, route_type, route_color, route_text_color
      )`,
      (async function* () {
        for await (const row of readCsvRows(path.join(extractDir, "routes.txt"))) {
          yield [
            feedVersionId,
            requireField(row, "route_id"),
            row.agency_id || null,
            row.route_short_name || null,
            row.route_long_name || null,
            row.route_desc || null,
            Number(requireField(row, "route_type")),
            row.route_color || null,
            row.route_text_color || null,
          ];
        }
      })(),
      (row, start) => {
        const p = simplePlaceholders(row.length, start);
        return { sql: p.sql, nextIndex: p.nextIndex, values: row };
      },
    );

    console.log("Importing calendar...");
    counts.calendar = await streamInsert(
      client,
      `INSERT INTO gtfs_calendar (
        feed_version_id, service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date
      )`,
      (async function* () {
        for await (const row of readCsvRows(path.join(extractDir, "calendar.txt"))) {
          yield [
            feedVersionId,
            requireField(row, "service_id"),
            Number(requireField(row, "monday")),
            Number(requireField(row, "tuesday")),
            Number(requireField(row, "wednesday")),
            Number(requireField(row, "thursday")),
            Number(requireField(row, "friday")),
            Number(requireField(row, "saturday")),
            Number(requireField(row, "sunday")),
            parseDate(requireField(row, "start_date")),
            parseDate(requireField(row, "end_date")),
          ];
        }
      })(),
      (row, start) => {
        const p = simplePlaceholders(row.length, start);
        return { sql: p.sql, nextIndex: p.nextIndex, values: row };
      },
    );

    console.log("Importing calendar_dates...");
    counts.calendarDates = await streamInsert(
      client,
      `INSERT INTO gtfs_calendar_dates (feed_version_id, service_id, date, exception_type)`,
      (async function* () {
        for await (const row of readCsvRows(path.join(extractDir, "calendar_dates.txt"))) {
          yield [
            feedVersionId,
            requireField(row, "service_id"),
            parseDate(requireField(row, "date")),
            Number(requireField(row, "exception_type")),
          ];
        }
      })(),
      (row, start) => {
        const p = simplePlaceholders(row.length, start);
        return { sql: p.sql, nextIndex: p.nextIndex, values: row };
      },
    );

    console.log("Importing trips...");
    counts.trips = await streamInsert(
      client,
      `INSERT INTO gtfs_trips (
        feed_version_id, trip_id, route_id, service_id, trip_headsign, direction_id, block_id, shape_id, wheelchair_accessible
      )`,
      (async function* () {
        for await (const row of readCsvRows(path.join(extractDir, "trips.txt"))) {
          yield [
            feedVersionId,
            requireField(row, "trip_id"),
            requireField(row, "route_id"),
            requireField(row, "service_id"),
            row.trip_headsign || null,
            toOptionalInt(row.direction_id),
            row.block_id || null,
            row.shape_id || null,
            toOptionalInt(row.wheelchair_accessible),
          ];
        }
      })(),
      (row, start) => {
        const p = simplePlaceholders(row.length, start);
        return { sql: p.sql, nextIndex: p.nextIndex, values: row };
      },
      500,
    );
    console.log(`  trips=${counts.trips}`);

    // Defer FK checks for stop_times bulk load by temporarily dropping FK is heavy;
    // instead insert in larger batches. Indexes already exist from migrations.
    console.log("Importing stop_times (this can take several minutes)...");
    counts.stopTimes = await streamInsert(
      client,
      `INSERT INTO gtfs_stop_times (
        feed_version_id, trip_id, stop_id, stop_sequence, arrival_secs, departure_secs, pickup_type, drop_off_type, timepoint
      )`,
      (async function* () {
        let n = 0;
        for await (const row of readCsvRows(path.join(extractDir, "stop_times.txt"))) {
          yield [
            feedVersionId,
            requireField(row, "trip_id"),
            requireField(row, "stop_id"),
            Number(requireField(row, "stop_sequence")),
            parseGtfsTimeToSeconds(row.arrival_time),
            parseGtfsTimeToSeconds(row.departure_time),
            toOptionalInt(row.pickup_type) ?? 0,
            toOptionalInt(row.drop_off_type) ?? 0,
            toOptionalInt(row.timepoint),
          ];
          n += 1;
          if (n % 100000 === 0) console.log(`  stop_times progress ~${n}`);
        }
      })(),
      (row, start) => {
        const p = simplePlaceholders(row.length, start);
        return { sql: p.sql, nextIndex: p.nextIndex, values: row };
      },
      2000,
    );
    console.log(`  stop_times=${counts.stopTimes}`);

    const notes = `Imported agencies=${counts.agencies} stops=${counts.stops} routes=${counts.routes} trips=${counts.trips} stop_times=${counts.stopTimes}`;
    await client.query(
      `UPDATE gtfs_feed_versions
       SET stop_count = $2, route_count = $3, trip_count = $4, stop_time_count = $5, validation_notes = $6
       WHERE id = $1`,
      [feedVersionId, counts.stops, counts.routes, counts.trips, counts.stopTimes, notes],
    );

    if (options.activate !== false) {
      await client.query(`UPDATE gtfs_feed_versions SET active = false WHERE active = true`);
      await client.query(`UPDATE gtfs_feed_versions SET active = true WHERE id = $1`, [feedVersionId]);
    }

    await client.query("COMMIT");
    console.log("Analyzing tables...");
    await client.query("ANALYZE gtfs_stops");
    await client.query("ANALYZE gtfs_stop_times");
    await client.query("ANALYZE gtfs_trips");
    await client.query("ANALYZE gtfs_routes");

    const pruned = await pruneInactiveFeeds(client, keepInactiveVersions);
    if (pruned > 0) console.log(`Pruned ${pruned} inactive feed version(s)`);

    console.log(notes);
    cleanupStaging(workDir, zipPath, { keepWork, preserveUserZip });
    return { feedVersionId, counts, sha256, reused: false };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore
    }
    throw error;
  } finally {
    await client.end();
  }
}
