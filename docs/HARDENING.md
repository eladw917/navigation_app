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

- Isochrones: L1 in-memory LRU + L2 Postgres (`isochrone_cache`, 7-day TTL) by rounded
  anchor (~11 m) + walking seconds + location_type. Approximated circles are not cached.
- Do not auto-fire plans on every slider tick in the notebook (Run button only).
- Monitor dashboard quotas (approx. 500 isochrones / 1000 geocodes per day on Standard).
- Prefer `api.heigit.org` hosts (legacy `api.openrouteservice.org` shutoff scheduled 2026-08-24).

## Error states to verify manually

- Missing/invalid `HEIGIT_API_KEY` → API fails at startup
- No active GTFS feed → `/v1/plans/direct` returns 503
- Outside Israel bounds → 400
- ORS/Pelias outage → 502 with message (no key leaked)

## Data lifecycle (best practices)

| Asset | Store | Notes |
|-------|--------|--------|
| App code | Git | Deploy from `main`; do not edit production by hand long-term |
| Live GTFS | Postgres (`gtfs_*`, active `gtfs_feed_versions` row) | Runtime source of truth |
| Import staging | `data/gtfs/work/` (gitignored) | Disposable zip + extracted txts |
| Secrets | `.env` on the host only | Never commit |

Import defaults:

- Hash the zip **before** extract; identical SHA reactivates without reloading.
- After success, delete staging under `data/gtfs/work/` (use `--keep-work` to retain).
- Delete inactive feed versions (CASCADE) so disk does not grow with every MOT refresh (`--keep-versions 1` keeps one rollback).

```bash
npm run db:import                 # MOT feed → Postgres, clean staging, prune inactive
npm run db:import -- --keep-work  # debug: leave zip/txts on disk
npm run db:import -- --keep-versions 1
```

## Deployment

Production Contabo API uses **immutable releases** with CI-gated GitHub Actions deploys and health-check rollback. Cloudflare Pages continues to publish the web app from the same `main` push.

See **[DEPLOYMENT.md](./DEPLOYMENT.md)** for layout, secrets, bootstrap, and rollback limits.

Sketch:

1. Managed Postgres with PostGIS (or Docker volume on a VPS)
2. Run migrations on every API deploy (`navigation-deploy`)
3. Periodic GTFS import job (nightly) using transactional feed activation + prune — **not** part of code deploy
4. API service with env secrets in `/home/ubuntu/navigation-api/shared/.env`; no public ORS key
5. Notebook remains an operator/analyst tool, not a production UI
6. Web static build on Cloudflare Pages

## Acceptance

- [ ] Fixture SQL integration test green
- [ ] Health/config/status OK
- [ ] Both modes return plausible options for sample journeys
- [ ] Isochrone cache hits when only fixed endpoint changes
- [ ] Secrets remain server-side
- [ ] README setup works from clean checkout
