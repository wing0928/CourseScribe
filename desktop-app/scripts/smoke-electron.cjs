const { app } = require("electron");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { dialog } = require("electron");
const { CourseDatabase } = require("../database.cjs");

const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coursescribe-electron-smoke-"));
const fixture = path.join(smokeRoot, "lecture-audio.mp3");
fs.writeFileSync(fixture, Buffer.alloc(96, 7));
const recoveryStaging = path.join(smokeRoot, "staging");
fs.mkdirSync(recoveryStaging, { recursive: true });
const recoveryPath = path.join(recoveryStaging, "recovery.webm.part");
fs.writeFileSync(recoveryPath, Buffer.alloc(128, 9));
const recoveryDb = new CourseDatabase(path.join(smokeRoot, "coursescribe.sqlite"));
const recoveryCourse = recoveryDb.createCourse({ title: "中斷復原測試", source: "recording", language: "zh-TW" });
recoveryDb.upsertMedia({ id: "recovery-media", courseId: recoveryCourse.id, filePath: recoveryPath, originalName: "recovery.webm", mimeType: "video/webm", mediaType: "video", extension: "webm", size: 128, processingStatus: "recording" });
recoveryDb.close();
app.setPath("userData", smokeRoot);
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("disable-features", "VizDisplayCompositor");
app.disableHardwareAcceleration();

let openMode = "cancel";
dialog.showOpenDialog = async (_window, options) => {
  if (options?.title !== "選擇錄音或影音檔") throw new Error(`非預期的檔案對話框：${options?.title || ""}`);
  return openMode === "cancel" ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [fixture] };
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message) => { throw new Error(message); };
function exitAfterTest(code) { app.exit(code); setTimeout(() => process.exit(code), 300).unref(); }

async function waitForWindow() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const window = require("electron").BrowserWindow.getAllWindows()[0];
    if (window && !window.isDestroyed() && !window.webContents.isLoadingMainFrame()) return window;
    await wait(100);
  }
  fail("主視窗未在 6 秒內完成載入");
}

async function evaluate(window, expression, ...args) {
  return window.webContents.executeJavaScript(`(${expression})(${args.map((value) => JSON.stringify(value)).join(",")})`);
}

