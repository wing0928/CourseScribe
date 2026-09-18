const { app } = require("electron");

// Keep the first paint reliable on Windows machines with problematic GPU drivers.
app.disableHardwareAcceleration();

const {
  BrowserWindow,
  ipcMain,
  dialog,
  desktopCapturer,
  session,
  protocol,
  net,
  shell,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const { Worker } = require("node:worker_threads");
const os = require("node:os");
const { randomUUID, createHash } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const ffmpegPath = require("ffmpeg-static");
const { WaveFile } = require("wavefile");
const {
  SUPPORTED_MEDIA_EXTENSIONS,
  normalizeMediaExtension,
  getMediaType,
  transcodeMediaToWav,
} = require("./media-utils.cjs");
const { CourseDatabase, COURSE_STATUSES } = require("./database.cjs");
const {
  OllamaClient,
  DEFAULT_MODEL,
  HIGH_QUALITY_MODEL,
  GEMMA_MODEL,
  AVAILABLE_MODELS,
  MAP_SCHEMA,
  SYNTHESIS_SCHEMA,
  getNoteGuide,
  buildMapPrompt,
  buildSynthesisPrompt,
  prepareTranscriptChunks,
  verifyMapEvidence,
  assembleCourseNotes,
  normalizeNoteShape,
} = require("./ollama.cjs");
const { toTraditionalTaiwan, normalizeNotes } = require("./text-utils.cjs");
const { segmentPath, findSegments, prepareRecordingMedia, inspectRecordingAudio } = require("./recording-segments.cjs");
const APP_VERSION = require("./package.json").version;
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const TRANSLATION_SCHEMA = {
  type: "object",
  properties: { items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string", maxLength: 1000 } }, required: ["id", "text"], additionalProperties: false } } },
  required: ["items"], additionalProperties: false,
};

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  protocol.registerSchemesAsPrivileged([{
    scheme: "coursescribe-media",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  }]);

  let mainWindow;
  let widgetWindow;
  let recordingWidgetState = { visible: false, recording: false, paused: false, elapsedMs: 0, title: "" };
  let courseDb;
  let libraryRoot;
  let stagingRoot;
  let whisperPipeline;
  let whisperLoad;
  let ollama;
  let selectedCaptureSource = null;
  const captureSources = new Map();
  const pendingImports = new Map();
  const liveSessions = new Map();
  const activeJobs = new Map();

  function startupLog(message) {
    const line = `[${new Date().toISOString()}] ${String(message || "")}\n`;
    console.error(line.trim());
    if (app.isReady()) fs.appendFile(path.join(app.getPath("userData"), "startup.log"), line).catch(() => {});
  }

  function publicMedia(media) {
    if (!media) return null;
    const result = { ...media };
    delete result.file_path;
    delete result.filePath;
    result.mediaType = result.media_type;
    result.originalName = result.original_name;
    result.processingStatus = result.processing_status;
    result.durationMs = result.duration_ms;
    result.mediaUrl = result.media_type === "video" && result.processing_status === "ready"
      ? `coursescribe-media://media/${encodeURIComponent(result.id)}`
      : null;
    return result;
  }

  function publicCourse(course) {
    if (!course) return null;
    return {
      ...course,
      categoryId: course.category_id,
      categoryName: course.category_name,
      segmentCount: Number(course.segment_count || 0),
      mediaCount: Number(course.media_count || 0),
      mediaTypes: course.media_types ? String(course.media_types).split(",") : [],
    };
  }

  function publicSegment(segment) {
    return {
      id: segment.id,
      mediaId: segment.media_id || segment.mediaId || null,
      startMs: Number(segment.start_ms ?? segment.startMs ?? 0),
      endMs: segment.end_ms == null && segment.endMs == null ? null : Number(segment.end_ms ?? segment.endMs),
      text: String(segment.text || ""),
      language: segment.language || null,
    };
  }

  function publicDetail(detail) {
    if (!detail) return null;
    return {
      course: publicCourse(detail.course),
      media: detail.media.map(publicMedia),
      segments: detail.segments.map(publicSegment),
      notes: detail.notes ? { ...detail.notes, json: detail.notes.json ? normalizeNoteShape(detail.notes.json) : null } : null,
      terms: detail.terms || [],
      translations: detail.translations || [],
      annotations: detail.annotations || [],
      jobs: (detail.jobs || []).map((job) => ({
        id: job.id,
        type: job.type,
        status: job.status,
        progress: Number(job.progress) || 0,
        detail: job.detail || null,
        error: job.error || null,
        createdAt: job.created_at,
        updatedAt: job.updated_at,
      })),
    };
  }

  function senderCanReceive(sender) { return Boolean(sender && !sender.isDestroyed?.()); }

  function send(channel, payload, sender = mainWindow?.webContents) {
    if (senderCanReceive(sender)) sender.send(channel, payload);
  }

  function emitProgress(courseId, stage, detail, progress, extra = {}) {
    const numeric = Number(progress);
    send("course:progress", {
      courseId: courseId || null,
      stage,
      detail: String(detail || ""),
      progress: Number.isFinite(numeric) ? Math.max(0, Math.min(100, Math.round(numeric))) : null,
      ...extra,
    });
  }

  function emitUpdated(courseId, reason = "updated") { send("course:updated", { courseId, reason }); }

  function activeTranscriptionJob(courseId) {
    return [...activeJobs.entries()].find(([, activeCourseId]) => activeCourseId === courseId)?.[0] || null;
  }

  function emitModelProgress(model, data) {
    const completed = Number(data?.completed);
    const total = Number(data?.total);
    const progress = total > 0 ? Math.round((completed / total) * 100) : null;
    send("model:progress", {
      model,
      status: data?.status || "downloading",
      detail: data?.digest ? String(data.digest).slice(0, 18) : "",
      progress: Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : null,
    });
  }

  function safeBaseName(value) {
    return String(value || "course").replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().slice(0, 64) || "course";
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

  function fileTypeLabel(mediaType) { return mediaType === "video" ? "影片" : "錄音"; }

  function languageName(code) {
    return { "zh-TW": "chinese", "zh-CN": "chinese", "en-US": "english", "ja-JP": "japanese" }[code] || "chinese";
  }

  function hashFile(filePath) {
    return new Promise((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = fsSync.createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(hash.digest("hex")));
    });
  }

  async function uniqueLibraryPath(courseId, originalName) {
    const extension = normalizeMediaExtension(path.extname(originalName)) || "webm";
    const folder = path.join(libraryRoot, safeBaseName(courseId));
    await fs.mkdir(folder, { recursive: true });
    const target = path.join(folder, `${safeBaseName(path.basename(originalName, path.extname(originalName)))}-${randomUUID()}.${extension}`);
    return { target, extension };
  }

  async function moveIntoLibrary(sourcePath, courseId, originalName) {
    const { target, extension } = await uniqueLibraryPath(courseId, originalName);
    const tempTarget = `${target}.partial`;
    let sourceStats = await fs.stat(sourcePath);
    if (!sourceStats.isFile() || sourceStats.size <= 0) throw new Error("來源檔案是空白或無法讀取。");
    try {
      await fs.rename(sourcePath, target);
    } catch (error) {
      if (error.code !== "EXDEV") throw error;
      await fs.copyFile(sourcePath, tempTarget);
      const copiedStats = await fs.stat(tempTarget);
      if (copiedStats.size !== sourceStats.size) throw new Error("檔案移動驗證失敗，原始檔案已保留。");
      const sourceHash = await hashFile(sourcePath);
      const copiedHash = await hashFile(tempTarget);
      if (sourceHash !== copiedHash) {
        await removePathIfExists(tempTarget);
        throw new Error("跨磁碟匯入的 SHA-256 驗證失敗，原始檔案已保留。");
      }
      await fs.rename(tempTarget, target);
      await fs.unlink(sourcePath);
    }
    sourceStats = await fs.stat(target);
    return { filePath: target, extension, size: sourceStats.size, sha256: await hashFile(target) };
  }

  async function removePathIfExists(filePath) {
    if (!filePath) return;
    try { await fs.rm(filePath, { force: true }); } catch (error) { startupLog(`清理暫存檔失敗: ${error.message}`); }
  }

  function createWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      return mainWindow;
    }
    mainWindow = new BrowserWindow({
      width: 1120,
      height: 820,
      minWidth: 820,
      minHeight: 620,
      backgroundColor: "#07111d",
      title: "課間捕手 · CourseScribe",
      show: false,
      webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
    });
    mainWindow.once("ready-to-show", () => { mainWindow.show(); mainWindow.focus(); });
    mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      if (level >= 2) startupLog(`畫面錯誤: ${message} (${sourceId}:${line})`);
    });
    mainWindow.webContents.on("render-process-gone", (_event, details) => startupLog(`畫面程序停止: ${details.reason} (${details.exitCode})`));
    mainWindow.webContents.on("did-fail-load", (_event, code, description, url) => startupLog(`畫面載入失敗 (${code}): ${description} — ${url}`));
    mainWindow.on("unresponsive", () => startupLog("應用程式視窗沒有回應"));
    mainWindow.on("closed", () => { mainWindow = null; });
    mainWindow.loadFile(path.join(__dirname, "index.html")).catch((error) => startupLog(`無法開啟主畫面: ${error.stack || error.message}`));
    return mainWindow;
  }

  function sendWidgetState() {
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      widgetWindow.webContents.send("widget:state", recordingWidgetState);
    }
  }

  function createRecordingWidget() {
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      widgetWindow.show();
      widgetWindow.focus();
      sendWidgetState();
      return widgetWindow;
    }
    widgetWindow = new BrowserWindow({
      width: 318,
      height: 116,
      minWidth: 286,
      minHeight: 104,
      maxWidth: 420,
      maxHeight: 150,
      frame: false,
      transparent: true,
      resizable: true,
      alwaysOnTop: true,
      skipTaskbar: false,
      show: false,
      title: "CourseScribe 錄影工具",
      webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
    });
    // The mini controller is intentionally above ordinary windows while a
    // class is recording.  It is separate from the main window so switching
    // apps never hides the timer or the stop control.
    widgetWindow.setAlwaysOnTop(true, "screen-saver");
    widgetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    widgetWindow.webContents.once("did-finish-load", () => {
      widgetWindow.show();
      setTimeout(sendWidgetState, 0);
    });
    widgetWindow.on("show", () => widgetWindow?.setAlwaysOnTop(true, "screen-saver"));
    widgetWindow.on("closed", () => { widgetWindow = null; });
    widgetWindow.loadFile(path.join(__dirname, "widget.html")).catch((error) => startupLog(`無法開啟錄影小工具: ${error.message}`));
    return widgetWindow;
  }

  function getWhisper() {
    if (whisperPipeline) return whisperPipeline;
    if (!whisperLoad) {
      whisperLoad = (async () => {
        emitProgress(null, "model", "正在準備本機 Whisper 模型", 0);
        const { pipeline, env } = await import("@huggingface/transformers");
        env.cacheDir = path.join(app.getPath("userData"), "whisper-models");
        whisperPipeline = await pipeline("automatic-speech-recognition", "onnx-community/whisper-small", {
          dtype: "q4",
          device: "cpu",
          progress_callback: (item) => emitProgress(null, "model", item?.file || "正在下載 Whisper 模型", item?.progress),
        });
        emitProgress(null, "model", "本機 Whisper 模型已準備完成", 100);
        return whisperPipeline;
      })().catch((error) => {
        startupLog(`Whisper 模型載入失敗: ${error.stack || error.message}`);
        whisperLoad = null;
        throw error;
      });
    }
    return whisperLoad;
  }

  function resampleFloat(input, sourceRate, targetRate = 16000) {
    const source = input instanceof Float32Array ? input : Float32Array.from(input || []);
    if (!source.length || sourceRate === targetRate) return source;
    const length = Math.max(1, Math.round(source.length * targetRate / sourceRate));
    const output = new Float32Array(length);
    const ratio = sourceRate / targetRate;
    for (let index = 0; index < length; index += 1) {
      const position = index * ratio;
      const left = Math.floor(position);
      const right = Math.min(source.length - 1, left + 1);
      const weight = position - left;
      output[index] = source[left] * (1 - weight) + source[right] * weight;
    }
    return output;
  }

  function normalizeWhisperText(text, modelLanguage, outputLanguage) {
    const cleaned = String(text || "").replace(/\s+/g, modelLanguage === "english" ? " " : "").trim();
    return modelLanguage === "chinese" && String(outputLanguage).toLowerCase().startsWith("zh-tw")
      ? toTraditionalTaiwan(cleaned, "zh-TW")
      : cleaned;
  }

  async function recognizeAudio(audio, offsetMs, language, courseId) {
    const transcriber = await getWhisper();
    const modelLanguage = languageName(language);
    const result = await transcriber(audio, { language: modelLanguage, task: "transcribe", return_timestamps: true });
    const chunks = Array.isArray(result.chunks) && result.chunks.length
      ? result.chunks
      : (result.text ? [{ text: result.text, timestamp: [0, null] }] : []);
    const segments = chunks.map((chunk) => {
      const localStart = Number(chunk.timestamp?.[0]);
      const localEnd = Number(chunk.timestamp?.[1]);
      return {
        startMs: Math.max(0, Math.round(offsetMs + (Number.isFinite(localStart) ? localStart * 1000 : 0))),
        endMs: Number.isFinite(localEnd) ? Math.max(0, Math.round(offsetMs + localEnd * 1000)) : null,
        text: normalizeWhisperText(chunk.text, modelLanguage, language),
      };
    }).filter((segment) => segment.text);
    if (courseId) startupLog(`Whisper 完成課程 ${courseId} 的 ${segments.length} 個片段`);
    return segments;
  }

  function loadWavSamples(wavBytes) {
    const wav = new WaveFile(wavBytes);
    wav.toBitDepth("32f");
    wav.toSampleRate(16000);
    let samples = wav.getSamples();
    if (Array.isArray(samples)) samples = samples[0];
    return samples instanceof Float32Array ? samples : new Float32Array(samples);
  }

  async function transcribeFileCourse(courseId, mediaId, language, jobId) {
    const media = courseDb.getMedia(mediaId);
    if (!media) throw new Error("找不到要轉錄的媒體");
    courseDb.updateCourse(courseId, { status: "transcribing", error: null });
    courseDb.updateJob(jobId, { status: "running", detail: "正在啟動背景轉錄", progress: 1 });
    emitProgress(courseId, "audio", `正在以背景程序準備${fileTypeLabel(media.media_type)}音訊`, 1);
    // Keep FFmpeg in Electron's main process. It is still asynchronous (the UI
    // stays responsive), but avoids spawning an executable from inside an
    // unpacked Node Worker, which can hang on packaged Windows installations.
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "coursescribe-transcribe-"));
    const wavPath = path.join(tempRoot, "audio.wav");
    try {
      courseDb.updateJob(jobId, { status: "running", detail: "正在準備音訊", progress: 2 });
      await transcodeMediaToWav({ ffmpegPath, inputPath: media.file_path, outputPath: wavPath });
      courseDb.updateJob(jobId, { status: "running", detail: "音訊準備完成，正在啟動 Whisper", progress: 4 });
      emitProgress(courseId, "audio", "音訊準備完成，正在載入背景 Whisper 模型", 4);
      return await new Promise((resolve, reject) => {
      // Node workers cannot reliably execute an entry file virtualized inside
      // app.asar.  electron-builder unpacks this file for packaged builds;
      // development keeps the original path.
      const workerSource = path.join(__dirname, "whisper-worker.cjs");
      const unpackedWorker = workerSource.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
      const workerPath = fsSync.existsSync(unpackedWorker) ? unpackedWorker : workerSource;
      const worker = new Worker(workerPath, { workerData: {
        wavPath, language,
        appRoot: __dirname,
        modelCacheDir: path.join(app.getPath("userData"), "whisper-models"),
      } });
      let settled = false;
      let lastWorkerMessageAt = Date.now();
      // Keep already persisted segments on automatic recovery.  A recovered
      // worker starts from the beginning, so de-duplicate its repeated output
      // instead of deleting the user's partial transcript.
      const knownSegments = new Set(courseDb.listSegments(courseId).map((segment) => `${Math.round(Number(segment.start_ms) / 100)}:${String(segment.text || "").trim()}`));
      const watchdog = setInterval(() => {
        if (!settled && Date.now() - lastWorkerMessageAt > 180000) finish(new Error("Whisper 模型超過 3 分鐘沒有回報進度，已停止這次工作。請確認本機模型完整後重新轉錄。"));
      }, 15000);
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        clearInterval(watchdog);
        worker.terminate().catch(() => {});
        if (error) reject(error);
        else {
          const segmentCount = courseDb.listSegments(courseId).length;
          if (!segmentCount) reject(new Error("Whisper 沒有辨識到可用文字，請確認檔案包含清楚的課程聲音。"));
          else {
            courseDb.updateJob(jobId, { status: "completed", detail: "逐字稿完成", progress: 100 });
            emitProgress(courseId, "transcribe", "逐字稿完成，準備整理課程筆記", 100);
            resolve(segmentCount);
          }
        }
      };
      worker.on("message", (message) => {
        lastWorkerMessageAt = Date.now();
        if (message.type === "stage") {
          courseDb.updateJob(jobId, { status: "running", detail: message.detail, progress: Number(message.progress) || 1 });
          emitProgress(courseId, "audio", message.detail, message.progress);
        } else if (message.type === "segments") {
          const recognized = (message.segments || []).map((segment) => ({ ...segment, text: normalizeWhisperText(segment.text, languageName(language), language) }));
          const newSegments = recognized.filter((segment) => {
            const key = `${Math.round(Number(segment.startMs) / 100)}:${String(segment.text || "").trim()}`;
            if (knownSegments.has(key)) return false;
            knownSegments.add(key);
            return true;
          });
          if (newSegments.length) courseDb.addSegments(courseId, mediaId, newSegments, language);
          courseDb.updateJob(jobId, { status: "running", detail: `已完成第 ${message.chunkIndex}/${message.total} 段`, progress: message.progress });
          emitProgress(courseId, "transcribe", `正在轉錄第 ${message.chunkIndex}/${message.total} 段`, message.progress);
          emitUpdated(courseId, "transcript");
        } else if (message.type === "complete") finish();
        else if (message.type === "error") finish(new Error(message.message));
      });
      worker.on("error", (error) => finish(error));
      worker.on("exit", (code) => {
        if (!settled) finish(new Error(`背景轉錄程序在送出結果前結束（${code}）。請重新轉錄。`));
      });
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }

  function noteMarkdown(course, note) {
    const list = (items) => (items || []).map((item) => `- ${item}`).join("\n") || "- 無資料";
    const points = (items) => (items || []).map((item) => `- ${item.kind === "extension" ? "【補充／可能考】" : ""}${item.text}（${item.status === "source_matched" ? `原文吻合 [${item.timestamp}]：「${item.quote}」` : `待核：${item.quote ? `原文未吻合「${item.quote}」` : "缺少可回查原文"}`}）`).join("\n") || "- 無資料";
    return [
      `# ${course.title}`, "", "## 課程摘要", note.summary || "無摘要", "",
      ...(note.sections || []).flatMap((section) => [`## ${section.title}${section.timestamp ? ` [${section.timestamp}]` : ""}`, points(section.points), ""]),
      "## 容易混淆或需複習處", list(note.confusions), "", "## 課後複習問題", list(note.reviewQuestions), "",
      "## 一句話總結", note.takeaway || "無總結",
    ].join("\n");
  }

  async function generateJsonWithRepair(args) {
    try {
      return await ollama.generateJson(args);
    } catch (error) {
      if (error.code !== "OLLAMA_BAD_JSON") throw error;
      // Keep the retry bounded. The schema limits the number and length of
      // cards, so a complete object should fit inside this allowance. Passing
      // malformed output back would lengthen the context and made long
      // lectures fail repeatedly on Gemma.
      return ollama.generateJson({
        ...args,
        prompt: `${args.prompt}\n重試要求：只保留最重要的 1–2 個主題與每題 1–2 個短重點；務必輸出完整閉合的 JSON。`,
        maxOutputTokens: Math.min(1400, Math.max(900, Number(args.maxOutputTokens || 650))),
      });
    }
  }

  async function generateNotesForCourse(courseId, requestedModel = null) {
    const course = courseDb.getCourse(courseId);
    const segments = courseDb.listSegments(courseId);
    if (!course || !segments.length) throw new Error("逐字稿尚未完成，無法整理課程筆記。");
    const model = String(requestedModel || courseDb.getSetting("selectedOllamaModel", DEFAULT_MODEL));
    if (!AVAILABLE_MODELS.some((item) => item.name === model)) throw new Error("尚未選擇有效的 AI 模型。");
    courseDb.updateCourse(courseId, { status: "summarizing", model, error: null });
    courseDb.saveNotes(courseId, { model, status: "processing", error: null });
    emitUpdated(courseId, "notes-started");
    emitProgress(courseId, "notes", "正在連線到本機 Ollama", 0, { model });
    const status = await ollama.status();
    if (!status.available) {
      const error = new Error("找不到本機 Ollama。請先安裝並啟動 Ollama，再重試課程整理。");
      error.code = "OLLAMA_UNAVAILABLE";
      throw error;
    }
    if (!status.models.includes(model)) {
      const error = new Error(`本機尚未下載 ${model}。請到模型設定下載後再試一次。`);
      error.code = "OLLAMA_MODEL_MISSING";
      throw error;
    }
    // Gemma receives a 16K context, so it can safely cover more source text
    // per map pass.  This reduces expensive local generation calls on long
    // lectures without sacrificing the bounded JSON contract.
    const chunkChars = model === GEMMA_MODEL ? 2400 : 1500;
    const chunks = prepareTranscriptChunks(segments, chunkChars);
    if (!chunks.length) throw new Error("逐字稿沒有可整理的文字。");
    const guide = getNoteGuide();
    const guideHash = createHash("sha256").update(`evidence-v1\n${guide}\n${JSON.stringify(MAP_SCHEMA)}`).digest("hex");
    const maps = [];
    const startedAt = Date.now();
    let completedSteps = 0;
    const estimatedTotalSteps = chunks.length + 1;
    const remainingSeconds = () => completedSteps ? Math.max(0, Math.round((Date.now() - startedAt) / 1000 / completedSteps * (estimatedTotalSteps - completedSteps))) : null;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunkHash = createHash("sha256").update(chunks[index]).digest("hex");
      const cached = verifyMapEvidence(courseDb.getNoteMap(courseId, model, guideHash, index, chunkHash), chunks[index]);
      if (cached.sections.length) {
        maps.push(cached);
        completedSteps += 1;
        emitProgress(courseId, "notes", `沿用第 ${index + 1}/${chunks.length} 段已核對主題`, Math.round((completedSteps / estimatedTotalSteps) * 100), { model, etaSeconds: remainingSeconds() });
        continue;
      }
      const baseProgress = Math.round((index / estimatedTotalSteps) * 100);
      emitProgress(courseId, "notes", `擷取主題第 ${index + 1}/${chunks.length} 段`, baseProgress, { model, etaSeconds: remainingSeconds() });
      const result = await generateJsonWithRepair({ model, prompt: buildMapPrompt(chunks[index], course.title, course.language), system: guide,
        schema: MAP_SCHEMA, maxOutputTokens: 1100, timeoutMs: 600000,
        onProgress: ({ characters, evalCount }) => emitProgress(courseId, "notes", `擷取第 ${index + 1}/${chunks.length} 段：已生成 ${characters} 字${evalCount ? `／${evalCount} token` : ""}`, baseProgress, { model, etaSeconds: remainingSeconds() }),
      });
      const map = verifyMapEvidence(result.value, chunks[index]);
      if (!map.sections.length) throw new Error(`第 ${index + 1} 段沒有擷取到主題；已保留舊筆記，請檢查逐字稿後重試。`);
      courseDb.saveNoteMap(courseId, model, guideHash, index, chunkHash, map);
      maps.push(map);
      completedSteps += 1;
      emitProgress(courseId, "notes", `已擷取第 ${index + 1}/${chunks.length} 段：${map.sections.length} 個主題`, Math.round((completedSteps / estimatedTotalSteps) * 100), { model, etaSeconds: remainingSeconds() });
    }
    emitProgress(courseId, "notes", "正在撰寫跨主題摘要；各段主題已保留", Math.round((completedSteps / estimatedTotalSteps) * 100), { model, etaSeconds: remainingSeconds() });
    let synthesis = {};
    try {
      const result = await generateJsonWithRepair({ model, prompt: buildSynthesisPrompt(maps, course.title, course.language), system: guide,
        schema: SYNTHESIS_SCHEMA, maxOutputTokens: 600, timeoutMs: 600000,
        onProgress: ({ characters }) => emitProgress(courseId, "notes", `撰寫全課摘要：已生成 ${characters} 字`, Math.round((completedSteps / estimatedTotalSteps) * 100), { model, etaSeconds: remainingSeconds() }),
      });
      synthesis = result.value;
    } catch (error) {
      startupLog(`全課摘要生成失敗，保留已完成主題：${error.message}`);
    }
    const note = normalizeNotes(assembleCourseNotes(maps, synthesis), course.language);
    courseDb.saveAnnotations(courseId, note.annotations || []);
    const saved = courseDb.saveNotes(courseId, { model, status: "ready", json: note, text: noteMarkdown(course, note), error: null });
    courseDb.updateCourse(courseId, { status: "ready", model, error: null });
    emitProgress(courseId, "notes", "課程筆記完成", 100, { model });
    emitUpdated(courseId, "notes");
    return saved;
  }

  async function translateTranscriptForCourse(courseId, targetLanguage = "en", requestedModel = null) {
    const course = courseDb.getCourse(courseId);
    const segments = courseDb.listSegments(courseId);
    if (!course || !segments.length) throw new Error("逐字稿尚未完成，無法翻譯。");
    const model = String(requestedModel || course.model || courseDb.getSetting("selectedOllamaModel", DEFAULT_MODEL));
    const status = await ollama.status();
    if (!status.available) throw new Error("找不到本機 Ollama。請先啟動 Ollama 後再翻譯。");
    if (!status.models.includes(model)) throw new Error(`本機尚未下載 ${model}。請先下載模型後再翻譯。`);
    const target = String(targetLanguage || "en").toLowerCase() === "en" ? "English" : String(targetLanguage);
    const batches = [];
    for (let index = 0; index < segments.length; index += 24) batches.push(segments.slice(index, index + 24));
    const translated = [];
    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      const source = batch.map((segment) => ({ id: segment.id, text: segment.text }));
      const result = await generateJsonWithRepair({
        model,
        system: "You are a careful academic transcript translator. Return valid JSON only. Preserve meaning, terminology, formulas and uncertainty; do not summarize, omit, merge or invent sentences.",
        prompt: `Translate every item below into ${target}. Keep every id exactly once. Do not correct or rewrite the source transcript.\n${JSON.stringify({ items: source })}`,
        schema: TRANSLATION_SCHEMA,
        maxOutputTokens: 1800,
        timeoutMs: 600000,
        onProgress: ({ characters }) => emitProgress(courseId, "translate", `翻譯第 ${index + 1}/${batches.length} 段：已生成 ${characters} 字`, Math.round((index / batches.length) * 100), { model }),
      });
      const allowed = new Set(batch.map((segment) => segment.id));
      const mapped = new Map((result.value?.items || []).filter((item) => allowed.has(String(item?.id)) && String(item?.text || "").trim()).map((item) => [String(item.id), String(item.text).trim()]));
      if (mapped.size !== batch.length) throw new Error(`翻譯第 ${index + 1} 段不完整，原始逐字稿未變更，請重試。`);
      translated.push(...batch.map((segment) => ({ segmentId: segment.id, text: mapped.get(segment.id) })));
      emitProgress(courseId, "translate", `已完成第 ${index + 1}/${batches.length} 段英文翻譯`, Math.round(((index + 1) / batches.length) * 100), { model });
    }
    const rows = courseDb.saveTranslations(courseId, String(targetLanguage || "en"), translated, model);
    emitProgress(courseId, "translate", "英文逐字稿已儲存", 100, { model });
    emitUpdated(courseId, "translation");
    return rows;
  }

  async function runImportedPipeline(courseId, mediaId, language, jobId) {
    try {
      await transcribeFileCourse(courseId, mediaId, language, jobId);
      await generateNotesForCourse(courseId);
    } catch (error) {
      startupLog(`課程處理失敗: ${error.stack || error.message}`);
      courseDb.updateCourse(courseId, { status: "failed", error: error.message });
      courseDb.updateJob(jobId, { status: "failed", error: error.message, detail: error.message });
      courseDb.saveNotes(courseId, { status: "error", model: courseDb.getSetting("selectedOllamaModel", DEFAULT_MODEL), error: error.message });
      emitProgress(courseId, "error", error.message, 100, { code: error.code || "COURSE_FAILED" });
      emitUpdated(courseId, "failed");
    } finally { activeJobs.delete(jobId); }
  }

  async function processLiveAudio(sessionState, samples, sampleRate, startMs) {
    const audio = resampleFloat(samples, Number(sampleRate) || 16000, 16000);
    let energy = 0;
    let peak = 0;
    for (const value of audio) { energy += value * value; peak = Math.max(peak, Math.abs(value)); }
    if (peak < 0.005 || Math.sqrt(energy / Math.max(1, audio.length)) < 0.0007) {
      sessionState.processedMs = Math.max(sessionState.processedMs, (Number(startMs) || 0) + Math.round(audio.length / 16));
      emitProgress(sessionState.courseId, "transcribe", "此段沒有有效聲音，已略過以避免產生錯誤文字", null, { live: true, audioWarning: true });
      return;
    }
    const segments = await recognizeAudio(audio, Number(startMs) || 0, sessionState.language, sessionState.courseId);
    courseDb.addSegments(sessionState.courseId, sessionState.mediaId, segments, sessionState.language);
    sessionState.processedMs = Math.max(sessionState.processedMs, (Number(startMs) || 0) + Math.round(audio.length / 16));
    const progress = sessionState.expectedMs > 0 ? Math.min(99, Math.round(sessionState.processedMs / sessionState.expectedMs * 100)) : null;
    emitProgress(sessionState.courseId, "transcribe", "錄影中，背景轉錄已完成一段", progress, { live: true });
    emitUpdated(sessionState.courseId, "transcript");
  }

  async function finishLiveSession(sessionState) {
    let processingError = sessionState.error;
    try { await sessionState.audioQueue; } catch (error) { processingError = processingError || error; }
    try { await sessionState.videoQueue; } catch (error) { processingError = processingError || error; }
    let media = null;
    try {
      const prepared = await prepareRecordingMedia({ ffmpegPath, stagingRoot, courseId: sessionState.courseId, segmentPaths: sessionState.segmentPaths });
      const health = await inspectRecordingAudio(ffmpegPath, prepared.filePath);
      if (!health.audioOk) processingError = processingError || new Error(`錄影聲音在 ${Math.round(health.audioSeconds || 0)} 秒後中斷，影像持續到 ${Math.round(health.videoSeconds || 0)} 秒；影片已保留，後續逐字稿不可信。`);
      const moved = await moveIntoLibrary(prepared.filePath, sessionState.courseId, `${safeBaseName(sessionState.title)}-${recordingStamp()}.webm`);
      media = courseDb.upsertMedia({
        id: sessionState.mediaId || randomUUID(), courseId: sessionState.courseId, filePath: moved.filePath,
        originalName: sessionState.originalName, mimeType: "video/webm", mediaType: "video", extension: "webm",
        size: moved.size, sha256: moved.sha256, processingStatus: "ready",
      });
      for (const filePath of prepared.cleanup) await removePathIfExists(filePath);
    } catch (error) { processingError = processingError || error; startupLog(`錄影檔整理失敗: ${error.stack || error.message}`); }
    // Failed merges leave every original segment in staging for recovery.
    if (!media && sessionState.mediaId) {
      const sizes = await Promise.all(sessionState.segmentPaths.map(async (filePath) => {
        try { return (await fs.stat(filePath)).size; } catch { return 0; }
      }));
      const size = sizes.reduce((total, value) => total + value, 0);
      courseDb.updateMedia(sessionState.mediaId, { processingStatus: size > 0 ? "interrupted" : "failed", size });
    }
    if (media) {
      courseDb.updateCourse(sessionState.courseId, { status: "transcribing", error: processingError ? processingError.message : null });
      emitUpdated(sessionState.courseId, "media-ready");
      emitProgress(sessionState.courseId, "transcribe", "影片已保存，正在完成逐字稿與筆記", 90);
    }
    const segments = courseDb.listSegments(sessionState.courseId);
    if (!processingError && segments.length) {
      try { await generateNotesForCourse(sessionState.courseId, sessionState.model); }
      catch (error) {
        processingError = error;
        courseDb.saveNotes(sessionState.courseId, { model: sessionState.model, status: "error", error: error.message });
        startupLog(`錄影課程筆記失敗: ${error.stack || error.message}`);
      }
    }
    if (processingError || !segments.length) {
      const message = processingError?.message || "沒有辨識到可用文字，請確認錄影時有取得系統聲音。";
      courseDb.updateCourse(sessionState.courseId, { status: "failed", error: message });
      emitProgress(sessionState.courseId, "error", message, 100, { code: processingError?.code || "LIVE_TRANSCRIPTION_FAILED" });
    } else {
      courseDb.updateCourse(sessionState.courseId, { status: "ready", error: null });
      emitProgress(sessionState.courseId, "complete", "錄影、逐字稿與課程筆記完成", 100);
    }
    emitUpdated(sessionState.courseId, "complete");
    liveSessions.delete(sessionState.courseId);
  }

  async function chooseMediaFile(event) {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "選擇錄音或影音檔", properties: ["openFile"],
      filters: [{ name: "影音與音訊檔", extensions: SUPPORTED_MEDIA_EXTENSIONS }, { name: "所有檔案", extensions: ["*"] }],
    });
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
    const filePath = result.filePaths[0];
    const extension = normalizeMediaExtension(path.extname(filePath));
    const mediaType = getMediaType(extension);
    if (!mediaType) throw new Error("不支援這個檔案格式，請選擇常見的影片、錄音或音訊檔。");
    const stats = await fs.stat(filePath);
    if (!stats.isFile() || stats.size <= 0) throw new Error("選取的檔案是空白或無法讀取。");
    const sourceId = randomUUID();
    pendingImports.set(sourceId, { senderId: event.sender.id, filePath, name: path.basename(filePath), extension, mediaType, size: stats.size });
    return { canceled: false, sourceId, name: path.basename(filePath), extension, mediaType, size: stats.size };
  }

  function getPendingImport(event, sourceId) {
    const item = pendingImports.get(String(sourceId || ""));
    if (!item || item.senderId !== event.sender.id) throw new Error("找不到已選取的檔案，請重新選擇。");
    return item;
  }

  function makeCourseInput(input = {}) {
    return {
      title: String(input.title || "未命名課程").trim().slice(0, 200) || "未命名課程",
      source: String(input.source || "upload"),
      language: String(input.language || "zh-TW"),
      model: AVAILABLE_MODELS.some((item) => item.name === input.model) ? input.model : DEFAULT_MODEL,
      categoryId: input.categoryId ? String(input.categoryId) : null,
      semester: String(input.semester || "").trim().slice(0, 80) || null,
      status: "draft",
    };
  }

  async function registerMediaFile(event, courseId, sourceId) {
    const source = getPendingImport(event, sourceId);
    emitProgress(courseId, "audio", "正在安全移入本機媒體庫", null);
    const moved = await moveIntoLibrary(source.filePath, courseId, source.name);
    const media = courseDb.upsertMedia({
      courseId, filePath: moved.filePath, originalName: source.name,
      mimeType: source.mediaType === "video" ? `video/${source.extension}` : `audio/${source.extension}`,
      mediaType: source.mediaType, extension: source.extension, size: moved.size, sha256: moved.sha256, processingStatus: "ready",
    });
    pendingImports.delete(String(sourceId));
    emitProgress(courseId, "audio", "媒體已匯入，正在準備本機轉錄", 0);
    return publicMedia(media);
  }

  function validateCourseId(value) {
    const id = String(value || "").trim();
    if (!id || id.length > 100) throw new Error("課程識別碼無效");
    return id;
  }

  async function moveCourseToTrash(courseId) {
    const id = validateCourseId(courseId);
    const detail = courseDb.getCourseDetail(id);
    if (!detail) throw new Error("找不到課程");
    const trashRoot = path.join(libraryRoot, ".trash");
    await fs.mkdir(trashRoot, { recursive: true });
    for (const media of detail.media) {
      if (media.is_trash || !media.file_path) continue;
      const target = path.join(trashRoot, `${media.id}-${path.basename(media.file_path)}`);
      await fs.rename(media.file_path, target);
      courseDb.updateMedia(media.id, { filePath: target, isTrash: true, deletedAt: new Date().toISOString() });
    }
    return publicCourse(courseDb.trashCourse(id));
  }

  async function restoreCourseFromTrash(courseId) {
    const id = validateCourseId(courseId);
    const detail = courseDb.getCourseDetail(id);
    if (!detail) throw new Error("找不到課程");
    for (const media of detail.media) {
      if (!media.is_trash || !media.file_path) continue;
      const folder = path.join(libraryRoot, safeBaseName(id));
      await fs.mkdir(folder, { recursive: true });
      const filename = path.basename(media.file_path).replace(`${media.id}-`, "");
      const target = path.join(folder, filename);
      await fs.rename(media.file_path, target);
      courseDb.updateMedia(media.id, { filePath: target, isTrash: false, deletedAt: null });
    }
    return publicCourse(courseDb.restoreCourse(id));
  }

  async function recoverInterruptedRecordings() {
    const pending = courseDb.listProcessingMedia("recording");
    for (const media of pending) {
      const course = courseDb.getCourse(media.course_id);
      if (!course) continue;
      try {
        const segmentPaths = await findSegments(stagingRoot, media.course_id, media.file_path);
        if (segmentPaths.length) {
          const prepared = await prepareRecordingMedia({ ffmpegPath, stagingRoot, courseId: media.course_id, segmentPaths });
          const moved = await moveIntoLibrary(prepared.filePath, media.course_id, media.original_name);
          courseDb.upsertMedia({
            id: media.id, courseId: media.course_id, filePath: moved.filePath,
            originalName: media.original_name, mimeType: media.mime_type || "video/webm",
            mediaType: media.media_type, extension: media.extension || "webm", size: moved.size,
            sha256: moved.sha256, processingStatus: "ready",
          });
          for (const filePath of prepared.cleanup) await removePathIfExists(filePath);
          courseDb.updateCourse(media.course_id, { status: "failed", error: "上次錄影未正常結束；已保留影片，可按「重新轉錄」繼續處理。" });
          startupLog(`已復原中斷錄影：${course.title}`);
          continue;
        }
        courseDb.updateMedia(media.id, { processingStatus: "failed", size: 0 });
        courseDb.updateCourse(media.course_id, { status: "failed", error: "上次錄影沒有留下可用的影片檔。" });
      } catch (error) {
        courseDb.updateMedia(media.id, { processingStatus: "interrupted" });
        courseDb.updateCourse(media.course_id, { status: "failed", error: "上次錄影未正常結束，暫存影片仍保留；請檢查磁碟空間後重試。" });
        startupLog(`中斷錄影待人工處理：${error.message}`);
      }
    }
  }

  async function recoverMostRecentTranscription() {
    const pending = courseDb.getMostRecentInterruptedTranscription();
    if (!pending) return;
    courseDb.abandonRunningTranscriptionJobs(pending.course_id);
    const job = courseDb.createJob(pending.course_id, "transcription-resume");
    activeJobs.set(job.id, pending.course_id);
    startupLog(`恢復中斷轉錄：${pending.title}`);
    void runImportedPipeline(pending.course_id, pending.media_id, pending.language, job.id);
  }

  function recoverInterruptedNotes() {
    for (const row of courseDb.all("SELECT id FROM courses WHERE status='summarizing'")) {
      const message = "上次課程整理未完成；已保留逐字稿與前次筆記，可重新整理。";
      courseDb.updateCourse(row.id, { status: "failed", error: message });
      if (courseDb.getNotes(row.id)?.status === "processing") courseDb.saveNotes(row.id, { status: "error", error: message });
    }
  }

  async function purgeExpiredTrash() {
    const cutoff = Date.now() - TRASH_RETENTION_MS;
    const trashed = courseDb.listCourses({ trash: true });
    for (const course of trashed) {
      const deletedAt = Date.parse(course.deleted_at || "");
      if (!Number.isFinite(deletedAt) || deletedAt > cutoff) continue;
      const detail = courseDb.getCourseDetail(course.id);
      let movedEveryMedia = true;
      for (const media of detail?.media || []) {
        if (!media.file_path) continue;
        try { await shell.trashItem(media.file_path); }
        catch (error) { movedEveryMedia = false; startupLog(`過期課程媒體移到 Windows 回收桶失敗：${error.message}`); }
      }
      if (movedEveryMedia) {
        courseDb.deleteCourse(course.id);
        startupLog(`已清理超過 30 天的課程回收桶資料：${course.title}`);
      } else {
        courseDb.updateCourse(course.id, { error: "回收桶保留期限已到，但部分媒體尚未能移到 Windows 回收桶；請稍後重試。" });
      }
    }
  }

  function registerIpc() {
    ipcMain.handle("app:log", (_event, message) => { startupLog(String(message || "")); return true; });
    ipcMain.handle("app:open-external", async (_event, url) => {
      const target = String(url || "");
      if (!/^https:\/\/ollama\.com\//i.test(target)) throw new Error("不允許開啟這個網址");
      await shell.openExternal(target);
      return true;
    });
    ipcMain.handle("app:info", () => ({ version: APP_VERSION, name: "CourseScribe", dataPath: app.getPath("userData") }));
    ipcMain.handle("widget:show", () => {
      recordingWidgetState = { ...recordingWidgetState, visible: true };
      createRecordingWidget();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
      return true;
    });
    ipcMain.handle("widget:hide", () => {
      recordingWidgetState = { ...recordingWidgetState, visible: false };
      if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.hide();
      return true;
    });
    ipcMain.handle("widget:update", (_event, nextState = {}) => {
      recordingWidgetState = {
        visible: Boolean(nextState.visible ?? recordingWidgetState.visible),
        recording: Boolean(nextState.recording),
        paused: Boolean(nextState.paused),
        elapsedMs: Math.max(0, Number(nextState.elapsedMs) || 0),
        title: String(nextState.title || "").slice(0, 200),
      };
      sendWidgetState();
      if (!recordingWidgetState.recording && widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.hide();
      return true;
    });
    ipcMain.handle("widget:get-state", () => ({ ...recordingWidgetState }));
    ipcMain.handle("widget:action", (_event, action) => {
      const safeAction = ["pause", "resume", "stop", "open", "close"].includes(action) ? action : "";
      if (!safeAction) throw new Error("未知的小工具操作");
      if (safeAction === "open") {
        createWindow();
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
        return true;
      }
      if (safeAction === "close") {
        if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.hide();
        return true;
      }
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("widget:action", safeAction);
      return true;
    });

    ipcMain.handle("courses:list", (_event, filters) => courseDb.listCourses(filters || {}).map(publicCourse));
    ipcMain.handle("courses:get", (_event, courseId) => publicDetail(courseDb.getCourseDetail(validateCourseId(courseId))));
    ipcMain.handle("courses:create", (_event, input) => publicCourse(courseDb.createCourse(makeCourseInput(input))));
    ipcMain.handle("courses:update", (_event, { courseId, patch }) => publicCourse(courseDb.updateCourse(validateCourseId(courseId), patch || {})));
    ipcMain.handle("courses:set-category", (_event, { courseId, categoryId }) => {
      const course = courseDb.setCourseCategory(validateCourseId(courseId), categoryId);
      emitUpdated(course.id, "category");
      return publicCourse(course);
    });
    ipcMain.handle("courses:trash", (_event, courseId) => moveCourseToTrash(courseId));
    ipcMain.handle("courses:restore", (_event, courseId) => restoreCourseFromTrash(courseId));
    ipcMain.handle("courses:delete-permanently", async (_event, courseId) => {
      const id = validateCourseId(courseId);
      const detail = courseDb.getCourseDetail(id);
      if (!detail) return { deleted: false };
      if (!detail.course.deleted_at) throw new Error("請先將課程移到應用內回收桶。");
      for (const media of detail.media) {
        try { if (media.file_path) await shell.trashItem(media.file_path); } catch (error) { startupLog(`媒體移到回收桶失敗: ${error.message}`); }
      }
      courseDb.deleteCourse(id);
      emitUpdated(id, "deleted");
      return { deleted: true };
    });
    ipcMain.handle("courses:import-media", async (event, { courseId, sourceId }) => {
      const id = validateCourseId(courseId);
      const media = await registerMediaFile(event, id, sourceId);
      emitUpdated(id, "media");
      return media;
    });
    ipcMain.handle("courses:export-media", async (_event, { mediaId }) => {
      const media = courseDb.getMedia(String(mediaId || ""));
      if (!media?.file_path) throw new Error("找不到媒體");
      const result = await dialog.showSaveDialog(mainWindow, { defaultPath: media.original_name });
      if (result.canceled || !result.filePath) return { canceled: true };
      await fs.copyFile(media.file_path, result.filePath);
      return { canceled: false };
    });

    ipcMain.handle("categories:list", () => courseDb.listCategories());
    ipcMain.handle("categories:create", (_event, name) => courseDb.addCategory(String(name || "")));
    ipcMain.handle("semesters:list", () => courseDb.listSemesters());
    ipcMain.handle("semesters:create", (_event, name) => courseDb.addSemester(String(name || "")));

    ipcMain.handle("media:choose", chooseMediaFile);
    ipcMain.handle("transcription:start", (_event, { courseId, mediaId, language }) => {
      const id = validateCourseId(courseId);
      const active = activeTranscriptionJob(id);
      if (active) return { jobId: active, reused: true };
      const job = courseDb.createJob(id, "transcription");
      activeJobs.set(job.id, id);
      void runImportedPipeline(id, String(mediaId || ""), String(language || "zh-TW"), job.id);
      return { jobId: job.id };
    });
    ipcMain.handle("transcription:retry", (_event, { courseId }) => {
      const id = validateCourseId(courseId);
      const active = activeTranscriptionJob(id);
      if (active) return { jobId: active, reused: true };
      const detail = courseDb.getCourseDetail(id);
      const media = detail?.media.find((item) => item.processing_status !== "recording") || detail?.media[0];
      if (!media) throw new Error("找不到可重新轉錄的媒體");
      courseDb.clearSegments(id);
      const job = courseDb.createJob(id, "transcription-retry");
      activeJobs.set(job.id, id);
      void runImportedPipeline(id, media.id, detail.course.language, job.id);
      return { jobId: job.id };
    });
    ipcMain.handle("notes:generate", async (_event, { courseId, model }) => {
      const id = validateCourseId(courseId);
      try { return { note: await generateNotesForCourse(id, model || null) }; }
      catch (error) {
        courseDb.updateCourse(id, { status: "failed", error: error.message });
        courseDb.saveNotes(id, { model: model || courseDb.getSetting("selectedOllamaModel", DEFAULT_MODEL), status: "error", error: error.message });
        emitProgress(id, "error", error.message, 100, { code: error.code || "NOTES_FAILED" });
        emitUpdated(id, "notes-error");
        throw error;
      }
    });
    ipcMain.handle("translations:generate", async (_event, { courseId, targetLanguage, model }) => {
      const id = validateCourseId(courseId);
      return { translations: await translateTranscriptForCourse(id, targetLanguage || "en", model || null) };
    });

    ipcMain.handle("models:status", async () => ({ ...await ollama.status(), choices: AVAILABLE_MODELS, selected: courseDb.getSetting("selectedOllamaModel", DEFAULT_MODEL) }));
    ipcMain.handle("models:select", (_event, model) => {
      const selected = String(model || "");
      if (!AVAILABLE_MODELS.some((item) => item.name === selected)) throw new Error("不支援的模型");
      courseDb.setSetting("selectedOllamaModel", selected);
      return { selected };
    });
    ipcMain.handle("models:pull", async (_event, model) => {
      const selected = String(model || DEFAULT_MODEL);
      if (!AVAILABLE_MODELS.some((item) => item.name === selected)) throw new Error("不支援的模型");
      try {
        const result = await ollama.pull(selected, (data) => emitModelProgress(selected, data));
        return { result, status: await ollama.status() };
      } catch (error) {
        send("model:progress", { model: selected, status: "error", detail: error.message, progress: null });
        throw error;
      }
    });
    ipcMain.handle("models:remove", async (_event, model) => {
      const selected = String(model || "");
      if (!AVAILABLE_MODELS.some((item) => item.name === selected)) throw new Error("不支援的模型");
      await ollama.remove(selected);
      return ollama.status();
    });
    ipcMain.handle("models:cancel", () => { ollama.cancelAll(); return true; });
    ipcMain.handle("models:open-download", () => shell.openExternal("https://ollama.com/download/windows"));

    ipcMain.handle("capture:list", async () => {
      const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 360, height: 203 } });
      captureSources.clear();
      const result = sources.map((source) => {
        captureSources.set(source.id, source);
        return { id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL(), type: source.id.startsWith("window:") ? "window" : "screen" };
      });
      startupLog(`找到 ${result.length} 個可錄製來源`);
      return result;
    });
    ipcMain.handle("capture:select", (_event, sourceId) => {
      selectedCaptureSource = captureSources.get(String(sourceId || "")) || null;
      return Boolean(selectedCaptureSource);
    });

    ipcMain.handle("recording:create", (_event, input) => publicCourse(courseDb.createCourse({ ...makeCourseInput(input), source: "recording" })));
    ipcMain.handle("recording:begin", async (_event, { courseId, title, language, model }) => {
      const id = validateCourseId(courseId);
      if (liveSessions.has(id)) throw new Error("這門課已在錄製中。");
      const tempVideo = segmentPath(stagingRoot, id, 0);
      const originalName = `${safeBaseName(title)}-${recordingStamp()}.webm`;
      await fs.mkdir(stagingRoot, { recursive: true });
      await fs.writeFile(tempVideo, Buffer.alloc(0));
      const media = courseDb.upsertMedia({
        id: randomUUID(), courseId: id, filePath: tempVideo, originalName,
        mimeType: "video/webm", mediaType: "video", extension: "webm", size: 0,
        processingStatus: "recording",
      });
      const sessionState = {
        courseId: id, title: String(title || "未命名課程"), language: String(language || "zh-TW"),
        model: AVAILABLE_MODELS.some((item) => item.name === model) ? model : courseDb.getSetting("selectedOllamaModel", DEFAULT_MODEL),
        tempVideo, segmentPaths: [tempVideo], segmentIndex: 0, segmentOpen: true,
        originalName, videoQueue: Promise.resolve(), audioQueue: Promise.resolve(), mediaId: media.id,
        processedMs: 0, expectedMs: 0, error: null,
      };
      liveSessions.set(id, sessionState);
      courseDb.updateCourse(id, { status: "recording", error: null });
      emitProgress(id, "recording", "正在錄影與背景轉錄", 0, { live: true });
      return { started: true, courseId: id };
    });
    ipcMain.handle("recording:video-chunk", (_event, { courseId, bytes }) => {
      const state = liveSessions.get(validateCourseId(courseId));
      if (!state) throw new Error("找不到正在錄製的課程");
      if (!state.segmentOpen) throw new Error("錄影目前已暫停，不能寫入影片片段");
      const buffer = toBuffer(bytes);
      if (!buffer.length) return { accepted: false };
      state.videoQueue = state.videoQueue.then(() => fs.appendFile(state.tempVideo, buffer));
      state.videoQueue = state.videoQueue.catch((error) => { state.error = state.error || error; throw error; });
      return { accepted: true, bytes: buffer.length };
    });
    ipcMain.handle("recording:pause", async (_event, { courseId }) => {
      const state = liveSessions.get(validateCourseId(courseId));
      if (!state) throw new Error("找不到正在錄製的課程");
      if (!state.segmentOpen) return { paused: true };
      await state.videoQueue;
      state.segmentOpen = false;
      const stats = await fs.stat(state.tempVideo);
      courseDb.updateMedia(state.mediaId, { size: stats.size });
      if (stats.size === 0) return { paused: true, videoSeconds: 0, audioSeconds: 0, audioOk: true };
      const health = await inspectRecordingAudio(ffmpegPath, state.tempVideo);
      if (!health.audioOk) {
        state.error = state.error || new Error("錄影片段的聲音比影像提早中斷；已保留影片，請檢查系統音訊來源。");
      }
      return { paused: true, ...health };
    });
    ipcMain.handle("recording:resume", async (_event, { courseId }) => {
      const state = liveSessions.get(validateCourseId(courseId));
      if (!state) throw new Error("找不到正在錄製的課程");
      if (state.segmentOpen) throw new Error("錄影尚未暫停");
      if (state.segmentIndex >= 999) throw new Error("錄影片段數已達上限，請先停止並保存課程。");
      const nextIndex = state.segmentIndex + 1;
      const nextPath = segmentPath(stagingRoot, state.courseId, nextIndex);
      await fs.writeFile(nextPath, Buffer.alloc(0), { flag: "wx" });
      state.segmentIndex = nextIndex;
      state.segmentPaths.push(nextPath);
      state.tempVideo = nextPath;
      state.videoQueue = Promise.resolve();
      state.segmentOpen = true;
      return { resumed: true, segment: nextIndex };
    });
    ipcMain.handle("recording:audio-chunk", (_event, { courseId, samples, sampleRate, startMs, expectedMs }) => {
      const state = liveSessions.get(validateCourseId(courseId));
      if (!state) throw new Error("找不到正在錄製的課程");
      const input = samples instanceof Float32Array ? new Float32Array(samples) : Float32Array.from(samples || []);
      if (!input.length) return { accepted: false };
      state.expectedMs = Math.max(state.expectedMs, Number(expectedMs) || 0);
      state.audioQueue = state.audioQueue.catch(() => {}).then(() => processLiveAudio(state, input, Number(sampleRate) || 16000, Number(startMs) || 0)).catch((error) => {
        state.error = state.error || error;
        startupLog(`背景轉錄片段失敗: ${error.stack || error.message}`);
      });
      return { accepted: true };
    });
    ipcMain.handle("recording:finish", (_event, { courseId }) => {
      const state = liveSessions.get(validateCourseId(courseId));
      if (!state) throw new Error("找不到正在錄製的課程");
      void finishLiveSession(state);
      return { accepted: true };
    });

    // Compatibility aliases for the earlier 0.1.x renderer/tests.
    ipcMain.handle("recording:choose-media", chooseMediaFile);
    ipcMain.handle("recording:export-imported", async (event, { sourceId, courseTitle }) => {
      const source = getPendingImport(event, sourceId);
      const result = await dialog.showSaveDialog(mainWindow, { defaultPath: `${safeBaseName(courseTitle)}.${source.extension}` });
      if (result.canceled || !result.filePath) return { canceled: true };
      await fs.copyFile(source.filePath, result.filePath);
      return { canceled: false };
    });
  }

  app.on("second-instance", () => {
    if (!mainWindow) createWindow();
    else {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send("app:focus");
    }
  });

  process.on("uncaughtException", (error) => startupLog(`未處理例外: ${error.stack || error.message}`));
  process.on("unhandledRejection", (error) => startupLog(`未處理 Promise: ${error?.stack || error}`));

  app.whenReady().then(async () => {
    try {
      const userData = app.getPath("userData");
      libraryRoot = path.join(userData, "media-library");
      stagingRoot = path.join(userData, "staging");
      await fs.mkdir(libraryRoot, { recursive: true });
      await fs.mkdir(stagingRoot, { recursive: true });
      courseDb = new CourseDatabase(path.join(userData, "coursescribe.sqlite"));
      ollama = new OllamaClient();
      await recoverInterruptedRecordings();
      await recoverMostRecentTranscription();
      recoverInterruptedNotes();
      await purgeExpiredTrash();
      protocol.handle("coursescribe-media", async (request) => {
        try {
          const url = new URL(request.url);
          const mediaId = decodeURIComponent(url.pathname.replace(/^\//, ""));
          const media = courseDb.getMedia(mediaId);
          if (!media || media.media_type !== "video" || media.is_trash || !media.file_path) return new Response("Not found", { status: 404 });
          return await net.fetch(pathToFileURL(media.file_path).toString());
        } catch (error) {
          startupLog(`讀取影片失敗: ${error.message}`);
          return new Response("Not found", { status: 404 });
        }
      });
      registerIpc();
      session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
        const source = selectedCaptureSource;
        selectedCaptureSource = null;
        callback(source ? { video: source, audio: "loopback" } : {});
      });
      createWindow();
      startupLog(`CourseScribe ${APP_VERSION} 已啟動，資料庫位於 ${path.join(userData, "coursescribe.sqlite")}`);
    } catch (error) {
      startupLog(`應用程式啟動失敗: ${error.stack || error.message}`);
      dialog.showErrorBox("CourseScribe 無法啟動", error.message || "資料庫初始化失敗");
      app.quit();
    }
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }).catch((error) => startupLog(`應用程式啟動失敗: ${error.stack || error.message}`));

  app.on("before-quit", () => {
    try { ollama?.cancelAll(); } catch {}
    try { courseDb?.close(); } catch {}
  });
  app.on("window-all-closed", () => {
    captureSources.clear();
    if (process.platform !== "darwin") app.quit();
  });
}
