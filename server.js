"use strict";

// QL VPP backend server.
//
// Plain Node.js (no external dependencies) HTTP server that:
//   - serves the static frontend (index.html, css/, js/)
//   - exposes a small JSON REST API backed by a shared data/db.json file
//     so every browser on the office network reads/writes the same data
//
// Run with:  node server.js
// Then open: http://<this-machine's-LAN-IP>:PORT/  from any PC on the
// same office network (사내망).

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0"; // listen on every network interface, not just localhost

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");

// ---------------- shared JSON "database" ----------------
// All reads/writes use synchronous fs calls on purpose: Node runs
// JavaScript on a single thread, so a sync read-modify-write cannot be
// interleaved by another request the way an async one could, which keeps
// concurrent writes from multiple office PCs from corrupting the file.

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ items: [], movements: [] }, null, 2));
  }
}

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ---------------- helpers ----------------
function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 20 * 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(req, res, urlPath) {
  const relativePath = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.normalize(path.join(ROOT_DIR, relativePath));

  // never serve anything outside the project root
  if (!filePath.startsWith(ROOT_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(content);
  });
}

// ---------------- API route handlers ----------------
async function handleApi(req, res, urlPath) {
  // GET /api/items
  if (req.method === "GET" && urlPath === "/api/items") {
    const db = readDb();
    return sendJson(res, 200, db.items);
  }

  // POST /api/items/bulk  body: [{ name, unit, note, photo }, ...]
  if (req.method === "POST" && urlPath === "/api/items/bulk") {
    const body = await readJsonBody(req);
    if (!Array.isArray(body)) return sendJson(res, 400, { error: "array expected" });

    const db = readDb();
    const created = [];
    body.forEach((entry) => {
      const name = String(entry.name || "").trim();
      if (!name) return;
      const item = {
        id: crypto.randomUUID(),
        name,
        unit: String(entry.unit || "").trim(),
        note: String(entry.note || "").trim(),
        photo: typeof entry.photo === "string" ? entry.photo : "",
      };
      db.items.push(item);
      created.push(item);
    });
    writeDb(db);
    return sendJson(res, 201, created);
  }

  // DELETE /api/items/:id
  const itemDeleteMatch = urlPath.match(/^\/api\/items\/([^/]+)$/);
  if (req.method === "DELETE" && itemDeleteMatch) {
    const id = decodeURIComponent(itemDeleteMatch[1]);
    const db = readDb();
    const before = db.items.length;
    db.items = db.items.filter((it) => it.id !== id);
    writeDb(db);
    return sendJson(res, 200, { deleted: before !== db.items.length });
  }

  // GET /api/movements
  if (req.method === "GET" && urlPath === "/api/movements") {
    const db = readDb();
    return sendJson(res, 200, db.movements);
  }

  // POST /api/movements  body: { itemId, itemName, itemUnit, type, date, qty, recipient }
  if (req.method === "POST" && urlPath === "/api/movements") {
    const body = await readJsonBody(req);
    if (!body || typeof body !== "object") return sendJson(res, 400, { error: "object expected" });

    const type = body.type === "입고" || body.type === "출고" ? body.type : null;
    const qty = Number(body.qty);
    const date = String(body.date || "");
    const itemId = String(body.itemId || "");
    const recipient = String(body.recipient || "").trim();

    if (!type || !itemId || !recipient || !qty || qty <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return sendJson(res, 400, { error: "invalid movement payload" });
    }

    const movement = {
      id: crypto.randomUUID(),
      itemId,
      itemName: String(body.itemName || ""),
      itemUnit: String(body.itemUnit || ""),
      type,
      date,
      qty,
      recipient,
    };

    const db = readDb();
    db.movements.unshift(movement);
    writeDb(db);
    return sendJson(res, 201, movement);
  }

  return sendJson(res, 404, { error: "not found" });
}

// ---------------- server ----------------
const server = http.createServer((req, res) => {
  const urlPath = decodeURI(req.url.split("?")[0]);

  if (urlPath.startsWith("/api/")) {
    handleApi(req, res, urlPath).catch((err) => {
      console.error(err);
      sendJson(res, 500, { error: "internal server error" });
    });
    return;
  }

  serveStatic(req, res, urlPath);
});

ensureDb();

server.listen(PORT, HOST, () => {
  console.log(`QL VPP server running at http://${HOST}:${PORT}/`);
  console.log("Access it from other PCs on the same office network using this machine's LAN IP address.");
});
