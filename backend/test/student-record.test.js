const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { createApp } = require("../src/app");

const CLASSROOM = { latitude: 22.3149, longitude: 87.3105, accuracy: 12 };

async function startServer() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "campuspulse-record-"));
  const { app, store } = createApp({
    databasePath: path.join(directory, "campuspulse.json"),
    env: { NODE_ENV: "test" },
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  return {
    store,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
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

async function signUp(baseUrl, role, index, rollNumber) {
  const created = await call(baseUrl, "/api/auth/signup", {
    method: "POST",
    body: {
      role,
      name: role === "faculty" ? "Record Professor" : `Record Student ${index}`,
      department: "Mechanical Engineering",
      email: `record.${role}.${index}@example.com`,
      password: "a-good-password",
      phone: "9876543210",
      ...(rollNumber ? { rollNumber, hall: "Nehru Hall" } : {}),
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.token;
}

async function classroom(baseUrl) {
  const professorToken = await signUp(baseUrl, "faculty", 0);
  const course = await call(baseUrl, "/api/courses", {
    method: "POST",
    token: professorToken,
    body: { name: "Record Hall", courseCode: "REC101", department: "Mechanical Engineering" },
  });
  assert.equal(course.status, 201);
  const courseId = course.body.course.id;
  const joinCode = course.body.course.studentCode || course.body.course.code;

  await call(baseUrl, `/api/courses/${courseId}/roster`, {
    method: "PUT",
    token: professorToken,
    body: {
      students: [
        { serial: 1, rollNumber: "24REC001", name: "Attends Often" },
        { serial: 2, rollNumber: "24REC002", name: "Never Signed Up" },
      ],
    },
  });

  const studentToken = await signUp(baseUrl, "student", 1, "24REC001");
  const joined = await call(baseUrl, "/api/courses/join", {
    method: "POST",
    token: studentToken,
    body: { code: joinCode, rollNumber: "24REC001" },
  });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));

  return { professorToken, studentToken, courseId };
}

// Holds a class, marks the given roll numbers present, then closes it.
//
// `daysAgo` backdates the finished session. Classes really do fall on separate
// days, and without it the second one in a test is refused as a double-tap.
async function holdClass(server, token, courseId, presentRolls, daysAgo = 0) {
  const opened = await call(server.baseUrl, "/api/attendance/sessions", {
    method: "POST",
    token,
    body: { courseId, location: CLASSROOM },
  });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const sessionId = opened.body.attendance.id;
  if (presentRolls.length) {
    const marked = await call(server.baseUrl, `/api/attendance/${sessionId}/records`, {
      method: "PATCH",
      token,
      body: { records: presentRolls.map((rollNumber) => ({ rollNumber, present: true })) },
    });
    assert.equal(marked.status, 200, JSON.stringify(marked.body));
  }
  const closed = await call(server.baseUrl, `/api/attendance/${sessionId}/close`, {
    method: "POST",
    token,
    body: {},
  });
  assert.equal(closed.status, 200);

  const when = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  await server.store.update((database) => {
    const session = database.attendanceSessions.find((item) => item.id === sessionId);
    session.startedAt = when;
    session.closedAt = when;
    return null;
  });
  return sessionId;
}

test("a professor sees a student's whole history and running percentage", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, courseId } = await classroom(server.baseUrl);

  // Four classes: present, absent, present, present.
  await holdClass(server, professorToken, courseId, ["24REC001"], 4);
  await holdClass(server, professorToken, courseId, [], 3);
  await holdClass(server, professorToken, courseId, ["24REC001"], 2);
  await holdClass(server, professorToken, courseId, ["24REC001"], 1);

  const record = await call(
    server.baseUrl,
    `/api/courses/${courseId}/students/24REC001`,
    { token: professorToken },
  );
  assert.equal(record.status, 200, JSON.stringify(record.body));

  assert.equal(record.body.student.rollNumber, "24REC001");
  assert.equal(record.body.student.name, "Attends Often");
  assert.equal(record.body.student.hasAccount, true);
  assert.equal(record.body.student.email, "record.student.1@example.com");
  assert.equal(record.body.student.courseCode, "REC101");

  assert.deepEqual(record.body.summary, {
    held: 4,
    attended: 3,
    missed: 1,
    percentage: 75,
  });

  // Every class the course has held, newest first.
  assert.equal(record.body.sessions.length, 4);
  assert.deepEqual(
    record.body.sessions.map((session) => session.present),
    [true, true, false, true],
  );
  const times = record.body.sessions.map((session) => Date.parse(session.startedAt));
  assert.deepEqual([...times].sort((a, b) => b - a), times, "newest first");
});

test("a rostered student who never signed up still has a record", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, courseId } = await classroom(server.baseUrl);
  await holdClass(server, professorToken, courseId, []);

  const record = await call(
    server.baseUrl,
    `/api/courses/${courseId}/students/24REC002`,
    { token: professorToken },
  );
  assert.equal(record.status, 200, JSON.stringify(record.body));
  assert.equal(record.body.student.name, "Never Signed Up");
  assert.equal(record.body.student.hasAccount, false);
  // No account means no contact details to leak.
  assert.equal(record.body.student.email, "");
  assert.equal(record.body.summary.held, 1);
  assert.equal(record.body.summary.attended, 0);
});

test("a student cannot read anyone's record, including their own", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, studentToken, courseId } = await classroom(server.baseUrl);
  await holdClass(server, professorToken, courseId, ["24REC001"]);

  const own = await call(
    server.baseUrl,
    `/api/courses/${courseId}/students/24REC001`,
    { token: studentToken },
  );
  assert.equal(own.status, 403, "this route is for the course team only");
});

test("another course's professor is refused", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, courseId } = await classroom(server.baseUrl);
  await holdClass(server, professorToken, courseId, ["24REC001"]);

  const outsiderToken = await signUp(server.baseUrl, "faculty", 9);
  const attempt = await call(
    server.baseUrl,
    `/api/courses/${courseId}/students/24REC001`,
    { token: outsiderToken },
  );
  assert.equal(attempt.status, 403, JSON.stringify(attempt.body));
});

test("an unknown roll number is reported rather than returned empty", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, courseId } = await classroom(server.baseUrl);

  const missing = await call(
    server.baseUrl,
    `/api/courses/${courseId}/students/24NOBODY`,
    { token: professorToken },
  );
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /not on this course roster/i);
});

test("a class held before a student joined the roll list is not counted", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, courseId } = await classroom(server.baseUrl);

  // One class with the original roll list.
  await holdClass(server, professorToken, courseId, ["24REC001"], 2);

  // A student added afterwards was not on that session's snapshot.
  await call(server.baseUrl, `/api/courses/${courseId}/roster`, {
    method: "PUT",
    token: professorToken,
    body: {
      students: [
        { serial: 1, rollNumber: "24REC001", name: "Attends Often" },
        { serial: 2, rollNumber: "24REC002", name: "Never Signed Up" },
        { serial: 3, rollNumber: "24REC003", name: "Joined Late" },
      ],
    },
  });
  await holdClass(server, professorToken, courseId, ["24REC003"], 1);

  const record = await call(
    server.baseUrl,
    `/api/courses/${courseId}/students/24REC003`,
    { token: professorToken },
  );
  assert.equal(record.status, 200, JSON.stringify(record.body));
  assert.equal(
    record.body.summary.held,
    1,
    "the earlier class must not count against a student who was not on the list",
  );
  assert.equal(record.body.summary.percentage, 100);
});
