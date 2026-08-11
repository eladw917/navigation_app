# Handoff — Israeli Walk + Transit planner

Last updated: 2026-08-09  
Audience: next engineer continuing product/UI work on the Phase 1.0 MVP.

This document complements the root [README.md](../README.md) (setup, stack, endpoints). Prefer the README for first-time bootstrap; use this for **current product behavior**, **recent UI work**, and **where to change things**.

---

## What this product is

Direct **walk + one bus** planner for Israel:

- Static GTFS in PostGIS (no transfers, no live SIRI).
- Walking isochrones (HeiGIT ORS, with circular fallback).
- Two plan modes run together: `walk_transit` (walk near origin) and `transit_walk` (walk near destination).
- Web UI: place search → plan → options list + MapLibre map with station browsing.

Out of scope for Phase 1.0: multi-leg journeys, real-time arrivals, RTL app chrome (basemap Hebrew labels are fixed; UI layout is still LTR).

---

## Quick start

```bash
cp .env.example .env   # set HEIGIT_API_KEY + DATABASE_URL
npm install
npm run db:migrate
npm run db:import:fixture   # or npm run db:import for full MOT feed

npm run dev                 # API :3010
npm run dev:web             # Vite :5173 → proxies /v1 to API
```

- API docs: `http://localhost:3010/docs`
- App: `http://localhost:5173/`
- Typecheck: `npm run typecheck`
- Tests: `npm test` (API + importer; **no web unit tests**)

---

## Repo map

| Path | Role |
|------|------|
| `apps/api` | Fastify API |
| `apps/web` | React + Vite + MapLibre |
| `packages/contracts` | Shared Zod schemas |
| `scripts/gtfs-import` | GTFS → PostGIS |
| `db/migrations` | Schema |
| `docs/HARDENING.md` | Perf / pilot checklist |
| `notebooks/` | API exploration notebook |

**Entrypoints**

- API: `apps/api/src/index.ts` → `routes/index.ts`
- Web: `apps/web/src/main.tsx` → `pages/PlannerPage.tsx`
- Contracts: `packages/contracts/src/index.ts`

---

## Architecture (mental model)

```
PlannerPage
  ├─ PlaceInput (+ placeHistory localStorage)
  ├─ planDirect × 2 modes ──► mergePlans / applyResultFilters
  ├─ RouteResults (cards + schedule expander)
  └─ TransitMap (pins, trip path, station stepper, next bus)
         │
         ▼
API: ORS isochrone → reachableStops / directRoutes SQL → scheduleStats
     GET /v1/departures, GET /v1/trips/:tripId/path
```

| Concern | Primary files |
|---------|----------------|
| Plan | `apps/api/src/services/planner.ts`, `repositories/directRoutes.sql`, `reachableStops.sql`, `scheduleStats.sql`, `orsIsochrone.ts` |
| Departures | `apps/api/src/services/departures.ts`, `repositories/boardDepartures.sql` |
| Trip geometry/times | `apps/api/src/services/tripPath.ts`, `repositories/tripPath.sql` |
| Page orchestration | `apps/web/src/pages/PlannerPage.tsx` |
| Map + popup | `apps/web/src/components/TransitMap.tsx` |
| Options list | `apps/web/src/components/RouteResults.tsx` |
| Next-bus helpers | `apps/web/src/formatDeparture.ts` |
| Client filters/merge | `apps/web/src/mergePlans.ts` |
| Recent places | `apps/web/src/placeHistory.ts`, `PlaceInput.tsx` |

---

## Product behavior (as of this handoff)

### Planning & results

- After origin + destination + Go: both modes are fetched; cards are merged/filtered client-side.
- Filters on the map toolbar: mode toggles, “Walks ≤ N min”, max station frequency, max total time, optional schedule window.
- Option cards emphasize **bus number, headsign, frequency, total time, next bus** — not board/alight names.
- After plan, From/To become static; **New query** restores search fields.

### Map & station browsing (`TransitMap`)

- Clicking a pin opens the bus popup; selecting a line loads the full trip path.
- **Get on** / **Get off** rows + ← → stepper:
  - Get-on list: trip start → **one stop before** get-off.
  - Get-off list: one stop after get-on → trip end.
  - Switching Get on ↔ Get off **keeps** `chosenBoardId` / `chosenAlightId` (does not reset the other end).
  - Clicking a **destination** pin defaults the stepper to **Get off** at that station.
