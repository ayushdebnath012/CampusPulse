const ACCOUNT_RESET_ID = "delete-existing-accounts-2026-08-01";

async function deleteExistingAccountsOnce(store) {
  return store.update((database) => {
    if (database.maintenance.includes(ACCOUNT_RESET_ID)) {
      return { applied: false, deletedAccounts: 0 };
    }

    const deletedUserIds = new Set(database.users.map((user) => user.id));
    const deletedAccounts = database.users.length;
    database.users = [];
    database.verificationCodes = [];
    database.sessions = [];
    database.enrollments = [];

    database.courses.forEach((course) => {
      if (deletedUserIds.has(course.ownerId)) delete course.ownerId;
    });
    database.attendanceSessions.forEach((session) => {
      if (Array.isArray(session.present)) session.present = [];
      if (Array.isArray(session.records)) {
        session.records.forEach((record) => {
          if (deletedUserIds.has(record.markedBy)) record.markedBy = "deleted-user";
        });
      }
      if (deletedUserIds.has(session.startedBy)) session.startedBy = "deleted-user";
      if (deletedUserIds.has(session.closedBy)) session.closedBy = "deleted-user";
    });
    database.quizzes.forEach((quiz) => {
      quiz.responses = [];
      if (deletedUserIds.has(quiz.createdBy)) quiz.createdBy = "deleted-user";
    });

    database.maintenance.push(ACCOUNT_RESET_ID);
    return { applied: true, deletedAccounts };
  });
}

module.exports = { ACCOUNT_RESET_ID, deleteExistingAccountsOnce };
