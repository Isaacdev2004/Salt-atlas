require("dotenv").config();

const express = require("express");
const cors = require("cors");
const compression = require("compression");
const fs = require("fs");
const path = require("path");
const Papa = require("papaparse");

// ---------------------------------------------------------------------------
// DB - pool is the default export; getWeights() is a named export.
// When DATABASE_URL is not set we skip DB entirely and read from local files.
// ---------------------------------------------------------------------------
const db = process.env.DATABASE_URL ? require("./db") : null;
const pool = db;
const getWeights = db ? db.getWeights : null;

// ---------------------------------------------------------------------------
// POI layer config
// Set a layer to false to disable its route without deleting anything.
// ---------------------------------------------------------------------------
const POI_CONFIG = {
  airports: true,
  ports: true,
  rail: true,
  warehouses: true,
  manufacturing: true,
};

// ---------------------------------------------------------------------------
// Fallback weights - used in file mode (no DB) only.
// In DB mode, scoring_weights table is the single source of truth.
// Keys here MUST match the column names in regions_metrics exactly.
// To add a new metric for Phase 2: add a column to regions_metrics,
// add a row to scoring_weights, and add its key here for file-mode fallback.
// ---------------------------------------------------------------------------
const FILE_MODE_WEIGHTS = {
  population: 0.33,
  median_income: 0.33,
  business_count: 0.33,
};

// ---------------------------------------------------------------------------
// Simple in-memory caching to speed up reloads and reduce repeated DB/disk work.
// This helps perceived startup time when the frontend re-requests the same data.
// ---------------------------------------------------------------------------
const API_CACHE_TTL_MS = Number(process.env.API_CACHE_TTL_MS ?? 10 * 60 * 1000); // 10 minutes default
let regionsCache = null;
let regionsCacheTs = 0;
const poiLayerCache = new Map(); // layer_key -> { data, ts }

// ---------------------------------------------------------------------------
// Column map - maps each weight key to its DB column name and internal
// log-compressed key. This is the ONLY place you define a metric.
// Adding a Phase 2 metric = add one entry here + a DB column + a weight row.
// ---------------------------------------------------------------------------
// Format: weightKey → { dbCol, logKey }
//   weightKey - must match scoring_weights.metric_name exactly
//   dbCol     - column name in regions_metrics table
//   logKey    - internal key used during log compression (prefixed with _)
const METRIC_MAP = {
  population: {
    dbCol: "population",
    logKey: "_population",
    transform: "log",
  },
  median_income: {
    dbCol: "median_income",
    logKey: "_median_income",
    transform: "none",
  },
  business_count: {
    dbCol: "business_count",
    logKey: "_business_count",
    transform: "log",
  },
};

const app = express();
const isProd = process.env.NODE_ENV === "production";

app.use(cors());
app.use(compression());
app.use(express.json());

