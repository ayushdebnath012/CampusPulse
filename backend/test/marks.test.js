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

  const taToken = await signUp(baseUrl, "ta", 2, "24MRK002");
  const taJoined = await call(baseUrl, "/api/courses/join", {
    method: "POST",
    token: taToken,
    body: { code: course.body.course.taCode, rollNumber: "24MRK002" },
  });
  assert.equal(taJoined.status, 201, JSON.stringify(taJoined.body));

  return { professorToken, studentToken, taToken, courseId };
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

test("marks for an exam this course does not record are refused", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, courseId } = await classroom(server.baseUrl);

  const refused = await call(server.baseUrl, `/api/courses/${courseId}/marks/test9`, {
    method: "PUT",
    token: professorToken,
    body: { maxMarks: 20, entries: [{ rollNumber: "24MRK001", score: 10 }] },
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /not one this course records/i);
});

test("students cannot access their own marks", async (t) => {
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

  // There is no route that hands a student their own marks. It was removed
  // rather than guarded, so that no later change can quietly re-open it.
  const mine = await call(server.baseUrl, `/api/marks?courseId=${courseId}`, {
    token: studentToken,
  });
  assert.equal(mine.status, 404, JSON.stringify(mine.body));

  // And the whole-course grid stays closed to them.
  const grid = await call(server.baseUrl, `/api/courses/${courseId}/marks`, {
    token: studentToken,
  });
  assert.equal(grid.status, 403);
});

test("a TA can record marks but never read one back", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, taToken, courseId } = await classroom(server.baseUrl);

  await call(server.baseUrl, `/api/courses/${courseId}/marks/endsem`, {
    method: "PUT",
    token: professorToken,
    body: {
      maxMarks: 100,
      entries: [
        { rollNumber: "24MRK001", score: 78 },
        { rollNumber: "24MRK003", score: 64 },
      ],
    },
  });

  // The grid still arrives, because a TA needs the roster and the exam columns
  // to enter marks into. Every score in it is blank.
  const grid = await call(server.baseUrl, `/api/courses/${courseId}/marks`, {
    token: taToken,
  });
  assert.equal(grid.status, 200, JSON.stringify(grid.body));
  assert.equal(grid.body.scoresHidden, true);
  assert.ok(grid.body.students.length >= 3, "the roster still comes through");
  for (const student of grid.body.students) {
    for (const [exam, score] of Object.entries(student.marks)) {
      assert.equal(score, null, `${student.rollNumber} ${exam} leaked to a TA`);
    }
  }

  // Nor through a single student's record, which a TA opens for attendance.
  const record = await call(
    server.baseUrl,
    `/api/courses/${courseId}/students/24MRK001`,
    { token: taToken },
  );
  assert.equal(record.status, 200, JSON.stringify(record.body));
  assert.equal(record.body.scoresHidden, true);
  assert.ok(record.body.sessions, "attendance is still theirs to see");
  for (const exam of record.body.marks) {
    assert.equal(exam.score, null, `${exam.id} leaked through a student record`);
  }

  // Writing still works, and the receipt counts marks without echoing them.
  const saved = await call(server.baseUrl, `/api/courses/${courseId}/marks/test1`, {
    method: "PUT",
    token: taToken,
    body: { maxMarks: 20, entries: [{ rollNumber: "24MRK001", score: 15 }] },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.saved, 1);

  const professorView = await call(server.baseUrl, `/api/courses/${courseId}/marks`, {
    token: professorToken,
  });
  const first = professorView.body.students.find(
    (student) => student.rollNumber === "24MRK001",
  );
  assert.equal(first.marks.test1, 15, "the TA's entry reached the professor");
  assert.equal(professorView.body.scoresHidden, false);
});

