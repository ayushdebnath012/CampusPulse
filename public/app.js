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
  courses: [
    { id: "soft401", code: "", name: "Soft Computing", courseCode: "MF41601", section: "Autumn 2026-2027", room: "NR221", students: 310 },
    { id: "kbs60353", code: "", name: "Knowledge Based Systems in Engineering", courseCode: "ME60353", section: "Autumn 2026-2027", room: "Room TBA", students: 22 }
  ],
  enrolledCourses: [],
  selectedCourseId: "soft401",
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
state.selectedCourseId = defaultState.courses.some(course => course.id === state.selectedCourseId)
  ? state.selectedCourseId
  : "soft401";
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
let courseRosters = new Map();
let managedCourseId = "";
let modalReturnFocus = null;
let selectedLoginRole = state.userRole || "faculty";
let authMode = state.accounts.length ? "login" : "signup";
const view = document.querySelector("#view");
const authRoot = document.querySelector("#authRoot");
const appShell = document.querySelector("#appShell");
const pageTitle = document.querySelector("#pageTitle");
const pageEyebrow = document.querySelector("#pageEyebrow");
const quickAction = document.querySelector("#quickAction");
const roleLabel = document.querySelector("#roleLabel");
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
    ready: "Restart ready",
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
  return state.courses.find(course => course.id === "soft401") || state.courses[0] || defaultState.courses[0];
}

function courseCapabilities(course = selectedCourse()) {
  return course?.capabilities || {};
}

function canManageCourse(course = selectedCourse()) {
  return Boolean(courseCapabilities(course).canManageCourse);
}

function canRunAttendance(course = selectedCourse()) {
  return Boolean(courseCapabilities(course).canRunAttendance);
}

function canPublishQuiz(course = selectedCourse()) {
  return Boolean(courseCapabilities(course).canPublishQuiz);
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
  courseRosters = new Map();
  activeAttendance = null;
  managedCourseId = "";
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
    description: "Join assigned courses by code, run attendance, and publish quizzes without changing course settings.",
    idLabel: "Verified TA email",
    placeholder: "ta@iitkgp.ac.in",
    initials: "TA",
    name: "Teaching Assistant"
  },
  student: {
    title: "Student login",
    shortTitle: "Student",
    description: "Join professor-owned courses by code, take quizzes, and view your calendar. Attendance is teaching-team managed.",
    idLabel: "Verified institute email",
    placeholder: "student@kgpian.iitkgp.ac.in",
    initials: "ST",
    name: "Student Demo"
  }
};

function renderLogin(role = selectedLoginRole, mode = authMode) {
  courseRosters = new Map();
  activeAttendance = null;
  managedCourseId = "";
  closeMenu();
  if (view) view.innerHTML = "";
  selectedLoginRole = loginProfiles[role] ? role : "faculty";
  authMode = mode === "login" ? "login" : "signup";
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
            <button type="button" class="${authMode === "login" ? "active" : ""}" data-auth-mode="login">Sign in</button>
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
            ${selectedLoginRole === "ta" ? `<label for="taInviteCode">TA invitation code</label><input id="taInviteCode" name="roleCode" type="password" placeholder="Provided by the course administrator" autocomplete="off" required />` : ""}
            <button class="btn btn-primary auth-submit" type="submit">${icon("i-arrow")} Create account & sign in</button>
          </form>
          <div class="auth-demo-note"><span>Institutional email required</span><p>Use an address ending in iitkgp.ac.in. No email OTP is required.</p></div>` : `
          <form id="loginForm" class="login-form">
            <input type="hidden" name="role" value="${selectedLoginRole}" />
            <label for="loginEmail">${profile.idLabel}</label>
            <input id="loginEmail" name="email" type="email" placeholder="${profile.placeholder}" autocomplete="username" required />
            <label for="loginPassword">Password</label>
            <input id="loginPassword" name="password" type="password" placeholder="Enter your password" autocomplete="current-password" minlength="8" required />
            <button class="btn btn-primary auth-submit" type="submit">${icon("i-arrow")} Sign in as ${profile.shortTitle}</button>
          </form>
          <div class="auth-demo-note"><span>Secure password sign-in</span><p>Use the email, password, and account role selected during sign-up.</p></div>`}
          <p class="auth-description" style="margin-top:18px"><a href="privacy.html" target="_blank" rel="noopener">Privacy policy</a> · <a href="delete-account.html" target="_blank" rel="noopener">Delete an account</a></p>
        </div>
      </section>
    </div>`;
  setTimeout(() => document.querySelector(authMode === "signup" ? "#signupName" : "#loginEmail")?.focus(), 0);
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
  applyAttendanceSnapshot(null);
  state.attendanceCheckedIn = false;
  applyQuizSnapshot(payload.quiz);
  persist();
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
  roleLabel.textContent = profile.label;
  profileAvatar.textContent = profile.initials;
  profileName.textContent = roleDisplayName(state.userRole, state.accountName || profile.name);
  profileMeta.textContent = profile.meta;
  if (menuAvatar) menuAvatar.textContent = profile.initials;
  if (menuName) menuName.textContent = profileName.textContent;
  if (menuMeta) menuMeta.textContent = state.authEmail || profile.meta;
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
  state.route = route;
  setNavigationState(route);
  render();
  persist();
  window.scrollTo({ top: 0, behavior: "smooth" });
  pageTitle.focus({ preventScroll: true });
}

