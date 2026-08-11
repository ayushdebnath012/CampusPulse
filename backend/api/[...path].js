// Vercel invokes this module as a serverless function for every /api/* route.
// The Express app is created once per warm function instance and reused.
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = "4";
}

const { createApp } = require("../src/app");
const {
  deleteExistingAccountsOnce,
  clearAttendanceAndQuizzesOnce,
} = require("../src/maintenance");
const { applyProfessorProfileOverrides } = require("../src/profile-overrides");

// createApp falls back to a JSON file store when no database URL is set. That
// is right for a laptop and never right here: data/ is gitignored so the file
// is absent from the deployment, and the function filesystem is ephemeral and
// read-only anyway. The fallback therefore serves an empty workspace — no
// courses, no past classes — and fails every write, which looks to a student
// like the app lost their course rather than like a missing setting. Refuse to
// start instead, and say which variable is missing.
const databaseUrl = String(
  process.env.TARGET_DATABASE_URL || process.env.DATABASE_URL || "",
).trim();
const configurationError = databaseUrl
  ? null
  : new Error(
      "TARGET_DATABASE_URL is not set on this deployment. Refusing to start on " +
        "the local-file fallback, which would serve an empty workspace.",
    );

const { app, store } = configurationError ? {} : createApp();
let initialization;

function initialize() {
  if (!initialization) {
    initialization = (async () => {
      await deleteExistingAccountsOnce(store);
      await clearAttendanceAndQuizzesOnce(store);
      await applyProfessorProfileOverrides(store, process.env);
    })().catch((error) => {
      initialization = undefined;
      throw error;
    });
  }
  return initialization;
}

module.exports = async function handler(request, response) {
  if (configurationError) {
    console.error("CampusPulse is misconfigured", configurationError.message);
    return response
      .status(503)
      .json({ error: "CampusPulse is not configured. Contact your course team." });
  }
  try {
    await initialize();
    return app(request, response);
  } catch (error) {
    console.error("CampusPulse failed to initialize", error);
    if (!response.headersSent) {
      response.status(503).json({ error: "CampusPulse is temporarily unavailable" });
    }
  }
};
