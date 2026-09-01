#!/usr/bin/env node
/**
 * Marks one student present on a register that has already been closed.
 *
 * This is the backfill for a student who was in the room and signed the paper
 * sheet but never marked themselves on their phone. The API has no way to edit
 * a closed register, so the correction is the same three steps the app's
 * "Reopen to add students" button makes: reopen, add the roll, close again.
 *
 * Usage:
 *   node scripts/mark-present.mjs --email prof@example.edu --course MF41601 \
 *     --roll 23ME36004 --date 2026-08-25
 *
 *   --api <url>            API base (default: https://campuspulse-api-ayush.vercel.app)
 *   --email <address>      Professor or TA login for the course
 *   --role <faculty|ta>    Login role (default: faculty)
 *   --course <code|name>   Course code, name, or id — punctuation and case are ignored
 *   --roll <number>        Roll number to mark present
 *   --date <yyyy-mm-dd>    Class date. Defaults to the most recent Tuesday.
 *   --session-id <id>      Use this register instead of matching on date, for a
 *                          course that met twice on the same day
 *   --dry-run              Read everything, show the register, change nothing
 *   --yes                  Skip the confirmation prompt
 *
 * Closing a register notifies every student in the course of their own result,
 * so this sends the whole class a fresh attendance notice for an old class.
 * That is unavoidable — it is what the button in the app does too.
 *
 * The password is read from CAMPUSPULSE_PASSWORD so it stays out of your shell
 * history and the process list.
 */
import { createInterface } from "node:readline/promises";

// public/config.js retired the onrender host; the installed apps are all on
// this one, so a correction made anywhere else would not be the one students see.
const DEFAULT_API = "https://campuspulse-api-ayush.vercel.app";

function parseArgs(argv) {
  const flags = new Set();
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(name, next);
      index += 1;
    } else {
      flags.add(name);
    }
  }
  return { flags, values };
}

const { flags, values } = parseArgs(process.argv.slice(2));
const apiBase = (values.get("api") || DEFAULT_API).replace(/\/+$/, "");
const dryRun = flags.has("dry-run");

