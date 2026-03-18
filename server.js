const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const fsp = fs.promises;

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;
const MAX_JSON_SIZE = 64 * 1024;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE_NAME = "campus_cloud_session";

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const STORAGE_DIR = path.join(ROOT_DIR, "storage");
const FILES_DIR = path.join(STORAGE_DIR, "files");
const INDEX_FILE = path.join(STORAGE_DIR, "index.json");
const USERS_FILE = path.join(STORAGE_DIR, "users.json");
const SESSIONS_FILE = path.join(STORAGE_DIR, "sessions.json");

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
  await ensureJsonFile(INDEX_FILE, []);
  await ensureJsonFile(USERS_FILE, []);
  await ensureJsonFile(SESSIONS_FILE, []);
}

async function ensureJsonFile(filePath, fallbackValue) {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
  } catch {
    await fsp.writeFile(filePath, JSON.stringify(fallbackValue, null, 2), "utf8");
  }
}

async function readArrayFile(filePath) {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeArrayFile(filePath, entries) {
  await fsp.writeFile(filePath, JSON.stringify(entries, null, 2), "utf8");
}

function withMutationLock(task) {
  const runTask = mutationLock.then(task, task);
  mutationLock = runTask.catch(() => {});
  return runTask;
}

function sendJson(res, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(body);
}

function sendError(res, statusCode, message, headers = {}) {
  sendJson(res, statusCode, { error: message }, headers);
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
      const error = new Error("Размер данных превышает допустимый лимит.");
      error.statusCode = 413;
      throw error;
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function collectJsonBody(req) {
  const body = await collectRequestBody(req, MAX_JSON_SIZE);

  if (!body.length) {
    return {};
  }

  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    const error = new Error("Тело запроса должно быть корректным JSON.");
    error.statusCode = 400;
    throw error;
  }
}

function getRequestUrl(req) {
  return new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
}

function parseCookies(req) {
  const rawCookie = req.headers.cookie;

  if (!rawCookie) {
    return {};
  }

  return rawCookie.split(";").reduce((cookies, part) => {
    const separatorIndex = part.indexOf("=");

    if (separatorIndex === -1) {
      return cookies;
    }

    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function isSecureRequest(req) {
  return req.socket.encrypted || req.headers["x-forwarded-proto"] === "https";
}

function serializeSessionCookie(req, sessionId, maxAgeSeconds) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`
  ];

  if (isSecureRequest(req)) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function clearSessionCookie(req) {
  return serializeSessionCookie(req, "", 0);
}

function normalizeLogin(login) {
  return String(login || "").trim().toLowerCase();
}

function validateCredentials(login, password) {
  const cleanLogin = String(login || "").trim();
  const cleanPassword = String(password || "");

  if (!/^[a-zA-Z0-9._-]{3,24}$/.test(cleanLogin)) {
    const error = new Error("Логин должен быть длиной 3-24 символа и содержать только буквы, цифры, точку, дефис или _.");
    error.statusCode = 400;
    throw error;
  }

  if (cleanPassword.length < 6) {
    const error = new Error("Пароль должен содержать минимум 6 символов.");
    error.statusCode = 400;
    throw error;
  }

  return {
    login: cleanLogin,
    normalizedLogin: normalizeLogin(cleanLogin),
    password: cleanPassword
  };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, expectedHash] = String(storedHash || "").split(":");

  if (!salt || !expectedHash) {
    return false;
  }

  const actualHash = crypto.scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expectedHash, "hex");

  if (actualHash.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(actualHash, expectedBuffer);
}

function toPublicUser(user) {
  return {
    id: user.id,
    login: user.login,
    createdAt: user.createdAt
  };
}

function toPublicFile(metadata) {
  return {
    id: metadata.id,
    name: metadata.name,
    size: metadata.size,
    type: metadata.type,
    uploadedAt: metadata.uploadedAt,
    downloadUrl: `/api/files/${metadata.id}`
  };
}

async function findAuthenticatedUser(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies[SESSION_COOKIE_NAME];

  if (!sessionId) {
    return null;
  }

  const [sessions, users] = await Promise.all([
    readArrayFile(SESSIONS_FILE),
    readArrayFile(USERS_FILE)
  ]);

  const session = sessions.find((entry) => entry.id === sessionId);

  if (!session) {
    return null;
  }

  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    await withMutationLock(async () => {
      const nextSessions = (await readArrayFile(SESSIONS_FILE)).filter((entry) => entry.id !== sessionId);
      await writeArrayFile(SESSIONS_FILE, nextSessions);
    });
    return null;
  }

  const user = users.find((entry) => entry.id === session.userId);
  return user || null;
}

async function requireAuthenticatedUser(req, res) {
  const user = await findAuthenticatedUser(req);

  if (!user) {
    sendError(res, 401, "Сначала войди в аккаунт.");
    return null;
  }

  return user;
}

async function createSession(req, userId) {
  const session = {
    id: crypto.randomUUID(),
    userId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
  };

  await withMutationLock(async () => {
    const sessions = await readArrayFile(SESSIONS_FILE);
    const activeSessions = sessions.filter((entry) => new Date(entry.expiresAt).getTime() > Date.now());
    activeSessions.push(session);
    await writeArrayFile(SESSIONS_FILE, activeSessions);
  });

  return serializeSessionCookie(req, session.id, Math.floor(SESSION_TTL_MS / 1000));
}

async function destroySession(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies[SESSION_COOKIE_NAME];

  if (!sessionId) {
    return;
  }

  await withMutationLock(async () => {
    const nextSessions = (await readArrayFile(SESSIONS_FILE)).filter((entry) => entry.id !== sessionId);
    await writeArrayFile(SESSIONS_FILE, nextSessions);
  });
}

function getFileIdFromPath(pathname) {
  const match = pathname.match(/^\/api\/files\/([0-9a-f-]+)$/i);
  return match ? match[1] : null;
}

async function handleRegister(req, res) {
  const body = await collectJsonBody(req);
  const credentials = validateCredentials(body.login, body.password);

  const createdUser = await withMutationLock(async () => {
    const users = await readArrayFile(USERS_FILE);
    const exists = users.some((entry) => entry.normalizedLogin === credentials.normalizedLogin);

    if (exists) {
      const error = new Error("Пользователь с таким логином уже существует.");
      error.statusCode = 409;
      throw error;
    }

    const user = {
      id: crypto.randomUUID(),
      login: credentials.login,
      normalizedLogin: credentials.normalizedLogin,
      passwordHash: hashPassword(credentials.password),
      createdAt: new Date().toISOString()
    };

    users.push(user);
    await writeArrayFile(USERS_FILE, users);
    return user;
  });

  const cookie = await createSession(req, createdUser.id);

  sendJson(
    res,
    201,
    {
      message: "Аккаунт создан. Ты уже вошёл в систему.",
      user: toPublicUser(createdUser)
    },
    {
      "Set-Cookie": cookie
    }
  );
}

async function handleLogin(req, res) {
  const body = await collectJsonBody(req);
  const credentials = validateCredentials(body.login, body.password);
  const users = await readArrayFile(USERS_FILE);
  const user = users.find((entry) => entry.normalizedLogin === credentials.normalizedLogin);

  if (!user || !verifyPassword(credentials.password, user.passwordHash)) {
    sendError(res, 401, "Неверный логин или пароль.");
    return;
  }

  const cookie = await createSession(req, user.id);

  sendJson(
    res,
    200,
    {
      message: "Вход выполнен.",
      user: toPublicUser(user)
    },
    {
      "Set-Cookie": cookie
    }
  );
}

async function handleLogout(req, res) {
  await destroySession(req);

  sendJson(
    res,
    200,
    {
      message: "Ты вышел из аккаунта."
    },
    {
      "Set-Cookie": clearSessionCookie(req)
    }
  );
}

async function handleMe(req, res) {
  const user = await findAuthenticatedUser(req);

  if (!user) {
    sendError(res, 401, "Аккаунт не найден или сессия истекла.");
    return;
  }

  sendJson(res, 200, { user: toPublicUser(user) });
}

async function handleListFiles(req, res, user) {
  const items = await readArrayFile(INDEX_FILE);
  const userFiles = items
    .filter((item) => item.ownerId === user.id)
    .sort((left, right) => new Date(right.uploadedAt) - new Date(left.uploadedAt));

  sendJson(res, 200, {
    files: userFiles.map((item) => toPublicFile(item))
  });
}

async function handleUpload(req, res, user) {
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

  if (!body.length) {
    sendError(res, 400, "Файл пустой. Выбери другой файл для загрузки.");
    return;
  }

  const id = crypto.randomUUID();
  const extension = path.extname(originalName);
  const storedName = extension ? `${id}${extension}` : id;
  const filePath = path.join(FILES_DIR, storedName);
  const metadata = {
    id,
    ownerId: user.id,
    name: originalName,
    size: body.length,
    type: req.headers["content-type"] || "application/octet-stream",
    uploadedAt: new Date().toISOString(),
    storedName
  };

  await withMutationLock(async () => {
    const items = await readArrayFile(INDEX_FILE);
    await fsp.writeFile(filePath, body);
    items.unshift(metadata);
    await writeArrayFile(INDEX_FILE, items);
  });

  sendJson(res, 201, {
    message: "Файл успешно загружен.",
    file: toPublicFile(metadata)
  });
}

async function handleDownload(res, fileId, user) {
  const items = await readArrayFile(INDEX_FILE);
  const metadata = items.find((item) => item.id === fileId && item.ownerId === user.id);

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

async function handleDelete(res, fileId, user) {
  const deletedItem = await withMutationLock(async () => {
    const items = await readArrayFile(INDEX_FILE);
    const item = items.find((entry) => entry.id === fileId && entry.ownerId === user.id);

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

    await writeArrayFile(INDEX_FILE, nextItems);
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

    if (req.method === "POST" && pathname === "/api/register") {
      await handleRegister(req, res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/login") {
      await handleLogin(req, res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/logout") {
      await handleLogout(req, res);
      return;
    }

    if (req.method === "GET" && pathname === "/api/me") {
      await handleMe(req, res);
      return;
    }

    if (req.method === "GET" && pathname === "/api/files") {
      const user = await requireAuthenticatedUser(req, res);

      if (!user) {
        return;
      }

      await handleListFiles(req, res, user);
      return;
    }

    if (req.method === "POST" && pathname === "/api/files") {
      const user = await requireAuthenticatedUser(req, res);

      if (!user) {
        return;
      }

      await handleUpload(req, res, user);
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/api/files/")) {
      const user = await requireAuthenticatedUser(req, res);

      if (!user) {
        return;
      }

      const fileId = getFileIdFromPath(pathname);

      if (!fileId) {
        sendError(res, 404, "Файл не найден.");
        return;
      }

      await handleDownload(res, fileId, user);
      return;
    }

    if (req.method === "DELETE" && pathname.startsWith("/api/files/")) {
      const user = await requireAuthenticatedUser(req, res);

      if (!user) {
        return;
      }

      const fileId = getFileIdFromPath(pathname);

      if (!fileId) {
        sendError(res, 404, "Файл не найден.");
        return;
      }

      await handleDelete(res, fileId, user);
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
