const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const COURSE_CONFIG = {
  MF41601: {
    id: "soft401",
    code: "SC401A",
    name: "Soft Computing",
    courseCode: "MF41601",
    section: "Autumn 2026-2027",
    room: "NR221",
    expectedStudents: 310,
  },
  ME60353: {
    id: "kbs60353",
    code: "KB60353",
    name: "Knowledge Based Systems in Engineering",
    courseCode: "ME60353",
    section: "Autumn 2026-2027",
    room: "Room TBA",
    expectedStudents: 22,
  },
};

function configuredJoinCodes(env = process.env) {
  const raw = String(env.COURSE_JOIN_CODES_JSON || "").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("COURSE_JOIN_CODES_JSON must be a JSON object");
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([course, code]) => [
      String(course).trim(),
      String(code).trim().toUpperCase(),
    ]),
  );
}

const lockedJoinCodes = new Map();

function lockedJoinCode(courseId) {
  if (!lockedJoinCodes.has(courseId)) {
    lockedJoinCodes.set(
      courseId,
      `LOCKED-${crypto.randomBytes(8).toString("hex").toUpperCase()}`,
    );
  }
  return lockedJoinCodes.get(courseId);
}

function loadSourceRosters(env = process.env) {
  if (env.COURSE_ROSTERS_JSON_BASE64) {
    return JSON.parse(
      Buffer.from(env.COURSE_ROSTERS_JSON_BASE64, "base64").toString("utf8"),
    );
  }
  if (env.COURSE_ROSTERS_JSON) return JSON.parse(env.COURSE_ROSTERS_JSON);

  const rosterPath = path.resolve(
    env.COURSE_ROSTERS_PATH || path.join(__dirname, "../data/course-rosters.json"),
  );
  try {
    return JSON.parse(fs.readFileSync(rosterPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function buildCourseData(env = process.env) {
  const sourceRosters = loadSourceRosters(env);
  const joinCodes = configuredJoinCodes(env);
  const courses = [];
  const courseStudents = [];
  const seenRollNumbers = new Set();

  for (const [courseCode, config] of Object.entries(COURSE_CONFIG)) {
    const source = sourceRosters.find((item) => item.courseCode === courseCode);
    const configuredCode = joinCodes[config.id] || joinCodes[config.courseCode];
    const production = String(env.NODE_ENV || "").toLowerCase() === "production";
    // An unconfigured course must never fall back to its published default code in
    // production, but it must not take the whole API down either: lock it with a
    // per-process random code until COURSE_JOIN_CODES_JSON is set.
    const usableCode =
      configuredCode && /^[A-Z0-9-]{6,32}$/.test(configuredCode) ? configuredCode : null;
    const joinCode =
      usableCode || (production ? lockedJoinCode(config.id) : config.code);
    if (source && source.students.length !== source.studentCount) {
      throw new Error(`Roster count mismatch for ${source.courseCode}`);
    }
    if (source && source.studentCount !== config.expectedStudents) {
      throw new Error(`Unexpected student count for ${source.courseCode}`);
    }
    if (source) source.students.forEach((student, index) => {
      const rollNumber = String(student.rollNumber || "").trim().toUpperCase();
      const name = String(student.name || "").trim();
      if (student.serial !== index + 1 || !rollNumber || !name) {
        throw new Error(`Invalid roster row ${index + 1} for ${source.courseCode}`);
      }
      if (seenRollNumbers.has(rollNumber)) {
        throw new Error(`Duplicate roster roll number ${rollNumber}`);
      }
      seenRollNumbers.add(rollNumber);
    });

    courses.push({
      id: config.id,
      code: joinCode,
      joinCodeConfigured: Boolean(configuredCode),
      name: config.name,
      courseCode: config.courseCode,
      section: config.section,
      room: config.room,
      students: config.expectedStudents,
    });
    if (source) courseStudents.push(
      ...source.students.map((student) => ({
        courseId: config.id,
        serial: student.serial,
        rollNumber: String(student.rollNumber).trim().toUpperCase(),
        name: String(student.name).trim(),
      })),
    );
  }

  return { courses, courseStudents };
}

module.exports = { buildCourseData, loadSourceRosters };
