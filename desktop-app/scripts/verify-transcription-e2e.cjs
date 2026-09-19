const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const { CourseDatabase } = require("../database.cjs");

const root = path.join(__dirname, "..", "verification-output", "transcription-e2e");
const sample = path.join(__dirname, "..", "verification-output", "jfk.wav");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForWindow() {
  for (let i = 0; i < 200; i += 1) {
    const window = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
    if (window && !window.webContents.isLoadingMainFrame()) return window;
    await wait(100);
  }
  throw new Error("主視窗未在 20 秒內載入");
}

async function evaluate(window, fn, ...args) {
  return window.webContents.executeJavaScript(`(${fn})(${args.map((value) => JSON.stringify(value)).join(",")})`);
}

function seedCourse(db, title, sourcePath, status = "draft") {
  const course = db.createCourse({ title, source: "import", language: "en-US", status });
  const mediaPath = path.join(root, "media-library", course.id, `${course.id}.wav`);
  fs.mkdirSync(path.dirname(mediaPath), { recursive: true });
  fs.copyFileSync(sourcePath, mediaPath);
  const media = db.upsertMedia({
    courseId: course.id,
    filePath: mediaPath,
    originalName: `${title}.wav`,
    mimeType: "audio/wav",
    mediaType: "audio",
    extension: "wav",
    size: fs.statSync(mediaPath).size,
    processingStatus: "ready",
  });
  return { course, media };
}

function prepareFixture() {
  if (!fs.existsSync(sample)) throw new Error("短語音樣本不存在，請先完成 verify:whisper-process");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const db = new CourseDatabase(path.join(root, "coursescribe.sqlite"));
  const completed = seedCourse(db, "背景程序完整轉錄驗收", sample);
  const stopped = seedCourse(db, "停止轉錄驗收", sample);
  const recovery = seedCourse(db, "重啟恢復驗收", sample, "transcribing");
  const oldJob = db.createJob(recovery.course.id, "transcription");
  db.updateJob(oldJob.id, { status: "running", progress: 4, detail: "測試重啟前的中斷工作" });
  db.close();
  return { completed, stopped, recovery };
}

const fixtures = prepareFixture();
const tempRoot = path.join(root, "tmp");
fs.mkdirSync(tempRoot, { recursive: true });
process.env.TEMP = tempRoot;
process.env.TMP = tempRoot;
process.env.COURSESCRIBE_MODEL_CACHE_DIR = path.join(process.env.APPDATA, "course-capture-desktop", "whisper-models");
app.setPath("userData", root);
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("disable-features", "VizDisplayCompositor");
require("../main.cjs");

async function run() {
  const { completed, stopped, recovery } = fixtures;
  await app.whenReady();
  const window = await waitForWindow();
  let unresponsive = false;
  window.on("unresponsive", () => { unresponsive = true; });

  const initial = await evaluate(window, () => ({ title: document.title, body: document.body.innerText.length }));
  assert.ok(initial.body > 20, "UI 初始畫面不可為黑屏");
  const started = await evaluate(window, async (courseId, mediaId) => window.courseCapture.transcription.start(courseId, mediaId, "en-US"), completed.course.id, completed.media.id);
  const duplicate = await evaluate(window, async (courseId, mediaId) => window.courseCapture.transcription.start(courseId, mediaId, "en-US"), completed.course.id, completed.media.id);
  assert.equal(duplicate.jobId, started.jobId, "同一課程不可同時啟動第二個轉錄工作");

  let detail = null;
  let uiHeartbeats = 0;
  let progressSeen = 0;
  for (let i = 0; i < 240; i += 1) {
    await wait(250);
    const ui = await evaluate(window, () => ({ title: document.title, body: document.body.innerText.length }));
    if (ui.body > 20) uiHeartbeats += 1;
    detail = await evaluate(window, (courseId) => window.courseCapture.courses.get(courseId), completed.course.id);
    progressSeen = Math.max(progressSeen, Number(detail?.jobs?.[0]?.progress || 0));
    if (detail?.segments?.length && progressSeen > 4) break;
  }
  assert.ok(!unresponsive, "轉錄期間 Electron 視窗不可回報 unresponsive");
  assert.ok(uiHeartbeats >= 3, "轉錄期間 UI 必須可持續操作");
  assert.ok(detail.segments.length > 0, "SQLite 應寫入至少一個逐字稿片段");
  assert.ok(progressSeen > 4, `進度必須超過 4%，實際 ${progressSeen}%`);
  assert.ok(detail.segments.every((segment) => segment.text && Number.isFinite(segment.startMs)), "SQLite 片段必須有文字與時間戳");

  const stopStarted = await evaluate(window, async (courseId, mediaId) => window.courseCapture.transcription.start(courseId, mediaId, "en-US"), stopped.course.id, stopped.media.id);
  const stopDuplicate = await evaluate(window, async (courseId, mediaId) => window.courseCapture.transcription.start(courseId, mediaId, "en-US"), stopped.course.id, stopped.media.id);
  assert.equal(stopDuplicate.jobId, stopStarted.jobId, "停止測試也不可建立重複工作");
  const stopResult = await evaluate(window, async (courseId) => window.courseCapture.transcription.cancel(courseId), stopped.course.id);
  assert.equal(stopResult.stopped, true, "停止 IPC 必須確認已送出停止");
  let stoppedDetail = null;
  for (let i = 0; i < 80; i += 1) {
    await wait(100);
    stoppedDetail = await evaluate(window, (courseId) => window.courseCapture.courses.get(courseId), stopped.course.id);
    if (stoppedDetail?.jobs?.[0]?.status === "interrupted") break;
  }
  assert.equal(stoppedDetail.jobs[0].status, "interrupted", "停止後工作必須進入 interrupted");
  assert.equal(stoppedDetail.course.status, "failed", "停止後課程狀態必須可重試");
  assert.ok(stoppedDetail.media.length === 1 && fs.existsSync(stoppedDetail.media[0].mediaUrl ? path.join(root, "media-library", stopped.course.id, `${stopped.course.id}.wav`) : path.join(root, "media-library", stopped.course.id, `${stopped.course.id}.wav`)), "停止後媒體檔必須保留");

  let recoveryDetail = null;
  for (let i = 0; i < 240; i += 1) {
    await wait(250);
    recoveryDetail = await evaluate(window, (courseId) => window.courseCapture.courses.get(courseId), recovery.course.id);
    if (recoveryDetail.segments.length > 0 && recoveryDetail.jobs.some((job) => job.type === "transcription-resume")) break;
  }
  assert.ok(recoveryDetail.segments.length > 0, "重啟恢復工作必須寫入逐字稿片段");
  assert.ok(recoveryDetail.jobs.some((job) => job.type === "transcription-resume"), "啟動時必須建立恢復工作");
  console.log(JSON.stringify({
    ok: true,
    uiHeartbeats,
    completed: { courseId: completed.course.id, segmentCount: detail.segments.length, progress: progressSeen, firstSegment: detail.segments[0] },
    stopped: { courseId: stopped.course.id, status: stoppedDetail.jobs[0].status, mediaRetained: true },
    recovery: { courseId: recovery.course.id, segmentCount: recoveryDetail.segments.length, resumeJob: recoveryDetail.jobs.find((job) => job.type === "transcription-resume")?.status },
  }));
  setTimeout(() => app.exit(0), 200);
}

run().catch((error) => {
  console.error(error.stack || error.message);
  app.exit(1);
});
