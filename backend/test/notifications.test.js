const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../src/app");
const { createStore, initialData, normalizeData } = require("../src/database");
const { createFirebaseNotifier } = require("../src/push-notifier");
const { sha256 } = require("../src/security");

async function request(baseUrl, route, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
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
  return {
    response,
    body: contentType.includes("application/json")
      ? await response.json()
      : await response.text(),
  };
}

async function notificationServer(pushNotifier) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "campuspulse-push-"));
  const env = { ALLOWED_ORIGINS: "http://localhost" };
  const store = createStore(path.join(directory, "database.json"), { env });
  const tokens = {
    professor: "professor-session",
    student: "student-session",
    outsider: "outsider-session",
  };
  await store.update((database) => {
    database.users.push(
      { id: "professor", role: "faculty", name: "Professor", email: "p@iitkgp.ac.in" },
      { id: "student", role: "student", name: "Student", email: "s@kgpian.iitkgp.ac.in" },
      { id: "outsider", role: "student", name: "Outsider", email: "o@kgpian.iitkgp.ac.in" },
    );
    for (const [userId, token] of Object.entries(tokens)) {
      database.sessions.push({
        userId,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    }
    database.courses.push({
      id: "course-1",
      ownerId: "professor",
      code: "JOIN1234",
      name: "Push Systems",
      courseCode: "PS10001",
      section: "Test",
      room: "Room 1",
    });
    database.courseStudents.push({
      courseId: "course-1",
      serial: 1,
      rollNumber: "23PS10001",
      name: "Student",
    });
    database.enrollments.push({
      userId: "student",
      courseId: "course-1",
      courseRole: "student",
      rollNumber: "23PS10001",
    });
    database.schedule.push({
      id: "schedule-1",
      courseId: "course-1",
      day: "Monday",
      start: "3:00 PM",
      end: "4:00 PM",
      topic: "Push delivery",
    });
    return null;
  });
  const { app } = createApp({
    store,
    pushNotifier,
    env,
    mailer: { configured: false },
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    directory,
    store,
    tokens,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("course events persist a private inbox and push to valid member devices", async (t) => {
  const pushes = [];
  const fakeNotifier = {
    configured: true,
    provider: "fake",
    status: "configured",
    async send(message) {
      pushes.push(message);
      if (message.token.startsWith("invalid-")) {
        const error = new Error("unregistered");
        error.invalidToken = true;
        throw error;
      }
      if (message.token.startsWith("transient-")) throw new Error("temporary outage");
      return { delivered: true };
    },
  };
  const server = await notificationServer(fakeNotifier);
  t.after(async () => {
    await server.close();
    await fs.rm(server.directory, { recursive: true, force: true });
  });

  const unauthenticated = await request(server.baseUrl, "/api/notifications");
  assert.equal(unauthenticated.response.status, 401);

  for (const [token, session] of [
    ["invalid-student-device", server.tokens.student],
    ["professor-device-token", server.tokens.professor],
    ["outsider-device-token", server.tokens.outsider],
  ]) {
    const registered = await request(server.baseUrl, "/api/notifications/devices", {
      method: "POST",
      token: session,
      body: { token, platform: "android" },
    });
    assert.equal(registered.response.status, 201);
  }
  // Registration is tied to the authenticated session and bounded so one
  // account cannot turn a course event into unlimited outbound requests.
  for (let index = 0; index < 7; index += 1) {
    await request(server.baseUrl, "/api/notifications/devices", {
      method: "POST",
      token: server.tokens.outsider,
      body: { token: `outsider-device-${index}`, platform: "android" },
    });
  }
  const boundedDevices = (await server.store.read()).pushDevices.filter(
    (device) => device.userId === "outsider",
  );
  assert.equal(boundedDevices.length, 5);
  assert.ok(boundedDevices.every((device) => device.sessionTokenHash));

  const attendance = await request(server.baseUrl, "/api/attendance/sessions", {
    method: "POST",
    token: server.tokens.professor,
    body: { courseId: "course-1", scheduleId: "schedule-1" },
  });
  assert.equal(attendance.response.status, 201);
  assert.deepEqual(pushes.map((item) => item.token), ["invalid-student-device"]);
  assert.equal(pushes[0].data.type, "attendance");
  assert.equal(pushes[0].data.route, "attendance");
  assert.equal(pushes[0].data.courseId, "course-1");
  assert.equal(pushes[0].data.attendanceId, attendance.body.attendance.id);
  assert.match(pushes[0].data.notificationId, /^notification-/);
  assert.equal(
    (await server.store.read()).pushDevices.some(
      (device) => device.token === "invalid-student-device",
    ),
    false,
  );

  const studentInbox = await request(server.baseUrl, "/api/notifications", {
    token: server.tokens.student,
  });
  assert.equal(studentInbox.body.unreadCount, 1);
  assert.equal(studentInbox.body.notifications[0].type, "attendance");
  assert.equal(studentInbox.body.notifications[0].readAt, null);
  assert.equal("userId" in studentInbox.body.notifications[0], false);
  const notificationId = studentInbox.body.notifications[0].id;

  const hidden = await request(
    server.baseUrl,
    `/api/notifications/${notificationId}/read`,
    { method: "PATCH", token: server.tokens.outsider },
  );
  assert.equal(hidden.response.status, 404);
  const read = await request(
    server.baseUrl,
    `/api/notifications/${notificationId}/read`,
    { method: "PATCH", token: server.tokens.student },
  );
  assert.equal(read.response.status, 200);
  assert.ok(read.body.notification.readAt);

  for (const token of ["student-device-token", "transient-student-device"]) {
    await request(server.baseUrl, "/api/notifications/devices", {
      method: "POST",
      token: server.tokens.student,
      body: { token, platform: "android" },
    });
  }
  const quizBody = {
    courseId: "course-1",
    title: "Live quiz",
    scheduleId: "schedule-1",
    classLabel: "Monday class",
    quizDate: "2026-08-03",
    timeLimitMinutes: 5,
    reveal: "after-quiz",
    questions: [{ text: "Ready?", options: ["Yes", "No"], answer: 0 }],
  };
  const liveQuiz = await request(server.baseUrl, "/api/quizzes", {
    method: "POST",
    token: server.tokens.professor,
    body: quizBody,
  });
  assert.equal(liveQuiz.response.status, 201);

  const draft = await request(server.baseUrl, "/api/quizzes", {
    method: "POST",
    token: server.tokens.professor,
    body: { ...quizBody, title: "Draft quiz", status: "draft" },
  });
  assert.equal(draft.response.status, 201);
  const callsBeforePublish = pushes.length;
  const published = await request(
    server.baseUrl,
    `/api/quizzes/${draft.body.quiz.id}/publish`,
    { method: "POST", token: server.tokens.professor },
  );
  assert.equal(published.response.status, 200);
  assert.equal(pushes.length, callsBeforePublish + 2);

  const material = await request(server.baseUrl, "/api/courses/course-1/materials", {
    method: "POST",
    token: server.tokens.professor,
    headers: {
      "content-type": "text/plain",
      "x-file-name": encodeURIComponent("Lecture notes.txt"),
    },
    rawBody: Buffer.from("notes"),
  });
  assert.equal(material.response.status, 201);
  assert.equal(material.body.material.fileName, "Lecture notes.txt");

  const limited = await request(server.baseUrl, "/api/notifications?limit=2", {
    token: server.tokens.student,
  });
  assert.equal(limited.body.notifications.length, 2);
  assert.equal(limited.body.unreadCount, 3);
  assert.deepEqual(
    limited.body.notifications.map((item) => item.type),
    ["material", "quiz"],
  );
  assert.equal(limited.body.notifications[0].route, "materials");
  assert.equal(limited.body.notifications[0].data.materialId, material.body.material.id);

  const allRead = await request(server.baseUrl, "/api/notifications/read-all", {
    method: "POST",
    token: server.tokens.student,
  });
  assert.deepEqual(allRead.body, { updated: 3, unreadCount: 0 });

  const removed = await request(server.baseUrl, "/api/notifications/devices", {
    method: "DELETE",
    token: server.tokens.student,
    body: { token: "student-device-token" },
  });
  assert.equal(removed.response.status, 204);
  const stored = await server.store.read();
  assert.equal(
    stored.pushDevices.some((device) => device.token === "student-device-token"),
    false,
  );
  // A transient delivery error did not fail any event or delete the token.
  assert.equal(
    stored.pushDevices.some((device) => device.token === "transient-student-device"),
    true,
  );
  assert.deepEqual(
    (await request(server.baseUrl, "/api/notifications", { token: server.tokens.outsider }))
      .body.notifications,
    [],
  );

  const loggedOut = await request(server.baseUrl, "/api/auth/logout", {
    method: "POST",
    token: server.tokens.outsider,
  });
  assert.equal(loggedOut.response.status, 204);
  assert.equal(
    (await server.store.read()).pushDevices.some((device) => device.userId === "outsider"),
    false,
  );

  const deleted = await request(server.baseUrl, "/api/courses/course-1", {
    method: "DELETE",
    token: server.tokens.professor,
  });
  assert.equal(deleted.response.status, 200);
  const afterCourseDeletion = await server.store.read();
  assert.equal(
    afterCourseDeletion.courseNotices.some((notice) => notice.courseId === "course-1"),
    false,
  );
  assert.equal(
    afterCourseDeletion.notifications.some(
      (notification) => notification.courseId === "course-1",
    ),
    false,
  );
});

test("notification data is normalized for existing databases", () => {
  const value = initialData({});
  value.users.push({ id: "user-1" });
  value.notifications = [
    { id: "n-1", userId: "user-1", title: "Hello", data: { count: 3 } },
  ];
  value.pushDevices = [
    { token: "same-device-token", userId: "user-1", platform: "unknown" },
    { token: "same-device-token", userId: "user-1", platform: "web" },
  ];
  const normalized = normalizeData(value, {});
  assert.equal(normalized.notifications[0].data.count, "3");
  assert.equal(normalized.notifications[0].readAt, null);
  assert.equal(normalized.pushDevices.length, 1);
  assert.equal(normalized.pushDevices[0].platform, "web");
  assert.deepEqual(normalizeData({}, {}).notifications, []);
  assert.deepEqual(normalizeData({}, {}).pushDevices, []);
});

test("Firebase HTTP v1 notifier signs requests, normalizes data, and flags dead tokens", async () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === "https://oauth2.googleapis.com/token") {
      return {
        ok: true,
        status: 200,
        async json() {
          return { access_token: "oauth-token", expires_in: 3600 };
        },
      };
    }
    const payload = JSON.parse(options.body);
    if (payload.message.token === "dead-token") {
      return {
        ok: false,
        status: 404,
        async json() {
          return {
            error: {
              message: "Requested entity was not found.",
              details: [{ errorCode: "UNREGISTERED" }],
            },
          };
        },
      };
    }
    return { ok: true, status: 200, async json() { return { name: "message/1" }; } };
  };
  const notifier = createFirebaseNotifier(
    {
      FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        project_id: "campuspulse-test",
        client_email: "firebase@test.invalid",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      }),
    },
    { fetch },
  );
  assert.equal(notifier.configured, true);
  await Promise.all([
    notifier.send({ token: "phone-1", title: "One", data: { count: 2 } }),
    notifier.send({ token: "phone-2", title: "Two", data: { open: true } }),
  ]);
  assert.equal(calls.filter((call) => call.url.includes("oauth2.googleapis.com")).length, 1);
  const message = JSON.parse(calls.find((call) => call.url.includes("messages:send")).options.body);
  assert.equal(message.message.data.count, "2");
  assert.equal(message.message.android.notification.channel_id, "campuspulse_events");
  await assert.rejects(
    notifier.send({ token: "dead-token", title: "Dead" }),
    (error) => error.invalidToken === true,
  );
  assert.equal(
    createFirebaseNotifier({ FIREBASE_SERVICE_ACCOUNT_JSON: "not-json" }).status,
    "invalid",
  );
});
