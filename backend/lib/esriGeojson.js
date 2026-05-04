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
/**
 * Esri pages fetched in parallel (each ≤2000 features). Default **2**:
 * improves first-load latency while staying conservative for ArcGIS throttling.
 * Set 1 for maximum stability, or 3–4 on capable hosts.
 */
const ESRI_PARALLEL_PAGES = Math.min(
  8,
  Math.max(1, Number(process.env.ESRI_PARALLEL_PAGES ?? 2))
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
  /** FAF5 Regions (centroids used for OD lane endpoints). */
  faf5_regions:
    "https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_Freight_Analysis_Framework_Regions/FeatureServer/0",
  /** FAF5 road network links (used to infer top inter-zone truck lane connections). */
  faf5_network_links:
    "https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_Freight_Analysis_Framework_Network_Links/FeatureServer/0",
  /** Public FCC-derived tower infrastructure (ArcGIS Living Atlas archive). */
  fcc_cell_towers:
    "https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/Cellular_Towers_in_the_United_States_view/FeatureServer/0",
  /** NCES EDGE — Public school point locations (2022–23 CCD), MapServer layer 0 */
  nces_public_schools_2223:
    "https://nces.ed.gov/opengis/rest/services/K12_School_Locations/EDGE_GEOCODE_PUBLICSCH_2223/MapServer/0",
  /** USGS NGDA hospitals / medical centers (layer 0 of federal medical & emergency structures). */
  hospitals_medical_centers:
    "https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/Structures_Medical_Emergency_Response_v1/FeatureServer/0",
  /** HHS-derived child care centers (center-based day care; archived federal layer). */
  child_care_centers:
    "https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/Child_Care_Centers_(Archive)/FeatureServer/0",
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

function esriJsonGeometryToGeoJson(geometry, geometryType) {
  if (!geometry) return null;
  if (geometryType === "esriGeometryPoint") {
    if (typeof geometry.x !== "number" || typeof geometry.y !== "number")
      return null;
    return { type: "Point", coordinates: [geometry.x, geometry.y] };
  }
  if (geometryType === "esriGeometryPolyline") {
    const paths = Array.isArray(geometry.paths) ? geometry.paths : [];
    if (!paths.length) return null;
    return paths.length === 1
      ? { type: "LineString", coordinates: paths[0] }
      : { type: "MultiLineString", coordinates: paths };
  }
  if (geometryType === "esriGeometryPolygon") {
    const rings = Array.isArray(geometry.rings) ? geometry.rings : [];
    if (!rings.length) return null;
    return { type: "Polygon", coordinates: rings };
  }
  return null;
}

function normalizeEsriResponseToGeoJson(payload) {
  if (!payload || typeof payload !== "object") {
    return { type: "FeatureCollection", features: [] };
  }
  if (payload.type === "FeatureCollection") return stripForMapbox(payload);
  const geometryType = payload.geometryType;
  const features = Array.isArray(payload.features)
    ? payload.features.map((f, idx) => ({
        type: "Feature",
        id: f?.attributes?.OBJECTID ?? idx + 1,
        properties: f?.attributes || {},
        geometry: esriJsonGeometryToGeoJson(f?.geometry, geometryType),
      }))
    : [];
  return stripForMapbox({ type: "FeatureCollection", features });
}

/** Round coordinates in-place to shrink JSON (helps Render / browser limits on NTM polylines). */
function quantizeGeoJsonFeatures(features, decimals) {
  if (!Array.isArray(features) || decimals == null || decimals < 0) return;
  const q = (coord) =>
    typeof coord[0] === "number"
      ? coord.map((n) => Number(Number(n).toFixed(decimals)))
      : coord.map(q);
  const walk = (g) => {
    if (!g?.coordinates) return;
    const t = g.type;
    if (t === "LineString") g.coordinates = q(g.coordinates);
    else if (t === "MultiLineString")
      g.coordinates = g.coordinates.map(q);
    else if (t === "Polygon") g.coordinates = g.coordinates.map(q);
    else if (t === "MultiPolygon")
      g.coordinates = g.coordinates.map((poly) => poly.map(q));
    else if (t === "Point" && Array.isArray(g.coordinates)) {
      const [lon, lat] = g.coordinates;
      g.coordinates = [
        Number(Number(lon).toFixed(decimals)),
        Number(Number(lat).toFixed(decimals)),
      ];
    }
    else if (t === "MultiPoint") g.coordinates = q(g.coordinates);
  };
  for (const f of features) walk(f?.geometry);
}

/**
 * @param {string} serviceUrl FeatureServer layer URL (no trailing slash)
 * @param {object} opts
 * @param {number} [opts.maxFeatures]
 * @param {string} [opts.extraQuery] e.g. geometry simplification
 * @param {number} [opts.quantizeCoordinateDecimals] round line/polygon coords (e.g. 4 for NTM)
 * @param {string} [opts.where]
 * @param {string} [opts.outFields]
 * @param {boolean} [opts.returnGeometry]
 * @param {string} [opts.orderByFields]
 * @param {"geojson"|"json"} [opts.responseFormat]
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchEsriPage(queryUrl) {
  let lastErr;
  for (let attempt = 1; attempt <= ESRI_PAGE_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ESRI_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(queryUrl, {
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
  const where = (opts.where || "1=1").trim();
  const outFields = (opts.outFields || "*").trim();
  const returnGeometry = opts.returnGeometry !== false;
  const orderByFields =
    opts.orderByFields === undefined
      ? "OBJECTID"
      : String(opts.orderByFields ?? "").trim();
  const responseFormat =
    (opts.responseFormat || "geojson").toLowerCase() === "json"
      ? "json"
      : "geojson";
  const queryBase = new URLSearchParams({
    where,
    outFields,
    returnGeometry: returnGeometry ? "true" : "false",
    outSR: "4326",
    f: responseFormat,
  });
  if (orderByFields) queryBase.set("orderByFields", orderByFields);
  const extraSuffix = opts.extraQuery ? `&${opts.extraQuery}` : "";
  const qDec = Number.isFinite(Number(opts.quantizeCoordinateDecimals))
    ? Math.min(8, Math.max(0, Math.round(Number(opts.quantizeCoordinateDecimals))))
    : null;
  const cacheKey = `${serviceUrl}|${maxFeatures}|${queryBase.toString()}|${extraSuffix}|p${ESRI_PARALLEL_PAGES}|q${qDec ?? "x"}`;
  const cfile = cachePath(cacheKey);
  const cached = readCache(cfile, DEFAULT_TTL_MS);
  if (cached) return stripForMapbox(cached);

  const features = [];
  const numPages = Math.ceil(maxFeatures / pageSize);

  if (ESRI_PARALLEL_PAGES <= 1) {
    let offset = 0;
    while (offset < maxFeatures) {
      const take = Math.min(pageSize, maxFeatures - offset);
      const q = new URLSearchParams(queryBase);
      q.set("resultOffset", String(offset));
      q.set("resultRecordCount", String(take));
      const gj = await fetchEsriPage(
        `${serviceUrl}/query?${q.toString()}${extraSuffix}`
      );
      const norm = normalizeEsriResponseToGeoJson(gj);
      const batch = norm.features || [];
      if (!batch.length) break;
      features.push(...batch);
      offset += batch.length;
      if (batch.length < take) break;
    }
  } else {
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
        const q = new URLSearchParams(queryBase);
        q.set("resultOffset", String(offset));
        q.set("resultRecordCount", String(take));
        pagePromises.push(
          fetchEsriPage(`${serviceUrl}/query?${q.toString()}${extraSuffix}`)
        );
      }
      const jsonChunks = await Promise.all(pagePromises);
      let sawShortPage = false;
      for (const gj of jsonChunks) {
        const norm = normalizeEsriResponseToGeoJson(gj);
        const batch = norm.features || [];
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
  }

  const trimmed =
    features.length > maxFeatures ? features.slice(0, maxFeatures) : features;

  if (qDec != null) quantizeGeoJsonFeatures(trimmed, qDec);

  const out = stripForMapbox({ type: "FeatureCollection", features: trimmed });
  try {
    writeCache(cfile, out);
  } catch (e) {
    console.warn("[esri] disk cache write failed:", e?.message || e);
  }
  return out;
}

module.exports = {
  SERVICES,
  fetchEsriGeoJson,
  stripForMapbox,
};
