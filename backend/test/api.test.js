const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../src/app");
const { initialData, normalizeData } = require("../src/database");
const { ACCOUNT_RESET_ID, deleteExistingAccountsOnce } = require("../src/maintenance");


async function createTestServer(options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "campuspulse-api-"));
  const databasePath = path.join(directory, "database.json");
  const mailer = options.mailer || {
    configured: false,
    async sendVerification({ code }) {
      return { delivered: false, previewCode: code };
    },
  };
  const { app, store } = createApp({
    databasePath,
    mailer,
    env: {
      ALLOWED_ORIGINS: "http://localhost",
      ALLOW_DEV_VERIFICATION_CODE: "true",
      FACULTY_SIGNUP_CODE: "faculty-invite",
      TA_SIGNUP_CODE: "ta-invite",
      ...(options.env || {}),
    },
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const { port } = server.address();
  return {
    directory,
    store,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function request(baseUrl, route, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers["content-type"] = "application/json";
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(`${baseUrl}${route}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  return { response, body };
}

async function createVerifiedUser(baseUrl, user) {
  const signupBody = {
    ...user,
    roleCode:
      user.role === "faculty"
        ? user.roleCode || "faculty-invite"
        : user.role === "ta"
          ? user.roleCode || "ta-invite"
          : user.roleCode,
  };
  const created = await request(baseUrl, "/api/auth/signup", {
    method: "POST",
    body: signupBody,
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.user.role, user.role);
  assert.ok(created.body.token);

  const loggedIn = await request(baseUrl, "/api/auth/login", {
    method: "POST",
    body: { email: user.email, password: user.password, role: user.role },
  });
  assert.equal(loggedIn.response.status, 200);
  assert.ok(loggedIn.body.token);
  return loggedIn.body;
}

function rosterOf(count, prefix, namePrefix) {
  return Array.from({ length: count }, (_, index) => ({
    rollNumber: `${prefix}${String(index + 1).padStart(4, "0")}`,
    name: `${namePrefix} ${String(index + 1).padStart(3, "0")}`,
  }));
}

// Nothing is seeded, so every test that needs a course builds one the way a
// professor does: create it, then upload its roll list.
async function createCourse(baseUrl, token, options = {}) {
  const created = await request(baseUrl, "/api/courses", {
    method: "POST",
    token,
    body: {
      name: options.name || "Soft Computing",
      courseCode: options.courseCode || "MF41601",
      section: options.section || "Autumn 2026-2027",
      room: options.room || "NR221",
    },
  });
  assert.equal(created.response.status, 201);
  const course = created.body.course;
  const students = options.students || rosterOf(3, "MFTEST", "Soft Student");
  if (students.length) {
    const uploaded = await request(baseUrl, `/api/courses/${course.id}/roster`, {
      method: "PUT",
      token,
      body: { students },
    });
    assert.equal(
      uploaded.response.status,
      200,
      `roster upload failed: ${JSON.stringify(uploaded.body)}`,
    );
    return { ...course, ...uploaded.body.course, students };
  }
  return { ...course, students };
}

test("CampusPulse API connects professor attendance to the authoritative rosters", async (t) => {
  const testServer = await createTestServer();
  t.after(async () => {
    await testServer.close();
    await fs.rm(testServer.directory, { recursive: true, force: true });
  });

  const health = await request(testServer.baseUrl, "/api/health");
  assert.equal(health.response.status, 200);
  assert.equal(health.body.ok, true);

  const professor = await createVerifiedUser(testServer.baseUrl, {
    role: "faculty",
    name: "Ayush Professor",
    email: "professor@iitkgp.ac.in",
    password: "professor-password",
  });
  const student = await createVerifiedUser(testServer.baseUrl, {
    role: "student",
    name: "Ayush Student",
    email: "student@kgpian.iitkgp.ac.in",
    password: "student-password",
  });
  const teachingAssistant = await createVerifiedUser(testServer.baseUrl, {
    role: "ta",
    name: "Course Assistant",
    email: "assistant@iitkgp.ac.in",
    password: "assistant-password",
  });

  const soft = await createCourse(testServer.baseUrl, professor.token, {
    name: "Soft Computing",
    courseCode: "MF41601",
    students: rosterOf(310, "MFTEST", "Soft Student"),
  });
  const kbs = await createCourse(testServer.baseUrl, professor.token, {
    name: "Knowledge Based Systems in Engineering",
    courseCode: "ME60353",
    room: "Room TBA",
    students: rosterOf(22, "METEST", "KBS Student"),
  });

  const softRoster = await request(
    testServer.baseUrl,
    `/api/courses/${soft.id}/roster`,
    { token: professor.token },
  );
  assert.equal(softRoster.response.status, 200);
  assert.equal(softRoster.body.course.courseCode, "MF41601");
  assert.equal(softRoster.body.students.length, 310);
  assert.deepEqual(softRoster.body.students[0], {
    courseId: soft.id,
    serial: 1,
    rollNumber: "MFTEST0001",
    name: "Soft Student 001",
  });
  assert.deepEqual(softRoster.body.students.at(-1), {
    courseId: soft.id,
    serial: 310,
    rollNumber: "MFTEST0310",
    name: "Soft Student 310",
  });

  const kbsRoster = await request(
    testServer.baseUrl,
    `/api/courses/${kbs.id}/roster`,
    { token: professor.token },
  );
  assert.equal(kbsRoster.response.status, 200);
  assert.equal(kbsRoster.body.course.courseCode, "ME60353");
  assert.equal(kbsRoster.body.students.length, 22);
  assert.equal(kbsRoster.body.students.at(-1).rollNumber, "METEST0022");

  for (const token of [student.token, teachingAssistant.token]) {
    const restrictedRoster = await request(
      testServer.baseUrl,
      `/api/courses/${soft.id}/roster`,
      { token },
    );
    assert.equal(restrictedRoster.response.status, 403);
  }

  await testServer.store.update((database) => {
    database.courses.push({
      id: "orphan-course",
      code: "ORPHAN1",
      name: "Unowned Course",
      courseCode: "NONE001",
      section: "Test",
      room: "Room TBA",
      students: 0,
      ownerId: "missing-owner",
    });
    return null;
  });
  const orphanJoin = await request(testServer.baseUrl, "/api/courses/join", {
    method: "POST",
    token: student.token,
    body: { code: "ORPHAN1" },
  });
  assert.equal(orphanJoin.response.status, 404);

  const joined = await request(testServer.baseUrl, "/api/courses/join", {
    method: "POST",
    token: student.token,
    body: { code: soft.code, rollNumber: "MFTEST0001" },
  });
  assert.equal(joined.response.status, 201);
  assert.equal(joined.body.course.id, soft.id);
  assert.equal("code" in joined.body.course, false);

  const bootstrap = await request(testServer.baseUrl, "/api/bootstrap", {
    token: student.token,
  });
  assert.equal(bootstrap.response.status, 200);
  assert.deepEqual(bootstrap.body.enrolledCourseIds, [soft.id]);
  assert.equal("attendance" in bootstrap.body, false);
  assert.equal("attendanceByCourse" in bootstrap.body, false);
  assert.equal(bootstrap.body.schedule.length, 0);
  assert.equal(bootstrap.body.courses[0].room, "NR221");
  assert.equal(bootstrap.body.courses[0].courseCode, "MF41601");
  assert.equal(bootstrap.body.courses[0].students, 310);

  const openedAttendance = await request(
    testServer.baseUrl,
    "/api/attendance/sessions",
    {
      method: "POST",
      token: professor.token,
      body: { courseId: soft.id },
    },
  );
  assert.equal(openedAttendance.response.status, 201);
  const attendanceId = openedAttendance.body.attendance.id;
  assert.equal(openedAttendance.body.attendance.records.length, 310);
  assert.equal(openedAttendance.body.attendance.records[0].present, false);

  for (const token of [student.token, teachingAssistant.token]) {
    const restrictedCurrent = await request(
      testServer.baseUrl,
      `/api/attendance/current?courseId=${soft.id}`,
      { token },
    );
    assert.equal(restrictedCurrent.response.status, 403);
  }

  // Students now mark themselves, but only with device signals in the documented
  // shape; the legacy top-level flags carry no weight.
  const checkIn = await request(
    testServer.baseUrl,
    `/api/attendance/${attendanceId}/check-in`,
    {
      method: "POST",
      token: student.token,
      body: { wifi: true, bluetooth: true },
    },
  );
  assert.equal(checkIn.response.status, 400);
  assert.match(checkIn.body.error, /bluetooth/i);

  const taJoinedSoft = await request(testServer.baseUrl, "/api/courses/join", {
    method: "POST",
    token: teachingAssistant.token,
    body: { code: soft.code },
  });
  assert.equal(taJoinedSoft.response.status, 201);
  assert.equal(taJoinedSoft.body.course.capabilities.canRunAttendance, true);
  assert.equal(taJoinedSoft.body.course.capabilities.canManageCourse, false);
  assert.equal("code" in taJoinedSoft.body.course, false);

  const taJoinedKbs = await request(testServer.baseUrl, "/api/courses/join", {
    method: "POST",
    token: teachingAssistant.token,
    body: { code: kbs.code },
  });
  assert.equal(taJoinedKbs.response.status, 201);

  const taRoster = await request(
    testServer.baseUrl,
    `/api/courses/${soft.id}/roster`,
    { token: teachingAssistant.token },
  );
  assert.equal(taRoster.response.status, 200);
  assert.equal(taRoster.body.students.length, 310);

  const taOpenedKbs = await request(
    testServer.baseUrl,
    "/api/attendance/sessions",
    {
      method: "POST",
      token: teachingAssistant.token,
      body: { courseId: kbs.id },
    },
  );
  assert.equal(taOpenedKbs.response.status, 201);
  assert.equal(taOpenedKbs.body.attendance.records.length, 22);

  const markedAttendance = await request(
    testServer.baseUrl,
    `/api/attendance/${attendanceId}/records`,
    {
      method: "PATCH",
      token: professor.token,
      body: {
        records: [
          { rollNumber: "MFTEST0001", present: true },
          { rollNumber: "MFTEST0310", present: true },
        ],
      },
    },
  );
  assert.equal(markedAttendance.response.status, 200);
  assert.equal(
    markedAttendance.body.attendance.records.filter((record) => record.present).length,
    2,
  );
  assert.equal(markedAttendance.body.attendance.records[0].name, "Soft Student 001");

  const taMarkedAttendance = await request(
    testServer.baseUrl,
    `/api/attendance/${attendanceId}/records`,
    {
      method: "PATCH",
      token: teachingAssistant.token,
      body: { records: [{ rollNumber: "MFTEST0002", present: true }] },
    },
  );
  assert.equal(taMarkedAttendance.response.status, 200);
  assert.equal(
    taMarkedAttendance.body.attendance.records.filter((record) => record.present).length,
    3,
  );

  const taClosedAttendance = await request(
    testServer.baseUrl,
    `/api/attendance/${attendanceId}/close`,
    { method: "POST", token: teachingAssistant.token },
  );
  assert.equal(taClosedAttendance.response.status, 200);

  const openedQuiz = await request(testServer.baseUrl, "/api/quizzes", {
    method: "POST",
    token: teachingAssistant.token,
    body: {
      courseId: soft.id,
      title: "Soft Computing check",
      questions: [
        {
          prompt: "Which set has partial membership?",
          options: ["Crisp", "Fuzzy", "Empty", "Universal"],
          answer: 1,
        },
      ],
    },
  });
  assert.equal(openedQuiz.response.status, 201);

  const invalidQuiz = await request(testServer.baseUrl, "/api/quizzes", {
    method: "POST",
    token: teachingAssistant.token,
    body: {
      courseId: soft.id,
      title: "Invalid quiz",
      questions: [{ text: "Invalid", options: ["Only one"], answer: 0 }],
    },
  });
  assert.equal(invalidQuiz.response.status, 400);

  const privateBootstrap = await request(testServer.baseUrl, "/api/bootstrap", {
    token: student.token,
  });
  assert.equal("attendance" in privateBootstrap.body, false);
  assert.equal("attendanceByCourse" in privateBootstrap.body, false);
  assert.equal("answer" in privateBootstrap.body.quiz.questions[0], false);
  assert.equal("responses" in privateBootstrap.body.quiz, false);

  const invalidQuizResponse = await request(
    testServer.baseUrl,
    `/api/quizzes/${openedQuiz.body.quiz.id}/respond`,
    {
      method: "POST",
      token: student.token,
      body: { answers: [] },
    },
  );
  assert.equal(invalidQuizResponse.response.status, 400);

  const quizResponse = await request(
    testServer.baseUrl,
    `/api/quizzes/${openedQuiz.body.quiz.id}/respond`,
    {
      method: "POST",
      token: student.token,
      body: { answers: [1] },
    },
  );
  assert.equal(quizResponse.response.status, 201);
  assert.deepEqual(quizResponse.body, { score: 1, total: 1 });

  const repeatedClose = await request(
    testServer.baseUrl,
    `/api/attendance/${attendanceId}/close`,
    {
      method: "POST",
      token: professor.token,
    },
  );
  assert.equal(repeatedClose.response.status, 409);

  const restoredProfessorState = await request(
    testServer.baseUrl,
    "/api/bootstrap",
    { token: professor.token },
  );
  assert.equal("attendance" in restoredProfessorState.body, false);
  assert.equal("attendanceByCourse" in restoredProfessorState.body, false);

  const latestClosedSoftAttendance = await request(
    testServer.baseUrl,
    `/api/attendance/current?courseId=${soft.id}`,
    { token: professor.token },
  );
  assert.equal(latestClosedSoftAttendance.response.status, 200);
  assert.equal(latestClosedSoftAttendance.body.attendance.id, attendanceId);
  assert.equal(latestClosedSoftAttendance.body.attendance.status, "closed");
  assert.equal(latestClosedSoftAttendance.body.attendance.records.length, 310);

  const openedKbsAttendance = await request(
    testServer.baseUrl,
    "/api/attendance/sessions",
    {
      method: "POST",
      token: professor.token,
      body: { courseId: kbs.id },
    },
  );
  assert.equal(openedKbsAttendance.response.status, 201);
  assert.equal(openedKbsAttendance.body.attendance.records.length, 22);
  assert.equal(openedKbsAttendance.body.attendance.records[0].rollNumber, "METEST0001");

  const reopenedSoftAttendance = await request(
    testServer.baseUrl,
    "/api/attendance/sessions",
    {
      method: "POST",
      token: professor.token,
      body: { courseId: soft.id },
    },
  );
  assert.equal(reopenedSoftAttendance.response.status, 201);

  for (const [courseId, attendance] of [
    [soft.id, reopenedSoftAttendance.body.attendance],
    [kbs.id, openedKbsAttendance.body.attendance],
  ]) {
    const currentForCourse = await request(
      testServer.baseUrl,
      `/api/attendance/current?courseId=${encodeURIComponent(courseId)}`,
      { token: professor.token },
    );
    assert.equal(currentForCourse.response.status, 200);
    assert.equal(currentForCourse.body.attendance.id, attendance.id);
  }

  const missingApiRoute = await request(testServer.baseUrl, "/api/not-a-route", {
    token: professor.token,
  });
  assert.equal(missingApiRoute.response.status, 404);
  assert.deepEqual(missingApiRoute.body, { error: "API endpoint not found" });

  const taCourseCreateAttempt = await request(testServer.baseUrl, "/api/courses", {
    method: "POST",
    token: teachingAssistant.token,
    body: {
      name: "TA-Owned Course",
      courseCode: "TA0001",
      section: "Autumn",
      room: "Room 1",
    },
  });
  assert.equal(taCourseCreateAttempt.response.status, 403);

  const taRosterUploadAttempt = await request(
    testServer.baseUrl,
    `/api/courses/${soft.id}/roster`,
    {
      method: "PUT",
      token: teachingAssistant.token,
      body: { students: [{ rollNumber: "BLOCKED1", name: "Blocked Student" }] },
    },
  );
  assert.equal(taRosterUploadAttempt.response.status, 403);

  const otherProfessor = await createVerifiedUser(testServer.baseUrl, {
    role: "faculty",
    name: "Other Professor",
    email: "other-professor@iitkgp.ac.in",
    password: "other-professor-password",
  });
  const otherBootstrap = await request(testServer.baseUrl, "/api/bootstrap", {
    token: otherProfessor.token,
  });
  assert.deepEqual(otherBootstrap.body.courses, []);

  const crossRosterAttempt = await request(
    testServer.baseUrl,
    `/api/courses/${soft.id}/roster`,
    { token: otherProfessor.token },
  );
  assert.equal(crossRosterAttempt.response.status, 403);

  const crossAttendanceAttempt = await request(
    testServer.baseUrl,
    "/api/attendance/sessions",
    {
      method: "POST",
      token: otherProfessor.token,
      body: { courseId: soft.id },
    },
  );
  assert.equal(crossAttendanceAttempt.response.status, 403);

  const crossQuizCloseAttempt = await request(
    testServer.baseUrl,
    `/api/quizzes/${openedQuiz.body.quiz.id}/close`,
    { method: "POST", token: otherProfessor.token },
  );
  assert.equal(crossQuizCloseAttempt.response.status, 403);

  const createdCourse = await request(testServer.baseUrl, "/api/courses", {
    method: "POST",
    token: otherProfessor.token,
    body: {
      name: "Exclusive Course",
      courseCode: "EX1001",
      section: "Autumn 2026-2027",
      room: "Room X",
    },
  });
  assert.equal(createdCourse.response.status, 201);
  assert.equal(createdCourse.body.course.owned, true);
  assert.match(createdCourse.body.course.code, /^[A-Z0-9]{8}$/);
  const exclusiveCourseId = createdCourse.body.course.id;

  const uploadedRoster = await request(
    testServer.baseUrl,
    `/api/courses/${exclusiveCourseId}/roster`,
    {
      method: "PUT",
      token: otherProfessor.token,
      body: {
        students: [
          { rollNumber: "EXTEST001", name: "Exclusive Student One" },
          { rollNumber: "EXTEST002", name: "Exclusive Student Two" },
        ],
      },
    },
  );
  assert.equal(uploadedRoster.response.status, 200);
  assert.equal(uploadedRoster.body.students.length, 2);

  const originalProfessorCrossAttempt = await request(
    testServer.baseUrl,
    `/api/courses/${exclusiveCourseId}/roster`,
    { token: professor.token },
  );
  assert.equal(originalProfessorCrossAttempt.response.status, 403);

  const ownerDeleteAttempt = await request(testServer.baseUrl, "/api/account", {
    method: "DELETE",
    token: otherProfessor.token,
  });
  assert.equal(ownerDeleteAttempt.response.status, 409);

  const deletedAccount = await request(testServer.baseUrl, "/api/account", {
    method: "DELETE",
    token: student.token,
  });
  assert.equal(deletedAccount.response.status, 204);

  const deletedLogin = await request(testServer.baseUrl, "/api/auth/login", {
    method: "POST",
    body: {
      email: "student@kgpian.iitkgp.ac.in",
      password: "student-password",
      role: "student",
    },
  });
  assert.equal(deletedLogin.response.status, 401);
});

test("production signup does not expose a code when email delivery is unavailable", async (t) => {
  const testServer = await createTestServer({
    env: {
      NODE_ENV: "production",
      ALLOW_DEV_VERIFICATION_CODE: "false",
    },
  });
  t.after(async () => {
    await testServer.close();
    await fs.rm(testServer.directory, { recursive: true, force: true });
  });

  const requested = await request(testServer.baseUrl, "/api/auth/signup/request", {
    method: "POST",
    body: {
      role: "student",
      name: "Email Test",
      email: "email-test@kgpian.iitkgp.ac.in",
      password: "student-password",
    },
  });
  assert.equal(requested.response.status, 503);
  assert.equal("devCode" in requested.body, false);
});

test("signup creates and signs in an account without email delivery or OTP", async (t) => {
  const testServer = await createTestServer({
    env: {
      NODE_ENV: "production",
      ALLOW_DEV_VERIFICATION_CODE: "false",
    },
  });
  t.after(async () => {
    await testServer.close();
    await fs.rm(testServer.directory, { recursive: true, force: true });
  });

  const created = await request(testServer.baseUrl, "/api/auth/signup", {
    method: "POST",
    body: {
      role: "student",
      name: "Password Only Student",
      email: "password-only@kgpian.iitkgp.ac.in",
      password: "student-password",
    },
  });
  assert.equal(created.response.status, 201);
  assert.ok(created.body.token);
  assert.equal(created.body.user.email, "password-only@kgpian.iitkgp.ac.in");
  assert.equal(created.body.user.verifiedAt, null);

  const session = await request(testServer.baseUrl, "/api/me", {
    token: created.body.token,
  });
  assert.equal(session.response.status, 200);
  assert.equal(session.body.user.email, "password-only@kgpian.iitkgp.ac.in");
});

test("a professor can create several courses, each with its own join code", async (t) => {
  const testServer = await createTestServer({
    env: { NODE_ENV: "production", FACULTY_SIGNUP_CODE: "" },
  });
  t.after(async () => {
    await testServer.close();
    await fs.rm(testServer.directory, { recursive: true, force: true });
  });

  const professor = await createVerifiedUser(testServer.baseUrl, {
    role: "faculty",
    name: "Department Professor",
    email: "dkpra@mech.iitkgp.ac.in",
    password: "professor-password",
  });

  // A brand new workspace holds nothing at all.
  const empty = await request(testServer.baseUrl, "/api/courses", {
    token: professor.token,
  });
  assert.deepEqual(empty.body.courses, []);

  const first = await createCourse(testServer.baseUrl, professor.token, {
    name: "Soft Computing",
    courseCode: "MF41601",
    students: rosterOf(4, "MFTEST", "Soft Student"),
  });
  const second = await createCourse(testServer.baseUrl, professor.token, {
    name: "Knowledge Based Systems in Engineering",
    courseCode: "ME60353",
    students: rosterOf(2, "METEST", "KBS Student"),
  });

  const owned = await request(testServer.baseUrl, "/api/courses", {
    token: professor.token,
  });
  assert.equal(owned.body.courses.length, 2);
  assert.ok(owned.body.courses.every((course) => course.owned && course.rosterReady));
  assert.match(first.code, /^[A-Z0-9]{8}$/);
  assert.match(second.code, /^[A-Z0-9]{8}$/);
  assert.notEqual(first.code, second.code);

  const duplicate = await request(testServer.baseUrl, "/api/courses", {
    method: "POST",
    token: professor.token,
    body: { name: "Repeat", courseCode: "MF41601" },
  });
  assert.equal(duplicate.response.status, 409);

  // A student joins each course with the roll number from its own list.
  const student = await createVerifiedUser(testServer.baseUrl, {
    role: "student",
    name: "Dual Enrolled",
    email: "dual@kgpian.iitkgp.ac.in",
    password: "student-password",
  });
  for (const [course, rollNumber] of [[first, "MFTEST0001"], [second, "METEST0001"]]) {
    const joined = await request(testServer.baseUrl, "/api/courses/join", {
      method: "POST",
      token: student.token,
      body: { code: course.code, rollNumber },
    });
    assert.equal(joined.response.status, 201);
  }
  const bootstrap = await request(testServer.baseUrl, "/api/bootstrap", {
    token: student.token,
  });
  assert.equal(bootstrap.body.enrolledCourseIds.length, 2);
});

test("the one-time reset empties the workspace completely", async (t) => {
  const testServer = await createTestServer({ env: { FACULTY_SIGNUP_CODE: "" } });
  t.after(async () => {
    await testServer.close();
    await fs.rm(testServer.directory, { recursive: true, force: true });
  });

  const professor = await createVerifiedUser(testServer.baseUrl, {
    role: "faculty",
    name: "Reset Professor",
    email: "reset-professor@iitkgp.ac.in",
    password: "professor-password",
  });
  await createCourse(testServer.baseUrl, professor.token, {
    students: rosterOf(2, "MFTEST", "Soft Student"),
  });

  const before = await testServer.store.read();
  assert.equal(before.users.length, 1);
  assert.equal(before.courses.length, 1);
  assert.equal(before.courseStudents.length, 2);

  const reset = await deleteExistingAccountsOnce(testServer.store);
  assert.deepEqual(reset, { applied: true, deletedAccounts: 1, deletedCourses: 1 });

  const after = await testServer.store.read();
  for (const key of [
    "users",
    "sessions",
    "enrollments",
    "courses",
    "courseStudents",
    "schedule",
    "attendanceSessions",
    "quizzes",
  ]) {
    assert.deepEqual(after[key], [], `${key} should be empty after the reset`);
  }
  assert.ok(after.maintenance.includes(ACCOUNT_RESET_ID));

  const repeated = await deleteExistingAccountsOnce(testServer.store);
  assert.deepEqual(repeated, { applied: false, deletedAccounts: 0, deletedCourses: 0 });
});

test("a course stays closed until its professor uploads the roll list", async (t) => {
  const testServer = await createTestServer();
  t.after(async () => {
    await testServer.close();
    await fs.rm(testServer.directory, { recursive: true, force: true });
  });

  const professor = await createVerifiedUser(testServer.baseUrl, {
    role: "faculty",
    name: "Ayush Professor",
    email: "professor@iitkgp.ac.in",
    password: "professor-password",
  });
  const student = await createVerifiedUser(testServer.baseUrl, {
    role: "student",
    name: "Ayush Student",
    email: "student@kgpian.iitkgp.ac.in",
    password: "student-password",
  });

  const course = await createCourse(testServer.baseUrl, professor.token, {
    students: [],
  });
  const ownedBefore = await request(testServer.baseUrl, "/api/courses", {
    token: professor.token,
  });
  assert.equal(ownedBefore.body.courses[0].rosterReady, false);

  const earlyJoin = await request(testServer.baseUrl, "/api/courses/join", {
    method: "POST",
    token: student.token,
    body: { code: course.code, rollNumber: "21ME10001" },
  });
  assert.equal(earlyJoin.response.status, 409);
  assert.match(earlyJoin.body.error, /has not started yet/i);

  const earlySession = await request(testServer.baseUrl, "/api/attendance/sessions", {
    method: "POST",
    token: professor.token,
    body: { courseId: course.id },
  });
  assert.equal(earlySession.response.status, 409);
  assert.match(earlySession.body.error, /roll list/i);

  const uploaded = await request(testServer.baseUrl, `/api/courses/${course.id}/roster`, {
    method: "PUT",
    token: professor.token,
    body: {
      students: [
        { rollNumber: "21ME10001", name: "Ayush Student" },
        { rollNumber: "21ME10002", name: "Second Student" },
      ],
    },
  });
  assert.equal(uploaded.response.status, 200);
  assert.equal(uploaded.body.course.rosterReady, true);

  const join = await request(testServer.baseUrl, "/api/courses/join", {
    method: "POST",
    token: student.token,
    body: { code: course.code, rollNumber: "21ME10001" },
  });
  assert.equal(join.response.status, 201);

  const session = await request(testServer.baseUrl, "/api/attendance/sessions", {
    method: "POST",
    token: professor.token,
    body: { courseId: course.id },
  });
  assert.equal(session.response.status, 201);
  assert.deepEqual(
    session.body.attendance.records.map((record) => record.rollNumber),
    ["21ME10001", "21ME10002"],
  );

  const marked = await request(
    testServer.baseUrl,
    `/api/attendance/${session.body.attendance.id}/check-in`,
    {
      method: "POST",
      token: student.token,
      body: { signals: { wifi: true, bluetooth: true } },
    },
  );
  assert.equal(marked.response.status, 201);
});

test("students mark their own attendance only while the professor's session is open", async (t) => {
  const testServer = await createTestServer();
  t.after(async () => {
    await testServer.close();
    await fs.rm(testServer.directory, { recursive: true, force: true });
  });

  const professor = await createVerifiedUser(testServer.baseUrl, {
    role: "faculty",
    name: "Ayush Professor",
    email: "professor@iitkgp.ac.in",
    password: "professor-password",
  });
  const student = await createVerifiedUser(testServer.baseUrl, {
    role: "student",
    name: "Ayush Student",
    email: "student@kgpian.iitkgp.ac.in",
    password: "student-password",
  });
  const outsider = await createVerifiedUser(testServer.baseUrl, {
    role: "student",
    name: "Other Student",
    email: "outsider@kgpian.iitkgp.ac.in",
    password: "outsider-password",
  });

  const soft = await createCourse(testServer.baseUrl, professor.token, {
    students: rosterOf(4, "MFTEST", "Soft Student"),
  });
  // Admission is checked against the roll list at join time.
  const notAdmitted = await request(testServer.baseUrl, "/api/courses/join", {
    method: "POST",
    token: student.token,
    body: { code: soft.code, rollNumber: "NOTONROSTER" },
  });
  assert.equal(notAdmitted.response.status, 403);
  assert.match(notAdmitted.body.error, /not admitted/i);

  const noRoll = await request(testServer.baseUrl, "/api/courses/join", {
    method: "POST",
    token: student.token,
    body: { code: soft.code },
  });
  assert.equal(noRoll.response.status, 400);

  for (const [token, rollNumber] of [
    [student.token, "MFTEST0001"],
    [outsider.token, "MFTEST0002"],
  ]) {
    const joined = await request(testServer.baseUrl, "/api/courses/join", {
      method: "POST",
      token,
      body: { code: soft.code, rollNumber },
    });
    assert.equal(joined.response.status, 201);
  }

  const goodSignals = { wifi: true, bluetooth: true };

  // Nothing to join before the professor starts the session.
  const beforeOpen = await request(testServer.baseUrl, "/api/attendance/open", {
    token: student.token,
  });
  assert.equal(beforeOpen.response.status, 200);
  assert.deepEqual(beforeOpen.body.sessions, []);
  const early = await request(testServer.baseUrl, "/api/attendance/attendance-missing/check-in", {
    method: "POST",
    token: student.token,
    body: { rollNumber: "MFTEST0001", signals: goodSignals },
  });
  assert.equal(early.response.status, 404);

  const started = await request(testServer.baseUrl, "/api/attendance/sessions", {
    method: "POST",
    token: professor.token,
    body: { courseId: soft.id },
  });
  assert.equal(started.response.status, 201);
  const sessionId = started.body.attendance.id;

  const visible = await request(testServer.baseUrl, "/api/attendance/open", {
    token: student.token,
  });
  assert.equal(visible.body.sessions.length, 1);
  assert.equal(visible.body.sessions[0].id, sessionId);
  assert.equal(visible.body.sessions[0].checkedIn, false);

  // Wi-Fi and Bluetooth must both be reported before the roll number is read.
  for (const signals of [{ wifi: false, bluetooth: true }, { wifi: true, bluetooth: false }, {}]) {
    const blocked = await request(testServer.baseUrl, `/api/attendance/${sessionId}/check-in`, {
      method: "POST",
      token: student.token,
      body: { rollNumber: "MFTEST0001", signals },
    });
    assert.equal(blocked.response.status, 400);
  }

  const checkedIn = await request(testServer.baseUrl, `/api/attendance/${sessionId}/check-in`, {
    method: "POST",
    token: student.token,
    body: { rollNumber: "MFTEST0001", signals: goodSignals },
  });
  assert.equal(checkedIn.response.status, 201);
  assert.equal(checkedIn.body.checkedIn, true);
  assert.equal(checkedIn.body.rollNumber, "MFTEST0001");
  // The student payload must not carry the rest of the roster.
  assert.equal("records" in checkedIn.body, false);

  // A roll number bound at join cannot be claimed by a second account.
  const stolen = await request(testServer.baseUrl, "/api/courses/join", {
    method: "POST",
    token: outsider.token,
    body: { code: soft.code, rollNumber: "MFTEST0001" },
  });
  assert.equal(stolen.response.status, 200);
  assert.equal(stolen.body.existing, true);

  // Marking uses the roll bound at join, never one supplied at check-in time.
  const spoofed = await request(testServer.baseUrl, `/api/attendance/${sessionId}/check-in`, {
    method: "POST",
    token: outsider.token,
    body: { rollNumber: "MFTEST0001", signals: goodSignals },
  });
  assert.equal(spoofed.response.status, 201);
  assert.equal(spoofed.body.rollNumber, "MFTEST0002");

  // Once bound, the roll number no longer has to be supplied.
  const repeat = await request(testServer.baseUrl, `/api/attendance/${sessionId}/check-in`, {
    method: "POST",
    token: student.token,
    body: { signals: goodSignals },
  });
  assert.equal(repeat.response.status, 201);
  assert.equal(repeat.body.rollNumber, "MFTEST0001");

  const professorView = await request(testServer.baseUrl, `/api/attendance/${sessionId}`, {
    token: professor.token,
  });
  const marked = professorView.body.attendance.records.find(
    (record) => record.rollNumber === "MFTEST0001",
  );
  assert.equal(marked.present, true);
  assert.equal(marked.markedBy, student.user.id);
  assert.equal(marked.markedVia, "student");

  const studentStatus = await request(testServer.baseUrl, "/api/attendance/open", {
    token: student.token,
  });
  assert.equal(studentStatus.body.sessions[0].checkedIn, true);

  // Closing the session ends student self-marking.
  const closed = await request(testServer.baseUrl, `/api/attendance/${sessionId}/close`, {
    method: "POST",
    token: professor.token,
  });
  assert.equal(closed.response.status, 200);
  const afterClose = await request(testServer.baseUrl, `/api/attendance/${sessionId}/check-in`, {
    method: "POST",
    token: student.token,
    body: { signals: goodSignals },
  });
  assert.equal(afterClose.response.status, 404);
  const noneOpen = await request(testServer.baseUrl, "/api/attendance/open", {
    token: student.token,
  });
  assert.deepEqual(noneOpen.body.sessions, []);
});

test("professors sign up from department subdomains, students do not", async (t) => {
  const testServer = await createTestServer({ env: { FACULTY_SIGNUP_CODE: "" } });
  t.after(async () => {
    await testServer.close();
    await fs.rm(testServer.directory, { recursive: true, force: true });
  });

  const departmentProfessor = await request(testServer.baseUrl, "/api/auth/signup", {
    method: "POST",
    body: {
      role: "faculty",
      name: "Department Professor",
      email: "dkpra@mech.iitkgp.ac.in",
      password: "professor-password",
    },
  });
  assert.equal(departmentProfessor.response.status, 201);

  const plainProfessor = await request(testServer.baseUrl, "/api/auth/signup", {
    method: "POST",
    body: {
      role: "faculty",
      name: "Institute Professor",
      email: "someone@iitkgp.ac.in",
      password: "professor-password",
    },
  });
  assert.equal(plainProfessor.response.status, 201);

  // A student address may not register as faculty.
  const studentAsProfessor = await request(testServer.baseUrl, "/api/auth/signup", {
    method: "POST",
    body: {
      role: "faculty",
      name: "Not A Professor",
      email: "student@kgpian.iitkgp.ac.in",
      password: "professor-password",
    },
  });
  assert.equal(studentAsProfessor.response.status, 400);
  assert.match(studentAsProfessor.body.error, /iitkgp\.ac\.in email/i);

  const outsider = await request(testServer.baseUrl, "/api/auth/signup", {
    method: "POST",
    body: {
      role: "faculty",
      name: "Outsider",
      email: "someone@example.com",
      password: "professor-password",
    },
  });
  assert.equal(outsider.response.status, 400);
});

test("passwords can be changed while signed in and reset by email", async (t) => {
  let sentCode = "";
  const testServer = await createTestServer({
    env: { FACULTY_SIGNUP_CODE: "" },
    mailer: {
      configured: true,
      provider: "smtp",
      async sendVerification({ code }) {
        sentCode = code;
        return { delivered: true };
      },
      async sendPasswordReset({ code }) {
        sentCode = code;
        return { delivered: true };
      },
    },
  });
  t.after(async () => {
    await testServer.close();
    await fs.rm(testServer.directory, { recursive: true, force: true });
  });

  const student = await createVerifiedUser(testServer.baseUrl, {
    role: "student",
    name: "Password Student",
    email: "password-student@kgpian.iitkgp.ac.in",
    password: "first-password",
  });

  const wrongCurrent = await request(testServer.baseUrl, "/api/auth/password", {
    method: "POST",
    token: student.token,
    body: { currentPassword: "not-the-password", newPassword: "second-password" },
  });
  assert.equal(wrongCurrent.response.status, 403);

  const tooShort = await request(testServer.baseUrl, "/api/auth/password", {
    method: "POST",
    token: student.token,
    body: { currentPassword: "first-password", newPassword: "short" },
  });
  assert.equal(tooShort.response.status, 400);

  const changed = await request(testServer.baseUrl, "/api/auth/password", {
    method: "POST",
    token: student.token,
    body: { currentPassword: "first-password", newPassword: "second-password" },
  });
  assert.equal(changed.response.status, 200);

  const oldPassword = await request(testServer.baseUrl, "/api/auth/login", {
    method: "POST",
    body: {
      email: "password-student@kgpian.iitkgp.ac.in",
      password: "first-password",
      role: "student",
    },
  });
  assert.equal(oldPassword.response.status, 401);

  // The session that made the change keeps working.
  const stillSignedIn = await request(testServer.baseUrl, "/api/me", {
    token: student.token,
  });
  assert.equal(stillSignedIn.response.status, 200);

  // An unknown address is answered exactly like a known one.
  const unknown = await request(testServer.baseUrl, "/api/auth/password/forgot", {
    method: "POST",
    body: { email: "nobody@kgpian.iitkgp.ac.in" },
  });
  assert.equal(unknown.response.status, 202);

  const requested = await request(testServer.baseUrl, "/api/auth/password/forgot", {
    method: "POST",
    body: { email: "password-student@kgpian.iitkgp.ac.in" },
  });
  assert.equal(requested.response.status, 202);
  assert.equal("code" in requested.body, false);
  assert.match(sentCode, /^\d{6}$/);

  const wrongCode = await request(testServer.baseUrl, "/api/auth/password/reset", {
    method: "POST",
    body: {
      email: "password-student@kgpian.iitkgp.ac.in",
      code: "000000",
      newPassword: "third-password",
    },
  });
  assert.equal(wrongCode.response.status, 400);

  const reset = await request(testServer.baseUrl, "/api/auth/password/reset", {
    method: "POST",
    body: {
      email: "password-student@kgpian.iitkgp.ac.in",
      code: sentCode,
      newPassword: "third-password",
    },
  });
  assert.equal(reset.response.status, 200);

  const signedIn = await request(testServer.baseUrl, "/api/auth/login", {
    method: "POST",
    body: {
      email: "password-student@kgpian.iitkgp.ac.in",
      password: "third-password",
      role: "student",
    },
  });
  assert.equal(signedIn.response.status, 200);

  // The reset code is single use and every old session is gone.
  const reused = await request(testServer.baseUrl, "/api/auth/password/reset", {
    method: "POST",
    body: {
      email: "password-student@kgpian.iitkgp.ac.in",
      code: sentCode,
      newPassword: "fourth-password",
    },
  });
  assert.equal(reused.response.status, 400);
  const revoked = await request(testServer.baseUrl, "/api/me", { token: student.token });
  assert.equal(revoked.response.status, 401);
});

test("password reset says so plainly when email delivery is off", async (t) => {
  const testServer = await createTestServer({ env: { FACULTY_SIGNUP_CODE: "" } });
  t.after(async () => {
    await testServer.close();
    await fs.rm(testServer.directory, { recursive: true, force: true });
  });

  const forgot = await request(testServer.baseUrl, "/api/auth/password/forgot", {
    method: "POST",
    body: { email: "anyone@kgpian.iitkgp.ac.in" },
  });
  assert.equal(forgot.response.status, 503);
  assert.match(forgot.body.error, /unavailable/i);
});

test("production stays healthy with no configuration and no courses", async (t) => {
  const testServer = await createTestServer({
    env: {
      NODE_ENV: "production",
      ALLOW_DEV_VERIFICATION_CODE: "false",
      FACULTY_SIGNUP_CODE: "",
      TA_SIGNUP_CODE: "",
    },
  });
  t.after(async () => {
    await testServer.close();
    await fs.rm(testServer.directory, { recursive: true, force: true });
  });

  const health = await request(testServer.baseUrl, "/api/health");
  assert.equal(health.response.status, 200);
  assert.equal(health.body.ok, true);

  const created = await request(testServer.baseUrl, "/api/auth/signup", {
    method: "POST",
    body: {
      role: "student",
      name: "Unconfigured Student",
      email: "unconfigured@kgpian.iitkgp.ac.in",
      password: "student-password",
    },
  });
  assert.equal(created.response.status, 201);

  const bootstrap = await request(testServer.baseUrl, "/api/bootstrap", {
    token: created.body.token,
  });
  assert.deepEqual(bootstrap.body.courses, []);
  assert.deepEqual(bootstrap.body.enrolledCourseIds, []);
});

test("production signup sends the verification code through the configured mailer", async (t) => {
  let sentMessage;
  const testServer = await createTestServer({
    env: {
      NODE_ENV: "production",
      ALLOW_DEV_VERIFICATION_CODE: "false",
    },
    mailer: {
      configured: true,
      provider: "test",
      async sendVerification(message) {
        sentMessage = message;
        return { delivered: true };
      },
    },
  });
  t.after(async () => {
    await testServer.close();
    await fs.rm(testServer.directory, { recursive: true, force: true });
  });

  const requested = await request(testServer.baseUrl, "/api/auth/signup/request", {
    method: "POST",
    body: {
      role: "student",
      name: "Delivered Email",
      email: "delivered@kgpian.iitkgp.ac.in",
      password: "student-password",
    },
  });
  assert.equal(requested.response.status, 202);
  assert.equal("devCode" in requested.body, false);
  assert.equal(sentMessage.email, "delivered@kgpian.iitkgp.ac.in");
  assert.match(sentMessage.code, /^\d{6}$/);
});

test("faculty signup ignores legacy invitations while TA still requires one", async (t) => {
  const testServer = await createTestServer();
  t.after(async () => {
    await testServer.close();
    await fs.rm(testServer.directory, { recursive: true, force: true });
  });

  const baseUser = {
    role: "faculty",
    name: "Uninvited Faculty",
    email: "uninvited@iitkgp.ac.in",
    password: "faculty-password",
  };
  const missingCode = await request(
    testServer.baseUrl,
    "/api/auth/signup",
    { method: "POST", body: baseUser },
  );
  assert.equal(missingCode.response.status, 201);

  const uninvitedTA = await request(
    testServer.baseUrl,
    "/api/auth/signup",
    {
      method: "POST",
      body: {
        role: "ta",
        name: "Uninvited Assistant",
        email: "uninvited-ta@iitkgp.ac.in",
        password: "assistant-password",
      },
    },
  );
  assert.equal(uninvitedTA.response.status, 403);
});



