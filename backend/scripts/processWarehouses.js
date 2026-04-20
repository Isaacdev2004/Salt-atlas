const fs = require("fs");
const Papa = require("papaparse");
const path = require("path");

const csv = fs.readFileSync(
  path.join(__dirname, "../data/raw/warehouses.csv"),
  "utf8"
);

const parsed = Papa.parse(csv, {
  header: true,
  skipEmptyLines: true,
});

const features = parsed.data
  .slice(0, 800)
  .map((row) => {
    const lat = parseFloat(row.lat);
    const lng = parseFloat(row.lon);

    if (isNaN(lat) || isNaN(lng)) return null;

    return {
      type: "Feature",
      properties: {
        name: `${row.City} Warehouse Hub`,
      },
      geometry: {
        type: "Point",
        coordinates: [lng, lat],
      },
    };
  })
  .filter(Boolean);

const geojson = {
  type: "FeatureCollection",
  features,
};

fs.writeFileSync(
  path.join(__dirname, "../data/derived/warehouses.geojson"),
  JSON.stringify(geojson)
);

console.log("✅ Warehouses processed");
