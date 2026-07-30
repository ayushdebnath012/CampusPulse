const roster = [
  ["Student 01", "DEMO001"], ["Student 02", "DEMO002"], ["Student 03", "DEMO003"],
  ["Student 04", "DEMO004"], ["Student 05", "DEMO005"], ["Student 06", "DEMO006"],
  ["Student 07", "DEMO007"], ["Student 08", "DEMO008"], ["Student 09", "DEMO009"],
  ["Student 10", "DEMO010"], ["Student 11", "DEMO011"], ["Student 12", "DEMO012"]
];

const APP_VERSION = "6";

const defaultState = {
  route: "dashboard",
  userRole: "faculty",
  authenticated: false,
  accountName: "",
  attendanceStatus: "not_started",
  checks: { wifi: false, bluetooth: false },
  present: [],
  quizPublished: false,
  quizResponses: 0,
  erpStatus: "pending",
  courses: [
    { id: "soft401", code: "SC401A", name: "Soft Computing", courseCode: "CSE 401", section: "Section A", room: "Room 304", students: 42 }
  ],
  enrolledCourses: [],
  importedSchedule: []
};

let state = { ...defaultState, ...JSON.parse(localStorage.getItem("campusPulseState") || "{}") };
state.courses = defaultState.courses;
state.enrolledCourses = Array.isArray(state.enrolledCourses) && state.enrolledCourses.includes("soft401") ? ["soft401"] : [];
state.importedSchedule = Array.isArray(state.importedSchedule) ? state.importedSchedule : [];
state.authenticated = Boolean(state.authenticated);
let scanTimer;
let quizTimer;
let selectedLoginRole = state.userRole || "faculty";
const view = document.querySelector("#view");
const authRoot = document.querySelector("#authRoot");
const appShell = document.querySelector("#appShell");
const pageTitle = document.querySelector("#pageTitle");
const pageEyebrow = document.querySelector("#pageEyebrow");
const quickAction = document.querySelector("#quickAction");
const roleLabel = document.querySelector("#roleLabel");
const erpNav = document.querySelector("#erpNav");
const profileAvatar = document.querySelector("#profileAvatar");
const profileName = document.querySelector("#profileName");
const profileMeta = document.querySelector("#profileMeta");

function icon(id) {
  return `<svg aria-hidden="true"><use href="#${id}"/></svg>`;
}

function persist() {
  state.appVersion = APP_VERSION;
  localStorage.setItem("campusPulseState", JSON.stringify(state));
  document.querySelector("#syncDot").classList.toggle("visible", state.userRole === "faculty" && state.erpStatus === "pending" && state.attendanceStatus === "complete");
}

const loginProfiles = {
  faculty: {
    title: "Professor login",
    shortTitle: "Professor",
    description: "Manage Soft Computing, attendance, quizzes, and ERP uploads.",
    idLabel: "Faculty email or employee ID",
    placeholder: "professor@iitkgp.ac.in",
    initials: "PF",
    name: "Professor Demo"
  },
  ta: {
    title: "Teaching Assistant login",
    shortTitle: "TA",
    description: "Start attendance and update quizzes for assigned courses.",
    idLabel: "TA email or employee ID",
    placeholder: "ta@iitkgp.ac.in",
    initials: "TA",
    name: "Teaching Assistant"
  },
  student: {
    title: "Student login",
    shortTitle: "Student",
    description: "Join Soft Computing, check in, take quizzes, and view your calendar.",
    idLabel: "Institute email or roll number",
    placeholder: "22XX00000",
    initials: "ST",
    name: "Student Demo"
  }
};

