const state = {
  user: null,
  files: [],
  filter: "all",
  query: "",
  sort: { key: "date", dir: "desc" }
};

const $ = (id) => document.getElementById(id);

const authGuest = $("auth-guest");
const dashboard = $("dashboard");
const loginForm = $("login-form");
const registerForm = $("register-form");
const tabLogin = $("tab-login");
const tabRegister = $("tab-register");
const currentUserLogin = $("current-user-login");
const userAvatar = $("user-avatar");
const logoutButton = $("logout-button");
const dropzone = $("dropzone");
const fileInput = $("file-input");
const uploadButton = $("upload-button");
const refreshButton = $("refresh-button");
const searchInput = $("search-input");
const statusMessage = $("status-message");
const filesList = $("files-list");
const filesCaption = $("files-caption");
const filesCount = $("files-count");
const filesSize = $("files-size");
const usageBar = $("usage-bar");
const usageLegend = $("usage-legend");
const viewTitle = $("view-title");
const uploadQueue = $("upload-queue");
const dragOverlay = $("drag-overlay");
const confirmDialog = $("confirm-dialog");
const confirmText = $("confirm-text");

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;

const CATEGORY_LABELS = {
  all: "Все файлы",
  doc: "Документы",
  sheet: "Таблицы",
  image: "Изображения",
  other: "Другое"
};

const EXT_KIND = {
  doc: ["doc", "docx", "odt", "rtf", "pages"],
  pdf: ["pdf"],
  slides: ["ppt", "pptx", "odp", "key"],
  text: ["txt", "md", "log"],
  sheet: ["xls", "xlsx", "ods", "csv", "numbers", "tsv"],
  image: ["jpg", "jpeg", "png", "gif", "webp", "svg", "heic", "bmp", "avif"],
  archive: ["zip", "rar", "7z", "tar", "gz"],
  audio: ["mp3", "wav", "ogg", "flac", "m4a"],
  video: ["mp4", "mov", "avi", "mkv", "webm"],
  code: ["js", "ts", "py", "java", "c", "cpp", "cs", "html", "css", "json", "xml", "sql", "php", "go"]
};

const KIND_TO_CATEGORY = {
  doc: "doc",
  pdf: "doc",
  slides: "doc",
  text: "doc",
  sheet: "sheet",
  image: "image"
};

/* ---------- helpers ---------- */

let toastTimer = null;

function setStatus(message, tone = "neutral") {
  statusMessage.textContent = message;
  statusMessage.dataset.tone = tone;
  statusMessage.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => statusMessage.classList.remove("is-visible"), tone === "error" ? 6000 : 3200);
}

