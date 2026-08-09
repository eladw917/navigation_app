# Free SaaS MVP — Neon + Render + Cloudflare Pages

Zero-cost public demo. **Fixture GTFS only** (Neon Free ≈ 0.5 GB cannot hold the full MOT Israel feed).

| Layer | Free service | Role |
|-------|----------------|------|
| Database | [Neon](https://console.neon.tech) | Postgres + PostGIS |
| API | [Render](https://dashboard.render.com) | Fastify (`apps/api`) |
| Web | [Cloudflare Pages](https://dash.cloudflare.com) | Vite build (`apps/web`) |

Alternative for web: Vercel (same build; see below).

---

## Limits (read this)

- **Data:** only `npm run db:import:fixture` — tiny sample stops/routes, not all of Israel.
- **API cold start:** Render Free sleeps ~15 min idle; first hit can take 30–60s.
- **HeiGIT:** free ORS/Pelias quotas; without a key the API falls back to circular walk + Nominatim.
- **Not for:** full-country planning or always-on latency.

---

## Step 1 — Neon database

1. Sign up → **New project** (region close to you).
2. Dashboard → **Connection details** → copy the **pooled** connection string  
   (`…-pooler.…`, SSL usually required — Neon URLs already include `sslmode=require`).
3. **SQL Editor** → run:

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
```

4. On your laptop (repo root), load schema + fixture into Neon:

```bash
export DATABASE_URL='postgresql://USER:PASS@HOST/neondb?sslmode=require'
npm install
npm run db:migrate
npm run db:import:fixture
```

5. Optional check with local API pointed at Neon:

```bash
# in .env temporarily, or:
DATABASE_URL='…same…' npm run dev
curl -s http://127.0.0.1:3010/v1/gtfs/status | jq .
```

---

## Step 2 — Render API

Repo already has [`render.yaml`](../render.yaml). Easiest:

1. Render → **New → Blueprint** → connect `eladw917/navigation_app` → apply `render.yaml`.
2. Or **New → Web Service** manually:

| Setting | Value |
|---------|--------|
| Repo | `eladw917/navigation_app` |
| Runtime | Node |
| Build | `npm install && npm run build -w @navigation/contracts && npm run build -w @navigation/api` |
| Start | `npm run start -w @navigation/api` |
| Plan | **Free** |
| Health check | `/health` |

3. **Environment** (Dashboard → Environment):

| Key | Value |
|-----|--------|
| `DATABASE_URL` | Neon pooled URL |
| `HOST` | `0.0.0.0` |
| `HEIGIT_API_KEY` | your key (or leave unset / `missing` for fallbacks) |
| `HEIGIT_ORS_BASE_URL` | `https://api.heigit.org/openrouteservice` |
| `HEIGIT_PELIAS_BASE_URL` | `https://api.heigit.org/pelias/v1` |
| `LOG_LEVEL` | `info` |

Render injects `PORT` — do not hardcode it.

4. Deploy → copy the service URL, e.g.  
   `https://navigation-api-xxxx.onrender.com`

5. Smoke:

```bash
curl -sS https://YOUR-API.onrender.com/health
curl -sS https://YOUR-API.onrender.com/v1/gtfs/status
```

---

## Step 3 — Cloudflare Pages (web)

1. Cloudflare → **Workers & Pages** → **Create** → **Pages** → connect the same GitHub repo.
2. Build settings:

| Setting | Value |
|---------|--------|
| Framework preset | None |
| Build command | `npm install && npm run build -w @navigation/contracts && npm run build -w @navigation/web` |
| Build output directory | `apps/web/dist` |
| Root directory | `/` (repo root) |

3. **Environment variables** → Production:

| Key | Value |
|-----|--------|
| `VITE_API_BASE_URL` | `https://YOUR-API.onrender.com` (no trailing slash) |

4. Deploy → open `https://….pages.dev`.

SPA fallback is in `apps/web/public/_redirects` (copied into `dist` on build).

### Vercel instead of Pages

Root [`vercel.json`](../vercel.json) is set up. Import the repo in Vercel, set the same `VITE_API_BASE_URL`, deploy.

---

## Step 4 — Demo checklist

1. Open the Pages URL (wait on first load if API is cold).
2. Pick origin/destination that work with the **fixture** (see `tests/fixtures/gtfs/raw/stops.txt` names/coords), or use map after a plan from known fixture area.
3. Run a plan; expect few options vs production MOT.
4. Confirm Next bus / map still load (departures hit the API).

---

## After every code push

```bash
git push origin main
```

Render and Pages rebuild from `main`.  
Re-run migrate/fixture **only** when schema or fixture changes (from your laptop against Neon):

```bash
DATABASE_URL='…' npm run db:migrate
DATABASE_URL='…' npm run db:import:fixture
```

---

## When you outgrow free SaaS

- Full Israel GTFS → paid Postgres disk (or a small VPS).
- No cold starts → Render paid / Fly / VPS.
- See also [HANDOFF.md](./HANDOFF.md) and [HARDENING.md](./HARDENING.md).
