const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { createApp } = require("../src/app");

// A lecture theatre, and points measured out from it.
const CLASSROOM = { latitude: 22.3149, longitude: 87.3105, accuracy: 10 };
const BACK_ROW = { latitude: 22.31494, longitude: 87.31056, accuracy: 25 };
const ANOTHER_BUILDING = { latitude: 22.3210, longitude: 87.3180, accuracy: 20 };
const AT_HOME = { latitude: 22.5726, longitude: 88.3639, accuracy: 15 };

async function startServer(env = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "campuspulse-geo-"));
  const { app, store } = createApp({
    databasePath: path.join(directory, "campuspulse.json"),
    env: { NODE_ENV: "test", ...env },
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
      name: "Geo Professor",
      department: "Mechanical Engineering",
      email: "geo.professor@mech.iitkgp.ac.in",
      password: "a-good-password",
      phone: "9876543210",
    },
  });
  assert.equal(professor.status, 201);

  const course = await call(baseUrl, "/api/courses", {
    method: "POST",
    token: professor.body.token,
    body: { name: "Geo Hall", courseCode: "GEO101", department: "Mechanical Engineering" },
  });
  assert.equal(course.status, 201);
  const courseId = course.body.course.id;
  const joinCode = course.body.course.studentCode || course.body.course.code;

  await call(baseUrl, `/api/courses/${courseId}/roster`, {
    method: "PUT",
    token: professor.body.token,
    body: { students: [{ serial: 1, rollNumber: "24GEO001", name: "Geo Student" }] },
  });

  const student = await call(baseUrl, "/api/auth/signup", {
    method: "POST",
    body: {
      role: "student",
      name: "Geo Student",
      department: "Mechanical Engineering",
      email: "geo.student@kgpian.iitkgp.ac.in",
      password: "a-good-password",
      phone: "9876543210",
      rollNumber: "24GEO001",
      hall: "Nehru Hall",
    },
  });
  assert.equal(student.status, 201);
  const joined = await call(baseUrl, "/api/courses/join", {
    method: "POST",
    token: student.body.token,
    body: { code: joinCode, rollNumber: "24GEO001" },
  });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));

  return {
    professorToken: professor.body.token,
    studentToken: student.body.token,
    courseId,
  };
}

async function openAttendance(baseUrl, token, courseId, location = CLASSROOM) {
  return call(baseUrl, "/api/attendance/sessions", {
    method: "POST",
    token,
    body: { courseId, location },
  });
}

async function checkIn(baseUrl, token, sessionId, code, location) {
  return call(baseUrl, `/api/attendance/${sessionId}/check-in`, {
    method: "POST",
    token,
    body: {
      rollNumber: "24GEO001",
      signals: { wifi: true, bluetooth: true },
      code,
      ...(location ? { location } : {}),
    },
  });
}

async function currentCode(baseUrl, token, sessionId) {
  const result = await call(baseUrl, `/api/attendance/${sessionId}/code`, { token });
  assert.equal(result.status, 200);
  return result.body.code;
}

test("a session records the classroom's position when one is offered", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, courseId } = await classroom(server.baseUrl);

  const opened = await openAttendance(server.baseUrl, professorToken, courseId);
  assert.equal(opened.status, 201);
  // The coordinates themselves are not handed back to the class.
  assert.equal(opened.body.attendance.location, undefined);
  assert.equal(opened.body.attendance.hasLocation, true);
});

test("attendance still opens on a device that cannot supply a position", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, studentToken, courseId } = await classroom(server.baseUrl);

  // An app already installed on a phone may have no way to ask for the
  // location permission. Refusing to open the register would leave the
  // professor unable to take attendance at all.
  const opened = await call(server.baseUrl, "/api/attendance/sessions", {
    method: "POST",
    token: professorToken,
    body: { courseId },
  });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  assert.equal(opened.body.attendance.hasLocation, false);

  const sessionId = opened.body.attendance.id;
  const code = await currentCode(server.baseUrl, professorToken, sessionId);

  // With no classroom position to compare against, Bluetooth alone decides.
  const marked = await checkIn(server.baseUrl, studentToken, sessionId, code, BACK_ROW);
  assert.equal(marked.status, 201, JSON.stringify(marked.body));
  assert.equal(marked.body.proximity.locationVerified, false);
});

test("a student in the room is marked present, a student elsewhere is not", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, studentToken, courseId } = await classroom(server.baseUrl);
  const opened = await openAttendance(server.baseUrl, professorToken, courseId);
  const sessionId = opened.body.attendance.id;
  const code = await currentCode(server.baseUrl, professorToken, sessionId);

  const faraway = await checkIn(server.baseUrl, studentToken, sessionId, code, AT_HOME);
  assert.equal(faraway.status, 403, JSON.stringify(faraway.body));
  assert.match(faraway.body.error, /from this class/i);

  const inRoom = await checkIn(server.baseUrl, studentToken, sessionId, code, BACK_ROW);
  assert.equal(inRoom.status, 201, JSON.stringify(inRoom.body));
  assert.equal(inRoom.body.checkedIn, true);
});

test("a student whose phone gives no fix still marks present on Bluetooth", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, studentToken, courseId } = await classroom(server.baseUrl);
  const opened = await openAttendance(server.baseUrl, professorToken, courseId);
  const sessionId = opened.body.attendance.id;
  const code = await currentCode(server.baseUrl, professorToken, sessionId);

  // The beacon token is the proof of presence; locking out a phone that cannot
  // produce a fix would exclude students who are genuinely in the room.
  const noFix = await checkIn(server.baseUrl, studentToken, sessionId, code, null);
  assert.equal(noFix.status, 201, JSON.stringify(noFix.body));
  assert.equal(
    noFix.body.proximity.locationVerified,
    false,
    "the mark is recorded as resting on Bluetooth alone",
  );
  assert.equal(noFix.body.proximity.locationMetres, null);
});