function render() {
  if (!state.authenticated) return renderLogin(state.userRole);
  if (state.route === "dashboard") return renderDashboard();
  if (state.route === "schedule") return renderSchedule();
  if (state.route === "attendance") return renderAttendance();
  if (state.route === "quizzes") return renderQuiz();
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
  setHeader(`Good morning, ${roleDisplayName()}`, "MONDAY, 3 AUGUST");
  const attendanceLabel = courseAttendanceStatus === "complete" ? "Attendance recorded" : courseAttendanceStatus === "scanning" ? "Attendance in progress" : "Ready to begin";
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
              <span>${icon("i-clock")} 3:00 – 5:00 PM</span>
              <span>${icon("i-users")} ${course.students} students</span>
              <span>${icon("i-calendar")} ${escapeHtml(course.room || "Room TBA")}</span>
            </div>
          </div>
          <div class="hero-action">${canRunAttendance(course) ? `<button class="btn" data-action="open-dashboard-attendance" data-course-id="${escapeHtml(course.id)}">${icon("i-play")} ${courseAttendanceStatus === "not_started" ? "Take attendance" : "View attendance"}</button>` : `<span class="badge gray">Attendance unavailable</span>`}</div>
        </article>

        <div class="stat-grid">
          <article class="card stat">
            <div class="stat-top"><span class="stat-icon">${icon("i-users")}</span><span class="trend">↑ 2.4%</span></div>
            <div class="stat-value">91.2%</div><div class="stat-label">Average attendance</div>
          </article>
          <article class="card stat">
            <div class="stat-top"><span class="stat-icon green">${icon("i-check")}</span><span class="trend">This week</span></div>
            <div class="stat-value">8</div><div class="stat-label">Classes completed</div>
          </article>
          <article class="card stat">
            <div class="stat-top"><span class="stat-icon amber">${icon("i-quiz")}</span><span class="trend">76% avg.</span></div>
            <div class="stat-value">${state.quizPublished ? "4" : "3"}</div><div class="stat-label">Quick quizzes</div>
          </article>
        </div>

        <article class="card card-pad">
          <div class="section-head"><h2>Today’s classes</h2><button class="text-btn" data-route-link="classes">View schedule</button></div>
          <div class="class-list">
            ${classRow("3:00", "5:00 PM", course.name, `${course.courseCode} · ${course.section} · ${course.room}`, attendanceLabel, statusClass, canRunAttendance(course) ? "attendance" : "", course.id)}
          </div>
        </article>
      </div>

      <div class="right-stack">
        <article class="card date-card">
          <div class="date-top"><div><div class="date-day">Monday</div><div class="date-number">3</div></div><div class="date-month">August 2026</div></div>
          <div class="week-strip">
            <span class="selected">M<b>3</b></span><span>T<b>4</b></span><span>W<b>5</b></span><span>T<b>6</b></span><span>F<b>7</b></span><span>S<b>8</b></span><span>S<b>9</b></span>
          </div>
        </article>
        <article class="card card-pad">
          <div class="section-head"><h3>Recent activity</h3></div>
          <div class="activity-list">
            <div class="activity"><span class="activity-icon">${icon("i-check")}</span><div><strong>Attendance workspace ready</strong><p>${escapeHtml(course.name)} · ${escapeHtml(course.section)}</p></div><time>Now</time></div>
            <div class="activity"><span class="activity-icon purple">${icon("i-quiz")}</span><div><strong>Quiz publishing enabled</strong><p>${escapeHtml(course.name)}</p></div><time>Course team</time></div>
            <div class="activity"><span class="activity-icon">${icon("i-users")}</span><div><strong>${attendanceMatchesCourse ? `${coursePresentCount} of ${course.students} students present` : `${course.students} rostered students`}</strong><p>${escapeHtml(course.name)}</p></div><time>Latest</time></div>
          </div>
        </article>
      </div>
    </div>`;
}

function renderStudentDashboard() {
  setHeader(`Good morning, ${roleDisplayName()}`, "STUDENT DASHBOARD", false);
  const enrolled = state.courses.filter(course => state.enrolledCourses.includes(course.id));
  view.innerHTML = `
    <div class="left-stack">
      <section class="student-welcome">
        <h2>${enrolled.length ? "Your classroom is ready" : "Join your first course"}</h2>
        <p>${enrolled.length ? "Access your schedule, quick quizzes, and class updates. Attendance records are maintained by the course teaching team." : "Enter the private course code shared by your faculty. Course content is available only after enrollment."}</p>
        <button class="btn" data-route-link="${enrolled.length ? "schedule" : "classes"}">${icon(enrolled.length ? "i-calendar" : "i-plus")} ${enrolled.length ? "View my schedule" : "Join a course"}</button>
      </section>
      <div class="course-grid">
        ${enrolled.length ? enrolled.map(course => studentCourseCard(course)).join("") : `
          <article class="card empty-state" style="min-height:260px;grid-column:1/-1"><div><span class="empty-icon">${icon("i-calendar")}</span><h2>No courses yet</h2><p>Ask your faculty for the course join code, then enter it on the Courses page.</p><button class="btn btn-primary" data-route-link="classes">Enter join code</button></div></article>`}
      </div>
    </div>`;
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
          <button class="btn btn-primary" data-action="import-schedule">${icon("i-download")} Import CSV / ICS</button>
          <input id="scheduleFile" type="file" accept=".csv,.ics,text/csv,text/calendar" hidden />
        </div>
        <div class="security-note"><span class="lock">⌾</span><span>Your timetable file is parsed only in this browser and is not uploaded to CampusPulse.</span></div>` : ""}
      ${isStudent && !enrolled ? `<div class="security-note"><span class="lock">⌾</span><span>Ask the course professor for the private join code to unlock activities. Attendance remains teaching-team managed.</span></div>` : ""}
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
    <div class="course-footer"><span>${icon("i-users")} ${course.students} classmates</span><button class="text-btn" data-action="open-course-quiz" data-course-id="${escapeHtml(course.id)}">Open course</button></div>
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
  view.innerHTML = `
    <button class="back-btn" data-route-link="dashboard">${icon("i-back")} Back to overview</button>
    <div class="page-grid">
      <article class="card page-card">
        ${sessionHeading("Choose the official roster", "Attendance has not started yet", "amber")}
        ${stepper(1)}
        <div class="roster-picker">
          <label for="attendanceCourseSelect">Course roster</label>
          <select class="select" id="attendanceCourseSelect">
            ${availableCourses.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === course.id ? "selected" : ""}>${escapeHtml(item.courseCode)} · ${escapeHtml(item.name)} (${item.students})</option>`).join("")}
          </select>
          <div class="roster-source-card">
            <span class="student-avatar">${roster.length}</span>
            <div><strong>${escapeHtml(course.name)}</strong><p>${escapeHtml(course.courseCode)} · ${escapeHtml(course.section)} · ${roster.length} students</p></div>
            <span class="badge green">Official roster ready</span>
          </div>
        </div>
        <div class="security-note"><span class="lock">⌾</span><span>This list is visible only to the course-owning professor and enrolled teaching assistants. Each session stores a roster snapshot so marks stay linked to roll numbers.</span></div>
        <div class="setup-actions">
          <button class="btn" data-route-link="dashboard">Cancel</button>
          <button class="btn btn-primary" data-action="start-scan" ${roster.length ? "" : "disabled"}>${icon("i-play")} Take attendance</button>
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
  if (state.userRole === "faculty" && managedCourseId) return renderCourseRoster(managedCourseId);
  setHeader("My courses", "PROFESSOR WORKSPACE", false);
  view.innerHTML = `
    <article class="card page-card">
      <div class="section-head"><div><h2 style="margin:0 0 5px">Courses you own</h2><p class="stat-label">Only you can manage these courses, join codes, and official rosters.</p></div><button class="btn btn-primary" data-action="open-course-modal">${icon("i-plus")} Create course</button></div>
      <div class="course-grid">${state.courses.map(facultyCourseCard).join("")}</div>
    </article>
    ${weeklySchedule()}`;
}