function renderLogin(role = selectedLoginRole) {
  selectedLoginRole = loginProfiles[role] ? role : "faculty";
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
          <p>Proximity attendance, short quizzes, and a shared Soft Computing calendar for every member of the course team.</p>
        </div>
        <div class="auth-feature-row">
          <span>${icon("i-calendar")} Shared calendar</span>
          <span>${icon("i-wifi")} Wi-Fi + Bluetooth</span>
          <span>${icon("i-cloud")} Professor ERP export</span>
        </div>
      </section>
      <section class="auth-panel">
        <div class="auth-card">
          <div class="auth-heading">
            <span class="auth-icon">${profile.initials}</span>
            <div><p>Welcome to CampusPulse</p><h2>${profile.title}</h2></div>
          </div>
          <div class="auth-role-grid" role="tablist" aria-label="Choose login type">
            ${Object.entries(loginProfiles).map(([key, item]) => `
              <button type="button" class="auth-role ${key === selectedLoginRole ? "active" : ""}" data-auth-role="${key}" role="tab" aria-selected="${key === selectedLoginRole}">
                <span>${item.initials}</span><strong>${item.shortTitle}</strong>
              </button>`).join("")}
          </div>
          <p class="auth-description">${profile.description}</p>
          <form id="loginForm" class="login-form">
            <input type="hidden" name="role" value="${selectedLoginRole}" />
            <label for="loginId">${profile.idLabel}</label>
            <input id="loginId" name="loginId" type="text" placeholder="${profile.placeholder}" autocomplete="username" required />
            <label for="loginPassword">Password</label>
            <input id="loginPassword" name="password" type="password" placeholder="Enter your password" autocomplete="current-password" minlength="4" required />
            <button class="btn btn-primary auth-submit" type="submit">${icon("i-arrow")} Sign in as ${profile.shortTitle}</button>
          </form>
          <div class="auth-demo-note"><span>Prototype access</span><p>Use any ID and a password of 4+ characters. Passwords are never saved.</p></div>
        </div>
      </section>
    </div>`;
  setTimeout(() => document.querySelector("#loginId")?.focus(), 0);
}

function showApp() {
  authRoot.hidden = true;
  authRoot.innerHTML = "";
  appShell.hidden = false;
  render();
}

function toast(message) {
  const el = document.createElement("div");
  el.className = "toast success";
  el.textContent = message;
  document.querySelector("#toastRegion").append(el);
  setTimeout(() => el.remove(), 3200);
}

function setHeader(title, eyebrow, showQuick = true) {
  pageTitle.textContent = title;
  pageEyebrow.textContent = eyebrow;
  quickAction.style.display = showQuick ? "" : "none";
  const profiles = {
    faculty: { label: "Professor view", initials: "PF", name: "Professor Demo", meta: "Instructor · CSE" },
    ta: { label: "TA view", initials: "TA", name: "Teaching Assistant", meta: "Course team · CSE" },
    student: { label: "Student view", initials: "ST", name: "Student Demo", meta: "Student · CSE" }
  };
  const profile = profiles[state.userRole] || profiles.faculty;
  roleLabel.textContent = profile.label;
  profileAvatar.textContent = profile.initials;
  profileName.textContent = state.accountName || profile.name;
  profileMeta.textContent = profile.meta;
  erpNav.style.display = state.userRole === "faculty" ? "" : "none";
}

function navigate(route) {
  clearInterval(scanTimer);
  clearInterval(quizTimer);
  state.route = route;
  document.querySelectorAll(".nav-item").forEach(btn => btn.classList.toggle("active", btn.dataset.route === route));
  render();
  persist();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function render() {
  if (!state.authenticated) return renderLogin(state.userRole);
  if (state.route === "dashboard") return renderDashboard();
  if (state.route === "schedule") return renderSchedule();
  if (state.route === "attendance") return renderAttendance();
  if (state.route === "quizzes") return renderQuiz();
  if (state.route === "erp") return state.userRole === "faculty" ? renderERP() : renderRestrictedERP();
  return renderPlaceholder(state.route);
}

function renderDashboard() {
  if (state.userRole === "student") return renderStudentDashboard();
  setHeader(state.userRole === "ta" ? "Good morning, Teaching Assistant" : "Good morning, Faculty", "THURSDAY, 30 JULY");
  const attendanceLabel = state.attendanceStatus === "complete" ? "Attendance recorded" : state.attendanceStatus === "scanning" ? "Check-in is live" : "Ready to begin";
  const statusClass = state.attendanceStatus === "complete" ? "green" : "amber";
  view.innerHTML = `
    <div class="dashboard-grid">
      <div class="left-stack">
        <article class="hero-session">
          <div class="hero-copy">
            <span class="live-tag">NEXT CLASS · 10:00 AM</span>
            <h2>Soft Computing</h2>
            <p>CSE 401 · Section A</p>
            <div class="hero-meta">
              <span>${icon("i-clock")} 10:00 – 10:50 AM</span>
              <span>${icon("i-users")} 42 students</span>
              <span>${icon("i-calendar")} Room 304</span>
            </div>
          </div>
          <div class="hero-action"><button class="btn" data-action="attendance">${icon("i-play")} ${state.attendanceStatus === "complete" ? "View attendance" : "Start attendance"}</button></div>
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
            ${classRow("10:00", "10:50 AM", "Soft Computing", "CSE 401 · Section A · Room 304", attendanceLabel, statusClass, "attendance")}
          </div>
        </article>
      </div>

      <div class="right-stack">
        <article class="card date-card">
          <div class="date-top"><div><div class="date-day">Thursday</div><div class="date-number">30</div></div><div class="date-month">July 2026</div></div>
          <div class="week-strip">
            <span>M<b>27</b></span><span>T<b>28</b></span><span>W<b>29</b></span><span class="selected">T<b>30</b></span><span>F<b>31</b></span><span>S<b>1</b></span><span>S<b>2</b></span>
          </div>
        </article>
        <article class="card card-pad">
          <div class="section-head"><h3>Recent activity</h3><button class="icon-btn">${icon("i-more")}</button></div>
          <div class="activity-list">
            <div class="activity"><span class="activity-icon">${icon("i-check")}</span><div><strong>Attendance synced to ERP</strong><p>Soft Computing · Section A</p></div><time>9:14</time></div>
            <div class="activity"><span class="activity-icon purple">${icon("i-quiz")}</span><div><strong>Quiz results published</strong><p>Algorithms · Quiz 04</p></div><time>Wed</time></div>
            <div class="activity"><span class="activity-icon">${icon("i-users")}</span><div><strong>38 of 42 students present</strong><p>Soft Computing</p></div><time>Tue</time></div>
          </div>
        </article>
      </div>
    </div>`;
}

function renderStudentDashboard() {
  setHeader("Welcome back, Student", "STUDENT DASHBOARD", false);
  const enrolled = state.courses.filter(course => state.enrolledCourses.includes(course.id));
  view.innerHTML = `
    <div class="left-stack">
      <section class="student-welcome">
        <h2>${enrolled.length ? "Your classroom is ready" : "Join your first course"}</h2>
        <p>${enrolled.length ? "Access attendance check-ins, quick quizzes, and class updates from every course you have joined." : "Enter the private course code shared by your faculty. Course content is available only after enrollment."}</p>
        <button class="btn" data-route-link="${enrolled.length ? "schedule" : "classes"}">${icon(enrolled.length ? "i-calendar" : "i-plus")} ${enrolled.length ? "View my schedule" : "Join a course"}</button>
      </section>
      <div class="course-grid">
        ${enrolled.length ? enrolled.map(course => studentCourseCard(course)).join("") : `
          <article class="card empty-state" style="min-height:260px;grid-column:1/-1"><div><span class="empty-icon">${icon("i-calendar")}</span><h2>No courses yet</h2><p>Ask your faculty for a six-character join code, then enter it on the Courses page.</p><button class="btn btn-primary" data-route-link="classes">Enter join code</button></div></article>`}
      </div>
    </div>`;
}

function renderSchedule() {
  const isStudent = state.userRole === "student";
  const enrolled = state.enrolledCourses.includes("soft401");
  const imported = isStudent && state.importedSchedule.length > 0;
  const calendarDays = [
    ["MON", "27"], ["TUE", "28"], ["WED", "29"], ["THU", "30"], ["FRI", "31"], ["SAT", "1"], ["SUN", "2"]
  ];
  const defaultEvents = [
    { dayIndex: 1, day: "Tuesday", date: "28 Jul", start: "10:00 AM", end: "11:00 AM", topic: "Foundations of Soft Computing", room: "Room 304", status: "Completed" },
    { dayIndex: 3, day: "Thursday", date: "30 Jul", start: "10:00 AM", end: "10:50 AM", topic: "Fuzzy Sets & Membership", room: "Room 304", status: "Today", today: true },
    { dayIndex: 5, day: "Saturday", date: "1 Aug", start: "09:00 AM", end: "10:00 AM", topic: "Neural Network Models", room: "Room 304", status: "Upcoming" }
  ];
  const importedEvents = state.importedSchedule.map((item, index) => ({
    ...item,
    dayIndex: dayIndexFromName(item.day),
    status: index === 0 ? "Next" : "Upcoming",
    today: index === 0
  })).filter(item => item.dayIndex >= 0);
  const events = imported && importedEvents.length ? importedEvents : defaultEvents;
  const roleName = state.userRole === "faculty" ? "Professor" : state.userRole === "ta" ? "Teaching Assistant" : "Student";
  setHeader("Schedule calendar", `${roleName.toUpperCase()} TIMETABLE`, false);
  view.innerHTML = `
    <article class="card page-card calendar-page">
      <div class="calendar-titlebar">
        <div><span class="calendar-kicker">${icon("i-calendar")} WEEK CALENDAR</span><h2>${imported ? "My ERP timetable" : "27 July – 2 August 2026"}</h2><p>${imported ? "Imported locally from your timetable file" : "Soft Computing · CSE 401 · Section A"}</p></div>
        <div class="calendar-title-actions"><span class="badge ${imported ? "green" : "purple"}">${imported ? "ERP file imported" : `${roleName} view`}</span><button class="btn btn-soft" data-action="calendar-today">Today</button></div>
      </div>
      <div class="calendar-scroll" aria-label="Weekly class calendar">
        <div class="calendar-board">
          <div class="calendar-days"><span class="calendar-zone">IST</span>${calendarDays.map(([day, date], index) => `<span class="${index === 3 ? "is-today" : ""}"><small>${day}</small><strong>${date}</strong></span>`).join("")}</div>
          <div class="calendar-body">
            <div class="calendar-times">${["8 AM", "9 AM", "10 AM", "11 AM", "12 PM", "1 PM", "2 PM", "3 PM", "4 PM", "5 PM"].map(time => `<span>${time}</span>`).join("")}</div>
            <div class="calendar-lanes">
              ${calendarDays.map((_, index) => `<div class="calendar-lane ${index === 3 ? "is-today" : ""}">${events.filter(event => event.dayIndex === index).map(event => calendarEvent(event)).join("")}</div>`).join("")}
            </div>
          </div>
        </div>
      </div>
      <div class="calendar-agenda">
        <div class="section-head"><div><h3>Class agenda</h3><p class="stat-label">All scheduled sessions for this week</p></div><span class="badge gray">${events.length} sessions</span></div>
        <div class="schedule-week">${events.map(event => scheduleDay(event, isStudent, enrolled)).join("")}</div>
      </div>
      ${isStudent ? `
        <div class="setup-actions">
          ${imported ? `<button class="btn btn-danger" data-action="clear-imported-schedule">Clear imported schedule</button>` : ""}
          <a class="btn" href="https://erp.iitkgp.ac.in/IIT_ERP3/home.htm" target="_blank" rel="noopener noreferrer">${icon("i-cloud")} Open IIT KGP ERP</a>
          <button class="btn btn-primary" data-action="import-schedule">${icon("i-download")} Import CSV / ICS</button>
          <input id="scheduleFile" type="file" accept=".csv,.ics,text/csv,text/calendar" hidden />
        </div>
        <div class="security-note"><span class="lock">⌾</span><span>Your timetable file is parsed only in this browser. CampusPulse never receives your ERP password or session cookie.</span></div>` : ""}
      ${isStudent && !enrolled ? `<div class="security-note"><span class="lock">⌾</span><span>Join Soft Computing with code <strong>SC401A</strong> to unlock attendance and quiz activities. The calendar remains visible to everyone.</span></div>` : ""}
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
    <strong>${event.topic}</strong><span>${event.start} · ${event.room || "Room TBA"}</span>
  </article>`;
}

function scheduleDay(event, isStudent, enrolled) {
  const action = event.today
    ? isStudent
      ? `<button class="btn ${enrolled ? "btn-soft" : ""}" data-route-link="${enrolled ? "attendance" : "classes"}">${icon(enrolled ? "i-wifi" : "i-plus")} ${enrolled ? "View check-in" : "Join course"}</button>`
      : `<button class="btn btn-primary" data-route-link="attendance">${icon("i-play")} Start attendance</button>`
    : `<span class="badge ${event.status === "Completed" ? "green" : "gray"}">${event.status}</span>`;
  return `<div class="schedule-day ${event.today ? "today" : ""}">
    <div class="schedule-date"><strong>${event.day}</strong><span>${event.date}</span></div>
    <div class="schedule-time"><strong>${event.start}</strong><span>${event.end}</span></div>
    <div class="schedule-info"><strong>${event.topic}</strong><span>Soft Computing · CSE 401 · ${event.room || "Room TBA"}</span></div>
    <div class="schedule-action">${action}</div>
  </div>`;
}

function studentCourseCard(course) {
  return `<article class="course-card">
    <div class="course-accent"></div><span class="badge green">Enrolled</span>
    <h3 style="margin-top:12px">${course.name}</h3><p>${course.courseCode} · ${course.section} · ${course.room}</p>
    <div class="course-footer"><span>${icon("i-users")} ${course.students} classmates</span><button class="text-btn" data-route-link="quizzes">Open course</button></div>
  </article>`;
}

function classRow(time, suffix, title, meta, badge, color, route) {
  return `<div class="class-row">
    <div class="time">${time}<small>${suffix}</small></div>
    <div class="course"><strong>${title}</strong><span>${meta}</span></div>
    <span class="badge ${color}">${badge}</span>
    <button class="chevron" data-route-link="${route}" aria-label="Open ${title}">${icon("i-arrow")}</button>
  </div>`;
}

function renderAttendance() {
  if (state.userRole === "student") return renderStudentAttendanceAccess();
  setHeader("Attendance session", "SOFT COMPUTING · CSE 401", false);
  if (state.attendanceStatus === "not_started") return renderAttendanceSetup();
  return renderLiveAttendance();
}

function renderStudentAttendanceAccess() {
  setHeader("Class check-in", "STUDENT ACCESS", false);
  const hasAccess = state.enrolledCourses.includes("soft401");
  view.innerHTML = hasAccess ? `
    <button class="back-btn" data-route-link="dashboard">${icon("i-back")} Back to dashboard</button>
    <article class="card join-panel">
      <div class="setup-radar">${icon("i-bluetooth")}</div><span class="badge green">Course access verified</span>
      <h2 style="margin:15px 0 7px">Soft Computing check-in</h2>
      <p class="stat-label">When your faculty opens attendance, keep Bluetooth and internet on. CampusPulse will verify that your device is inside the classroom.</p>
      <button class="btn btn-primary" style="margin-top:20px" ${state.attendanceStatus === "scanning" ? "" : "disabled"}>${icon("i-wifi")} ${state.attendanceStatus === "scanning" ? "Verify my presence" : "Waiting for faculty"}</button>
    </article>` : `
    <article class="card empty-state"><div><span class="empty-icon">${icon("i-users")}</span><h2>Join the course first</h2><p>Attendance check-in is available only to students enrolled in Soft Computing.</p><button class="btn btn-primary" data-route-link="classes">Join with course code</button></div></article>`;
}

function renderAttendanceSetup() {
  const ready = state.checks.wifi && state.checks.bluetooth;
  view.innerHTML = `
    <button class="back-btn" data-route-link="dashboard">${icon("i-back")} Back to overview</button>
    <div class="page-grid">
      <article class="card page-card">
        ${sessionHeading("Ready your classroom", "Attendance has not started yet", "amber")}
        ${stepper(1)}
        <div class="setup-hero">
          <div class="setup-radar">${icon("i-bluetooth")}</div>
          <h3>Verify classroom proximity</h3>
          <p>Students are checked in only when both the classroom Wi‑Fi and the secure Bluetooth beacon are detected.</p>
        </div>
        <div class="check-grid">
          <button class="device-check ${state.checks.wifi ? "ready" : ""}" data-check="wifi">
            <span class="device-icon">${icon("i-wifi")}</span><span><strong>Campus Wi‑Fi</strong><span>${state.checks.wifi ? "Connected · CAMPUS_SECURE" : "Tap to verify connection"}</span></span><span class="checkmark">${icon("i-check")}</span>
          </button>
          <button class="device-check ${state.checks.bluetooth ? "ready" : ""}" data-check="bluetooth">
            <span class="device-icon">${icon("i-bluetooth")}</span><span><strong>Bluetooth beacon</strong><span>${state.checks.bluetooth ? "Ready · Room 304" : "Tap to enable beacon"}</span></span><span class="checkmark">${icon("i-check")}</span>
          </button>
        </div>
        <div class="setup-actions">
          <button class="btn" data-route-link="dashboard">Cancel</button>
          <button class="btn btn-primary" data-action="start-scan" ${ready ? "" : "disabled"}>${icon("i-play")} Open check-in</button>
        </div>
      </article>
      ${attendanceSidePanel(0)}
    </div>`;
}

function sessionHeading(title, subtitle, color) {
  return `<div class="session-title"><div><h2>${title}</h2><p>${subtitle} · Room 304 · 10:00–10:50 AM</p></div><span class="badge ${color}">${state.attendanceStatus === "complete" ? "Completed" : state.attendanceStatus === "scanning" ? "Live now" : "Setup"}</span></div>`;
}

function stepper(current) {
  return `<div class="stepper"><div class="step ${current === 1 ? "active" : current > 1 ? "done" : ""}">1. Device check</div><div class="step ${current === 2 ? "active" : current > 2 ? "done" : ""}">2. Student check-in</div><div class="step ${current === 3 ? "active" : ""}">3. Review & sync</div></div>`;
}

function attendanceSidePanel(count) {
  const percent = Math.round((count / 42) * 100);
  return `<aside class="card page-card">
    <div class="section-head"><h3>Session summary</h3><span class="badge purple">CSE 401</span></div>
    <div class="summary-ring" style="--progress:${percent}%"><div><strong>${count}</strong><span>of 42 checked in</span></div></div>
    <div class="summary-list">
      <div class="summary-item"><span>Present</span><strong>${count}</strong></div>
      <div class="summary-item"><span>Not checked in</span><strong>${42 - count}</strong></div>
      <div class="summary-item"><span>Flagged</span><strong>0</strong></div>
      <div class="summary-item"><span>Started at</span><strong>${state.attendanceStatus === "not_started" ? "—" : "10:00 AM"}</strong></div>
    </div>
    <div class="security-note"><span class="lock">⌾</span><span>Presence is validated using two signals. No location history is retained after the session.</span></div>
  </aside>`;
}

function renderLiveAttendance() {
  const complete = state.attendanceStatus === "complete";
  const count = state.present.length;
  view.innerHTML = `
    <button class="back-btn" data-route-link="dashboard">${icon("i-back")} Back to overview</button>
    <div class="page-grid">
      <article class="card page-card">
        ${sessionHeading(complete ? "Review attendance" : "Student check-in", complete ? "Session closed and ready for sync" : "Students are joining now", complete ? "green" : "purple")}
        ${stepper(complete ? 3 : 2)}
        <div class="roster-toolbar">
          <div class="scan-status">${complete ? icon("i-check") + " Check-in closed" : '<span class="pulse"></span> Scanning for nearby students'}</div>
          <span class="badge ${complete ? "green" : "purple"}">${count} present</span>
        </div>
        <div class="roster">
          ${roster.map((student, i) => studentRow(student, i, i < count)).join("")}
        </div>
        <div class="setup-actions">
          ${complete ? `<button class="btn" data-action="download">${icon("i-download")} Export CSV</button>${state.userRole === "faculty" ? `<button class="btn btn-primary" data-route-link="erp">${icon("i-cloud")} Review ERP sync</button>` : ""}` : `<button class="btn btn-danger" data-action="end-session">End check-in</button>`}
        </div>
      </article>
      ${attendanceSidePanel(count)}
    </div>`;

  if (!complete && count < roster.length) {
    scanTimer = setInterval(() => {
      const remaining = roster.filter((_, i) => !state.present.includes(i));
      if (!remaining.length) return clearInterval(scanTimer);
      const nextIndex = roster.indexOf(remaining[0]);
      state.present.push(nextIndex);
      persist();
      renderLiveAttendance();
      toast(`${roster[nextIndex][0]} checked in`);
    }, 1500);
  }
}

function studentRow(student, index, present) {
  const initials = student[0].split(" ").map(n => n[0]).join("");
  return `<div class="student-row">
    <span class="student-avatar">${initials}</span>
    <div class="student-name"><strong>${student[0]}</strong><span>${student[1]}</span></div>
    <span class="signal ${present ? (index % 4 === 0 ? "mid" : "good") : ""}"><i></i><i></i><i></i><i></i></span>
    <span class="badge ${present ? "green" : "gray"}">${present ? "Present" : "Waiting"}</span>
  </div>`;
}

function renderQuiz() {
  if (state.userRole === "student") return renderStudentQuizAccess();
  setHeader("Quick quiz", "SOFT COMPUTING · CSE 401", false);
  if (state.quizPublished) return renderLiveQuiz();
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
        <label for="quizTitle">Quiz title</label><input class="text-input" id="quizTitle" value="Concept check · Relations & Trees" />
        <label for="duration">Time limit</label><select class="select" id="duration"><option>3 minutes</option><option>5 minutes</option><option>No limit</option></select>
        <label for="reveal">Results</label><select class="select" id="reveal"><option>Reveal after quiz ends</option><option>Reveal after each answer</option><option>Keep private</option></select>
        <div class="security-note"><span class="lock">✦</span><span>Quiz responses are linked to the active class roster and included in the ERP export.</span></div>
      </aside>
    </div>`;
}

