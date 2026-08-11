CREATE TABLE IF NOT EXISTS isochrone_cache (
  cache_key text PRIMARY KEY,
  geojson jsonb NOT NULL,
  approximated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS isochrone_cache_expires_at_idx
  ON isochrone_cache (expires_at);
