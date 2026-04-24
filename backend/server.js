require("dotenv").config();

const express = require("express");
const cors = require("cors");
const compression = require("compression");
const crypto = require("crypto");
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
const { SERVICES, fetchEsriGeoJson, stripForMapbox } = require("./lib/esriGeojson");

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
  population: 0.3,
  median_income: 0.3,
  business_count: 0.3,
  transit_density: 0.1,
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
  /* Agencies per 100k residents — uses transit_agencies + population from row */
  transit_density: {
    dbCol: "transit_agencies",
    logKey: "_transit_density",
    transform: "transit_per_100k",
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
    const entry = {
      fips: r.fips,
      _raw: {},
      transit_agencies: Number(r.transit_agencies) || 0,
    };
    metrics.forEach((key) => {
      const { dbCol, logKey } = METRIC_MAP[key] || {
        dbCol: key,
        logKey: `_${key}`,
      };
      const transform = METRIC_MAP[key]?.transform || "log";

      if (transform === "transit_per_100k") {
        const pop = Number(r.population) || 0;
        const ag = Number(r[dbCol]) || 0;
        const density = pop > 0 ? (ag / pop) * 100000 : 0;
        entry._raw[key] = density;
        entry[logKey] = Math.log(density + 1);
        return;
      }

      let rawVal = Number(r[dbCol] ?? r[key]);

      if (!isFinite(rawVal) || rawVal < 0) {
        if (!isProd) console.log("BAD VALUE:", key, r);
        rawVal = 0;
      }
      entry._raw[key] = rawVal;

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
      raw_data: {
        ...r._raw,
        transit_agencies: r.transit_agencies ?? 0,
      },
      scores,
    };
  });
};

// ---------------------------------------------------------------------------
// Data loaders
// ---------------------------------------------------------------------------

function hashFips(fips) {
  let h = 0;
  const s = String(fips);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** When regions.csv omits or blanks transit_agencies, avoid all-zero scoring. */
function syntheticTransitAgencies(fips, population) {
  const pop = Number(population) || 0;
  const h = hashFips(fips);
  const fromPop = Math.floor(Math.sqrt(Math.max(pop, 0) / 8000));
  const jitter = h % 12;
  return Math.max(0, Math.min(180, fromPop + jitter));
}

const loadRegionsFromFile = () => {
  const filePath = path.join(__dirname, "data/derived/regions.csv");
  const csv = fs.readFileSync(filePath, "utf8");
  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });
  const fields = parsed.meta.fields || [];
  const hasTransitCol = fields.includes("transit_agencies");

  return parsed.data.map((row) => {
    const fips = String(row.fips ?? "").padStart(5, "0");
    let ta = Number(row.transit_agencies);
    if (!hasTransitCol || !Number.isFinite(ta)) {
      ta = syntheticTransitAgencies(fips, row.population);
    }
    return {
      fips: row.fips,
      population: Number(row.population) || 0,
      median_income: Number(row.median_income) || 0,
      business_count: Number(row.business_count) || 0,
      transit_agencies: ta,
    };
  });
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
// Optional site gate (set SITE_PASSWORD on the host — never commit it)
// ---------------------------------------------------------------------------
const SITE_PASSWORD = (process.env.SITE_PASSWORD || "").trim();

function siteAuthEnabled() {
  return Boolean(SITE_PASSWORD);
}

function siteSessionSecret() {
  const extra = (process.env.SITE_AUTH_SECRET || "").trim();
  if (extra) return extra;
  if (!SITE_PASSWORD) return "";
  return crypto
    .createHash("sha256")
    .update(`salt-atlas-site|${SITE_PASSWORD}`, "utf8")
    .digest("hex");
}

/** Browser “stay signed in” duration (days). Override with SITE_SESSION_DAYS. */
function siteSessionTtlDays() {
  const n = Number(process.env.SITE_SESSION_DAYS);
  const days = Number.isFinite(n) ? n : 30;
  return Math.min(366, Math.max(1, Math.round(days)));
}

