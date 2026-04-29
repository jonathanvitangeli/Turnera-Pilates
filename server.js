const http = require("http");
const fs = require("fs");
const path = require("path");

const rootDir = __dirname;
const port = Number(process.env.PORT || 3000);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".sql": "text/plain; charset=utf-8"
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/config") {
    const payload = {
      url: process.env.SUPABASE_URL || "",
      anonKey: process.env.SUPABASE_ANON_KEY || ""
    };

    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
    return;
  }

  const relativePath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const filePath = path.resolve(rootDir, relativePath);

  if (!filePath.startsWith(rootDir)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, contents) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mimeTypes[extension] || "application/octet-stream"
    });
    res.end(contents);
  });
});

server.listen(port, () => {
  console.log(`Turnera disponible en http://localhost:${port}`);
});
