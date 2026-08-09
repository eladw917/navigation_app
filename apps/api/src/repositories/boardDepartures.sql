-- Board departures for a planned board→alight pair (static GTFS).
-- $1 text board_stop_id
-- $2 text alight_stop_id
-- $3 text route_id (empty string = ignore)
-- $4 text route_short_name
-- $5 int today_dow (0=Sunday .. 6=Saturday)
-- $6 int tomorrow_dow
WITH active_feed AS (
  SELECT id
  FROM gtfs_feed_versions
  WHERE active = true
  LIMIT 1
),
services_today AS (
  SELECT c.feed_version_id, c.service_id, 0 AS day_offset
  FROM gtfs_calendar c
  JOIN active_feed f ON c.feed_version_id = f.id
  WHERE ($5 = 0 AND c.sunday = 1)
     OR ($5 = 1 AND c.monday = 1)
     OR ($5 = 2 AND c.tuesday = 1)
     OR ($5 = 3 AND c.wednesday = 1)
     OR ($5 = 4 AND c.thursday = 1)
     OR ($5 = 5 AND c.friday = 1)
     OR ($5 = 6 AND c.saturday = 1)
),
services_tomorrow AS (
  SELECT c.feed_version_id, c.service_id, 1 AS day_offset
  FROM gtfs_calendar c
  JOIN active_feed f ON c.feed_version_id = f.id
  WHERE ($6 = 0 AND c.sunday = 1)
     OR ($6 = 1 AND c.monday = 1)
     OR ($6 = 2 AND c.tuesday = 1)
     OR ($6 = 3 AND c.wednesday = 1)
     OR ($6 = 4 AND c.thursday = 1)
     OR ($6 = 5 AND c.friday = 1)
     OR ($6 = 6 AND c.saturday = 1)
),
services AS (
  SELECT * FROM services_today
  UNION ALL
  SELECT * FROM services_tomorrow
)
SELECT
  s.day_offset,
  t.trip_id,
  COALESCE(st_board.departure_secs, st_board.arrival_secs)::int AS departure_secs
FROM active_feed f
JOIN services s
  ON s.feed_version_id = f.id
JOIN gtfs_trips t
  ON t.feed_version_id = s.feed_version_id
 AND t.service_id = s.service_id
JOIN gtfs_routes r
  ON r.feed_version_id = t.feed_version_id
 AND r.route_id = t.route_id
JOIN gtfs_stop_times st_board
  ON st_board.feed_version_id = t.feed_version_id
 AND st_board.trip_id = t.trip_id
 AND st_board.stop_id = $1
JOIN gtfs_stop_times st_alight
  ON st_alight.feed_version_id = st_board.feed_version_id
 AND st_alight.trip_id = st_board.trip_id
 AND st_alight.stop_id = $2
 AND st_alight.stop_sequence > st_board.stop_sequence
WHERE COALESCE(st_board.pickup_type, 0) <> 1
  AND COALESCE(st_alight.drop_off_type, 0) <> 1
  AND COALESCE(st_board.departure_secs, st_board.arrival_secs) IS NOT NULL
  AND (
    NULLIF(BTRIM($3), '') IS NULL
    OR r.route_id = $3
  )
  AND COALESCE(NULLIF(r.route_short_name, ''), r.route_id) = $4
ORDER BY s.day_offset, departure_secs, t.trip_id;
