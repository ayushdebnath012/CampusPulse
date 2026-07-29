const roster = [
  ["Student 01", "DEMO001"], ["Student 02", "DEMO002"], ["Student 03", "DEMO003"],
  ["Student 04", "DEMO004"], ["Student 05", "DEMO005"], ["Student 06", "DEMO006"],
  ["Student 07", "DEMO007"], ["Student 08", "DEMO008"], ["Student 09", "DEMO009"],
  ["Student 10", "DEMO010"], ["Student 11", "DEMO011"], ["Student 12", "DEMO012"]
];

const defaultState = {
  route: "dashboard",
  userRole: "faculty",
  attendanceStatus: "not_started",
  checks: { wifi: false, bluetooth: false },
  present: [],
  quizPublished: false,
  quizResponses: 0,
  erpStatus: "pending",
  courses: [
    { id: "cse202", code: "DM202A", name: "Discrete Mathematics", courseCode: "CSE 202", section: "Section A", room: "Room 304", students: 42 },
    { id: "cse204", code: "DS204B", name: "Data Structures", courseCode: "CSE 204", section: "Section B", room: "Lab 2", students: 38 },
    { id: "cse306", code: "OS306A", name: "Operating Systems", courseCode: "CSE 306", section: "Section A", room: "Room 211", students: 40 }
  ],
  enrolledCourses: []
};

let state = { ...defaultState, ...JSON.parse(localStorage.getItem("campusPulseState") || "{}") };
state.courses = Array.isArray(state.courses) ? state.courses : defaultState.courses;
state.enrolledCourses = Array.isArray(state.enrolledCourses) ? state.enrolledCourses : [];
let scanTimer;
let quizTimer;
const view = document.querySelector("#view");
const pageTitle = document.querySelector("#pageTitle");
const pageEyebrow = document.querySelector("#pageEyebrow");
const quickAction = document.querySelector("#quickAction");
const roleLabel = document.querySelector("#roleLabel");
const profileAvatar = document.querySelector("#profileAvatar");
const profileName = document.querySelector("#profileName");
const profileMeta = document.querySelector("#profileMeta");

function icon(id) {
  return `<svg aria-hidden="true"><use href="#${id}"/></svg>`;
}

function persist() {
  localStorage.setItem("campusPulseState", JSON.stringify(state));
  document.querySelector("#syncDot").classList.toggle("visible", state.erpStatus === "pending" && state.attendanceStatus === "complete");
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
    faculty: { label: "Faculty view", initials: "FD", name: "Faculty Demo", meta: "Instructor · CSE" },
    ta: { label: "TA view", initials: "TA", name: "Teaching Assistant", meta: "Course team · CSE" },
    student: { label: "Student view", initials: "SD", name: "Student Demo", meta: "Student · CSE" }
  };
  const profile = profiles[state.userRole] || profiles.faculty;
  roleLabel.textContent = profile.label;
  profileAvatar.textContent = profile.initials;
  profileName.textContent = profile.name;
  profileMeta.textContent = profile.meta;
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
  if (state.route === "dashboard") return renderDashboard();
  if (state.route === "attendance") return renderAttendance();
  if (state.route === "quizzes") return renderQuiz();
  if (state.route === "erp") return renderERP();
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
            <h2>Discrete Mathematics</h2>
            <p>CSE 202 · Section A</p>
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
            ${classRow("10:00", "10:50 AM", "Discrete Mathematics", "CSE 202 · Section A · Room 304", attendanceLabel, statusClass, "attendance")}
            ${classRow("12:00", "12:50 PM", "Data Structures", "CSE 204 · Section B · Lab 2", "Upcoming", "gray", "attendance")}
            ${classRow("02:00", "02:50 PM", "Operating Systems", "CSE 306 · Section A · Room 211", "Upcoming", "gray", "attendance")}
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
            <div class="activity"><span class="activity-icon">${icon("i-check")}</span><div><strong>Attendance synced to ERP</strong><p>Data Structures · Section A</p></div><time>9:14</time></div>
            <div class="activity"><span class="activity-icon purple">${icon("i-quiz")}</span><div><strong>Quiz results published</strong><p>Algorithms · Quiz 04</p></div><time>Wed</time></div>
            <div class="activity"><span class="activity-icon">${icon("i-users")}</span><div><strong>38 of 42 students present</strong><p>Operating Systems</p></div><time>Tue</time></div>
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
        <button class="btn" data-route-link="classes">${icon(enrolled.length ? "i-arrow" : "i-plus")} ${enrolled.length ? "View my courses" : "Join a course"}</button>
      </section>
      <div class="course-grid">
        ${enrolled.length ? enrolled.map(course => studentCourseCard(course)).join("") : `
          <article class="card empty-state" style="min-height:260px;grid-column:1/-1"><div><span class="empty-icon">${icon("i-calendar")}</span><h2>No courses yet</h2><p>Ask your faculty for a six-character join code, then enter it on the Courses page.</p><button class="btn btn-primary" data-route-link="classes">Enter join code</button></div></article>`}
      </div>
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
  setHeader("Attendance session", "DISCRETE MATHEMATICS · CSE 202", false);
  if (state.attendanceStatus === "not_started") return renderAttendanceSetup();
  return renderLiveAttendance();
}

