const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { createApp } = require("../src/app");

const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

function today() {
  return WEEKDAYS[(new Date().getDay() + 6) % 7];
}

async function startServer() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "campuspulse-class-"));
  const databasePath = path.join(directory, "campuspulse.json");
  const { app, store } = createApp({
    databasePath,
    env: { NODE_ENV: "test" },
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const { port } = server.address();
  return {
    store,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

async function call(baseUrl, route, { method = "GET", token, body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function signUpProfessor(baseUrl) {
  const created = await call(baseUrl, "/api/auth/signup", {
    method: "POST",
    body: {
      role: "faculty",
      name: "Class Professor",
      department: "Mechanical Engineering",
      email: "class.professor@mech.iitkgp.ac.in",
      password: "a-good-password",
      phone: "9876543210",
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.token;
}

async function courseWithTwoClassesToday(baseUrl, token) {
  const course = await call(baseUrl, "/api/courses", {
    method: "POST",
    token,
    body: {
      name: "Twice A Day",
      courseCode: "TWICE101",
      department: "Mechanical Engineering",
    },
  });
  assert.equal(course.status, 201, JSON.stringify(course.body));
  const courseId = course.body.course.id;

  // Two classes on the same weekday: a morning slot and an afternoon slot.
  const schedule = await call(
    baseUrl,
    `/api/courses/${encodeURIComponent(courseId)}/schedule`,
    {
      method: "PUT",
      token,
      body: {
        revision: 0,
        classes: [
          { day: today(), start: "09:00", end: "10:00", topic: "Morning", room: "L1" },
          { day: today(), start: "15:00", end: "16:00", topic: "Afternoon", room: "L2" },
        ],
      },
    },
  );
  assert.equal(schedule.status, 200, JSON.stringify(schedule.body));

  const roster = await call(
    baseUrl,
    `/api/courses/${encodeURIComponent(courseId)}/roster`,
    {
      method: "PUT",
      token,
      body: {
        students: [
          { serial: 1, rollNumber: "24CLASS01", name: "First Student" },
          { serial: 2, rollNumber: "24CLASS02", name: "Second Student" },
        ],
      },
    },
  );
  assert.equal(roster.status, 200, JSON.stringify(roster.body));

  return { courseId, classes: schedule.body.schedule };
}

test("a course meeting twice in a day takes attendance twice", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const token = await signUpProfessor(server.baseUrl);
  const { courseId, classes } = await courseWithTwoClassesToday(server.baseUrl, token);

  const morning = await call(server.baseUrl, "/api/attendance/sessions", {
    method: "POST",
    token,
    body: { courseId, scheduleId: classes[0].id },
  });
  assert.equal(morning.status, 201, JSON.stringify(morning.body));

  // Same class again is a double-tap and is refused.
  const repeat = await call(server.baseUrl, "/api/attendance/sessions", {
    method: "POST",
    token,
    body: { courseId, scheduleId: classes[0].id },
  });
  assert.equal(repeat.status, 409);
  assert.match(repeat.body.error, /already taken for this class/i);

  // The afternoon class is a different class, so it gets its own register.
  const afternoon = await call(server.baseUrl, "/api/attendance/sessions", {
    method: "POST",
    token,
    body: { courseId, scheduleId: classes[1].id },
  });
  assert.equal(
    afternoon.status,
    201,
    `a second class on the same day must be allowed: ${JSON.stringify(afternoon.body)}`,
  );
  assert.notEqual(afternoon.body.attendance.id, morning.body.attendance.id);

  // The new register starts blank rather than inheriting the morning's marks.
  assert.equal(
    afternoon.body.attendance.records.filter((record) => record.present).length,
    0,
  );
  assert.equal(afternoon.body.attendance.records.length, 2);
});

test("yesterday's session is not offered as today's attendance", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const token = await signUpProfessor(server.baseUrl);
  const { courseId, classes } = await courseWithTwoClassesToday(server.baseUrl, token);

  const opened = await call(server.baseUrl, "/api/attendance/sessions", {
    method: "POST",
    token,
    body: { courseId, scheduleId: classes[0].id },
  });
  assert.equal(opened.status, 201);
  const sessionId = opened.body.attendance.id;

  const closed = await call(
    server.baseUrl,
    `/api/attendance/${encodeURIComponent(sessionId)}/close`,
    { method: "POST", token },
  );
  assert.equal(closed.status, 200);

  const stillToday = await call(
    server.baseUrl,
    `/api/attendance/current?courseId=${encodeURIComponent(courseId)}`,
    { token },
  );
  assert.equal(stillToday.body.attendance?.id, sessionId, "today's session stays current");

  // Backdate it: the app must then open on a blank register, not on the old one.
  await server.store.update((database) => {
    const session = database.attendanceSessions.find((item) => item.id === sessionId);
    session.startedAt = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
    session.closedAt = session.startedAt;
    return null;
  });

  const freshDay = await call(
    server.baseUrl,
    `/api/attendance/current?courseId=${encodeURIComponent(courseId)}`,
    { token },
  );
  assert.equal(
    freshDay.body.attendance,
    null,
    "an older session must not be presented as today's attendance",
  );

  // And attendance can be taken again for the same class on the new day.
  const reopenedDay = await call(server.baseUrl, "/api/attendance/sessions", {
    method: "POST",
    token,
    body: { courseId, scheduleId: classes[0].id },
  });
  assert.equal(
    reopenedDay.status,
    201,
    `a new day must allow a fresh register: ${JSON.stringify(reopenedDay.body)}`,
  );
  assert.notEqual(reopenedDay.body.attendance.id, sessionId);

  // The old session is still readable as history.
  const past = await call(
    server.baseUrl,
    `/api/attendance/past?courseId=${encodeURIComponent(courseId)}`,
    { token },
  );
  assert.ok(
    past.body.sessions.some((item) => item.id === sessionId),
    "the earlier session remains in history",
  );
});

test("history names every past class so two on one day are distinguishable", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const token = await signUpProfessor(server.baseUrl);
  const { courseId, classes } = await courseWithTwoClassesToday(server.baseUrl, token);

  for (const scheduled of classes) {
    const opened = await call(server.baseUrl, "/api/attendance/sessions", {
      method: "POST",
      token,
      body: { courseId, scheduleId: scheduled.id },
    });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    const closed = await call(
      server.baseUrl,
      `/api/attendance/${encodeURIComponent(opened.body.attendance.id)}/close`,
      { method: "POST", token },
    );
    assert.equal(closed.status, 200);
  }

  const past = await call(
    server.baseUrl,
    `/api/attendance/past?courseId=${encodeURIComponent(courseId)}`,
    { token },
  );
  assert.equal(past.status, 200);
  assert.equal(past.body.sessions.length, 2, "both of today's classes are listed");

  const labels = past.body.sessions.map((session) => session.classLabel);
  assert.deepEqual(
    [...labels].sort(),
    ["09:00 · Morning", "15:00 · Afternoon"].sort(),
    "each entry names the class it belongs to, not just the date",
  );
  assert.equal(new Set(labels).size, 2, "the two entries must not look identical");
});

test("attendance opened without a named class is still keyed to one", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const token = await signUpProfessor(server.baseUrl);
  const { courseId } = await courseWithTwoClassesToday(server.baseUrl, token);

  // The one-tap button sends no scheduleId; the server resolves today's class.
  const opened = await call(server.baseUrl, "/api/attendance/sessions", {
    method: "POST",
    token,
    body: { courseId },
  });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  assert.ok(
    opened.body.attendance.scheduleId,
    "a session should be attached to the class it belongs to",
  );
});