- Station subtitle shows relative line position: `Stop N/M`.
- **Reset** restores the recommended board/alight path.
- Walk summary metrics order: **distance / stops first, duration second**  
  e.g. `1.5 km · ~20 min`, `8 stops · ~11 min`.

### Outside the selected ride (visual)

- Segments **before get-on** and **after get-off** stay on the map as grey `transitOutside` lines.
- Those stations are dimmed (lower opacity, grey).
- Board→alight stays teal `transit`.

### Next bus vs Get on times

These are **intentionally independent**:

| UI | Meaning |
|----|---------|
| **Get on / Get off clocks** | Stop times on the **loaded trip path** (often a planner sample trip for geometry). |
| **Next bus** | First departure you can still catch if you start walking in **1 minute**, using walk-to-board time (same minute rounding as the Walk-to-stop row). |

Helpers: `DEPARTURE_PREP_SECONDS`, `pickNextCatchableDeparture`, `formatNextBusIn` in `formatDeparture.ts`.  
Map popup refetches departures for the **current** bus + effective board/alight (so changing bus at a station updates next bus). Schedule “i” / picked departure only applies when the browsed trip matches the selected option.

### Place history

- `localStorage` key `navigationApp.placeHistory.v1` (max 8).
- Dropdown should open immediately with Recent (not gated on search loading).

### Hebrew on the basemap

- MapLibre needs an RTL text plugin; registered in `TransitMap` via `@mapbox/mapbox-gl-rtl-text@0.3.0` (unpkg). Reload if labels still look reversed after a hot reload.

---

## Performance notes (known)

Place history only caches **coordinates/labels** — not plans.

A Go click still:

1. Runs **two** `POST /v1/plans/direct` (one per mode) — each: ORS isochrone (L1 memory + L2 Postgres, 7-day TTL) + heavy PostGIS + schedule stats.
2. Then fires **`GET /v1/departures` per route option** (can be many).

Meta line after plan shows `elapsedMs` and `isochrone cached`. Plan-cache / lazy departures were discussed but **not implemented**.

---

## Env (root `.env`)

See `.env.example`. Important knobs:

- `HEIGIT_API_KEY`, ORS/Pelias URLs  
- `DATABASE_URL`  
- `PORT` (3010), `PLAN_RESULT_LIMIT` (default 200), `MAX_WALKING_SECONDS`, `ENDPOINT_RADIUS_METERS`, `ALLOWED_ROUTE_TYPES` (default `0,2,3` = light rail, train, bus — Israel MOT GTFS types)  
- Web: Vite proxies `/v1` → API; optional `VITE_API_BASE_URL`

---

## Recent session changelog (high level)

Work landed in this conversation arc (web-heavy):

1. Next bus + 24h schedule expander; next bus on all option cards.  
2. Place recent-history UX; static From/To after plan.  
3. Map popup: full trip stations, get-on/get-off scroll, persist choices, destination opens on get-off.  
4. Grey/dim outside-route line + stations.  
5. Walk-aware next bus (+1 min prep); metrics distance/stops-then-time.  
6. Clarified next bus ≠ get-on sample clocks.  
7. MapLibre RTL plugin for Hebrew basemap labels.

---

## Suggested next steps

- [ ] Ship free SaaS demo: follow [FREE_SAAS_MVP.md](./FREE_SAAS_MVP.md) (Neon + Render + Pages, fixture GTFS).
- [ ] Confirm RTL labels after a full page reload (not only HMR).
- [ ] If plan feels slow: cache plans by O/D/walk/mode, or fetch departures only for visible/selected cards.
- [ ] Optional: when user picks a schedule time, keep map get-on clocks on that trip (path already loads via `activeDeparture` in `PlannerPage`).
- [ ] Web tests for `formatDeparture.pickNextCatchableDeparture` and scroll-list bounds.
- [ ] App-level `dir="rtl"` / Hebrew UI if product wants full RTL chrome.
- [ ] See `docs/HARDENING.md` before any pilot load.

---

## Working agreements from recent UI work

- Prefer matching existing map/popup patterns in `TransitMap.tsx` over new components.  
- Walk speed for estimates: **1.25 m/s** (same as API circular fallback).  
- Do not force get-on clocks to equal next bus; next bus must remain walk-aware.  
- Board scroll must stop one station before get-off; changing ends must not wipe the other choice.
