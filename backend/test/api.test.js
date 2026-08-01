const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../src/app");
const { initialData, normalizeData } = require("../src/database");
const { ACCOUNT_RESET_ID, deleteExistingAccountsOnce } = require("../src/maintenance");

function syntheticRoster(courseCode, courseTitle, count, rollPrefix, namePrefix) {
  return {
    courseCode,
    courseTitle,
    term: "AUTUMN, 2026-2027",
    studentCount: count,
    students: Array.from({ length: count }, (_, index) => ({
      serial: index + 1,
      rollNumber: `${rollPrefix}${String(index + 1).padStart(4, "0")}`,
      name: `${namePrefix} ${String(index + 1).padStart(3, "0")}`,
    })),
  };
}

const TEST_ROSTERS_JSON = JSON.stringify([
  syntheticRoster("MF41601", "SOFT COMPUTING", 310, "MFTEST", "Soft Student"),
  syntheticRoster(
    "ME60353",
    "KNOWLEDGE BASED SYSTEMS IN ENGINEERING",
    22,
    "METEST",
    "KBS Student",
  ),
]);
const TEST_ROSTER_ENV = { COURSE_ROSTERS_JSON: TEST_ROSTERS_JSON };
const TEST_OWNER_EMAILS = JSON.stringify({
  soft401: "professor@iitkgp.ac.in",
  kbs60353: "professor@iitkgp.ac.in",
});

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
      COURSE_OWNER_EMAILS_JSON: TEST_OWNER_EMAILS,
      COURSE_JOIN_CODES_JSON: JSON.stringify({
        soft401: "SC401A",
        kbs60353: "KB60353",
      }),
      ...TEST_ROSTER_ENV,
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

  const softRoster = await request(
    testServer.baseUrl,
    "/api/courses/soft401/roster",
    { token: professor.token },
  );
  assert.equal(softRoster.response.status, 200);
  assert.equal(softRoster.body.course.courseCode, "MF41601");
  assert.equal(softRoster.body.students.length, 310);
  assert.deepEqual(softRoster.body.students[0], {
    courseId: "soft401",
    serial: 1,
    rollNumber: "MFTEST0001",
    name: "Soft Student 001",
  });
  assert.deepEqual(softRoster.body.students.at(-1), {
    courseId: "soft401",
    serial: 310,
    rollNumber: "MFTEST0310",
    name: "Soft Student 310",
  });

  const kbsRoster = await request(
    testServer.baseUrl,
    "/api/courses/kbs60353/roster",
    { token: professor.token },
  );
  assert.equal(kbsRoster.response.status, 200);
  assert.equal(kbsRoster.body.course.courseCode, "ME60353");
  assert.equal(kbsRoster.body.students.length, 22);
  assert.equal(kbsRoster.body.students.at(-1).rollNumber, "METEST0022");

  for (const token of [student.token, teachingAssistant.token]) {
    const restrictedRoster = await request(
      testServer.baseUrl,
      "/api/courses/soft401/roster",
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
    body: { code: "SC401A" },
  });
  assert.equal(joined.response.status, 201);
  assert.equal(joined.body.course.id, "soft401");
  assert.equal("code" in joined.body.course, false);

  const bootstrap = await request(testServer.baseUrl, "/api/bootstrap", {
    token: student.token,
  });
  assert.equal(bootstrap.response.status, 200);
  assert.deepEqual(bootstrap.body.enrolledCourseIds, ["soft401"]);
  assert.equal("attendance" in bootstrap.body, false);
  assert.equal("attendanceByCourse" in bootstrap.body, false);
  assert.equal(bootstrap.body.schedule.length, 2);
  assert.equal(bootstrap.body.courses[0].room, "NR221");
  assert.equal(bootstrap.body.courses[0].courseCode, "MF41601");
  assert.equal(bootstrap.body.courses[0].students, 310);
  assert.deepEqual(
    bootstrap.body.schedule.map(({ day, start, end, room }) => ({
      day,
      start,
      end,
      room,
    })),
    [
      { day: "Monday", start: "3:00 PM", end: "5:00 PM", room: "NR221" },
      { day: "Tuesday", start: "2:00 PM", end: "4:00 PM", room: "NR221" },
    ],
  );

  const openedAttendance = await request(
    testServer.baseUrl,
    "/api/attendance/sessions",
    {
      method: "POST",
      token: professor.token,
      body: { courseId: "soft401", scheduleId: "schedule-2" },
    },
  );
  assert.equal(openedAttendance.response.status, 201);
  const attendanceId = openedAttendance.body.attendance.id;
  assert.equal(openedAttendance.body.attendance.records.length, 310);
  assert.equal(openedAttendance.body.attendance.records[0].present, false);

  for (const token of [student.token, teachingAssistant.token]) {
    const restrictedCurrent = await request(
      testServer.baseUrl,
      "/api/attendance/current?courseId=soft401",
      { token },
    );
    assert.equal(restrictedCurrent.response.status, 403);
  }

  const checkIn = await request(
    testServer.baseUrl,
    `/api/attendance/${attendanceId}/check-in`,
    {
      method: "POST",
      token: student.token,
      body: { wifi: true, bluetooth: true },
    },
  );
  assert.equal(checkIn.response.status, 403);
  assert.match(checkIn.body.error, /teaching team/i);

  const taJoinedSoft = await request(testServer.baseUrl, "/api/courses/join", {
    method: "POST",
    token: teachingAssistant.token,
    body: { code: "SC401A" },
  });
  assert.equal(taJoinedSoft.response.status, 201);
  assert.equal(taJoinedSoft.body.course.capabilities.canRunAttendance, true);
  assert.equal(taJoinedSoft.body.course.capabilities.canManageCourse, false);
  assert.equal("code" in taJoinedSoft.body.course, false);

  const taJoinedKbs = await request(testServer.baseUrl, "/api/courses/join", {
    method: "POST",
    token: teachingAssistant.token,
    body: { code: "KB60353" },
  });
  assert.equal(taJoinedKbs.response.status, 201);

  const taRoster = await request(
    testServer.baseUrl,
    "/api/courses/soft401/roster",
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
      body: { courseId: "kbs60353" },
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
      courseId: "soft401",
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
      courseId: "soft401",
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
    "/api/attendance/current?courseId=soft401",
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
      body: { courseId: "kbs60353" },
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
      body: { courseId: "soft401" },
    },
  );
  assert.equal(reopenedSoftAttendance.response.status, 201);

  for (const [courseId, attendance] of [
    ["soft401", reopenedSoftAttendance.body.attendance],
    ["kbs60353", openedKbsAttendance.body.attendance],
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
    "/api/courses/soft401/roster",
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
    "/api/courses/soft401/roster",
    { token: otherProfessor.token },
  );
  assert.equal(crossRosterAttempt.response.status, 403);

  const crossAttendanceAttempt = await request(
    testServer.baseUrl,
    "/api/attendance/sessions",
    {
      method: "POST",
      token: otherProfessor.token,
      body: { courseId: "soft401" },
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

test("first professor automatically owns courses and receives working join codes", async (t) => {
  const testServer = await createTestServer({
    env: {
      NODE_ENV: "production",
      FACULTY_SIGNUP_CODE: "",
      COURSE_OWNER_EMAILS_JSON: "",
      COURSE_JOIN_CODES_JSON: "",
    },
  });
  t.after(async () => {
    await testServer.close();
    await fs.rm(testServer.directory, { recursive: true, force: true });
  });

  const professor = await request(testServer.baseUrl, "/api/auth/signup", {
    method: "POST",
    body: {
      role: "faculty",
      name: "Automatic Professor",
      email: "automatic-professor@iitkgp.ac.in",
      password: "professor-password",
    },
  });
  assert.equal(professor.response.status, 201);

  const professorCourses = await request(testServer.baseUrl, "/api/courses", {
    token: professor.body.token,
  });
  assert.equal(professorCourses.response.status, 200);
  assert.equal(professorCourses.body.courses.length, 2);
  const softCourse = professorCourses.body.courses.find(
    (course) => course.id === "soft401",
  );
  assert.match(softCourse.code, /^[A-Z0-9]{8}$/);

  const student = await request(testServer.baseUrl, "/api/auth/signup", {
    method: "POST",
    body: {
      role: "student",
      name: "Automatic Student",
      email: "automatic-student@kgpian.iitkgp.ac.in",
      password: "student-password",
    },
  });
  assert.equal(student.response.status, 201);

  const joined = await request(testServer.baseUrl, "/api/courses/join", {
    method: "POST",
    token: student.body.token,
    body: { code: softCourse.code },
  });
  assert.equal(joined.response.status, 201);
  assert.equal(joined.body.course.id, "soft401");

  const professorLogin = await request(testServer.baseUrl, "/api/auth/login", {
    method: "POST",
    body: {
      role: "faculty",
      email: "automatic-professor@iitkgp.ac.in",
      password: "professor-password",
    },
  });
  const coursesAfterLogin = await request(testServer.baseUrl, "/api/courses", {
    token: professorLogin.body.token,
  });
  assert.equal(
    coursesAfterLogin.body.courses.find((course) => course.id === "soft401").code,
    softCourse.code,
  );
});

test("one-time account reset removes existing identities but preserves course data", async (t) => {
  const testServer = await createTestServer({
    env: {
      FACULTY_SIGNUP_CODE: "",
      COURSE_OWNER_EMAILS_JSON: "",
    },
  });
  t.after(async () => {
    await testServer.close();
    await fs.rm(testServer.directory, { recursive: true, force: true });
  });

  const professor = await request(testServer.baseUrl, "/api/auth/signup", {
    method: "POST",
    body: {
      role: "faculty",
      name: "Reset Professor",
      email: "reset-professor@iitkgp.ac.in",
      password: "professor-password",
    },
  });
  assert.equal(professor.response.status, 201);
  const before = await testServer.store.read();
  assert.equal(before.users.length, 1);
  assert.ok(before.courses.some((course) => course.ownerId));

  const reset = await deleteExistingAccountsOnce(testServer.store);
  assert.deepEqual(reset, { applied: true, deletedAccounts: 1 });
  const after = await testServer.store.read();
  assert.equal(after.users.length, 0);
  assert.equal(after.sessions.length, 0);
  assert.equal(after.enrollments.length, 0);
  assert.ok(after.courses.length >= 2);
  assert.ok(after.courses.every((course) => !course.ownerId));
  assert.ok(after.maintenance.includes(ACCOUNT_RESET_ID));

  const repeated = await deleteExistingAccountsOnce(testServer.store);
  assert.deepEqual(repeated, { applied: false, deletedAccounts: 0 });
});

test("production stays healthy and usable when course env vars are unset", async (t) => {
  const testServer = await createTestServer({
    env: {
      NODE_ENV: "production",
      ALLOW_DEV_VERIFICATION_CODE: "false",
      COURSE_JOIN_CODES_JSON: "",
      COURSE_OWNER_EMAILS_JSON: "",
      COURSE_ROSTERS_JSON: "",
      COURSE_ROSTERS_PATH: path.join(os.tmpdir(), "campuspulse-missing-rosters.json"),
    },
  });
  t.after(async () => {
    await testServer.close();
    await fs.rm(testServer.directory, { recursive: true, force: true });
  });

  const health = await request(testServer.baseUrl, "/api/health");
  assert.equal(health.response.status, 200);
  assert.equal(health.body.ok, true);
  assert.deepEqual(health.body.lockedCourses, ["soft401", "kbs60353"]);

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

  const joined = await request(testServer.baseUrl, "/api/courses/join", {
    method: "POST",
    token: created.body.token,
    body: { code: "SC401A" },
  });
  assert.equal(joined.response.status, 404);
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

test("configured faculty and TA signup require administrator invitation codes", async (t) => {
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
  assert.equal(missingCode.response.status, 403);

  const wrongCode = await request(
    testServer.baseUrl,
    "/api/auth/signup",
    { method: "POST", body: { ...baseUser, roleCode: "wrong-code" } },
  );
  assert.equal(wrongCode.response.status, 403);

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

test("roster seed and legacy normalization preserve exact course identities", () => {
  const seeded = initialData(TEST_ROSTER_ENV);
  const softStudents = seeded.courseStudents.filter(
    (student) => student.courseId === "soft401",
  );
  const kbsStudents = seeded.courseStudents.filter(
    (student) => student.courseId === "kbs60353",
  );
  assert.equal(softStudents.length, 310);
  assert.equal(kbsStudents.length, 22);
  assert.equal(new Set(seeded.courseStudents.map((student) => student.rollNumber)).size, 332);
  for (const students of [softStudents, kbsStudents]) {
    assert.deepEqual(
      students.map((student) => student.serial),
      Array.from({ length: students.length }, (_, index) => index + 1),
    );
  }

  const legacy = normalizeData({
    users: [{ id: "existing-user", name: "Soft Student 001" }],
    courses: [
      {
        id: "soft401",
        name: "Soft Computing",
        courseCode: "CSE 401",
        students: 42,
      },
    ],
    attendanceSessions: [
      {
        id: "legacy-attendance",
        courseId: "soft401",
        status: "open",
        present: [
          { userId: "existing-user", checkedInAt: "2026-07-30T09:00:00.000Z" },
        ],
      },
    ],
  }, TEST_ROSTER_ENV);
  assert.deepEqual(legacy.users, [
    { id: "existing-user", name: "Soft Student 001" },
  ]);
  assert.equal(legacy.courses[0].courseCode, "MF41601");
  assert.equal(legacy.courses[0].students, 310);
  assert.equal(legacy.courses[1].courseCode, "ME60353");
  assert.equal(legacy.courseStudents.length, 332);
  assert.equal(legacy.attendanceSessions[0].records.length, 310);
  assert.equal(legacy.attendanceSessions[0].records[0].rollNumber, "MFTEST0001");
  assert.equal(legacy.attendanceSessions[0].records[0].present, true);

  const noRosterEnv = {
    COURSE_ROSTERS_PATH: path.join(os.tmpdir(), "campuspulse-missing-roster.json"),
  };
  const freshWithoutSecret = initialData(noRosterEnv);
  assert.equal(freshWithoutSecret.courseStudents.length, 0);
  assert.deepEqual(
    freshWithoutSecret.courses.map((course) => course.students),
    [310, 22],
  );
  const preservedWithoutSecret = normalizeData(
    { courseStudents: seeded.courseStudents },
    noRosterEnv,
  );
  assert.equal(preservedWithoutSecret.courseStudents.length, 332);

  const deferredLegacy = normalizeData(
    {
      users: legacy.users,
      attendanceSessions: [
        {
          id: "deferred-legacy-attendance",
          courseId: "soft401",
          status: "closed",
          present: [
            { userId: "existing-user", checkedInAt: "2026-07-30T09:00:00.000Z" },
          ],
        },
      ],
    },
    noRosterEnv,
  );
  assert.equal(deferredLegacy.attendanceSessions[0].records, undefined);
  const restoredDeferredLegacy = normalizeData(deferredLegacy, TEST_ROSTER_ENV);
  assert.equal(restoredDeferredLegacy.attendanceSessions[0].records.length, 310);
  assert.equal(restoredDeferredLegacy.attendanceSessions[0].records[0].present, true);

  const ownerUploadedRoster = normalizeData(
    {
      courses: [
        {
          id: "soft401",
          name: "Soft Computing",
          courseCode: "MF41601",
          students: 2,
          ownerId: "owner-user",
          rosterSource: "owner-upload",
        },
      ],
      courseStudents: [
        {
          courseId: "soft401",
          serial: 1,
          rollNumber: "OWNER001",
          name: "Owner Uploaded One",
        },
        {
          courseId: "soft401",
          serial: 2,
          rollNumber: "OWNER002",
          name: "Owner Uploaded Two",
        },
      ],
    },
    TEST_ROSTER_ENV,
  );
  assert.equal(ownerUploadedRoster.courses[0].ownerId, "owner-user");
  assert.equal(ownerUploadedRoster.courses[0].students, 2);
  assert.deepEqual(
    ownerUploadedRoster.courseStudents
      .filter((student) => student.courseId === "soft401")
      .map((student) => student.rollNumber),
    ["OWNER001", "OWNER002"],
  );
});

test("production course loading stays available when join codes are incomplete", () => {
  const productionWithoutCodes = initialData({
    ...TEST_ROSTER_ENV,
    NODE_ENV: "production",
    COURSE_JOIN_CODES_JSON: JSON.stringify({ kbs60353: "KB60353-PRIVATE" }),
  });
  const softCourse = productionWithoutCodes.courses.find(
    (course) => course.id === "soft401",
  );
  const kbsCourse = productionWithoutCodes.courses.find(
    (course) => course.id === "kbs60353",
  );

  assert.match(softCourse.code, /^LOCKED-[A-F0-9]{16}$/);
  assert.notEqual(softCourse.code, "SC401A");
  assert.equal(kbsCourse.code, "KB60353-PRIVATE");
});

test("a malformed configured join code locks the course instead of failing", () => {
  const productionWithBadCode = initialData({
    ...TEST_ROSTER_ENV,
    NODE_ENV: "production",
    COURSE_JOIN_CODES_JSON: JSON.stringify({
      soft401: "no",
      kbs60353: "KBS_UNDERSCORE",
    }),
  });

  for (const courseId of ["soft401", "kbs60353"]) {
    const course = productionWithBadCode.courses.find((item) => item.id === courseId);
    assert.match(course.code, /^LOCKED-[A-F0-9]{16}$/);
  }
});