test("an unusable fix is treated as no fix, not as agreement", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, studentToken, courseId } = await classroom(server.baseUrl);
  const opened = await openAttendance(server.baseUrl, professorToken, courseId);
  const sessionId = opened.body.attendance.id;
  const code = await currentCode(server.baseUrl, professorToken, sessionId);

  const nonsense = await checkIn(server.baseUrl, studentToken, sessionId, code, {
    latitude: "not-a-number",
    longitude: 87.3105,
  });
  assert.equal(nonsense.status, 201, JSON.stringify(nonsense.body));
  assert.equal(nonsense.body.proximity.locationVerified, false);
});

test("a rough fix in the room still passes, because its error bar is allowed for", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, studentToken, courseId } = await classroom(server.baseUrl);
  const opened = await openAttendance(server.baseUrl, professorToken, courseId);
  const sessionId = opened.body.attendance.id;
  const code = await currentCode(server.baseUrl, professorToken, sessionId);

  // Indoors a phone often reports a 200 m error bar. A student that far out on
  // paper but genuinely present must not be turned away.
  const vague = await checkIn(server.baseUrl, studentToken, sessionId, code, {
    latitude: 22.3163,
    longitude: 87.3119,
    accuracy: 200,
  });
  assert.equal(
    vague.status,
    201,
    `a fuzzy indoor fix must not reject a student in the room: ${JSON.stringify(vague.body)}`,
  );
  // Both measurements are kept so a disputed mark can be examined.
  assert.equal(typeof vague.body.proximity.locationMetres, "number");
  assert.equal(vague.body.proximity.locationAccuracy, 200);
});

test("the geofence radius is configurable", async (t) => {
  const server = await startServer({ ATTENDANCE_GEOFENCE_METRES: "25" });
  t.after(() => server.close());
  const { professorToken, studentToken, courseId } = await classroom(server.baseUrl);
  const opened = await openAttendance(server.baseUrl, professorToken, courseId);
  const sessionId = opened.body.attendance.id;
  const code = await currentCode(server.baseUrl, professorToken, sessionId);

  // Roughly a kilometre away, with tight accuracy on both fixes.
  const nextBuilding = await checkIn(
    server.baseUrl,
    studentToken,
    sessionId,
    code,
    { ...ANOTHER_BUILDING, accuracy: 5 },
  );
  assert.equal(nextBuilding.status, 403, JSON.stringify(nextBuilding.body));
  assert.match(nextBuilding.body.error, /\d+ m from this class/);
});

test("a wrong beacon token is refused even from inside the room", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, studentToken, courseId } = await classroom(server.baseUrl);
  const opened = await openAttendance(server.baseUrl, professorToken, courseId);
  const sessionId = opened.body.attendance.id;

  // Location alone must never be enough; Bluetooth is still the proof of presence.
  const spoofed = await checkIn(server.baseUrl, studentToken, sessionId, "ZZZZZZ", BACK_ROW);
  assert.equal(spoofed.status, 403);
  assert.match(spoofed.body.error, /code/i);
});

// The teaching device goes on broadcasting while the app is backgrounded, which
// it can only do by deriving each window's token for itself. That derivation
// lives in AttendanceBeaconService.java and has to match this server exactly, so
// the material behind it — and who is allowed to see it — is pinned here.
test("the course team is given what it needs to derive the token itself", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const { professorToken, studentToken, courseId } = await classroom(server.baseUrl);

  const opened = await openAttendance(server.baseUrl, professorToken, courseId);
  assert.equal(opened.status, 201);
  const sessionId = opened.body.attendance.id;

  // The secret rides on exactly one route. A session read back anywhere else
  // must not carry it, however privileged the reader.
  assert.equal(opened.body.attendance.proximitySecret, undefined);
  const session = await call(server.baseUrl, `/api/attendance/${sessionId}`, {
    token: professorToken,
  });
  assert.equal(session.status, 200);
  assert.equal(session.body.attendance.proximitySecret, undefined);

  const shown = await call(server.baseUrl, `/api/attendance/${sessionId}/code`, {
    token: professorToken,
  });
  assert.equal(shown.status, 200);
  const { secret, windowMs, digits, serverTime, code } = shown.body;
  assert.equal(typeof secret, "string");
  assert.ok(secret.length > 0);
  assert.equal(windowMs, 30000);
  assert.equal(digits, 6);
  assert.equal(typeof serverTime, "number");

  // Character for character, the derivation the native beacon performs.
  const derived = crypto
    .createHash("sha256")
    .update(`${secret}:${Math.floor(serverTime / windowMs)}`)
    .digest("hex")
    .slice(0, digits)
    .toUpperCase();
  assert.equal(derived, code);

  // And a token derived that way marks a student present, which is the whole
  // point: a locked phone in a pocket keeps the register working.
  const marked = await checkIn(
    server.baseUrl,
    studentToken,
    sessionId,
    derived,
    CLASSROOM,
  );
  assert.equal(marked.status, 201, JSON.stringify(marked.body));

  // None of it is readable by the people it is meant to keep honest.
  const peeked = await call(server.baseUrl, `/api/attendance/${sessionId}/code`, {
    token: studentToken,
  });
  assert.equal(peeked.status, 403);
});
