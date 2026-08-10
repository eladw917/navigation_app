#!/usr/bin/env bash
# Strict health check: HTTP alone is insufficient — /health returns 200 when degraded.
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:3010}"
TIMEOUT_SECS="${2:-30}"
DEADLINE=$((SECONDS + TIMEOUT_SECS))

while (( SECONDS < DEADLINE )); do
  if body="$(curl -fsS --max-time 5 "${BASE_URL%/}/health" 2>/dev/null)"; then
    if python3 -c '
import json, sys
body = json.load(sys.stdin)
ok = body.get("status") == "ok" and body.get("database") is True
sys.exit(0 if ok else 1)
' <<<"$body"; then
      echo "$body"
      exit 0
    fi
  fi
  sleep 1
done

echo "health check failed for ${BASE_URL} within ${TIMEOUT_SECS}s" >&2
exit 1
