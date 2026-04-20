const fs = require("fs");
const path = require("path");

const inputPath = path.join(__dirname, "../data/raw/ports.geojson");
const outputPath = path.join(__dirname, "../data/derived/ports.geojson");

// Multi-region US bounds (divided into shapes to select parts of the US)
const US_AREAS = [
  // Contiguous US
  {
    name: "lower48",
    minLng: -125.0,
    maxLng: -66.5,
    minLat: 24.0,
    maxLat: 49.8,
  },
  // Alaska
  {
    name: "alaska",
    minLng: -179.1,
    maxLng: -129.9,
    minLat: 51.2,
    maxLat: 71.4,
  },
  // Alaska Aleutians crossing the antimeridian (positive longitudes)
  {
    name: "alaska_aleutians",
    minLng: 172.0,
    maxLng: 180.0,
    minLat: 51.0,
    maxLat: 55.5,
  },
  // Hawaii
  {
    name: "hawaii",
    minLng: -161.5,
    maxLng: -154.0,
    minLat: 18.5,
    maxLat: 22.8,
  },
  // Puerto Rico
  {
    name: "puerto_rico",
    minLng: -67.9454,
    maxLng: -65.2207,
    minLat: 17.8832,
    maxLat: 18.5156,
  },
  // US Virgin Islands
  { name: "usvi", minLng: -65.2, maxLng: -64.3, minLat: 17.5, maxLat: 18.5 },
  // Guam
  { name: "guam", minLng: 144.3, maxLng: 145.1, minLat: 13.1, maxLat: 13.8 },
  // American Samoa
  {
    name: "american_samoa",
    minLng: -171.2,
    maxLng: -168.9,
    minLat: -14.6,
    maxLat: -10.8,
  },
  // Northern Mariana Islands
  {
    name: "northern_mariana",
    minLng: 144.7,
    maxLng: 146.2,
    minLat: 14.0,
    maxLat: 20.8,
  },
];

const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const inBounds = (lng, lat, box) => {
  return (
    lng >= box.minLng &&
    lng <= box.maxLng &&
    lat >= box.minLat &&
    lat <= box.maxLat
  );
};

const inUSAreas = (lng, lat) => {
  return US_AREAS.some((box) => inBounds(lng, lat, box));
};

const averageCoords = (coords) => {
  let count = 0;
  let lngSum = 0;
  let latSum = 0;

  const walk = (node) => {
    if (!Array.isArray(node)) return;

    if (
      node.length >= 2 &&
      typeof node[0] === "number" &&
      typeof node[1] === "number"
    ) {
      lngSum += node[0];
      latSum += node[1];
      count += 1;
      return;
    }

    for (const child of node) {
      walk(child);
    }
  };

  walk(coords);

  if (!count) return null;

  return [lngSum / count, latSum / count];
};

const pointFromFeature = (feature) => {
  if (!feature || feature.type !== "Feature" || !feature.geometry) return null;

  const { type, coordinates } = feature.geometry;

  if (type === "Point") {
    const lng = toNumber(coordinates?.[0]);
    const lat = toNumber(coordinates?.[1]);
    if (lng === null || lat === null) return null;
    return [lng, lat];
  }

  if (
    type === "LineString" ||
    type === "MultiLineString" ||
    type === "Polygon" ||
    type === "MultiPolygon"
  ) {
    return averageCoords(coordinates);
  }

  return null;
};

const featureName = (props = {}) => {
  return (
    props.name ||
    props.NAME ||
    props.Name ||
    props.FEATURENAME ||
    props.port_name ||
    props.Port ||
    props.port ||
    props.harbour ||
    props["name:en"] ||
    "Port"
  );
};

const geoJSONFeatureFromArcGIS = (feature) => {
  const props = feature.attributes || feature.properties || {};
  const g = feature.geometry || {};

  if (typeof g.x === "number" && typeof g.y === "number") {
    return {
      type: "Feature",
      properties: props,
      geometry: { type: "Point", coordinates: [g.x, g.y] },
    };
  }

  if (Array.isArray(g.paths)) {
    return {
      type: "Feature",
      properties: props,
      geometry: { type: "MultiLineString", coordinates: g.paths },
    };
  }

  if (Array.isArray(g.rings)) {
    return {
      type: "Feature",
      properties: props,
      geometry: { type: "Polygon", coordinates: g.rings },
    };
  }

  return null;
};

const geoJSONFeatureFromOverpass = (el) => {
  const props = el.tags || {};

  if (el.type === "node") {
    const lon = toNumber(el.lon);
    const lat = toNumber(el.lat);
    if (lon === null || lat === null) return null;
    return {
      type: "Feature",
      properties: props,
      geometry: { type: "Point", coordinates: [lon, lat] },
    };
  }

  if (Array.isArray(el.geometry) && el.geometry.length) {
    const coords = el.geometry
      .map((p) => [toNumber(p.lon), toNumber(p.lat)])
      .filter((p) => p[0] !== null && p[1] !== null);

    if (!coords.length) return null;

    return {
      type: "Feature",
      properties: props,
      geometry: { type: "LineString", coordinates: coords },
    };
  }

  return null;
};

const normalizeInputToFeatures = (raw) => {
  // GeoJSON FeatureCollection
  if (Array.isArray(raw.features) && raw.type === "FeatureCollection") {
    return raw.features;
  }

  // ArcGIS JSON FeatureSet
  if (Array.isArray(raw.features)) {
    return raw.features.map(geoJSONFeatureFromArcGIS).filter(Boolean);
  }

  // Overpass JSON
  if (Array.isArray(raw.elements)) {
    return raw.elements.map(geoJSONFeatureFromOverpass).filter(Boolean);
  }

  return [];
};

if (!fs.existsSync(inputPath)) {
  console.error(`❌ Missing input file: ${inputPath}`);
  console.error(
    "Place your downloaded ports JSON/GeoJSON at backend/data/raw/ports.geojson"
  );
  process.exit(1);
}

let raw;
try {
  raw = JSON.parse(fs.readFileSync(inputPath, "utf8"));
} catch (error) {
  console.error(`❌ Could not parse JSON in ${inputPath}`);
  console.error("Make sure the file is a single valid JSON object.");
  console.error(error.message);
  process.exit(1);
}

const rawFeatures = normalizeInputToFeatures(raw);

if (!rawFeatures.length) {
  console.error(
    "❌ No features found. Input must be GeoJSON, ArcGIS JSON, or Overpass JSON."
  );
  process.exit(1);
}

const normalized = [];
const seen = new Set();

for (const feature of rawFeatures) {
  const point = pointFromFeature(feature);
  if (!point) continue;

  const [lng, lat] = point;
  if (!inUSAreas(lng, lat)) continue;

  const name = String(featureName(feature.properties || {})).trim() || "Port";

  // De-duplicate near-identical points by name+rounded coordinate key
  const key = `${name.toLowerCase()}|${lng.toFixed(5)}|${lat.toFixed(5)}`;
  if (seen.has(key)) continue;
  seen.add(key);

  normalized.push({
    type: "Feature",
    properties: { name },
    geometry: {
      type: "Point",
      coordinates: [lng, lat],
    },
  });
}

fs.writeFileSync(
  outputPath,
  JSON.stringify(
    {
      type: "FeatureCollection",
      features: normalized,
    },
    null,
    2
  )
);

console.log(`✅ Ports processed: ${normalized.length}`);
console.log(`📥 Input features: ${rawFeatures.length}`);
console.log(`📤 Output points: ${normalized.length}`);