test("lowering an exam total does not name a score to a TA", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, taToken, courseId } = await classroom(server.baseUrl);

  await call(server.baseUrl, `/api/courses/${courseId}/marks/test1`, {
    method: "PUT",
    token: professorToken,
    body: { maxMarks: 50, entries: [{ rollNumber: "24MRK001", score: 47 }] },
  });

  const exams = [{ id: "test1", label: "Test 1", maxMarks: 10 }];
  const asTa = await call(server.baseUrl, `/api/courses/${courseId}/exams`, {
    method: "PUT",
    token: taToken,
    body: { exams },
  });
  assert.equal(asTa.status, 409);
  assert.doesNotMatch(asTa.body.error, /24MRK001|47/, "the refusal named a mark");

  // The professor still gets the specific reason, which is what makes it fixable.
  const asProfessor = await call(server.baseUrl, `/api/courses/${courseId}/exams`, {
    method: "PUT",
    token: professorToken,
    body: { exams },
  });
  assert.equal(asProfessor.status, 409);
  assert.match(asProfessor.body.error, /24MRK001/);
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

  const saved = await call(server.baseUrl, `/api/courses/${courseId}/exams`, {
    method: "PUT",
    token: professorToken,
    body: {
      exams: [
        { id: "test1", label: "Test 1", maxMarks: 20 },
        { id: "test2", label: "Test 2", maxMarks: 20 },
        { id: "test3", label: "Test 3", maxMarks: 20 },
        { id: "test4", label: "Test 4", maxMarks: null },
        { id: "midsem", label: "Mid Sem", maxMarks: 50 },
        { id: "endsem", label: "End Sem", maxMarks: 100 },
      ],
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  const byId = new Map(saved.body.exams.map((exam) => [exam.id, exam.maxMarks]));
  assert.equal(byId.get("test1"), 20);
  assert.equal(byId.get("midsem"), 50);
  assert.equal(byId.get("endsem"), 100);
  assert.equal(byId.get("test4"), null, "an exam with no total yet stays unset");

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

  const refused = await call(server.baseUrl, `/api/courses/${courseId}/exams`, {
    method: "PUT",
    token: professorToken,
    body: { exams: [{ id: "test1", label: "Test 1", maxMarks: 10 }] },
  });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(refused.body.error, /24MRK001 already has 18/);

  // Raising it is fine.
  const raised = await call(server.baseUrl, `/api/courses/${courseId}/exams`, {
    method: "PUT",
    token: professorToken,
    body: { exams: [{ id: "test1", label: "Test 1", maxMarks: 25 }] },
  });
  assert.equal(raised.status, 200);
});

test("a blank total leaves an exam listed but unmarked", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, courseId } = await classroom(server.baseUrl);

  const cleared = await call(server.baseUrl, `/api/courses/${courseId}/exams`, {
    method: "PUT",
    token: professorToken,
    body: { exams: [{ id: "test6", label: "Test 6", maxMarks: null }] },
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.exams.find((exam) => exam.id === "test6").maxMarks, null);
});

test("a student cannot change the exams", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { studentToken, courseId } = await classroom(server.baseUrl);

  const refused = await call(server.baseUrl, `/api/courses/${courseId}/exams`, {
    method: "PUT",
    token: studentToken,
    body: { exams: [{ label: "Test 1", maxMarks: 5 }] },
  });
  assert.equal(refused.status, 403);
});

test("a professor adds an exam of their own and records marks for it", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, courseId } = await classroom(server.baseUrl);

  // A course assessed by a viva and a project, not by six tests.
  const saved = await call(server.baseUrl, `/api/courses/${courseId}/exams`, {
    method: "PUT",
    token: professorToken,
    body: {
      exams: [
        { label: "Viva Voce", maxMarks: 30 },
        { label: "Project Report", maxMarks: 70 },
      ],
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.exams.length, 2, "the default eight are replaced");
  assert.deepEqual(
    saved.body.exams.map((exam) => exam.label),
    ["Viva Voce", "Project Report"],
  );
  const vivaId = saved.body.exams[0].id;

  const marks = await call(server.baseUrl, `/api/courses/${courseId}/marks/${vivaId}`, {
    method: "PUT",
    token: professorToken,
    body: { entries: [{ rollNumber: "24MRK001", score: 27 }] },
  });
  assert.equal(marks.status, 200, JSON.stringify(marks.body));

  const grid = await call(server.baseUrl, `/api/courses/${courseId}/marks`, {
    token: professorToken,
  });
  assert.equal(grid.body.exams.length, 2);
  const student = grid.body.students.find((item) => item.rollNumber === "24MRK001");
  assert.equal(student.marks[vivaId], 27);
});

