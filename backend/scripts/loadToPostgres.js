/**
 * scripts/loadToPostgres.js
 *
 * Loads derived data into PostgreSQL.
 * Run after merge.js has produced data/derived/regions.csv.
 *
 * Usage:
 *   node scripts/loadToPostgres.js
 *
 * Requires: DATABASE_URL environment variable (set in .env)
 *
 * ─── Adding a new POI layer ───────────────────────────────────────────────────
 * Drop a .geojson file into data/derived/ and re-run this script.
 * It is automatically discovered and loaded. No code changes needed.
 *
 * ─── Adding a new metric column ──────────────────────────────────────────────
 * Add the column to regions_metrics in init.sql, add the column to regions.csv,
 * and re-run this script. Column names are read directly from the CSV header
 * no changes to this file needed.
 * ─────────────────────────────────────────────────────────────────────────────
 */

require("dotenv").config();

const fs   = require("fs");
const path = require("path");
const { Client } = require("pg");

const conn = process.env.DATABASE_URL;

if (!conn) {
  console.error("❌ DATABASE_URL is required");
  process.exit(1);
}

const root        = path.join(__dirname, "..");
const derivedDir  = path.join(root, "data/derived");
const regionsFile = path.join(derivedDir, "regions.csv");

/* ── File readers ─────────────────────────────────────────────────────────── */

const readJSON = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

/**
 * Minimal CSV parser.
 * Returns: { columns: string[], rows: Record<string,string>[] }
 */
const readCSV = (filePath) => {
  const text = fs.readFileSync(filePath, "utf8").trim();
  const [header, ...lines] = text.split(/\r?\n/);
  const columns = header.split(",").map((c) => c.trim());
  const rows = lines.filter(Boolean).map((line) => {
    const values = line.split(",");
    const row = {};
    columns.forEach((col, i) => { row[col] = values[i]?.trim() ?? ""; });
    return row;
  });
  return { columns, rows };
};

/**
 * discoverPoiFiles()
 *
 * Scans data/derived/ for all .geojson files except the counties boundary file.
 * Returns: { [layerKey]: absoluteFilePath }
 *
 * To add a new POI layer: drop the .geojson into data/derived/ and re-run.
 * No code changes needed here or in server.js.
 */
const discoverPoiFiles = () => {
  // Files to skip: these are boundary/choropleth sources, not POI layers
  const SKIP = new Set(["counties.geojson"]);

  const files = {};
  if (!fs.existsSync(derivedDir)) {
    console.warn(`⚠️  data/derived/ directory not found at ${derivedDir}`);
    return files;
  }

  fs.readdirSync(derivedDir)
    .filter((name) => name.endsWith(".geojson") && !SKIP.has(name))
    .forEach((name) => {
      const key = path.basename(name, ".geojson"); // "airports.geojson" → "airports"
      files[key] = path.join(derivedDir, name);
    });

  return files;
};

/* ── Main ─────────────────────────────────────────────────────────────────── */

(async () => {
  const isProd = conn.includes("railway") || conn.includes("render") ||
                 conn.includes("supabase") || conn.includes("neon") ||
                 conn.includes("heroku") || !!process.env.NODE_ENV?.match(/prod/);

  const client = new Client({
    connectionString: conn,
    ssl: isProd ? { rejectUnauthorized: false } : false,
  });

  await client.connect();
  console.log("🔌 Connected to database\n");

  try {
    /* 1. Run init.sql. First drops and recreates regions_metrics + poi_layers,
     *    preserves scoring_weights so weight changes survive a reload. */
    const initSql = fs.readFileSync(path.join(root, "sql/init.sql"), "utf8");
    await client.query(initSql);
    console.log("✅ Schema ready (tables dropped and recreated)");

    await client.query("BEGIN");

    /* 2. Load regions ─────────────────────────────────────────────────────
     *
     * Column names are read directly from the CSV header row.
     * Adding a new metric = add the column to the CSV and to init.sql.
     * No changes needed in this file.
     *
     * Required columns: fips + at least one metric column.
     * All non-fips columns are treated as metric columns and inserted as-is.
     */
    if (!fs.existsSync(regionsFile)) {
      throw new Error(`regions.csv not found at ${regionsFile}\nRun: node scripts/merge.js`);
    }

    const { columns, rows: regions } = readCSV(regionsFile);

    // Validate required column
    if (!columns.includes("fips")) {
      throw new Error(`regions.csv is missing the required "fips" column.\nFound: ${columns.join(", ")}`);
    }

    // Warn on old column names from pre-refactor merge.js
    if (columns.includes("income") && !columns.includes("median_income")) {
      throw new Error(
        'regions.csv has an "income" column but expects "median_income".\n' +
        "Re-run scripts/merge.js to regenerate the CSV."
      );
    }

    // Metric columns = everything except fips
    const metricCols = columns.filter((c) => c !== "fips");

    console.log(`\n📊 CSV columns detected: fips + [${metricCols.join(", ")}]`);
    console.log(`   → Inserting ${regions.length} rows into regions_metrics\n`);

    // regions_metrics was already dropped+recreated by init.sql
    // so we can use a simple INSERT (no ON CONFLICT needed)
    for (const row of regions) {
      const placeholders = metricCols.map((_, i) => `$${i + 2}`).join(", ");
      const values = [row.fips, ...metricCols.map((c) => Number(row[c]) || 0)];

      await client.query(
        `INSERT INTO regions_metrics (fips, ${metricCols.join(", ")})
         VALUES ($1, ${placeholders})`,
        values
      );
    }

    console.log(`✅ regions_metrics loaded — ${regions.length} rows`);

    /* 3. Load POI GeoJSON layers ──────────────────────────────────────────
     *
     * Auto-discovered from data/derived/*.geojson
     * Drop a new file there and re-run. There are no code changes needed.
     */
    const poiFiles = discoverPoiFiles();
    const poiCount = Object.keys(poiFiles).length;

    console.log(`\n🗺  POI files discovered: [${Object.keys(poiFiles).join(", ")}]`);

    if (poiCount === 0) {
      console.warn("⚠️  No .geojson files found in data/derived/ — poi_layers will be empty");
    }

    // poi_layers was dropped+recreated by init.sql
    for (const [layer, file] of Object.entries(poiFiles)) {
      if (!fs.existsSync(file)) {
        console.warn(`⚠️  Skipping ${layer} — file not found: ${file}`);
        continue;
      }
      const geojson = readJSON(file);
      await client.query(
        `INSERT INTO poi_layers (layer_key, data, updated_at)
         VALUES ($1, $2::jsonb, NOW())`,
        [layer, JSON.stringify(geojson)]
      );
      console.log(`   ✅ ${layer}`);
    }

    await client.query("COMMIT");

    console.log(`
🎉 Done
   ${regions.length} regions loaded
   ${poiCount} POI layers loaded
   DB is now in sync with your CSV and geojson files.
`);

  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("\n❌ Load failed:", error.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
