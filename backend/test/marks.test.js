const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { createApp } = require("../src/app");

async function startServer() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "campuspulse-marks-"));
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
      name: role === "faculty" ? "Marks Professor" : `Marks Student ${index}`,
      department: "Mechanical Engineering",
      email: `marks.${role}.${index}@example.com`,
      password: "a-good-password",
      phone: "9876543210",
      ...(rollNumber ? { rollNumber } : {}),
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
    body: { name: "Marks Hall", courseCode: "MRK101", department: "Mechanical Engineering" },
  });
  assert.equal(course.status, 201);
  const courseId = course.body.course.id;
  const joinCode = course.body.course.studentCode || course.body.course.code;

  await call(baseUrl, `/api/courses/${courseId}/roster`, {
    method: "PUT",
    token: professorToken,
    body: {
      students: [
        { serial: 1, rollNumber: "24MRK001", name: "First Student" },
        { serial: 2, rollNumber: "24MRK002", name: "Second Student" },
        { serial: 3, rollNumber: "24MRK003", name: "Third Student" },
      ],
    },
  });

  const studentToken = await signUp(baseUrl, "student", 1, "24MRK001");
  const joined = await call(baseUrl, "/api/courses/join", {
    method: "POST",
    token: studentToken,
    body: { code: joinCode, rollNumber: "24MRK001" },
  });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));

  return { professorToken, studentToken, courseId };
}

test("marks for a whole exam are recorded and read back", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, courseId } = await classroom(server.baseUrl);

  const saved = await call(server.baseUrl, `/api/courses/${courseId}/marks/test1`, {
    method: "PUT",
    token: professorToken,
    body: {
      maxMarks: 20,
      entries: [
        { rollNumber: "24MRK001", score: 18 },
        { rollNumber: "24MRK002", score: 12.5 },
      ],
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.saved, 2);

  const grid = await call(server.baseUrl, `/api/courses/${courseId}/marks`, {
    token: professorToken,
  });
  assert.equal(grid.status, 200);
  assert.equal(grid.body.exams.length, 8, "six tests, mid sem and end sem");
  assert.equal(grid.body.exams.find((exam) => exam.id === "test1").maxMarks, 20);

  const byRoll = new Map(grid.body.students.map((student) => [student.rollNumber, student]));
  assert.equal(byRoll.get("24MRK001").marks.test1, 18);
  assert.equal(byRoll.get("24MRK002").marks.test1, 12.5);
  // Nobody entered a mark for the third student, so they have none.
  assert.equal(byRoll.get("24MRK003").marks.test1, null);
  assert.equal(byRoll.get("24MRK001").marks.endsem, null);
});

test("a sheet covering part of the class leaves everyone else alone", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, courseId } = await classroom(server.baseUrl);

  await call(server.baseUrl, `/api/courses/${courseId}/marks/midsem`, {
    method: "PUT",
    token: professorToken,
    body: {
      maxMarks: 50,
      entries: [
        { rollNumber: "24MRK001", score: 40 },
        { rollNumber: "24MRK002", score: 35 },
      ],
    },
  });

  // A second sheet with only one student in it must not wipe the other.
  const second = await call(server.baseUrl, `/api/courses/${courseId}/marks/midsem`, {
    method: "PUT",
    token: professorToken,
    body: { entries: [{ rollNumber: "24MRK003", score: 45 }] },
  });
  assert.equal(second.status, 200);

  const grid = await call(server.baseUrl, `/api/courses/${courseId}/marks`, {
    token: professorToken,
  });
  const byRoll = new Map(grid.body.students.map((student) => [student.rollNumber, student]));
  assert.equal(byRoll.get("24MRK001").marks.midsem, 40, "an untouched mark survives");
  assert.equal(byRoll.get("24MRK002").marks.midsem, 35);
  assert.equal(byRoll.get("24MRK003").marks.midsem, 45);
});

test("a correction replaces the mark rather than adding a second one", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, courseId } = await classroom(server.baseUrl);

  for (const score of [10, 15, 19]) {
    const saved = await call(server.baseUrl, `/api/courses/${courseId}/marks/test2`, {
      method: "PUT",
      token: professorToken,
      body: { maxMarks: 20, entries: [{ rollNumber: "24MRK001", score }] },
    });
    assert.equal(saved.status, 200);
  }

  const stored = (await server.store.read()).courseMarks.filter(
    (mark) => mark.exam === "test2" && mark.rollNumber === "24MRK001",
  );
  assert.equal(stored.length, 1, "one row per student per exam");
  assert.equal(stored[0].score, 19);
});

