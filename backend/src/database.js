const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { buildCourseData } = require("./course-data");

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
  normalized.enrollments = normalized.enrollments
    .map((enrollment) => {
      const user = normalized.users.find((item) => item.id === enrollment.userId);
      const courseRole =
        enrollment.courseRole ||
        (user?.role === "student" || user?.role === "ta" ? user.role : null);
      return courseRole ? { ...enrollment, courseRole } : null;
    })
    .filter(Boolean);
  const userIds = new Set(normalized.users.map((user) => user.id));
  normalized.notifications = normalized.notifications
    .filter(
      (notification) =>
        notification &&
        userIds.has(notification.userId) &&
        String(notification.id || "").trim(),
    )
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
  normalized.attendanceSessions = normalized.attendanceSessions.map((session) => {
    if (Array.isArray(session.records) && session.records.length) return session;
    const roster = normalized.courseStudents.filter(
      (student) => student.courseId === session.courseId,
    );
    if (!roster.length) {
      const { records: _unusableRecords, ...unmigratedSession } = session;
      return unmigratedSession;
    }
    const legacyPresentByName = new Map(
      (Array.isArray(session.present) ? session.present : []).map((entry) => {
        const user = normalized.users.find((item) => item.id === entry.userId);
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
  return JSON.parse(JSON.stringify(value));
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
  let queue = Promise.resolve();

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

  return {
    read() {
      const operation = queue.then(async () => {
        const { data, joinCodesMigrated } = await load();
        // A read may be the first operation after upgrading. Persist generated
        // legacy TA codes immediately so they never change between requests.
        if (joinCodesMigrated) await save(data);
        return clone(data);
      });
      queue = operation.catch(() => {});
      return operation;
    },
    update(mutator) {
      const operation = queue.then(async () => {
        const { data } = await load();
        const result = await mutator(data);
        await save(data);
        return clone(result);
      });
      queue = operation.catch(() => {});
      return operation;
    },
    path: absolutePath,
  };
}

module.exports = {
  courseJoinCodesNeedPersistence,
  configuredCourseOwners,
  createStore,
  initialData,
  normalizeCourseJoinCodes,
  normalizeData,
};
