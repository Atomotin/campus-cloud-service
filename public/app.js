const state = {
  user: null,
  pendingFile: null
};

const loginForm = document.getElementById("login-form");
const registerForm = document.getElementById("register-form");
const authGuest = document.getElementById("auth-guest");
const authUser = document.getElementById("auth-user");
const currentUserLogin = document.getElementById("current-user-login");
const logoutButton = document.getElementById("logout-button");
const heroUserState = document.getElementById("hero-user-state");
const userStateStat = document.getElementById("user-state-stat");
const dashboard = document.getElementById("dashboard");
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
const uploadButton = document.getElementById("upload-button");
const refreshButton = document.getElementById("refresh-button");
const statusMessage = document.getElementById("status-message");
const filesList = document.getElementById("files-list");
const filesCaption = document.getElementById("files-caption");
const filesCount = document.getElementById("files-count");
const filesSize = document.getElementById("files-size");

function setStatus(message, tone = "neutral") {
  statusMessage.textContent = message;
  statusMessage.dataset.tone = tone;
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

  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderEmptyState(title, description) {
  filesList.innerHTML = `
    <div class="empty-state">
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(description)}</p>
    </div>
  `;
}

function renderFiles(files) {
  filesCount.textContent = String(files.length);
  filesSize.textContent = formatBytes(files.reduce((total, file) => total + file.size, 0));

  if (!state.user) {
    renderEmptyState("Личное облако закрыто", "Войди в аккаунт, чтобы увидеть только свои файлы.");
    return;
  }

  if (!files.length) {
    renderEmptyState("Твоё хранилище пока пустое", "Загрузи первый файл, и он появится только в твоём профиле.");
    return;
  }

  filesList.innerHTML = files
    .map(
      (file) => `
        <article class="file-card">
          <div class="file-card__meta">
            <h3 title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</h3>
            <p>${formatBytes(file.size)} • ${formatDate(file.uploadedAt)}</p>
          </div>

          <div class="file-card__actions">
            <a class="button button--ghost" href="${file.downloadUrl}">Скачать</a>
            <button class="button button--danger" type="button" data-file-id="${file.id}">Удалить</button>
          </div>
        </article>
      `
    )
    .join("");
}

function updateAuthUi(user) {
  const isLoggedIn = Boolean(user);

  authGuest.hidden = isLoggedIn;
  authUser.hidden = !isLoggedIn;
  dashboard.classList.toggle("dashboard--locked", !isLoggedIn);
  dropzone.classList.toggle("dropzone--disabled", !isLoggedIn);

  fileInput.disabled = !isLoggedIn;
  uploadButton.disabled = !isLoggedIn;
  refreshButton.disabled = !isLoggedIn;

  if (isLoggedIn) {
    currentUserLogin.textContent = user.login;
    heroUserState.textContent = user.login;
    userStateStat.textContent = user.login;
    filesCaption.textContent = "Ни один другой пользователь не увидит эти файлы без входа в твой аккаунт.";
    return;
  }

  currentUserLogin.textContent = "";
  heroUserState.textContent = "Гость";
  userStateStat.textContent = "Гость";
  filesCaption.textContent = "Войди в аккаунт, чтобы увидеть своё личное облачное хранилище.";
  filesCount.textContent = "0";
  filesSize.textContent = "0 Б";
  state.pendingFile = null;
  fileInput.value = "";
}

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

  return {
    response,
    payload
  };
}

function setCurrentUser(user) {
  state.user = user;
  updateAuthUi(user);
}

function handleUnauthorized(message) {
  setCurrentUser(null);
  renderFiles([]);
  setStatus(message || "Сессия истекла. Войди снова.", "warning");
}

async function loadFiles({ silent = false } = {}) {
  if (!state.user) {
    renderFiles([]);
    return;
  }

  if (!silent) {
    setStatus("Обновляю список личных файлов...");
  }

  const { response, payload } = await apiRequest("/api/files");

  if (response.status === 401) {
    handleUnauthorized(payload.error);
    return;
  }

  if (!response.ok) {
    throw new Error(payload.error || "Не удалось загрузить список файлов.");
  }

  renderFiles(payload.files || []);

  if (!silent) {
    setStatus("Список личных файлов обновлён.", "success");
  }
}