// ---------------------------------------------------------------------------
// Scoring - fully data-driven, iterates over weights object dynamically.
//
// Adding a new metric for Phase 2 requires ZERO changes to this function.
// Just add the metric to METRIC_MAP, regions_metrics, and scoring_weights.
//
// Pipeline:
//   1. Log-compress each metric  - Math.log(val + 1) collapses right-skew
//      so metro outliers don't push every other county to ~0 after norm.
//   2. Min-Max normalize         - each metric scaled 0–1 across the dataset.
//   3. Weighted composite        - opportunity_score in [0, 1].
// ---------------------------------------------------------------------------
const scoreRegions = (rows, weights) => {
  const metrics = Object.keys(weights);
  // Sanitize weights: if DB weights are missing/zero, ensure we still produce valid scores.
  const safeWeights = {};
  metrics.forEach((key) => {
    const w = Number(weights[key]);
    safeWeights[key] = isFinite(w) && w > 0 ? w : 0;
  });
  let totalWeight = metrics.reduce((sum, key) => sum + safeWeights[key], 0);
  if (!isFinite(totalWeight) || totalWeight <= 0) {
    // Fall back to equal weights so opportunity_score doesn't collapse to 0/NaN.
    metrics.forEach((key) => {
      safeWeights[key] = 1;
    });
    totalWeight = metrics.length;
  }

  // Step 1 - log-compress every metric defined in weights
  const compressed = rows.map((r) => {
    const entry = { fips: r.fips, _raw: {} };
    metrics.forEach((key) => {
      const { dbCol, logKey } = METRIC_MAP[key] || {
        dbCol: key,
        logKey: `_${key}`,
      };
      let rawVal = Number(r[dbCol] ?? r[key]);

      if (!isFinite(rawVal) || rawVal < 0) {
        if (!isProd) console.log("BAD VALUE:", key, r);
        rawVal = 0;
      }
      entry._raw[key] = rawVal;
      const transform = METRIC_MAP[key]?.transform || "log";

      entry[logKey] = transform === "log" ? Math.log(rawVal + 1) : rawVal;
    });
    return entry;
  });

  // Step 2 - compute min/max bounds from the actual dataset per metric
  const bounds = {};
  metrics.forEach((key) => {
    const { logKey } = METRIC_MAP[key] || { logKey: `_${key}` };
    const vals = compressed.map((r) => r[logKey]);
    bounds[key] = { min: Math.min(...vals), max: Math.max(...vals) };
  });

  const norm = (val, { min, max }) =>
    max === min ? 0 : (val - min) / (max - min);

  // Step 3 - normalize + composite score
  return compressed.map((r) => {
    const { logKey } = METRIC_MAP;
    const scores = {};

    // Compute normalized score for each metric
    metrics.forEach((key) => {
      const lk = (METRIC_MAP[key] || { logKey: `_${key}` }).logKey;
      const val = norm(r[lk], bounds[key]);
      scores[`${key}_norm`] = isFinite(val) ? val : 0;
    });

    // Composite opportunity score
    scores.opportunity_score =
      metrics.reduce((sum, key) => {
        return sum + scores[`${key}_norm`] * safeWeights[key];
      }, 0) / totalWeight;

    return {
      id: r.fips,
      raw_data: { ...r._raw },
      scores,
    };
  });
};

// ---------------------------------------------------------------------------
// Data loaders
// ---------------------------------------------------------------------------

const loadRegionsFromFile = () => {
  const filePath = path.join(__dirname, "data/derived/regions.csv");
  const csv = fs.readFileSync(filePath, "utf8");
  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });

  return parsed.data.map((row) => ({
    fips: row.fips,
    population: Number(row.population) || 0,
    median_income: Number(row.median_income) || 0,
    business_count: Number(row.business_count) || 0,
  }));
};