function renderStudentQuizAccess() {
  setHeader("Course activities", "STUDENT ACCESS", false);
  const hasAccess = state.enrolledCourses.includes("soft401");
  view.innerHTML = hasAccess ? `
    <button class="back-btn" data-route-link="dashboard">${icon("i-back")} Back to dashboard</button>
    <div class="page-grid">
      <article class="card page-card">
        <div class="session-title"><div><h2>Soft Computing</h2><p>CSE 401 · Section A</p></div><span class="badge green">Enrolled</span></div>
        <div class="question-card" style="margin-top:20px"><div class="section-head"><div><h3>Concept check · Relations & Trees</h3><p class="stat-label" style="margin-top:5px">2 questions · 3 minutes</p></div><span class="badge ${state.quizPublished ? "purple" : "gray"}">${state.quizPublished ? "Available now" : "Not started"}</span></div>
        <button class="btn btn-primary" ${state.quizPublished ? "" : "disabled"}>${icon("i-play")} Start quiz</button></div>
      </article>
      <aside class="card page-card"><div class="section-head"><h3>Your access</h3><span class="badge green">Verified</span></div><div class="summary-list"><div class="summary-item"><span>Enrollment</span><strong>Active</strong></div><div class="summary-item"><span>Course</span><strong>CSE 401</strong></div><div class="summary-item"><span>Attendance eligibility</span><strong>Enabled</strong></div></div><div class="security-note"><span class="lock">⌾</span><span>You can access these activities because you joined this course with its private code.</span></div></aside>
    </div>` : `
    <article class="card empty-state"><div><span class="empty-icon">${icon("i-quiz")}</span><h2>Course access required</h2><p>Join Soft Computing before opening its quizzes or attendance check-ins.</p><button class="btn btn-primary" data-route-link="classes">Join a course</button></div></article>`;
}