function facultyCourseCard(course) {
  return `<article class="course-card">
    <div class="course-accent"></div><h3>${escapeHtml(course.name)}</h3><p>${escapeHtml(course.courseCode)} · ${escapeHtml(course.section)} · ${escapeHtml(course.room)}</p>
    <div class="course-code"><span>TA & student join code</span><strong>${escapeHtml(course.code)}</strong><button class="icon-btn" data-copy="${escapeHtml(course.code)}" aria-label="Copy join code">${icon("i-quiz")}</button></div>
    <div class="course-footer"><span>${icon("i-users")} ${Number(course.students) || 0} rostered students</span><button class="text-btn" data-action="view-course-roster" data-course-id="${escapeHtml(course.id)}">Manage roster</button></div>
  </article>`;
}

function renderCourseRoster(courseId) {
  const course = state.courses.find(item => item.id === courseId);
  const roster = courseRosters.get(courseId) || [];
  if (!course) {
    managedCourseId = "";
    return renderClasses();
  }
  setHeader(`${course.name} roster`, "PROFESSOR WORKSPACE", false);
  view.innerHTML = `
    <button class="back-btn" data-action="close-course-roster">${icon("i-back")} Back to courses</button>
    <article class="card page-card">
      <div class="section-head"><div><h2 style="margin:0 0 5px">Official student list</h2><p class="stat-label">${escapeHtml(course.courseCode)} · ${escapeHtml(course.section)} · active course roster</p></div><span class="badge green">${roster.length} students</span></div>
      <div class="roster-toolbar roster-search-toolbar">
        <label class="roster-search">${icon("i-users")}<input id="rosterSearch" type="search" placeholder="Search name or roll number" autocomplete="off" /></label>
        <div class="setup-actions"><button class="btn" data-action="choose-roster-upload">${icon("i-download")} Upload roster</button><button class="btn btn-primary" data-action="start-course-attendance" data-course-id="${escapeHtml(course.id)}" ${roster.length ? "" : "disabled"}>${icon("i-play")} Take attendance</button><input id="rosterUploadFile" type="file" accept=".csv,.json,text/csv,application/json" hidden /></div>
      </div>
      <div class="roster roster-scroll professor-roster" id="professorRoster">
        ${roster.map((student, index) => studentRow({ ...student, present: false }, index, false, true)).join("")}
      </div>
      <div class="security-note"><span class="lock">⌾</span><span>Only you can replace this official roster. Enrolled TAs may see its snapshot only while running attendance; students never receive it.</span></div>
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
        <div class="section-head"><div><h2 style="margin:0 0 5px">Enrolled TA courses</h2><p class="stat-label">You can run attendance and publish quizzes, but cannot change course settings, rosters, or join codes.</p></div><span class="badge purple">${state.courses.length} assigned</span></div>
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
      <p class="stat-label">Your faculty will share a private course code. You only need to join once.</p>
      <form class="join-code" id="joinForm"><div class="join-code-field"><label for="studentJoinCode">Private course code</label><input id="studentJoinCode" name="joinCode" maxlength="32" placeholder="Enter course code" autocomplete="off" required/></div><button class="btn btn-primary">Join course</button></form>
      ${enrolled.length ? `<div class="student-course-list"><div class="section-head"><h3>Courses joined</h3><span class="badge green">${enrolled.length} active</span></div>${enrolled.map(course => studentCourseCard(course)).join("")}</div>` : ""}
    </article>
    ${weeklySchedule()}
    </div>`;
}

