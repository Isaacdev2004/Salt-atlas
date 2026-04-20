/**
 * db.js
 *
 * Exports:
 *   pool          - pg connection pool (default export for drop-in compat)
 *   getWeights()  - async fn that returns scoring weights from the DB,
 *                   falling back to hardcoded equal weights if the table is
 *                   unreachable or empty.
 */

const { Pool } = require("pg");

// ---------------------------------------------------------------------------
// Connection pool
// ---------------------------------------------------------------------------

const isProd = !!process.env.DATABASE_URL;

const pool = isProd
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : new Pool({
      connectionString: "postgres://localhost:5432/saltatlas",
    });

// ---------------------------------------------------------------------------
// Fallback weights - used when DB is unavailable or scoring_weights is empty.
// Must match metric_name values seeded in init.sql.
// ---------------------------------------------------------------------------
const FALLBACK_WEIGHTS = {
  population:     0.33,
  median_income:  0.33,
  business_count: 0.33,
};

// ---------------------------------------------------------------------------
// getWeights()
//
// Reads scoring_weights from Postgres and returns a plain object:
//   { population: number, median_income: number, business_count: number }
//
// Falls back to FALLBACK_WEIGHTS so the app stays up even if the table is
// missing (e.g. during local dev before init.sql has been run).
// ---------------------------------------------------------------------------
async function getWeights() {
  try {
    const result = await pool.query(
      "SELECT metric_name, weight FROM scoring_weights"
    );

    if (!result.rows.length) {
      console.warn("scoring_weights table is empty — using fallback weights");
      return { ...FALLBACK_WEIGHTS };
    }

    const weights = {};
    result.rows.forEach(({ metric_name, weight }) => {
      weights[metric_name] = Number(weight);
    });

    // Fill in any missing keys with fallback so the scorer never crashes
    Object.keys(FALLBACK_WEIGHTS).forEach((key) => {
      if (weights[key] === undefined) {
        console.warn(`scoring_weights missing "${key}" — using fallback value`);
        weights[key] = FALLBACK_WEIGHTS[key];
      }
    });

    return weights;
  } catch (err) {
    console.warn("Could not read scoring_weights — using fallback weights:", err.message);
    return { ...FALLBACK_WEIGHTS };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

// Keep `module.exports = pool` as the default so existing requires like
//   const pool = require('./db')
// in server.js continue to work without any changes.
module.exports = pool;
module.exports.getWeights = getWeights;