test("a blank clears a mark instead of storing a zero", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, courseId } = await classroom(server.baseUrl);

  await call(server.baseUrl, `/api/courses/${courseId}/marks/test3`, {
    method: "PUT",
    token: professorToken,
    body: { maxMarks: 20, entries: [{ rollNumber: "24MRK001", score: 15 }] },
  });
  const cleared = await call(server.baseUrl, `/api/courses/${courseId}/marks/test3`, {
    method: "PUT",
    token: professorToken,
    body: { entries: [{ rollNumber: "24MRK001", score: "" }] },
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.cleared, 1);

  const grid = await call(server.baseUrl, `/api/courses/${courseId}/marks`, {
    token: professorToken,
  });
  const student = grid.body.students.find((item) => item.rollNumber === "24MRK001");
  assert.equal(student.marks.test3, null, "not sitting an exam is not a zero");
});

test("a mark above the total is refused, and the sheet is not half applied", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, courseId } = await classroom(server.baseUrl);

  const refused = await call(server.baseUrl, `/api/courses/${courseId}/marks/test4`, {
    method: "PUT",
    token: professorToken,
    body: {
      maxMarks: 20,
      entries: [
        { rollNumber: "24MRK001", score: 15 },
        { rollNumber: "24MRK002", score: 25 },
      ],
    },
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /more than the 20/);

  const grid = await call(server.baseUrl, `/api/courses/${courseId}/marks`, {
    token: professorToken,
  });
  const first = grid.body.students.find((item) => item.rollNumber === "24MRK001");
  assert.equal(first.marks.test4, null, "the whole upload is rejected together");
});

test("roll numbers not on the roster are reported, not silently stored", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, courseId } = await classroom(server.baseUrl);

  const saved = await call(server.baseUrl, `/api/courses/${courseId}/marks/test5`, {
    method: "PUT",
    token: professorToken,
    body: {
      maxMarks: 30,
      entries: [
        { rollNumber: "24MRK001", score: 20 },
        { rollNumber: "24NOTHERE", score: 25 },
      ],
    },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.saved, 1);
  assert.equal(saved.body.ignoredCount, 1);
  assert.deepEqual(saved.body.ignored, ["24NOTHERE"]);
});

test("an unknown exam is refused", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, courseId } = await classroom(server.baseUrl);

  const refused = await call(server.baseUrl, `/api/courses/${courseId}/marks/test9`, {
    method: "PUT",
    token: professorToken,
    body: { maxMarks: 20, entries: [{ rollNumber: "24MRK001", score: 10 }] },
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /unknown exam/i);
});

test("a student sees their own marks and nobody else's", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, studentToken, courseId } = await classroom(server.baseUrl);

  await call(server.baseUrl, `/api/courses/${courseId}/marks/endsem`, {
    method: "PUT",
    token: professorToken,
    body: {
      maxMarks: 100,
      entries: [
        { rollNumber: "24MRK001", score: 78 },
        { rollNumber: "24MRK002", score: 91 },
      ],
    },
  });

  const mine = await call(server.baseUrl, `/api/marks?courseId=${courseId}`, {
    token: studentToken,
  });
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  const endsem = mine.body.courses[0].exams.find((exam) => exam.id === "endsem");
  assert.equal(endsem.score, 78);
  assert.equal(endsem.maxMarks, 100);
  // The other student's 91 must appear nowhere in the response.
  assert.equal(JSON.stringify(mine.body).includes("91"), false);

  // And the whole-course grid stays closed to them.
  const grid = await call(server.baseUrl, `/api/courses/${courseId}/marks`, {
    token: studentToken,
  });
  assert.equal(grid.status, 403);
});

test("a student's record carries their marks alongside their attendance", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, courseId } = await classroom(server.baseUrl);

  await call(server.baseUrl, `/api/courses/${courseId}/marks/test6`, {
    method: "PUT",
    token: professorToken,
    body: { maxMarks: 25, entries: [{ rollNumber: "24MRK001", score: 22 }] },
  });

  const record = await call(
    server.baseUrl,
    `/api/courses/${courseId}/students/24MRK001`,
    { token: professorToken },
  );
  assert.equal(record.status, 200);
  const test6 = record.body.marks.find((exam) => exam.id === "test6");
  assert.equal(test6.score, 22);
  assert.equal(test6.maxMarks, 25);
  assert.equal(record.body.marks.length, 8, "every exam is listed, scored or not");
});

