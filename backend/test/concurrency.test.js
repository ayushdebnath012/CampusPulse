const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { createApp } = require("../src/app");
const { createBatchingUpdater } = require("../src/database");

async function temporaryDatabasePath() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "campuspulse-load-"));
  return path.join(directory, "campuspulse.json");
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

function studentSignup(index) {
  return {
    role: "student",
    name: `Load Student ${index}`,
    email: `load.student.${index}@kgpian.iitkgp.ac.in`,
    department: "Mechanical Engineering",
    phone: "+91 90000 00000",
    rollNumber: `24LOAD${String(index).padStart(3, "0")}`,
    hall: "Nehru Hall",
    password: "correct-horse-battery",
  };
}

test("a room signing in at once is served without failures", async (t) => {
  const databasePath = await temporaryDatabasePath();
  const { app } = createApp({
    databasePath,
    env: { NODE_ENV: "test", ALLOW_DEV_VERIFICATION_CODE: "false" },
  });
  const { server, origin } = await listen(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const accounts = 40;
  const signups = await Promise.all(
    Array.from({ length: accounts }, (_unused, index) =>
      fetch(`${origin}/api/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(studentSignup(index)),
      }),
    ),
  );
  const failedSignups = signups.filter((response) => !response.ok);
  assert.equal(
    failedSignups.length,
    0,
    `expected every sign-up to succeed, ${failedSignups.length} failed`,
  );

  // Every account exists exactly once: batched writes must not lose or
  // duplicate a mutation when they share one load-and-save cycle.
  const health = await (await fetch(`${origin}/api/health`)).json();
  assert.equal(health.ok, true);
  const stored = JSON.parse(await fs.readFile(databasePath, "utf8"));
  assert.equal(stored.users.length, accounts);
  assert.equal(new Set(stored.users.map((user) => user.email)).size, accounts);

  const started = Date.now();
  const logins = await Promise.all(
    Array.from({ length: accounts }, (_unused, index) =>
      fetch(`${origin}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: "student",
          email: studentSignup(index).email,
          password: "correct-horse-battery",
        }),
      }),
    ),
  );
  const elapsed = Date.now() - started;

  const failedLogins = logins.filter((response) => response.status !== 200);
  assert.equal(
    failedLogins.length,
    0,
    `expected every sign-in to succeed, ${failedLogins.length} failed`,
  );

  const tokens = await Promise.all(logins.map((response) => response.json()));
  assert.equal(new Set(tokens.map((body) => body.token)).size, accounts);

  // Each of the concurrent sign-ins keeps a usable session rather than being
  // evicted by a neighbour's write landing on a stale copy of the document.
  const sessions = await Promise.all(
    tokens.map((body) =>
      fetch(`${origin}/api/me`, {
        headers: { Authorization: `Bearer ${body.token}` },
      }),
    ),
  );
  assert.equal(
    sessions.filter((response) => response.status !== 200).length,
    0,
    "every freshly issued session should authenticate",
  );

  assert.ok(
    elapsed < 20000,
    `${accounts} concurrent sign-ins took ${elapsed}ms, which is far too slow`,
  );
});

test("concurrent reads share one load instead of one per caller", async (t) => {
  const databasePath = await temporaryDatabasePath();
  let loads = 0;
  const { app, store } = createApp({
    databasePath,
    env: { NODE_ENV: "test" },
  });
  const realRead = store.read.bind(store);
  store.read = () => {
    loads += 1;
    return realRead();
  };
  const { server, origin } = await listen(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  await Promise.all(
    Array.from({ length: 25 }, () => fetch(`${origin}/api/health`)),
  );
  assert.equal(loads, 25, "each request still asks the store for a snapshot");
});

test("batched writes replay individually when one mutator throws", async () => {
  let cycles = 0;
  let document = { value: [] };
  const update = createBatchingUpdater(async (apply) => {
    cycles += 1;
    const working = structuredClone(document);
    const outcome = await apply(working);
    document = working;
    return outcome;
  });

  const results = await Promise.allSettled([
    update((data) => {
      data.value.push("a");
      return "a";
    }),
    update(() => {
      throw new Error("rejected by the mutator");
    }),
    update((data) => {
      data.value.push("c");
      return "c";
    }),
  ]);

  assert.deepEqual(
    results.map((entry) => entry.status),
    ["fulfilled", "rejected", "fulfilled"],
  );
  assert.equal(results[0].value, "a");
  assert.equal(results[2].value, "c");
  // The failing mutator must not have committed anything, and must not have
  // discarded the work of the two it was batched with.
  assert.deepEqual(document.value, ["a", "c"]);
  assert.ok(cycles > 1, "a failed batch is replayed one mutator at a time");
});

test("a burst of writes costs a handful of database cycles, not one each", async () => {
  let cycles = 0;
  let document = { value: [] };
  const update = createBatchingUpdater(async (apply) => {
    cycles += 1;
    // Stand in for a Postgres round trip, which is what made one cycle per
    // caller unaffordable: 60 sign-ins meant 60 sequential loads and rewrites
    // of the whole shared document.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const working = structuredClone(document);
    const outcome = await apply(working);
    await new Promise((resolve) => setTimeout(resolve, 5));
    document = working;
    return outcome;
  });

  const writes = 60;
  await Promise.all(
    Array.from({ length: writes }, (_unused, index) =>
      update((data) => {
        data.value.push(index);
        return index;
      }),
    ),
  );

  assert.equal(document.value.length, writes, "every write must land");
  assert.deepEqual(
    [...document.value].sort((a, b) => a - b),
    Array.from({ length: writes }, (_unused, index) => index),
  );
  assert.ok(
    cycles <= 5,
    `${writes} concurrent writes should coalesce into a few cycles, took ${cycles}`,
  );
});

test("a mutator that throws leaves no partial write behind", async () => {
  let document = { value: [] };
  const update = createBatchingUpdater(async (apply) => {
    const working = structuredClone(document);
    const outcome = await apply(working);
    document = working;
    return outcome;
  });

  await assert.rejects(
    update((data) => {
      data.value.push("half-done");
      throw new Error("failed after mutating");
    }),
    /failed after mutating/,
  );
  assert.deepEqual(document.value, []);
});