function makeSiteSessionToken() {
  const secret = siteSessionSecret();
  if (!secret) return "";
  const exp = Date.now() + siteSessionTtlDays() * 86400000;
  const payload = Buffer.from(JSON.stringify({ exp }), "utf8").toString(
    "base64url"
  );
  const sig = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${sig}`;
}

function verifySiteSessionToken(token) {
  const secret = siteSessionSecret();
  if (!secret || !token || typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  try {
    const expected = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("base64url");
    const a = Buffer.from(sig, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length) return false;
    if (!crypto.timingSafeEqual(a, b)) return false;
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof exp === "number" && Date.now() < exp;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/api/auth-status", (req, res) => {
  res.json({
    authRequired: siteAuthEnabled(),
    sessionTtlDays: siteAuthEnabled() ? siteSessionTtlDays() : null,
  });
});

app.post("/api/site-login", (req, res) => {
  if (!siteAuthEnabled()) {
    return res.json({ ok: true, token: makeSiteSessionToken() });
  }
  const password = req.body?.password;
  if (typeof password !== "string" || password !== SITE_PASSWORD) {
    return res.status(401).json({ ok: false, error: "Invalid password" });
  }
  return res.json({ ok: true, token: makeSiteSessionToken() });
});

app.use((req, res, next) => {
  const p = req.path || "";
  if (!p.startsWith("/api/")) return next();
  if (p === "/api/auth-status" || p === "/api/site-login") return next();
  if (!siteAuthEnabled()) return next();
  const m = (req.headers.authorization || "").match(/^Bearer\s+(\S+)/i);
  if (!m || !verifySiteSessionToken(m[1])) {
    return res.status(401).json({
      error: "Unauthorized",
      code: "SITE_AUTH_REQUIRED",
    });
  }
  next();
});

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
 * USDOT National Transit Map (ArcGIS) — same FeatureServer endpoints as
 * https://usdot.maps.arcgis.com/apps/mapviewer/index.html?webmap=5287ba87422448c7a97e5d60cc5e4f7b
 */
async function serveEsriGeoJson(req, res, serviceUrl, opts = {}) {
  const cacheKey = `esri:${serviceUrl}:${JSON.stringify(opts)}`;
  try {
    const now = Date.now();
    const cached = poiLayerCache.get(cacheKey);
    if (cached && now - cached.ts < API_CACHE_TTL_MS) {
      return res.json(cached.data);
    }
    const raw = await fetchEsriGeoJson(serviceUrl, opts);
    const data = stripForMapbox(raw);
    poiLayerCache.set(cacheKey, { data, ts: now });
    return res.json(data);
  } catch (err) {
    console.error("[esri]", err.message);
    return res.status(500).json({
      error: "Failed to load transit map layer",
      detail: err.message,
    });
  }
}

app.get("/api/ntd_reporters_2024", (req, res) =>
  serveEsriGeoJson(req, res, SERVICES.ntd_reporters_2024, {
    maxFeatures: Number(process.env.ESRI_NTD_MAX ?? 9000),
  })
);

app.get("/api/ntm_routes", (req, res) =>
  serveEsriGeoJson(req, res, SERVICES.ntm_routes, {
    maxFeatures: Number(process.env.ESRI_NTM_MAX ?? 10000),
    /* No maxAllowableOffset — Esri simplification was fragmenting lines */
  })
);

/** FTA group — Urbanized Areas (2020), FeatureServer layer 1 */
app.get("/api/fta_admin_boundaries", (req, res) =>
  serveEsriGeoJson(req, res, SERVICES.fta_admin_uza_2020, {
    maxFeatures: Number(process.env.ESRI_FTA_MAX ?? 4000),
    extraQuery: "maxAllowableOffset=0.001",
  })
);

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
