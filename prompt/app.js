import {
  env,
  pipeline,
  RawImage
} from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const MODEL_ID = "Xenova/vit-gpt2-image-captioning";

env.allowLocalModels = false;
env.useBrowserCache = true;

const dropZone = document.querySelector("#dropZone");
const fileInput = document.querySelector("#fileInput");
const emptyState = document.querySelector("#emptyState");
const previewState = document.querySelector("#previewState");
const previewImage = document.querySelector("#previewImage");
const removeButton = document.querySelector("#removeButton");
const promptMode = document.querySelector("#promptMode");
const detailMode = document.querySelector("#detailMode");
const analyzeButton = document.querySelector("#analyzeButton");
const copyButton = document.querySelector("#copyButton");
const clearButton = document.querySelector("#clearButton");
const placeholderText = document.querySelector("#placeholderText");
const promptText = document.querySelector("#promptText");
const loadingState = document.querySelector("#loadingState");
const loadingTitle = document.querySelector("#loadingTitle");
const loadingText = document.querySelector("#loadingText");
const progressBar = document.querySelector("#progressBar");
const statusText = document.querySelector("#statusText");

let currentFile = null;
let currentImageUrl = "";
let captionerPromise = null;
let isAnalyzing = false;
let imageRevision = 0;

dropZone.addEventListener("click", () => {
  if (!currentFile) {
    fileInput.click();
  }
});

dropZone.addEventListener("keydown", (event) => {
  if (!currentFile && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    fileInput.click();
  }
});

fileInput.addEventListener("change", () => {
  const [file] = fileInput.files;
  if (file) {
    setImage(file, "file");
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
    setImage(file, "drop");
  }
});

window.addEventListener("paste", async (event) => {
  const imageItem = [...event.clipboardData.items].find((item) => item.type.startsWith("image/"));
  const file = imageItem?.getAsFile();
  if (file) {
    event.preventDefault();
    await setImage(file, "clipboard");
  }
});

removeButton.addEventListener("click", (event) => {
  event.stopPropagation();
  resetImage();
});

analyzeButton.addEventListener("click", analyzeImage);
clearButton.addEventListener("click", clearOutput);
promptMode.addEventListener("change", refreshFormattedPrompt);
detailMode.addEventListener("change", refreshFormattedPrompt);

copyButton.addEventListener("click", async () => {
  const text = promptText.textContent.trim();
  if (!text) {
    return;
  }

  await navigator.clipboard.writeText(text);
  const originalLabel = copyButton.textContent;
  copyButton.textContent = "복사됨";
  window.setTimeout(() => {
    copyButton.textContent = originalLabel;
  }, 1300);
});

async function setImage(file, source) {
  const error = validateFile(file);
  if (error) {
    showInputError(error);
    return;
  }

  const selectionRevision = ++imageRevision;
  const bytes = await file.arrayBuffer();
  if (selectionRevision !== imageRevision) {
    return;
  }

  const extension = mimeExtension(file.type);
  const sourceName = source === "clipboard"
    ? `clipboard-${Date.now()}.${extension}`
    : file.name;
  const snapshot = new File([bytes], sourceName, {
    type: file.type,
    lastModified: Date.now()
  });
  const fingerprint = await createFingerprint(bytes);
  if (selectionRevision !== imageRevision) {
    return;
  }

  resetImageUrl();
  currentFile = snapshot;
  currentImageUrl = URL.createObjectURL(snapshot);
  previewImage.src = currentImageUrl;
  emptyState.hidden = true;
  previewState.hidden = false;
  analyzeButton.disabled = false;
  clearOutput();
  statusText.textContent = `${sourceName} · ${formatBytes(snapshot.size)} · ID ${fingerprint}`;
}

