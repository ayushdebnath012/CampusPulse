const fs = require("node:fs/promises");
const path = require("node:path");

function initialData() {
  return {
    users: [],
    verificationCodes: [],
    sessions: [],
    enrollments: [],
    courses: [
      {
        id: "soft401",
        code: "SC401A",
        name: "Soft Computing",
        courseCode: "CSE 401",
        section: "Section A",
        room: "Room 304",
        students: 42,
      },
    ],
    schedule: [
      {
        id: "schedule-1",
        courseId: "soft401",
        day: "Tuesday",
        date: "28 Jul",
        start: "10:00 AM",
        end: "11:00 AM",
        topic: "Foundations of Soft Computing",
        room: "Room 304",
      },
      {
        id: "schedule-2",
        courseId: "soft401",
        day: "Thursday",
        date: "30 Jul",
        start: "10:00 AM",
        end: "10:50 AM",
        topic: "Fuzzy Sets & Membership",
        room: "Room 304",
        today: true,
      },
      {
        id: "schedule-3",
        courseId: "soft401",
        day: "Saturday",
        date: "1 Aug",
        start: "09:00 AM",
        end: "10:00 AM",
        topic: "Neural Network Models",
        room: "Room 304",
      },
    ],
    attendanceSessions: [],
    quizzes: [],
  };
}

function normalizeData(value) {
  const defaults = initialData();
  return Object.fromEntries(
    Object.entries(defaults).map(([key, fallback]) => [
      key,
      Array.isArray(value?.[key]) ? value[key] : fallback,
    ]),
  );
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createStore(filePath) {
  const absolutePath = path.resolve(filePath);
  let queue = Promise.resolve();

  async function load() {
    try {
      return normalizeData(JSON.parse(await fs.readFile(absolutePath, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return initialData();
    }
  }

  async function save(data) {
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    const temporaryPath = `${absolutePath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(temporaryPath, absolutePath);
  }

  return {
    async read() {
      await queue;
      return clone(await load());
    },
    update(mutator) {
      const operation = queue.then(async () => {
        const data = await load();
        const result = await mutator(data);
        await save(data);
        return clone(result);
      });
      queue = operation.catch(() => {});
      return operation;
    },
    path: absolutePath,
  };
}

module.exports = { createStore, initialData, normalizeData };
