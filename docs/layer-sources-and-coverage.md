# Salt Atlas — Layer Sources & Coverage

Last updated: 2026-05-06

This document lists:

- **Source links** for each map layer dataset.
- **Coverage** notes (full vs capped) based on current backend settings.
- How to generate a **periodic coverage snapshot** for reporting.

## How coverage is defined

- **Source count**: total features reported by the upstream dataset/service.
- **Returned count**: features the Salt Atlas API is configured to return (may be capped for performance).
- **Coverage ratio**: \(returnedCount / sourceCount\).

To see the *live* numbers for your deployment, use the runtime endpoint:

- `GET /api/layer-health`

## Core infrastructure (local snapshot layers)

These layers are served from the API’s local snapshot GeoJSON files when Postgres is not enabled, or from `poi_layers` when Postgres is enabled.

- **Airports**
  - **API key**: `airports`
  - **Backend source**: `backend/data/derived/airports.geojson`
  - **Coverage**: full snapshot (no cap)

- **Ports**
  - **API key**: `ports`
  - **Backend source**: `backend/data/derived/ports.geojson`
  - **Coverage**: full snapshot (no cap)

- **Rail terminals**
  - **API key**: `rail`
  - **Backend source**: `backend/data/derived/rail.geojson`
  - **Coverage**: full snapshot (no cap)

- **Warehouses**
  - **API key**: `warehouses`
  - **Backend source**: `backend/data/derived/warehouses.geojson`
  - **Coverage**: full snapshot (no cap)

- **Manufacturing**
  - **API key**: `manufacturing`
  - **Backend source**: `backend/data/derived/manufacturing.geojson`
  - **Coverage**: full snapshot (no cap)

## USDOT / Esri transit layers

- **National Transit Database Reporters (2024)**
  - **API key**: `ntd_reporters_2024`
  - **Source (Esri FeatureServer)**: `https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/National_Transit_Database_Reporters_2024/FeatureServer/0`
  - **Coverage**: effectively full (source count is below current cap)

- **National Transit Map Routes**
  - **API key**: `ntm_routes`
  - **Source (Esri FeatureServer)**: `https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_National_Transit_Map_Routes/FeatureServer/0`
  - **Coverage**: **capped** for performance (and geometries are simplified via `maxAllowableOffset`)

- **FTA Administrative Boundaries (Urbanized Areas 2020)**
  - **API key**: `fta_admin_boundaries`
  - **Source (Esri FeatureServer)**: `https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/FTA_Administrative_Boundaries/FeatureServer/1`
  - **Coverage**: full (source count is below current cap)

## Freight lanes (FAF)

- **FAF5 Truck Lanes (OD)**
  - **API key**: `faf5_truck_lanes`
  - **Source program**: `https://www.bts.gov/faf`
  - **FAF database downloads**: `https://www.bts.gov/faf/faf5-database`
  - **Implementation**: served from a derived snapshot file:
    - `backend/data/derived/faf5_truck_od_2024.geojson`
  - **Coverage**: full of the derived snapshot (note: this is an OD-lane product, not the full FAF network geometry)

## Telecom

- **Telecom Infrastructure (FCC towers layer)**
  - **API key**: `telecom_infrastructure`
  - **Source (Esri FeatureServer)**: `https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/Cellular_Towers_in_the_United_States_view/FeatureServer/0`
  - **Coverage**: full (source count is below current cap)

## Education

- **Public Schools (NCES 2022–23)**
  - **API key**: `public_schools_2223`
  - **Catalog page**: `https://catalog.data.gov/dataset/public-school-locations-2022-23`
  - **Source (NCES MapServer layer 0)**: `https://nces.ed.gov/opengis/rest/services/K12_School_Locations/EDGE_GEOCODE_PUBLICSCH_2223/MapServer/0`
  - **Coverage**: full (cap is above current source count)

## Healthcare

- **Hospitals & Medical Centers**
  - **API key**: `hospitals_medical_centers`
  - **Hub page**: `https://hub.arcgis.com/datasets/fedmaps::hospitals-medical-centers/explore`
  - **Source (Esri FeatureServer layer 0)**: `https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/Structures_Medical_Emergency_Response_v1/FeatureServer/0`
  - **Coverage**: full (source count is below current cap)

## Child care

- **Child Care Centers (Day Care)**
  - **API key**: `child_care_centers`
  - **ArcGIS item**: `https://www.arcgis.com/home/item.html?id=2b5fb973bdd94bd985039b69da1f0424`
  - **Source (Esri FeatureServer layer 0)**: `https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/Child_Care_Centers_(Archive)/FeatureServer/0`
  - **Coverage**: full (cap is above current source count)

## Periodic coverage snapshot (recommended)

Use the runtime endpoint to generate a point-in-time snapshot for documentation:

- `GET https://<YOUR_API_HOST>/api/layer-health`

Suggested workflow:

- Run it weekly (or after deployments)
- Save the JSON output with a timestamp (e.g. `layer-health-2026-05-06.json`)
- Store it in your internal docs folder or attach it to the client report

Optional automation:

- Set up a weekly scheduled job (CI or cron) that fetches `/api/layer-health` and archives the JSON.

