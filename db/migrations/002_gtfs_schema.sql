CREATE TABLE IF NOT EXISTS gtfs_feed_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_url text NOT NULL,
  source_sha256 text NOT NULL UNIQUE,
  imported_at timestamptz NOT NULL DEFAULT now(),
  active boolean NOT NULL DEFAULT false,
  stop_count integer,
  route_count integer,
  trip_count integer,
  stop_time_count integer,
  validation_notes text
);

CREATE UNIQUE INDEX IF NOT EXISTS gtfs_feed_versions_one_active
  ON gtfs_feed_versions ((active))
  WHERE active = true;

CREATE TABLE IF NOT EXISTS gtfs_agency (
  feed_version_id uuid NOT NULL REFERENCES gtfs_feed_versions(id) ON DELETE CASCADE,
  agency_id text NOT NULL,
  agency_name text NOT NULL,
  agency_url text,
  agency_timezone text,
  agency_lang text,
  agency_phone text,
  PRIMARY KEY (feed_version_id, agency_id)
);

CREATE TABLE IF NOT EXISTS gtfs_stops (
  feed_version_id uuid NOT NULL REFERENCES gtfs_feed_versions(id) ON DELETE CASCADE,
  stop_id text NOT NULL,
  stop_code text,
  stop_name text NOT NULL,
  stop_desc text,
  stop_lat double precision NOT NULL,
  stop_lon double precision NOT NULL,
  geom geometry(Point, 4326) NOT NULL,
  location_type smallint DEFAULT 0,
  parent_station text,
  wheelchair_boarding smallint,
  PRIMARY KEY (feed_version_id, stop_id)
);

CREATE TABLE IF NOT EXISTS gtfs_routes (
  feed_version_id uuid NOT NULL REFERENCES gtfs_feed_versions(id) ON DELETE CASCADE,
  route_id text NOT NULL,
  agency_id text,
  route_short_name text,
  route_long_name text,
  route_desc text,
  route_type smallint NOT NULL,
  route_color text,
  route_text_color text,
  PRIMARY KEY (feed_version_id, route_id)
);

CREATE TABLE IF NOT EXISTS gtfs_calendar (
  feed_version_id uuid NOT NULL REFERENCES gtfs_feed_versions(id) ON DELETE CASCADE,
  service_id text NOT NULL,
  monday smallint NOT NULL,
  tuesday smallint NOT NULL,
  wednesday smallint NOT NULL,
  thursday smallint NOT NULL,
  friday smallint NOT NULL,
  saturday smallint NOT NULL,
  sunday smallint NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  PRIMARY KEY (feed_version_id, service_id)
);

CREATE TABLE IF NOT EXISTS gtfs_calendar_dates (
  feed_version_id uuid NOT NULL REFERENCES gtfs_feed_versions(id) ON DELETE CASCADE,
  service_id text NOT NULL,
  date date NOT NULL,
  exception_type smallint NOT NULL,
  PRIMARY KEY (feed_version_id, service_id, date)
);

CREATE TABLE IF NOT EXISTS gtfs_trips (
  feed_version_id uuid NOT NULL REFERENCES gtfs_feed_versions(id) ON DELETE CASCADE,
  trip_id text NOT NULL,
  route_id text NOT NULL,
  service_id text NOT NULL,
  trip_headsign text,
  direction_id smallint,
  block_id text,
  shape_id text,
  wheelchair_accessible smallint,
  PRIMARY KEY (feed_version_id, trip_id),
  FOREIGN KEY (feed_version_id, route_id)
    REFERENCES gtfs_routes(feed_version_id, route_id)
);

CREATE TABLE IF NOT EXISTS gtfs_stop_times (
  feed_version_id uuid NOT NULL REFERENCES gtfs_feed_versions(id) ON DELETE CASCADE,
  trip_id text NOT NULL,
  stop_id text NOT NULL,
  stop_sequence integer NOT NULL,
  arrival_secs integer,
  departure_secs integer,
  pickup_type smallint DEFAULT 0,
  drop_off_type smallint DEFAULT 0,
  timepoint smallint,
  PRIMARY KEY (feed_version_id, trip_id, stop_sequence),
  FOREIGN KEY (feed_version_id, trip_id)
    REFERENCES gtfs_trips(feed_version_id, trip_id),
  FOREIGN KEY (feed_version_id, stop_id)
    REFERENCES gtfs_stops(feed_version_id, stop_id)
);
