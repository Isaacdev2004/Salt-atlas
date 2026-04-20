const fs = require("fs");
const path = require("path");

const inputPath = path.join(__dirname, "../data/raw/rail.geojson");
const outputDir = path.join(__dirname, "../data/derived");
const outputPath = path.join(outputDir, "rail.geojson");

// ensure folder exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const raw = JSON.parse(fs.readFileSync(inputPath, "utf8"));

const features = raw.features.map((f) => {
  const coords = f.geometry.coordinates;

  let lng = 0;
  let lat = 0;

  if (f.geometry.type === "LineString") {
    const mid = coords[Math.floor(coords.length / 2)];
    lng = mid[0];
    lat = mid[1];
  }

  if (f.geometry.type === "MultiLineString") {
    const firstLine = coords[0];
    const mid = firstLine[Math.floor(firstLine.length / 2)];
    lng = mid[0];
    lat = mid[1];
  }

  return {
    type: "Feature",
    properties: {
      name:
        `${f.properties.YARDNAME} RAIL TERMINAL` ||
        `${f.properties.RROWNER1_NAME} RAIL TERMINAL` ||
        "RAIL TERMINAL",
    },
    geometry: {
      type: "Point",
      coordinates: [lng, lat],
    },
  };
});

const geojson = {
  type: "FeatureCollection",
  features,
};

fs.writeFileSync(outputPath, JSON.stringify(geojson));

console.log("✅ Rail processed");
