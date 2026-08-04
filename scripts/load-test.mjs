// Puts a full class through the API on a real deployment: sign-ups, sign-ins,
// then the whole room marking attendance at once, followed by cleanup.
//
// Run it against the staging service, never production. It creates and deletes
// hundreds of accounts, and production sign-up requires an emailed code anyway.
//
//   CAMPUSPULSE_API=https://campuspulse-api-staging.onrender.com \
//     node scripts/load-test.mjs
//
// Everything it creates carries a unique tag so any residue is identifiable,
// and cleanup runs even when a step fails part way through.

const BASE = process.env.CAMPUSPULSE_API || "http://127.0.0.1:8787";
const CLASS_SIZE = Number(process.env.CLASS_SIZE || 310);
const TAG = `loadtest-${Date.now().toString(36)}`;

// Refuse the production host outright rather than relying on the operator to
// remember. Deleting live accounts is not something to leave to a typo.
const PROTECTED_HOSTS = ["campuspulse-api-ayush.onrender.com"];
if (PROTECTED_HOSTS.some((host) => BASE.includes(host)) && !process.env.I_MEAN_IT) {
  console.error(
    `\nRefusing to run against ${BASE}.\n\n` +
      `This creates and deletes hundreds of accounts, so it belongs on the\n` +
      `staging service. Point CAMPUSPULSE_API at that instead.\n`,
  );
  process.exit(1);
}

const CLASSROOM = { latitude: 22.3149, longitude: 87.3105, accuracy: 12 };
const SEAT = { latitude: 22.31492, longitude: 87.31053, accuracy: 18 };

const professorEmail = `${TAG}.professor@loadtest.invalid`;
const studentEmail = (i) => `${TAG}.student.${i}@loadtest.invalid`;
const rollNumber = (i) => `${TAG.toUpperCase().slice(-6)}${String(i).padStart(4, "0")}`;
const PASSWORD = "load-test-password-9271";

let created = { professorToken: "", courseId: "", students: [] };

async function call(route, { method = "GET", token, body, retries = 6 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const started = Date.now();
    try {
      const response = await fetch(BASE + route, {
        method,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(90000),
      });
      const payload = await response.json().catch(() => ({}));
      // 502/503/504 mean the instance never ran the request (waking or busy).
      if ([502, 503, 504].includes(response.status) && attempt < retries) {
        await sleep(1500 * 2 ** attempt);
        continue;
      }
      return { status: response.status, body: payload, ms: Date.now() - started };
    } catch (error) {
      if (attempt >= retries) {
        return { status: 0, body: { error: String(error.message) }, ms: Date.now() - started };
      }
      await sleep(1000 * 2 ** attempt);
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function report(label, results, elapsed) {
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  const bad = results.filter((r) => r.status >= 400 || r.status === 0);
  const pick = (p) => times[Math.min(times.length - 1, Math.floor(times.length * p))];
  console.log(
    `  ${label.padEnd(26)} ${String(results.length - bad.length).padStart(3)}/${results.length} ok` +
      ` | wall ${String(elapsed).padStart(6)}ms` +
      ` | p50 ${String(pick(0.5)).padStart(5)}ms  p95 ${String(pick(0.95)).padStart(5)}ms  max ${String(times[times.length - 1]).padStart(5)}ms`,
  );
  if (bad.length) {
    console.log(`     first failure: ${bad[0].status} ${JSON.stringify(bad[0].body).slice(0, 160)}`);
  }
  return bad.length;
}

// Real phones are separate devices; one process opening 310 sockets at once
// hits local port limits rather than server limits, so waves keep the
// measurement about the server.
async function inWaves(items, size, worker) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(worker))));
  }
  return out;
}

