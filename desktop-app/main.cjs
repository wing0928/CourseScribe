const { app, BrowserWindow, ipcMain, dialog, desktopCapturer, session } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const { spawn } = require("node:child_process");
const ffmpegPath = require("ffmpeg-static");
const { WaveFile } = require("wavefile");

let mainWindow;
let whisperPipeline;
let whisperLoad;
const captureSources = new Map();
let selectedCaptureSource = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 760,
    minHeight: 620,
    backgroundColor: "#08111e",
    title: "課間捕手",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.loadFile("index.html");
}

function safeBaseName(value) {
  return String(value || "course").replace(/[\\/:*?"<>|]/g, "-").slice(0, 48);
}

function emitProgress(sender, stage, detail, progress) {
  sender.send("whisper:progress", { stage, detail, progress: Number.isFinite(progress) ? Math.round(progress) : null });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let error = "";
    child.stderr.on("data", (chunk) => { error += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(error || `ffmpeg 結束碼 ${code}`)));
  });
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
    })().catch((error) => { whisperLoad = null; throw error; });
  }
  return whisperLoad;
}

function languageName(code) {
  return { "zh-TW": "chinese", "zh-CN": "chinese", "en-US": "english", "ja-JP": "japanese" }[code] || "chinese";
}

async function transcribeRecording(event, { bytes, language }) {
  if (!bytes) throw new Error("找不到要轉錄的錄製檔");
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "course-capture-"));
  const input = path.join(tempRoot, "recording.webm");
  const output = path.join(tempRoot, "recording.wav");
  try {
    await fs.writeFile(input, Buffer.from(bytes));
    emitProgress(event.sender, "audio", "正在準備完整錄音檔", null);
    await runFfmpeg(["-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", output]);
    const wav = new WaveFile(await fs.readFile(output));
    wav.toBitDepth("32f");
    wav.toSampleRate(16000);
    let samples = wav.getSamples();
    if (Array.isArray(samples)) samples = samples[0];
    const audio = samples instanceof Float32Array ? samples : new Float32Array(samples);
    const transcriber = await getWhisper(event.sender);
    emitProgress(event.sender, "transcribe", "Whisper 正在轉錄完整課程", null);
    const result = await transcriber(audio, { language: languageName(language), task: "transcribe", return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 });
    const segments = (result.chunks || []).map((chunk) => ({ time: Number(chunk.timestamp?.[0] || 0), text: String(chunk.text || "").trim() })).filter((chunk) => chunk.text);
    return { text: result.text || "", segments };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

ipcMain.handle("recording:save", async (_event, { bytes, courseTitle }) => {
  const date = new Date().toISOString().slice(0, 10);
  const target = path.join(app.getPath("videos"), `${safeBaseName(courseTitle)}-${date}.webm`);
  await fs.writeFile(target, Buffer.from(bytes));
  return { path: target };
});
ipcMain.handle("capture:list", async () => {
  const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 } });
  captureSources.clear();
  return sources.map((source) => {
    captureSources.set(source.id, source);
    return { id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL() };
  });
});
ipcMain.handle("capture:select", (_event, id) => {
  selectedCaptureSource = captureSources.get(id) || null;
  return Boolean(selectedCaptureSource);
});
ipcMain.handle("recording:transcribe", transcribeRecording);
ipcMain.handle("recording:export", async (_event, { bytes, courseTitle }) => {
  const date = new Date().toISOString().slice(0, 10);
  const result = await dialog.showSaveDialog(mainWindow, { defaultPath: `${safeBaseName(courseTitle)}-${date}.webm`, filters: [{ name: "WebM 影片", extensions: ["webm"] }] });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.writeFile(result.filePath, Buffer.from(bytes));
  return { canceled: false, path: result.filePath };
});

app.whenReady().then(() => {
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    const source = selectedCaptureSource;
    selectedCaptureSource = null;
    callback(source ? { video: source, audio: "loopback" } : {});
  });
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
