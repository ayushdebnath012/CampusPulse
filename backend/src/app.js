const express = require("express");
const path = require("node:path");
const { createStore } = require("./database");
const { createPostgresStore } = require("./postgres-database");
const { createMailer } = require("./mailer");
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

function isFacultyEmail(email) {
  return cleanEmail(email).split("@")[1] === "iitkgp.ac.in";
}

function publicUser(user) {
  return {
    id: user.id,
    role: user.role,
    name: user.name,
    email: user.email,
    verifiedAt: user.verifiedAt,
  };
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
    capabilities: {
      canManageCourse: owner,
      canManageRoster: owner,
      canViewAttendanceRoster: owner || assistant,
      canRunAttendance: owner || assistant,
      canPublishQuiz: owner || assistant,
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

function claimUnownedCourses(database, user) {
  if (user.role !== "faculty") return [];
  const claimed = [];
  for (const course of database.courses) {
    if (hasValidCourseOwner(database, course)) continue;
    course.ownerId = user.id;
    if (!course.code || String(course.code).startsWith("LOCKED-")) {
      course.code = createJoinCode(database);
      course.joinCodeConfigured = true;
    }
    claimed.push(course.id);
  }
  return claimed;
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
    if (
      text.length < 2 ||
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
    return { text, options, answer };
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
  const automaticallyAssignFacultyCourses = !String(
    env.COURSE_OWNER_EMAILS_JSON || "",
  ).trim();
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
        "Authorization, Content-Type",
      );
      response.setHeader(
        "Access-Control-Allow-Methods",
        "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      );
    }
    if (request.method === "OPTIONS") return response.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: "128kb" }));
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
      if (production && !data.courseStudents.length) {
        warnings.push("COURSE_ROSTERS_JSON_BASE64");
      }
      const lockedCourses = data.courses
        .filter((course) => String(course.code || "").startsWith("LOCKED-"))
        .map((course) => course.id);
      response.json({
        ok: true,
        service: "campuspulse-api",
        version: "1.2.0",
        otpRequired: false,
        emailDelivery:
          mailer.provider || (mailer.configured ? "configured" : "disabled"),
        ...(warnings.length ? { configurationWarnings: warnings } : {}),
        ...(lockedCourses.length ? { lockedCourses } : {}),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/signup", async (request, response, next) => {
    try {
      const role = String(request.body.role || "");
      const name = String(request.body.name || "").trim().replace(/\s+/g, " ");
      const email = cleanEmail(request.body.email);
      const password = String(request.body.password || "");
      if (!ROLES.has(role)) return response.status(400).json({ error: "Invalid role" });
      if (name.length < 2 || name.length > 80)
        return response.status(400).json({ error: "Enter a valid full name" });
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

      const passwordHash = await hashPassword(password);
      const token = randomToken();
      const result = await store.update((database) => {
        if (database.users.some((user) => user.email === email)) {
          return { error: "An account already exists for this email", status: 409 };
        }
        const now = new Date().toISOString();
        const created = {
          id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role,
          name,
          email,
          passwordHash,
          createdAt: now,
          verifiedAt: null,
        };
        database.users.push(created);
        if (automaticallyAssignFacultyCourses) {
          claimUnownedCourses(database, created);
        }
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
      const email = cleanEmail(request.body.email);
      const password = String(request.body.password || "");
      if (!ROLES.has(role)) return response.status(400).json({ error: "Invalid role" });
      if (name.length < 2 || name.length > 80)
        return response.status(400).json({ error: "Enter a valid full name" });
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
        const created = {
          id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: record.role,
          name: record.name,
          email: record.email,
          passwordHash: record.passwordHash,
          verifiedAt: new Date().toISOString(),
        };
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
        const currentUser = database.users.find((item) => item.id === user.id) || user;
        if (automaticallyAssignFacultyCourses) {
          claimUnownedCourses(database, currentUser);
        }
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
      response.json({
        user: publicUser(request.user),
        courses: courses.map((course) => publicCourse(data, request.user, course)),
        enrolledCourseIds,
        schedule: data.schedule.filter((item) => courseIds.has(item.courseId)),
        quiz:
          request.user.role === "student"
            ? safeQuizForStudent(currentQuiz, request.user.id)
            : currentQuiz || null,
      });
    } catch (error) {
      next(error);
    }
  });

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
    requireRoles("faculty"),
    async (request, response, next) => {
      try {
        const result = await store.update((database) => {
          const course = requireCourse(
            database,
            request.user,
            request.params.id,
            "owner",
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

  app.post(
    "/api/courses/join",
    authenticate,
    requireRoles("student", "ta"),
    async (request, response, next) => {
      try {
        const code = String(request.body.code || "").trim().toUpperCase();
        const submittedRoll = String(request.body.rollNumber || "")
          .trim()
          .toUpperCase();
        const enrollment = await store.update((database) => {
          const course = database.courses.find(
            (item) => item.code === code && hasValidCourseOwner(database, item),
          );
          if (!course) {
            const error = new Error("Course code not found");
            error.status = 404;
            throw error;
          }
          // A course opens to students only once its roll list exists.
          const roster = courseRoster(database, course.id);
          if (!roster.length) {
            const error = new Error(
              "This course has not started yet — its professor has not uploaded the roll list",
            );
            error.status = 409;
            throw error;
          }
          const existing = database.enrollments.find(
            (item) => item.userId === request.user.id && item.courseId === course.id,
          );
          if (existing) return { course, existing: true };

          // Students are admitted only if the professor's roll list contains
          // them; teaching assistants never appear on it.
          let rollNumber = "";
          if (request.user.role === "student") {
            if (!submittedRoll) {
              const error = new Error("Enter your roll number to join this course");
              error.status = 400;
              throw error;
            }
            const entry = roster.find((item) => item.rollNumber === submittedRoll);
            if (!entry) {
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
          const courseId = request.body.courseId || "soft401";
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
        const submittedRoll = String(request.body.rollNumber || "")
          .trim()
          .toUpperCase();

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
        const quiz = await store.update((database) => {
          const courseId = String(request.body.courseId || "").trim();
          requireCourse(database, request.user, courseId, "run");
          database.quizzes.forEach((item) => {
            if (item.status === "open" && item.courseId === courseId) {
              item.status = "closed";
              item.closedAt = new Date().toISOString();
              item.closedBy = request.user.id;
            }
          });
          const created = {
            id: `quiz-${Date.now()}`,
            courseId,
            title: String(request.body.title || "Quick quiz").slice(0, 100),
            questions,
            status: "open",
            createdBy: request.user.id,
            createdAt: new Date().toISOString(),
            responses: [],
          };
          database.quizzes.push(created);
          return created;
        });
        response.status(201).json({ quiz });
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
