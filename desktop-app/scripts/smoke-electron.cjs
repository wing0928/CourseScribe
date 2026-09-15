const { app } = require("electron");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const smokeRoot = path.join(os.tmpdir(), "course-capture-electron-smoke");
fs.mkdirSync(path.join(smokeRoot, "videos"), { recursive: true });
app.setPath("userData", smokeRoot);
app.setPath("videos", path.join(smokeRoot, "videos"));
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("disable-features", "VizDisplayCompositor");
app.disableHardwareAcceleration();
const { BrowserWindow } = require("electron");

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const fail = (message) => { throw new Error(message); };

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

async function run() {
  require("../main.cjs");
  await app.whenReady();
  const window = await waitForWindow();
  const initial = await evaluate(window, () => ({
    title: document.title,
    hasOldPicker: Boolean(document.querySelector("[data-picker]")),
    recordReady: Boolean(document.querySelector("[data-record]") && !document.querySelector("[data-record]").disabled),
    transcriptDisabled: document.querySelector("[data-transcribe]")?.disabled === true,
  }));
  if (initial.title !== "課間捕手") fail(`主畫面標題錯誤：${initial.title}`);
  if (initial.hasOldPicker) fail("舊的中央選擇視窗仍存在");
  if (!initial.recordReady) fail("開始錄製按鈕不可用");
  if (!initial.transcriptDisabled) fail("尚未錄影時，逐字稿按鈕應停用");

  await evaluate(window, () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    canvas.getContext("2d").fillRect(0, 0, canvas.width, canvas.height);
    const stream = canvas.captureStream(10);
    window.__COURSE_CAPTURE_TEST_MODE__ = true;
    window.__COURSE_CAPTURE_TEST_GET_DISPLAY_MEDIA__ = async () => stream;
    const title = document.querySelector("[data-course-title]");
    title.value = "__course-capture-smoke__";
    document.querySelector("[data-record]").click();
  });
  await wait(800);
  const recordingStarted = await evaluate(window, () => document.querySelector("[data-state]")?.textContent === "錄製中");
  if (!recordingStarted) fail("模擬錄製未啟動");

  await evaluate(window, () => document.querySelector("[data-record]").click());
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const done = await evaluate(window, () => document.querySelector("[data-transcribe]")?.disabled === false);
    if (done) break;
    await wait(100);
  }
  const recordingSaved = await evaluate(window, () => ({
    transcribeReady: document.querySelector("[data-transcribe]")?.disabled === false,
    exportReady: document.querySelector("[data-export]")?.disabled === false,
    status: document.querySelector("[data-status]")?.textContent || "",
  }));
  if (!recordingSaved.transcribeReady || !recordingSaved.exportReady) fail(`錄影未完成儲存：${recordingSaved.status}`);

  await evaluate(window, () => {
    window.__COURSE_CAPTURE_TEST_TRANSCRIBE__ = async () => ({
      text: "第一個概念說明。第二個概念補充。",
      segments: [{ time: 0, text: "第一個概念說明。" }, { time: 8, text: "第二個概念補充。" }],
    });
    document.querySelector("[data-transcribe]").click();
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const ready = await evaluate(window, () => document.querySelector("[data-notes-button]")?.disabled === false);
    if (ready) break;
    await wait(100);
  }
  const transcriptReady = await evaluate(window, () => ({
    notesEnabled: document.querySelector("[data-notes-button]")?.disabled === false,
    hasTranscript: document.querySelector("[data-transcript]")?.textContent.includes("第一個概念說明"),
  }));
  if (!transcriptReady.notesEnabled || !transcriptReady.hasTranscript) fail("逐字稿未呈現或課程重點按鈕未啟用");

  await evaluate(window, () => document.querySelector("[data-notes-button]").click());
  const notesReady = await evaluate(window, () => ({
    hasHeading: document.querySelector("[data-notes]")?.textContent.includes("本堂重點"),
    hasBullet: document.querySelector("[data-notes]")?.textContent.includes("第二個概念補充"),
    copyEnabled: document.querySelector("[data-copy]")?.disabled === false,
  }));
  if (!notesReady.hasHeading || !notesReady.hasBullet || !notesReady.copyEnabled) fail("課程筆記未完成整理");

  console.log(JSON.stringify({ initial, recordingSaved, transcriptReady, notesReady }));
  app.exit(0);
}

run().catch(async (error) => {
  console.error(error.stack || error.message);
  if (app.isReady()) app.exit(1);
  else process.exitCode = 1;
});
