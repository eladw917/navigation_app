CREATE TABLE IF NOT EXISTS walk_route_cache (
  cache_key text PRIMARY KEY,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS walk_route_cache_expires_at_idx
  ON walk_route_cache (expires_at);