async function run() {
  console.log(`\nCampusPulse production load test`);
  console.log(`  target     ${BASE}`);
  console.log(`  class size ${CLASS_SIZE}`);
  console.log(`  tag        ${TAG}\n`);

  const warm = await call("/api/health");
  console.log(`  warm-up: ${warm.status} in ${warm.ms}ms (cold start shows up here)\n`);
  if (warm.status !== 200) throw new Error("API is not reachable");

  const professor = await call("/api/auth/signup", {
    method: "POST",
    body: {
      role: "faculty",
      name: "Load Test Professor",
      department: "Load Testing",
      email: professorEmail,
      password: PASSWORD,
      phone: "9876543210",
    },
  });
  if (professor.status !== 201) throw new Error(`professor signup: ${JSON.stringify(professor.body)}`);
  created.professorToken = professor.body.token;

  const course = await call("/api/courses", {
    method: "POST",
    token: created.professorToken,
    body: { name: `Load Test ${TAG}`, courseCode: `LOAD${TAG.slice(-4).toUpperCase()}`, department: "Load Testing" },
  });
  if (course.status !== 201) throw new Error(`course: ${JSON.stringify(course.body)}`);
  created.courseId = course.body.course.id;
  const joinCode = course.body.course.studentCode || course.body.course.code;

  const roster = await call(`/api/courses/${created.courseId}/roster`, {
    method: "PUT",
    token: created.professorToken,
    body: {
      students: Array.from({ length: CLASS_SIZE }, (_u, i) => ({
        serial: i + 1,
        rollNumber: rollNumber(i),
        name: `Load Student ${i + 1}`,
      })),
    },
  });
  if (roster.status !== 200) throw new Error(`roster: ${JSON.stringify(roster.body)}`);
  console.log(`  course ${created.courseId} with a ${CLASS_SIZE}-student roster\n`);

  const indices = Array.from({ length: CLASS_SIZE }, (_u, i) => i);
  let failures = 0;

  let t = Date.now();
  const signups = await inWaves(indices, 40, (i) =>
    call("/api/auth/signup", {
      method: "POST",
      body: {
        role: "student",
        name: `Load Student ${i + 1}`,
        department: "Load Testing",
        email: studentEmail(i),
        password: PASSWORD,
        phone: "9876543210",
        rollNumber: rollNumber(i),
        hall: "Load Hall",
      },
    }),
  );
  failures += report("sign-ups", signups, Date.now() - t);
  created.students = signups.map((s) => s.body?.token).filter(Boolean);

  t = Date.now();
  const joins = await inWaves(indices, 40, (i) =>
    call("/api/courses/join", {
      method: "POST",
      token: signups[i].body.token,
      body: { code: joinCode, rollNumber: rollNumber(i) },
    }),
  );
  failures += report("course joins", joins, Date.now() - t);

  t = Date.now();
  const logins = await inWaves(indices, 40, (i) =>
    call("/api/auth/login", {
      method: "POST",
      body: { role: "student", email: studentEmail(i), password: PASSWORD },
    }),
  );
  failures += report("sign-ins (whole class)", logins, Date.now() - t);
  const tokens = logins.map((l, i) => l.body?.token || signups[i].body?.token);

  const opened = await call("/api/attendance/sessions", {
    method: "POST",
    token: created.professorToken,
    body: { courseId: created.courseId, location: CLASSROOM },
  });
  if (opened.status !== 201) throw new Error(`open attendance: ${JSON.stringify(opened.body)}`);
  const sessionId = opened.body.attendance.id;
  const codeResult = await call(`/api/attendance/${sessionId}/code`, { token: created.professorToken });
  const code = codeResult.body.code;
  console.log(`\n  attendance open, beacon code ${code}\n`);

  // The moment that matters.
  t = Date.now();
  const checkIns = await inWaves(indices, 40, (i) =>
    call(`/api/attendance/${sessionId}/check-in`, {
      method: "POST",
      token: tokens[i],
      body: {
        rollNumber: rollNumber(i),
        signals: { wifi: true, bluetooth: true },
        code,
        location: SEAT,
        bluetoothDistanceMeters: 8,
      },
    }),
  );
  const checkInWall = Date.now() - t;
  failures += report("CHECK-INS (the class)", checkIns, checkInWall);

  t = Date.now();
  const closed = await call(`/api/attendance/${sessionId}/close`, {
    method: "POST",
    token: created.professorToken,
    body: {},
  });
  console.log(`  ${"close register".padEnd(26)} ${closed.status === 200 ? "ok" : "FAILED"}      | wall ${String(Date.now() - t).padStart(6)}ms`);
  if (closed.status !== 200) failures += 1;

  const finalState = await call(`/api/attendance/${sessionId}`, { token: created.professorToken });
  const present = (finalState.body.attendance?.records || []).filter((r) => r.present);
  console.log(`\n  marks persisted: ${present.length}/${CLASS_SIZE}`);
  const unique = new Set(present.map((r) => r.rollNumber)).size;
  console.log(`  unique students: ${unique}/${CLASS_SIZE}`);
  if (present.length !== CLASS_SIZE || unique !== CLASS_SIZE) failures += 1;

  console.log(
    failures === 0
      ? `\n  RESULT: every request succeeded and every mark persisted.`
      : `\n  RESULT: ${failures} problem(s) — see above.`,
  );
  return { failures, tokens };
}

async function cleanup(tokens) {
  console.log(`\n  cleaning up…`);
  // The course must go before its owner can be deleted.
  const courseGone = created.courseId
    ? await call(`/api/courses/${created.courseId}`, { method: "DELETE", token: created.professorToken })
    : { status: 204 };
  console.log(`    course deleted: ${courseGone.status < 400 ? "yes" : `NO (${courseGone.status})`}`);

  const studentTokens = (tokens || created.students).filter(Boolean);
  const removals = await inWaves(studentTokens, 40, (token) =>
    call("/api/account", { method: "DELETE", token }),
  );
  const stuck = removals.filter((r) => r.status >= 400).length;
  console.log(`    student accounts deleted: ${removals.length - stuck}/${removals.length}`);

  const professorGone = created.professorToken
    ? await call("/api/account", { method: "DELETE", token: created.professorToken })
    : { status: 204 };
  console.log(`    professor deleted: ${professorGone.status < 400 ? "yes" : `NO (${professorGone.status})`}`);

  if (stuck || courseGone.status >= 400 || professorGone.status >= 400) {
    console.log(`\n    RESIDUE may remain, identifiable by the tag ${TAG}`);
  } else {
    console.log(`    nothing left behind.`);
  }
}

let outcome = { failures: 1, tokens: [] };
try {
  outcome = await run();
} catch (error) {
  console.error(`\n  ABORTED: ${error.message}`);
} finally {
  await cleanup(outcome.tokens);
  const health = await call("/api/health");
  console.log(`\n  post-test health: ${health.status} | courses: ${health.body.courses}`);
}
