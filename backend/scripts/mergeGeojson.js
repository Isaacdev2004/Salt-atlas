const fs = require("fs");
const path = require("path");

const [, , outputFile, ...inputFiles] = process.argv;

if (!outputFile || inputFiles.length < 2) {
  console.error(
    "Usage: node scripts/mergeGeojson.js <output.geojson> <input1.geojson> <input2.geojson> [...]"
  );
  process.exit(1);
}

const allFeatures = [];

for (const file of inputFiles) {
  const fullPath = path.resolve(file);
  if (!fs.existsSync(fullPath)) {
    console.error(`❌ Missing file: ${fullPath}`);
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  } catch (error) {
    console.error(`❌ Invalid JSON in ${fullPath}`);
    console.error(error.message);
    process.exit(1);
  }

  const features = Array.isArray(parsed.features) ? parsed.features : [];
  allFeatures.push(...features);
  console.log(`➕ ${path.basename(file)}: ${features.length} features`);
}

const merged = {
  type: "FeatureCollection",
  features: allFeatures,
};

const outPath = path.resolve(outputFile);
fs.writeFileSync(outPath, JSON.stringify(merged, null, 2));
console.log(`✅ Wrote ${allFeatures.length} features to ${outPath}`);
