# NTD / FTA transit data (optional upgrade)

The map **Transit Agencies** POI layer and county **`transit_agencies`** counts ship with a **deterministic placeholder** so the app works out of the box. For production, replace them with **[National Transit Database (NTD)](https://www.transit.dot.gov/ntd/fta-census-map)** data.

## Suggested workflow

1. From the FTA census map / NTD resources, export **reporter locations** as GeoJSON (points with coordinates).
2. Save the file as `backend/data/raw/ntd_reporters.geojson`.
3. Join each agency point to a **5-digit county FIPS** (spatial join to a US counties layer, or use an attribute if your export includes `GEOID` / `COUNTYFP` / `STCNTYFP`).
4. Aggregate **count of agencies per FIPS** and merge into `regions.csv` as column **`transit_agencies`** (integer).
5. Optionally rebuild **`data/derived/transit.geojson`** from the same points (one feature per agency with `properties.name`).
6. Re-run `node scripts/loadToPostgres.js` if you use PostgreSQL.

Until then, run **`node scripts/seedTransitFromRegions.js`** from the `backend/` folder after changing `regions.csv` without transit, to regenerate placeholder counts and `transit.geojson`.
