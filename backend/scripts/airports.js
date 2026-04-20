const fs = require("fs");
const Papa = require("papaparse");

const csv = fs.readFileSync("./data/raw/airports.csv", "utf8");

const parsed = Papa.parse(csv, {
  header: true,
  skipEmptyLines: true,
});

const features = parsed.data
  .filter((row) => row.iso_country === "US")
  .filter(
    (row) => row.type === "large_airport" || row.type === "medium_airport"
  )
  .map((row) => {
    const coordStr = row.coordinates?.replace(/"/g, "");
    if (!coordStr) return null;

    const parts = coordStr.split(",");
    if (parts.length !== 2) return null;

    const lat = parseFloat(parts[0].trim());
    const lng = parseFloat(parts[1].trim());

    if (isNaN(lat) || isNaN(lng)) return null;

    return {
      type: "Feature",
      properties: {
        name: row.name,
        type: row.type,
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

fs.writeFileSync("../backend/derived/airports.geojson", JSON.stringify(geojson));

console.log("✅ US airports generated");