function questionBlock(number, question, options, answer) {
  return `<div class="question-card">
    <div class="question-top"><span class="q-number">${number}</span><input value="${question}" aria-label="Question ${number}" /><button class="icon-btn" aria-label="Question options">${icon("i-more")}</button></div>
    <div class="options">${options.map((opt, i) => `<label class="option-input"><input type="radio" name="q${number}" ${i === answer ? "checked" : ""}/><input type="text" value="${opt}" aria-label="Option ${i + 1}" /></label>`).join("")}</div>
  </div>`;
}

function renderLiveQuiz() {
  const responses = state.quizResponses;
  const percentage = Math.round((responses / 42) * 100);
  view.innerHTML = `
    <button class="back-btn" data-route-link="dashboard">${icon("i-back")} Back to overview</button>
    <div class="page-grid">
      <article class="card page-card">
        <div class="session-title"><div><h2>Concept check · Relations & Trees</h2><p>2 questions · 3 minute limit</p></div><span class="badge green">Live now</span></div>
        <div class="quiz-live">
          <div class="response-count">${responses}</div><p class="stat-label">of 42 students responded</p>
          <div class="response-track"><span style="width:${percentage}%"></span></div>
          <p class="stat-label">${percentage}% response rate</p>
        </div>
        <div class="question-card"><div class="section-head"><h3>Live response mix</h3><span class="badge purple">Question 1 of 2</span></div>
          ${resultBar("Reflexive only", 12, "#d88b1d")}
          ${resultBar("Symmetric only", 7, "#9b9cac")}
          ${resultBar("Reflexive, symmetric & transitive", 68, "#169b73")}
          ${resultBar("Transitive only", 13, "#d85555")}
        </div>
        <div class="setup-actions"><button class="btn btn-danger" data-action="end-quiz">End quiz</button></div>
      </article>
      <aside class="card page-card">
        <div class="section-head"><h3>Response quality</h3></div>
        <div class="summary-ring" style="--progress:68%"><div><strong>68%</strong><span>correct</span></div></div>
        <div class="summary-list"><div class="summary-item"><span>Average response time</span><strong>18 sec</strong></div><div class="summary-item"><span>Questions</span><strong>2</strong></div><div class="summary-item"><span>Time remaining</span><strong>01:42</strong></div></div>
      </aside>
    </div>`;
  if (responses < 38) {
    quizTimer = setInterval(() => {
      state.quizResponses = Math.min(38, state.quizResponses + Math.ceil(Math.random() * 3));
      persist(); renderLiveQuiz();
    }, 1800);
  }
}

