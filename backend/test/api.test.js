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
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(`${baseUrl}${route}`, {
    method: options.method || "GET",
    headers,
    body:
      options.rawBody !== undefined
        ? options.rawBody
        : options.body !== undefined
          ? JSON.stringify(options.body)
          : undefined,
  });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  return { response, body };
}

async function createVerifiedUser(baseUrl, user) {
  const signupBody = {
    phone: "9876543210",
    department: user.department || "Mechanical Engineering",
    ...(user.role === "faculty" ? {} : { rollNumber: user.rollNumber || `TEST${Math.random().toString(36).slice(2, 8).toUpperCase()}`, hall: "Azad Hall" }),
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
  assert.equal(created.body.user.department, signupBody.department);
  assert.ok(created.body.token);

  const loggedIn = await request(baseUrl, "/api/auth/login", {
    method: "POST",
    body: { email: user.email, password: user.password, role: user.role },
  });
  assert.equal(loggedIn.response.status, 200);
  assert.equal(loggedIn.body.user.department, signupBody.department);
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

// Committing a quiz needs a class, a time limit and a reveal mode.
async function addClass(baseUrl, token, courseId, revision = 0) {
  const saved = await request(baseUrl, `/api/courses/${courseId}/schedule`, {
    method: "PUT",
    token,
    body: {
      revision,
      classes: [{ day: "Monday", start: "3:00 PM", end: "5:00 PM", topic: "Lecture" }],
    },
  });
  assert.equal(saved.response.status, 200);
  return saved.body.schedule[0].id;
}

// Students prove they are in the room with the code the team's screen shows.
async function attendanceCode(baseUrl, token, sessionId) {
  const shown = await request(baseUrl, `/api/attendance/${sessionId}/code`, { token });
  assert.equal(shown.response.status, 200);
  assert.match(shown.body.code, /^[0-9A-F]{6}$/);
  return shown.body.code;
}

function quizSettings(scheduleId, overrides = {}) {
  return {
    scheduleId,
    day: "Monday",
    classLabel: "Monday · 3:00 PM–5:00 PM",
    timeLimitMinutes: 5,
    reveal: "after-quiz",
    quizDate: "2026-08-03",
    ...overrides,
  };
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
    rollNumber: "MFTEST0001",
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
  const softClassId = await addClass(testServer.baseUrl, professor.token, soft.id);

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
    body: { code: soft.code },
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
  // The one class added above so a quiz can be tied to it.
  assert.equal(bootstrap.body.schedule.length, 1);
  assert.equal(bootstrap.body.courses[0].room, "NR221");
  assert.equal(bootstrap.body.courses[0].courseCode, "MF41601");
  assert.equal(bootstrap.body.courses[0].students, 310);
  assert.deepEqual(bootstrap.body.teachingAssistants, []);

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
  assert.equal(taJoinedSoft.body.course.capabilities.canManageSchedule, true);
  assert.equal(taJoinedSoft.body.course.capabilities.canManageRoster, true);
  assert.equal(taJoinedSoft.body.course.capabilities.canUploadMaterials, true);
  assert.equal("code" in taJoinedSoft.body.course, false);

  const taSchedule = await request(
    testServer.baseUrl,
    `/api/courses/${soft.id}/schedule`,
    {
      method: "PUT",
      token: teachingAssistant.token,
      body: {
        revision: 1,
        classes: [
          {
            day: "Tuesday",
            start: "10:00 AM",
            end: "11:00 AM",
            topic: "TA tutorial",
            room: "NR221",
            subtopics: ["Review", "Problem solving"],
          },
        ],
      },
    },
  );
  assert.equal(taSchedule.response.status, 200);
  const softTuesdayId = taSchedule.body.schedule[0].id;
  assert.deepEqual(taSchedule.body.schedule[0].subtopics, [
    "Review",
    "Problem solving",
  ]);

  const taJoinedKbs = await request(testServer.baseUrl, "/api/courses/join", {
    method: "POST",
    token: teachingAssistant.token,
    body: { code: kbs.code },
  });
  assert.equal(taJoinedKbs.response.status, 201);

  const studentTeam = await request(testServer.baseUrl, "/api/bootstrap", {
    token: student.token,
  });
  assert.deepEqual(
    studentTeam.body.teachingAssistants.map((assistant) => ({
      name: assistant.name,
      email: assistant.email,
      courseCode: assistant.courseCode,
      department: assistant.department,
    })),
    [
      {
        name: "Course Assistant",
        email: "assistant@iitkgp.ac.in",
        courseCode: "MF41601",
        department: "Mechanical Engineering",
      },
    ],
  );
  const professorTeam = await request(testServer.baseUrl, "/api/bootstrap", {
    token: professor.token,
  });
  assert.deepEqual(
    professorTeam.body.teachingAssistants.map((assistant) => assistant.courseCode),
    ["ME60353", "MF41601"],
  );
  const enrolledStudentsOnly = await request(testServer.baseUrl, "/api/students", {
    token: professor.token,
  });
  assert.ok(enrolledStudentsOnly.body.students.every((person) => person.role === "student"));

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
      ...quizSettings(softTuesdayId, { day: "Tuesday", quizDate: "2026-08-04" }),
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
      ...quizSettings(softTuesdayId, { day: "Tuesday", quizDate: "2026-08-04" }),
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

  const taRosterUpload = await request(
    testServer.baseUrl,
    `/api/courses/${soft.id}/roster`,
    {
      method: "PUT",
      token: teachingAssistant.token,
      body: { students: rosterOf(310, "MFTEST", "TA Updated Student") },
    },
  );
  assert.equal(taRosterUpload.response.status, 200);
  assert.equal(taRosterUpload.body.students.length, 310);

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
      department: "Mechanical Engineering",
      email: "email-test@kgpian.iitkgp.ac.in",
      password: "student-password",
      phone: "9876543210",
      rollNumber: "SELF0001",
      hall: "Azad Hall",
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
      department: "Mechanical Engineering",
      email: "password-only@kgpian.iitkgp.ac.in",
      password: "student-password",
      phone: "9876543210",
      rollNumber: "SELF0001",
      hall: "Azad Hall",
    },
  });
  assert.equal(created.response.status, 201);
  assert.ok(created.body.token);
  assert.equal(created.body.user.email, "password-only@kgpian.iitkgp.ac.in");
  assert.equal(created.body.user.department, "Mechanical Engineering");
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
    students: rosterOf(2, "MFTEST", "KBS Student"),
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
    rollNumber: "MFTEST0001",
    password: "student-password",
  });
  for (const course of [first, second]) {
    const joined = await request(testServer.baseUrl, "/api/courses/join", {
      method: "POST",
      token: student.token,
      body: { code: course.code },
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
    "courseMaterials",
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

test("a course without an uploaded roster builds one from enrolled students", async (t) => {
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
    rollNumber: "MFTEST0001",
    password: "student-password",
  });
  const secondStudent = await createVerifiedUser(testServer.baseUrl, {
    role: "student",
    name: "Second Student",
    email: "second@kgpian.iitkgp.ac.in",
    rollNumber: "MFTEST0002",
    phone: "9876543211",
    hall: "Nehru Hall",
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
    body: { code: course.code },
  });
  assert.equal(earlyJoin.response.status, 201);
  const secondJoin = await request(testServer.baseUrl, "/api/courses/join", {
    method: "POST",
    token: secondStudent.token,
    body: { code: course.code },
  });
  assert.equal(secondJoin.response.status, 201);

  const generatedRoster = await request(
    testServer.baseUrl,
    `/api/courses/${course.id}/roster`,
    { token: professor.token },
  );
  assert.equal(generatedRoster.response.status, 200);
  assert.deepEqual(
    generatedRoster.body.students.map((item) => item.rollNumber),
    ["MFTEST0001", "MFTEST0002"],
  );

  const earlySession = await request(testServer.baseUrl, "/api/attendance/sessions", {
    method: "POST",
    token: professor.token,
    body: { courseId: course.id },
  });
  assert.equal(earlySession.response.status, 201);
  assert.deepEqual(
    earlySession.body.attendance.records.map((record) => record.rollNumber),
    ["MFTEST0001", "MFTEST0002"],
  );

  const marked = await request(
    testServer.baseUrl,
    `/api/attendance/${earlySession.body.attendance.id}/check-in`,
    {
      method: "POST",
      token: student.token,
      body: {
        signals: { wifi: true, bluetooth: true },
        code: await attendanceCode(
          testServer.baseUrl,
          professor.token,
          earlySession.body.attendance.id,
        ),
      },
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
    rollNumber: "MFTEST0001",
    password: "student-password",
  });
  const outsider = await createVerifiedUser(testServer.baseUrl, {
    role: "student",
    name: "Other Student",
    email: "outsider@kgpian.iitkgp.ac.in",
    rollNumber: "MFTEST0002",
    password: "outsider-password",
  });

  const soft = await createCourse(testServer.baseUrl, professor.token, {
    students: rosterOf(4, "MFTEST", "Soft Student"),
  });
  const stranger = await createVerifiedUser(testServer.baseUrl, {
    role: "student",
    name: "Not On Roster",
    email: "stranger@kgpian.iitkgp.ac.in",
    rollNumber: "NOTONLIST1",
    password: "stranger-password",
  });

  // Admission is checked against the account roll number at join time.
  const notAdmitted = await request(testServer.baseUrl, "/api/courses/join", {
    method: "POST",
    token: stranger.token,
    body: { code: soft.code },
  });
  assert.equal(notAdmitted.response.status, 403);
  assert.match(notAdmitted.body.error, /not admitted/i);

  for (const token of [student.token, outsider.token]) {
    const joined = await request(testServer.baseUrl, "/api/courses/join", {
      method: "POST",
      token,
      body: { code: soft.code },
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
    body: {
      rollNumber: "MFTEST0001",
      signals: goodSignals,
      code: await attendanceCode(testServer.baseUrl, professor.token, sessionId),
    },
  });
  assert.equal(checkedIn.response.status, 201);
  assert.equal(checkedIn.body.checkedIn, true);
  assert.equal(checkedIn.body.rollNumber, "MFTEST0001");
  // The student payload must not carry the rest of the roster.
  assert.equal("records" in checkedIn.body, false);

  // The code has to be the one on the class screen.
  for (const code of ["", "ZZZZZZ"]) {
    const refused = await request(testServer.baseUrl, `/api/attendance/${sessionId}/check-in`, {
      method: "POST",
      token: outsider.token,
      body: { signals: goodSignals, code },
    });
    assert.equal(refused.response.status, 403);
  }
  // Students cannot read the code themselves.
  const peeked = await request(testServer.baseUrl, `/api/attendance/${sessionId}/code`, {
    token: student.token,
  });
  assert.equal(peeked.response.status, 403);

  // A roll number bound at join cannot be claimed by a second account.
  const stolen = await request(testServer.baseUrl, "/api/courses/join", {
    method: "POST",
    token: outsider.token,
    body: { code: soft.code },
  });
  assert.equal(stolen.response.status, 200);
  assert.equal(stolen.body.existing, true);

  // Marking uses the roll bound at join, never one supplied at check-in time.
  const spoofed = await request(testServer.baseUrl, `/api/attendance/${sessionId}/check-in`, {
    method: "POST",
    token: outsider.token,
    body: {
      rollNumber: "MFTEST0001",
      signals: goodSignals,
      code: await attendanceCode(testServer.baseUrl, professor.token, sessionId),
    },
  });
  assert.equal(spoofed.response.status, 201);
  assert.equal(spoofed.body.rollNumber, "MFTEST0002");

  // Once bound, the roll number no longer has to be supplied.
  const repeat = await request(testServer.baseUrl, `/api/attendance/${sessionId}/check-in`, {
    method: "POST",
    token: student.token,
    body: {
      signals: goodSignals,
      code: await attendanceCode(testServer.baseUrl, professor.token, sessionId),
    },
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

test("a professor adds and removes students and sets the weekly timetable", async (t) => {
  const testServer = await createTestServer({ env: { FACULTY_SIGNUP_CODE: "" } });
  t.after(async () => {
    await testServer.close();
    await fs.rm(testServer.directory, { recursive: true, force: true });
  });

  const professor = await createVerifiedUser(testServer.baseUrl, {
    role: "faculty",
    name: "Roster Professor",
    email: "roster-professor@mech.iitkgp.ac.in",
    password: "professor-password",
  });
  const course = await createCourse(testServer.baseUrl, professor.token, {
    students: [
      { rollNumber: "23ME10001", name: "First Student" },
      { rollNumber: "23ME10002", name: "Second Student" },
    ],
  });

  const added = await request(testServer.baseUrl, `/api/courses/${course.id}/roster`, {
    method: "POST",
    token: professor.token,
    body: { rollNumber: "23me10003", name: "Third  Student" },
  });
  assert.equal(added.response.status, 201);
  assert.deepEqual(
    added.body.students.map((student) => [student.serial, student.rollNumber]),
    [[1, "23ME10001"], [2, "23ME10002"], [3, "23ME10003"]],
  );
  assert.equal(added.body.students.at(-1).name, "Third Student");
  assert.equal(added.body.course.students, 3);

  const duplicate = await request(testServer.baseUrl, `/api/courses/${course.id}/roster`, {
    method: "POST",
    token: professor.token,
    body: { rollNumber: "23ME10003", name: "Someone Else" },
  });
  assert.equal(duplicate.response.status, 409);

  // The newly added student can join and is in a session opened afterwards.
  const student = await createVerifiedUser(testServer.baseUrl, {
    role: "student",
    name: "Third Student",
    email: "third@kgpian.iitkgp.ac.in",
    rollNumber: "23ME10003",
    password: "student-password",
  });
  const joined = await request(testServer.baseUrl, "/api/courses/join", {
    method: "POST",
    token: student.token,
    body: { code: course.code },
  });
  assert.equal(joined.response.status, 201);

  const removed = await request(
    testServer.baseUrl,
    `/api/courses/${course.id}/roster/23ME10003`,
    { method: "DELETE", token: professor.token },
  );
  assert.equal(removed.response.status, 200);
  assert.deepEqual(
    removed.body.students.map((item) => item.rollNumber),
    ["23ME10001", "23ME10002"],
  );
  // Removal also withdraws the enrolment it granted.
  const afterRemoval = await request(testServer.baseUrl, "/api/bootstrap", {
    token: student.token,
  });
  assert.deepEqual(afterRemoval.body.enrolledCourseIds, []);

  const missing = await request(
    testServer.baseUrl,
    `/api/courses/${course.id}/roster/NOSUCHROLL`,
    { method: "DELETE", token: professor.token },
  );
  assert.equal(missing.response.status, 404);

  const timetable = await request(testServer.baseUrl, `/api/courses/${course.id}/schedule`, {
    method: "PUT",
    token: professor.token,
    body: {
      revision: 0,
      classes: [
        {
          day: "Mon",
          start: "8:0:AM",
          end: "8:55:AM",
          topic: "ME60215",
          room: "NC241",
          subtopics: ["Introduction", "Worked example"],
        },
        { day: "Thur", start: "12:0:PM", end: "12:55:PM", topic: "ME60215" },
      ],
    },
  });
  assert.equal(timetable.response.status, 200);
  assert.deepEqual(
    timetable.body.schedule.map((item) => [item.day, item.start, item.room]),
    [["Monday", "8:0:AM", "NC241"], ["Thursday", "12:0:PM", "Room TBA"]],
  );
  assert.deepEqual(timetable.body.schedule[0].subtopics, [
    "Introduction",
    "Worked example",
  ]);

  const bootstrap = await request(testServer.baseUrl, "/api/bootstrap", {
    token: professor.token,
  });
  assert.equal(bootstrap.body.schedule.length, 2);
  assert.deepEqual(bootstrap.body.stats, {
    courses: 1,
    rosteredStudents: 2,
    classesCompleted: 0,
    averageAttendance: 0,
    quizzes: 0,
  });
  assert.deepEqual(bootstrap.body.statsByCourse[course.id], bootstrap.body.stats);

  const editedTimetable = await request(
    testServer.baseUrl,
    `/api/courses/${course.id}/schedule`,
    {
      method: "PUT",
      token: professor.token,
      body: {
        revision: timetable.body.revision,
        classes: timetable.body.schedule.map((entry, index) => ({
          ...entry,
          subtopics: index === 0 ? ["Updated topic", "Discussion"] : [],
        })),
      },
    },
  );
  assert.equal(editedTimetable.response.status, 200);
  assert.deepEqual(
    editedTimetable.body.schedule.map((entry) => entry.id),
    timetable.body.schedule.map((entry) => entry.id),
  );
  assert.deepEqual(editedTimetable.body.schedule[0].subtopics, [
    "Updated topic",
    "Discussion",
  ]);

  const staleTimetable = await request(
    testServer.baseUrl,
    `/api/courses/${course.id}/schedule`,
    {
      method: "PUT",
      token: professor.token,
      body: {
        revision: timetable.body.revision,
        classes: [],
      },
    },
  );
  assert.equal(staleTimetable.response.status, 409);

  const badDay = await request(testServer.baseUrl, `/api/courses/${course.id}/schedule`, {
    method: "PUT",
    token: professor.token,
    body: {
      revision: editedTimetable.body.revision,
      classes: [{ day: "Someday", start: "9:00 AM" }],
    },
  });
  assert.equal(badDay.response.status, 400);

  const blankDay = await request(testServer.baseUrl, `/api/courses/${course.id}/schedule`, {
    method: "PUT",
    token: professor.token,
    body: {
      revision: editedTimetable.body.revision,
      classes: [{ day: "", start: "9:00 AM" }],
    },
  });
  assert.equal(blankDay.response.status, 400);

  const tooManySubtopics = await request(
    testServer.baseUrl,
    `/api/courses/${course.id}/schedule`,
    {
      method: "PUT",
      token: professor.token,
      body: {
        revision: editedTimetable.body.revision,
        classes: [
          {
            day: "Monday",
            start: "9:00 AM",
            subtopics: Array.from({ length: 21 }, (_, index) => `Part ${index + 1}`),
          },
        ],
      },
    },
  );
  assert.equal(tooManySubtopics.response.status, 400);

  const afterRejectedEdits = await request(testServer.baseUrl, "/api/schedule", {
    token: professor.token,
  });
  assert.deepEqual(afterRejectedEdits.body.schedule, editedTimetable.body.schedule);
});

test("the students list shows who joined, and only to the course team", async (t) => {
  const testServer = await createTestServer({ env: { FACULTY_SIGNUP_CODE: "" } });
  t.after(async () => {
    await testServer.close();
    await fs.rm(testServer.directory, { recursive: true, force: true });
  });

  const professor = await createVerifiedUser(testServer.baseUrl, {
    role: "faculty",
    name: "List Professor",
    email: "list-professor@mech.iitkgp.ac.in",
    password: "professor-password",
  });
  const course = await createCourse(testServer.baseUrl, professor.token, {
    students: [
      { rollNumber: "23ME10001", name: "Joined Student" },
      { rollNumber: "23ME10002", name: "Never Joined" },
    ],
  });

  const empty = await request(testServer.baseUrl, "/api/students", {
    token: professor.token,
  });
  assert.equal(empty.response.status, 200);
  assert.deepEqual(empty.body.students, []);

  const student = await createVerifiedUser(testServer.baseUrl, {
    role: "student",
    name: "Joined Student",
    email: "joined@kgpian.iitkgp.ac.in",
    rollNumber: "23ME10001",
    password: "student-password",
  });
  await request(testServer.baseUrl, "/api/courses/join", {
    method: "POST",
    token: student.token,
    body: { code: course.code },
  });

  const listed = await request(testServer.baseUrl, "/api/students", {
    token: professor.token,
  });
  assert.equal(listed.body.students.length, 1);
  assert.deepEqual(
    {
      rollNumber: listed.body.students[0].rollNumber,
      name: listed.body.students[0].name,
      email: listed.body.students[0].email,
      department: listed.body.students[0].department,
      phone: listed.body.students[0].phone,
      hall: listed.body.students[0].hall,
      courseId: listed.body.students[0].courseId,
      role: listed.body.students[0].role,
    },
    {
      rollNumber: "23ME10001",
      name: "Joined Student",
      email: "joined@kgpian.iitkgp.ac.in",
      department: "Mechanical Engineering",
      phone: "9876543210",
      hall: "Azad Hall",
      courseId: course.id,
      role: "student",
    },
  );

  // Students cannot read the list of their classmates.
  const denied = await request(testServer.baseUrl, "/api/students", {
    token: student.token,
  });
  assert.equal(denied.response.status, 403);

  // Another professor sees nothing from this course.
  const outsider = await createVerifiedUser(testServer.baseUrl, {
    role: "faculty",
    name: "Other Professor",
    email: "other-professor@iitkgp.ac.in",
    password: "professor-password",
  });
  const otherView = await request(testServer.baseUrl, "/api/students", {
    token: outsider.token,
  });
  assert.deepEqual(otherView.body.students, []);
});

test("course teams share materials only with their enrolled course", async (t) => {
  const testServer = await createTestServer();
  t.after(async () => {
    await testServer.close();
    await fs.rm(testServer.directory, { recursive: true, force: true });
  });

  const professor = await createVerifiedUser(testServer.baseUrl, {
    role: "faculty",
    name: "Material Professor",
    email: "materials@iitkgp.ac.in",
    password: "professor-password",
  });
  const student = await createVerifiedUser(testServer.baseUrl, {
    role: "student",
    name: "Enrolled Reader",
    email: "reader@kgpian.iitkgp.ac.in",
    rollNumber: "MFTEST0001",
    password: "student-password",
  });
  const teachingAssistant = await createVerifiedUser(testServer.baseUrl, {
    role: "ta",
    name: "Material Assistant",
    email: "material-assistant@iitkgp.ac.in",
    password: "assistant-password",
  });
  const outsider = await createVerifiedUser(testServer.baseUrl, {
    role: "student",
    name: "Outside Reader",
    email: "outside-reader@kgpian.iitkgp.ac.in",
    rollNumber: "OUTSIDE001",
    password: "student-password",
  });
  const course = await createCourse(testServer.baseUrl, professor.token, {
    students: rosterOf(2, "MFTEST", "Material Student"),
  });
  const joined = await request(testServer.baseUrl, "/api/courses/join", {
    method: "POST",
    token: student.token,
    body: { code: course.code },
  });
  assert.equal(joined.response.status, 201);
  const taJoined = await request(testServer.baseUrl, "/api/courses/join", {
    method: "POST",
    token: teachingAssistant.token,
    body: { code: course.code },
  });
  assert.equal(taJoined.response.status, 201);

  const contents = "Week 1 notes: neural networks and fuzzy logic.";
  const uploaded = await request(
    testServer.baseUrl,
    `/api/courses/${course.id}/materials`,
    {
      method: "POST",
      token: teachingAssistant.token,
      headers: {
        "content-type": "text/plain",
        "x-file-name": encodeURIComponent("Week 1 notes.txt"),
      },
      rawBody: Buffer.from(contents),
    },
  );
  assert.equal(uploaded.response.status, 201);
  assert.equal(uploaded.body.material.fileName, "Week 1 notes.txt");
  assert.equal(uploaded.body.material.size, Buffer.byteLength(contents));
  assert.equal("dataBase64" in uploaded.body.material, false);

  const listed = await request(
    testServer.baseUrl,
    `/api/courses/${course.id}/materials`,
    { token: student.token },
  );
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.materials.length, 1);
  assert.equal("dataBase64" in listed.body.materials[0], false);

  const downloaded = await request(
    testServer.baseUrl,
    `/api/materials/${uploaded.body.material.id}/download`,
    { token: student.token },
  );
  assert.equal(downloaded.response.status, 200);
  assert.equal(downloaded.body, contents);
  assert.match(downloaded.response.headers.get("content-disposition"), /Week 1 notes\.txt/);

  const hiddenList = await request(
    testServer.baseUrl,
    `/api/courses/${course.id}/materials`,
    { token: outsider.token },
  );
  assert.equal(hiddenList.response.status, 403);
  const hiddenDownload = await request(
    testServer.baseUrl,
    `/api/materials/${uploaded.body.material.id}/download`,
    { token: outsider.token },
  );
  assert.equal(hiddenDownload.response.status, 403);

  const removed = await request(
    testServer.baseUrl,
    `/api/materials/${uploaded.body.material.id}`,
    { method: "DELETE", token: professor.token },
  );
  assert.equal(removed.response.status, 204);
  const afterRemoval = await request(
    testServer.baseUrl,
    `/api/courses/${course.id}/materials`,
    { token: student.token },
  );
  assert.deepEqual(afterRemoval.body.materials, []);
});

test("editing a course keeps its join code, and deleting one clears its data", async (t) => {
  const testServer = await createTestServer({ env: { FACULTY_SIGNUP_CODE: "" } });
  t.after(async () => {
    await testServer.close();
    await fs.rm(testServer.directory, { recursive: true, force: true });
  });

  const professor = await createVerifiedUser(testServer.baseUrl, {
    role: "faculty",
    name: "Editing Professor",
    email: "editing-professor@mech.iitkgp.ac.in",
    password: "professor-password",
  });
  const course = await createCourse(testServer.baseUrl, professor.token, {
    students: [{ rollNumber: "23ME10001", name: "Enrolled Student" }],
  });
  const other = await createCourse(testServer.baseUrl, professor.token, {
    name: "Second Course",
    courseCode: "ME60353",
    students: [],
  });
  const student = await createVerifiedUser(testServer.baseUrl, {
    role: "student",
    name: "Enrolled Student",
    email: "enrolled@kgpian.iitkgp.ac.in",
    password: "student-password",
    rollNumber: "23ME10001",
  });
  await request(testServer.baseUrl, "/api/courses/join", {
    method: "POST",
    token: student.token,
    body: { code: course.code },
  });

  const updated = await request(testServer.baseUrl, `/api/courses/${course.id}`, {
    method: "PATCH",
    token: professor.token,
    body: {
      name: "Soft Computing Renamed",
      courseCode: "MF41601A",
      section: "Autumn 2027-2028",
      room: "NR305",
    },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.course.name, "Soft Computing Renamed");
  assert.equal(updated.body.course.courseCode, "MF41601A");
  assert.equal(updated.body.course.room, "NR305");
  // The join code must survive an edit so nobody has to rejoin.
  assert.equal(updated.body.course.code, course.code);

  // The roll list and enrolment stay attached across the rename.
  const roster = await request(testServer.baseUrl, `/api/courses/${course.id}/roster`, {
    token: professor.token,
  });
  assert.equal(roster.body.students.length, 1);
  const stillJoined = await request(testServer.baseUrl, "/api/bootstrap", {
    token: student.token,
  });
  assert.deepEqual(stillJoined.body.enrolledCourseIds, [course.id]);

  const clash = await request(testServer.baseUrl, `/api/courses/${course.id}`, {
    method: "PATCH",
    token: professor.token,
    body: { courseCode: other.courseCode },
  });
  assert.equal(clash.response.status, 409);

  // Another professor can neither edit nor delete it.
  const outsider = await createVerifiedUser(testServer.baseUrl, {
    role: "faculty",
    name: "Outsider Professor",
    email: "outsider-professor@iitkgp.ac.in",
    password: "professor-password",
  });
  for (const method of ["PATCH", "DELETE"]) {
    const denied = await request(testServer.baseUrl, `/api/courses/${course.id}`, {
      method,
      token: outsider.token,
      ...(method === "PATCH" ? { body: { name: "Hijacked" } } : {}),
    });
    assert.equal(denied.response.status, 403);
  }

  const deleted = await request(testServer.baseUrl, `/api/courses/${course.id}`, {
    method: "DELETE",
    token: professor.token,
  });
  assert.equal(deleted.response.status, 200);
  assert.equal(deleted.body.removed.students, 1);
  assert.equal(deleted.body.removed.enrolments, 1);

  const after = await testServer.store.read();
  assert.equal(after.courses.some((item) => item.id === course.id), false);
  assert.equal(after.courseStudents.some((item) => item.courseId === course.id), false);
  assert.equal(after.enrollments.some((item) => item.courseId === course.id), false);
  // The professor's other course is untouched.
  assert.equal(after.courses.length, 1);
  assert.equal(after.courses[0].id, other.id);

  const gone = await request(testServer.baseUrl, `/api/courses/${course.id}`, {
    method: "DELETE",
    token: professor.token,
  });
  assert.equal(gone.response.status, 404);
});

test("a quiz can carry image questions and name the class it belongs to", async (t) => {
  const testServer = await createTestServer({ env: { FACULTY_SIGNUP_CODE: "" } });
  t.after(async () => {
    await testServer.close();
    await fs.rm(testServer.directory, { recursive: true, force: true });
  });

  const professor = await createVerifiedUser(testServer.baseUrl, {
    role: "faculty",
    name: "Quiz Professor",
    email: "quiz-professor@mech.iitkgp.ac.in",
    password: "professor-password",
  });
  const course = await createCourse(testServer.baseUrl, professor.token, {
    students: [{ rollNumber: "23ME10001", name: "Quiz Student" }],
  });
  const student = await createVerifiedUser(testServer.baseUrl, {
    role: "student",
    name: "Quiz Student",
    email: "quiz-student@kgpian.iitkgp.ac.in",
    password: "student-password",
    rollNumber: "23ME10001",
  });
  await request(testServer.baseUrl, "/api/courses/join", {
    method: "POST",
    token: student.token,
    body: { code: course.code },
  });

  const timetable = await request(testServer.baseUrl, `/api/courses/${course.id}/schedule`, {
    method: "PUT",
    token: professor.token,
    body: {
      revision: 0,
      classes: [{ day: "Monday", start: "3:00 PM", end: "5:00 PM", topic: "Fuzzy sets" }],
    },
  });
  assert.equal(timetable.response.status, 200);
  const scheduleId = timetable.body.schedule[0].id;

  const pixel =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  const badImage = await request(testServer.baseUrl, "/api/quizzes", {
    method: "POST",
    token: professor.token,
    body: {
      courseId: course.id,
      title: "Diagram check",
      ...quizSettings(scheduleId),
      questions: [
        { text: "Which diagram?", options: ["A", "B"], answer: 0, image: "https://example.com/x.png" },
      ],
    },
  });
  assert.equal(badImage.response.status, 400);

  const wrongClass = await request(testServer.baseUrl, "/api/quizzes", {
    method: "POST",
    token: professor.token,
    body: {
      courseId: course.id,
      title: "Diagram check",
      ...quizSettings("schedule-not-here"),
      questions: [{ text: "Which diagram?", options: ["A", "B"], answer: 0 }],
    },
  });
  assert.equal(wrongClass.response.status, 400);

  const published = await request(testServer.baseUrl, "/api/quizzes", {
    method: "POST",
    token: professor.token,
    body: {
      courseId: course.id,
      title: "Diagram check",
      ...quizSettings(scheduleId, { classLabel: "Monday · 3:00 PM–5:00 PM · Fuzzy sets" }),
      questions: [
        { text: "Which diagram shows a fuzzy set?", options: ["A", "B"], answer: 1, image: pixel },
        // A question may be the image alone, with no text.
        { text: "", options: ["Left", "Right"], answer: 0, image: pixel },
      ],
    },
  });
  assert.equal(published.response.status, 201);
  assert.equal(published.body.quiz.day, "Monday");
  assert.equal(published.body.quiz.scheduleId, scheduleId);
  assert.equal(published.body.quiz.questions[0].image, pixel);
  assert.equal(published.body.quiz.questions[1].text, "");

  // The student gets the image and the class, but never the answer key.
  const seen = await request(testServer.baseUrl, "/api/bootstrap", { token: student.token });
  assert.equal(seen.body.quiz.classLabel, "Monday · 3:00 PM–5:00 PM · Fuzzy sets");
  assert.equal(seen.body.quiz.day, "Monday");
  assert.equal(seen.body.quiz.questions[0].image, pixel);
  assert.equal("answer" in seen.body.quiz.questions[0], false);
});

test("a quiz can be saved for a class ahead of time and published later", async (t) => {
  const testServer = await createTestServer({ env: { FACULTY_SIGNUP_CODE: "" } });
  t.after(async () => {
    await testServer.close();
    await fs.rm(testServer.directory, { recursive: true, force: true });
  });

  const professor = await createVerifiedUser(testServer.baseUrl, {
    role: "faculty",
    name: "Draft Professor",
    email: "draft-professor@mech.iitkgp.ac.in",
    password: "professor-password",
  });
  const course = await createCourse(testServer.baseUrl, professor.token, {
    students: [{ rollNumber: "23ME10001", name: "Draft Student" }],
  });
  const student = await createVerifiedUser(testServer.baseUrl, {
    role: "student",
    name: "Draft Student",
    email: "draft-student@kgpian.iitkgp.ac.in",
    password: "student-password",
    rollNumber: "23ME10001",
  });
  await request(testServer.baseUrl, "/api/courses/join", {
    method: "POST",
    token: student.token,
    body: { code: course.code },
  });
  const draftClassId = await addClass(testServer.baseUrl, professor.token, course.id);

  const saved = await request(testServer.baseUrl, "/api/quizzes", {
    method: "POST",
    token: professor.token,
    body: {
      courseId: course.id,
      status: "draft",
      title: "Week 4 check",
      ...quizSettings(draftClassId),
      questions: [{ text: "Ready?", options: ["Yes", "No"], answer: 0 }],
    },
  });
  assert.equal(saved.response.status, 201);
  assert.equal(saved.body.quiz.status, "draft");

  // A saved quiz is invisible to students until it is published.
  const studentBefore = await request(testServer.baseUrl, "/api/bootstrap", {
    token: student.token,
  });
  assert.equal(studentBefore.body.quiz, null);
  // And it does not count towards the published quiz tally.
  const statsBefore = await request(testServer.baseUrl, "/api/bootstrap", {
    token: professor.token,
  });
  assert.equal(statsBefore.body.stats.quizzes, 0);

  const drafts = await request(
    testServer.baseUrl,
    `/api/quizzes/drafts?courseId=${course.id}`,
    { token: professor.token },
  );
  assert.equal(drafts.body.drafts.length, 1);

  // Students may not read the course's drafts.
  const denied = await request(testServer.baseUrl, "/api/quizzes/drafts", {
    token: student.token,
  });
  assert.equal(denied.response.status, 403);

  // Reopening a saved quiz and editing it updates that draft in place.
  const edited = await request(testServer.baseUrl, `/api/quizzes/${saved.body.quiz.id}`, {
    method: "PUT",
    token: professor.token,
    body: {
      title: "Week 4 check (revised)",
      ...quizSettings(draftClassId),
      questions: [
        { text: "Ready now?", options: ["Yes", "No", "Maybe"], answer: 2 },
        { text: "Second question", options: ["A", "B"], answer: 0 },
      ],
    },
  });
  assert.equal(edited.response.status, 200);
  assert.equal(edited.body.quiz.status, "draft");
  assert.equal(edited.body.quiz.questions.length, 2);
  const stillOneDraft = await request(
    testServer.baseUrl,
    `/api/quizzes/drafts?courseId=${course.id}`,
    { token: professor.token },
  );
  assert.equal(stillOneDraft.body.drafts.length, 1);

  const published = await request(
    testServer.baseUrl,
    `/api/quizzes/${saved.body.quiz.id}/publish`,
    { method: "POST", token: professor.token, body: {} },
  );
  assert.equal(published.response.status, 200);
  assert.equal(published.body.quiz.status, "open");

  const studentAfter = await request(testServer.baseUrl, "/api/bootstrap", {
    token: student.token,
  });
  assert.equal(studentAfter.body.quiz.id, saved.body.quiz.id);
  assert.equal(studentAfter.body.quiz.title, "Week 4 check (revised)");
  assert.equal(studentAfter.body.quiz.questions.length, 2);

  // Publishing twice is refused, since it is no longer a draft.
  const again = await request(
    testServer.baseUrl,
    `/api/quizzes/${saved.body.quiz.id}/publish`,
    { method: "POST", token: professor.token, body: {} },
  );
  assert.equal(again.response.status, 404);

  // A second draft can be removed without touching the live quiz.
  const spare = await request(testServer.baseUrl, "/api/quizzes", {
    method: "POST",
    token: professor.token,
    body: {
      courseId: course.id,
      status: "draft",
      title: "Spare",
      ...quizSettings(draftClassId),
      questions: [{ text: "Spare?", options: ["A", "B"], answer: 1 }],
    },
  });
  const removed = await request(testServer.baseUrl, `/api/quizzes/${spare.body.quiz.id}`, {
    method: "DELETE",
    token: professor.token,
  });
  assert.equal(removed.response.status, 204);
  const stillLive = await request(testServer.baseUrl, "/api/bootstrap", {
    token: student.token,
  });
  assert.equal(stillLive.body.quiz.id, saved.body.quiz.id);
});

test("quiz results list every rostered student with their marks", async (t) => {
  const testServer = await createTestServer({ env: { FACULTY_SIGNUP_CODE: "" } });
  t.after(async () => {
    await testServer.close();
    await fs.rm(testServer.directory, { recursive: true, force: true });
  });

  const professor = await createVerifiedUser(testServer.baseUrl, {
    role: "faculty",
    name: "Marks Professor",
    email: "marks-professor@mech.iitkgp.ac.in",
    password: "professor-password",
  });
  const course = await createCourse(testServer.baseUrl, professor.token, {
    students: [
      { rollNumber: "23ME10001", name: "Sat The Quiz" },
      { rollNumber: "23ME10002", name: "Never Attempted" },
    ],
  });
  const classId = await addClass(testServer.baseUrl, professor.token, course.id);
  const student = await createVerifiedUser(testServer.baseUrl, {
    role: "student",
    name: "Sat The Quiz",
    email: "sat@kgpian.iitkgp.ac.in",
    password: "student-password",
    rollNumber: "23ME10001",
  });
  await request(testServer.baseUrl, "/api/courses/join", {
    method: "POST",
    token: student.token,
    body: { code: course.code },
  });

  const quiz = await request(testServer.baseUrl, "/api/quizzes", {
    method: "POST",
    token: professor.token,
    body: {
      courseId: course.id,
      title: "Week 1 check",
      ...quizSettings(classId),
      questions: [
        { text: "One?", options: ["A", "B"], answer: 0 },
        { text: "Two?", options: ["A", "B"], answer: 1 },
      ],
    },
  });
  const quizId = quiz.body.quiz.id;

  const answered = await request(testServer.baseUrl, `/api/quizzes/${quizId}/respond`, {
    method: "POST",
    token: student.token,
    body: { answers: [0, 0] },
  });
  assert.equal(answered.response.status, 201);
  assert.deepEqual(answered.body, { score: 1, total: 2 });

  const results = await request(testServer.baseUrl, `/api/quizzes/${quizId}/results`, {
    token: professor.token,
  });
  assert.equal(results.response.status, 200);
  assert.equal(results.body.quiz.title, "Week 1 check");
  assert.equal(results.body.quiz.total, 2);
  assert.deepEqual(results.body.summary, {
    attempted: 1,
    rostered: 2,
    averageScore: 1,
  });
  // The whole roll list appears, so a student who never sat it is visible.
  assert.deepEqual(
    results.body.results.map((item) => [item.rollNumber, item.attempted, item.score]),
    [
      ["23ME10001", true, 1],
      ["23ME10002", false, null],
    ],
  );

  const history = await request(
    testServer.baseUrl,
    `/api/quizzes/history?courseId=${course.id}`,
    { token: professor.token },
  );
  assert.equal(history.body.quizzes.length, 1);
  assert.equal(history.body.quizzes[0].responses, 1);
  assert.equal(history.body.quizzes[0].classLabel, "Monday · 3:00 PM–5:00 PM");
  assert.equal(history.body.quizzes[0].quizDate, "2026-08-03");

  // The date is required, and only a real calendar date is accepted.
  for (const quizDate of ["", "03-08-2026", "2026-13-45"]) {
    const rejected = await request(testServer.baseUrl, "/api/quizzes", {
      method: "POST",
      token: professor.token,
      body: {
        courseId: course.id,
        title: "Dateless",
        ...quizSettings(classId, { quizDate }),
        questions: [{ text: "One?", options: ["A", "B"], answer: 0 }],
      },
    });
    assert.equal(rejected.response.status, 400);
  }

  // The team sees the answer key and how the class split across options.
  assert.equal(results.body.quiz.questions.length, 2);
  assert.equal(results.body.quiz.questions[0].answer, 0);
  // One student answered [0, 0]: right on the first, wrong on the second.
  assert.deepEqual(results.body.quiz.questions[0].optionCounts, [1, 0]);
  assert.equal(results.body.quiz.questions[0].correctCount, 1);
  assert.equal(results.body.quiz.questions[0].answered, 1);
  assert.deepEqual(results.body.quiz.questions[1].optionCounts, [1, 0]);
  assert.equal(results.body.quiz.questions[1].correctCount, 0);

  // A finished quiz can be removed along with its marks.
  const dropped = await request(testServer.baseUrl, `/api/quizzes/${quizId}`, {
    method: "DELETE",
    token: professor.token,
  });
  assert.equal(dropped.response.status, 204);
  const afterDelete = await request(
    testServer.baseUrl,
    `/api/quizzes/history?courseId=${course.id}`,
    { token: professor.token },
  );
  assert.deepEqual(afterDelete.body.quizzes, []);

  // Marks are for the course team only.
  for (const route of ["/api/quizzes/history"]) {
    const denied = await request(testServer.baseUrl, route, { token: student.token });
    assert.equal(denied.response.status, 403);
  }
});

test("course activity raises notices that students can read but not change", async (t) => {
  const testServer = await createTestServer({ env: { FACULTY_SIGNUP_CODE: "" } });
  t.after(async () => {
    await testServer.close();
    await fs.rm(testServer.directory, { recursive: true, force: true });
  });

  const professor = await createVerifiedUser(testServer.baseUrl, {
    role: "faculty",
    name: "Notice Professor",
    email: "notice-professor@mech.iitkgp.ac.in",
    password: "professor-password",
  });
  const course = await createCourse(testServer.baseUrl, professor.token, {
    students: [{ rollNumber: "23ME10001", name: "Notice Student" }],
  });
  const classId = await addClass(testServer.baseUrl, professor.token, course.id);
  const student = await createVerifiedUser(testServer.baseUrl, {
    role: "student",
    name: "Notice Student",
    email: "notice-student@kgpian.iitkgp.ac.in",
    password: "student-password",
    rollNumber: "23ME10001",
  });
  await request(testServer.baseUrl, "/api/courses/join", {
    method: "POST",
    token: student.token,
    body: { code: course.code },
  });

  const empty = await request(testServer.baseUrl, `/api/courses/${course.id}/notices`, {
    token: student.token,
  });
  assert.equal(empty.response.status, 200);
  assert.deepEqual(empty.body.notices, []);

  // Opening attendance and publishing a quiz each announce themselves.
  await request(testServer.baseUrl, "/api/attendance/sessions", {
    method: "POST",
    token: professor.token,
    body: { courseId: course.id },
  });
  await request(testServer.baseUrl, "/api/quizzes", {
    method: "POST",
    token: professor.token,
    body: {
      courseId: course.id,
      title: "Pop quiz",
      ...quizSettings(classId),
      questions: [{ text: "One?", options: ["A", "B"], answer: 0 }],
    },
  });

  const posted = await request(testServer.baseUrl, `/api/courses/${course.id}/notices`, {
    method: "POST",
    token: professor.token,
    body: { title: "Class moved to NR305", body: "Only for this week." },
  });
  assert.equal(posted.response.status, 201);

  const seen = await request(testServer.baseUrl, `/api/courses/${course.id}/notices`, {
    token: student.token,
  });
  assert.equal(seen.body.notices.length, 3);
  // Newest first.
  assert.deepEqual(
    seen.body.notices.map((item) => item.kind),
    ["notice", "quiz", "attendance"],
  );
  assert.equal(seen.body.notices[0].title, "Class moved to NR305");
  assert.equal(seen.body.notices[0].authorName, "Notice Professor");

  // Students may not post or remove.
  const refusedPost = await request(testServer.baseUrl, `/api/courses/${course.id}/notices`, {
    method: "POST",
    token: student.token,
    body: { title: "Cancel the class" },
  });
  assert.equal(refusedPost.response.status, 403);
  const refusedDelete = await request(
    testServer.baseUrl,
    `/api/courses/${course.id}/notices/${posted.body.notice.id}`,
    { method: "DELETE", token: student.token },
  );
  assert.equal(refusedDelete.response.status, 403);

  const removed = await request(
    testServer.baseUrl,
    `/api/courses/${course.id}/notices/${posted.body.notice.id}`,
    { method: "DELETE", token: professor.token },
  );
  assert.equal(removed.response.status, 204);
  const afterRemoval = await request(testServer.baseUrl, `/api/courses/${course.id}/notices`, {
    token: student.token,
  });
  assert.equal(afterRemoval.body.notices.length, 2);

  // A quiz date has to land on the day that class runs.
  const wrongDay = await request(testServer.baseUrl, "/api/quizzes", {
    method: "POST",
    token: professor.token,
    body: {
      courseId: course.id,
      title: "Wrong day",
      // The class runs on Monday; 4 August 2026 is a Tuesday.
      ...quizSettings(classId, { quizDate: "2026-08-04" }),
      questions: [{ text: "One?", options: ["A", "B"], answer: 0 }],
    },
  });
  assert.equal(wrongDay.response.status, 400);
  assert.match(wrongDay.body.error, /Monday/);
});

test("professors sign up from department subdomains, students do not", async (t) => {
  const overrideEmail = "profile-override@mech.iitkgp.ac.in";
  const testServer = await createTestServer({
    env: {
      FACULTY_SIGNUP_CODE: "",
      PROFESSOR_PROFILE_OVERRIDES_JSON: JSON.stringify({
        [overrideEmail]: {
          phone: "+91 90000 00000",
          department: "Mechanical Engineering",
        },
      }),
    },
  });
  t.after(async () => {
    await testServer.close();
    await fs.rm(testServer.directory, { recursive: true, force: true });
  });

  const departmentProfessor = await request(testServer.baseUrl, "/api/auth/signup", {
    method: "POST",
    body: {
      role: "faculty",
      name: "Department Professor",
      department: "Mechanical Engineering",
      email: overrideEmail,
      password: "professor-password",
      phone: "9876543210",
    },
  });
  assert.equal(departmentProfessor.response.status, 201);
  assert.equal(
    departmentProfessor.body.user.department,
    "Mechanical Engineering",
  );
  const storedDepartmentProfessor = (await testServer.store.read()).users.find(
    (user) => user.email === overrideEmail,
  );
  assert.equal(storedDepartmentProfessor.phone, "+91 90000 00000");
  assert.equal(storedDepartmentProfessor.department, "Mechanical Engineering");

  const plainProfessor = await request(testServer.baseUrl, "/api/auth/signup", {
    method: "POST",
    body: {
      role: "faculty",
      name: "Institute Professor",
      department: "Mechanical Engineering",
      email: "someone@iitkgp.ac.in",
      password: "professor-password",
      phone: "9876543210",
    },
  });
  assert.equal(plainProfessor.response.status, 201);

  // A student address may not register as faculty.
  const studentAsProfessor = await request(testServer.baseUrl, "/api/auth/signup", {
    method: "POST",
    body: {
      role: "faculty",
      name: "Not A Professor",
      department: "Mechanical Engineering",
      email: "student@kgpian.iitkgp.ac.in",
      password: "professor-password",
      phone: "9876543210",
    },
  });
  assert.equal(studentAsProfessor.response.status, 400);
  assert.match(studentAsProfessor.body.error, /iitkgp\.ac\.in email/i);

  const outsider = await request(testServer.baseUrl, "/api/auth/signup", {
    method: "POST",
    body: {
      role: "faculty",
      name: "Outsider",
      department: "Mechanical Engineering",
      email: "someone@example.com",
      password: "professor-password",
      phone: "9876543210",
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
      department: "Mechanical Engineering",
      email: "unconfigured@kgpian.iitkgp.ac.in",
      password: "student-password",
      phone: "9876543210",
      rollNumber: "SELF0001",
      hall: "Azad Hall",
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
      department: "Mechanical Engineering",
      email: "delivered@kgpian.iitkgp.ac.in",
      password: "student-password",
      phone: "9876543210",
      rollNumber: "SELF0001",
      hall: "Azad Hall",
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
    department: "Mechanical Engineering",
    email: "uninvited@iitkgp.ac.in",
    password: "faculty-password",
    phone: "9876543210",
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
        department: "Mechanical Engineering",
        email: "uninvited-ta@iitkgp.ac.in",
        password: "assistant-password",
      },
    },
  );
  assert.equal(uninvitedTA.response.status, 403);
});



