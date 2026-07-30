const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../src/app");

async function createTestServer() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "campuspulse-api-"));
  const databasePath = path.join(directory, "database.json");
  const mailer = {
    configured: false,
    async sendVerification({ code }) {
      return { delivered: false, previewCode: code };
    },
  };
  const { app } = createApp({
    databasePath,
    mailer,
    env: {
      ALLOWED_ORIGINS: "http://localhost",
      ALLOW_DEV_VERIFICATION_CODE: "true",
    },
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const { port } = server.address();
  return {
    directory,
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
  const requested = await request(baseUrl, "/api/auth/signup/request", {
    method: "POST",
    body: user,
  });
  assert.equal(requested.response.status, 202);
  assert.match(requested.body.devCode, /^\d{6}$/);

  const verified = await request(baseUrl, "/api/auth/signup/verify", {
    method: "POST",
    body: { email: user.email, code: requested.body.devCode },
  });
  assert.equal(verified.response.status, 201);
  assert.equal(verified.body.user.role, user.role);

  const loggedIn = await request(baseUrl, "/api/auth/login", {
    method: "POST",
    body: { email: user.email, password: user.password, role: user.role },
  });
  assert.equal(loggedIn.response.status, 200);
  assert.ok(loggedIn.body.token);
  return loggedIn.body;
}

test("CampusPulse API supports verified login, enrollment, attendance, quiz, and ERP export", async (t) => {
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

  const joined = await request(testServer.baseUrl, "/api/courses/join", {
    method: "POST",
    token: student.token,
    body: { code: "SC401A" },
  });
  assert.equal(joined.response.status, 201);
  assert.equal(joined.body.course.id, "soft401");

  const bootstrap = await request(testServer.baseUrl, "/api/bootstrap", {
    token: student.token,
  });
  assert.equal(bootstrap.response.status, 200);
  assert.deepEqual(bootstrap.body.enrolledCourseIds, ["soft401"]);
  assert.equal(bootstrap.body.schedule.length, 3);

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

  const checkIn = await request(
    testServer.baseUrl,
    `/api/attendance/${attendanceId}/check-in`,
    {
      method: "POST",
      token: student.token,
      body: { wifi: true, bluetooth: true },
    },
  );
  assert.equal(checkIn.response.status, 200);
  assert.equal(checkIn.body.checkedIn, true);

  const openedQuiz = await request(testServer.baseUrl, "/api/quizzes", {
    method: "POST",
    token: professor.token,
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

  const closedAttendance = await request(
    testServer.baseUrl,
    `/api/attendance/${attendanceId}/close`,
    {
      method: "POST",
      token: professor.token,
    },
  );
  assert.equal(closedAttendance.response.status, 200);
  assert.equal(closedAttendance.body.attendance.present.length, 1);

  const erpExport = await request(
    testServer.baseUrl,
    "/api/erp/attendance.csv",
    { token: professor.token },
  );
  assert.equal(erpExport.response.status, 200);
  assert.match(erpExport.body, /student@kgpian\.iitkgp\.ac\.in/);
  assert.match(erpExport.body, /"P"/);
});
