const { app } = require("electron");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "course-capture-electron-smoke-"));
const videosRoot = path.join(smokeRoot, "videos");
const importedFixture = path.join(smokeRoot, "lecture-audio.mp3");
fs.mkdirSync(videosRoot, { recursive: true });
fs.writeFileSync(importedFixture, Buffer.alloc(32, 7));
app.setPath("userData", smokeRoot);
app.setPath("videos", videosRoot);
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("disable-features", "VizDisplayCompositor");
app.disableHardwareAcceleration();
const { BrowserWindow, dialog } = require("electron");

let openDialogMode = "cancel";
let exportCount = 0;
const exportedFiles = [];
dialog.showOpenDialog = async (_window, options) => {
  if (options?.title !== "選擇錄音或影音檔") throw new Error(`非預期的開檔視窗：${options?.title || ""}`);
  return openDialogMode === "cancel" ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [importedFixture] };
};
dialog.showSaveDialog = async (_window, options) => {
  const extension = path.extname(options?.defaultPath || "") || ".webm";
  const filePath = path.join(smokeRoot, `export-${++exportCount}${extension}`);
  exportedFiles.push(filePath);
  return { canceled: false, filePath };
};

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const fail = (message) => { throw new Error(message); };
function exitAfterTest(code) {
  app.exit(code);
  setTimeout(() => process.exit(code), 250).unref();
}

async function waitForWindow() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const window = BrowserWindow.getAllWindows()[0];
    if (window && !window.isDestroyed() && !window.webContents.isLoadingMainFrame()) return window;
    await wait(100);
  }
  return fail("主視窗未在 5 秒內完成載入");
}

async function evaluate(window, expression) {
  return window.webContents.executeJavaScript(`(${expression})()`);
}

async function waitFor(window, expression, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await evaluate(window, expression)) return;
    await wait(100);
  }
  fail(message);
}

