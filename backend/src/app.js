const express = require("express");
const path = require("node:path");
const { createStore } = require("./database");
const { createPostgresStore } = require("./postgres-database");
const { createMailer } = require("./mailer");
const { createFirebaseNotifier } = require("./push-notifier");
const { applyUserProfileOverride } = require("./profile-overrides");
const {
  hashPassword,
  verifyPassword,
  randomCode,
  randomToken,
  sha256,
} = require("./security");

const ROLES = new Set(["faculty", "ta", "student"]);
const FIVE_MINUTES = 5 * 60 * 1000;
const TEN_MINUTES = 10 * 60 * 1000;
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
const MAX_PUSH_DEVICES_PER_USER = 5;
const PUSH_DELIVERY_CONCURRENCY = 20;
// How long a request will wait for phone delivery before answering and
// letting the rest finish in the background.
const PUSH_DELIVERY_RESPONSE_BUDGET_MS = 1500;

function cleanEmail(value = "") {
  return String(value).trim().toLowerCase();
}

/**
 * Any working mailbox is accepted, for every role.
 *
 * Sign-up used to be restricted to iitkgp.ac.in addresses, which locked out
 * visiting staff, exchange students, and anyone whose institute account was not
 * yet issued. Course access is controlled by the private join codes, not by the
 * shape of an address, so the domain check bought less than it cost.
 */
function isValidEmail(email) {
  const value = cleanEmail(email);
  if (value.length < 6 || value.length > 254) return false;
  const [local, domain, extraAddressPart] = value.split("@");
  if (extraAddressPart !== undefined) return false;
  if (!/^[a-z0-9][a-z0-9._%+-]*$/.test(local || "")) return false;
  if (local.includes("..") || local.endsWith(".")) return false;
  // At least one dot, and every label a plausible DNS label.
  const labels = String(domain || "").split(".");
  if (labels.length < 2) return false;
  if (!/^[a-z]{2,63}$/.test(labels[labels.length - 1])) return false;
  return labels.every((label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
  );
}

// Retained so existing course-owner mappings and any caller that still cares
// can recognise a departmental IIT KGP address, for example
// dkpra@mech.iitkgp.ac.in. It no longer gates who may sign up.
function isFacultyEmail(email) {
  const [local, domain, extraAddressPart] = cleanEmail(email).split("@");
  const [department, institute, academic, country, extraDomainPart] = String(
    domain || "",
  ).split(".");
  return Boolean(
    !extraAddressPart &&
      !extraDomainPart &&
      /^[a-z0-9][a-z0-9_%+.-]*$/.test(local || "") &&
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(department || "") &&
      department !== "kgpian" &&
      institute === "iitkgp" &&
      academic === "ac" &&
      country === "in",
  );
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

function publicNotification(notification) {
  const { userId: _userId, ...visible } = notification;
  return visible;
}

function notificationData(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 50)
      .filter(([, item]) => item !== undefined && item !== null)
      .map(([key, item]) => [String(key).slice(0, 100), String(item).slice(0, 4000)])
      .filter(([key]) => key),
  );
}

// Inbox records are authoritative even when a phone is offline or Firebase is
// temporarily unavailable. Device deliveries are returned separately so they
// can happen after the database transaction has committed.
/** The devices a signed-in user can currently be reached on. */
function reachableDevices(database, userId) {
  return database.pushDevices
    .filter(
      (device) =>
        device.userId === userId &&
        device.sessionTokenHash &&
        database.sessions.some(
          (session) =>
            session.userId === userId &&
            session.tokenHash === device.sessionTokenHash &&
            Date.parse(session.expiresAt) > Date.now(),
        ),
    )
    .map(({ token, platform }) => ({ token, platform }));
}

/** Trims a user's inbox without losing the useful recent history. */
function trimInbox(database, userIds) {
  for (const userId of userIds) {
    const own = database.notifications.filter((item) => item.userId === userId);
    if (own.length <= 500) continue;
    const obsolete = new Set(own.slice(0, own.length - 500).map((item) => item.id));
    database.notifications = database.notifications.filter(
      (item) => !obsolete.has(item.id),
    );
  }
}

/**
 * Notifications whose wording differs per recipient.
 *
 * "You were marked present" is only meaningful to the one student it is about,
 * so unlike a course announcement each entry carries its own title and body.
 */
function addPersonalNotifications(database, entries) {
  const users = new Set(database.users.map((user) => user.id));
  const createdAt = new Date().toISOString();
  const deliveries = [];
  const touched = new Set();

  for (const entry of entries) {
    const userId = String(entry.userId || "");
    if (!users.has(userId)) continue;
    const notification = {
      id: `notification-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      userId,
      type: String(entry.type || "notice").slice(0, 40),
      title: String(entry.title || "CampusPulse").slice(0, 120),
      body: String(entry.body || "").slice(0, 500),
      courseId: String(entry.courseId || ""),
      route: String(entry.route || "dashboard").slice(0, 80),
      data: notificationData(entry.data || {}),
      createdAt,
      readAt: null,
    };
    database.notifications.push(notification);
    touched.add(userId);
    deliveries.push({ notification, devices: reachableDevices(database, userId) });
  }

  trimInbox(database, touched);
  return deliveries;
}

function addCourseNotifications(
  database,
  { courseId, actorId, type, title, body = "", route, data = {}, studentsOnly = false },
) {
  const course = database.courses.find((item) => item.id === courseId);
  if (!course) return [];
  const courseEnrollments = database.enrollments.filter(
    (enrollment) => enrollment.courseId === courseId,
  );
  // Some notices (e.g. "mark yourself present") only make sense for students;
  // the professor and TAs who run attendance don't need to mark themselves.
  const recipientIds = new Set(
    studentsOnly
      ? courseEnrollments
          .filter((enrollment) => enrollment.courseRole === "student")
          .map((enrollment) => enrollment.userId)
      : [course.ownerId, ...courseEnrollments.map((enrollment) => enrollment.userId)],
  );
  recipientIds.delete(actorId);

  const users = new Set(database.users.map((user) => user.id));
  const createdAt = new Date().toISOString();
  const deliveries = [];
  for (const userId of recipientIds) {
    if (!users.has(userId)) continue;
    const notification = {
      id: `notification-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      userId,
      type: String(type || "notice").slice(0, 40),
      title: String(title || "CampusPulse").slice(0, 120),
      body: String(body || "").slice(0, 500),
      courseId,
      route: String(route || "dashboard").slice(0, 80),
      data: notificationData(data),
      createdAt,
      readAt: null,
    };
    database.notifications.push(notification);
    deliveries.push({ notification, devices: reachableDevices(database, userId) });
  }

  trimInbox(database, recipientIds);
  return deliveries;
}

