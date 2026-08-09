import assert from "node:assert/strict";
import { describe, it } from "node:test";
import pg from "pg";
import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
loadEnv({ path: path.join(root, ".env") });

describe("direct route SQL integration", () => {
  it("runs walk_transit query against the active feed", async () => {
    const client = new pg.Client({
      connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/navigation",
    });
    await client.connect();
    try {
      const feed = await client.query(`SELECT id, stop_count FROM gtfs_feed_versions WHERE active = true`);
      assert.ok(feed.rows[0], "expected an active GTFS feed");

      const sql = await readFile(
        path.join(root, "apps/api/src/repositories/directRoutes.sql"),
        "utf8",
      );

      // ~15 min walking circle approximation around Dizengoff, Tel Aviv
      const polygon = {
        type: "Polygon",
        coordinates: [
          [
            [34.7700, 32.0750],
            [34.7950, 32.0750],
            [34.7950, 32.0950],
            [34.7700, 32.0950],
            [34.7700, 32.0750],
          ],
        ],
      };

      const result = await client.query(sql, [
        JSON.stringify(polygon),
        34.7700,
        32.0650,
        500,
        "walk_transit",
        [3],
        50,
      ]);

      // Full Israel feed should yield at least one direct option in central TLV.
      // Fixture-only environments may return 0 or 1 depending on coverage.
      assert.ok(Array.isArray(result.rows));
      if (Number(feed.rows[0].stop_count) > 100) {
        assert.ok(result.rows.length > 0, "expected routes on the full Israel feed");
        assert.ok(result.rows[0].board_stop_id);
        assert.ok(result.rows[0].alight_stop_id);
        assert.notEqual(result.rows[0].board_stop_id, result.rows[0].alight_stop_id);
      }
    } finally {
      await client.end();
    }
  });
});
