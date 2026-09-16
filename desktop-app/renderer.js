const $ = (selector) => document.querySelector(selector);
const els = {
  title: $("[data-course-title]"), language: $("[data-language]"), record: $("[data-record]"), upload: $("[data-upload]"),
  recordLabel: $("[data-record-label]"), recordIcon: $("[data-record-icon]"), state: $("[data-state]"),
  sourceInfo: $("[data-source-info]"), sourceName: $("[data-source-name]"), sourceMeta: $("[data-source-meta]"),
  transcript: $("[data-transcript]"), wordCount: $("[data-word-count]"), transcribe: $("[data-transcribe]"),
  export: $("[data-export]"), notes: $("[data-notes]"), notesButton: $("[data-notes-button]"), copy: $("[data-copy]"),
  status: $("[data-status]"), progressCard: $("[data-progress-card]"), progressStage: $("[data-progress-stage]"),
  progressCopy: $("[data-progress-copy]"), progressPercent: $("[data-progress-percent]"), progressBar: $("[data-progress-bar]"),
};
const state = {
  stream: null, recorder: null, chunks: [], recording: null,
  sourceId: "", sourceName: "", sourceExtension: "", sourceMimeType: "", sourceKind: "", sourceSize: 0,
  transcript: [], notesText: "", transcribing: false,
};

