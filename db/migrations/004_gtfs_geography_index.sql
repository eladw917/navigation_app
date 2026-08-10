-- ST_DWithin(...::geography, radius_meters) cannot use the geometry index.
-- This expression index keeps endpoint-radius lookups index-backed.
CREATE INDEX IF NOT EXISTS gtfs_stops_geog_gix
  ON gtfs_stops USING GIST ((geom::geography));