function resultBar(label, value, color) {
  return `<div style="margin-top:12px"><div class="summary-item"><span>${label}</span><strong>${value}%</strong></div><div class="response-track" style="height:6px;margin-top:6px"><span style="width:${value}%;background:${color}"></span></div></div>`;
}

function renderERP() {
  if (state.userRole !== "faculty") return renderRestrictedERP();
  setHeader("ERP sync center", "CAMPUS RECORDS");
  const hasSession = state.attendanceStatus === "complete";
  view.innerHTML = `
    <div class="page-grid">
      <article class="card page-card">
        <div class="section-head"><div><h2 style="margin:0 0 5px">Attendance upload</h2><p class="stat-label">Prepare the attendance file, then upload it through the official IIT KGP ERP.</p></div><span class="badge ${hasSession ? "amber" : "green"}">${hasSession ? "Ready to export" : "No pending class"}</span></div>
        ${hasSession ? `
          <div class="sync-record">
            <span class="sync-symbol">${icon("i-cloud")}</span>
            <div><strong>Soft Computing · 30 Jul 2026</strong><p>${state.present.length} present · ${42 - state.present.length} absent · Quiz ${state.quizPublished ? "included" : "not included"}</p></div>
            <button class="btn btn-primary" data-action="prepare-erp-upload">${icon("i-download")} Download CSV</button>
          </div>` : `
          <div class="empty-state"><div><span class="empty-icon">${icon("i-cloud")}</span><h2>No records waiting</h2><p>Complete an attendance session and it will appear here for review and upload.</p><button class="btn btn-primary" data-route-link="attendance">Start attendance</button></div></div>`}
      </article>
      <aside class="card page-card">
        <div class="section-head"><h3>IIT KGP ERP</h3><span class="badge amber">Manual upload</span></div>
        <div class="summary-list">
          <div class="summary-item"><span>Provider</span><strong>IIT Kharagpur ERP</strong></div>
          <div class="summary-item"><span>Access</span><strong>Professor only</strong></div>
          <div class="summary-item"><span>Mode</span><strong>CSV export + manual upload</strong></div>
        </div>
        <a class="btn btn-soft" style="width:100%;margin-top:18px" href="https://erp.iitkgp.ac.in/IIT_ERP3/home.htm" target="_blank" rel="noopener noreferrer">${icon("i-cloud")} Open official ERP</a>
        <div class="security-note"><span class="lock">⌾</span><span>CampusPulse does not store professor ERP credentials. Direct upload can be enabled later with an institute-approved API.</span></div>
      </aside>
    </div>`;
}