function cleanTitle() { return els.title.value.trim() || "未命名課程"; }
function clock(seconds) { return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`; }
function setStatus(text) { els.status.textContent = text; }
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, bytes || 0)} B`;
  const units = ["KB", "MB", "GB"]; let value = bytes; let unit = "B";
  for (const next of units) { if (value < 1024) break; value /= 1024; unit = next; }
  return `${value.toFixed(value >= 10 || unit === "KB" ? 1 : 2)} ${unit}`;
}
function setProgress(data) {
  els.progressCard.hidden = false;
  els.progressStage.textContent = data.stage === "model" ? "WHISPER MODEL" : data.stage === "audio" ? "AUDIO" : "TRANSCRIBE";
  els.progressCopy.textContent = data.detail || "正在處理";
  const progress = Number(data.progress);
  const hasProgress = Number.isFinite(progress);
  const safeProgress = hasProgress ? Math.min(100, Math.max(0, Math.round(progress))) : 0;
  els.progressPercent.textContent = hasProgress ? `${safeProgress}%` : "處理中";
  els.progressBar.style.width = `${hasProgress ? safeProgress : 8}%`;
}
function resetResults() {
  state.transcript = []; state.notesText = ""; state.transcribing = false; els.wordCount.textContent = "0 字";
  els.transcript.className = "empty";
  els.transcript.innerHTML = "<span>◎</span><b>來源準備好後開始轉錄</b><p>Whisper 會在這台電腦處理完整音訊；第一次需下載模型。</p>";
  els.notes.className = "empty";
  els.notes.innerHTML = "<span>✦</span><b>逐字稿完成後整理重點</b><p>將完整內容整理成重點、關鍵詞與一句話摘要。</p>";
  els.notesButton.disabled = true; els.copy.disabled = true;
}
function setSource({ blob = null, sourceId = "", name = "課程錄音", extension = "", mimeType = "", kind = "upload", size = 0 } = {}) {
  state.recording = blob; state.sourceId = String(sourceId || ""); state.sourceName = String(name || "課程錄音");
  state.sourceExtension = String(extension || "").replace(/^\./, "").toLowerCase(); state.sourceMimeType = String(mimeType || "");
  state.sourceKind = kind; state.sourceSize = Number.isFinite(size) && size >= 0 ? size : blob?.size || 0;
  els.sourceInfo.hidden = false; els.sourceName.textContent = state.sourceName;
  els.sourceMeta.textContent = `${kind === "upload" ? "上傳檔案" : "本機錄製"} · ${formatBytes(state.sourceSize)}`;
  els.transcribe.disabled = false; els.export.disabled = false; els.progressCard.hidden = true; resetResults();
}
function clearSource() {
  state.recording = null; state.sourceId = ""; state.sourceName = ""; state.sourceExtension = ""; state.sourceMimeType = "";
  state.sourceKind = ""; state.sourceSize = 0; els.sourceInfo.hidden = true; els.transcribe.disabled = true; els.export.disabled = true; els.progressCard.hidden = true; resetResults();
}
function showTranscript() {
  if (!state.transcript.length) {
    if (state.transcribing) {
      els.transcript.className = "transcript transcript-waiting";
      els.transcript.innerHTML = "<span>◌</span><b>正在等待第一段逐字稿…</b><p>Whisper 完成一段音訊後會立即顯示在這裡。</p>";
    }
    els.notesButton.disabled = true;
    return;
  }
  els.transcript.className = "transcript";
  els.transcript.innerHTML = state.transcript.map((item) => `<div><time>${clock(item.time)}</time><p>${escapeHtml(item.text)}</p></div>`).join("");
  els.wordCount.textContent = `${state.transcript.reduce((sum, item) => sum + item.text.replace(/\s/g, "").length, 0)} 字`;
  els.notesButton.disabled = state.transcribing;
  els.transcript.scrollTop = els.transcript.scrollHeight;
}
function appendTranscript(segments) {
  if (!Array.isArray(segments)) return;
  for (const item of segments) {
    const text = String(item?.text || "").trim();
    if (!text) continue;
    const time = Number.isFinite(Number(item?.time)) ? Number(item.time) : 0;
    const duplicate = state.transcript.some((existing) => existing.text === text && Math.abs(Number(existing.time || 0) - time) < 5);
    if (!duplicate) state.transcript.push({ time, text });
  }
  state.transcript.sort((left, right) => left.time - right.time);
  showTranscript();
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
    setStatus("正在準備錄製整個桌面與 Windows 系統聲音…"); await chooseSource();
    const getDisplayMedia = window.__COURSE_CAPTURE_TEST_GET_DISPLAY_MEDIA__ || ((constraints) => navigator.mediaDevices.getDisplayMedia(constraints));
    const stream = await getDisplayMedia({ video: true, audio: true });
    clearSource(); state.stream = stream; state.chunks = [];
    state.recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus") ? "video/webm;codecs=vp9,opus" : "video/webm" });
    state.recorder.ondataavailable = (event) => { if (event.data.size) state.chunks.push(event.data); };
    state.recorder.onstop = finishRecording; state.recorder.start();
    const [track] = stream.getVideoTracks(); if (track) track.onended = stopRecording;
    const audioReady = stream.getAudioTracks().length > 0;
    els.recordLabel.textContent = "停止錄製"; els.recordIcon.textContent = "■"; els.record.classList.add("active"); els.state.textContent = "錄製中";
    setStatus(audioReady ? "正在錄製課程；逐字稿會在結束後建立。" : "錄製已開始，但沒有取得系統聲音；結束後可能沒有可用逐字稿。");
    window.courseCapture.log(`錄製已開始，${audioReady ? "已取得系統聲音" : "未取得系統聲音"}`);
  } catch (error) { window.courseCapture.log(`錄製啟動失敗: ${error.message || error}`); setStatus(`沒有取得課程畫面或聲音：${error.message || "尚未開始錄製"}`); }
}
function stopRecording() {
  if (state.recorder?.state === "recording") state.recorder.stop();
  if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
  window.courseCapture.log("錄製已停止，正在整理錄影資料");
  els.recordLabel.textContent = "開始錄製"; els.recordIcon.textContent = "●"; els.record.classList.remove("active"); els.state.textContent = "錄製完成";
}
async function finishRecording() {
  try {
    state.recording = new Blob(state.chunks, { type: "video/webm" });
    if (!state.recording.size) throw new Error("沒有取得錄製內容，請確認螢幕擷取權限。繼續錄製前請重新開始。");
    const saved = await window.courseCapture.saveRecording({ bytes: await state.recording.arrayBuffer(), courseTitle: cleanTitle() });
    setSource({ blob: state.recording, name: saved?.name || "課程錄影.webm", extension: "webm", mimeType: "video/webm", kind: "recording", size: state.recording.size });
    setStatus("錄影已保留在電腦的影片資料夾，可開始 Whisper 課後轉錄。");
  } catch (error) { window.courseCapture.log(`錄影儲存失敗: ${error.message || error}`); setStatus(`錄影儲存失敗：${error.message || "請確認影片資料夾可寫入"}`); }
}
async function uploadMedia() {
  if (state.recorder?.state === "recording") { setStatus("請先停止目前錄製，再上傳檔案。"); return; }
  els.upload.disabled = true; setStatus("正在開啟檔案選擇器…");
  try {
    const chooseMediaFile = window.__COURSE_CAPTURE_TEST_CHOOSE_MEDIA__ || window.courseCapture.chooseMediaFile;
    const result = await chooseMediaFile();
    if (!result || result.canceled) { setStatus("已取消選擇檔案。"); return; }
    if (!result.id) throw new Error("檔案來源建立失敗，請重新選擇。");
    const name = String(result.name || "上傳課程檔");
    if (els.title.value.trim() === "" || els.title.value.trim() === "未命名課程") els.title.value = name.replace(/\.[^.]+$/, "");
    setSource({ sourceId: result.id, name, extension: result.extension, mimeType: result.mimeType, kind: "upload", size: Number(result.size) || 0 });
    els.state.textContent = "檔案已載入"; setStatus(`已載入「${name}」，可以使用 Whisper 轉錄。`); window.courseCapture.log(`上傳檔案已載入，${name} (${result.size || 0} bytes)`);
  } catch (error) { window.courseCapture.log(`上傳檔案失敗: ${error.message || error}`); setStatus(`上傳檔案失敗：${error.message || "請選擇可讀取的錄音或影音檔"}`); }
  finally { els.upload.disabled = false; }
}
async function transcribe() {
  if (!state.recording && !state.sourceId) return;
  state.transcribing = true; state.transcript = []; state.notesText = ""; els.notesButton.disabled = true; els.copy.disabled = true;
  els.transcribe.disabled = true; setProgress({ stage: "audio", detail: `正在準備${state.sourceKind === "upload" ? "上傳檔案" : "完整課程錄影"}（0%）`, progress: 0 }); showTranscript(); setStatus("Whisper 正在轉錄，完成一段就會立即顯示在逐字稿區。");
  try {
    const transcribeRecording = window.__COURSE_CAPTURE_TEST_TRANSCRIBE__ || window.courseCapture.transcribeRecording;
    const payload = { language: els.language.value };
    if (state.sourceId) payload.sourceId = state.sourceId;
    else { payload.bytes = await state.recording.arrayBuffer(); payload.extension = state.sourceExtension || "webm"; payload.fileName = state.sourceName; payload.mimeType = state.sourceMimeType; }
    const result = await transcribeRecording(payload);
    state.transcript = result.segments?.length ? result.segments : result.text ? [{ time: 0, text: result.text }] : [];
    state.transcribing = false; showTranscript(); setProgress({ stage: "transcribe", detail: "轉錄完成（100%）", progress: 100 }); setStatus(state.transcript.length ? "逐字稿完成，可以整理課程重點。" : "Whisper 沒有辨識到可用文字，請確認來源包含清楚的課程聲音。");
  } catch (error) { state.transcribing = false; showTranscript(); els.progressCard.hidden = true; els.transcribe.disabled = false; setStatus(`轉錄失敗：${error.message || "請再試一次"}`); }
}
async function exportSource() {
  if (!state.recording && !state.sourceId) return;
  try {
    const result = state.sourceId
      ? await window.courseCapture.exportImportedMedia({ sourceId: state.sourceId, courseTitle: cleanTitle() })
      : await window.courseCapture.exportRecording({ bytes: await state.recording.arrayBuffer(), courseTitle: cleanTitle() });
    setStatus(result.canceled ? "已取消匯出。" : "來源檔已匯出。");
  } catch (error) { setStatus(`匯出失敗：${error.message || "請再試一次"}`); }
}
function getNoteUnits() { return state.transcript.flatMap((item) => String(item.text || "").split(/[。！？!?；;]+/).map((part) => part.trim()).filter(Boolean)); }
function selectNoteUnits(units) {
  const unique = units.filter((unit, index) => index === 0 || unit !== units[index - 1]);
  const informative = unique.filter((unit) => unit.replace(/[\s，、,]/g, "").length >= 8); const pool = informative.length >= 3 ? informative : unique;
  if (pool.length <= 5) return pool;
  return [...new Set(Array.from({ length: 5 }, (_item, index) => pool[Math.round(index * (pool.length - 1) / 4)]))];
}
function getKeywords(text) {
  const stopWords = new Set(["這篇", "基本上", "可能", "其實", "裡面", "也許", "中間", "所以", "不管", "怎麼樣", "一些", "非常", "重要", "叫做", "分別", "它是", "可以", "就是", "以及", "然後", "這個", "那個", "也有", "其實是", "不管怎麼", "據說是", "他的", "它的", "大概", "包含", "而且", "還有", "但是", "只是", "這些", "那些", "百分之百", "大概包含", "寫進去", "成為", "進去", "據說", "東西", "这篇", "基本上", "其实", "里面", "也许", "中间", "所以", "不管", "怎么样", "一些", "非常", "重要", "叫做", "分别", "它是", "可以", "就是", "以及", "然后", "这个", "那个", "也有", "其实是", "不管怎么", "据说是", "他的", "它的", "大概", "包含", "而且", "还有", "但是", "只是", "这些", "那些", "百分之百", "大概包含", "写进去", "成为", "进去", "据说", "东西"]);
  const tokens = typeof Intl.Segmenter === "function" ? [...new Intl.Segmenter("zh", { granularity: "word" }).segment(text)].map((item) => item.segment) : text.match(/[A-Za-z]{4,}|[\u4e00-\u9fff]{2,6}/g) || [];
  const tally = new Map(); tokens.map((word) => word.trim()).filter((word) => word.length >= 2 && !stopWords.has(word) && !/^[，。！？、；：,.!?\d]+$/.test(word)).forEach((word) => tally.set(word, (tally.get(word) || 0) + 1));
  return [...tally.entries()].sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length)).slice(0, 6).map(([word]) => word);
}
function makeNotes() {
  const text = state.transcript.map((item) => item.text).join(" "); const bullets = selectNoteUnits(getNoteUnits()); const keywords = getKeywords(text);
  els.notes.className = "notes-content"; els.notes.innerHTML = `<h3>本堂重點</h3><ul>${bullets.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul><h3>一句話帶走</h3><p>${escapeHtml(bullets.slice(0, 2).join("；") || "完成轉錄後再整理。")}</p><h3>關鍵詞</h3><div class="tags">${keywords.map((word) => `<span>${escapeHtml(word)}</span>`).join("")}</div>`;
  state.notesText = `${cleanTitle()}\n\n本堂重點\n${bullets.map((item) => `• ${item}`).join("\n")}\n\n一句話帶走\n• ${bullets.slice(0, 2).join("；")}\n\n關鍵詞\n${keywords.join(" · ")}`;
  els.copy.disabled = false; setStatus("課程筆記已整理完成。"); window.courseCapture.log(`課程筆記已整理，${bullets.length} 個重點，${keywords.length} 個關鍵詞`);
}
els.record.addEventListener("click", () => state.recorder?.state === "recording" ? stopRecording() : startRecording());
els.upload.addEventListener("click", uploadMedia); els.transcribe.addEventListener("click", transcribe); els.export.addEventListener("click", exportSource);
els.notesButton.addEventListener("click", makeNotes); els.copy.addEventListener("click", async () => { await navigator.clipboard.writeText(state.notesText); setStatus("筆記已複製到剪貼簿。"); });
window.courseCapture.onProgress(setProgress);
window.courseCapture.onTranscript((data) => {
  if (!state.transcribing) return;
  appendTranscript(data?.segments);
  if (data?.progress != null) setProgress({ stage: "transcribe", detail: `已完成 ${data.progress}%${data.done ? "，正在整理逐字稿" : ""}`, progress: data.progress });
});
window.__COURSE_CAPTURE_TEST_PUSH_TRANSCRIPT__ = appendTranscript;
window.__COURSE_CAPTURE_TEST_SET_PROGRESS__ = setProgress;
