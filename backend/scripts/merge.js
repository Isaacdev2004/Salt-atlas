const fs = require("fs");

// ---------------------------------------------------------------------------
// merge.js - Data merging ONLY
// Outputs raw values: population, median_income, business_count
// Normalization and scoring are handled at serve-time in server.js
// ---------------------------------------------------------------------------

// Load raw files
const census = JSON.parse(fs.readFileSync("./data/raw/census.json"));
const business = JSON.parse(fs.readFileSync("./data/raw/business.json"));

// Strip header rows
const censusRows = census.slice(1);
const businessRows = business.slice(1);

// Build FIPS → establishment count lookup from business data
const businessMap = {};

businessRows.forEach(([estab, state, county]) => {
  const fips = state + county;
  businessMap[fips] = Number(estab) || 0;
});

// Merge census rows with business counts, preserving raw values
const result = [];

censusRows.forEach(([pop, income, state, county]) => {
  const fips = state + county;

  result.push({
    fips,
    population: Number(pop) || 0,
    median_income: Number(income) || 0,
    business_count: businessMap[fips] || 0,
  });
});

// Convert to CSV with raw column names
let csv = "fips,population,median_income,business_count\n";

result.forEach((r) => {
  csv += `${r.fips},${r.population},${r.median_income},${r.business_count}\n`;
});

// Save
fs.writeFileSync("./data/derived/regions.csv", csv);

console.log(`✅ regions.csv created — ${result.length} counties merged (raw values only)`);
