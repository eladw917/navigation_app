WITH active_feed AS (
  SELECT id
  FROM gtfs_feed_versions
  WHERE active = true
  LIMIT 1
),
endpoint AS (
  SELECT ST_SetSRID(ST_MakePoint($3, $4), 4326) AS geom
),
endpoint_stops AS (
  SELECT s.feed_version_id, s.stop_id
  FROM gtfs_stops s
  JOIN active_feed f ON s.feed_version_id = f.id
  CROSS JOIN endpoint e
  WHERE COALESCE(s.location_type, 0) = 0
    AND ST_DWithin(s.geom::geography, e.geom::geography, $5)
)
SELECT
  t.trip_id,
  st_board.stop_id AS board_stop_id,
  st_alight.stop_id AS alight_stop_id
FROM active_feed f
JOIN gtfs_routes r
  ON r.feed_version_id = f.id
 AND COALESCE(NULLIF(r.route_short_name, ''), r.route_id) = $1
 AND r.route_type = ANY($7::smallint[])
JOIN gtfs_trips t
  ON t.feed_version_id = r.feed_version_id
 AND t.route_id = r.route_id
JOIN gtfs_stop_times st_focus
  ON st_focus.feed_version_id = t.feed_version_id
 AND st_focus.trip_id = t.trip_id
 AND st_focus.stop_id = $2
JOIN gtfs_stop_times st_board
  ON st_board.feed_version_id = t.feed_version_id
 AND st_board.trip_id = t.trip_id
JOIN gtfs_stop_times st_alight
  ON st_alight.feed_version_id = t.feed_version_id
 AND st_alight.trip_id = t.trip_id
 AND st_alight.stop_sequence > st_board.stop_sequence
JOIN endpoint_stops e
  ON e.feed_version_id = t.feed_version_id
 AND e.stop_id = CASE
   WHEN $6 = 'walk_transit' THEN st_alight.stop_id
   ELSE st_board.stop_id
 END
WHERE CASE
    WHEN $6 = 'walk_transit' THEN
      st_board.stop_id = $2
      AND st_board.stop_sequence = st_focus.stop_sequence
      AND COALESCE(st_board.pickup_type, 0) <> 1
      AND COALESCE(st_alight.drop_off_type, 0) <> 1
    ELSE
      st_alight.stop_id = $2
      AND st_alight.stop_sequence = st_focus.stop_sequence
      AND COALESCE(st_board.pickup_type, 0) <> 1
      AND COALESCE(st_alight.drop_off_type, 0) <> 1
  END
ORDER BY st_alight.stop_sequence - st_board.stop_sequence, t.trip_id
LIMIT 1;
