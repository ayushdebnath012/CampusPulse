const express = require("express");
const path = require("node:path");
const { createStore } = require("./database");
const { createPostgresStore } = require("./postgres-database");
const { createMailer } = require("./mailer");
const { applyUserProfileOverride } = require("./profile-overrides");
const {
  hashPassword,
  verifyPassword,
  randomCode,
  randomToken,
  sha256,
} = require("./security");

const ROLES = new Set(["faculty", "ta", "student"]);
const TEN_MINUTES = 10 * 60 * 1000;
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

function cleanEmail(value = "") {
  return String(value).trim().toLowerCase();
}

function isCampusEmail(email) {
  const domain = cleanEmail(email).split("@")[1] || "";
  return domain === "iitkgp.ac.in" || domain.endsWith(".iitkgp.ac.in");
}

// Professors and staff use iitkgp.ac.in or a department subdomain such as
// mech.iitkgp.ac.in; kgpian.iitkgp.ac.in is the student domain.
function isFacultyEmail(email) {
  const domain = cleanEmail(email).split("@")[1] || "";
  if (domain === "kgpian.iitkgp.ac.in") return false;
  return domain === "iitkgp.ac.in" || domain.endsWith(".iitkgp.ac.in");
}

function publicUser(user) {
  return {
    id: user.id,
    role: user.role,
    name: user.name,
    email: user.email,
    department: user.department || "",
    verifiedAt: user.verifiedAt,
  };
}

function publicMaterial(material) {
  const { dataBase64: _dataBase64, ...metadata } = material;
  return metadata;
}

function uploadedFileName(value) {
  let decoded = String(value || "");
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep the literal header value when it was not URI encoded.
  }
  return decoded
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
    .slice(0, 160);
}

function courseRoster(database, courseId) {
  return database.courseStudents
    .filter((student) => student.courseId === courseId)
    .sort((left, right) => left.serial - right.serial);
}

function boundRollNumber(database, user, courseId) {
  const enrollment = database.enrollments.find(
    (item) => item.userId === user.id && item.courseId === courseId,
  );
  return enrollment?.rollNumber || "";
}

// A student's own row in a session, found by the roll number bound to their
// enrollment, falling back to a row they personally marked.
function ownRecord(database, user, session) {
  const rollNumber = boundRollNumber(database, user, session.courseId);
  if (rollNumber) {
    return session.records.find((item) => item.rollNumber === rollNumber) || null;
  }
  return session.records.find((item) => item.markedBy === user.id) || null;
}

// Real counters for the dashboard. A workspace with no history reports zeros
// rather than sample figures.
function workspaceStats(database, user, courses) {
  const courseIds = new Set(courses.map((course) => course.id));
  const closed = database.attendanceSessions.filter(
    (session) => courseIds.has(session.courseId) && session.status === "closed",
  );
  const student = user.role === "student";

  let attended = 0;
  let possible = 0;
  for (const session of closed) {
    const records = Array.isArray(session.records) ? session.records : [];
    if (student) {
      const rollNumber = boundRollNumber(database, user, session.courseId);
      const own = records.find((record) => record.rollNumber === rollNumber);
      if (own) {
        possible += 1;
        if (own.present) attended += 1;
      }
      continue;
    }
    attended += records.filter((record) => record.present).length;
    possible += records.length;
  }

  return {
    courses: courses.length,
    rosteredStudents: database.courseStudents.filter((item) =>
      courseIds.has(item.courseId),
    ).length,
    classesCompleted: closed.length,
    averageAttendance: possible ? Math.round((attended / possible) * 1000) / 10 : 0,
    quizzes: database.quizzes.filter(
      (quiz) => courseIds.has(quiz.courseId) && quiz.status !== "draft",
    ).length,
  };
}

