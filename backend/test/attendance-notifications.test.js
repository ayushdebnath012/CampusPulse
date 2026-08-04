const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { createApp } = require("../src/app");

async function startServer() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "campuspulse-notify-"));
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

async function classroom(baseUrl) {
  const professor = await call(baseUrl, "/api/auth/signup", {
    method: "POST",
    body: {
      role: "faculty",
      name: "Notify Professor",
      department: "Mechanical Engineering",
      email: "notify.professor@mech.iitkgp.ac.in",
      password: "a-good-password",
      phone: "9876543210",
    },
  });
  assert.equal(professor.status, 201);

  const course = await call(baseUrl, "/api/courses", {
    method: "POST",
    token: professor.body.token,
    body: { name: "Notify Hall", courseCode: "NOT101", department: "Mechanical Engineering" },
  });
  assert.equal(course.status, 201);
  const courseId = course.body.course.id;
  const joinCode = course.body.course.studentCode || course.body.course.code;

  const roster = await call(baseUrl, `/api/courses/${courseId}/roster`, {
    method: "PUT",
    token: professor.body.token,
    body: {
      students: [
        { serial: 1, rollNumber: "24NOTIF01", name: "Present Student" },
        { serial: 2, rollNumber: "24NOTIF02", name: "Absent Student" },
      ],
    },
  });
  assert.equal(roster.status, 200);

  const students = [];
  for (const [index, rollNumber] of ["24NOTIF01", "24NOTIF02"].entries()) {
    const created = await call(baseUrl, "/api/auth/signup", {
      method: "POST",
      body: {
        role: "student",
        name: `Notify Student ${index + 1}`,
        department: "Mechanical Engineering",
        email: `notify.student.${index}@kgpian.iitkgp.ac.in`,
        password: "a-good-password",
        phone: "9876543210",
        rollNumber,
        hall: "Nehru Hall",
      },
    });
    assert.equal(created.status, 201);
    const joined = await call(baseUrl, "/api/courses/join", {
      method: "POST",
      token: created.body.token,
      body: { code: joinCode, rollNumber },
    });
    assert.equal(joined.status, 201, JSON.stringify(joined.body));
    students.push({ rollNumber, token: created.body.token });
  }

  return { professorToken: professor.body.token, courseId, students };
}

async function inbox(baseUrl, token) {
  const result = await call(baseUrl, "/api/notifications", { token });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.notifications || [];
}

test("closing attendance tells every student their own result", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, courseId, students } = await classroom(server.baseUrl);
  const [present, absent] = students;

  const opened = await call(server.baseUrl, "/api/attendance/sessions", {
    method: "POST",
    token: professorToken,
    body: { courseId },
  });
  assert.equal(opened.status, 201);
  const sessionId = opened.body.attendance.id;

  // Opening attendance already notifies the class; only one student is marked.
  const marked = await call(server.baseUrl, `/api/attendance/${sessionId}/records`, {
    method: "PATCH",
    token: professorToken,
    body: { records: [{ rollNumber: present.rollNumber, present: true }] },
  });
  assert.equal(marked.status, 200);

  const closed = await call(server.baseUrl, `/api/attendance/${sessionId}/close`, {
    method: "POST",
    token: professorToken,
    body: {},
  });
  assert.equal(closed.status, 200);

  const presentInbox = await inbox(server.baseUrl, present.token);
  const presentClosing = presentInbox.filter((item) => /marked present/i.test(item.title));
  assert.ok(
    presentClosing.length >= 1,
    `the present student should be told they were present: ${JSON.stringify(presentInbox.map((i) => i.title))}`,
  );

  const absentInbox = await inbox(server.baseUrl, absent.token);
  const absentClosing = absentInbox.find((item) => /marked absent/i.test(item.title));
  assert.ok(
    absentClosing,
    `the absent student should be told they were absent: ${JSON.stringify(absentInbox.map((i) => i.title))}`,
  );
  assert.match(absentClosing.body, /absent/i);
  assert.equal(absentClosing.data.present, "0");
  assert.equal(absentClosing.route, "attendance");
});

test("overriding a student's mark notifies that student only", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, courseId, students } = await classroom(server.baseUrl);
  const [first, second] = students;

  const opened = await call(server.baseUrl, "/api/attendance/sessions", {
    method: "POST",
    token: professorToken,
    body: { courseId },
  });
  assert.equal(opened.status, 201);
  const sessionId = opened.body.attendance.id;

  const before = (await inbox(server.baseUrl, second.token)).length;

  const marked = await call(server.baseUrl, `/api/attendance/${sessionId}/records`, {
    method: "PATCH",
    token: professorToken,
    body: { records: [{ rollNumber: first.rollNumber, present: true }] },
  });
  assert.equal(marked.status, 200);

  const firstInbox = await inbox(server.baseUrl, first.token);
  assert.ok(
    firstInbox.some((item) => /marked present/i.test(item.title)),
    "the student whose mark changed is told",
  );
  assert.equal(
    (await inbox(server.baseUrl, second.token)).length,
    before,
    "a student whose mark did not change is not disturbed",
  );

  // Saving the same value again must not send a second notification.
  const countAfterFirst = firstInbox.length;
  const repeated = await call(server.baseUrl, `/api/attendance/${sessionId}/records`, {
    method: "PATCH",
    token: professorToken,
    body: { records: [{ rollNumber: first.rollNumber, present: true }] },
  });
  assert.equal(repeated.status, 200);
  assert.equal(
    (await inbox(server.baseUrl, first.token)).length,
    countAfterFirst,
    "re-saving an unchanged mark must not notify again",
  );
});
