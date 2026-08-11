const assert = require("node:assert/strict");
const test = require("node:test");

const { initialData } = require("../src/database");
const { createPostgresStore } = require("../src/postgres-database");

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("a failed write cannot null the cache underneath an in-flight read", async () => {
  const document = initialData({});
  const revisionQuery = deferred();
  let delayRevision = false;

  const client = {
    async query(sql) {
      if (String(sql).includes("SELECT data FROM campuspulse_store")) {
        return { rows: [{ data: document }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    async query(sql) {
      const text = String(sql);
      if (text.includes("CASE") && text.includes("courseMaterials")) {
        return { rows: [{ data: document, revision: 1 }] };
      }
      if (text.includes("SELECT revision")) {
        return delayRevision
          ? revisionQuery.promise
          : { rows: [{ revision: 1 }] };
      }
      return { rows: [] };
    },
    async connect() {
      return client;
    },
  };

  const store = createPostgresStore("postgres://test", { pool, env: {} });
  await store.read();

  delayRevision = true;
  const reading = store.read();
  await assert.rejects(
    store.update(() => {
      throw new Error("write failed");
    }),
    /write failed/,
  );
  revisionQuery.resolve({ rows: [{ revision: 1 }] });

  const snapshot = await reading;
  assert.deepEqual(snapshot, document);
});
