WITH active AS (
  SELECT id AS feed_version_id
  FROM gtfs_feed_versions
  WHERE active = true
  LIMIT 1
),
board_seq AS (
  SELECT MIN(st.stop_sequence) AS seq
  FROM active a
  JOIN gtfs_stop_times st
    ON st.feed_version_id = a.feed_version_id
   AND st.trip_id = $1
   AND st.stop_id = $2
),
alight_seq AS (
  SELECT MIN(st.stop_sequence) AS seq
  FROM active a
  CROSS JOIN board_seq b
  JOIN gtfs_stop_times st
    ON st.feed_version_id = a.feed_version_id
   AND st.trip_id = $1
   AND st.stop_id = $3
   AND st.stop_sequence >= b.seq
)
SELECT
  st.stop_sequence,
  s.stop_id,
  s.stop_name,
  ST_X(s.geom)::float8 AS lng,
  ST_Y(s.geom)::float8 AS lat,
  st.arrival_secs,
  st.departure_secs,
  (st.stop_sequence >= b.seq AND st.stop_sequence <= a.seq) AS on_path,
  (st.stop_id = $2 AND st.stop_sequence = b.seq) AS is_board,
  (st.stop_id = $3 AND st.stop_sequence = a.seq) AS is_alight
FROM active act
CROSS JOIN board_seq b
CROSS JOIN alight_seq a
JOIN gtfs_stop_times st
  ON st.feed_version_id = act.feed_version_id
 AND st.trip_id = $1
JOIN gtfs_stops s
  ON s.feed_version_id = st.feed_version_id
 AND s.stop_id = st.stop_id
WHERE b.seq IS NOT NULL
  AND a.seq IS NOT NULL
ORDER BY st.stop_sequence;
