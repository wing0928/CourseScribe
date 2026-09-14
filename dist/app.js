(() => {
  "use strict";
  const $ = (selector) => document.querySelector(selector);
  const els = {
    courseTitle: $("[data-course-title]"), language: $("[data-language]"), source: $("[data-source]"),
    recordButton: $("[data-record-button]"), recordLabel: $("[data-record-label]"), captureState: $("[data-capture-state]"), captureHint: $("[data-capture-hint]"), topStatus: $("[data-top-status]"),
    stream: $("[data-transcript-stream]"), wordCount: $("[data-word-count]"), composerIndicator: $("[data-composer-indicator]"), composerCopy: $("[data-composer-copy]"),
    generateNotes: $("[data-generate-notes]"), refineTranscript: $("[data-refine-transcript]"), copyNotes: $("[data-copy-notes]"), notesBody: $("[data-notes-body]"), notesStatus: $("[data-notes-status]"),
    recordingResult: $("[data-recording-result]"), recordingLink: $("[data-recording-link]"), sessionTitle: $("[data-session-list-title]"), sessionStatus: $("[data-session-list-status]"),
    miniButton: $("[data-mini-button]"), miniLabel: $("[data-mini-label]"), miniDock: $("[data-mini-dock]"), toast: $("[data-toast]"),
  };
  const state = {
    isRecording: false, elapsedSeconds: 0, transcript: [], timer: null, mediaStream: null, mediaRecorder: null, recordingChunks: [], recordingBlob: null, recordingUrl: null, recordingMimeType: "video/webm", notesText: "", startedAt: null,
    chunkOffset: 0, miniHosts: [], miniWindow: null,
    local: { status: "idle", progress: 0, workers: {}, loads: {}, requests: new Map(), queue: Promise.resolve(), requestId: 0, refining: false },
  };
  let toastTimer;

  function showToast(message) { els.toast.textContent = message; els.toast.classList.add("is-visible"); window.clearTimeout(toastTimer); toastTimer = window.setTimeout(() => els.toast.classList.remove("is-visible"), 3600); }
  function formatTime(seconds) { return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`; }
  function whisperLanguage() { return { "zh-TW": "chinese", "zh-CN": "chinese", "en-US": "english", "ja-JP": "japanese" }[els.language.value] || "chinese"; }
  function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }

  function localCopy() {
    if (state.local.refining) return "正在用較大模型精修完整錄影…";
    if (state.local.status === "loading") return state.local.progress ? `本機模型下載中 ${state.local.progress}%…` : "本機模型正在準備中…";
    if (state.local.status === "transcribing") return "正在本機辨識最新片段…";
    if (state.local.status === "ready") return "本機轉錄已就緒，課程聲音不會離開這個裝置。";
    if (state.local.status === "error") return "本機模型沒有啟動；錄影檔仍會保留在這個裝置。";
    return "第一次開始時會下載本機模型；音訊會留在這個裝置上處理。";
  }
  function updateCourseTitle() { const title = els.courseTitle.value.trim() || "未命名課程"; els.sessionTitle.textContent = title; document.title = `${title}｜課間捕手`; updateMiniTools(); }
  function updateRefineControl() { els.refineTranscript.disabled = state.isRecording || !state.recordingBlob || state.local.refining; els.refineTranscript.textContent = state.local.refining ? "精修中…" : "課後精修"; }
  function updateRecordingUi() {
    const active = state.isRecording;
    els.recordButton.classList.toggle("is-recording", active); els.recordLabel.textContent = active ? "停止錄製與轉錄" : "開始錄製與轉錄";
    els.captureState.textContent = active ? `REC · ${formatTime(state.elapsedSeconds)}` : state.local.status === "ready" ? "本機模型就緒" : "本機優先";
    els.captureState.classList.toggle("is-recording", active); els.topStatus.classList.toggle("is-recording", active); els.topStatus.innerHTML = `<span class="status-dot" aria-hidden="true"></span>${active ? "正在錄製" : "本機模式"}`;
    els.composerIndicator.classList.toggle("is-active", active || state.local.status === "transcribing");
    els.composerCopy.textContent = active ? localCopy() : state.transcript.length ? "轉錄已暫停，可以整理或課後精修" : "等待開始本機錄製與轉錄";
    els.sessionStatus.textContent = active ? `錄製中 · ${formatTime(state.elapsedSeconds)}` : state.transcript.length ? "已完成本機轉錄" : "尚未開始";
    els.captureHint.innerHTML = `<span class="hint-icon" aria-hidden="true">⌁</span><span>${localCopy()}</span>`;
    updateRefineControl(); updateMiniTools();
  }
  function emptyTranscriptMarkup() {
    const failed = state.local.status === "error";
    return `<div class="transcript-empty"><div class="empty-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div><strong>${failed ? "本機模型尚未啟動" : "還沒有已驗證的逐字稿"}</strong><p>${failed ? "請使用最新版 Chrome 或 Edge；錄影檔仍可下載保存。" : "開始錄製後，文字會由這個裝置上的模型產生。"}</p></div>`;
  }
  function renderTranscript() {
    els.stream.replaceChildren();
    if (!state.transcript.length) els.stream.innerHTML = emptyTranscriptMarkup();
    else {
      state.transcript.forEach((segment) => { const row = document.createElement("div"); row.className = "transcript-entry"; row.innerHTML = `<time class="transcript-time">${formatTime(segment.time)}</time><p>${escapeHtml(segment.text)}</p>`; els.stream.append(row); });
      els.stream.scrollTop = els.stream.scrollHeight;
    }
    const characters = state.transcript.reduce((sum, item) => sum + item.text.replace(/\s/g, "").length, 0);
    els.wordCount.textContent = `${characters.toLocaleString("zh-TW")} 字`; els.generateNotes.disabled = state.transcript.length === 0; updateRefineControl(); updateMiniTools();
  }
  function addTranscript(text, time = state.elapsedSeconds) { const normalized = String(text || "").replace(/\s+/g, " ").trim(); if (!normalized || state.transcript.at(-1)?.text === normalized) return; state.transcript.push({ time: Math.max(0, Math.round(time)), text: normalized }); renderTranscript(); }

  function createTranscriberWorker(tier) {
    const worker = new Worker("./local-transcriber-worker.js", { type: "module" }); state.local.workers[tier] = worker;
    state.local.loads[tier] = new Promise((resolve, reject) => { worker.__resolveLoad = resolve; worker.__rejectLoad = reject; });
    worker.addEventListener("message", ({ data }) => {
      if (!data) return;
      if (data.type === "progress" && tier === "live") { state.local.status = "loading"; state.local.progress = Number.isFinite(data.progress) ? Math.round(data.progress) : 0; updateRecordingUi(); return; }
      if (data.type === "ready") { worker.__resolveLoad?.(); if (tier === "live") { state.local.status = "ready"; state.local.progress = 100; updateRecordingUi(); renderTranscript(); } return; }
      if (data.type === "result" || data.type === "error") { const request = state.local.requests.get(data.id); if (!request) return; state.local.requests.delete(data.id); data.type === "result" ? request.resolve(data) : request.reject(new Error(data.message || "本機辨識失敗")); }
    });
    worker.addEventListener("error", () => { worker.__rejectLoad?.(new Error("本機模型工作程序無法啟動")); if (tier === "live") { state.local.status = "error"; updateRecordingUi(); renderTranscript(); } });
    worker.postMessage({ type: "load", tier }); return state.local.loads[tier];
  }
  function ensureWorker(tier = "live") { if (state.local.loads[tier]) return state.local.loads[tier]; if (tier === "live") { state.local.status = "loading"; updateRecordingUi(); } return createTranscriberWorker(tier); }
  async function transcribeAudio(tier, audio) { await ensureWorker(tier); const id = ++state.local.requestId; const response = new Promise((resolve, reject) => state.local.requests.set(id, { resolve, reject })); state.local.workers[tier].postMessage({ type: "transcribe", id, audio, language: whisperLanguage() }, [audio.buffer]); return response; }
  async function decodeForWhisper(blob) {
    const raw = await blob.arrayBuffer(); const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass || !window.OfflineAudioContext) throw new Error("此瀏覽器無法處理本機音訊");
    const context = new AudioContextClass(); const decoded = await context.decodeAudioData(raw.slice(0)); const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * 16000)), 16000);
    const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start(); const rendered = await offline.startRendering(); await context.close(); return rendered.getChannelData(0).slice();
  }
  function queueLocalTranscription(blob, offset) {
    if (!blob?.size) return;
    state.local.queue = state.local.queue.then(async () => { state.local.status = "transcribing"; updateRecordingUi(); const result = await transcribeAudio("live", await decodeForWhisper(blob)); if (result.text) addTranscript(result.text, offset); state.local.status = "ready"; updateRecordingUi(); }).catch(() => { state.local.status = "error"; updateRecordingUi(); renderTranscript(); });
  }

  async function requestAudioSource() { if (els.source.value === "mic") return navigator.mediaDevices.getUserMedia({ audio: true }); if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("此瀏覽器無法擷取課程分頁"); return navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); }
  function createRecorder(stream) {
    const candidates = els.source.value === "mic" ? ["audio/webm;codecs=opus", "audio/webm"] : ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    const mimeType = candidates.find((candidate) => MediaRecorder.isTypeSupported?.(candidate)) || ""; const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    state.recordingMimeType = recorder.mimeType || (els.source.value === "mic" ? "audio/webm" : "video/webm");
    recorder.ondataavailable = (event) => { if (!event.data?.size) return; state.recordingChunks.push(event.data); const offset = state.chunkOffset; state.chunkOffset = state.elapsedSeconds; queueLocalTranscription(event.data, offset); };
    recorder.onstop = finishRecordingFile; return recorder;
  }
  function finishRecordingFile() {
    if (!state.recordingChunks.length) return; if (state.recordingUrl) URL.revokeObjectURL(state.recordingUrl);
    state.recordingBlob = new Blob(state.recordingChunks, { type: state.recordingMimeType }); state.recordingUrl = URL.createObjectURL(state.recordingBlob);
    const safeTitle = (els.courseTitle.value.trim() || "未命名課程").replace(/[\\/:*?"<>|]/g, "-").slice(0, 48); els.recordingLink.href = state.recordingUrl; els.recordingLink.download = `${safeTitle}-${new Date().toISOString().slice(0, 10)}.webm`;
    els.recordingLink.textContent = els.source.value === "mic" ? "下載聲音 .webm" : "下載錄影 .webm"; els.recordingResult.hidden = false; updateRefineControl(); showToast("課程錄製完成，已保留在這個裝置上。");
  }
  async function startRecording() {
    if (state.isRecording) return; state.startedAt = Date.now(); state.elapsedSeconds = 0; state.notesText = ""; state.recordingChunks = []; state.recordingBlob = null; state.chunkOffset = 0; els.recordingResult.hidden = true;
    try { state.mediaStream = await requestAudioSource(); } catch { showToast("沒有取得課程聲音，因此沒有開始錄製。 "); return; }
    try { state.mediaRecorder = createRecorder(state.mediaStream); } catch { state.mediaStream.getTracks().forEach((track) => track.stop()); state.mediaStream = null; showToast("此瀏覽器無法建立錄製檔，請改用最新版 Chrome 或 Edge。"); return; }
    const [videoTrack] = state.mediaStream.getVideoTracks(); if (videoTrack) videoTrack.onended = () => { if (state.isRecording) stopRecording("分享已結束"); };
    state.isRecording = true; try { state.mediaRecorder.start(6000); } catch { state.isRecording = false; showToast("無法啟動錄製，請重新選擇課程分頁。"); return; }
    state.timer = window.setInterval(() => { state.elapsedSeconds = Math.floor((Date.now() - state.startedAt) / 1000); updateRecordingUi(); }, 1000);
    ensureWorker("live").catch(() => { state.local.status = "error"; updateRecordingUi(); renderTranscript(); }); updateRecordingUi(); renderTranscript();
  }
  function stopRecording(reason = "") {
    if (!state.isRecording) return; state.isRecording = false; window.clearInterval(state.timer); state.timer = null;
    if (state.mediaRecorder?.state !== "inactive") { try { state.mediaRecorder.stop(); } catch { /* already stopped */ } }
    if (state.mediaStream) { state.mediaStream.getTracks().forEach((track) => track.stop()); state.mediaStream = null; }
    updateRecordingUi(); renderTranscript(); els.notesStatus.textContent = state.transcript.length ? "可以整理" : "等待最後片段轉錄"; showToast(reason || "錄製已停止，最後片段會在本機完成辨識。 ");
  }

  function getTranscriptText() { return state.transcript.map((item) => item.text).join(" "); }
  function buildNotes() {
    const text = getTranscriptText(); const sentences = text.split(/[。！？!?]/).map((sentence) => sentence.trim()).filter(Boolean); const words = text.match(/[A-Za-z]{4,}|[\u4e00-\u9fff]{2,8}/g) || [];
    const counts = new Map(); words.forEach((word) => counts.set(word, (counts.get(word) || 0) + 1)); return { title: els.courseTitle.value.trim() || "這堂課", bullets: sentences.slice(0, 4), takeaway: sentences[0] || "先累積一段逐字稿，再回來整理課程重點。", keywords: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([word]) => word) };
  }
  function renderNotes() {
    const notes = buildNotes(); const bullets = (notes.bullets.length ? notes.bullets : ["這段課程尚沒有足夠的內容可以整理。"]).map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join(""); const keywords = (notes.keywords.length ? notes.keywords : ["課程內容", "核心概念"]).map((word) => `<span class="keyword">${escapeHtml(word)}</span>`).join("");
    els.notesBody.classList.add("has-notes"); els.notesBody.innerHTML = `<div class="note-group"><div class="note-group-title"><span>01</span>這堂課在說什麼</div><ul class="note-list">${bullets}</ul></div><div class="note-group"><div class="note-group-title"><span>02</span>一句話帶走</div><ul class="note-list"><li>${escapeHtml(notes.takeaway)}</li></ul></div><div class="note-group"><div class="note-group-title"><span>03</span>關鍵詞</div><div class="keyword-row">${keywords}</div></div>`;
    els.notesStatus.textContent = "已整理 · 剛剛"; state.notesText = `${notes.title}\n\n這堂課在說什麼\n${notes.bullets.map((item) => `• ${item}`).join("\n")}\n\n一句話帶走\n• ${notes.takeaway}\n\n關鍵詞\n${notes.keywords.join(" · ")}`; els.copyNotes.disabled = false;
  }
  async function refineTranscript() {
    if (!state.recordingBlob || state.isRecording || state.local.refining) return; state.local.refining = true; updateRecordingUi();
    try {
      showToast("正在下載或啟動精修模型；第一次使用會花比較久。 "); const result = await transcribeAudio("refine", await decodeForWhisper(state.recordingBlob)); const chunks = Array.isArray(result.chunks) ? result.chunks : [];
      state.transcript = chunks.length ? chunks.map((chunk) => ({ time: Number(chunk.timestamp?.[0] || 0), text: String(chunk.text || "").trim() })).filter((chunk) => chunk.text) : [];
      if (!state.transcript.length && result.text) addTranscript(result.text, 0); state.notesText = ""; els.copyNotes.disabled = true; els.notesStatus.textContent = "精修完成，可重新整理"; showToast("課後精修完成，已用較大模型更新逐字稿。 ");
    } catch { showToast("精修模型無法在這台裝置上完成，已保留原本的逐字稿。 "); }
    state.local.refining = false; updateRecordingUi(); renderTranscript();
  }
  async function copyNotes() { if (!state.notesText) return; try { await navigator.clipboard.writeText(state.notesText); showToast("課程筆記已複製到剪貼簿。 "); } catch { showToast("目前無法自動複製，請直接選取筆記內容。 "); } }
  function clearTranscript() {
    if (state.isRecording) { showToast("錄製進行中，請先停止後再清除內容。 "); return; }
    state.transcript = []; state.notesText = ""; els.copyNotes.disabled = true; els.notesStatus.textContent = "尚未整理"; els.notesBody.classList.remove("has-notes"); els.notesBody.innerHTML = `<div class="notes-empty"><div class="notes-orb" aria-hidden="true"><span>✦</span></div><strong>下課後，這裡會變成你的複習頁。</strong><p>先完成一段已辨識內容，再按下整理，會自動拆出重點與關鍵詞。</p></div>`; updateRecordingUi(); renderTranscript();
  }

  function miniMarkup() { return `<section class="mini-tool" aria-label="課間捕手迷你工具"><span class="mini-record-dot" data-mini-dot></span><div class="mini-copy"><strong data-mini-title>未命名課程</strong><small data-mini-state>本機轉錄待命</small></div><strong class="mini-time" data-mini-time>00:00</strong><button class="mini-record-button" type="button" data-mini-record aria-label="開始錄製" title="開始錄製"><span data-mini-record-icon>●</span></button><button class="mini-expand" type="button" data-mini-expand aria-label="回到主畫面" title="回到主畫面">↗</button><button class="mini-close" type="button" data-mini-close aria-label="關閉迷你工具">×</button></section>`; }
  function mountMiniTool(host, isPictureInPicture = false) {
    host.innerHTML = miniMarkup();
    host.querySelector("[data-mini-close]").addEventListener("click", () => { if (isPictureInPicture && state.miniWindow) state.miniWindow.close(); else { els.miniDock.hidden = true; state.miniHosts = state.miniHosts.filter((item) => item !== host); updateMiniButton(); } });
    host.querySelector("[data-mini-record]").addEventListener("click", () => state.isRecording ? stopRecording() : startRecording()); host.querySelector("[data-mini-expand]").addEventListener("click", () => { window.focus(); document.querySelector(".capture-card")?.scrollIntoView({ behavior: "smooth", block: "center" }); });
    state.miniHosts = state.miniHosts.filter((item) => item.isConnected).concat(host); updateMiniTools();
  }
  function updateMiniTools() {
    state.miniHosts = state.miniHosts.filter((host) => host.isConnected);
    state.miniHosts.forEach((host) => { const active = state.isRecording; const dot = host.querySelector("[data-mini-dot]"); if (!dot) return; dot.classList.toggle("is-recording", active); host.querySelector("[data-mini-title]").textContent = els.courseTitle.value.trim() || "未命名課程"; host.querySelector("[data-mini-state]").textContent = active ? (state.local.status === "transcribing" ? "本機辨識中" : "正在錄製") : state.transcript.length ? `${state.transcript.length} 段已轉錄` : "本機轉錄待命"; host.querySelector("[data-mini-time]").textContent = formatTime(state.elapsedSeconds); const record = host.querySelector("[data-mini-record]"); record.classList.toggle("is-recording", active); record.setAttribute("aria-label", active ? "停止錄製" : "開始錄製"); record.title = active ? "停止錄製" : "開始錄製"; host.querySelector("[data-mini-record-icon]").textContent = active ? "■" : "●"; });
  }
  function updateMiniButton() { els.miniLabel.textContent = state.miniHosts.length ? "關閉迷你工具" : "開啟迷你工具"; }
  async function toggleMiniTool() {
    if (state.miniWindow && !state.miniWindow.closed) { state.miniWindow.close(); return; }
    if (!els.miniDock.hidden) { els.miniDock.hidden = true; state.miniHosts = state.miniHosts.filter((host) => host !== els.miniDock); updateMiniButton(); return; }
    if (window.documentPictureInPicture?.requestWindow) {
      try {
        const pip = await window.documentPictureInPicture.requestWindow({ width: 336, height: 72 }); pip.document.head.innerHTML = `<base href="${location.href}"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${new URL("./styles.css", location.href).href}">`; pip.document.body.style.margin = "0"; pip.document.body.style.background = "#08111e"; state.miniWindow = pip; mountMiniTool(pip.document.body, true);
        pip.addEventListener("pagehide", () => { state.miniWindow = null; state.miniHosts = state.miniHosts.filter((host) => host.isConnected && host !== pip.document.body); updateMiniButton(); }); updateMiniButton(); return;
      } catch { showToast("獨立小窗無法開啟，已切換成頁面右下角的小工具。 "); }
    }
    els.miniDock.hidden = false; mountMiniTool(els.miniDock); updateMiniButton();
  }
  function registerWebMcp() {
    const context = document.modelContext; if (!context?.registerTool) return; const lifecycle = new AbortController();
    try {
      void Promise.resolve(context.registerTool({ name: "start_transcription", title: "開始本機錄製與轉錄", description: "開始錄製課程，音訊在目前裝置上由本機模型辨識。", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false }, async execute() { await startRecording(); return { status: state.isRecording ? "recording" : "awaiting_audio_permission" }; } }, { signal: lifecycle.signal }));
      void Promise.resolve(context.registerTool({ name: "generate_course_notes", title: "整理課程重點", description: "把本機逐字稿整理成課程重點與關鍵詞。", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: true }, async execute() { if (!state.transcript.length) throw new Error("目前沒有可整理的逐字稿"); renderNotes(); return { status: "ready", transcriptCharacters: getTranscriptText().length }; } }, { signal: lifecycle.signal }));
    } catch { /* WebMCP is optional. */ }
  }
  els.courseTitle.addEventListener("input", updateCourseTitle); els.recordButton.addEventListener("click", () => state.isRecording ? stopRecording() : startRecording()); els.generateNotes.addEventListener("click", renderNotes); els.refineTranscript.addEventListener("click", refineTranscript); els.copyNotes.addEventListener("click", copyNotes);
  $("[data-clear-transcript]").addEventListener("click", clearTranscript); $("[data-session-card]").addEventListener("click", () => els.courseTitle.focus()); els.miniButton.addEventListener("click", toggleMiniTool);
  window.addEventListener("beforeunload", () => { if (state.isRecording) stopRecording("頁面即將關閉"); if (state.recordingUrl) URL.revokeObjectURL(state.recordingUrl); Object.values(state.local.workers).forEach((worker) => worker?.terminate()); });
  updateCourseTitle(); updateRecordingUi(); renderTranscript(); updateMiniButton(); registerWebMcp();
})();
