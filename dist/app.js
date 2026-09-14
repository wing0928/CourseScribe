(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

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
    empty: $("[data-transcript-empty]"),
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
    toast: $("[data-toast]"),
  };

  const demoSegments = [
    "今天先從問題定義開始。好的產品策略，不是先急著想功能，而是先確認我們到底要替誰解決什麼問題。",
    "接著要把使用者的情境拆開來看：他在什麼時刻遇到阻力、現在用什麼方式處理，以及這個問題是否真的值得被解決。",
    "一個實用的判斷方式，是同時看需求的頻率、痛點強度和替代方案的成本。三者交集越清楚，優先級就越高。",
    "最後把洞察寫成可以被團隊共同理解的一句話，這句話會成為後續設計與驗證的共同基準。",
  ];

  let state = {
    isRecording: false,
    elapsedSeconds: 0,
    transcript: [],
    interim: "",
    demoTimer: null,
    timer: null,
    recognition: null,
    mediaStream: null,
    mediaRecorder: null,
    recordingChunks: [],
    recordingUrl: null,
    notesText: "",
    startedAt: null,
    demoIndex: 0,
  };

  let toastTimer;

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add("is-visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => els.toast.classList.remove("is-visible"), 3400);
  }

  function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
    const remainder = Math.floor(seconds % 60).toString().padStart(2, "0");
    return `${minutes}:${remainder}`;
  }

  function currentLanguageName() {
    return els.language.options[els.language.selectedIndex]?.textContent || "繁體中文";
  }

  function updateCourseTitle() {
    const title = els.courseTitle.value.trim() || "未命名課程";
    els.sessionTitle.textContent = title;
    document.title = `${title}｜課間捕手`;
  }

  function updateRecordingUi() {
    const active = state.isRecording;
    els.recordButton.classList.toggle("is-recording", active);
    els.recordLabel.textContent = active ? "停止錄製與轉錄" : "開始錄製與轉錄";
    els.captureState.textContent = active ? `Recording + transcript · ${formatTime(state.elapsedSeconds)}` : "Ready to capture";
    els.captureState.classList.toggle("is-recording", active);
    els.topStatus.classList.toggle("is-recording", active);
    els.topStatus.innerHTML = `<span class="status-dot" aria-hidden="true"></span>${active ? "正在轉錄" : "準備就緒"}`;
    els.composerIndicator.classList.toggle("is-active", active);
    els.composerCopy.textContent = active ? "正在聆聽課堂內容…" : state.transcript.length ? "轉錄已暫停，可以整理課程重點" : "等待開始轉錄";
    els.sessionStatus.textContent = active ? `轉錄中 · ${formatTime(state.elapsedSeconds)}` : state.transcript.length ? "已完成一段轉錄" : "尚未開始";
    els.captureHint.innerHTML = active
      ? `<span class="hint-icon" aria-hidden="true">◉</span><span>正在錄製課程並以${currentLanguageName()}辨識；你可以繼續上課。</span>`
      : `<span class="hint-icon" aria-hidden="true">⌁</span><span>按下開始後，允許瀏覽器擷取你選擇的課程畫面與聲音。</span>`;
  }

  function renderTranscript() {
    els.empty?.remove();
    const existing = els.stream.querySelectorAll(".transcript-entry");
    existing.forEach((entry) => entry.remove());
    const all = [...state.transcript];
    if (state.interim) all.push({ time: state.elapsedSeconds, text: state.interim, interim: true });

    if (!all.length) {
      els.stream.innerHTML = `<div class="transcript-empty" data-transcript-empty><div class="empty-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div><strong>還沒有逐字稿</strong><p>開始轉錄後，這裡會依時間出現課堂內容。</p></div>`;
    } else {
      all.forEach((segment) => {
        const row = document.createElement("div");
        row.className = `transcript-entry${segment.interim ? " is-interim" : ""}`;
        row.innerHTML = `<time class="transcript-time">${formatTime(segment.time)}</time><p>${escapeHtml(segment.text)}</p>`;
        els.stream.append(row);
      });
      els.stream.scrollTop = els.stream.scrollHeight;
    }

    const totalWords = state.transcript.reduce((sum, item) => sum + item.text.replace(/\s/g, "").length, 0);
    els.wordCount.textContent = `${totalWords.toLocaleString("zh-TW")} 字`;
    els.generateNotes.disabled = state.transcript.length === 0;
  }

  function escapeHtml(value) {
    return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
  }

  function addTranscript(text, time = state.elapsedSeconds, interim = false) {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) return;
    if (interim) {
      state.interim = normalized;
    } else {
      state.interim = "";
      state.transcript.push({ time, text: normalized });
    }
    renderTranscript();
  }

  async function requestAudioSource() {
    if (els.source.value === "mic") {
      if (!navigator.mediaDevices?.getUserMedia) return null;
      return navigator.mediaDevices.getUserMedia({ audio: true });
    }
    if (!navigator.mediaDevices?.getDisplayMedia) return null;
    return navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  }

  function createRecorder(stream) {
    if (!stream || !window.MediaRecorder) return null;
    const candidates = els.source.value === "mic"
      ? ["audio/webm;codecs=opus", "audio/webm"]
      : ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    const mimeType = candidates.find((candidate) => MediaRecorder.isTypeSupported?.(candidate));
    try {
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorder.ondataavailable = (event) => { if (event.data?.size) state.recordingChunks.push(event.data); };
      recorder.onstop = finishRecordingFile;
      return recorder;
    } catch (error) {
      return null;
    }
  }

  function finishRecordingFile() {
    if (!state.recordingChunks.length) return;
    if (state.recordingUrl) URL.revokeObjectURL(state.recordingUrl);
    const type = state.mediaRecorder?.mimeType || (els.source.value === "mic" ? "audio/webm" : "video/webm");
    const blob = new Blob(state.recordingChunks, { type });
    state.recordingUrl = URL.createObjectURL(blob);
    const safeTitle = (els.courseTitle.value.trim() || "未命名課程").replace(/[\\/:*?"<>|]/g, "-").slice(0, 48);
    const date = new Date().toISOString().slice(0, 10);
    els.recordingLink.href = state.recordingUrl;
    els.recordingLink.download = `${safeTitle}-${date}.webm`;
    els.recordingLink.textContent = els.source.value === "mic" ? "下載聲音 .webm" : "下載錄影 .webm";
    els.recordingResult.hidden = false;
    showToast("課程錄製完成，請下載檔案保存。");
  }

  function createRecognition() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) return null;
    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = els.language.value;
    recognition.onresult = (event) => {
      let interim = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result[0]?.transcript || "";
        if (result.isFinal) addTranscript(text);
        else interim += text;
      }
      if (interim) addTranscript(interim, state.elapsedSeconds, true);
    };
    recognition.onerror = (event) => {
      if (event.error !== "aborted" && event.error !== "no-speech") showToast(`語音辨識暫時無法使用：${event.error}`);
    };
    recognition.onend = () => {
      if (state.isRecording) {
        try { recognition.start(); } catch (error) { /* browser may already be restarting */ }
      }
    };
    return recognition;
  }

  function startDemoFeed() {
    if (state.transcript.length > 0) return;
    state.demoIndex = 0;
    const pushNext = () => {
      if (!state.isRecording || state.demoIndex >= demoSegments.length) return;
      addTranscript(demoSegments[state.demoIndex], state.elapsedSeconds);
      state.demoIndex += 1;
      if (state.demoIndex < demoSegments.length) state.demoTimer = window.setTimeout(pushNext, 3200);
    };
    state.demoTimer = window.setTimeout(pushNext, 1300);
  }

  async function startRecording() {
    if (state.isRecording) return;
    state.startedAt = Date.now();
    state.elapsedSeconds = 0;
    state.notesText = "";
    state.recordingChunks = [];
    els.recordingResult.hidden = true;
    els.notesBody.classList.remove("has-notes");
    els.notesBody.innerHTML = `<div class="notes-empty"><div class="notes-orb" aria-hidden="true"><span>✦</span></div><strong>轉錄結束後，這裡會變成你的複習頁。</strong><p>完成一段內容後，按下整理，就會自動拆出重點與關鍵詞。</p></div>`;
    els.notesStatus.textContent = "等待轉錄完成";
    els.copyNotes.disabled = true;

    try {
      state.mediaStream = await requestAudioSource();
      if (state.mediaStream) {
        const [videoTrack] = state.mediaStream.getVideoTracks();
        if (videoTrack) videoTrack.onended = () => { if (state.isRecording) stopRecording("分享已結束"); };
      }
    } catch (error) {
      showToast("沒有取得聲音來源，先用試用內容示範即時逐字稿。");
    }

    state.isRecording = true;
    state.mediaRecorder = createRecorder(state.mediaStream);
    if (state.mediaRecorder) {
      try { state.mediaRecorder.start(1000); } catch (error) { state.mediaRecorder = null; }
    }
    state.recognition = createRecognition();
    if (state.recognition) {
      try { state.recognition.start(); } catch (error) { /* handled by demo fallback */ }
      els.composerCopy.textContent = "瀏覽器語音辨識已啟動…";
    } else {
      startDemoFeed();
      showToast("此瀏覽器尚未支援即時語音辨識，已開啟試用模式；錄製仍會繼續。");
    }
    if (!state.mediaRecorder) showToast("此瀏覽器無法建立錄製檔，逐字稿流程仍可繼續。");

    state.timer = window.setInterval(() => {
      state.elapsedSeconds = Math.floor((Date.now() - state.startedAt) / 1000);
      updateRecordingUi();
      if (state.elapsedSeconds > 0 && state.elapsedSeconds % 12 === 0 && state.transcript.length < demoSegments.length && !state.recognition) startDemoFeed();
    }, 1000);
    updateRecordingUi();
    renderTranscript();
  }

  function stopRecording(reason = "") {
    if (!state.isRecording) return;
    state.isRecording = false;
    window.clearInterval(state.timer);
    window.clearTimeout(state.demoTimer);
    state.timer = null;
    state.demoTimer = null;
    state.interim = "";
    if (state.recognition) {
      try { state.recognition.stop(); } catch (error) { /* already stopped */ }
      state.recognition = null;
    }
    if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
      try { state.mediaRecorder.stop(); } catch (error) { /* already stopped */ }
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
      showToast(reason || "轉錄已停止，可以整理課程重點了。");
    } else {
      showToast(reason || "轉錄已停止。");
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
    const keywordCandidates = ["問題定義", "使用者情境", "痛點強度", "替代方案", "優先級", "共同基準"];
    const keywords = keywordCandidates.filter((keyword) => text.includes(keyword));
    if (!keywords.length) keywords.push("課程內容", "核心概念", "複習素材");
    return {
      title,
      bullets: selected.length ? selected : ["這段課程還沒有足夠的文字可以整理。"],
      takeaway: selected[0] || "先累積一段完整轉錄，再回來整理課程重點。",
      keywords,
    };
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
  }

  async function copyNotes() {
    if (!state.notesText) return;
    try {
      await navigator.clipboard.writeText(state.notesText);
      showToast("課程筆記已複製到剪貼簿。");
    } catch (error) {
      showToast("目前無法自動複製，請直接選取筆記內容。");
    }
  }

  function clearTranscript() {
    if (state.isRecording) {
      showToast("轉錄進行中，請先停止後再清除內容。");
      return;
    }
    state.transcript = [];
    state.interim = "";
    state.notesText = "";
    els.notesBody.classList.remove("has-notes");
    els.notesBody.innerHTML = `<div class="notes-empty"><div class="notes-orb" aria-hidden="true"><span>✦</span></div><strong>下課後，這裡會變成你的複習頁。</strong><p>先完成一段轉錄，再按下整理，會自動拆出重點、關鍵詞與下一步。</p></div>`;
    els.notesStatus.textContent = "尚未整理";
    els.copyNotes.disabled = true;
    updateRecordingUi();
    renderTranscript();
  }

  function registerWebMcp() {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    try {
      void Promise.resolve(context.registerTool({
        name: "start_transcription",
        title: "開始課程轉錄",
        description: "開始目前課程的即時轉錄；使用者已在畫面上選好課程名稱、語言與聲音來源時使用。",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        async execute() {
          await startRecording();
          return { status: state.isRecording ? "recording" : "demo_ready", courseTitle: els.courseTitle.value.trim() || "未命名課程" };
        },
      }, { signal: lifecycle.signal }));
      void Promise.resolve(context.registerTool({
        name: "generate_course_notes",
        title: "整理課程重點",
        description: "把目前已完成的課程逐字稿整理成重點、帶走的一句話與關鍵詞。",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        async execute() {
          if (!state.transcript.length) throw new Error("目前沒有可整理的逐字稿");
          renderNotes();
          return { status: "ready", title: els.courseTitle.value.trim() || "未命名課程", transcriptCharacters: getTranscriptText().length };
        },
      }, { signal: lifecycle.signal }));
    } catch (error) {
      // WebMCP is optional; the visible interface remains the source of truth.
    }
  }

  els.courseTitle.addEventListener("input", updateCourseTitle);
  els.recordButton.addEventListener("click", () => state.isRecording ? stopRecording() : startRecording());
  els.generateNotes.addEventListener("click", renderNotes);
  els.copyNotes.addEventListener("click", copyNotes);
  $("[data-clear-transcript]").addEventListener("click", clearTranscript);
  $("[data-session-card]").addEventListener("click", () => els.courseTitle.focus());
  window.addEventListener("beforeunload", () => { if (state.isRecording) stopRecording("頁面即將關閉"); });

  updateCourseTitle();
  updateRecordingUi();
  renderTranscript();
  registerWebMcp();
})();
