const { Pool } = require("pg");
const {
  courseJoinCodesNeedPersistence,
  initialData,
  normalizeData,
} = require("./database");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createPostgresStore(connectionString, options = {}) {
  const env = options.env || process.env;
  const pool = new Pool({
    connectionString,
    ssl: options.ssl ? { rejectUnauthorized: false } : undefined,
    max: Number(options.maxConnections || 5),
  });
  let ready;
  let queue = Promise.resolve();

  function ensureTable() {
    if (!ready) {
      ready = pool.query(`
        CREATE TABLE IF NOT EXISTS campuspulse_store (
          id INTEGER PRIMARY KEY,
          data JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    }
    return ready;
  }

  async function load(client = pool, persistJoinCodes = false) {
    await ensureTable();
    const result = await client.query(
      "SELECT data FROM campuspulse_store WHERE id = 1",
    );
    const source = result.rows[0]?.data || initialData(env);
    const data = normalizeData(source, env);
    if (
      persistJoinCodes &&
      result.rows[0] &&
      courseJoinCodesNeedPersistence(source, data)
    ) {
      await client.query(
        "UPDATE campuspulse_store SET data = $1::jsonb, updated_at = NOW() WHERE id = 1",
        [JSON.stringify(data)],
      );
    }
    return data;
  }

  return {
    read() {
      const operation = queue.then(async () => clone(await load(pool, true)));
      // Legacy-code migration is a write. Keep reads serialized so two first
      // requests cannot generate and return different TA codes.
      queue = operation.catch(() => {});
      return operation;
    },
    update(mutator) {
      const operation = queue.then(async () => {
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
          const value = await mutator(data);
          await client.query(
            "UPDATE campuspulse_store SET data = $1::jsonb, updated_at = NOW() WHERE id = 1",
            [JSON.stringify(data)],
          );
          await client.query("COMMIT");
          return clone(value);
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      });
      queue = operation.catch(() => {});
      return operation;
    },
    type: "postgres",
  };
}

module.exports = { createPostgresStore };
