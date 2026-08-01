const fs = require("node:fs/promises");
const path = require("node:path");
const { buildCourseData } = require("./course-data");

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
    schedule: [
      {
        id: "schedule-1",
        courseId: "soft401",
        day: "Monday",
        date: "3 Aug",
        start: "3:00 PM",
        end: "5:00 PM",
        topic: "Foundations of Soft Computing",
        room: "NR221",
      },
      {
        id: "schedule-2",
        courseId: "soft401",
        day: "Tuesday",
        date: "4 Aug",
        start: "2:00 PM",
        end: "4:00 PM",
        topic: "Fuzzy Sets & Membership",
        room: "NR221",
      },
    ],
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
  const managedCourseIds = new Set(defaults.courses.map((course) => course.id));
  const existingCourses = new Map(
    normalized.courses.map((course) => [course.id, course]),
  );
  normalized.courses = [
    ...defaults.courses.map((course) => {
      const existing = existingCourses.get(course.id);
      const merged = { ...existing, ...course };
      if (
        !course.joinCodeConfigured &&
        existing?.ownerId &&
        existing?.code &&
        !String(existing.code).startsWith("LOCKED-")
      ) {
        merged.code = existing.code;
        merged.joinCodeConfigured = true;
      }
      return existing?.rosterSource === "owner-upload"
        ? { ...merged, students: existing.students }
        : merged;
    }),
    ...normalized.courses.filter((course) => !managedCourseIds.has(course.id)),
  ];
  const ownerEmails = configuredCourseOwners(env);
  normalized.courses = normalized.courses.map((course) => {
    if (course.ownerId) return course;
    const ownerEmail = ownerEmails[course.id] || ownerEmails[course.courseCode];
    const owner = ownerEmail
      ? normalized.users.find(
          (user) =>
            user.role === "faculty" &&
            String(user.email || "").trim().toLowerCase() === ownerEmail,
        )
      : null;
    return owner ? { ...course, ownerId: owner.id } : course;
  });
  normalized.enrollments = normalized.enrollments
    .map((enrollment) => {
      const user = normalized.users.find((item) => item.id === enrollment.userId);
      const courseRole =
        enrollment.courseRole ||
        (user?.role === "student" || user?.role === "ta" ? user.role : null);
      return courseRole ? { ...enrollment, courseRole } : null;
    })
    .filter(Boolean);
  if (defaults.courseStudents.length) {
    const ownerManagedRosterIds = new Set(
      normalized.courses
        .filter((course) => course.rosterSource === "owner-upload")
        .map((course) => course.id),
    );
    normalized.courseStudents = [
      ...normalized.courseStudents.filter(
        (student) =>
          !managedCourseIds.has(student.courseId) ||
          ownerManagedRosterIds.has(student.courseId),
      ),
      ...defaults.courseStudents.filter(
        (student) => !ownerManagedRosterIds.has(student.courseId),
      ),
    ];
  }
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
  normalized.schedule = [
    ...normalized.schedule.filter((item) => item.courseId !== "soft401"),
    ...defaults.schedule,
  ];
  return normalized;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createStore(filePath, options = {}) {
  const absolutePath = path.resolve(filePath);
  const env = options.env || process.env;
  let queue = Promise.resolve();

  async function load() {
    try {
      return normalizeData(JSON.parse(await fs.readFile(absolutePath, "utf8")), env);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return initialData(env);
    }
  }

  async function save(data) {
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    const temporaryPath = `${absolutePath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(temporaryPath, absolutePath);
  }

  return {
    async read() {
      await queue;
      return clone(await load());
    },
    update(mutator) {
      const operation = queue.then(async () => {
        const data = await load();
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
  configuredCourseOwners,
  createStore,
  initialData,
  normalizeData,
};
