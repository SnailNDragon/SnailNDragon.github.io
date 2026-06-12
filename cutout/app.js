import { removeBackground } from "https://esm.sh/@imgly/background-removal@1.7.0?bundle";

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const SELECT_MASK_MAX_SIZE = 900;

const dropZone = document.querySelector("#dropZone");
const fileInput = document.querySelector("#fileInput");
const editor = document.querySelector("#editor");
const originalImage = document.querySelector("#originalImage");
const resultCanvas = document.querySelector("#resultCanvas");
const resultContext = resultCanvas.getContext("2d", { willReadFrequently: true });
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
const editToolbar = document.querySelector("#editToolbar");
const toolHint = document.querySelector("#toolHint");
const brushSize = document.querySelector("#brushSize");
const undoButton = document.querySelector("#undoButton");
const restoreButton = document.querySelector("#restoreButton");
const modeButtons = [...document.querySelectorAll("[data-mode]")];

let originalUrl = "";
let currentFile = null;
let originalBitmap = null;
let aiResultCanvas = null;
let undoCanvas = null;
let taskId = 0;
let editMode = "select";
let drawing = false;
let lastPoint = null;

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

for (const button of modeButtons) {
  button.addEventListener("click", () => setEditMode(button.dataset.mode));
}

resultCanvas.addEventListener("pointerdown", beginCanvasEdit);
resultCanvas.addEventListener("pointermove", continueCanvasEdit);
resultCanvas.addEventListener("pointerup", endCanvasEdit);
resultCanvas.addEventListener("pointercancel", endCanvasEdit);
resultCanvas.addEventListener("contextmenu", (event) => event.preventDefault());

undoButton.addEventListener("click", undoLastEdit);
restoreButton.addEventListener("click", restoreAiResult);
resetButton.addEventListener("click", resetWorkspace);

