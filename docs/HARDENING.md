# Hardening & pilot checklist

## Performance

1. Import the full Israel feed (`npm run db:import`).
2. Run representative plans from the notebook scenario matrix.
3. Capture SQL plans:

```sql
EXPLAIN (ANALYZE, BUFFERS)
-- paste parameterized plan after substituting JSON / coords
```

4. Tune only after measured evidence: indexes, `PLAN_RESULT_LIMIT`, endpoint radius.

## ORS / HeiGIT free-tier guardrails

- Isochrones: cache by rounded anchor + seconds + location_type (already implemented).
- Do not auto-fire plans on every slider tick in the notebook (Run button only).
- Monitor dashboard quotas (approx. 500 isochrones / 1000 geocodes per day on Standard).
- Prefer `api.heigit.org` hosts (legacy `api.openrouteservice.org` shutoff scheduled 2026-08-24).

## Error states to verify manually

- Missing/invalid `HEIGIT_API_KEY` → API fails at startup
- No active GTFS feed → `/v1/plans/direct` returns 503
- Outside Israel bounds → 400
- ORS/Pelias outage → 502 with message (no key leaked)

## Deployment sketch

1. Managed Postgres with PostGIS
2. Run migrations on deploy
3. Periodic GTFS import job (nightly) using transactional feed activation
4. API service with env secrets; no public ORS key
5. Notebook remains an operator/analyst tool, not a production UI

## Acceptance

- [ ] Fixture SQL integration test green
- [ ] Health/config/status OK
- [ ] Both modes return plausible options for sample journeys
- [ ] Isochrone cache hits when only fixed endpoint changes
- [ ] Secrets remain server-side
- [ ] README setup works from clean checkout