test("renaming an exam keeps the marks already recorded against it", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, courseId } = await classroom(server.baseUrl);

  await call(server.baseUrl, `/api/courses/${courseId}/marks/test1`, {
    method: "PUT",
    token: professorToken,
    body: { maxMarks: 20, entries: [{ rollNumber: "24MRK001", score: 16 }] },
  });

  const renamed = await call(server.baseUrl, `/api/courses/${courseId}/exams`, {
    method: "PUT",
    token: professorToken,
    body: { exams: [{ id: "test1", label: "Class Test I", maxMarks: 20 }] },
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.exams[0].label, "Class Test I");
  assert.equal(renamed.body.exams[0].id, "test1", "the identifier is what marks hang off");
  assert.equal(renamed.body.removedMarks, 0);

  const grid = await call(server.baseUrl, `/api/courses/${courseId}/marks`, {
    token: professorToken,
  });
  const student = grid.body.students.find((item) => item.rollNumber === "24MRK001");
  assert.equal(student.marks.test1, 16, "a rename must not orphan a mark");
});

test("removing an exam takes its marks with it, and says how many", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, courseId } = await classroom(server.baseUrl);

  await call(server.baseUrl, `/api/courses/${courseId}/marks/test1`, {
    method: "PUT",
    token: professorToken,
    body: {
      maxMarks: 20,
      entries: [
        { rollNumber: "24MRK001", score: 16 },
        { rollNumber: "24MRK002", score: 11 },
      ],
    },
  });
  await call(server.baseUrl, `/api/courses/${courseId}/marks/test2`, {
    method: "PUT",
    token: professorToken,
    body: { maxMarks: 20, entries: [{ rollNumber: "24MRK001", score: 19 }] },
  });

  // Test 1 is dropped; Test 2 stays.
  const removed = await call(server.baseUrl, `/api/courses/${courseId}/exams`, {
    method: "PUT",
    token: professorToken,
    body: { exams: [{ id: "test2", label: "Test 2", maxMarks: 20 }] },
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.removedMarks, 2, "both Test 1 marks go with the exam");

  const stored = (await server.store.read()).courseMarks.filter(
    (mark) => mark.courseId === courseId,
  );
  assert.equal(stored.length, 1, "no marks are left behind for a deleted exam");
  assert.equal(stored[0].exam, "test2");
});

test("an exam needs a name, and a course cannot record hundreds", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, courseId } = await classroom(server.baseUrl);

  const unnamed = await call(server.baseUrl, `/api/courses/${courseId}/exams`, {
    method: "PUT",
    token: professorToken,
    body: { exams: [{ label: "  ", maxMarks: 10 }] },
  });
  assert.equal(unnamed.status, 400);
  assert.match(unnamed.body.error, /needs a name/i);

  const tooMany = await call(server.baseUrl, `/api/courses/${courseId}/exams`, {
    method: "PUT",
    token: professorToken,
    body: {
      exams: Array.from({ length: 41 }, (_unused, index) => ({
        label: `Exam ${index + 1}`,
        maxMarks: 10,
      })),
    },
  });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.error, /up to 40/);
});

test("two exams sharing a name still get distinct identifiers", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, courseId } = await classroom(server.baseUrl);

  const saved = await call(server.baseUrl, `/api/courses/${courseId}/exams`, {
    method: "PUT",
    token: professorToken,
    body: {
      exams: [
        { label: "Quiz", maxMarks: 10 },
        { label: "Quiz", maxMarks: 10 },
      ],
    },
  });
  assert.equal(saved.status, 200);
  const [first, second] = saved.body.exams;
  assert.notEqual(first.id, second.id, "one mark must never overwrite the other");
});

test("a course that has never been configured still records the usual exams", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, courseId } = await classroom(server.baseUrl);

  const grid = await call(server.baseUrl, `/api/courses/${courseId}/marks`, {
    token: professorToken,
  });
  assert.equal(grid.status, 200);
  assert.deepEqual(
    grid.body.exams.map((exam) => exam.id),
    ["test1", "test2", "test3", "test4", "test5", "test6", "midsem", "endsem"],
  );
});