// Course announcements: written by the team, plus an automatic line whenever
// something happens that students need to know about.
function addNotice(database, { courseId, kind, title, body = "", authorId, authorName }) {
  const notice = {
    id: `notice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    courseId,
    kind,
    title,
    body,
    authorId: authorId || "",
    authorName: authorName || "",
    createdAt: new Date().toISOString(),
  };
  database.courseNotices.push(notice);
  // Only the most recent announcements are worth keeping per course.
  const forCourse = database.courseNotices.filter((item) => item.courseId === courseId);
  if (forCourse.length > 100) {
    const cutoff = new Set(forCourse.slice(0, forCourse.length - 100).map((item) => item.id));
    database.courseNotices = database.courseNotices.filter((item) => !cutoff.has(item.id));
  }
  return notice;
}

function attendanceRecord(student) {
  return {
    serial: student.serial,
    rollNumber: student.rollNumber,
    name: student.name,
    present: false,
    markedAt: null,
    markedBy: null,
  };
}

function safeQuizForStudent(quiz, userId) {
  if (!quiz) return null;
  return {
    id: quiz.id,
    courseId: quiz.courseId,
    title: quiz.title,
    status: quiz.status,
    createdAt: quiz.createdAt,
    ...(quiz.day ? { day: quiz.day } : {}),
    ...(quiz.classLabel ? { classLabel: quiz.classLabel } : {}),
    timeLimitMinutes: quiz.timeLimitMinutes ?? 0,
    reveal: quiz.reveal || "after-quiz",
    ...(quiz.quizDate ? { quizDate: quiz.quizDate } : {}),
    questions: quiz.questions.map(({ answer, ...question }) => question),
    responded: quiz.responses.some((item) => item.userId === userId),
  };
}

function courseEnrollment(database, user, courseId) {
  return database.enrollments.find(
    (item) => item.userId === user.id && item.courseId === courseId,
  );
}

function isCourseOwner(user, course) {
  return user.role === "faculty" && course.ownerId === user.id;
}

function hasValidCourseOwner(database, course) {
  return database.users.some(
    (user) => user.id === course.ownerId && user.role === "faculty",
  );
}

function isEnrolledAssistant(database, user, courseId) {
  return user.role === "ta" && Boolean(courseEnrollment(database, user, courseId));
}

function canRunCourse(database, user, course) {
  return (
    isCourseOwner(user, course) ||
    (hasValidCourseOwner(database, course) &&
      isEnrolledAssistant(database, user, course.id))
  );
}

function accessibleCourses(database, user) {
  if (user.role === "faculty") {
    return database.courses.filter((course) => isCourseOwner(user, course));
  }
  const enrolledIds = new Set(
    database.enrollments
      .filter((item) => item.userId === user.id)
      .map((item) => item.courseId),
  );
  return database.courses.filter(
    (course) => enrolledIds.has(course.id) && hasValidCourseOwner(database, course),
  );
}

function publicCourse(database, user, course) {
  const enrollment = courseEnrollment(database, user, course.id);
  const owner = isCourseOwner(user, course);
  const assistant =
    hasValidCourseOwner(database, course) &&
    isEnrolledAssistant(database, user, course.id);
  const {
    ownerId: _ownerId,
    code,
    joinCodeConfigured: _joinCodeConfigured,
    ...metadata
  } = course;
  return {
    ...metadata,
    ...(owner ? { code } : {}),
    owned: owner,
    enrolled: Boolean(enrollment),
    rosterReady: courseRoster(database, course.id).length > 0,
    materialCount: database.courseMaterials.filter(
      (material) => material.courseId === course.id,
    ).length,
    capabilities: {
      canManageCourse: owner,
      canManageSchedule: owner || assistant,
      canManageRoster: owner || assistant,
      canViewAttendanceRoster: owner || assistant,
      canRunAttendance: owner || assistant,
      canPublishQuiz: owner || assistant,
      canUploadMaterials: owner || assistant,
    },
  };
}

function requireCourse(database, user, courseId, permission = "access") {
  const course = database.courses.find((item) => item.id === courseId);
  if (!course) {
    const error = new Error("Course not found");
    error.status = 404;
    throw error;
  }
  const allowed =
    permission === "owner"
      ? isCourseOwner(user, course)
      : permission === "run"
        ? canRunCourse(database, user, course)
        : accessibleCourses(database, user).some((item) => item.id === course.id);
  if (!allowed) {
    const error = new Error("You do not have access to this course");
    error.status = 403;
    throw error;
  }
  return course;
}

function createJoinCode(database) {
  let code;
  do {
    code = randomToken().replace(/[^a-z0-9]/gi, "").slice(0, 8).toUpperCase();
  } while (!code || database.courses.some((course) => course.code === code));
  return code;
}

function normalizeRosterUpload(students, courseId) {
  if (!Array.isArray(students) || !students.length || students.length > 500) {
    const error = new Error("Upload a roster containing 1–500 students");
    error.status = 400;
    throw error;
  }
  const seen = new Set();
  return students.map((student, index) => {
    const rollNumber = String(student.rollNumber || student.roll || "")
      .trim()
      .toUpperCase();
    const name = String(student.name || "").trim().replace(/\s+/g, " ");
    if (!rollNumber || rollNumber.length > 40 || name.length < 2 || name.length > 120) {
      const error = new Error(`Invalid roster entry at row ${index + 1}`);
      error.status = 400;
      throw error;
    }
    if (seen.has(rollNumber)) {
      const error = new Error(`Duplicate roll number at row ${index + 1}`);
      error.status = 400;
      throw error;
    }
    seen.add(rollNumber);
    return {
      courseId,
      serial: index + 1,
      rollNumber,
      name,
    };
  });
}

const QUIZ_TIME_LIMITS = [3, 5, 10, 0];
const QUIZ_REVEAL_MODES = ["after-quiz", "after-answer", "private"];

// Title, class, time limit and reveal mode are all required to commit a quiz.
function normalizeQuizSettings(body, { courseId, database }) {
  const title = String(body.title || "").trim().replace(/\s+/g, " ").slice(0, 100);
  if (title.length < 2) {
    const error = new Error("Give the quiz a title");
    error.status = 400;
    throw error;
  }
  const scheduleId = String(body.scheduleId || "").trim();
  const scheduled = database.schedule.find(
    (item) => item.id === scheduleId && item.courseId === courseId,
  );
  if (!scheduled) {
    const error = new Error("Choose which class this quiz is for");
    error.status = 400;
    throw error;
  }
  const timeLimitMinutes = Number(body.timeLimitMinutes);
  if (!QUIZ_TIME_LIMITS.includes(timeLimitMinutes)) {
    const error = new Error("Choose a time limit for the quiz");
    error.status = 400;
    throw error;
  }
  const reveal = String(body.reveal || "");
  if (!QUIZ_REVEAL_MODES.includes(reveal)) {
    const error = new Error("Choose when results are revealed");
    error.status = 400;
    throw error;
  }
  const quizDate = String(body.quizDate || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(quizDate) || Number.isNaN(Date.parse(quizDate))) {
    const error = new Error("Pick the date this quiz is for");
    error.status = 400;
    throw error;
  }
  // The date has to land on a day the course actually runs.
  const picked = new Date(`${quizDate}T12:00:00`);
  if (WEEKDAYS[(picked.getDay() + 6) % 7] !== scheduled.day) {
    const error = new Error(`${scheduled.day} is the day this class runs — pick a ${scheduled.day}`);
    error.status = 400;
    throw error;
  }
  return {
    title,
    scheduleId,
    day: scheduled.day,
    classLabel: String(body.classLabel || "").trim().slice(0, 120) || scheduled.day,
    quizDate,
    timeLimitMinutes,
    reveal,
  };
}

const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

function normalizeSchedule(classes, courseId, existingEntries = []) {
  if (!Array.isArray(classes) || classes.length > 60) {
    const error = new Error("Add up to 60 weekly classes");
    error.status = 400;
    throw error;
  }
  const existingIds = new Set(existingEntries.map((entry) => entry.id).filter(Boolean));
  const usedIds = new Set();
  return classes.map((entry, index) => {
    const dayInput = String(entry?.day || "").trim().toLowerCase();
    const day = dayInput.length >= 3
      ? WEEKDAYS.find((name) => name.toLowerCase().startsWith(dayInput.slice(0, 3)))
      : null;
    const start = String(entry?.start || "").trim().slice(0, 20);
    const end = String(entry?.end || "").trim().slice(0, 20);
    const topic = String(entry?.topic || "").trim().replace(/\s+/g, " ").slice(0, 120);
    const room = String(entry?.room || "").trim().slice(0, 80) || "Room TBA";
    const subtopicsInput = Array.isArray(entry?.subtopics)
      ? entry.subtopics
      : String(entry?.subtopics || entry?.subclasses || "")
          .split(/\r?\n|,/);
    const subtopics = subtopicsInput
      .map((item) => String(item || "").trim().replace(/\s+/g, " ").slice(0, 120))
      .filter(Boolean);
    if (subtopics.length > 20) {
      const error = new Error(`Class ${index + 1} can have up to 20 sub-classes`);
      error.status = 400;
      throw error;
    }
    if (!day || !start) {
      const error = new Error(`Class ${index + 1} needs a weekday and a start time`);
      error.status = 400;
      throw error;
    }
    const requestedId = String(entry?.id || "").trim();
    const positionalId = String(existingEntries[index]?.id || "").trim();
    let id = existingIds.has(requestedId) && !usedIds.has(requestedId)
      ? requestedId
      : existingIds.has(positionalId) && !usedIds.has(positionalId)
        ? positionalId
        : "";
    let sequence = index + 1;
    while (!id || usedIds.has(id)) {
      const candidate = `schedule-${courseId}-${sequence}`;
      sequence += 1;
      if (!existingIds.has(candidate) && !usedIds.has(candidate)) id = candidate;
    }
    usedIds.add(id);
    return {
      id,
      courseId,
      day,
      date: "",
      start,
      end,
      topic,
      room,
      subtopics,
    };
  });
}

function normalizeQuizQuestions(input) {
  if (!Array.isArray(input) || !input.length || input.length > 10) {
    const error = new Error("Add 1–10 quiz questions");
    error.status = 400;
    throw error;
  }
  return input.map((question, index) => {
    const text = String(question?.text || question?.question || question?.prompt || "")
      .trim()
      .replace(/\s+/g, " ");
    const options = Array.isArray(question?.options)
      ? question.options.map((option) => String(option || "").trim())
      : [];
    const answer = Number(question?.answer);
    const image = String(question?.image || "").trim();
    // Images ride along as data URLs; anything else could point off-site.
    if (image && !/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) {
      const error = new Error(`Question ${index + 1} has an unsupported image`);
      error.status = 400;
      throw error;
    }
    if (image.length > 900000) {
      const error = new Error(`The image on question ${index + 1} is too large`);
      error.status = 413;
      throw error;
    }
    if (
      (text.length < 2 && !image) ||
      text.length > 500 ||
      options.length < 2 ||
      options.length > 6 ||
      options.some((option) => !option || option.length > 200) ||
      !Number.isInteger(answer) ||
      answer < 0 ||
      answer >= options.length
    ) {
      const error = new Error(`Invalid quiz question at row ${index + 1}`);
      error.status = 400;
      throw error;
    }
    return { text, options, answer, ...(image ? { image } : {}) };
  });
}

function createApp(options = {}) {
  const env = options.env || process.env;
  const databasePath =
    options.databasePath ||
    env.DATABASE_PATH ||
    path.resolve(__dirname, "../data/campuspulse.json");
  const store =
    options.store ||
    (env.DATABASE_URL
      ? createPostgresStore(env.DATABASE_URL, {
          ssl: String(env.DATABASE_SSL || "").toLowerCase() === "true",
          env,
        })
      : createStore(databasePath, { env }));
  const mailer = options.mailer || createMailer(env);
  const allowDevVerificationCode =
    String(env.NODE_ENV || "").toLowerCase() !== "production" &&
    String(env.ALLOW_DEV_VERIFICATION_CODE || "").toLowerCase() === "true";
  const app = express();

  const allowedOrigins = new Set(
    String(
      env.ALLOWED_ORIGINS ||
        "https://ayushdebnath012.github.io,https://localhost,capacitor://localhost,http://localhost,http://127.0.0.1:4173",
    )
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );

  app.disable("x-powered-by");
  app.use((request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    const origin = request.headers.origin;
    if (origin && (allowedOrigins.has(origin) || allowedOrigins.has("*"))) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
      response.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, X-File-Name",
      );
      response.setHeader(
        "Access-Control-Allow-Methods",
        "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      );
    }
    if (request.method === "OPTIONS") return response.sendStatus(204);
    next();
  });
  const jsonParser = express.json({ limit: "128kb" });
  app.use((request, response, next) => {
    const materialUpload =
      request.method === "POST" &&
      /^\/api\/courses\/[^/]+\/materials$/.test(request.path);
    return materialUpload ? next() : jsonParser(request, response, next);
  });
  app.use("/api", (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });

  async function authenticate(request, response, next) {
    try {
      const token = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
      if (!token) return response.status(401).json({ error: "Authentication required" });
      const data = await store.read();
      const now = Date.now();
      const session = data.sessions.find(
        (item) => item.tokenHash === sha256(token) && Date.parse(item.expiresAt) > now,
      );
      const user = session && data.users.find((item) => item.id === session.userId);
      if (!user) return response.status(401).json({ error: "Session expired" });
      request.user = user;
      request.sessionTokenHash = session.tokenHash;
      next();
    } catch (error) {
      next(error);
    }
  }

  function requireRoles(...roles) {
    return (request, response, next) =>
      roles.includes(request.user.role)
        ? next()
        : response.status(403).json({ error: "You do not have permission for this action" });
  }

  app.get("/api/health", async (_request, response, next) => {
    try {
      const production = String(env.NODE_ENV || "").toLowerCase() === "production";
      const warnings = production
        ? [
            "TA_SIGNUP_CODE",
          ].filter((key) => !String(env[key] || "").trim())
        : [];
      const data = await store.read();
      response.json({
        ok: true,
        service: "campuspulse-api",
        version: "1.3.0",
        otpRequired: false,
        emailDelivery:
          mailer.provider || (mailer.configured ? "configured" : "disabled"),
        courses: data.courses.length,
        coursesAwaitingRollList: data.courses.filter(
          (course) => !courseRoster(data, course.id).length,
        ).length,
        ...(warnings.length ? { configurationWarnings: warnings } : {}),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/signup", async (request, response, next) => {
    try {
      const role = String(request.body.role || "");
      const name = String(request.body.name || "").trim().replace(/\s+/g, " ");
      const department = String(request.body.department || "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 120);
      const email = cleanEmail(request.body.email);
      const password = String(request.body.password || "");
      if (!ROLES.has(role)) return response.status(400).json({ error: "Invalid role" });
      if (name.length < 2 || name.length > 80)
        return response.status(400).json({ error: "Enter a valid full name" });
      if (department.length < 2)
        return response.status(400).json({ error: "Enter your department name" });
      if (!isCampusEmail(email))
        return response.status(400).json({ error: "Use an IIT KGP institutional email" });
      if (role === "faculty" && !isFacultyEmail(email))
        return response.status(400).json({
          error: "Professor accounts require an @iitkgp.ac.in email",
        });
      if (password.length < 8 || password.length > 128)
        return response.status(400).json({ error: "Password must contain 8–128 characters" });
      if (
        role === "ta" &&
        (!env.TA_SIGNUP_CODE || request.body.roleCode !== env.TA_SIGNUP_CODE)
      )
        return response.status(403).json({
          error: "TA accounts must be provisioned with a valid invitation code",
        });

      // Everyone gives a phone number. Roll number and hall of residence apply
      // to students and TAs, not to professors.
      const phone = String(request.body.phone || "").trim();
      if (!/^\+?[0-9][0-9\s()-]{6,19}$/.test(phone)) {
        return response.status(400).json({ error: "Enter a valid contact number" });
      }
      const rollNumber =
        role === "faculty"
          ? ""
          : String(request.body.rollNumber || "").trim().toUpperCase();
      const hall =
        role === "faculty" ? "" : String(request.body.hall || "").trim().slice(0, 80);
      if (role !== "faculty") {
        if (!rollNumber || rollNumber.length > 40) {
          return response.status(400).json({ error: "Enter your roll number" });
        }
        if (hall.length < 2) {
          return response.status(400).json({ error: "Enter your hall of residence" });
        }
      }

      const passwordHash = await hashPassword(password);
      const token = randomToken();
      const result = await store.update((database) => {
        if (database.users.some((user) => user.email === email)) {
          return { error: "An account already exists for this email", status: 409 };
        }
        if (
          rollNumber &&
          database.users.some((user) => user.rollNumber === rollNumber)
        ) {
          return {
            error: "An account already exists for this roll number",
            status: 409,
          };
        }
        const now = new Date().toISOString();
        const created = applyUserProfileOverride({
          id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role,
          name,
          email,
          department,
          phone,
          ...(rollNumber ? { rollNumber } : {}),
          ...(hall ? { hall } : {}),
          passwordHash,
          createdAt: now,
          verifiedAt: null,
        }, env);
        database.users.push(created);
        database.sessions = database.sessions.filter(
          (item) => Date.parse(item.expiresAt) > Date.now(),
        );
        database.sessions.push({
          tokenHash: sha256(token),
          userId: created.id,
          createdAt: now,
          expiresAt: new Date(Date.now() + THIRTY_DAYS).toISOString(),
        });
        return { user: created };
      });
      if (result.error) return response.status(result.status).json({ error: result.error });
      response.status(201).json({ token, user: publicUser(result.user) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/signup/request", async (request, response, next) => {
    try {
      const role = String(request.body.role || "");
      const name = String(request.body.name || "").trim().replace(/\s+/g, " ");
      const department = String(request.body.department || "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 120);
      const email = cleanEmail(request.body.email);
      const password = String(request.body.password || "");
      if (!ROLES.has(role)) return response.status(400).json({ error: "Invalid role" });
      if (name.length < 2 || name.length > 80)
        return response.status(400).json({ error: "Enter a valid full name" });
      if (department.length < 2)
        return response.status(400).json({ error: "Enter your department name" });
      if (!isCampusEmail(email))
        return response.status(400).json({ error: "Use an IIT KGP institutional email" });
      if (password.length < 8 || password.length > 128)
        return response.status(400).json({ error: "Password must contain 8–128 characters" });
      if (
        role === "ta" &&
        (!env.TA_SIGNUP_CODE ||
        request.body.roleCode !== env.TA_SIGNUP_CODE
        )
      )
        return response.status(403).json({
          error: "TA accounts must be provisioned with a valid invitation code",
        });

      const data = await store.read();
      if (data.users.some((user) => user.email === email))
        return response.status(409).json({ error: "An account already exists for this email" });
      if (!mailer.configured && !allowDevVerificationCode) {
        return response.status(503).json({
          error: "Verification email delivery is temporarily unavailable",
        });
      }

      const code = randomCode();
      const passwordHash = await hashPassword(password);
      const expiresAt = new Date(Date.now() + TEN_MINUTES).toISOString();
      await store.update((database) => {
        database.verificationCodes = database.verificationCodes.filter(
          (item) => item.email !== email && Date.parse(item.expiresAt) > Date.now(),
        );
        database.verificationCodes.push({
          email,
          role,
          name,
          department,
          passwordHash,
          codeHash: sha256(code),
          expiresAt,
          attempts: 0,
        });
        return null;
      });
      const delivery = await mailer.sendVerification({ email, name, code });
      const payload = { ok: true, expiresInSeconds: TEN_MINUTES / 1000 };
      if (!delivery.delivered && allowDevVerificationCode) {
        payload.devCode = delivery.previewCode;
      }
      response.status(202).json(payload);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/signup/verify", async (request, response, next) => {
    try {
      const email = cleanEmail(request.body.email);
      const codeHash = sha256(String(request.body.code || ""));
      const result = await store.update((database) => {
        const record = database.verificationCodes.find((item) => item.email === email);
        if (!record || Date.parse(record.expiresAt) <= Date.now()) {
          database.verificationCodes = database.verificationCodes.filter(
            (item) => item.email !== email,
          );
          return { error: "Verification code expired", status: 400 };
        }
        record.attempts += 1;
        if (record.attempts > 5 || record.codeHash !== codeHash) {
          return {
            error:
              record.attempts > 5
                ? "Too many verification attempts"
                : "Incorrect verification code",
            status: 400,
          };
        }
        if (database.users.some((item) => item.email === email)) {
          return { error: "Account already exists", status: 409 };
        }
        const created = applyUserProfileOverride({
          id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: record.role,
          name: record.name,
          email: record.email,
          department: record.department || "",
          passwordHash: record.passwordHash,
          verifiedAt: new Date().toISOString(),
        }, env);
        database.users.push(created);
        database.verificationCodes = database.verificationCodes.filter(
          (item) => item.email !== email,
        );
        return { user: created };
      });
      if (result.error) return response.status(result.status).json({ error: result.error });
      response.status(201).json({ ok: true, user: publicUser(result.user) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/signup/resend", async (request, response, next) => {
    try {
      const email = cleanEmail(request.body.email);
      if (!mailer.configured && !allowDevVerificationCode) {
        return response.status(503).json({
          error: "Verification email delivery is temporarily unavailable",
        });
      }
      const code = randomCode();
      const record = await store.update((database) => {
        const pending = database.verificationCodes.find((item) => item.email === email);
        if (!pending) return null;
        pending.codeHash = sha256(code);
        pending.expiresAt = new Date(Date.now() + TEN_MINUTES).toISOString();
        pending.attempts = 0;
        return { email: pending.email, name: pending.name };
      });
      if (!record)
        return response.status(404).json({ error: "No pending sign-up for this email" });
      const delivery = await mailer.sendVerification({ ...record, code });
      const payload = { ok: true, expiresInSeconds: TEN_MINUTES / 1000 };
      if (!delivery.delivered && allowDevVerificationCode) {
        payload.devCode = delivery.previewCode;
      }
      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/login", async (request, response, next) => {
    try {
      const email = cleanEmail(request.body.email);
      const role = String(request.body.role || "");
      const password = String(request.body.password || "");
      const data = await store.read();
      const user = data.users.find((item) => item.email === email && item.role === role);
      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        return response.status(401).json({ error: "Incorrect email, password, or role" });
      }
      const token = randomToken();
      await store.update((database) => {
        database.sessions = database.sessions.filter(
          (item) => Date.parse(item.expiresAt) > Date.now() && item.userId !== user.id,
        );
        database.sessions.push({
          tokenHash: sha256(token),
          userId: user.id,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + THIRTY_DAYS).toISOString(),
        });
        return null;
      });
      response.json({ token, user: publicUser(user) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/password", authenticate, async (request, response, next) => {
    try {
      const currentPassword = String(request.body.currentPassword || "");
      const newPassword = String(request.body.newPassword || "");
      if (newPassword.length < 8 || newPassword.length > 128) {
        return response
          .status(400)
          .json({ error: "Password must contain 8–128 characters" });
      }
      if (!(await verifyPassword(currentPassword, request.user.passwordHash))) {
        return response.status(403).json({ error: "Your current password is incorrect" });
      }
      const passwordHash = await hashPassword(newPassword);
      await store.update((database) => {
        const user = database.users.find((item) => item.id === request.user.id);
        if (user) user.passwordHash = passwordHash;
        // Every other device is signed out; this session stays valid.
        database.sessions = database.sessions.filter(
          (item) =>
            item.userId !== request.user.id ||
            item.tokenHash === request.sessionTokenHash,
        );
        return null;
      });
      response.json({ updated: true });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/password/forgot", async (request, response, next) => {
    try {
      const email = cleanEmail(request.body.email);
      if (!mailer.configured) {
        return response.status(503).json({
          error:
            "Password reset email is unavailable. Ask your professor to reset it for you.",
        });
      }
      const data = await store.read();
      const user = data.users.find((item) => item.email === email);
      // Answer the same way whether or not the address is registered.
      if (!user) return response.status(202).json({ sent: true });

      const code = randomCode();
      await store.update((database) => {
        database.verificationCodes = database.verificationCodes.filter(
          (item) =>
            !(item.email === email && item.purpose === "password-reset") &&
            Date.parse(item.expiresAt) > Date.now(),
        );
        database.verificationCodes.push({
          email,
          purpose: "password-reset",
          codeHash: sha256(code),
          expiresAt: new Date(Date.now() + TEN_MINUTES).toISOString(),
          attempts: 0,
        });
        return null;
      });
      await mailer.sendPasswordReset({ email, name: user.name, code });
      response.status(202).json({ sent: true });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/password/reset", async (request, response, next) => {
    try {
      const email = cleanEmail(request.body.email);
      const codeHash = sha256(String(request.body.code || "").trim());
      const newPassword = String(request.body.newPassword || "");
      if (newPassword.length < 8 || newPassword.length > 128) {
        return response
          .status(400)
          .json({ error: "Password must contain 8–128 characters" });
      }
      const passwordHash = await hashPassword(newPassword);
      const result = await store.update((database) => {
        const record = database.verificationCodes.find(
          (item) => item.email === email && item.purpose === "password-reset",
        );
        if (!record || Date.parse(record.expiresAt) < Date.now()) {
          return { error: "That reset code has expired", status: 400 };
        }
        record.attempts = (record.attempts || 0) + 1;
        if (record.attempts > 5 || record.codeHash !== codeHash) {
          if (record.attempts > 5) {
            database.verificationCodes = database.verificationCodes.filter(
              (item) => item !== record,
            );
          }
          return {
            error: record.attempts > 5 ? "Too many attempts" : "Incorrect reset code",
            status: 400,
          };
        }
        const user = database.users.find((item) => item.email === email);
        if (!user) return { error: "That reset code has expired", status: 400 };
        user.passwordHash = passwordHash;
        database.verificationCodes = database.verificationCodes.filter(
          (item) => item !== record,
        );
        database.sessions = database.sessions.filter(
          (item) => item.userId !== user.id,
        );
        return { ok: true };
      });
      if (result.error) {
        return response.status(result.status).json({ error: result.error });
      }
      response.json({ updated: true });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/logout", authenticate, async (request, response, next) => {
    try {
      await store.update((database) => {
        database.sessions = database.sessions.filter(
          (item) => item.tokenHash !== request.sessionTokenHash,
        );
        return null;
      });
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/me", authenticate, (request, response) => {
    response.json({ user: publicUser(request.user) });
  });

  app.delete("/api/account", authenticate, async (request, response, next) => {
    try {
      const userId = request.user.id;
      const email = request.user.email;
      await store.update((database) => {
        if (database.courses.some((course) => course.ownerId === userId)) {
          const error = new Error(
            "Transfer or remove your owned courses before deleting this account",
          );
          error.status = 409;
          throw error;
        }
        database.users = database.users.filter((item) => item.id !== userId);
        database.sessions = database.sessions.filter(
          (item) => item.userId !== userId,
        );
        database.enrollments = database.enrollments.filter(
          (item) => item.userId !== userId,
        );
        database.verificationCodes = database.verificationCodes.filter(
          (item) => item.email !== email,
        );
        database.attendanceSessions.forEach((session) => {
          if (Array.isArray(session.present)) {
            session.present = session.present.filter(
              (item) => item.userId !== userId,
            );
          }
          if (Array.isArray(session.records)) {
            session.records.forEach((record) => {
              if (record.markedBy === userId) record.markedBy = "deleted-user";
            });
          }
          if (session.startedBy === userId) session.startedBy = "deleted-user";
          if (session.closedBy === userId) session.closedBy = "deleted-user";
        });
        database.quizzes.forEach((quiz) => {
          quiz.responses = quiz.responses.filter(
            (item) => item.userId !== userId,
          );
          if (quiz.createdBy === userId) quiz.createdBy = "deleted-user";
        });
        return null;
      });
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/bootstrap", authenticate, async (request, response, next) => {
    try {
      const data = await store.read();
      const courses = accessibleCourses(data, request.user);
      const courseIds = new Set(courses.map((course) => course.id));
      const enrolledCourseIds = data.enrollments
        .filter((item) => item.userId === request.user.id)
        .map((item) => item.courseId);
      const currentQuiz = [...data.quizzes]
        .reverse()
        .find((item) => item.status === "open" && courseIds.has(item.courseId));
      const courseById = new Map(courses.map((course) => [course.id, course]));
      const teachingAssistants = data.enrollments
        .filter(
          (item) => courseIds.has(item.courseId) && item.courseRole === "ta",
        )
        .map((item) => {
          const user = data.users.find((person) => person.id === item.userId);
          const course = courseById.get(item.courseId);
          if (!user || !course) return null;
          return {
            userId: user.id,
            name: user.name,
            email: user.email,
            department: user.department || "",
            courseId: course.id,
            courseCode: course.courseCode,
            courseName: course.name,
            joinedAt: item.joinedAt || null,
          };
        })
        .filter(Boolean)
        .sort(
          (left, right) =>
            left.courseCode.localeCompare(right.courseCode) ||
            left.name.localeCompare(right.name),
        );
      response.json({
        user: publicUser(request.user),
        courses: courses.map((course) => publicCourse(data, request.user, course)),
        enrolledCourseIds,
        schedule: data.schedule.filter((item) => courseIds.has(item.courseId)),
        teachingAssistants,
        quiz:
          request.user.role === "student"
            ? safeQuizForStudent(currentQuiz, request.user.id)
            : currentQuiz || null,
        stats: workspaceStats(data, request.user, courses),
        statsByCourse: Object.fromEntries(
          courses.map((course) => [
            course.id,
            workspaceStats(data, request.user, [course]),
          ]),
        ),
      });
    } catch (error) {
      next(error);
    }
  });

  // Everyone who actually signed up and joined, as opposed to the roll list.
  app.get(
    "/api/students",
    authenticate,
    requireRoles("faculty", "ta"),
    async (request, response, next) => {
      try {
        const data = await store.read();
        const courses = accessibleCourses(data, request.user);
        const byId = new Map(courses.map((course) => [course.id, course]));
        const students = data.enrollments
          .filter((item) => byId.has(item.courseId))
          .map((item) => {
            const user = data.users.find((person) => person.id === item.userId);
            if (!user) return null;
            if ((item.courseRole || user.role) !== "student") return null;
            const course = byId.get(item.courseId);
            return {
              userId: user.id,
              name: user.name,
              email: user.email,
              role: item.courseRole || user.role,
              rollNumber: item.rollNumber || user.rollNumber || "",
              department: user.department || "",
              phone: user.phone || "",
              hall: user.hall || "",
              courseId: course.id,
              courseCode: course.courseCode,
              courseName: course.name,
              joinedAt: item.joinedAt || null,
            };
          })
          .filter(Boolean)
          .sort(
            (left, right) =>
              left.courseCode.localeCompare(right.courseCode) ||
              left.rollNumber.localeCompare(right.rollNumber) ||
              left.name.localeCompare(right.name),
          );
        response.json({ students });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get("/api/courses", authenticate, async (request, response, next) => {
    try {
      const data = await store.read();
      response.json({
        courses: accessibleCourses(data, request.user).map((course) =>
          publicCourse(data, request.user, course),
        ),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/courses",
    authenticate,
    requireRoles("faculty"),
    async (request, response, next) => {
      try {
        const name = String(request.body.name || "").trim().replace(/\s+/g, " ");
        const courseCode = String(request.body.courseCode || "")
          .trim()
          .toUpperCase()
          .replace(/\s+/g, " ");
        const section = String(request.body.section || "").trim().slice(0, 80);
        const room = String(request.body.room || "Room TBA").trim().slice(0, 80);
        if (
          name.length < 2 ||
          name.length > 120 ||
          courseCode.length < 2 ||
          courseCode.length > 30
        ) {
          return response
            .status(400)
            .json({ error: "Enter a valid course name and code" });
        }
        const course = await store.update((database) => {
          if (
            database.courses.some(
              (item) => item.courseCode.toUpperCase() === courseCode,
            )
          ) {
            const error = new Error("A course with this code already exists");
            error.status = 409;
            throw error;
          }
          const created = {
            id: `course-${Date.now()}-${randomToken().slice(0, 6)}`,
            code: createJoinCode(database),
            name,
            courseCode,
            section: section || "Current term",
            room: room || "Room TBA",
            students: 0,
            ownerId: request.user.id,
            createdAt: new Date().toISOString(),
          };
          database.courses.push(created);
          return publicCourse(database, request.user, created);
        });
        response.status(201).json({ course });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/api/courses/:id/roster",
    authenticate,
    requireRoles("faculty", "ta"),
    async (request, response, next) => {
      try {
        const data = await store.read();
        const course = requireCourse(data, request.user, request.params.id, "run");
        response.json({
          course: publicCourse(data, request.user, course),
          students: courseRoster(data, course.id),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.put(
    "/api/courses/:id/roster",
    authenticate,
    requireRoles("faculty", "ta"),
    async (request, response, next) => {
      try {
        const result = await store.update((database) => {
          const course = requireCourse(
            database,
            request.user,
            request.params.id,
            "run",
          );
          const students = normalizeRosterUpload(request.body.students, course.id);
          database.courseStudents = [
            ...database.courseStudents.filter(
              (student) => student.courseId !== course.id,
            ),
            ...students,
          ];
          course.students = students.length;
          course.rosterSource = "owner-upload";
          course.rosterUpdatedAt = new Date().toISOString();
          return {
            course: publicCourse(database, request.user, course),
            students,
          };
        });
        response.json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  app.patch(
    "/api/courses/:id",
    authenticate,
    requireRoles("faculty"),
    async (request, response, next) => {
      try {
        const course = await store.update((database) => {
          const existing = requireCourse(
            database,
            request.user,
            request.params.id,
            "owner",
          );
          const name = String(request.body.name ?? existing.name)
            .trim()
            .replace(/\s+/g, " ");
          const courseCode = String(request.body.courseCode ?? existing.courseCode)
            .trim()
            .toUpperCase()
            .replace(/\s+/g, " ");
          if (
            name.length < 2 ||
            name.length > 120 ||
            courseCode.length < 2 ||
            courseCode.length > 30
          ) {
            const error = new Error("Enter a valid course name and code");
            error.status = 400;
            throw error;
          }
          if (
            database.courses.some(
              (item) =>
                item.id !== existing.id &&
                String(item.courseCode || "").toUpperCase() === courseCode,
            )
          ) {
            const error = new Error("A course with this code already exists");
            error.status = 409;
            throw error;
          }
          existing.name = name;
          existing.courseCode = courseCode;
          existing.section = String(request.body.section ?? existing.section)
            .trim()
            .slice(0, 80);
          existing.room =
            String(request.body.room ?? existing.room).trim().slice(0, 80) ||
            "Room TBA";
          // The join code is deliberately untouched: students and TAs have it.
          return publicCourse(database, request.user, existing);
        });
        response.json({ course });
      } catch (error) {
        next(error);
      }
    },
  );

  app.delete(
    "/api/courses/:id",
    authenticate,
    requireRoles("faculty"),
    async (request, response, next) => {
      try {
        const removed = await store.update((database) => {
          const course = requireCourse(
            database,
            request.user,
            request.params.id,
            "owner",
          );
          const courseId = course.id;
          const summary = {
            id: courseId,
            courseCode: course.courseCode,
            students: database.courseStudents.filter(
              (item) => item.courseId === courseId,
            ).length,
            enrolments: database.enrollments.filter(
              (item) => item.courseId === courseId,
            ).length,
          };
          // A course takes its roll list, enrolments, files, timetable,
          // attendance history and quizzes with it.
          database.courses = database.courses.filter((item) => item.id !== courseId);
          database.courseStudents = database.courseStudents.filter(
            (item) => item.courseId !== courseId,
          );
          database.enrollments = database.enrollments.filter(
            (item) => item.courseId !== courseId,
          );
          database.courseMaterials = database.courseMaterials.filter(
            (item) => item.courseId !== courseId,
          );
          database.schedule = database.schedule.filter(
            (item) => item.courseId !== courseId,
          );
          database.attendanceSessions = database.attendanceSessions.filter(
            (item) => item.courseId !== courseId,
          );
          database.quizzes = database.quizzes.filter(
            (item) => item.courseId !== courseId,
          );
          return summary;
        });
        response.json({ removed });
      } catch (error) {
        next(error);
      }
    },
  );

  app.put(
    "/api/courses/:id/schedule",
    authenticate,
    requireRoles("faculty", "ta"),
    async (request, response, next) => {
      try {
        const result = await store.update((database) => {
          const course = requireCourse(
            database,
            request.user,
            request.params.id,
            "run",
          );
          const currentRevision = Number(course.scheduleRevision) || 0;
          if (
            !Number.isInteger(request.body.revision) ||
            request.body.revision !== currentRevision
          ) {
            const error = new Error(
              "The timetable changed on another device. Refresh it before saving.",
            );
            error.status = 409;
            throw error;
          }
          const existingEntries = database.schedule.filter(
            (item) => item.courseId === course.id,
          );
          const entries = normalizeSchedule(
            request.body.classes,
            course.id,
            existingEntries,
          );
          database.schedule = [
            ...database.schedule.filter((item) => item.courseId !== course.id),
            ...entries,
          ];
          course.scheduleRevision = currentRevision + 1;
          return {
            schedule: entries,
            revision: course.scheduleRevision,
          };
        });
        response.json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/courses/:id/roster",
    authenticate,
    requireRoles("faculty", "ta"),
    async (request, response, next) => {
      try {
        const result = await store.update((database) => {
          const course = requireCourse(
            database,
            request.user,
            request.params.id,
            "run",
          );
          const rollNumber = String(request.body.rollNumber || "")
            .trim()
            .toUpperCase();
          const name = String(request.body.name || "").trim().replace(/\s+/g, " ");
          if (!rollNumber || rollNumber.length > 40 || name.length < 2 || name.length > 120) {
            const error = new Error("Enter a valid roll number and name");
            error.status = 400;
            throw error;
          }
          const roster = courseRoster(database, course.id);
          if (roster.some((student) => student.rollNumber === rollNumber)) {
            const error = new Error("That roll number is already on this roll list");
            error.status = 409;
            throw error;
          }
          const added = {
            courseId: course.id,
            serial: roster.length + 1,
            rollNumber,
            name,
          };
          database.courseStudents.push(added);
          // An open session was snapshotted before this student existed.
          database.attendanceSessions.forEach((session) => {
            if (session.courseId === course.id && session.status === "open") {
              session.records.push(attendanceRecord(added));
            }
          });
          course.students = roster.length + 1;
          course.rosterUpdatedAt = new Date().toISOString();
          return {
            course: publicCourse(database, request.user, course),
            students: courseRoster(database, course.id),
          };
        });
        response.status(201).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  app.delete(
    "/api/courses/:id/roster/:rollNumber",
    authenticate,
    requireRoles("faculty", "ta"),
    async (request, response, next) => {
      try {
        const result = await store.update((database) => {
          const course = requireCourse(
            database,
            request.user,
            request.params.id,
            "run",
          );
          const rollNumber = String(request.params.rollNumber || "")
            .trim()
            .toUpperCase();
          const present = database.courseStudents.some(
            (student) =>
              student.courseId === course.id && student.rollNumber === rollNumber,
          );
          if (!present) {
            const error = new Error("That roll number is not on this roll list");
            error.status = 404;
            throw error;
          }
          database.courseStudents = database.courseStudents.filter(
            (student) =>
              !(student.courseId === course.id && student.rollNumber === rollNumber),
          );
          // Keep the printed order contiguous after the gap.
          courseRoster(database, course.id).forEach((student, index) => {
            student.serial = index + 1;
          });
          // Removing a student withdraws their admission to the course.
          database.enrollments = database.enrollments.filter(
            (item) =>
              !(item.courseId === course.id && item.rollNumber === rollNumber),
          );
          // Closed sessions stay as they were recorded on the day.
          database.attendanceSessions.forEach((session) => {
            if (session.courseId === course.id && session.status === "open") {
              session.records = session.records.filter(
                (record) => record.rollNumber !== rollNumber,
              );
            }
          });
          const students = courseRoster(database, course.id);
          course.students = students.length;
          course.rosterUpdatedAt = new Date().toISOString();
          return {
            course: publicCourse(database, request.user, course),
            students,
          };
        });
        response.json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/courses/:id/materials",
    authenticate,
    requireRoles("faculty", "ta"),
    express.raw({ type: () => true, limit: "8mb" }),
    async (request, response, next) => {
      try {
        const fileName = uploadedFileName(request.headers["x-file-name"]);
        const data = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        if (!fileName) {
          return response.status(400).json({ error: "Choose a file to upload" });
        }
        if (!data.length) {
          return response.status(400).json({ error: "The selected file is empty" });
        }
        const requestedContentType = String(request.headers["content-type"] || "")
          .split(";")[0]
          .trim()
          .slice(0, 120);
        const contentType = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(
          requestedContentType,
        )
          ? requestedContentType
          : "application/octet-stream";
        const material = await store.update((database) => {
          const course = requireCourse(
            database,
            request.user,
            request.params.id,
            "run",
          );
          const created = {
            id: `material-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            courseId: course.id,
            fileName,
            contentType,
            size: data.length,
            uploadedAt: new Date().toISOString(),
            uploadedBy: request.user.id,
            uploadedByName: request.user.name,
            dataBase64: data.toString("base64"),
          };
          database.courseMaterials.push(created);
          addNotice(database, {
            courseId: created.courseId,
            kind: "material",
            title: `New material: ${created.name}`,
            body: "Open the Materials tab to view or download it.",
            authorId: request.user.id,
            authorName: request.user.name,
          });
          return publicMaterial(created);
        });
        response.status(201).json({ material });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/api/courses/:id/materials",
    authenticate,
    async (request, response, next) => {
      try {
        const database = await store.read();
        const course = requireCourse(database, request.user, request.params.id);
        const materials = database.courseMaterials
          .filter((material) => material.courseId === course.id)
          .sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt))
          .map(publicMaterial);
        response.json({ materials });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/api/materials/:id/download",
    authenticate,
    async (request, response, next) => {
      try {
        const database = await store.read();
        const material = database.courseMaterials.find(
          (item) => item.id === request.params.id,
        );
        if (!material) {
          return response.status(404).json({ error: "Course material not found" });
        }
        requireCourse(database, request.user, material.courseId);
        const data = Buffer.from(material.dataBase64, "base64");
        const fallbackName = material.fileName
          .replace(/[^\x20-\x7e]/g, "_")
          .replace(/["\\]/g, "_");
        response.setHeader("Content-Type", material.contentType);
        response.setHeader("Content-Length", data.length);
        response.setHeader(
          "Content-Disposition",
          `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(material.fileName)}`,
        );
        response.send(data);
      } catch (error) {
        next(error);
      }
    },
  );

  app.delete(
    "/api/materials/:id",
    authenticate,
    requireRoles("faculty"),
    async (request, response, next) => {
      try {
        await store.update((database) => {
          const material = database.courseMaterials.find(
            (item) => item.id === request.params.id,
          );
          if (!material) {
            const error = new Error("Course material not found");
            error.status = 404;
            throw error;
          }
          requireCourse(database, request.user, material.courseId, "owner");
          database.courseMaterials = database.courseMaterials.filter(
            (item) => item.id !== material.id,
          );
          return null;
        });
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/courses/join",
    authenticate,
    requireRoles("student", "ta"),
    async (request, response, next) => {
      try {
        const code = String(request.body.code || "").trim().toUpperCase();
        // The roll number belongs to the account, so it is never re-entered.
        const submittedRoll = String(request.user.rollNumber || "").trim().toUpperCase();
        const enrollment = await store.update((database) => {
          const course = database.courses.find(
            (item) => item.code === code && hasValidCourseOwner(database, item),
          );
          if (!course) {
            const error = new Error("Course code not found");
            error.status = 404;
            throw error;
          }
          const roster = courseRoster(database, course.id);
          // Without an uploaded roll list the course builds its own from the
          // students who enrol, so it still has a register to work from.
          const openEnrolment =
            roster.length === 0 || course.rosterSource === "self-enrolled";
          const existing = database.enrollments.find(
            (item) => item.userId === request.user.id && item.courseId === course.id,
          );
          if (existing) return { course, existing: true };

          // With a roll list the student must be on it; without one they
          // register their own details instead. TAs never appear on either.
          let rollNumber = "";
          if (request.user.role === "student") {
            if (!submittedRoll) {
              const error = new Error(
                "Your account has no roll number. Sign up again with your roll number.",
              );
              error.status = 400;
              throw error;
            }
            if (!openEnrolment && !roster.some((item) => item.rollNumber === submittedRoll)) {
              const error = new Error(
                "You are not admitted to this course — your roll number is not on its roll list",
              );
              error.status = 403;
              throw error;
            }
            const claimedByAnother = database.enrollments.some(
              (item) =>
                item.courseId === course.id &&
                item.userId !== request.user.id &&
                item.rollNumber === submittedRoll,
            );
            if (claimedByAnother) {
              const error = new Error(
                "That roll number is already linked to another account",
              );
              error.status = 409;
              throw error;
            }
            rollNumber = submittedRoll;

            if (openEnrolment) {
              const added = {
                courseId: course.id,
                serial: courseRoster(database, course.id).length + 1,
                rollNumber,
                name: request.user.name,
              };
              database.courseStudents.push(added);
              database.attendanceSessions.forEach((session) => {
                if (session.courseId === course.id && session.status === "open") {
                  session.records.push(attendanceRecord(added));
                }
              });
              course.students = courseRoster(database, course.id).length;
              course.rosterSource = "self-enrolled";
              course.rosterUpdatedAt = new Date().toISOString();
            }
          }

          database.enrollments.push({
            id: `enrollment-${Date.now()}`,
            userId: request.user.id,
            courseId: course.id,
            courseRole: request.user.role,
            ...(rollNumber ? { rollNumber } : {}),
            joinedAt: new Date().toISOString(),
          });
          return { course, existing: false };
        });
        const data = await store.read();
        response.status(enrollment.existing ? 200 : 201).json({
          course: publicCourse(data, request.user, enrollment.course),
          existing: enrollment.existing,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get("/api/schedule", authenticate, async (request, response, next) => {
    try {
      const data = await store.read();
      const courseIds = new Set(
        accessibleCourses(data, request.user).map((course) => course.id),
      );
      response.json({
        schedule: data.schedule.filter((item) => courseIds.has(item.courseId)),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/attendance/sessions",
    authenticate,
    requireRoles("faculty", "ta"),
    async (request, response, next) => {
      try {
        const session = await store.update((database) => {
          const courseId = String(request.body.courseId || "").trim();
          const course = requireCourse(database, request.user, courseId, "run");
          const roster = courseRoster(database, courseId);
          if (!roster.length) {
            const error = new Error(
              "Upload the course roll list before taking attendance",
            );
            error.status = 409;
            throw error;
          }
          const scheduleId = String(request.body.scheduleId || "").trim() || null;
          if (
            scheduleId &&
            !database.schedule.some(
              (item) => item.id === scheduleId && item.courseId === courseId,
            )
          ) {
            const error = new Error("Schedule does not belong to this course");
            error.status = 400;
            throw error;
          }
          database.attendanceSessions.forEach((item) => {
            if (item.status === "open" && item.courseId === courseId) {
              item.status = "closed";
              item.closedAt = new Date().toISOString();
              item.closedBy = request.user.id;
            }
          });
          const created = {
            id: `attendance-${Date.now()}`,
            courseId,
            scheduleId,
            startedBy: request.user.id,
            startedAt: new Date().toISOString(),
            status: "open",
            records: roster.map(attendanceRecord),
          };
          database.attendanceSessions.push(created);
          addNotice(database, {
            courseId,
            kind: "attendance",
            title: "Attendance is open",
            body: "Mark yourself present with Wi‑Fi and Bluetooth switched on.",
            authorId: request.user.id,
            authorName: request.user.name,
          });
          return created;
        });
        response.status(201).json({ attendance: session });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/api/attendance/current",
    authenticate,
    requireRoles("faculty", "ta"),
    async (request, response, next) => {
      try {
        const data = await store.read();
        const courseId = String(request.query.courseId || "").trim();
        const accessibleIds = new Set(
          accessibleCourses(data, request.user).map((course) => course.id),
        );
        if (courseId) requireCourse(data, request.user, courseId, "run");
        const sessions = data.attendanceSessions.filter(
          (item) =>
            accessibleIds.has(item.courseId) &&
            (!courseId || item.courseId === courseId),
        );
        const attendance =
          [...sessions].reverse().find((item) => item.status === "open") ||
          [...sessions].reverse().find(Boolean);
        response.json({ attendance: attendance || null });
      } catch (error) {
        next(error);
      }
    },
  );

  // Must stay ahead of "/api/attendance/:id" so "open" is not read as an id.
  app.get(
    "/api/attendance/open",
    authenticate,
    requireRoles("student", "ta"),
    async (request, response, next) => {
      try {
        const data = await store.read();
        const enrolledIds = new Set(
          data.enrollments
            .filter((item) => item.userId === request.user.id)
            .map((item) => item.courseId),
        );
        const sessions = data.attendanceSessions.filter((session) => {
          if (session.status !== "open" || !enrolledIds.has(session.courseId)) return false;
          const course = data.courses.find((item) => item.id === session.courseId);
          return Boolean(course) && hasValidCourseOwner(data, course);
        });
        response.json({
          sessions: sessions.map((session) => {
            const record = ownRecord(data, request.user, session);
            return {
              id: session.id,
              courseId: session.courseId,
              startedAt: session.startedAt,
              rollNumber:
                record?.rollNumber || boundRollNumber(data, request.user, session.courseId),
              checkedIn: Boolean(record?.present),
              markedAt: record?.present ? record.markedAt : null,
            };
          }),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/api/attendance/:id",
    authenticate,
    requireRoles("faculty", "ta"),
    async (request, response, next) => {
      try {
        const data = await store.read();
        const attendance = data.attendanceSessions.find(
          (item) => item.id === request.params.id,
        );
        if (!attendance)
          return response.status(404).json({ error: "Attendance session not found" });
        requireCourse(data, request.user, attendance.courseId, "run");
        response.json({ attendance });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/attendance/:id/check-in",
    authenticate,
    requireRoles("student", "ta"),
    async (request, response, next) => {
      try {
        const signals = request.body.signals || {};
        if (signals.wifi !== true || signals.bluetooth !== true) {
          return response.status(400).json({
            error: "Connect Wi‑Fi and turn on Bluetooth before marking attendance",
          });
        }
        // The roll number belongs to the account, so it is never re-entered.
        const submittedRoll = String(request.user.rollNumber || "").trim().toUpperCase();

        const result = await store.update((database) => {
          const session = database.attendanceSessions.find(
            (item) => item.id === request.params.id && item.status === "open",
          );
          if (!session) {
            const error = new Error("Attendance is not open for this course");
            error.status = 404;
            throw error;
          }
          const enrollment = database.enrollments.find(
            (item) =>
              item.userId === request.user.id && item.courseId === session.courseId,
          );
          if (!enrollment) {
            const error = new Error("Join the course before marking attendance");
            error.status = 403;
            throw error;
          }
          const course = database.courses.find((item) => item.id === session.courseId);
          if (!course || !hasValidCourseOwner(database, course)) {
            const error = new Error("This course does not have an active professor");
            error.status = 409;
            throw error;
          }

          const alreadyBound = enrollment.rollNumber || "";
          const rollNumber = alreadyBound || submittedRoll;
          if (!rollNumber) {
            const error = new Error("Enter your roll number to mark attendance");
            error.status = 400;
            throw error;
          }
          const record = session.records.find(
            (item) => item.rollNumber === rollNumber,
          );
          if (!record) {
            const error = new Error("That roll number is not on this course roster");
            error.status = 400;
            throw error;
          }
          if (!alreadyBound) {
            const claimedByAnother = database.enrollments.some(
              (item) =>
                item.courseId === session.courseId &&
                item.userId !== request.user.id &&
                item.rollNumber === rollNumber,
            );
            if (claimedByAnother) {
              const error = new Error("That roll number is already linked to another account");
              error.status = 409;
              throw error;
            }
            enrollment.rollNumber = rollNumber;
          }

          record.present = true;
          record.markedAt = new Date().toISOString();
          record.markedBy = request.user.id;
          record.markedVia = "student";
          return {
            courseId: session.courseId,
            rollNumber,
            markedAt: record.markedAt,
          };
        });
        response.status(201).json({ checkedIn: true, ...result });
      } catch (error) {
        next(error);
      }
    },
  );

  app.patch(
    "/api/attendance/:id/records",
    authenticate,
    requireRoles("faculty", "ta"),
    async (request, response, next) => {
      try {
        const updates = Array.isArray(request.body.records)
          ? request.body.records.slice(0, 400)
          : [];
        if (!updates.length)
          return response.status(400).json({ error: "Select at least one roster entry" });
        const attendance = await store.update((database) => {
          const session = database.attendanceSessions.find(
            (item) => item.id === request.params.id && item.status === "open",
          );
          if (!session) {
            const error = new Error("Attendance session is not open");
            error.status = 404;
            throw error;
          }
          requireCourse(database, request.user, session.courseId, "run");
          const recordByRoll = new Map(
            session.records.map((record) => [record.rollNumber, record]),
          );
          for (const update of updates) {
            const rollNumber = String(update.rollNumber || "").trim().toUpperCase();
            const record = recordByRoll.get(rollNumber);
            if (!record) {
              const error = new Error("A submitted roll number is not in this roster");
              error.status = 400;
              throw error;
            }
            record.present = update.present === true;
            record.markedAt = new Date().toISOString();
            record.markedBy = request.user.id;
          }
          return session;
        });
        response.json({ attendance });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/attendance/:id/close",
    authenticate,
    requireRoles("faculty", "ta"),
    async (request, response, next) => {
      try {
        const attendance = await store.update((database) => {
          const session = database.attendanceSessions.find(
            (item) => item.id === request.params.id && item.status === "open",
          );
          if (!session) {
            const error = new Error("Attendance session is not open");
            error.status = 409;
            throw error;
          }
          requireCourse(database, request.user, session.courseId, "run");
          session.status = "closed";
          session.closedAt = new Date().toISOString();
          session.closedBy = request.user.id;
          return session;
        });
        response.json({ attendance });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/quizzes",
    authenticate,
    requireRoles("faculty", "ta"),
    async (request, response, next) => {
      try {
        const questions = normalizeQuizQuestions(request.body.questions);
        const asDraft = request.body.status === "draft";
        const quiz = await store.update((database) => {
          const courseId = String(request.body.courseId || "").trim();
          requireCourse(database, request.user, courseId, "run");
          // A draft disturbs nothing that is already running.
          database.quizzes.forEach((item) => {
            if (!asDraft && item.status === "open" && item.courseId === courseId) {
              item.status = "closed";
              item.closedAt = new Date().toISOString();
              item.closedBy = request.user.id;
            }
          });
          const settings = normalizeQuizSettings(request.body, { courseId, database });
          const created = {
            id: `quiz-${Date.now()}`,
            courseId,
            ...settings,
            questions,
            status: asDraft ? "draft" : "open",
            createdBy: request.user.id,
            createdAt: new Date().toISOString(),
            responses: [],
          };
          database.quizzes.push(created);
          if (!asDraft) {
            addNotice(database, {
              courseId,
              kind: "quiz",
              title: `Quiz published: ${created.title}`,
              body: `${questions.length} question${questions.length === 1 ? "" : "s"}${created.classLabel ? ` · ${created.classLabel}` : ""}.`,
              authorId: request.user.id,
              authorName: request.user.name,
            });
          }
          return created;
        });
        response.status(201).json({ quiz });
      } catch (error) {
        next(error);
      }
    },
  );

  // Drafts belong to the course team; students never see them.
  app.get(
    "/api/quizzes/drafts",
    authenticate,
    requireRoles("faculty", "ta"),
    async (request, response, next) => {
      try {
        const data = await store.read();
        const courseId = String(request.query.courseId || "").trim();
        if (courseId) requireCourse(data, request.user, courseId, "run");
        const accessibleIds = new Set(
          accessibleCourses(data, request.user).map((course) => course.id),
        );
        const drafts = data.quizzes.filter(
          (item) =>
            item.status === "draft" &&
            accessibleIds.has(item.courseId) &&
            (!courseId || item.courseId === courseId),
        );
        response.json({ drafts });
      } catch (error) {
        next(error);
      }
    },
  );

  app.put(
    "/api/quizzes/:id",
    authenticate,
    requireRoles("faculty", "ta"),
    async (request, response, next) => {
      try {
        const questions = normalizeQuizQuestions(request.body.questions);
        const quiz = await store.update((database) => {
          const draft = database.quizzes.find(
            (item) => item.id === request.params.id && item.status === "draft",
          );
          if (!draft) {
            const error = new Error("That draft quiz no longer exists");
            error.status = 404;
            throw error;
          }
          requireCourse(database, request.user, draft.courseId, "run");
          Object.assign(
            draft,
            normalizeQuizSettings(request.body, {
              courseId: draft.courseId,
              database,
            }),
          );
          draft.questions = questions;
          draft.updatedAt = new Date().toISOString();
          return draft;
        });
        response.json({ quiz });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/api/courses/:id/notices",
    authenticate,
    async (request, response, next) => {
      try {
        const data = await store.read();
        // Anyone with access to the course can read; only the team writes.
        requireCourse(data, request.user, request.params.id, "access");
        const notices = data.courseNotices
          .filter((item) => item.courseId === request.params.id)
          .slice(-100)
          .reverse();
        response.json({ notices });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/courses/:id/notices",
    authenticate,
    requireRoles("faculty", "ta"),
    async (request, response, next) => {
      try {
        const notice = await store.update((database) => {
          const course = requireCourse(
            database,
            request.user,
            request.params.id,
            "run",
          );
          const title = String(request.body.title || "")
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 120);
          const body = String(request.body.body || "").trim().slice(0, 2000);
          if (title.length < 2) {
            const error = new Error("Give the notice a title");
            error.status = 400;
            throw error;
          }
          return addNotice(database, {
            courseId: course.id,
            kind: "notice",
            title,
            body,
            authorId: request.user.id,
            authorName: request.user.name,
          });
        });
        response.status(201).json({ notice });
      } catch (error) {
        next(error);
      }
    },
  );

  app.delete(
    "/api/courses/:id/notices/:noticeId",
    authenticate,
    requireRoles("faculty", "ta"),
    async (request, response, next) => {
      try {
        await store.update((database) => {
          requireCourse(database, request.user, request.params.id, "run");
          const exists = database.courseNotices.some(
            (item) =>
              item.id === request.params.noticeId &&
              item.courseId === request.params.id,
          );
          if (!exists) {
            const error = new Error("That notice no longer exists");
            error.status = 404;
            throw error;
          }
          database.courseNotices = database.courseNotices.filter(
            (item) => item.id !== request.params.noticeId,
          );
          return null;
        });
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );

  // Every quiz the course team has run, newest first, for picking results from.
  app.get(
    "/api/quizzes/history",
    authenticate,
    requireRoles("faculty", "ta"),
    async (request, response, next) => {
      try {
        const data = await store.read();
        const courseId = String(request.query.courseId || "").trim();
        if (courseId) requireCourse(data, request.user, courseId, "run");
        const accessibleIds = new Set(
          accessibleCourses(data, request.user).map((course) => course.id),
        );
        const quizzes = data.quizzes
          .filter(
            (quiz) =>
              quiz.status !== "draft" &&
              accessibleIds.has(quiz.courseId) &&
              (!courseId || quiz.courseId === courseId),
          )
          .map((quiz) => ({
            id: quiz.id,
            courseId: quiz.courseId,
            title: quiz.title,
            status: quiz.status,
            day: quiz.day || "",
            classLabel: quiz.classLabel || "",
            quizDate: quiz.quizDate || "",
            questions: quiz.questions.length,
            responses: quiz.responses.length,
            createdAt: quiz.createdAt,
            publishedAt: quiz.publishedAt || quiz.createdAt,
            closedAt: quiz.closedAt || null,
          }))
          .reverse();
        response.json({ quizzes });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/api/quizzes/:id/results",
    authenticate,
    requireRoles("faculty", "ta"),
    async (request, response, next) => {
      try {
        const data = await store.read();
        const quiz = data.quizzes.find((item) => item.id === request.params.id);
        if (!quiz || quiz.status === "draft") {
          return response.status(404).json({ error: "Quiz not found" });
        }
        requireCourse(data, request.user, quiz.courseId, "run");
        const total = quiz.questions.length;
        const byUser = new Map(
          quiz.responses.map((response_) => [response_.userId, response_]),
        );
        // The whole roll list appears, so absentees are visible as blanks.
        const roster = courseRoster(data, quiz.courseId);
        const enrolmentByRoll = new Map(
          data.enrollments
            .filter((item) => item.courseId === quiz.courseId && item.rollNumber)
            .map((item) => [item.rollNumber, item]),
        );
        const results = roster.map((student) => {
          const enrolment = enrolmentByRoll.get(student.rollNumber);
          const user = enrolment
            ? data.users.find((item) => item.id === enrolment.userId)
            : null;
          const answered = user ? byUser.get(user.id) : null;
          return {
            serial: student.serial,
            rollNumber: student.rollNumber,
            name: user?.name || student.name,
            email: user?.email || "",
            attempted: Boolean(answered),
            score: answered ? Number(answered.score) || 0 : null,
            total,
            submittedAt: answered?.submittedAt || null,
          };
        });
        const attempted = results.filter((item) => item.attempted);
        response.json({
          quiz: {
            id: quiz.id,
            courseId: quiz.courseId,
            title: quiz.title,
            status: quiz.status,
            day: quiz.day || "",
            classLabel: quiz.classLabel || "",
            quizDate: quiz.quizDate || "",
            total,
            // The team may see the answer key alongside the marks.
            questions: quiz.questions,
            publishedAt: quiz.publishedAt || quiz.createdAt,
            closedAt: quiz.closedAt || null,
          },
          summary: {
            attempted: attempted.length,
            rostered: results.length,
            averageScore: attempted.length
              ? Math.round(
                  (attempted.reduce((sum, item) => sum + item.score, 0) /
                    attempted.length) *
                    100,
                ) / 100
              : 0,
          },
          results,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/quizzes/:id/publish",
    authenticate,
    requireRoles("faculty", "ta"),
    async (request, response, next) => {
      try {
        const quiz = await store.update((database) => {
          const draft = database.quizzes.find(
            (item) => item.id === request.params.id && item.status === "draft",
          );
          if (!draft) {
            const error = new Error("That draft quiz no longer exists");
            error.status = 404;
            throw error;
          }
          requireCourse(database, request.user, draft.courseId, "run");
          database.quizzes.forEach((item) => {
            if (item.status === "open" && item.courseId === draft.courseId) {
              item.status = "closed";
              item.closedAt = new Date().toISOString();
              item.closedBy = request.user.id;
            }
          });
          draft.status = "open";
          draft.publishedAt = new Date().toISOString();
          draft.publishedBy = request.user.id;
          addNotice(database, {
            courseId: draft.courseId,
            kind: "quiz",
            title: `Quiz published: ${draft.title}`,
            body: `${draft.questions.length} question${draft.questions.length === 1 ? "" : "s"}${draft.classLabel ? ` · ${draft.classLabel}` : ""}.`,
            authorId: request.user.id,
            authorName: request.user.name,
          });
          return draft;
        });
        response.json({ quiz });
      } catch (error) {
        next(error);
      }
    },
  );

  app.delete(
    "/api/quizzes/:id",
    authenticate,
    requireRoles("faculty", "ta"),
    async (request, response, next) => {
      try {
        await store.update((database) => {
          const quiz = database.quizzes.find((item) => item.id === request.params.id);
          if (!quiz) {
            const error = new Error("That quiz no longer exists");
            error.status = 404;
            throw error;
          }
          requireCourse(database, request.user, quiz.courseId, "run");
          database.quizzes = database.quizzes.filter((item) => item.id !== quiz.id);
          return null;
        });
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );

  app.get("/api/quizzes/current", authenticate, async (request, response, next) => {
    try {
      const data = await store.read();
      const courseId = String(request.query.courseId || "").trim();
      const accessibleIds = new Set(
        accessibleCourses(data, request.user).map((course) => course.id),
      );
      if (courseId) requireCourse(data, request.user, courseId, "access");
      const quiz = [...data.quizzes]
        .reverse()
        .find(
          (item) =>
            item.status === "open" &&
            accessibleIds.has(item.courseId) &&
            (!courseId || item.courseId === courseId),
        );
      if (!quiz) return response.json({ quiz: null });
      if (request.user.role === "student") {
        return response.json({ quiz: safeQuizForStudent(quiz, request.user.id) });
      }
      response.json({ quiz });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/quizzes/:id/respond",
    authenticate,
    requireRoles("student"),
    async (request, response, next) => {
      try {
        const answers = Array.isArray(request.body.answers)
          ? request.body.answers.map(Number)
          : [];
        const result = await store.update((database) => {
          const quiz = database.quizzes.find(
            (item) => item.id === request.params.id && item.status === "open",
          );
          if (!quiz) {
            const error = new Error("Quiz is not open");
            error.status = 404;
            throw error;
          }
          const enrolled = database.enrollments.some(
            (item) => item.userId === request.user.id && item.courseId === quiz.courseId,
          );
          if (!enrolled) {
            const error = new Error("Join the course before answering this quiz");
            error.status = 403;
            throw error;
          }
          if (quiz.responses.some((item) => item.userId === request.user.id)) {
            const error = new Error("Quiz response already submitted");
            error.status = 409;
            throw error;
          }
          const validAnswers =
            answers.length === quiz.questions.length &&
            answers.every(
              (answer, index) =>
                Number.isInteger(answer) &&
                answer >= 0 &&
                answer < quiz.questions[index].options.length,
            );
          if (!validAnswers) {
            const error = new Error("Submit one valid answer for every question");
            error.status = 400;
            throw error;
          }
          const score = quiz.questions.reduce(
            (total, question, index) =>
              total + (Number(question.answer) === answers[index] ? 1 : 0),
            0,
          );
          quiz.responses.push({
            userId: request.user.id,
            answers,
            score,
            submittedAt: new Date().toISOString(),
          });
          return { score, total: quiz.questions.length };
        });
        response.status(201).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/quizzes/:id/close",
    authenticate,
    requireRoles("faculty", "ta"),
    async (request, response, next) => {
      try {
        const quiz = await store.update((database) => {
          const current = database.quizzes.find((item) => item.id === request.params.id);
          if (!current) {
            const error = new Error("Quiz not found");
            error.status = 404;
            throw error;
          }
          requireCourse(database, request.user, current.courseId, "run");
          current.status = "closed";
          current.closedAt = new Date().toISOString();
          current.closedBy = request.user.id;
          return current;
        });
        response.json({ quiz });
      } catch (error) {
        next(error);
      }
    },
  );

  app.use("/api", (_request, response) => {
    response.status(404).json({ error: "API endpoint not found" });
  });

  const clientPath = path.resolve(__dirname, "../../public");
  app.use(express.static(clientPath, { maxAge: "5m", etag: true }));
  app.get(/.*/, (_request, response) => response.sendFile(path.join(clientPath, "index.html")));

  app.use((error, _request, response, _next) => {
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    response.status(status).json({
      error: error.status ? error.message : "Unexpected server error",
    });
  });

  return { app, store };
}

module.exports = { createApp, isCampusEmail };
