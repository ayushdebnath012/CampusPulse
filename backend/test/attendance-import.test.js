const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../src/app");

// Paper registers are filed after the fact, so this route is the one place a
// session may carry a date that is not today.

async function createTestServer() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "campuspulse-import-"));
  const { app, store } = createApp({
    databasePath: path.join(directory, "database.json"),
    mailer: {
      configured: false,
      async sendVerification({ code }) {
        return { delivered: false, previewCode: code };
      },
    },
    env: { ALLOWED_ORIGINS: "http://localhost", ALLOW_DEV_VERIFICATION_CODE: "true" },
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  return {
    store,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function request(baseUrl, route, options = {}) {
  const headers = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(`${baseUrl}${route}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const type = response.headers.get("content-type") || "";
  return {
    response,
    body: type.includes("application/json") ? await response.json() : await response.text(),
  };
}

async function signIn(baseUrl, user) {
  const requested = await request(baseUrl, "/api/auth/signup/request", {
    method: "POST",
    body: { phone: "9876543210", department: "Mechanical Engineering", ...user },
  });
  assert.equal(requested.response.status, 202);
  const verified = await request(baseUrl, "/api/auth/signup/verify", {
    method: "POST",
    body: { email: user.email, code: requested.body.devCode },
  });
  assert.equal(verified.response.status, 201);
  return verified.body;
}

async function professorWithCourse(baseUrl) {
  const professor = await signIn(baseUrl, {
    role: "faculty",
    name: "Prof Soft Computing",
    email: "prof-import@kgpian.iitkgp.ac.in",
    password: "professor-password",
  });
  const created = await request(baseUrl, "/api/courses", {
    method: "POST",
    token: professor.token,
    body: { name: "Soft Computing", courseCode: "MF41601", room: "NR221" },
  });
  assert.equal(created.response.status, 201);
  const students = [
    { rollNumber: "23ME10094", name: "Ushasee Roy" },
    { rollNumber: "24MF10049", name: "Rathlavath Nikitha" },
    { rollNumber: "24ME10127", name: "Pavish R" },
  ];
  const uploaded = await request(baseUrl, `/api/courses/${created.body.course.id}/roster`, {
    method: "PUT",
    token: professor.token,
    body: { students },
  });
  assert.equal(uploaded.response.status, 200);
  return { professor, course: created.body.course, students };
}

test("a paper register is filed under the day the class was actually held", async (t) => {
  const server = await createTestServer();
  t.after(() => server.close());
  const { professor, course } = await professorWithCourse(server.baseUrl);

  const imported = await request(server.baseUrl, "/api/attendance/import", {
    method: "POST",
    token: professor.token,
    body: {
      courseId: course.id,
      startedAt: "2026-08-04",
      present: ["23ME10094", "24ME10127"],
    },
  });
  assert.equal(imported.response.status, 201, JSON.stringify(imported.body));
  const session = imported.body.attendance;

  // The class date is kept, not the moment the import ran.
  assert.equal(session.startedAt.slice(0, 10), "2026-08-04");
  // Past classes are never left open for a student to walk into.
  assert.equal(session.status, "closed");
  assert.ok(session.importedAt);
  assert.equal(session.proximitySecret, undefined);

  assert.equal(session.records.length, 3);
  const present = session.records.filter((record) => record.present).map((r) => r.rollNumber);
  assert.deepEqual(present.sort(), ["23ME10094", "24ME10127"]);
  // Everyone else is absent, and the whole roll list is on the register.
  assert.deepEqual(
    session.records.filter((r) => !r.present).map((r) => r.rollNumber),
    ["24MF10049"],
  );

  // Nobody is told that attendance opened for a class that already happened.
  const data = await server.store.read();
  assert.equal(data.notifications.length, 0);
  assert.equal(data.courseNotices.length, 0);
});

test("several past classes can be filed in one sitting", async (t) => {
  const server = await createTestServer();
  t.after(() => server.close());
  const { professor, course } = await professorWithCourse(server.baseUrl);

  // The live route allows one register per course per day, which is what makes
  // a back-fill of a term impossible through it.
  for (const date of ["2026-07-21", "2026-07-27", "2026-08-03", "2026-08-04"]) {
    const filed = await request(server.baseUrl, "/api/attendance/import", {
      method: "POST",
      token: professor.token,
      body: { courseId: course.id, startedAt: date, present: ["23ME10094"] },
    });
    assert.equal(filed.response.status, 201, `${date}: ${JSON.stringify(filed.body)}`);
  }
  const data = await server.store.read();
  assert.deepEqual(
    data.attendanceSessions.map((item) => item.startedAt.slice(0, 10)).sort(),
    ["2026-07-21", "2026-07-27", "2026-08-03", "2026-08-04"],
  );

  // Re-running the import does not double up a register.
  const again = await request(server.baseUrl, "/api/attendance/import", {
    method: "POST",
    token: professor.token,
    body: { courseId: course.id, startedAt: "2026-08-04", present: ["23ME10094"] },
  });
  assert.equal(again.response.status, 409);
});

test("adding a timetable between two runs does not duplicate a filed register", async (t) => {
  const server = await createTestServer();
  t.after(() => server.close());
  const { professor, course } = await professorWithCourse(server.baseUrl);

  // Filed before any timetable exists, so the register has no class attached.
  const first = await request(server.baseUrl, "/api/attendance/import", {
    method: "POST",
    token: professor.token,
    body: { courseId: course.id, startedAt: "2026-08-04", present: ["23ME10094"] },
  });
  assert.equal(first.response.status, 201);
  assert.equal(first.body.attendance.scheduleId, null);

  await request(server.baseUrl, `/api/courses/${course.id}/schedule`, {
    method: "PUT",
    token: professor.token,
    body: {
      revision: 0,
      classes: [{ day: "Tuesday", start: "10:00 AM", end: "11:00 AM", topic: "Soft Computing" }],
    },
  });

  // The same sheet now resolves to a class, but it is still the same class day.
  const again = await request(server.baseUrl, "/api/attendance/import", {
    method: "POST",
    token: professor.token,
    body: { courseId: course.id, startedAt: "2026-08-04", present: ["23ME10094"] },
  });
  assert.equal(again.response.status, 409);
  const data = await server.store.read();
  assert.equal(data.attendanceSessions.length, 1);
});

test("an import is refused rather than quietly recording the wrong register", async (t) => {
  const server = await createTestServer();
  t.after(() => server.close());
  const { professor, course } = await professorWithCourse(server.baseUrl);

  // A misread roll number would mark the wrong student present and the right
  // one absent, so it stops the import instead of being dropped.
  const stranger = await request(server.baseUrl, "/api/attendance/import", {
    method: "POST",
    token: professor.token,
    body: { courseId: course.id, startedAt: "2026-08-04", present: ["24ME99999"] },
  });
  assert.equal(stranger.response.status, 400);
  assert.match(stranger.body.error, /24ME99999/);

  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const ahead = await request(server.baseUrl, "/api/attendance/import", {
    method: "POST",
    token: professor.token,
    body: { courseId: course.id, startedAt: future, present: [] },
  });
  assert.equal(ahead.response.status, 400);

  const nonsense = await request(server.baseUrl, "/api/attendance/import", {
    method: "POST",
    token: professor.token,
    body: { courseId: course.id, startedAt: "the Tuesday before last", present: [] },
  });
  assert.equal(nonsense.response.status, 400);

  // A student cannot file a register for themselves.
  const student = await signIn(server.baseUrl, {
    role: "student",
    name: "Ushasee Roy",
    email: "ushasee@kgpian.iitkgp.ac.in",
    password: "student-password",
    rollNumber: "23ME10094",
    hall: "Azad Hall",
  });
  const forged = await request(server.baseUrl, "/api/attendance/import", {
    method: "POST",
    token: student.token,
    body: { courseId: course.id, startedAt: "2026-08-04", present: ["23ME10094"] },
  });
  assert.equal(forged.response.status, 403);
});

test("a filed register attaches to the class that runs on that weekday", async (t) => {
  const server = await createTestServer();
  t.after(() => server.close());
  const { professor, course } = await professorWithCourse(server.baseUrl);

  const saved = await request(server.baseUrl, `/api/courses/${course.id}/schedule`, {
    method: "PUT",
    token: professor.token,
    body: {
      revision: 0,
      classes: [
        { day: "Monday", start: "10:00 AM", end: "11:00 AM", topic: "Soft Computing" },
        { day: "Tuesday", start: "10:00 AM", end: "11:00 AM", topic: "Soft Computing" },
      ],
    },
  });
  assert.equal(saved.response.status, 200);
  const monday = saved.body.schedule.find((item) => item.day === "Monday");
  const tuesday = saved.body.schedule.find((item) => item.day === "Tuesday");

  // 3 Aug 2026 is a Monday and 4 Aug 2026 is a Tuesday.
  const first = await request(server.baseUrl, "/api/attendance/import", {
    method: "POST",
    token: professor.token,
    body: { courseId: course.id, startedAt: "2026-08-03", present: [] },
  });
  const second = await request(server.baseUrl, "/api/attendance/import", {
    method: "POST",
    token: professor.token,
    body: { courseId: course.id, startedAt: "2026-08-04", present: [] },
  });
  assert.equal(first.body.attendance.scheduleId, monday.id);
  assert.equal(second.body.attendance.scheduleId, tuesday.id);
});
