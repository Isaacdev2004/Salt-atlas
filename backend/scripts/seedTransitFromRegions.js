/**
 * seedTransitFromRegions.js
 *
 * 1) Adds / refreshes `transit_agencies` on every county in data/derived/regions.csv
 *    using a deterministic heuristic (until you replace counts from NTD GeoJSON).
 * 2) Writes data/derived/transit.geojson — agency points for the map POI layer.
 *
 * Replace the heuristic with real NTD → county counts (see data/raw/README_NTD.md),
 * then re-run this script before loadToPostgres / deploy.
 *
 * Usage (from backend/):
 *   node scripts/seedTransitFromRegions.js
 */

const fs = require("fs");
const path = require("path");
const Papa = require("papaparse");

const root = path.join(__dirname, "..");
const regionsPath = path.join(root, "data/derived/regions.csv");
const outGeo = path.join(root, "data/derived/transit.geojson");

function hashFips(fips) {
  let h = 0;
  const s = String(fips);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Stand-in until NTD county rollups exist: correlates weakly with population. */
function syntheticTransitAgencies(fips, population) {
  const pop = Number(population) || 0;
  const h = hashFips(fips);
  const fromPop = Math.floor(Math.sqrt(Math.max(pop, 0) / 8000));
  const jitter = h % 12;
  return Math.max(0, Math.min(180, fromPop + jitter));
}

/** Rough CONUS placement from FIPS (visual only; replace with real agency coords). */
function baseLngLat(fips) {
  const st = parseInt(String(fips).padStart(5, "0").slice(0, 2), 10) || 1;
  const co = parseInt(String(fips).padStart(5, "0").slice(2), 10) || 0;
  const lng = -124.5 + (st / 56) * 52 + (co % 17) * 0.04;
  const lat = 25.5 + ((co % 900) / 900) * 21 + (st % 7) * 0.35;
  return [lng, lat];
}

function main() {
  if (!fs.existsSync(regionsPath)) {
    console.error("Missing", regionsPath);
    process.exit(1);
  }

  const text = fs.readFileSync(regionsPath, "utf8");
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  if (parsed.errors?.length) {
    console.error(parsed.errors);
    process.exit(1);
  }

  const rows = parsed.data.map((row) => {
    const fips = String(row.fips || "").padStart(5, "0");
    const population = Number(row.population) || 0;
    const agencies = syntheticTransitAgencies(fips, population);
    return {
      ...row,
      fips,
      population,
      median_income: Number(row.median_income) || 0,
      business_count: Number(row.business_count) || 0,
      transit_agencies: agencies,
    };
  });

  const csvOut = Papa.unparse(rows, { columns: [
    "fips",
    "population",
    "median_income",
    "business_count",
    "transit_agencies",
  ]});
  fs.writeFileSync(regionsPath, csvOut, "utf8");
  console.log("✅ Updated regions.csv with transit_agencies");

  const features = [];
  /* Keep POI payload reasonable for Mapbox; raise after switching to real NTD points. */
  const capPointsPerCounty = 5;
  for (const row of rows) {
    const n = Math.min(Number(row.transit_agencies) || 0, capPointsPerCounty);
    const [lng0, lat0] = baseLngLat(row.fips);
    for (let i = 0; i < n; i++) {
      const t = (i + 1) / (n + 1);
      const weight = 0.25 + (0.75 * t);
      features.push({
        type: "Feature",
        properties: {
          name: `Transit service ${row.fips}-${i + 1}`,
          weight,
        },
        geometry: {
          type: "Point",
          coordinates: [lng0 + i * 0.028, lat0 + i * 0.019],
        },
      });
    }
  }

  fs.writeFileSync(
    outGeo,
    JSON.stringify({ type: "FeatureCollection", features }, null, 0),
    "utf8"
  );
  console.log(`✅ Wrote transit.geojson (${features.length} points)`);
}

main();
