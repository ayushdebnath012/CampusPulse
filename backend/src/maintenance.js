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
    database.schedule = [];
    database.attendanceSessions = [];
    database.quizzes = [];

    database.maintenance.push(ACCOUNT_RESET_ID);
    return { applied: true, deletedAccounts, deletedCourses };
  });
}

module.exports = { ACCOUNT_RESET_ID, deleteExistingAccountsOnce };
