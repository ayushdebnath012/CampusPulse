const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { createApp } = require("../src/app");

const CLASS_SIZE = 310;

async function startServer() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "campuspulse-load-"));
  const { app, store } = createApp({
    databasePath: path.join(directory, "campuspulse.json"),
    env: { NODE_ENV: "test" },
  });
  const crashes = [];
  process.on("uncaughtException", (error) => crashes.push(error));
  process.on("unhandledRejection", (error) => crashes.push(error));
  const server = await new Promise((resolve) => {
    // A class arrives together, so the accept queue has to hold the whole room.
    const listening = app.listen(0, "127.0.0.1", 1024, () => resolve(listening));
  });
  server.on("error", (error) => crashes.push(error));
  return {
    store,
    crashes,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

async function call(baseUrl, route, { method = "GET", token, body } = {}) {
  // Loopback on Windows runs out of ephemeral ports long before the server runs
  // out of capacity, and that shows up as ECONNREFUSED/ECONNRESET on connect.
  // Real clients are separate devices, so a transport refusal is retried rather
  // than counted as a server failure; a status is still reported faithfully.
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}${route}`, {
        method,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    } catch (error) {
      const code = error?.cause?.code || error?.code || "";
      const transport = ["ECONNREFUSED", "ECONNRESET", "EADDRNOTAVAIL", "UND_ERR_SOCKET"];
      if (!transport.includes(code) || attempt >= 8) {
        return { status: 0, body: { error: String(error?.cause?.code || error?.message) } };
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
    }
  }
}

function rollNumber(index) {
  return `24LOAD${String(index).padStart(4, "0")}`;
}

test(`${CLASS_SIZE} students mark attendance at once without losing anyone`, async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const professor = await call(server.baseUrl, "/api/auth/signup", {
    method: "POST",
    body: {
      role: "faculty",
      name: "Load Professor",
      department: "Mechanical Engineering",
      email: "load.professor@mech.iitkgp.ac.in",
      password: "a-good-password",
      phone: "9876543210",
    },
  });
  assert.equal(professor.status, 201);
  const professorToken = professor.body.token;

  const course = await call(server.baseUrl, "/api/courses", {
    method: "POST",
    token: professorToken,
    body: { name: "Big Hall", courseCode: "BIG101", department: "Mechanical Engineering" },
  });
  assert.equal(course.status, 201);
  const courseId = course.body.course.id;
  const joinCode = course.body.course.studentCode || course.body.course.code;

  const roster = await call(
    server.baseUrl,
    `/api/courses/${encodeURIComponent(courseId)}/roster`,
    {
      method: "PUT",
      token: professorToken,
      body: {
        students: Array.from({ length: CLASS_SIZE }, (_unused, index) => ({
          serial: index + 1,
          rollNumber: rollNumber(index),
          name: `Student ${index + 1}`,
        })),
      },
    },
  );
  assert.equal(roster.status, 200, JSON.stringify(roster.body));

  // A whole class signs up and enrols.
  const students = await Promise.all(
    Array.from({ length: CLASS_SIZE }, async (_unused, index) => {
      const created = await call(server.baseUrl, "/api/auth/signup", {
        method: "POST",
        body: {
          role: "student",
          name: `Student ${index + 1}`,
          department: "Mechanical Engineering",
          email: `load.student.${index}@kgpian.iitkgp.ac.in`,
          password: "a-good-password",
          phone: "9876543210",
          rollNumber: rollNumber(index),
          hall: "Nehru Hall",
        },
      });
      return { index, status: created.status, token: created.body.token };
    }),
  );
  assert.equal(
    students.filter((student) => student.status !== 201).length,
    0,
    "every sign-up should succeed",
  );

  const joins = await Promise.all(
    students.map((student) =>
      call(server.baseUrl, "/api/courses/join", {
        method: "POST",
        token: student.token,
        body: { code: joinCode, rollNumber: rollNumber(student.index) },
      }),
    ),
  );
  const failedJoins = joins.filter((join) => join.status >= 400);
  assert.equal(
    failedJoins.length,
    0,
    `every student should join: ${JSON.stringify(failedJoins[0]?.body)}`,
  );

  const opened = await call(server.baseUrl, "/api/attendance/sessions", {
    method: "POST",
    token: professorToken,
    body: { courseId, location: { latitude: 22.3149, longitude: 87.3105, accuracy: 12 } },
  });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const sessionId = opened.body.attendance.id;

  const code = await call(
    server.baseUrl,
    `/api/attendance/${encodeURIComponent(sessionId)}/code`,
    { token: professorToken },
  );
  assert.equal(code.status, 200);
  const proximityCode = code.body.code;

  // The moment that matters: the whole hall taps "mark me present" together.
  const started = Date.now();
  const checkIns = await Promise.all(
    students.map((student) =>
      call(
        server.baseUrl,
        `/api/attendance/${encodeURIComponent(sessionId)}/check-in`,
        {
          method: "POST",
          token: student.token,
          body: {
            rollNumber: rollNumber(student.index),
            signals: { wifi: true, bluetooth: true }, location: { latitude: 22.31492, longitude: 87.31053, accuracy: 15 },
            code: proximityCode,
          },
        },
      ),
    ),
  );
  const elapsed = Date.now() - started;

  const rejected = checkIns.filter((entry) => entry.status >= 400);
  assert.equal(
    rejected.length,
    0,
    `every student should be marked present: ${rejected.length} failed, first ${JSON.stringify(rejected[0]?.body)}`,
  );

  // Every single mark has to survive: concurrent writes must not overwrite one
  // another, which is exactly what a shared document is prone to.
  const finalState = await call(
    server.baseUrl,
    `/api/attendance/${encodeURIComponent(sessionId)}`,
    { token: professorToken },
  );
  assert.equal(finalState.status, 200);
  const present = finalState.body.attendance.records.filter((record) => record.present);
  assert.equal(
    present.length,
    CLASS_SIZE,
    `all ${CLASS_SIZE} marks must persist, found ${present.length}`,
  );
  assert.equal(
    new Set(present.map((record) => record.rollNumber)).size,
    CLASS_SIZE,
    "each student appears exactly once",
  );

  assert.ok(
    elapsed < 30000,
    `${CLASS_SIZE} concurrent check-ins took ${elapsed}ms, which is too slow for a class`,
  );
  console.log(`    ${CLASS_SIZE} concurrent check-ins completed in ${elapsed}ms`);

  // Closing writes a personally worded notification for every student. The
  // professor must not be left waiting on that fan-out.
  const closingStarted = Date.now();
  const closed = await call(
    server.baseUrl,
    `/api/attendance/${encodeURIComponent(sessionId)}/close`,
    { method: "POST", token: professorToken, body: {} },
  );
  const closingElapsed = Date.now() - closingStarted;
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.ok(
    closingElapsed < 10000,
    `closing a ${CLASS_SIZE}-student register took ${closingElapsed}ms`,
  );
  console.log(`    closing a ${CLASS_SIZE}-student register took ${closingElapsed}ms`);

  // Every student still gets told their result.
  const stored = await server.store.read();
  const closingNotices = stored.notifications.filter(
    (item) => item.type === "attendance" && /marked (present|absent)/i.test(item.title),
  );
  assert.equal(
    closingNotices.length,
    CLASS_SIZE,
    `every student should be told their result, got ${closingNotices.length}`,
  );
});
