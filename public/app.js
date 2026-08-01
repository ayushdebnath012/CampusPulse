const APP_VERSION = "1.2.0";
const API_BASE = String(window.CAMPUSPULSE_CONFIG?.apiBase || "").replace(/\/+$/, "");
let apiToken = localStorage.getItem("campusPulseApiToken") || "";

async function apiRequest(path, options = {}) {
  if (!API_BASE) {
    const error = new Error("Backend API is not configured");
    error.code = "API_NOT_CONFIGURED";
    throw error;
  }
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.auth !== false && apiToken) headers.Authorization = `Bearer ${apiToken}`;
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  if (response.status === 204) return null;
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    const error = new Error(payload?.error || `Backend request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
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
  backendQuizQuestions: [],
  quizResponded: false,
  attendanceStatus: "not_started",
  checks: { wifi: false, bluetooth: false },
  quizPublished: false,
  quizResponses: 0,
  courses: [],
  enrolledCourses: [],
  selectedCourseId: "",
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
state.selectedCourseId = "";
delete state.present;
state.importedSchedule = Array.isArray(state.importedSchedule) ? state.importedSchedule : [];
state.backendSchedule = Array.isArray(state.backendSchedule) ? state.backendSchedule : [];
state.backendQuizQuestions = Array.isArray(state.backendQuizQuestions) ? state.backendQuizQuestions : [];
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
// in so the card appears as soon as the professor starts attendance.
let openAttendance = [];
let openAttendanceTimer = null;
let enrolledStudents = [];
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
      if (!state.authenticated) renderLogin(selectedLoginRole, authMode);
    }
  } catch {
    // Sign-in must still work when the health probe cannot be reached.
  }
}
let courseRosters = new Map();
let managedCourseId = "";
let courseMaterials = new Map();
let materialsCourseId = "";
let modalReturnFocus = null;
let selectedLoginRole = state.userRole || "faculty";
let authMode = state.accounts.length ? "login" : "signup";
const view = document.querySelector("#view");
const authRoot = document.querySelector("#authRoot");
const appShell = document.querySelector("#appShell");
const pageTitle = document.querySelector("#pageTitle");
const pageEyebrow = document.querySelector("#pageEyebrow");
const quickAction = document.querySelector("#quickAction");
const attendanceNav = document.querySelector("#attendanceNav");
const profileAvatar = document.querySelector("#profileAvatar");
const profileName = document.querySelector("#profileName");
const profileMeta = document.querySelector("#profileMeta");
const updateBanner = document.querySelector("#updateBanner");
const updateBannerMessage = document.querySelector("#updateBannerMessage");
const updateManager = window.CAMPUSPULSE_UPDATES || null;
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
}

async function selectAttendanceCourse(courseId) {
  const course = state.courses.find(item => item.id === courseId);
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
}

function applyQuizSnapshot(quiz) {
  state.backendQuizId = quiz?.id || "";
  state.backendQuizCourseId = quiz?.courseId || "";
  state.backendQuizTitle = quiz?.title || "";
  state.backendQuizQuestions = quiz?.questions || [];
  state.quizPublished = quiz?.status === "open";
  state.quizResponses = Array.isArray(quiz?.responses) ? quiz.responses.length : 0;
  state.quizResponded = Boolean(quiz?.responded);
}

async function selectQuizCourse(courseId) {
  const course = state.courses.find(item => item.id === courseId);
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
  openAttendance = [];
  enrolledStudents = [];
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
  state.backendQuizQuestions = [];
  state.quizPublished = false;
  state.quizResponded = false;
  state.courses = defaultState.courses;
  state.enrolledCourses = [];
  state.backendSchedule = [];
  if (clearImportedSchedule) state.importedSchedule = [];
  if (view) view.innerHTML = "";
}

function persist() {
  state.appVersion = APP_VERSION;
  localStorage.setItem("campusPulseState", JSON.stringify(state));
}

const loginProfiles = {
  faculty: {
    title: "Professor login",
    shortTitle: "Professor",
    description: "Create and manage your exclusive courses, rosters, attendance, and quizzes.",
    idLabel: "Verified faculty email",
    placeholder: "professor@iitkgp.ac.in",
    initials: "PF",
    name: "Professor Demo"
  },
  ta: {
    title: "Teaching Assistant login",
    shortTitle: "TA",
    description: "Join assigned courses by code, manage rosters and materials, run attendance, and publish quizzes.",
    idLabel: "Verified TA email",
    placeholder: "ta@iitkgp.ac.in",
    initials: "TA",
    name: "Teaching Assistant"
  },
  student: {
    title: "Student login",
    shortTitle: "Student",
    description: "Join professor-owned courses by code, mark your attendance when class starts, take quizzes, and view your calendar.",
    idLabel: "Verified institute email",
    placeholder: "student@kgpian.iitkgp.ac.in",
    initials: "ST",
    name: "Student Demo"
  }
};

function renderLogin(role = selectedLoginRole, mode = authMode) {
  courseRosters = new Map();
  courseMaterials = new Map();
  activeAttendance = null;
  managedCourseId = "";
  materialsCourseId = "";
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
            <label for="signupEmail">IIT KGP email</label>
            <input id="signupEmail" name="email" type="email" placeholder="${profile.placeholder}" autocomplete="email" required />
            <div class="auth-field-pair">
              <div><label for="signupPassword">Password</label><input id="signupPassword" name="password" type="password" placeholder="At least 8 characters" autocomplete="new-password" minlength="8" required /></div>
              <div><label for="signupConfirm">Confirm password</label><input id="signupConfirm" name="confirmPassword" type="password" placeholder="Repeat password" autocomplete="new-password" minlength="8" required /></div>
            </div>
            <label for="signupPhone">Contact number</label>
            <input id="signupPhone" name="phone" type="tel" placeholder="10-digit mobile number" autocomplete="tel" required />
            ${selectedLoginRole === "faculty" ? "" : `
            <div class="auth-field-pair">
              <div><label for="signupRoll">Roll number</label><input id="signupRoll" name="rollNumber" type="text" placeholder="e.g. 23ME10001" autocomplete="off" maxlength="40" required /></div>
              <div><label for="signupHall">Hall of residence</label><input id="signupHall" name="hall" type="text" placeholder="e.g. Azad Hall" autocomplete="off" maxlength="80" required /></div>
            </div>`}
            ${selectedLoginRole === "ta" ? `<label for="taInviteCode">TA invitation code</label><input id="taInviteCode" name="roleCode" type="password" placeholder="Provided by the course administrator" autocomplete="off" required />` : ""}
            <button class="btn btn-primary auth-submit" type="submit">${icon("i-arrow")} Create account & sign in</button>
          </form>
          <div class="auth-demo-note"><span>Institutional email required</span><p>Use an address ending in iitkgp.ac.in. No email OTP is required.</p></div>` : `
          ${authMode === "forgot" ? `
          <form id="forgotPasswordForm" class="login-form">
            <label for="forgotEmail">Registered email</label>
            <input id="forgotEmail" name="email" type="email" placeholder="${profile.placeholder}" autocomplete="username" required />
            <button class="btn btn-primary auth-submit" type="submit">${icon("i-send")} Email me a reset code</button>
          </form>
          <div class="verification-actions"><button type="button" class="text-btn" data-auth-mode="login">Back to sign in</button><button type="button" class="text-btn" data-auth-mode="reset">I already have a code</button></div>
          <div class="auth-demo-note"><span>Registered address only</span><p>The code goes to the email your account was created with. Nothing is shown on this page.</p></div>` : authMode === "reset" ? `
          <form id="resetPasswordForm" class="login-form">
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
            <label for="loginPassword">Password</label>
            <input id="loginPassword" name="password" type="password" placeholder="Enter your password" autocomplete="current-password" minlength="8" required />
            <button class="btn btn-primary auth-submit" type="submit">${icon("i-arrow")} Sign in as ${profile.shortTitle}</button>
          </form>
          ${emailDeliveryAvailable ? `<div class="verification-actions"><span></span><button type="button" class="text-btn" data-auth-mode="forgot">Forgot password?</button></div>` : ""}
          <div class="auth-demo-note"><span>Secure password sign-in</span><p>Use the email, password, and account role selected during sign-up.${emailDeliveryAvailable ? "" : " Password reset by email is switched off, so ask your professor if you are locked out."}</p></div>`}`}
          <p class="auth-description" style="margin-top:18px"><a href="privacy.html" target="_blank" rel="noopener">Privacy policy</a> · <a href="delete-account.html" target="_blank" rel="noopener">Delete an account</a></p>
        </div>
      </section>
    </div>`;
  const firstField = { signup: "#signupName", forgot: "#forgotEmail", reset: "#resetCode" }[authMode] || "#loginEmail";
  setTimeout(() => document.querySelector(firstField)?.focus(), 0);
}

function isCampusEmail(email = "") {
  const domain = email.trim().toLowerCase().split("@")[1] || "";
  return domain === "iitkgp.ac.in" || domain.endsWith(".iitkgp.ac.in");
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
  authRoot.hidden = true;
  authRoot.innerHTML = "";
  appShell.hidden = false;
  setNavigationState(state.route);
  render();
}

function canSelfMarkAttendance() {
  return state.userRole === "student" || state.userRole === "ta";
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
    if (changed && rerender && state.route === "dashboard") render();
  } catch {
    // A failed poll must never disrupt the screen the student is using.
  }
}

function startOpenAttendancePolling() {
  clearInterval(openAttendanceTimer);
  if (!canSelfMarkAttendance()) return;
  openAttendanceTimer = setInterval(() => refreshOpenAttendance(), 15000);
}

async function syncBackendState() {
  if (!backendConfigured() || !apiToken) return;
  const payload = await apiRequest("/api/bootstrap");
  state.userRole = payload.user.role;
  state.accountName = payload.user.name;
  state.authEmail = payload.user.email;
  state.courses = Array.isArray(payload.courses)
    ? payload.courses.map((course) => ({ ...course, code: course.code || "" }))
    : [];
  if (!state.courses.some(course => course.id === state.selectedCourseId)) {
    state.selectedCourseId = state.courses[0]?.id || "";
  }
  state.enrolledCourses = payload.enrolledCourseIds || [];
  state.backendSchedule = payload.schedule || [];
  courseRosters = new Map();
  courseMaterials = new Map();
  applyAttendanceSnapshot(null);
  state.attendanceCheckedIn = false;
  applyQuizSnapshot(payload.quiz);
  persist();
  await refreshOpenAttendance({ rerender: false });
  await refreshEnrolledStudents();
  startOpenAttendancePolling();
}

async function restoreBackendSession() {
  if (!backendConfigured() || !apiToken) return false;
  try {
    const payload = await apiRequest("/api/me");
    state.userRole = payload.user.role;
    state.accountName = payload.user.name;
    state.authEmail = payload.user.email;
    state.authenticated = true;
    await syncBackendState();
    showApp();
    return true;
  } catch {
    apiToken = "";
    localStorage.removeItem("campusPulseApiToken");
    clearSensitiveClientState({ clearImportedSchedule: true });
    state.authenticated = false;
    state.accountName = "";
    state.authEmail = "";
    persist();
    return false;
  }
}

function toast(message, type = "success") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  document.querySelector("#toastRegion").append(el);
  setTimeout(() => el.remove(), 3200);
}

function setHeader(title, eyebrow, showQuick = true) {
  pageTitle.textContent = title;
  pageEyebrow.textContent = eyebrow;
  const attendanceCourse = selectedCourse() || state.courses.find(canRunAttendance);
  quickAction.style.display = showQuick && canRunAttendance(attendanceCourse) ? "" : "none";
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
  const studentsNav = document.querySelector("#studentsNav");
  if (studentsNav) studentsNav.style.display = state.userRole === "student" ? "none" : "";
  if (attendanceNav) {
    attendanceNav.style.display = state.courses.some(canRunAttendance) ? "" : "none";
  }
}

function setNavigationState(route) {
  document.querySelectorAll(".nav-item").forEach(btn => {
    const active = btn.dataset.route === route;
    btn.classList.toggle("active", active);
    if (active) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });
}

function navigate(route) {
  clearInterval(scanTimer);
  clearTimeout(quizTimer);
  if (route === "students") managedCourseId = "";
  if (route === "materials") materialsCourseId = "";
  state.route = route;
  setNavigationState(route);
  render();
  persist();
  window.scrollTo({ top: 0, behavior: "smooth" });
  pageTitle.focus({ preventScroll: true });
  updateManager?.applyStagedUpdate?.();
  if (route === "dashboard") refreshOpenAttendance();
  if (route === "students") refreshEnrolledStudents().then(() => { if (state.route === "students") renderStudents(); });
}

function render() {
  if (!state.authenticated) return renderLogin(state.userRole);
  if (state.route === "dashboard") return renderDashboard();
  if (state.route === "schedule") return renderSchedule();
  if (state.route === "attendance") return renderAttendance();
  if (state.route === "quizzes") return renderQuiz();
  if (state.route === "students") return renderStudents();
  if (state.route === "materials") return renderMaterials();
  return renderPlaceholder(state.route);
}

function renderDashboard() {
  if (state.userRole === "student") return renderStudentDashboard();
  const course = selectedCourse() || state.courses[0];
  if (!course) {
    setHeader(`Good morning, ${roleDisplayName()}`, state.userRole === "faculty" ? "PROFESSOR WORKSPACE" : "TA WORKSPACE", false);
    view.innerHTML = `<article class="card empty-state"><div><span class="empty-icon">${icon("i-users")}</span><h2>${state.userRole === "faculty" ? "Create your first course" : "Join your assigned course"}</h2><p>${state.userRole === "faculty" ? "Courses are private to their professor owner. Create a course, then share its join code with students and teaching assistants." : "Enter the private course code shared by the professor before accessing attendance or quizzes."}</p><button class="btn btn-primary" ${state.userRole === "faculty" ? 'data-action="open-course-modal"' : 'data-route-link="classes"'}>${icon("i-plus")} ${state.userRole === "faculty" ? "Create course" : "Enter course code"}</button></div></article>`;
    return;
  }
  const attendanceMatchesCourse = activeAttendance?.courseId === course.id;
  const courseAttendanceStatus = attendanceMatchesCourse ? state.attendanceStatus : "not_started";
  const coursePresentCount = attendanceMatchesCourse ? currentPresentCount() : 0;
  setHeader(`Good morning, ${roleDisplayName()}`, todayLabel());
  const attendanceLabel = courseAttendanceStatus === "complete" ? "Attendance recorded" : courseAttendanceStatus === "scanning" ? "Attendance in progress" : "Ready to begin";
  const stats = workspaceStats();
  const todaysClasses = scheduleForToday(course);
  const statusClass = courseAttendanceStatus === "complete" ? "green" : "amber";
  view.innerHTML = `
    <div class="dashboard-grid">
      <div class="left-stack">
        <article class="hero-session">
          <div class="hero-copy">
            <span class="live-tag">YOUR COURSE</span>
            <h2>${escapeHtml(course.name)}</h2>
            <p>${escapeHtml(course.courseCode)} · ${escapeHtml(course.section)}</p>
            <div class="hero-meta">
              <span>${icon("i-clock")} ${escapeHtml(courseTimeLabel(course))}</span>
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
            <div class="stat-value">${stats.quizzes}</div><div class="stat-label">Quick quizzes</div>
          </article>
        </div>

        <article class="card card-pad">
          <div class="section-head"><h2>Today’s classes</h2><button class="text-btn" data-route-link="classes">View schedule</button></div>
          <div class="class-list">
            ${todaysClasses.length
              ? todaysClasses.map(item => classRow(item.start || "—", item.end || "", item.topic || course.name, `${course.courseCode} · ${course.section} · ${item.room || course.room}`, attendanceLabel, statusClass, canRunAttendance(course) ? "attendance" : "", course.id)).join("")
              : `<p class="stat-label" style="padding:6px 2px">No classes scheduled yet. Import a timetable from the Schedule page.</p>`}
          </div>
        </article>
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
  return {
    courses: 0,
    rosteredStudents: 0,
    classesCompleted: 0,
    averageAttendance: 0,
    quizzes: 0,
    ...(state.stats || {})
  };
}

