WITH active_feed AS (
  SELECT id, imported_at, source_sha256
  FROM gtfs_feed_versions
  WHERE active = true
  LIMIT 1
),
area AS (
  SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS geom
),
endpoint AS (
  SELECT ST_SetSRID(ST_MakePoint($2, $3), 4326) AS geom
),
-- Keep the small spatial stop sets fixed. Inlining them lets PostgreSQL choose a
-- nested-loop plan that repeats spatial filtering while joining stop_times.
boarding AS MATERIALIZED (
  SELECT s.feed_version_id, s.stop_id, s.stop_name, s.geom
  FROM gtfs_stops s, active_feed f, area a, endpoint e
  WHERE s.feed_version_id = f.id
    AND COALESCE(s.location_type, 0) = 0
    AND CASE WHEN $5 = 'walk_transit'
      THEN ST_Covers(a.geom, s.geom)
      ELSE ST_DWithin(s.geom::geography, e.geom::geography, $4)
    END
),
alighting AS MATERIALIZED (
  SELECT s.feed_version_id, s.stop_id, s.stop_name, s.geom
  FROM gtfs_stops s, active_feed f, area a, endpoint e
  WHERE s.feed_version_id = f.id
    AND COALESCE(s.location_type, 0) = 0
    AND CASE WHEN $5 = 'transit_walk'
      THEN ST_Covers(a.geom, s.geom)
      ELSE ST_DWithin(s.geom::geography, e.geom::geography, $4)
    END
),
connections AS (
  SELECT
    st1.feed_version_id,
    st1.trip_id,
    st1.stop_id AS board_stop_id,
    st2.stop_id AS alight_stop_id,
    st1.stop_sequence AS board_sequence,
    st2.stop_sequence AS alight_sequence,
    COALESCE(st1.departure_secs, st1.arrival_secs) AS board_secs,
    COALESCE(st2.arrival_secs, st2.departure_secs) AS alight_secs
  FROM boarding b
  JOIN gtfs_stop_times st1
    ON st1.feed_version_id = b.feed_version_id
   AND st1.stop_id = b.stop_id
  JOIN gtfs_stop_times st2
    ON st2.feed_version_id = st1.feed_version_id
   AND st2.trip_id = st1.trip_id
   AND st2.stop_sequence > st1.stop_sequence
  JOIN alighting a
    ON a.feed_version_id = st2.feed_version_id
   AND a.stop_id = st2.stop_id
  WHERE COALESCE(st1.pickup_type, 0) <> 1
    AND COALESCE(st2.drop_off_type, 0) <> 1
)
SELECT * FROM (
SELECT DISTINCT ON (r.route_id, c.board_stop_id, c.alight_stop_id)
  r.route_id,
  r.route_short_name,
  r.route_long_name,
  r.route_type,
  t.direction_id,
  t.trip_headsign,
  c.trip_id,
  c.board_stop_id,
  bs.stop_name AS board_stop_name,
  ST_X(bs.geom) AS board_lng,
  ST_Y(bs.geom) AS board_lat,
  c.alight_stop_id,
  als.stop_name AS alight_stop_name,
  ST_X(als.geom) AS alight_lng,
  ST_Y(als.geom) AS alight_lat,
  CASE
    WHEN c.board_secs IS NULL OR c.alight_secs IS NULL THEN NULL
    ELSE GREATEST(0, c.alight_secs - c.board_secs)
  END AS ride_duration_seconds,
  f.id AS feed_version_id,
  f.imported_at,
  f.source_sha256
FROM connections c
JOIN active_feed f ON true
JOIN gtfs_trips t
  ON t.feed_version_id = c.feed_version_id
 AND t.trip_id = c.trip_id
JOIN gtfs_routes r
  ON r.feed_version_id = t.feed_version_id
 AND r.route_id = t.route_id
JOIN gtfs_stops bs
  ON bs.feed_version_id = c.feed_version_id
 AND bs.stop_id = c.board_stop_id
JOIN gtfs_stops als
  ON als.feed_version_id = c.feed_version_id
 AND als.stop_id = c.alight_stop_id
WHERE r.route_type = ANY($6::smallint[])
ORDER BY
  r.route_id,
  c.board_stop_id,
  c.alight_stop_id,
  (c.alight_secs - c.board_secs) ASC NULLS LAST,
  c.trip_id
) AS options
ORDER BY
  -- Prefer light rail / train before buses so PLAN_RESULT_LIMIT does not drown them out.
  CASE route_type
    WHEN 0 THEN 0
    WHEN 2 THEN 1
    ELSE 2
  END,
  ride_duration_seconds ASC NULLS LAST,
  route_id,
  board_stop_id,
  alight_stop_id
LIMIT $7;
