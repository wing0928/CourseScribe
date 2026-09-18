const { app } = require("electron");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { dialog } = require("electron");
const { CourseDatabase } = require("../database.cjs");
const ffmpegPath = require("ffmpeg-static");
const { runFfmpeg } = require("../media-utils.cjs");
const { inspectRecordingAudio } = require("../recording-segments.cjs");

const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coursescribe-electron-smoke-"));
const fixture = path.join(smokeRoot, "lecture-audio.mp3");
fs.writeFileSync(fixture, Buffer.alloc(96, 7));
const recoveryStaging = path.join(smokeRoot, "staging");
fs.mkdirSync(recoveryStaging, { recursive: true });
const recoveryPath = path.join(recoveryStaging, "recovery.webm.part");
fs.writeFileSync(recoveryPath, Buffer.alloc(128, 9));
const recoveryDb = new CourseDatabase(path.join(smokeRoot, "coursescribe.sqlite"));
const recoveryCourse = recoveryDb.createCourse({ title: "中斷復原測試", source: "recording", language: "zh-TW" });
recoveryDb.saveNotes(recoveryCourse.id, { status: "ready", model: "qwen3:4b", json: {
  summary: "本課涵蓋：第一主題、第二主題。", sections: [
    { title: "第一主題", timestamp: "00:20", points: [{ text: "第一個重點", quote: "第一個重點的原文", timestamp: "00:20", status: "source_matched" }, { text: "補充公式 $F=ma$", quote: "第一個重點的原文", kind: "extension", timestamp: "00:20", status: "source_matched" }] },
    { title: "第二主題", timestamp: "03:40", points: ["第二個重點"] },
  ], confusions: [], reviewQuestions: ["如何比較兩個主題？"], takeaway: "保留全部主題。",
} });
recoveryDb.upsertMedia({ id: "recovery-media", courseId: recoveryCourse.id, filePath: recoveryPath, originalName: "recovery.webm", mimeType: "video/webm", mediaType: "video", extension: "webm", size: 128, processingStatus: "recording" });
recoveryDb.addSegments(recoveryCourse.id, "recovery-media", [{ startMs: 20000, endMs: 24000, text: "第一個重點的原文" }], "zh-TW");
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
function exitAfterTest(code) { setTimeout(() => process.exit(code), 300); app.exit(code); }

async function waitForWindow() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const window = require("electron").BrowserWindow.getAllWindows()[0];
    if (window && !window.isDestroyed() && !window.webContents.isLoadingMainFrame()) return window;
    await wait(100);
  }
  fail("主視窗未在 6 秒內完成載入");
}

