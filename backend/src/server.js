// Password hashing is deliberately limited to four concurrent libuv workers.
// Each scrypt job reserves a sizeable native-memory buffer, so widening this
// pool to sixteen can exhaust a small Render instance during a login burst.
// Requests may queue briefly, but the process stays alive to serve them.
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = "4";
}

const path = require("node:path");
const { createApp } = require("./app");
const { deleteExistingAccountsOnce, clearAttendanceAndQuizzesOnce } = require("./maintenance");
const { applyProfessorProfileOverrides } = require("./profile-overrides");

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "0.0.0.0";
const databasePath =
  process.env.DATABASE_PATH ||
  path.resolve(__dirname, "../data/campuspulse.json");
const { app, store } = createApp({ databasePath });

async function start() {
  const reset = await deleteExistingAccountsOnce(store);
  if (reset.applied) {
    console.log(`CampusPulse account reset: deleted ${reset.deletedAccounts} account(s)`);
  }
  const aqReset = await clearAttendanceAndQuizzesOnce(store);
  if (aqReset.applied) {
    console.log(`CampusPulse data reset: cleared ${aqReset.deletedSessions} attendance session(s) and ${aqReset.deletedQuizzes} quiz(zes)`);
  }
  const profileOverrides = await applyProfessorProfileOverrides(store, process.env);
  if (profileOverrides.updated) {
    console.log(
      `CampusPulse professor profiles updated: ${profileOverrides.updated} account(s)`,
    );
  }
  const server = app.listen(port, host, () => {
    console.log(`CampusPulse API listening on http://${host}:${port}`);
    console.log(
      `CampusPulse database: ${process.env.TARGET_DATABASE_URL || process.env.DATABASE_URL ? "PostgreSQL" : databasePath}`,
    );
  });
  server.headersTimeout = 65000;
  server.requestTimeout = 60000;
  server.keepAliveTimeout = 30000;
}

start().catch((error) => {
  console.error("CampusPulse failed to start", error);
  process.exitCode = 1;
});
