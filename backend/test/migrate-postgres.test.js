const assert = require("node:assert/strict");
const test = require("node:test");

const { initialData } = require("../src/database");
const { copyStore } = require("../scripts/migrate-postgres");

test("the PostgreSQL migration copies and verifies the complete store", async () => {
  const sourceData = initialData({});
  sourceData.users.push({ id: "user-1", name: "Migration Test" });
  const targetState = { row: null };
  const ended = [];

  const source = {
    async connect() {},
    async query() {
      return { rows: [{ data: sourceData, revision: "42" }] };
    },
    async end() {
      ended.push("source");
    },
  };
  const target = {
    async connect() {},
    async query(sql, parameters = []) {
      const text = String(sql);
      if (text.includes("SELECT 1 FROM campuspulse_store")) {
        return { rows: targetState.row ? [{ exists: 1 }] : [] };
      }
      if (text.includes("INSERT INTO campuspulse_store")) {
        targetState.row = {
          data: JSON.parse(parameters[0]),
          revision: String(parameters[1]),
        };
        return { rows: [] };
      }
      if (text.includes("SELECT data, revision FROM campuspulse_store")) {
        return { rows: targetState.row ? [targetState.row] : [] };
      }
      return { rows: [] };
    },
    async end() {
      ended.push("target");
    },
  };

  const result = await copyStore({
    sourceUrl: "postgres://source",
    targetUrl: "postgres://target",
    createClient: (url) => (url.includes("source") ? source : target),
  });

  assert.equal(result.revision, "42");
  assert.deepEqual(targetState.row.data, sourceData);
  assert.deepEqual(ended.sort(), ["source", "target"]);
});
