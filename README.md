# Salt Atlas

Salt Atlas is an exploration tool that surfaces high-opportunity U.S. counties by combining socioeconomic metrics, infrastructure layers, and interactive filters. The React/Tailwind frontend talks to an Express API that either serves pre-baked CSV/GeoJSON data or, when configured, pulls metrics directly from PostgreSQL for live scoring.

## Features

- County-level choropleth powered by opportunity, population, income, and business metrics with log-normalized scoring.
- Infrastructure toggles (airports, ports, rail, warehouses, manufacturing, **transit agencies**) rendered as clustered POI layers on Mapbox GL.
- **Transit density** is part of the opportunity score (10% weight by default): `transit_agencies` per county, normalized as agencies per 100k residents. Replace placeholder data with [NTD](https://www.transit.dot.gov/ntd/fta-census-map) rollups using `backend/scripts/seedTransitFromRegions.js` (see `backend/data/raw/README_NTD.md`).
- Select mode, top 20 quick pick, export-to-CSV, and detailed region panel with comparisons.
- Responsive layout with desktop sidebar/panel flows and mobile action sheets, help walkthrough, and clean map view toggle.
- Backend caching plus optional PostgreSQL weights table so scoring can vary without redeploying the frontend.

## Architecture

### Frontend

- Built with Vite + React 19, Mapbox GL, Turf, PapaParse, and Tailwind CSS v4.
- `src/App.jsx` handles map lifecycle, filters, selection, UI state (toast, help, detail panel), and fetches `/api/regions`, `/api/weights`, and `/api/<layer>` at runtime.
- Environment: `VITE_MAPBOX_TOKEN` (Mapbox access token) and `VITE_API_URL` (backend base URL). Copy `.env.example` to `.env` and set values before running locally or building for production.

### Backend

- Node.js + Express API located in `backend/server.js`. Serves:
  - `GET /api/regions`: loads raw region metrics (CSV fallback or PostgreSQL), runs log/compress/min-max scoring (weights come from `scoring_weights` or `FILE_MODE_WEIGHTS`), caches the result.
  - `GET /api/weights`: exposes current scoring weights so the UI can show which metrics drive the opportunity score.
  - `GET /api/:layer`: serves POI GeoJSON layers. The route is dynamically enabled via `POI_CONFIG` and caches each layer in memory.
- `METRIC_MAP` centralizes metric → column/log-transformation info so adding new metrics only requires column + weight + config updates.
- Caching TTL is governed by `API_CACHE_TTL_MS`; backend auto-falls back to file mode when `DATABASE_URL` is absent.
- Data and GeoJSON live under `backend/data/derived`. The schema/seed scripts live in `backend/sql` and `backend/scripts`.

### Data pipeline

- `backend/scripts/mergeGeojson.js` merges multiple GeoJSON inputs into one collection (used when preparing derived POI layers).
- `backend/scripts/loadToPostgres.js` runs `sql/init.sql`, loads `regions.csv`, and pushes discovered GeoJSON files into `poi_layers`. The script auto-discovers layers in `data/derived/*.geojson` and inserts them without extra code changes.
- `backend/data/derived/regions.csv` and the GeoJSON files are the source-of-truth when PostgreSQL is not configured.

## Project structure

```
salt-atlas/
├── backend/
│   ├── data/
│   │   ├── derived/         # airports.geojson, ports.geojson, rail.geojson, warehouses.geojson, regions.csv
│   │   └── raw/             # source exports (business.json, census.json, query*.json, etc.)
│   ├── scripts/             # helpers: mergeGeojson, process*, loadToPostgres
│   ├── sql/
│   │   └── init.sql         # schema for regions_metrics, poi_layers, scoring_weights
│   ├── db.js                # Postgres pool + helpers
│   ├── server.js            # Express API
│   └── .env                 # DATABASE_URL (optional for file mode)
├── src/
│   ├── App.jsx              # map UI, filters, selection, export
│   ├── main.jsx             # Vite entry
│   ├── index.css            # Tailwind + layout
│   ├── config/
│   │   └── api.js           # fetch helpers + base URL
│   └── assets/              # image/audio/static assets
├── public/                  # favicon, icons, salt_logo.png, index.html shell
├── .env.example             # Template for Vite env (copy to `.env`)
├── package.json
├── package-lock.json
├── vite.config.js
├── vercel.json              # SPA rewrites + build output for Vercel
├── .gitignore
└── eslint.config.js
```

## Getting started

### Prerequisites

- Node 20+ (or latest LTS) for both frontend and backend.
- PostgreSQL if you want live scoring/weights; otherwise the backend uses the local CSV/GeoJSON bundles.
- Mapbox account to generate `VITE_MAPBOX_TOKEN`.

### Environment

1. Copy `.env.example` to `.env` and set `VITE_MAPBOX_TOKEN` and `VITE_API_URL` as needed.
2. In `backend/.env` set `DATABASE_URL` to your Postgres connection string. Leave it unset to run in file mode.
3. Optional backend env:
   - `PORT`: port for the Express server (defaults to 5000).
   - `API_CACHE_TTL_MS`: cache time for regions/POI responses (default 10 minutes).

### Backend setup

```bash
cd backend
npm install
# (re)load derived data when you update CSV/GeoJSON
npm run db:load
# start the API
node server.js
```

- Without a DB, `npm run db:load` still validates CSV/GeoJSON but the API will default to `FILE_MODE_WEIGHTS`.
- To add a new POI layer, drop its `.geojson` into `backend/data/derived/` and rerun `npm run db:load` (the script auto-discovers files).

### Frontend setup

```bash
npm install
npm run dev   # http://localhost:5173 by default
npm run lint
npm run build # production bundle
npm run preview
```

- Ensure `VITE_API_URL` matches the running backend (e.g., `http://localhost:5000` for local development).
- `npm run build` outputs static assets for deployment; it will inline the current env variables you defined before building.

### Deploying on Vercel

- Set the **Root Directory** of the Vercel project to `salt-atlas` (this folder), or open this folder as the Git repository root.
- Add environment variables in the Vercel project settings: `VITE_MAPBOX_TOKEN`, `VITE_API_URL` (your deployed API origin), and optionally `VITE_MAPBOX_TILESET_URL`, `VITE_MAPBOX_COUNTY_SOURCE_LAYER`, and `VITE_MAPBOX_STYLE`.
- The included `vercel.json` sets `outputDirectory` to `dist` and rewrites unknown paths to `index.html` for the SPA. The Express API is not deployed by this config; host the backend separately and point `VITE_API_URL` at it.

## Development notes

- `src/config/api.js` centralizes API paths and the fetch helpers.
- `App.jsx` keeps most UI pieces (filters, help, selection, export) and uses `mapbox-gl` feature state for choropleth rendering.
- The UI exposes CSV export of the current selection using PapaParse; customize the export columns in `App.jsx` if requirements change.
- Clean map view, help flow, and mobile sheets help keep the interface focused while preserving the full control on desktop.
- The right panel detail view and hover card rely on `feature-state` metrics injected during region scoring.

## API summary

- `GET /api/regions` - scoped region scores with raw metrics.
- `GET /api/weights` - weights used in the current scoring.
- `GET /api/:layer` - returns GeoJSON for each enabled infrastructure layer (see `backend/server.js` → `POI_CONFIG`).

## Roadmap

- Phase 2 should migrate spatial storage/querying to PostGIS for performance and advanced geospatial operations while keeping the scoring pipeline data-driven via `METRIC_MAP` and `scoring_weights`.

## Troubleshooting

- If the API logs missing counties, inspect `backend/data/derived/regions.csv` for zero/empty `business_count`.
- Run `node scripts/loadToPostgres.js` manually to inspect raw CSV parsing errors before reloading Postgres.