function renderStudentAttendanceAccess() {
  setHeader("Class check-in", "STUDENT ACCESS", false);
  const hasAccess = state.enrolledCourses.includes("cse202");
  view.innerHTML = hasAccess ? `
    <button class="back-btn" data-route-link="dashboard">${icon("i-back")} Back to dashboard</button>
    <article class="card join-panel">
      <div class="setup-radar">${icon("i-bluetooth")}</div><span class="badge green">Course access verified</span>
      <h2 style="margin:15px 0 7px">Discrete Mathematics check-in</h2>
      <p class="stat-label">When your faculty opens attendance, keep Bluetooth and internet on. CampusPulse will verify that your device is inside the classroom.</p>
      <button class="btn btn-primary" style="margin-top:20px" ${state.attendanceStatus === "scanning" ? "" : "disabled"}>${icon("i-wifi")} ${state.attendanceStatus === "scanning" ? "Verify my presence" : "Waiting for faculty"}</button>
    </article>` : `
    <article class="card empty-state"><div><span class="empty-icon">${icon("i-users")}</span><h2>Join the course first</h2><p>Attendance check-in is available only to students enrolled in Discrete Mathematics.</p><button class="btn btn-primary" data-route-link="classes">Join with course code</button></div></article>`;
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
    <div class="section-head"><h3>Session summary</h3><span class="badge purple">CSE 202</span></div>
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
          ${complete ? `<button class="btn" data-action="download">${icon("i-download")} Export CSV</button><button class="btn btn-primary" data-route-link="erp">${icon("i-cloud")} Review ERP sync</button>` : `<button class="btn btn-danger" data-action="end-session">End check-in</button>`}
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
  setHeader("Quick quiz", "DISCRETE MATHEMATICS · CSE 202", false);
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
  const hasAccess = state.enrolledCourses.includes("cse202");
  view.innerHTML = hasAccess ? `
    <button class="back-btn" data-route-link="dashboard">${icon("i-back")} Back to dashboard</button>
    <div class="page-grid">
      <article class="card page-card">
        <div class="session-title"><div><h2>Discrete Mathematics</h2><p>CSE 202 · Section A</p></div><span class="badge green">Enrolled</span></div>
        <div class="question-card" style="margin-top:20px"><div class="section-head"><div><h3>Concept check · Relations & Trees</h3><p class="stat-label" style="margin-top:5px">2 questions · 3 minutes</p></div><span class="badge ${state.quizPublished ? "purple" : "gray"}">${state.quizPublished ? "Available now" : "Not started"}</span></div>
        <button class="btn btn-primary" ${state.quizPublished ? "" : "disabled"}>${icon("i-play")} Start quiz</button></div>
      </article>
      <aside class="card page-card"><div class="section-head"><h3>Your access</h3><span class="badge green">Verified</span></div><div class="summary-list"><div class="summary-item"><span>Enrollment</span><strong>Active</strong></div><div class="summary-item"><span>Course</span><strong>CSE 202</strong></div><div class="summary-item"><span>Attendance eligibility</span><strong>Enabled</strong></div></div><div class="security-note"><span class="lock">⌾</span><span>You can access these activities because you joined this course with its private code.</span></div></aside>
    </div>` : `
    <article class="card empty-state"><div><span class="empty-icon">${icon("i-quiz")}</span><h2>Course access required</h2><p>Join Discrete Mathematics before opening its quizzes or attendance check-ins.</p><button class="btn btn-primary" data-route-link="classes">Join a course</button></div></article>`;
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
  setHeader("ERP sync center", "CAMPUS RECORDS");
  const hasSession = state.attendanceStatus === "complete";
  view.innerHTML = `
    <div class="page-grid">
      <article class="card page-card">
        <div class="section-head"><div><h2 style="margin:0 0 5px">Sync queue</h2><p class="stat-label">Review classroom records before sending them to your institution ERP.</p></div><span class="badge ${hasSession && state.erpStatus === "pending" ? "amber" : "green"}">${hasSession && state.erpStatus === "pending" ? "1 pending" : "All synced"}</span></div>
        ${hasSession ? `
          <div class="sync-record">
            <span class="sync-symbol ${state.erpStatus === "synced" ? "done" : ""}">${icon(state.erpStatus === "synced" ? "i-check" : "i-cloud")}</span>
            <div><strong>Discrete Mathematics · 30 Jul 2026</strong><p>${state.present.length} present · ${42 - state.present.length} absent · Quiz ${state.quizPublished ? "included" : "not included"}</p></div>
            ${state.erpStatus === "pending" ? `<button class="btn btn-primary" data-action="sync-erp">Sync now</button>` : `<span class="badge green">Synced</span>`}
          </div>` : `
          <div class="empty-state"><div><span class="empty-icon">${icon("i-cloud")}</span><h2>No records waiting</h2><p>Complete an attendance session and it will appear here for review and upload.</p><button class="btn btn-primary" data-route-link="attendance">Start attendance</button></div></div>`}
      </article>
      <aside class="card page-card">
        <div class="section-head"><h3>ERP connection</h3><span class="badge green">Connected</span></div>
        <div class="summary-list">
          <div class="summary-item"><span>Provider</span><strong>Campus ERP</strong></div>
          <div class="summary-item"><span>Institution ID</span><strong>INST-2026-04</strong></div>
          <div class="summary-item"><span>Last successful sync</span><strong>Today, 9:14 AM</strong></div>
          <div class="summary-item"><span>Mode</span><strong>Review before sync</strong></div>
        </div>
        <div class="security-note"><span class="lock">⌾</span><span>This prototype uses a local ERP adapter. Replace it with your institution’s authenticated REST API endpoint for production.</span></div>
      </aside>
    </div>`;
}

