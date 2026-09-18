const { app } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const ffmpegPath = require("ffmpeg-static");
const { runFfmpeg } = require("../media-utils.cjs");

async function run() {
  const packagedRoot = path.resolve(process.env.COURSESCRIBE_PACKAGED_ROOT || process.argv.at(-1) || "");
  const appRoot = path.join(packagedRoot, "resources", "app.asar");
  const workerPath = path.join(packagedRoot, "resources", "app.asar.unpacked", "whisper-worker.cjs");
  await fs.access(workerPath);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coursescribe-packaged-worker-"));
  const input = path.join(root, "short-tone.wav");
  await runFfmpeg(ffmpegPath, ["-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000", "-t", "1", "-c:a", "pcm_s16le", input]);
  await app.whenReady();
  let beats = 0;
  const ticker = setInterval(() => { beats += 1; }, 25);
  try {
    const outcome = await new Promise((resolve, reject) => {
      const worker = new Worker(workerPath, { workerData: { wavPath: input, language: "en-US", appRoot, modelCacheDir: path.join(process.env.APPDATA || root, "coursescribe-desktop", "whisper-models") } });
      const timer = setTimeout(() => { worker.terminate().catch(() => {}); reject(new Error("封裝 Worker 測試逾時")); }, 600000);
      worker.on("message", (message) => {
        if (message.type === "complete") { clearTimeout(timer); worker.terminate().catch(() => {}); resolve(message); }
        if (message.type === "error") { clearTimeout(timer); reject(new Error(message.message)); }
      });
      worker.on("error", reject);
    });
    assert.ok(beats > 2, "封裝 Worker 不可阻塞 Electron 主程序");
    console.log(JSON.stringify({ ok: true, packaged: true, heartbeats: beats, durationMs: outcome.durationMs }));
  } finally { clearInterval(ticker); await fs.rm(root, { recursive: true, force: true }); }
}

run().then(() => app.exit(0)).catch((error) => { console.error(error.stack || error.message); app.exit(1); });
