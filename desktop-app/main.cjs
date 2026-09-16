const { app } = require("electron");

// Apply the fallback before creating the first window. Some Windows graphics
// drivers fail before Electron's first paint.
app.disableHardwareAcceleration();

const { BrowserWindow, ipcMain, dialog, desktopCapturer, session } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const ffmpegPath = require("ffmpeg-static");
const { WaveFile } = require("wavefile");
const { SUPPORTED_MEDIA_EXTENSIONS, normalizeMediaExtension, getMediaType, transcodeMediaToWav } = require("./media-utils.cjs");

let mainWindow;
let whisperPipeline;
let whisperLoad;
const captureSources = new Map();
let selectedCaptureSource = null;
const importedMedia = new Map();

function startupLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  console.error(line.trim());
  if (app.isReady()) {
    fs.appendFile(path.join(app.getPath("userData"), "startup.log"), line).catch(() => {});
  }
}

function clearImportedMediaForSender(senderId) {
  for (const [id, media] of importedMedia.entries()) {
    if (media.senderId === senderId) importedMedia.delete(id);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 760,
    minHeight: 620,
    backgroundColor: "#08111e",
    title: "課間捕手",
    show: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.once("ready-to-show", () => { mainWindow.show(); mainWindow.focus(); });
  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) startupLog(`畫面錯誤: ${message} (${sourceId}:${line})`);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    startupLog(`畫面程序停止: ${details.reason} (${details.exitCode})`);
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, description, url) => {
    startupLog(`畫面載入失敗 (${code}): ${description} — ${url}`);
  });
  mainWindow.on("unresponsive", () => startupLog("應用程式視窗沒有回應"));
  const senderId = mainWindow.webContents.id;
  mainWindow.webContents.once("destroyed", () => clearImportedMediaForSender(senderId));
  mainWindow.loadFile(path.join(__dirname, "index.html")).catch((error) => {
    startupLog(`無法開啟主畫面: ${error.stack || error.message}`);
    mainWindow.show();
  });
}

