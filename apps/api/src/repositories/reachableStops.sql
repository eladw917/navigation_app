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
-- PostgreSQL otherwise inlines these small spatial result sets and may rerun the
-- endpoint lookup inside the stop_times join (millions of needless comparisons).
polygon_stops AS MATERIALIZED (
  SELECT s.feed_version_id, s.stop_id, s.stop_name, s.geom
  FROM gtfs_stops s
  JOIN active_feed f ON s.feed_version_id = f.id
  CROSS JOIN area a
  WHERE COALESCE(s.location_type, 0) = 0
    AND ST_Covers(a.geom, s.geom)
),
endpoint_stops AS MATERIALIZED (
  SELECT s.feed_version_id, s.stop_id, s.stop_name, s.geom
  FROM gtfs_stops s
  JOIN active_feed f ON s.feed_version_id = f.id
  CROSS JOIN endpoint e
  WHERE COALESCE(s.location_type, 0) = 0
    AND ST_DWithin(s.geom::geography, e.geom::geography, $4)
),
-- Every (polygon_stop, route) that reaches the destination area on a direct trip
reachable_routes AS (
  SELECT DISTINCT
    p.stop_id,
    r.route_id,
    COALESCE(NULLIF(r.route_short_name, ''), r.route_id) AS route_short_name
  FROM polygon_stops p
  JOIN gtfs_stop_times st_p
    ON st_p.feed_version_id = p.feed_version_id
   AND st_p.stop_id = p.stop_id
  JOIN gtfs_stop_times st_e
    ON st_e.feed_version_id = st_p.feed_version_id
   AND st_e.trip_id = st_p.trip_id
   AND CASE
     WHEN $5 = 'walk_transit' THEN st_e.stop_sequence > st_p.stop_sequence
     ELSE st_e.stop_sequence < st_p.stop_sequence
   END
  JOIN endpoint_stops e
    ON e.feed_version_id = st_e.feed_version_id
   AND e.stop_id = st_e.stop_id
  JOIN gtfs_trips t
    ON t.feed_version_id = st_p.feed_version_id
   AND t.trip_id = st_p.trip_id
  JOIN gtfs_routes r
    ON r.feed_version_id = t.feed_version_id
   AND r.route_id = t.route_id
  WHERE r.route_type = ANY($6::smallint[])
    AND CASE
      WHEN $5 = 'walk_transit' THEN
        COALESCE(st_p.pickup_type, 0) <> 1
        AND COALESCE(st_e.drop_off_type, 0) <> 1
      ELSE
        COALESCE(st_e.pickup_type, 0) <> 1
        AND COALESCE(st_p.drop_off_type, 0) <> 1
    END
)
SELECT
  s.stop_id,
  s.stop_name,
  ST_X(s.geom) AS lng,
  ST_Y(s.geom) AS lat,
  CASE WHEN $5 = 'walk_transit' THEN 'boarding' ELSE 'alighting' END AS role,
  ARRAY_AGG(DISTINCT rr.route_short_name ORDER BY rr.route_short_name) AS route_short_names,
  f.id AS feed_version_id,
  f.imported_at,
  f.source_sha256
FROM reachable_routes rr
JOIN active_feed f ON true
JOIN gtfs_stops s
  ON s.feed_version_id = f.id
 AND s.stop_id = rr.stop_id
GROUP BY
  s.stop_id,
  s.stop_name,
  s.geom,
  f.id,
  f.imported_at,
  f.source_sha256
ORDER BY s.stop_name, s.stop_id;
