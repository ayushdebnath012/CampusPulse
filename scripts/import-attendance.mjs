#!/usr/bin/env node
/**
 * Files the scanned paper attendance sheets into CampusPulse.
 *
 * Two separate things come off those sheets. The dates say which weekdays each
 * course meets, which becomes the course timetable. The signatures say who was
 * there, which becomes one closed register per class held.
 *
 * Usage:
 *   node scripts/import-attendance.mjs --email prof@example.edu [options]
 *
 *   --api <url>             API base (default: https://campuspulse-api-ayush.onrender.com)
 *   --list                  Show which registers are already on the server, and
 *                           how their counts compare with the paper sheets
 *   --dry-run               Print what would be sent and change nothing
 *   --skip-schedule         Leave the timetable alone, import registers only
 *   --skip-registers        Save the timetable only
 *   --overwrite             Replace a register already on the server with the
 *                           paper one. The existing register is written to
 *                           backend/data/attendance-backups first, because the
 *                           one being replaced may be what the class marked
 *                           from their phones and there is no undo.
 *   --include-unreviewed    Also import sessions flagged needsReview. Read the
 *                           'note' on each one first — they are flagged because
 *                           importing them would record students absent on the
 *                           strength of a scan that does not say so.
 *
 * The password is read from CAMPUSPULSE_PASSWORD so it stays out of your shell
 * history and the process list.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_API = "https://campuspulse-api-ayush.onrender.com";
// Ignored by backend/.gitignore along with the rest of backend/data.
const BACKUP_DIR = path.join(root, "backend/data/attendance-backups");

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
const includeUnreviewed = flags.has("include-unreviewed");
const overwrite = flags.has("overwrite");

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

/** Roll numbers for a printed sheet, looked up by the Sl.No column. */
function rollNumbersFor(session, roster) {
  const bySerial = new Map(roster.students.map((student) => [student.serial, student]));
  if (Array.isArray(session.presentRollNumbers)) {
    const known = new Set(roster.students.map((student) => student.rollNumber));
    const rolls = session.presentRollNumbers.map((roll) => String(roll).trim().toUpperCase());
    const unknown = rolls.filter((roll) => !known.has(roll));
    if (unknown.length) {
      fail(
        `${session.courseCode} ${session.date}: roll numbers not on the roll list: ${unknown.join(", ")}`,
      );
    }
    return rolls;
  }
  const serials = session.presentSerials || [];
  const missing = serials.filter((serial) => !bySerial.has(serial));
  if (missing.length) {
    fail(`${session.courseCode} ${session.date}: no roster entry for Sl.No ${missing.join(", ")}`);
  }
  return serials.map((serial) => bySerial.get(serial).rollNumber);
}

