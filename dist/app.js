(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);

  const els = {
    courseTitle: $("[data-course-title]"),
    language: $("[data-language]"),
    source: $("[data-source]"),
    recordButton: $("[data-record-button]"),
    recordLabel: $("[data-record-label]"),
    captureState: $("[data-capture-state]"),
    captureHint: $("[data-capture-hint]"),
    topStatus: $("[data-top-status]"),
    stream: $("[data-transcript-stream]"),
    wordCount: $("[data-word-count]"),
    composerIndicator: $("[data-composer-indicator]"),
    composerCopy: $("[data-composer-copy]"),
    generateNotes: $("[data-generate-notes]"),
    copyNotes: $("[data-copy-notes]"),
    notesBody: $("[data-notes-body]"),
    notesStatus: $("[data-notes-status]"),
    recordingResult: $("[data-recording-result]"),
    recordingLink: $("[data-recording-link]"),
    sessionTitle: $("[data-session-list-title]"),
    sessionStatus: $("[data-session-list-status]"),
    miniButton: $("[data-mini-button]"),
    miniLabel: $("[data-mini-label]"),
    miniDock: $("[data-mini-dock]"),
    toast: $("[data-toast]"),
  };

  const state = {
    isRecording: false,
    elapsedSeconds: 0,
    transcript: [],
    timer: null,
    mediaStream: null,
    mediaRecorder: null,
    recordingChunks: [],
    recordingUrl: null,
    recordingMimeType: "video/webm",
    notesText: "",
    startedAt: null,
    cloudStatus: "idle",
    cloudQueue: Promise.resolve(),
    chunkOffset: 0,
    miniHosts: [],
    miniWindow: null,
  };

  let toastTimer;

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add("is-visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => els.toast.classList.remove("is-visible"), 3600);
  }

  function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
    const remainder = Math.floor(seconds % 60).toString().padStart(2, "0");
    return `${minutes}:${remainder}`;
  }

  function languageCode() {
    return (els.language.value || "zh-TW").split("-")[0];
  }

  function updateCourseTitle() {
    const title = els.courseTitle.value.trim() || "未命名課程";
    els.sessionTitle.textContent = title;
    document.title = `${title}｜課間捕手`;
    updateMiniTools();
  }

  function cloudCopy() {
    if (state.cloudStatus === "transcribing") return "雲端正在辨識最新片段…";
    if (state.cloudStatus === "connected") return "雲端逐字稿已連接，最新片段會分段送回。";
    if (state.cloudStatus === "unavailable") return "尚未連接雲端轉錄服務；錄影仍會保存在這個裝置。";
    return "開始後會收集課程音訊，並由雲端服務分段辨識。";
  }

  function updateRecordingUi() {
    const active = state.isRecording;
    els.recordButton.classList.toggle("is-recording", active);
    els.recordLabel.textContent = active ? "停止錄製與轉錄" : "開始錄製與轉錄";
    els.captureState.textContent = active ? `Recording · ${formatTime(state.elapsedSeconds)}` : "Ready to capture";
    els.captureState.classList.toggle("is-recording", active);
    els.topStatus.classList.toggle("is-recording", active);
    els.topStatus.innerHTML = `<span class="status-dot" aria-hidden="true"></span>${active ? "正在錄製" : "準備就緒"}`;
    els.composerIndicator.classList.toggle("is-active", active);
    els.composerCopy.textContent = active ? cloudCopy() : state.transcript.length ? "轉錄已暫停，可以整理課程重點" : "等待開始錄製與雲端轉錄";
    els.sessionStatus.textContent = active ? `錄製中 · ${formatTime(state.elapsedSeconds)}` : state.transcript.length ? "已完成一段轉錄" : "尚未開始";
    els.captureHint.innerHTML = active
      ? `<span class="hint-icon" aria-hidden="true">◉</span><span>${cloudCopy()}</span>`
      : `<span class="hint-icon" aria-hidden="true">⌁</span><span>開始後會錄下課程畫面與聲音；逐字稿只顯示實際辨識完成的內容。</span>`;
    updateMiniTools();
  }

  function emptyTranscriptMarkup() {
    const unavailable = state.cloudStatus === "unavailable";
    return `<div class="transcript-empty"><div class="empty-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div><strong>${unavailable ? "雲端轉錄尚未連接" : "還沒有已驗證的逐字稿"}</strong><p>${unavailable ? "錄影檔仍可下載；設定免費轉錄 API 後，新的課程片段會自動送回文字。" : "開始錄製後，這裡只會顯示雲端辨識完成的課程內容。"}</p></div>`;
  }

  function renderTranscript() {
    els.stream.replaceChildren();
    if (!state.transcript.length) els.stream.innerHTML = emptyTranscriptMarkup();
    else {
      state.transcript.forEach((segment) => {
        const row = document.createElement("div");
        row.className = "transcript-entry";
        row.innerHTML = `<time class="transcript-time">${formatTime(segment.time)}</time><p>${escapeHtml(segment.text)}</p>`;
        els.stream.append(row);
      });
      els.stream.scrollTop = els.stream.scrollHeight;
    }
    const totalCharacters = state.transcript.reduce((sum, item) => sum + item.text.replace(/\s/g, "").length, 0);
    els.wordCount.textContent = `${totalCharacters.toLocaleString("zh-TW")} 字`;
    els.generateNotes.disabled = state.transcript.length === 0;
    updateMiniTools();
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
  }

  function addTranscript(text, time = state.elapsedSeconds) {
    const normalized = String(text).replace(/\s+/g, " ").trim();
    if (!normalized) return;
    if (state.transcript.at(-1)?.text === normalized) return;
    state.transcript.push({ time: Math.max(0, Math.round(time)), text: normalized });
    renderTranscript();
  }

  async function requestAudioSource() {
    if (els.source.value === "mic") {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("此瀏覽器無法取得麥克風");
      return navigator.mediaDevices.getUserMedia({ audio: true });
    }
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("此瀏覽器無法擷取課程分頁");
    return navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  }

  function createRecorder(stream) {
    if (!stream || !window.MediaRecorder) return null;
    const candidates = els.source.value === "mic"
      ? ["audio/webm;codecs=opus", "audio/webm"]
      : ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    const mimeType = candidates.find((candidate) => MediaRecorder.isTypeSupported?.(candidate)) || "";
    try {
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      state.recordingMimeType = recorder.mimeType || (els.source.value === "mic" ? "audio/webm" : "video/webm");
      recorder.ondataavailable = (event) => {
        if (!event.data?.size) return;
        state.recordingChunks.push(event.data);
        const offset = state.chunkOffset;
        state.chunkOffset = state.elapsedSeconds;
        queueCloudTranscription(event.data, offset);
      };
      recorder.onstop = finishRecordingFile;
      return recorder;
    } catch {
      return null;
    }
  }

  function queueCloudTranscription(blob, offset) {
    if (!blob?.size || state.cloudStatus === "unavailable") return;
    state.cloudQueue = state.cloudQueue.then(() => sendAudioChunk(blob, offset)).catch(() => undefined);
  }

  async function sendAudioChunk(blob, offset) {
    state.cloudStatus = "transcribing";
    updateRecordingUi();
    const formData = new FormData();
    formData.append("audio", blob, `course-chunk-${Math.round(offset)}.webm`);
    formData.append("language", languageCode());
    formData.append("offset", String(offset));
    try {
      const response = await fetch("/api/transcribe", { method: "POST", body: formData });
      if (!response.ok) throw new Error(`轉錄服務回應 ${response.status}`);
      const payload = await response.json();
      const segments = Array.isArray(payload?.segments) ? payload.segments : [];
      if (segments.length) segments.forEach((segment) => addTranscript(segment.text, offset + Number(segment.start || 0)));
      else if (payload?.text) addTranscript(payload.text, offset);
      state.cloudStatus = "connected";
    } catch {
      state.cloudStatus = "unavailable";
    }
    updateRecordingUi();
    renderTranscript();
  }

  function finishRecordingFile() {
    if (!state.recordingChunks.length) return;
    if (state.recordingUrl) URL.revokeObjectURL(state.recordingUrl);
    const blob = new Blob(state.recordingChunks, { type: state.recordingMimeType });
    state.recordingUrl = URL.createObjectURL(blob);
    const safeTitle = (els.courseTitle.value.trim() || "未命名課程").replace(/[\\/:*?"<>|]/g, "-").slice(0, 48);
    const date = new Date().toISOString().slice(0, 10);
    els.recordingLink.href = state.recordingUrl;
    els.recordingLink.download = `${safeTitle}-${date}.webm`;
    els.recordingLink.textContent = els.source.value === "mic" ? "下載聲音 .webm" : "下載錄影 .webm";
    els.recordingResult.hidden = false;
    showToast("課程錄製完成，請下載檔案保存。");
  }

  async function startRecording() {
    if (state.isRecording) return;
    state.startedAt = Date.now();
    state.elapsedSeconds = 0;
    state.notesText = "";
    state.recordingChunks = [];
    state.chunkOffset = 0;
    state.cloudStatus = "idle";
    els.recordingResult.hidden = true;
    els.notesBody.classList.remove("has-notes");
    els.notesBody.innerHTML = `<div class="notes-empty"><div class="notes-orb" aria-hidden="true"><span>✦</span></div><strong>轉錄結束後，這裡會變成你的複習頁。</strong><p>完成一段已辨識內容後，按下整理，就會自動拆出重點與關鍵詞。</p></div>`;
    els.notesStatus.textContent = "等待已辨識內容";
    els.copyNotes.disabled = true;
    try {
      state.mediaStream = await requestAudioSource();
      const [videoTrack] = state.mediaStream.getVideoTracks();
      if (videoTrack) videoTrack.onended = () => { if (state.isRecording) stopRecording("分享已結束"); };
    } catch {
      showToast("沒有取得課程聲音，因此沒有開始錄製或產生逐字稿。");
      return;
    }
    state.mediaRecorder = createRecorder(state.mediaStream);
    if (!state.mediaRecorder) {
      state.mediaStream.getTracks().forEach((track) => track.stop());
      state.mediaStream = null;
      showToast("此瀏覽器無法建立錄製檔，請改用最新版 Chrome 或 Edge。");
      return;
    }
    state.isRecording = true;
    try { state.mediaRecorder.start(6000); } catch {
      state.isRecording = false;
      showToast("無法啟動錄製，請重新選擇課程分頁。 ");
      return;
    }
    state.timer = window.setInterval(() => {
      state.elapsedSeconds = Math.floor((Date.now() - state.startedAt) / 1000);
      updateRecordingUi();
    }, 1000);
    updateRecordingUi();
    renderTranscript();
  }

  function stopRecording(reason = "") {
    if (!state.isRecording) return;
    state.isRecording = false;
    window.clearInterval(state.timer);
    state.timer = null;
    if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
      try { state.mediaRecorder.stop(); } catch { /* already stopped */ }
    }
    if (state.mediaStream) {
      state.mediaStream.getTracks().forEach((track) => track.stop());
      state.mediaStream = null;
    }
    state.mediaRecorder = null;
    updateRecordingUi();
    renderTranscript();
    if (state.transcript.length) {
      els.notesStatus.textContent = "可以整理";
      els.generateNotes.disabled = false;
      showToast(reason || "錄製已停止，可以整理課程重點了。");
    } else {
      els.notesStatus.textContent = state.cloudStatus === "unavailable" ? "等待免費雲端轉錄設定" : "等待最後片段辨識";
      showToast(reason || "錄製已停止；已完成的雲端辨識片段會繼續送回。 ");
    }
  }

  function getTranscriptText() {
    return state.transcript.map((item) => item.text).join(" ");
  }

  function buildNotes() {
    const text = getTranscriptText();
    const sentences = text.split(/[。！？!?]/).map((sentence) => sentence.trim()).filter(Boolean);
    const title = els.courseTitle.value.trim() || "這堂課";
    const selected = sentences.slice(0, 4);
    const words = text.match(/[A-Za-z]{4,}|[\u4e00-\u9fff]{2,8}/g) || [];
    const counts = new Map();
    words.forEach((word) => { if (word.length >= 2) counts.set(word, (counts.get(word) || 0) + 1); });
    const keywords = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([word]) => word);
    if (!keywords.length) keywords.push("課程內容", "核心概念", "複習素材");
    return { title, bullets: selected.length ? selected : ["這段課程尚沒有足夠的已辨識內容可以整理。"], takeaway: selected[0] || "先累積一段已辨識內容，再回來整理課程重點。", keywords };
  }

  function renderNotes() {
    const notes = buildNotes();
    const bullets = notes.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("");
    const keywords = notes.keywords.map((keyword) => `<span class="keyword">${escapeHtml(keyword)}</span>`).join("");
    els.notesBody.classList.add("has-notes");
    els.notesBody.innerHTML = `<div class="note-group"><div class="note-group-title"><span>01</span>這堂課在說什麼</div><ul class="note-list">${bullets}</ul></div><div class="note-group"><div class="note-group-title"><span>02</span>一句話帶走</div><ul class="note-list"><li>${escapeHtml(notes.takeaway)}</li></ul></div><div class="note-group"><div class="note-group-title"><span>03</span>關鍵詞</div><div class="keyword-row">${keywords}</div></div>`;
    els.notesStatus.textContent = "已整理 · 剛剛";
    state.notesText = `${notes.title}\n\n這堂課在說什麼\n${notes.bullets.map((item) => `• ${item}`).join("\n")}\n\n一句話帶走\n• ${notes.takeaway}\n\n關鍵詞\n${notes.keywords.join(" · ")}`;
    els.copyNotes.disabled = false;
    updateMiniTools();
  }

  async function copyNotes() {
    if (!state.notesText) return;
    try {
      await navigator.clipboard.writeText(state.notesText);
      showToast("課程筆記已複製到剪貼簿。");
    } catch {
      showToast("目前無法自動複製，請直接選取筆記內容。");
    }
  }

  function clearTranscript() {
    if (state.isRecording) {
      showToast("錄製進行中，請先停止後再清除內容。");
      return;
    }
    state.transcript = [];
    state.notesText = "";
    els.notesBody.classList.remove("has-notes");
    els.notesBody.innerHTML = `<div class="notes-empty"><div class="notes-orb" aria-hidden="true"><span>✦</span></div><strong>下課後，這裡會變成你的複習頁。</strong><p>先完成一段已辨識內容，再按下整理，會自動拆出重點、關鍵詞與下一步。</p></div>`;
    els.notesStatus.textContent = "尚未整理";
    els.copyNotes.disabled = true;
    updateRecordingUi();
    renderTranscript();
  }

  function miniMarkup() {
    return `<section class="mini-tool" aria-label="課間捕手迷你工具"><header class="mini-tool-header"><div class="mini-tool-brand"><span aria-hidden="true">◲</span><span><strong data-mini-title>未命名課程</strong><small data-mini-service>準備雲端轉錄</small></span></div><button class="mini-close" type="button" data-mini-close aria-label="關閉迷你工具">×</button></header><div class="mini-tool-body"><div class="mini-meter"><span class="mini-record-dot" data-mini-dot></span><span data-mini-state>尚未開始</span><strong class="mini-time" data-mini-time>00:00</strong></div><p class="mini-transcript is-empty" data-mini-transcript>開始後，這裡會顯示最新的已辨識文字。</p><div class="mini-tool-actions"><button class="mini-record-button" type="button" data-mini-record>開始錄製</button><button class="mini-note-button" type="button" data-mini-notes disabled>整理重點</button></div><p class="mini-tool-foot" data-mini-foot>課程內容會留在這個小視窗，方便你專心上課。</p></div></section>`;
  }

  function mountMiniTool(host, isPictureInPicture = false) {
    host.innerHTML = miniMarkup();
    host.querySelector("[data-mini-close]").addEventListener("click", () => {
      if (isPictureInPicture && state.miniWindow) state.miniWindow.close();
      else { els.miniDock.hidden = true; state.miniHosts = state.miniHosts.filter((item) => item !== host); updateMiniButton(); }
    });
    host.querySelector("[data-mini-record]").addEventListener("click", () => state.isRecording ? stopRecording() : startRecording());
    host.querySelector("[data-mini-notes]").addEventListener("click", renderNotes);
    state.miniHosts = state.miniHosts.filter((item) => item.isConnected).concat(host);
    updateMiniTools();
  }

  function updateMiniTools() {
    state.miniHosts = state.miniHosts.filter((host) => host.isConnected);
    const lastText = state.transcript.at(-1)?.text || "開始後，這裡會顯示最新的已辨識文字。";
    state.miniHosts.forEach((host) => {
      const active = state.isRecording;
      const dot = host.querySelector("[data-mini-dot]");
      if (!dot) return;
      dot.classList.toggle("is-recording", active);
      host.querySelector("[data-mini-state]").textContent = active ? (state.cloudStatus === "connected" ? "雲端辨識中" : "正在錄製") : "尚未開始";
      host.querySelector("[data-mini-time]").textContent = formatTime(state.elapsedSeconds);
      const transcript = host.querySelector("[data-mini-transcript]");
      transcript.textContent = lastText;
      transcript.classList.toggle("is-empty", !state.transcript.length);
      const record = host.querySelector("[data-mini-record]");
      record.textContent = active ? "停止錄製" : "開始錄製";
      record.classList.toggle("is-recording", active);
      host.querySelector("[data-mini-notes]").disabled = !state.transcript.length;
      host.querySelector("[data-mini-title]").textContent = els.courseTitle.value.trim() || "未命名課程";
      host.querySelector("[data-mini-service]").textContent = state.cloudStatus === "connected" ? "已連接雲端轉錄" : state.cloudStatus === "unavailable" ? "等待免費雲端 API" : "準備雲端轉錄";
      host.querySelector("[data-mini-foot]").textContent = active ? cloudCopy() : "可維持這個小視窗開著，課程在另一個分頁也不用一直切回來。";
    });
  }

  function updateMiniButton() {
    els.miniLabel.textContent = state.miniHosts.length ? "關閉迷你工具" : "開啟迷你工具";
  }

  async function toggleMiniTool() {
    if (state.miniWindow && !state.miniWindow.closed) { state.miniWindow.close(); return; }
    if (!els.miniDock.hidden) {
      els.miniDock.hidden = true;
      state.miniHosts = state.miniHosts.filter((host) => host !== els.miniDock);
      updateMiniButton();
      return;
    }
    if (window.documentPictureInPicture?.requestWindow) {
      try {
        const pip = await window.documentPictureInPicture.requestWindow({ width: 390, height: 330 });
        pip.document.head.innerHTML = `<base href="${location.href}"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${new URL("./styles.css", location.href).href}">`;
        pip.document.body.style.margin = "0";
        pip.document.body.style.background = "#08111e";
        state.miniWindow = pip;
        mountMiniTool(pip.document.body, true);
        pip.addEventListener("pagehide", () => { state.miniWindow = null; state.miniHosts = state.miniHosts.filter((host) => host.isConnected && host !== pip.document.body); updateMiniButton(); });
        updateMiniButton();
        return;
      } catch {
        showToast("獨立小窗無法開啟，已切換為頁面右下角的迷你控制器。 ");
      }
    }
    els.miniDock.hidden = false;
    mountMiniTool(els.miniDock);
    updateMiniButton();
  }

  function registerWebMcp() {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    try {
      void Promise.resolve(context.registerTool({ name: "start_transcription", title: "開始課程錄製與轉錄", description: "開始目前課程的錄製，並將音訊分段交給已設定的雲端轉錄服務。", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false }, async execute() { await startRecording(); return { status: state.isRecording ? "recording" : "awaiting_audio_permission", courseTitle: els.courseTitle.value.trim() || "未命名課程" }; } }, { signal: lifecycle.signal }));
      void Promise.resolve(context.registerTool({ name: "generate_course_notes", title: "整理課程重點", description: "把已完成的課程逐字稿整理成重點、帶走的一句話與關鍵詞。", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: true }, async execute() { if (!state.transcript.length) throw new Error("目前沒有可整理的逐字稿"); renderNotes(); return { status: "ready", title: els.courseTitle.value.trim() || "未命名課程", transcriptCharacters: getTranscriptText().length }; } }, { signal: lifecycle.signal }));
    } catch { /* WebMCP is optional. */ }
  }

  els.courseTitle.addEventListener("input", updateCourseTitle);
  els.recordButton.addEventListener("click", () => state.isRecording ? stopRecording() : startRecording());
  els.generateNotes.addEventListener("click", renderNotes);
  els.copyNotes.addEventListener("click", copyNotes);
  $("[data-clear-transcript]").addEventListener("click", clearTranscript);
  $("[data-session-card]").addEventListener("click", () => els.courseTitle.focus());
  els.miniButton.addEventListener("click", toggleMiniTool);
  window.addEventListener("beforeunload", () => { if (state.isRecording) stopRecording("頁面即將關閉"); if (state.recordingUrl) URL.revokeObjectURL(state.recordingUrl); });

  updateCourseTitle();
  updateRecordingUi();
  renderTranscript();
  updateMiniButton();
  registerWebMcp();
})();