async function run() {
  require("../main.cjs");
  await app.whenReady();
  const window = await waitForWindow();
  const recovered = await evaluate(window, async (courseId) => window.courseCapture.courses.get(courseId), recoveryCourse.id);
  if (!recovered || recovered.course.status !== "failed" || recovered.media[0]?.processingStatus !== "ready") fail(`中斷錄影沒有在啟動時復原：${JSON.stringify(recovered)}`);
  const initial = await evaluate(window, () => ({
    title: document.title,
    oldPicker: Boolean(document.querySelector("[data-picker], .picker")),
    hasHome: Boolean(document.querySelector("[data-view-panel=home]")),
    hasDatabase: Boolean(document.querySelector("[data-view-panel=database]")),
    recordReady: Boolean(document.querySelector("[data-record]")),
    uploadReady: Boolean(document.querySelector("[data-upload]")),
    homeHasTranscript: Boolean(document.querySelector("[data-transcript]")),
    hasRecordingWidget: Boolean(document.querySelector("[data-recording-widget]")),
    hasPauseControl: Boolean(document.querySelector("[data-pause-recording]")),
    hasModelCancel: Boolean(document.querySelector("[data-cancel-model]")),
    hasWidgetBridge: Boolean(window.courseCapture.widget?.show && window.courseCapture.widget?.onAction),
  }));
  if (!initial.hasHome || !initial.hasDatabase || initial.oldPicker || !initial.recordReady || !initial.uploadReady || initial.homeHasTranscript || !initial.hasRecordingWidget || !initial.hasPauseControl || !initial.hasModelCancel || !initial.hasWidgetBridge) fail(`首頁結構錯誤：${JSON.stringify(initial)}`);

  await evaluate(window, () => document.querySelector("[data-view=database]").click());
  await wait(250);
  const initialDatabase = await evaluate(window, () => ({ hidden: document.querySelector("[data-view-panel=database]").hidden, hasSearch: Boolean(document.querySelector("[data-db-search]")) }));
  if (initialDatabase.hidden || !initialDatabase.hasSearch) fail("資料庫分頁未正常開啟");

  const created = await evaluate(window, async () => {
    const category = await window.courseCapture.categories.create("測試分類");
    const semester = await window.courseCapture.semesters.create("2026-1");
    return window.courseCapture.courses.create({ title: "持久化測試課程", categoryId: category.id, semester: semester.name, language: "zh-TW", model: "qwen3:4b" });
  });
  const loaded = await evaluate(window, async (courseId) => window.courseCapture.courses.get(courseId), created.id);
  if (!loaded || loaded.course.title !== "持久化測試課程" || loaded.course.categoryName !== "測試分類" || loaded.course.semester !== "2026-1") fail("課程、分類或學期沒有保存");

  openMode = "file";
  const imported = await evaluate(window, async () => {
    const choice = await window.courseCapture.media.choose();
    const course = await window.courseCapture.courses.create({ title: "匯入測試課程", language: "zh-TW" });
    const media = await window.courseCapture.courses.importMedia(course.id, choice.sourceId);
    return { course, media };
  });
  if (!imported.media || imported.media.mediaType !== "audio" || !imported.media.size || fs.existsSync(fixture)) fail("媒體沒有安全移入受管理媒體庫");
  const importedDetail = await evaluate(window, async (courseId) => window.courseCapture.courses.get(courseId), imported.course.id);
  if (importedDetail.media.length !== 1 || importedDetail.media[0].mediaType !== "audio") fail("匯入媒體沒有寫入資料庫");

  await evaluate(window, async (courseId) => window.courseCapture.courses.trash(courseId), imported.course.id);
  const trashed = await evaluate(window, async (courseId) => window.courseCapture.courses.get(courseId), imported.course.id);
  if (!trashed.course.deleted_at || !trashed.media[0].is_trash) fail("課程回收桶沒有標記並移入受管理媒體");
  await evaluate(window, async (courseId) => window.courseCapture.courses.restore(courseId), imported.course.id);
  const restored = await evaluate(window, async (courseId) => window.courseCapture.courses.get(courseId), imported.course.id);
  if (restored.course.deleted_at || restored.media[0].is_trash) fail("課程回收桶還原失敗");

  const databaseAfterImport = await evaluate(window, () => ({
    text: document.querySelector("[data-course-list]")?.textContent || "",
  }));
  if (!databaseAfterImport.text.includes("持久化測試課程")) fail("資料庫列表沒有顯示課程");

  await evaluate(window, async () => {
    await window.courseCapture.widget.update({ visible: true, recording: true, paused: false, elapsedMs: 3723000, title: "小工具測試課程" });
    await window.courseCapture.widget.show();
  });
  let widgetWindow;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    widgetWindow = require("electron").BrowserWindow.getAllWindows().find((candidate) => candidate !== window && !candidate.isDestroyed());
    if (widgetWindow && !widgetWindow.webContents.isLoadingMainFrame()) break;
    await wait(100);
  }
  if (!widgetWindow) fail("置頂錄影小工具沒有開啟");
  const widget = await evaluate(widgetWindow, () => ({
    time: document.querySelector("[data-time]")?.textContent,
    title: document.querySelector("[data-title]")?.textContent,
    pauseReady: Boolean(document.querySelector("[data-pause]")),
    stopReady: Boolean(document.querySelector("[data-stop]")),
  }));
  if (widget.time !== "01:02:03" || widget.title !== "小工具測試課程" || !widget.pauseReady || !widget.stopReady) fail(`錄影小工具狀態錯誤：${JSON.stringify(widget)}`);
  await evaluate(widgetWindow, () => window.courseCapture.widget.action("close"));

  console.log(JSON.stringify({ initial, initialDatabase, persisted: loaded.course.title, imported: imported.media.originalName, sourceMoved: !fs.existsSync(fixture), trashRestore: true, recovery: recovered.course.title, widget }));
  exitAfterTest(0);
}

run().catch((error) => {
  console.error(error.stack || error.message);
  if (app.isReady()) exitAfterTest(1);
  else process.exitCode = 1;
});
