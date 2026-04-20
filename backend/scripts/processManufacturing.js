const fs = require("fs");
const Papa = require("papaparse");
const path = require("path");

const csv = fs.readFileSync(
  path.join(__dirname, "../data/processed/manufacturing.csv"),
  "utf8"
);

const parsed = Papa.parse(csv, {
  header: true,
  skipEmptyLines: true,
});

let invalid = 0;

const features = parsed.data
  .slice(0, 1000) // adjust if needed
  .map((row) => {
    const lat = parseFloat(row.Latitude || row.latitude || row.lat || row.LAT);

    const lng = parseFloat(
      row.Longitude || row.longitude || row.lon || row.LON
    );

    if (isNaN(lat) || isNaN(lng)) {
      invalid++;
      return null;
    }

    const name =
      row.name ||
      row.company ||
      row.operator ||
      row.industry ||
      row.facility ||
      (row.city ? `${row.city} Manufacturing` : null);

    return {
      type: "Feature",
      properties: {
        name: name || "Manufacturing Facility",
      },
      geometry: {
        type: "Point",
        coordinates: [lng, lat],
      },
    };
  })
  .filter(Boolean);

fs.writeFileSync(
  path.join(__dirname, "../data/derived/manufacturing.geojson"),
  JSON.stringify({
    type: "FeatureCollection",
    features,
  })
);

console.log("✅ Manufacturing processed:", features.length);
console.log("❌ Invalid rows:", invalid);
if (lat < 20 || lat > 55 || lng < -130 || lng > -60) {
  console.log("⚠️ OUTSIDE US:", lat, lng);
}
