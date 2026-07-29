import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vinextEntry = resolve(root, "dist/server/index.mjs");
const sitesEntry = resolve(root, "dist/server/index.js");
const hostingSource = resolve(root, ".openai/hosting.json");
const hostingTarget = resolve(root, "dist/.openai/hosting.json");

if (!existsSync(vinextEntry)) {
  throw new Error("vinext build did not produce dist/server/index.mjs");
}

mkdirSync(dirname(hostingTarget), { recursive: true });
copyFileSync(vinextEntry, sitesEntry);
copyFileSync(hostingSource, hostingTarget);

console.log("CampusPulse Sites package prepared.");