async function api(route, { method = "GET", token, body } = {}) {
  const response = await fetch(`${apiBase}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = text;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    /* a proxy error page, not JSON — keep the text for the message */
  }
  return { status: response.status, ok: response.ok, body: payload };
}

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

/** Course codes get typed as "MF41601", "mf 41601", or "softcomputing". */
function loosely(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The most recent Tuesday, today included. A correction is always filed after
 * the class, so this is the Tuesday the student means when they do not say.
 *
 * Computed in UTC because registers are matched on the UTC half of startedAt,
 * which is how the app itself decides what counts as today.
 */
function lastTuesday(from = new Date()) {
  const day = new Date(from);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() - 2 + 7) % 7));
  return day.toISOString().slice(0, 10);
}

async function main() {
  const email = values.get("email");
  const role = values.get("role") || "faculty";
  const courseWanted = values.get("course");
  const roll = String(values.get("roll") || "").trim().toUpperCase();
  const sessionIdWanted = values.get("session-id");
  const date = values.get("date") || lastTuesday();

  if (!email) fail("Pass --email followed by your professor login");
  if (!["faculty", "ta"].includes(role)) fail(`--role must be faculty or ta, not "${role}"`);
  if (!courseWanted) fail("Pass --course followed by the course code, name, or id");
  if (!roll) fail("Pass --roll followed by the roll number to mark present");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`--date must look like 2026-08-25, not "${date}"`);
  if (!values.get("date") && !sessionIdWanted) {
    console.log(`No --date given — using the most recent Tuesday, ${date}.\n`);
  }

  let password = process.env.CAMPUSPULSE_PASSWORD;
  if (!password) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    password = await rl.question("CampusPulse password: ");
    rl.close();
  }

  const login = await api("/api/auth/login", {
    method: "POST",
    body: { email, password, role },
  });
  if (!login.ok) fail(`Login failed (${login.status}): ${login.body?.error || login.body}`);
  const token = login.body.token;
  console.log(`Signed in as ${login.body.user.name}\n`);

  // ---- which course ------------------------------------------------------
  const listed = await api("/api/courses", { token });
  if (!listed.ok) fail(`Could not list courses (${listed.status})`);
  const courses = listed.body.courses || [];
  const needle = loosely(courseWanted);
  const matches = courses.filter(
    (course) =>
      loosely(course.courseCode) === needle ||
      loosely(course.name) === needle ||
      course.id === courseWanted ||
      loosely(course.courseCode).includes(needle) ||
      loosely(course.name).includes(needle),
  );
  if (!matches.length) {
    fail(
      `No course matches "${courseWanted}" on this account. It has: ` +
        (courses.map((course) => `${course.courseCode} (${course.name})`).join(", ") || "no courses"),
    );
  }
  if (matches.length > 1) {
    fail(
      `"${courseWanted}" matches more than one course: ` +
        `${matches.map((course) => course.courseCode).join(", ")}. Use the exact code.`,
    );
  }
  const course = matches[0];
  console.log(`Course: ${course.courseCode} — ${course.name}`);

  // ---- which register ----------------------------------------------------
  const past = await api(`/api/attendance/past?courseId=${encodeURIComponent(course.id)}`, { token });
  if (!past.ok) fail(`Could not read the attendance history (${past.status})`);
  const registers = past.body.sessions || [];
  const onDate = sessionIdWanted
    ? registers.filter((item) => item.id === sessionIdWanted)
    : registers.filter((item) => item.startedAt?.slice(0, 10) === date);

  if (!onDate.length) {
    const nearby = registers
      .slice(0, 8)
      .map((item) => `  ${item.startedAt.slice(0, 10)}  ${item.present}/${item.total}  ${item.id}`)
      .join("\n");
    fail(
      `No closed register for ${course.courseCode} on ${date}.\n\nMost recent registers:\n${nearby || "  (none)"}`,
    );
  }
  if (onDate.length > 1) {
    const options = onDate
      .map((item) => `  ${item.classLabel || "unlabelled class"}  ${item.present}/${item.total}  --session-id ${item.id}`)
      .join("\n");
    fail(`${course.courseCode} has ${onDate.length} registers on ${date}:\n${options}\n\nRe-run with --session-id.`);
  }
  const register = onDate[0];

  // The listing carries counts but not the roster, so read the register itself
  // to find out whether this correction is even needed.
  const detail = await api(`/api/attendance/${encodeURIComponent(register.id)}`, { token });
  if (!detail.ok) fail(`Could not read register ${register.id} (${detail.status})`);
  const records = detail.body.attendance?.records || [];
  const record = records.find((item) => item.rollNumber === roll);
  if (!record) {
    fail(
      `${roll} is not on this register. They are not on the ${course.courseCode} roll list — ` +
        "add them on the Students tab first, then re-run.",
    );
  }

  console.log(`Register: ${register.classLabel || "unlabelled class"} on ${register.startedAt.slice(0, 10)}`);
  console.log(`          ${register.present} of ${register.total} present, closed ${register.closedAt?.slice(0, 16).replace("T", " ") || "?"}`);
  console.log(`Student:  ${roll} — ${record.name || "name not on record"} — currently ${record.present ? "PRESENT" : "ABSENT"}\n`);

  if (record.present) {
    console.log("✓ Already marked present on this register. Nothing to change.");
    return;
  }

  // Reopening closes whatever else is open for this course, which would end a
  // live register mid-class. Worth knowing before, not after.
  const current = await api(`/api/attendance/current?courseId=${encodeURIComponent(course.id)}`, { token });
  if (current.ok && current.body.attendance?.status === "open") {
    fail(
      `${course.courseCode} has a register open right now (${current.body.attendance.id}). ` +
        "Reopening Tuesday's would close it. Wait until that class is finished.",
    );
  }

  if (dryRun) {
    console.log(`Dry run — would reopen ${register.id}, add ${roll}, and close it again.`);
    return;
  }

  if (!flags.has("yes")) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `Mark ${roll} present on ${course.courseCode} ${date}?\n` +
        `This reopens and re-closes the register, which sends all ${register.total} students ` +
        "a notification of their own result for that class. Type yes to continue: ",
    );
    rl.close();
    if (answer.trim().toLowerCase() !== "yes") fail("Cancelled — nothing was changed.");
  }

  // ---- the three steps the app's button makes ----------------------------
  const reopened = await api(`/api/attendance/${encodeURIComponent(register.id)}/reopen`, {
    method: "POST",
    token,
    body: {},
  });
  if (!reopened.ok) fail(`Could not reopen the register (${reopened.status}): ${reopened.body?.error || ""}`);
  console.log("✓ Reopened");

  const added = await api(`/api/attendance/${encodeURIComponent(register.id)}/add-student`, {
    method: "POST",
    token,
    body: { rollNumber: roll },
  });
  if (!added.ok) {
    console.error(`✖ Could not add ${roll} (${added.status}): ${added.body?.error || ""}`);
    console.error(`  The register is still OPEN. Close it in the app, or re-run once that is fixed.`);
    process.exit(1);
  }
  console.log(`✓ ${roll} marked present`);

  const closed = await api(`/api/attendance/${encodeURIComponent(register.id)}/close`, {
    method: "POST",
    token,
    body: {},
  });
  if (!closed.ok) {
    console.error(`✖ ${roll} was marked, but the register would not close (${closed.status}).`);
    console.error("  It is still open and students can check in. Close it in the app now.");
    process.exit(1);
  }
  console.log("✓ Closed again\n");

  // Read it back rather than trusting the write: this is a graded record.
  const after = await api(`/api/attendance/${encodeURIComponent(register.id)}`, { token });
  const confirmed = (after.body?.attendance?.records || []).find((item) => item.rollNumber === roll);
  const total = (after.body?.attendance?.records || []).filter((item) => item.present).length;
  if (!confirmed?.present) {
    fail(`${roll} still does not read as present. Check the register in the app.`);
  }
  console.log(`✓ Verified: ${roll} is present on ${course.courseCode} ${date}. Register now ${total} of ${register.total}.`);
}

main().catch((error) => fail(error.stack || String(error)));
