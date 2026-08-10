-- $1 text[] stop_ids
-- $2 int window_start_secs (inclusive, Israel-local GTFS clock)
-- $3 int window_end_secs (exclusive; typically start + 3600)
-- $4 int[] days_of_week (0=Sunday .. 6=Saturday)
--
-- Fast frequency estimate: buses in the window / 3600s → headway.
-- headway_secs = 3600 / departure_count  (i.e. minutes ≈ 60 / buses_per_hour)
WITH active_feed AS (
  SELECT id
  FROM gtfs_feed_versions
  WHERE active = true
  LIMIT 1
),
day_filter AS (
  SELECT COALESCE(cardinality($4::int[]), 0) AS n
),
services AS (
  SELECT c.feed_version_id, c.service_id
  FROM gtfs_calendar c
  JOIN active_feed f ON c.feed_version_id = f.id
  CROSS JOIN day_filter d
  WHERE d.n = 0
     OR (0 = ANY($4) AND c.sunday = 1)
     OR (1 = ANY($4) AND c.monday = 1)
     OR (2 = ANY($4) AND c.tuesday = 1)
     OR (3 = ANY($4) AND c.wednesday = 1)
     OR (4 = ANY($4) AND c.thursday = 1)
     OR (5 = ANY($4) AND c.friday = 1)
     OR (6 = ANY($4) AND c.saturday = 1)
),
deps AS (
  SELECT
    st.stop_id,
    COALESCE(NULLIF(r.route_short_name, ''), r.route_id) AS route_short_name
  FROM active_feed f
  JOIN gtfs_stop_times st
    ON st.feed_version_id = f.id
   AND st.stop_id = ANY($1::text[])
  JOIN gtfs_trips t
    ON t.feed_version_id = st.feed_version_id
   AND t.trip_id = st.trip_id
  JOIN services s
    ON s.feed_version_id = t.feed_version_id
   AND s.service_id = t.service_id
  JOIN gtfs_routes r
    ON r.feed_version_id = t.feed_version_id
   AND r.route_id = t.route_id
  WHERE COALESCE(st.departure_secs, st.arrival_secs) IS NOT NULL
    AND COALESCE(st.departure_secs, st.arrival_secs) >= $2
    AND COALESCE(st.departure_secs, st.arrival_secs) < $3
    AND COALESCE(st.pickup_type, 0) <> 1
),
stop_counts AS (
  SELECT stop_id, COUNT(*)::int AS departure_count
  FROM deps
  GROUP BY stop_id
),
route_counts AS (
  SELECT stop_id, route_short_name, COUNT(*)::int AS departure_count
  FROM deps
  GROUP BY stop_id, route_short_name
)
SELECT
  'stop'::text AS kind,
  s.stop_id,
  NULL::text AS route_short_name,
  CASE
    WHEN s.departure_count > 0 THEN (3600.0 / s.departure_count)
    ELSE NULL
  END AS median_headway_secs,
  s.departure_count AS sample_count,
  s.departure_count
FROM stop_counts s
UNION ALL
SELECT
  'route'::text AS kind,
  r.stop_id,
  r.route_short_name,
  CASE
    WHEN r.departure_count > 0 THEN (3600.0 / r.departure_count)
    ELSE NULL
  END AS median_headway_secs,
  r.departure_count AS sample_count,
  r.departure_count
FROM route_counts r
ORDER BY kind, stop_id, route_short_name NULLS FIRST;