const PROXIMITY_WINDOW_MS = 30000;

// The code changes every 30 seconds and is derived from a secret held only by
// the server, so a student has to read it from the room to submit it.
function proximityCodeFor(secret, offset = 0) {
  const window = Math.floor(Date.now() / PROXIMITY_WINDOW_MS) + offset;
  return sha256(`${secret}:${window}`).slice(0, 6).toUpperCase();
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

function publicAttendance(session) {
  if (!session) return session;
  // The exact coordinates of the room are not the class's business; whether a
  // location was captured is.
  const { proximitySecret: _secret, location, ...rest } = session;
  return { ...rest, hasLocation: Boolean(location) };
}

/** A geolocation reading from a phone, or null if it is unusable. */
function normalizeLocation(value) {
  if (!value || typeof value !== "object") return null;
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90) return null;
  if (!Number.isFinite(longitude) || Math.abs(longitude) > 180) return null;
  // Browsers report accuracy as a 68%-confidence radius in metres. A fix with
  // no accuracy is treated as very rough rather than as perfect.
  const accuracy = Number(value.accuracy);
  return {
    latitude,
    longitude,
    accuracy:
      Number.isFinite(accuracy) && accuracy >= 0 ? Math.min(accuracy, 10000) : 2000,
    capturedAt: new Date().toISOString(),
  };
}

