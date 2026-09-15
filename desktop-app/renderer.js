const $ = (selector) => document.querySelector(selector);
const els = { title: $("[data-course-title]"), language: $("[data-language]"), record: $("[data-record]"), recordLabel: $("[data-record-label]"), recordIcon: $("[data-record-icon]"), state: $("[data-state]"), transcript: $("[data-transcript]"), wordCount: $("[data-word-count]"), transcribe: $("[data-transcribe]"), export: $("[data-export]"), notes: $("[data-notes]"), notesButton: $("[data-notes-button]"), copy: $("[data-copy]"), status: $("[data-status]"), progressCard: $("[data-progress-card]"), progressStage: $("[data-progress-stage]"), progressCopy: $("[data-progress-copy]"), progressBar: $("[data-progress-bar]") };
const state = { stream: null, recorder: null, chunks: [], recording: null, transcript: [], notesText: "" };

function cleanTitle() { return els.title.value.trim() || "未命名課程"; }
function clock(seconds) { return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`; }
function setStatus(text) { els.status.textContent = text; }
function setProgress(data) { els.progressCard.hidden = false; els.progressStage.textContent = data.stage === "model" ? "WHISPER MODEL" : data.stage === "audio" ? "AUDIO" : "TRANSCRIBE"; els.progressCopy.textContent = data.detail || "正在處理"; els.progressBar.style.width = data.progress == null ? "18%" : `${Math.max(4, data.progress)}%`; }
function showTranscript() {
  if (!state.transcript.length) return;
  els.transcript.className = "transcript";
  els.transcript.innerHTML = state.transcript.map((item) => `<div><time>${clock(item.time)}</time><p>${escapeHtml(item.text)}</p></div>`).join("");
  els.wordCount.textContent = `${state.transcript.reduce((sum, item) => sum + item.text.replace(/\s/g, "").length, 0)} 字`;
  els.notesButton.disabled = false;
}
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[c]); }
async function chooseSource() {
  if (window.__COURSE_CAPTURE_TEST_MODE__) return true;
  const selected = await window.courseCapture.selectDesktopSource();
  if (!selected) throw new Error("找不到可錄製的桌面來源，請重新開啟應用程式後再試一次。");
  return true;
}
async function startRecording() {
  try {
    setStatus("正在準備錄製整個桌面與 Windows 系統聲音…");
    await chooseSource();
    const getDisplayMedia = window.__COURSE_CAPTURE_TEST_GET_DISPLAY_MEDIA__ || ((constraints) => navigator.mediaDevices.getDisplayMedia(constraints));
    state.stream = await getDisplayMedia({ video: true, audio: true });
    state.chunks = [];
    state.recorder = new MediaRecorder(state.stream, { mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus") ? "video/webm;codecs=vp9,opus" : "video/webm" });
    state.recorder.ondataavailable = (event) => { if (event.data.size) state.chunks.push(event.data); };
    state.recorder.onstop = finishRecording;
    state.recorder.start();
    const [track] = state.stream.getVideoTracks(); if (track) track.onended = stopRecording;
    const audioReady = state.stream.getAudioTracks().length > 0;
    els.recordLabel.textContent = "停止錄製"; els.recordIcon.textContent = "■"; els.record.classList.add("active"); els.state.textContent = "錄製中"; setStatus(audioReady ? "正在錄製課程；逐字稿會在結束後建立。" : "錄製已開始，但沒有取得系統聲音；結束後可能沒有可用逐字稿。");
    window.courseCapture.log(`錄製已開始，${audioReady ? "已取得系統聲音" : "未取得系統聲音"}`);
  } catch (error) { window.courseCapture.log(`錄製啟動失敗: ${error.message || error}`); setStatus(`沒有取得課程畫面或聲音：${error.message || "尚未開始錄製"}`); }
}
function stopRecording() { if (state.recorder?.state === "recording") state.recorder.stop(); if (state.stream) state.stream.getTracks().forEach((track) => track.stop()); window.courseCapture.log("錄製已停止，正在整理錄影資料"); els.recordLabel.textContent = "開始錄製"; els.recordIcon.textContent = "●"; els.record.classList.remove("active"); els.state.textContent = "錄製完成"; }
async function finishRecording() {
  try {
    state.recording = new Blob(state.chunks, { type: "video/webm" });
    const bytes = await state.recording.arrayBuffer();
    await window.courseCapture.saveRecording({ bytes, courseTitle: cleanTitle() });
    els.transcribe.disabled = false; els.export.disabled = false; setStatus("錄影已保留在電腦的影片資料夾，可開始 Whisper 課後轉錄。");
  } catch (error) { window.courseCapture.log(`錄影儲存失敗: ${error.message || error}`); setStatus(`錄影儲存失敗：${error.message || "請確認影片資料夾可寫入"}`); }
}
async function transcribe() {
  if (!state.recording) return;
  els.transcribe.disabled = true; setProgress({ stage: "audio", detail: "正在準備完整課程錄影" }); setStatus("Whisper 正在處理完整課程，請保持應用程式開啟。");
  try {
    const transcribeRecording = window.__COURSE_CAPTURE_TEST_TRANSCRIBE__ || window.courseCapture.transcribeRecording;
    const result = await transcribeRecording({ bytes: await state.recording.arrayBuffer(), language: els.language.value });
    state.transcript = result.segments?.length ? result.segments : result.text ? [{ time: 0, text: result.text }] : [];
    showTranscript(); els.progressCard.hidden = true; setStatus(state.transcript.length ? "逐字稿完成，可以整理課程重點。" : "Whisper 沒有辨識到可用文字，請確認錄製時有分享課程聲音。");
  } catch (error) { els.progressCard.hidden = true; els.transcribe.disabled = false; setStatus(`轉錄失敗：${error.message || "請再試一次"}`); }
}
function getNoteUnits() {
  const units = state.transcript.flatMap((item) => String(item.text || "").split(/[。！？!?；;]+/).map((part) => part.trim()).filter(Boolean));
  return units.length > 1 ? units : units[0] ? [units[0]] : [];
}
function selectNoteUnits(units) {
  const unique = units.filter((unit, index) => index === 0 || unit !== units[index - 1]);
  const informative = unique.filter((unit) => unit.replace(/[\s，、,]/g, "").length >= 8);
  const pool = informative.length >= 3 ? informative : unique;
  if (pool.length <= 5) return pool;
  return [...new Set(Array.from({ length: 5 }, (_item, index) => pool[Math.round(index * (pool.length - 1) / 4)]))];
}
function getKeywords(text) {
  const stopWords = new Set(["這篇", "基本上", "可能", "其實", "裡面", "也許", "中間", "所以", "不管", "怎麼樣", "一些", "非常", "重要", "叫做", "分別", "它是", "可以", "就是", "以及", "然後", "這個", "那個", "也有", "其實是", "不管怎麼", "據說是", "他的", "它的", "大概", "包含", "而且", "還有", "但是", "只是", "這些", "那些", "百分之百", "大概包含", "寫進去", "成為", "進去", "據說", "東西", "这篇", "基本上", "其实", "里面", "也许", "中间", "所以", "不管", "怎么样", "一些", "非常", "重要", "叫做", "分别", "它是", "可以", "就是", "以及", "然后", "这个", "那个", "也有", "其实是", "不管怎么", "据说是", "他的", "它的", "大概", "包含", "而且", "还有", "但是", "只是", "这些", "那些", "百分之百", "大概包含", "写进去", "成为", "进去", "据说", "东西"]);
  const tokens = typeof Intl.Segmenter === "function" ? [...new Intl.Segmenter("zh", { granularity: "word" }).segment(text)].map((item) => item.segment) : text.match(/[A-Za-z]{4,}|[\u4e00-\u9fff]{2,6}/g) || [];
  const tally = new Map();
  tokens.map((word) => word.trim()).filter((word) => word.length >= 2 && !stopWords.has(word) && !/^[，。！？、；：,.!?\d]+$/.test(word)).forEach((word) => tally.set(word, (tally.get(word) || 0) + 1));
  return [...tally.entries()].sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length)).slice(0, 6).map(([word]) => word);
}
function makeNotes() {
  const text = state.transcript.map((item) => item.text).join(" "); const bullets = selectNoteUnits(getNoteUnits()); const keywords = getKeywords(text);
  els.notes.className = "notes-content"; els.notes.innerHTML = `<h3>本堂重點</h3><ul>${bullets.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul><h3>一句話帶走</h3><p>${escapeHtml(bullets.slice(0, 2).join("；") || "完成轉錄後再整理。")}</p><h3>關鍵詞</h3><div class="tags">${keywords.map((word) => `<span>${escapeHtml(word)}</span>`).join("")}</div>`;
  state.notesText = `${cleanTitle()}\n\n本堂重點\n${bullets.map((item) => `• ${item}`).join("\n")}\n\n一句話帶走\n• ${bullets.slice(0, 2).join("；")}\n\n關鍵詞\n${keywords.join(" · ")}`; els.copy.disabled = false; setStatus("課程筆記已整理完成。"); window.courseCapture.log(`課程筆記已整理，${bullets.length} 個重點，${keywords.length} 個關鍵詞`);
}
els.record.addEventListener("click", () => state.recorder?.state === "recording" ? stopRecording() : startRecording());
els.transcribe.addEventListener("click", transcribe); els.export.addEventListener("click", async () => { if (!state.recording) return; const result = await window.courseCapture.exportRecording({ bytes: await state.recording.arrayBuffer(), courseTitle: cleanTitle() }); if (!result.canceled) setStatus("錄影已匯出。"); });
els.notesButton.addEventListener("click", makeNotes); els.copy.addEventListener("click", async () => { await navigator.clipboard.writeText(state.notesText); setStatus("筆記已複製到剪貼簿。"); }); window.courseCapture.onProgress(setProgress);
