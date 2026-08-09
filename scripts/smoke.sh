#!/usr/bin/env bash
set -euo pipefail
BASE="${API_BASE_URL:-http://127.0.0.1:3010}"

echo "== health =="
curl -sf "$BASE/health" | tee /tmp/nav-health.json
echo

echo "== config =="
curl -sf "$BASE/v1/config" | tee /tmp/nav-config.json
echo

echo "== gtfs status =="
curl -sf "$BASE/v1/gtfs/status" | tee /tmp/nav-gtfs.json
echo

echo "== places search =="
curl -sf --get "$BASE/v1/places/search" --data-urlencode "q=Tel Aviv" --data-urlencode "limit=3" | tee /tmp/nav-places.json
echo

echo "== plan walk_transit =="
curl -sf "$BASE/v1/plans/direct" \
  -H 'content-type: application/json' \
  -d '{"mode":"walk_transit","origin":{"lng":34.7818,"lat":32.0853},"destination":{"lng":34.7800,"lat":32.0750},"maxWalkingSeconds":900}' \
  | tee /tmp/nav-plan1.json
echo

echo "== plan again (expect isochrone cache) =="
curl -sf "$BASE/v1/plans/direct" \
  -H 'content-type: application/json' \
  -d '{"mode":"walk_transit","origin":{"lng":34.7818,"lat":32.0853},"destination":{"lng":34.7810,"lat":32.0755},"maxWalkingSeconds":900}' \
  | tee /tmp/nav-plan2.json
echo

python3 - <<'PY'
import json
p1=json.load(open('/tmp/nav-plan1.json'))
p2=json.load(open('/tmp/nav-plan2.json'))
print('plan1 cached', p1['meta']['isochroneCached'], 'routes', p1['meta']['routeCount'])
print('plan2 cached', p2['meta']['isochroneCached'], 'routes', p2['meta']['routeCount'])
assert p2['meta']['isochroneCached'] is True, 'expected isochrone cache hit on second call'
print('SMOKE_OK')
PY
