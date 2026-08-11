// Vercel reliably routes rewrites to /api/index. Delegate to the shared
// Express handler so nested paths like /api/attendance/past reach the app.
module.exports = require("./[...path]");
