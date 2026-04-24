/**
 * Fetch GeoJSON from ArcGIS FeatureServer with pagination + simple disk cache.
 * Aligns with USDOT National Transit Map webmap services.
 *
 * @see https://usdot.maps.arcgis.com/apps/mapviewer/index.html?webmap=5287ba87422448c7a97e5d60cc5e4f7b
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CACHE_DIR = path.join(__dirname, "../data/cache");
const DEFAULT_TTL_MS = Number(process.env.ESRI_CACHE_TTL_MS ?? 6 * 60 * 60 * 1000);
const ESRI_FETCH_TIMEOUT_MS = Number(process.env.ESRI_FETCH_TIMEOUT_MS ?? 120000);
const ESRI_PAGE_RETRIES = Number(process.env.ESRI_PAGE_RETRIES ?? 3);
/** Fetch this many Esri pages concurrently (each page ≤2000 features). */
const ESRI_PARALLEL_PAGES = Math.min(
  8,
  Math.max(1, Number(process.env.ESRI_PARALLEL_PAGES ?? 4))
);

/** Official USDOT-hosted FeatureServer layers (same as reference webmap). */
const SERVICES = {
  ntd_reporters_2024:
    "https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/National_Transit_Database_Reporters_2024/FeatureServer/0",
  ntm_routes:
    "https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_National_Transit_Map_Routes/FeatureServer/0",
  /** Urbanized Areas (2020) — visible “administrative” footprint in the reference map */
  fta_admin_uza_2020:
    "https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/FTA_Administrative_Boundaries/FeatureServer/1",
};

function cachePath(key) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const hash = crypto.createHash("md5").update(key).digest("hex");
  return path.join(CACHE_DIR, `${hash}.json`);
}

function readCache(file, ttlMs) {
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs > ttlMs) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(file, data) {
  fs.writeFileSync(file, JSON.stringify(data), "utf8");
}

/** Mapbox GeoJSON sources reject some Esri root fields (e.g. crs). */
function stripForMapbox(fc) {
  if (!fc || typeof fc !== "object") {
    return { type: "FeatureCollection", features: [] };
  }
  return {
    type: "FeatureCollection",
    features: Array.isArray(fc.features) ? fc.features : [],
  };
}

/**
 * @param {string} serviceUrl FeatureServer layer URL (no trailing slash)
 * @param {object} opts
 * @param {number} [opts.maxFeatures]
 * @param {string} [opts.extraQuery] e.g. geometry simplification
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchEsriPage(serviceUrl, offset, take, extraSuffix) {
  const q = new URLSearchParams({
    where: "1=1",
    outFields: "*",
    returnGeometry: "true",
    outSR: "4326",
    f: "geojson",
    resultOffset: String(offset),
    resultRecordCount: String(take),
  });
  const url = `${serviceUrl}/query?${q.toString()}${extraSuffix}`;
  let lastErr;
  for (let attempt = 1; attempt <= ESRI_PAGE_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ESRI_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Esri HTTP ${res.status}: ${txt.slice(0, 500)}`);
      }
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < ESRI_PAGE_RETRIES) {
        await sleep(600 * attempt);
      }
    }
  }
  throw lastErr;
}

async function fetchEsriGeoJson(serviceUrl, opts = {}) {
  const maxFeatures = opts.maxFeatures ?? 8000;
  const pageSize = Math.min(2000, maxFeatures);
  const extraSuffix = opts.extraQuery ? `&${opts.extraQuery}` : "";
  const cacheKey = `${serviceUrl}|${maxFeatures}|${extraSuffix}`;
  const cfile = cachePath(cacheKey);
  const cached = readCache(cfile, DEFAULT_TTL_MS);
  if (cached) return stripForMapbox(cached);

  const numPages = Math.ceil(maxFeatures / pageSize);
  const features = [];

  for (
    let chunkStart = 0;
    chunkStart < numPages;
    chunkStart += ESRI_PARALLEL_PAGES
  ) {
    const pagePromises = [];
    for (
      let p = chunkStart;
      p < Math.min(chunkStart + ESRI_PARALLEL_PAGES, numPages);
      p++
    ) {
      const offset = p * pageSize;
      const take = Math.min(pageSize, maxFeatures - offset);
      pagePromises.push(fetchEsriPage(serviceUrl, offset, take, extraSuffix));
    }
    const jsonChunks = await Promise.all(pagePromises);
    let sawShortPage = false;
    for (const gj of jsonChunks) {
      const batch = gj.features || [];
      if (!batch.length) {
        sawShortPage = true;
        break;
      }
      features.push(...batch);
      if (batch.length < pageSize) sawShortPage = true;
    }
    if (sawShortPage) break;
    if (features.length >= maxFeatures) break;
  }

  const trimmed =
    features.length > maxFeatures ? features.slice(0, maxFeatures) : features;

  const out = stripForMapbox({ type: "FeatureCollection", features: trimmed });
  writeCache(cfile, out);
  return out;
}

module.exports = {
  SERVICES,
  fetchEsriGeoJson,
  stripForMapbox,
};
