const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const ffmpegPath = require("ffmpeg-static");
const { runFfmpeg } = require("../media-utils.cjs");

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coursescribe-worker-"));
  const input = path.join(root, "short-tone.wav");
  await runFfmpeg(ffmpegPath, ["-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000", "-t", "1", "-c:a", "pcm_s16le", input]);
  let heartbeats = 0;
  const timer = setInterval(() => { heartbeats += 1; }, 25);
  try {
    const outcome = await new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, "..", "whisper-worker.cjs"), { workerData: {
        wavPath: input, language: "en-US", appRoot: path.join(__dirname, ".."),
        modelCacheDir: path.join(process.env.APPDATA || root, "coursescribe-desktop", "whisper-models"),
      } });
      const timeout = setTimeout(() => { worker.terminate().catch(() => {}); reject(new Error("背景 Whisper Worker 測試逾時")); }, 600000);
      worker.on("message", (message) => {
        if (message.type === "complete") { clearTimeout(timeout); worker.terminate().catch(() => {}); resolve(message); }
        if (message.type === "error") { clearTimeout(timeout); reject(new Error(message.message)); }
      });
      worker.on("error", reject);
      worker.on("exit", (code) => { if (code !== 0 && code !== 1) reject(new Error(`Worker 意外結束：${code}`)); });
    });
    assert.ok(heartbeats > 2, "Worker 運行時主事件迴圈仍必須可回應");
    console.log(JSON.stringify({ ok: true, worker: "completed", heartbeats, durationMs: outcome.durationMs }));
  } finally { clearInterval(timer); await fs.rm(root, { recursive: true, force: true }); }
}

run().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
