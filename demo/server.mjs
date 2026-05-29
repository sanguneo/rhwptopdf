import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 8788;
const PUBLIC_DIR = path.join(__dirname, "public");
const PKG_DIR = path.join(__dirname, "vendor");

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

function safeResolve(baseDir, requestPath) {
  const resolved = path.resolve(baseDir, `.${requestPath}`);
  if (!resolved.startsWith(baseDir)) return null;
  return resolved;
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      if (error.code === "ENOENT") {
        send(res, 404, "Not found");
        return;
      }
      send(res, 500, error.message);
      return;
    }

    const ext = path.extname(filePath);
    const type = MIME_TYPES[ext] || "application/octet-stream";
    send(res, 200, data, type);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;

  if (pathname.startsWith("/vendor/")) {
    const pkgPath = pathname.replace("/vendor/", "/");
    const filePath = safeResolve(PKG_DIR, pkgPath);
    if (!filePath) {
      send(res, 400, "Bad request");
      return;
    }
    serveFile(res, filePath);
    return;
  }

  const filePath = safeResolve(PUBLIC_DIR, pathname);
  if (!filePath) {
    send(res, 400, "Bad request");
    return;
  }
  serveFile(res, filePath);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`http://127.0.0.1:${PORT}`);
});
