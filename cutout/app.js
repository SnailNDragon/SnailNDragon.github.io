import { removeBackground } from "https://esm.sh/@imgly/background-removal@1.7.0?bundle";

const MAX_FILE_SIZE = 25 * 1024 * 1024;

const dropZone = document.querySelector("#dropZone");
const fileInput = document.querySelector("#fileInput");
const editor = document.querySelector("#editor");
const originalImage = document.querySelector("#originalImage");
const resultImage = document.querySelector("#resultImage");
const fileMeta = document.querySelector("#fileMeta");
const resultBadge = document.querySelector("#resultBadge");
const processingState = document.querySelector("#processingState");
const statusTitle = document.querySelector("#statusTitle");
const statusText = document.querySelector("#statusText");
const progressBar = document.querySelector("#progressBar");
const statusDot = document.querySelector("#statusDot");
const statusSummary = document.querySelector("#statusSummary");
const resetButton = document.querySelector("#resetButton");
const downloadButton = document.querySelector("#downloadButton");

let originalUrl = "";
let resultUrl = "";
let resultBlob = null;
let currentFile = null;
let taskId = 0;

const config = {
  model: "isnet_fp16",
  device: "cpu",
  output: {
    format: "image/png",
    quality: 1,
    type: "foreground"
  },
  progress: updateProgress
};

dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    fileInput.click();
  }
});

fileInput.addEventListener("change", () => {
  const [file] = fileInput.files;
  if (file) {
    processFile(file);
  }
});

for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
}

for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
  });
}

dropZone.addEventListener("drop", (event) => {
  const [file] = event.dataTransfer.files;
  if (file) {
    processFile(file);
  }
});

window.addEventListener("paste", (event) => {
  const imageItem = [...event.clipboardData.items].find((item) => item.type.startsWith("image/"));
  const file = imageItem?.getAsFile();
  if (file) {
    processFile(file);
  }
});

resetButton.addEventListener("click", resetWorkspace);

downloadButton.addEventListener("click", () => {
  if (!resultBlob || !resultUrl || !currentFile) {
    return;
  }

  const link = document.createElement("a");
  const baseName = currentFile.name.replace(/\.[^.]+$/, "") || "cutout";
  link.href = resultUrl;
  link.download = `${baseName}-transparent.png`;
  document.body.appendChild(link);
  link.click();
  link.remove();
});

async function processFile(file) {
  const validationError = validateFile(file);
  if (validationError) {
    showDropError(validationError);
    return;
  }

  const myTaskId = ++taskId;
  currentFile = file;
  clearUrls();

  originalUrl = URL.createObjectURL(file);
  originalImage.src = originalUrl;
  resultImage.hidden = true;
  resultImage.removeAttribute("src");
  fileMeta.textContent = `${file.name} · ${formatBytes(file.size)}`;

  dropZone.hidden = true;
  editor.hidden = false;
  processingState.hidden = false;
  downloadButton.disabled = true;
  resultBadge.textContent = "처리 중";
  resultBadge.className = "result-badge";
  statusDot.className = "status-dot is-working";
  statusSummary.textContent = "배경을 분석하고 있습니다";
  statusTitle.textContent = "AI 모델 준비 중";
  statusText.textContent = "첫 실행은 모델 다운로드로 시간이 더 걸릴 수 있습니다.";
  progressBar.style.width = "4%";

  try {
    resultBlob = await removeBackground(file, config);
    if (myTaskId !== taskId) {
      return;
    }

    resultUrl = URL.createObjectURL(resultBlob);
    resultImage.src = resultUrl;
    resultImage.hidden = false;
    processingState.hidden = true;
    resultBadge.textContent = "완료";
    resultBadge.className = "result-badge is-ready";
    statusDot.className = "status-dot is-ready";
    statusSummary.textContent = "투명 PNG가 준비되었습니다";
    downloadButton.disabled = false;
  } catch (error) {
    if (myTaskId !== taskId) {
      return;
    }

    console.error(error);
    resultBlob = null;
    resultBadge.textContent = "오류";
    resultBadge.className = "result-badge is-error";
    statusDot.className = "status-dot is-error";
    statusSummary.textContent = "배경 제거를 완료하지 못했습니다";
    statusTitle.textContent = "처리 중 문제가 발생했습니다";
    statusText.textContent = "브라우저를 새로고침하거나 더 작은 이미지로 다시 시도해 주세요.";
    progressBar.style.width = "0%";
  }
}

function updateProgress(key, current, total) {
  if (!total || total <= 0) {
    return;
  }

  const percent = Math.max(4, Math.min(100, Math.round((current / total) * 100)));
  progressBar.style.width = `${percent}%`;

  if (key.startsWith("compute:")) {
    statusTitle.textContent = "피사체를 정밀하게 분리하는 중";
    statusText.textContent = "윤곽과 가장자리의 투명도를 계산하고 있습니다.";
    statusSummary.textContent = "이미지를 처리하고 있습니다";
  } else {
    statusTitle.textContent = "AI 모델을 불러오는 중";
    statusText.textContent = `필요한 파일을 준비하고 있습니다 · ${percent}%`;
    statusSummary.textContent = "처리 엔진을 준비하고 있습니다";
  }
}

function validateFile(file) {
  const allowedTypes = ["image/png", "image/jpeg", "image/webp"];
  if (!allowedTypes.includes(file.type)) {
    return "PNG, JPG 또는 WEBP 이미지를 선택해 주세요.";
  }

  if (file.size > MAX_FILE_SIZE) {
    return "파일 크기는 25MB 이하여야 합니다.";
  }

  return "";
}

function showDropError(message) {
  const help = document.querySelector("#uploadHelp");
  help.textContent = message;
  help.classList.add("is-error");
  window.setTimeout(() => {
    help.textContent = "PNG, JPG, WEBP · 최대 25MB";
    help.classList.remove("is-error");
  }, 3500);
}

function resetWorkspace() {
  taskId += 1;
  currentFile = null;
  resultBlob = null;
  fileInput.value = "";
  clearUrls();
  editor.hidden = true;
  dropZone.hidden = false;
  dropZone.focus();
}

function clearUrls() {
  if (originalUrl) {
    URL.revokeObjectURL(originalUrl);
    originalUrl = "";
  }

  if (resultUrl) {
    URL.revokeObjectURL(resultUrl);
    resultUrl = "";
  }
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