async function uploadSelectedFile() {
  if (!state.user) {
    setStatus("Сначала войди в аккаунт.", "warning");
    return;
  }

  const file = state.pendingFile || fileInput.files[0];

  if (!file) {
    setStatus("Сначала выбери файл для загрузки.", "warning");
    return;
  }

  setStatus(`Загружаю файл "${file.name}" в твой профиль...`);
  uploadButton.disabled = true;

  try {
    const { response, payload } = await apiRequest("/api/files", {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "x-file-name": encodeURIComponent(file.name)
      },
      body: file
    });

    if (response.status === 401) {
      handleUnauthorized(payload.error);
      return;
    }

    if (!response.ok) {
      throw new Error(payload.error || "Не удалось загрузить файл.");
    }

    state.pendingFile = null;
    fileInput.value = "";
    await loadFiles({ silent: true });
    setStatus(`Файл "${file.name}" успешно загружен в твой аккаунт.`, "success");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    uploadButton.disabled = !state.user;
  }
}

async function deleteFile(fileId) {
  if (!state.user) {
    setStatus("Сначала войди в аккаунт.", "warning");
    return;
  }

  const confirmed = window.confirm("Удалить этот файл из твоего облака?");

  if (!confirmed) {
    return;
  }

  setStatus("Удаляю файл...");

  const { response, payload } = await apiRequest(`/api/files/${fileId}`, {
    method: "DELETE"
  });

  if (response.status === 401) {
    handleUnauthorized(payload.error);
    return;
  }

  if (!response.ok) {
    throw new Error(payload.error || "Не удалось удалить файл.");
  }

  await loadFiles({ silent: true });
  setStatus("Файл удалён.", "success");
}

async function submitAuthForm(url, form) {
  const formData = new FormData(form);
  const login = String(formData.get("login") || "").trim();
  const password = String(formData.get("password") || "");

  const { response, payload } = await apiRequest(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ login, password })
  });

  if (!response.ok) {
    throw new Error(payload.error || "Не удалось выполнить запрос.");
  }

  setCurrentUser(payload.user);
  await loadFiles({ silent: true });
  form.reset();
  setStatus(payload.message || "Готово.", "success");
}

async function logout() {
  const { response, payload } = await apiRequest("/api/logout", {
    method: "POST"
  });

  if (!response.ok) {
    throw new Error(payload.error || "Не удалось выйти из аккаунта.");
  }

  setCurrentUser(null);
  renderFiles([]);
  setStatus("Ты вышел из аккаунта.", "success");
}

async function restoreSession() {
  const { response, payload } = await apiRequest("/api/me");

  if (!response.ok) {
    setCurrentUser(null);
    renderFiles([]);
    setStatus("Войди или зарегистрируйся, чтобы работать с личным облаком.", "neutral");
    return;
  }

  setCurrentUser(payload.user);
  await loadFiles({ silent: true });
  setStatus(`Ты вошёл как ${payload.user.login}.`, "success");
}

loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitAuthForm("/api/login", loginForm).catch((error) => {
    setStatus(error.message, "error");
  });
});

registerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitAuthForm("/api/register", registerForm).catch((error) => {
    setStatus(error.message, "error");
  });
});

logoutButton.addEventListener("click", () => {
  logout().catch((error) => {
    setStatus(error.message, "error");
  });
});

uploadButton.addEventListener("click", () => {
  uploadSelectedFile().catch((error) => {
    setStatus(error.message, "error");
  });
});

refreshButton.addEventListener("click", () => {
  loadFiles().catch((error) => {
    setStatus(error.message, "error");
  });
});

filesList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-file-id]");

  if (!button) {
    return;
  }

  deleteFile(button.dataset.fileId).catch((error) => {
    setStatus(error.message, "error");
  });
});

["dragenter", "dragover"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();

    if (state.user) {
      dropzone.classList.add("dropzone--active");
    }
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove("dropzone--active");
  });
});

dropzone.addEventListener("drop", (event) => {
  if (!state.user) {
    setStatus("Сначала войди в аккаунт.", "warning");
    return;
  }

  const [file] = event.dataTransfer.files;

  if (file) {
    state.pendingFile = file;
    setStatus(`Файл "${file.name}" готов к загрузке.`, "neutral");
  }
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];

  if (file) {
    state.pendingFile = file;
    setStatus(`Выбран файл "${file.name}".`, "neutral");
  }
});

restoreSession().catch((error) => {
  setStatus(error.message, "error");
});