async function main() {
  const sheets = JSON.parse(
    await readFile(path.join(root, "backend/data/attendance-sheets.json"), "utf8"),
  );
  const rosters = JSON.parse(
    await readFile(path.join(root, "backend/data/course-rosters.json"), "utf8"),
  );
  const rosterByCode = new Map(rosters.map((entry) => [entry.courseCode, entry]));

  // Cross-check the transcription against the roll lists before anything is
  // sent, so a bad sheet fails here rather than half way through the import.
  for (const session of sheets.sessions) {
    const roster = rosterByCode.get(session.courseCode);
    if (!roster) fail(`No roll list for ${session.courseCode} in course-rosters.json`);
    if (session.rosterSize && session.rosterSize !== roster.students.length) {
      fail(
        `${session.courseCode} ${session.date}: sheet says ${session.rosterSize} students, roll list has ${roster.students.length}`,
      );
    }
    rollNumbersFor(session, roster);
  }
  console.log("✓ Every transcribed entry matches the roll lists.\n");

  // Both courses run twice a week, one class on Monday and one on Tuesday.
  // A second class on the same weekday would be a second register for that
  // day, so a stray duplicate here would quietly split a class in two.
  for (const course of sheets.courses) {
    const seen = new Set();
    for (const entry of course.classes) {
      if (seen.has(entry.day)) {
        fail(`${course.courseCode}: two classes on ${entry.day}; each course runs once a day`);
      }
      seen.add(entry.day);
    }
  }
  // Every class date on a sheet has to fall on a day the course actually runs.
  const daysByCode = new Map(
    sheets.courses.map((course) => [course.courseCode, new Set(course.classes.map((k) => k.day))]),
  );
  const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  for (const session of sheets.sessions) {
    const [y, m, d] = session.date.split("-").map(Number);
    const weekday = WEEKDAYS[new Date(y, m - 1, d).getDay()];
    if (weekday !== session.weekday) {
      fail(`${session.courseCode} ${session.date} is a ${weekday}, but the sheet is filed as ${session.weekday}`);
    }
    const days = daysByCode.get(session.courseCode);
    if (days && !days.has(weekday)) {
      fail(`${session.courseCode} ${session.date} is a ${weekday}, which is not a day this course runs`);
    }
  }
  console.log("✓ Every class date falls on a day the course runs.\n");

  // A dry run never contacts the API, so it needs no credentials at all.
  const email = values.get("email");
  if (!email && !dryRun) fail("Pass --email followed by your professor login, e.g. --email you@kgpian.iitkgp.ac.in");
  let password = process.env.CAMPUSPULSE_PASSWORD;
  if (!password && !dryRun) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    password = await rl.question("CampusPulse password: ");
    rl.close();
  }

  if (dryRun) {
    console.log(`Dry run against ${apiBase} — nothing will be sent.\n`);
  }

  let token = null;
  if (!dryRun) {
    const login = await api("/api/auth/login", {
      method: "POST",
      body: { email, password, role: "faculty" },
    });
    if (!login.ok) fail(`Login failed (${login.status}): ${login.body?.error || login.body}`);
    token = login.body.token;
    console.log(`Signed in as ${login.body.user.name}\n`);
  }

  let courseByCode = new Map();
  if (!dryRun) {
    const listed = await api("/api/courses", { token });
    if (!listed.ok) fail(`Could not list courses (${listed.status})`);
    courseByCode = new Map(listed.body.courses.map((course) => [course.courseCode, course]));
    for (const wanted of sheets.courses) {
      if (!courseByCode.has(wanted.courseCode)) {
        fail(
          `${wanted.courseCode} does not exist on ${apiBase} under this account. Create it in the app (and upload its roll list) first.`,
        );
      }
    }
  }

  // ---- what is already on the server -----------------------------------
  if (flags.has("list")) {
    const wanted = new Map();
    for (const session of sheets.sessions) {
      wanted.set(`${session.courseCode}::${session.date}`, session);
    }
    for (const course of sheets.courses) {
      const live = courseByCode.get(course.courseCode);
      const past = await api(`/api/attendance/past?courseId=${encodeURIComponent(live.id)}`, { token });
      if (!past.ok) fail(`Could not read ${course.courseCode} registers (${past.status})`);
      console.log(`${course.courseCode} — ${past.body.sessions.length} register(s) on the server`);
      for (const filed of past.body.sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
        const date = filed.startedAt.slice(0, 10);
        const sheet = wanted.get(`${course.courseCode}::${date}`);
        const share = filed.total ? Math.round((filed.present / filed.total) * 100) : 0;
        // Where a sheet covers the same day, the two counts are shown side by
        // side: a register taken on phones and one signed on paper rarely agree.
        const against = sheet && (sheet.presentSerials?.length || sheet.presentRollNumbers?.length)
          ? `   sheet says ${(sheet.presentSerials || sheet.presentRollNumbers).length}`
          : "";
        console.log(`  ${date}  ${String(filed.present).padStart(3)}/${filed.total}  ${String(share).padStart(3)}%${against}`);
      }
      const missing = sheets.sessions.filter(
        (session) =>
          session.courseCode === course.courseCode &&
          !past.body.sessions.some((filed) => filed.startedAt.slice(0, 10) === session.date),
      );
      for (const session of missing) {
        console.log(`  ${session.date}  not filed${session.needsReview ? " (sheet needs review)" : ""}`);
      }
      console.log("");
    }
    return;
  }

  // ---- timetable -------------------------------------------------------
  if (flags.has("skip-schedule")) {
    console.log("Skipping the timetable (--skip-schedule).\n");
  } else if (!sheets.scheduleTimesKnown) {
    console.log(
      [
        "⚠ Skipping the timetable: the sheets record the class dates but not the times.",
        "  Fill in start/end/room for each day in backend/data/attendance-sheets.json",
        '  and set "scheduleTimesKnown": true, then re-run.',
        `  Days derived from the sheet dates: ${sheets.courses
          .map((c) => `${c.courseCode} = ${c.classes.map((k) => k.day).join(" + ")}`)
          .join("; ")}`,
        "  Registers below are unaffected — they attach to a class if one exists,",
        "  and stand on their own date if not.\n",
      ].join("\n"),
    );
  } else {
    for (const wanted of sheets.courses) {
      const course = courseByCode.get(wanted.courseCode);
      const label = `${wanted.courseCode} timetable`;
      if (dryRun) {
        console.log(`[dry-run] PUT /api/courses/<${wanted.courseCode}>/schedule`);
        console.log(`          ${wanted.classes.map((k) => `${k.day} ${k.start}-${k.end}`).join(", ")}`);
        continue;
      }
      const saved = await api(`/api/courses/${course.id}/schedule`, {
        method: "PUT",
        token,
        body: { revision: Number(course.scheduleRevision) || 0, classes: wanted.classes },
      });
      if (!saved.ok) fail(`${label} failed (${saved.status}): ${saved.body?.error || saved.body}`);
      console.log(`✓ ${label}: ${saved.body.schedule.map((k) => k.day).join(" + ")}`);
    }
    console.log("");
  }

  // ---- registers -------------------------------------------------------
  if (flags.has("skip-registers")) {
    console.log("Skipping registers (--skip-registers).");
    return;
  }

  const ordered = [...sheets.sessions].sort((a, b) => a.date.localeCompare(b.date));
  let imported = 0;
  let skipped = 0;
  for (const session of ordered) {
    const roster = rosterByCode.get(session.courseCode);
    const present = rollNumbersFor(session, roster);
    const tag = `${session.courseCode} ${session.date} (${session.weekday})`;

    if (session.needsReview && !includeUnreviewed) {
      console.log(`- ${tag}: skipped, needs review — ${session.note}`);
      skipped += 1;
      continue;
    }
    // An empty register is not a record of an empty room, it is a sheet nobody
    // has transcribed yet. Filing it would mark the whole class absent.
    if (!present.length) {
      console.log(`- ${tag}: skipped, nothing transcribed yet (would mark all ${roster.students.length} absent)`);
      skipped += 1;
      continue;
    }
    if (dryRun) {
      console.log(
        `[dry-run] POST /api/attendance/import  ${tag}  ${present.length}/${roster.students.length} present`,
      );
      imported += 1;
      continue;
    }
    const course = courseByCode.get(session.courseCode);
    const created = await api("/api/attendance/import", {
      method: "POST",
      token,
      body: { courseId: course.id, startedAt: session.date, present },
    });
    if (created.status === 409 && overwrite) {
      // Saved before it is replaced, because the register on the server may be
      // the one the class marked from their phones and there is no undo.
      const past = await api(`/api/attendance/past?courseId=${encodeURIComponent(course.id)}`, { token });
      const filed = (past.body?.sessions || []).find((item) => item.startedAt.slice(0, 10) === session.date);
      let before = null;
      if (filed) {
        const full = await api(`/api/attendance/${encodeURIComponent(filed.id)}`, { token });
        before = full.body?.attendance || null;
      }
      // Without a copy of what is there, an overwrite is unrecoverable, so it
      // does not happen.
      if (!before) {
        fail(`${tag}: could not read the register already on the server, so it will not be overwritten`);
      }
      const had = before.records.filter((r) => r.present);
      if (had.map((r) => r.rollNumber).sort().join() === [...present].sort().join()) {
        console.log(`- ${tag}: already filed and identical, left alone`);
        skipped += 1;
        continue;
      }
      await mkdir(BACKUP_DIR, { recursive: true });
      const file = path.join(BACKUP_DIR, `${session.courseCode}-${session.date}-${Date.now()}.json`);
      await writeFile(file, JSON.stringify(before, null, 2), "utf8");
      console.log(`  ${tag}: replacing ${had.length}/${before.records.length} with ${present.length}/${roster.students.length}`);
      console.log(`  backed up to ${path.relative(root, file)}`);
      const replaced = await api("/api/attendance/import", {
        method: "POST",
        token,
        body: { courseId: course.id, startedAt: session.date, present, replace: true },
      });
      if (!replaced.ok) {
        fail(`${tag} replace failed (${replaced.status}): ${replaced.body?.error || replaced.body}`);
      }
      const now = replaced.body.attendance.records.filter((r) => r.present).length;
      console.log(`✓ ${tag}: overwritten, ${now}/${replaced.body.attendance.records.length} present`);
      imported += 1;
      continue;
    }
    if (created.status === 409) {
      console.log(`- ${tag}: already filed, left alone (--overwrite replaces it)`);
      skipped += 1;
      continue;
    }
    if (!created.ok) {
      fail(`${tag} failed (${created.status}): ${created.body?.error || created.body}`);
    }
    const marked = created.body.attendance.records.filter((r) => r.present).length;
    console.log(`✓ ${tag}: ${marked}/${created.body.attendance.records.length} present`);
    imported += 1;
  }

  console.log(`\n${dryRun ? "Would import" : "Imported"} ${imported} register(s); ${skipped} skipped.`);
}

main().catch((error) => fail(error.stack || String(error)));
