// Bumping this id replays the reset once on the next start.
const ACCOUNT_RESET_ID = "reset-to-empty-workspace-2026-08-02";

async function deleteExistingAccountsOnce(store) {
  return store.update((database) => {
    if (database.maintenance.includes(ACCOUNT_RESET_ID)) {
      return { applied: false, deletedAccounts: 0, deletedCourses: 0 };
    }

    const deletedAccounts = database.users.length;
    const deletedCourses = database.courses.length;

    // CampusPulse starts empty: every course, roll list, attendance record and
    // quiz belongs to a professor who now has to create it again.
    database.users = [];
    database.verificationCodes = [];
    database.sessions = [];
    database.enrollments = [];
    database.courses = [];
    database.courseStudents = [];
    database.courseMaterials = [];
    database.courseNotices = [];
    database.notifications = [];
    database.pushDevices = [];
    database.schedule = [];
    database.attendanceSessions = [];
    database.quizzes = [];

    database.maintenance.push(ACCOUNT_RESET_ID);
    return { applied: true, deletedAccounts, deletedCourses };
  });
}

// Clears attendance and quiz data only — courses, students, schedules stay.
const ATTENDANCE_QUIZ_RESET_ID = "clear-attendance-quiz-2026-08-02";

async function clearAttendanceAndQuizzesOnce(store) {
  return store.update((database) => {
    if (database.maintenance.includes(ATTENDANCE_QUIZ_RESET_ID)) {
      return { applied: false };
    }

    const deletedSessions = database.attendanceSessions.length;
    const deletedQuizzes = database.quizzes.length;

    database.attendanceSessions = [];
    database.quizzes = [];

    database.maintenance.push(ATTENDANCE_QUIZ_RESET_ID);
    return { applied: true, deletedSessions, deletedQuizzes };
  });
}

module.exports = {
  ACCOUNT_RESET_ID,
  deleteExistingAccountsOnce,
  ATTENDANCE_QUIZ_RESET_ID,
  clearAttendanceAndQuizzesOnce,
};
