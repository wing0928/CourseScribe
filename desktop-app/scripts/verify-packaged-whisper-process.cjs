const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { fork } = require("node:child_process");

async function run() {
  const modelId = process.env.COURSESCRIBE_TEST_WHISPER_MODEL || "onnx-community/whisper-small";
  const startedAt = Date.now();
  const packagedRoot = path.resolve(process.env.COURSESCRIBE_PACKAGED_ROOT || path.join(__dirname, "..", "release-0.1.27", "win-unpacked"));
  const appRoot = path.join(packagedRoot, "resources", "app.asar");
  const workerPath = path.join(packagedRoot, "resources", "app.asar.unpacked", "whisper-worker.cjs");
  const electronExecutable = process.env.COURSESCRIBE_ELECTRON_EXECUTABLE || path.join(packagedRoot, "CourseScribe.exe");
  const sample = path.join(__dirname, "..", "verification-output", "jfk.wav");
  const root = path.join(__dirname, "..", "verification-output", "packaged-worker");
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  await fs.access(workerPath);
  await fs.access(sample);
  const segments = [];
  const result = await new Promise((resolve, reject) => {
    const child = fork(workerPath, [], {
      execPath: electronExecutable,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    let settled = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error("封裝背景程序測試逾時")); }, 600000);
    child.on("message", (message) => {
      if (message.type === "segments") segments.push(...(message.segments || []));
      if (message.type === "error" && !settled) { settled = true; clearTimeout(timer); reject(new Error(message.message)); }
      if (message.type === "complete" && !settled) { settled = true; clearTimeout(timer); resolve(message); child.kill(); }
    });
    child.on("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.send({ type: "start", config: {
      wavPath: sample,
      language: "en-US",
      appRoot,
      tempRoot: root,
      modelCacheDir: path.join(process.env.APPDATA, "coursescribe-desktop", "whisper-models"),
      modelId,
    }});
  });
  assert.ok(result.durationMs >= 900);
  assert.ok(segments.length > 0);
  assert.ok(segments.every((segment) => segment.text && Number.isFinite(segment.startMs)));
  console.log(JSON.stringify({ ok: true, packaged: true, workerPath, modelId, elapsedMs: Date.now() - startedAt, durationMs: result.durationMs, segmentCount: segments.length, firstSegment: segments[0] }));
}

run().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
