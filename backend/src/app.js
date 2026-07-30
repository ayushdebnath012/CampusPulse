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

function publicUser(user) {
  return {
    id: user.id,
    role: user.role,
    name: user.name,
    email: user.email,
    verifiedAt: user.verifiedAt,
  };
}

function asCsv(rows) {
  return rows
    .map((row) =>
      row.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(","),
    )
    .join("\n");
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
        })
      : createStore(databasePath));
  const mailer = options.mailer || createMailer(env);
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
      response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    }
    if (request.method === "OPTIONS") return response.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: "128kb" }));

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

  app.get("/api/health", (_request, response) => {
    response.json({
      ok: true,
      service: "campuspulse-api",
      version: "1.0.0",
      emailDelivery: mailer.configured ? "smtp" : "preview",
    });
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
        role === "faculty" &&
        env.FACULTY_SIGNUP_CODE &&
        request.body.roleCode !== env.FACULTY_SIGNUP_CODE
      )
        return response.status(403).json({ error: "Invalid faculty invitation code" });
      if (
        role === "ta" &&
        env.TA_SIGNUP_CODE &&
        request.body.roleCode !== env.TA_SIGNUP_CODE
      )
        return response.status(403).json({ error: "Invalid TA invitation code" });

      const data = await store.read();
      if (data.users.some((user) => user.email === email))
        return response.status(409).json({ error: "An account already exists for this email" });

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
      if (!delivery.delivered && env.ALLOW_DEV_VERIFICATION_CODE !== "false") {
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
      if (!delivery.delivered && env.ALLOW_DEV_VERIFICATION_CODE !== "false") {
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

  app.get("/api/bootstrap", authenticate, async (request, response, next) => {
    try {
      const data = await store.read();
      const enrolledCourseIds = data.enrollments
        .filter((item) => item.userId === request.user.id)
        .map((item) => item.courseId);
      const currentAttendance = [...data.attendanceSessions]
        .reverse()
        .find((item) => item.status === "open");
      const currentQuiz = [...data.quizzes].reverse().find((item) => item.status === "open");
      response.json({
        user: publicUser(request.user),
        courses: data.courses.map((course) => ({
          ...course,
          code: request.user.role === "student" ? undefined : course.code,
          enrolled: enrolledCourseIds.includes(course.id),
        })),
        enrolledCourseIds,
        schedule: data.schedule,
        attendance: currentAttendance || null,
        quiz: currentQuiz || null,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/courses", authenticate, async (request, response, next) => {
    try {
      const data = await store.read();
      const enrolled = new Set(
        data.enrollments
          .filter((item) => item.userId === request.user.id)
          .map((item) => item.courseId),
      );
      response.json({
        courses: data.courses.map((course) => ({
          ...course,
          code: request.user.role === "student" ? undefined : course.code,
          enrolled: enrolled.has(course.id),
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/courses/join",
    authenticate,
    requireRoles("student"),
    async (request, response, next) => {
      try {
        const code = String(request.body.code || "").trim().toUpperCase();
        const enrollment = await store.update((database) => {
          const course = database.courses.find((item) => item.code === code);
          if (!course) {
            const error = new Error("Course code not found");
            error.status = 404;
            throw error;
          }
          const existing = database.enrollments.find(
            (item) => item.userId === request.user.id && item.courseId === course.id,
          );
          if (existing) return { course, existing: true };
          database.enrollments.push({
            id: `enrollment-${Date.now()}`,
            userId: request.user.id,
            courseId: course.id,
            joinedAt: new Date().toISOString(),
          });
          return { course, existing: false };
        });
        response.status(enrollment.existing ? 200 : 201).json(enrollment);
      } catch (error) {
        next(error);
      }
    },
  );

  app.get("/api/schedule", authenticate, async (_request, response, next) => {
    try {
      response.json({ schedule: (await store.read()).schedule });
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
          if (!database.courses.some((item) => item.id === courseId)) {
            const error = new Error("Course not found");
            error.status = 404;
            throw error;
          }
          database.attendanceSessions.forEach((item) => {
            if (item.status === "open") item.status = "closed";
          });
          const created = {
            id: `attendance-${Date.now()}`,
            courseId,
            scheduleId: request.body.scheduleId || "schedule-2",
            startedBy: request.user.id,
            startedAt: new Date().toISOString(),
            status: "open",
            present: [],
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

  app.get("/api/attendance/current", authenticate, async (request, response, next) => {
    try {
      const data = await store.read();
      const attendance = [...data.attendanceSessions]
        .reverse()
        .find((item) => item.status === "open");
      if (!attendance) return response.json({ attendance: null });
      if (request.user.role === "student") {
        return response.json({
          attendance: {
            id: attendance.id,
            courseId: attendance.courseId,
            status: attendance.status,
            startedAt: attendance.startedAt,
            checkedIn: attendance.present.some((item) => item.userId === request.user.id),
          },
        });
      }
      response.json({ attendance });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/attendance/:id/check-in",
    authenticate,
    requireRoles("student"),
    async (request, response, next) => {
      try {
        if (!request.body.wifi || !request.body.bluetooth)
          return response.status(400).json({ error: "Wi-Fi and Bluetooth are required" });
        const result = await store.update((database) => {
          const attendance = database.attendanceSessions.find(
            (item) => item.id === request.params.id && item.status === "open",
          );
          if (!attendance) {
            const error = new Error("Attendance session is not open");
            error.status = 404;
            throw error;
          }
          const enrolled = database.enrollments.some(
            (item) =>
              item.userId === request.user.id && item.courseId === attendance.courseId,
          );
          if (!enrolled) {
            const error = new Error("Join the course before checking in");
            error.status = 403;
            throw error;
          }
          const existing = attendance.present.find(
            (item) => item.userId === request.user.id,
          );
          if (!existing) {
            attendance.present.push({
              userId: request.user.id,
              checkedInAt: new Date().toISOString(),
              wifi: true,
              bluetooth: true,
            });
          }
          return { checkedIn: true, attendanceId: attendance.id };
        });
        response.json(result);
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
            (item) => item.id === request.params.id,
          );
          if (!session) {
            const error = new Error("Attendance session not found");
            error.status = 404;
            throw error;
          }
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
        const questions = Array.isArray(request.body.questions)
          ? request.body.questions.slice(0, 10)
          : [];
        if (!questions.length)
          return response.status(400).json({ error: "Add at least one question" });
        const quiz = await store.update((database) => {
          database.quizzes.forEach((item) => {
            if (item.status === "open") item.status = "closed";
          });
          const created = {
            id: `quiz-${Date.now()}`,
            courseId: request.body.courseId || "soft401",
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
      const quiz = [...(await store.read()).quizzes]
        .reverse()
        .find((item) => item.status === "open");
      if (!quiz) return response.json({ quiz: null });
      if (request.user.role === "student") {
        return response.json({
          quiz: {
            ...quiz,
            questions: quiz.questions.map(({ answer, ...question }) => question),
            responses: undefined,
            responded: quiz.responses.some((item) => item.userId === request.user.id),
          },
        });
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
          current.status = "closed";
          current.closedAt = new Date().toISOString();
          return current;
        });
        response.json({ quiz });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/api/erp/attendance.csv",
    authenticate,
    requireRoles("faculty"),
    async (_request, response, next) => {
      try {
        const data = await store.read();
        const attendance = [...data.attendanceSessions].reverse().find(Boolean);
        if (!attendance)
          return response.status(404).json({ error: "No attendance record available" });
        const course = data.courses.find((item) => item.id === attendance.courseId);
        const presentIds = new Set(attendance.present.map((item) => item.userId));
        const enrolledUsers = data.enrollments
          .filter((item) => item.courseId === attendance.courseId)
          .map((item) => data.users.find((user) => user.id === item.userId))
          .filter(Boolean);
        const rows = [
          [
            "COURSE_CODE",
            "COURSE_NAME",
            "LECTURE_DATE",
            "STUDENT_EMAIL",
            "STUDENT_NAME",
            "STATUS",
          ],
          ...enrolledUsers.map((user) => [
            course.courseCode.replace(/\s+/g, ""),
            course.name,
            attendance.startedAt.slice(0, 10),
            user.email,
            user.name,
            presentIds.has(user.id) ? "P" : "A",
          ]),
        ];
        response.setHeader("Content-Type", "text/csv; charset=utf-8");
        response.setHeader(
          "Content-Disposition",
          `attachment; filename="${course.courseCode.replace(/\s+/g, "")}-attendance.csv"`,
        );
        response.send(asCsv(rows));
      } catch (error) {
        next(error);
      }
    },
  );

  const clientPath = path.resolve(__dirname, "../../public");
  app.use(express.static(clientPath, { maxAge: "5m", etag: true }));
  app.get(/.*/, (_request, response) => response.sendFile(path.join(clientPath, "index.html")));

  app.use((error, _request, response, _next) => {
    console.error(error);
    response.status(error.status || 500).json({
      error: error.status ? error.message : "Unexpected server error",
    });
  });

  return { app, store };
}

module.exports = { createApp, isCampusEmail };