function renderRestrictedERP() {
  setHeader("ERP access restricted", "FACULTY ONLY", false);
  view.innerHTML = `<article class="card empty-state"><div><span class="empty-icon">${icon("i-cloud")}</span><h2>Professor access required</h2><p>Only the course professor can review or sync attendance and quiz records with the ERP.</p><button class="btn btn-primary" data-route-link="dashboard">Back to dashboard</button></div></article>`;
}

function renderClasses() {
  if (state.userRole === "student") return renderStudentClasses();
  const isTA = state.userRole === "ta";
  setHeader(isTA ? "Courses you assist" : "My courses", isTA ? "TEACHING ASSISTANT WORKSPACE" : "FACULTY WORKSPACE", false);
  view.innerHTML = `
    <article class="card page-card">
      <div class="section-head"><div><h2 style="margin:0 0 5px">${isTA ? "Assigned course" : "Course you teach"}</h2><p class="stat-label">${isTA ? "You can run attendance and update live quizzes for this course." : "Soft Computing is the only active course in this prototype."}</p></div><span class="badge ${isTA ? "purple" : "green"}">${isTA ? "TA access" : "1 active course"}</span></div>
      <div class="course-grid">${state.courses.map(facultyCourseCard).join("")}</div>
    </article>
    ${weeklySchedule()}`;
}

function facultyCourseCard(course) {
  return `<article class="course-card">
    <div class="course-accent"></div><h3>${course.name}</h3><p>${course.courseCode} · ${course.section} · ${course.room}</p>
    <div class="course-code"><span>Student join code</span><strong>${course.code}</strong><button class="icon-btn" data-copy="${course.code}" aria-label="Copy join code">${icon("i-quiz")}</button></div>
    <div class="course-footer"><span>${icon("i-users")} ${course.students} students joined</span><button class="text-btn">Manage</button></div>
  </article>`;
}

