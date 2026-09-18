const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { buildCourseData } = require("./course-data");

// Inbox retention. Every "attendance is open" alert fans out to a whole class,
// and seven weeks of them — nine thousand records, all of the same alert — were
// 3.7 MB of a 5.2 MB document that every write moves to the database and back.
// A student needs the last few classes' alerts, not the term's.
const NOTIFICATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_NOTIFICATIONS_PER_USER = 15;

function cleanJoinCode(value) {
  return String(value || "").trim().toUpperCase().slice(0, 64);
}

function newJoinCode(used) {
  let code = "";
  do {
    code = crypto
      .randomBytes(12)
      .toString("base64url")
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 8)
      .toUpperCase();
  } while (code.length !== 8 || used.has(code));
  return code;
}

// Older databases have one `code`. It remains the student's code for backward
// compatibility, while every course also receives a separate, unguessable TA
// code. Resolving collisions here makes the invariant hold for imported data as
// well as for newly created courses.
function normalizeCourseJoinCodes(courses) {
  const used = new Set();
  return courses.map((course) => {
    let studentCode = cleanJoinCode(course?.studentCode || course?.code);
    if (!studentCode || used.has(studentCode)) studentCode = newJoinCode(used);
    used.add(studentCode);

    let taCode = cleanJoinCode(course?.taCode);
    if (!taCode || used.has(taCode)) taCode = newJoinCode(used);
    used.add(taCode);

    return {
      ...course,
      // `code` is deliberately retained for old installed clients.
      code: studentCode,
      studentCode,
      taCode,
    };
  });
}

function courseJoinCodesNeedPersistence(source, normalized) {
  const originalCourses = Array.isArray(source?.courses) ? source.courses : [];
  if (originalCourses.length !== normalized.courses.length) return true;
  return normalized.courses.some((course, index) => {
    const original = originalCourses[index] || {};
    return (
      original.id !== course.id ||
      original.code !== course.code ||
      original.studentCode !== course.studentCode ||
      original.taCode !== course.taCode
    );
  });
}

function configuredCourseOwners(env = process.env) {
  const raw = String(env.COURSE_OWNER_EMAILS_JSON || "").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("COURSE_OWNER_EMAILS_JSON must be a JSON object");
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([course, email]) => [
      String(course).trim(),
      String(email).trim().toLowerCase(),
    ]),
  );
}

function initialData(env = process.env) {
  const { courses, courseStudents } = buildCourseData(env);
  return {
    users: [],
    verificationCodes: [],
    sessions: [],
    enrollments: [],
    maintenance: [],
    courses,
    courseStudents,
    courseMaterials: [],
    courseNotices: [],
    courseMarks: [],
    notifications: [],
    pushDevices: [],
    schedule: [],
    attendanceSessions: [],
    quizzes: [],
  };
}