function scheduleForToday(course) {
  const today = new Date().toLocaleDateString("en-US", { weekday: "long" });
  return state.backendSchedule.filter(
    item => item.courseId === course.id && String(item.day || "") === today
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

function attendanceCallCard(session) {
  const course = state.courses.find(item => item.id === session.courseId);
  const courseName = course ? course.name : "Your course";
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
  return `<article class="card page-card attendance-call">
    <div class="section-head"><h3>${escapeHtml(courseName)}</h3><span class="badge amber">Attendance open</span></div>
    <p class="attendance-call-copy">Your professor started attendance${startedAt ? ` at ${escapeHtml(startedAt)}` : ""}. Wi‑Fi and Bluetooth must both be on.</p>
    ${session.rollNumber
      ? `<p class="attendance-call-roll">Roll number <strong>${escapeHtml(session.rollNumber)}</strong></p>`
      : `<label class="attendance-call-label" for="rollNumber-${escapeHtml(session.id)}">Your roll number</label>
         <input class="text-input" id="rollNumber-${escapeHtml(session.id)}" data-roll-for="${escapeHtml(session.id)}" type="text" placeholder="e.g. 21ME10001" autocomplete="off" />`}
    <button class="btn btn-primary attendance-call-submit" type="button" data-action="student-check-in" data-session-id="${escapeHtml(session.id)}">${icon("i-check")} Mark me present</button>
  </article>`;
}

function renderStudentDashboard() {
  setHeader(`Good morning, ${roleDisplayName()}`, "STUDENT DASHBOARD", false);
  const enrolled = state.courses.filter(course => state.enrolledCourses.includes(course.id));
  view.innerHTML = `
    <div class="left-stack">
      ${openAttendance.length ? `<div class="attendance-call-stack">${openAttendance.map(attendanceCallCard).join("")}</div>` : ""}
      <section class="student-welcome">
        <h2>${enrolled.length ? "Your classroom is ready" : "Join your first course"}</h2>
        <p>${enrolled.length ? "Access your schedule, quick quizzes, and class updates. Mark yourself present when your professor opens attendance." : "Enter the private course code shared by your faculty. Course content is available only after enrollment."}</p>
        <button class="btn" data-route-link="${enrolled.length ? "schedule" : "classes"}">${icon(enrolled.length ? "i-calendar" : "i-plus")} ${enrolled.length ? "View my schedule" : "Join a course"}</button>
      </section>
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
  const imported = isStudent && state.importedSchedule.length > 0;
  const calendarDays = [
    ["MON", "3"], ["TUE", "4"], ["WED", "5"], ["THU", "6"], ["FRI", "7"], ["SAT", "8"], ["SUN", "9"]
  ];
  const courseSchedule = state.backendSchedule.filter(item => item.courseId === course.id);
  const defaultEvents = (courseSchedule.length ? courseSchedule : [
    { day: "Monday", date: "3 Aug", start: "3:00 PM", end: "5:00 PM", topic: course.name, room: course.room, status: "Upcoming" }
  ]).map((item, index) => ({
    ...item,
    dayIndex: dayIndexFromName(item.day),
    status: item.status || (index === 0 ? "Next" : "Upcoming")
  }));
  const importedEvents = state.importedSchedule.map((item, index) => ({
    ...item,
    dayIndex: dayIndexFromName(item.day),
    status: index === 0 ? "Next" : "Upcoming",
    today: index === 0
  })).filter(item => item.dayIndex >= 0);
  const backendEvents = state.backendSchedule.map((item, index) => ({
    ...item,
    dayIndex: dayIndexFromName(item.day),
    status: item.today ? "Today" : index === 0 ? "Completed" : "Upcoming",
    today: Boolean(item.today)
  })).filter(item => item.dayIndex >= 0);
  const hasBackendSchedule = backendEvents.length > 0;
  const events = imported && importedEvents.length
    ? importedEvents
    : hasBackendSchedule
      ? backendEvents
      : defaultEvents;
  const scheduleLabel = imported
    ? "My imported timetable"
    : hasBackendSchedule
      ? "Campus schedule"
      : "3–9 August 2026";
  const scheduleBadge = imported
    ? "Timetable file imported"
    : hasBackendSchedule
      ? "Synced from CampusPulse"
      : `${state.userRole === "faculty" ? "Professor" : state.userRole === "ta" ? "Teaching Assistant" : "Student"} view`;
  const roleName = state.userRole === "faculty" ? "Professor" : state.userRole === "ta" ? "Teaching Assistant" : "Student";
  setHeader("Schedule calendar", `${roleName.toUpperCase()} TIMETABLE`, false);
  view.innerHTML = `
    <article class="card page-card calendar-page">
      <div class="calendar-titlebar">
        <div><span class="calendar-kicker">${icon("i-calendar")} WEEK CALENDAR</span><h2>${scheduleLabel}</h2><p>${imported ? "Imported locally from your timetable file" : `${escapeHtml(course.name)} · ${escapeHtml(course.courseCode)} · ${escapeHtml(course.section)}`}</p></div>
        <div class="calendar-title-actions"><span class="badge ${imported ? "green" : "purple"}">${scheduleBadge}</span><button class="btn btn-soft" data-action="calendar-today">Today</button></div>
      </div>
      <div class="calendar-scroll" aria-label="Weekly class calendar">
        <div class="calendar-board">
          <div class="calendar-days"><span class="calendar-zone">IST</span>${calendarDays.map(([day, date], index) => `<span class="${index === 0 ? "is-today" : ""}"><small>${day}</small><strong>${date}</strong></span>`).join("")}</div>
          <div class="calendar-body">
            <div class="calendar-times">${["8 AM", "9 AM", "10 AM", "11 AM", "12 PM", "1 PM", "2 PM", "3 PM", "4 PM", "5 PM"].map(time => `<span>${time}</span>`).join("")}</div>
            <div class="calendar-lanes">
              ${calendarDays.map((_, index) => `<div class="calendar-lane ${index === 0 ? "is-today" : ""}">${events.filter(event => event.dayIndex === index).map(event => calendarEvent(event)).join("")}</div>`).join("")}
            </div>
          </div>
        </div>
      </div>
      <div class="calendar-agenda">
        <div class="section-head"><div><h3>Class agenda</h3><p class="stat-label">All scheduled sessions for this week</p></div><span class="badge gray">${events.length} sessions</span></div>
        <div class="schedule-week">${events.map(event => scheduleDay(event, course, isStudent, enrolled)).join("")}</div>
      </div>
      ${isStudent ? `
        <div class="setup-actions">
          ${imported ? `<button class="btn btn-danger" data-action="clear-imported-schedule">Clear imported schedule</button>` : ""}
          <button class="btn btn-primary" data-action="import-schedule">${icon("i-upload")} Import CSV / ICS</button>
          <input id="scheduleFile" type="file" accept=".csv,.ics,text/csv,text/calendar" hidden />
        </div>
        <div class="security-note"><span class="lock">⌾</span><span>Your timetable file is parsed only in this browser and is not uploaded to CampusPulse.</span></div>` : ""}
      ${isStudent && !enrolled ? `<div class="security-note"><span class="lock">⌾</span><span>Ask the course professor for the private join code to unlock activities. Attendance remains teaching-team managed.</span></div>` : ""}
    </article>
    ${canManageCourse(course) ? scheduleEditor(course, courseSchedule) : ""}`;
}

async function saveCourseSchedule(course, classes, message) {
  try {
    const result = await apiRequest(`/api/courses/${encodeURIComponent(course.id)}/schedule`, {
      method: "PUT",
      body: { classes }
    });
    state.backendSchedule = [
      ...state.backendSchedule.filter(item => item.courseId !== course.id),
      ...(result.schedule || [])
    ];
    persist();
    renderSchedule();
    return toast(message);
  } catch (error) {
    return toast(error.message || "Could not save the timetable", "error");
  }
}

function scheduleEditor(course, entries) {
  return `<article class="card page-card" style="margin-top:22px">
    <div class="section-head"><div><h2 style="margin:0 0 5px">Weekly timetable</h2><p class="stat-label">${escapeHtml(course.courseCode)} · shown on everyone's calendar</p></div><span class="badge ${entries.length ? "green" : "amber"}">${entries.length} classes</span></div>
    ${entries.length ? `<table class="roster-table" style="margin-bottom:14px">
      <thead><tr><th>Day</th><th>Start</th><th>End</th><th>Class</th><th>Room</th><th></th></tr></thead>
      <tbody>${entries.map((item, index) => `<tr>
        <td>${escapeHtml(item.day || "")}</td>
        <td>${escapeHtml(item.start || "")}</td>
        <td>${escapeHtml(item.end || "")}</td>
        <td>${escapeHtml(item.topic || course.name)}</td>
        <td>${escapeHtml(item.room || "")}</td>
        <td class="roster-actions"><button class="text-btn danger" type="button" data-action="remove-schedule-class" data-index="${index}">Remove</button></td>
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
      <div class="field" style="justify-content:flex-end"><button class="btn btn-primary" type="submit">${icon("i-plus")} Add class</button></div>
    </form>
    <div class="setup-actions" style="margin-top:16px">
      <button class="btn" data-action="choose-timetable-upload">${icon("i-upload")} Upload timetable</button>
      <input id="timetableFile" type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" hidden />
    </div>
    <div class="security-note" style="margin-top:14px"><span class="lock">⌾</span><span>Upload a weekly grid (days down the side, time slots across the top) or a list with day, start, end, subject and room columns. Uploading replaces this course's timetable.</span></div>
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

function calendarEvent(event) {
  const start = Math.max(8 * 60, Math.min(18 * 60, timeToMinutes(event.start)));
  const end = Math.max(start + 35, Math.min(18 * 60, timeToMinutes(event.end)));
  const top = ((start - 8 * 60) / (10 * 60)) * 100;
  const height = Math.max(8, ((end - start) / (10 * 60)) * 100);
  return `<article class="calendar-event ${event.today ? "current" : ""}" style="--event-top:${top}%;--event-height:${height}%">
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
    <h3 style="margin-top:12px">${escapeHtml(course.name)}</h3><p>${escapeHtml(course.courseCode)} · ${escapeHtml(course.section)} · ${escapeHtml(course.room)}</p>
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

function renderAttendance() {
  const course = selectedCourse();
  if (!course || !canRunAttendance(course)) return renderRestrictedAttendance();
  setHeader("Attendance session", `${course.name.toUpperCase()} · ${course.courseCode}`, false);
  if (!backendConfigured() || state.attendanceStatus === "not_started" || !activeAttendance) {
    return renderAttendanceSetup();
  }
  return renderLiveAttendance();
}

function renderRestrictedAttendance() {
  setHeader("Attendance access restricted", "COURSE TEAM ONLY", false);
  view.innerHTML = `<article class="card empty-state"><div><span class="empty-icon">${icon("i-users")}</span><h2>Course-team access required</h2><p>Attendance is available only to the professor who owns the course and teaching assistants enrolled in it. Students and unrelated staff cannot view or change attendance.</p><button class="btn btn-primary" data-route-link="classes">Open courses</button></div></article>`;
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
        view.innerHTML = `<article class="card empty-state"><div><span class="empty-icon">${icon("i-users")}</span><h2>Roster unavailable</h2><p>${escapeHtml(error.message || "Could not load this roster")}</p><button class="btn" data-route-link="classes">Back to courses</button></div></article>`;
      });
    return;
  }
  const roster = courseRosters.get(course.id) || [];
  const ready = roster.length > 0;
  view.innerHTML = `
    <button class="back-btn" data-route-link="dashboard">${icon("i-back")} Back to overview</button>
    <div class="page-grid">
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
            <div><strong>${escapeHtml(course.name)}</strong><p>${escapeHtml(course.courseCode)} · ${escapeHtml(course.section)} · ${ready ? `${roster.length} students` : "no roll list uploaded yet"}</p></div>
            <span class="badge ${ready ? "green" : "amber"}">${ready ? "Official roster ready" : "Roll list required"}</span>
          </div>
        </div>
        ${ready
          ? `<div class="security-note"><span class="lock">⌾</span><span>This list is visible only to the course-owning professor and enrolled teaching assistants. Each session stores a roster snapshot so marks stay linked to roll numbers.</span></div>`
          : `<div class="security-note"><span class="lock">⌾</span><span>Attendance runs against your official roll list. Upload it as Excel (.xlsx), PDF, CSV, or JSON — it needs a roll number column and a name column. Students can only mark themselves once a roll list exists.</span></div>`}
        <div class="setup-actions">
          <button class="btn" data-route-link="dashboard">Cancel</button>
          ${ready
            ? `<button class="btn btn-primary" data-action="start-scan">${icon("i-play")} Take attendance</button>`
            : canManageCourse(course)
              ? `<button class="btn btn-primary" data-action="view-course-roster" data-course-id="${escapeHtml(course.id)}">${icon("i-upload")} Upload roll list</button>`
              : `<span class="badge gray">Waiting for the professor's roll list</span>`}
        </div>
      </article>
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

function attendanceSidePanel(records) {
  const total = records.length;
  const count = records.filter(record => record.present).length;
  const percent = total ? Math.round((count / total) * 100) : 0;
  const startedAt = activeAttendance?.startedAt
    ? new Date(activeAttendance.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "—";
  const missingLabel = state.attendanceStatus === "not_started" ? "Unmarked" : "Absent";
  return `<aside class="card page-card">
    <div class="section-head"><h3>Session summary</h3><span class="badge purple">${escapeHtml(selectedCourse().courseCode)}</span></div>
    <div class="summary-ring" style="--progress:${percent}%"><div><strong>${count}</strong><span>of ${total} present</span></div></div>
    <div class="summary-list">
      <div class="summary-item"><span>Present</span><strong>${count}</strong></div>
      <div class="summary-item"><span>${missingLabel}</span><strong>${total - count}</strong></div>
      <div class="summary-item"><span>Flagged</span><strong>0</strong></div>
      <div class="summary-item"><span>Started at</span><strong>${startedAt}</strong></div>
    </div>
    <div class="security-note"><span class="lock">⌾</span><span>The course professor and enrolled TAs can mark and close attendance. Students cannot change attendance records.</span></div>
  </aside>`;
}

function renderLiveAttendance() {
  clearInterval(scanTimer);
  const previousRoster = view.querySelector(".roster-scroll");
  const previousScrollTop = previousRoster?.scrollTop || 0;
  const focusedRollNumber = document.activeElement?.dataset?.rollNumber || "";
  const complete = state.attendanceStatus === "complete";
  const records = currentAttendanceRecords();
  const count = records.filter(record => record.present).length;
  view.innerHTML = `
    <button class="back-btn" data-route-link="dashboard">${icon("i-back")} Back to overview</button>
    <div class="page-grid">
      <article class="card page-card">
        ${sessionHeading(complete ? "Review attendance" : "Mark attendance", complete ? "Session closed and saved" : "Select each student who is present", complete ? "green" : "purple")}
        ${stepper(complete ? 3 : 2)}
        <div class="roster-toolbar">
          <div class="scan-status">${complete ? icon("i-check") + " Attendance closed" : '<span class="pulse"></span> Changes save to the course roster'}</div>
          <span class="badge ${complete ? "green" : "purple"}">${count} present</span>
        </div>
        ${complete ? "" : `<div class="roster-bulk-actions"><button class="btn btn-soft" data-action="mark-all-attendance">Mark all present</button><button class="btn" data-action="clear-attendance">Clear all</button></div>`}
        <div class="roster roster-scroll">
          ${records.map((student, index) => studentRow(student, index, !complete)).join("")}
        </div>
        <div class="setup-actions">
          ${complete ? `<button class="btn" data-action="new-attendance-session">${icon("i-play")} New attendance</button>` : `<button class="btn btn-danger" data-action="end-session">Close attendance</button>`}
        </div>
      </article>
      ${attendanceSidePanel(records)}
    </div>`;

  const nextRoster = view.querySelector(".roster-scroll");
  if (nextRoster) nextRoster.scrollTop = previousScrollTop;
  if (focusedRollNumber) {
    [...view.querySelectorAll("[data-roll-number]")]
      .find(element => element.dataset.rollNumber === focusedRollNumber)
      ?.focus({ preventScroll: true });
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
  const tag = interactive ? "button" : "div";
  const action = interactive ? `type="button" data-action="toggle-attendance" data-roll-number="${escapeHtml(student.rollNumber)}" aria-pressed="${present}"` : "";
  return `<${tag} class="student-row attendance-row ${interactive ? "is-interactive" : ""}" ${action}>
    <span class="student-avatar">${escapeHtml(initials)}</span>
    <div class="student-name"><strong>${escapeHtml(student.name)}</strong><span>${escapeHtml(student.rollNumber)} · No. ${student.serial || index + 1}</span></div>
    <span class="signal ${present ? "good" : ""}"><i></i><i></i><i></i><i></i></span>
    <span class="badge ${present ? "green" : rosterOnly ? "purple" : "gray"}">${present ? "Present" : rosterOnly ? "Rostered" : "Absent"}</span>
  </${tag}>`;
}

function renderQuiz() {
  if (state.userRole === "student") return renderStudentQuizAccess();
  const course = selectedCourse();
  if (!course || !canPublishQuiz(course)) {
    setHeader("Quick quizzes", "COURSE ACCESS", false);
    view.innerHTML = `<article class="card empty-state"><div><span class="empty-icon">${icon("i-quiz")}</span><h2>Course access required</h2><p>${state.userRole === "ta" ? "Join the professor's course before publishing quizzes." : "Create a course before publishing quizzes."}</p><button class="btn btn-primary" data-route-link="classes">Open courses</button></div></article>`;
    return;
  }
  setHeader("Quick quiz", `${course.name.toUpperCase()} · ${course.courseCode}`, false);
  if (state.quizPublished && state.backendQuizCourseId === course.id) return renderLiveQuiz();
  view.innerHTML = `
    <button class="back-btn" data-route-link="dashboard">${icon("i-back")} Back to overview</button>
    <div class="page-grid">
      <article class="card page-card">
        <div class="session-title"><div><h2>Create a pulse check</h2><p>Keep it short — students answer live from their devices.</p></div><span class="badge purple">Draft</span></div>
        <div class="quiz-builder" id="quizBuilder">
          ${questionBlock(1, "Which relation is an equivalence relation?", ["Reflexive only", "Symmetric only", "Reflexive, symmetric & transitive", "Transitive only"], 2)}
          ${questionBlock(2, "A tree with n vertices has how many edges?", ["n edges", "n − 1 edges", "n + 1 edges", "2n edges"], 1)}
          <button class="add-question" data-action="add-question">${icon("i-plus")} Add another question</button>
        </div>
        <div class="setup-actions"><button class="btn" data-route-link="dashboard">Save draft</button><button class="btn btn-primary" data-action="publish-quiz">${icon("i-send")} Publish to class</button></div>
      </article>
      <aside class="card page-card quiz-settings">
        <div class="section-head"><h3>Quiz settings</h3></div>
        <label for="quizCourseSelect">Course</label><select class="select" id="quizCourseSelect">${state.courses.filter(canPublishQuiz).map(item => `<option value="${escapeHtml(item.id)}" ${item.id === course.id ? "selected" : ""}>${escapeHtml(item.courseCode)} · ${escapeHtml(item.name)}</option>`).join("")}</select>
        <label for="quizTitle">Quiz title</label><input class="text-input" id="quizTitle" value="Concept check · Relations & Trees" />
        <label for="duration">Time limit</label><select class="select" id="duration"><option>3 minutes</option><option>5 minutes</option><option>No limit</option></select>
        <label for="reveal">Results</label><select class="select" id="reveal"><option>Reveal after quiz ends</option><option>Reveal after each answer</option><option>Keep private</option></select>
        <div class="security-note"><span class="lock">✦</span><span>Quiz responses are linked to the active course and visible only to its teaching team.</span></div>
      </aside>
    </div>`;
}

function renderStudentQuizAccess() {
  setHeader("Course activities", "STUDENT ACCESS", false);
  const course = state.courses.find(item => item.id === state.backendQuizCourseId) || selectedCourse();
  const hasAccess = Boolean(course && state.enrolledCourses.includes(course.id));
  view.innerHTML = hasAccess ? `
    <button class="back-btn" data-route-link="dashboard">${icon("i-back")} Back to dashboard</button>
    <div class="page-grid">
      <article class="card page-card">
        <div class="session-title"><div><h2>${escapeHtml(course.name)}</h2><p>${escapeHtml(course.courseCode)} · ${escapeHtml(course.section)}</p></div><span class="badge green">Enrolled</span></div>
        <div class="question-card" style="margin-top:20px"><div class="section-head"><div><h3>${escapeHtml(state.backendQuizTitle || "Quick quiz")}</h3><p class="stat-label" style="margin-top:5px">${state.backendQuizQuestions.length} questions</p></div><span class="badge ${state.quizPublished ? "purple" : "gray"}">${state.quizResponded ? "Submitted" : state.quizPublished ? "Available now" : "Not started"}</span></div>
        ${state.quizPublished && !state.quizResponded ? `<form id="studentQuizForm" class="quiz-builder" style="margin-top:18px">
          ${(state.backendQuizQuestions.length ? state.backendQuizQuestions : [
            { text: "Which property is central to fuzzy membership?", options: ["Binary membership only", "Degrees of membership", "No membership", "Random membership"] },
            { text: "A neural network learns primarily by adjusting what?", options: ["Room numbers", "Weights", "Course codes", "Calendar dates"] }
          ]).map((question, questionIndex) => `<fieldset class="question-card"><legend><strong>${questionIndex + 1}. ${escapeHtml(question.text || question.question)}</strong></legend>${question.options.map((option, optionIndex) => `<label class="option-input"><input type="radio" name="student-q-${questionIndex}" value="${optionIndex}" required /><span>${escapeHtml(option)}</span></label>`).join("")}</fieldset>`).join("")}
          <button class="btn btn-primary" type="submit">${icon("i-send")} Submit quiz</button>
        </form>` : `<button class="btn btn-primary" disabled>${icon(state.quizResponded ? "i-check" : "i-play")} ${state.quizResponded ? "Response submitted" : "Waiting for quiz"}</button>`}</div>
      </article>
      <aside class="card page-card"><div class="section-head"><h3>Your access</h3><span class="badge green">Verified</span></div><div class="summary-list"><div class="summary-item"><span>Enrollment</span><strong>Active</strong></div><div class="summary-item"><span>Course</span><strong>${escapeHtml(course.courseCode)}</strong></div><div class="summary-item"><span>Attendance</span><strong>Teaching-team managed</strong></div></div><div class="security-note"><span class="lock">⌾</span><span>You can access course activities, but only the owning professor and enrolled TAs can view or change attendance.</span></div></aside>
    </div>` : `
    <article class="card empty-state"><div><span class="empty-icon">${icon("i-quiz")}</span><h2>Course access required</h2><p>Join a course before opening its quizzes.</p><button class="btn btn-primary" data-route-link="classes">Join a course</button></div></article>`;
}

function questionBlock(number, question, options, answer) {
  return `<div class="question-card">
    <div class="question-top"><span class="q-number">${number}</span><input value="${escapeHtml(question)}" aria-label="Question ${number}" /><button class="icon-btn" aria-label="Question options">${icon("i-more")}</button></div>
    <div class="options">${options.map((opt, i) => `<div class="option-input"><input type="radio" name="q${number}" aria-label="Mark option ${i + 1} correct" ${i === answer ? "checked" : ""}/><input type="text" value="${escapeHtml(opt)}" aria-label="Option ${i + 1} text" /></div>`).join("")}</div>
  </div>`;
}

function renderLiveQuiz() {
  clearTimeout(quizTimer);
  if (state.route !== "quizzes" || state.userRole === "student" || !state.authenticated) return;
  const course = selectedCourse();
  if (!course || !canPublishQuiz(course) || state.backendQuizCourseId !== course.id) return renderQuiz();
  const responses = state.quizResponses;
  const totalStudents = course.students;
  const percentage = totalStudents ? Math.round((responses / totalStudents) * 100) : 0;
  const questionCount = state.backendQuizQuestions.length;
  view.innerHTML = `
    <button class="back-btn" data-route-link="dashboard">${icon("i-back")} Back to overview</button>
    <div class="page-grid">
      <article class="card page-card">
        <div class="session-title"><div><h2>${escapeHtml(state.backendQuizTitle || "Quick quiz")}</h2><p>${questionCount} ${questionCount === 1 ? "question" : "questions"}</p></div><span class="badge green">Live now</span></div>
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
      if (state.route !== "quizzes" || state.userRole === "student" || !state.authenticated) return;
      try {
        const result = await apiRequest(`/api/quizzes/current?courseId=${encodeURIComponent(course.id)}`);
        const responseCount = result.quiz?.responses?.length || 0;
        if (responseCount !== state.quizResponses) {
          state.quizResponses = responseCount;
          persist();
          renderLiveQuiz();
        }
      } catch {}
    }, 3000);
  } else if (responses < 38) {
    quizTimer = setTimeout(() => {
      if (state.route !== "quizzes" || state.userRole === "student" || !state.authenticated) return;
      state.quizResponses = Math.min(38, state.quizResponses + Math.ceil(Math.random() * 3));
      persist(); renderLiveQuiz();
    }, 1800);
  }
}

function renderClasses() {
  if (state.userRole === "student") return renderStudentClasses();
  if (state.userRole === "ta") return renderTAClasses();
  setHeader("My courses", "PROFESSOR WORKSPACE", false);
  view.innerHTML = `
    <article class="card page-card">
      <div class="section-head"><div><h2 style="margin:0 0 5px">Courses you own</h2><p class="stat-label">Create courses and share their private join codes. Rosters and files now have dedicated tabs.</p></div><button class="btn btn-primary" data-action="open-course-modal">${icon("i-plus")} Create course</button></div>
      <div class="course-grid">${state.courses.map(facultyCourseCard).join("")}</div>
    </article>`;
}

function facultyCourseCard(course) {
  return `<article class="course-card">
    <div class="course-accent"></div><h3>${escapeHtml(course.name)}</h3><p>${escapeHtml(course.courseCode)} · ${escapeHtml(course.section)} · ${escapeHtml(course.room)}</p>
    <div class="course-code"><span>TA & student join code</span><strong>${escapeHtml(course.code)}</strong><button class="icon-btn" data-copy="${escapeHtml(course.code)}" aria-label="Copy join code">${icon("i-quiz")}</button></div>
    <div class="course-footer"><span>${course.rosterReady === false ? `${icon("i-users")} No official roster yet` : `${icon("i-users")} ${Number(course.students) || 0} rostered students`}</span><span>${Number(course.materialCount) || 0} shared files</span></div>
  </article>`;
}

function rosterTableRow(student, index, editable = false) {
  return `<tr>
    <td class="roster-serial">${student.serial || index + 1}</td>
    <td class="roster-roll">${escapeHtml(student.rollNumber)}</td>
    <td>${escapeHtml(student.name)}</td>
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
  setHeader(
    `${course.name} roster`,
    state.userRole === "faculty" ? "PROFESSOR WORKSPACE" : "TEACHING ASSISTANT WORKSPACE",
    false
  );
  view.innerHTML = `
    <button class="back-btn" data-action="close-course-roster">${icon("i-back")} Back to students</button>
    <div class="page-grid roster-grid">
      <article class="card page-card">
        <div class="section-head"><div><h2 style="margin:0 0 5px">Official student list</h2><p class="stat-label">${escapeHtml(course.courseCode)} · ${escapeHtml(course.section)}</p></div><span class="badge ${roster.length ? "green" : "amber"}">${roster.length} students</span></div>
        <label class="roster-search">${icon("i-users")}<input id="rosterSearch" type="search" placeholder="Search name or roll number" autocomplete="off" /></label>
        <div class="roster-scroll" id="professorRoster">
          ${roster.length ? `<table class="roster-table">
            <thead><tr><th>Sl.No.</th><th>Roll No</th><th>Name</th><th></th></tr></thead>
            <tbody>${roster.map((student, index) => rosterTableRow(student, index, editable)).join("")}</tbody>
          </table>` : `<p class="stat-label" style="padding:14px 2px">No students yet. Upload the roll list, or add them one at a time.</p>`}
        </div>
      </article>

      ${editable ? `<aside class="card page-card">
        <div class="section-head"><h3>Manage roll list</h3></div>
        <form id="addStudentForm" class="login-form">
          <label for="addRollNumber">Roll number</label>
          <input id="addRollNumber" name="rollNumber" type="text" placeholder="e.g. 23ME10001" autocomplete="off" maxlength="40" required />
          <label for="addStudentName">Full name</label>
          <input id="addStudentName" name="name" type="text" placeholder="Student name" autocomplete="off" maxlength="120" required />
          <button class="btn btn-primary" type="submit">${icon("i-plus")} Add student</button>
        </form>
        <div class="setup-actions" style="margin-top:16px">
          <button class="btn" data-action="choose-roster-upload">${icon("i-upload")} Upload roll list</button>
          <button class="btn btn-primary" data-action="start-course-attendance" data-course-id="${escapeHtml(course.id)}" ${roster.length ? "" : "disabled"}>${icon("i-play")} Take attendance</button>
          <input id="rosterUploadFile" type="file" accept=".xlsx,.pdf,.csv,.json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/pdf,text/csv,application/json" hidden />
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
    <p>${escapeHtml(course.courseCode)} · ${escapeHtml(course.section)} · ${escapeHtml(course.room)}</p>
    <div class="course-footer"><span>${Number(course.materialCount) || 0} shared files</span><button class="text-btn" data-action="open-course-materials" data-course-id="${escapeHtml(course.id)}">${owner ? "Upload & manage" : upload ? "Upload & view" : "View materials"}</button></div>
  </article>`;
}

function renderMaterials() {
  if (materialsCourseId) return renderCourseMaterials(materialsCourseId);
  const roleLabel = state.userRole === "faculty"
    ? "PROFESSOR WORKSPACE"
    : state.userRole === "ta"
      ? "TEACHING ASSISTANT WORKSPACE"
      : "STUDENT WORKSPACE";
  setHeader("Materials", roleLabel, false);
  view.innerHTML = `
    <article class="card page-card">
      <div class="section-head"><div><h2 style="margin:0 0 5px">Course materials</h2><p class="stat-label">Choose a course to ${state.userRole === "student" ? "view or download its shared files" : "upload, view, or download its shared files"}.</p></div><span class="badge purple">${state.courses.length} courses</span></div>
      <div class="course-grid">${state.courses.map(materialCourseCard).join("") || `<div class="empty-state"><div><span class="empty-icon">${icon("i-cloud")}</span><h3>No courses available</h3><p>Create or join a course before using materials.</p><button class="btn btn-primary" data-route-link="classes">Open Courses</button></div></div>`}</div>
    </article>`;
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
    <button class="back-btn" data-action="close-course-materials">${icon("i-back")} Back to materials</button>
    <article class="card page-card">
      <div class="section-head">
        <div><h2 style="margin:0 0 5px">Course materials</h2><p class="stat-label">Files here are private to this course's professor, teaching assistants, and enrolled students.</p></div>
        <div class="setup-actions"><span class="badge ${materials.length ? "green" : "gray"}">${materials.length} files</span>${uploader ? `<button class="btn btn-primary" type="button" data-action="choose-material-upload">${icon("i-upload")} Upload material</button><input id="materialUploadFile" type="file" hidden />` : ""}</div>
      </div>
      ${materials.length ? `<div class="roster-scroll"><table class="roster-table">
        <thead><tr><th>File</th><th>Size</th><th>Uploaded</th><th></th></tr></thead>
        <tbody>${materials.map(material => materialTableRow(material, owner)).join("")}</tbody>
      </table></div>` : `<div class="empty-state"><div><span class="empty-icon">${icon("i-quiz")}</span><h3>No materials uploaded yet</h3><p>${uploader ? "Upload notes, slides, PDFs, assignments, or other course files." : "Your course team has not shared any course files yet."}</p></div></div>`}
    </article>`;
}

function renderTAClasses() {
  setHeader("Courses you assist", "TEACHING ASSISTANT WORKSPACE", false);
  view.innerHTML = `
    <div class="left-stack">
      <article class="card join-panel">
        <span class="empty-icon">${icon("i-plus")}</span><h2>Join an assigned course</h2>
        <p class="stat-label">Enter the private code shared by the course professor. Your TA account must also be administrator-approved.</p>
        <form class="join-code" id="joinForm"><div class="join-code-field"><label for="taJoinCode">Private course code</label><input id="taJoinCode" name="joinCode" maxlength="32" placeholder="Enter course code" autocomplete="off" required/></div><button class="btn btn-primary">Join course</button></form>
      </article>
      <article class="card page-card">
        <div class="section-head"><div><h2 style="margin:0 0 5px">Enrolled TA courses</h2><p class="stat-label">You can manage rosters and materials, run attendance, and publish quizzes. Course creation and join codes remain with the professor.</p></div><span class="badge purple">${state.courses.length} assigned</span></div>
        <div class="course-grid">${state.courses.map(taCourseCard).join("") || `<div class="empty-state"><div><p>No course joined yet.</p></div></div>`}</div>
      </article>
    </div>`;
}

function taCourseCard(course) {
  return `<article class="course-card">
    <div class="course-accent"></div><span class="badge purple">Teaching assistant</span>
    <h3 style="margin-top:12px">${escapeHtml(course.name)}</h3><p>${escapeHtml(course.courseCode)} · ${escapeHtml(course.section)} · ${escapeHtml(course.room)}</p>
    <div class="course-footer"><button class="text-btn" data-action="start-course-attendance" data-course-id="${escapeHtml(course.id)}">Take attendance</button><button class="text-btn" data-action="open-course-quiz" data-course-id="${escapeHtml(course.id)}">Create quiz</button></div>
  </article>`;
}

function renderStudentClasses() {
  setHeader("Join a course", "STUDENT WORKSPACE", false);
  const enrolled = state.courses.filter(course => state.enrolledCourses.includes(course.id));
  view.innerHTML = `
    <div class="left-stack">
    <article class="card join-panel">
      <span class="empty-icon">${icon("i-plus")}</span><h2>Enter your course code</h2>
      <p class="stat-label">Your faculty will share a private course code. The roll number from your account is used, so you only need to join once.</p>
      <form class="join-code" id="joinForm">
        <div class="join-code-field"><label for="studentJoinCode">Private course code</label><input id="studentJoinCode" name="joinCode" maxlength="32" placeholder="Enter course code" autocomplete="off" required/></div>
        <button class="btn btn-primary">Join course</button>
      </form>
      ${enrolled.length ? `<div class="student-course-list"><div class="section-head"><h3>Courses joined</h3><span class="badge green">${enrolled.length} active</span></div>${enrolled.map(course => studentCourseCard(course)).join("")}</div>` : ""}
    </article>
    </div>`;
}

function openCourseModal() {
  modalReturnFocus = document.activeElement;
  document.querySelector("#modalRoot").innerHTML = `
    <div class="modal-backdrop" data-action="close-modal">
      <form class="modal" id="courseForm" role="dialog" aria-modal="true" aria-labelledby="courseModalTitle" aria-describedby="courseModalDescription">
        <div class="modal-head"><div><h2 id="courseModalTitle">Add a new course</h2><p id="courseModalDescription">Students will use the generated code to enroll.</p></div><button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">${icon("i-close")}</button></div>
        <div class="field-grid">
          <div class="field full"><label for="courseName">Course name</label><input id="courseName" name="name" placeholder="e.g. Computer Networks" required /></div>
          <div class="field"><label for="courseCode">Course code</label><input id="courseCode" name="courseCode" placeholder="CSE 308" required /></div>
          <div class="field"><label for="section">Section</label><input id="section" name="section" placeholder="Section A" required /></div>
          <div class="field"><label for="room">Classroom</label><input id="room" name="room" placeholder="Room 205" required /></div>
          <div class="field full"><p class="stat-label">After creation, use the Students tab to upload the official Excel, PDF, CSV, or JSON roster. The Materials tab holds course files.</p></div>
        </div>
        <div class="setup-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn btn-primary">${icon("i-plus")} Create course</button></div>
      </form>
    </div>`;
  setTimeout(() => document.querySelector("#courseName")?.focus(), 0);
}

function closeModal() {
  document.querySelector("#modalRoot").innerHTML = "";
  modalReturnFocus?.focus?.();
  modalReturnFocus = null;
}

function renderPlaceholder(route) {
  if (route === "classes") return renderClasses();
  if (route === "settings") return renderSettings();
  const config = {
    classes: ["Classes", "Manage your timetable", "i-calendar"],
    settings: ["Settings", "Configure the secure API connection, privacy, and account access.", "i-settings"]
  }[route] || ["Coming soon", "This workspace is ready for its next module.", "i-grid"];
  setHeader(config[0], "CAMPUSPULSE");
  view.innerHTML = `<article class="card empty-state"><div><span class="empty-icon">${icon(config[2])}</span><h2>${config[0]}</h2><p>${config[1]}</p><button class="btn btn-primary" data-route-link="dashboard">Back to overview</button></div></article>`;
}

// Everyone who signed up and joined, as opposed to the uploaded roll list.
function renderStudents() {
  if (state.userRole === "student") return navigate("dashboard");
  if (managedCourseId) return renderCourseRoster(managedCourseId);
  setHeader("Students", state.userRole === "faculty" ? "PROFESSOR WORKSPACE" : "TEACHING ASSISTANT WORKSPACE", false);
  const enrolled = enrolledStudents;
  const byCourse = new Map();
  for (const student of enrolled) {
    if (!byCourse.has(student.courseId)) byCourse.set(student.courseId, []);
    byCourse.get(student.courseId).push(student);
  }
  view.innerHTML = `
    <div class="page-grid roster-grid">
      <article class="card page-card">
        <div class="section-head"><div><h2 style="margin:0 0 5px">Enrolled students</h2><p class="stat-label">Accounts that joined this course using their registered roll number</p></div><div class="setup-actions"><span class="badge ${enrolled.length ? "green" : "amber"}">${enrolled.length} enrolled</span><button class="btn" type="button" data-action="export-enrolled" ${enrolled.length ? "" : "disabled"}>${icon("i-download")} Excel</button></div></div>
        ${enrolled.length ? [...byCourse.entries()].map(([courseId, students]) => {
          const course = state.courses.find(item => item.id === courseId);
          return `<div style="margin-top:18px">
            <div class="section-head"><h3>${escapeHtml(course ? `${course.courseCode} · ${course.name}` : courseId)}</h3><span class="badge purple">${students.length}</span></div>
            <div class="roster-scroll">
              <table class="roster-table">
                <thead><tr><th>Roll No</th><th>Name</th><th>Email</th><th>Phone</th><th>Hall</th></tr></thead>
                <tbody>${students.map(student => `<tr>
                  <td class="roster-roll">${escapeHtml(student.rollNumber || "—")}</td>
                  <td>${escapeHtml(student.name)}</td>
                  <td>${escapeHtml(student.email)}</td>
                  <td>${escapeHtml(student.phone || "—")}</td>
                  <td>${escapeHtml(student.hall || "—")}</td>
                </tr>`).join("")}</tbody>
              </table>
            </div>
          </div>`;
        }).join("") : `<p class="stat-label" style="padding:14px 2px">Nobody has joined yet. Share a course join code — students enter it with their roll number.</p>`}
      </article>
      <aside class="card page-card">
        <div class="section-head"><h3>Official rosters</h3></div>
        <div class="summary-list">
          ${state.courses.map(course => `<div class="summary-item"><span>${escapeHtml(course.courseCode)} · ${(byCourse.get(course.id) || []).length} enrolled of ${Number(course.students) || 0}</span><button class="text-btn" type="button" data-action="view-course-roster" data-course-id="${escapeHtml(course.id)}">${canManageRoster(course) ? "Manage roster" : "View roster"}</button></div>`).join("") || `<div class="summary-item"><span>No courses yet</span><strong>—</strong></div>`}
        </div>
        <div class="security-note" style="margin-top:16px"><span class="lock">⌾</span><span>Professors and assigned TAs manage the official roll list here. The enrolled table shows who has created an account and joined.</span></div>
      </aside>
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
        <p class="update-explainer">Web features, fixes, and styling download and install automatically in the Android app, except while a class is running — those wait until you leave the screen. Native Android changes still require a newly signed APK.</p>
        ${updateState.supported ? `<div class="setup-actions"><button class="btn" type="button" data-action="check-for-updates">Check now</button>${updateState.status === "ready" ? `<button class="btn btn-primary" type="button" data-action="restart-to-update">Restart and update</button>` : ""}</div>` : ""}
      </article>
    </div>`;
}

function nativeDeviceStatus() {
  return window.Capacitor?.Plugins?.DeviceStatus || null;
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

// Shared by CSV and Excel: rows are arrays of cell strings, first row the header.
function rosterFromRows(rows, label) {
  const cleaned = rows.filter(row => row.some(cell => String(cell || "").trim()));
  if (cleaned.length < 2) throw new Error(`Roster ${label} must include a header and at least one student`);
  const headers = cleaned[0].map(header =>
    String(header || "").toLowerCase().replace(/[^a-z0-9]/g, "")
  );
  const rollIndex = headers.findIndex(header => ROLL_HEADERS.includes(header));
  const nameIndex = headers.findIndex(header => NAME_HEADERS.includes(header));
  if (rollIndex < 0 || nameIndex < 0) {
    throw new Error(`Roster ${label} needs a roll number column and a name column`);
  }
  return cleaned
    .slice(1)
    .map(row => ({
      rollNumber: String(row[rollIndex] ?? "").trim(),
      name: String(row[nameIndex] ?? "").trim()
    }))
    .filter(student => student.rollNumber || student.name);
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

function xlsxCell(reference, value) {
  const text = String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // Excel rejects control characters outright.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
}

function downloadXlsx(filename, headers, rows) {
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
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Enrolled" sheetId="1" r:id="rId1"/></sheets></workbook>`],
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

function parseRosterUpload(text, filename = "") {
  if (filename.toLowerCase().endsWith(".json")) {
    const parsed = JSON.parse(text);
    const students = Array.isArray(parsed) ? parsed : parsed.students;
    if (!Array.isArray(students)) throw new Error("JSON roster must be an array or contain a students array");
    return students.map(student => ({
      rollNumber: student.rollNumber || student.roll || student.roll_no,
      name: student.name || student.studentName || student.student_name
    }));
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
    return toast(`Join code ${copyButton.dataset.copy} copied`);
  }
  const routeButton = event.target.closest("[data-route], [data-route-link]");
  if (routeButton) {
    const route = routeButton.dataset.route || routeButton.dataset.routeLink;
    if (route === "attendance") {
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
    try {
      await loadCourseRoster(courseId);
    } catch (error) {
      return toast(error.message || "Could not load the course roster", "error");
    }
    managedCourseId = courseId;
    state.route = "students";
    setNavigationState("students");
    persist();
    return renderStudents();
  }
  if (action === "close-course-roster") {
    managedCourseId = "";
    return renderStudents();
  }
  if (action === "open-course-materials") {
    const courseId = event.target.closest("[data-course-id]")?.dataset.courseId || "";
    if (!state.courses.some(course => course.id === courseId)) {
      return toast("Course not found", "error");
    }
    try {
      await loadCourseMaterials(courseId, { force: true });
    } catch (error) {
      return toast(error.message || "Could not load course materials", "error");
    }
    managedCourseId = "";
    materialsCourseId = courseId;
    state.route = "materials";
    setNavigationState("materials");
    persist();
    return renderMaterials();
  }
  if (action === "close-course-materials") {
    materialsCourseId = "";
    return renderMaterials();
  }
  if (action === "choose-material-upload") {
    const course = state.courses.find(item => item.id === materialsCourseId);
    if (!canUploadMaterials(course)) {
      return toast("Course-team material access required", "error");
    }
    return document.querySelector("#materialUploadFile")?.click();
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
  if (action === "choose-roster-upload") {
    const course = state.courses.find(item => item.id === managedCourseId);
    if (!canManageRoster(course)) return toast("Course-team roster access required", "error");
    return document.querySelector("#rosterUploadFile")?.click();
  }
  if (action === "open-course-quiz") {
    const courseId = event.target.closest("[data-course-id]")?.dataset.courseId || "";
    try {
      await selectQuizCourse(courseId);
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
      await selectAttendanceCourse(courseId);
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
      await selectAttendanceCourse(courseId);
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
  if (action === "start-scan") {
    if (!canRunAttendance(selectedCourse())) return toast("Course-team attendance access required", "error");
    if (!backendConfigured()) return toast("Connect CampusPulse to its API first", "error");
    try {
      const result = await apiRequest("/api/attendance/sessions", {
        method: "POST",
        body: { courseId: state.selectedCourseId }
      });
      activeAttendance = result.attendance;
      state.backendAttendanceId = result.attendance.id;
    } catch (error) {
      return toast(error.message || "Could not open attendance", "error");
    }
    state.attendanceStatus = "scanning";
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
    state.attendanceStatus = "complete";
    persist(); renderLiveAttendance(); toast(`Attendance saved for ${currentPresentCount()} students`);
  }
  if (action === "delete-account") {
    const confirmed = window.confirm(
      "Delete your CampusPulse account, enrollment, and quiz response data? Official rosters and teaching-team-recorded attendance remain course records. This cannot be undone."
    );
    if (!confirmed) return;
    try {
      if (backendConfigured() && apiToken) {
        await apiRequest("/api/account", { method: "DELETE" });
      } else {
        state.accounts = state.accounts.filter(
          (account) => account.email !== state.authEmail
        );
      }
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
  if (action === "import-schedule") document.querySelector("#scheduleFile")?.click();
  if (action === "clear-imported-schedule") {
    state.importedSchedule = [];
    persist();
    renderSchedule();
    toast("Imported timetable cleared");
  }
  if (action === "calendar-today") {
    document.querySelector(".calendar-scroll")?.scrollTo({ left: 220, behavior: "smooth" });
    toast("Showing the current teaching week");
  }
  if (action === "logout") {
    clearTimeout(quizTimer);
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
    if (!enrolledStudents.length) return toast("Nobody has joined yet", "error");
    const stamp = new Date().toISOString().slice(0, 10);
    downloadXlsx(
      `CampusPulse-enrolled-${stamp}.xlsx`,
      ["Name", "Roll No", "Email", "Phone No", "Hall of Residence", "Course"],
      enrolledStudents.map(student => [
        student.name,
        student.rollNumber || "",
        student.email,
        student.phone || "",
        student.hall || "",
        student.courseCode
      ])
    );
    return toast(`${enrolledStudents.length} enrolled students exported`);
  }
  if (action === "choose-timetable-upload") {
    return document.querySelector("#timetableFile")?.click();
  }
  if (action === "remove-schedule-class") {
    const course = selectedCourse();
    if (!course || !canManageCourse(course)) {
      return toast("Only the course owner can change this timetable", "error");
    }
    const index = Number(event.target.closest("[data-index]")?.dataset.index);
    const remaining = state.backendSchedule
      .filter(item => item.courseId === course.id)
      .filter((_, position) => position !== index);
    return saveCourseSchedule(course, remaining, "Class removed");
  }
  if (action === "remove-roster-student") {
    const course = state.courses.find(item => item.id === managedCourseId);
    const rollNumber = event.target.closest("[data-roll-number]")?.dataset.rollNumber || "";
    if (!course || !canManageRoster(course)) {
      return toast("Course-team roster access required", "error");
    }
    if (!window.confirm(`Remove ${rollNumber} from the ${course.courseCode} roll list? They lose access to this course.`)) return;
    try {
      const result = await apiRequest(
        `/api/courses/${encodeURIComponent(course.id)}/roster/${encodeURIComponent(rollNumber)}`,
        { method: "DELETE" }
      );
      courseRosters.set(course.id, result.students || []);
      state.courses = state.courses.map(item => item.id === course.id ? { ...item, ...result.course } : item);
      persist();
      renderCourseRoster(course.id);
      return toast(`${rollNumber} removed`);
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
      const signals = await attendanceSignals({ requestWebBluetooth: true });
      if (!signals.wifi || !signals.bluetooth) {
        const missing = [!signals.wifi && "Wi‑Fi", !signals.bluetooth && "Bluetooth"]
          .filter(Boolean)
          .join(" and ");
        return toast(`Turn on ${missing}, then mark attendance again`, "error");
      }
      await apiRequest(`/api/attendance/${sessionId}/check-in`, {
        method: "POST",
        body: { rollNumber, signals }
      });
      state.checks = { wifi: true, bluetooth: true };
      persist();
      toast("You are marked present");
    } catch (error) {
      return toast(error.message || "Could not mark attendance", "error");
    } finally {
      button.disabled = false;
    }
    await refreshOpenAttendance({ rerender: false });
    return render();
  }
  if (action === "add-question") {
    const button = event.target.closest("[data-action]");
    button.insertAdjacentHTML("beforebegin", questionBlock(document.querySelectorAll(".question-card").length + 1, "Type your question here", ["Option A", "Option B", "Option C", "Option D"], 0));
  }
  if (action === "publish-quiz") {
    const course = selectedCourse();
    if (!course || !canPublishQuiz(course)) return toast("Course quiz permission required", "error");
    if (backendConfigured()) {
      const questions = [...document.querySelectorAll("#quizBuilder .question-card")].map((card) => {
        const options = [...card.querySelectorAll(".option-input input[type='text']")].map((input) => input.value.trim());
        const selected = [...card.querySelectorAll(".option-input input[type='radio']")].findIndex((input) => input.checked);
        return {
          text: card.querySelector(".question-top > input")?.value.trim() || "Question",
          options,
          answer: Math.max(0, selected)
        };
      });
      try {
        const result = await apiRequest("/api/quizzes", {
          method: "POST",
          body: {
            courseId: course.id,
            title: document.querySelector("#quizTitle")?.value || "Quick quiz",
            questions
          }
        });
        applyQuizSnapshot(result.quiz);
      } catch (error) {
        return toast(error.message || "Could not publish the quiz", "error");
      }
    }
    state.quizPublished = true;
    state.quizResponses = backendConfigured() ? 0 : 3;
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
    state.quizPublished = false;
    persist();
    toast(`Quiz ended with ${state.quizResponses} responses`);
    navigate("dashboard");
  }
});

document.addEventListener("change", async event => {
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
  if (event.target.id === "quizCourseSelect") {
    try {
      await selectQuizCourse(event.target.value);
    } catch (error) {
      return toast(error.message || "Could not switch quiz course", "error");
    }
    persist();
    return renderQuiz();
  }
  if (event.target.id === "attendanceCourseSelect") {
    try {
      await selectAttendanceCourse(event.target.value);
    } catch (error) {
      return toast(error.message || "Could not switch course attendance", "error");
    }
    persist();
    return renderAttendance();
  }
  if (event.target.id === "timetableFile") {
    const file = event.target.files?.[0];
    const course = selectedCourse();
    if (!file || !course || !canManageCourse(course)) return;
    try {
      const classes = await readTimetableFile(file);
      const preview = classes
        .slice(0, 3)
        .map(item => `  ${item.day} ${item.start}${item.end ? `–${item.end}` : ""} ${item.topic}`)
        .join("\n");
      if (!window.confirm(`Replace the ${course.courseCode} timetable with ${classes.length} classes from ${file.name}?

${preview}`)) return;
      await saveCourseSchedule(course, classes, `${classes.length} classes imported`);
    } catch (error) {
      return toast(error.message || "Could not read that timetable", "error");
    } finally {
      event.target.value = "";
    }
    return;
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
        .map(student => `  ${student.rollNumber} — ${student.name}`)
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
    state.importedSchedule = parsed.slice(0, 30);
    persist();
    renderSchedule();
    toast(`${state.importedSchedule.length} timetable entries imported`);
  } catch (error) {
    toast(error.message || "Could not read that timetable file");
  }
});

document.addEventListener("input", event => {
  if (event.target.id !== "rosterSearch") return;
  const query = event.target.value.trim().toLowerCase();
  document.querySelectorAll("#professorRoster .student-row").forEach(row => {
    row.hidden = Boolean(query) && !row.textContent.toLowerCase().includes(query);
  });
});

quickAction.addEventListener("click", async () => {
  if (state.route === "dashboard") {
    const course = selectedCourse() || state.courses.find(canRunAttendance);
    if (!course || !canRunAttendance(course)) return toast("Join or create a course first", "error");
    try {
      await selectAttendanceCourse(course.id);
    } catch (error) {
      return toast(error.message || "Could not open course attendance", "error");
    }
  }
  navigate("attendance");
});

document.addEventListener("submit", async event => {
  event.preventDefault();
  if (event.target.id === "signupForm") {
    const data = Object.fromEntries(new FormData(event.target));
    const email = String(data.email || "").trim().toLowerCase();
    const name = String(data.name || "").trim().replace(/\s+/g, " ");
    if (!backendConfigured()) {
      return toast("Connect CampusPulse to its API before creating an account", "error");
    }
    if (name.length < 2) return toast("Enter your full name", "error");
    if (!isCampusEmail(email)) return toast("Use a valid IIT KGP institutional email", "error");
    if (String(data.password).length < 8) return toast("Password must contain at least 8 characters", "error");
    if (data.password !== data.confirmPassword) return toast("The passwords do not match", "error");
    try {
      const signedUp = await apiRequest("/api/auth/signup", {
        method: "POST",
        auth: false,
        body: {
          role: data.role,
          name,
          email,
          password: data.password,
          phone: String(data.phone || "").trim(),
          rollNumber: String(data.rollNumber || "").trim().toUpperCase() || undefined,
          hall: String(data.hall || "").trim() || undefined,
          roleCode: data.roleCode || undefined
        }
      });
      apiToken = signedUp.token;
      localStorage.setItem("campusPulseApiToken", apiToken);
      state.userRole = signedUp.user.role;
      state.authenticated = true;
      state.accountName = signedUp.user.name;
      state.authEmail = signedUp.user.email;
      state.route = "dashboard";
      await syncBackendState();
      setNavigationState("dashboard");
      showApp();
    } catch (error) {
      return toast(error.message || "Could not create the account", "error");
    }
    return toast("Account created and signed in");
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
    let result;
    try {
      result = await apiRequest("/api/courses", {
        method: "POST",
        body: {
          name: data.name,
          courseCode: data.courseCode,
          section: data.section,
          room: data.room
        }
      });
      await syncBackendState();
      state.selectedCourseId = result.course.id;
    } catch (error) {
      return toast(error.message || "Could not create the course", "error");
    }
    persist();
    closeModal();
    renderClasses();
    toast(`${result.course.name} created · Code ${result.course.code}`);
  }
  if (event.target.id === "addClassForm") {
    const course = selectedCourse();
    if (!course || !canManageCourse(course)) {
      return toast("Only the course owner can change this timetable", "error");
    }
    const data = new FormData(event.target);
    const existing = state.backendSchedule
      .filter(item => item.courseId === course.id)
      .map(({ day, start, end, topic, room }) => ({ day, start, end, topic, room }));
    existing.push({
      day: String(data.get("day") || ""),
      start: String(data.get("start") || "").trim(),
      end: String(data.get("end") || "").trim(),
      topic: String(data.get("topic") || "").trim() || course.courseCode,
      room: String(data.get("room") || "").trim() || course.room || ""
    });
    return saveCourseSchedule(course, existing, "Class added to the timetable");
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
          name: String(data.get("name") || "").trim()
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
    const newPassword = String(data.get("newPassword") || "");
    if (newPassword !== String(data.get("confirmNewPassword") || "")) {
      return toast("The new passwords do not match", "error");
    }
    try {
      await apiRequest("/api/auth/password/reset", {
        method: "POST",
        auth: false,
        body: { email: passwordResetEmail, code: String(data.get("code") || ""), newPassword }
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
      state.selectedCourseId = result.course.id;
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
persist();
if (backendConfigured() && apiToken) {
  restoreBackendSession().then((restored) => {
    if (!restored) render();
  });
} else {
  render();
}
refreshEmailDeliveryState();