async function analyzeImage() {
  if (!currentFile || isAnalyzing) {
    return;
  }

  isAnalyzing = true;
  const analyzedFile = currentFile;
  const analyzedRevision = imageRevision;
  analyzeButton.disabled = true;
  copyButton.disabled = true;
  promptText.hidden = true;
  placeholderText.hidden = true;
  loadingState.hidden = false;
  loadingTitle.textContent = "AI 모델을 준비하고 있습니다";
  loadingText.textContent = "첫 실행은 모델 파일을 내려받아 시간이 더 걸릴 수 있습니다.";
  progressBar.style.width = "3%";

  try {
    const captioner = await getCaptioner();
    loadingTitle.textContent = "이미지를 읽고 있습니다";
    loadingText.textContent = "주요 대상과 실제 픽셀의 색상, 밝기, 구도를 확인하고 있습니다.";
    progressBar.style.width = "88%";

    const inputImage = await RawImage.fromBlob(analyzedFile);
    const [output, visualDetails] = await Promise.all([
      captioner(inputImage, {
        max_new_tokens: 72,
        num_beams: 4,
        repetition_penalty: 1.15
      }),
      describeVisualProperties(analyzedFile)
    ]);

    if (analyzedRevision !== imageRevision || analyzedFile !== currentFile) {
      return;
    }

    const rawCaption = output?.[0]?.generated_text?.trim();
    if (!rawCaption) {
      throw new Error("The image caption model returned no text.");
    }

    promptText.dataset.caption = normalizeCaption(
      mergeVisualDetails(rawCaption, visualDetails)
    );
    refreshFormattedPrompt();
    loadingState.hidden = true;
    promptText.hidden = false;
    copyButton.disabled = false;
    progressBar.style.width = "100%";
    statusText.textContent = "이미지 분석이 완료되었습니다.";
  } catch (error) {
    console.error(error);
    loadingState.hidden = true;
    placeholderText.hidden = false;
    placeholderText.textContent = "이미지를 분석하지 못했습니다. 브라우저를 새로고침하거나 다른 이미지로 다시 시도해 주세요.";
    statusText.textContent = "모델 또는 이미지 로딩 중 오류가 발생했습니다.";
  } finally {
    isAnalyzing = false;
    analyzeButton.disabled = !currentFile;
  }
}

function getCaptioner() {
  if (!captionerPromise) {
    captionerPromise = pipeline("image-to-text", MODEL_ID, {
      dtype: "q8",
      device: "wasm",
      progress_callback: updateModelProgress
    }).catch((error) => {
      captionerPromise = null;
      throw error;
    });
  }

  return captionerPromise;
}

function updateModelProgress(progress) {
  if (!progress) {
    return;
  }

  const percent = Number.isFinite(progress.progress)
    ? Math.round(progress.progress)
    : null;

  if (percent !== null) {
    progressBar.style.width = `${Math.max(3, Math.min(84, percent * 0.84))}%`;
    loadingText.textContent = `이미지 분석 모델을 내려받고 있습니다 · ${percent}%`;
  } else if (progress.status === "ready") {
    progressBar.style.width = "84%";
    loadingText.textContent = "모델 준비가 완료되었습니다.";
  }
}

function refreshFormattedPrompt() {
  const caption = promptText.dataset.caption;
  if (!caption) {
    return;
  }

  promptText.textContent = formatPrompt(caption, promptMode.value, detailMode.value);
}

function formatPrompt(caption, mode, detail) {
  let text = caption.replace(/[.]+$/, "");

  if (mode === "generation") {
    text = `${text}, faithful to the visible subject, clear composition, coherent colors, accurate proportions`;
  } else if (mode === "game") {
    text = `${text}, game asset reference, clearly readable silhouette, consistent proportions, clean visual details`;
  }

  if (detail === "compact") {
    return text
      .replace(/\b(a|an|the|there is|there are)\b/gi, "")
      .replace(/\s+/g, " ")
      .replace(/\s+,/g, ",")
      .trim();
  }

  if (detail === "detailed") {
    return `A detailed visual description of ${lowercaseFirst(text)}, including the visible subject, pose, clothing or surface details, colors, surrounding objects, background, lighting, and composition. Do not add elements that are not visible in the reference image.`;
  }

  return `${capitalizeFirst(text)}.`;
}

function normalizeCaption(text) {
  return text
    .replace(/\s+/g, " ")
    .replace(/^\s+|\s+$/g, "")
    .replace(/\s+([,.!?])/g, "$1");
}