function normalizeData(value, env = process.env) {
  const defaults = initialData(env);
  const normalized = Object.fromEntries(
    Object.entries(defaults).map(([key, fallback]) => [
      key,
      Array.isArray(value?.[key]) ? value[key] : fallback,
    ]),
  );
  normalized.courses = normalizeCourseJoinCodes(normalized.courses);
  // Indexed once: a linear scan per enrollment made normalization quadratic,
  // and normalization runs on every load of the shared document.
  const usersById = new Map(normalized.users.map((user) => [user.id, user]));
  normalized.enrollments = normalized.enrollments
    .map((enrollment) => {
      const user = usersById.get(enrollment.userId);
      const courseRole =
        enrollment.courseRole ||
        (user?.role === "student" || user?.role === "ta" ? user.role : null);
      return courseRole ? { ...enrollment, courseRole } : null;
    })
    .filter(Boolean);
  const userIds = new Set(usersById.keys());
  // Every write ships the whole document to the database and back, so what is
  // no longer needed is dropped here, on the one path every load takes.
  // Expired sessions and codes can never be used again; a notification older
  // than the retention window, or beyond the newest few dozen for its owner,
  // is off the bottom of an inbox nobody scrolls that far.
  const now = Date.now();
  normalized.sessions = normalized.sessions.filter(
    (session) => session && Date.parse(session.expiresAt) > now,
  );
  normalized.verificationCodes = normalized.verificationCodes.filter(
    (code) => code && Date.parse(code.expiresAt) > now,
  );
  const notificationCutoff = now - NOTIFICATION_RETENTION_MS;
  const keptPerUser = new Map();
  // An undated record cannot be judged stale, so it is kept.
  const notificationTime = (notification) => Date.parse(notification.createdAt) || now;
  normalized.notifications = normalized.notifications
    .filter(
      (notification) =>
        notification &&
        userIds.has(notification.userId) &&
        String(notification.id || "").trim() &&
        notificationTime(notification) > notificationCutoff,
    )
    // Newest first, so the cap keeps the recent ones.
    .sort((left, right) => notificationTime(right) - notificationTime(left))
    .filter((notification) => {
      const userId = String(notification.userId);
      const kept = (keptPerUser.get(userId) || 0) + 1;
      keptPerUser.set(userId, kept);
      return kept <= MAX_NOTIFICATIONS_PER_USER;
    })
    .reverse()
    .map((notification) => ({
      ...notification,
      id: String(notification.id),
      userId: String(notification.userId),
      type: String(notification.type || "notice").slice(0, 40),
      title: String(notification.title || "CampusPulse").slice(0, 120),
      body: String(notification.body || "").slice(0, 500),
      courseId: String(notification.courseId || ""),
      route: String(notification.route || "dashboard").slice(0, 80),
      data:
        notification.data &&
        !Array.isArray(notification.data) &&
        typeof notification.data === "object"
          ? Object.fromEntries(
              Object.entries(notification.data).map(([key, item]) => [
                String(key),
                String(item ?? ""),
              ]),
            )
          : {},
      createdAt: String(notification.createdAt || new Date(0).toISOString()),
      readAt: notification.readAt ? String(notification.readAt) : null,
    }));
  // One FCM registration token can only identify one current signed-in user.
  // When legacy data contains duplicates, keep the most recently seen record.
  const devicesByToken = new Map();
  normalized.pushDevices.forEach((device) => {
    const token = String(device?.token || "").trim();
    const userId = String(device?.userId || "");
    if (!token || token.length > 4096 || /\s/.test(token) || !userIds.has(userId)) return;
    const platform = ["android", "ios", "web"].includes(device.platform)
      ? device.platform
      : "android";
    devicesByToken.set(token, {
      ...device,
      token,
      userId,
      platform,
      sessionTokenHash: String(device.sessionTokenHash || ""),
      registeredAt: String(device.registeredAt || new Date(0).toISOString()),
      updatedAt: String(device.updatedAt || device.registeredAt || new Date(0).toISOString()),
    });
  });
  normalized.pushDevices = [...devicesByToken.values()];
  // One score per student per exam per course. Keeping the last write means a
  // corrected mark replaces the wrong one instead of sitting beside it.
  const marksByKey = new Map();
  normalized.courseMarks.forEach((mark) => {
    const courseId = String(mark?.courseId || "");
    const exam = String(mark?.exam || "");
    const rollNumber = String(mark?.rollNumber || "").trim().toUpperCase();
    const score = Number(mark?.score);
    if (!courseId || !exam || !rollNumber || !Number.isFinite(score) || score < 0) return;
    marksByKey.set(`${courseId}::${exam}::${rollNumber}`, {
      courseId,
      exam,
      rollNumber,
      score,
      updatedAt: String(mark.updatedAt || new Date(0).toISOString()),
      updatedBy: String(mark.updatedBy || ""),
    });
  });
  normalized.courseMarks = [...marksByKey.values()];
  // Built only if some session still needs the one-time legacy migration, so
  // an already-migrated database pays nothing for it.
  let rosterByCourse = null;
  function rosterFor(courseId) {
    if (!rosterByCourse) {
      rosterByCourse = new Map();
      normalized.courseStudents.forEach((student) => {
        const group = rosterByCourse.get(student.courseId);
        if (group) group.push(student);
        else rosterByCourse.set(student.courseId, [student]);
      });
    }
    return rosterByCourse.get(courseId) || [];
  }
  normalized.attendanceSessions = normalized.attendanceSessions.map((session) => {
    if (Array.isArray(session.records) && session.records.length) return session;
    const roster = rosterFor(session.courseId);
    if (!roster.length) {
      const { records: _unusableRecords, ...unmigratedSession } = session;
      return unmigratedSession;
    }
    const legacyPresentByName = new Map(
      (Array.isArray(session.present) ? session.present : []).map((entry) => {
        const user = usersById.get(entry.userId);
        return [String(user?.name || "").trim().toLowerCase(), entry];
      }),
    );
    const records = roster.map((student) => {
        const legacyEntry = legacyPresentByName.get(student.name.trim().toLowerCase());
        return {
          serial: student.serial,
          rollNumber: student.rollNumber,
          name: student.name,
          present: Boolean(legacyEntry),
          markedAt: legacyEntry?.checkedInAt || null,
          markedBy: legacyEntry ? "legacy-check-in" : null,
        };
      });
    return { ...session, records };
  });
  return normalized;
}

