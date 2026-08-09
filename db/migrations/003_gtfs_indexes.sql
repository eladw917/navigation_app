CREATE INDEX IF NOT EXISTS gtfs_stops_geom_gix
  ON gtfs_stops USING GIST (geom);

CREATE INDEX IF NOT EXISTS gtfs_stops_feed_idx
  ON gtfs_stops (feed_version_id);

CREATE INDEX IF NOT EXISTS gtfs_stop_times_stop_trip_seq_idx
  ON gtfs_stop_times (feed_version_id, stop_id, trip_id, stop_sequence);

CREATE INDEX IF NOT EXISTS gtfs_stop_times_trip_seq_idx
  ON gtfs_stop_times (feed_version_id, trip_id, stop_sequence);

CREATE INDEX IF NOT EXISTS gtfs_trips_route_idx
  ON gtfs_trips (feed_version_id, route_id);

CREATE INDEX IF NOT EXISTS gtfs_trips_service_idx
  ON gtfs_trips (feed_version_id, service_id);

CREATE INDEX IF NOT EXISTS gtfs_routes_type_idx
  ON gtfs_routes (feed_version_id, route_type);

CREATE INDEX IF NOT EXISTS gtfs_calendar_dates_date_idx
  ON gtfs_calendar_dates (feed_version_id, date);
