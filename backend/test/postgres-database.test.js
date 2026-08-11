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

  const store = createPostgresStore("postgres://test", {
    pool,
    env: {},
    cacheValidationTtlMs: 0,
  });
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

test("cached reads avoid repeated database revision traffic within the TTL", async () => {
  const document = initialData({});
  let loads = 0;
  let revisionChecks = 0;
  const pool = {
    async query(sql) {
      const text = String(sql);
      if (text.includes("CASE") && text.includes("courseMaterials")) {
        loads += 1;
        return { rows: [{ data: document, revision: 1 }] };
      }
      if (text.includes("SELECT revision")) revisionChecks += 1;
      return { rows: [] };
    },
  };
  const store = createPostgresStore("postgres://test", {
    pool,
    env: {},
    cacheValidationTtlMs: 10000,
  });

  await store.read();
  await store.read();

  assert.equal(loads, 1);
  assert.equal(revisionChecks, 0);
});

test("CockroachDB serialization failures retry the complete transaction", async () => {
  let document = initialData({});
  let revision = 0;
  let connections = 0;

  const pool = {
    async query() {
      return { rows: [] };
    },
    async connect() {
      connections += 1;
      const thisAttempt = connections;
      let pending = null;
      return {
        async query(sql, parameters = []) {
          const text = String(sql);
          if (text.includes("SELECT data FROM campuspulse_store")) {
            // `pg` parses a fresh JSON value for every result row; mirror that
            // isolation so a rolled-back attempt cannot mutate the fake source.
            return { rows: [{ data: structuredClone(document) }] };
          }
          if (text.includes("UPDATE campuspulse_store")) {
            pending = JSON.parse(parameters[0]);
            return { rows: [{ revision: revision + 1 }] };
          }
          if (text === "COMMIT") {
            if (thisAttempt === 1) {
              const error = new Error("restart transaction");
              error.code = "40001";
              throw error;
            }
            document = pending;
            revision += 1;
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };

  const store = createPostgresStore("postgres://test", {
    pool,
    env: {},
    transactionAttempts: 3,
  });
  const result = await store.update((data) => {
    data.users.push({ id: "user-1" });
    return "saved";
  });

  assert.equal(result, "saved");
  assert.equal(connections, 2);
  assert.deepEqual(document.users, [{ id: "user-1" }]);
});