test("marks cannot be entered before a roll list exists", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const professorToken = await signUp(server.baseUrl, "faculty", 0);
  const course = await call(server.baseUrl, "/api/courses", {
    method: "POST",
    token: professorToken,
    body: { name: "Empty", courseCode: "EMP101", department: "Mechanical Engineering" },
  });

  const refused = await call(
    server.baseUrl,
    `/api/courses/${course.body.course.id}/marks/test1`,
    {
      method: "PUT",
      token: professorToken,
      body: { maxMarks: 20, entries: [{ rollNumber: "24MRK001", score: 10 }] },
    },
  );
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /roll list/i);
});

test("every exam total can be set up front, before any marks exist", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, courseId } = await classroom(server.baseUrl);

  const saved = await call(server.baseUrl, `/api/courses/${courseId}/exam-totals`, {
    method: "PUT",
    token: professorToken,
    body: {
      totals: {
        test1: 20,
        test2: 20,
        test3: 20,
        midsem: 50,
        endsem: 100,
        // Left out on purpose: this course does not sit tests 4 to 6.
      },
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  const byId = new Map(saved.body.exams.map((exam) => [exam.id, exam.maxMarks]));
  assert.equal(byId.get("test1"), 20);
  assert.equal(byId.get("midsem"), 50);
  assert.equal(byId.get("endsem"), 100);
  assert.equal(byId.get("test4"), null, "an exam the course does not sit stays unset");

  // An upload can then omit the total, because the course already knows it.
  const marks = await call(server.baseUrl, `/api/courses/${courseId}/marks/midsem`, {
    method: "PUT",
    token: professorToken,
    body: { entries: [{ rollNumber: "24MRK001", score: 48 }] },
  });
  assert.equal(marks.status, 200, JSON.stringify(marks.body));
  assert.equal(marks.body.maxMarks, 50);

  // And the stored total is still enforced.
  const tooHigh = await call(server.baseUrl, `/api/courses/${courseId}/marks/midsem`, {
    method: "PUT",
    token: professorToken,
    body: { entries: [{ rollNumber: "24MRK002", score: 51 }] },
  });
  assert.equal(tooHigh.status, 400);
});

test("a total cannot be dropped below a mark already awarded", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, courseId } = await classroom(server.baseUrl);

  await call(server.baseUrl, `/api/courses/${courseId}/marks/test1`, {
    method: "PUT",
    token: professorToken,
    body: { maxMarks: 20, entries: [{ rollNumber: "24MRK001", score: 18 }] },
  });

  const refused = await call(server.baseUrl, `/api/courses/${courseId}/exam-totals`, {
    method: "PUT",
    token: professorToken,
    body: { totals: { test1: 10 } },
  });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(refused.body.error, /24MRK001 already has 18/);

  // Raising it is fine.
  const raised = await call(server.baseUrl, `/api/courses/${courseId}/exam-totals`, {
    method: "PUT",
    token: professorToken,
    body: { totals: { test1: 25 } },
  });
  assert.equal(raised.status, 200);
});

test("a blank total clears an exam the course no longer sits", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, courseId } = await classroom(server.baseUrl);

  await call(server.baseUrl, `/api/courses/${courseId}/exam-totals`, {
    method: "PUT",
    token: professorToken,
    body: { totals: { test6: 15 } },
  });
  const cleared = await call(server.baseUrl, `/api/courses/${courseId}/exam-totals`, {
    method: "PUT",
    token: professorToken,
    body: { totals: { test6: null } },
  });
  assert.equal(cleared.status, 200);
  assert.equal(
    cleared.body.exams.find((exam) => exam.id === "test6").maxMarks,
    null,
  );
});

test("an unknown exam in the totals is refused", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, courseId } = await classroom(server.baseUrl);

  const refused = await call(server.baseUrl, `/api/courses/${courseId}/exam-totals`, {
    method: "PUT",
    token: professorToken,
    body: { totals: { viva: 20 } },
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /unknown exam/i);
});

test("a student cannot set exam totals", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { studentToken, courseId } = await classroom(server.baseUrl);

  const refused = await call(server.baseUrl, `/api/courses/${courseId}/exam-totals`, {
    method: "PUT",
    token: studentToken,
    body: { totals: { test1: 5 } },
  });
  assert.equal(refused.status, 403);
});
