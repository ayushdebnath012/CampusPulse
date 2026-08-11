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

const { app, store } = createApp();
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
