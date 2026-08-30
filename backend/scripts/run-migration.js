// One-shot copy of the CampusPulse store from one managed Postgres to another,
// e.g. off a CockroachDB Cloud trial and onto AWS RDS before the trial deletes
// the cluster. It reuses copyStore() from migrate-postgres.js unchanged; the
// only thing it adds is an explicit TLS setting on both connections.
//
// The stock migrate-postgres.js opens `new Client({ connectionString })` with
// no ssl option, which fails against providers that require TLS but do not hand
// you a locally-resolvable root certificate (both CockroachDB Cloud and RDS).
// We connect the same way the running app does — ssl with rejectUnauthorized
// false (see postgres-database.js) — which encrypts the link without needing
// the CA file on disk. That is appropriate for a one-time operator-run copy.
//
// Usage (run it from the backend/ directory so `pg` resolves):
//   cd /opt/campuspulse/backend
//   SOURCE_DATABASE_URL='postgresql://…cockroachlabs.cloud…/defaultdb' \
//   TARGET_DATABASE_URL='postgresql://…rds.amazonaws.com:5432/campuspulse' \
//   MIGRATION_CONFIRM=copy-campuspulse \
//   node scripts/run-migration.js
//
// Add ALLOW_TARGET_OVERWRITE=true only to overwrite an RDS that already holds a
// CampusPulse store (a re-run after a first partial attempt, say).
const { Client } = require("pg");
const { copyStore } = require("./migrate-postgres");

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  if (process.env.MIGRATION_CONFIRM !== "copy-campuspulse") {
    throw new Error("Set MIGRATION_CONFIRM=copy-campuspulse to confirm the database copy");
  }
  const result = await copyStore({
    sourceUrl: required("SOURCE_DATABASE_URL"),
    targetUrl: required("TARGET_DATABASE_URL"),
    allowOverwrite: process.env.ALLOW_TARGET_OVERWRITE === "true",
    createClient: (connectionString) =>
      new Client({ connectionString, ssl: { rejectUnauthorized: false } }),
  });
  console.log(
    `CampusPulse database copied and verified at revision ${result.revision}. ` +
      "Point DATABASE_URL at the target, set DATABASE_SSL=true, and restart the API.",
  );
}

main().catch((error) => {
  console.error(`CampusPulse database migration failed: ${error.message}`);
  process.exitCode = 1;
});