function renderStudentClasses() {
  setHeader("Join a course", "STUDENT WORKSPACE", false);
  const enrolled = state.courses.filter(course => state.enrolledCourses.includes(course.id));
  view.innerHTML = `
    <div class="left-stack">
    <article class="card join-panel">
      <span class="empty-icon">${icon("i-plus")}</span><h2>Enter your course code</h2>
      <p class="stat-label">Your faculty will share a six-character code. You only need to join once.</p>
      <form class="join-code" id="joinForm"><input name="joinCode" maxlength="8" placeholder="e.g. SC401A" autocomplete="off" required/><button class="btn btn-primary">Join course</button></form>
      ${enrolled.length ? `<div class="student-course-list"><div class="section-head"><h3>Courses joined</h3><span class="badge green">${enrolled.length} active</span></div>${enrolled.map(course => studentCourseCard(course)).join("")}</div>` : ""}
    </article>
    ${weeklySchedule()}
    </div>`;
}

function weeklySchedule() {
  const sessions = [
    ["TUE", "10:00", "11:00 AM", "Foundations of Soft Computing", "Room 304"],
    ["THU", "10:00", "10:50 AM", "Fuzzy Sets & Membership", "Room 304"],
    ["SAT", "09:00", "10:00 AM", "Neural Network Models", "Room 304"]
  ];
  return `<article class="card page-card">
    <div class="section-head"><div><h2 style="margin:0 0 5px">Weekly schedule</h2><p class="stat-label">Soft Computing · CSE 401 · Section A</p></div><span class="badge purple">${icon("i-calendar")} 3 sessions</span></div>
    <div class="class-list">
      ${sessions.map(([day, time, end, type, room]) => `<div class="class-row">
        <div class="time">${day}<small>${time}</small></div>
        <div class="course"><strong>${type}</strong><span>Soft Computing · ${room}</span></div>
        <span class="badge gray">${time} – ${end}</span>
        <button class="chevron" data-route-link="attendance" aria-label="Open ${day} session">${icon("i-arrow")}</button>
      </div>`).join("")}
    </div>
  </article>`;
}

function openCourseModal() {
  document.querySelector("#modalRoot").innerHTML = `
    <div class="modal-backdrop" data-action="close-modal">
      <form class="modal" id="courseForm">
        <div class="modal-head"><div><h2>Add a new course</h2><p>Students will use the generated code to enroll.</p></div><button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">${icon("i-close")}</button></div>
        <div class="field-grid">
          <div class="field full"><label for="courseName">Course name</label><input id="courseName" name="name" placeholder="e.g. Computer Networks" required /></div>
          <div class="field"><label for="courseCode">Course code</label><input id="courseCode" name="courseCode" placeholder="CSE 308" required /></div>
          <div class="field"><label for="section">Section</label><input id="section" name="section" placeholder="Section A" required /></div>
          <div class="field"><label for="room">Classroom</label><input id="room" name="room" placeholder="Room 205" required /></div>
          <div class="field"><label for="capacity">Class strength</label><input id="capacity" name="students" type="number" min="1" max="300" value="40" required /></div>
        </div>
        <div class="setup-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn btn-primary">${icon("i-plus")} Create course</button></div>
      </form>
    </div>`;
  setTimeout(() => document.querySelector("#courseName")?.focus(), 0);
}

function openRoleModal() {
  document.querySelector("#modalRoot").innerHTML = `
    <div class="modal-backdrop" data-action="close-modal">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="roleModalTitle">
        <div class="modal-head"><div><h2 id="roleModalTitle">Switch account</h2><p>You will return to the secure role-specific login.</p></div><button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">${icon("i-close")}</button></div>
        <div class="role-options">
          ${roleOption("faculty", "PF", "Professor / Faculty", "Courses, quizzes, attendance, and ERP")}
          ${roleOption("ta", "TA", "Teaching Assistant", "Update quizzes and start attendance")}
          ${roleOption("student", "ST", "Student", "Join courses and participate in activities")}
        </div>
      </div>
    </div>`;
}

function roleOption(role, initials, title, description) {
  return `<button class="role-option" data-switch-role="${role}"><span class="avatar">${initials}</span><span><strong>${title}</strong><span>${description}</span></span>${state.userRole === role ? icon("i-check") : icon("i-arrow")}</button>`;
}

function renderPlaceholder(route) {
  if (route === "classes") return renderClasses();
  const config = {
    classes: ["Classes", "Manage your timetable", "i-calendar"],
    settings: ["Settings", "Configure campus network, Bluetooth beacons, and ERP access.", "i-settings"]
  }[route] || ["Coming soon", "This workspace is ready for its next module.", "i-grid"];
  setHeader(config[0], "CAMPUSPULSE");
  view.innerHTML = `<article class="card empty-state"><div><span class="empty-icon">${icon(config[2])}</span><h2>${config[0]}</h2><p>${config[1]}</p><button class="btn btn-primary" data-route-link="dashboard">Back to overview</button></div></article>`;
}

async function verifyDevice(type) {
  if (type === "wifi") {
    if (!navigator.onLine) return toast("Connect to a network, then try again");
    state.checks.wifi = true;
    toast("Campus Wi‑Fi connection verified");
  } else {
    if (navigator.bluetooth?.requestDevice) {
      try {
        await navigator.bluetooth.requestDevice({ acceptAllDevices: true });
      } catch (error) {
        if (error.name === "NotFoundError") return;
      }
    }
    state.checks.bluetooth = true;
    toast(navigator.bluetooth ? "Bluetooth beacon ready" : "Bluetooth ready in prototype mode");
  }
  persist();
  renderAttendanceSetup();
}

