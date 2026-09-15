const $ = (selector) => document.querySelector(selector);
const els = { title: $("[data-course-title]"), language: $("[data-language]"), record: $("[data-record]"), recordLabel: $("[data-record-label]"), recordIcon: $("[data-record-icon]"), state: $("[data-state]"), transcript: $("[data-transcript]"), wordCount: $("[data-word-count]"), transcribe: $("[data-transcribe]"), export: $("[data-export]"), notes: $("[data-notes]"), notesButton: $("[data-notes-button]"), copy: $("[data-copy]"), status: $("[data-status]"), progressCard: $("[data-progress-card]"), progressStage: $("[data-progress-stage]"), progressCopy: $("[data-progress-copy]"), progressBar: $("[data-progress-bar]"), picker: $("[data-picker]"), sourceList: $("[data-source-list]"), pickerClose: $("[data-picker-close]") };
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
  const selected = await window.courseCapture.selectDesktopSource();
  if (!selected) throw new Error("找不到可錄製的桌面來源，請重新開啟應用程式後再試一次。");
  return true;
}
async function startRecording() {
  try {
    setStatus("正在準備錄製整個桌面與 Windows 系統聲音…");
    await chooseSource();
    state.stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    state.chunks = [];
    state.recorder = new MediaRecorder(state.stream, { mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus") ? "video/webm;codecs=vp9,opus" : "video/webm" });
    state.recorder.ondataavailable = (event) => { if (event.data.size) state.chunks.push(event.data); };
    state.recorder.onstop = finishRecording;
    state.recorder.start();
    const [track] = state.stream.getVideoTracks(); if (track) track.onended = stopRecording;
    els.recordLabel.textContent = "停止錄製"; els.recordIcon.textContent = "■"; els.record.classList.add("active"); els.state.textContent = "錄製中"; setStatus("正在錄製課程；逐字稿會在結束後建立。");
  } catch { setStatus("沒有取得課程畫面或聲音，尚未開始錄製。"); }
}
function stopRecording() { if (state.recorder?.state === "recording") state.recorder.stop(); if (state.stream) state.stream.getTracks().forEach((track) => track.stop()); els.recordLabel.textContent = "開始錄製"; els.recordIcon.textContent = "●"; els.record.classList.remove("active"); els.state.textContent = "錄製完成"; }
async function finishRecording() {
  state.recording = new Blob(state.chunks, { type: "video/webm" });
  const bytes = await state.recording.arrayBuffer();
  await window.courseCapture.saveRecording({ bytes, courseTitle: cleanTitle() });
  els.transcribe.disabled = false; els.export.disabled = false; setStatus("錄影已保留在電腦的影片資料夾，可開始 Whisper 課後轉錄。");
}
async function transcribe() {
  if (!state.recording) return;
  els.transcribe.disabled = true; setProgress({ stage: "audio", detail: "正在準備完整課程錄影" }); setStatus("Whisper 正在處理完整課程，請保持應用程式開啟。");
  try {
    const result = await window.courseCapture.transcribeRecording({ bytes: await state.recording.arrayBuffer(), language: els.language.value });
    state.transcript = result.segments?.length ? result.segments : result.text ? [{ time: 0, text: result.text }] : [];
    showTranscript(); els.progressCard.hidden = true; setStatus(state.transcript.length ? "逐字稿完成，可以整理課程重點。" : "Whisper 沒有辨識到可用文字，請確認錄製時有分享課程聲音。");
  } catch (error) { els.progressCard.hidden = true; els.transcribe.disabled = false; setStatus(`轉錄失敗：${error.message || "請再試一次"}`); }
}
function makeNotes() {
  const text = state.transcript.map((item) => item.text).join(" "); const sentences = text.split(/[。！？!?]/).map((item) => item.trim()).filter(Boolean); const words = text.match(/[A-Za-z]{4,}|[\u4e00-\u9fff]{2,8}/g) || []; const tally = new Map(); words.forEach((word) => tally.set(word, (tally.get(word) || 0) + 1)); const keywords = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([word]) => word);
  const bullets = sentences.slice(0, 5); els.notes.className = "notes-content"; els.notes.innerHTML = `<h3>本堂重點</h3><ul>${bullets.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul><h3>一句話帶走</h3><p>${escapeHtml(bullets[0] || "完成轉錄後再整理。")}</p><h3>關鍵詞</h3><div class="tags">${keywords.map((word) => `<span>${escapeHtml(word)}</span>`).join("")}</div>`;
  state.notesText = `${cleanTitle()}\n\n本堂重點\n${bullets.map((item) => `• ${item}`).join("\n")}\n\n一句話帶走\n• ${bullets[0] || ""}\n\n關鍵詞\n${keywords.join(" · ")}`; els.copy.disabled = false; setStatus("課程筆記已整理完成。");
}
els.record.addEventListener("click", () => state.recorder?.state === "recording" ? stopRecording() : startRecording());
els.transcribe.addEventListener("click", transcribe); els.export.addEventListener("click", async () => { if (!state.recording) return; const result = await window.courseCapture.exportRecording({ bytes: await state.recording.arrayBuffer(), courseTitle: cleanTitle() }); if (!result.canceled) setStatus("錄影已匯出。"); });
els.notesButton.addEventListener("click", makeNotes); els.copy.addEventListener("click", async () => { await navigator.clipboard.writeText(state.notesText); setStatus("筆記已複製到剪貼簿。"); }); window.courseCapture.onProgress(setProgress);
