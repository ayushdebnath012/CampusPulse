const http = require("http");
const fs = require("fs");
const path = require("path");

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const root = path.join(__dirname, "public");
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

http
  .createServer((req, res) => {
    const route = decodeURIComponent(req.url.split("?")[0]);
    const requested = route === "/" ? "index.html" : route.replace(/^\/+/, "");
    const filePath = path.resolve(root, requested);

    if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not found");
    }

    res.writeHead(200, {
      "Content-Type": mime[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    fs.createReadStream(filePath).pipe(res);
  })
  .listen(port, host, () => {
    console.log(`CampusPulse is running at http://${host}:${port}`);
  });
