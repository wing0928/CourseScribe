const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { fork } = require("node:child_process");
const ffmpegPath = require("ffmpeg-static");
const { runFfmpeg } = require("../media-utils.cjs");

async function run() {
  const modelId = process.env.COURSESCRIBE_TEST_WHISPER_MODEL || "onnx-community/whisper-small";
  const startedAt = Date.now();
  const testRoot = path.join(__dirname, "..", "verification-output");
  await fs.mkdir(testRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(testRoot, "coursescribe-process-"));
  const wavPath = path.join(root, "short-speech.wav");
  const bundledSample = path.join(testRoot, "jfk.wav");
  try {
    await fs.copyFile(bundledSample, wavPath);
  } catch {
    const response = await fetch("https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav");
    if (!response.ok) throw new Error(`無法取得短語音驗收檔：${response.status}`);
    await fs.writeFile(wavPath, Buffer.from(await response.arrayBuffer()));
  }
  let beats = 0;
  const ticker = setInterval(() => { beats += 1; }, 25);
  try {
    const outcome = await new Promise((resolve, reject) => {
      const child = fork(path.join(__dirname, "..", "whisper-worker.cjs"), [], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
      let settled = false;
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("背景 Whisper 子程序測試逾時"));
      }, 600000);
      const segments = [];
      child.on("message", (message) => {
        if (message.type === "segments") segments.push(...(message.segments || []));
        if (message.type === "error") {
          clearTimeout(timeout);
          if (!settled) { settled = true; reject(new Error(message.message)); }
        } else if (message.type === "complete") {
          clearTimeout(timeout);
          if (!settled) { settled = true; resolve({ ...message, segments }); }
          child.kill();
        }
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        if (!settled) { settled = true; reject(error); }
      });
      child.send({ type: "start", config: {
        wavPath,
        language: "en-US",
        appRoot: path.join(__dirname, ".."),
        tempRoot: root,
        modelCacheDir: path.join(process.env.APPDATA || root, "coursescribe-desktop", "whisper-models"),
        modelId,
      }});
    });
    assert.ok(beats > 2, "背景子程序運行時主事件迴圈仍必須可回應");
    assert.ok(outcome.durationMs >= 900, "背景子程序應回報實際音訊長度");
    assert.ok(outcome.segments.length > 0, "短語音應產生至少一個逐字稿片段");
    assert.ok(outcome.segments.every((segment) => Number.isFinite(segment.startMs) && String(segment.text || "").trim()), "每個片段都必須有文字與有效時間戳");
    console.log(JSON.stringify({ ok: true, process: "completed", modelId, elapsedMs: Date.now() - startedAt, heartbeats: beats, durationMs: outcome.durationMs, segmentCount: outcome.segments.length, preview: outcome.segments.slice(0, 3) }));
  } finally {
    clearInterval(ticker);
    await fs.rm(root, { recursive: true, force: true });
  }
}

run().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
