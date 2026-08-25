const APP_VERSION = "1.10.0";
const API_BASE = String(window.CAMPUSPULSE_CONFIG?.apiBase || "").replace(/\/+$/, "");
let apiToken = localStorage.getItem("campusPulseApiToken") || "";

// A free-tier API sleeps when idle and takes the better part of a minute to
// wake, and a whole class opening the app at once arrives while it is still
// waking. Without a timeout a request could hang indefinitely; without a retry
// one unlucky moment surfaced to the student as a bare "could not fetch".
const REQUEST_TIMEOUT_MS = 60000;
// A sleeping or restarting instance answers with these before any handler runs,
// so the request provably had no effect and replaying it is safe.
const UNSERVED_STATUSES = new Set([502, 503, 504]);
// Safe to replay only for reads, where a repeat cannot change anything even if
// the first attempt did reach a handler.
const BUSY_STATUSES = new Set([429, 500, 522, 524]);
const RETRY_DELAYS_MS = [800, 2000, 4500];

function isOffline() {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

async function fetchOnce(path, options, headers) {
  // `AbortSignal.timeout` is missing on some older in-app webviews.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${API_BASE}${path}`, {
      method: options.method || "GET",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function apiRequest(path, options = {}) {
  if (!API_BASE) {
    const error = new Error("Backend API is not configured");
    error.code = "API_NOT_CONFIGURED";
    throw error;
  }
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.auth !== false && apiToken) headers.Authorization = `Bearer ${apiToken}`;
  const method = options.method || "GET";
  const isRead = method === "GET" || method === "HEAD";
  const attempts = options.retry === false ? 1 : RETRY_DELAYS_MS.length + 1;

  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      const base = RETRY_DELAYS_MS[attempt - 1];
      // Jitter keeps a room full of phones from retrying in lockstep.
      const wait = base + Math.random() * base * 0.5;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }

    let response;
    try {
      response = await fetchOnce(path, options, headers);
    } catch (error) {
      // A dropped connection, a DNS failure, or our own timeout.
      lastError = new Error(
        isOffline()
          ? "You appear to be offline. Reconnect and try again."
          : "Could not reach CampusPulse. The server may be waking up — trying again.",
      );
      lastError.code = "NETWORK";
      lastError.cause = error;
      continue;
    }

    const worthRetrying =
      UNSERVED_STATUSES.has(response.status) ||
      (isRead && BUSY_STATUSES.has(response.status));
    if (!response.ok && worthRetrying) {
      lastError = new Error(
        response.status === 429
          ? "CampusPulse is busy right now. Trying again."
          : "CampusPulse is starting up. Trying again.",
      );
      lastError.status = response.status;
      continue;
    }

    if (response.status === 204) return null;
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
    if (!response.ok) {
      const error = new Error(
        payload?.error || `Backend request failed (${response.status})`,
      );
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  const failure =
    lastError || new Error("Could not reach CampusPulse. Try again in a moment.");
  if (failure.code === "NETWORK" && !isOffline()) {
    failure.message =
      "Could not reach CampusPulse after several tries. Check your connection, or the server may still be starting up.";
  } else if (failure.status) {
    failure.message =
      "CampusPulse is still busy. Wait a few seconds and try again.";
  }
  throw failure;
}

async function apiFileUpload(path, file) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": file.type || "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name)
    },
    body: file
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Upload failed (${response.status})`);
  }
  return payload;
}

async function materialBlob(materialId) {
  const response = await fetch(
    `${API_BASE}/api/materials/${encodeURIComponent(materialId)}/download`,
    { headers: { Authorization: `Bearer ${apiToken}` } }
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Download failed (${response.status})`);
  }
  return response.blob();
}

function backendConfigured() {
  return Boolean(API_BASE);
}

const defaultState = {
  route: "dashboard",
  userRole: "faculty",
  authenticated: false,
  accountName: "",
  authEmail: "",
  accounts: [],
  backendSchedule: [],
  backendAttendanceId: "",
  attendanceCheckedIn: false,
  backendQuizId: "",
  backendQuizCourseId: "",
  backendQuizTitle: "",
  backendQuizClassLabel: "",
  backendQuizQuestions: [],
  quizResponded: false,
  attendanceStatus: "not_started",
  checks: { wifi: false, bluetooth: false },
  quizPublished: false,
  quizResponses: 0,
  courses: [],
  enrolledCourses: [],
  teachingAssistants: [],
  selectedCourseId: "",
  stats: {},
  statsByCourse: {},
  importedSchedule: []
};

function loadStoredState() {
  try {
    return JSON.parse(localStorage.getItem("campusPulseState") || "{}");
  } catch {
    localStorage.removeItem("campusPulseState");
    return {};
  }
}

let state = { ...defaultState, ...loadStoredState() };
state.courses = defaultState.courses;
state.enrolledCourses = Array.isArray(state.enrolledCourses)
  ? state.enrolledCourses.filter(courseId => defaultState.courses.some(course => course.id === courseId))
  : [];
state.selectedCourseId = String(state.selectedCourseId || "");
delete state.present;
state.importedSchedule = Array.isArray(state.importedSchedule) ? state.importedSchedule : [];
state.backendSchedule = Array.isArray(state.backendSchedule) ? state.backendSchedule : [];
state.backendQuizQuestions = Array.isArray(state.backendQuizQuestions) ? state.backendQuizQuestions : [];
state.teachingAssistants = Array.isArray(state.teachingAssistants) ? state.teachingAssistants : [];
state.stats = state.stats && typeof state.stats === "object" ? state.stats : {};
state.statsByCourse = state.statsByCourse && typeof state.statsByCourse === "object"
  ? state.statsByCourse
  : {};
state.attendanceCheckedIn = Boolean(state.attendanceCheckedIn);
state.quizResponded = Boolean(state.quizResponded);
state.accounts = Array.isArray(state.accounts) ? state.accounts.filter(account => account?.email && account?.passwordHash && account?.role) : [];
state.authenticated = Boolean(state.authenticated);
if (!state.authenticated) {
  state.accountName = "";
  state.authEmail = "";
}
let scanTimer;
let quizTimer;
let activeAttendance = null;
// Open sessions a student may mark themselves present in, polled while signed
// in so the card appears as soon as the professor or an enrolled TA starts attendance.
let openAttendance = [];
let openAttendanceTimer = null;
let enrolledStudents = [];
let quizDrafts = [];
let editingDraftId = "";
let quizHistory = [];
let myQuizzes = [];
let myQuizId = "";
let attendanceHistory = null;
let attendanceDayId = "";
let proximityCode = null;
let beaconToken = "";
// Set whenever the native plugin rejects startBeacon, so the UI can show the
// real reason (e.g. "Turn Bluetooth on") instead of a generic message.
let beaconError = "";
// Set when the installed app is rotating the token for itself in a
// foreground service, which is what lets a locked phone keep a valid beacon
// in the air. iOS and the browser cannot, and are fed a token from here.
let beaconRotating = false;
// Consecutive disagreements between what is on the air and what the server
// says the code is. One is a window boundary landing between two reads.
let beaconMismatches = 0;
// How far this device's clock sits from the server's. Both sides cut the
// token's window from wall-clock time, so the native beacon needs it.
let proximityClockSkewMs = 0;
let proximityTimer = null;
// The session this device is broadcasting for, held apart from
// `activeAttendance` so that opening another screen, or looking at another
// course, cannot silently stop the beacon a class is checking in against. The
// token students scan for rotates every 30 seconds, so a broadcast is only as
// alive as the ticker that keeps refreshing it.
let broadcastSessionId = "";
let broadcastCourseId = "";
// The professor/TA's list of past attendance days for the selected course,
// and whichever one is currently open for read-only review (null = today's).
let pastAttendanceSessions = [];
let pastSessionsLoadedFor = "";
let pastSessionsStatus = "idle";
let pastSessionsError = "";
let viewingPastAttendance = null;
let viewingPastAttendanceOriginRoute = "attendance";
// The student whose whole record the course team is looking at, if any.
let studentRecord = null;
// Which exam a marks spreadsheet is about to be recorded against.
let pendingMarksUpload = null;
// What is typed into the search box on the register and the student list.
let rosterSearch = "";
let studentSearch = "";
// The marks grid for the selected course, so totals can be shown and prefilled.
let courseMarks = null;
let courseMarksLoadedFor = "";

// Matches a student by name or roll number, ignoring case, spacing and the
// punctuation that creeps into a roll number when it is copied around.
function matchesSearch(student, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return true;
  const name = String(student?.name || "").toLowerCase();
  const roll = String(student?.rollNumber || "").toLowerCase();
  if (name.includes(needle) || roll.includes(needle)) return true;
  // Whatever else the roll list carried is searchable too, so a professor can
  // find someone by the email or hall the sheet listed against them.
  const details = [student?.email, student?.phone, ...Object.values(student?.extra || {})];
  if (details.some((value) => String(value || "").toLowerCase().includes(needle))) return true;
  const loose = (value) => value.replace(/[^a-z0-9]/g, "");
  return loose(roll).includes(loose(needle));
}

function searchBox(id, value, placeholder) {
  return `<label class="roster-search">
    <span class="visually-hidden">${escapeHtml(placeholder)}</span>
    <input class="text-input" id="${id}" type="search" value="${escapeHtml(value)}"
      placeholder="${escapeHtml(placeholder)}" autocomplete="off" data-search-box />
  </label>`;
}
// Rows being edited in the exams card, held separately from the saved list so
// an unsaved addition survives a re-render.
let examDraft = null;

function examEditorRows() {
  if (examDraft) return examDraft;
  return (courseMarks?.exams || EXAM_CHOICES.map(exam => ({ ...exam, maxMarks: null })))
    .map(exam => ({ id: exam.id, label: exam.label, maxMarks: exam.maxMarks ?? null }));
}

// Reads whatever is currently typed into the card, so nothing is lost when a
// row is added or removed.
function readExamRows() {
  return [...view.querySelectorAll("[data-exam-row]")].map(row => ({
    id: row.querySelector("[data-exam-id]")?.value || "",
    label: row.querySelector("[data-exam-label]")?.value || "",
    maxMarks: row.querySelector("[data-exam-max]")?.value.trim() || null
  }));
}

const EXAM_CHOICES = [
  { id: "test1", label: "Test 1" },
  { id: "test2", label: "Test 2" },
  { id: "test3", label: "Test 3" },
  { id: "test4", label: "Test 4" },
  { id: "test5", label: "Test 5" },
  { id: "test6", label: "Test 6" },
  { id: "midsem", label: "Mid Sem" },
  { id: "endsem", label: "End Sem" }
];
let courseNotices = [];
let quizResults = null;
let pendingSignup = null;
let passwordResetEmail = "";
// Reset by email is only offered when the server can actually send one.
let emailDeliveryAvailable = false;

async function refreshEmailDeliveryState() {
  if (!backendConfigured()) return;
  try {
    const health = await apiRequest("/api/health", { auth: false });
    const available = Boolean(health.emailDelivery) && health.emailDelivery !== "disabled";
    if (available !== emailDeliveryAvailable) {
      emailDeliveryAvailable = available;
      // Never redraw over someone part-way through entering their code.
      if (!state.authenticated && !pendingSignup) {
        renderLogin(selectedLoginRole, authMode);
      }
    }
  } catch {
    // Sign-in must still work when the health probe cannot be reached.
  }
}
let courseRosters = new Map();
let managedCourseId = "";
let courseMaterials = new Map();
let materialsCourseId = "";
let editingScheduleIndex = -1;
let modalReturnFocus = null;
let selectedLoginRole = state.userRole || "faculty";
let authMode = state.accounts.length ? "login" : "signup";
const view = document.querySelector("#view");
const authRoot = document.querySelector("#authRoot");
const appShell = document.querySelector("#appShell");
const pageTitle = document.querySelector("#pageTitle");
const pageEyebrow = document.querySelector("#pageEyebrow");
const quickAction = document.querySelector("#quickAction");
const courseSwitcher = document.querySelector("#courseSwitcher");
const courseSwitcherWrap = document.querySelector("#courseSwitcherWrap");
const courseSwitcherDropdown = document.querySelector("#courseSwitcherDropdown");
const attendanceLiveBar = document.querySelector("#attendanceLiveBar");
const attendanceLiveText = document.querySelector("#attendanceLiveText");
const profileAvatar = document.querySelector("#profileAvatar");
const profileName = document.querySelector("#profileName");
const profileMeta = document.querySelector("#profileMeta");
const updateBanner = document.querySelector("#updateBanner");
const updateBannerMessage = document.querySelector("#updateBannerMessage");
const updateManager = window.CAMPUSPULSE_UPDATES || null;
const reminderManager = window.CAMPUSPULSE_REMINDERS || null;
const pushManager = window.CAMPUSPULSE_PUSH || null;
const notificationButton = document.querySelector("#notificationButton");
const notificationBadge = document.querySelector("#notificationBadge");
const appMenu = document.querySelector("#appMenu");
const menuScrim = document.querySelector("#menuScrim");
const menuToggle = document.querySelector("#menuToggle");
const menuAvatar = document.querySelector("#menuAvatar");
const menuName = document.querySelector("#menuName");
const menuMeta = document.querySelector("#menuMeta");

function setMenuOpen(open) {
  if (!appMenu) return;
  appMenu.classList.toggle("open", open);
  appMenu.setAttribute("aria-hidden", open ? "false" : "true");
  menuScrim?.classList.toggle("open", open);
  menuToggle?.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) appMenu.querySelector(".app-menu-item")?.focus();
  else if (document.activeElement && appMenu.contains(document.activeElement)) {
    menuToggle?.focus();
  }
}

function closeMenu() {
  setMenuOpen(false);
}

menuToggle?.addEventListener("click", () => setMenuOpen(!appMenu.classList.contains("open")));
menuScrim?.addEventListener("click", closeMenu);
document.querySelector("#menuClose")?.addEventListener("click", closeMenu);
appMenu?.addEventListener("click", event => {
  if (event.target.closest(".app-menu-item")) closeMenu();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && appMenu?.classList.contains("open")) closeMenu();
});

function updateStatusLabel(status) {
  return {
    checking: "Checking",
    downloading: "Downloading",
    ready: "Installs shortly",
    applying: "Applying",
    current: "Up to date",
    error: "Embedded fallback",
    idle: "Automatic",
    unavailable: "Web deployment",
  }[status] || "Automatic";
}

function syncUpdateUi(updateState = updateManager?.state || {}) {
  if (updateBanner) {
    updateBanner.hidden = updateState.status !== "ready";
    if (updateBannerMessage && updateState.message) {
      updateBannerMessage.textContent = updateState.message;
    }
  }
  const status = document.querySelector("#webUpdateStatus");
  const detail = document.querySelector("#webUpdateDetail");
  if (status) status.textContent = updateStatusLabel(updateState.status);
  if (detail && updateState.message) detail.textContent = updateState.message;
}

updateManager?.subscribe(syncUpdateUi);

// A downloaded bundle reloads the webview, so hold it back while a class is
// actually running or a dialog is open, and apply it on the next screen change.
function updatesAreSafeToApply() {
  const attendanceLive =
    activeAttendance?.status === "open" || state.attendanceStatus === "scanning";
  const modalOpen = Boolean(document.querySelector("#modalRoot")?.innerHTML.trim());
  return !attendanceLive && !modalOpen;
}

updateManager?.setApplyGuard?.(updatesAreSafeToApply);

function icon(id) {
  return `<svg aria-hidden="true"><use href="#${id}"/></svg>`;
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function selectedCourse() {
  return state.courses.find(course => course.id === state.selectedCourseId) || state.courses[0] || null;
}

function softComputingCourse() {
  return selectedCourse();
}

function courseCapabilities(course = selectedCourse()) {
  return course?.capabilities || {};
}

function canManageCourse(course = selectedCourse()) {
  return Boolean(courseCapabilities(course).canManageCourse);
}

function canManageSchedule(course = selectedCourse()) {
  return Boolean(courseCapabilities(course).canManageSchedule);
}

function canManageRoster(course = selectedCourse()) {
  return Boolean(courseCapabilities(course).canManageRoster);
}

function canRunAttendance(course = selectedCourse()) {
  return Boolean(courseCapabilities(course).canRunAttendance);
}

function canPublishQuiz(course = selectedCourse()) {
  return Boolean(courseCapabilities(course).canPublishQuiz);
}

function canUploadMaterials(course = selectedCourse()) {
  return Boolean(courseCapabilities(course).canUploadMaterials);
}

function attendanceCourse() {
  return state.courses.find(course => course.id === activeAttendance?.courseId) || selectedCourse();
}

async function loadCourseRoster(courseId, { force = false } = {}) {
  const course = state.courses.find(item => item.id === courseId);
  if (!courseCapabilities(course).canViewAttendanceRoster) {
    throw new Error("You do not have roster access for this course");
  }
  if (!force && courseRosters.has(courseId)) return courseRosters.get(courseId);
  const result = await apiRequest(`/api/courses/${encodeURIComponent(courseId)}/roster`);
  const roster = result.students || [];
  courseRosters.set(courseId, roster);
  return roster;
}

async function loadCourseMaterials(courseId, { force = false } = {}) {
  if (!force && courseMaterials.has(courseId)) return courseMaterials.get(courseId);
  const result = await apiRequest(
    `/api/courses/${encodeURIComponent(courseId)}/materials`
  );
  const materials = result.materials || [];
  courseMaterials.set(courseId, materials);
  return materials;
}

function currentAttendanceRecords() {
  return Array.isArray(activeAttendance?.records) ? activeAttendance.records : [];
}

function currentPresentCount() {
  return currentAttendanceRecords().filter(record => record.present).length;
}

function applyAttendanceSnapshot(attendance) {
  activeAttendance = attendance || null;
  state.backendAttendanceId = attendance?.id || "";
  state.attendanceStatus = attendance
    ? attendance.status === "open" ? "scanning" : "complete"
    : "not_started";
  if (attendance?.courseId) state.selectedCourseId = attendance.courseId;
  // A newly applied snapshot is always today's session, not a past one being
  // browsed, and not a student's record opened from some other course.
  viewingPastAttendance = null;
  studentRecord = null;
}

async function selectAttendanceCourse(courseId) {
  let course = state.courses.find(item => item.id === courseId);
  if (!course) {
    try { await syncBackendState(); } catch { /* best effort */ }
    course = state.courses.find(item => item.id === courseId);
  }
  if (!course) throw new Error("Course not found");
  if (!canRunAttendance(course)) throw new Error("You cannot run attendance for this course");
  state.selectedCourseId = course.id;
  if (activeAttendance?.courseId === course.id) return;
  if (!backendConfigured() || !apiToken) {
    applyAttendanceSnapshot(null);
    return;
  }
  const payload = await apiRequest(
    `/api/attendance/current?courseId=${encodeURIComponent(course.id)}`
  );
  applyAttendanceSnapshot(payload.attendance);
  // Closing the app mid-class, or a bundle update reloading it, must not take
  // the room off the air: an open session picks its beacon back up here rather
  // than waiting for someone to open the register again. A broadcast already
  // running keeps the radio — one device can only advertise one class at once.
  if (!broadcastSessionId && payload.attendance?.status === "open") {
    startAttendanceBroadcast(payload.attendance.id, payload.attendance.courseId);
  }
}

// Lazily loaded once per course so switching back to "today" doesn't refetch.
async function refreshPastSessions(courseId) {
  if (!backendConfigured() || !apiToken || !courseId) {
    pastAttendanceSessions = [];
    pastSessionsLoadedFor = "";
    pastSessionsStatus = "idle";
    pastSessionsError = "";
    return;
  }
  // Clear another course's rows before painting this course. Apart from being
  // misleading, briefly displaying them would leak course-scoped history.
  if (pastSessionsLoadedFor !== courseId) pastAttendanceSessions = [];
  pastSessionsLoadedFor = courseId;
  pastSessionsStatus = "loading";
  pastSessionsError = "";
  try {
    const result = await apiRequest(`/api/attendance/past?courseId=${encodeURIComponent(courseId)}`);
    // Course switching can finish a newer request before this one. Never let
    // the older response overwrite the newly selected course.
    if (pastSessionsLoadedFor !== courseId) return;
    pastAttendanceSessions = result.sessions || [];
    pastSessionsStatus = "ready";
  } catch (error) {
    if (pastSessionsLoadedFor !== courseId) return;
    pastSessionsStatus = "error";
    pastSessionsError = error?.message || "Could not load previous attendance.";
  }
}

// The history picker belongs on the attendance page at all times, not only
// while a session happens to be open: the commonest reason to open attendance
// on a quiet day is to look up what a past class recorded.
function pastSessionsPicker() {
  const current = viewingPastAttendance?.id || "";
  if (pastSessionsStatus === "loading") {
    return `<label class="past-session-picker">
      <span>Previous classes</span>
      <select class="select" id="pastSessionSelect" disabled><option>Loading attendance history…</option></select>
    </label>`;
  }
  if (pastSessionsStatus === "error") {
    return `<div class="past-session-picker history-inline-error">
      <span>Previous classes</span>
      <button class="btn" type="button" data-action="retry-past-sessions">Retry history</button>
    </div>`;
  }
  if (!pastAttendanceSessions.length) {
    return `<label class="past-session-picker">
      <span>Previous classes</span>
      <select class="select" id="pastSessionSelect" disabled>
        <option value="">No classes recorded yet</option>
      </select>
    </label>`;
  }
  return `<label class="past-session-picker">
    <span>Previous classes</span>
    <select class="select" id="pastSessionSelect">
      <option value="">${activeAttendance ? "Today's session" : "Choose a class…"}</option>
      ${pastAttendanceSessions.map(session => `<option value="${escapeHtml(session.id)}" ${current === session.id ? "selected" : ""}>${escapeHtml(pastSessionLabel(session))}</option>`).join("")}
    </select>
  </label>`;
}

// Every register is one class on one day, so the label needs both. A course
// meeting twice on a Tuesday would otherwise show two identical entries.
function pastSessionLabel(session) {
  const started = new Date(session.startedAt);
  const day = started.toLocaleDateString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  const parts = [day];
  if (session.classLabel) parts.push(session.classLabel);
  else if (session.importedAt) parts.push("Paper register");
  else parts.push(started.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  parts.push(`${session.present}/${session.total} present`);
  return parts.join(" · ");
}

/** A past register's turnout as a whole percentage. */
function sessionTurnout(session) {
  return session.total ? Math.round((session.present / session.total) * 100) : 0;
}

function turnoutTone(percentage) {
  return percentage >= 75 ? "green" : percentage >= 50 ? "amber" : "gray";
}

// What the register adds up to across the course. A professor opening
// attendance on a quiet day is usually there to look back, not to start
// something, so the page leads with the shape of the term rather than with an
// empty setup form.
function attendanceOverview() {
  if (!pastAttendanceSessions.length) return "";
  const possible = pastAttendanceSessions.reduce((sum, item) => sum + (item.total || 0), 0);
  const attended = pastAttendanceSessions.reduce((sum, item) => sum + (item.present || 0), 0);
  // Averaged over seats rather than over classes, so a class with a fuller
  // roll list counts for proportionally more.
  const average = possible ? Math.round((attended / possible) * 100) : 0;
  const turnouts = pastAttendanceSessions.filter(item => item.total).map(sessionTurnout);
  const lowest = turnouts.length ? Math.min(...turnouts) : 0;
  return `
    <article class="card page-card">
      <div class="section-head"><div><h2 style="margin:0 0 5px">Attendance so far</h2><p class="stat-label">Across every class recorded for this course.</p></div><span class="badge ${turnoutTone(average)}">${average}%</span></div>
      <div class="stat-grid" style="margin-top:18px">
        <article class="card stat"><div class="stat-top"><span class="stat-icon">${icon("i-calendar")}</span></div><div class="stat-value">${pastAttendanceSessions.length}</div><div class="stat-label">Classes held</div></article>
        <article class="card stat"><div class="stat-top"><span class="stat-icon green">${icon("i-check")}</span><span class="trend">${attended} of ${possible}</span></div><div class="stat-value">${average}%</div><div class="stat-label">Average attendance</div></article>
        <article class="card stat"><div class="stat-top"><span class="stat-icon amber">${icon("i-clock")}</span></div><div class="stat-value">${lowest}%</div><div class="stat-label">Lowest turnout</div></article>
      </div>
    </article>`;
}

// The dropdown is right for switching classes while a register is on screen,
// but on the setup page the past classes are the reason to be there at all, so
// they are listed instead of hidden inside a select.
function pastSessionsListCard({ hideStatus = false } = {}) {
  if (pastSessionsStatus === "loading") {
    return hideStatus ? "" : `<article class="card page-card history-status-card" aria-live="polite">
      <span class="history-spinner" aria-hidden="true"></span><div><h2>Loading previous classes</h2><p>Fetching the attendance registers saved for this course.</p></div>
    </article>`;
  }
  if (pastSessionsStatus === "error") {
    return hideStatus ? "" : `<article class="card page-card history-status-card history-error" role="alert">
      <span class="empty-icon">${icon("i-cloud")}</span><div><h2>Attendance history unavailable</h2><p>${escapeHtml(pastSessionsError)}</p><button class="btn" type="button" data-action="retry-past-sessions">Try again</button></div>
    </article>`;
  }
  if (!pastAttendanceSessions.length) {
    return `<article class="card page-card">
      <div class="section-head"><div><h2 style="margin:0 0 5px">Previous classes</h2><p class="stat-label">Registers already taken for this course.</p></div><span class="badge gray">0</span></div>
      <p class="stat-label">No class recorded yet. Each register appears here once you close it.</p>
    </article>`;
  }
  return `<article class="card page-card">
    <div class="section-head"><div><h2 style="margin:0 0 5px">Previous classes</h2><p class="stat-label">Open one to see who was there.</p></div><span class="badge gray">${pastAttendanceSessions.length}</span></div>
    <div class="class-list">
      ${pastAttendanceSessions.map(session => {
        const started = new Date(session.startedAt);
        const share = sessionTurnout(session);
        // The register already on screen is marked, so the list reads as a
        // place in the term rather than a set of identical-looking links.
        const open = viewingPastAttendance?.id === session.id;
        return `<button class="class-row attendance-day" type="button" data-action="open-past-session" data-session-id="${escapeHtml(session.id)}"${open ? ' aria-current="true"' : ""}>
          <div class="time">${escapeHtml(started.toLocaleDateString([], { weekday: "short" }))}<small>${escapeHtml(started.toLocaleDateString([], { day: "numeric", month: "short" }))}</small></div>
          <div class="course"><strong>${escapeHtml(session.classLabel || (session.importedAt ? "Paper register" : started.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })))}</strong><span>${session.present}/${session.total} present</span></div>
          <span class="badge ${open ? "purple" : turnoutTone(share)}">${open ? "Viewing" : `${share}%`}</span>
          <span class="chevron">${icon("i-arrow")}</span>
        </button>`;
      }).join("")}
    </div>
  </article>`;
}

// One student's whole record in a course: every class held, whether they were
// there, and the running percentage. Available to the course team only.
async function openStudentRecord(courseId, rollNumber) {
  try {
    studentRecord = await apiRequest(
      `/api/courses/${encodeURIComponent(courseId)}/students/${encodeURIComponent(rollNumber)}`
    );
  } catch (error) {
    studentRecord = null;
    return toast(error.message || "Could not open that student's record", "error");
  }
  render();
}

function attendanceMethodLabel(markedVia, { self = false } = {}) {
  if (markedVia === "student-web-wifi") {
    return self ? "You, via classroom Wi‑Fi" : "Student (Web Wi‑Fi)";
  }
  if (markedVia === "student") {
    return self ? "You, via Bluetooth" : "Student (Bluetooth)";
  }
  return markedVia ? "Course team" : "";
}

function renderStudentRecord() {
  const { student, summary, sessions } = studentRecord;
  const percentage = summary.percentage;
  // Only exams that have both a total and a mark can be added up; the rest are
  // still shown so a mark can be typed in.
  const marksTotal = (studentRecord.marks || []).reduce(
    (running, exam) =>
      exam.maxMarks && exam.score !== null
        ? { scored: running.scored + exam.score, outOf: running.outOf + exam.maxMarks }
        : running,
    { scored: 0, outOf: 0 }
  );
  const detail = (label, value) =>
    value ? `<div class="summary-item"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>` : "";
  setHeader(student.name || student.rollNumber, `${student.courseCode} · STUDENT RECORD`, false);
  view.innerHTML = `
    <button class="back-btn" type="button" data-action="go-back">${icon("i-back")} Back</button>
    <div class="page-grid">
      <article class="card page-card">
        <div class="section-head">
          <div>
            <h2 style="margin:0 0 5px">${escapeHtml(student.name || "Unnamed student")}</h2>
            <p class="stat-label">${escapeHtml(student.rollNumber)}${student.serial ? ` · No. ${student.serial}` : ""} · ${escapeHtml(student.courseCode)}</p>
          </div>
          <span class="badge ${percentage >= 75 ? "green" : percentage >= 50 ? "amber" : "red"}">${percentage}%</span>
        </div>
        <div class="stat-grid" style="margin-top:18px">
          <article class="card stat"><div class="stat-top"><span class="stat-icon green">${icon("i-check")}</span></div><div class="stat-value">${summary.attended}</div><div class="stat-label">Present</div></article>
          <article class="card stat"><div class="stat-top"><span class="stat-icon amber">${icon("i-clock")}</span></div><div class="stat-value">${summary.missed}</div><div class="stat-label">Absent</div></article>
          <article class="card stat"><div class="stat-top"><span class="stat-icon">${icon("i-calendar")}</span></div><div class="stat-value">${summary.held}</div><div class="stat-label">Classes held</div></article>
        </div>
        ${student.hasAccount
          ? `<div class="summary-list" style="margin-top:16px">
              ${detail("Email", student.email)}
              ${detail("Department", student.department)}
              ${detail("Phone", student.phone)}
              ${detail("Hall", student.hall)}
              ${detail("Joined", student.joinedAt ? new Date(student.joinedAt).toLocaleDateString() : "")}
            </div>`
          : `<div class="security-note" style="margin-top:16px"><span class="lock">⌾</span><span>On the roll list, but has not signed up yet. Contact details appear once they create an account.</span></div>`}
        <div class="setup-actions" style="margin-top:16px">
          <button class="btn btn-soft" type="button" data-action="export-student-record">${icon("i-download")} Download record</button>
        </div>
      </article>
      <article class="card page-card">
        <div class="section-head"><div><h2 style="margin:0 0 5px">Exam marks</h2><p class="stat-label">${studentRecord.scoresHidden
          ? "You can record a mark here, but marks already recorded are visible to the professor only."
          : "Type a mark and press Enter, or leave it blank if they did not sit the exam."}</p></div><span class="badge ${studentRecord.scoresHidden ? "gray" : marksTotal.outOf ? "purple" : "gray"}">${studentRecord.scoresHidden ? "Hidden" : marksTotal.outOf ? `${marksTotal.scored}/${marksTotal.outOf}` : "Not set up"}</span></div>
        <div class="roster-scroll">
          <table class="roster-table marks-table">
            <thead><tr><th>Exam</th><th>Out of</th><th>Marks</th></tr></thead>
            <tbody>${(studentRecord.marks || []).map(exam => `<tr>
              <td>${escapeHtml(exam.label)}</td>
              <td class="roster-roll">${exam.maxMarks ?? "—"}</td>
              <td>
                <input class="text-input marks-input" type="number" min="0" step="0.5"
                  ${exam.maxMarks ? `max="${exam.maxMarks}"` : ""}
                  value="${exam.score ?? ""}"
                  data-mark-for="${escapeHtml(exam.id)}"
                  aria-label="${escapeHtml(exam.label)} marks"
                  placeholder="—" />
              </td>
            </tr>`).join("")}</tbody>
          </table>
        </div>
        <div class="setup-actions" style="margin-top:14px">
          <button class="btn btn-primary" type="button" data-action="save-student-marks">${icon("i-check")} Save marks</button>
        </div>
      </article>
      <article class="card page-card">
        <div class="section-head"><div><h2 style="margin:0 0 5px">Every class</h2><p class="stat-label">Newest first. Classes held before this student joined the roll list are not counted.</p></div><span class="badge gray">${sessions.length}</span></div>
        ${sessions.length ? `<div class="class-list">
          ${sessions.map(session => {
            const when = new Date(session.startedAt);
            return `<div class="class-row">
              <div class="time">${escapeHtml(when.toLocaleDateString([], { weekday: "short" }))}<small>${escapeHtml(when.toLocaleDateString([], { day: "numeric", month: "short" }))}</small></div>
              <div class="course"><strong>${escapeHtml(session.classLabel || (session.importedAt ? "Paper register" : when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })))}</strong><span>${escapeHtml(session.room || "Room TBA")}${session.present && session.markedVia ? ` · ${escapeHtml(attendanceMethodLabel(session.markedVia))}` : ""}</span></div>
              <span class="badge ${session.present ? "green" : "gray"}">${session.present ? "Present" : "Absent"}</span>
            </div>`;
          }).join("")}
        </div>` : `<p class="stat-label">No attendance has been taken for this course yet.</p>`}
      </article>
    </div>`;
}

// Loads a past (closed) session's full roster for read-only review, or clears
// back to today's session when the dropdown is reset to its default option.
async function openPastAttendanceSession(
  sessionId,
  {
    originRoute = viewingPastAttendance
      ? viewingPastAttendanceOriginRoute
      : state.route,
  } = {}
) {
  // Clearing the picker returns to whatever the page would otherwise show:
  // today's session if one exists, the setup screen if not. Going straight to
  // the live view would leave an empty roster on a day with no session.
  if (!sessionId) {
    viewingPastAttendance = null;
    viewingPastAttendanceOriginRoute = "attendance";
    return renderAttendance();
  }
  try {
    const result = await apiRequest(`/api/attendance/${encodeURIComponent(sessionId)}`);
    viewingPastAttendance = result.attendance;
    viewingPastAttendanceOriginRoute = originRoute;
  } catch (error) {
    viewingPastAttendance = null;
    viewingPastAttendanceOriginRoute = "attendance";
    return toast(error.message || "Could not load that session", "error");
  }
  renderAttendance();
}

function applyQuizSnapshot(quiz) {
  state.backendQuizId = quiz?.id || "";
  state.backendQuizCourseId = quiz?.courseId || "";
  state.backendQuizTitle = quiz?.title || "";
  state.backendQuizClassLabel = quiz?.classLabel || quiz?.day || "";
  state.backendQuizQuestions = quiz?.questions || [];
  state.quizPublished = quiz?.status === "open";
  state.quizResponses = Array.isArray(quiz?.responses) ? quiz.responses.length : 0;
  state.quizResponded = Boolean(quiz?.responded);
}

async function selectQuizCourse(courseId) {
  let course = state.courses.find(item => item.id === courseId);
  if (!course) {
    try { await syncBackendState(); } catch { /* best effort */ }
    course = state.courses.find(item => item.id === courseId);
  }
  if (!course) throw new Error("Course not found");
  if (state.userRole !== "student" && !canPublishQuiz(course)) {
    throw new Error("You cannot publish quizzes for this course");
  }
  state.selectedCourseId = course.id;
  if (!backendConfigured() || !apiToken) {
    applyQuizSnapshot(null);
    return;
  }
  const payload = await apiRequest(
    `/api/quizzes/current?courseId=${encodeURIComponent(course.id)}`
  );
  applyQuizSnapshot(payload.quiz);
}

function clearSensitiveClientState({ clearImportedSchedule = false } = {}) {
  clearInterval(scanTimer);
  clearTimeout(quizTimer);
  clearInterval(openAttendanceTimer);
  clearInterval(proximityTimer);
  proximityTimer = null;
  proximityCode = null;
  broadcastSessionId = "";
  broadcastCourseId = "";
  stopAttendanceBeacon();
  syncAttendanceLiveBar();
  attendanceHistory = null;
  attendanceDayId = "";
  myQuizzes = [];
  myQuizId = "";
  openAttendance = [];
  enrolledStudents = [];
  quizDrafts = [];
  courseRosters = new Map();
  courseMaterials = new Map();
  activeAttendance = null;
  managedCourseId = "";
  materialsCourseId = "";
  state.backendAttendanceId = "";
  state.attendanceStatus = "not_started";
  state.attendanceCheckedIn = false;
  state.backendQuizId = "";
  state.backendQuizCourseId = "";
  state.backendQuizTitle = "";
  state.backendQuizClassLabel = "";
  state.backendQuizQuestions = [];
  state.quizPublished = false;
  state.quizResponded = false;
  state.courses = defaultState.courses;
  state.enrolledCourses = [];
  state.teachingAssistants = [];
  state.selectedCourseId = "";
  state.stats = {};
  state.statsByCourse = {};
  state.backendSchedule = [];
  if (clearImportedSchedule) state.importedSchedule = [];
  if (view) view.innerHTML = "";
}

function persist() {
  state.appVersion = APP_VERSION;
  localStorage.setItem("campusPulseState", JSON.stringify(state));
}

// The browser's own `pattern` check, kept deliberately permissive so it never
// rejects an address the server would accept.
const EMAIL_INPUT_PATTERN =
  "[A-Za-z0-9][A-Za-z0-9._%+\\-]*@[A-Za-z0-9](?:[A-Za-z0-9\\-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9\\-]{0,61}[A-Za-z0-9])?)*\\.[A-Za-z]{2,63}";

const loginProfiles = {
  faculty: {
    title: "Professor login",
    shortTitle: "Professor",
    description: "Create and manage your exclusive courses, rosters, attendance, and quizzes.",
    idLabel: "Email address",
    emailLabel: "Email address",
    placeholder: "you@example.com",
    emailPattern: EMAIL_INPUT_PATTERN,
    emailTitle: "Any email address you can receive mail at",
    emailHelp: "Any address you can receive mail at — an institute one, Gmail, anything.",
    emailError: "Enter a valid email address",
    initials: "PF",
    name: "Professor Demo"
  },
  ta: {
    title: "Teaching Assistant login",
    shortTitle: "TA",
    description: "Sign in like a student, then use the TA course code to access teaching-team tools.",
    idLabel: "Email address",
    emailLabel: "Email address",
    placeholder: "you@example.com",
    emailPattern: EMAIL_INPUT_PATTERN,
    emailTitle: "Any email address you can receive mail at",
    emailHelp: "Any address you can receive mail at — an institute one, Gmail, anything.",
    emailError: "Enter a valid email address",
    initials: "TA",
    name: "Teaching Assistant"
  },
  student: {
    title: "Student login",
    shortTitle: "Student",
    description: "Join professor-owned courses by code, mark your attendance when class starts, take quizzes, and view your calendar.",
    idLabel: "Email address",
    emailLabel: "Email address",
    placeholder: "you@example.com",
    emailPattern: EMAIL_INPUT_PATTERN,
    emailTitle: "Any email address you can receive mail at",
    emailHelp: "Any address you can receive mail at — an institute one, Gmail, anything.",
    emailError: "Enter a valid email address",
    initials: "ST",
    name: "Student Demo"
  }
};

// Shown from the moment the app starts until the saved session is either
// restored or found to be gone. Restoring it is a chain of requests that each
// retry for up to a minute, so without something painted here the app is a
// blank white page for as long as the network is slow — which reads to a
// student as "the app is broken", not "the app is loading".
let bootSplashTimer = null;

function bindBootSplashMotion() {
  const splash = authRoot.querySelector("[data-boot-splash]");
  const visual = splash?.querySelector(".boot-visual");
  if (
    !splash ||
    !visual ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  ) return;
  let frame = 0;

  function move(event) {
    const point = event.touches?.[0] || event;
    const bounds = splash.getBoundingClientRect();
    const x = Math.max(-1, Math.min(1, (point.clientX - bounds.left) / bounds.width * 2 - 1));
    const y = Math.max(-1, Math.min(1, (point.clientY - bounds.top) / bounds.height * 2 - 1));
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      visual.style.setProperty("--boot-x", `${(x * 10).toFixed(2)}px`);
      visual.style.setProperty("--boot-y", `${(y * 8).toFixed(2)}px`);
      visual.style.setProperty("--boot-rotate-x", `${(-y * 7).toFixed(2)}deg`);
      visual.style.setProperty("--boot-rotate-y", `${(x * 7).toFixed(2)}deg`);
    });
  }

  function reset() {
    visual.style.setProperty("--boot-x", "0px");
    visual.style.setProperty("--boot-y", "0px");
    visual.style.setProperty("--boot-rotate-x", "0deg");
    visual.style.setProperty("--boot-rotate-y", "0deg");
  }

  splash.addEventListener("pointermove", move, { passive: true });
  splash.addEventListener("pointerleave", reset, { passive: true });
}

function renderBootSplash() {
  appShell.hidden = true;
  authRoot.hidden = false;
  authRoot.innerHTML = `
    <div class="boot-splash" data-boot-splash role="status" aria-label="CampusPulse is loading">
      <div class="boot-visual" aria-hidden="true">
        <span class="boot-orbit boot-orbit-outer"><i></i></span>
        <span class="boot-orbit boot-orbit-inner"><i></i></span>
        <span class="boot-pulse"></span>
        <span class="boot-logo">C</span>
      </div>
      <div class="boot-wordmark">Campus<span>Pulse</span></div>
      <p class="boot-message" id="bootMessage">Signing you in…</p>
      <div class="boot-progress" aria-hidden="true"><span></span></div>
    </div>`;
  bindBootSplashMotion();
  clearTimeout(bootSplashTimer);
  bootSplashTimer = setTimeout(() => {
    const message = document.querySelector("#bootMessage");
    if (message) {
      message.textContent =
        "Still syncing your latest campus data. A slow connection can take a little longer.";
    }
  }, 6000);
}

function clearBootSplash() {
  clearTimeout(bootSplashTimer);
  bootSplashTimer = null;
}

// The saved session is still believed good; we simply could not reach the
// server. Signing the student out here would lose their session over a bad
// signal, so offer a retry instead.
function renderSessionRetry(error) {
  clearBootSplash();
  appShell.hidden = true;
  authRoot.hidden = false;
  authRoot.innerHTML = `
    <div class="boot-splash">
      <div class="auth-brand"><span class="brand-mark">C</span><span class="brand-name">Campus<span>Pulse</span></span></div>
      <p class="boot-message">${escapeHtml(
        error?.message || "Could not reach CampusPulse."
      )}</p>
      <div class="boot-actions">
        <button class="btn btn-primary" type="button" data-action="retry-session">Try again</button>
        <button class="text-btn" type="button" data-action="sign-out-stuck">Sign in with a different account</button>
      </div>
    </div>`;
}

function renderLogin(role = selectedLoginRole, mode = authMode) {
  clearBootSplash();
  pendingSignup = null;
  courseRosters = new Map();
  courseMaterials = new Map();
  activeAttendance = null;
  managedCourseId = "";
  materialsCourseId = "";
  if (courseSwitcherWrap) courseSwitcherWrap.hidden = true;
  closeMenu();
  if (view) view.innerHTML = "";
  selectedLoginRole = loginProfiles[role] ? role : "faculty";
  authMode = ["login", "signup", "forgot", "reset"].includes(mode) ? mode : "signup";
  const profile = loginProfiles[selectedLoginRole];
  appShell.hidden = true;
  authRoot.hidden = false;
  authRoot.innerHTML = `
    <div class="auth-layout">
      <section class="auth-story">
        <div class="auth-brand"><span class="brand-mark">C</span><span class="brand-name">Campus<span>Pulse</span></span></div>
        <div class="auth-story-copy">
          <span class="auth-kicker">ONE CAMPUS · THREE WORKSPACES</span>
          <h1>Your classroom, on schedule.</h1>
          <p>Professor-owned courses, teaching-team attendance, short quizzes, and a shared academic calendar.</p>
        </div>
        <div class="auth-feature-row">
          <span>${icon("i-calendar")} Shared calendar</span>
          <span>${icon("i-users")} Official course rosters</span>
          <span>${icon("i-lock")} Private course access</span>
        </div>
      </section>
      <section class="auth-panel">
        <div class="auth-card">
          <div class="auth-heading">
            <span class="auth-icon">${profile.initials}</span>
            <div><p>Welcome to CampusPulse</p><h2>${authMode === "signup" ? `${profile.shortTitle} sign-up` : profile.title}</h2></div>
          </div>
          <div class="auth-role-grid" role="tablist" aria-label="Choose login type">
            ${Object.entries(loginProfiles).map(([key, item]) => `
              <button type="button" class="auth-role ${key === selectedLoginRole ? "active" : ""}" data-auth-role="${key}" role="tab" aria-selected="${key === selectedLoginRole}">
                <span>${item.initials}</span><strong>${item.shortTitle}</strong>
              </button>`).join("")}
          </div>
          <div class="auth-mode-switch" role="tablist" aria-label="Account action">
            <button type="button" class="${authMode === "signup" ? "active" : ""}" data-auth-mode="signup">Create account</button>
            <button type="button" class="${authMode !== "signup" ? "active" : ""}" data-auth-mode="login">Sign in</button>
          </div>
          <p class="auth-description">${profile.description}</p>
          ${authMode === "signup" ? `
          <form id="signupForm" class="login-form">
            <input type="hidden" name="role" value="${selectedLoginRole}" />
            <label for="signupName">Full name</label>
            <input id="signupName" name="name" type="text" placeholder="Enter your full name" autocomplete="name" minlength="2" required />
            <label for="signupDepartment">Department</label>
            <input id="signupDepartment" name="department" type="text" placeholder="e.g. Mechanical Engineering" autocomplete="organization" minlength="2" maxlength="120" required />
            <label for="signupEmail">${profile.emailLabel}</label>
            <input id="signupEmail" name="email" type="email" placeholder="${profile.placeholder}" autocomplete="email" pattern="${profile.emailPattern}" title="${profile.emailTitle}" aria-describedby="signupEmailHelp" required />
            <p class="auth-field-help" id="signupEmailHelp">${profile.emailHelp}</p>
            <div class="auth-field-pair">
              <div><label for="signupPassword">Password</label><input id="signupPassword" name="password" type="password" placeholder="At least 8 characters" autocomplete="new-password" minlength="8" required /></div>
              <div><label for="signupConfirm">Confirm password</label><input id="signupConfirm" name="confirmPassword" type="password" placeholder="Repeat password" autocomplete="new-password" minlength="8" required /></div>
            </div>
            <label for="signupPhone">Contact number</label>
            <input id="signupPhone" name="phone" type="tel" placeholder="10-digit mobile number" autocomplete="tel" required />
            ${selectedLoginRole === "faculty" ? "" : `
            <div class="auth-field-pair">
              <div><label for="signupRoll">Roll number</label><input id="signupRoll" name="rollNumber" type="text" placeholder="e.g. 23ME10001" autocomplete="off" maxlength="40" required /></div>
              <div><label for="signupHall">Hall of residence <span class="field-optional">(optional)</span></label><input id="signupHall" name="hall" type="text" placeholder="e.g. Azad Hall" autocomplete="off" maxlength="80" /></div>
            </div>`}
            <button class="btn btn-primary auth-submit" type="submit">${icon("i-arrow")} Create account & sign in</button>
          </form>
          <div class="auth-demo-note"><span>Any email address</span><p>${profile.emailHelp} We email a six-digit code to confirm it before the account is created.</p></div>` : `
          ${authMode === "forgot" ? `
          <form id="forgotPasswordForm" class="login-form">
            <label for="forgotEmail">Registered email</label>
            <input id="forgotEmail" name="email" type="email" placeholder="${profile.placeholder}" autocomplete="username" required />
            <button class="btn btn-primary auth-submit" type="submit">${icon("i-send")} Email me a reset code</button>
          </form>
          <div class="verification-actions"><button type="button" class="text-btn" data-auth-mode="login">Back to sign in</button><button type="button" class="text-btn" data-auth-mode="reset">I already have a code</button></div>
          <div class="auth-demo-note"><span>Registered address only</span><p>The code goes to the email your account was created with. Nothing is shown on this page.</p></div>` : authMode === "reset" ? `
          <form id="resetPasswordForm" class="login-form">
            <label for="resetEmail">Registered email</label>
            <input id="resetEmail" name="email" type="email" placeholder="${profile.placeholder}" autocomplete="username" value="${passwordResetEmail}" required />
            <label for="resetCode">Reset code</label>
            <input id="resetCode" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="000000" autocomplete="one-time-code" required />
            <div class="auth-field-pair">
              <div><label for="resetPassword">New password</label><input id="resetPassword" name="newPassword" type="password" placeholder="At least 8 characters" autocomplete="new-password" minlength="8" required /></div>
              <div><label for="resetConfirm">Confirm password</label><input id="resetConfirm" name="confirmNewPassword" type="password" autocomplete="new-password" minlength="8" required /></div>
            </div>
            <button class="btn btn-primary auth-submit" type="submit">${icon("i-check")} Set new password</button>
          </form>
          <div class="verification-actions"><button type="button" class="text-btn" data-auth-mode="forgot">Send another code</button><button type="button" class="text-btn" data-auth-mode="login">Back to sign in</button></div>` : `
          <form id="loginForm" class="login-form">
            <input type="hidden" name="role" value="${selectedLoginRole}" />
            <label for="loginEmail">${profile.idLabel}</label>
            <input id="loginEmail" name="email" type="email" placeholder="${profile.placeholder}" autocomplete="username" required />
            <div class="label-row"><label for="loginPassword">Password</label>${emailDeliveryAvailable
              ? `<button type="button" class="text-btn" data-auth-mode="forgot">Forgot password?</button>`
              : ""}</div>
            <input id="loginPassword" name="password" type="password" placeholder="Enter your password" autocomplete="current-password" minlength="8" required />
            <button class="btn btn-primary auth-submit" type="submit">${icon("i-arrow")} Sign in as ${profile.shortTitle}</button>
          </form>
          <div class="auth-demo-note"><span>Secure password sign-in</span><p>Use the email, password, and account role selected during sign-up.${emailDeliveryAvailable ? "" : " Password reset by email is switched off, so ask your professor if you are locked out."}</p></div>`}`}
          <p class="auth-description" style="margin-top:18px"><a href="privacy.html" target="_blank" rel="noopener">Privacy policy</a> · <a href="delete-account.html" target="_blank" rel="noopener">Delete an account</a></p>
        </div>
      </section>
    </div>`;
  const firstField = { signup: "#signupName", forgot: "#forgotEmail", reset: passwordResetEmail ? "#resetCode" : "#resetEmail" }[authMode] || "#loginEmail";
  setTimeout(() => document.querySelector(firstField)?.focus(), 0);
}

function maskEmail(email = "") {
  const [local, domain] = String(email).split("@");
  if (!domain) return email;
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}${"•".repeat(Math.max(3, local.length - visible.length))}@${domain}`;
}

// Shown after sign-up while the emailed code is outstanding.
function renderEmailVerification() {
  if (!pendingSignup) return renderLogin(selectedLoginRole, "signup");
  const profile = loginProfiles[pendingSignup.role] || loginProfiles.student;
  closeMenu();
  if (view) view.innerHTML = "";
  appShell.hidden = true;
  authRoot.hidden = false;
  authRoot.innerHTML = `
    <div class="auth-layout">
      <section class="auth-story">
        <div class="auth-brand"><span class="brand-mark">C</span><span class="brand-name">Campus<span>Pulse</span></span></div>
        <div class="auth-story-copy"><span class="auth-kicker">ONE LAST STEP</span><h1>Check your inbox.</h1><p>Confirming the address keeps every classroom tied to a real, reachable account.</p></div>
      </section>
      <section class="auth-panel">
        <div class="auth-card">
          <div class="auth-heading"><span class="auth-icon">${icon("i-send")}</span><div><p>Verification sent</p><h2>Enter your code</h2></div></div>
          <p class="auth-description">We sent a six-digit code to <strong>${escapeHtml(maskEmail(pendingSignup.email))}</strong>. It expires in ten minutes.</p>
          <form id="verificationForm" class="login-form">
            <label for="verificationCode">Verification code</label>
            <input id="verificationCode" name="code" class="verification-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="000000" autocomplete="one-time-code" required />
            <button class="btn btn-primary auth-submit" type="submit">${icon("i-check")} Verify and continue</button>
          </form>
          <div class="verification-actions">
            <button type="button" class="text-btn" data-action="back-to-signup">Change details</button>
            <button type="button" class="text-btn" data-action="resend-code">Send another code</button>
          </div>
          <div class="auth-demo-note"><span>Check spam too</span><p>The code goes to the address you signed up with. CampusPulse never shows it on this page.</p></div>
        </div>
      </section>
    </div>`;
  setTimeout(() => document.querySelector("#verificationCode")?.focus(), 0);
}

// Any working mailbox is accepted, for every role. Course access is controlled
// by the private join codes rather than by the shape of an address, so an
// institute-only rule mainly locked out people who belonged in the class.
// Mirrors isValidEmail on the server.
function isValidEmail(email = "") {
  const value = email.trim().toLowerCase();
  if (value.length < 6 || value.length > 254) return false;
  const [local, domain, extra] = value.split("@");
  if (extra !== undefined) return false;
  if (!/^[a-z0-9][a-z0-9._%+-]*$/.test(local || "")) return false;
  if (local.includes("..") || local.endsWith(".")) return false;
  const labels = String(domain || "").split(".");
  if (labels.length < 2) return false;
  if (!/^[a-z]{2,63}$/.test(labels[labels.length - 1])) return false;
  return labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function isEmailForRole(_role, email = "") {
  return isValidEmail(email);
}

async function credentialHash(email, password) {
  const input = new TextEncoder().encode(`${email.trim().toLowerCase()}:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function roleDisplayName(role = state.userRole, name = state.accountName) {
  const cleanName = name?.trim() || loginProfiles[role]?.name || "User";
  if (role === "faculty") return `Prof. ${cleanName}`;
  if (role === "ta") return `Mr. ${cleanName}`;
  return cleanName;
}

function showApp() {
  startNavigationHistory();
  syncBackButton();
  authRoot.hidden = true;
  authRoot.innerHTML = "";
  appShell.hidden = false;
  setNavigationState(state.route);
  render();
  syncNotificationUi();
  // The shell is painted before Android can ask for notification permission.
  // This keeps all native permission UI behind a completed sign-in.
  window.setTimeout(() => startNotificationLifecycle(), 0);
}

function canSelfMarkAttendance() {
  return state.userRole === "student" || state.userRole === "ta";
}

// Every open session this account can mark itself present in, whichever course
// tab happens to be selected — a student or TA on the wrong tab when attendance
// starts would otherwise see nothing at all. The course in view is listed first.
//
// A session in a course this account also runs is left out: that phone is the
// beacon, so it cannot scan for itself, and the register is right there.
function selfMarkableSessions(preferredCourseId = state.selectedCourseId) {
  if (!canSelfMarkAttendance()) return [];
  return openAttendance
    .filter(session => {
      const course = state.courses.find(item => item.id === session.courseId);
      return !course || !canRunAttendance(course);
    })
    .sort((left, right) =>
      Number(right.courseId === preferredCourseId)
      - Number(left.courseId === preferredCourseId));
}

async function refreshEnrolledStudents() {
  if (!backendConfigured() || !apiToken || state.userRole === "student") {
    enrolledStudents = [];
    return;
  }
  try {
    const payload = await apiRequest("/api/students");
    enrolledStudents = Array.isArray(payload.students) ? payload.students : [];
  } catch {
    enrolledStudents = [];
  }
}

async function refreshOpenAttendance({ rerender = true } = {}) {
  if (!backendConfigured() || !apiToken || !canSelfMarkAttendance()) {
    openAttendance = [];
    return;
  }
  try {
    const payload = await apiRequest("/api/attendance/open");
    const next = Array.isArray(payload.sessions) ? payload.sessions : [];
    const changed = JSON.stringify(next) !== JSON.stringify(openAttendance);
    openAttendance = next;
    if (changed && rerender && (state.route === "dashboard" || state.route === "attendance")) render();
  } catch {
    // A failed poll must never disrupt the screen the student is using.
  }
}

function startOpenAttendancePolling() {
  clearInterval(openAttendanceTimer);
  if (!canSelfMarkAttendance()) return;
  // Push notifications and route changes provide the fast path. This fallback
  // stays deliberately light so hundreds of idle phones do not continually
  // wake the database and make real attendance requests time out.
  openAttendanceTimer = setInterval(() => {
    if (document.visibilityState === "visible") refreshOpenAttendance();
  }, 60000);
}

async function syncBackendState() {
  if (!backendConfigured() || !apiToken) return;
  const payload = await apiRequest("/api/bootstrap");
  state.userRole = payload.user.role;
  state.accountName = payload.user.name;
  state.authEmail = payload.user.email;
  state.courses = Array.isArray(payload.courses)
    ? payload.courses.map((course) => {
        if (payload.user.role === "faculty") {
          return { ...course, code: course.code || course.studentCode || "" };
        }
        // The API already strips private codes for non-owners. Remove them
        // again before persistence so a future API regression cannot cache
        // either professor-only code on a TA or student device.
        const {
          code: _legacyCode,
          studentCode: _studentCode,
          taCode: _taCode,
          ...safeCourse
        } = course;
        return safeCourse;
      })
    : [];
  migrateImportedScheduleCourseIds();
  if (!state.courses.some(course => course.id === state.selectedCourseId)) {
    state.selectedCourseId = state.courses[0]?.id || "";
  }
  state.enrolledCourses = payload.enrolledCourseIds || [];
  state.teachingAssistants = Array.isArray(payload.teachingAssistants)
    ? payload.teachingAssistants
    : [];
  state.stats = payload.stats || {};
  state.statsByCourse = payload.statsByCourse || {};
  state.backendSchedule = payload.schedule || [];
  courseRosters = new Map();
  courseMaterials = new Map();
  if (!activeAttendance || !state.courses.some(c => c.id === activeAttendance.courseId)) {
    applyAttendanceSnapshot(null);
  }
  state.attendanceCheckedIn = false;
  applyQuizSnapshot(null);
  const course = selectedCourse();
  const courseRefreshes = [];
  if (course && canRunAttendance(course)) {
    courseRefreshes.push(selectAttendanceCourse(course.id));
  }
  if (course && (state.userRole === "student" || canPublishQuiz(course))) {
    courseRefreshes.push(selectQuizCourse(course.id));
  }
  await Promise.allSettled(courseRefreshes);
  persist();
  await refreshOpenAttendance({ rerender: false });
  await refreshEnrolledStudents();
  await refreshNotices(state.selectedCourseId);
  if (canPublishQuiz()) {
    await refreshQuizDrafts(state.selectedCourseId);
    await refreshQuizHistory(state.selectedCourseId);
  }
  await syncClassReminders();
  startOpenAttendancePolling();
}

// Only the server saying "this token is no longer valid" should end a session.
// A timeout, a DNS failure or a 502 from a waking instance says nothing about
// the token, and treating those as a rejected login logged students out every
// time their signal dropped.
function isAuthFailure(error) {
  return error?.status === 401 || error?.status === 403;
}

function signOutLocally() {
  apiToken = "";
  localStorage.removeItem("campusPulseApiToken");
  clearSensitiveClientState({ clearImportedSchedule: true });
  state.authenticated = false;
  state.accountName = "";
  state.authEmail = "";
  state.route = "dashboard";
  persist();
}

async function restoreBackendSession() {
  if (!backendConfigured() || !apiToken) return false;
  const payload = await apiRequest("/api/me").catch((error) => {
    if (!isAuthFailure(error)) throw error;
    return null;
  });
  if (!payload) {
    signOutLocally();
    return false;
  }
  state.userRole = payload.user.role;
  state.accountName = payload.user.name;
  state.authEmail = payload.user.email;
  state.authenticated = true;
  try {
    await syncBackendState();
  } catch (error) {
    if (isAuthFailure(error)) {
      signOutLocally();
      return false;
    }
    // Identity is confirmed and the shell can be drawn from what was persisted
    // last time. Course data that failed to load is a toast, not a dead end —
    // pull-to-refresh will fetch it again.
    clearBootSplash();
    showApp();
    toast(
      error?.message || "Could not load your latest course data. Pull down to refresh.",
      "error"
    );
    return true;
  }
  clearBootSplash();
  showApp();
  return true;
}

function toast(message, type = "success") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  document.querySelector("#toastRegion").append(el);
  setTimeout(() => el.remove(), 3200);
}

/**
 * Makes a failure visible instead of leaving the screen unchanged.
 *
 * Every click and submit handler is async, so anything thrown inside one
 * becomes an unhandled rejection: nothing renders, nothing is reported, and the
 * button reads as dead. On a phone there is no console to check afterwards, so
 * the error is put on screen where it happened.
 */
function reportFailure(detail) {
  const message = String(detail?.message || detail || "Unknown error").slice(0, 160);
  try {
    toast(message, "error");
  } catch {
    // The toast region may not exist yet; the console is the only fallback.
  }
  console.error("[CampusPulse]", detail);
}

window.addEventListener("unhandledrejection", event => reportFailure(event.reason));
window.addEventListener("error", event => reportFailure(event.error || event.message));

function setHeader(title, eyebrow, showQuick = true) {
  pageTitle.textContent = title;
  pageEyebrow.textContent = eyebrow;
  quickAction.style.display = showQuick ? "" : "none";
  syncCourseSwitcher();
  const profiles = {
    faculty: { label: "Professor view", initials: "PF", name: "Professor Demo", meta: "Instructor · CSE" },
    ta: { label: "TA view", initials: "TA", name: "Teaching Assistant", meta: "Course team · CSE" },
    student: { label: "Student view", initials: "ST", name: "Student Demo", meta: "Student · CSE" }
  };
  const profile = profiles[state.userRole] || profiles.faculty;
  profileAvatar.textContent = profile.initials;
  profileName.textContent = roleDisplayName(state.userRole, state.accountName || profile.name);
  profileMeta.textContent = profile.meta;
  if (menuAvatar) menuAvatar.textContent = profile.initials;
  if (menuName) menuName.textContent = profileName.textContent;
  if (menuMeta) menuMeta.textContent = state.authEmail || profile.meta;
  syncNavVisibility();
}

const backNav = document.querySelector("#backNav");
let navigationSessionId = "";

function createNavigationSessionId() {
  try {
    if (crypto.randomUUID) return crypto.randomUUID();
  } catch {
    // Older Android webviews may not expose randomUUID.
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Each entry describes the screen that was actually drawn. Course drill-downs
// can share a route, so their context is part of the entry too.
function navigationEntry(route, depth) {
  return {
    campusNavigationSession: navigationSessionId,
    campusNavigationDepth: depth,
    campusRoute: route,
    campusSelectedCourseId: state.selectedCourseId || "",
    campusManagedCourseId: route === "students" ? managedCourseId : "",
    campusMaterialsCourseId: route === "materials" ? materialsCourseId : "",
  };
}

function navigationEntryMatches(entry, route) {
  const expected = navigationEntry(route, Number(entry?.campusNavigationDepth) || 0);
  return entry?.campusNavigationSession === expected.campusNavigationSession
    && entry?.campusRoute === expected.campusRoute
    && (entry?.campusSelectedCourseId || "") === expected.campusSelectedCourseId
    && (entry?.campusManagedCourseId || "") === expected.campusManagedCourseId
    && (entry?.campusMaterialsCourseId || "") === expected.campusMaterialsCourseId;
}

function replaceCurrentNavigationEntry() {
  const current = history.state;
  if (current?.campusNavigationSession !== navigationSessionId) return;
  try {
    history.replaceState(
      navigationEntry(state.route, Number(current.campusNavigationDepth) || 0),
      "",
    );
  } catch {
    // Course switching still succeeds when history is unavailable.
  }
}

function clearCourseScopedNavigationState() {
  courseMarks = null;
  courseMarksLoadedFor = "";
  examDraft = null;
  applyAttendanceSnapshot(null);
  applyQuizSnapshot(null);
  editingDraftId = "";
  quizResults = null;
  quizDrafts = [];
  quizHistory = [];
  myQuizzes = [];
  attendanceHistory = null;
  courseNotices = [];
  pastAttendanceSessions = [];
  pastSessionsLoadedFor = "";
  pastSessionsStatus = "idle";
  pastSessionsError = "";
}

// Overview is a sentinel at depth zero. A restored non-root screen is placed
// one step above it, so Back always reaches Overview before Android exits.
function startNavigationHistory() {
  navigationSessionId = createNavigationSessionId();
  // Detail routes depend on objects held only for the current page lifetime.
  // After a restart, resume at their stable parent instead of creating a Back
  // loop between a missing detail and its fallback screen.
  const restoredParent = {
    attendanceday: "attendance",
    myquiz: "quizzes",
    quizquestions: "quizmarks",
  }[state.route];
  const restorableRoutes = new Set([
    "dashboard", "schedule", "attendance", "quizzes", "students",
    "notices", "quizmarks", "materials", "classes", "settings",
  ]);
  const initialRoute = restoredParent
    || (restorableRoutes.has(state.route) ? state.route : "dashboard");
  if (state.route !== initialRoute) {
    state.route = initialRoute;
    persist();
  }
  try {
    history.replaceState(navigationEntry("dashboard", 0), "");
    if (initialRoute !== "dashboard") {
      history.pushState(navigationEntry(initialRoute, 1), "");
    }
  } catch {
    // A blocked history API falls back to the explicit Overview step below.
  }
}

// One rule for every nav item, so the sidebar and the phone drawer agree and
// nobody is offered a screen their role cannot use.
function syncNavVisibility() {
  const team = state.userRole === "faculty" || state.userRole === "ta";
  const runsAttendance = state.courses.some(canRunAttendance);
  const visible = {
    dashboard: true,
    schedule: true,
    classes: true,
    notices: true,
    students: team,
    materials: true,
    attendance: state.userRole === "student" || (team && runsAttendance),
    quizzes: true,
    settings: true,
  };
  document.querySelectorAll(".nav-item[data-route]").forEach(item => {
    const allowed = visible[item.dataset.route];
    item.hidden = allowed === false;
  });
}

function syncBackButton() {
  if (!backNav) return;
  // The dashboard is the root of the app, so there is nothing behind it.
  backNav.hidden = !state.authenticated || state.route === "dashboard";
}

function goBack() {
  const dialog = document.querySelector("#modalRoot [role='dialog']");
  if (dialog) {
    closeModal();
    return true;
  }
  if (appMenu?.classList.contains("open")) {
    closeMenu();
    return true;
  }
  // Student records replace their parent register/list without changing route.
  if (studentRecord) {
    studentRecord = null;
    render();
    syncBackButton();
    return true;
  }
  // A past register opened from Attendance closes back to today's register.
  // When it came from another route, the real history entry remains the origin.
  if (
    viewingPastAttendance
    && state.route === "attendance"
    && viewingPastAttendanceOriginRoute === "attendance"
  ) {
    viewingPastAttendance = null;
    renderAttendance();
    syncBackButton();
    return true;
  }
  if (state.route === "dashboard") return false;
  const entry = history.state;
  if (
    entry?.campusNavigationSession === navigationSessionId
    && Number(entry.campusNavigationDepth) > 0
  ) {
    history.back();
    return true;
  }
  // A deep screen restored without usable history still gets Overview as its
  // final in-app stop. Replace instead of push, otherwise Back would loop.
  managedCourseId = "";
  materialsCourseId = "";
  viewingPastAttendance = null;
  navigate("dashboard", { fromHistory: true, keepCourseContext: true });
  try {
    history.replaceState(navigationEntry("dashboard", 0), "");
  } catch {
    // Rendering Overview is sufficient when history is unavailable.
  }
  return true;
}

backNav?.addEventListener("click", goBack);
// MainActivity calls this instead of WebView.goBack(), allowing the web app to
// close an in-page detail first and to tell Android when Overview may exit.
window.campusPulseHandleBack = goBack;

window.addEventListener("popstate", event => {
  if (!state.authenticated) return;
  const entry = event.state;
  if (entry?.campusNavigationSession !== navigationSessionId) {
    managedCourseId = "";
    materialsCourseId = "";
    viewingPastAttendance = null;
    navigate("dashboard", { fromHistory: true, keepCourseContext: true });
    try {
      history.replaceState(navigationEntry("dashboard", 0), "");
    } catch {
      // The screen is already safely back at Overview.
    }
    return;
  }
  const route = entry.campusRoute || "dashboard";
  const selectedCourseId = entry.campusSelectedCourseId || "";
  const canRestoreCourse = !selectedCourseId
    || state.courses.some(course => course.id === selectedCourseId);
  const courseChanged = canRestoreCourse && selectedCourseId !== state.selectedCourseId;
  if (canRestoreCourse) {
    state.selectedCourseId = selectedCourseId;
  }
  if (courseChanged) clearCourseScopedNavigationState();
  // Entries pushed before courses were recorded carry none, and the first entry
  // of the session has no state at all, so an absent value closes the course.
  managedCourseId = entry.campusManagedCourseId || "";
  materialsCourseId = entry.campusMaterialsCourseId || "";
  if (route !== "attendance") {
    viewingPastAttendance = null;
    viewingPastAttendanceOriginRoute = "attendance";
  }
  if (route === state.route) {
    // Same screen, different course: only a repaint separates the two entries.
    render();
    persist();
    syncCourseSwitcher();
    syncBackButton();
    return;
  }
  navigate(route, { fromHistory: true, keepCourseContext: true });
});

function setNavigationState(route) {
  document.querySelectorAll(".nav-item[data-route]").forEach(btn => {
    const active = btn.dataset.route === route;
    btn.classList.toggle("active", active);
    if (active) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });
}

// Browser history drives Back, so the Android hardware button and the topbar
// arrow both retrace the same trail.
function navigate(route, { fromHistory = false, keepCourseContext = false } = {}) {
  if (!fromHistory && state.authenticated && !navigationSessionId) {
    startNavigationHistory();
  }
  // Opening one course's roster is a route change that carries its course with
  // it, so that caller keeps the context a plain nav entry clears. Settled
  // before the entry is pushed, so the entry records the screen actually shown.
  if (route === "students" && !keepCourseContext) managedCourseId = "";
  if (!fromHistory && route === "dashboard") {
    // Choosing Overview starts a fresh root. Older entries may remain inside
    // WebView, but their session tag prevents Back from reopening them.
    navigationSessionId = createNavigationSessionId();
    managedCourseId = "";
    materialsCourseId = "";
    viewingPastAttendance = null;
    try {
      history.replaceState(navigationEntry("dashboard", 0), "");
    } catch {
      // Navigation itself must still work when history is unavailable.
    }
  } else if (!fromHistory && !navigationEntryMatches(history.state, route)) {
    try {
      // The open course rides along in the entry: stepping back onto this
      // screen then restores that roster or material list rather than dropping
      // the user on the bare course list.
      const depth = history.state?.campusNavigationSession === navigationSessionId
        ? (Number(history.state.campusNavigationDepth) || 0) + 1
        : 1;
      history.pushState(navigationEntry(route, depth), "");
    } catch {
      // A blocked history API must never stop navigation.
    }
  }
  clearInterval(scanTimer);
  clearTimeout(quizTimer);
  // Leaving the attendance screen closes whichever student's record was open,
  // so coming back lands on the register rather than on someone's history.
  if (route !== "attendance") studentRecord = null;
  if (route !== "attendance") {
    viewingPastAttendance = null;
    viewingPastAttendanceOriginRoute = "attendance";
  }
  state.route = route;
  setNavigationState(route);
  render();
  persist();
  window.scrollTo({ top: 0, behavior: "smooth" });
  pageTitle.focus({ preventScroll: true });
  updateManager?.applyStagedUpdate?.();
  syncBackButton();
  if (route === "dashboard") refreshOpenAttendance();
  if (route === "students") refreshEnrolledStudents().then(() => { if (state.route === "students") renderStudents(); });
  if (route === "attendance" && state.userRole === "student") {
    Promise.all([
      refreshAttendanceHistory(state.selectedCourseId),
      refreshOpenAttendance({ rerender: false })
    ]).then(() => {
      if (state.route === "attendance") renderStudentAttendance();
    });
  }
  if (route === "quizzes") quizResults = null;
  if (route === "quizzes" && state.userRole === "student") {
    refreshMyQuizzes(state.selectedCourseId).then(() => {
      if (state.route === "quizzes") renderStudentQuizAccess();
    });
  }
  if (route === "quizmarks" && state.selectedCourseId) {
    // The panel lists the class even before a quiz is chosen.
    Promise.all([
      courseRosters.has(state.selectedCourseId)
        ? Promise.resolve()
        : loadCourseRoster(state.selectedCourseId).catch(() => {}),
      refreshQuizHistory(state.selectedCourseId)
    ]).then(() => {
      if (state.route === "quizmarks") renderQuizMarks();
    });
  }
  if (route === "notices") {
    refreshNotices(state.selectedCourseId).then(() => {
      if (state.route === "notices") renderNotices();
    });
  }
  if (route === "quizzes" && canPublishQuiz()) {
    Promise.all([
      refreshQuizDrafts(state.selectedCourseId),
      refreshQuizHistory(state.selectedCourseId)
    ]).then(() => {
      if (state.route === "quizzes" && !state.quizPublished) renderQuiz();
    });
  }
}

function render() {
  syncAttendanceLiveBar();
  if (!state.authenticated) {
    if (pendingSignup) return renderEmailVerification();
    return renderLogin(state.userRole);
  }
  if (state.route === "dashboard") return renderDashboard();
  if (state.route === "schedule") return renderSchedule();
  if (state.route === "attendance") return renderAttendance();
  if (state.route === "quizzes") return renderQuiz();
  if (state.route === "students") return renderStudents();
  if (state.route === "notices") return renderNotices();
  if (state.route === "quizmarks") return renderQuizMarks();
  if (state.route === "quizquestions") return renderQuizQuestions();
  if (state.route === "attendanceday") return renderAttendanceDay();
  if (state.route === "myquiz") return renderMyQuiz();
  if (state.route === "materials") return renderMaterials();
  return renderPlaceholder(state.route);
}

function attendanceDays() {
  const days = new Map();
  [...pastAttendanceSessions]
    .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))
    .forEach(session => {
      const date = new Date(session.startedAt);
      const total = Math.max(0, Number(session.total) || 0);
      const present = Math.max(0, Math.min(total, Number(session.present) || 0));
      if (!total || Number.isNaN(date.getTime())) return;
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      const day = days.get(key) || { key, date, present: 0, total: 0, classes: 0 };
      day.present += present;
      day.total += total;
      day.classes += 1;
      days.set(key, day);
    });
  return [...days.values()].map(day => ({
    ...day,
    percentage: Math.round((day.present / day.total) * 1000) / 10,
  }));
}

function attendanceTrendPlot(days) {
  const recent = days.slice(-10);
  const width = 720;
  const height = 260;
  const left = 48;
  const right = 18;
  const top = 18;
  const bottom = 48;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const x = index => recent.length === 1
    ? left + plotWidth / 2
    : left + (index / (recent.length - 1)) * plotWidth;
  const y = percentage => top + ((100 - percentage) / 100) * plotHeight;
  const points = recent.map((day, index) => ({
    ...day,
    x: x(index),
    y: y(day.percentage),
  }));
  const line = points.map((point, index) =>
    `${index ? "L" : "M"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`
  ).join(" ");
  const base = top + plotHeight;
  const area = points.length
    ? `${line} L ${points.at(-1).x.toFixed(2)} ${base} L ${points[0].x.toFixed(2)} ${base} Z`
    : "";
  const labelEvery = recent.length > 6 ? Math.ceil(recent.length / 6) : 1;

  return `<svg class="attendance-trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="attendanceTrendTitle attendanceTrendDescription">
    <title id="attendanceTrendTitle">Percentage present by teaching day</title>
    <desc id="attendanceTrendDescription">Attendance percentages for the latest ${recent.length} recorded teaching days.</desc>
    ${[100, 75, 50, 25, 0].map(value => {
      const rowY = y(value).toFixed(2);
      return `<g class="attendance-grid-line"><line x1="${left}" y1="${rowY}" x2="${width - right}" y2="${rowY}"/><text x="${left - 10}" y="${Number(rowY) + 4}" text-anchor="end">${value}%</text></g>`;
    }).join("")}
    <path class="attendance-area" d="${area}"/>
    <path class="attendance-line" d="${line}"/>
    ${points.map((point, index) => {
      const fullDate = point.date.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
      const shortDate = point.date.toLocaleDateString([], { day: "numeric", month: "short" });
      const showLabel = index % labelEvery === 0 || index === points.length - 1;
      return `<g class="attendance-point" tabindex="0" aria-label="${escapeHtml(`${fullDate}: ${point.percentage}% present`)}">
        <circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="4.5"><title>${escapeHtml(`${fullDate}: ${point.present} of ${point.total} present (${point.percentage}%)`)}</title></circle>
        ${showLabel ? `<text class="attendance-day-label" x="${point.x.toFixed(2)}" y="${height - 18}" text-anchor="middle">${escapeHtml(shortDate)}</text>` : ""}
      </g>`;
    }).join("")}
  </svg>`;
}

function attendanceAnalytics() {
  if (pastSessionsStatus === "loading") {
    return `<article class="card card-pad attendance-analytics analytics-loading" aria-live="polite">
      <div class="section-head"><div><h2>Attendance analytics</h2><p class="stat-label">Loading the saved attendance registers…</p></div></div>
      <div class="analytics-loading-chart" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div>
    </article>`;
  }
  if (pastSessionsStatus === "error") {
    return `<article class="card card-pad attendance-analytics analytics-error" role="alert">
      <div class="section-head"><div><h2>Attendance analytics</h2><p class="stat-label">The saved registers are still in the database.</p></div></div>
      <div class="analytics-empty"><span class="empty-icon">${icon("i-cloud")}</span><div><strong>Could not load attendance history</strong><p>${escapeHtml(pastSessionsError)}</p><button class="btn" type="button" data-action="retry-past-sessions">Try again</button></div></div>
    </article>`;
  }
  const days = attendanceDays();
  if (!days.length) {
    return `<article class="card card-pad attendance-analytics empty-analytics">
      <div class="section-head"><div><h2>Attendance analytics</h2><p class="stat-label">Daily turnout and participation patterns.</p></div></div>
      <div class="analytics-empty"><span class="empty-icon">${icon("i-chart")}</span><div><strong>Your charts will appear after the first class</strong><p>Close an attendance register to start tracking percentage present by day.</p></div></div>
    </article>`;
  }

  const present = days.reduce((sum, day) => sum + day.present, 0);
  const possible = days.reduce((sum, day) => sum + day.total, 0);
  const absent = Math.max(0, possible - present);
  const average = possible ? Math.round((present / possible) * 1000) / 10 : 0;
  const change = Math.round((days.at(-1).percentage - days[0].percentage) * 10) / 10;
  const weekdayRows = Array.from({ length: 7 }, (_, index) => ({
    index,
    label: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][index],
    present: 0,
    total: 0,
  }));
  days.forEach(day => {
    const weekday = (day.date.getDay() + 6) % 7;
    weekdayRows[weekday].present += day.present;
    weekdayRows[weekday].total += day.total;
  });
  const latestLabel = days.at(-1).date.toLocaleDateString([], { day: "numeric", month: "short" });
  const trendLabel = change === 0
    ? "No change across the period"
    : `${change > 0 ? "+" : ""}${change} points since ${days[0].date.toLocaleDateString([], { day: "numeric", month: "short" })}`;

  return `<article class="card card-pad attendance-analytics">
    <div class="section-head analytics-heading">
      <div><h2>Attendance analytics</h2><p class="stat-label">Percentage present across ${days.length} teaching day${days.length === 1 ? "" : "s"}.</p></div>
      <div class="analytics-head-metrics"><span><b>${days.at(-1).percentage}%</b> Latest · ${escapeHtml(latestLabel)}</span><span class="${change >= 0 ? "positive" : "negative"}">${escapeHtml(trendLabel)}</span></div>
    </div>
    <div class="attendance-analytics-grid">
      <section class="attendance-trend-panel" aria-label="Daily attendance trend">
        <div class="plot-title"><strong>Percentage present by day</strong><span>Latest ${Math.min(days.length, 10)} days</span></div>
        ${attendanceTrendPlot(days)}
      </section>
      <aside class="attendance-supporting-plots">
        <section class="mini-plot attendance-share-plot">
          <div class="plot-title"><strong>Present vs absent</strong><span>${possible} student records</span></div>
          <div class="attendance-share-content">
            <div class="attendance-donut" role="img" aria-label="${average}% present overall">
              <svg viewBox="0 0 42 42" aria-hidden="true"><circle class="donut-track" cx="21" cy="21" r="15.9"/><circle class="donut-value" cx="21" cy="21" r="15.9" pathLength="100" stroke-dasharray="${average} ${Math.max(0, 100 - average)}"/></svg>
              <span><strong>${average}%</strong><small>present</small></span>
            </div>
            <div class="attendance-legend"><span class="present"><i></i><b>${present}</b> Present</span><span class="absent"><i></i><b>${absent}</b> Absent</span></div>
          </div>
        </section>
        <section class="mini-plot weekday-plot">
          <div class="plot-title"><strong>Attendance by weekday</strong><span>Term average</span></div>
          <div class="weekday-bars" role="img" aria-label="Average attendance percentage by weekday">
            ${weekdayRows.map(row => {
              const percentage = row.total ? Math.round((row.present / row.total) * 100) : 0;
              return `<div class="weekday-bar ${row.total ? "has-data" : ""}" title="${row.label}: ${row.total ? `${percentage}%` : "No classes"}"><span><i style="height:${row.total ? Math.max(5, percentage) : 3}%"></i></span><b>${row.label.slice(0, 1)}</b></div>`;
            }).join("")}
          </div>
        </section>
      </aside>
    </div>
  </article>`;
}

function renderDashboard() {
  if (state.userRole === "student") return renderStudentDashboard();
  const course = selectedCourse() || state.courses[0];
  if (!course) {
    setHeader(`Good morning, ${roleDisplayName()}`, state.userRole === "faculty" ? "PROFESSOR WORKSPACE" : "TA WORKSPACE", false);
    view.innerHTML = `<article class="card empty-state"><div><span class="empty-icon">${icon("i-users")}</span><h2>${state.userRole === "faculty" ? "Create your first course" : "Join your assigned course"}</h2><p>${state.userRole === "faculty" ? "Courses are private to their professor owner. Create a course, then share the student and TA join codes with the right groups." : "Enter the private course code shared by the professor before accessing attendance or quizzes."}</p><button class="btn btn-primary" ${state.userRole === "faculty" ? 'data-action="open-course-modal"' : 'data-route-link="classes"'}>${icon("i-plus")} ${state.userRole === "faculty" ? "Create course" : "Enter course code"}</button></div></article>`;
    return;
  }
  const attendanceMatchesCourse = activeAttendance?.courseId === course.id;
  const courseAttendanceStatus = attendanceMatchesCourse ? state.attendanceStatus : "not_started";
  const coursePresentCount = attendanceMatchesCourse ? currentPresentCount() : 0;
  setHeader(`Good morning, ${roleDisplayName()}`, todayLabel());
  // The classes already recorded belong on the overview too. "Today's classes"
  // comes off the timetable, so it is empty on any day the course does not
  // meet — which is most days — and the page then says nothing about a term
  // that may already be well under way.
  if (canRunAttendance(course) && backendConfigured() && apiToken && pastSessionsLoadedFor !== course.id) {
    refreshPastSessions(course.id).then(() => {
      if (state.route === "dashboard" && selectedCourse()?.id === course.id) renderDashboard();
    });
  }
  const stats = workspaceStats();
  const todaysClasses = scheduleForToday();
  // A TA is on a course team and on a roster at the same time. Everything below
  // is the teaching half; this is the other one — the classes they attend, which
  // had no screen of their own on this side of the app.
  const selfMark = selfMarkableSessions(course.id);
  view.innerHTML = `
    <div class="dashboard-grid">
      <div class="left-stack">
        ${selfMark.length ? `<div class="attendance-call-stack">${selfMark.map(attendanceCallCard).join("")}</div>` : ""}
        <article class="hero-session">
          <div class="hero-copy">
            <span class="live-tag">YOUR COURSE</span>
            <h2>${escapeHtml(course.name)}</h2>
            <p>${escapeHtml(course.courseCode)}</p>
            <div class="hero-meta">
              <span>${icon("i-users")} ${Number(course.students) || 0} students</span>
              <span>${icon("i-calendar")} ${escapeHtml(course.room || "Room TBA")}</span>
            </div>
          </div>
          <div class="hero-action">${canRunAttendance(course) ? `<button class="btn" data-action="open-dashboard-attendance" data-course-id="${escapeHtml(course.id)}">${icon("i-play")} ${courseAttendanceStatus === "not_started" ? "Take attendance" : "View attendance"}</button>` : `<span class="badge gray">Attendance unavailable</span>`}</div>
        </article>

        <div class="stat-grid">
          <article class="card stat">
            <div class="stat-top"><span class="stat-icon">${icon("i-users")}</span><span class="trend">${stats.classesCompleted ? "Recorded" : "No data yet"}</span></div>
            <div class="stat-value">${stats.averageAttendance}%</div><div class="stat-label">Average attendance</div>
          </article>
          <article class="card stat">
            <div class="stat-top"><span class="stat-icon green">${icon("i-check")}</span><span class="trend">All time</span></div>
            <div class="stat-value">${stats.classesCompleted}</div><div class="stat-label">Classes completed</div>
          </article>
          <article class="card stat">
            <div class="stat-top"><span class="stat-icon amber">${icon("i-quiz")}</span><span class="trend">Published</span></div>
            <div class="stat-value">${stats.quizzes}</div><div class="stat-label">Quizzes</div>
          </article>
        </div>

        ${canRunAttendance(course) ? attendanceAnalytics() : ""}

        <article class="card card-pad">
          <div class="section-head"><h2>Today’s classes</h2><button class="text-btn" data-route-link="schedule">View schedule</button></div>
          <div class="class-list">
            ${todaysClasses.length
              ? todaysClasses.map(item => todayClassRow(item, { attendanceLinks: true })).join("")
              : `<p class="stat-label" style="padding:6px 2px">No classes scheduled for today. Add a timetable from the Schedule page.</p>`}
          </div>
        </article>

        ${canRunAttendance(course) ? pastSessionsListCard({ hideStatus: true }) : ""}
      </div>

      <div class="right-stack">
        ${dateCard()}
        <article class="card card-pad">
          <div class="section-head"><h3>Recent activity</h3></div>
          <div class="activity-list">
            ${activityFeed(course, attendanceMatchesCourse, coursePresentCount, stats)}
          </div>
        </article>
      </div>
    </div>`;
}

// Counters come from the server; a workspace with no history reports zeros.
function workspaceStats() {
  const courseId = selectedCourse()?.id || "";
  return {
    courses: 0,
    rosteredStudents: 0,
    classesCompleted: 0,
    averageAttendance: 0,
    quizzes: 0,
    ...(courseId ? state.statsByCourse?.[courseId] || state.stats : state.stats || {})
  };
}

function scheduleForToday() {
  const todayIndex = (new Date().getDay() + 6) % 7;
  const course = selectedCourse();
  const importedForCourse = state.importedSchedule.filter(item =>
    scheduleBelongsToCourse(item, course)
  );
  const source = state.userRole === "student" && importedForCourse.length
    ? importedForCourse
    : state.backendSchedule;
  return source
    .filter(item =>
      dayIndexFromName(String(item.day || "")) === todayIndex &&
      scheduleBelongsToCourse(item, course)
    )
    .sort((left, right) => timeToMinutes(left.start) - timeToMinutes(right.start));
}

function scheduleBelongsToCourse(item, course) {
  if (!course) return false;
  if (item.courseId) return item.courseId === course.id;
  if (state.courses.length === 1) return true;
  const compact = value => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const eventLabel = compact(`${item.courseCode || ""} ${item.topic || ""} ${item.courseName || ""}`);
  return [course.courseCode, course.name]
    .map(compact)
    .filter(Boolean)
    .some(label => eventLabel.includes(label));
}

function migrateImportedScheduleCourseIds() {
  state.importedSchedule = state.importedSchedule.map(item => {
    if (item.courseId) return item;
    const matches = state.courses.filter(course => scheduleBelongsToCourse(item, course));
    if (matches.length !== 1) return item;
    const course = matches[0];
    return {
      ...item,
      courseId: course.id,
      courseCode: item.courseCode || course.courseCode,
      courseName: item.courseName || course.name,
    };
  });
}

function syncCourseSwitcher() {
  if (!courseSwitcher || !courseSwitcherWrap || !courseSwitcherDropdown) return;
  const visible = state.authenticated && state.courses.length > 0;
  courseSwitcherWrap.hidden = !visible;
  if (!visible) {
    courseSwitcher.textContent = "";
    courseSwitcherDropdown.innerHTML = "";
    return;
  }
  const current = selectedCourse();
  courseSwitcher.textContent = current ? `${current.courseCode} · ${current.name}` : "Select a course";
  courseSwitcherDropdown.innerHTML = state.courses.map(course =>
    `<li role="option" data-course-id="${escapeHtml(course.id)}" class="${course.id === (current?.id || "") ? "active" : ""}" aria-selected="${course.id === (current?.id || "")}">${escapeHtml(`${course.courseCode} · ${course.name}`)}</li>`
  ).join("");
}

function toggleCourseSwitcher(forceOpen) {
  if (!courseSwitcherWrap || !courseSwitcherDropdown) return;
  const isOpen = forceOpen !== undefined ? forceOpen : courseSwitcherDropdown.hidden;
  courseSwitcherDropdown.hidden = !isOpen;
  courseSwitcherWrap.classList.toggle("open", isOpen);
  courseSwitcher?.setAttribute("aria-expanded", isOpen ? "true" : "false");
}

async function switchCourseContext(
  courseId,
  { renderView = true, notify = true, updateHistory = renderView } = {}
) {
  const course = state.courses.find(item => item.id === courseId);
  if (!course) return toast("Course not found", "error");
  clearTimeout(quizTimer);
  state.selectedCourseId = course.id;
  managedCourseId = "";
  materialsCourseId = "";
  courseMarks = null;
  courseMarksLoadedFor = "";
  examDraft = null;
  applyAttendanceSnapshot(null);
  applyQuizSnapshot(null);
  editingDraftId = "";
  persist();
  quizResults = null;
  await refreshNotices(course.id);
  if (canPublishQuiz(course)) {
    await refreshQuizDrafts(course.id);
    await refreshQuizHistory(course.id);
  }

  const refreshes = [];
  if (canRunAttendance(course)) refreshes.push(selectAttendanceCourse(course.id));
  if (state.userRole === "student" || canPublishQuiz(course)) {
    refreshes.push(selectQuizCourse(course.id));
  }
  const results = await Promise.allSettled(refreshes);
  const failed = results.find(result => result.status === "rejected");
  let materialFailure = null;

  if (state.route === "materials") {
    materialsCourseId = course.id;
    try {
      await loadCourseMaterials(course.id, { force: true });
    } catch (error) {
      materialFailure = error;
      if (notify) {
        toast(error.message || "Could not load course materials", "error");
      }
    }
  }

  persist();
  if (updateHistory) replaceCurrentNavigationEntry();
  if (renderView) render();
  if (failed && notify) {
    toast(failed.reason?.message || "Some course data could not be refreshed", "error");
  } else if (notify && !materialFailure) {
    toast(`Switched to ${course.courseCode}`);
  }
  return course;
}

function todayClassRow(item, { attendanceLinks = false } = {}) {
  const course = state.courses.find(candidate => candidate.id === item.courseId);
  const title = course?.name || item.topic || "Scheduled class";
  const rawRoom = item.room || course?.room || "Room TBA";
  const room = /^room\b/i.test(rawRoom) ? rawRoom : `Room ${rawRoom}`;
  const detail = [
    course?.courseCode,
    item.topic && item.topic !== title ? item.topic : "",
    room,
    Array.isArray(item.subtopics) && item.subtopics.length
      ? `Topics: ${item.subtopics.join(", ")}`
      : "",
  ].filter(Boolean).join(" · ");
  const route = attendanceLinks && course && canRunAttendance(course)
    ? "attendance"
    : "schedule";
  return classRow(
    item.start || "Time TBA",
    item.end || "",
    title,
    detail,
    room,
    "purple",
    route,
    course?.id || "",
  );
}

function courseTimeLabel(course) {
  const next = state.backendSchedule.find(item => item.courseId === course.id);
  return next?.start && next?.end ? `${next.start} – ${next.end}` : "Schedule not set";
}

function todayLabel() {
  return new Date()
    .toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long" })
    .toUpperCase();
}

function dateCard() {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const week = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(monday);
    day.setDate(monday.getDate() + index);
    return day;
  });
  return `<article class="card date-card">
    <div class="date-top"><div><div class="date-day">${now.toLocaleDateString("en-US", { weekday: "long" })}</div><div class="date-number">${now.getDate()}</div></div><div class="date-month">${now.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</div></div>
    <div class="week-strip">
      ${week.map(day => `<span class="${day.toDateString() === now.toDateString() ? "selected" : ""}">${day.toLocaleDateString("en-US", { weekday: "narrow" })}<b>${day.getDate()}</b></span>`).join("")}
    </div>
  </article>`;
}

function activityFeed(course, attendanceMatchesCourse, coursePresentCount, stats) {
  const items = [];
  if (attendanceMatchesCourse && state.attendanceStatus === "scanning") {
    items.push([icon("i-check"), `${coursePresentCount} of ${Number(course.students) || 0} students present`, course.name, "Live"]);
  }
  if (stats.classesCompleted) {
    items.push([icon("i-check"), `${stats.classesCompleted} class${stats.classesCompleted === 1 ? "" : "es"} recorded`, `${stats.averageAttendance}% average attendance`, "All time"]);
  }
  if (stats.quizzes) {
    items.push([icon("i-quiz"), `${stats.quizzes} quiz${stats.quizzes === 1 ? "" : "zes"} published`, course.name, "All time"]);
  }
  if (Number(course.students) > 0) {
    items.push([icon("i-users"), `${course.students} students on the roll list`, course.name, "Roster"]);
  }
  if (!items.length) {
    return `<p class="stat-label" style="padding:6px 2px">Nothing yet. Upload a roll list, then take attendance.</p>`;
  }
  return items
    .map(([glyph, title, meta, when]) =>
      `<div class="activity"><span class="activity-icon">${glyph}</span><div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(meta)}</p></div><time>${escapeHtml(when)}</time></div>`
    )
    .join("");
}

// The team's screen shows a code that changes every 30 seconds; students in the
// room read it off that screen to prove they were there.
async function refreshProximityCode(sessionId) {
  if (!backendConfigured() || !apiToken || !sessionId) {
    proximityCode = null;
    return { closed: false };
  }
  try {
    proximityCode = await apiRequest(`/api/attendance/${encodeURIComponent(sessionId)}/code`);
    if (Number.isFinite(proximityCode?.serverTime)) {
      // Round-trip latency is in here too, but a few hundred milliseconds
      // does not matter against a thirty-second window.
      proximityClockSkewMs = proximityCode.serverTime - Date.now();
    }
    return { closed: false };
  } catch (error) {
    // Only a session that is gone, closed, or no longer ours retires the code.
    // A dropped connection must not: the beacon is still advertising a token
    // the server will accept, and the class is still in the room.
    if (error?.status === 404 || error?.status === 403) {
      proximityCode = null;
      return { closed: true };
    }
    return { closed: false, error };
  }
}

// True only while this session's register is the thing on screen, so a token
// refresh running in the background never repaints some other page out from
// under the person reading it.
function showingLiveSession(sessionId) {
  return state.route === "attendance"
    && !viewingPastAttendance
    && activeAttendance?.id === sessionId;
}

// Takes over the beacon for a session and keeps it fed. Asking again for the
// session already being broadcast is a no-op, so this is safe to call from a
// render that runs on every repaint.
async function startAttendanceBroadcast(sessionId, courseId = "") {
  if (!sessionId || !backendConfigured() || !apiToken) return;
  if (broadcastSessionId === sessionId && proximityTimer) return;
  broadcastSessionId = sessionId;
  broadcastCourseId = courseId || broadcastCourseId;
  syncAttendanceLiveBar();
  const { closed } = await refreshProximityCode(sessionId);
  // Another broadcast started while this one was in flight; it owns the radio.
  if (broadcastSessionId !== sessionId) return;
  if (closed) return stopAttendanceBroadcast();
  if (proximityCode?.code) await startAttendanceBeacon(proximityCode.code);
  startProximityCodeTicker(sessionId);
  if (showingLiveSession(sessionId)) renderLiveAttendance();
}

async function stopAttendanceBroadcast() {
  clearInterval(proximityTimer);
  proximityTimer = null;
  broadcastSessionId = "";
  broadcastCourseId = "";
  proximityCode = null;
  syncAttendanceLiveBar();
  await stopAttendanceBeacon();
}

function startProximityCodeTicker(sessionId) {
  clearInterval(proximityTimer);
  if (!sessionId) return;
  // A register outlives the screen it was opened from. This keeps rotating the
  // token while the team reads another page or looks at another course, and
  // stops only when the session closes, another session takes the radio, or
  // the account signs out.
  proximityTimer = setInterval(async () => {
    if (broadcastSessionId !== sessionId) {
      clearInterval(proximityTimer);
      return;
    }
    const previous = proximityCode?.code;
    const { closed } = await refreshProximityCode(sessionId);
    if (broadcastSessionId !== sessionId) return;
    if (closed) {
      // Closed from another device, or course access withdrawn.
      await stopAttendanceBroadcast();
      if (state.route === "attendance") renderLiveAttendance();
      return;
    }
    await syncBeaconToken();
    if (proximityCode?.code !== previous && showingLiveSession(sessionId)) {
      renderLiveAttendance();
    }
  }, 5000);
}

// Android suspends the WebView's timers while the app is in the background, so
// the token sitting on the beacon is already stale by the time the teaching
// device is picked up again. Catch up at once rather than leave the room
// failing check-ins for up to another five seconds.
async function resumeAttendanceBroadcast() {
  const sessionId = broadcastSessionId;
  if (!sessionId) return;
  const { closed } = await refreshProximityCode(sessionId);
  if (broadcastSessionId !== sessionId) return;
  if (closed) {
    await stopAttendanceBroadcast();
    if (state.route === "attendance") renderLiveAttendance();
    return;
  }
  // On Android the service kept broadcasting through the whole background
  // spell and there is nothing to catch up; everywhere else this is the
  // moment the stale token gets replaced.
  await syncBeaconToken();
  startProximityCodeTicker(sessionId);
  if (showingLiveSession(sessionId)) renderLiveAttendance();
}

// A register left open while the team reads another page has nothing else to
// show for itself, and a beacon nobody can see is a beacon nobody turns off.
function syncAttendanceLiveBar() {
  if (!attendanceLiveBar) return;
  const live = Boolean(broadcastSessionId) && state.authenticated;
  const showing = live && !showingLiveSession(broadcastSessionId);
  attendanceLiveBar.hidden = !showing;
  if (!showing || !attendanceLiveText) return;
  const course = state.courses.find(item => item.id === broadcastCourseId);
  attendanceLiveText.textContent = course
    ? `Attendance is live for ${course.courseCode}`
    : "Attendance is live";
}

function proximityPlugin() {
  return window.Capacitor?.Plugins?.Proximity || null;
}

// The teaching device broadcasts the rotating session token so students in the
// room can pick it up over Bluetooth without anyone reading a code aloud.
// Says what is actually wrong when the beacon will not start. The plugin's own
// message can be misleading: from Android 12, reading whether the radio is on
// needs the Nearby devices permission, so a phone with Bluetooth plainly on is
// reported as off. Asking the plugin what it can see tells the two apart.
async function beaconFailureReason(fallback) {
  const plugin = proximityPlugin();
  if (!plugin?.isSupported) return fallback;
  try {
    const support = await plugin.isSupported();
    if (support?.available === false) {
      return "This phone has no Bluetooth, so it cannot broadcast attendance.";
    }
    if (support?.enabled === false) {
      // Either genuinely off, or the permission is missing and we cannot tell.
      return "Turn Bluetooth on, and allow CampusPulse the Nearby devices permission when asked. If Bluetooth is already on, the permission is what is missing — grant it in Settings › Apps › CampusPulse › Permissions › Nearby devices.";
    }
    if (support?.canAdvertise === false) {
      return "This phone cannot broadcast over Bluetooth LE. Run attendance from another device, or mark students from the list below.";
    }
  } catch {
    // The diagnostic itself failed; the original message is all we have.
  }
  return fallback;
}

// Hands the beacon everything it needs to stay current on its own. Given the
// session secret, the installed Android app derives each window's token in a
// foreground service and keeps broadcasting through a locked screen; iOS, a
// browser, or an older native build ignore the extra fields and go on being
// fed a token from here every window instead.
async function startAttendanceBeacon(token) {
  const plugin = proximityPlugin();
  if (!plugin || !token) return false;
  const course = state.courses.find(item => item.id === broadcastCourseId);
  try {
    const result = await plugin.startBeacon({
      token,
      secret: proximityCode?.secret || "",
      windowMs: proximityCode?.windowMs || 30000,
      digits: proximityCode?.digits || 6,
      clockSkewMs: proximityClockSkewMs,
      label: course ? course.courseCode : ""
    });
    beaconToken = token;
    beaconRotating = Boolean(result?.rotating);
    beaconMismatches = 0;
    beaconError = "";
    return true;
  } catch (error) {
    beaconToken = "";
    beaconRotating = false;
    beaconError = await beaconFailureReason(
      error?.message || "Could not start broadcasting"
    );
    return false;
  }
}

// Keeps what is on the air in step with what the server will accept.
//
// A beacon that rotates for itself needs nothing pushed to it, but it is still
// checked against the server while the app is on screen. Both derive the token
// from the same secret and the same clock, so they can only disagree if this
// phone's clock has drifted into a different window — which would fail every
// check-in in the room and say nothing about why. Pushing the server's own
// token repairs the class, at the cost of going stale in the background again.
async function syncBeaconToken() {
  const code = proximityCode?.code;
  if (!code) return;
  if (!beaconRotating) {
    if (code !== beaconToken) await startAttendanceBeacon(code);
    return;
  }
  let live = "";
  try {
    live = (await proximityPlugin()?.beaconStatus?.())?.token || "";
  } catch {
    // An older native build has no status to report; trust the rotation.
    return;
  }
  if (!live || live === code) {
    beaconMismatches = 0;
    return;
  }
  // A single disagreement is a window boundary falling between the two reads,
  // and the server accepts the previous window anyway. Drift persists.
  beaconMismatches += 1;
  if (beaconMismatches < 3) return;
  beaconMismatches = 0;
  beaconRotating = false;
  await startAttendanceBeacon(code);
}

async function stopAttendanceBeacon() {
  const plugin = proximityPlugin();
  beaconToken = "";
  beaconRotating = false;
  beaconMismatches = 0;
  if (!plugin) return;
  try {
    await plugin.stopBeacon();
  } catch {
    // Nothing useful to do if the radio already went away.
  }
}

// How far the beacon is allowed to be and still count as "in this class".
// Sized for a full lecture theatre rather than a small room: a student in the
// back row belongs in the register, and the walls exclude the corridor far more
// reliably than a tighter number would.
const ATTENDANCE_RANGE_METRES = 30;

// Students listen for the class beacon. The plugin samples the signal for a
// couple of seconds and reports an estimated distance, so a single unlucky
// packet no longer decides whether someone is marked present.
async function findAttendanceBeacon() {
  const plugin = proximityPlugin();
  if (!plugin) return { found: false, unsupported: true };
  try {
    const result = await plugin.scanForBeacon({
      timeoutMs: 12000,
      maxDistanceMeters: ATTENDANCE_RANGE_METRES,
    });
    return {
      found: Boolean(result?.found),
      token: result?.token || "",
      rssi: result?.rssi,
      distanceMeters: result?.distanceMeters,
      outOfRange: Boolean(result?.outOfRange),
    };
  } catch (error) {
    return { found: false, error: error?.message || "Bluetooth scan failed" };
  }
}

function attendanceCallCard(session) {
  const course = state.courses.find(item => item.id === session.courseId);
  const websiteCheckIn = !proximityPlugin();
  // The card can now appear while a different course is selected, so it has to
  // say which class it belongs to rather than borrow the heading of the page.
  const courseName = course ? `${course.courseCode} · ${course.name}` : "Your course";
  const startedAt = session.startedAt
    ? new Date(session.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";
  if (session.checkedIn) {
    const markedAt = session.markedAt
      ? new Date(session.markedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "";
    return `<article class="card page-card attendance-call is-marked">
      <div class="section-head"><h3>${escapeHtml(courseName)}</h3><span class="badge green">${icon("i-check")} Present</span></div>
      <p class="attendance-call-copy">You were marked present${markedAt ? ` at ${escapeHtml(markedAt)}` : ""}. Nothing else to do.</p>
    </article>`;
  }
  const webAvailable = websiteCheckIn && session.webCheckInAvailable;
  return `<article class="card page-card attendance-call${websiteCheckIn && !webAvailable ? " is-idle" : ""}">
    <div class="section-head"><h3>${escapeHtml(courseName)}</h3><span class="badge amber">Attendance open</span></div>
    <p class="attendance-call-copy">Your course team started attendance${startedAt ? ` at ${escapeHtml(startedAt)}` : ""}. ${websiteCheckIn ? "CampusPulse can verify your classroom Wi‑Fi and location from this website." : "Stay in the room — your phone connects over Bluetooth."}</p>
    ${session.rollNumber
      ? `<p class="attendance-call-roll">Roll number <strong>${escapeHtml(session.rollNumber)}</strong></p>`
      : `<label class="attendance-call-label" for="rollNumber-${escapeHtml(session.id)}">Your roll number</label>
         <input class="text-input" id="rollNumber-${escapeHtml(session.id)}" data-roll-for="${escapeHtml(session.id)}" type="text" placeholder="e.g. 21ME10001" autocomplete="off" />`}
    <p class="attendance-call-copy">${websiteCheckIn
      ? webAvailable
        ? "Connect to the same classroom Wi‑Fi used to start attendance. Safari will ask for Precise Location when you tap below."
        : "Website check-in is unavailable for this session because the classroom network or location was not captured. Ask the course team to mark you from the roster."
      : "Wi‑Fi and Bluetooth must both be on. Your phone will find the class automatically when you tap below."}</p>
    <button class="btn btn-primary attendance-call-submit" type="button" data-action="student-check-in" data-session-id="${escapeHtml(session.id)}" ${websiteCheckIn && !webAvailable ? "disabled" : ""}>${icon("i-check")} ${websiteCheckIn ? "Verify classroom & mark present" : "Mark me present"}</button>
  </article>`;
}

function renderStudentDashboard() {
  setHeader(`Good morning, ${roleDisplayName()}`, "STUDENT DASHBOARD");
  const course = selectedCourse();
  const enrolled = course && state.enrolledCourses.includes(course.id) ? [course] : [];
  // Not just the selected course's: a student sitting on the wrong course tab
  // when the professor or a TA starts attendance would otherwise see nothing.
  const selectedAttendance = selfMarkableSessions(course?.id);
  const todaysClasses = scheduleForToday();
  view.innerHTML = `
    <div class="left-stack">
      ${selectedAttendance.length ? `<div class="attendance-call-stack">${selectedAttendance.map(attendanceCallCard).join("")}</div>` : ""}
      <section class="student-welcome">
        <h2>${enrolled.length ? escapeHtml(`${course.courseCode} · ${course.name}`) : "Join your first course"}</h2>
        <p>${enrolled.length ? `Welcome to ${escapeHtml(course.name)}. Access this course's schedule, quick quizzes, materials, and class updates here.` : "Enter the private course code shared by your faculty. Course content is available only after enrollment."}</p>
        <button class="btn" data-route-link="${enrolled.length ? "schedule" : "classes"}">${icon(enrolled.length ? "i-calendar" : "i-plus")} ${enrolled.length ? "View my schedule" : "Join a course"}</button>
      </section>
      <article class="card card-pad">
        <div class="section-head"><h2>Today’s classes</h2><button class="text-btn" data-route-link="schedule">View schedule</button></div>
        <div class="class-list">
          ${todaysClasses.length
            ? todaysClasses.map(item => todayClassRow(item)).join("")
            : `<p class="stat-label" style="padding:6px 2px">No classes scheduled for today.</p>`}
        </div>
      </article>
      <div class="course-grid">
        ${enrolled.length ? enrolled.map(course => studentCourseCard(course)).join("") : `
          <article class="card empty-state" style="min-height:260px;grid-column:1/-1"><div><span class="empty-icon">${icon("i-calendar")}</span><h2>No courses yet</h2><p>Ask your faculty for the course join code, then enter it on the Courses page.</p><button class="btn btn-primary" data-route-link="classes">Enter join code</button></div></article>`}
      </div>
    </div>`;
}

// A weekly grid: first row holds the time slots, first column the weekdays,
// and any non-empty cell is a class in that slot.
function parseTimetableGrid(rows) {
  const cleaned = rows.filter(row => row.some(cell => String(cell || "").trim()));
  if (cleaned.length < 2) throw new Error("That timetable has no rows");
  const slots = cleaned[0].map(cell => String(cell || "").trim());
  const classes = [];
  for (const row of cleaned.slice(1)) {
    const day = String(row[0] || "").trim();
    if (!day) continue;
    for (let column = 1; column < row.length; column += 1) {
      const subject = String(row[column] || "").trim().replace(/\s+/g, " ");
      if (!subject) continue;
      const slot = slots[column] || "";
      const [start, end] = slot.split(/\s*[-–—]\s*/);
      classes.push({
        day,
        start: (start || slot).trim(),
        end: (end || "").trim(),
        topic: subject,
        room: ""
      });
    }
  }
  if (!classes.length) throw new Error("No classes were found in that timetable");
  return classes;
}

// A plain list works too: day, start, end, subject, room as columns.
function parseTimetableList(rows) {
  const headers = rows[0].map(cell => String(cell || "").toLowerCase().replace(/[^a-z]/g, ""));
  const at = (...names) => headers.findIndex(header => names.includes(header));
  const dayIndex = at("day", "weekday", "dayname");
  if (dayIndex < 0) return null;
  const startIndex = at("start", "starttime", "from", "time");
  const endIndex = at("end", "endtime", "to");
  const topicIndex = at("subject", "course", "topic", "class");
  const roomIndex = at("room", "venue", "location");
  return rows.slice(1)
    .filter(row => String(row[dayIndex] || "").trim())
    .map(row => ({
      day: String(row[dayIndex] || "").trim(),
      start: startIndex >= 0 ? String(row[startIndex] || "").trim() : "",
      end: endIndex >= 0 ? String(row[endIndex] || "").trim() : "",
      topic: topicIndex >= 0 ? String(row[topicIndex] || "").trim() : "",
      room: roomIndex >= 0 ? String(row[roomIndex] || "").trim() : ""
    }));
}

async function readTimetableFile(file) {
  const name = (file.name || "").toLowerCase();
  let rows;
  if (name.endsWith(".xlsx")) {
    rows = await xlsxRows(await file.arrayBuffer());
  } else if (!/\.(csv|txt)$/.test(name)) {
    // The picker no longer filters by type, so the wrong file is named as
    // such rather than failing later as an unreadable sheet.
    throw new Error("Upload the timetable as .xlsx or .csv");
  } else {
    rows = (await file.text())
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(parseCSVRow);
  }
  if (!rows.length) throw new Error("That file has no rows");
  return parseTimetableList(rows) || parseTimetableGrid(rows);
}

function renderSchedule() {
  const isStudent = state.userRole === "student";
  const course = selectedCourse();
  if (!course) {
    setHeader("Schedule", "COURSE ACCESS", false);
    view.innerHTML = `<article class="card empty-state"><div><span class="empty-icon">${icon("i-calendar")}</span><h2>No course schedule yet</h2><p>${state.userRole === "faculty" ? "Create a course to begin." : "Join a course with the code shared by its professor."}</p><button class="btn btn-primary" data-route-link="classes">Open courses</button></div></article>`;
    return;
  }
  const enrolled = state.enrolledCourses.includes(course.id);
  const importedEvents = state.importedSchedule.filter(item =>
    scheduleBelongsToCourse(item, course)
  );
  const imported = isStudent && importedEvents.length > 0;
  const courseSchedule = state.backendSchedule
    .filter(item => item.courseId === course.id)
    .map((item, index) => ({ ...item, scheduleIndex: index }));
  const source = imported ? importedEvents : courseSchedule;
  const todayIndex = (new Date().getDay() + 6) % 7;
  const events = source
    .map((item, index) => ({
      ...item,
      scheduleIndex: item.scheduleIndex ?? index,
      dayIndex: dayIndexFromName(item.day),
    }))
    .filter(item => item.dayIndex >= 0)
    .sort((left, right) =>
      left.dayIndex - right.dayIndex || timeToMinutes(left.start) - timeToMinutes(right.start)
    );
  const weekDays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const weekMonday = new Date();
  weekMonday.setHours(12, 0, 0, 0);
  weekMonday.setDate(weekMonday.getDate() - todayIndex);
  const calendarDays = weekDays.map((day, index) => {
    const date = new Date(weekMonday);
    date.setDate(weekMonday.getDate() + index);
    return {
      label: day.slice(0, 3).toUpperCase(),
      date: date.getDate(),
      today: index === todayIndex,
    };
  });
  const calendarSource = imported
    ? importedEvents.map(item => ({ ...item, courseId: course.id }))
    : state.backendSchedule;
  const calendarEvents = calendarSource
    .map(event => {
      const owner = state.courses.find(item => item.id === event.courseId) || course;
      return {
        ...event,
        dayIndex: dayIndexFromName(event.day),
        courseCode: owner.courseCode || "",
        topic: event.topic || owner.name,
        room: event.room || owner.room || "Room TBA",
        otherCourse: owner.id !== course.id,
      };
    })
    .filter(event => event.dayIndex >= 0)
    .map(event => ({ ...event, today: event.dayIndex === todayIndex }));
  const calendarCourseCount = new Set(calendarEvents.map(event => event.courseId)).size;
  setHeader(`${course.name} schedule`, `${course.courseCode} · WEEKLY AGENDA`, false);
  view.innerHTML = `
    ${state.courses.some(canManageSchedule) ? `<div class="schedule-toolbar">
      <div><strong>Weekly timetable</strong><span>Upload one grid covering every course you teach. Each class is filed under the course code in its cell; anything unlabelled goes to ${escapeHtml(course.courseCode)}. Courses named in the file have their classes replaced.</span></div>
      <div class="setup-actions">
        <label class="btn btn-primary" for="timetableFile">${icon("i-upload")} Upload timetable</label>
        <input id="timetableFile" class="visually-hidden" type="file" />
      </div>
    </div>` : ""}
    <article class="card page-card calendar-page schedule-calendar-card">
      <div class="calendar-titlebar">
        <div><span class="calendar-kicker">${icon("i-calendar")} WEEK CALENDAR</span><h2>All courses</h2><p>${calendarCourseCount > 1 ? `Every course you teach or attend · ${calendarCourseCount} courses` : "Your full week across every course"}</p></div>
        <div class="calendar-title-actions"><span class="badge ${imported ? "green" : "purple"}">${imported ? "Local timetable" : `${calendarEvents.length} sessions`}</span><button class="btn btn-soft" data-action="calendar-today">Today</button></div>
      </div>
      <div class="calendar-scroll" aria-label="Weekly class calendar across all courses">
        <div class="calendar-board">
          <div class="calendar-days"><span class="calendar-zone">IST</span>${calendarDays.map(day => `<span class="${day.today ? "is-today" : ""}"><small>${day.label}</small><strong>${day.date}</strong></span>`).join("")}</div>
          <div class="calendar-body">
            <div class="calendar-times">${["8 AM", "9 AM", "10 AM", "11 AM", "12 PM", "1 PM", "2 PM", "3 PM", "4 PM", "5 PM"].map(time => `<span>${time}</span>`).join("")}</div>
            <div class="calendar-lanes">${calendarDays.map((day, index) => `<div class="calendar-lane ${day.today ? "is-today" : ""}">${layoutDayEvents(calendarEvents.filter(event => event.dayIndex === index)).map(event => calendarEvent(event)).join("")}</div>`).join("")}</div>
          </div>
        </div>
      </div>
    </article>
    <article class="card page-card weekly-agenda-card">
      <div class="section-head"><div><h2 style="margin:0 0 5px">Entire week</h2><p class="stat-label">Previous days remain visible, followed by today and upcoming classes.</p></div><div class="setup-actions"><span class="badge ${imported ? "green" : "purple"}">${imported ? "Local timetable" : `${events.length} sessions`}</span>${isStudent ? `<label class="btn" for="scheduleFile">${icon("i-upload")} Import CSV / ICS</label><input id="scheduleFile" class="visually-hidden" type="file" />` : ""}</div></div>
      <div class="weekly-agenda">
        ${weekDays.map((day, dayIndex) => weeklyAgendaDay({
          day,
          dayIndex,
          todayIndex,
          events: events.filter(event => event.dayIndex === dayIndex),
          course,
          isStudent,
          enrolled,
          editable: canManageSchedule(course),
        })).join("")}
      </div>
      ${isStudent ? `<div class="setup-actions" style="margin-top:16px">${imported ? `<button class="btn btn-danger" data-action="clear-imported-schedule">Clear imported schedule</button>` : ""}</div><div class="security-note" style="margin-top:16px"><span class="lock">⌾</span><span>Your imported file stays on this device and is attached to ${escapeHtml(course.courseCode)}.</span></div>` : ""}
      ${isStudent && !enrolled ? `<div class="security-note" style="margin-top:16px"><span class="lock">⌾</span><span>Ask the course professor for the private join code to unlock activities.</span></div>` : ""}
    </article>
    ${canManageSchedule(course) ? scheduleEditor(course, courseSchedule) : ""}`;
}

function weeklyAgendaDay({ day, dayIndex, todayIndex, events, course, isStudent, enrolled, editable }) {
  const status = dayIndex < todayIndex ? "Previous" : dayIndex === todayIndex ? "Today" : "Upcoming";
  const tone = status === "Previous" ? "gray" : status === "Today" ? "purple" : "green";
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - todayIndex + dayIndex);
  const dateLabel = date.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
  });
  return `<section class="weekly-agenda-day ${status.toLowerCase()}">
    <div class="weekly-agenda-day-head"><div><h3>${escapeHtml(day)}</h3><span>${escapeHtml(dateLabel)} · ${events.length} ${events.length === 1 ? "class" : "classes"}</span></div><span class="badge ${tone}">${status}</span></div>
    <div class="agenda-class-list">
      ${events.length
        ? events.map(event => weeklyAgendaClass(event, course, { isStudent, enrolled, editable, today: status === "Today" })).join("")
        : `<div class="empty-agenda compact"><span>No classes</span></div>`}
    </div>
  </section>`;
}

function weeklyAgendaClass(event, course, { isStudent, enrolled, editable, today }) {
  const subtopics = Array.isArray(event.subtopics) ? event.subtopics : [];
  const room = event.room || course.room || "Room TBA";
  const attendanceAction = today && !isStudent && canRunAttendance(course)
    ? `<button class="btn btn-primary" data-action="open-dashboard-attendance" data-course-id="${escapeHtml(course.id)}">${icon("i-play")} Attendance</button>`
    : today && isStudent && !enrolled
      ? `<button class="btn" data-route-link="classes">Join course</button>`
      : "";
  return `<article class="agenda-class ${today ? "is-today" : ""}">
    <div class="agenda-class-time"><strong>${escapeHtml(event.start || "Time TBA")}</strong><span>${escapeHtml(event.end || "")}</span></div>
    <div class="agenda-class-main"><div class="agenda-class-title"><strong>${escapeHtml(event.topic || course.name)}</strong><span>${escapeHtml(room)}</span></div><p>${escapeHtml(course.courseCode)} · ${escapeHtml(course.name)}</p>${subtopics.length ? `<div class="subtopic-list">${subtopics.map((topic, index) => `<span><b>${index + 1}</b>${escapeHtml(topic)}</span>`).join("")}</div>` : `<span class="stat-label">No sub-classes or topic breakdown added</span>`}</div>
    <div class="agenda-class-actions">${attendanceAction}${editable ? `<button class="btn btn-soft" data-action="edit-class-topics" data-index="${event.scheduleIndex}">Edit topics</button>` : ""}</div>
  </article>`;
}

// A timetable grid usually covers a whole week, so one cell may name a course
// other than the open one. Each class goes to the course whose code it carries.
function groupClassesByCourse(classes, fallbackCourse) {
  const manageable = state.courses.filter(canManageSchedule);
  // Longest code first so "ME60215A" is not matched by "ME60215".
  const codes = manageable
    .map(course => ({ course, code: String(course.courseCode || "").toUpperCase() }))
    .filter(entry => entry.code.length >= 3)
    .sort((left, right) => right.code.length - left.code.length);
  const grouped = new Map();
  for (const item of classes) {
    const text = `${item.topic || ""} ${item.room || ""}`.toUpperCase();
    const match = codes.find(entry => text.includes(entry.code));
    const course = match ? match.course : fallbackCourse;
    if (!course) continue;
    // Strip the code out of the label; whatever is left is usually the room.
    let topic = String(item.topic || "").trim();
    let room = String(item.room || "").trim();
    if (match) {
      const remainder = topic
        .replace(new RegExp(match.code, "ig"), " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!room && remainder) room = remainder;
      topic = course.courseCode;
    }
    if (!grouped.has(course.id)) grouped.set(course.id, { course, classes: [] });
    grouped.get(course.id).classes.push({ ...item, topic, room });
  }
  return [...grouped.values()];
}

async function saveCourseSchedule(course, classes, message, { silent = false } = {}) {
  try {
    const result = await apiRequest(`/api/courses/${encodeURIComponent(course.id)}/schedule`, {
      method: "PUT",
      body: {
        classes,
        revision: Number(course.scheduleRevision) || 0,
      }
    });
    state.backendSchedule = [
      ...state.backendSchedule.filter(item => item.courseId !== course.id),
      ...(result.schedule || [])
    ];
    state.courses = state.courses.map(item =>
      item.id === course.id
        ? { ...item, scheduleRevision: result.revision }
        : item
    );
    persist();
    await syncClassReminders();
    if (silent) return true;
    renderSchedule();
    return toast(message);
  } catch (error) {
    // A batch import reports once for the whole file, so let it handle this.
    if (silent) throw error;
    if (error.status === 409 && backendConfigured()) {
      await syncBackendState().catch(() => {});
      if (state.route === "schedule") renderSchedule();
      return toast(
        "The timetable changed elsewhere. Latest classes loaded; review and save again.",
        "error"
      );
    }
    return toast(error.message || "Could not save the timetable", "error");
  }
}

function scheduleEditor(course, entries) {
  return `<article class="card page-card" style="margin-top:22px">
    <div class="section-head"><div><h2 style="margin:0 0 5px">Weekly timetable</h2><p class="stat-label">${escapeHtml(course.courseCode)} · shown in the teaching team's and students' weekly agenda</p></div><span class="badge ${entries.length ? "green" : "amber"}">${entries.length} classes</span></div>
    ${entries.length ? `<table class="roster-table" style="margin-bottom:14px">
      <thead><tr><th>Day</th><th>Time</th><th>Class topic</th><th>Sub-classes</th><th>Room</th><th></th></tr></thead>
      <tbody>${entries.map((item, index) => `<tr>
        <td>${escapeHtml(item.day || "")}</td>
        <td>${escapeHtml(item.start || "")}${item.end ? `<br><span class="stat-label">to ${escapeHtml(item.end)}</span>` : ""}</td>
        <td>${escapeHtml(item.topic || course.name)}</td>
        <td>${Array.isArray(item.subtopics) && item.subtopics.length ? item.subtopics.map(topic => `<span class="table-subtopic">${escapeHtml(topic)}</span>`).join("") : `<span class="stat-label">None yet</span>`}</td>
        <td>${escapeHtml(item.room || "")}</td>
        <td class="roster-actions"><div class="setup-actions"><button class="text-btn" type="button" data-action="edit-class-topics" data-index="${index}">Edit topics</button><button class="text-btn danger" type="button" data-action="remove-schedule-class" data-index="${index}">Remove</button></div></td>
      </tr>`).join("")}</tbody>
    </table>` : `<p class="stat-label" style="padding:6px 2px 14px">No classes yet. Add them by hand, or upload your timetable.</p>`}
    <form id="addClassForm" class="field-grid">
      <div class="field"><label for="classDay">Day</label>
        <select class="select" id="classDay" name="day" required>
          ${["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map(day => `<option value="${day}">${day}</option>`).join("")}
        </select>
      </div>
      <div class="field"><label for="classStart">Start</label><input class="text-input" id="classStart" name="start" placeholder="3:00 PM" required /></div>
      <div class="field"><label for="classEnd">End</label><input class="text-input" id="classEnd" name="end" placeholder="5:00 PM" /></div>
      <div class="field"><label for="classTopic">Class</label><input class="text-input" id="classTopic" name="topic" placeholder="${escapeHtml(course.courseCode)}" /></div>
      <div class="field"><label for="classRoom">Room</label><input class="text-input" id="classRoom" name="room" placeholder="${escapeHtml(course.room || "NR221")}" /></div>
      <div class="field full"><label for="classSubtopics">Sub-classes / topic breakdown</label><textarea class="text-input" id="classSubtopics" name="subtopics" rows="3" placeholder="One item per line, e.g.&#10;Introduction&#10;Worked example&#10;Questions"></textarea></div>
      <div class="field" style="justify-content:flex-end"><button class="btn btn-primary" type="submit">${icon("i-plus")} Add class</button></div>
    </form>
    <div class="security-note" style="margin-top:14px"><span class="lock">⌾</span><span>Use <strong>Upload timetable</strong> at the top of this page to import a weekly grid or a day/start/end/subject list.</span></div>
  </article>`;
}

function dayIndexFromName(day = "") {
  const key = day.trim().slice(0, 3).toLowerCase();
  return ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].indexOf(key);
}

function timeToMinutes(value = "") {
  const match = value.trim().match(/(\d{1,2}):?(\d{2})?\s*(AM|PM)?/i);
  if (!match) return 8 * 60;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const period = match[3]?.toUpperCase();
  if (period === "PM" && hour !== 12) hour += 12;
  if (period === "AM" && hour === 12) hour = 0;
  return hour * 60 + minute;
}

// Classes that share a time slot are placed in adjacent columns so a card can
// hold several courses at once without one covering the others.
function layoutDayEvents(events) {
  const sorted = [...events].sort(
    (left, right) =>
      timeToMinutes(left.start) - timeToMinutes(right.start) ||
      timeToMinutes(left.end) - timeToMinutes(right.end)
  );
  const columnEnds = [];
  // Times are kept separate so the displayed start and end stay untouched.
  const placed = sorted.map(event => {
    const from = timeToMinutes(event.start);
    const to = Math.max(from + 35, timeToMinutes(event.end));
    let column = columnEnds.findIndex(columnEnd => columnEnd <= from);
    if (column < 0) {
      column = columnEnds.length;
      columnEnds.push(to);
    } else {
      columnEnds[column] = to;
    }
    return { event, column, from, to };
  });
  // Every class in a run of overlaps shares the same column count.
  return placed.map(item => {
    const overlapping = placed.filter(
      other => other.from < item.to && item.from < other.to
    );
    return {
      ...item.event,
      column: item.column,
      columns: Math.max(...overlapping.map(other => other.column + 1)),
    };
  });
}

function calendarEvent(event) {
  const start = Math.max(8 * 60, Math.min(18 * 60, timeToMinutes(event.start)));
  const end = Math.max(start + 35, Math.min(18 * 60, timeToMinutes(event.end)));
  const top = ((start - 8 * 60) / (10 * 60)) * 100;
  const height = Math.max(8, ((end - start) / (10 * 60)) * 100);
  const columns = Math.max(1, Number(event.columns) || 1);
  const column = Math.min(columns - 1, Math.max(0, Number(event.column) || 0));
  return `<article class="calendar-event ${event.today ? "current" : ""} ${event.otherCourse ? "is-other-course" : ""}" style="--event-top:${top}%;--event-height:${height}%;--event-columns:${columns};--event-column:${column}">
    ${event.courseCode ? `<em class="calendar-event-course">${escapeHtml(event.courseCode)}</em>` : ""}
    <strong>${escapeHtml(event.topic)}</strong><span>${escapeHtml(event.start)} · ${escapeHtml(event.room || "Room TBA")}</span>
  </article>`;
}

function scheduleDay(event, course, isStudent, enrolled) {
  const action = event.today
    ? isStudent
      ? enrolled
        ? `<span class="badge gray">Teaching-team attendance</span>`
        : `<button class="btn" data-route-link="classes">${icon("i-plus")} Join course</button>`
      : canRunAttendance(course)
        ? `<button class="btn btn-primary" data-route-link="attendance" data-course-id="${escapeHtml(course.id)}">${icon("i-play")} Take attendance</button>`
        : `<span class="badge gray">Attendance unavailable</span>`
    : `<span class="badge ${event.status === "Completed" ? "green" : "gray"}">${event.status}</span>`;
  return `<div class="schedule-day ${event.today ? "today" : ""}">
    <div class="schedule-date"><strong>${escapeHtml(event.day)}</strong><span>${escapeHtml(event.date)}</span></div>
    <div class="schedule-time"><strong>${escapeHtml(event.start)}</strong><span>${escapeHtml(event.end)}</span></div>
    <div class="schedule-info"><strong>${escapeHtml(event.topic)}</strong><span>${escapeHtml(course.name)} · ${escapeHtml(course.courseCode)} · ${escapeHtml(event.room || "Room TBA")}</span></div>
    <div class="schedule-action">${action}</div>
  </div>`;
}

function studentCourseCard(course) {
  return `<article class="course-card">
    <div class="course-accent"></div><span class="badge green">Enrolled</span>
    <h3 style="margin-top:12px">${escapeHtml(course.name)}</h3><p>${escapeHtml(course.courseCode)} · ${escapeHtml(course.room)}</p>
    <div class="course-footer"><span>${icon("i-users")} ${course.students} classmates</span><button class="text-btn" data-action="open-course-quiz" data-course-id="${escapeHtml(course.id)}">Quizzes</button></div>
  </article>`;
}

function classRow(time, suffix, title, meta, badge, color, route, courseId = "") {
  return `<div class="class-row">
    <div class="time">${escapeHtml(time)}<small>${escapeHtml(suffix)}</small></div>
    <div class="course"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(meta)}</span></div>
    <span class="badge ${color}">${escapeHtml(badge)}</span>
    ${route ? `<button class="chevron" data-route-link="${route}" ${courseId ? `data-course-id="${escapeHtml(courseId)}"` : ""} aria-label="Open ${escapeHtml(title)}">${icon("i-arrow")}</button>` : `<span class="badge gray">Read only</span>`}
  </div>`;
}

async function refreshAttendanceHistory(courseId) {
  if (!backendConfigured() || !apiToken) {
    attendanceHistory = null;
    return;
  }
  try {
    attendanceHistory = await apiRequest(
      `/api/attendance/history${courseId ? `?courseId=${encodeURIComponent(courseId)}` : ""}`
    );
  } catch {
    attendanceHistory = null;
  }
}

function attendanceDayLabel(session) {
  const when = new Date(session.startedAt);
  return Number.isNaN(when.getTime())
    ? "Class"
    : when.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short", year: "numeric" });
}

function shortDate(value) {
  const when = new Date(value);
  return Number.isNaN(when.getTime())
    ? ""
    : when.toLocaleDateString([], { day: "numeric", month: "short" });
}

function stamp(value) {
  const when = new Date(value);
  return Number.isNaN(when.getTime())
    ? ""
    : when.toLocaleString([], { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" });
}

// Only registers that actually exist belong in attendance history. The
// timetable is a plan, not proof that attendance was taken on that date.
function studentClassDays(course, sessions) {
  return sessions.map(session => {
    const when = new Date(session.startedAt);
    if (Number.isNaN(when.getTime())) return null;
    return {
      key: session.id,
      date: when,
      dayName: WEEKDAY_NAMES[(when.getDay() + 6) % 7],
      classLabel: session.classLabel || (session.importedAt ? "Paper register" : "Extra class"),
      room: session.room || course.room || "",
      session,
      present: Boolean(session.present),
    };
  }).filter(Boolean).sort((left, right) => right.date - left.date);
}

// The student's own record for the course in view.
function renderStudentAttendance() {
  const course = selectedCourse();
  setHeader("My attendance", course ? `${course.courseCode} · YOUR RECORD` : "YOUR RECORD", false);
  if (!course) {
    view.innerHTML = `<article class="card empty-state"><div><span class="empty-icon">${icon("i-users")}</span><h2>No course yet</h2><p>Join a course to see your attendance.</p><button class="btn btn-primary" data-route-link="classes">Join a course</button></div></article>`;
    return;
  }
  const summary = attendanceHistory?.summary;
  const sessions = attendanceHistory?.sessions || [];
  const percentage = summary?.percentage ?? 0;
  const classDays = studentClassDays(course, sessions);
  const openNow = selfMarkableSessions(course.id);
  const liveSession = openNow.find(item => item.courseId === course.id) || null;
  // Attendance open in a course that is not the one in view still belongs on
  // this page — hunting for the right tab is how a mark gets missed.
  const elsewhere = openNow.filter(item => item.courseId !== course.id);
  view.innerHTML = `
    <div class="left-stack">
      ${liveSession
        ? attendanceCallCard(liveSession)
        : `<article class="card page-card attendance-call is-idle">
            <div class="section-head"><h3>Mark attendance</h3><span class="badge gray">Closed</span></div>
            <p class="attendance-call-copy">Attendance is not open for ${escapeHtml(course.courseCode)}. This turns on the moment your professor or TA starts it, and your phone will find the class over Bluetooth.</p>
            <button class="btn btn-primary attendance-call-submit" type="button" disabled>${icon("i-check")} Mark me present</button>
          </article>`}
      ${elsewhere.length ? `<p class="stat-label" style="margin:-6px 2px 0">Attendance is also open in ${elsewhere.length === 1 ? "another course" : `${elsewhere.length} other courses`} you are enrolled in.</p>
        <div class="attendance-call-stack">${elsewhere.map(attendanceCallCard).join("")}</div>` : ""}
      <article class="card page-card">
        <div class="section-head"><div><h2 style="margin:0 0 5px">${escapeHtml(course.name)}</h2><p class="stat-label">${escapeHtml(course.courseCode)} · your attendance so far</p></div><span class="badge ${percentage >= 75 ? "green" : percentage >= 50 ? "amber" : "gray"}">${percentage}%</span></div>
        <div class="stat-grid" style="margin-top:18px">
          <article class="card stat"><div class="stat-top"><span class="stat-icon green">${icon("i-check")}</span></div><div class="stat-value">${summary?.attended ?? 0}</div><div class="stat-label">Classes attended</div></article>
          <article class="card stat"><div class="stat-top"><span class="stat-icon amber">${icon("i-clock")}</span></div><div class="stat-value">${summary?.missed ?? 0}</div><div class="stat-label">Classes missed</div></article>
          <article class="card stat"><div class="stat-top"><span class="stat-icon">${icon("i-calendar")}</span><span class="trend">${summary?.held ?? 0} held</span></div><div class="stat-value">${percentage}%</div><div class="stat-label">Attendance</div></article>
        </div>
      </article>
      <article class="card page-card">
        <div class="section-head"><div><h2 style="margin:0 0 5px">Recorded classes</h2><p class="stat-label">Only classes where attendance was actually taken.</p></div><span class="badge gray">${classDays.length}</span></div>
        ${classDays.length ? `<div class="class-list">
          ${classDays.map(day => `<button class="class-row attendance-day" type="button" data-action="open-attendance-day" data-session-id="${escapeHtml(day.session.id)}">
            <div class="time">${escapeHtml(day.dayName.slice(0, 3))}<small>${escapeHtml(day.date.toLocaleDateString([], { day: "numeric", month: "short" }))}</small></div>
            <div class="course"><strong>${escapeHtml(day.classLabel)}</strong><span>${escapeHtml(day.room || "Room TBA")}</span></div>
            <span class="badge ${day.present ? "green" : "gray"}">${day.present ? "Present" : "Absent"}</span>
            <span class="chevron">${icon("i-arrow")}</span>
          </button>`).join("")}
        </div>` : `<p class="stat-label">No attendance has been taken for this course yet.</p>`}
      </article>
    </div>`;
}

function renderAttendanceDay() {
  const course = selectedCourse();
  const session = (attendanceHistory?.sessions || []).find(item => item.id === attendanceDayId);
  if (!session) return goBack();
  setHeader(attendanceDayLabel(session), `${session.courseCode || course?.courseCode || ""} · CLASS DETAIL`, false);
  view.innerHTML = `
    <button class="back-btn" type="button" data-action="go-back">${icon("i-back")} Back</button>
    <div class="page-grid">
      <article class="card page-card">
        <div class="section-head"><div><h2 style="margin:0 0 5px">${escapeHtml(session.classLabel || session.courseName || "Class")}</h2><p class="stat-label">${escapeHtml(attendanceDayLabel(session))}</p></div><span class="badge ${session.present ? "green" : "gray"}">${session.present ? "Present" : "Absent"}</span></div>
        <div class="summary-list" style="margin-top:18px">
          <div class="summary-item"><span>Course</span><strong>${escapeHtml(session.courseCode || "")} · ${escapeHtml(session.courseName || "")}</strong></div>
          <div class="summary-item"><span>Room</span><strong>${escapeHtml(session.room || "Room TBA")}</strong></div>
          ${session.importedAt
            ? `<div class="summary-item"><span>Source</span><strong>Paper register</strong></div>
               <div class="summary-item"><span>Your record</span><strong>${session.present ? "Present" : "Absent"}</strong></div>`
            : `<div class="summary-item"><span>Session opened</span><strong>${escapeHtml(stamp(session.startedAt))}</strong></div>
               <div class="summary-item"><span>Session closed</span><strong>${session.closedAt ? escapeHtml(stamp(session.closedAt)) : "Still open"}</strong></div>
               <div class="summary-item"><span>You were marked</span><strong>${session.present ? escapeHtml(stamp(session.markedAt)) : "Not marked"}</strong></div>
               ${session.present && session.markedVia ? `<div class="summary-item"><span>Marked by</span><strong>${escapeHtml(attendanceMethodLabel(session.markedVia, { self: true }))}</strong></div>` : ""}`}
        </div>
        ${session.present ? "" : `<div class="security-note" style="margin-top:16px"><span class="lock">⌾</span><span>Nothing was recorded for you in this class. Speak to your professor or TA if that looks wrong.</span></div>`}
      </article>
    </div>`;
}

function renderAttendance() {
  const course = selectedCourse();
  if (state.userRole === "student") return renderStudentAttendance();
  if (!course || !canRunAttendance(course)) return renderRestrictedAttendance();
  setHeader("Attendance session", `${course.name.toUpperCase()} · ${course.courseCode}`, false);
  if (backendConfigured() && apiToken && pastSessionsLoadedFor !== course.id) {
    refreshPastSessions(course.id).then(() => {
      if (state.route === "attendance" && state.selectedCourseId === course.id) renderAttendance();
    });
  }
  // A student's record replaces the register while it is open.
  if (studentRecord) return renderStudentRecord();
  // Browsing a past class wins over the setup screen, so history stays readable
  // on a day with no session of its own.
  if (viewingPastAttendance) return renderLiveAttendance();
  if (!backendConfigured() || state.attendanceStatus === "not_started" || !activeAttendance) {
    return renderAttendanceSetup();
  }
  return renderLiveAttendance();
}

function renderRestrictedAttendance() {
  setHeader("Attendance access restricted", "COURSE TEAM ONLY", false);
  // Landing here with attendance open in a course this account attends rather
  // than assists must still leave a way to mark itself present.
  const selfMark = selfMarkableSessions();
  view.innerHTML = `
    ${selfMark.length ? `<div class="attendance-call-stack">${selfMark.map(attendanceCallCard).join("")}</div>` : ""}
    <article class="card empty-state"><div><span class="empty-icon">${icon("i-users")}</span><h2>Course-team access required</h2><p>Attendance is available only to the professor who owns the course and teaching assistants enrolled in it. Students and unrelated staff cannot view or change attendance.</p><button class="btn btn-primary" data-route-link="classes">Open courses</button></div></article>`;
}

function renderAttendanceSetup() {
  if (!backendConfigured()) {
    view.innerHTML = `<article class="card empty-state"><div><span class="empty-icon">${icon("i-cloud")}</span><h2>Connect the secure API</h2><p>The official student rosters are kept on the server and are never bundled into the public app. Connect CampusPulse before taking attendance.</p><button class="btn btn-primary" data-route-link="settings">Open settings</button></div></article>`;
    return;
  }
  const availableCourses = state.courses.filter(canRunAttendance);
  const course = selectedCourse();
  if (!course || !canRunAttendance(course)) return renderRestrictedAttendance();
  if (!courseRosters.has(course.id)) {
    view.innerHTML = `<article class="card empty-state"><div><span class="empty-icon">${icon("i-users")}</span><h2>Loading official roster</h2><p>Checking your course-scoped attendance access.</p></div></article>`;
    loadCourseRoster(course.id)
      .then(() => {
        if (state.route === "attendance" && state.selectedCourseId === course.id) {
          renderAttendanceSetup();
        }
      })
      .catch((error) => {
        view.innerHTML = `<article class="card empty-state"><div><span class="empty-icon">${icon("i-users")}</span><h2>Roster unavailable</h2><p>${escapeHtml(error.message || "Could not load this roster")}</p><button class="btn" type="button" data-action="go-back">Back</button></div></article>`;
      });
    return;
  }
  const roster = courseRosters.get(course.id) || [];
  const ready = roster.length > 0;
  const selfMark = selfMarkableSessions(course.id);
  view.innerHTML = `
    <button class="back-btn" type="button" data-action="go-back">${icon("i-back")} Back</button>
    <div class="page-grid">
      <div class="left-stack">
        ${selfMark.length ? `<div class="attendance-call-stack">${selfMark.map(attendanceCallCard).join("")}</div>` : ""}
        <article class="card page-card">
          ${sessionHeading(ready ? "Choose the official roster" : "Upload the roll list first", "Attendance has not started yet", "amber")}
          ${stepper(1)}
          <div class="roster-picker">
            <label for="attendanceCourseSelect">Course roster</label>
            <select class="select" id="attendanceCourseSelect">
              ${availableCourses.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === course.id ? "selected" : ""}>${escapeHtml(item.courseCode)} · ${escapeHtml(item.name)} (${item.students})</option>`).join("")}
            </select>
            <div class="roster-source-card">
              <span class="student-avatar">${roster.length}</span>
              <div><strong>${escapeHtml(course.name)}</strong><p>${escapeHtml(course.courseCode)} · ${ready ? `${roster.length} students` : "no roll list uploaded yet"}</p></div>
              <span class="badge ${ready ? "green" : "amber"}">${ready ? "Official roster ready" : "Roll list required"}</span>
            </div>
          </div>
          ${ready
            ? `<div class="security-note"><span class="lock">⌾</span><span>This list is visible only to the course-owning professor and enrolled teaching assistants. Each session stores a roster snapshot so marks stay linked to roll numbers.</span></div>`
            : `<div class="security-note"><span class="lock">⌾</span><span>Attendance runs against your official roll list. Upload it as Excel (.xlsx), PDF, CSV, or JSON — only a name column is required, and roll number, email, phone and any other columns are kept against each student. Students can only mark themselves once a roll list exists.</span></div>`}
          <div class="setup-actions">
            <button class="btn" data-route-link="dashboard">Cancel</button>
            ${ready
              ? `<button class="btn btn-primary" data-action="start-scan">${icon("i-play")} Take attendance</button>`
              : canManageRoster(course)
                ? `<button class="btn btn-primary" data-action="view-course-roster" data-course-id="${escapeHtml(course.id)}">${icon("i-upload")} Upload roll list</button>`
                : `<span class="badge gray">Waiting for the professor's roll list</span>`}
          </div>
        </article>
        ${attendanceOverview()}
        ${pastSessionsListCard()}
      </div>
      ${attendanceSidePanel(roster.map(student => ({ ...student, present: false })))}
    </div>`;
}

function sessionHeading(title, subtitle, color) {
  const course = selectedCourse();
  return `<div class="session-title"><div><h2>${title}</h2><p>${subtitle} · ${escapeHtml(course.courseCode)} · ${escapeHtml(course.room || "Room TBA")}</p></div><span class="badge ${color}">${state.attendanceStatus === "complete" ? "Completed" : state.attendanceStatus === "scanning" ? "In progress" : "Setup"}</span></div>`;
}

function stepper(current) {
  return `<div class="stepper"><div class="step ${current === 1 ? "active" : current > 1 ? "done" : ""}">1. Choose roster</div><div class="step ${current === 2 ? "active" : current > 2 ? "done" : ""}">2. Mark students</div><div class="step ${current === 3 ? "active" : ""}">3. Review</div></div>`;
}

function attendanceSidePanel(records, sessionOverride) {
  const total = records.length;
  const count = records.filter(record => record.present).length;
  const percent = total ? Math.round((count / total) * 100) : 0;
  const session = sessionOverride || activeAttendance;
  const startedAt = session?.startedAt
    ? new Date(session.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "—";
  const missingLabel = state.attendanceStatus === "not_started" ? "Unmarked" : "Absent";
  return `<aside class="card page-card">
    <div class="section-head"><h3>Session summary</h3><span class="badge purple">${escapeHtml(selectedCourse().courseCode)}</span></div>
    <div class="summary-ring" style="--progress:${percent}%"><div><strong>${count}</strong><span>of ${total} present</span></div></div>
    <div class="summary-list">
      <div class="summary-item"><span>Present</span><strong>${count}</strong></div>
      <div class="summary-item"><span>${missingLabel}</span><strong>${total - count}</strong></div>
      <div class="summary-item"><span>Flagged</span><strong>0</strong></div>
      ${session?.importedAt
        ? '<div class="summary-item"><span>Source</span><strong>Paper register</strong></div>'
        : `<div class="summary-item"><span>Started at</span><strong>${startedAt}</strong></div>`}
    </div>
    <div class="security-note"><span class="lock">⌾</span><span>The course professor and enrolled TAs can mark and close attendance. Students cannot change attendance records.</span></div>
  </aside>`;
}

function renderLiveAttendance() {
  clearInterval(scanTimer);
  const previousRoster = view.querySelector(".roster-scroll");
  const previousScrollTop = previousRoster?.scrollTop || 0;
  const focusedRollNumber = document.activeElement?.dataset?.rollNumber || "";
  // Browsing a past day is always read-only; only today's open session can be edited.
  const viewingPast = Boolean(viewingPastAttendance);
  const complete = viewingPast || state.attendanceStatus === "complete";
  const records = viewingPast ? (viewingPastAttendance.records || []) : currentAttendanceRecords();
  const count = records.filter(record => record.present).length;
  const shown = records.filter(record => matchesSearch(record, rosterSearch));
  const reopenTargetId = viewingPast ? viewingPastAttendance.id : state.backendAttendanceId;
  const selfMark = viewingPast ? [] : selfMarkableSessions();
  view.innerHTML = `
    <button class="back-btn" type="button" data-action="go-back">${icon("i-back")} Back</button>
    <div class="page-grid">
      <div class="left-stack">
        ${selfMark.length ? `<div class="attendance-call-stack">${selfMark.map(attendanceCallCard).join("")}</div>` : ""}
        <article class="card page-card">
          ${sessionHeading(
            viewingPast ? "Past attendance" : complete ? "Review attendance" : "Mark attendance",
            viewingPast
              ? new Date(viewingPastAttendance.startedAt).toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" })
              : complete ? "Session closed and saved" : "Select each student who is present",
            viewingPast ? "gray" : complete ? "green" : "purple"
          )}
          ${pastSessionsPicker()}
          ${!complete ? (beaconToken ? `<div class="proximity-code">
            <div><span>Broadcasting to the room</span><strong>${icon("i-check")} Bluetooth active</strong></div>
            <p>Installed apps use Bluetooth automatically. iPhone website users see this session too and can verify the same classroom Wi‑Fi plus location.${beaconRotating ? " You can lock this phone or use another app: the broadcast keeps running until you close attendance." : ""}</p>
          </div>` : proximityPlugin() ? (beaconError ? `<div class="proximity-code no-ble">
            <div><span>Bluetooth not available</span><strong>${icon("i-close")} Not broadcasting</strong></div>
            <p>${escapeHtml(beaconError)}${activeAttendance?.webCheckInAvailable ? " iPhone website users can still check in through the classroom Wi‑Fi and location fallback." : ""}</p>
            <button class="btn btn-soft" type="button" data-action="retry-beacon">Try broadcasting again</button>
          </div>` : `<div class="proximity-code no-ble">
            <div><span>Connecting</span><strong>${icon("i-clock")} Starting broadcast…</strong></div>
            <p>Turn Bluetooth on if you're asked to, then wait a moment — broadcasting starts automatically.</p>
          </div>`) : `<div class="proximity-code no-ble">
            <div><span>Web browser</span><strong>${icon(activeAttendance?.webCheckInAvailable ? "i-check" : "i-close")} ${activeAttendance?.webCheckInAvailable ? "Wi‑Fi website check-in active" : "Manual marking only"}</strong></div>
            <p>${activeAttendance?.webCheckInAvailable ? "Students on the same classroom Wi‑Fi can verify their location and mark themselves present from the website." : "Bluetooth broadcasting needs the installed app, and this session did not capture the network and precise location needed for website check-in. Students can still be marked from the list below."}</p>
          </div>`) : ""}
          ${stepper(complete ? 3 : 2)}
          <div class="roster-toolbar">
            <div class="scan-status">${viewingPast ? icon("i-check") + " Closed session" : complete ? icon("i-check") + " Attendance closed" : '<span class="pulse"></span> Changes save to the course roster'}</div>
            <div class="roster-toolbar-actions">
              <button class="btn btn-soft" type="button" data-action="export-day-attendance">${icon("i-download")} Excel</button>
              <span class="badge ${complete ? "green" : "purple"}">${count} present</span>
            </div>
          </div>
          ${searchBox("attendanceSearch", rosterSearch, "Search this class by name or roll number")}
          ${rosterSearch ? `<p class="stat-label" style="margin:-4px 2px 10px">${shown.length} of ${records.length} students${shown.length ? "" : " — nothing matches that"}</p>` : ""}
          ${!complete ? `<div class="roster-bulk-actions"><button class="btn btn-soft" data-action="mark-all-attendance">Mark all present</button><button class="btn" data-action="clear-attendance">Clear all</button></div>` : ""}
          <div class="roster roster-scroll">
            ${shown.map(student => studentRow(student, records.indexOf(student), !complete)).join("")}
          </div>
          <div class="setup-actions">
            ${complete
              ? `<button class="btn" data-action="reopen-session" data-session-id="${escapeHtml(reopenTargetId || "")}">${icon("i-play")} Reopen to add students</button>`
              : `<div class="manual-add-row">
                  <input class="text-input" id="manualRollInput" type="text" placeholder="Roll number to add" autocomplete="off" style="flex:1" />
                  <button class="btn btn-soft" type="button" data-action="add-student-manual">${icon("i-plus")} Add</button>
                </div>
                <button class="btn btn-danger" data-action="end-session">Close attendance</button>`}
          </div>
        </article>
      ${attendanceOverview()}
      ${pastSessionsListCard()}
      </div>
      ${attendanceSidePanel(records, viewingPast ? viewingPastAttendance : null)}
    </div>`;

  const nextRoster = view.querySelector(".roster-scroll");
  if (nextRoster) nextRoster.scrollTop = previousScrollTop;
  if (focusedRollNumber) {
    [...view.querySelectorAll("[data-roll-number]")]
      .find(element => element.dataset.rollNumber === focusedRollNumber)
      ?.focus({ preventScroll: true });
  }

  if (viewingPast) return;

  if (!complete && backendConfigured() && state.backendAttendanceId) {
    startAttendanceBroadcast(
      state.backendAttendanceId,
      activeAttendance?.courseId || state.selectedCourseId
    );
  }
  if (!complete && backendConfigured() && state.backendAttendanceId) {
    scanTimer = setInterval(async () => {
      if (state.route !== "attendance" || state.attendanceStatus !== "scanning") return;
      try {
        const result = await apiRequest(`/api/attendance/${state.backendAttendanceId}`);
        if (result.attendance?.status === "closed") {
          activeAttendance = result.attendance;
          state.attendanceStatus = "complete";
          persist();
          return renderLiveAttendance();
        }
        const backendRecords = result.attendance?.records || [];
        const signature = backendRecords.map(record => `${record.rollNumber}:${record.present}`).join("|");
        const currentSignature = records.map(record => `${record.rollNumber}:${record.present}`).join("|");
        if (signature && signature !== currentSignature) {
          activeAttendance = result.attendance;
          renderLiveAttendance();
        }
      } catch {}
    }, 4000);
  }
}

function studentRow(student, index, interactive = false, rosterOnly = false) {
  const present = Boolean(student.present);
  const initials = student.name.split(" ").filter(Boolean).map(part => part[0]).join("").slice(0, 3);
  const roll = escapeHtml(student.rollNumber);
  const body = `
    <span class="student-avatar">${escapeHtml(initials)}</span>
    <div class="student-name"><strong>${escapeHtml(student.name)}</strong><span>${escapeHtml(student.rollNumber)} · No. ${student.serial || index + 1}</span></div>
    <span class="signal ${present ? "good" : ""}"><i></i><i></i><i></i><i></i></span>
    <span class="badge ${present ? "green" : rosterOnly ? "purple" : "gray"}">${present ? "Present" : rosterOnly ? "Rostered" : "Absent"}</span>`;

  // While the register is open the row toggles present/absent, so opening a
  // student's record needs its own control rather than stealing that tap. A
  // closed register has nothing to toggle, so the whole row opens the record.
  if (!interactive) {
    return `<div class="student-row-wrap">
      <button class="student-row attendance-row is-interactive" type="button" data-action="open-student-record" data-roll-number="${roll}">${body}</button>
      <span class="student-row-info" aria-hidden="true">${icon("i-arrow")}</span>
    </div>`;
  }
  return `<div class="student-row-wrap">
    <button class="student-row attendance-row is-interactive" type="button" data-action="toggle-attendance" data-roll-number="${roll}" aria-pressed="${present}">${body}</button>
    <button class="student-row-info" type="button" data-action="open-student-record" data-roll-number="${roll}" aria-label="Attendance record for ${escapeHtml(student.name)}">${icon("i-arrow")}</button>
  </div>`;
}

function renderQuiz() {
  if (state.userRole === "student") return renderStudentQuizAccess();
  const course = selectedCourse();
  if (!course || !canPublishQuiz(course)) {
    setHeader("Quizzes", "COURSE ACCESS", false);
    view.innerHTML = `<article class="card empty-state"><div><span class="empty-icon">${icon("i-quiz")}</span><h2>Course access required</h2><p>${state.userRole === "ta" ? "Join the professor's course before publishing quizzes." : "Create a course before publishing quizzes."}</p><button class="btn btn-primary" data-route-link="classes">Open courses</button></div></article>`;
    return;
  }
  setHeader("Quizzes", `${course.name.toUpperCase()} · ${course.courseCode}`, false);
  const openDraft = quizDrafts.find(item => item.id === editingDraftId) || null;
  const courseClasses = state.backendSchedule
    .filter(item => item.courseId === course.id)
    .sort(
      (left, right) =>
        dayIndexFromName(left.day) - dayIndexFromName(right.day) ||
        timeToMinutes(left.start) - timeToMinutes(right.start)
    );
  if (state.quizPublished && state.backendQuizCourseId === course.id) return renderLiveQuiz();
  setTimeout(() => snapQuizDateToClassDay(), 0);
  view.innerHTML = `
    <button class="back-btn" type="button" data-action="go-back">${icon("i-back")} Back</button>
    <div class="page-grid">
      <article class="card page-card">
        <div class="session-title"><div><h2>${openDraft ? `${escapeHtml(openDraft.title || "Untitled quiz")} · ${escapeHtml(course.courseCode)}` : `New quiz for ${escapeHtml(course.courseCode)}`}</h2><p>${openDraft
          ? `${[openDraft.day, formatQuizDate(openDraft.quizDate), openDraft.classLabel].filter(Boolean).map(escapeHtml).join(" · ") || escapeHtml(course.name)} — edit below, then publish when the class starts.`
          : `Goes only to ${escapeHtml(course.name)}. Pick another course on the right to build one for a different class.`}</p></div>${openDraft ? `<button class="text-btn" type="button" data-action="close-draft-quiz">Start a new quiz</button>` : `<span class="badge purple">Draft</span>`}</div>
        <div class="quiz-builder" id="quizBuilder">
          ${openDraft && openDraft.questions.length
            ? openDraft.questions
                .map((question, index) =>
                  questionBlock(
                    index + 1,
                    question.text || "",
                    question.options && question.options.length ? question.options : ["", "", "", ""],
                    Number(question.answer) || 0,
                    question.image || ""
                  )
                )
                .join("")
            : questionBlock(1)}
          <button class="add-question" data-action="add-question">${icon("i-plus")} Add another question</button>
        </div>
        <div class="setup-actions"><button class="btn" type="button" data-action="save-quiz-draft">${icon("i-check")} ${openDraft ? "Save changes" : "Save for later"}</button><button class="btn btn-primary" data-action="publish-quiz">${icon("i-send")} Publish to class</button></div>
      </article>
      <aside class="card page-card quiz-settings">
        <div class="saved-quizzes">
          <div class="section-head"><button class="section-link" type="button" data-action="open-past-quizzes"><h3>Past quiz</h3>${icon("i-arrow")}</button><span class="badge ${quizHistory.length ? "gray" : "gray"}">${quizHistory.length}</span></div>
          ${quizHistory.length
            ? quizHistory.map(item => `<div class="saved-quiz ${quizResults?.quiz?.id === item.id ? "is-open-draft" : ""}">
            <button class="saved-quiz-open" type="button" data-action="open-quiz-results" data-quiz-id="${escapeHtml(item.id)}">
              <strong>${escapeHtml(item.title || "Untitled quiz")}</strong>
              <span>${item.responses} response${item.responses === 1 ? "" : "s"}${item.classLabel ? ` · ${escapeHtml(item.classLabel)}` : ""} · ${escapeHtml(formatQuizDate(item.quizDate || item.publishedAt))}</span>
            </button>
          </div>`).join("")
            : `<p class="stat-label">No quiz has run yet. Open this to see the class list.</p>`}
        </div>
        <div class="saved-quizzes">
          <div class="section-head"><h3>Saved quiz</h3><span class="badge ${quizDrafts.length ? "purple" : "gray"}">${quizDrafts.length}</span></div>
          ${quizDrafts.length
            ? quizDrafts.map(draft => `<div class="saved-quiz ${draft.id === editingDraftId ? "is-open-draft" : ""}">
            <button class="saved-quiz-open" type="button" data-action="open-draft-quiz" data-quiz-id="${escapeHtml(draft.id)}">
              <strong>${escapeHtml(draft.title || "Untitled quiz")}</strong>
              <span>${draft.questions.length} question${draft.questions.length === 1 ? "" : "s"}${draft.classLabel ? ` · ${escapeHtml(draft.classLabel)}` : ""}${draft.id === editingDraftId ? " · open" : ""}</span>
            </button>
            <div class="saved-quiz-actions">
              <button class="btn btn-primary" type="button" data-action="publish-draft-quiz" data-quiz-id="${escapeHtml(draft.id)}">${icon("i-send")} Publish</button>
              <button class="text-btn danger" type="button" data-action="delete-draft-quiz" data-quiz-id="${escapeHtml(draft.id)}">Delete</button>
            </div>
          </div>`).join("")
            : `<p class="stat-label">Nothing saved yet. Build a quiz below and choose Save for later.</p>`}
        </div>
        <div class="section-head"><h3>Quiz settings</h3></div>
        <label for="quizCourseSelect">Course</label><select class="select" id="quizCourseSelect">${state.courses.filter(canPublishQuiz).map(item => `<option value="${escapeHtml(item.id)}" ${item.id === course.id ? "selected" : ""}>${escapeHtml(item.courseCode)} · ${escapeHtml(item.name)}</option>`).join("")}</select>
        <label for="quizTitle">Quiz title</label><input class="text-input" id="quizTitle" placeholder="e.g. Lecture 4 concept check" value="${openDraft ? escapeHtml(openDraft.title || "") : ""}" />
        <label for="quizClassSelect">Quiz for which class</label>
        ${courseClasses.length ? `<select class="select" id="quizClassSelect">
          <option value="" ${openDraft?.scheduleId ? "" : "selected"} disabled>Choose a class</option>
          ${courseClasses
            .map(item => {
              const label = scheduledClassLabel(item, course);
              return `<option value="${escapeHtml(item.id)}" data-day="${escapeHtml(item.day || "")}" data-label="${escapeHtml(label)}" ${openDraft?.scheduleId === item.id ? "selected" : ""}>${escapeHtml(label)}</option>`;
            })
            .join("")}
        </select>` : `<p class="stat-label">${escapeHtml(course.courseCode)} has no timetabled classes yet. Add them on the Schedule tab to tie a quiz to one.</p>`}
        <label for="quizDate">Date</label>
        <input class="text-input" id="quizDate" type="date" value="${openDraft?.quizDate ? escapeHtml(openDraft.quizDate) : new Date().toISOString().slice(0, 10)}" />
        <label for="duration">Time limit</label><select class="select" id="duration">${[[3, "3 minutes"], [5, "5 minutes"], [10, "10 minutes"], [0, "No limit"]].map(([value, label]) => `<option value="${value}" ${Number(openDraft?.timeLimitMinutes) === value ? "selected" : ""}>${label}</option>`).join("")}</select>
        <label for="reveal">Results</label><select class="select" id="reveal">${[["after-quiz", "Reveal after quiz ends"], ["after-answer", "Reveal after each answer"], ["private", "Keep private"]].map(([value, label]) => `<option value="${value}" ${(openDraft?.reveal || "after-quiz") === value ? "selected" : ""}>${label}</option>`).join("")}</select>
        <div class="security-note"><span class="lock">✦</span><span>Quiz responses are linked to the active course and visible only to its teaching team.</span></div>
      </aside>
    </div>`;
}

async function refreshMyQuizzes(courseId) {
  if (!backendConfigured() || !apiToken || state.userRole !== "student") {
    myQuizzes = [];
    return;
  }
  try {
    const payload = await apiRequest(
      `/api/quizzes/mine${courseId ? `?courseId=${encodeURIComponent(courseId)}` : ""}`
    );
    myQuizzes = Array.isArray(payload.quizzes) ? payload.quizzes : [];
  } catch {
    myQuizzes = [];
  }
}

// A student sees their own attempts only, never the rest of the class.
function myQuizzesPanel() {
  return `<article class="card page-card">
    <div class="section-head"><div><h2 style="margin:0 0 5px">Your past quizzes</h2><p class="stat-label">Your own answers and score. Other students' marks are never shown.</p></div><span class="badge ${myQuizzes.length ? "purple" : "gray"}">${myQuizzes.length}</span></div>
    ${myQuizzes.length ? `<div class="class-list">
      ${myQuizzes.map(quiz => `<button class="class-row attendance-day" type="button" data-action="open-my-quiz" data-quiz-id="${escapeHtml(quiz.id)}">
        <div class="time">${escapeHtml(formatQuizDate(quiz.quizDate || quiz.publishedAt) || "—")}<small>${escapeHtml(quiz.courseCode || "")}</small></div>
        <div class="course"><strong>${escapeHtml(quiz.title || "Quiz")}</strong><span>${escapeHtml(quiz.classLabel || quiz.day || "")}</span></div>
        <span class="badge ${quiz.attempted ? "green" : "gray"}">${quiz.attempted ? `${quiz.score}/${quiz.total}` : "Missed"}</span>
        <span class="chevron">${icon("i-arrow")}</span>
      </button>`).join("")}
    </div>` : `<p class="stat-label">You have not taken a quiz yet.</p>`}
  </article>`;
}

function renderMyQuiz() {
  const quiz = myQuizzes.find(item => item.id === myQuizId);
  if (!quiz) return goBack();
  setHeader(quiz.title || "Your quiz", `${quiz.courseCode || ""} · YOUR ANSWERS`, false);
  view.innerHTML = `
    <button class="back-btn" type="button" data-action="go-back">${icon("i-back")} Back</button>
    <article class="card page-card">
      <div class="section-head">
        <div><h2 style="margin:0 0 5px">${escapeHtml(quiz.title || "Quiz")}</h2><p class="stat-label">${[
          formatQuizDate(quiz.quizDate || quiz.publishedAt),
          quiz.classLabel || quiz.day,
          quiz.attempted ? `you scored ${quiz.score} of ${quiz.total}` : "you did not take this quiz"
        ].filter(Boolean).map(escapeHtml).join(" · ")}</p></div>
        <span class="badge ${quiz.attempted ? "green" : "gray"}">${quiz.attempted ? `${quiz.score}/${quiz.total}` : "Missed"}</span>
      </div>
      ${quiz.revealed && quiz.questions.length ? `<div class="quiz-review" style="margin-top:18px">
        ${quiz.questions.map((question, index) => `<div class="question-card">
          <div class="question-top"><span class="q-number">${index + 1}</span><strong>${escapeHtml(question.text || "Image question")}</strong></div>
          ${question.image ? `<img class="question-image-view" src="${escapeHtml(question.image)}" alt="Question ${index + 1} image" />` : ""}
          <div class="options">
            ${(question.options || []).map((option, optionIndex) => {
              const correct = optionIndex === question.answer;
              const chosen = optionIndex === question.yourAnswer;
              return `<div class="option-input review-option ${correct ? "is-correct" : ""} ${chosen && !correct ? "is-wrong" : ""}">
                <span class="review-mark">${correct ? icon("i-check") : chosen ? icon("i-close") : ""}</span>
                <span class="option-text">${escapeHtml(option)}</span>
                ${chosen ? `<span class="option-share">Your answer</span>` : ""}
              </div>`;
            }).join("")}
          </div>
        </div>`).join("")}
      </div>` : `<div class="security-note" style="margin-top:18px"><span class="lock">⌾</span><span>${quiz.attempted
        ? "Answers appear once your professor closes this quiz."
        : "You did not answer this quiz, so there is nothing to review."}</span></div>`}
    </article>`;
}

function renderStudentQuizAccess() {
  const course = selectedCourse();
  setHeader(
    "Course activities",
    course ? `${course.courseCode} · STUDENT ACCESS` : "STUDENT ACCESS",
    false
  );
  const hasAccess = Boolean(course && state.enrolledCourses.includes(course.id));
  const quizMatchesCourse = Boolean(
    course && state.backendQuizCourseId === course.id
  );
  const quizPublished = quizMatchesCourse && state.quizPublished;
  const quizResponded = quizMatchesCourse && state.quizResponded;
  view.innerHTML = hasAccess ? `
    <button class="back-btn" type="button" data-action="go-back">${icon("i-back")} Back</button>
    <div class="page-grid">
      <article class="card page-card">
        <div class="session-title"><div><h2>${escapeHtml(course.name)}</h2><p>${escapeHtml(course.courseCode)}</p></div><span class="badge green">Enrolled</span></div>
        <div class="question-card" style="margin-top:20px"><div class="section-head"><div><h3>${escapeHtml(quizMatchesCourse ? state.backendQuizTitle || "Class quiz" : "No quiz available")}</h3><p class="stat-label" style="margin-top:5px">${quizMatchesCourse ? state.backendQuizQuestions.length : 0} questions${quizMatchesCourse && state.backendQuizClassLabel ? ` · for ${escapeHtml(state.backendQuizClassLabel)}` : ""}</p></div><span class="badge ${quizPublished ? "purple" : "gray"}">${quizResponded ? "Submitted" : quizPublished ? "Available now" : "Not started"}</span></div>
        ${quizPublished && !quizResponded ? `<form id="studentQuizForm" class="quiz-builder" style="margin-top:18px">
          ${state.backendQuizQuestions.map((question, questionIndex) => `<fieldset class="question-card"><legend><strong>${questionIndex + 1}. ${escapeHtml(question.text || question.question || "")}</strong></legend>${question.image ? `<img class="question-image-view" src="${escapeHtml(question.image)}" alt="Question ${questionIndex + 1} image" />` : ""}${question.options.map((option, optionIndex) => `<label class="option-input"><input type="radio" name="student-q-${questionIndex}" value="${optionIndex}" required /><span>${escapeHtml(option)}</span></label>`).join("")}</fieldset>`).join("")}
          <button class="btn btn-primary" type="submit">${icon("i-send")} Submit quiz</button>
        </form>` : `<button class="btn btn-primary" disabled>${icon(quizResponded ? "i-check" : "i-play")} ${quizResponded ? "Response submitted" : "Waiting for quiz"}</button>`}</div>
      </article>
      ${myQuizzesPanel()}
    </div>` : `
    <article class="card empty-state"><div><span class="empty-icon">${icon("i-quiz")}</span><h2>Course access required</h2><p>Join a course before opening its quizzes.</p><button class="btn btn-primary" data-route-link="classes">Join a course</button></div></article>`;
}

// The selected class travels with the quiz so students know which one it is for.
function scheduledClassLabel(item, course) {
  const time = `${item.start || ""}${item.end ? `–${item.end}` : ""}`.trim();
  const code = course.courseCode || "";
  const topic = String(item.topic || "").trim();
  // The topic is often just the course code after a timetable import.
  const extra = topic && topic.toUpperCase() !== code.toUpperCase() ? ` · ${topic}` : "";
  return [item.day, time, code].filter(Boolean).join(" · ") + extra;
}

const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function isoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// The nearest date on the given weekday, so only days the course runs are used.
function nearestDateOnDay(day, from = new Date()) {
  const target = WEEKDAY_NAMES.indexOf(day);
  if (target < 0) return isoDate(from);
  const base = new Date(from);
  base.setHours(12, 0, 0, 0);
  const current = (base.getDay() + 6) % 7;
  const backwards = (current - target + 7) % 7;
  const forwards = (target - current + 7) % 7;
  base.setDate(base.getDate() + (backwards <= forwards ? -backwards : forwards));
  return isoDate(base);
}

function selectedClassDay() {
  const option = document.querySelector("#quizClassSelect")?.selectedOptions?.[0];
  return option?.dataset.day || "";
}

// Keeps the picker on a day the class actually meets.
function snapQuizDateToClassDay({ announce = false } = {}) {
  const input = document.querySelector("#quizDate");
  const day = selectedClassDay();
  if (!input || !day) return;
  const picked = input.value ? new Date(`${input.value}T12:00:00`) : null;
  const pickedDay = picked && !Number.isNaN(picked.getTime())
    ? WEEKDAY_NAMES[(picked.getDay() + 6) % 7]
    : "";
  if (pickedDay === day) return;
  input.value = nearestDateOnDay(day, picked && !Number.isNaN(picked.getTime()) ? picked : new Date());
  if (announce) toast(`This class runs on ${day} — moved to the nearest ${day}`);
}

function formatQuizDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

function quizResultsPicker(selectedId = "") {
  if (!quizHistory.length) {
    return `<label class="results-picker">
      <span>Marks for</span>
      <select class="select" disabled><option>No past quizzes yet</option></select>
    </label>`;
  }
  return `<label class="results-picker">
    <span>Marks for</span>
    <select class="select" id="quizResultsSelect">
      <option value="">Choose a date</option>
      ${quizHistory
        .map(item => {
          const when = formatQuizDate(item.quizDate || item.publishedAt) || "No date";
          const label = `${when}${item.title ? ` · ${item.title}` : ""}${item.classLabel ? ` · ${item.classLabel}` : ""}`;
          return `<option value="${escapeHtml(item.id)}" ${item.id === selectedId ? "selected" : ""}>${escapeHtml(label)}</option>`;
        })
        .join("")}
    </select>
  </label>`;
}

function renderQuizMarks() {
  const course = selectedCourse();
  if (!course) return goBack();
  const roster = courseRosters.get(course.id) || [];
  const quiz = quizResults?.quiz || null;
  const summary = quizResults?.summary || null;
  // With no quiz chosen the panel still lists the class, marks blank.
  const rows = quizResults
    ? quizResults.results
    : roster.map(student => ({
        serial: student.serial,
        rollNumber: student.rollNumber,
        name: student.name,
        attempted: false,
        score: null,
        total: null,
        submittedAt: null,
      }));
  setHeader(
    "Past quiz",
    quiz
      ? `${course.courseCode} · ${formatQuizDate(quiz.quizDate || quiz.publishedAt) || "MARKS"}`
      : `${course.courseCode} · MARKS BY DATE`,
    false
  );
  view.innerHTML = `
    <button class="back-btn" type="button" data-action="go-back">${icon("i-back")} Back</button>
    <article class="card page-card" style="margin-bottom:22px">
      <div class="section-head">
        <div><h2 style="margin:0 0 5px">${quiz ? `${escapeHtml(quiz.title || "Past quiz")} · marks` : "Class marks"}</h2><p class="stat-label">${quiz && summary
          ? [
              formatQuizDate(quiz.quizDate || quiz.publishedAt),
              quiz.classLabel || quiz.day,
              `${summary.attempted} of ${summary.rostered} attempted`,
              `average ${summary.averageScore}/${quiz.total}`
            ].filter(Boolean).map(escapeHtml).join(" · ")
          : `${rows.length} students · choose a quiz to fill in their marks`}</p></div>
        <div class="setup-actions">
          ${quizResultsPicker(quiz?.id || "")}
          ${quiz ? `<button class="btn" type="button" data-action="export-quiz-results">${icon("i-download")} Excel</button>
          <button class="text-btn danger" type="button" data-action="delete-quiz" data-quiz-id="${escapeHtml(quiz.id)}">Delete quiz</button>` : ""}
        </div>
      </div>
      ${rows.length ? `<div class="roster-scroll">
        <table class="roster-table">
          <thead><tr><th>Sl.No.</th><th>Roll No</th><th>Name</th><th>Marks</th><th>Submitted</th></tr></thead>
          <tbody>${rows.map(item => `<tr>
            <td class="roster-serial">${item.serial}</td>
            <td class="roster-roll">${escapeHtml(item.rollNumber)}</td>
            <td>${escapeHtml(item.name)}</td>
            <td>${item.attempted ? `${item.score}/${item.total}` : "—"}</td>
            <td>${item.submittedAt
              ? escapeHtml(new Date(item.submittedAt).toLocaleString([], { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }))
              : quiz ? "Not attempted" : "—"}</td>
          </tr>`).join("")}</tbody>
        </table>
      </div>` : `<p class="stat-label" style="padding:14px 2px">No roll list yet. Upload one from the Students tab.</p>`}
    </article>
    ${quizHistory.length ? `<article class="card page-card" style="margin-bottom:22px">
      <div class="section-head"><div><h2 style="margin:0 0 5px">All past quizzes</h2><p class="stat-label">Every quiz this course has run.</p></div><span class="badge purple">${quizHistory.length}</span></div>
      <div class="roster-scroll">
        <table class="roster-table">
          <thead><tr><th>Date</th><th>Quiz</th><th>Class</th><th>Questions</th><th>Responses</th><th></th></tr></thead>
          <tbody>${quizHistory.map(item => `<tr class="${item.id === quiz?.id ? "is-open-row" : ""}">
            <td>${escapeHtml(formatQuizDate(item.quizDate || item.publishedAt) || "—")}</td>
            <td>${escapeHtml(item.title || "Untitled quiz")}</td>
            <td>${escapeHtml(item.classLabel || item.day || "—")}</td>
            <td>${item.questions}</td>
            <td>${item.responses}</td>
            <td class="roster-actions"><button class="text-btn" type="button" data-action="open-quiz-results" data-quiz-id="${escapeHtml(item.id)}">View marks</button></td>
          </tr>`).join("")}</tbody>
        </table>
      </div>
    </article>` : `<article class="card page-card" style="margin-bottom:22px"><p class="stat-label">No quiz has run yet. Publish one from the Quizzes tab.</p></article>`}
    ${quiz ? `<article class="card page-card">
      <div class="section-head"><div><h2 style="margin:0 0 5px">Questions</h2><p class="stat-label">See what was asked, the correct option, and how the class split.</p></div><button class="btn" type="button" data-action="open-quiz-questions">${icon("i-quiz")} View questions</button></div>
    </article>` : ""}`;
}


function renderQuizQuestions() {
  const course = selectedCourse();
  const quiz = quizResults?.quiz;
  if (!course || !quiz) return goBack();
  const questions = quiz.questions || [];
  setHeader(
    `${quiz.title || "Past quiz"} · questions`,
    `${course.courseCode} · ${formatQuizDate(quiz.quizDate || quiz.publishedAt) || "PAST QUIZ"}`,
    false
  );
  view.innerHTML = `
    <button class="back-btn" type="button" data-action="go-back">${icon("i-back")} Back</button>
    <article class="card page-card">
      <div class="section-head"><div><h2 style="margin:0 0 5px">Questions</h2><p class="stat-label">${[
        quiz.classLabel || quiz.day,
        formatQuizDate(quiz.quizDate || quiz.publishedAt),
        `${questions.length} question${questions.length === 1 ? "" : "s"}`
      ].filter(Boolean).map(escapeHtml).join(" · ")}</p></div><span class="badge green">Answers shown</span></div>
      <div class="quiz-review">
        ${questions.length ? questions.map((question, index) => {
          const answered = Number(question.answered) || 0;
          const correctShare = answered ? Math.round((Number(question.correctCount) || 0) / answered * 100) : 0;
          return `<div class="question-card">
            <div class="question-top"><span class="q-number">${index + 1}</span><strong>${escapeHtml(question.text || "Image question")}</strong></div>
            ${question.image ? `<img class="question-image-view" src="${escapeHtml(question.image)}" alt="Question ${index + 1} image" />` : ""}
            <p class="stat-label">${answered} answered · ${correctShare}% correct</p>
            <div class="options">
              ${(question.options || []).map((option, optionIndex) => {
                const count = Number(question.optionCounts?.[optionIndex]) || 0;
                const share = answered ? Math.round((count / answered) * 100) : 0;
                const correct = optionIndex === question.answer;
                return `<div class="option-input review-option ${correct ? "is-correct" : ""}">
                  <span class="option-bar" style="--share:${share}%"></span>
                  <span class="review-mark">${correct ? icon("i-check") : ""}</span>
                  <span class="option-text">${escapeHtml(option)}</span>
                  <span class="option-share">${share}% · ${count}</span>
                </div>`;
              }).join("")}
            </div>
          </div>`;
        }).join("") : `<p class="stat-label">This quiz has no questions.</p>`}
      </div>
    </article>`;
}

function quizResultsCard() {
  if (!quizResults) return "";
  const { quiz, summary, results } = quizResults;
  return `<article class="card page-card" style="margin-bottom:22px">
    <div class="section-head">
      <div><h2 style="margin:0 0 5px">${escapeHtml(quiz.title || "Past quiz")} · marks</h2><p class="stat-label">${[
        formatQuizDate(quiz.quizDate || quiz.publishedAt),
        quiz.classLabel || quiz.day,
        `${summary.attempted} of ${summary.rostered} attempted`,
        `average ${summary.averageScore}/${quiz.total}`
      ].filter(Boolean).map(escapeHtml).join(" · ")}</p></div>
      <div class="setup-actions">
        ${quizResultsPicker(quiz.id)}
        <button class="btn" type="button" data-action="export-quiz-results">${icon("i-download")} Excel</button>
        <button class="text-btn danger" type="button" data-action="delete-quiz" data-quiz-id="${escapeHtml(quiz.id)}">Delete quiz</button>
      </div>
    </div>
    <div class="roster-scroll">
      <table class="roster-table">
        <thead><tr><th>Sl.No.</th><th>Roll No</th><th>Name</th><th>Marks</th><th>Submitted</th></tr></thead>
        <tbody>${results.map(item => `<tr>
          <td class="roster-serial">${item.serial}</td>
          <td class="roster-roll">${escapeHtml(item.rollNumber)}</td>
          <td>${escapeHtml(item.name)}</td>
          <td>${item.attempted ? `${item.score}/${item.total}` : "—"}</td>
          <td>${item.submittedAt ? escapeHtml(new Date(item.submittedAt).toLocaleString([], { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })) : "Not attempted"}</td>
        </tr>`).join("")}</tbody>
      </table>
    </div>
  </article>`;
}

function readQuizBuilder() {
  return [...document.querySelectorAll("#quizBuilder .question-card")].map(card => {
    const options = [...card.querySelectorAll(".option-input input[type='text']")].map(input => input.value.trim());
    const selected = [...card.querySelectorAll(".option-input input[type='radio']")].findIndex(input => input.checked);
    const image = card.querySelector(".question-image img")?.dataset.image || "";
    return {
      text: card.querySelector(".question-top > input")?.value.trim() || (image ? "" : "Question"),
      options,
      answer: Math.max(0, selected),
      ...(image ? { image } : {})
    };
  });
}

async function refreshNotices(courseId) {
  if (!backendConfigured() || !apiToken || !courseId) {
    courseNotices = [];
    return;
  }
  try {
    const payload = await apiRequest(`/api/courses/${encodeURIComponent(courseId)}/notices`);
    courseNotices = Array.isArray(payload.notices) ? payload.notices : [];
  } catch {
    courseNotices = [];
  }
}

function noticeIcon(kind) {
  return { quiz: "i-quiz", attendance: "i-users", material: "i-download" }[kind] || "i-bell";
}

function noticeAge(value) {
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) return "";
  const minutes = Math.round((Date.now() - when.getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return when.toLocaleDateString([], { day: "numeric", month: "short" });
}

function renderNotices() {
  const course = selectedCourse();
  setHeader("Notices", course ? `${course.courseCode} · COURSE NOTICE BOARD` : "COURSE NOTICE BOARD", false);
  if (!course) {
    view.innerHTML = `<article class="card empty-state"><div><span class="empty-icon">${icon("i-bell")}</span><h2>No notices</h2><p>${state.userRole === "faculty" ? "Create a course to post notices." : state.userRole === "ta" ? "Join the course you assist to post notices." : "Join a course to see its notices."}</p><button class="btn btn-primary" data-route-link="classes">Open courses</button></div></article>`;
    return;
  }
  view.innerHTML = noticeBoard(course);
}

// Shown to students, TAs and professors alike; only the team can post.
function noticeBoard(course) {
  if (!course) return "";
  const canPost = canRunAttendance(course);
  return `<article class="card page-card notice-board">
    <div class="section-head"><div><h2 style="margin:0 0 5px">Notice board</h2><p class="stat-label">${escapeHtml(course.courseCode)} · announcements and course activity</p></div><span class="badge ${courseNotices.length ? "purple" : "gray"}">${courseNotices.length}</span></div>
    ${canPost ? `<form id="noticeForm" class="login-form" style="margin-bottom:16px">
      <label for="noticeTitle">New notice</label>
      <input class="text-input" id="noticeTitle" name="title" placeholder="e.g. Class moved to NR305" maxlength="120" required />
      <label for="noticeBody">Details (optional)</label>
      <textarea class="text-input" id="noticeBody" name="body" rows="2" maxlength="2000" placeholder="Anything students should know"></textarea>
      <button class="btn btn-primary" type="submit">${icon("i-send")} Post notice</button>
    </form>` : ""}
    <div class="notice-list">
      ${courseNotices.length ? courseNotices.map(notice => `<div class="notice">
        <span class="activity-icon">${icon(noticeIcon(notice.kind))}</span>
        <div>
          <strong>${escapeHtml(notice.title)}</strong>
          ${notice.body ? `<p>${escapeHtml(notice.body)}</p>` : ""}
          <span class="notice-meta">${escapeHtml(notice.authorName || "Course team")} · ${escapeHtml(noticeAge(notice.createdAt))}</span>
        </div>
        ${canPost ? `<button class="text-btn danger" type="button" data-action="delete-notice" data-notice-id="${escapeHtml(notice.id)}">Remove</button>` : ""}
      </div>`).join("") : `<p class="stat-label">Nothing posted yet.${canPost ? " Post a notice, or one appears automatically when you open attendance, publish a quiz, or share material." : ""}</p>`}
    </div>
  </article>`;
}

async function refreshQuizHistory(courseId) {
  if (!backendConfigured() || !apiToken || !courseId) {
    quizHistory = [];
    return;
  }
  try {
    const payload = await apiRequest(`/api/quizzes/history?courseId=${encodeURIComponent(courseId)}`);
    quizHistory = Array.isArray(payload.quizzes) ? payload.quizzes : [];
  } catch {
    quizHistory = [];
  }
}

async function refreshQuizDrafts(courseId) {
  if (!backendConfigured() || !apiToken || !courseId) {
    quizDrafts = [];
    return;
  }
  try {
    const payload = await apiRequest(`/api/quizzes/drafts?courseId=${encodeURIComponent(courseId)}`);
    quizDrafts = Array.isArray(payload.drafts) ? payload.drafts : [];
  } catch {
    quizDrafts = [];
  }
}

function quizSettingsPayload() {
  const title = document.querySelector("#quizTitle")?.value.trim() || "";
  const select = document.querySelector("#quizClassSelect");
  const option = select?.selectedOptions?.[0];
  const quizDate = document.querySelector("#quizDate")?.value || "";
  const timeLimit = document.querySelector("#duration")?.value ?? "";
  const reveal = document.querySelector("#reveal")?.value || "";
  if (title.length < 2) {
    toast("Give the quiz a title", "error");
    return null;
  }
  if (!select || !select.value || !option) {
    toast(
      select ? "Choose which class this quiz is for" : "Add a class to the timetable first",
      "error"
    );
    return null;
  }
  if (!quizDate) {
    toast("Pick the date this quiz is for", "error");
    return null;
  }
  const classDay = option.dataset.day || "";
  const pickedDay = WEEKDAY_NAMES[(new Date(`${quizDate}T12:00:00`).getDay() + 6) % 7];
  if (classDay && pickedDay !== classDay) {
    toast(`This class runs on ${classDay} — pick a ${classDay}`, "error");
    return null;
  }
  if (timeLimit === "" || !reveal) {
    toast("Choose a time limit and when results are revealed", "error");
    return null;
  }
  return {
    title,
    scheduleId: select.value,
    day: option.dataset.day || "",
    classLabel: option.dataset.label || "",
    quizDate,
    timeLimitMinutes: Number(timeLimit),
    reveal
  };
}

function questionBlock(number, question = "", options = ["", "", "", ""], answer = 0, image = "") {
  return `<div class="question-card">
    <div class="question-top"><span class="q-number">${number}</span><input value="${escapeHtml(question)}" placeholder="Type question ${number}" aria-label="Question ${number}" /><button class="icon-btn" type="button" data-action="attach-question-image" aria-label="Attach an image to question ${number}">${icon("i-upload")}</button><button class="icon-btn danger" type="button" data-action="remove-question" aria-label="Delete question ${number}">${icon("i-close")}</button></div>
    <div class="question-image" ${image ? "" : "hidden"}><img alt="Question ${number} image" ${image ? `src="${escapeHtml(image)}" data-image="${escapeHtml(image)}"` : ""} /><button class="text-btn danger" type="button" data-action="remove-question-image">Remove image</button></div>
    <input class="question-image-file" type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden />
    <p class="answer-hint">${icon("i-check")} Tick the circle beside the correct answer</p>
    <div class="options">${options.map((opt, i) => `<div class="option-input"><input type="radio" name="q${number}" title="Mark this option correct" aria-label="Mark option ${i + 1} correct" ${i === answer ? "checked" : ""}/><input type="text" value="${escapeHtml(opt)}" placeholder="Option ${i + 1}" aria-label="Option ${i + 1} text" /><span class="option-flag">Correct</span></div>`).join("")}</div>
  </div>`;
}

function renderLiveQuiz() {
  clearTimeout(quizTimer);
  if (state.route !== "quizzes" || state.userRole === "student" || !state.authenticated) return;
  const course = selectedCourse();
  if (!course || !canPublishQuiz(course) || state.backendQuizCourseId !== course.id) return renderQuiz();
  const liveCourseId = course.id;
  const liveQuizId = state.backendQuizId;
  const responses = state.quizResponses;
  const totalStudents = course.students;
  const percentage = totalStudents ? Math.round((responses / totalStudents) * 100) : 0;
  const questionCount = state.backendQuizQuestions.length;
  view.innerHTML = `
    <button class="back-btn" type="button" data-action="go-back">${icon("i-back")} Back</button>
    <div class="page-grid">
      <article class="card page-card">
        <div class="session-title"><div><h2>${escapeHtml(state.backendQuizTitle || "Class quiz")}</h2><p>${questionCount} ${questionCount === 1 ? "question" : "questions"}${state.backendQuizClassLabel ? ` · for ${escapeHtml(state.backendQuizClassLabel)}` : ""}</p></div><span class="badge green">Live now</span></div>
        <div class="quiz-live">
          <div class="response-count">${responses}</div><p class="stat-label">of ${totalStudents} students responded</p>
          <div class="response-track"><span style="width:${percentage}%"></span></div>
          <p class="stat-label">${percentage}% response rate</p>
        </div>
        <div class="setup-actions"><button class="btn btn-danger" data-action="end-quiz">End quiz</button></div>
      </article>
      <aside class="card page-card">
        <div class="section-head"><h3>Live summary</h3></div>
        <div class="summary-ring" style="--progress:${percentage}%"><div><strong>${percentage}%</strong><span>responded</span></div></div>
        <div class="summary-list"><div class="summary-item"><span>Questions</span><strong>${questionCount}</strong></div><div class="summary-item"><span>Responses</span><strong>${responses}</strong></div><div class="summary-item"><span>Status</span><strong>Open</strong></div></div>
      </aside>
    </div>`;
  if (backendConfigured() && state.backendQuizId) {
    quizTimer = setTimeout(async () => {
      if (
        state.route !== "quizzes" ||
        state.userRole === "student" ||
        !state.authenticated ||
        selectedCourse()?.id !== liveCourseId ||
        state.backendQuizCourseId !== liveCourseId ||
        state.backendQuizId !== liveQuizId
      ) return;
      try {
        const result = await apiRequest(`/api/quizzes/current?courseId=${encodeURIComponent(course.id)}`);
        if (
          selectedCourse()?.id !== liveCourseId ||
          state.backendQuizCourseId !== liveCourseId ||
          state.backendQuizId !== liveQuizId
        ) return;
        const responseCount = result.quiz?.responses?.length || 0;
        if (responseCount !== state.quizResponses) {
          state.quizResponses = responseCount;
          persist();
          renderLiveQuiz();
        }
      } catch {}
    }, 3000);
  }
}

function renderClasses() {
  if (state.userRole === "student") return renderStudentClasses();
  if (state.userRole === "ta") return renderTAClasses();
  setHeader("My courses", "PROFESSOR WORKSPACE", false);
  const openCourse = selectedCourse();
  view.innerHTML = `
    <article class="card page-card">
      <div class="section-head"><div><h2 style="margin:0 0 5px">Courses you own</h2><p class="stat-label">Every course you own. Select one to point the rest of the workspace at it.</p></div><div class="setup-actions"><span class="badge purple">${state.courses.length} ${state.courses.length === 1 ? "course" : "courses"}</span><button class="btn btn-primary" data-action="open-course-modal">${icon("i-plus")} Create course</button></div></div>
      <div class="course-grid">${state.courses.length
        ? state.courses.map(item => facultyCourseCard(item, item.id === openCourse?.id)).join("")
        : `<div class="empty-state"><div><p>No course created yet.</p></div></div>`}</div>
    </article>
    ${renderTeachingAssistantsSection()}`;
}

function renderTeachingAssistantsSection() {
  const course = selectedCourse();
  const assistants = (state.teachingAssistants || []).filter(
    assistant => !course || assistant.courseId === course.id
  );
  if (!assistants.length) return "";
  return `<article class="card page-card">
    <div class="section-head"><div><h2 style="margin:0 0 5px">Teaching assistants</h2><p class="stat-label">TAs who have joined your accessible courses</p></div><span class="badge purple">${assistants.length} enrolled</span></div>
    <div class="roster-scroll"><table class="roster-table">
      <thead><tr><th>Course</th><th>Name</th><th>Email</th><th>Department</th></tr></thead>
      <tbody>${assistants.map(assistant => `<tr>
        <td class="roster-roll">${escapeHtml(assistant.courseCode)}</td>
        <td>${escapeHtml(assistant.name)}</td>
        <td><a href="mailto:${escapeHtml(assistant.email)}">${escapeHtml(assistant.email)}</a></td>
        <td>${escapeHtml(assistant.department || "—")}</td>
      </tr>`).join("")}</tbody>
    </table></div>
  </article>`;
}

function facultyCourseCard(course, isOpen = false) {
  const studentCode = course.studentCode || course.code || "";
  const taCode = course.taCode || "";
  return `<article class="course-card ${isOpen ? "is-open-course" : ""}">
    <div class="course-accent"></div>
    <div class="course-card-head"><h3>${escapeHtml(course.name)}</h3>${isOpen
      ? `<span class="badge green">Open</span>`
      : `<button class="text-btn" type="button" data-action="select-course" data-course-id="${escapeHtml(course.id)}">Open</button>`}</div>
    <p>${escapeHtml(course.courseCode)} · ${escapeHtml(course.room)}</p>
    <div class="course-join-codes">
      <div class="course-code"><span>Student join code</span><strong>${escapeHtml(studentCode || "Unavailable")}</strong><button class="icon-btn" data-copy="${escapeHtml(studentCode)}" data-copy-label="Student join code" aria-label="Copy student join code" ${studentCode ? "" : "disabled"}>${icon("i-quiz")}</button></div>
      <div class="course-code"><span>TA join code</span><strong>${escapeHtml(taCode || "Unavailable")}</strong><button class="icon-btn" data-copy="${escapeHtml(taCode)}" data-copy-label="TA join code" aria-label="Copy TA join code" ${taCode ? "" : "disabled"}>${icon("i-quiz")}</button></div>
    </div>
    <div class="course-footer"><span>${course.rosterReady === false ? `${icon("i-users")} No official roster yet` : `${icon("i-users")} ${Number(course.students) || 0} rostered students`}</span><span>${Number(course.materialCount) || 0} shared files</span></div>
    <div class="course-manage">
      <button class="text-btn" type="button" data-action="edit-course" data-course-id="${escapeHtml(course.id)}">Edit details</button>
      <button class="text-btn danger" type="button" data-action="delete-course" data-course-id="${escapeHtml(course.id)}">Delete course</button>
    </div>
  </article>`;
}

const NO_VALUE = '<span class="roster-mark-empty">—</span>';

// Columns the roll list brought that the app has no column of its own for.
// Shown under the name so a sheet with eight headings does not push the table
// sideways off a phone.
function rosterExtraLine(student) {
  const entries = Object.entries(student.extra || {});
  if (!entries.length) return "";
  return `<div class="roster-extra">${entries
    .map(([label, value]) =>
      `<span><b>${escapeHtml(label)}:</b> ${escapeHtml(String(value))}</span>`
    )
    .join("")}</div>`;
}

function rosterTableRow(student, index, editable = false, exams = [], columns = {}) {
  const roll = String(student.rollNumber || "");
  const serial = student.serial || index + 1;
  // Roll number addresses an entry when it has one; a name-only entry is
  // addressed by the serial printed beside it.
  const target = roll
    ? `data-roll-number="${escapeHtml(roll)}"`
    : `data-roster-serial="${escapeHtml(String(serial))}"`;
  return `<tr>
    <td class="roster-serial">${serial}</td>
    <td class="roster-roll">${roll ? escapeHtml(roll) : NO_VALUE}</td>
    <td>${escapeHtml(student.name)}${rosterExtraLine(student)}</td>
    ${columns.email ? `<td class="roster-contact">${student.email ? escapeHtml(student.email) : NO_VALUE}</td>` : ""}
    ${columns.phone ? `<td class="roster-contact">${student.phone ? escapeHtml(student.phone) : NO_VALUE}</td>` : ""}
    ${exams.map(exam => {
      const score = student.marks?.[exam.id];
      const recorded = score !== null && score !== undefined;
      return `<td class="roster-mark">${recorded
        ? `<strong>${escapeHtml(String(score))}</strong>${exam.maxMarks ? `<span> / ${escapeHtml(String(exam.maxMarks))}</span>` : ""}`
        : '<span class="roster-mark-empty">—</span>'}</td>`;
    }).join("")}
    <td class="roster-actions">${editable ? `<button class="text-btn danger" type="button" data-action="remove-roster-student" data-roll-number="${escapeHtml(student.rollNumber)}">Remove</button>` : ""}</td>
  </tr>`;
}

function renderCourseRoster(courseId) {
  const course = state.courses.find(item => item.id === courseId);
  const roster = courseRosters.get(courseId) || [];
  if (!course) {
    managedCourseId = "";
    return renderStudents();
  }
  const editable = canManageRoster(course);
  // Contact columns appear only when the uploaded list actually carried them,
  // so a bare name-and-roll sheet still reads as a bare name-and-roll table.
  const columns = {
    email: roster.some(student => student.email),
    phone: roster.some(student => student.phone),
  };
  const markStudents = courseMarks?.students || [];
  const marksByRoll = new Map(
    markStudents.map(student => [String(student.rollNumber || "").toUpperCase(), student.marks || {}])
  );
  // Empty future exams stay out of the roster. As soon as a total or a score
  // exists, the exam becomes a real mark-book column beside every student.
  const markedExams = (courseMarks?.exams || []).filter(exam =>
    exam.maxMarks || markStudents.some(student => student.marks?.[exam.id] !== null && student.marks?.[exam.id] !== undefined)
  );
  const rosterWithMarks = roster.map(student => ({
    ...student,
    marks: marksByRoll.get(String(student.rollNumber || "").toUpperCase()) || {},
  }));
  const studentsWithMarks = rosterWithMarks.filter(student =>
    markedExams.some(exam => student.marks?.[exam.id] !== null && student.marks?.[exam.id] !== undefined)
  ).length;
  setHeader(
    `${course.name} roster`,
    state.userRole === "faculty" ? "PROFESSOR WORKSPACE" : "TEACHING ASSISTANT WORKSPACE",
    false
  );
  view.innerHTML = `
    <button class="back-btn" type="button" data-action="go-back">${icon("i-back")} Back</button>
    <div class="page-grid roster-grid">
      <article class="card page-card">
        <div class="section-head"><div><h2 style="margin:0 0 5px">Official student list</h2><p class="stat-label">${escapeHtml(course.courseCode)}${courseMarks?.scoresHidden ? " · marks visible to the professor only" : markedExams.length ? ` · ${studentsWithMarks} with recorded marks` : ""}</p></div><span class="badge ${roster.length ? "green" : "amber"}">${roster.length} students</span></div>
        <label class="roster-search">${icon("i-users")}<input id="rosterSearch" type="search" placeholder="Search name or roll number" autocomplete="off" /></label>
        <div class="roster-scroll" id="professorRoster">
          ${roster.length ? `<table class="roster-table">
            <thead><tr><th>Sl.No.</th><th>Roll No</th><th>Name</th>${columns.email ? "<th>Email</th>" : ""}${columns.phone ? "<th>Phone</th>" : ""}${markedExams.map(exam => `<th class="roster-mark-header">${escapeHtml(exam.label)}${exam.maxMarks ? `<span> / ${escapeHtml(String(exam.maxMarks))}</span>` : ""}</th>`).join("")}<th></th></tr></thead>
            <tbody>${rosterWithMarks.map((student, index) => rosterTableRow(student, index, editable, markedExams, columns)).join("")}</tbody>
          </table>` : `<p class="stat-label" style="padding:14px 2px">No students yet. Upload the roll list, or add them one at a time.</p>`}
        </div>
      </article>

      ${editable ? `<aside class="card page-card">
        <div class="section-head"><h3>Manage roll list</h3></div>
        <form id="addStudentForm" class="login-form">
          <label for="addStudentName">Full name</label>
          <input id="addStudentName" name="name" type="text" placeholder="Student name" autocomplete="off" maxlength="120" required />
          <label for="addRollNumber">Roll number <span class="field-optional">(optional)</span></label>
          <input id="addRollNumber" name="rollNumber" type="text" placeholder="e.g. 23ME10001" autocomplete="off" maxlength="40" aria-describedby="addRollHelp" />
          <p class="auth-field-help" id="addRollHelp">Attendance and marks are matched on the roll number. Without one the student stays on the list but cannot be marked.</p>
          <label for="addStudentEmail">Email <span class="field-optional">(optional)</span></label>
          <input id="addStudentEmail" name="email" type="email" placeholder="Student email" autocomplete="off" maxlength="160" />
          <label for="addStudentPhone">Contact number <span class="field-optional">(optional)</span></label>
          <input id="addStudentPhone" name="phone" type="tel" placeholder="Mobile number" autocomplete="off" maxlength="32" />
          <button class="btn btn-primary" type="submit">${icon("i-plus")} Add student</button>
        </form>
        <div class="setup-actions" style="margin-top:16px">
          <!-- A label opens the picker natively. A scripted .click() on a
               hidden input is the thing Android's WebView declines to act on,
               and it fails silently when it does. -->
          <label class="btn" for="rosterUploadFile">${icon("i-upload")} Upload roll list</label>
          <input id="rosterUploadFile" class="visually-hidden" type="file" />
        </div>
        <div class="security-note" style="margin-top:16px"><span class="lock">⌾</span><span>Uploading a file replaces the whole list. Removing a student also withdraws their enrolment from this course. Students never receive this list.</span></div>
      </aside>` : `<aside class="card page-card"><div class="section-head"><h3>Official roll list</h3></div><div class="security-note"><span class="lock">⌾</span><span>This roster is read-only for your account.</span></div></aside>`}
    </div>`;
}

function materialSize(size) {
  const bytes = Number(size) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function materialDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function materialCanOpen(material) {
  return /^(application\/pdf|image\/|text\/)/i.test(material.contentType || "");
}

function materialTableRow(material, owner) {
  return `<tr>
    <td><strong>${escapeHtml(material.fileName)}</strong><br><span class="stat-label">${escapeHtml(material.uploadedByName || "Professor")}</span></td>
    <td>${escapeHtml(materialSize(material.size))}</td>
    <td>${escapeHtml(materialDate(material.uploadedAt))}</td>
    <td class="roster-actions"><div class="setup-actions">
      ${materialCanOpen(material) ? `<button class="text-btn" type="button" data-action="view-material" data-material-id="${escapeHtml(material.id)}">View</button>` : ""}
      <button class="text-btn" type="button" data-action="download-material" data-material-id="${escapeHtml(material.id)}" data-file-name="${escapeHtml(material.fileName)}">Download</button>
      ${owner ? `<button class="text-btn danger" type="button" data-action="delete-material" data-material-id="${escapeHtml(material.id)}">Remove</button>` : ""}
    </div></td>
  </tr>`;
}

function materialCourseCard(course) {
  const upload = canUploadMaterials(course);
  const owner = canManageCourse(course);
  return `<article class="course-card">
    <div class="course-accent"></div><span class="badge ${upload ? "purple" : "green"}">${upload ? "Course team" : "Enrolled"}</span>
    <h3 style="margin-top:12px">${escapeHtml(course.name)}</h3>
    <p>${escapeHtml(course.courseCode)} · ${escapeHtml(course.room)}</p>
    <div class="course-footer"><span>${Number(course.materialCount) || 0} shared files</span><button class="text-btn" data-action="open-course-materials" data-course-id="${escapeHtml(course.id)}">${owner ? "Upload & manage" : upload ? "Upload & view" : "View materials"}</button></div>
  </article>`;
}

function renderMaterials() {
  const course = selectedCourse();
  const roleLabel = state.userRole === "faculty"
    ? "PROFESSOR WORKSPACE"
    : state.userRole === "ta"
      ? "TEACHING ASSISTANT WORKSPACE"
      : "STUDENT WORKSPACE";
  if (!course) {
    setHeader("Materials", roleLabel, false);
    view.innerHTML = `<article class="card empty-state"><div><span class="empty-icon">${icon("i-cloud")}</span><h3>No course selected</h3><p>Create or join a course before using materials.</p><button class="btn btn-primary" data-route-link="classes">Open Courses</button></div></article>`;
    return;
  }
  materialsCourseId = course.id;
  if (!courseMaterials.has(course.id)) {
    setHeader(`${course.name} materials`, `${course.courseCode} · COURSE FILES`, false);
    view.innerHTML = `<article class="card empty-state"><div><span class="empty-icon">${icon("i-cloud")}</span><h3>Loading course materials</h3><p>Checking files shared with ${escapeHtml(course.courseCode)}.</p></div></article>`;
    loadCourseMaterials(course.id)
      .then(() => {
        if (state.route === "materials" && selectedCourse()?.id === course.id) {
          renderCourseMaterials(course.id);
        }
      })
      .catch(error => {
        if (state.route === "materials") {
          view.innerHTML = `<article class="card empty-state"><div><span class="empty-icon">${icon("i-cloud")}</span><h3>Materials unavailable</h3><p>${escapeHtml(error.message || "Could not load course materials")}</p></div></article>`;
        }
      });
    return;
  }
  return renderCourseMaterials(course.id);
}

function renderCourseMaterials(courseId) {
  const course = state.courses.find(item => item.id === courseId);
  if (!course) {
    materialsCourseId = "";
    return renderMaterials();
  }
  const materials = courseMaterials.get(courseId) || [];
  const owner = canManageCourse(course);
  const uploader = canUploadMaterials(course);
  setHeader(`${course.name} materials`, `${course.courseCode} · COURSE FILES`, false);
  view.innerHTML = `
    <article class="card page-card">
      <div class="section-head">
        <div><h2 style="margin:0 0 5px">Course materials</h2><p class="stat-label">Files here are private to this course's professor, teaching assistants, and enrolled students.</p></div>
        <div class="setup-actions"><span class="badge ${materials.length ? "green" : "gray"}">${materials.length} files</span>${uploader ? `<label class="btn btn-primary" for="materialUploadFile">${icon("i-upload")} Upload material</label><input id="materialUploadFile" class="visually-hidden" type="file" />` : ""}</div>
      </div>
      ${materials.length ? `<div class="roster-scroll"><table class="roster-table">
        <thead><tr><th>File</th><th>Size</th><th>Uploaded</th><th></th></tr></thead>
        <tbody>${materials.map(material => materialTableRow(material, owner)).join("")}</tbody>
      </table></div>` : `<div class="empty-state"><div><span class="empty-icon">${icon("i-quiz")}</span><h3>No materials uploaded yet</h3><p>${uploader ? "Upload notes, slides, PDFs, assignments, or other course files." : "Your course team has not shared any course files yet."}</p></div></div>`}
    </article>`;
}

function renderTAClasses() {
  setHeader("Courses you assist", "TEACHING ASSISTANT WORKSPACE", false);
  const course = selectedCourse();
  view.innerHTML = `
    <div class="left-stack">
      <article class="card join-panel">
        <span class="empty-icon">${icon("i-plus")}</span><h2>Join an assigned course</h2>
        <p class="stat-label">Enter the TA join code shared by the course professor. Student join codes cannot grant teaching-team access.</p>
        <form class="join-code" id="joinForm"><div class="join-code-field"><label for="taJoinCode">TA join code</label><input id="taJoinCode" name="joinCode" maxlength="32" placeholder="Enter TA join code" autocomplete="off" required/></div><button class="btn btn-primary">Join course</button></form>
      </article>
      <article class="card page-card">
        <div class="section-head"><div><h2 style="margin:0 0 5px">Courses you assist</h2><p class="stat-label">Select a course to point rosters, materials, attendance, quizzes, and schedule at it.</p></div><span class="badge purple">${state.courses.length} assigned</span></div>
        <div class="course-grid">${state.courses.length
          ? state.courses.map(item => taCourseCard(item, item.id === course?.id)).join("")
          : `<div class="empty-state"><div><p>No course joined yet.</p></div></div>`}</div>
      </article>
      ${renderTeachingAssistantsSection()}
    </div>`;
}

function taCourseCard(course, isOpen = false) {
  return `<article class="course-card ${isOpen ? "is-open-course" : ""}">
    <div class="course-accent"></div>
    <div class="course-card-head"><span class="badge purple">Teaching assistant</span>${isOpen
      ? `<span class="badge green">Open</span>`
      : `<button class="text-btn" type="button" data-action="select-course" data-course-id="${escapeHtml(course.id)}">Open</button>`}</div>
    <h3 style="margin-top:12px">${escapeHtml(course.name)}</h3><p>${escapeHtml(course.courseCode)} · ${escapeHtml(course.room)}</p>
    <div class="course-footer"><button class="text-btn" data-action="start-course-attendance" data-course-id="${escapeHtml(course.id)}">Take attendance</button><button class="text-btn" data-action="open-course-quiz" data-course-id="${escapeHtml(course.id)}">Create quiz</button></div>
  </article>`;
}

function renderStudentClasses() {
  setHeader("Join a course", "STUDENT WORKSPACE", false);
  const course = selectedCourse();
  const enrolled = course && state.enrolledCourses.includes(course.id) ? [course] : [];
  view.innerHTML = `
    <div class="left-stack">
    <article class="card join-panel">
      <span class="empty-icon">${icon("i-plus")}</span><h2>Enter your course code</h2>
      <p class="stat-label">Your faculty will share the student join code. The roll number from your account is used, so you only need to join once.</p>
      <form class="join-code" id="joinForm">
        <div class="join-code-field"><label for="studentJoinCode">Student join code</label><input id="studentJoinCode" name="joinCode" maxlength="32" placeholder="Enter student join code" autocomplete="off" required/></div>
        <button class="btn btn-primary">Join course</button>
      </form>
      ${enrolled.length ? `<div class="student-course-list"><div class="section-head"><h3>Courses joined</h3><span class="badge green">${enrolled.length} active</span></div>${enrolled.map(course => studentCourseCard(course)).join("")}</div>` : ""}
    </article>
    ${renderTeachingAssistantsSection()}
    </div>`;
}

function openCourseModal(course = null) {
  modalReturnFocus = document.activeElement;
  const editing = Boolean(course);
  const studentCode = course?.studentCode || course?.code || "";
  const taCode = course?.taCode || "";
  document.querySelector("#modalRoot").innerHTML = `
    <div class="modal-backdrop" data-action="close-modal">
      <form class="modal" id="courseForm" role="dialog" aria-modal="true" aria-labelledby="courseModalTitle" aria-describedby="courseModalDescription" ${editing ? `data-course-id="${escapeHtml(course.id)}"` : ""}>
        <div class="modal-head"><div><h2 id="courseModalTitle">${editing ? "Edit course details" : "Add a new course"}</h2><p id="courseModalDescription">${editing ? "The student and TA join codes stay the same, so nobody has to rejoin." : "Separate student and TA join codes will be generated."}</p></div><button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">${icon("i-close")}</button></div>
        <div class="field-grid">
          <div class="field full"><label for="courseName">Course name</label><input id="courseName" name="name" placeholder="e.g. Computer Networks" value="${editing ? escapeHtml(course.name) : ""}" required /></div>
          <div class="field"><label for="courseCode">Course code</label><input id="courseCode" name="courseCode" placeholder="CSE 308" value="${editing ? escapeHtml(course.courseCode) : ""}" required /></div>
          <div class="field"><label for="room">Classroom</label><input id="room" name="room" placeholder="Room 205" value="${editing ? escapeHtml(course.room) : ""}" required /></div>
          <div class="field full"><p class="stat-label">${editing ? `Student code <strong>${escapeHtml(studentCode || "Unavailable")}</strong> and TA code <strong>${escapeHtml(taCode || "Unavailable")}</strong> are unchanged by this edit. Rosters, files, attendance and quizzes all stay attached.` : "After creation, give each code only to its intended group. Use the Students tab to upload the official roster and Materials for course files."}</p></div>
        </div>
        <div class="setup-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn btn-primary">${icon(editing ? "i-check" : "i-plus")} ${editing ? "Save changes" : "Create course"}</button></div>
      </form>
    </div>`;
  setTimeout(() => document.querySelector("#courseName")?.focus(), 0);
}

function openScheduleTopicsModal(index) {
  const course = selectedCourse();
  const entries = state.backendSchedule.filter(item => item.courseId === course?.id);
  const scheduleClass = entries[index];
  if (!course || !canManageSchedule(course) || !scheduleClass) {
    return toast("That class could not be opened", "error");
  }
  editingScheduleIndex = index;
  modalReturnFocus = document.activeElement;
  document.querySelector("#modalRoot").innerHTML = `
    <div class="modal-backdrop" data-action="close-modal">
      <form class="modal" id="editClassTopicsForm" role="dialog" aria-modal="true" aria-labelledby="scheduleTopicsTitle">
        <div class="modal-head"><div><h2 id="scheduleTopicsTitle">Class topics</h2><p>${escapeHtml(scheduleClass.day)} · ${escapeHtml(scheduleClass.start)} · ${escapeHtml(course.courseCode)}</p></div><button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">${icon("i-close")}</button></div>
        <div class="field-grid">
          <div class="field full"><label for="editClassTopic">Main class topic</label><input class="text-input" id="editClassTopic" name="topic" maxlength="120" value="${escapeHtml(scheduleClass.topic || course.name)}" required /></div>
          <div class="field full"><label for="editClassSubtopics">Break into sub-classes / topic items</label><textarea class="text-input" id="editClassSubtopics" name="subtopics" rows="7" placeholder="One item per line">${escapeHtml((scheduleClass.subtopics || []).join("\n"))}</textarea><span class="stat-label">Add up to 20 items, one per line. They appear in Today's classes and the full week.</span></div>
        </div>
        <div class="setup-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn btn-primary" type="submit">${icon("i-check")} Save topics</button></div>
      </form>
    </div>`;
  setTimeout(() => document.querySelector("#editClassTopic")?.focus(), 0);
}

function reminderScheduleEntries() {
  const accessibleCourseIds = new Set(state.courses.map(course => course.id));
  const scopedImported = state.importedSchedule.filter(
    event => event.courseId && accessibleCourseIds.has(event.courseId)
  );
  const useImported = state.userRole === "student" && scopedImported.length > 0;
  const importedCourseIds = new Set(
    scopedImported.map(event => event.courseId)
  );
  const source = useImported
    ? [
        ...state.backendSchedule.filter(event => !importedCourseIds.has(event.courseId)),
        ...scopedImported,
      ]
    : state.backendSchedule;
  const courses = new Map(state.courses.map(course => [course.id, course]));
  return source.map((event, index) => {
    const course = courses.get(event.courseId) || null;
    return {
      ...event,
      id: event.id || `${useImported ? "imported" : "schedule"}-${index + 1}`,
      courseCode: course?.courseCode || event.courseCode || event.topic || "Class",
      courseName: course?.name || event.courseName || event.topic || "Scheduled class",
      room: event.room || course?.room || "Room TBA",
    };
  });
}

async function syncClassReminders() {
  if (!state.authenticated || !state.authEmail || !reminderManager) return null;
  return reminderManager.reconcile({
    accountEmail: state.authEmail,
    events: reminderScheduleEntries(),
  });
}

function currentNotificationState() {
  return pushManager?.getState?.() || {
    notifications: [],
    unreadCount: 0,
    status: { supported: false, permission: "unsupported", registered: false, polling: false },
  };
}

function syncNotificationUi(snapshot = currentNotificationState()) {
  if (!notificationButton || !notificationBadge) return;
  const unread = Math.max(0, Number(snapshot.unreadCount) || 0);
  notificationButton.classList.toggle("has-unread", unread > 0);
  notificationButton.setAttribute(
    "aria-label",
    unread ? `Notifications, ${unread} unread` : "Notifications",
  );
  notificationBadge.hidden = unread === 0;
  notificationBadge.textContent = unread > 99 ? "99+" : String(unread);
  notificationBadge.setAttribute(
    "aria-label",
    `${unread} unread notification${unread === 1 ? "" : "s"}`,
  );
}

function notificationPresentation(item) {
  const type = String(item?.type || "").toLowerCase();
  if (type.includes("attendance")) {
    return { iconName: "i-users", className: "is-attendance", label: "Attendance" };
  }
  if (type.includes("quiz")) {
    return { iconName: "i-quiz", className: "is-quiz", label: "Quiz" };
  }
  if (type.includes("material")) {
    return { iconName: "i-cloud", className: "is-material", label: "Material" };
  }
  return { iconName: "i-bell", className: "is-update", label: "Course update" };
}

function notificationTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently";
  const today = new Date();
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate();
  return new Intl.DateTimeFormat(undefined, sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }
  ).format(date);
}

function notificationStatusMarkup(status = {}) {
  if (status.permission === "denied") {
    return {
      message: "Phone alerts are off in Android settings. Updates will still be saved in this inbox.",
      action: `<button class="text-btn" type="button" data-action="enable-push-notifications">Try again</button>`,
    };
  }
  if (!status.supported) {
    return {
      message: "This inbox stays synced here. Install the app to receive alerts while CampusPulse is closed.",
      action: "",
    };
  }
  if (status.registered) {
    return {
      message: "Phone alerts are on. Attendance, quiz, and material updates are also saved here.",
      action: "",
    };
  }
  if (status.error) {
    return {
      message: `${escapeHtml(status.error)}. CampusPulse will retry when the app is active.`,
      action: "",
    };
  }
  return {
    message: "Connecting phone alerts. Updates are already being saved in this inbox.",
    action: "",
  };
}

function renderNotificationInbox({ focus = false, restoreFocus = false } = {}) {
  const root = document.querySelector("#modalRoot");
  if (!root) return;
  const previous = restoreFocus ? document.activeElement : null;
  const previousNotificationId = previous?.dataset?.notificationId || "";
  const previousAction = previous?.dataset?.action || "";
  const snapshot = currentNotificationState();
  const items = snapshot.notifications || [];
  const unread = Math.max(0, Number(snapshot.unreadCount) || 0);
  const statusView = notificationStatusMarkup(snapshot.status);
  root.innerHTML = `
    <div class="modal-backdrop" data-action="close-modal">
      <section class="modal notification-modal" id="notificationInboxModal" role="dialog" aria-modal="true" aria-labelledby="notificationInboxTitle" aria-describedby="notificationInboxDescription">
        <div class="modal-head">
          <div class="notification-modal-title">
            <span>${icon("i-bell")}</span>
            <div><h2 id="notificationInboxTitle">Notifications</h2><p id="notificationInboxDescription">Course activity from all your joined classes</p></div>
          </div>
          <button type="button" class="icon-btn" data-action="close-modal" aria-label="Close notifications">${icon("i-close")}</button>
        </div>
        <div class="notification-toolbar">
          <span>${unread ? `${unread} unread` : "You are all caught up"}</span>
          <button class="text-btn" type="button" data-action="mark-all-notifications-read" ${unread ? "" : "disabled"}>Mark all as read</button>
        </div>
        <div class="notification-list">
          ${items.length ? items.map(item => {
            const presentation = notificationPresentation(item);
            const course = state.courses.find(candidate => candidate.id === item.courseId);
            const courseLabel = course?.courseCode || item.data?.courseCode || presentation.label;
            return `<button class="notification-item ${item.readAt ? "" : "is-unread"}" type="button" data-action="open-notification" data-notification-id="${escapeHtml(item.id)}">
              <span class="notification-kind ${presentation.className}">${icon(presentation.iconName)}</span>
              <span class="notification-copy">
                <strong>${escapeHtml(item.title || "CampusPulse update")}</strong>
                <span>${escapeHtml(item.body || "Open to view this course update.")}</span>
                <small>${escapeHtml(courseLabel)} · ${escapeHtml(notificationTime(item.createdAt))}</small>
              </span>
              ${item.readAt ? `<span class="chevron" aria-hidden="true">${icon("i-arrow")}</span>` : `<span class="notification-unread-dot" aria-label="Unread"></span>`}
            </button>`;
          }).join("") : `<div class="notification-empty"><div><span class="empty-icon">${icon("i-bell")}</span><h3>No notifications yet</h3><p>When attendance opens or a quiz or material is posted, it will stay here for you.</p></div></div>`}
        </div>
        <p class="notification-status">${icon("i-bell")}<span>${statusView.message}</span>${statusView.action}</p>
      </section>
    </div>`;
  notificationButton?.setAttribute("aria-expanded", "true");
  window.setTimeout(() => {
    if (focus) {
      root.querySelector("button[data-action='close-modal']")?.focus();
      return;
    }
    if (!restoreFocus) return;
    const buttons = [...root.querySelectorAll("button")];
    const replacement = previousNotificationId
      ? buttons.find(button => button.dataset.notificationId === previousNotificationId)
      : buttons.find(button => button.dataset.action === previousAction);
    replacement?.focus();
  }, 0);
}

function openNotificationInbox() {
  if (!state.authenticated) return;
  modalReturnFocus = document.activeElement;
  renderNotificationInbox({ focus: true });
  pushManager?.refresh?.({ silent: true }).catch(() => {});
}

async function openNotificationDestination(item) {
  if (!item || !state.authenticated) return;
  closeModal();
  if (item.courseId) {
    const course = state.courses.find(candidate => candidate.id === item.courseId);
    if (!course) {
      toast("That course is no longer available to this account", "error");
      return navigate("dashboard");
    }
    try {
      await switchCourseContext(course.id, { renderView: false, notify: false });
    } catch (error) {
      toast(error.message || "Could not open that course", "error");
      return;
    }
  }
  const route = [
    "dashboard", "schedule", "classes", "notices", "students",
    "materials", "attendance", "quizzes", "settings",
  ].includes(item.route) ? item.route : "dashboard";
  navigate(route);
}

async function startNotificationLifecycle() {
  if (!pushManager || !state.authenticated || !state.authEmail || !backendConfigured() || !apiToken) {
    syncNotificationUi();
    return;
  }
  try {
    const snapshot = await pushManager.start({ accountEmail: state.authEmail });
    syncNotificationUi(snapshot);
  } catch {
    // Core app access must not depend on push or inbox availability.
  }
}

pushManager?.configure?.({
  // The manager receives an authenticated request function, never the token.
  request: (path, options) => apiRequest(path, options),
  onInbox: (snapshot) => {
    syncNotificationUi(snapshot);
    if (document.querySelector("#notificationInboxModal")) {
      renderNotificationInbox({ restoreFocus: true });
    }
  },
  onStatus: () => {
    syncNotificationUi();
    if (document.querySelector("#notificationInboxModal")) {
      renderNotificationInbox({ restoreFocus: true });
    }
  },
  onForeground: (item) => {
    const message = [item.title, item.body].filter(Boolean).join(" · ");
    toast(message || "New course activity", "notification");
    if (item.route === "attendance" || String(item.type).includes("attendance")) {
      refreshOpenAttendance().catch(() => {});
    }
  },
  onOpen: (item) => {
    openNotificationDestination(item).catch((error) => {
      toast(error.message || "Could not open that notification", "error");
    });
  },
});

function openReminderModal() {
  modalReturnFocus = document.activeElement;
  const settings = reminderManager?.getSettings?.(state.authEmail) || {
    enabled: false,
    leadMinutes: 15,
  };
  const entries = reminderScheduleEntries();
  const supported = Boolean(reminderManager?.supported);
  const submitDisabled = !supported || !entries.length;
  document.querySelector("#modalRoot").innerHTML = `
    <div class="modal-backdrop" data-action="close-modal">
      <form class="modal" id="reminderForm" role="dialog" aria-modal="true" aria-labelledby="reminderModalTitle" aria-describedby="reminderModalDescription">
        <div class="modal-head"><div><h2 id="reminderModalTitle">${icon("i-clock")} Class reminders</h2><p id="reminderModalDescription">Get an alert on this phone before every scheduled class.</p></div><button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">${icon("i-close")}</button></div>
        <div class="reminder-summary">
          <span class="reminder-bell">${icon("i-clock")}</span>
          <div><strong>${entries.length} weekly ${entries.length === 1 ? "class" : "classes"} found</strong><p>${settings.enabled ? `Reminders are on · ${settings.leadMinutes} minutes before class` : "Reminders are currently off"}</p></div>
        </div>
        <div class="field" style="margin-top:18px">
          <label for="reminderLead">Remind me before class</label>
          <select id="reminderLead" name="leadMinutes" ${submitDisabled ? "disabled" : ""}>
            ${[5, 10, 15, 30, 60].map(minutes => `<option value="${minutes}" ${settings.leadMinutes === minutes ? "selected" : ""}>${minutes === 60 ? "1 hour" : `${minutes} minutes`} before</option>`).join("")}
          </select>
        </div>
        ${supported
          ? entries.length
            ? `<div class="security-note"><span class="lock">${icon("i-clock")}</span><span>CampusPulse schedules these alerts on this phone. No SMS, email service, or internet connection is needed when an alert fires.</span></div>`
            : `<div class="security-note"><span class="lock">${icon("i-calendar")}</span><span>Add or import a weekly timetable before enabling reminders.</span></div>`
          : `<div class="security-note"><span class="lock">${icon("i-download")}</span><span>Phone reminders need the installed CampusPulse app. This browser cannot reliably alert you while it is closed.</span></div>`}
        <div class="setup-actions">
          <button type="button" class="btn" data-action="close-modal">Cancel</button>
          ${!entries.length ? `<button type="button" class="btn btn-soft" data-action="open-reminder-schedule">${icon("i-calendar")} Open schedule</button>` : ""}
          ${settings.enabled ? `<button type="button" class="btn btn-danger" data-action="disable-class-reminders">Turn off</button>` : ""}
          <button class="btn btn-primary" type="submit" ${submitDisabled ? "disabled" : ""}>${icon("i-clock")} ${settings.enabled ? "Update reminders" : "Enable reminders"}</button>
        </div>
      </form>
    </div>`;
  setTimeout(() => document.querySelector("#reminderLead:not([disabled])")?.focus(), 0);
}

function closeModal() {
  document.querySelector("#modalRoot").innerHTML = "";
  notificationButton?.setAttribute("aria-expanded", "false");
  modalReturnFocus?.focus?.();
  modalReturnFocus = null;
  editingScheduleIndex = -1;
}

function renderPlaceholder(route) {
  if (route === "classes") return renderClasses();
  if (route === "settings") return renderSettings();
  const config = {
    classes: ["Classes", "Manage your timetable", "i-calendar"],
    settings: ["Settings", "Configure the secure API connection, privacy, and account access.", "i-settings"]
  }[route] || ["Coming soon", "This workspace is ready for its next module.", "i-grid"];
  setHeader(config[0], "CAMPUSPULSE");
  view.innerHTML = `<article class="card empty-state"><div><span class="empty-icon">${icon(config[2])}</span><h2>${config[0]}</h2><p>${config[1]}</p><button class="btn btn-primary" type="button" data-action="go-back">Back</button></div></article>`;
}

// Everyone who signed up and joined, as opposed to the uploaded roll list.
async function refreshCourseMarks(courseId) {
  if (!backendConfigured() || !apiToken || !courseId) {
    courseMarks = null;
    courseMarksLoadedFor = "";
    return;
  }
  courseMarksLoadedFor = courseId;
  try {
    courseMarks = await apiRequest(`/api/courses/${encodeURIComponent(courseId)}/marks`);
  } catch {
    courseMarks = null;
    courseMarksLoadedFor = "";
  }
}

function renderStudents() {
  if (state.userRole === "student") return navigate("dashboard");
  if (studentRecord) return renderStudentRecord();
  if (managedCourseId) return renderCourseRoster(managedCourseId);
  setHeader("Students", state.userRole === "faculty" ? "PROFESSOR WORKSPACE" : "TEACHING ASSISTANT WORKSPACE", false);
  const course = selectedCourse();
  if (course && canManageRoster(course) && courseMarksLoadedFor !== course.id) {
    refreshCourseMarks(course.id).then(() => {
      if (state.route === "students" && state.selectedCourseId === course.id) renderStudents();
    });
  }
  const visibleCourses = course ? [course] : [];
  const allEnrolled = enrolledStudents.filter(
    student => !course || student.courseId === course.id
  );
  const enrolled = allEnrolled.filter(student => matchesSearch(student, studentSearch));
  const byCourse = new Map();
  const officialRosterCourses = visibleCourses.filter(
    course => course.rosterSource === "owner-upload"
  );
  const pendingRosterCourses = visibleCourses.filter(
    course => canManageRoster(course) && course.rosterSource !== "owner-upload"
  );
  for (const student of enrolled) {
    if (!byCourse.has(student.courseId)) byCourse.set(student.courseId, []);
    byCourse.get(student.courseId).push(student);
  }
  view.innerHTML = `
    <div class="page-grid roster-grid">
      <article class="card page-card">
        <div class="section-head"><div><h2 style="margin:0 0 5px">Enrolled students</h2><p class="stat-label">Accounts that joined this course using their registered roll number</p></div><div class="setup-actions"><span class="badge ${allEnrolled.length ? "green" : "amber"}">${studentSearch ? `${enrolled.length} of ${allEnrolled.length}` : `${allEnrolled.length} enrolled`}</span><button class="btn" type="button" data-action="export-enrolled" ${enrolled.length ? "" : "disabled"}>${icon("i-download")} Excel</button></div></div>
        ${allEnrolled.length ? searchBox("studentSearch", studentSearch, "Search students by name or roll number") : ""}
        ${pendingRosterCourses.length ? `<div class="setup-actions roster-upload-actions">
          ${pendingRosterCourses.map(course => `<button class="btn btn-soft" type="button" data-action="view-course-roster" data-course-id="${escapeHtml(course.id)}">${icon("i-upload")} Upload ${escapeHtml(course.courseCode)} roll list</button>`).join("")}
        </div>` : ""}
        ${enrolled.length ? [...byCourse.entries()].map(([courseId, students]) => {
          const course = state.courses.find(item => item.id === courseId);
          return `<div style="margin-top:18px">
            <div class="section-head"><h3>${escapeHtml(course ? `${course.courseCode} · ${course.name}` : courseId)}</h3><span class="badge purple">${students.length}</span></div>
            <div class="roster-scroll">
              <table class="roster-table">
                <thead><tr><th>Roll No</th><th>Name</th><th>Email</th><th>Department</th><th>Phone</th><th>Hall</th></tr></thead>
                <tbody>${students.map(student => `<tr class="roster-row-clickable" data-action="open-student-record" data-roll-number="${escapeHtml(student.rollNumber || "")}" data-course-id="${escapeHtml(student.courseId)}" tabindex="0" role="button" aria-label="Open the record for ${escapeHtml(student.name)}">
                  <td class="roster-roll">${escapeHtml(student.rollNumber || "—")}</td>
                  <td>${escapeHtml(student.name)}</td>
                  <td>${escapeHtml(student.email)}</td>
                  <td>${escapeHtml(student.department || "—")}</td>
                  <td>${escapeHtml(student.phone || "—")}</td>
                  <td>${escapeHtml(student.hall || "—")}</td>
                </tr>`).join("")}</tbody>
              </table>
            </div>
          </div>`;
        }).join("") : `<p class="stat-label" style="padding:14px 2px">${studentSearch
          ? "No student here matches that name or roll number."
          : "Nobody has joined yet. Share a course join code — students enter it with their roll number."}</p>`}
      </article>
      ${course && canManageRoster(course) ? `<aside class="card page-card" data-course-id="${escapeHtml(course.id)}">
        <div class="section-head"><div><h3>Exams</h3><p class="stat-label">Rename, reorder by editing, add what this course actually sets, and remove what it does not.</p></div></div>
        <div class="exam-rows">
          ${examEditorRows().map((exam, index) => `<div class="exam-row" data-exam-row>
            <input class="text-input" type="text" maxlength="60" placeholder="Exam name"
              data-exam-label value="${escapeHtml(exam.label)}" aria-label="Exam ${index + 1} name" />
            <input class="text-input" type="number" min="1" max="1000" step="1" placeholder="Out of"
              data-exam-max value="${exam.maxMarks ?? ""}" aria-label="Exam ${index + 1} marked out of" />
            <input type="hidden" data-exam-id value="${escapeHtml(exam.id || "")}" />
            <button class="icon-btn" type="button" data-action="remove-exam-row" aria-label="Remove ${escapeHtml(exam.label || "this exam")}">${icon("i-close")}</button>
          </div>`).join("")}
        </div>
        <div class="setup-actions" style="margin-top:14px">
          <button class="btn btn-soft" type="button" data-action="add-exam-row">${icon("i-plus")} Add exam</button>
          <button class="btn btn-primary" type="button" data-action="save-exams" data-course-id="${escapeHtml(course.id)}">${icon("i-check")} Save exams</button>
        </div>
        <div class="security-note" style="margin-top:14px"><span class="lock">⌾</span><span>Removing an exam deletes the marks recorded for it. Renaming one keeps them.</span></div>
      </aside>
      <aside class="card page-card" data-course-id="${escapeHtml(course.id)}">
        <div class="section-head"><div><h3>Upload marks</h3><p class="stat-label">Record a whole exam from a spreadsheet, or open any student to type one mark.</p></div></div>
        <label for="examSelect">Exam</label>
        <select class="select" id="examSelect">
          ${(courseMarks?.exams || []).map(exam =>
            `<option value="${escapeHtml(exam.id)}" data-max-marks="${exam.maxMarks ?? ""}">${escapeHtml(exam.label)}${exam.maxMarks ? ` · out of ${exam.maxMarks}` : ""}</option>`
          ).join("") || `<option value="">Save the exams first</option>`}
        </select>
        <label for="examOutOf" style="margin-top:12px">Marked out of</label>
        <input class="text-input" id="examOutOf" type="number" min="1" max="1000" step="1" placeholder="e.g. 20"
          value="${courseMarks?.exams?.[0]?.maxMarks ?? ""}" />
        <div class="setup-actions" style="margin-top:14px">
          <button class="btn btn-soft" type="button" data-action="upload-exam-marks" data-course-id="${escapeHtml(course.id)}">${icon("i-upload")} Upload marks sheet</button>
          <input id="examMarksFile" type="file" hidden />
        </div>
        <div class="security-note" style="margin-top:14px"><span class="lock">⌾</span><span>The sheet needs a roll number column and a marks column. Anyone left out keeps the mark they already have, so a partial sheet is fine.</span></div>
      </aside>` : ""}
      ${officialRosterCourses.length ? `<aside class="card page-card">
        <div class="section-head"><h3>Official rosters</h3></div>
        <div class="summary-list">
          ${officialRosterCourses.map(course => `<div class="summary-item"><span>${escapeHtml(course.courseCode)} · ${(byCourse.get(course.id) || []).length} enrolled of ${Number(course.students) || 0}</span></div>`).join("")}
        </div>
        <div class="security-note official-roster-actions" style="margin-top:16px">
          ${officialRosterCourses.map(course => `<button class="btn btn-soft" type="button" data-action="view-course-roster" data-course-id="${escapeHtml(course.id)}">${icon("i-users")} ${canManageRoster(course) ? "Manage roster" : "View roster"}${officialRosterCourses.length > 1 ? ` · ${escapeHtml(course.courseCode)}` : ""}</button>`).join("")}
        </div>
      </aside>` : ""}
    </div>`;
}

function renderSettings() {
  setHeader("Settings", "CAMPUSPULSE", false);
  const updateState = updateManager?.state || { status: "unavailable" };
  view.innerHTML = `
    <div class="page-grid">
      <aside class="card page-card">
        <div class="section-head"><h3>Account & privacy</h3></div>
        <div class="summary-list"><div class="summary-item"><span>Mode</span><strong>${backendConfigured() ? "Persistent API" : "This-device prototype"}</strong></div><div class="summary-item"><span>Account session</span><strong>${apiToken ? "Signed in" : "Not connected"}</strong></div><div class="summary-item"><span>App version</span><strong>${APP_VERSION}</strong></div></div>
        <div class="setup-actions" style="margin-top:20px"><a class="btn" href="privacy.html" target="_blank" rel="noopener">Privacy policy</a><button class="btn" type="button" data-action="logout">Sign out</button><button class="btn btn-danger" type="button" data-action="delete-account">Delete my account</button></div>
      </aside>
      <article class="card page-card">
        <div class="section-head"><div><h2 style="margin:0 0 5px">Change password</h2><p class="stat-label">Signs out your other devices. ${escapeHtml(state.authEmail || "your account")}</p></div></div>
        <form id="changePasswordForm" class="login-form">
          <label for="currentPassword">Current password</label>
          <input id="currentPassword" name="currentPassword" type="password" autocomplete="current-password" required />
          <div class="auth-field-pair">
            <div><label for="newPassword">New password</label><input id="newPassword" name="newPassword" type="password" placeholder="At least 8 characters" autocomplete="new-password" minlength="8" required /></div>
            <div><label for="confirmNewPassword">Confirm new password</label><input id="confirmNewPassword" name="confirmNewPassword" type="password" autocomplete="new-password" minlength="8" required /></div>
          </div>
          <button class="btn btn-primary" type="submit">${icon("i-check")} Update password</button>
        </form>
      </article>
      <article class="card page-card update-settings-card">
        <div class="section-head"><div><h2 style="margin:0 0 5px">App updates</h2><p id="webUpdateDetail" class="stat-label">${escapeHtml(updateState.message || "Updates are delivered with the website")}</p></div><span id="webUpdateStatus" class="badge ${updateState.status === "error" ? "amber" : "green"}">${updateStatusLabel(updateState.status)}</span></div>
        <p class="update-explainer">Web features, fixes, and styling download and install automatically in the installed app, except while a class is running — those wait until you leave the screen. Native changes still require a new APK or IPA.</p>
        ${updateState.supported ? `<div class="setup-actions"><button class="btn" type="button" data-action="check-for-updates">Check now</button>${updateState.status === "ready" ? `<button class="btn btn-primary" type="button" data-action="restart-to-update">Restart and update</button>` : ""}</div>` : ""}
      </article>
    </div>`;
}

function nativeDeviceStatus() {
  return window.Capacitor?.Plugins?.DeviceStatus || null;
}

function geolocationPlugin() {
  return window.Capacitor?.Plugins?.Geolocation || null;
}

// Attendance is verified against where the class is being held, so a fix is
// required on both sides. Resolves to null when the device cannot or will not
// provide one; the caller turns that into an explanation rather than a silent
// failure.
async function currentLocation({ timeoutMs = 12000 } = {}) {
  // In the installed app, `navigator.geolocation` only works once the app
  // itself holds Android's runtime location permission — and nothing in a web
  // page can ask for that. The native plugin requests it, so it has to be tried
  // first or the professor just sees "turn Location on" with no way to.
  const plugin = geolocationPlugin();
  if (plugin) {
    try {
      const permission = await plugin.checkPermissions();
      if (permission?.location !== "granted") {
        const asked = await plugin.requestPermissions({ permissions: ["location"] });
        if (asked?.location !== "granted") return null;
      }
      const position = await plugin.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: timeoutMs,
        maximumAge: 30000,
      });
      if (position?.coords) {
        return {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
        };
      }
    } catch {
      // Permission refused, or the radio gave nothing. Fall through to the
      // browser API, which may still succeed on a device that has a fix.
    }
  }

  return new Promise((resolve) => {
    if (!navigator.geolocation?.getCurrentPosition) return resolve(null);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    // Some devices sit on a pending permission prompt indefinitely.
    const timer = setTimeout(() => finish(null), timeoutMs + 1000);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        clearTimeout(timer);
        finish({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
      },
      () => {
        clearTimeout(timer);
        finish(null);
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30000 }
    );
  });
}

async function attendanceSignals({ requestWebBluetooth = false } = {}) {
  const nativePlugin = nativeDeviceStatus();
  if (nativePlugin) {
    const [wifi, bluetooth] = await Promise.all([
      nativePlugin.checkWifi(),
      nativePlugin.checkBluetooth()
    ]);
    return {
      wifi: Boolean(wifi.connected),
      bluetooth: Boolean(bluetooth.available && bluetooth.enabled)
    };
  }

  let bluetooth = state.checks.bluetooth;
  if (requestWebBluetooth && navigator.bluetooth?.requestDevice) {
    try {
      await navigator.bluetooth.requestDevice({ acceptAllDevices: true });
      bluetooth = true;
    } catch (error) {
      if (error.name === "NotFoundError") bluetooth = false;
      else throw error;
    }
  } else if (!navigator.bluetooth) {
    bluetooth = true;
  }
  return { wifi: navigator.onLine, bluetooth };
}

async function verifyDevice(type) {
  try {
    const signals = await attendanceSignals({
      requestWebBluetooth: type === "bluetooth"
    });
    if (type === "wifi") {
      if (!signals.wifi) return toast("Connect to Wi‑Fi, then try again", "error");
      state.checks.wifi = true;
      toast("Wi‑Fi connection verified");
    } else {
      if (!signals.bluetooth) return toast("Turn on Bluetooth, then try again", "error");
      state.checks.bluetooth = true;
      toast(nativeDeviceStatus() ? "Bluetooth status verified" : "Bluetooth beacon ready");
    }
  } catch (error) {
    return toast(error.message || "Device verification permission was denied", "error");
  }
  persist();
  renderAttendanceSetup();
}

function parseScheduleCSV(text) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error("CSV must include a header and at least one class");
  const headers = lines[0].split(",").map(header => header.trim().replace(/^"|"$/g, "").toLowerCase());
  const get = (values, ...names) => {
    const index = headers.findIndex(header => names.includes(header));
    return index >= 0 ? values[index]?.trim().replace(/^"|"$/g, "") : "";
  };
  return lines.slice(1).map(line => {
    const values = line.split(",");
    return {
      day: get(values, "day", "weekday") || "Class",
      date: get(values, "date") || "Imported",
      start: get(values, "start", "start_time", "time") || "—",
      end: get(values, "end", "end_time") || "—",
      topic: get(values, "course", "subject", "topic", "summary") || "Scheduled class",
      room: get(values, "room", "location", "venue") || "Room TBA"
    };
  }).filter(item => item.topic);
}

function parseCSVRow(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && quoted && line[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      values.push(value.trim());
      value = "";
    } else {
      value += character;
    }
  }
  values.push(value.trim());
  return values;
}

const ROLL_HEADERS = ["roll", "rollno", "rollnumber", "studentroll", "rollno.", "regno", "registrationno"];
const NAME_HEADERS = ["name", "studentname", "fullname", "student"];
const EMAIL_HEADERS = ["email", "emailid", "emailaddress", "mail", "mailid", "instituteemail"];
const PHONE_HEADERS = [
  "phone", "phoneno", "phonenumber", "mobile", "mobileno", "mobilenumber",
  "contact", "contactno", "contactnumber", "whatsapp"
];
// The roster table numbers its own rows, so a serial column out of the sheet is
// recognised and dropped rather than kept as one more detail to scroll past.
const SERIAL_HEADERS = ["sl", "slno", "sno", "serial", "serialno", "srno", "sr", "no", "index"];
// Real sheets write "Name of Student" or "Student's Roll No.", so an exact
// heading match is tried first and a word match second.
const ROLL_TOKENS = ["roll", "regn", "registration", "enrol", "admission"];
const NAME_TOKENS = ["name"];
const EMAIL_TOKENS = ["email", "mail"];
const PHONE_TOKENS = ["phone", "mobile", "contact", "whatsapp"];
// Someone else's name on the row is not the student's.
const NAME_EXCLUSIONS = ["father", "mother", "guardian", "parent", "username", "filename", "course", "subject", "hall", "college"];
const MAX_ROSTER_EXTRA_FIELDS = 12;
const MAX_EXTRA_LABEL = 60;
const MAX_EXTRA_VALUE = 200;

// How far down a sheet the real header row is looked for.
const MAX_HEADER_SEARCH_ROWS = 10;

// Reads one candidate row as a set of headings, or returns null when it holds
// no name column and therefore is not the header.
function rosterColumnsFrom(candidate) {
  const rawHeaders = candidate.map(header => String(header || "").trim());
  const headers = rawHeaders.map(header => header.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const claimed = new Set();
  const take = (exactList, tokens, exclusions = []) => {
    const free = (index) => !claimed.has(index);
    let found = headers.findIndex((header, index) => free(index) && exactList.includes(header));
    const exact = found >= 0;
    if (found < 0) {
      found = headers.findIndex((header, index) =>
        free(index)
        && tokens.some(token => header.includes(token))
        && !exclusions.some(token => header.includes(token))
      );
    }
    if (found >= 0) claimed.add(found);
    return { index: found, exact };
  };
  // The unambiguous columns are claimed first so the looser name match cannot
  // wander into one of them.
  const roll = take(ROLL_HEADERS, ROLL_TOKENS);
  const email = take(EMAIL_HEADERS, EMAIL_TOKENS);
  const phone = take(PHONE_HEADERS, PHONE_TOKENS);
  const name = take(NAME_HEADERS, NAME_TOKENS, NAME_EXCLUSIONS);
  const { index: rollIndex } = roll;
  const { index: emailIndex } = email;
  const { index: phoneIndex } = phone;
  const nameIndex = name.index;
  if (nameIndex < 0) return null;
  // A row filling one cell is a banner rather than a header — unless that cell
  // is exactly a known heading, since a sheet of nothing but names is real.
  // "Student Name List 2026" is a title; "Name" is a column.
  if (rawHeaders.filter(Boolean).length < 2 && !name.exact) return null;
  // Whatever the app has no column of its own for still belongs to the student,
  // kept under the heading the sheet gave it.
  const extraColumns = rawHeaders
    .map((header, index) => ({ header, index }))
    .filter(column =>
      column.header
      && !claimed.has(column.index)
      && !SERIAL_HEADERS.includes(headers[column.index])
    )
    .slice(0, MAX_ROSTER_EXTRA_FIELDS);
  return {
    rollIndex, emailIndex, phoneIndex, nameIndex, extraColumns,
    // How much of the row was recognised, so the real header beats a title
    // that happens to contain one of the words.
    score: [rollIndex, emailIndex, phoneIndex, nameIndex].filter(index => index >= 0).length,
  };
}

// Shared by CSV and Excel: rows are arrays of cell strings.
//
// A departmental roll list is whatever that department exports — roll, email,
// phone, hall, year, section, in any combination. Only the name is required;
// every other column is carried through under the student instead of being
// dropped, so the professor keeps the contact details they were sent.
//
// The header is searched for rather than assumed to be the first row: these
// exports routinely open with a title and a subtitle above the real headings.
function rosterFromRows(rows, label) {
  const cleaned = rows.filter(row => row.some(cell => String(cell || "").trim()));
  if (cleaned.length < 2) throw new Error(`Roster ${label} must include a header and at least one student`);
  let headerRow = -1;
  let columns = null;
  const limit = Math.min(cleaned.length - 1, MAX_HEADER_SEARCH_ROWS);
  for (let index = 0; index < limit; index += 1) {
    const candidate = rosterColumnsFrom(cleaned[index]);
    if (candidate && (!columns || candidate.score > columns.score)) {
      headerRow = index;
      columns = candidate;
    }
  }
  if (!columns) throw new Error(`Roster ${label} needs a name column`);
  const { rollIndex, emailIndex, phoneIndex, nameIndex, extraColumns } = columns;

  return cleaned
    .slice(headerRow + 1)
    .map(row => {
      const cell = index => (index >= 0 ? String(row[index] ?? "").trim() : "");
      const extra = {};
      extraColumns.forEach(column => {
        const value = String(row[column.index] ?? "").trim();
        if (value) extra[column.header.slice(0, MAX_EXTRA_LABEL)] = value.slice(0, MAX_EXTRA_VALUE);
      });
      return {
        rollNumber: cell(rollIndex),
        name: cell(nameIndex),
        email: cell(emailIndex),
        phone: cell(phoneIndex),
        ...(Object.keys(extra).length ? { extra } : {})
      };
    })
    .filter(student => student.name);
}

const MARK_HEADERS = [
  "marks", "mark", "score", "scores", "obtained", "marksobtained",
  "total", "result", "grade", "points"
];

// Reads a marks sheet: one column of roll numbers and one of marks.
//
// The marks column is named where possible and otherwise inferred, because a
// sheet exported from an exam system rarely uses the heading you expect. Rows
// whose mark is blank are kept — clearing a mark is a real edit, distinct from
// leaving a student out of the file altogether.
function marksFromRows(rows, label) {
  const cleaned = rows.filter(row => row.some(cell => String(cell || "").trim()));
  if (cleaned.length < 2) {
    throw new Error(`Marks ${label} must include a header and at least one student`);
  }
  const headers = cleaned[0].map(header =>
    String(header || "").toLowerCase().replace(/[^a-z0-9]/g, "")
  );
  const rollIndex = headers.findIndex(header => ROLL_HEADERS.includes(header));
  if (rollIndex < 0) throw new Error(`Marks ${label} needs a roll number column`);

  let markIndex = headers.findIndex(header => MARK_HEADERS.includes(header));
  if (markIndex < 0) {
    // Fall back to the first other column that reads as numbers.
    markIndex = headers.findIndex((_header, index) => {
      if (index === rollIndex) return false;
      const values = cleaned.slice(1).map(row => String(row[index] ?? "").trim());
      const filled = values.filter(Boolean);
      return filled.length > 0 && filled.every(value => Number.isFinite(Number(value)));
    });
  }
  if (markIndex < 0) throw new Error(`Marks ${label} needs a column of marks`);

  return cleaned
    .slice(1)
    .map(row => {
      const rollNumber = String(row[rollIndex] ?? "").trim();
      const raw = String(row[markIndex] ?? "").trim();
      return { rollNumber, score: raw === "" ? null : raw };
    })
    .filter(entry => entry.rollNumber);
}

async function readMarksFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx")) {
    return marksFromRows(await xlsxRows(await file.arrayBuffer()), "sheet");
  }
  if (name.endsWith(".csv")) {
    const rows = (await file.text())
      .split(/\r?\n/)
      .filter(line => line.trim())
      .map(parseCSVRow);
    return marksFromRows(rows, "file");
  }
  throw new Error("Upload the marks as .xlsx or .csv");
}

function decodeXmlText(value = "") {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&");
}

async function inflateEntry(bytes, method) {
  if (method === 0) return bytes;
  if (method !== 8) throw new Error("This Excel file uses an unsupported compression method");
  if (typeof DecompressionStream !== "function") {
    throw new Error("This browser cannot open .xlsx files — save the sheet as CSV instead");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Minimal reader for the parts of the .xlsx container we need. An .xlsx file is
// a ZIP of XML, so the central directory is walked directly rather than pulling
// in a spreadsheet library the app has no bundler for.
async function readXlsxParts(buffer, wanted) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let end = -1;
  for (let index = bytes.length - 22; index >= 0 && index > bytes.length - 66000; index -= 1) {
    if (view.getUint32(index, true) === 0x06054b50) { end = index; break; }
  }
  if (end < 0) throw new Error("That file is not a readable .xlsx workbook");

  const entryCount = view.getUint16(end + 10, true);
  let pointer = view.getUint32(end + 16, true);
  const parts = new Map();
  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(pointer, true) !== 0x02014b50) break;
    const method = view.getUint16(pointer + 10, true);
    const compressedSize = view.getUint32(pointer + 20, true);
    const nameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    const localOffset = view.getUint32(pointer + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength));
    if (wanted(name)) {
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const raw = bytes.subarray(start, start + compressedSize);
      parts.set(name, new TextDecoder().decode(await inflateEntry(raw, method)));
    }
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return parts;
}

function columnIndex(reference = "") {
  const letters = String(reference).match(/^[A-Z]+/)?.[0] || "";
  return [...letters].reduce((total, letter) => total * 26 + (letter.charCodeAt(0) - 64), 0) - 1;
}

async function xlsxRows(buffer) {
  const parts = await readXlsxParts(
    buffer,
    name => name === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(name)
  );
  const sheetName = [...parts.keys()]
    .filter(name => name.startsWith("xl/worksheets/"))
    .sort()[0];
  if (!sheetName) throw new Error("That workbook has no readable sheet");

  const sharedStrings = [...(parts.get("xl/sharedStrings.xml") || "").matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map(match => [...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
      .map(part => decodeXmlText(part[1]))
      .join(""));

  const rows = [];
  for (const rowMatch of parts.get(sheetName).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attributes = cellMatch[1];
      const body = cellMatch[2];
      const type = attributes.match(/\st="([^"]+)"/)?.[1] || "";
      const reference = attributes.match(/\sr="([^"]+)"/)?.[1] || "";
      let value = "";
      if (type === "s") {
        value = sharedStrings[Number(body.match(/<v>([\s\S]*?)<\/v>/)?.[1] || -1)] || "";
      } else if (type === "inlineStr") {
        value = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
          .map(part => decodeXmlText(part[1]))
          .join("");
      } else {
        value = decodeXmlText(body.match(/<v>([\s\S]*?)<\/v>/)?.[1] || "");
      }
      const index = reference ? columnIndex(reference) : cells.length;
      cells[index >= 0 ? index : cells.length] = value;
    }
    rows.push([...cells].map(cell => cell ?? ""));
  }
  return rows;
}

async function parseRosterXlsx(buffer) {
  return rosterFromRows(await xlsxRows(buffer), "sheet");
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// A .xlsx is a ZIP of XML. Entries are stored uncompressed, which keeps the
// writer to a CRC and a couple of headers instead of a spreadsheet library.
function zipStored(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(text);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(10, 0, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((total, part) => total + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
}

function xlsxCellText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Excel rejects control characters outright.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

function xlsxCell(reference, value) {
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xlsxCellText(value)}</t></is></c>`;
}

// Excel rejects a sheet name containing any of : \ / ? * [ ] or over 31 chars.
function xlsxSheetName(name) {
  const cleaned = String(name || "").replace(/[:\\/?*[\]]/g, " ").trim().slice(0, 31);
  return cleaned || "Sheet1";
}

function downloadXlsx(filename, headers, rows, sheetName = "Sheet1") {
  const columns = (index) => {
    let name = "";
    let value = index;
    do {
      name = String.fromCharCode(65 + (value % 26)) + name;
      value = Math.floor(value / 26) - 1;
    } while (value >= 0);
    return name;
  };
  const sheetRows = [headers, ...rows]
    .map((cells, rowIndex) =>
      `<row r="${rowIndex + 1}">${cells.map((cell, columnIndex) => xlsxCell(`${columns(columnIndex)}${rowIndex + 1}`, cell)).join("")}</row>`
    )
    .join("");
  const blob = zipStored([
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xlsxCellText(xlsxSheetName(sheetName))}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
    ["xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`]
  ]);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function decodePdfLiteral(raw) {
  let out = "";
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character !== "\\") { out += character; continue; }
    const next = raw[index += 1];
    if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "t") out += "\t";
    else if (next === "b" || next === "f") out += " ";
    else if (next >= "0" && next <= "7") {
      let octal = next;
      while (octal.length < 3 && raw[index + 1] >= "0" && raw[index + 1] <= "7") octal += raw[index += 1];
      out += String.fromCharCode(parseInt(octal, 8));
    } else out += next;
  }
  return out;
}

function decodePdfHex(raw) {
  const digits = raw.replace(/[^0-9A-Fa-f]/g, "");
  let out = "";
  for (let index = 0; index + 1 < digits.length; index += 2) {
    out += String.fromCharCode(parseInt(digits.slice(index, index + 2), 16));
  }
  return out;
}

// Each drawn string with the text-space position it was placed at. Roster PDFs
// are tables, so every cell is its own positioned string.
function pdfTextItems(content) {
  const items = [];
  let x = 0;
  let y = 0;
  let lineX = 0;
  let lineY = 0;
  let leading = 12;
  let numbers = [];
  let pending = [];
  const tokens = content.matchAll(
    /\((?:\\[\s\S]|[^\\()])*\)|<[0-9A-Fa-f\s]*>|-?\d+(?:\.\d+)?|BT|ET|T\*|Tm|TD|Td|TL|TJ|Tj/g
  );
  for (const [token] of tokens) {
    if (token.startsWith("(")) { pending.push(decodePdfLiteral(token.slice(1, -1))); continue; }
    if (token.startsWith("<")) { pending.push(decodePdfHex(token.slice(1, -1))); continue; }
    if (/^-?\d/.test(token)) { numbers.push(Number(token)); continue; }
    if (token === "BT") { x = y = lineX = lineY = 0; }
    else if (token === "Tm" && numbers.length >= 6) {
      x = lineX = numbers[numbers.length - 2];
      y = lineY = numbers[numbers.length - 1];
    } else if ((token === "Td" || token === "TD") && numbers.length >= 2) {
      if (token === "TD") leading = -numbers[numbers.length - 1];
      lineX += numbers[numbers.length - 2];
      lineY += numbers[numbers.length - 1];
      x = lineX;
      y = lineY;
    } else if (token === "TL" && numbers.length) {
      leading = numbers[numbers.length - 1];
    } else if (token === "T*") {
      lineY -= leading;
      x = lineX;
      y = lineY;
    } else if (token === "Tj" || token === "TJ") {
      const text = pending.join("");
      if (text.trim()) items.push({ x, y, text });
    }
    numbers = [];
    if (token === "Tj" || token === "TJ") pending = [];
  }
  return items;
}

// Cells sharing a baseline form one row, read left to right, top row first.
function pdfTextLines(content) {
  const rows = new Map();
  for (const item of pdfTextItems(content)) {
    const key = Math.round(item.y);
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(item);
  }
  return [...rows.entries()]
    .sort((left, right) => right[0] - left[0])
    .map(([, cells]) =>
      cells
        .sort((left, right) => left.x - right.x)
        .map(cell => cell.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean);
}

async function pdfContentStreams(buffer) {
  const bytes = new Uint8Array(buffer);
  const raw = new TextDecoder("latin1").decode(bytes);
  if (/\/Encrypt\b/.test(raw)) {
    throw new Error("That PDF is password protected — export an unprotected copy");
  }
  const chunks = [];
  const marker = /stream\r?\n?/g;
  let match;
  while ((match = marker.exec(raw))) {
    const dictionary = raw.slice(Math.max(0, match.index - 400), match.index);
    const start = match.index + match[0].length;
    const stop = raw.indexOf("endstream", start);
    if (stop < 0) break;
    // Prefer the declared /Length; otherwise drop the EOL that precedes
    // "endstream", because a single trailing byte makes inflate reject the
    // whole stream as trailing junk.
    const declared = Number(dictionary.match(/\/Length\s+(\d+)/)?.[1] || 0);
    let finish = declared > 0 && start + declared <= stop ? start + declared : stop;
    while (finish > start && (bytes[finish - 1] === 0x0a || bytes[finish - 1] === 0x0d)) finish -= 1;
    const slice = bytes.subarray(start, finish);
    if (/\/FlateDecode/.test(dictionary)) {
      if (typeof DecompressionStream !== "function") {
        throw new Error("This browser cannot open compressed PDFs — upload the Excel or CSV version");
      }
      try {
        const stream = new Blob([slice]).stream().pipeThrough(new DecompressionStream("deflate"));
        chunks.push(new TextDecoder("latin1").decode(await new Response(stream).arrayBuffer()));
      } catch {
        // Not every stream is page content; skip the ones that will not inflate.
      }
    } else {
      chunks.push(new TextDecoder("latin1").decode(slice));
    }
    marker.lastIndex = stop + "endstream".length;
  }
  return chunks;
}

// Roll numbers carry at least one digit; the remainder of the line is the name.
function rosterFromTextLines(lines) {
  const pattern = /^(?:\d{1,4}[.)]?\s+)?([A-Za-z0-9/-]{5,20})[\s,|]+([A-Za-z][A-Za-z .'`-]{1,80})$/;
  const students = [];
  for (const line of lines) {
    const text = line.replace(/\s+/g, " ").trim();
    const match = text.match(pattern);
    if (!match) continue;
    const rollNumber = match[1].toUpperCase();
    if (!/\d/.test(rollNumber)) continue;
    students.push({ rollNumber, name: match[2].trim() });
  }
  return students;
}

async function parseRosterPdf(buffer) {
  const streams = await pdfContentStreams(buffer);
  const lines = streams.flatMap(pdfTextLines);
  const students = rosterFromTextLines(lines);
  if (!students.length) {
    throw new Error(
      "No roll numbers were found in that PDF. Scanned PDFs hold no text — upload the Excel or CSV version instead"
    );
  }
  return students;
}

// Keys the roster already has a home for; anything else in a JSON entry is kept
// as an extra detail rather than silently discarded.
const JSON_ROSTER_KNOWN_KEYS = new Set([
  "rollNumber", "roll", "roll_no", "rollno",
  "name", "studentName", "student_name",
  "email", "emailId", "email_id",
  "phone", "mobile", "phoneNumber", "phone_number",
  "serial", "sl", "slNo", "sl_no", "courseId", "extra",
]);

function parseRosterUpload(text, filename = "") {
  if (filename.toLowerCase().endsWith(".json")) {
    const parsed = JSON.parse(text);
    const students = Array.isArray(parsed) ? parsed : parsed.students;
    if (!Array.isArray(students)) throw new Error("JSON roster must be an array or contain a students array");
    return students.map(student => {
      const extra = {};
      Object.entries(student || {}).forEach(([key, value]) => {
        if (JSON_ROSTER_KNOWN_KEYS.has(key)) return;
        if (value === null || value === undefined || typeof value === "object") return;
        const text = String(value).trim();
        if (text) extra[key.slice(0, MAX_EXTRA_LABEL)] = text.slice(0, MAX_EXTRA_VALUE);
      });
      // A caller that already grouped its own fields under `extra` keeps them.
      Object.entries(student?.extra && typeof student.extra === "object" ? student.extra : {})
        .forEach(([key, value]) => {
          const text = String(value ?? "").trim();
          if (text) extra[key.slice(0, MAX_EXTRA_LABEL)] = text.slice(0, MAX_EXTRA_VALUE);
        });
      return {
        rollNumber: student.rollNumber || student.roll || student.roll_no || "",
        name: student.name || student.studentName || student.student_name || "",
        email: student.email || student.emailId || student.email_id || "",
        phone: student.phone || student.mobile || student.phoneNumber || student.phone_number || "",
        ...(Object.keys(extra).length ? { extra } : {})
      };
    });
  }
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return rosterFromRows(lines.map(parseCSVRow), "CSV");
}

async function readRosterFile(file) {
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".xlsx")) return parseRosterXlsx(await file.arrayBuffer());
  if (name.endsWith(".pdf")) return parseRosterPdf(await file.arrayBuffer());
  if (name.endsWith(".xls")) {
    throw new Error("Save the sheet as .xlsx or CSV — the old .xls format is not supported");
  }
  // The picker no longer filters by type, so an unreadable choice is named as
  // such rather than failing further in as a malformed CSV.
  if (!/\.(csv|json|txt)$/.test(name)) {
    throw new Error("Upload the roll list as .xlsx, .pdf, .csv or .json");
  }
  return parseRosterUpload(await file.text(), file.name);
}

function parseScheduleICS(text) {
  const formatDate = value => {
    const raw = value.replace(/Z$/, "");
    const date = new Date(Number(raw.slice(0, 4)), Number(raw.slice(4, 6)) - 1, Number(raw.slice(6, 8)), Number(raw.slice(9, 11) || 0), Number(raw.slice(11, 13) || 0));
    return {
      day: date.toLocaleDateString("en-US", { weekday: "long" }),
      date: date.toLocaleDateString("en-US", { day: "numeric", month: "short" }),
      time: date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
    };
  };
  return text.split("BEGIN:VEVENT").slice(1).map(block => {
    const field = name => block.match(new RegExp(`^${name}(?:;[^:]*)?:(.+)$`, "mi"))?.[1]?.trim() || "";
    const start = formatDate(field("DTSTART"));
    const end = formatDate(field("DTEND"));
    return { day: start.day, date: start.date, start: start.time, end: end.time, topic: field("SUMMARY") || "Scheduled class", room: field("LOCATION") || "Room TBA" };
  });
}

document.addEventListener("keydown", event => {
  const dialog = document.querySelector("#modalRoot [role='dialog']");
  if (!dialog) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeModal();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [...dialog.querySelectorAll(
    "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
  )].filter(element => !element.hidden && element.getClientRects().length);
  if (!focusable.length) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!dialog.contains(document.activeElement)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

document.addEventListener("click", async event => {
  const authRole = event.target.closest("[data-auth-role]");
  if (authRole) return renderLogin(authRole.dataset.authRole, authMode);
  const authModeButton = event.target.closest("[data-auth-mode]");
  if (authModeButton) {
    return renderLogin(selectedLoginRole, authModeButton.dataset.authMode);
  }
  const copyButton = event.target.closest("[data-copy]");
  if (copyButton) {
    navigator.clipboard?.writeText(copyButton.dataset.copy);
    return toast(`${copyButton.dataset.copyLabel || "Join code"} ${copyButton.dataset.copy} copied`);
  }
  const routeButton = event.target.closest("[data-route], [data-route-link]");
  if (routeButton) {
    const route = routeButton.dataset.route || routeButton.dataset.routeLink;
    // Students open their own record here; only the team opens a session.
    if (route === "attendance" && state.userRole !== "student") {
      const courseId = routeButton.dataset.courseId
        || selectedCourse()?.id
        || state.courses.find(canRunAttendance)?.id;
      if (!courseId) return toast("Join or create a course first", "error");
      try {
        await selectAttendanceCourse(courseId);
      } catch (error) {
        return toast(error.message || "Could not open course attendance", "error");
      }
    }
    return navigate(route);
  }
  const check = event.target.closest("[data-check]");
  if (check) return verifyDevice(check.dataset.check);
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!action) return;

  if (action === "go-back") return goBack();

  if (action === "retry-session") {
    await bootstrapApp();
    return;
  }
  if (action === "retry-past-sessions") {
    const course = selectedCourse();
    if (!course || !canRunAttendance(course)) return;
    const refresh = refreshPastSessions(course.id);
    render();
    await refresh;
    if (state.selectedCourseId === course.id) render();
    return;
  }
  if (action === "sign-out-stuck") {
    signOutLocally();
    authMode = "login";
    renderLogin(state.userRole);
    return;
  }
  if (action === "check-for-updates") {
    if (!updateManager?.state.supported) return toast("Updates are automatic on the web");
    const result = await updateManager.checkForUpdate({ manual: true });
    syncUpdateUi(result);
    if (result.status === "current") return toast("CampusPulse is up to date");
    if (result.status === "ready") return toast("Update downloaded and ready to apply");
    return toast(result.message || "Could not check for updates", "error");
  }
  if (action === "restart-to-update") {
    try {
      await updateManager?.restartToUpdate();
    } catch (error) {
      return toast(error.message || "Could not apply the update", "error");
    }
    return;
  }

  if (action === "open-reminder-schedule") {
    closeModal();
    return navigate("schedule");
  }
  if (action === "disable-class-reminders") {
    try {
      await reminderManager?.disable(state.authEmail);
      closeModal();
      return toast("Class reminders turned off on this phone");
    } catch (error) {
      return toast(error.message || "Could not turn off class reminders", "error");
    }
  }

  if (action === "open-notification-inbox") {
    return openNotificationInbox();
  }
  if (action === "mark-all-notifications-read") {
    try {
      await pushManager?.markAllRead?.();
      return toast("All notifications marked as read");
    } catch (error) {
      return toast(error.message || "Could not update notifications", "error");
    }
  }
  if (action === "enable-push-notifications") {
    try {
      const result = await pushManager?.enablePush?.({ requestPermission: true });
      if (result?.permission === "granted") {
        return toast("Phone alerts are enabled");
      }
      return toast("Allow CampusPulse notifications in Android settings", "error");
    } catch (error) {
      return toast(error.message || "Could not enable phone alerts", "error");
    }
  }
  if (action === "open-notification") {
    const id = event.target.closest("[data-notification-id]")?.dataset.notificationId || "";
    const item = currentNotificationState().notifications.find(notification => notification.id === id);
    if (!item) return toast("That notification is no longer available", "error");
    pushManager?.markRead?.(item.inboxId || item.id).catch(() => {});
    return openNotificationDestination(item);
  }

  if (action === "edit-course") {
    if (state.userRole !== "faculty") return toast("Only professors can edit courses", "error");
    const courseId = event.target.closest("[data-course-id]")?.dataset.courseId || "";
    const target = state.courses.find(item => item.id === courseId);
    if (!target) return toast("Course not found", "error");
    return openCourseModal(target);
  }
  if (action === "delete-course") {
    if (state.userRole !== "faculty") return toast("Only professors can delete courses", "error");
    const courseId = event.target.closest("[data-course-id]")?.dataset.courseId || "";
    const target = state.courses.find(item => item.id === courseId);
    if (!target) return toast("Course not found", "error");
    const confirmed = window.confirm(
      `Delete ${target.courseCode} — ${target.name}?

`
      + `This removes its roll list, enrolments, shared files, timetable, attendance history and quizzes. `
      + `Students and TAs lose access. This cannot be undone.`
    );
    if (!confirmed) return;
    try {
      await apiRequest(`/api/courses/${encodeURIComponent(courseId)}`, { method: "DELETE" });
    } catch (error) {
      return toast(error.message || "Could not delete the course", "error");
    }
    if (state.selectedCourseId === courseId) state.selectedCourseId = "";
    if (managedCourseId === courseId) managedCourseId = "";
    if (materialsCourseId === courseId) materialsCourseId = "";
    await syncBackendState();
    persist();
    syncCourseSwitcher();
    renderClasses();
    return toast(`${target.courseCode} deleted`);
  }
  if (action === "open-course-modal") {
    if (state.userRole !== "faculty") return toast("Only professors can create courses", "error");
    openCourseModal();
  }
  if (action === "close-modal") {
    const isBackdropClick = event.target.classList.contains("modal-backdrop");
    const isCloseButton = Boolean(event.target.closest("button[data-action='close-modal']"));
    if (isBackdropClick || isCloseButton) closeModal();
  }
  if (action === "view-course-roster") {
    const courseId = event.target.closest("[data-course-id]")?.dataset.courseId || "";
    const course = state.courses.find(item => item.id === courseId);
    if (!courseCapabilities(course).canViewAttendanceRoster) {
      return toast("Course roster access required", "error");
    }
    await switchCourseContext(courseId, { renderView: false, notify: false });
    try {
      await Promise.all([loadCourseRoster(courseId), refreshCourseMarks(courseId)]);
    } catch (error) {
      return toast(error.message || "Could not load the course roster", "error");
    }
    managedCourseId = courseId;
    // Routed rather than assigned: a direct state.route change leaves no
    // history entry, so Back had nothing to step onto and the topbar arrow
    // stayed hidden on a screen that is not the root.
    return navigate("students", { keepCourseContext: true });
  }
  if (action === "close-course-roster") {
    return goBack();
  }
  if (action === "open-course-materials") {
    const courseId = event.target.closest("[data-course-id]")?.dataset.courseId || "";
    if (!state.courses.some(course => course.id === courseId)) {
      return toast("Course not found", "error");
    }
    await switchCourseContext(courseId, { renderView: false, notify: false });
    try {
      await loadCourseMaterials(courseId, { force: true });
    } catch (error) {
      return toast(error.message || "Could not load course materials", "error");
    }
    managedCourseId = "";
    materialsCourseId = courseId;
    return navigate("materials");
  }
  if (action === "close-course-materials") {
    return goBack();
  }
  if (action === "view-material" || action === "download-material") {
    const button = event.target.closest("[data-material-id]");
    const materialId = button?.dataset.materialId || "";
    const material = (courseMaterials.get(materialsCourseId) || [])
      .find(item => item.id === materialId);
    if (!material) return toast("Course material not found", "error");
    button.disabled = true;
    try {
      const blob = await materialBlob(materialId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      if (action === "view-material") {
        link.target = "_blank";
        link.rel = "noopener";
      } else {
        link.download = material.fileName;
      }
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return toast(action === "view-material" ? "Opening material" : "Download started");
    } catch (error) {
      return toast(error.message || "Could not download that material", "error");
    } finally {
      button.disabled = false;
    }
  }
  if (action === "delete-material") {
    const course = state.courses.find(item => item.id === materialsCourseId);
    const materialId = event.target.closest("[data-material-id]")?.dataset.materialId || "";
    const material = (courseMaterials.get(materialsCourseId) || [])
      .find(item => item.id === materialId);
    if (!canManageCourse(course) || !material) {
      return toast("Only the course professor can remove materials", "error");
    }
    if (!window.confirm(`Remove ${material.fileName} from ${course.courseCode}?`)) return;
    try {
      await apiRequest(`/api/materials/${encodeURIComponent(materialId)}`, {
        method: "DELETE"
      });
      const materials = await loadCourseMaterials(course.id, { force: true });
      state.courses = state.courses.map(item =>
        item.id === course.id ? { ...item, materialCount: materials.length } : item
      );
      persist();
      renderCourseMaterials(course.id);
      return toast("Course material removed");
    } catch (error) {
      return toast(error.message || "Could not remove that material", "error");
    }
  }
  if (action === "open-course-quiz") {
    const courseId = event.target.closest("[data-course-id]")?.dataset.courseId || "";
    try {
      await switchCourseContext(courseId, { renderView: false, notify: false });
    } catch (error) {
      return toast(error.message || "Could not open course quizzes", "error");
    }
    return navigate("quizzes");
  }
  if (action === "start-course-attendance") {
    const courseId = event.target.closest("[data-course-id]")?.dataset.courseId || "";
    const course = state.courses.find(item => item.id === courseId);
    if (!canRunAttendance(course)) return toast("Course-team attendance access required", "error");
    try {
      await switchCourseContext(courseId, { renderView: false, notify: false });
    } catch (error) {
      return toast(error.message || "Could not open course attendance", "error");
    }
    managedCourseId = "";
    return navigate("attendance");
  }
  if (action === "open-dashboard-attendance") {
    const courseId = event.target.closest("[data-course-id]")?.dataset.courseId || "";
    const course = state.courses.find(item => item.id === courseId);
    if (!canRunAttendance(course)) return toast("Course-team attendance access required", "error");
    try {
      await switchCourseContext(courseId, { renderView: false, notify: false });
    } catch (error) {
      return toast(error.message || "Could not open course attendance", "error");
    }
    return navigate("attendance");
  }
  if (action === "attendance") navigate("attendance");
  if (action === "new-attendance-session") {
    if (!canRunAttendance(attendanceCourse())) return toast("Course-team attendance access required", "error");
    applyAttendanceSnapshot(null);
    persist();
    return renderAttendanceSetup();
  }
  if (action === "export-day-attendance") {
    const course = attendanceCourse() || selectedCourse();
    const session = viewingPastAttendance || activeAttendance;
    const records = viewingPastAttendance
      ? viewingPastAttendance.records || []
      : currentAttendanceRecords();
    if (!course || !records.length) return toast("Nothing to export yet", "error");
    const started = session?.startedAt ? new Date(session.startedAt) : new Date();
    const stamp = started.toISOString().slice(0, 10);
    const clock = session?.importedAt ? "paper" : started.toTimeString().slice(0, 5).replace(":", "");
    const present = records.filter(record => record.present).length;
    downloadXlsx(
      `CampusPulse-${course.courseCode}-attendance-${stamp}-${clock}.xlsx`,
      ["Sl.No.", "Roll No", "Name", "Status", "Marked at", "Marked by", "Bluetooth (m)", "Network checked", "Location checked"],
      records.map((record, index) => [
        record.serial || index + 1,
        record.rollNumber || "",
        record.name || "",
        record.present ? "Present" : "Absent",
        record.markedAt && !session?.importedAt ? new Date(record.markedAt).toLocaleString() : "",
        session?.importedAt && record.present ? "Paper register" : record.markedAt ? attendanceMethodLabel(record.markedVia) || "Course team" : "",
        record.proximity?.bluetoothMetres ?? "",
        record.proximity ? (record.proximity.networkVerified ? "Yes" : "No") : "",
        record.proximity ? (record.proximity.locationVerified ? "Yes" : "No") : ""
      ]),
      `${stamp} attendance`
    );
    return toast(`Downloaded ${present}/${records.length} present`);
  }
  if (action === "open-student-record") {
    const holder = event.target.closest("[data-roll-number]");
    const rollNumber = holder?.dataset.rollNumber;
    const courseId =
      holder?.dataset.courseId || (attendanceCourse() || selectedCourse())?.id;
    if (!rollNumber || !courseId) {
      return toast("That student has no roll number yet", "error");
    }
    return openStudentRecord(courseId, rollNumber);
  }
  if (action === "save-student-marks") {
    if (!studentRecord) return toast("Open a student first", "error");
    const { student } = studentRecord;
    const changed = [];
    for (const input of view.querySelectorAll("[data-mark-for]")) {
      const exam = input.dataset.markFor;
      const before = studentRecord.marks.find(item => item.id === exam);
      const typed = input.value.trim();
      const after = typed === "" ? null : Number(typed);
      if (typed !== "" && !Number.isFinite(after)) {
        return toast(`${before.label}: enter a number, or leave it blank`, "error");
      }
      if ((before.score ?? null) !== after) changed.push({ exam, score: after });
    }
    if (!changed.length) return toast("Nothing changed");
    try {
      // One exam per request: the API records a whole exam at a time, which is
      // also what a spreadsheet upload uses.
      for (const { exam, score } of changed) {
        await apiRequest(
          `/api/courses/${encodeURIComponent(student.courseId)}/marks/${encodeURIComponent(exam)}`,
          { method: "PUT", body: { entries: [{ rollNumber: student.rollNumber, score }] } }
        );
      }
    } catch (error) {
      return toast(error.message || "Could not save those marks", "error");
    }
    await openStudentRecord(student.courseId, student.rollNumber);
    return toast(`Saved ${changed.length} mark${changed.length === 1 ? "" : "s"}`);
  }
  if (action === "add-exam-row") {
    examDraft = [...readExamRows(), { id: "", label: "", maxMarks: null }];
    renderStudents();
    // Land the caret in the row just added rather than making them find it.
    const rows = view.querySelectorAll("[data-exam-row] [data-exam-label]");
    return rows[rows.length - 1]?.focus();
  }
  if (action === "remove-exam-row") {
    const row = event.target.closest("[data-exam-row]");
    const rows = [...view.querySelectorAll("[data-exam-row]")];
    const index = rows.indexOf(row);
    if (index < 0) return;
    examDraft = readExamRows().filter((_exam, position) => position !== index);
    return renderStudents();
  }
  if (action === "save-exams") {
    const courseId = event.target.closest("[data-course-id]")?.dataset.courseId;
    if (!courseId) return toast("Choose a course first", "error");
    const rows = readExamRows();
    if (rows.some(row => !row.label.trim())) {
      return toast("Every exam needs a name", "error");
    }
    if (rows.some(row => row.maxMarks !== null && !(Number(row.maxMarks) > 0))) {
      return toast("An exam is marked out of a number above zero, or left blank", "error");
    }
    // Removing an exam destroys its marks, so it is confirmed rather than done
    // on a stray tap.
    const kept = new Set(rows.map(row => row.id).filter(Boolean));
    const dropped = (courseMarks?.exams || []).filter(exam => !kept.has(exam.id));
    if (dropped.length) {
      const names = dropped.map(exam => exam.label).join(", ");
      const confirmed = window.confirm(
        `Remove ${names}?\n\nAny marks recorded for ${dropped.length === 1 ? "it" : "them"} are deleted and cannot be recovered.`
      );
      if (!confirmed) return;
    }
    try {
      const saved = await apiRequest(`/api/courses/${encodeURIComponent(courseId)}/exams`, {
        method: "PUT",
        body: { exams: rows }
      });
      courseMarks = { ...(courseMarks || {}), exams: saved.exams };
      examDraft = null;
      // The grid and every total may have moved, so take them fresh.
      await refreshCourseMarks(courseId);
    } catch (error) {
      return toast(error.message || "Could not save those exams", "error");
    }
    renderStudents();
    return toast(
      dropped.length
        ? `Saved. ${dropped.length} exam${dropped.length === 1 ? "" : "s"} removed.`
        : `Saved ${rows.length} exam${rows.length === 1 ? "" : "s"}`
    );
  }
  if (action === "upload-exam-marks") {
    const courseId = event.target.closest("[data-course-id]")?.dataset.courseId;
    const exam = view.querySelector("#examSelect")?.value;
    const outOf = view.querySelector("#examOutOf")?.value.trim();
    if (!courseId || !exam) return toast("Choose an exam first", "error");
    if (!outOf || !(Number(outOf) > 0)) {
      return toast("Enter what this exam is marked out of", "error");
    }
    pendingMarksUpload = { courseId, exam, maxMarks: Number(outOf) };
    return view.querySelector("#examMarksFile")?.click();
  }
  if (action === "close-student-record") {
    return goBack();
  }
  if (action === "export-student-record") {
    if (!studentRecord) return toast("Open a student first", "error");
    const { student, summary, sessions } = studentRecord;
    const safeRoll = String(student.rollNumber || "student").replace(/[^A-Za-z0-9]+/g, "-");
    downloadXlsx(
      `CampusPulse-${student.courseCode}-${safeRoll}.xlsx`,
      ["Date", "Class", "Room", "Status", "Marked at", "Marked by"],
      [
        ...sessions.map(session => [
          new Date(session.startedAt).toLocaleDateString(),
          session.classLabel || (session.importedAt ? "Paper register" : new Date(session.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })),
          session.room || "",
          session.present ? "Present" : "Absent",
          session.markedAt && !session.importedAt ? new Date(session.markedAt).toLocaleString() : "",
          session.importedAt && session.present ? "Paper register" : session.markedAt ? attendanceMethodLabel(session.markedVia) || "Course team" : ""
        ]),
        [],
        ["Held", summary.held, "Attended", summary.attended, "Missed", summary.missed],
        ["Percentage", `${summary.percentage}%`]
      ],
      `${student.rollNumber}`
    );
    return toast("Downloaded that student's record");
  }
  if (action === "retry-beacon") {
    // Granting the permission or switching the radio on happens outside the
    // app, so there has to be a way back in without restarting the session.
    if (!proximityCode?.code) return toast("No active session to broadcast", "error");
    beaconError = "";
    renderLiveAttendance();
    const started = await startAttendanceBeacon(proximityCode.code);
    renderLiveAttendance();
    return toast(
      started ? "Broadcasting to the room" : beaconError || "Still not broadcasting",
      started ? "success" : "error"
    );
  }
  if (action === "start-scan") {
    if (!canRunAttendance(selectedCourse())) return toast("Course-team attendance access required", "error");
    if (!backendConfigured()) return toast("Connect CampusPulse to its API first", "error");
    toast("Finding the classroom…");
    // A fix makes the register stronger but must never prevent one being
    // taken: an already-installed app may have no way to ask for the location
    // permission, and a professor stuck at this step cannot teach the class.
    const classLocation = await currentLocation();
    try {
      const result = await apiRequest("/api/attendance/sessions", {
        method: "POST",
        body: {
          courseId: state.selectedCourseId,
          ...(classLocation ? { location: classLocation } : {})
        }
      });
      activeAttendance = result.attendance;
      state.backendAttendanceId = result.attendance.id;
      viewingPastAttendance = null;
    } catch (error) {
      return toast(error.message || "Could not open attendance", "error");
    }
    state.attendanceStatus = "scanning";
    // An earlier class today may have just moved into the history.
    await refreshPastSessions(state.selectedCourseId);
    persist(); renderLiveAttendance(); toast(`Attendance opened with ${currentAttendanceRecords().length} rostered students`);
  }
  if (action === "toggle-attendance") {
    if (!canRunAttendance(attendanceCourse()) || !state.backendAttendanceId) return toast("Course-team attendance session required", "error");
    const rollNumber = event.target.closest("[data-roll-number]")?.dataset.rollNumber;
    const record = currentAttendanceRecords().find(item => item.rollNumber === rollNumber);
    if (!record) return toast("That student is not in the active roster", "error");
    try {
      const result = await apiRequest(`/api/attendance/${state.backendAttendanceId}/records`, {
        method: "PATCH",
        body: { records: [{ rollNumber, present: !record.present }] }
      });
      activeAttendance = result.attendance;
      renderLiveAttendance();
    } catch (error) {
      return toast(error.message || "Could not update attendance", "error");
    }
  }
  if (action === "mark-all-attendance" || action === "clear-attendance") {
    if (!canRunAttendance(attendanceCourse()) || !state.backendAttendanceId) return toast("Course-team attendance session required", "error");
    const present = action === "mark-all-attendance";
    try {
      const result = await apiRequest(`/api/attendance/${state.backendAttendanceId}/records`, {
        method: "PATCH",
        body: { records: currentAttendanceRecords().map(record => ({ rollNumber: record.rollNumber, present })) }
      });
      activeAttendance = result.attendance;
      renderLiveAttendance();
      toast(present ? "All rostered students marked present" : "Attendance marks cleared");
    } catch (error) {
      return toast(error.message || "Could not update attendance", "error");
    }
  }
  if (action === "end-session") {
    if (!canRunAttendance(attendanceCourse())) return toast("Course-team attendance access required", "error");
    const total = currentAttendanceRecords().length;
    const present = currentPresentCount();
    if (!window.confirm(`Close attendance with ${present} present and ${total - present} absent? Marks cannot be changed after closing.`)) return;
    try {
      const result = await apiRequest(`/api/attendance/${state.backendAttendanceId}/close`, {
        method: "POST",
        body: {}
      });
      activeAttendance = result.attendance;
    } catch (error) {
      return toast(error.message || "Could not close attendance", "error");
    }
    clearInterval(scanTimer);
    // Nothing is listening now, and a beacon left running would keep telling
    // the room that a closed class is still taking marks.
    await stopAttendanceBroadcast();
    state.attendanceStatus = "complete";
    // The class just closed belongs in the history dropdown straight away.
    await refreshPastSessions(state.selectedCourseId);
    persist(); renderLiveAttendance(); toast(`Attendance saved for ${currentPresentCount()} students`);
  }
  if (action === "reopen-session") {
    if (!canRunAttendance(attendanceCourse())) return toast("Course-team attendance access required", "error");
    const sessionId = event.target.closest("[data-session-id]")?.dataset.sessionId
      || viewingPastAttendance?.id
      || state.backendAttendanceId;
    if (!sessionId) return toast("No session to reopen", "error");
    const classLocation = await currentLocation();
    try {
      const result = await apiRequest(`/api/attendance/${encodeURIComponent(sessionId)}/reopen`, {
        method: "POST",
        body: classLocation ? { location: classLocation } : {},
      });
      activeAttendance = result.attendance;
      state.backendAttendanceId = result.attendance.id;
      state.attendanceStatus = "scanning";
      viewingPastAttendance = null;
    } catch (error) {
      return toast(error.message || "Could not reopen that session", "error");
    }
    persist();
    await refreshPastSessions(state.selectedCourseId);
    renderLiveAttendance();
    toast("Attendance reopened — add missed students below");
  }
  if (action === "add-student-manual") {
    if (!canRunAttendance(attendanceCourse()) || !state.backendAttendanceId) return toast("Course-team attendance session required", "error");
    const input = view.querySelector("#manualRollInput");
    const rollNumber = input?.value.trim().toUpperCase() || "";
    if (!rollNumber) return toast("Enter a roll number", "error");
    try {
      const result = await apiRequest(`/api/attendance/${state.backendAttendanceId}/add-student`, {
        method: "POST",
        body: { rollNumber }
      });
      activeAttendance = result.attendance;
      renderLiveAttendance();
      toast(`${rollNumber} added and marked present`);
    } catch (error) {
      return toast(error.message || "Could not add that student", "error");
    }
  }
  if (action === "delete-account") {
    const confirmed = window.confirm(
      "Delete your CampusPulse account, enrollment, and quiz response data? Official rosters and teaching-team-recorded attendance remain course records. This cannot be undone."
    );
    if (!confirmed) return;
    const deletingEmail = state.authEmail;
    try {
      if (backendConfigured() && apiToken) {
        await apiRequest("/api/account", { method: "DELETE" });
      } else {
        state.accounts = state.accounts.filter(
          (account) => account.email !== state.authEmail
        );
      }
      await pushManager?.stop?.({ unregister: true }).catch(() => {});
      await reminderManager?.disable(deletingEmail, { forget: true }).catch(() => {});
      apiToken = "";
      localStorage.removeItem("campusPulseApiToken");
      clearSensitiveClientState({ clearImportedSchedule: true });
      state.authenticated = false;
      state.accountName = "";
      state.authEmail = "";
      state.enrolledCourses = [];
      state.route = "dashboard";
      localStorage.removeItem("campusPulseState");
      renderLogin(state.userRole, "signup");
      return toast("Your CampusPulse account was deleted");
    } catch (error) {
      return toast(error.message || "Could not delete the account", "error");
    }
  }
  if (action === "clear-imported-schedule") {
    const course = selectedCourse();
    state.importedSchedule = state.importedSchedule.filter(
      item => !course || (
        Boolean(item.courseId) &&
        item.courseId !== course.id &&
        !scheduleBelongsToCourse(item, course)
      )
    );
    persist();
    await syncClassReminders();
    renderSchedule();
    toast(`Imported ${course?.courseCode || "course"} timetable cleared`);
  }
  if (action === "calendar-today") {
    document.querySelector(".calendar-scroll")?.scrollTo({ left: 220, behavior: "smooth" });
    toast("Showing the current teaching week");
  }
  if (action === "logout") {
    clearTimeout(quizTimer);
    await reminderManager?.suspend(state.authEmail).catch(() => {});
    await pushManager?.stop?.({ unregister: true }).catch(() => {});
    if (backendConfigured() && apiToken) {
      try { await apiRequest("/api/auth/logout", { method: "POST" }); } catch {}
      apiToken = "";
      localStorage.removeItem("campusPulseApiToken");
    }
    clearSensitiveClientState({ clearImportedSchedule: true });
    state.authenticated = false;
    state.accountName = "";
    state.authEmail = "";
    state.route = "dashboard";
    authMode = "login";
    persist();
    document.querySelector("#modalRoot").innerHTML = "";
    modalReturnFocus = null;
    renderLogin(state.userRole);
  }
  if (action === "export-enrolled") {
    const course = selectedCourse();
    const exportStudents = enrolledStudents.filter(
      student => course && student.courseId === course.id
    );
    if (!exportStudents.length) return toast("Nobody has joined this course yet", "error");
    const stamp = new Date().toISOString().slice(0, 10);
    downloadXlsx(
      `CampusPulse-${course.courseCode}-enrolled-${stamp}.xlsx`,
      ["Name", "Roll No", "Email", "Department", "Phone No", "Hall of Residence", "Course"],
      exportStudents.map(student => [
        student.name,
        student.rollNumber || "",
        student.email,
        student.department || "",
        student.phone || "",
        student.hall || "",
        student.courseCode
      ])
    );
    return toast(`${exportStudents.length} ${course.courseCode} students exported`);
  }
  if (action === "select-course") {
    const courseId = event.target.closest("[data-course-id]")?.dataset.courseId || "";
    if (courseId === state.selectedCourseId) return;
    try {
      await switchCourseContext(courseId);
    } catch (error) {
      return toast(error.message || "Could not switch courses", "error");
    }
    syncCourseSwitcher();
    return;
  }
  if (action === "edit-class-topics") {
    const index = Number(event.target.closest("[data-index]")?.dataset.index);
    return openScheduleTopicsModal(index);
  }
  if (action === "remove-schedule-class") {
    const course = selectedCourse();
    if (!course || !canManageSchedule(course)) {
      return toast("Course-team timetable access required", "error");
    }
    const index = Number(event.target.closest("[data-index]")?.dataset.index);
    const remaining = state.backendSchedule
      .filter(item => item.courseId === course.id)
      .filter((_, position) => position !== index);
    return saveCourseSchedule(course, remaining, "Class removed");
  }
  if (action === "remove-roster-student") {
    const course = state.courses.find(item => item.id === managedCourseId);
    const button = event.target.closest("[data-action]");
    const rollNumber = button?.dataset.rollNumber || "";
    const serial = button?.dataset.rosterSerial || "";
    if (!course || !canManageRoster(course)) {
      return toast("Course-team roster access required", "error");
    }
    if (!rollNumber && !serial) return toast("Could not identify that student", "error");
    // A name-only entry has no roll number to name it by, on screen or in the URL.
    const label = rollNumber || `entry ${serial}`;
    if (!window.confirm(`Remove ${label} from the ${course.courseCode} roll list? They lose access to this course.`)) return;
    try {
      const path = rollNumber
        ? `/api/courses/${encodeURIComponent(course.id)}/roster/${encodeURIComponent(rollNumber)}`
        : `/api/courses/${encodeURIComponent(course.id)}/roster/entry/${encodeURIComponent(serial)}`;
      const result = await apiRequest(path, { method: "DELETE" });
      courseRosters.set(course.id, result.students || []);
      state.courses = state.courses.map(item => item.id === course.id ? { ...item, ...result.course } : item);
      persist();
      renderCourseRoster(course.id);
      return toast(`${label} removed`);
    } catch (error) {
      return toast(error.message || "Could not remove that student", "error");
    }
  }
  if (action === "student-check-in") {
    const button = event.target.closest("[data-action]");
    const sessionId = button.dataset.sessionId;
    const session = openAttendance.find(item => item.id === sessionId);
    if (!session) return toast("That attendance session has closed", "error");
    const rollInput = document.querySelector(`[data-roll-for="${sessionId}"]`);
    const rollNumber = session.rollNumber || rollInput?.value.trim().toUpperCase() || "";
    if (!rollNumber) return toast("Enter your roll number", "error");
    button.disabled = true;
    try {
      if (!proximityPlugin()) {
        if (!session.webCheckInAvailable) {
          return toast(
            "Website attendance was not enabled for this class. Ask the course team to mark you from the roster.",
            "error",
          );
        }
        if (!navigator.onLine) {
          return toast("Connect to the classroom Wi‑Fi, then try again", "error");
        }
        toast("Verifying classroom Wi‑Fi and location…");
        const location = await currentLocation();
        if (!location) {
          return toast(
            "Allow Precise Location for CampusPulse in Safari, then try again",
            "error",
          );
        }
        await apiRequest(`/api/attendance/${sessionId}/check-in`, {
          method: "POST",
          body: { rollNumber, mode: "web-wifi", location },
        });
        state.checks = { wifi: true, bluetooth: false };
      } else {
        const signals = await attendanceSignals({ requestWebBluetooth: true });
        if (!signals.wifi || !signals.bluetooth) {
          const missing = [!signals.wifi && "Wi‑Fi", !signals.bluetooth && "Bluetooth"]
            .filter(Boolean)
            .join(" and ");
          return toast(`Turn on ${missing}, then mark attendance again`, "error");
        }
        toast("Looking for the class over Bluetooth…");
        const beacon = await findAttendanceBeacon();
        const code = String(beacon.token || "").trim().toUpperCase();
        // Hearing the beacon at all means being inside Bluetooth radio range.
        // A token that read as too far is still submitted, because the distance
        // estimate is the noisier of the two signals at that point and location
        // can settle it — a student in the back row should not be turned away.
        if (!code) {
          return toast(
            beacon.error || "The class was not found nearby. Move closer and try again.",
            "error",
          );
        }
        // Bluetooth has already proved the room. A fix strengthens that, but a
        // phone whose installed app cannot ask for the location permission must
        // still be able to mark itself present.
        const location = await currentLocation();
        await apiRequest(`/api/attendance/${sessionId}/check-in`, {
          method: "POST",
          body: {
            rollNumber,
            signals,
            code,
            ...(location ? { location } : {}),
            bluetoothDistanceMeters: beacon.distanceMeters,
          },
        });
        state.checks = { wifi: true, bluetooth: true };
      }
      persist();
      toast("You are marked present");
    } catch (error) {
      return toast(error.message || "Could not mark attendance", "error");
    } finally {
      button.disabled = false;
    }
    await refreshOpenAttendance({ rerender: false });
    if (state.route === "attendance") await refreshAttendanceHistory(state.selectedCourseId);
    return render();
  }
  if (action === "remove-question") {
    const card = event.target.closest(".question-card");
    const builder = document.querySelector("#quizBuilder");
    if (!card || !builder) return;
    if (builder.querySelectorAll(".question-card").length <= 1) {
      return toast("A quiz needs at least one question", "error");
    }
    card.remove();
    // Renumber what is left so the badges stay in order.
    builder.querySelectorAll(".question-card").forEach((item, index) => {
      const badge = item.querySelector(".q-number");
      if (badge) badge.textContent = index + 1;
      item.querySelectorAll(".option-input input[type='radio']").forEach(radio => {
        radio.name = `q${index + 1}`;
      });
    });
    return;
  }
  if (action === "attach-question-image") {
    const card = event.target.closest(".question-card");
    return card?.querySelector(".question-image-file")?.click();
  }
  if (action === "remove-question-image") {
    const card = event.target.closest(".question-card");
    const holder = card?.querySelector(".question-image");
    const picture = holder?.querySelector("img");
    if (picture) {
      picture.removeAttribute("src");
      delete picture.dataset.image;
    }
    if (holder) holder.hidden = true;
    const input = card?.querySelector(".question-image-file");
    if (input) input.value = "";
    return;
  }
  if (action === "add-question") {
    const button = event.target.closest("[data-action]");
    button.insertAdjacentHTML("beforebegin", questionBlock(document.querySelectorAll(".question-card").length + 1));
  }
  if (action === "delete-notice") {
    const course = selectedCourse();
    const noticeId = event.target.closest("[data-notice-id]")?.dataset.noticeId || "";
    if (!course || !canRunAttendance(course)) {
      return toast("Only the course team can remove notices", "error");
    }
    try {
      await apiRequest(
        `/api/courses/${encodeURIComponent(course.id)}/notices/${encodeURIComponent(noticeId)}`,
        { method: "DELETE" }
      );
      await refreshNotices(course.id);
    } catch (error) {
      return toast(error.message || "Could not remove that notice", "error");
    }
    renderNotices();
    return toast("Notice removed");
  }
  if (action === "open-my-quiz") {
    myQuizId = event.target.closest("[data-quiz-id]")?.dataset.quizId || "";
    return navigate("myquiz");
  }
  if (action === "back-to-signup") {
    const role = pendingSignup?.role || selectedLoginRole;
    pendingSignup = null;
    return renderLogin(role, "signup");
  }
  if (action === "resend-code" && pendingSignup) {
    try {
      await apiRequest("/api/auth/signup/resend", {
        method: "POST",
        auth: false,
        body: { email: pendingSignup.email }
      });
    } catch (error) {
      return toast(error.message || "Could not send another code", "error");
    }
    return toast("Another code is on its way");
  }
  if (action === "open-attendance-day") {
    attendanceDayId = event.target.closest("[data-session-id]")?.dataset.sessionId || "";
    return navigate("attendanceday");
  }
  if (action === "open-past-session") {
    const sessionId = event.target.closest("[data-session-id]")?.dataset.sessionId || "";
    if (!sessionId) return;
    const originRoute = state.route;
    // The list also sits on the dashboard, so the route has to move with the
    // click or the register would render underneath the wrong tab.
    if (state.route !== "attendance") navigate("attendance");
    return openPastAttendanceSession(sessionId, { originRoute });
  }
  if (action === "open-quiz-questions") {
    if (!quizResults) return toast("Choose a quiz first", "error");
    return navigate("quizquestions");
  }
  if (action === "back-to-marks") {
    return goBack();
  }
  if (action === "open-past-quizzes") {
    quizResults = null;
    return navigate("quizmarks");
  }
  if (action === "open-quiz-results") {
    const quizId = event.target.closest("[data-quiz-id]")?.dataset.quizId || "";
    try {
      quizResults = await apiRequest(`/api/quizzes/${encodeURIComponent(quizId)}/results`);
    } catch (error) {
      quizResults = null;
      return toast(error.message || "Could not load those marks", "error");
    }
    return navigate("quizmarks");
  }
  if (action === "delete-quiz") {
    const course = selectedCourse();
    const quizId = event.target.closest("[data-quiz-id]")?.dataset.quizId || "";
    if (!course || !canPublishQuiz(course)) return toast("Course quiz permission required", "error");
    if (!window.confirm("Delete this quiz and every mark recorded for it? This cannot be undone.")) return;
    try {
      await apiRequest(`/api/quizzes/${encodeURIComponent(quizId)}`, { method: "DELETE" });
      quizResults = null;
      await refreshQuizHistory(course.id);
      await refreshQuizDrafts(course.id);
    } catch (error) {
      return toast(error.message || "Could not delete that quiz", "error");
    }
    navigate("quizzes");
    return toast("Quiz deleted");
  }
  if (action === "export-quiz-results") {
    if (!quizResults) return toast("Open a quiz first", "error");
    const { quiz, results } = quizResults;
    const stamp = (quiz.quizDate || quiz.publishedAt || new Date().toISOString()).slice(0, 10);
    const safeTitle = String(quiz.title || "quiz").replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40);
    downloadXlsx(
      `CampusPulse-${safeTitle}-${stamp}.xlsx`,
      ["Sl.No.", "Roll No", "Name", "Email", "Marks", "Out of", "Submitted", "Class", "Date"],
      results.map(item => [
        item.serial,
        item.rollNumber,
        item.name,
        item.email,
        item.attempted ? item.score : "",
        item.total,
        item.submittedAt ? new Date(item.submittedAt).toLocaleString() : "Not attempted",
        quiz.classLabel || quiz.day || "",
        formatQuizDate(quiz.quizDate || quiz.publishedAt)
      ])
    );
    return toast(`${results.length} rows exported`);
  }
  if (action === "open-draft-quiz") {
    const quizId = event.target.closest("[data-quiz-id]")?.dataset.quizId || "";
    if (!quizDrafts.some(item => item.id === quizId)) {
      return toast("That saved quiz is no longer available", "error");
    }
    editingDraftId = quizId;
    renderQuiz();
    return;
  }
  if (action === "close-draft-quiz") {
    editingDraftId = "";
    renderQuiz();
    return;
  }
  if (action === "save-quiz-draft") {
    const course = selectedCourse();
    if (!course || !canPublishQuiz(course)) return toast("Course quiz permission required", "error");
    if (!backendConfigured()) return toast("Connect CampusPulse to its API first", "error");
    const settings = quizSettingsPayload();
    if (!settings) return;
    const body = {
      courseId: course.id,
      status: "draft",
      ...settings,
      questions: readQuizBuilder()
    };
    try {
      const saved = editingDraftId
        ? await apiRequest(`/api/quizzes/${encodeURIComponent(editingDraftId)}`, {
            method: "PUT",
            body
          })
        : await apiRequest("/api/quizzes", { method: "POST", body });
      editingDraftId = saved.quiz?.id || editingDraftId;
      await refreshQuizDrafts(course.id);
    } catch (error) {
      return toast(error.message || "Could not save the quiz", "error");
    }
    renderQuiz();
    return toast(
      editingDraftId ? "Saved quiz updated" : "Quiz saved. Publish it when the class starts."
    );
  }
  if (action === "publish-draft-quiz") {
    const course = selectedCourse();
    const quizId = event.target.closest("[data-quiz-id]")?.dataset.quizId || "";
    if (!course || !canPublishQuiz(course)) return toast("Course quiz permission required", "error");
    try {
      const result = await apiRequest(`/api/quizzes/${encodeURIComponent(quizId)}/publish`, {
        method: "POST",
        body: {}
      });
      applyQuizSnapshot(result.quiz);
      editingDraftId = "";
      await refreshQuizDrafts(course.id);
    } catch (error) {
      return toast(error.message || "Could not publish that quiz", "error");
    }
    persist();
    renderLiveQuiz();
    return toast(`Quiz published to ${course.name}`);
  }
  if (action === "delete-draft-quiz") {
    const course = selectedCourse();
    const quizId = event.target.closest("[data-quiz-id]")?.dataset.quizId || "";
    if (!course || !canPublishQuiz(course)) return toast("Course quiz permission required", "error");
    if (!window.confirm("Delete this saved quiz?")) return;
    try {
      await apiRequest(`/api/quizzes/${encodeURIComponent(quizId)}`, { method: "DELETE" });
      if (editingDraftId === quizId) editingDraftId = "";
      await refreshQuizDrafts(course.id);
    } catch (error) {
      return toast(error.message || "Could not delete that quiz", "error");
    }
    renderQuiz();
    return toast("Saved quiz deleted");
  }
  if (action === "publish-quiz") {
    const course = selectedCourse();
    if (!course || !canPublishQuiz(course)) return toast("Course quiz permission required", "error");
    const settings = quizSettingsPayload();
    if (!settings) return;
    if (backendConfigured() && editingDraftId) {
      try {
        await apiRequest(`/api/quizzes/${encodeURIComponent(editingDraftId)}`, {
          method: "PUT",
          body: { ...settings, questions: readQuizBuilder() }
        });
        const result = await apiRequest(
          `/api/quizzes/${encodeURIComponent(editingDraftId)}/publish`,
          { method: "POST", body: {} }
        );
        applyQuizSnapshot(result.quiz);
        editingDraftId = "";
        await refreshQuizDrafts(course.id);
      } catch (error) {
        return toast(error.message || "Could not publish the quiz", "error");
      }
      state.quizPublished = true;
      persist();
      renderLiveQuiz();
      return toast(`Quiz published to ${course.name}`);
    }
    if (backendConfigured()) {
      const questions = readQuizBuilder();
      try {
        const result = await apiRequest("/api/quizzes", {
          method: "POST",
          body: { courseId: course.id, ...settings, questions }
        });
        applyQuizSnapshot(result.quiz);
      } catch (error) {
        return toast(error.message || "Could not publish the quiz", "error");
      }
    }
    state.quizPublished = true;
    state.quizResponses = 0;
    persist(); renderLiveQuiz(); toast(`Quiz published to ${course.name}`);
  }
  if (action === "end-quiz") {
    const course = selectedCourse();
    if (!course || !canPublishQuiz(course) || state.backendQuizCourseId !== course.id) return toast("Course quiz permission required", "error");
    if (backendConfigured() && state.backendQuizId) {
      try {
        await apiRequest(`/api/quizzes/${state.backendQuizId}/close`, {
          method: "POST",
          body: {}
        });
      } catch (error) {
        return toast(error.message || "Could not close the quiz", "error");
      }
    }
    clearTimeout(quizTimer);
    const finalResponses = state.quizResponses;
    state.quizPublished = false;
    state.backendQuizId = "";
    state.backendQuizCourseId = "";
    state.backendQuizTitle = "";
    state.backendQuizQuestions = [];
    state.quizResponses = 0;
    persist();
    await refreshQuizHistory(course.id);
    renderQuiz();
    toast(
      `Quiz ended with ${finalResponses} ${finalResponses === 1 ? "response" : "responses"}. Build the next one below.`
    );
  }
});

document.addEventListener("change", async event => {
  if (event.target.id === "examSelect") {
    const outOf = view.querySelector("#examOutOf");
    const stored = event.target.selectedOptions?.[0]?.dataset.maxMarks || "";
    if (outOf) outOf.value = stored;
    return;
  }
  if (event.target.id === "materialUploadFile") {
    const file = event.target.files?.[0];
    const course = state.courses.find(item => item.id === materialsCourseId);
    if (!file || !course || !canUploadMaterials(course)) return;
    if (!file.size) {
      event.target.value = "";
      return toast("That file is empty", "error");
    }
    if (file.size > 8 * 1024 * 1024) {
      event.target.value = "";
      return toast("Course materials must be 8 MB or smaller", "error");
    }
    try {
      await apiFileUpload(
        `/api/courses/${encodeURIComponent(course.id)}/materials`,
        file
      );
      const materials = await loadCourseMaterials(course.id, { force: true });
      state.courses = state.courses.map(item =>
        item.id === course.id ? { ...item, materialCount: materials.length } : item
      );
      persist();
      renderCourseMaterials(course.id);
      return toast(`${file.name} shared with the course`);
    } catch (error) {
      return toast(error.message || "Could not upload that material", "error");
    } finally {
      event.target.value = "";
    }
  }
  if (event.target.id === "quizResultsSelect") {
    const quizId = event.target.value;
    if (!quizId) {
      quizResults = null;
      navigate("quizzes");
      return;
    }
    try {
      quizResults = await apiRequest(`/api/quizzes/${encodeURIComponent(quizId)}/results`);
    } catch (error) {
      quizResults = null;
      return toast(error.message || "Could not load those marks", "error");
    }
    renderQuizMarks();
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  if (event.target.id === "quizClassSelect") {
    snapQuizDateToClassDay();
    return;
  }
  if (event.target.id === "quizDate") {
    snapQuizDateToClassDay({ announce: true });
    return;
  }
  if (event.target.id === "quizCourseSelect") {
    return switchCourseContext(event.target.value);
  }
  if (event.target.id === "attendanceCourseSelect") {
    return switchCourseContext(event.target.value);
  }
  if (event.target.id === "pastSessionSelect") {
    return openPastAttendanceSession(event.target.value);
  }
  if (event.target.classList?.contains("question-image-file")) {
    const file = event.target.files?.[0];
    const card = event.target.closest(".question-card");
    if (!file || !card) return;
    // Kept small so a quiz stays comfortably inside the request limit.
    if (file.size > 600 * 1024) {
      event.target.value = "";
      return toast("Use an image under 600 KB", "error");
    }
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("Could not read that image"));
        reader.readAsDataURL(file);
      });
      const holder = card.querySelector(".question-image");
      const picture = holder?.querySelector("img");
      if (picture) {
        picture.src = dataUrl;
        picture.dataset.image = dataUrl;
      }
      if (holder) holder.hidden = false;
      toast("Image attached to the question");
    } catch (error) {
      return toast(error.message || "Could not read that image", "error");
    } finally {
      event.target.value = "";
    }
    return;
  }
  if (event.target.id === "timetableFile") {
    const file = event.target.files?.[0];
    const course = selectedCourse();
    if (!file || !state.courses.some(canManageSchedule)) return;
    try {
      const classes = await readTimetableFile(file);
      const groups = groupClassesByCourse(classes, course);
      if (!groups.length) throw new Error("No classes were found in that timetable");
      const summary = groups
        .map(group => `  ${group.course.courseCode} — ${group.classes.length} class${group.classes.length === 1 ? "" : "es"}`)
        .join("\n");
      const affected = groups.map(group => group.course.courseCode).join(", ");
      if (!window.confirm(
        `Import ${classes.length} classes from ${file.name}?\n\n${summary}\n\n`
        + `This replaces the timetable for ${affected}.`
      )) return;
      for (const group of groups) {
        await saveCourseSchedule(group.course, group.classes, "", { silent: true });
      }
      renderSchedule();
      toast(
        groups.length > 1
          ? `${classes.length} classes imported across ${groups.length} courses`
          : `${classes.length} classes imported`
      );
    } catch (error) {
      return toast(error.message || "Could not read that timetable", "error");
    } finally {
      event.target.value = "";
    }
    return;
  }
  if (event.target.id === "examMarksFile") {
    const file = event.target.files?.[0];
    const request = pendingMarksUpload;
    pendingMarksUpload = null;
    if (!file || !request) return;
    try {
      const entries = await readMarksFile(file);
      if (!entries.length) {
        return toast("No roll numbers and marks were found in that file", "error");
      }
      const label = view.querySelector("#examSelect")?.selectedOptions?.[0]?.textContent || request.exam;
      const preview = entries
        .slice(0, 3)
        .map(entry => `  ${entry.rollNumber} — ${entry.score ?? "(blank)"}`)
        .join("\n");
      const confirmed = window.confirm(
        `Record ${entries.length} ${label} marks out of ${request.maxMarks} from ${file.name}?\n\n`
        + `First entries:\n${preview}\n\n`
        + "Students not in this file keep whatever mark they already have."
      );
      if (!confirmed) return;
      const result = await apiRequest(
        `/api/courses/${encodeURIComponent(request.courseId)}/marks/${encodeURIComponent(request.exam)}`,
        { method: "PUT", body: { maxMarks: request.maxMarks, entries } }
      );
      renderStudents();
      const ignored = result.ignoredCount
        ? `, ${result.ignoredCount} roll number${result.ignoredCount === 1 ? "" : "s"} not on the roster ignored`
        : "";
      return toast(`${result.saved} ${label} marks recorded${ignored}`);
    } catch (error) {
      return toast(error.message || "Could not read those marks", "error");
    } finally {
      event.target.value = "";
    }
  }
  if (event.target.id === "rosterUploadFile") {
    const file = event.target.files?.[0];
    const course = state.courses.find(item => item.id === managedCourseId);
    if (!file || !canManageRoster(course)) return;
    try {
      const students = await readRosterFile(file);
      // The PDF reader is heuristic, so show what was actually read before it
      // replaces the official roster.
      const preview = students
        .slice(0, 3)
        .map(student => {
          const details = [student.rollNumber, student.email, student.phone]
            .concat(Object.values(student.extra || {}))
            .filter(Boolean)
            .join(" · ");
          return `  ${student.name}${details ? ` — ${details}` : ""}`;
        })
        .join("\n");
      const confirmed = window.confirm(
        `Replace the official ${course.courseCode} roster with ${students.length} students read from ${file.name}?\n\n`
        + `First entries:\n${preview}\n\n`
        + "Check these look right. Existing attendance snapshots stay unchanged."
      );
      if (!confirmed) return;
      const result = await apiRequest(`/api/courses/${encodeURIComponent(course.id)}/roster`, {
        method: "PUT",
        body: { students }
      });
      courseRosters.set(course.id, result.students || []);
      state.courses = state.courses.map(item => item.id === course.id ? { ...item, ...result.course } : item);
      persist();
      renderCourseRoster(course.id);
      return toast(`${result.students.length} roster entries uploaded`);
    } catch (error) {
      return toast(error.message || "Could not upload that roster", "error");
    } finally {
      event.target.value = "";
    }
  }
  if (event.target.id !== "scheduleFile" || !event.target.files?.[0]) return;
  const file = event.target.files[0];
  try {
    const text = await file.text();
    const parsed = file.name.toLowerCase().endsWith(".ics") ? parseScheduleICS(text) : parseScheduleCSV(text);
    if (!parsed.length) throw new Error("No timetable entries found");
    const course = selectedCourse();
    const importedEntries = parsed.slice(0, 30).map(item => ({
      ...item,
      courseId: course?.id || "",
      courseCode: course?.courseCode || item.courseCode || "",
      courseName: course?.name || item.courseName || "",
    }));
    state.importedSchedule = [
      ...state.importedSchedule.filter(item => item.courseId !== course?.id),
      ...importedEntries,
    ];
    persist();
    await syncClassReminders();
    renderSchedule();
    toast(`${importedEntries.length} ${course?.courseCode || "course"} timetable entries imported`);
  } catch (error) {
    toast(error.message || "Could not read that timetable file");
  }
});

document.addEventListener("input", event => {
  // The roster-management screen filters its own rows in place.
  if (event.target.id === "rosterSearch") {
    const query = event.target.value.trim().toLowerCase();
    document.querySelectorAll("#professorRoster tbody tr").forEach(row => {
      row.hidden = Boolean(query) && !row.textContent.toLowerCase().includes(query);
    });
    return;
  }

  // These two re-render their list, which destroys the input being typed into,
  // so focus and caret position are restored afterwards.
  const searches = {
    attendanceSearch: value => {
      rosterSearch = value;
      renderLiveAttendance();
    },
    studentSearch: value => {
      studentSearch = value;
      renderStudents();
    }
  };
  const apply = searches[event.target.id];
  if (!apply) return;
  const { id, selectionStart } = event.target;
  apply(event.target.value);
  const restored = document.querySelector(`#${id}`);
  if (!restored) return;
  restored.focus({ preventScroll: true });
  try {
    restored.setSelectionRange(selectionStart, selectionStart);
  } catch {
    // A search input refuses setSelectionRange in some browsers; focus is enough.
  }
});

quickAction.addEventListener("click", openReminderModal);
courseSwitcherWrap?.addEventListener("click", async event => {
  const item = event.target.closest("[data-course-id]");
  if (item) {
    toggleCourseSwitcher(false);
    try {
      await switchCourseContext(item.dataset.courseId);
    } catch (error) {
      toast(error.message || "Could not switch courses", "error");
    } finally {
      syncCourseSwitcher();
    }
    return;
  }
  if (event.target.closest(".course-switcher-dropdown")) return;
  toggleCourseSwitcher();
});
document.addEventListener("click", event => {
  if (courseSwitcherWrap && !courseSwitcherWrap.contains(event.target)) {
    toggleCourseSwitcher(false);
  }
});

attendanceLiveBar?.addEventListener("click", async () => {
  const courseId = broadcastCourseId;
  if (!broadcastSessionId) return;
  try {
    // The register may belong to a course other than the one being browsed, so
    // the tab has to follow before the screen can show it.
    if (courseId && courseId !== state.selectedCourseId) {
      await switchCourseContext(courseId, { renderView: false, notify: false });
    }
    navigate("attendance");
  } catch (error) {
    toast(error?.message || "Could not open the register", "error");
  }
});

document.addEventListener("submit", async event => {
  event.preventDefault();
  if (event.target.id === "reminderForm") {
    const data = new FormData(event.target);
    try {
      const result = await reminderManager.enable({
        accountEmail: state.authEmail,
        events: reminderScheduleEntries(),
        leadMinutes: Number(data.get("leadMinutes")),
      });
      closeModal();
      let exactAlarm = result.exactAlarm;
      if (
        exactAlarm !== "granted" &&
        reminderManager.requestExactTiming &&
        window.confirm("For reminders at the exact selected minute, allow CampusPulse to use Alarms & reminders in Android settings?")
      ) {
        exactAlarm = await reminderManager.requestExactTiming();
        await syncClassReminders();
      }
      const timingNote = exactAlarm === "granted"
        ? ""
        : " Android may deliver them a few minutes around the selected time.";
      return toast(
        `${result.scheduled} weekly class ${result.scheduled === 1 ? "reminder" : "reminders"} enabled.${timingNote}`,
      );
    } catch (error) {
      return toast(error.message || "Could not enable class reminders", "error");
    }
  }
  if (event.target.id === "signupForm") {
    const data = Object.fromEntries(new FormData(event.target));
    const email = String(data.email || "").trim().toLowerCase();
    const name = String(data.name || "").trim().replace(/\s+/g, " ");
    const department = String(data.department || "").trim().replace(/\s+/g, " ");
    const profile = loginProfiles[data.role];
    if (!backendConfigured()) {
      return toast("Connect CampusPulse to its API before creating an account", "error");
    }
    if (!profile) return toast("Choose a valid account type", "error");
    if (name.length < 2) return toast("Enter your full name", "error");
    if (department.length < 2) return toast("Enter your department name", "error");
    if (!isEmailForRole(data.role, email)) return toast(profile.emailError, "error");
    if (String(data.password).length < 8) return toast("Password must contain at least 8 characters", "error");
    if (data.password !== data.confirmPassword) return toast("The passwords do not match", "error");
    try {
      await apiRequest("/api/auth/signup/request", {
        method: "POST",
        auth: false,
        body: {
          role: data.role,
          name,
          email,
          department: String(data.department || "").trim(),
          password: data.password,
          phone: String(data.phone || "").trim(),
          rollNumber: String(data.rollNumber || "").trim().toUpperCase() || undefined,
          hall: String(data.hall || "").trim() || undefined
        }
      });
      pendingSignup = { role: data.role, email, password: data.password };
      renderEmailVerification();
    } catch (error) {
      return toast(error.message || "Could not start the sign-up", "error");
    }
    return toast("Verification code sent to your email");
  }
  if (event.target.id === "verificationForm") {
    if (!pendingSignup) return renderLogin(selectedLoginRole, "signup");
    const code = String(new FormData(event.target).get("code") || "").trim();
    try {
      const verified = await apiRequest("/api/auth/signup/verify", {
        method: "POST",
        auth: false,
        body: { email: pendingSignup.email, code }
      });
      apiToken = verified.token || "";
      if (apiToken) localStorage.setItem("campusPulseApiToken", apiToken);
      state.userRole = verified.user.role;
      state.authenticated = true;
      state.accountName = verified.user.name;
      state.authEmail = verified.user.email;
      state.route = "dashboard";
      pendingSignup = null;
      await syncBackendState();
      setNavigationState("dashboard");
      showApp();
      return toast("Email verified. Welcome to CampusPulse");
    } catch (error) {
      return toast(error.message || "Could not verify that code", "error");
    }
  }
  if (event.target.id === "loginForm") {
    const data = Object.fromEntries(new FormData(event.target));
    const email = String(data.email || "").trim().toLowerCase();
    const profile = loginProfiles[data.role];
    if (!profile) return toast("Choose a valid account type", "error");
    if (backendConfigured()) {
      try {
        const loggedIn = await apiRequest("/api/auth/login", {
          method: "POST",
          auth: false,
          body: { email, password: data.password, role: data.role }
        });
        apiToken = loggedIn.token;
        localStorage.setItem("campusPulseApiToken", apiToken);
        state.userRole = loggedIn.user.role;
        state.authenticated = true;
        state.accountName = loggedIn.user.name;
        state.authEmail = loggedIn.user.email;
        state.route = "dashboard";
        await syncBackendState();
        setNavigationState("dashboard");
        showApp();
        return toast(`Signed in to the ${profile.shortTitle} workspace`);
      } catch (error) {
        return toast(error.message || "Could not sign in", "error");
      }
    }
    const account = state.accounts.find(item => item.email === email && item.role === data.role);
    if (!account) return toast(`No verified ${profile.shortTitle} account matches that email`, "error");
    const passwordHash = await credentialHash(email, data.password);
    if (passwordHash !== account.passwordHash) return toast("Incorrect email or password", "error");
    state.userRole = account.role;
    state.authenticated = true;
    state.accountName = account.name;
    state.authEmail = account.email;
    state.route = "dashboard";
    persist();
    setNavigationState("dashboard");
    showApp();
    return toast(`Signed in to the ${profile.shortTitle} workspace`);
  }
  if (event.target.id === "courseForm") {
    if (state.userRole !== "faculty") return toast("Only professors can create courses", "error");
    if (!backendConfigured()) return toast("Connect CampusPulse to its API first", "error");
    const data = Object.fromEntries(new FormData(event.target));
    const editingId = event.target.dataset.courseId || "";
    const body = {
      name: data.name,
      courseCode: data.courseCode,
      room: data.room
    };
    let result;
    try {
      result = editingId
        ? await apiRequest(`/api/courses/${encodeURIComponent(editingId)}`, {
            method: "PATCH",
            body
          })
        : await apiRequest("/api/courses", { method: "POST", body });
      await syncBackendState();
      await switchCourseContext(result.course.id, {
        renderView: false,
        notify: false,
        updateHistory: true,
      });
    } catch (error) {
      return toast(
        error.message || (editingId ? "Could not update the course" : "Could not create the course"),
        "error"
      );
    }
    persist();
    closeModal();
    renderClasses();
    syncCourseSwitcher();
    toast(
      editingId
        ? `${result.course.name} updated · Student and TA codes unchanged`
        : `${result.course.name} created · Student ${result.course.studentCode || result.course.code} · TA ${result.course.taCode}`
    );
  }
  if (event.target.id === "addClassForm") {
    const course = selectedCourse();
    if (!course || !canManageSchedule(course)) {
      return toast("Course-team timetable access required", "error");
    }
    const data = new FormData(event.target);
    const existing = state.backendSchedule
      .filter(item => item.courseId === course.id)
      .map(({ id, day, start, end, topic, room, subtopics }) => ({
        id,
        day,
        start,
        end,
        topic,
        room,
        subtopics: Array.isArray(subtopics) ? subtopics : [],
      }));
    existing.push({
      day: String(data.get("day") || ""),
      start: String(data.get("start") || "").trim(),
      end: String(data.get("end") || "").trim(),
      topic: String(data.get("topic") || "").trim() || course.courseCode,
      room: String(data.get("room") || "").trim() || course.room || "",
      subtopics: String(data.get("subtopics") || "")
        .split(/\r?\n/)
        .map(item => item.trim())
        .filter(Boolean),
    });
    return saveCourseSchedule(course, existing, "Class added to the timetable");
  }
  if (event.target.id === "editClassTopicsForm") {
    const course = selectedCourse();
    const index = editingScheduleIndex;
    if (!course || !canManageSchedule(course) || index < 0) {
      return toast("Course-team topic access required", "error");
    }
    const data = new FormData(event.target);
    const entries = state.backendSchedule
      .filter(item => item.courseId === course.id)
      .map(({ id, day, start, end, topic, room, subtopics }) => ({
        id,
        day,
        start,
        end,
        topic,
        room,
        subtopics: Array.isArray(subtopics) ? subtopics : [],
      }));
    if (!entries[index]) return toast("That class no longer exists", "error");
    entries[index] = {
      ...entries[index],
      topic: String(data.get("topic") || "").trim() || course.name,
      subtopics: String(data.get("subtopics") || "")
        .split(/\r?\n/)
        .map(item => item.trim())
        .filter(Boolean),
    };
    closeModal();
    return saveCourseSchedule(course, entries, "Class topics updated");
  }
  if (event.target.id === "addStudentForm") {
    const course = state.courses.find(item => item.id === managedCourseId);
    if (!course || !canManageRoster(course)) {
      return toast("Course-team roster access required", "error");
    }
    const data = new FormData(event.target);
    try {
      const result = await apiRequest(`/api/courses/${encodeURIComponent(course.id)}/roster`, {
        method: "POST",
        body: {
          rollNumber: String(data.get("rollNumber") || "").trim().toUpperCase(),
          name: String(data.get("name") || "").trim(),
          email: String(data.get("email") || "").trim(),
          phone: String(data.get("phone") || "").trim()
        }
      });
      courseRosters.set(course.id, result.students || []);
      state.courses = state.courses.map(item => item.id === course.id ? { ...item, ...result.course } : item);
      persist();
      renderCourseRoster(course.id);
      return toast("Student added to the roll list");
    } catch (error) {
      return toast(error.message || "Could not add that student", "error");
    }
  }
  if (event.target.id === "noticeForm") {
    const course = selectedCourse();
    if (!course || !canRunAttendance(course)) {
      return toast("Only the course team can post notices", "error");
    }
    const data = new FormData(event.target);
    try {
      await apiRequest(`/api/courses/${encodeURIComponent(course.id)}/notices`, {
        method: "POST",
        body: {
          title: String(data.get("title") || "").trim(),
          body: String(data.get("body") || "").trim()
        }
      });
      await refreshNotices(course.id);
    } catch (error) {
      return toast(error.message || "Could not post that notice", "error");
    }
    renderNotices();
    return toast("Notice posted");
  }
  if (event.target.id === "changePasswordForm") {
    const data = new FormData(event.target);
    const newPassword = String(data.get("newPassword") || "");
    if (newPassword !== String(data.get("confirmNewPassword") || "")) {
      return toast("The new passwords do not match", "error");
    }
    try {
      await apiRequest("/api/auth/password", {
        method: "POST",
        body: { currentPassword: String(data.get("currentPassword") || ""), newPassword }
      });
    } catch (error) {
      return toast(error.message || "Could not update the password", "error");
    }
    event.target.reset();
    return toast("Password updated. Other devices were signed out");
  }
  if (event.target.id === "forgotPasswordForm") {
    const email = String(new FormData(event.target).get("email") || "").trim().toLowerCase();
    try {
      await apiRequest("/api/auth/password/forgot", {
        method: "POST",
        auth: false,
        body: { email }
      });
    } catch (error) {
      return toast(error.message || "Could not send a reset code", "error");
    }
    passwordResetEmail = email;
    renderLogin(selectedLoginRole, "reset");
    return toast("If that address is registered, a reset code is on its way");
  }
  if (event.target.id === "resetPasswordForm") {
    const data = new FormData(event.target);
    const email = String(data.get("email") || "").trim().toLowerCase();
    const newPassword = String(data.get("newPassword") || "");
    if (newPassword !== String(data.get("confirmNewPassword") || "")) {
      return toast("The new passwords do not match", "error");
    }
    try {
      await apiRequest("/api/auth/password/reset", {
        method: "POST",
        auth: false,
        body: { email, code: String(data.get("code") || ""), newPassword }
      });
    } catch (error) {
      return toast(error.message || "Could not reset the password", "error");
    }
    passwordResetEmail = "";
    renderLogin(selectedLoginRole, "login");
    return toast("Password reset. Sign in with your new password");
  }
  if (event.target.id === "joinForm") {
    const data = new FormData(event.target);
    const code = String(data.get("joinCode") || "").trim().toUpperCase();
    if (!backendConfigured()) return toast("Connect CampusPulse to its API first", "error");
    try {
      const result = await apiRequest("/api/courses/join", {
        method: "POST",
        body: { code }
      });
      await syncBackendState();
      await switchCourseContext(result.course.id, {
        renderView: false,
        notify: false,
        updateHistory: true,
      });
      persist();
      renderClasses();
      return toast(`You joined ${result.course.name}`);
    } catch (error) {
      return toast(error.message || "Could not join that course", "error");
    }
  }
  if (event.target.id === "studentQuizForm") {
    const questions = state.backendQuizQuestions.length
      ? state.backendQuizQuestions
      : [{}, {}];
    const data = new FormData(event.target);
    const answers = questions.map((_, index) => Number(data.get(`student-q-${index}`)));
    if (backendConfigured() && state.backendQuizId) {
      try {
        const result = await apiRequest(`/api/quizzes/${state.backendQuizId}/respond`, {
          method: "POST",
          body: { answers }
        });
        state.quizResponded = true;
        persist();
        renderStudentQuizAccess();
        return toast(`Quiz submitted · Score ${result.score}/${result.total}`);
      } catch (error) {
        return toast(error.message || "Could not submit the quiz", "error");
      }
    }
    state.quizResponded = true;
    persist();
    renderStudentQuizAccess();
    toast("Quiz response saved on this device");
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    syncClassReminders().catch(() => {});
    if (state.authenticated) refreshOpenAttendance().catch(() => {});
    if (state.authenticated) pushManager?.refresh?.({ silent: true }).catch(() => {});
    // The phone was asleep or on another app; the broadcast token is stale.
    if (state.authenticated) resumeAttendanceBroadcast().catch(() => {});
  }
});

// Reloads everything the current screen is showing, and asks for a newer web
// bundle at the same time. A phone user's instinct after something looks stale
// is to pull down, so that gesture has to do both.
async function refreshEverything() {
  if (!backendConfigured() || !apiToken) {
    render();
    return;
  }
  await syncBackendState();
  const courseId = state.selectedCourseId;
  const course = selectedCourse();
  const refreshes = [refreshOpenAttendance({ rerender: false })];
  if (courseId) {
    refreshes.push(refreshNotices(courseId));
    if (course && canRunAttendance(course)) {
      refreshes.push(selectAttendanceCourse(courseId), refreshPastSessions(courseId));
    }
    if (state.userRole === "student") {
      refreshes.push(refreshAttendanceHistory(courseId), refreshMyQuizzes(courseId));
    }
    if (course && canPublishQuiz(course)) {
      refreshes.push(refreshQuizHistory(courseId), refreshQuizDrafts(courseId));
    }
    if (state.route === "materials") {
      refreshes.push(loadCourseMaterials(courseId, { force: true }));
    }
  }
  // One failed panel must not blank the rest of the screen.
  await Promise.allSettled(refreshes);
  persist();
  render();
  // A pull is also the moment to look for a newer app bundle.
  window.CAMPUSPULSE_UPDATES?.checkForUpdate?.({ manual: true })?.catch?.(() => {});
}

// Pull-to-refresh. The page scrolls on the document, so a pull only counts when
// the document is already at the top and the finger started somewhere that is
// not itself a scrolled-down list.
(() => {
  const TRIGGER_PX = 72;
  const MAX_PULL_PX = 130;
  const indicator = document.createElement("div");
  indicator.className = "pull-refresh";
  indicator.innerHTML = `<div class="pull-refresh-spinner"></div>`;
  indicator.setAttribute("aria-hidden", "true");
  document.body.append(indicator);

  let startY = 0;
  let pull = 0;
  let tracking = false;
  let refreshing = false;

  function scrolledToTop() {
    return (window.scrollY || document.documentElement.scrollTop || 0) <= 0;
  }

  // A finger inside a list that is scrolled down is scrolling that list.
  function insideScrolledRegion(target) {
    for (let node = target; node && node !== document.body; node = node.parentElement) {
      if (node.scrollTop > 0 && node.scrollHeight > node.clientHeight) return true;
    }
    return false;
  }

  function setPull(distance) {
    pull = distance;
    indicator.style.transform = `translate(-50%, ${Math.min(distance, MAX_PULL_PX)}px)`;
    indicator.style.opacity = String(Math.min(distance / TRIGGER_PX, 1));
    indicator.classList.toggle("ready", distance >= TRIGGER_PX);
  }

  function reset() {
    tracking = false;
    setPull(0);
    indicator.classList.remove("active", "ready");
    indicator.style.transform = "";
    indicator.style.opacity = "";
  }

  document.addEventListener(
    "touchstart",
    (event) => {
      if (refreshing || event.touches.length !== 1) return;
      if (appShell?.hidden || !state.authenticated) return;
      if (!scrolledToTop() || insideScrolledRegion(event.target)) return;
      startY = event.touches[0].clientY;
      tracking = true;
    },
    { passive: true }
  );

  document.addEventListener(
    "touchmove",
    (event) => {
      if (!tracking || refreshing) return;
      const distance = event.touches[0].clientY - startY;
      if (distance <= 0 || !scrolledToTop()) {
        if (pull) reset();
        return;
      }
      // Rubber band, so the pull slows as it lengthens.
      setPull(Math.min(distance * 0.5, MAX_PULL_PX));
      indicator.classList.add("active");
      // Stops the browser's own overscroll fighting the gesture.
      if (event.cancelable) event.preventDefault();
    },
    { passive: false }
  );

  async function finish() {
    if (!tracking || refreshing) return reset();
    const shouldRefresh = pull >= TRIGGER_PX;
    if (!shouldRefresh) return reset();

    refreshing = true;
    tracking = false;
    indicator.classList.add("active", "refreshing");
    setPull(TRIGGER_PX);
    try {
      await refreshEverything();
    } catch (error) {
      toast(error?.message || "Could not refresh. Try again.", "error");
    } finally {
      refreshing = false;
      indicator.classList.remove("refreshing");
      reset();
    }
  }

  document.addEventListener("touchend", finish, { passive: true });
  document.addEventListener("touchcancel", reset, { passive: true });
})();

async function bootstrapApp() {
  if (!backendConfigured() || !apiToken) {
    if (state.authenticated) startNavigationHistory();
    render();
    return;
  }
  // Paint before the first request, never after it.
  renderBootSplash();
  try {
    const restored = await restoreBackendSession();
    if (!restored) render();
  } catch (error) {
    // Reaching here means the token was never rejected — only the network
    // failed — so the session is kept and the student is offered a retry.
    renderSessionRetry(error);
  }
}

persist();
bootstrapApp();
refreshEmailDeliveryState();