function capitalizeFirst(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function lowercaseFirst(text) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function clearOutput() {
  promptText.textContent = "";
  delete promptText.dataset.caption;
  promptText.hidden = true;
  loadingState.hidden = true;
  placeholderText.hidden = false;
  placeholderText.textContent = "이미지를 선택하면 영어 프롬프트가 여기에 표시됩니다.";
  copyButton.disabled = true;
}

function resetImage() {
  currentFile = null;
  imageRevision += 1;
  fileInput.value = "";
  resetImageUrl();
  previewImage.removeAttribute("src");
  previewState.hidden = true;
  emptyState.hidden = false;
  analyzeButton.disabled = true;
  clearOutput();
  statusText.textContent = "모델은 필요할 때 브라우저에 한 번만 내려받습니다.";
}

function resetImageUrl() {
  if (currentImageUrl) {
    URL.revokeObjectURL(currentImageUrl);
    currentImageUrl = "";
  }
}

function validateFile(file) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    return "PNG, JPG 또는 WEBP 이미지를 선택해 주세요.";
  }

  if (file.size > MAX_FILE_SIZE) {
    return "파일 크기는 25MB 이하여야 합니다.";
  }

  return "";
}

function showInputError(message) {
  const help = emptyState.querySelector("small");
  help.textContent = message;
  help.classList.add("is-error");
  window.setTimeout(() => {
    help.textContent = "PNG, JPG, WEBP · Ctrl+V 지원 · 최대 25MB";
    help.classList.remove("is-error");
  }, 3500);
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

async function createFingerprint(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .slice(0, 4)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function mimeExtension(type) {
  if (type === "image/jpeg") {
    return "jpg";
  }

  if (type === "image/webp") {
    return "webp";
  }

  return "png";
}

async function describeVisualProperties(file) {
  const bitmap = await createImageBitmap(file);
  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;
  const canvas = document.createElement("canvas");
  const sampleSize = 48;
  canvas.width = sampleSize;
  canvas.height = sampleSize;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, sampleSize, sampleSize);
  bitmap.close?.();

  const pixels = context.getImageData(0, 0, sampleSize, sampleSize).data;
  const colorCounts = new Map();
  let brightnessTotal = 0;
  let opaquePixels = 0;

  for (let index = 0; index < pixels.length; index += 16) {
    if (pixels[index + 3] < 32) {
      continue;
    }

    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    brightnessTotal += (red * 0.299) + (green * 0.587) + (blue * 0.114);
    opaquePixels += 1;
    const color = colorName(red, green, blue);
    colorCounts.set(color, (colorCounts.get(color) || 0) + 1);
  }

  const colors = [...colorCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([color]) => color);
  const brightness = opaquePixels ? brightnessTotal / opaquePixels : 128;

  return {
    colors,
    lighting: brightness < 78 ? "dark" : brightness > 184 ? "bright" : "balanced",
    orientation: sourceWidth > sourceHeight
      ? "landscape"
      : sourceHeight > sourceWidth
        ? "portrait"
        : "square"
  };
}

function mergeVisualDetails(caption, details) {
  const text = caption.replace(/[.]+$/, "");
  const colorText = details.colors.length
    ? `predominantly ${joinEnglish(details.colors)}`
    : "";
  const additions = [
    colorText,
    `${details.lighting} lighting`,
    `${details.orientation} composition`
  ].filter(Boolean);
  return additions.length ? `${text}, ${additions.join(", ")}` : text;
}

function colorName(red, green, blue) {
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const spread = max - min;
  const brightness = (max + min) / 2;

  if (brightness < 35) return "black";
  if (brightness > 225 && spread < 28) return "white";
  if (spread < 22) return brightness < 105 ? "dark gray" : brightness > 185 ? "light gray" : "gray";
  if (red > green * 1.25 && red > blue * 1.25) return red > 175 && green > 85 ? "orange" : "red";
  if (blue > red * 1.22 && blue > green * 1.12) return blue > 150 && red > 95 ? "purple" : "blue";
  if (green > red * 1.16 && green > blue * 1.08) return green > 150 && red > 120 ? "yellow-green" : "green";
  if (red > 160 && green > 135 && blue < 120) return "yellow";
  if (red > 150 && blue > 130 && green < 145) return "pink";
  if (red > 125 && green > 75 && blue < 75) return "brown";
  return max === blue ? "blue" : max === green ? "green" : "warm red";
}

function joinEnglish(items) {
  if (items.length <= 1) return items[0] || "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}
