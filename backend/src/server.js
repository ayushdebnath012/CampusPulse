const path = require("node:path");
const { createApp } = require("./app");
const { deleteExistingAccountsOnce } = require("./maintenance");

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
  app.listen(port, host, () => {
    console.log(`CampusPulse API listening on http://${host}:${port}`);
    console.log(
      `CampusPulse database: ${process.env.DATABASE_URL ? "PostgreSQL" : databasePath}`,
    );
  });
}

start().catch((error) => {
  console.error("CampusPulse failed to start", error);
  process.exitCode = 1;
});