function formatBytes(value) {
  if (!value) {
    return "0 Б";
  }

  const units = ["Б", "КБ", "МБ", "ГБ"];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const digits = size >= 10 || unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(digits).replace(".", ",")} ${units[unitIndex]}`;
}

const timeFormat = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
const shortDate = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
const longDate = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric" });
const fullDate = new Intl.DateTimeFormat("ru-RU", { dateStyle: "long", timeStyle: "short" });

function formatDate(value) {
  const date = new Date(value);
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);

  if (dayDiff === 0) {
    return `Сегодня, ${timeFormat.format(date)}`;
  }

  if (dayDiff === 1) {
    return `Вчера, ${timeFormat.format(date)}`;
  }

  const formatter = date.getFullYear() === now.getFullYear() ? shortDate : longDate;
  return formatter.format(date).replace(" г.", "");
}

function plural(count, one, few, many) {
  const mod10 = count % 10;
  const mod100 = count % 100;

  if (mod10 === 1 && mod100 !== 11) {
    return one;
  }

  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return few;
  }

  return many;
}

function filesWord(count) {
  return `${count} ${plural(count, "файл", "файла", "файлов")}`;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function splitName(name) {
  const dot = name.lastIndexOf(".");

  if (dot <= 0 || dot === name.length - 1) {
    return { base: name, ext: "" };
  }

  return { base: name.slice(0, dot), ext: name.slice(dot + 1).toLowerCase() };
}

function getKind(name) {
  const { ext } = splitName(name);

  for (const [kind, list] of Object.entries(EXT_KIND)) {
    if (list.includes(ext)) {
      return kind;
    }
  }

  return "other";
}

function getCategory(name) {
  return KIND_TO_CATEGORY[getKind(name)] || "other";
}

function badgeLabel(name) {
  const { ext } = splitName(name);

  if (!ext) {
    return "FILE";
  }

  const short = { docx: "DOC", xlsx: "XLS", pptx: "PPT", jpeg: "JPG" }[ext];
  return (short || ext).slice(0, 4).toUpperCase();
}

function icon(id, cls = "ico") {
  return `<svg class="${cls}" aria-hidden="true"><use href="#${id}" /></svg>`;
}

/* ---------- rendering ---------- */

function visibleFiles() {
  const query = state.query.trim().toLowerCase();
  const { key, dir } = state.sort;
  const sign = dir === "asc" ? 1 : -1;

  return state.files
    .filter((file) => state.filter === "all" || getCategory(file.name) === state.filter)
    .filter((file) => !query || file.name.toLowerCase().includes(query))
    .sort((a, b) => {
      if (key === "name") {
        return sign * a.name.localeCompare(b.name, "ru", { numeric: true });
      }

      if (key === "size") {
        return sign * (a.size - b.size);
      }

      return sign * (new Date(a.uploadedAt) - new Date(b.uploadedAt));
    });
}

function renderEmptyState(kind) {
  const variants = {
    empty: {
      title: "Файлов пока нет — загрузите первый",
      text: "Перетащите файл в это окно или нажмите кнопку ниже. Он будет виден только вам.",
      action: `<button class="btn btn--primary" type="button" data-action="pick">${icon("i-upload", "ico ico--sm")}<span>Выбрать файлы</span></button>`
    },
    search: {
      title: "Ничего не нашлось",
      text: `По запросу «${escapeHtml(state.query.trim())}» файлов нет. Проверьте написание или сбросьте поиск.`,
      action: `<button class="btn btn--ghost" type="button" data-action="clear-search">Сбросить поиск</button>`
    },
    category: {
      title: `В разделе «${CATEGORY_LABELS[state.filter]}» пусто`,
      text: "Как только загрузите подходящий файл, он появится здесь.",
      action: `<button class="btn btn--ghost" type="button" data-action="show-all">Показать все файлы</button>`
    }
  };

  const v = variants[kind];

  filesList.innerHTML = `
    <div class="empty">
      <div class="empty__art" aria-hidden="true">
        <span class="empty__sheet empty__sheet--back"></span>
        <span class="empty__sheet empty__sheet--mid"></span>
        <span class="empty__folder"><i></i></span>
      </div>
      <h2 class="empty__title">${v.title}</h2>
      <p class="empty__text">${v.text}</p>
      ${v.action}
    </div>
  `;
}

function renderUsage() {
  const total = state.files.reduce((sum, file) => sum + file.size, 0);
  const groups = { doc: 0, sheet: 0, image: 0, other: 0 };
  const counts = { all: state.files.length, doc: 0, sheet: 0, image: 0, other: 0 };

  state.files.forEach((file) => {
    const category = getCategory(file.name);
    groups[category] += file.size;
    counts[category] += 1;
  });

  filesSize.textContent = formatBytes(total);
  filesCount.textContent = filesWord(state.files.length);

  document.querySelectorAll("[data-count]").forEach((el) => {
    el.textContent = String(counts[el.dataset.count]);
  });

  const parts = Object.entries(groups).filter(([, size]) => size > 0);

  usageBar.innerHTML = total
    ? parts
        .map(([cat, size]) => `<i data-cat="${cat}" style="flex-grow:${Math.max(size / total, 0.02)}"></i>`)
        .join("")
    : "";

  usageLegend.innerHTML = parts.length
    ? parts
        .map(
          ([cat, size]) =>
            `<li><i data-cat="${cat}"></i><span>${CATEGORY_LABELS[cat]}</span><b>${formatBytes(size)}</b></li>`
        )
        .join("")
    : `<li class="usage__none">Пока пусто</li>`;
}

function renderFiles() {
  renderUsage();

  const files = visibleFiles();
  const shownTotal = files.reduce((sum, file) => sum + file.size, 0);

  viewTitle.textContent = CATEGORY_LABELS[state.filter];
  filesCaption.textContent = files.length
    ? `${filesWord(files.length)} · ${formatBytes(shownTotal)}`
    : "Нет файлов";

  document.querySelectorAll(".sort").forEach((btn) => {
    const active = btn.dataset.sort === state.sort.key;
    btn.classList.toggle("is-active", active);
    btn.classList.toggle("is-asc", active && state.sort.dir === "asc");
    btn.setAttribute("aria-pressed", String(active));
  });

  dashboard.classList.toggle("is-empty", state.files.length === 0);
  dashboard.classList.toggle("no-rows", files.length === 0);

  if (!files.length) {
    if (!state.files.length) {
      renderEmptyState("empty");
    } else if (state.query.trim()) {
      renderEmptyState("search");
    } else {
      renderEmptyState("category");
    }
    return;
  }

  filesList.innerHTML = files
    .map((file) => {
      const { base, ext } = splitName(file.name);
      const kind = getKind(file.name);
      const name = escapeHtml(file.name);

      return `
        <div class="row">
          <a class="row__name" href="${escapeHtml(file.downloadUrl)}" download title="Скачать ${name}">
            <span class="ft" data-kind="${kind}">${escapeHtml(badgeLabel(file.name))}</span>
            <span class="row__label"><span class="row__base">${escapeHtml(base)}</span>${ext ? `<span class="row__ext">.${escapeHtml(ext)}</span>` : ""}</span>
          </a>
          <span class="row__meta">
            <span class="row__size">${formatBytes(file.size)}</span>
            <time class="row__date" datetime="${escapeHtml(file.uploadedAt)}" title="${fullDate.format(new Date(file.uploadedAt))}">${formatDate(file.uploadedAt)}</time>
          </span>
          <span class="row__actions">
            <a class="icon-btn" href="${escapeHtml(file.downloadUrl)}" download aria-label="Скачать ${name}" title="Скачать">${icon("i-download")}</a>
            <button class="icon-btn icon-btn--danger" type="button" data-file-id="${escapeHtml(file.id)}" data-file-name="${name}" aria-label="Удалить ${name}" title="Удалить">${icon("i-trash")}</button>
          </span>
        </div>
      `;
    })
    .join("");
}

function updateAuthUi(user) {
  const isLoggedIn = Boolean(user);

  document.body.classList.remove("is-booting");
  authGuest.hidden = isLoggedIn;
  dashboard.hidden = !isLoggedIn;
  fileInput.disabled = !isLoggedIn;
  uploadButton.disabled = !isLoggedIn;
  refreshButton.disabled = !isLoggedIn;

  if (isLoggedIn) {
    currentUserLogin.textContent = user.login;
    userAvatar.textContent = user.login.slice(0, 1).toUpperCase();
    document.title = "Все файлы — Campus Cloud";
    return;
  }

  document.title = "Вход — Campus Cloud";
  currentUserLogin.textContent = "";
  state.files = [];
  state.query = "";
  state.filter = "all";
  searchInput.value = "";
  fileInput.value = "";
  uploadQueue.innerHTML = "";
}

/* ---------- api ---------- */

async function readJsonResponse(response) {
  const text = await response.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await readJsonResponse(response);

  return { response, payload };
}

function setCurrentUser(user) {
  state.user = user;
  updateAuthUi(user);
}

function handleUnauthorized() {
  setCurrentUser(null);
  setStatus("Сессия истекла — войдите снова.", "warning");
}

async function loadFiles({ silent = false } = {}) {
  if (!state.user) {
    return;
  }

  refreshButton.classList.add("is-spinning");

  try {
    const { response, payload } = await apiRequest("/api/files");

    if (response.status === 401) {
      handleUnauthorized();
      return;
    }

    if (!response.ok) {
      throw new Error(payload.error || "Не удалось получить список файлов.");
    }

    state.files = payload.files || [];
    renderFiles();

    if (!silent) {
      setStatus("Список обновлён", "success");
    }
  } finally {
    refreshButton.classList.remove("is-spinning");
  }
}

function uploadOne(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/files");
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));

    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        onProgress(event.loaded / event.total);
      }
    });

    xhr.addEventListener("load", () => {
      let payload = {};

      try {
        payload = JSON.parse(xhr.responseText || "{}");
      } catch {
        payload = {};
      }

      if (xhr.status === 401) {
        const error = new Error("unauthorized");
        error.unauthorized = true;
        reject(error);
        return;
      }

      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(payload.error || "Не удалось загрузить файл."));
        return;
      }

      resolve(payload);
    });

    xhr.addEventListener("error", () => reject(new Error("Нет связи с сервером.")));
    xhr.send(file);
  });
}

function addQueueItem(file) {
  const item = document.createElement("li");
  item.className = "queue__item";
  item.innerHTML = `
    <span class="ft" data-kind="${getKind(file.name)}">${escapeHtml(badgeLabel(file.name))}</span>
    <span class="queue__body">
      <span class="queue__name">${escapeHtml(file.name)}</span>
      <span class="queue__track"><i></i></span>
    </span>
    <span class="queue__pct">0%</span>
  `;
  uploadQueue.append(item);

  return {
    progress(ratio) {
      const pct = Math.round(ratio * 100);
      item.querySelector(".queue__track i").style.width = `${pct}%`;
      item.querySelector(".queue__pct").textContent = `${pct}%`;
    },
    done() {
      item.classList.add("is-done");
      item.querySelector(".queue__pct").textContent = "Готово";
      setTimeout(() => item.remove(), 1400);
    },
    fail(message) {
      item.classList.add("is-failed");
      item.querySelector(".queue__pct").textContent = "Ошибка";
      item.title = message;
      setTimeout(() => item.remove(), 5000);
    }
  };
}

async function uploadFiles(fileList) {
  if (!state.user) {
    setStatus("Сначала войдите в аккаунт.", "warning");
    return;
  }

  const files = Array.from(fileList || []);

  if (!files.length) {
    return;
  }

  let uploaded = 0;
  let lastError = "";

  for (const file of files) {
    const entry = addQueueItem(file);

    if (file.size > MAX_UPLOAD_SIZE) {
      lastError = `«${file.name}» больше 50 МБ`;
      entry.fail(lastError);
      continue;
    }

    if (!file.size) {
      lastError = `«${file.name}» — пустой файл`;
      entry.fail(lastError);
      continue;
    }

    try {
      await uploadOne(file, entry.progress);
      entry.done();
      uploaded += 1;
    } catch (error) {
      if (error.unauthorized) {
        handleUnauthorized();
        return;
      }

      lastError = error.message;
      entry.fail(error.message);
    }
  }

  fileInput.value = "";
  await loadFiles({ silent: true });

  if (uploaded && !lastError) {
    setStatus(uploaded === 1 ? `«${files[0].name}» загружен` : `Загружено: ${filesWord(uploaded)}`, "success");
  } else if (lastError) {
    setStatus(uploaded ? `Загружено ${uploaded} из ${files.length}. ${lastError}` : lastError, "error");
  }
}

function askConfirm(fileName) {
  if (typeof confirmDialog.showModal !== "function") {
    return Promise.resolve(window.confirm(`Удалить «${fileName}»?`));
  }

  confirmText.textContent = `«${fileName}» будет удалён без возможности восстановления.`;
  confirmDialog.returnValue = "";
  confirmDialog.showModal();

  return new Promise((resolve) => {
    confirmDialog.addEventListener("close", () => resolve(confirmDialog.returnValue === "confirm"), { once: true });
  });
}

async function deleteFile(fileId, fileName) {
  if (!state.user) {
    return;
  }

  const confirmed = await askConfirm(fileName);

  if (!confirmed) {
    return;
  }

  const { response, payload } = await apiRequest(`/api/files/${encodeURIComponent(fileId)}`, {
    method: "DELETE"
  });

  if (response.status === 401) {
    handleUnauthorized();
    return;
  }

  if (!response.ok) {
    throw new Error(payload.error || "Не удалось удалить файл.");
  }

  await loadFiles({ silent: true });
  setStatus(`«${fileName}» удалён`, "success");
}

async function submitAuthForm(url, form) {
  const formData = new FormData(form);
  const login = String(formData.get("login") || "").trim();
  const password = String(formData.get("password") || "");
  const errorBox = form.querySelector("[data-form-error]");
  const submit = form.querySelector('[type="submit"]');

  errorBox.textContent = "";
  submit.disabled = true;
  form.classList.add("is-busy");

  try {
    const { response, payload } = await apiRequest(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login, password })
    });

    if (!response.ok) {
      errorBox.textContent = payload.error || "Не получилось. Попробуйте ещё раз.";
      return;
    }

    form.reset();
    setCurrentUser(payload.user);
    await loadFiles({ silent: true });
    setStatus(url.endsWith("register") ? `Аккаунт создан. Добро пожаловать, ${payload.user.login}!` : `С возвращением, ${payload.user.login}`, "success");
  } catch {
    errorBox.textContent = "Нет связи с сервером. Проверьте подключение.";
  } finally {
    submit.disabled = false;
    form.classList.remove("is-busy");
  }
}

async function logout() {
  const { response, payload } = await apiRequest("/api/logout", { method: "POST" });

  if (!response.ok) {
    throw new Error(payload.error || "Не удалось выйти из аккаунта.");
  }

  setCurrentUser(null);
  selectTab("login");
  setStatus("Вы вышли из аккаунта", "neutral");
}

async function restoreSession() {
  const { response, payload } = await apiRequest("/api/me");

  if (!response.ok) {
    setCurrentUser(null);
    return;
  }

  setCurrentUser(payload.user);
  await loadFiles({ silent: true });
}

/* ---------- tabs ---------- */

function selectTab(name, focus = false) {
  const isLogin = name === "login";
  tabLogin.setAttribute("aria-selected", String(isLogin));
  tabRegister.setAttribute("aria-selected", String(!isLogin));
  tabLogin.tabIndex = isLogin ? 0 : -1;
  tabRegister.tabIndex = isLogin ? -1 : 0;
  loginForm.hidden = !isLogin;
  registerForm.hidden = isLogin;
  authGuest.dataset.tab = name;

  if (focus) {
    (isLogin ? tabLogin : tabRegister).focus();
  }
}

tabLogin.addEventListener("click", () => selectTab("login"));
tabRegister.addEventListener("click", () => selectTab("register"));

[tabLogin, tabRegister].forEach((tab) => {
  tab.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      selectTab(tab === tabLogin ? "register" : "login", true);
    }
  });
});

/* ---------- events ---------- */

loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitAuthForm("/api/login", loginForm);
});

registerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitAuthForm("/api/register", registerForm);
});

logoutButton.addEventListener("click", () => {
  logout().catch((error) => setStatus(error.message, "error"));
});

uploadButton.addEventListener("click", () => fileInput.click());

refreshButton.addEventListener("click", () => {
  loadFiles().catch((error) => setStatus(error.message, "error"));
});

fileInput.addEventListener("change", () => {
  uploadFiles(fileInput.files).catch((error) => setStatus(error.message, "error"));
});

searchInput.addEventListener("input", () => {
  state.query = searchInput.value;
  renderFiles();
});

document.querySelectorAll("[data-filter]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.filter = btn.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach((el) => {
      const active = el === btn;
      el.classList.toggle("is-active", active);
      el.setAttribute("aria-pressed", String(active));
    });
    renderFiles();
  });
});

document.querySelectorAll(".sort").forEach((btn) => {
  btn.addEventListener("click", () => {
    const key = btn.dataset.sort;

    if (state.sort.key === key) {
      state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
    } else {
      state.sort = { key, dir: key === "name" ? "asc" : "desc" };
    }

    renderFiles();
  });
});

filesList.addEventListener("click", (event) => {
  const del = event.target.closest("[data-file-id]");

  if (del) {
    deleteFile(del.dataset.fileId, del.dataset.fileName).catch((error) => setStatus(error.message, "error"));
    return;
  }

  const action = event.target.closest("[data-action]");

  if (!action) {
    return;
  }

  if (action.dataset.action === "pick") {
    fileInput.click();
  } else if (action.dataset.action === "clear-search") {
    searchInput.value = "";
    state.query = "";
    renderFiles();
    searchInput.focus();
  } else if (action.dataset.action === "show-all") {
    document.querySelector('[data-filter="all"]').click();
  }
});

document.addEventListener("keydown", (event) => {
  const tag = (event.target.tagName || "").toLowerCase();

  if (event.key === "/" && state.user && !["input", "textarea"].includes(tag)) {
    event.preventDefault();
    searchInput.focus();
  }

  if (event.key === "Escape" && document.activeElement === searchInput && searchInput.value) {
    searchInput.value = "";
    state.query = "";
    renderFiles();
  }
});

/* drag & drop anywhere on the page */
let dragDepth = 0;

function hasFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes("Files");
}

window.addEventListener("dragenter", (event) => {
  if (!state.user || !hasFiles(event)) {
    return;
  }

  event.preventDefault();
  dragDepth += 1;
  dragOverlay.hidden = false;
  dropzone.classList.add("is-active");
});

window.addEventListener("dragover", (event) => {
  if (state.user && hasFiles(event)) {
    event.preventDefault();
  }
});

window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);

  if (!dragDepth) {
    dragOverlay.hidden = true;
    dropzone.classList.remove("is-active");
  }
});

window.addEventListener("drop", (event) => {
  if (!hasFiles(event)) {
    return;
  }

  event.preventDefault();
  dragDepth = 0;
  dragOverlay.hidden = true;
  dropzone.classList.remove("is-active");

  if (!state.user) {
    return;
  }

  uploadFiles(event.dataTransfer.files).catch((error) => setStatus(error.message, "error"));
});

restoreSession().catch(() => {
  setCurrentUser(null);
  setStatus("Сервер недоступен. Обновите страницу чуть позже.", "error");
});
