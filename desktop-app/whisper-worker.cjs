const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { createRequire } = require("node:module");

// In a packaged Electron app this worker entry point is deliberately unpacked
// so Node can execute it.  Its dependencies remain safely in app.asar, so use
// a require rooted at the archived package instead of resolving from the
// unpacked directory.
const appRoot = String(workerData?.appRoot || __dirname);
const requireFromApp = createRequire(path.join(appRoot, "package.json"));
const { WaveFile } = requireFromApp("wavefile");
const { transcodeMediaToWav } = requireFromApp("./media-utils.cjs");

function languageName(code) {
  return { "zh-TW": "chinese", "zh-CN": "chinese", "en-US": "english", "ja-JP": "japanese" }[code] || "chinese";
}

function send(type, payload = {}) { parentPort.postMessage({ type, ...payload }); }

function loadWavSamples(wavBytes) {
  const wav = new WaveFile(wavBytes);
  wav.toBitDepth("32f");
  wav.toSampleRate(16000);
  let samples = wav.getSamples();
  if (Array.isArray(samples)) samples = samples[0];
  return samples instanceof Float32Array ? samples : new Float32Array(samples);
}

async function run() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "coursescribe-transcribe-"));
  const wavPath = path.join(tempRoot, "audio.wav");
  try {
    send("stage", { detail: "正在以背景程序準備音訊", progress: 2 });
    await transcodeMediaToWav({ ffmpegPath: workerData.ffmpegPath, inputPath: workerData.mediaPath, outputPath: wavPath });
    const audio = loadWavSamples(await fs.readFile(wavPath));
    if (!audio.length) throw new Error("這個檔案沒有可用的音訊內容。");
    send("stage", { detail: "正在載入背景 Whisper 模型", progress: 4 });
    const transformersPath = requireFromApp.resolve("@huggingface/transformers");
    const { pipeline, env } = await import(pathToFileURL(transformersPath).href);
    env.cacheDir = workerData.modelCacheDir;
    const transcriber = await pipeline("automatic-speech-recognition", "onnx-community/whisper-small", { dtype: "q4", device: "cpu" });
    const durationMs = Math.round(audio.length / 16000 * 1000);
    const chunkMs = 20000;
    const overlapMs = 2000;
    const total = Math.max(1, Math.ceil(durationMs / (chunkMs - overlapMs)));
    const modelLanguage = languageName(workerData.language);
    let startMs = 0;
    let chunkIndex = 0;
    while (startMs < durationMs || chunkIndex === 0) {
      const endMs = Math.min(durationMs, startMs + chunkMs);
      const samples = audio.slice(Math.floor(startMs / 1000 * 16000), Math.floor(endMs / 1000 * 16000));
      const result = await transcriber(samples, { language: modelLanguage, task: "transcribe", return_timestamps: true });
      const chunks = Array.isArray(result.chunks) && result.chunks.length ? result.chunks : (result.text ? [{ text: result.text, timestamp: [0, null] }] : []);
      const segments = chunks.map((chunk) => ({
        startMs: Math.max(0, Math.round(startMs + (Number.isFinite(Number(chunk.timestamp?.[0])) ? Number(chunk.timestamp[0]) * 1000 : 0))),
        endMs: Number.isFinite(Number(chunk.timestamp?.[1])) ? Math.max(0, Math.round(startMs + Number(chunk.timestamp[1]) * 1000)) : null,
        text: String(chunk.text || "").replace(/\s+/g, modelLanguage === "english" ? " " : "").trim(),
      })).filter((segment) => segment.text);
      chunkIndex += 1;
      send("segments", { segments, chunkIndex, total, progress: Math.min(100, Math.round(endMs / durationMs * 100)) });
      if (endMs >= durationMs) break;
      startMs += chunkMs - overlapMs;
    }
    send("complete", { durationMs, total });
  } finally { await fs.rm(tempRoot, { recursive: true, force: true }); }
}

run().catch((error) => send("error", { message: error?.message || "背景 Whisper 轉錄失敗", stack: error?.stack || "" }));
