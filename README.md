# Israeli Walk + Transit (Phase 1.0)

Notebook-first MVP: static Israeli GTFS + walking isochrones + direct same-trip connections.

## Stack

- **API:** Node.js / TypeScript / Fastify
- **DB:** PostgreSQL + PostGIS
- **Isochrones / geocoding:** HeiGIT openrouteservice + Pelias (free Standard tier)
  - Free fallbacks if the HeiGIT key is disallowed: Nominatim geocoding + circular walking approximation
- **Validation UI:** Jupyter notebook (`notebooks/01_api_usage.ipynb`)
- **Frontend:** deferred until the notebook validation gate passes

> **Important:** If your HeiGIT key was pasted into chat, rotate it in the HeiGIT dashboard and update `.env`. A disallowed key returns HTTP 403; the API will still run using free fallbacks so local testing can continue.

## Prerequisites

- Node.js 20+
- PostgreSQL with PostGIS (local Homebrew or Docker Compose)
- HeiGIT API key in `.env` (never commit the key)

### Local Postgres (this machine)

```bash
export PATH="/usr/local/opt/postgresql@17/bin:$PATH"
brew services start postgresql@17
createdb navigation   # once
```

### Or Docker

```bash
docker compose up -d
# then set DATABASE_URL=postgres://navigation:navigation@localhost:5432/navigation
```

## Setup

```bash
cp .env.example .env
# edit HEIGIT_API_KEY

npm install
npm run db:migrate
npm run db:import:fixture   # tiny local feed for SQL tests
# optional full Israel feed (~150MB+):
# npm run db:import

npm run dev
```

API:
- Health: `http://localhost:3010/health`
- Docs: `http://localhost:3010/docs`
- OpenAPI: `http://localhost:3010/openapi.json`

## Frontend

```bash
# API already running on :3010
npm run dev:web
```

Open `http://localhost:5173/` — place search, walking slider, MapLibre map, and direct route list.
The Vite dev server proxies `/v1` and `/health` to the API on **port 3010**
(avoid 3000/3001 — those can be taken by other local apps like Haiku).

For current UI behavior, recent changes, and where to continue work, see **[docs/HANDOFF.md](docs/HANDOFF.md)**.

### Free SaaS MVP (public demo)

Use **Neon + Render + Cloudflare Pages** with the **fixture** GTFS only (free DB storage cannot hold the full Israel feed).

Step-by-step: **[docs/FREE_SAAS_MVP.md](docs/FREE_SAAS_MVP.md)**  
Configs: `render.yaml`, `vercel.json`, `apps/web/public/_redirects`.

## Notebook

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r notebooks/requirements.txt
cd notebooks
jupyter notebook 01_api_usage.ipynb
```

The notebook only needs `API_BASE_URL` (default `http://127.0.0.1:3010`).

## Core endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Process + DB readiness |
| GET | `/v1/config` | Bounds, walking defaults, radius |
| GET | `/v1/gtfs/status` | Active feed metadata |
| GET | `/v1/places/search?q=` | Israel-restricted geocoding |
| GET | `/v1/places/reverse?lng=&lat=` | Reverse geocoding |
| POST | `/v1/plans/direct` | Isochrone + direct GTFS routes |

### Example plan request

```bash
curl -s http://localhost:3010/v1/plans/direct \
  -H 'content-type: application/json' \
  -d '{
    "mode": "walk_transit",
    "origin": {"lng": 34.7818, "lat": 32.0853},
    "destination": {"lng": 34.7800, "lat": 32.0750},
    "maxWalkingSeconds": 900
  }' | jq .
```

## Modes

- `walk_transit`: walking isochrone around **origin**; destination matched by fixed radius (default 500 m)
- `transit_walk`: walking isochrone around **destination**; origin matched by fixed radius

A valid option is a **single GTFS trip** that boards then alights in sequence (no transfers, no SIRI).

## Security notes

- Keep `HEIGIT_API_KEY` server-side only
- Rotate any key that was pasted into chat
- `.env` is gitignored

## Tests

```bash
npm test
npm run typecheck
```

## RTL / Hebrew readiness (Phase 1 notes)

- API returns UTF-8 stop/route names unchanged
- Notebook/ basemap attribution must remain visible
- Future React UI should use logical CSS properties and an app-level `dir` switch

## Validation gate before frontend

Use the notebook checklist to confirm correctness, caching (`isochroneCached`), latency, and result cardinality on the active feed before building `apps/web`.
