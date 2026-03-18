const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const fsp = fs.promises;

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const STORAGE_DIR = path.join(ROOT_DIR, "storage");
const FILES_DIR = path.join(STORAGE_DIR, "files");
const INDEX_FILE = path.join(STORAGE_DIR, "index.json");

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

let mutationLock = Promise.resolve();

async function ensureStorage() {
  await fsp.mkdir(PUBLIC_DIR, { recursive: true });
  await fsp.mkdir(FILES_DIR, { recursive: true });

  try {
    await fsp.access(INDEX_FILE, fs.constants.F_OK);
  } catch {
    await fsp.writeFile(INDEX_FILE, "[]", "utf8");
  }
}

async function readIndex() {
  try {
    const raw = await fsp.readFile(INDEX_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeIndex(entries) {
  await fsp.writeFile(INDEX_FILE, JSON.stringify(entries, null, 2), "utf8");
}

function withMutationLock(task) {
  const runTask = mutationLock.then(task, task);
  mutationLock = runTask.catch(() => {});
  return runTask;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

function sanitizeFileName(name) {
  const trimmed = String(name || "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim();

  return trimmed || "file.bin";
}

function getMimeType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

async function collectRequestBody(req, maxSize) {
  let totalSize = 0;
  const chunks = [];

  for await (const chunk of req) {
    totalSize += chunk.length;

    if (totalSize > maxSize) {
      const error = new Error("Размер файла превышает лимит 50 МБ.");
      error.statusCode = 413;
      throw error;
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function getRequestUrl(req) {
  return new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
}

function getClientBaseUrl(req) {
  return `${req.socket.encrypted ? "https" : "http"}://${req.headers.host || `${HOST}:${PORT}`}`;
}

function toPublicFile(metadata, req) {
  return {
    id: metadata.id,
    name: metadata.name,
    size: metadata.size,
    type: metadata.type,
    uploadedAt: metadata.uploadedAt,
    downloadUrl: `${getClientBaseUrl(req)}/api/files/${metadata.id}`
  };
}

async function handleListFiles(req, res) {
  const items = await readIndex();
  items.sort((left, right) => new Date(right.uploadedAt) - new Date(left.uploadedAt));

  sendJson(res, 200, {
    files: items.map((item) => toPublicFile(item, req))
  });
}

async function handleUpload(req, res) {
  const rawHeaderName = req.headers["x-file-name"];
  const fileNameHeader = Array.isArray(rawHeaderName) ? rawHeaderName[0] : rawHeaderName;

  if (!fileNameHeader) {
    sendError(res, 400, "Не передано имя файла в заголовке x-file-name.");
    return;
  }

  let originalName;

  try {
    originalName = sanitizeFileName(decodeURIComponent(fileNameHeader));
  } catch {
    originalName = sanitizeFileName(fileNameHeader);
  }

  const body = await collectRequestBody(req, MAX_UPLOAD_SIZE);

  if (body.length === 0) {
    sendError(res, 400, "Файл пустой. Выбери другой файл для загрузки.");
    return;
  }

  const id = crypto.randomUUID();
  const extension = path.extname(originalName);
  const storedName = extension ? `${id}${extension}` : id;
  const filePath = path.join(FILES_DIR, storedName);
  const metadata = {
    id,
    name: originalName,
    size: body.length,
    type: req.headers["content-type"] || "application/octet-stream",
    uploadedAt: new Date().toISOString(),
    storedName
  };

  await withMutationLock(async () => {
    const items = await readIndex();
    await fsp.writeFile(filePath, body);
    items.unshift(metadata);
    await writeIndex(items);
  });

  sendJson(res, 201, {
    message: "Файл успешно загружен.",
    file: toPublicFile(metadata, req)
  });
}

function getFileIdFromPath(pathname) {
  const match = pathname.match(/^\/api\/files\/([0-9a-f-]+)$/i);
  return match ? match[1] : null;
}

async function handleDownload(req, res, fileId) {
  const items = await readIndex();
  const metadata = items.find((item) => item.id === fileId);

  if (!metadata) {
    sendError(res, 404, "Файл не найден.");
    return;
  }

  const filePath = path.join(FILES_DIR, metadata.storedName);

  try {
    await fsp.access(filePath, fs.constants.F_OK);
  } catch {
    sendError(res, 404, "Файл отсутствует в хранилище.");
    return;
  }

  res.writeHead(200, {
    "Content-Type": metadata.type || "application/octet-stream",
    "Content-Length": metadata.size,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(metadata.name)}`,
    "Cache-Control": "no-store"
  });

  fs.createReadStream(filePath).pipe(res);
}

async function handleDelete(res, fileId) {
  const deletedItem = await withMutationLock(async () => {
    const items = await readIndex();
    const item = items.find((entry) => entry.id === fileId);

    if (!item) {
      return null;
    }

    const nextItems = items.filter((entry) => entry.id !== fileId);
    const filePath = path.join(FILES_DIR, item.storedName);

    try {
      await fsp.unlink(filePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    await writeIndex(nextItems);
    return item;
  });

  if (!deletedItem) {
    sendError(res, 404, "Файл не найден.");
    return;
  }

  sendJson(res, 200, {
    message: "Файл удалён."
  });
}

async function serveStaticFile(req, res, pathname) {
  const normalizedPath = pathname === "/" ? "/index.html" : pathname;
  const targetPath = path.join(PUBLIC_DIR, normalizedPath);
  const resolvedPath = path.resolve(targetPath);

  if (!resolvedPath.startsWith(path.resolve(PUBLIC_DIR))) {
    sendError(res, 403, "Доступ запрещён.");
    return;
  }

  try {
    const stats = await fsp.stat(resolvedPath);

    if (!stats.isFile()) {
      sendError(res, 404, "Ресурс не найден.");
      return;
    }

    res.writeHead(200, {
      "Content-Type": getMimeType(resolvedPath),
      "Content-Length": stats.size
    });

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    fs.createReadStream(resolvedPath).pipe(res);
  } catch {
    sendError(res, 404, "Ресурс не найден.");
  }
}

async function requestHandler(req, res) {
  try {
    const url = getRequestUrl(req);
    const { pathname } = url;

    if (req.method === "GET" && pathname === "/api/health") {
      sendJson(res, 200, {
        status: "ok",
        service: "Campus Cloud Service",
        timestamp: new Date().toISOString()
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/files") {
      await handleListFiles(req, res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/files") {
      await handleUpload(req, res);
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/api/files/")) {
      const fileId = getFileIdFromPath(pathname);

      if (!fileId) {
        sendError(res, 404, "Файл не найден.");
        return;
      }

      await handleDownload(req, res, fileId);
      return;
    }

    if (req.method === "DELETE" && pathname.startsWith("/api/files/")) {
      const fileId = getFileIdFromPath(pathname);

      if (!fileId) {
        sendError(res, 404, "Файл не найден.");
        return;
      }

      await handleDelete(res, fileId);
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      await serveStaticFile(req, res, pathname);
      return;
    }

    sendError(res, 405, "Метод не поддерживается.");
  } catch (error) {
    const statusCode = error.statusCode || 500;
    sendError(res, statusCode, error.message || "Внутренняя ошибка сервера.");
  }
}

async function start() {
  await ensureStorage();

  const server = http.createServer((req, res) => {
    requestHandler(req, res);
  });

  server.listen(PORT, HOST, () => {
    console.log(`Campus Cloud Service запущен на http://${HOST}:${PORT}`);
  });
}

start().catch((error) => {
  console.error("Не удалось запустить сервер:", error);
  process.exit(1);
});
