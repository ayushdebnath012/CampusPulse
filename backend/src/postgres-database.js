const { Pool } = require("pg");
const {
  clone,
  courseJoinCodesNeedPersistence,
  createBatchingUpdater,
  initialData,
  normalizeData,
} = require("./database");

// Shipping every uploaded file back from Postgres cost more than the rest of a
// request put together, so material bytes are projected out of the shared
// document and fetched only by the one route that downloads them.
const READ_PROJECTION = `
  SELECT
    CASE
      WHEN jsonb_typeof(data->'courseMaterials') = 'array' THEN
        jsonb_set(data, '{courseMaterials}', COALESCE((
          SELECT jsonb_agg(item - 'dataBase64' ORDER BY ord)
          FROM jsonb_array_elements(data->'courseMaterials')
            WITH ORDINALITY AS elements(item, ord)
        ), '[]'::jsonb))
      ELSE data
    END AS data,
    revision
  FROM campuspulse_store
  WHERE id = 1
`;

function withoutMaterialBytes(data) {
  return {
    ...data,
    courseMaterials: (data.courseMaterials || []).map(
      ({ dataBase64: _bytes, ...metadata }) => metadata,
    ),
  };
}

function createPostgresStore(connectionString, options = {}) {
  const env = options.env || process.env;
  const pool = new Pool({
    connectionString,
    ssl: options.ssl ? { rejectUnauthorized: false } : undefined,
    max: Number(options.maxConnections || 10),
  });
  let ready;
  // The document last read from Postgres, reused until a write moves the
  // revision on. A sign-in storm then costs one load instead of one per user.
  let cache = null;
  let inFlightRead = null;

  function ensureTable() {
    if (!ready) {
      ready = (async () => {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS campuspulse_store (
            id INTEGER PRIMARY KEY,
            data JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        // Compared far more cheaply than the document itself, and unlike a
        // timestamp it always moves for two writes in the same instant.
        await pool.query(
          "ALTER TABLE campuspulse_store ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 0",
        );
      })().catch((error) => {
        ready = undefined;
        throw error;
      });
    }
    return ready;
  }

  async function currentRevision() {
    const result = await pool.query(
      "SELECT revision FROM campuspulse_store WHERE id = 1",
    );
    return result.rows[0] ? Number(result.rows[0].revision) : null;
  }

  async function loadFresh() {
    const result = await pool.query(READ_PROJECTION);
    const row = result.rows[0];
    const source = row?.data || initialData(env);
    const data = normalizeData(source, env);
    if (row && courseJoinCodesNeedPersistence(source, data)) {
      // Generated legacy TA codes must survive the response that first revealed
      // them. `data` has material bytes projected out, so the stored blobs are
      // carried across rather than overwritten with nothing.
      await pool.query(
        `UPDATE campuspulse_store
         SET data = jsonb_set(
               $1::jsonb,
               '{courseMaterials}',
               COALESCE(data->'courseMaterials', '[]'::jsonb)
             ),
             revision = revision + 1,
             updated_at = NOW()
         WHERE id = 1`,
        [JSON.stringify({ ...data, courseMaterials: [] })],
      );
    }
    return { data, revision: await currentRevision() };
  }

  async function readSnapshot() {
    await ensureTable();
    if (cache) {
      const revision = await currentRevision();
      if (revision !== null && revision === cache.revision) return cache.data;
    }
    cache = await loadFresh();
    return cache.data;
  }

  const runUpdates = createBatchingUpdater(async (apply) => {
    await ensureTable();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO campuspulse_store (id, data)
         VALUES (1, $1::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [JSON.stringify(initialData(env))],
      );
      const result = await client.query(
        "SELECT data FROM campuspulse_store WHERE id = 1 FOR UPDATE",
      );
      const data = normalizeData(result.rows[0].data, env);
      const outcome = await apply(data);
      const saved = await client.query(
        `UPDATE campuspulse_store
         SET data = $1::jsonb, revision = revision + 1, updated_at = NOW()
         WHERE id = 1
         RETURNING revision`,
        [JSON.stringify(data)],
      );
      await client.query("COMMIT");
      // Serve what was just written rather than reloading it.
      cache = {
        data: withoutMaterialBytes(data),
        revision: Number(saved.rows[0].revision),
      };
      return outcome;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      cache = null;
      throw error;
    } finally {
      client.release();
    }
  });

  return {
    read() {
      // Callers arriving together share one load instead of queueing behind one
      // another, which is what turned a burst of sign-ins into timeouts.
      if (!inFlightRead) {
        inFlightRead = readSnapshot().finally(() => {
          inFlightRead = null;
        });
      }
      return inFlightRead.then(clone);
    },
    update(mutator) {
      return runUpdates(mutator);
    },
    async readMaterialBlob(materialId) {
      await ensureTable();
      const result = await pool.query(
        `SELECT item->>'dataBase64' AS bytes
         FROM campuspulse_store, jsonb_array_elements(data->'courseMaterials') AS item
         WHERE id = 1 AND item->>'id' = $1
         LIMIT 1`,
        [String(materialId)],
      );
      return result.rows[0]?.bytes || null;
    },
    type: "postgres",
  };
}

module.exports = { createPostgresStore };