function downloadCSV() {
  const rows = [["Student", "Roll Number", "Status"], ...roster.map((s, i) => [...s, state.present.includes(i) ? "Present" : "Absent"])];
  const blob = new Blob([rows.map(r => r.join(",")).join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "CSE401-soft-computing-attendance-2026-07-30.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

function downloadERPAttendance() {
  const rows = [
    ["COURSE_CODE", "COURSE_NAME", "LECTURE_DATE", "ROLL_NUMBER", "STUDENT_NAME", "STATUS"],
    ...roster.map((student, index) => ["CSE401", "Soft Computing", "2026-07-30", student[1], student[0], state.present.includes(index) ? "P" : "A"])
  ];
  const csv = rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "IITKGP-CSE401-attendance-2026-07-30.csv";
  link.click();
  URL.revokeObjectURL(link.href);
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
      date: get(values, "date") || "ERP",
      start: get(values, "start", "start_time", "time") || "—",
      end: get(values, "end", "end_time") || "—",
      topic: get(values, "course", "subject", "topic", "summary") || "Scheduled class",
      room: get(values, "room", "location", "venue") || "Room TBA"
    };
  }).filter(item => item.topic);
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

document.addEventListener("click", event => {
  const authRole = event.target.closest("[data-auth-role]");
  if (authRole) return renderLogin(authRole.dataset.authRole);
  const switchButton = event.target.closest("[data-switch-role]");
  if (switchButton) {
    state.authenticated = false;
    state.userRole = switchButton.dataset.switchRole;
    state.accountName = "";
    state.route = "dashboard";
    persist();
    document.querySelector("#modalRoot").innerHTML = "";
    return renderLogin(state.userRole);
  }
  const copyButton = event.target.closest("[data-copy]");
  if (copyButton) {
    navigator.clipboard?.writeText(copyButton.dataset.copy);
    return toast(`Join code ${copyButton.dataset.copy} copied`);
  }
  const routeButton = event.target.closest("[data-route], [data-route-link]");
  if (routeButton) return navigate(routeButton.dataset.route || routeButton.dataset.routeLink);
  const check = event.target.closest("[data-check]");
  if (check) return verifyDevice(check.dataset.check);
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!action) return;

  if (action === "open-course-modal") openCourseModal();
  if (action === "close-modal") {
    const isBackdropClick = event.target.classList.contains("modal-backdrop");
    const isCloseButton = Boolean(event.target.closest("button[data-action='close-modal']"));
    if (isBackdropClick || isCloseButton) document.querySelector("#modalRoot").innerHTML = "";
  }
  if (action === "attendance") navigate("attendance");
  if (action === "start-scan") {
    state.attendanceStatus = "scanning";
    state.present = [];
    persist(); renderLiveAttendance(); toast("Check-in is now open");
  }
  if (action === "end-session") {
    clearInterval(scanTimer);
    state.attendanceStatus = "complete";
    state.erpStatus = "pending";
    persist(); renderLiveAttendance(); toast(`Attendance saved for ${state.present.length} students`);
  }
  if (action === "download") downloadCSV();
  if (action === "prepare-erp-upload") {
    if (state.userRole !== "faculty") return toast("Only the professor can prepare an ERP upload");
    downloadERPAttendance();
    toast("ERP attendance CSV prepared");
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
    state.authenticated = false;
    state.accountName = "";
    state.route = "dashboard";
    persist();
    document.querySelector("#modalRoot").innerHTML = "";
    renderLogin(state.userRole);
  }
  if (action === "add-question") {
    const button = event.target.closest("[data-action]");
    button.insertAdjacentHTML("beforebegin", questionBlock(document.querySelectorAll(".question-card").length + 1, "Type your question here", ["Option A", "Option B", "Option C", "Option D"], 0));
  }
  if (action === "publish-quiz") {
    state.quizPublished = true;
    state.quizResponses = 3;
    persist(); renderLiveQuiz(); toast("Quiz published to 42 students");
  }
  if (action === "end-quiz") {
    clearInterval(quizTimer);
    toast(`Quiz ended with ${state.quizResponses} responses`);
    navigate("dashboard");
  }
});

document.addEventListener("change", async event => {
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

quickAction.addEventListener("click", () => navigate("attendance"));
document.querySelector("#roleSwitch").addEventListener("click", openRoleModal);

document.addEventListener("submit", event => {
  event.preventDefault();
  if (event.target.id === "loginForm") {
    const data = Object.fromEntries(new FormData(event.target));
    const profile = loginProfiles[data.role];
    if (!profile || String(data.password).length < 4) return;
    state.userRole = data.role;
    state.authenticated = true;
    state.accountName = profile.name;
    state.route = "dashboard";
    persist();
    document.querySelectorAll(".nav-item").forEach(btn => btn.classList.toggle("active", btn.dataset.route === "dashboard"));
    showApp();
    return toast(`Signed in to the ${profile.shortTitle} workspace`);
  }
  if (event.target.id === "courseForm") {
    const data = Object.fromEntries(new FormData(event.target));
    const token = data.courseCode.replace(/[^a-z0-9]/gi, "").slice(0, 3).toUpperCase();
    const code = `${token}${Math.random().toString(36).slice(2, 5)}`.toUpperCase();
    state.courses.push({
      id: `course-${Date.now()}`,
      code,
      name: data.name,
      courseCode: data.courseCode.toUpperCase(),
      section: data.section,
      room: data.room,
      students: Number(data.students)
    });
    persist();
    document.querySelector("#modalRoot").innerHTML = "";
    renderClasses();
    toast(`${data.name} created · Code ${code}`);
  }
  if (event.target.id === "joinForm") {
    const code = new FormData(event.target).get("joinCode").trim().toUpperCase();
    const course = state.courses.find(item => item.code === code);
    if (!course) return toast("That course code was not found");
    if (state.enrolledCourses.includes(course.id)) return toast("You already joined this course");
    state.enrolledCourses.push(course.id);
    persist();
    renderStudentClasses();
    toast(`You joined ${course.name}`);
  }
});
persist();
render();