function renderClasses() {
  if (state.userRole === "student") return renderStudentClasses();
  const isTA = state.userRole === "ta";
  setHeader(isTA ? "Courses you assist" : "My courses", isTA ? "TEACHING ASSISTANT WORKSPACE" : "FACULTY WORKSPACE", false);
  view.innerHTML = `
    <article class="card page-card">
      <div class="section-head"><div><h2 style="margin:0 0 5px">${isTA ? "Assigned courses" : "Courses you teach"}</h2><p class="stat-label">${isTA ? "You can run attendance and update live quizzes for these courses." : "Create a course and share its private code with enrolled students."}</p></div>${isTA ? '<span class="badge purple">TA access</span>' : `<button class="btn btn-primary" data-action="open-course-modal">${icon("i-plus")} Add course</button>`}</div>
      <div class="course-grid">${state.courses.map(facultyCourseCard).join("")}</div>
    </article>`;
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
    <article class="card join-panel">
      <span class="empty-icon">${icon("i-plus")}</span><h2>Enter your course code</h2>
      <p class="stat-label">Your faculty will share a six-character code. You only need to join once.</p>
      <form class="join-code" id="joinForm"><input name="joinCode" maxlength="8" placeholder="e.g. DM202A" autocomplete="off" required/><button class="btn btn-primary">Join course</button></form>
      ${enrolled.length ? `<div class="student-course-list"><div class="section-head"><h3>Courses joined</h3><span class="badge green">${enrolled.length} active</span></div>${enrolled.map(course => studentCourseCard(course)).join("")}</div>` : ""}
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
        <div class="modal-head"><div><h2 id="roleModalTitle">Choose a demo login</h2><p>Permissions and course access change with each role.</p></div><button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">${icon("i-close")}</button></div>
        <div class="role-options">
          ${roleOption("faculty", "FD", "Professor / Faculty", "Create courses, quizzes, and attendance")}
          ${roleOption("ta", "TA", "Teaching Assistant", "Update quizzes and start attendance")}
          ${roleOption("student", "SD", "Student", "Join courses and participate in activities")}
        </div>
      </div>
    </div>`;
}

function roleOption(role, initials, title, description) {
  return `<button class="role-option" data-login-role="${role}"><span class="avatar">${initials}</span><span><strong>${title}</strong><span>${description}</span></span>${state.userRole === role ? icon("i-check") : icon("i-arrow")}</button>`;
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
  a.download = "CSE202-attendance-2026-07-30.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

document.addEventListener("click", event => {
  const loginButton = event.target.closest("[data-login-role]");
  if (loginButton) {
    state.userRole = loginButton.dataset.loginRole;
    state.route = "dashboard";
    persist();
    document.querySelector("#modalRoot").innerHTML = "";
    document.querySelectorAll(".nav-item").forEach(btn => btn.classList.toggle("active", btn.dataset.route === "dashboard"));
    render();
    return toast(`Signed in as ${state.userRole === "ta" ? "Teaching Assistant" : state.userRole}`);
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
  if (action === "sync-erp") {
    const btn = event.target.closest("button");
    btn.disabled = true;
    btn.textContent = "Syncing…";
    setTimeout(() => {
      state.erpStatus = "synced";
      persist(); renderERP(); toast("Attendance and quiz data synced to ERP");
    }, 1000);
  }
});

quickAction.addEventListener("click", () => navigate("attendance"));
document.querySelector("#roleSwitch").addEventListener("click", openRoleModal);

document.addEventListener("submit", event => {
  event.preventDefault();
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