function weeklySchedule() {
  const course = selectedCourse();
  if (!course) return "";
  const configured = state.backendSchedule.filter(item => item.courseId === course.id);
  const sessions = (configured.length ? configured : [{ day: "Class", start: "—", end: "—", topic: course.name, room: course.room }])
    .map(item => [String(item.day || "Class").slice(0, 3).toUpperCase(), item.start || "—", item.end || "—", item.topic || course.name, item.room || course.room]);
  return `<article class="card page-card">
    <div class="section-head"><div><h2 style="margin:0 0 5px">Weekly schedule</h2><p class="stat-label">${escapeHtml(course.name)} · ${escapeHtml(course.courseCode)} · ${escapeHtml(course.section)}</p></div><span class="badge purple">${icon("i-calendar")} ${sessions.length} sessions</span></div>
    <div class="class-list">
      ${sessions.map(([day, time, end, type, room]) => `<div class="class-row">
        <div class="time">${escapeHtml(day)}<small>${escapeHtml(time)}</small></div>
        <div class="course"><strong>${escapeHtml(type)}</strong><span>${escapeHtml(course.name)} · ${escapeHtml(room)}</span></div>
        <span class="badge gray">${escapeHtml(time)} – ${escapeHtml(end)}</span>
        ${canRunAttendance(course) ? `<button class="text-btn" data-route-link="attendance" data-course-id="${escapeHtml(course.id)}">Take attendance</button>` : `<span class="badge gray">Teaching-team attendance</span>`}
      </div>`).join("")}
    </div>
  </article>`;
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
          <div class="field full"><p class="stat-label">After creation, open the course to upload its official CSV or JSON roster. TA and student enrollment never changes that roster.</p></div>
        </div>
        <div class="setup-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn btn-primary">${icon("i-plus")} Create course</button></div>
      </form>
    </div>`;
  setTimeout(() => document.querySelector("#courseName")?.focus(), 0);
}

function openRoleModal() {
  modalReturnFocus = document.activeElement;
  document.querySelector("#modalRoot").innerHTML = `
    <div class="modal-backdrop" data-action="close-modal">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="roleModalTitle">
        <div class="modal-head"><div><h2 id="roleModalTitle">Switch account</h2><p>You will return to the secure role-specific login.</p></div><button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">${icon("i-close")}</button></div>
        <div class="role-options">
          ${roleOption("faculty", "PF", "Professor / Faculty", "Courses, rosters, quizzes, and attendance")}
          ${roleOption("ta", "TA", "Teaching Assistant", "Enroll, run attendance, and publish quizzes")}
          ${roleOption("student", "ST", "Student", "Join courses and participate in activities")}
        </div>
      </div>
    </div>`;
  setTimeout(() => document.querySelector(".role-option")?.focus(), 0);
}

function closeModal() {
  document.querySelector("#modalRoot").innerHTML = "";
  modalReturnFocus?.focus?.();
  modalReturnFocus = null;
}

function roleOption(role, initials, title, description) {
  return `<button class="role-option" data-switch-role="${role}"><span class="avatar">${initials}</span><span><strong>${title}</strong><span>${description}</span></span>${state.userRole === role ? icon("i-check") : icon("i-arrow")}</button>`;
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

function renderSettings() {
  setHeader("Settings", "CAMPUSPULSE", false);
  const updateState = updateManager?.state || { status: "unavailable" };
  view.innerHTML = `
    <div class="page-grid">
      <article class="card page-card">
        <div class="section-head"><div><h2 style="margin:0 0 5px">Backend connection</h2><p class="stat-label">Connect this device to the deployed CampusPulse API.</p></div><span class="badge ${backendConfigured() ? "green" : "amber"}">${backendConfigured() ? "Configured" : "Offline demo"}</span></div>
        <form id="apiSettingsForm" class="login-form" style="margin-top:22px">
          <label for="apiBaseUrl">API base URL</label>
          <input id="apiBaseUrl" name="apiBaseUrl" type="url" placeholder="https://your-api.example.com" value="${escapeHtml(API_BASE)}" />
          <div class="setup-actions"><button type="button" class="btn" data-action="clear-api-url">Disconnect API</button><button class="btn btn-primary" type="submit">${icon("i-cloud")} Save and reconnect</button></div>
        </form>
        <div class="security-note"><span class="lock">⌾</span><span>The Android app and web app use this HTTPS endpoint for accounts, course enrollment, attendance, and quizzes.</span></div>
      </article>
      <aside class="card page-card">
        <div class="section-head"><h3>Account & privacy</h3></div>
        <div class="summary-list"><div class="summary-item"><span>Mode</span><strong>${backendConfigured() ? "Persistent API" : "This-device prototype"}</strong></div><div class="summary-item"><span>Account session</span><strong>${apiToken ? "Signed in" : "Not connected"}</strong></div><div class="summary-item"><span>App version</span><strong>${APP_VERSION}</strong></div></div>
        <div class="setup-actions" style="margin-top:20px"><a class="btn" href="privacy.html" target="_blank" rel="noopener">Privacy policy</a><button class="btn" type="button" data-action="logout">Sign out</button><button class="btn btn-danger" type="button" data-action="delete-account">Delete my account</button></div>
      </aside>
      <article class="card page-card update-settings-card">
        <div class="section-head"><div><h2 style="margin:0 0 5px">App updates</h2><p id="webUpdateDetail" class="stat-label">${escapeHtml(updateState.message || "Updates are delivered with the website")}</p></div><span id="webUpdateStatus" class="badge ${updateState.status === "error" ? "amber" : "green"}">${updateStatusLabel(updateState.status)}</span></div>
        <p class="update-explainer">Web features, fixes, and styling are downloaded securely in the Android app and applied after a restart. Native Android changes still require a newly signed APK.</p>
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
  if (lines.length < 2) throw new Error("Roster CSV must include a header and at least one student");
  const headers = parseCSVRow(lines[0]).map(header => header.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const rollIndex = headers.findIndex(header => ["roll", "rollno", "rollnumber", "studentroll"].includes(header));
  const nameIndex = headers.findIndex(header => ["name", "studentname", "fullname"].includes(header));
  if (rollIndex < 0 || nameIndex < 0) throw new Error("Roster CSV needs roll number and name columns");
  return lines.slice(1).map(line => {
    const values = parseCSVRow(line);
    return { rollNumber: values[rollIndex], name: values[nameIndex] };
  });
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
  const switchButton = event.target.closest("[data-switch-role]");
  if (switchButton) {
    clearTimeout(quizTimer);
    if (backendConfigured() && apiToken) {
      try { await apiRequest("/api/auth/logout", { method: "POST" }); } catch {}
      apiToken = "";
      localStorage.removeItem("campusPulseApiToken");
    }
    clearSensitiveClientState({ clearImportedSchedule: true });
    state.authenticated = false;
    state.userRole = switchButton.dataset.switchRole;
    state.accountName = "";
    state.authEmail = "";
    state.route = "dashboard";
    authMode = "login";
    persist();
    document.querySelector("#modalRoot").innerHTML = "";
    modalReturnFocus = null;
    return renderLogin(state.userRole);
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
    if (!canManageCourse(course)) return toast("Only the course owner can manage this roster", "error");
    try {
      await loadCourseRoster(courseId);
    } catch (error) {
      return toast(error.message || "Could not load the course roster", "error");
    }
    managedCourseId = courseId;
    return renderClasses();
  }
  if (action === "close-course-roster") {
    managedCourseId = "";
    return renderClasses();
  }
  if (action === "choose-roster-upload") {
    const course = state.courses.find(item => item.id === managedCourseId);
    if (!canManageCourse(course)) return toast("Only the course owner can upload a roster", "error");
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
  if (action === "clear-api-url") {
    localStorage.setItem("campusPulseApiBase", "offline");
    localStorage.removeItem("campusPulseApiToken");
    clearSensitiveClientState({ clearImportedSchedule: true });
    state.authenticated = false;
    state.accountName = "";
    state.authEmail = "";
    persist();
    location.reload();
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
  if (event.target.id === "rosterUploadFile") {
    const file = event.target.files?.[0];
    const course = state.courses.find(item => item.id === managedCourseId);
    if (!file || !canManageCourse(course)) return;
    try {
      const students = parseRosterUpload(await file.text(), file.name);
      if (!window.confirm(`Replace the official ${course.courseCode} roster with ${students.length} uploaded students? Existing attendance snapshots will remain unchanged.`)) return;
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
document.querySelector("#roleSwitch").addEventListener("click", openRoleModal);

document.addEventListener("submit", async event => {
  event.preventDefault();
  if (event.target.id === "apiSettingsForm") {
    const value = String(new FormData(event.target).get("apiBaseUrl") || "").trim().replace(/\/+$/, "");
    if (value && !/^https:\/\//i.test(value) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(value)) {
      return toast("Use an HTTPS API URL", "error");
    }
    if (value) localStorage.setItem("campusPulseApiBase", value);
    else localStorage.setItem("campusPulseApiBase", "offline");
    localStorage.removeItem("campusPulseApiToken");
    clearSensitiveClientState({ clearImportedSchedule: true });
    state.authenticated = false;
    state.accountName = "";
    state.authEmail = "";
    persist();
    location.reload();
    return;
  }
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
        body: { role: data.role, name, email, password: data.password, roleCode: data.roleCode || undefined }
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
  if (event.target.id === "joinForm") {
    const code = new FormData(event.target).get("joinCode").trim().toUpperCase();
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