function clone(value) {
  // Measurably cheaper than a JSON round-trip on the whole shared document,
  // which every request clones.
  return value === undefined ? value : structuredClone(value);
}

/**
 * Turns a burst of concurrent writes into one load-mutate-save cycle.
 *
 * Every mutator used to pay for its own full read and full rewrite of the
 * shared document while everyone else waited, so a room signing in together
 * queued up until requests timed out. Mutators waiting at the same moment are
 * now applied to one loaded copy and persisted once.
 *
 * `runCycle(apply)` loads the document, awaits `apply(data)`, and persists it.
 * A mutator that throws aborts the cycle, so nothing it half-did can be
 * persisted; it is rejected on the spot and the cycle is rerun for the rest of
 * the batch without it. Only a failure of the cycle itself — the database, not
 * a mutator — falls back to replaying the batch one at a time.
 *
 * That distinction matters more than it looks. A check-in refused for a wrong
 * code or a far location throws from inside its mutator, and during a class
 * that is most of them. Discarding the whole batch and replaying it one at a
 * time on every such refusal turned one round-trip of the multi-megabyte
 * document into sixty, serialised, while the rest of the room waited — which
 * is what "the server can't handle the traffic" was.
 */
function createBatchingUpdater(runCycle, options = {}) {
  const maxBatch = Number(options.maxBatch || 64);
  let pending = [];
  let running = false;

  // Marks an error as coming from a mutator rather than from the cycle.
  class MutatorFailure extends Error {
    constructor(index, cause) {
      super("mutator failed");
      this.index = index;
      this.cause = cause;
    }
  }

  async function runBatch(batch) {
    let remaining = batch;
    while (remaining.length) {
      const entries = remaining;
      const results = new Array(entries.length);
      try {
        await runCycle(async (data) => {
          for (let index = 0; index < entries.length; index += 1) {
            try {
              results[index] = await entries[index].mutator(data);
            } catch (error) {
              throw new MutatorFailure(index, error);
            }
          }
          return null;
        }, entries.length);
      } catch (error) {
        if (!(error instanceof MutatorFailure)) throw error;
        entries[error.index].reject(error.cause);
        remaining = entries.filter((_, index) => index !== error.index);
        continue;
      }
      entries.forEach((entry, index) => entry.resolve(clone(results[index])));
      return;
    }
  }

  async function runIndividually(batch) {
    for (const entry of batch) {
      try {
        let result;
        await runCycle(async (data) => {
          result = await entry.mutator(data);
          return null;
        });
        entry.resolve(clone(result));
      } catch (error) {
        entry.reject(error);
      }
    }
  }

  async function drain() {
    running = true;
    try {
      while (pending.length) {
        const batch = pending.slice(0, maxBatch);
        pending = pending.slice(batch.length);
        if (batch.length === 1) {
          await runIndividually(batch);
          continue;
        }
        try {
          await runBatch(batch);
        } catch {
          await runIndividually(batch);
        }
      }
    } finally {
      running = false;
    }
  }

  return function update(mutator) {
    return new Promise((resolve, reject) => {
      pending.push({ mutator, resolve, reject });
      if (!running) {
        drain().catch((error) => {
          // `drain` settles each entry itself; reaching here means the loop
          // machinery failed, and silently stranding callers would be worse.
          pending.splice(0).forEach((entry) => entry.reject(error));
          running = false;
        });
      }
    });
  };
}