function safeBaseName(value) {
  return String(value || "course").replace(/[\\/:*?"<>|]/g, "-").slice(0, 48);
}

function recordingStamp(date = new Date()) {
  return `${date.toISOString().slice(0, 10)}-${date.toTimeString().slice(0, 8).replace(/:/g, "")}`;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (Array.isArray(value)) return Buffer.from(value);
  if (value && Array.isArray(value.data)) return Buffer.from(value.data);
  throw new Error("找不到可讀取的檔案內容");
}

function fileTypeLabel(mediaType) {
  return mediaType === "video" ? "影片" : "錄音";
}

function emitProgress(sender, stage, detail, progress) {
  if (!sender || sender.isDestroyed?.()) return;
  const numericProgress = Number(progress);
  const safeProgress = Number.isFinite(numericProgress) ? Math.min(100, Math.max(0, Math.round(numericProgress))) : null;
  sender.send("whisper:progress", { stage, detail, progress: safeProgress });
}

function emitTranscript(sender, segments, progress, done = false) {
  if (!sender || sender.isDestroyed?.()) return;
  const numericProgress = Number(progress);
  const safeProgress = Number.isFinite(numericProgress) ? Math.min(100, Math.max(0, Math.round(numericProgress))) : null;
  sender.send("whisper:transcript", { segments, progress: safeProgress, done });
}

async function getWhisper(sender) {
  if (whisperPipeline) return whisperPipeline;
  if (!whisperLoad) {
    whisperLoad = (async () => {
      emitProgress(sender, "model", "正在準備 Whisper 模型", 0);
      const { pipeline, env } = await import("@huggingface/transformers");
      env.cacheDir = path.join(app.getPath("userData"), "whisper-models");
      whisperPipeline = await pipeline("automatic-speech-recognition", "onnx-community/whisper-small", {
        dtype: "q4",
        device: "cpu",
        progress_callback: (item) => emitProgress(sender, "model", item?.file || "正在下載 Whisper 模型", item?.progress),
      });
      emitProgress(sender, "model", "Whisper 模型已準備完成", 100);
      return whisperPipeline;
    })().catch((error) => { startupLog(`Whisper 模型載入失敗: ${error.stack || error.message}`); whisperLoad = null; throw error; });
  }
  return whisperLoad;
}

function languageName(code) {
  return { "zh-TW": "chinese", "zh-CN": "chinese", "en-US": "english", "ja-JP": "japanese" }[code] || "chinese";
}

function getImportedMedia(event, sourceId) {
  const media = importedMedia.get(String(sourceId || ""));
  if (!media || media.senderId !== event.sender.id) {
    throw new Error("找不到已選取的影音檔，請重新上傳後再試一次。");
  }
  return media;
}

async function assertImportedMediaReadable(media) {
  try {
    const stats = await fs.stat(media.filePath);
    if (!stats.isFile() || stats.size <= 0) throw new Error("selected file is not readable");
    return stats;
  } catch (error) {
    startupLog(`無法讀取上傳檔案: ${error.stack || error.message}`);
    throw new Error("無法讀取已選取的檔案；它可能已被移動、刪除或沒有存取權限，請重新選擇。");
  }
}

async function chooseMediaFile(event) {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "選擇錄音或影音檔",
    properties: ["openFile"],
    filters: [
      { name: "影音與音訊檔", extensions: SUPPORTED_MEDIA_EXTENSIONS },
      { name: "所有檔案", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePaths?.[0]) return { canceled: true };

  const filePath = result.filePaths[0];
  const extension = normalizeMediaExtension(path.extname(filePath));
  const mediaType = getMediaType(extension);
  if (!mediaType) {
    throw new Error("不支援這個檔案格式。請選擇 MP4、WebM、MOV、MKV、MP3、WAV、M4A、AAC、OGG 或 FLAC 檔案。");
  }

  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch (error) {
    startupLog(`讀取選取檔案失敗: ${error.stack || error.message}`);
    throw new Error("無法讀取已選取的檔案，請確認檔案仍在原本的位置。");
  }
  if (!stats.isFile() || stats.size <= 0) throw new Error("選取的檔案是空白或不是可讀取的檔案，請重新選擇。");

  clearImportedMediaForSender(event.sender.id);
  const id = randomUUID();
  const name = path.basename(filePath);
  importedMedia.set(id, { id, senderId: event.sender.id, filePath, name, size: stats.size, extension, mediaType });
  startupLog(`已選取本機${fileTypeLabel(mediaType)}檔案: ${name} (${stats.size} bytes)`);
  return { canceled: false, id, name, size: stats.size, extension, mediaType };
}

async function resolveTranscriptionSource(event, payload, tempRoot) {
  if (payload?.sourceId) {
    const media = getImportedMedia(event, payload.sourceId);
    const stats = await assertImportedMediaReadable(media);
    return { inputPath: media.filePath, name: media.name, size: stats.size, mediaType: media.mediaType };
  }

  if (!payload?.bytes) throw new Error("找不到要轉錄的錄製檔");
  let inputBytes;
  try {
    inputBytes = toBuffer(payload.bytes);
  } catch {
    throw new Error("錄製資料無法讀取，請重新錄製後再試一次。");
  }
  if (!inputBytes.length) throw new Error("錄製檔案是空白，請確認錄製時有取得課程聲音。");
  const extension = normalizeMediaExtension(payload.extension || "webm");
  const mediaType = getMediaType(extension);
  if (!mediaType) throw new Error("錄製檔案格式不受支援，請重新錄製後再試一次。");
  const inputPath = path.join(tempRoot, `recording.${extension}`);
  await fs.writeFile(inputPath, inputBytes);
  return { inputPath, name: `錄製課程.${extension}`, size: inputBytes.length, mediaType };
}

async function transcribeRecording(event, payload = {}) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "course-capture-"));
  const output = path.join(tempRoot, "recording.wav");
  try {
    const source = await resolveTranscriptionSource(event, payload, tempRoot);
    startupLog(`開始轉錄，來源 ${source.name}，輸入大小 ${source.size} bytes，語言 ${payload.language || "zh-TW"}`);
    emitProgress(event.sender, "audio", `正在從${fileTypeLabel(source.mediaType)}準備 16 kHz 單聲道音訊（0%）`, 0);
    await transcodeMediaToWav({ ffmpegPath, inputPath: source.inputPath, outputPath: output });
    const outputStats = await fs.stat(output);
    if (outputStats.size <= 44) throw new Error(`「${source.name}」沒有可用的音訊內容。`);
    startupLog(`ffmpeg 已完成 ${source.name} → 16 kHz mono WAV`);
    const wav = new WaveFile(await fs.readFile(output));
    wav.toBitDepth("32f");
    wav.toSampleRate(16000);
    let samples = wav.getSamples();
    if (Array.isArray(samples)) samples = samples[0];
    const audio = samples instanceof Float32Array ? samples : new Float32Array(samples);
    startupLog(`音訊樣本準備完成，共 ${audio.length} samples`);
    const transcriber = await getWhisper(event.sender);
    const modelLanguage = languageName(payload.language);
    const duration = audio.length / 16000;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error(`「${source.name}」沒有可用的音訊內容。`);

    // Process short windows so the first completed Whisper window can be shown immediately.
    // A small overlap helps preserve words that cross a window boundary.
    const chunkLength = 20;
    const overlap = 3;
    const chunkCount = Math.max(1, Math.ceil(duration / chunkLength));
    const segments = [];
    emitProgress(event.sender, "transcribe", "Whisper 已準備完成，開始轉錄（0%）", 0);

    const normalizeSegmentText = (text) => String(text || "").replace(/\s+/g, "").trim().toLowerCase();
    const appendUniqueSegments = (target, candidates) => {
      const added = [];
      for (const candidate of candidates) {
        const text = String(candidate.text || "").trim();
        if (!text) continue;
        const normalized = normalizeSegmentText(text);
        const duplicate = target.some((existing) => normalizeSegmentText(existing.text) === normalized && Math.abs(Number(existing.time || 0) - Number(candidate.time || 0)) < 5);
        if (duplicate) continue;
        const segment = { time: Number(Number(candidate.time || 0).toFixed(2)), text };
        target.push(segment);
        added.push(segment);
      }
      target.sort((left, right) => left.time - right.time);
      return added.sort((left, right) => left.time - right.time);
    };

    for (let index = 0; index < chunkCount; index += 1) {
      const baseStart = index * chunkLength;
      const baseEnd = Math.min(duration, baseStart + chunkLength);
      const windowStart = Math.max(0, baseStart - overlap);
      const startSample = Math.floor(windowStart * 16000);
      const endSample = Math.min(audio.length, Math.ceil(baseEnd * 16000));
      const windowAudio = audio.slice(startSample, endSample);
      const beforeProgress = duration > 0 ? Math.round((baseStart / duration) * 100) : 0;
      emitProgress(event.sender, "transcribe", `正在轉錄第 ${index + 1}/${chunkCount} 段（${beforeProgress}%）`, beforeProgress);

      const result = await transcriber(windowAudio, { language: modelLanguage, task: "transcribe", return_timestamps: true });
      const rawChunks = Array.isArray(result.chunks) && result.chunks.length ? result.chunks : (result.text ? [{ text: result.text, timestamp: [0, null] }] : []);
      const candidates = rawChunks.map((chunk) => {
        const rawStart = chunk.timestamp?.[0];
        const rawEnd = chunk.timestamp?.[1];
        const localStart = Number(rawStart);
        const localEnd = rawEnd == null ? Number.NaN : Number(rawEnd);
        return {
          time: windowStart + (Number.isFinite(localStart) ? localStart : 0),
          endTime: Number.isFinite(localEnd) ? windowStart + localEnd : null,
          text: String(chunk.text || "").trim(),
        };
      }).filter((chunk) => chunk.text && (baseStart === 0 || chunk.endTime == null || chunk.endTime > baseStart + 0.25));
      const added = appendUniqueSegments(segments, candidates);
      const progress = duration > 0 ? Math.min(100, Math.round((baseEnd / duration) * 100)) : 100;
      if (added.length) emitTranscript(event.sender, added, progress);
      emitProgress(event.sender, "transcribe", `已完成 ${progress}%（第 ${index + 1}/${chunkCount} 段）`, progress);
    }

    emitTranscript(event.sender, [], 100, true);
    const text = modelLanguage === "english" ? segments.map((segment) => segment.text).join(" ") : segments.map((segment) => segment.text).join("");
    startupLog(`Whisper 轉錄完成，${segments.length} 段，${text.replace(/\s/g, "").length} 字`);
    return { text, segments };
  } catch (error) {
    startupLog(`轉錄失敗 (${error.code || "unknown"}): ${error.diagnostics || error.stack || error.message}`);
    throw error;
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

ipcMain.handle("app:log", (_event, message) => {
  startupLog(String(message || ""));
  return true;
});

ipcMain.handle("recording:save", async (_event, { bytes, courseTitle }) => {
  const inputBytes = toBuffer(bytes);
  const fileName = `${safeBaseName(courseTitle)}-${recordingStamp()}.webm`;
  const target = path.join(app.getPath("videos"), fileName);
  await fs.writeFile(target, inputBytes);
  startupLog(`錄影已儲存: ${target} (${inputBytes.length} bytes)`);
  return { saved: true, name: fileName, size: inputBytes.length };
});

ipcMain.handle("recording:choose-media", chooseMediaFile);
ipcMain.handle("recording:transcribe", transcribeRecording);

ipcMain.handle("recording:export", async (_event, { bytes, courseTitle }) => {
  const date = new Date().toISOString().slice(0, 10);
  const result = await dialog.showSaveDialog(mainWindow, { defaultPath: `${safeBaseName(courseTitle)}-${date}.webm`, filters: [{ name: "WebM 影片", extensions: ["webm"] }] });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.writeFile(result.filePath, toBuffer(bytes));
  return { canceled: false };
});

ipcMain.handle("recording:export-imported", async (event, { sourceId, courseTitle }) => {
  const media = getImportedMedia(event, sourceId);
  await assertImportedMediaReadable(media);
  const date = new Date().toISOString().slice(0, 10);
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: `${safeBaseName(courseTitle)}-${date}.${media.extension}`,
    filters: [{ name: `${fileTypeLabel(media.mediaType)}檔案`, extensions: [media.extension] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  try {
    await fs.copyFile(media.filePath, result.filePath);
  } catch (error) {
    startupLog(`匯出上傳檔案失敗: ${error.stack || error.message}`);
    throw new Error("無法匯出原始檔案，請確認目的資料夾可寫入後再試一次。");
  }
  return { canceled: false };
});

ipcMain.handle("capture:list", async () => {
  try {
    const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 } });
    startupLog(`找到 ${sources.length} 個可錄製來源`);
    captureSources.clear();
    return sources.map((source) => {
      captureSources.set(source.id, source);
      return { id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL() };
    });
  } catch (error) {
    startupLog(`讀取錄製來源失敗: ${error.stack || error.message}`);
    throw error;
  }
});

ipcMain.handle("capture:select", (_event, id) => {
  selectedCaptureSource = captureSources.get(id) || null;
  return Boolean(selectedCaptureSource);
});

ipcMain.handle("capture:select-desktop", async () => {
  try {
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } });
    selectedCaptureSource = sources[0] || null;
    startupLog(selectedCaptureSource ? "已選擇主要桌面作為錄製來源" : "找不到可錄製的桌面來源");
    return Boolean(selectedCaptureSource);
  } catch (error) {
    startupLog(`選擇桌面來源失敗: ${error.stack || error.message}`);
    throw error;
  }
});

process.on("uncaughtException", (error) => startupLog(`未處理例外: ${error.stack || error.message}`));
process.on("unhandledRejection", (error) => startupLog(`未處理 Promise: ${error?.stack || error}`));

app.whenReady().then(() => {
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    const source = selectedCaptureSource;
    selectedCaptureSource = null;
    callback(source ? { video: source, audio: "loopback" } : {});
  });
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch((error) => startupLog(`應用程式啟動失敗: ${error.stack || error.message}`));

app.on("window-all-closed", () => {
  importedMedia.clear();
  if (process.platform !== "darwin") app.quit();
});
