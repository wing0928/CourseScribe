const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

function send(type, payload = {}) {
  if (typeof process.send === "function") process.send({ type, ...payload });
}

function languageName(code) {
  return { "zh-TW": "chinese", "zh-CN": "chinese", "en-US": "english", "ja-JP": "japanese" }[code] || "chinese";
}

function loadWavSamples(wavBytes, WaveFile) {
  const wav = new WaveFile(wavBytes);
  wav.toBitDepth("32f");
  wav.toSampleRate(16000);
  let samples = wav.getSamples();
  if (Array.isArray(samples)) samples = samples[0];
  return samples instanceof Float32Array ? samples : new Float32Array(samples);
}

function normalizeText(text, modelLanguage) {
  return String(text || "").replace(/\s+/g, modelLanguage === "english" ? " " : "").trim();
}

async function run(config) {
  const appRoot = String(config.appRoot || __dirname);
  const requireFromApp = createRequire(path.join(appRoot, "package.json"));
  const { WaveFile } = requireFromApp("wavefile");
  const transformersPath = requireFromApp.resolve("@huggingface/transformers");
  const { pipeline, env } = await import(pathToFileURL(transformersPath).href);
  env.cacheDir = config.modelCacheDir;

  const tempParent = String(config.tempRoot || os.tmpdir());
  await fs.mkdir(tempParent, { recursive: true });
  const tempRoot = await fs.mkdtemp(path.join(tempParent, "coursescribe-transcribe-worker-"));
  try {
    send("stage", { detail: "正在初始化背景 Whisper 模型；CPU 模式首次啟動可能需要數分鐘", progress: 4 });
    const modelId = config.modelId === "onnx-community/whisper-base"
      ? "onnx-community/whisper-base"
      : "onnx-community/whisper-small";
    const transcriber = await pipeline("automatic-speech-recognition", modelId, {
      dtype: "q4",
      device: "cpu",
      progress_callback: (item) => send("model-progress", {
        detail: item?.file || "正在載入本機 Whisper 模型",
        progress: Number.isFinite(Number(item?.progress)) ? Number(item.progress) : null,
      }),
    });
    send("stage", { detail: `${modelId.endsWith("base") ? "快速" : "高準確"} Whisper 模型已準備完成`, progress: 4 });

    const audio = loadWavSamples(await fs.readFile(config.wavPath), WaveFile);
    if (!audio.length) throw new Error("這個檔案沒有可用的音訊內容。");
    const durationMs = Math.round(audio.length / 16000 * 1000);
    const chunkMs = 20000;
    const overlapMs = 2000;
    const total = Math.max(1, Math.ceil(durationMs / (chunkMs - overlapMs)));
    const modelLanguage = languageName(config.language);
    let startMs = 0;
    let chunkIndex = 0;
    const inferenceStartedAt = Date.now();

    while (startMs < durationMs || chunkIndex === 0) {
      send("stage", { detail: `正在辨識第 ${chunkIndex + 1}/${total} 段音訊`, progress: Math.min(99, Math.round(startMs / durationMs * 100)) });
      const endMs = Math.min(durationMs, startMs + chunkMs);
      const samples = audio.slice(Math.floor(startMs / 1000 * 16000), Math.floor(endMs / 1000 * 16000));
      const result = await transcriber(samples, {
        language: modelLanguage,
        task: "transcribe",
        return_timestamps: true,
      });
      const chunks = Array.isArray(result.chunks) && result.chunks.length
        ? result.chunks
        : (result.text ? [{ text: result.text, timestamp: [0, null] }] : []);
      const segments = chunks.map((chunk) => {
        const localStart = Number(chunk.timestamp?.[0]);
        const localEnd = Number(chunk.timestamp?.[1]);
        return {
          startMs: Math.max(0, Math.round(startMs + (Number.isFinite(localStart) ? localStart * 1000 : 0))),
          endMs: Number.isFinite(localEnd) ? Math.max(0, Math.round(startMs + localEnd * 1000)) : null,
          text: normalizeText(chunk.text, modelLanguage),
        };
      }).filter((segment) => segment.text);
      chunkIndex += 1;
      const averageChunkSeconds = (Date.now() - inferenceStartedAt) / 1000 / chunkIndex;
      send("segments", {
        segments,
        chunkIndex,
        total,
        durationMs,
        progress: Math.min(100, Math.round(endMs / durationMs * 100)),
        etaSeconds: Math.round(Math.max(0, total - chunkIndex) * averageChunkSeconds),
      });
      if (endMs >= durationMs) break;
      startMs += chunkMs - overlapMs;
    }
    send("complete", { durationMs, total });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

process.on("message", (message) => {
  if (message?.type === "cancel") process.exit(130);
});

process.on("uncaughtException", (error) => {
  send("error", { message: error?.message || "背景 Whisper 程序失敗", stack: error?.stack || "" });
  process.exitCode = 1;
});

process.on("unhandledRejection", (error) => {
  send("error", { message: error?.message || String(error), stack: error?.stack || "" });
  process.exitCode = 1;
});

if (require.main === module) {
  let config = null;
  process.on("message", (message) => {
    if (message?.type !== "start" || config) return;
    config = message.config;
    run(config)
      .catch((error) => {
        send("error", { message: error?.message || "背景 Whisper 轉錄失敗", stack: error?.stack || "" });
        process.exitCode = 1;
      });
  });
}