downloadButton.addEventListener("click", () => {
  if (!currentFile || resultCanvas.hidden) {
    return;
  }

  resultCanvas.toBlob((blob) => {
    if (!blob) {
      return;
    }

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const baseName = currentFile.name.replace(/\.[^.]+$/, "") || "cutout";
    link.href = url;
    link.download = `${baseName}-transparent.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, "image/png");
});

async function processFile(file) {
  const validationError = validateFile(file);
  if (validationError) {
    showDropError(validationError);
    return;
  }

  const myTaskId = ++taskId;
  currentFile = file;
  clearImageResources();

  originalUrl = URL.createObjectURL(file);
  originalImage.src = originalUrl;
  resultCanvas.hidden = true;
  editToolbar.hidden = true;
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
    const [resultBlob, sourceBitmap] = await Promise.all([
      removeBackground(file, config),
      createImageBitmap(file)
    ]);

    if (myTaskId !== taskId) {
      sourceBitmap.close?.();
      return;
    }

    const resultBitmap = await createImageBitmap(resultBlob);
    if (myTaskId !== taskId) {
      sourceBitmap.close?.();
      resultBitmap.close?.();
      return;
    }

    originalBitmap = sourceBitmap;
    resultCanvas.width = resultBitmap.width;
    resultCanvas.height = resultBitmap.height;
    resultContext.clearRect(0, 0, resultCanvas.width, resultCanvas.height);
    resultContext.drawImage(resultBitmap, 0, 0);

    aiResultCanvas = cloneCanvas(resultCanvas);
    undoCanvas = null;
    undoButton.disabled = true;
    resultBitmap.close?.();

    resultCanvas.hidden = false;
    editToolbar.hidden = false;
    processingState.hidden = true;
    resultBadge.textContent = "편집 가능";
    resultBadge.className = "result-badge is-ready";
    statusDot.className = "status-dot is-ready";
    statusSummary.textContent = "오브젝트를 선택하거나 브러시로 결과를 보정하세요";
    downloadButton.disabled = false;
    setEditMode("select");
  } catch (error) {
    if (myTaskId !== taskId) {
      return;
    }

    console.error(error);
    resultBadge.textContent = "오류";
    resultBadge.className = "result-badge is-error";
    statusDot.className = "status-dot is-error";
    statusSummary.textContent = "배경 제거를 완료하지 못했습니다";
    statusTitle.textContent = "처리 중 문제가 발생했습니다";
    statusText.textContent = "브라우저를 새로고침하거나 더 작은 이미지로 다시 시도해 주세요.";
    progressBar.style.width = "0%";
  }
}

function beginCanvasEdit(event) {
  if (resultCanvas.hidden || !originalBitmap) {
    return;
  }

  event.preventDefault();
  const point = getCanvasPoint(event);

  if (editMode === "select") {
    selectConnectedObject(point);
    return;
  }

  saveUndoState();
  drawing = true;
  lastPoint = point;
  resultCanvas.setPointerCapture(event.pointerId);
  paintAt(point);
}

function continueCanvasEdit(event) {
  if (!drawing || (editMode !== "keep" && editMode !== "erase")) {
    return;
  }

  event.preventDefault();
  const point = getCanvasPoint(event);
  paintLine(lastPoint, point);
  lastPoint = point;
}

function endCanvasEdit(event) {
  if (!drawing) {
    return;
  }

  drawing = false;
  lastPoint = null;
  if (resultCanvas.hasPointerCapture(event.pointerId)) {
    resultCanvas.releasePointerCapture(event.pointerId);
  }
  markEdited();
}

function paintLine(from, to) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const radius = getBrushRadius();
  const steps = Math.max(1, Math.ceil(distance / Math.max(1, radius * 0.35)));

  for (let step = 1; step <= steps; step += 1) {
    const ratio = step / steps;
    paintAt({
      x: from.x + (to.x - from.x) * ratio,
      y: from.y + (to.y - from.y) * ratio
    });
  }
}

function paintAt(point) {
  const radius = getBrushRadius();
  resultContext.save();
  resultContext.beginPath();
  resultContext.arc(point.x, point.y, radius, 0, Math.PI * 2);
  resultContext.clip();

  if (editMode === "keep") {
    resultContext.globalCompositeOperation = "source-over";
    resultContext.drawImage(originalBitmap, 0, 0, resultCanvas.width, resultCanvas.height);
  } else {
    resultContext.globalCompositeOperation = "destination-out";
    resultContext.fillStyle = "#000";
    resultContext.fillRect(point.x - radius, point.y - radius, radius * 2, radius * 2);
  }

  resultContext.restore();
}

function selectConnectedObject(point) {
  const scale = Math.min(1, SELECT_MASK_MAX_SIZE / Math.max(resultCanvas.width, resultCanvas.height));
  const width = Math.max(1, Math.round(resultCanvas.width * scale));
  const height = Math.max(1, Math.round(resultCanvas.height * scale));
  const sampleCanvas = document.createElement("canvas");
  sampleCanvas.width = width;
  sampleCanvas.height = height;
  const sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true });
  sampleContext.drawImage(resultCanvas, 0, 0, width, height);

  const imageData = sampleContext.getImageData(0, 0, width, height);
  const startX = Math.min(width - 1, Math.max(0, Math.floor(point.x * scale)));
  const startY = Math.min(height - 1, Math.max(0, Math.floor(point.y * scale)));
  const startIndex = startY * width + startX;
  const alphaThreshold = 12;

  if (imageData.data[startIndex * 4 + 3] <= alphaThreshold) {
    statusSummary.textContent = "남아 있는 오브젝트 위를 클릭해 주세요";
    return;
  }

  saveUndoState();
  statusSummary.textContent = "선택한 오브젝트를 분리하고 있습니다";
  const selected = new Uint8Array(width * height);
  const queue = new Uint32Array(width * height);
  let head = 0;
  let tail = 0;
  queue[tail++] = startIndex;
  selected[startIndex] = 1;

  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    const y = Math.floor(index / width);

    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      const nextY = y + offsetY;
      if (nextY < 0 || nextY >= height) {
        continue;
      }

      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        if (offsetX === 0 && offsetY === 0) {
          continue;
        }

        const nextX = x + offsetX;
        if (nextX < 0 || nextX >= width) {
          continue;
        }

        const nextIndex = nextY * width + nextX;
        if (selected[nextIndex] || imageData.data[nextIndex * 4 + 3] <= alphaThreshold) {
          continue;
        }

        selected[nextIndex] = 1;
        queue[tail++] = nextIndex;
      }
    }
  }

  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = width;
  maskCanvas.height = height;
  const maskContext = maskCanvas.getContext("2d");
  const maskData = maskContext.createImageData(width, height);

  for (let index = 0; index < selected.length; index += 1) {
    if (!selected[index]) {
      continue;
    }

    const pixelIndex = index * 4;
    maskData.data[pixelIndex] = 255;
    maskData.data[pixelIndex + 1] = 255;
    maskData.data[pixelIndex + 2] = 255;
    maskData.data[pixelIndex + 3] = 255;
  }

  maskContext.putImageData(maskData, 0, 0);
  resultContext.save();
  resultContext.globalCompositeOperation = "destination-in";
  resultContext.imageSmoothingEnabled = false;
  resultContext.drawImage(maskCanvas, 0, 0, resultCanvas.width, resultCanvas.height);
  resultContext.restore();
  markEdited("선택한 오브젝트만 남겼습니다. 빠진 부분은 남기기 브러시로 복원할 수 있습니다");
}

function setEditMode(mode) {
  editMode = mode;
  for (const button of modeButtons) {
    button.classList.toggle("is-active", button.dataset.mode === mode);
  }

  brushSize.disabled = mode === "select";
  resultCanvas.dataset.mode = mode;

  if (mode === "select") {
    toolHint.textContent = "결과 이미지에서 남길 물체를 클릭하면 다른 물체를 숨깁니다.";
  } else if (mode === "keep") {
    toolHint.textContent = "AI가 지운 부분을 칠하면 원본 픽셀이 다시 나타납니다.";
  } else {
    toolHint.textContent = "불필요하게 남은 부분을 칠해서 투명하게 지웁니다.";
  }
}

function saveUndoState() {
  undoCanvas = cloneCanvas(resultCanvas);
  undoButton.disabled = false;
}

function undoLastEdit() {
  if (!undoCanvas) {
    return;
  }

  resultContext.clearRect(0, 0, resultCanvas.width, resultCanvas.height);
  resultContext.drawImage(undoCanvas, 0, 0);
  undoCanvas = null;
  undoButton.disabled = true;
  statusSummary.textContent = "마지막 편집을 취소했습니다";
}

function restoreAiResult() {
  if (!aiResultCanvas) {
    return;
  }

  saveUndoState();
  resultContext.clearRect(0, 0, resultCanvas.width, resultCanvas.height);
  resultContext.drawImage(aiResultCanvas, 0, 0);
  markEdited("처음 AI 배경 제거 결과로 되돌렸습니다");
}

function markEdited(message = "수정된 투명 PNG를 다운로드할 수 있습니다") {
  resultBadge.textContent = "수정됨";
  resultBadge.className = "result-badge is-ready";
  statusDot.className = "status-dot is-ready";
  statusSummary.textContent = message;
}

function getCanvasPoint(event) {
  const rect = resultCanvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * (resultCanvas.width / rect.width),
    y: (event.clientY - rect.top) * (resultCanvas.height / rect.height)
  };
}

function getBrushRadius() {
  const rect = resultCanvas.getBoundingClientRect();
  const displayScale = resultCanvas.width / Math.max(1, rect.width);
  return Math.max(1, Number(brushSize.value) * 0.5 * displayScale);
}

function cloneCanvas(source) {
  const clone = document.createElement("canvas");
  clone.width = source.width;
  clone.height = source.height;
  clone.getContext("2d").drawImage(source, 0, 0);
  return clone;
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
  fileInput.value = "";
  clearImageResources();
  editor.hidden = true;
  dropZone.hidden = false;
  dropZone.focus();
}

function clearImageResources() {
  if (originalUrl) {
    URL.revokeObjectURL(originalUrl);
    originalUrl = "";
  }

  originalBitmap?.close?.();
  originalBitmap = null;
  aiResultCanvas = null;
  undoCanvas = null;
  undoButton.disabled = true;
  drawing = false;
  lastPoint = null;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
