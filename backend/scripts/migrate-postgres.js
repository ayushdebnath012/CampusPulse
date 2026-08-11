const assert = require("node:assert/strict");
const { Client } = require("pg");

const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS campuspulse_store (
    id INTEGER PRIMARY KEY,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revision BIGINT NOT NULL DEFAULT 0
  )
`;

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function copyStore({
  sourceUrl,
  targetUrl,
  allowOverwrite = false,
  createClient = (connectionString) => new Client({ connectionString }),
}) {
  if (sourceUrl === targetUrl) throw new Error("Source and target databases are identical");
  const source = createClient(sourceUrl);
  const target = createClient(targetUrl);

  try {
    await Promise.all([source.connect(), target.connect()]);
    const sourceResult = await source.query(
      "SELECT data, revision FROM campuspulse_store WHERE id = 1",
    );
    if (!sourceResult.rows[0]) throw new Error("The source CampusPulse store is empty");
    const sourceRow = sourceResult.rows[0];

    await target.query("BEGIN");
    try {
      await target.query(TABLE_SQL);
      await target.query(
        "ALTER TABLE campuspulse_store ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 0",
      );
      const existing = await target.query(
        "SELECT 1 FROM campuspulse_store WHERE id = 1",
      );
      if (existing.rows.length && !allowOverwrite) {
        throw new Error(
          "The target already contains CampusPulse data; set ALLOW_TARGET_OVERWRITE=true to replace it",
        );
      }
      await target.query(
        `INSERT INTO campuspulse_store (id, data, revision, updated_at)
         VALUES (1, $1::jsonb, $2::bigint, NOW())
         ON CONFLICT (id) DO UPDATE
         SET data = EXCLUDED.data,
             revision = EXCLUDED.revision,
             updated_at = NOW()`,
        [JSON.stringify(sourceRow.data), String(sourceRow.revision || 0)],
      );
      await target.query("COMMIT");
    } catch (error) {
      await target.query("ROLLBACK").catch(() => {});
      throw error;
    }

    const verified = await target.query(
      "SELECT data, revision FROM campuspulse_store WHERE id = 1",
    );
    assert.deepEqual(verified.rows[0]?.data, sourceRow.data);
    assert.equal(String(verified.rows[0]?.revision), String(sourceRow.revision || 0));
    return { revision: String(sourceRow.revision || 0) };
  } finally {
    await Promise.allSettled([source.end(), target.end()]);
  }
}

async function main() {
  if (process.env.MIGRATION_CONFIRM !== "copy-campuspulse") {
    throw new Error("Set MIGRATION_CONFIRM=copy-campuspulse to confirm the database copy");
  }
  const result = await copyStore({
    sourceUrl: required("SOURCE_DATABASE_URL"),
    targetUrl: required("TARGET_DATABASE_URL"),
    allowOverwrite: process.env.ALLOW_TARGET_OVERWRITE === "true",
  });
  console.log(`CampusPulse database copied and verified at revision ${result.revision}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`CampusPulse database migration failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { copyStore };
