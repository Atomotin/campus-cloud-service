const fileInput = document.getElementById("file-input");
const uploadButton = document.getElementById("upload-button");
const refreshButton = document.getElementById("refresh-button");
const statusMessage = document.getElementById("status-message");
const filesList = document.getElementById("files-list");
const filesCount = document.getElementById("files-count");
const filesSize = document.getElementById("files-size");
const dropzone = document.querySelector(".dropzone");
let pendingFile = null;

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

function renderFiles(files) {
  filesCount.textContent = String(files.length);
  filesSize.textContent = formatBytes(files.reduce((total, file) => total + file.size, 0));

  if (!files.length) {
    filesList.innerHTML = `
      <div class="empty-state">
        <strong>Хранилище пока пустое</strong>
        <p>Загрузи первый файл, и он появится здесь.</p>
      </div>
    `;
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

async function loadFiles() {
  setStatus("Обновляю список файлов...");

  const response = await fetch("/api/files");
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Не удалось загрузить список файлов.");
  }

  renderFiles(payload.files);
  setStatus("Список файлов обновлён.", "success");
}

async function uploadSelectedFile() {
  const file = pendingFile || fileInput.files[0];

  if (!file) {
    setStatus("Сначала выбери файл для загрузки.", "warning");
    return;
  }

  setStatus(`Загружаю файл "${file.name}"...`);
  uploadButton.disabled = true;

  try {
    const response = await fetch("/api/files", {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "x-file-name": encodeURIComponent(file.name)
      },
      body: file
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Не удалось загрузить файл.");
    }

    pendingFile = null;
    fileInput.value = "";
    setStatus(`Файл "${file.name}" успешно загружен.`, "success");
    await loadFiles();
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    uploadButton.disabled = false;
  }
}

async function deleteFile(fileId) {
  setStatus("Удаляю файл...");

  const response = await fetch(`/api/files/${fileId}`, {
    method: "DELETE"
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Не удалось удалить файл.");
  }

  setStatus("Файл удалён.", "success");
  await loadFiles();
}

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
    dropzone.classList.add("dropzone--active");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove("dropzone--active");
  });
});

dropzone.addEventListener("drop", (event) => {
  const [file] = event.dataTransfer.files;

  if (file) {
    pendingFile = file;
    setStatus(`Файл "${file.name}" готов к загрузке.`, "neutral");
  }
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];

  if (file) {
    pendingFile = file;
    setStatus(`Выбран файл "${file.name}".`, "neutral");
  }
});

loadFiles().catch((error) => {
  setStatus(error.message, "error");
});