async function renameWithRetry(source, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(source, destination);
      return;
    } catch (error) {
      const retryable = ["EPERM", "EACCES", "EBUSY"].includes(error.code);
      if (!retryable || attempt >= 6) throw error;
      // Windows virus scanners can briefly hold a freshly written JSON file.
      // Preserve the atomic replacement and retry instead of deleting either file.
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}

function createStore(filePath, options = {}) {
  const absolutePath = path.resolve(filePath);
  const env = options.env || process.env;
  // The document last read from disk, reused while the file is untouched.
  let cache = null;
  let inFlightRead = null;

  async function fileStamp() {
    try {
      const stats = await fs.stat(absolutePath);
      return `${stats.mtimeMs}:${stats.size}`;
    } catch (error) {
      if (error.code === "ENOENT") return "absent";
      throw error;
    }
  }

  async function load() {
    try {
      const source = JSON.parse(await fs.readFile(absolutePath, "utf8"));
      const data = normalizeData(source, env);
      return {
        data,
        joinCodesMigrated: courseJoinCodesNeedPersistence(source, data),
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { data: initialData(env), joinCodesMigrated: false };
    }
  }

  async function save(data) {
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    const temporaryPath = `${absolutePath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(data, null, 2), "utf8");
    await renameWithRetry(temporaryPath, absolutePath);
  }

  async function readSnapshot() {
    const stamp = await fileStamp();
    if (cache && cache.stamp === stamp) return cache.data;
    const { data, joinCodesMigrated } = await load();
    // A read may be the first operation after upgrading. Persist generated
    // legacy TA codes immediately so they never change between requests.
    if (joinCodesMigrated) await save(data);
    cache = { data, stamp: await fileStamp() };
    return cache.data;
  }

  const runUpdates = createBatchingUpdater(async (apply) => {
    const { data } = await load();
    let applied = false;
    try {
      const outcome = await apply(data);
      applied = true;
      await save(data);
      cache = { data, stamp: await fileStamp() };
      return outcome;
    } catch (error) {
      // A mutator that threw changed nothing on disk, so what was cached is
      // still what is stored. Only a failed save leaves that in doubt.
      if (applied) cache = null;
      throw error;
    }
  });

  return {
    read() {
      // Concurrent callers share one load instead of each re-reading and
      // re-normalizing the whole file. Reads receive this shared snapshot by
      // reference: all writes load a separate document through `update`, and
      // avoiding one full clone per request keeps traffic bursts bounded.
      if (!inFlightRead) {
        inFlightRead = readSnapshot().finally(() => {
          inFlightRead = null;
        });
      }
      return inFlightRead;
    },
    update(mutator) {
      return runUpdates(mutator);
    },
    async readMaterialBlob(materialId) {
      const data = await readSnapshot();
      const material = (data.courseMaterials || []).find(
        (item) => item.id === String(materialId),
      );
      return material?.dataBase64 || null;
    },
    path: absolutePath,
  };
}

module.exports = {
  clone,
  courseJoinCodesNeedPersistence,
  configuredCourseOwners,
  createBatchingUpdater,
  createStore,
  initialData,
  normalizeCourseJoinCodes,
  normalizeData,
};