async function evaluate(window, expression, ...args) {
  let timer;
  try {
    return await Promise.race([
      window.webContents.executeJavaScript(`(${expression})(${args.map((value) => JSON.stringify(value)).join(",")})`),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("畫面測試操作逾時")), 30000); }),
    ]);
  } finally { clearTimeout(timer); }
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
    hasReviewTabs: document.querySelectorAll("[data-review-tab]").length === 2,
    hasModelCancel: Boolean(document.querySelector("[data-cancel-model]")),
    hasWidgetBridge: Boolean(window.courseCapture.widget?.show && window.courseCapture.widget?.onAction),
  }));
  if (!initial.hasHome || !initial.hasDatabase || initial.oldPicker || !initial.recordReady || !initial.uploadReady || initial.homeHasTranscript || !initial.hasRecordingWidget || !initial.hasPauseControl || !initial.hasReviewTabs || !initial.hasModelCancel || !initial.hasWidgetBridge) fail(`首頁結構錯誤：${JSON.stringify(initial)}`);
  const homeReview = await evaluate(window, async (courseId) => {
    state.courseId = courseId;
    await refreshHomeNotes(courseId);
    const summary = document.querySelector("[data-home-notes]").textContent;
    document.querySelector('[data-review-tab="transcript"]').click();
    const transcript = document.querySelector("[data-home-transcript]").textContent;
    return { summary, transcript, summaryHidden: document.querySelector("[data-home-notes]").hidden, transcriptSelected: document.querySelector('[data-review-tab="transcript"]').getAttribute("aria-selected") };
  }, recoveryCourse.id);
  if (!homeReview.summary.includes("第一主題") || !homeReview.transcript.includes("第一個重點的原文") || !homeReview.summaryHidden || homeReview.transcriptSelected !== "true") fail(`首頁總結／逐字稿切換失敗：${JSON.stringify(homeReview)}`);
  await evaluate(window, () => document.querySelector('[data-review-tab="summary"]').click());

  await evaluate(window, () => document.querySelector("[data-view=database]").click());
  await wait(250);
  const initialDatabase = await evaluate(window, () => ({ hidden: document.querySelector("[data-view-panel=database]").hidden, hasSearch: Boolean(document.querySelector("[data-db-search]")) }));
  if (initialDatabase.hidden || !initialDatabase.hasSearch) fail("資料庫分頁未正常開啟");
  await evaluate(window, (courseId) => document.querySelector(`[data-course-id="${courseId}"]`).click(), recoveryCourse.id);
  await wait(250);
  const genericNotes = await evaluate(window, () => document.querySelector(".detail-note")?.textContent || "");
  if (!genericNotes.includes("第一主題") || !genericNotes.includes("第二主題") || genericNotes.includes("科學史人物")) fail("通用主題筆記沒有正確顯示");
  if (!genericNotes.includes("並非事實查核")) fail("筆記必須提醒逐字稿辨識錯誤的風險");
  if (!genericNotes.includes("原文吻合") || !genericNotes.includes("第一個重點的原文") || !genericNotes.includes("待核")) fail("來源引文與舊筆記待核狀態未正確顯示");
  const mathView = await evaluate(window, () => ({ rendered: Boolean(document.querySelector(".detail-note .katex")), extension: Boolean(document.querySelector(".detail-note .note-extension")), evidenceCollapsed: !document.querySelector(".detail-note .note-source")?.open }));
  if (!mathView.rendered || !mathView.extension || !mathView.evidenceCollapsed) fail(`公式排版或主題筆記樣式錯誤：${JSON.stringify(mathView)}`);
  const readableSize = await evaluate(window, () => {
    const sample = document.createElement("button");
    sample.className = "segment";
    sample.innerHTML = "<span>逐字稿</span>";
    document.body.append(sample);
    const result = { note: parseFloat(getComputedStyle(document.querySelector(".detail-note")).fontSize), transcript: parseFloat(getComputedStyle(sample.querySelector("span")).fontSize), quote: parseFloat(getComputedStyle(document.querySelector(".evidence-points blockquote")).fontSize) };
    sample.remove();
    return result;
  });
  if (readableSize.note < 14 || readableSize.transcript < 14 || readableSize.quote < 13) fail(`筆記或逐字稿文字仍太小：${JSON.stringify(readableSize)}`);
  if (genericNotes.includes("本課涵蓋：")) fail("舊版冗長標題清單不應佔據全課概覽");
  await evaluate(window, () => document.querySelector("[data-detail-back]").click());

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

  await evaluate(window, (courseId) => document.querySelector(`[data-course-id="${courseId}"]`).click(), created.id);
  await wait(250);
  const categoryEditor = await evaluate(window, () => Boolean(document.querySelector("[data-detail-category]")));
  if (!categoryEditor) fail("歷史課程詳情沒有分類編輯器");
  await evaluate(window, () => {
    const select = document.querySelector("[data-detail-category]");
    select.value = "__new__";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector("[data-detail-new-category-input]").value = "新增測試分類";
    document.querySelector("[data-detail-save]").click();
  });
  await wait(500);
  const recategorized = await evaluate(window, async (courseId) => window.courseCapture.courses.get(courseId), created.id);
  if (recategorized.course.categoryName !== "新增測試分類") fail("歷史課程分類未儲存");

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

  const clips = [440, 880].map((frequency, index) => ({ frequency, filePath: path.join(smokeRoot, `pause-resume-${index}.webm`) }));
  for (const clip of clips) await runFfmpeg(ffmpegPath, ["-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10", "-f", "lavfi", "-i", `sine=frequency=${clip.frequency}:sample_rate=48000`, "-t", "2", "-c:v", "libvpx-vp9", "-deadline", "realtime", "-b:v", "100k", "-c:a", "libopus", "-shortest", "-f", "webm", clip.filePath]);
  const recordingId = await evaluate(window, async () => {
    const course = await window.courseCapture.recording.create({ title: "暫停繼續測試", language: "zh-TW" });
    await window.courseCapture.recording.begin({ courseId: course.id, title: course.title, language: "zh-TW" });
    return course.id;
  });
  await evaluate(window, (id, bytes) => window.courseCapture.recording.videoChunk(id, bytes), recordingId, Array.from(fs.readFileSync(clips[0].filePath)));
  const pauseResult = await evaluate(window, (id) => window.courseCapture.recording.pause(id), recordingId);
  if (!pauseResult.audioOk) fail(`第一段錄影音軌不完整：${JSON.stringify(pauseResult)}`);
  await evaluate(window, (id) => window.courseCapture.recording.resume(id), recordingId);
  await evaluate(window, (id, bytes) => window.courseCapture.recording.videoChunk(id, bytes), recordingId, Array.from(fs.readFileSync(clips[1].filePath)));
  await evaluate(window, (id) => window.courseCapture.recording.pause(id), recordingId);
  await evaluate(window, (id) => window.courseCapture.recording.finish(id), recordingId);
  let recordedDetail;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    recordedDetail = await evaluate(window, (id) => window.courseCapture.courses.get(id), recordingId);
    if (recordedDetail?.media?.[0]?.processingStatus === "ready") break;
    await wait(100);
  }
  if (recordedDetail?.media?.[0]?.processingStatus !== "ready") fail("暫停繼續後影片未寫入媒體庫");
  const recordedFiles = fs.readdirSync(path.join(smokeRoot, "media-library", recordingId)).filter((name) => name.endsWith(".webm"));
  if (recordedFiles.length !== 1) fail(`合併後應只有一個影片：${JSON.stringify(recordedFiles)}`);
  const resumedHealth = await inspectRecordingAudio(ffmpegPath, path.join(smokeRoot, "media-library", recordingId, recordedFiles[0]));
  if (!resumedHealth.audioOk || resumedHealth.audioSeconds < 3.5) fail(`繼續錄影後音軌沒有延續：${JSON.stringify(resumedHealth)}`);
  console.log(`IPC 暫停／繼續驗證完成：${JSON.stringify(resumedHealth)}`);

  await evaluate(window, () => {
    window.__smokeCaptureCount = 0;
    window.__smokeCaptureContexts = [];
    navigator.mediaDevices.getDisplayMedia = async () => {
      window.__smokeCaptureCount += 1;
      const canvas = document.createElement("canvas");
      canvas.width = 160; canvas.height = 90;
      const paint = () => { const context = canvas.getContext("2d"); context.fillStyle = window.__smokeCaptureCount % 2 ? "#194a7f" : "#782f5c"; context.fillRect(0, 0, 160, 90); };
      paint();
      const timer = setInterval(paint, 100);
      const video = canvas.captureStream(12);
      const context = new AudioContext();
      const tone = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      tone.frequency.value = window.__smokeCaptureCount === 1 ? 440 : 880;
      tone.connect(destination); tone.start();
      window.__smokeCaptureContexts.push({ context, tone, canvas, timer });
      return new MediaStream([...video.getVideoTracks(), ...destination.stream.getAudioTracks()]);
    };
  });
  await evaluate(window, async () => {
    const sources = await window.courseCapture.capture.listSources();
    const screen = sources.find((source) => source.type === "screen");
    if (!screen || !await window.courseCapture.capture.selectSource(screen.id)) throw new Error("合成錄影測試無法選擇穩定的螢幕來源");
    state.selectedSourceId = screen.id;
  });
  console.log("已注入合成畫面與音訊來源");
  console.log(`開始介面錄影，來源=${JSON.stringify(await evaluate(window, () => state.selectedSourceId))}`);
  try {
    await evaluate(window, async () => { await startRecording(); if (!state.recording) throw new Error("介面未開始錄影"); state.recording.flushPcm = () => {}; });
  } catch (error) {
    console.log(`介面錄影逾時狀態：${JSON.stringify(await evaluate(window, () => ({ courseId: state.recording?.courseId, recorderState: state.recording?.recorder?.state, status: document.querySelector("[data-status]")?.textContent, captureCount: window.__smokeCaptureCount })).catch(() => null))}`);
    throw error;
  }
  console.log("介面錄影已開始");
  const uiRecordingId = await evaluate(window, () => state.recording.courseId);
  await wait(1300);
  await evaluate(window, async () => { await toggleRecordingPause("pause"); if (!state.recording.paused) throw new Error("介面未暫停錄影"); });
  console.log("介面錄影已暫停");
  await evaluate(window, async () => { await toggleRecordingPause("resume"); if (state.recording.paused) throw new Error("介面未繼續錄影"); state.recording.flushPcm = () => {}; });
  console.log("介面錄影已恢復");
  await wait(1300);
  await evaluate(window, async () => { await stopRecording(); if (state.recording) throw new Error("介面未停止錄影"); });
  let uiDetail;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    uiDetail = await evaluate(window, (id) => window.courseCapture.courses.get(id), uiRecordingId);
    if (uiDetail?.media?.[0]?.processingStatus === "ready") break;
    await wait(100);
  }
  if (uiDetail?.media?.[0]?.processingStatus !== "ready") fail("介面暫停繼續後影片未入庫");
  const uiCaptureCount = await evaluate(window, () => window.__smokeCaptureCount);
  if (uiCaptureCount !== 2) fail(`繼續錄影必須重新取得音訊串流：${uiCaptureCount}`);
  const uiFiles = fs.readdirSync(path.join(smokeRoot, "media-library", uiRecordingId)).filter((name) => name.endsWith(".webm"));
  const uiResumedHealth = await inspectRecordingAudio(ffmpegPath, path.join(smokeRoot, "media-library", uiRecordingId, uiFiles[0]));
  if (!uiResumedHealth.audioOk || uiResumedHealth.audioSeconds < 2) fail(`介面暫停繼續後音軌未延續：${JSON.stringify(uiResumedHealth)}`);

  console.log(JSON.stringify({ initial, initialDatabase, persisted: loaded.course.title, recategorized: recategorized.course.categoryName, imported: imported.media.originalName, sourceMoved: !fs.existsSync(fixture), trashRestore: true, recovery: recovered.course.title, widget, pauseResumeAudio: resumedHealth, uiPauseResumeAudio: uiResumedHealth }));
  exitAfterTest(0);
}

run().catch((error) => {
  console.error(error.stack || error.message);
  if (app.isReady()) exitAfterTest(1);
  else process.exitCode = 1;
});