async function run() {
  require("../main.cjs");
  await app.whenReady();
  const window = await waitForWindow();
  const initial = await evaluate(window, () => ({
    title: document.title,
    hasOldPicker: Boolean(document.querySelector("[data-picker]")),
    recordReady: Boolean(document.querySelector("[data-record]") && !document.querySelector("[data-record]").disabled),
    uploadReady: Boolean(document.querySelector("[data-upload]")),
    transcriptDisabled: document.querySelector("[data-transcribe]")?.disabled === true,
  }));
  if (initial.title !== "課間捕手") fail(`主畫面標題錯誤：${initial.title}`);
  if (initial.hasOldPicker) fail("舊的中央選擇視窗仍存在");
  if (!initial.recordReady) fail("開始錄製按鈕不可用");
  if (!initial.uploadReady) fail("上傳錄音／影音按鈕不存在");
  if (!initial.transcriptDisabled) fail("尚未錄影時，逐字稿按鈕應停用");

  await evaluate(window, () => document.querySelector("[data-upload]").click());
  await waitFor(window, () => document.querySelector("[data-status]")?.textContent.includes("取消"), "取消上傳沒有安全返回");
  const uploadCanceled = await evaluate(window, () => ({
    sourceHidden: document.querySelector("[data-source-info]")?.hidden === true,
    transcribeDisabled: document.querySelector("[data-transcribe]")?.disabled === true,
    status: document.querySelector("[data-status]")?.textContent || "",
  }));
  if (!uploadCanceled.sourceHidden || !uploadCanceled.transcribeDisabled) fail("取消上傳改變了目前課程來源");

  openDialogMode = "file";
  await evaluate(window, () => document.querySelector("[data-upload]").click());
  await waitFor(window, () => document.querySelector("[data-transcribe]")?.disabled === false, "上傳檔案後逐字稿按鈕未啟用");
  const uploaded = await evaluate(window, () => ({
    sourceVisible: document.querySelector("[data-source-info]")?.hidden === false,
    sourceText: document.querySelector("[data-source-info]")?.textContent || "",
    transcribeReady: document.querySelector("[data-transcribe]")?.disabled === false,
    exportReady: document.querySelector("[data-export]")?.disabled === false,
  }));
  if (!uploaded.sourceVisible || !uploaded.sourceText.includes("lecture-audio.mp3") || uploaded.sourceText.includes("course-capture-electron-smoke") || !uploaded.transcribeReady || !uploaded.exportReady) {
    fail("上傳音訊後來源資訊、路徑隱私或按鈕狀態錯誤");
  }

  await evaluate(window, () => document.querySelector("[data-export]").click());
  for (let attempt = 0; attempt < 50 && (!exportedFiles[0] || !fs.existsSync(exportedFiles[0])); attempt += 1) await wait(100);
  if (!fs.existsSync(exportedFiles[0]) || fs.statSync(exportedFiles[0]).size !== 32) fail("上傳來源無法以主程序安全匯出");

  await evaluate(window, () => {
    window.__COURSE_CAPTURE_TEST_TRANSCRIBE__ = async (payload) => {
      window.__COURSE_CAPTURE_TEST_UPLOAD_PAYLOAD__ = { sourceId: payload.sourceId || "", hasBytes: Boolean(payload.bytes), extension: payload.extension || "" };
      return { text: "上傳音訊測試。", segments: [{ time: 0, text: "上傳音訊測試。" }] };
    };
    document.querySelector("[data-transcribe]").click();
  });
  await waitFor(window, () => document.querySelector("[data-notes-button]")?.disabled === false, "上傳音訊轉錄未完成");
  const uploadTranscript = await evaluate(window, () => ({
    payload: window.__COURSE_CAPTURE_TEST_UPLOAD_PAYLOAD__,
    transcriptVisible: document.querySelector("[data-transcript]")?.textContent.includes("上傳音訊測試"),
  }));
  if (!uploadTranscript.payload?.sourceId || uploadTranscript.payload.hasBytes || uploadTranscript.payload.extension || !uploadTranscript.transcriptVisible) {
    fail("上傳音訊沒有以不含檔案內容的安全來源代號送入轉錄流程");
  }

  await evaluate(window, () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    canvas.getContext("2d").fillRect(0, 0, canvas.width, canvas.height);
    const stream = canvas.captureStream(10);
    window.__COURSE_CAPTURE_TEST_MODE__ = true;
    window.__COURSE_CAPTURE_TEST_GET_DISPLAY_MEDIA__ = async () => stream;
    document.querySelector("[data-course-title]").value = "__course-capture-smoke__";
    document.querySelector("[data-record]").click();
  });
  await waitFor(window, () => document.querySelector("[data-state]")?.textContent === "錄製中", "模擬錄製未啟動");

  await evaluate(window, () => document.querySelector("[data-record]").click());
  await waitFor(window, () => document.querySelector("[data-transcribe]")?.disabled === false, "錄影未完成儲存");
  const recordingSaved = await evaluate(window, () => ({
    transcribeReady: document.querySelector("[data-transcribe]")?.disabled === false,
    exportReady: document.querySelector("[data-export]")?.disabled === false,
    sourceText: document.querySelector("[data-source-info]")?.textContent || "",
    status: document.querySelector("[data-status]")?.textContent || "",
  }));
  if (!recordingSaved.transcribeReady || !recordingSaved.exportReady || !recordingSaved.sourceText.includes("本機錄製")) fail(`錄影未完成儲存：${recordingSaved.status}`);

  await evaluate(window, () => document.querySelector("[data-export]").click());
  for (let attempt = 0; attempt < 50 && (!exportedFiles[1] || !fs.existsSync(exportedFiles[1])); attempt += 1) await wait(100);
  if (!fs.existsSync(exportedFiles[1]) || fs.statSync(exportedFiles[1]).size <= 0) fail("既有錄影無法匯出");

  await evaluate(window, () => {
    window.__COURSE_CAPTURE_TEST_TRANSCRIBE__ = async (payload) => {
      window.__COURSE_CAPTURE_TEST_RECORDING_PAYLOAD__ = { sourceId: payload.sourceId || "", hasBytes: Boolean(payload.bytes), extension: payload.extension || "" };
      return { text: "第一個概念說明。第二個概念補充。", segments: [{ time: 0, text: "第一個概念說明。" }, { time: 8, text: "第二個概念補充。" }] };
    };
    document.querySelector("[data-transcribe]").click();
  });
  await waitFor(window, () => document.querySelector("[data-notes-button]")?.disabled === false, "錄影逐字稿未完成");
  const transcriptReady = await evaluate(window, () => ({
    payload: window.__COURSE_CAPTURE_TEST_RECORDING_PAYLOAD__,
    notesEnabled: document.querySelector("[data-notes-button]")?.disabled === false,
    hasTranscript: document.querySelector("[data-transcript]")?.textContent.includes("第一個概念說明"),
  }));
  if (transcriptReady.payload?.sourceId || !transcriptReady.payload?.hasBytes || transcriptReady.payload?.extension !== "webm" || !transcriptReady.notesEnabled || !transcriptReady.hasTranscript) {
    fail("既有錄影沒有維持 WebM 位元資料轉錄流程");
  }

  await evaluate(window, () => document.querySelector("[data-notes-button]").click());
  const notesReady = await evaluate(window, () => ({
    hasHeading: document.querySelector("[data-notes]")?.textContent.includes("本堂重點"),
    hasBullet: document.querySelector("[data-notes]")?.textContent.includes("第二個概念補充"),
    copyEnabled: document.querySelector("[data-copy]")?.disabled === false,
  }));
  if (!notesReady.hasHeading || !notesReady.hasBullet || !notesReady.copyEnabled) fail("課程筆記未完成整理");

  console.log(JSON.stringify({ initial, uploadCanceled, uploaded, uploadTranscript, recordingSaved, transcriptReady, notesReady, exportedFiles }));
  exitAfterTest(0);
}

run().catch(async (error) => {
  console.error(error.stack || error.message);
  if (app.isReady()) exitAfterTest(1);
  else process.exitCode = 1;
});
