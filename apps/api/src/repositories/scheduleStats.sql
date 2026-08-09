-- $1 text[] stop_ids
-- $2 int hour_start_secs (inclusive)
-- $3 int hour_end_secs (exclusive, may be > 86400 for overnight)
-- $4 int[] days_of_week (0=Sunday .. 6=Saturday); empty = all days
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
    COALESCE(NULLIF(r.route_short_name, ''), r.route_id) AS route_short_name,
    COALESCE(st.departure_secs, st.arrival_secs) AS dep_secs
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
ordered_route AS (
  SELECT
    stop_id,
    route_short_name,
    dep_secs,
    lag(dep_secs) OVER (
      PARTITION BY stop_id, route_short_name
      ORDER BY dep_secs
    ) AS prev_dep
  FROM deps
),
ordered_stop AS (
  SELECT
    stop_id,
    dep_secs,
    lag(dep_secs) OVER (
      PARTITION BY stop_id
      ORDER BY dep_secs
    ) AS prev_dep
  FROM deps
),
route_gaps AS (
  SELECT
    stop_id,
    route_short_name,
    (dep_secs - prev_dep) AS gap_secs
  FROM ordered_route
  WHERE prev_dep IS NOT NULL
    AND (dep_secs - prev_dep) BETWEEN 60 AND 7200
),
stop_gaps AS (
  SELECT
    stop_id,
    (dep_secs - prev_dep) AS gap_secs
  FROM ordered_stop
  WHERE prev_dep IS NOT NULL
    AND (dep_secs - prev_dep) BETWEEN 60 AND 7200
),
route_stats AS (
  SELECT
    stop_id,
    route_short_name,
    COUNT(*)::int AS sample_count,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_secs)::float8 AS median_headway_secs
  FROM route_gaps
  GROUP BY stop_id, route_short_name
),
stop_stats AS (
  SELECT
    stop_id,
    COUNT(*)::int AS sample_count,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_secs)::float8 AS median_headway_secs
  FROM stop_gaps
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
  s.median_headway_secs,
  s.sample_count,
  COALESCE((
    SELECT SUM(rc.departure_count)::int FROM route_counts rc WHERE rc.stop_id = s.stop_id
  ), 0) AS departure_count
FROM stop_stats s
UNION ALL
SELECT
  'route'::text AS kind,
  r.stop_id,
  r.route_short_name,
  r.median_headway_secs,
  r.sample_count,
  COALESCE(rc.departure_count, 0) AS departure_count
FROM route_stats r
LEFT JOIN route_counts rc
  ON rc.stop_id = r.stop_id
 AND rc.route_short_name = r.route_short_name
ORDER BY kind, stop_id, route_short_name NULLS FIRST;