const loadGeoJSONFromFile = (fileName) => {
  const filePath = path.join(__dirname, `data/derived/${fileName}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
};

const loadGeoJSON = async (layer) => {
  if (!pool) return loadGeoJSONFromFile(`${layer}.geojson`);

  const result = await pool.query(
    "SELECT data FROM poi_layers WHERE layer_key = $1",
    [layer]
  );

  if (!result.rows.length)
    throw new Error(`Missing layer in PostgreSQL: ${layer}`);

  return result.rows[0].data;
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /api/regions
 *
 * Fetches raw rows + weights, runs normalization + scoring, returns per-county:
 * {
 *   id: "01001",
 *   raw_data: { population, median_income, business_count },
 *   scores:   { population_norm, median_income_norm, business_count_norm, opportunity_score }
 * }
 *
 * Adding a Phase 2 metric: add column to regions_metrics, row to scoring_weights,
 * entry to METRIC_MAP. This route needs zero changes.
 */
app.get("/api/regions", async (req, res) => {
  try {
    const now = Date.now();
    if (regionsCache && now - regionsCacheTs < API_CACHE_TTL_MS) {
      return res.json(regionsCache);
    }

    let rawRows, weights;

    if (!pool) {
      rawRows = loadRegionsFromFile();
      weights = FILE_MODE_WEIGHTS;
    } else {
      const [rowsResult, dbWeights] = await Promise.all([
        pool.query(
          `SELECT fips, ${Object.values(METRIC_MAP)
            .map((m) => m.dbCol)
            .join(", ")} FROM regions_metrics`
        ),
        getWeights(),
      ]);
      rawRows = rowsResult.rows;
      weights = dbWeights;
    }

    const missing = [];

    rawRows.forEach((r) => {
      if (
        r.business_count === null ||
        r.business_count === undefined ||
        Number(r.business_count) === 0
      ) {
        missing.push({
          fips: r.fips,
          population: r.population,
          median_income: r.median_income,
        });
      }
    });

    if (!isProd) {
      console.log("❌ Missing counties FULL:", missing);
      console.log("Total missing:", missing.length);
    }

    const scored = scoreRegions(rawRows, weights);

    if (!isProd) {
      console.log("RAW SAMPLE:", rawRows[0]);
      console.log("SCORED SAMPLE:", scored[0]);
    }

    regionsCache = scored;
    regionsCacheTs = now;
    return res.json(scored);
  } catch (err) {
    // Log the real error so you can diagnose it; not just "Failed to load regions"
    console.error("[/api/regions] Error:", err.message);
    console.error(err.stack);
    return res
      .status(500)
      .json({ error: "Failed to load regions", detail: err.message });
  }
});

/**
 * GET /api/weights
 *
 * Returns currently active scoring weights.
 * Useful for the frontend to display what weights are in effect.
 */
app.get("/api/weights", async (req, res) => {
  try {
    const weights = pool ? await getWeights() : FILE_MODE_WEIGHTS;
    return res.json(weights);
  } catch (err) {
    console.error("[/api/weights] Error:", err.message);
    return res
      .status(500)
      .json({ error: "Failed to load weights", detail: err.message });
  }
});

/**
 * GET /api/:layer
 * Returns raw GeoJSON for a POI infrastructure layer.
 */
app.get("/api/:layer", async (req, res) => {
  const allowed = Object.keys(POI_CONFIG).filter((k) => POI_CONFIG[k]);
  const { layer } = req.params;

  if (!allowed.includes(layer)) {
    return res.status(400).json({ error: "Invalid layer" });
  }

  try {
    const now = Date.now();
    const cached = poiLayerCache.get(layer);
    if (cached && now - cached.ts < API_CACHE_TTL_MS) {
      return res.json(cached.data);
    }

    const data = await loadGeoJSON(layer);
    poiLayerCache.set(layer, { data, ts: now });
    return res.json(data);
  } catch (err) {
    console.error(`[/api/${layer}] Error:`, err.message);
    return res
      .status(500)
      .json({ error: `Failed to load ${layer}`, detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Startup - verify DB connection and log the actual error if it fails.
// This surfaces schema mismatches immediately on boot instead of at
// first request, making "Failed to load regions" much easier to diagnose.
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 5000;

app.listen(PORT, async () => {
  console.log(
    `\nSalt Atlas API — port ${PORT} (${pool ? "PostgreSQL" : "file"} mode)\n`
  );

  if (pool) {
    try {
      // Verify the table exists and has the expected columns
      const cols = Object.values(METRIC_MAP)
        .map((m) => m.dbCol)
        .join(", ");
      await pool.query(`SELECT fips, ${cols} FROM regions_metrics LIMIT 1`);
      console.log("✅ DB connection OK — regions_metrics schema verified");

      const weights = await getWeights();
      if (!isProd) console.log("✅ scoring_weights loaded:", weights);
    } catch (err) {
      // Print the exact Postgres error so you know immediately what's wrong
      console.error("❌ DB startup check FAILED:", err.message);
      console.error(
        "   → Run: node scripts/loadToPostgres.js  (this rebuilds the schema)"
      );
    }
  }
});