/** Great-circle distance in metres. */
function metresBetween(from, to) {
  const radius = 6371000;
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const deltaLat = toRadians(to.latitude - from.latitude);
  const deltaLon = toRadians(to.longitude - from.longitude);
  const fromLat = toRadians(from.latitude);
  const toLat = toRadians(to.latitude);
  const h =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Whether a student's fix is consistent with being at the class.
 *
 * Bluetooth is what proves someone is in the room; this is the wider net that
 * catches marking attendance from home. Indoor GPS is only accurate to tens of
 * metres, so both readings' own error bars are subtracted before judging, and
 * a missing fix never blocks a student whose Bluetooth already checked out —
 * refusing someone who is genuinely sitting in the lecture is the worse error.
 */
function locationAgrees(sessionLocation, studentLocation, limitMetres) {
  if (!sessionLocation || !studentLocation) {
    return { verified: false, reason: "unavailable" };
  }
  const distance = metresBetween(sessionLocation, studentLocation);
  const slack = sessionLocation.accuracy + studentLocation.accuracy;
  const worstCase = distance - slack;
  return {
    verified: true,
    within: worstCase <= limitMetres,
    distance: Math.round(distance),
    limitMetres,
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
    studentCode,
    taCode,
    joinCodeConfigured: _joinCodeConfigured,
    ...metadata
  } = course;
  return {
    ...metadata,
    ...(owner
      ? {
          code: studentCode || code,
          studentCode: studentCode || code,
          taCode,
        }
      : {}),
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

function createJoinCode(database, reserved = new Set()) {
  let code;
  do {
    code = randomToken().replace(/[^a-z0-9]/gi, "").slice(0, 8).toUpperCase();
  } while (
    !code ||
    reserved.has(code) ||
    database.courses.some((course) =>
      [course.code, course.studentCode, course.taCode].includes(code),
    )
  );
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

/** Names a scheduled class for a picker: "09:00 Introduction" or "09:00". */
function classLabelFor(scheduled) {
  if (!scheduled) return "";
  const time = String(scheduled.start || "").trim();
  const topic = String(scheduled.topic || "").trim();
  return [time, topic].filter(Boolean).join(" · ").slice(0, 140);
}

/** Minutes past midnight for a timetable time such as "10:00" or "2:30 PM". */
function minutesIntoDay(value) {
  const match = String(value || "")
    .trim()
    .match(/^(\d{1,2})[:.]?(\d{2})?\s*([ap]\.?m\.?)?$/i);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2] || 0);
  const meridiem = (match[3] || "").toLowerCase();
  if (hours > 23 || minutes > 59) return null;
  if (meridiem.startsWith("p") && hours < 12) hours += 12;
  if (meridiem.startsWith("a") && hours === 12) hours = 0;
  return hours * 60 + minutes;
}

/**
 * Which of today's scheduled classes an attendance session belongs to.
 *
 * Attendance is per class, not per day, so a course meeting twice on a Tuesday
 * gets two separate registers. When the client does not name a class, the one
 * nearest to now is used, which is what a professor starting attendance in the
 * room actually means.
 */
function scheduledClassNow(database, courseId, now = new Date()) {
  const today = WEEKDAYS[(now.getDay() + 6) % 7];
  const candidates = database.schedule.filter(
    (item) => item.courseId === courseId && item.day === today,
  );
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  let best = null;
  let bestDistance = Infinity;
  candidates.forEach((entry) => {
    const start = minutesIntoDay(entry.start);
    if (start === null) return;
    const end = minutesIntoDay(entry.end);
    // Inside the slot wins outright; otherwise the closest start time does.
    const distance =
      end !== null && currentMinutes >= start && currentMinutes <= end
        ? 0
        : Math.abs(currentMinutes - start);
    if (distance < bestDistance) {
      best = entry;
      bestDistance = distance;
    }
  });
  return best || candidates[0];
}

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
  const pushNotifier = options.pushNotifier || createFirebaseNotifier(env);
  const pushDeliveryState = {
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastErrorCount: 0,
  };
  // How far from the class a student's own fix may be. Deliberately wider than
  // a room: indoors a phone is only accurate to tens of metres, and the point
  // is to catch marking attendance from home, not to measure seating. Bluetooth
  // is what establishes actual presence.
  const geofenceMetres = Math.max(
    25,
    Number(env.ATTENDANCE_GEOFENCE_METRES || 150) || 150,
  );
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

  async function deliverNotifications(deliveries = []) {
    if (!pushNotifier.configured || typeof pushNotifier.send !== "function") return;
    const seenTokens = new Set();
    const attempts = [];
    for (const delivery of deliveries) {
      for (const device of delivery.devices || []) {
        if (!device.token || seenTokens.has(device.token)) continue;
        seenTokens.add(device.token);
        attempts.push({ device, notification: delivery.notification });
      }
    }
    if (!attempts.length) return;
    pushDeliveryState.lastAttemptAt = new Date().toISOString();
    const results = new Array(attempts.length);
    let nextAttempt = 0;
    const workers = Array.from(
      { length: Math.min(PUSH_DELIVERY_CONCURRENCY, attempts.length) },
      async () => {
        while (nextAttempt < attempts.length) {
          const index = nextAttempt;
          nextAttempt += 1;
          const { device, notification } = attempts[index];
          try {
            const result = await pushNotifier.send({
              token: device.token,
              platform: device.platform,
              title: notification.title,
              body: notification.body,
              data: {
                ...notification.data,
                notificationId: notification.id,
                type: notification.type,
                courseId: notification.courseId,
                route: notification.route,
              },
            });
            results[index] = {
              token: device.token,
              invalid: result?.invalidToken === true,
              delivered: result?.delivered !== false,
            };
          } catch (error) {
            results[index] = {
              token: device.token,
              invalid: error?.invalidToken === true,
              delivered: false,
            };
          }
        }
      },
    );
    await Promise.all(workers);
    const errorCount = results.filter((result) => !result.delivered).length;
    pushDeliveryState.lastErrorCount = errorCount;
    if (results.some((result) => result.delivered)) {
      pushDeliveryState.lastSuccessAt = new Date().toISOString();
    }
    if (errorCount) {
      pushDeliveryState.lastFailureAt = new Date().toISOString();
      console.warn(`CampusPulse push delivery failed for ${errorCount} device(s)`);
    }
    const invalidTokens = new Set(
      results.filter((result) => result.invalid).map((result) => result.token),
    );
    if (!invalidTokens.size) return;
    // FCM says these tokens are permanently invalid; leaving them in storage
    // would make every later course event retry them.
    await store
      .update((database) => {
        database.pushDevices = database.pushDevices.filter(
          (device) => !invalidTokens.has(device.token),
        );
        return null;
      })
      .catch(() => {});
  }

  /**
   * Delivers push notifications without letting them hold up the response.
   *
   * A course event fans out to the whole class, so closing attendance for 310
   * students means 310 phone deliveries. Making the professor's request wait
   * for all of them is how "close attendance" turns into a timeout. The inbox
   * rows are already committed by the time this runs, so nothing is lost by
   * answering first and letting a slow delivery finish in the background.
   */
  async function deliverNotificationsWithoutBlocking(deliveries = []) {
    if (!deliveries.length) return;
    const delivery = deliverNotifications(deliveries).catch((error) => {
      console.error("CampusPulse push delivery failed", error);
    });
    let release;
    const cap = new Promise((resolve) => {
      release = setTimeout(resolve, PUSH_DELIVERY_RESPONSE_BUDGET_MS);
    });
    await Promise.race([delivery.finally(() => clearTimeout(release)), cap]);
  }

  app.get("/api/health", async (_request, response, next) => {
    try {
      const production = String(env.NODE_ENV || "").toLowerCase() === "production";
      const warnings = production
        ? [
            "FIREBASE_SERVICE_ACCOUNT_JSON",
          ].filter((key) =>
            key === "FIREBASE_SERVICE_ACCOUNT_JSON"
              ? !pushNotifier.configured
              : !String(env[key] || "").trim(),
          )
        : [];
      const data = await store.read();
      response.json({
        ok: true,
        service: "campuspulse-api",
        version: "1.5.2",
        // Sign-up needs an emailed code whenever one can be sent.
        otpRequired: Boolean(mailer.configured || allowDevVerificationCode),
        emailDelivery:
          mailer.provider || (mailer.configured ? "configured" : "disabled"),
        // Makes "nobody got the code" answerable without server shell access.
        ...(mailer.stats ? { emailRuntime: { ...mailer.stats } } : {}),
        pushDelivery: pushNotifier.configured
          ? pushNotifier.provider || "configured"
          : pushNotifier.status || "disabled",
        pushConfigured: Boolean(pushNotifier.configured),
        pushRuntime: { ...pushDeliveryState },
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
      // Every account is created through the emailed code; this route stays
      // open only while there is no way to send one.
      if (mailer.configured || allowDevVerificationCode) {
        return response.status(403).json({
          error: "Verify your email to create an account",
          verificationRequired: true,
        });
      }
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
      if (!isValidEmail(email))
        return response.status(400).json({ error: "Enter a valid email address" });
      if (password.length < 8 || password.length > 128)
        return response.status(400).json({ error: "Password must contain 8–128 characters" });

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
      if (!isValidEmail(email))
        return response.status(400).json({ error: "Enter a valid email address" });
      if (password.length < 8 || password.length > 128)
        return response.status(400).json({ error: "Password must contain 8–128 characters" });

      // The same details the account will carry once the code is confirmed.
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
      }

      const data = await store.read();
      if (data.users.some((user) => user.email === email))
        return response.status(409).json({ error: "An account already exists for this email" });
      if (rollNumber && data.users.some((user) => user.rollNumber === rollNumber))
        return response
          .status(409)
          .json({ error: "An account already exists for this roll number" });
      if (!mailer.configured && !allowDevVerificationCode) {
        return response.status(503).json({
          error:
            "Verification email is not set up yet. Ask the administrator to configure it.",
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
          phone,
          ...(rollNumber ? { rollNumber } : {}),
          ...(hall ? { hall } : {}),
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
      const token = randomToken();
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
        if (
          record.rollNumber &&
          database.users.some((item) => item.rollNumber === record.rollNumber)
        ) {
          return { error: "An account already exists for this roll number", status: 409 };
        }
        const created = applyUserProfileOverride({
          id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: record.role,
          name: record.name,
          email: record.email,
          department: record.department || "",
          ...(record.phone ? { phone: record.phone } : {}),
          ...(record.rollNumber ? { rollNumber: record.rollNumber } : {}),
          ...(record.hall ? { hall: record.hall } : {}),
          passwordHash: record.passwordHash,
          createdAt: new Date().toISOString(),
          verifiedAt: new Date().toISOString(),
        }, env);
        database.users.push(created);
        database.verificationCodes = database.verificationCodes.filter(
          (item) => item.email !== email,
        );
        // A verified account is signed in straight away.
        database.sessions = database.sessions.filter(
          (item) => Date.parse(item.expiresAt) > Date.now(),
        );
        database.sessions.push({
          tokenHash: sha256(token),
          userId: created.id,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + THIRTY_DAYS).toISOString(),
        });
        return { user: created };
      });
      if (result.error) return response.status(result.status).json({ error: result.error });
      response.status(201).json({ ok: true, token, user: publicUser(result.user) });
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
        database.pushDevices = database.pushDevices.filter(
          (item) => item.userId !== user.id,
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
        database.pushDevices = database.pushDevices.filter(
          (item) =>
            item.userId !== request.user.id ||
            item.sessionTokenHash === request.sessionTokenHash,
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
        database.pushDevices = database.pushDevices.filter(
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
        database.pushDevices = database.pushDevices.filter(
          (item) =>
            item.userId !== request.user.id ||
            item.sessionTokenHash !== request.sessionTokenHash,
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

  app.get("/api/notifications", authenticate, async (request, response, next) => {
    try {
      const requestedLimit = Number.parseInt(String(request.query.limit || "50"), 10);
      const limit = Number.isFinite(requestedLimit)
        ? Math.min(100, Math.max(1, requestedLimit))
        : 50;
      const data = await store.read();
      const own = data.notifications.filter(
        (notification) => notification.userId === request.user.id,
      );
      response.json({
        notifications: own.slice(-limit).reverse().map(publicNotification),
        unreadCount: own.filter((notification) => !notification.readAt).length,
      });
    } catch (error) {
      next(error);
    }
  });

  app.patch(
    "/api/notifications/:id/read",
    authenticate,
    async (request, response, next) => {
      try {
        const notification = await store.update((database) => {
          const own = database.notifications.find(
            (item) => item.id === request.params.id && item.userId === request.user.id,
          );
          if (!own) {
            const error = new Error("Notification not found");
            error.status = 404;
            throw error;
          }
          if (!own.readAt) own.readAt = new Date().toISOString();
          return own;
        });
        response.json({ notification: publicNotification(notification) });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/notifications/read-all",
    authenticate,
    async (request, response, next) => {
      try {
        const updated = await store.update((database) => {
          const readAt = new Date().toISOString();
          let count = 0;
          database.notifications.forEach((notification) => {
            if (notification.userId === request.user.id && !notification.readAt) {
              notification.readAt = readAt;
              count += 1;
            }
          });
          return count;
        });
        response.json({ updated, unreadCount: 0 });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/notifications/devices",
    authenticate,
    async (request, response, next) => {
      try {
        const token = String(request.body.token || "").trim();
        const platform = String(request.body.platform || "android").toLowerCase();
        if (token.length < 8 || token.length > 4096 || /\s/.test(token)) {
          return response.status(400).json({ error: "Enter a valid device token" });
        }
        if (!["android", "ios", "web"].includes(platform)) {
          return response.status(400).json({ error: "Unsupported device platform" });
        }
        const result = await store.update((database) => {
          const now = new Date().toISOString();
          let device = database.pushDevices.find((item) => item.token === token);
          const created = !device;
          database.pushDevices = database.pushDevices.filter(
            (item) => item.token !== token,
          );
          const ownDevices = database.pushDevices
            .filter((item) => item.userId === request.user.id)
            .sort(
              (left, right) =>
                Date.parse(left.updatedAt || left.registeredAt || 0) -
                Date.parse(right.updatedAt || right.registeredAt || 0),
            );
          const evictedTokens = new Set(
            ownDevices
              .slice(0, Math.max(0, ownDevices.length - MAX_PUSH_DEVICES_PER_USER + 1))
              .map((item) => item.token),
          );
          if (evictedTokens.size) {
            database.pushDevices = database.pushDevices.filter(
              (item) => !evictedTokens.has(item.token),
            );
          }
          if (device) {
            device.userId = request.user.id;
            device.platform = platform;
            device.sessionTokenHash = request.sessionTokenHash;
            device.updatedAt = now;
          } else {
            device = {
              token,
              userId: request.user.id,
              platform,
              sessionTokenHash: request.sessionTokenHash,
              registeredAt: now,
              updatedAt: now,
            };
          }
          database.pushDevices.push(device);
          return { device, created };
        });
        response.status(result.created ? 201 : 200).json({
          device: {
            token: result.device.token,
            platform: result.device.platform,
            registeredAt: result.device.registeredAt,
            updatedAt: result.device.updatedAt,
          },
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.delete(
    "/api/notifications/devices",
    authenticate,
    async (request, response, next) => {
      try {
        const token = String(request.body.token || "").trim();
        if (!token) return response.status(400).json({ error: "Device token required" });
        await store.update((database) => {
          database.pushDevices = database.pushDevices.filter(
            (device) =>
              !(device.token === token && device.userId === request.user.id),
          );
          return null;
        });
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );

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
        database.notifications = database.notifications.filter(
          (item) => item.userId !== userId,
        );
        database.pushDevices = database.pushDevices.filter(
          (item) => item.userId !== userId,
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
          const studentCode = createJoinCode(database);
          const taCode = createJoinCode(database, new Set([studentCode]));
          const created = {
            id: `course-${Date.now()}-${randomToken().slice(0, 6)}`,
            // Keep `code` as an alias so already-installed clients continue to
            // use the student code while newer clients label both explicitly.
            code: studentCode,
            studentCode,
            taCode,
            name,
            courseCode,
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
          existing.room =
            String(request.body.room ?? existing.room).trim().slice(0, 80) ||
            "Room TBA";
          // Both join codes are deliberately untouched: already invited people
          // may still be holding either one.
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
          database.courseNotices = database.courseNotices.filter(
            (item) => item.courseId !== courseId,
          );
          database.notifications = database.notifications.filter(
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
        const result = await store.update((database) => {
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
          const title = `New material: ${created.fileName}`;
          const body = "Open the Materials tab to view or download it.";
          addNotice(database, {
            courseId: created.courseId,
            kind: "material",
            title,
            body,
            authorId: request.user.id,
            authorName: request.user.name,
          });
          const deliveries = addCourseNotifications(database, {
            courseId: created.courseId,
            actorId: request.user.id,
            type: "material",
            title,
            body,
            route: "materials",
            data: { materialId: created.id, fileName: created.fileName },
          });
          return { material: publicMaterial(created), deliveries };
        });
        await deliverNotificationsWithoutBlocking(result.deliveries);
        response.status(201).json({ material: result.material });
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
        // Shared reads no longer carry file bytes, so the stored blob is
        // fetched only here, for the one material actually being downloaded.
        const bytes =
          material.dataBase64 ??
          (store.readMaterialBlob ? await store.readMaterialBlob(material.id) : null);
        if (!bytes) {
          return response.status(404).json({ error: "Course material is unavailable" });
        }
        const data = Buffer.from(bytes, "base64");
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
        if (!code) {
          return response.status(400).json({ error: "Enter a course join code" });
        }
        // The roll number belongs to the account, so it is never re-entered.
        const submittedRoll = String(request.user.rollNumber || "").trim().toUpperCase();
        const enrollment = await store.update((database) => {
          const requiredCode =
            request.user.role === "ta" ? "taCode" : "studentCode";
          const otherCode =
            request.user.role === "ta" ? "studentCode" : "taCode";
          const course = database.courses.find(
            (item) =>
              item[requiredCode] === code && hasValidCourseOwner(database, item),
          );
          if (!course) {
            const wrongRoleCode = database.courses.some(
              (item) =>
                item[otherCode] === code && hasValidCourseOwner(database, item),
            );
            const error = new Error("Course code not found");
            if (wrongRoleCode) {
              error.message =
                request.user.role === "ta"
                  ? "That is the student join code. Ask the professor for the TA join code."
                  : "That is the TA join code. Ask the professor for the student join code.";
              error.status = 403;
            } else {
              error.status = 404;
            }
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
        // The class's own position is what students are measured against, but
        // it cannot be insisted on: an already-installed app may be physically
        // unable to supply one, and refusing to open attendance would leave a
        // professor with no way to take the register at all. Without it the
        // session simply falls back to Bluetooth-only proof.
        const sessionLocation = normalizeLocation(request.body.location);
        const result = await store.update((database) => {
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
          const requestedScheduleId = String(request.body.scheduleId || "").trim();
          if (
            requestedScheduleId &&
            !database.schedule.some(
              (item) => item.id === requestedScheduleId && item.courseId === courseId,
            )
          ) {
            const error = new Error("Schedule does not belong to this course");
            error.status = 400;
            throw error;
          }
          // Attendance belongs to a class, not to a date. A course that meets
          // twice in a day takes it twice, and every class starts from a blank
          // register rather than inheriting the last one. When the client does
          // not name a class, today's nearest one stands in, so sessions stay
          // keyed to a class even from the one-tap "start attendance" button.
          const scheduleId =
            requestedScheduleId ||
            scheduledClassNow(database, courseId)?.id ||
            null;

          const today = new Date().toISOString().slice(0, 10);
          const heldToday = database.attendanceSessions.filter(
            (item) =>
              item.courseId === courseId &&
              item.startedAt &&
              item.startedAt.slice(0, 10) === today,
          );
          // A repeat of the same class today is a double-tap, not a second
          // class. Two *different* classes are two registers and both go ahead,
          // however soon after each other they start.
          const sameClass =
            scheduleId && heldToday.some((item) => item.scheduleId === scheduleId);
          // When either side has no class attached — an unscheduled class, or a
          // session saved before attendance was tied to a class — there is
          // nothing to compare, so only timing can tell a double-tap from a
          // genuine second class.
          const justOpened = heldToday.some(
            (item) =>
              (!item.scheduleId || !scheduleId) &&
              Date.now() - Date.parse(item.startedAt) < FIVE_MINUTES,
          );
          if (sameClass || justOpened) {
            const error = new Error(
              sameClass
                ? "Attendance was already taken for this class today. Reopen that session to add missed students."
                : "Attendance for this course was opened moments ago. Reopen that session to add missed students.",
            );
            error.status = 409;
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
            // Where the class is being held, so a student's own fix can be
            // compared against it.
            location: sessionLocation,
            startedBy: request.user.id,
            startedAt: new Date().toISOString(),
            status: "open",
            proximitySecret: randomToken(),
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
          const deliveries = addCourseNotifications(database, {
            courseId,
            actorId: request.user.id,
            type: "attendance",
            title: "Attendance is open",
            body: "Mark yourself present with Wi-Fi and Bluetooth switched on.",
            route: "attendance",
            data: {
              attendanceId: created.id,
              ...(created.scheduleId ? { scheduleId: created.scheduleId } : {}),
            },
            studentsOnly: true,
          });
          return { session: created, deliveries };
        });
        await deliverNotificationsWithoutBlocking(result.deliveries);
        response.status(201).json({ attendance: publicAttendance(result.session) });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/api/attendance/past",
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
        // Which class a register belongs to, so a course meeting twice in a
        // day is not two identical-looking entries in the history dropdown.
        const classById = new Map(data.schedule.map((item) => [item.id, item]));
        const sessions = data.attendanceSessions
          .filter(
            (item) =>
              accessibleIds.has(item.courseId) &&
              (!courseId || item.courseId === courseId) &&
              item.status === "closed",
          )
          .map((item) => ({
            classLabel: classLabelFor(classById.get(item.scheduleId)),
            id: item.id,
            courseId: item.courseId,
            scheduleId: item.scheduleId,
            startedAt: item.startedAt,
            closedAt: item.closedAt,
            present: item.records.filter((r) => r.present).length,
            total: item.records.length,
          }))
          .reverse();
        response.json({ sessions });
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
        // An open session is the live one. Otherwise only today's counts as
        // current: falling back to the newest session of any age made the app
        // open on yesterday's register, which then looked like today's class
        // had already been taken. Older sessions are reached through history.
        const today = new Date().toISOString().slice(0, 10);
        const attendance =
          [...sessions].reverse().find((item) => item.status === "open") ||
          [...sessions]
            .reverse()
            .find((item) => item.startedAt && item.startedAt.slice(0, 10) === today);
        response.json({ attendance: publicAttendance(attendance) || null });
      } catch (error) {
        next(error);
      }
    },
  );

  // Must stay ahead of "/api/attendance/:id" so "open" is not read as an id.
  app.get(
    "/api/attendance/:id/code",
    authenticate,
    requireRoles("faculty", "ta"),
    async (request, response, next) => {
      try {
        const data = await store.read();
        const session = data.attendanceSessions.find(
          (item) => item.id === request.params.id,
        );
        if (!session || session.status !== "open") {
          return response.status(404).json({ error: "Attendance is not open" });
        }
        requireCourse(data, request.user, session.courseId, "run");
        if (!session.proximitySecret) {
          // Sessions opened before this existed cannot prove proximity.
          return response.json({ code: "", expiresInMs: 0, supported: false });
        }
        response.json({
          code: proximityCodeFor(session.proximitySecret),
          expiresInMs: PROXIMITY_WINDOW_MS - (Date.now() % PROXIMITY_WINDOW_MS),
          supported: true,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  // A student's own record: every session held, whether they were present, and
  // the running percentage.
  app.get(
    "/api/attendance/history",
    authenticate,
    async (request, response, next) => {
      try {
        const data = await store.read();
        const courseId = String(request.query.courseId || "").trim();
        const enrolments = data.enrollments.filter(
          (item) =>
            item.userId === request.user.id && (!courseId || item.courseId === courseId),
        );
        const byCourse = new Map(enrolments.map((item) => [item.courseId, item]));
        const sessions = data.attendanceSessions
          .filter((session) => byCourse.has(session.courseId))
          .map((session) => {
            const course = data.courses.find((item) => item.id === session.courseId);
            const rollNumber =
              byCourse.get(session.courseId)?.rollNumber || request.user.rollNumber || "";
            const record = (session.records || []).find(
              (item) => item.rollNumber === rollNumber,
            );
            const scheduled = data.schedule.find((item) => item.id === session.scheduleId);
            return {
              id: session.id,
              courseId: session.courseId,
              courseCode: course?.courseCode || "",
              courseName: course?.name || "",
              startedAt: session.startedAt,
              closedAt: session.closedAt || null,
              status: session.status,
              room: scheduled?.room || course?.room || "",
              classLabel: scheduled
                ? `${scheduled.day} · ${scheduled.start}${scheduled.end ? `–${scheduled.end}` : ""}`
                : "",
              onRoster: Boolean(record),
              present: Boolean(record?.present),
              markedAt: record?.present ? record.markedAt : null,
              markedVia: record?.markedVia || "",
            };
          })
          .filter((session) => session.onRoster)
          .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));

        const held = sessions.length;
        const attended = sessions.filter((session) => session.present).length;
        response.json({
          summary: {
            held,
            attended,
            missed: held - attended,
            percentage: held ? Math.round((attended / held) * 1000) / 10 : 0,
          },
          sessions,
        });
      } catch (error) {
        next(error);
      }
    },
  );

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
        response.json({ attendance: publicAttendance(attendance) });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/attendance/:id/reopen",
    authenticate,
    requireRoles("faculty", "ta"),
    async (request, response, next) => {
      try {
        const attendance = await store.update((database) => {
          const session = database.attendanceSessions.find(
            (item) => item.id === request.params.id && item.status === "closed",
          );
          if (!session) {
            const error = new Error("No closed session found to reopen");
            error.status = 404;
            throw error;
          }
          requireCourse(database, request.user, session.courseId, "run");
          // Close any other open session for this course first.
          database.attendanceSessions.forEach((item) => {
            if (item.status === "open" && item.courseId === session.courseId) {
              item.status = "closed";
              item.closedAt = new Date().toISOString();
              item.closedBy = request.user.id;
            }
          });
          session.status = "open";
          session.proximitySecret = session.proximitySecret || randomToken();
          delete session.closedAt;
          delete session.closedBy;
          return session;
        });
        response.json({ attendance: publicAttendance(attendance) });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/attendance/:id/add-student",
    authenticate,
    requireRoles("faculty", "ta"),
    async (request, response, next) => {
      try {
        const rollNumber = String(request.body.rollNumber || "").trim().toUpperCase();
        if (!rollNumber) {
          return response.status(400).json({ error: "Roll number is required" });
        }
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
          // Already on this session's roster?
          if (session.records.some((r) => r.rollNumber === rollNumber)) {
            const existing = session.records.find((r) => r.rollNumber === rollNumber);
            existing.present = true;
            existing.markedAt = new Date().toISOString();
            existing.markedBy = request.user.id;
            return session;
          }
          // Must be an enrolled student or on the course roster.
          const roster = courseRoster(database, session.courseId);
          const student = roster.find((r) => r.rollNumber === rollNumber);
          if (!student) {
            const error = new Error(
              "This roll number is not on the course roster. Add them on the Students tab first.",
            );
            error.status = 400;
            throw error;
          }
          session.records.push({
            ...attendanceRecord(student),
            present: true,
            markedAt: new Date().toISOString(),
            markedBy: request.user.id,
          });
          return session;
        });
        response.json({ attendance: publicAttendance(attendance) });
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
        const submittedCode = String(request.body.code || "").trim().toUpperCase();
        // The roll number belongs to the account, so it is never re-entered.
        const submittedRoll = String(request.user.rollNumber || "").trim().toUpperCase();
        const studentLocation = normalizeLocation(request.body.location);

        const result = await store.update((database) => {
          const session = database.attendanceSessions.find(
            (item) => item.id === request.params.id && item.status === "open",
          );
          if (!session) {
            const error = new Error("Attendance is not open for this course");
            error.status = 404;
            throw error;
          }
          if (session.proximitySecret) {
            // The previous window is accepted so a code cannot expire mid-tap.
            const accepted = [0, -1].map((offset) =>
              proximityCodeFor(session.proximitySecret, offset),
            );
            if (!accepted.includes(submittedCode)) {
              const error = new Error(
                submittedCode
                  ? "That code is wrong or has expired — read the current one from the class screen"
                  : "Enter the code shown on the class screen",
              );
              error.status = 403;
              throw error;
            }
          }
          // Two signals, each covering the other's weakness. The beacon token
          // above already proves Bluetooth contact, which no phone outside the
          // building can fake. Location then confirms the student is at the
          // venue rather than relaying a token from elsewhere.
          //
          // When either side cannot produce a fix the mark still stands on the
          // Bluetooth proof alone. An app already installed on a phone may have
          // no way to ask for the location permission, and locking those
          // students out of attendance is a worse outcome than a mark resting
          // on one signal. Which signals were used is recorded either way.
          const agreement = locationAgrees(
            session.location,
            studentLocation,
            geofenceMetres,
          );
          if (agreement.verified && !agreement.within) {
            const error = new Error(
              `You appear to be about ${agreement.distance} m from this class. Attendance can only be marked from the classroom.`,
            );
            error.status = 403;
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
          // What each signal actually measured, kept so a disputed mark can be
          // examined rather than argued about.
          record.proximity = {
            bluetoothMetres: Number.isFinite(Number(request.body.bluetoothDistanceMeters))
              ? Math.round(Number(request.body.bluetoothDistanceMeters))
              : null,
            locationMetres: agreement.verified ? agreement.distance : null,
            locationAccuracy: studentLocation ? Math.round(studentLocation.accuracy) : null,
            // False when a fix was unavailable on either side, so a mark resting
            // on Bluetooth alone can be told apart from one both signals agreed on.
            locationVerified: agreement.verified,
          };
          return {
            courseId: session.courseId,
            rollNumber,
            markedAt: record.markedAt,
            proximity: record.proximity,
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
          const course = requireCourse(database, request.user, session.courseId, "run");
          const recordByRoll = new Map(
            session.records.map((record) => [record.rollNumber, record]),
          );
          const changed = [];
          for (const update of updates) {
            const rollNumber = String(update.rollNumber || "").trim().toUpperCase();
            const record = recordByRoll.get(rollNumber);
            if (!record) {
              const error = new Error("A submitted roll number is not in this roster");
              error.status = 400;
              throw error;
            }
            const present = update.present === true;
            // Only a real change is worth telling a student about; re-saving
            // the same value must not spam them.
            if (record.present !== present) changed.push({ rollNumber, present });
            record.present = present;
            record.markedAt = new Date().toISOString();
            record.markedBy = request.user.id;
          }

          // The course team overrode a student's mark, so that student is told.
          const label = course.courseCode || course.name || "your class";
          const enrolmentByRoll = new Map(
            database.enrollments
              .filter(
                (enrollment) =>
                  enrollment.courseId === session.courseId &&
                  enrollment.courseRole === "student",
              )
              .map((enrollment) => [enrollment.rollNumber, enrollment]),
          );
          const entries = changed
            .map(({ rollNumber, present }) => {
              const enrollment = enrolmentByRoll.get(rollNumber);
              if (!enrollment || enrollment.userId === request.user.id) return null;
              return {
                userId: enrollment.userId,
                type: "attendance",
                title: present
                  ? `Marked present in ${label}`
                  : `Marked absent in ${label}`,
                body: present
                  ? `${request.user.name} recorded you as present.`
                  : `${request.user.name} recorded you as absent.`,
                courseId: session.courseId,
                route: "attendance",
                data: { attendanceId: session.id, present: present ? "1" : "0" },
              };
            })
            .filter(Boolean);

          return { session, deliveries: addPersonalNotifications(database, entries) };
        });
        await deliverNotificationsWithoutBlocking(attendance.deliveries);
        response.json({ attendance: publicAttendance(attendance.session) });
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
          const course = requireCourse(database, request.user, session.courseId, "run");
          session.status = "closed";
          session.closedAt = new Date().toISOString();
          session.closedBy = request.user.id;

          // Closing the register is the moment a student's own result becomes
          // final, so each one is told what it was rather than having to open
          // the app and look. This is also the only notice an absent student
          // gets, which is the one that actually matters to them.
          const label = course.courseCode || course.name || "your class";
          const entries = database.enrollments
            .filter(
              (enrollment) =>
                enrollment.courseId === session.courseId &&
                enrollment.courseRole === "student" &&
                enrollment.userId !== request.user.id,
            )
            .map((enrollment) => {
              const record = (session.records || []).find(
                (item) => item.rollNumber === enrollment.rollNumber,
              );
              if (!record) return null;
              return {
                userId: enrollment.userId,
                type: "attendance",
                title: record.present
                  ? `Marked present in ${label}`
                  : `Marked absent in ${label}`,
                body: record.present
                  ? "Attendance has closed and you were recorded present."
                  : "Attendance has closed and you were recorded absent. Speak to your professor if that is wrong.",
                courseId: session.courseId,
                route: "attendance",
                data: { attendanceId: session.id, present: record.present ? "1" : "0" },
              };
            })
            .filter(Boolean);

          return { session, deliveries: addPersonalNotifications(database, entries) };
        });
        await deliverNotificationsWithoutBlocking(attendance.deliveries);
        response.json({ attendance: publicAttendance(attendance.session) });
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
        const result = await store.update((database) => {
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
          let deliveries = [];
          if (!asDraft) {
            addNotice(database, {
              courseId,
              kind: "quiz",
              title: `Quiz published: ${created.title}`,
              body: `${questions.length} question${questions.length === 1 ? "" : "s"}${created.classLabel ? ` · ${created.classLabel}` : ""}.`,
              authorId: request.user.id,
              authorName: request.user.name,
            });
            deliveries = addCourseNotifications(database, {
              courseId,
              actorId: request.user.id,
              type: "quiz",
              title: `Quiz published: ${created.title}`,
              body: `${questions.length} question${questions.length === 1 ? "" : "s"}${created.classLabel ? ` · ${created.classLabel}` : ""}.`,
              route: "quizzes",
              data: { quizId: created.id },
            });
          }
          return { quiz: created, deliveries };
        });
        await deliverNotificationsWithoutBlocking(result.deliveries);
        response.status(201).json({ quiz: result.quiz });
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

  // A student's own quiz history: what they answered and what was correct,
  // for their attempts only. Nobody else's marks appear here.
  app.get(
    "/api/quizzes/mine",
    authenticate,
    requireRoles("student"),
    async (request, response, next) => {
      try {
        const data = await store.read();
        const courseId = String(request.query.courseId || "").trim();
        const enrolledIds = new Set(
          data.enrollments
            .filter((item) => item.userId === request.user.id)
            .map((item) => item.courseId),
        );
        const quizzes = data.quizzes
          .filter(
            (quiz) =>
              quiz.status !== "draft" &&
              enrolledIds.has(quiz.courseId) &&
              (!courseId || quiz.courseId === courseId),
          )
          .map((quiz) => {
            const own = quiz.responses.find((item) => item.userId === request.user.id);
            const course = data.courses.find((item) => item.id === quiz.courseId);
            return {
              id: quiz.id,
              courseId: quiz.courseId,
              courseCode: course?.courseCode || "",
              title: quiz.title,
              day: quiz.day || "",
              classLabel: quiz.classLabel || "",
              quizDate: quiz.quizDate || "",
              publishedAt: quiz.publishedAt || quiz.createdAt,
              status: quiz.status,
              attempted: Boolean(own),
              score: own ? Number(own.score) || 0 : null,
              total: quiz.questions.length,
              submittedAt: own?.submittedAt || null,
              // Answers are revealed once the quiz is closed, or straight away
              // when the team chose to reveal after each answer.
              questions:
                own && (quiz.status === "closed" || quiz.reveal === "after-answer")
                  ? quiz.questions.map((question, index) => ({
                      text: question.text,
                      image: question.image || "",
                      options: question.options,
                      answer: question.answer,
                      yourAnswer: own.answers?.[index] ?? null,
                    }))
                  : [],
              revealed: Boolean(
                own && (quiz.status === "closed" || quiz.reveal === "after-answer"),
              ),
            };
          })
          .reverse();
        response.json({ quizzes });
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
            // The team sees the key plus how the class split across options.
            questions: quiz.questions.map((question, index) => {
              const picks = quiz.responses.map((item) => item.answers?.[index]);
              const answered = picks.filter((pick) => Number.isInteger(pick)).length;
              return {
                ...question,
                answered,
                optionCounts: question.options.map(
                  (_option, optionIndex) =>
                    picks.filter((pick) => pick === optionIndex).length,
                ),
                correctCount: picks.filter((pick) => pick === question.answer).length,
              };
            }),
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
        const result = await store.update((database) => {
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
          const deliveries = addCourseNotifications(database, {
            courseId: draft.courseId,
            actorId: request.user.id,
            type: "quiz",
            title: `Quiz published: ${draft.title}`,
            body: `${draft.questions.length} question${draft.questions.length === 1 ? "" : "s"}${draft.classLabel ? ` · ${draft.classLabel}` : ""}.`,
            route: "quizzes",
            data: { quizId: draft.id },
          });
          return { quiz: draft, deliveries };
        });
        await deliverNotificationsWithoutBlocking(result.deliveries);
        response.json({ quiz: result.quiz });
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
    // A rejected email is a configuration problem the caller can act on, so it
    // is reported rather than hidden behind a generic failure.
    if (error.deliveryFailed) {
      console.error(error);
      // 424 rather than 502: the mailer already retried, so this is a settled
      // upstream failure. A 502 would tell the client the server never ran the
      // request and invite it to send the whole sign-up again.
      return response.status(424).json({ error: error.message });
    }
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    response.status(status).json({
      error: error.status ? error.message : "Unexpected server error",
    });
  });

  return { app, store };
}

module.exports = { createApp, isValidEmail, isFacultyEmail };
