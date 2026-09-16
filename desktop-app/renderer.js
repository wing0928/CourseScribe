const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const els = {
  views: $$(`[data-view-panel]`),
  nav: $$(`[data-view]`),
  title: $(`[data-course-title]`),
  category: $(`[data-category]`),
  semester: $(`[data-semester]`),
  language: $(`[data-language]`),
  model: $(`[data-model]`),
  state: $(`[data-state]`),
  record: $(`[data-record]`),
  recordLabel: $(`[data-record-label]`),
  recordIcon: $(`[data-record-icon]`),
  pauseRecording: $(`[data-pause-recording]`),
  upload: $(`[data-upload]`),
  sourceList: $(`[data-source-list]`),
  sourceInfo: $(`[data-source-info]`),
  sourceName: $(`[data-source-name]`),
  sourceMeta: $(`[data-source-meta]`),
  progressCard: $(`[data-progress-card]`),
  progressStage: $(`[data-progress-stage]`),
  progressCopy: $(`[data-progress-copy]`),
  progressPercent: $(`[data-progress-percent]`),
  progressBar: $(`[data-progress-bar]`),
  homeNotes: $(`[data-home-notes]`),
  homeNotesModel: $(`[data-notes-model]`),
  homeOpen: $(`[data-home-open]`),
  homeCopy: $(`[data-home-copy]`),
  modelStatus: $(`[data-model-status]`),
  cancelModel: $(`[data-cancel-model]`),
  ollamaBadge: $(`[data-ollama-badge]`),
  dbCount: $(`[data-db-count]`),
  dbSearch: $(`[data-db-search]`),
  dbCategory: $(`[data-db-category]`),
  dbSemester: $(`[data-db-semester]`),
  dbType: $(`[data-db-type]`),
  dbStatus: $(`[data-db-status]`),
  courseList: $(`[data-course-list]`),
  courseDetail: $(`[data-course-detail]`),
  status: $(`[data-status]`),
  dbMessage: $(`[data-db-status]`),
  recordingWidget: $(`[data-recording-widget]`),
  widgetState: $(`[data-widget-state]`),
  widgetTime: $(`[data-widget-time]`),
  widgetDot: $(`[data-widget-dot]`),
  widgetPause: $(`[data-widget-pause]`),
  widgetStop: $(`[data-widget-stop]`),
  widgetMinimize: $(`[data-widget-minimize]`),
};

const state = {
  view: "home",
  sources: [],
  selectedSourceId: "",
  categories: [],
  semesters: [],
  courses: [],
  courseId: "",
  selectedCourseId: "",
  trashMode: false,
  lastDetail: null,
  models: { available: false, models: [], choices: [], selected: "qwen3:4b" },
  modelPulling: "",
  recording: null,
};

const STATUS_LABELS = {
  draft: "草稿", recording: "錄製中", transcribing: "轉錄中", summarizing: "整理中", ready: "已完成", failed: "需處理",
};
const STAGE_LABELS = { model: "WHISPER", audio: "準備音訊", recording: "錄影中", transcribe: "轉錄中", notes: "整理筆記", complete: "完成", error: "需要處理" };

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatTime(ms) {
  const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function formatRecordingTime(ms) {
  const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function recordingElapsed(recording = state.recording) {
  if (!recording) return 0;
  const endpoint = recording.paused ? recording.pausedAt : Date.now();
  return Math.max(0, endpoint - recording.startedAt - recording.pausedTotal);
}

function publishRecordingWidget() {
  const recording = state.recording;
  const snapshot = {
    visible: Boolean(recording),
    recording: Boolean(recording),
    paused: Boolean(recording?.paused),
    elapsedMs: recordingElapsed(recording),
    title: els.title.value.trim() || "未命名課程",
  };
  if (els.recordingWidget) els.recordingWidget.hidden = !recording;
  if (els.widgetTime) els.widgetTime.textContent = formatRecordingTime(snapshot.elapsedMs);
  if (els.widgetState) els.widgetState.textContent = snapshot.paused ? "已暫停" : "錄影中";
  if (els.widgetPause) els.widgetPause.textContent = snapshot.paused ? "繼續" : "暫停";
  if (els.widgetDot) els.widgetDot.classList.toggle("paused", snapshot.paused);
  window.courseCapture.widget.update(snapshot).catch(() => {});
}

function startRecordingClock(recording) {
  clearInterval(recording.clockTimer);
  publishRecordingWidget();
  recording.clockTimer = setInterval(publishRecordingWidget, 500);
}

function setStatus(message, kind = "") {
  els.status.textContent = String(message || "");
  els.status.dataset.kind = kind;
}

function setDatabaseMessage(message) {
  if (els.dbMessage) els.dbMessage.textContent = String(message || "");
}

function setView(view) {
  state.view = view === "database" ? "database" : "home";
  els.views.forEach((panel) => { panel.hidden = panel.dataset.viewPanel !== state.view; });
  els.nav.forEach((button) => button.classList.toggle("active", button.dataset.view === state.view));
  if (state.view === "database") refreshCourses();
}

function courseInput() {
  return {
    title: els.title.value.trim() || "未命名課程",
    categoryId: els.category.value || null,
    semester: els.semester.value || null,
    language: els.language.value || "zh-TW",
    model: els.model.value || state.models.selected || "qwen3:4b",
  };
}

function renderSelect(select, values, emptyLabel, selectedValue = "") {
  if (!select) return;
  const options = values.map((item) => {
    const value = typeof item === "string" ? item : item.id;
    const label = typeof item === "string" ? item : item.name;
    return `<option value="${escapeHtml(value)}"${String(value) === String(selectedValue) ? " selected" : ""}>${escapeHtml(label)}</option>`;
  }).join("");
  select.innerHTML = `<option value="">${escapeHtml(emptyLabel)}</option>${options}`;
}

function renderFilters() {
  renderSelect(els.category, state.categories, "未分類", els.category.value);
  renderSelect(els.semester, state.semesters, "未指定", els.semester.value);
  const selectedCategory = els.dbCategory.value;
  const selectedSemester = els.dbSemester.value;
  els.dbCategory.innerHTML = `<option value="all">所有分類</option>${state.categories.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("")}`;
  els.dbSemester.innerHTML = `<option value="all">所有學期</option>${state.semesters.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join("")}`;
  if ([...els.dbCategory.options].some((item) => item.value === selectedCategory)) els.dbCategory.value = selectedCategory;
  if ([...els.dbSemester.options].some((item) => item.value === selectedSemester)) els.dbSemester.value = selectedSemester;
}

function showInlineForm(kind, visible) {
  const form = $(`[data-add-${kind}-form]`);
  if (form) form.hidden = !visible;
  if (visible) $(`[data-new-${kind}]`)?.focus();
}

async function addCategory() {
  const input = $(`[data-new-category]`);
  try {
    const created = await window.courseCapture.categories.create(input.value);
    input.value = "";
    showInlineForm("category", false);
    state.categories = await window.courseCapture.categories.list();
    renderFilters();
    els.category.value = created.id;
    setStatus(`已新增分類「${created.name}」。`);
  } catch (error) { setStatus(error.message || "新增分類失敗", "error"); }
}

async function addSemester() {
  const input = $(`[data-new-semester]`);
  try {
    const created = await window.courseCapture.semesters.create(input.value);
    input.value = "";
    showInlineForm("semester", false);
    state.semesters = await window.courseCapture.semesters.list();
    renderFilters();
    els.semester.value = created.name;
    setStatus(`已新增學期「${created.name}」。`);
  } catch (error) { setStatus(error.message || "新增學期失敗", "error"); }
}

async function refreshSources() {
  els.sourceList.innerHTML = `<div class="source-loading">正在讀取螢幕與視窗…</div>`;
  try {
    state.sources = await window.courseCapture.capture.listSources();
    if (!state.sources.length) {
      els.sourceList.innerHTML = `<div class="source-empty">目前找不到可錄製來源，請確認有開啟課程視窗。</div>`;
      state.selectedSourceId = "";
      return;
    }
    els.sourceList.innerHTML = state.sources.map((source) => `<button type="button" class="source-card${source.id === state.selectedSourceId ? " selected" : ""}" data-source-id="${escapeHtml(source.id)}"><img src="${escapeHtml(source.thumbnail)}" alt="" /><span>${escapeHtml(source.name)}</span><small>${source.type === "window" ? "視窗" : "螢幕"}</small></button>`).join("");
    if (!state.selectedSourceId || !state.sources.some((source) => source.id === state.selectedSourceId)) state.selectedSourceId = state.sources[0].id;
    await window.courseCapture.capture.selectSource(state.selectedSourceId);
    $(`[data-source-id="${CSS.escape(state.selectedSourceId)}"]`)?.classList.add("selected");
    const selected = state.sources.find((source) => source.id === state.selectedSourceId);
    if (selected) {
      els.sourceInfo.hidden = false;
      els.sourceName.textContent = selected.name;
      els.sourceMeta.textContent = selected.type === "window" ? "視窗擷取" : "整個螢幕擷取";
    }
  } catch (error) {
    els.sourceList.innerHTML = `<div class="source-empty">無法讀取來源：${escapeHtml(error.message || "請重試")}</div>`;
    setStatus(error.message || "無法讀取錄製來源", "error");
  }
}

async function selectSource(sourceId) {
  try {
    if (!await window.courseCapture.capture.selectSource(sourceId)) throw new Error("無法選擇這個來源");
    state.selectedSourceId = sourceId;
    $$(".source-card", els.sourceList).forEach((card) => card.classList.toggle("selected", card.dataset.sourceId === sourceId));
    const selected = state.sources.find((source) => source.id === sourceId);
    if (selected) { els.sourceInfo.hidden = false; els.sourceName.textContent = selected.name; els.sourceMeta.textContent = selected.type === "window" ? "視窗擷取" : "整個螢幕擷取"; }
    setStatus(`已選擇「${selected?.name || "錄製來源"}」，可以開始。`);
  } catch (error) { setStatus(error.message || "來源選擇失敗", "error"); }
}

function setProgress(data = {}) {
  if (!data.courseId && data.stage !== "model") return;
  els.progressCard.hidden = false;
  els.progressStage.textContent = STAGE_LABELS[data.stage] || String(data.stage || "處理中").toUpperCase();
  els.progressCopy.textContent = String(data.detail || "正在處理課程");
  const progress = Number(data.progress);
  const safe = Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.round(progress))) : 0;
  els.progressPercent.textContent = Number.isFinite(progress) ? `${safe}%` : "…";
  els.progressBar.style.width = `${safe}%`;
  if (data.stage === "error") setStatus(data.detail || "處理失敗", "error");
  else if (data.stage === "complete") setStatus(data.detail || "課程處理完成", "success");
  else if (data.detail) setStatus(data.detail);
}

function renderNotes(note, target, modelLabel = "") {
  if (!note?.json) {
    target.className = "notes-content empty";
    target.innerHTML = `<span>✦</span><b>${note?.status === "error" ? "課程筆記尚未完成" : "完成課後轉錄後整理"}</b><p>${escapeHtml(note?.error || "本機 Qwen 會整理摘要、重點、名詞與複習問題。")}</p>`;
    return;
  }
  const data = note.json;
  const list = (items) => (Array.isArray(items) && items.length ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : `<p class="muted">無資料</p>`);
  target.className = "notes-content";
  target.innerHTML = `${modelLabel ? `<p class="model-label">由 ${escapeHtml(modelLabel)} 整理</p>` : ""}<h3>課程摘要</h3><p>${escapeHtml(data.summary || "無摘要")}</p><h3>核心重點</h3>${list(data.keyPoints)}<h3>重要名詞／公式／定義</h3>${list(data.termsAndFormulas)}<h3>容易混淆或需複習處</h3>${list(data.confusions)}<h3>課後複習問題</h3>${list(data.reviewQuestions)}<h3>一句話總結</h3><p>${escapeHtml(data.takeaway || "無總結")}</p>`;
}

function notePlainText(note) {
  if (!note) return "";
  if (note.text) return note.text;
  const json = note.json;
  if (!json) return "";
  return [`課程摘要\n${json.summary || ""}`, `核心重點\n${(json.keyPoints || []).map((item) => `• ${item}`).join("\n")}`, `重要名詞／公式／定義\n${(json.termsAndFormulas || []).map((item) => `• ${item}`).join("\n")}`, `容易混淆或需複習處\n${(json.confusions || []).map((item) => `• ${item}`).join("\n")}`, `課後複習問題\n${(json.reviewQuestions || []).map((item) => `• ${item}`).join("\n")}`, `一句話總結\n${json.takeaway || ""}`].join("\n\n");
}

async function refreshHomeNotes(courseId = state.courseId) {
  if (!courseId) return;
  try {
    const detail = await window.courseCapture.courses.get(courseId);
    if (!detail) return;
    state.lastDetail = detail;
    renderNotes(detail.notes, els.homeNotes, detail.notes?.model || "本機 Qwen");
    els.homeNotesModel.textContent = detail.notes?.model || (detail.course.status === "ready" ? "已完成" : STATUS_LABELS[detail.course.status] || "處理中");
    els.homeOpen.disabled = false;
    els.homeCopy.disabled = !detail.notes?.json;
  } catch (error) { setStatus(error.message || "無法讀取課程結果", "error"); }
}

function beginProgressForCourse(courseId, detail = "正在準備課程") {
  state.courseId = courseId;
  setProgress({ courseId, stage: "audio", detail, progress: 0 });
  els.homeOpen.disabled = false;
}

function recordingMimeType() {
  const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  return candidates.find((value) => MediaRecorder.isTypeSupported(value)) || "";
}

function concatFloat(a, b) {
  const result = new Float32Array(a.length + b.length);
  result.set(a, 0); result.set(b, a.length);
  return result;
}

function setupPcmCapture(recording, stream) {
  if (!stream.getAudioTracks().length) {
    setStatus("已開始錄影，但沒有取得系統聲音；停止後將無法產生逐字稿。", "error");
    return;
  }
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const mute = context.createGain();
  mute.gain.value = 0;
  recording.audioContext = context;
  recording.audioProcessor = processor;
  recording.pcm = new Float32Array(0);
  recording.pcmStartSample = 0;
  recording.sampleRate = context.sampleRate;
  recording.audioQueue = Promise.resolve();
  const flush = (force = false) => {
    const chunkSamples = Math.round(recording.sampleRate * 20);
    const overlapSamples = Math.round(recording.sampleRate * 2);
    const stepSamples = Math.max(1, chunkSamples - overlapSamples);
    while (recording.pcm.length >= chunkSamples) {
      const payload = recording.pcm.slice(0, chunkSamples);
      const startMs = recording.pcmStartSample / recording.sampleRate * 1000;
      const expectedMs = (recording.pcmStartSample + recording.pcm.length) / recording.sampleRate * 1000;
      recording.audioQueue = recording.audioQueue.then(() => window.courseCapture.recording.audioChunk({ courseId: recording.courseId, samples: payload, sampleRate: recording.sampleRate, startMs, expectedMs }));
      recording.pcm = recording.pcm.slice(stepSamples);
      recording.pcmStartSample += stepSamples;
    }
    if (force && recording.pcm.length > recording.sampleRate * .25) {
      const payload = recording.pcm.slice();
      const startMs = recording.pcmStartSample / recording.sampleRate * 1000;
      const expectedMs = (recording.pcmStartSample + recording.pcm.length) / recording.sampleRate * 1000;
      recording.audioQueue = recording.audioQueue.then(() => window.courseCapture.recording.audioChunk({ courseId: recording.courseId, samples: payload, sampleRate: recording.sampleRate, startMs, expectedMs }));
      recording.pcm = new Float32Array(0);
      recording.pcmStartSample += payload.length;
    }
  };
  processor.onaudioprocess = (event) => {
    if (recording.paused || recording.stopping) return;
    const channel = event.inputBuffer.getChannelData(0);
    recording.pcm = concatFloat(recording.pcm, channel);
    flush(false);
  };
  source.connect(processor);
  processor.connect(mute);
  mute.connect(context.destination);
  recording.flushPcm = flush;
}

async function startRecording() {
  if (state.recording) return;
  if (!state.selectedSourceId) { setStatus("請先在上方選擇要錄製的螢幕或課程視窗。", "error"); return; }
  let course;
  try {
    course = await window.courseCapture.recording.create(courseInput());
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
    await window.courseCapture.recording.begin({ courseId: course.id, ...courseInput() });
    const mimeType = recordingMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const recording = {
      courseId: course.id,
      stream,
      recorder,
      videoQueue: Promise.resolve(),
      audioQueue: Promise.resolve(),
      stopping: false,
      paused: false,
      startedAt: Date.now(),
      pausedAt: 0,
      pausedTotal: 0,
      clockTimer: null,
    };
    state.recording = recording;
    recorder.ondataavailable = (event) => {
      if (!event.data?.size) return;
      recording.videoQueue = recording.videoQueue.then(() => event.data.arrayBuffer()).then((bytes) => window.courseCapture.recording.videoChunk(recording.courseId, bytes));
    };
    recorder.onerror = (event) => { setStatus(`錄影錯誤：${event.error?.message || "無法繼續錄影"}`, "error"); };
    recorder.start(1000);
    setupPcmCapture(recording, stream);
    els.record.classList.add("active");
    els.recordLabel.textContent = "停止錄製";
    els.recordIcon.textContent = "■";
    els.pauseRecording.hidden = false;
    els.pauseRecording.disabled = false;
    els.pauseRecording.textContent = "暫停錄影";
    els.state.textContent = "錄製中";
    els.state.className = "state recording";
    els.upload.disabled = true;
    els.title.disabled = true;
    beginProgressForCourse(course.id, "錄影與背景轉錄已開始");
    startRecordingClock(recording);
    setStatus("正在錄影；課程結束後按停止，系統會完成逐字稿與課程筆記。", "success");
  } catch (error) {
    if (course?.id) { try { await window.courseCapture.courses.update(course.id, { status: "failed", error: error.message }); } catch {} }
    setStatus(`無法開始錄影：${error.message || "請確認已選擇來源"}`, "error");
  }
}

async function toggleRecordingPause(forceAction = "") {
  const recording = state.recording;
  if (!recording || recording.stopping) return;
  const shouldResume = forceAction === "resume" || (!forceAction && recording.paused);
  const shouldPause = forceAction === "pause" || (!forceAction && !recording.paused);
  try {
    if (shouldPause && !recording.paused) {
      if (recording.recorder.state === "recording") recording.recorder.pause();
      await recording.audioContext?.suspend();
      recording.paused = true;
      recording.pausedAt = Date.now();
      els.pauseRecording.textContent = "繼續錄影";
      els.state.textContent = "已暫停";
      setStatus("錄影已暫停；按「繼續錄影」後接續同一堂課。", "success");
    } else if (shouldResume && recording.paused) {
      recording.pausedTotal += Date.now() - recording.pausedAt;
      recording.pausedAt = 0;
      recording.paused = false;
      await recording.audioContext?.resume();
      if (recording.recorder.state === "paused") recording.recorder.resume();
      els.pauseRecording.textContent = "暫停錄影";
      els.state.textContent = "錄製中";
      setStatus("已繼續錄影與背景轉錄。", "success");
    }
    publishRecordingWidget();
  } catch (error) {
    setStatus(`無法${recording.paused ? "繼續" : "暫停"}錄影：${error.message || "請再試一次"}`, "error");
  }
}

async function stopRecording() {
  const recording = state.recording;
  if (!recording || recording.stopping) return;
  recording.stopping = true;
  clearInterval(recording.clockTimer);
  els.record.disabled = true;
  els.pauseRecording.disabled = true;
  setStatus("正在保存影片並完成最後一段背景轉錄…");
  try {
    recording.flushPcm?.(true);
    await new Promise((resolve) => {
      if (recording.recorder.state === "inactive") resolve();
      else { recording.recorder.addEventListener("stop", resolve, { once: true }); recording.recorder.stop(); }
    });
    recording.stream.getTracks().forEach((track) => track.stop());
    recording.audioProcessor?.disconnect();
    recording.audioContext?.close().catch(() => {});
    let queueError = null;
    try { await recording.videoQueue; } catch (error) { queueError = error; }
    try { await recording.audioQueue; } catch (error) { queueError = queueError || error; }
    await window.courseCapture.recording.finish(recording.courseId);
    state.courseId = recording.courseId;
    setProgress({ courseId: recording.courseId, stage: "transcribe", detail: "影片已保存，正在完成課程結果", progress: 60 });
    setStatus(queueError ? "錄影已保存，但有一段背景處理失敗；資料庫保留目前內容，可重試。" : "影片已保存，正在完成逐字稿與課程筆記；可到資料庫查看進度。", queueError ? "error" : "success");
  } catch (error) {
    setStatus(`停止錄製時發生問題：${error.message || "請重新開啟應用程式查看草稿"}`, "error");
  } finally {
    state.recording = null;
    window.courseCapture.widget.update({ visible: false, recording: false, paused: false, elapsedMs: recordingElapsed(recording), title: els.title.value.trim() }).catch(() => {});
    els.record.disabled = false;
    els.record.classList.remove("active");
    els.recordLabel.textContent = "開始錄製";
    els.recordIcon.textContent = "●";
    els.pauseRecording.hidden = true;
    els.pauseRecording.disabled = false;
    els.pauseRecording.textContent = "暫停錄影";
    if (els.recordingWidget) els.recordingWidget.hidden = true;
    els.state.textContent = "處理中";
    els.state.className = "state";
    els.upload.disabled = false;
    els.title.disabled = false;
  }
}

async function uploadMedia() {
  if (state.recording) return;
  try {
    const chosen = await window.courseCapture.media.choose();
    if (chosen.canceled) return;
    const course = await window.courseCapture.courses.create({ ...courseInput(), source: "upload" });
    state.courseId = course.id;
    beginProgressForCourse(course.id, `正在匯入${chosen.mediaType === "video" ? "影片" : "錄音"}`);
    els.state.textContent = "檔案已匯入";
    const media = await window.courseCapture.courses.importMedia(course.id, chosen.sourceId);
    const job = await window.courseCapture.transcription.start(course.id, media.id, course.language);
    setStatus(`已匯入「${chosen.name}」，Whisper 正在本機轉錄。工作編號 ${job.jobId.slice(0, 8)}。`, "success");
  } catch (error) { setStatus(`匯入失敗：${error.message || "請重新選擇檔案"}`, "error"); }
}

function renderModelStatus() {
  const modelState = state.models;
  const installed = new Set(modelState.models || []);
  if (els.cancelModel) els.cancelModel.hidden = !state.modelPulling;
  if (els.cancelModel) els.cancelModel.textContent = state.modelPulling ? `取消 ${state.modelPulling}` : "取消下載";
  els.model.innerHTML = (modelState.choices || []).map((choice) => `<option value="${escapeHtml(choice.name)}"${choice.name === modelState.selected ? " selected" : ""}>${escapeHtml(choice.label)}</option>`).join("");
  if (!modelState.choices?.length) els.model.innerHTML = `<option value="qwen3:4b">Qwen 3 · 快速</option><option value="qwen3:8b">Qwen 3 · 高品質</option>`;
  els.ollamaBadge.textContent = modelState.available ? "Ollama 已連線" : "需要設定";
  els.ollamaBadge.className = modelState.available ? "ollama-ok" : "ollama-error";
  if (!modelState.available) {
    els.modelStatus.innerHTML = `<p class="ollama-error">尚未連線到本機 Ollama。</p><p>安裝後啟動 Ollama，再下載一個 Qwen 模型即可使用免費本機 AI 整理。</p>`;
    return;
  }
  els.modelStatus.innerHTML = (modelState.choices || []).map((choice) => {
    const has = installed.has(choice.name);
    return `<div class="model-choice${choice.name === modelState.selected ? " selected" : ""}"><b>${escapeHtml(choice.label)}${has ? " · 已下載" : ""}</b><button type="button" data-model-action="${has ? "remove" : "pull"}" data-model="${escapeHtml(choice.name)}" class="${has ? "remove" : ""}">${has ? "移除" : "下載"}</button><small>${escapeHtml(choice.name)} · ${escapeHtml(choice.size)}</small><div class="model-progress"><i data-model-progress="${escapeHtml(choice.name)}"></i></div></div>`;
  }).join("");
}

async function refreshModels() {
  try { state.models = await window.courseCapture.models.status(); renderModelStatus(); }
  catch (error) { els.ollamaBadge.textContent = "需要設定"; setStatus(error.message || "無法檢查 Ollama", "error"); }
}

async function handleModelAction(action, model) {
  try {
    if (action === "pull") {
      state.modelPulling = model;
      renderModelStatus();
      setStatus(`正在下載 ${model}，第一次可能需要一些時間…`);
      await window.courseCapture.models.pull(model);
    }
    else await window.courseCapture.models.remove(model);
  } catch (error) { setStatus(error.message || "模型操作失敗", "error"); }
  finally {
    state.modelPulling = "";
    await refreshModels();
  }
}

async function cancelModelPull() {
  if (!state.modelPulling) return;
  try {
    await window.courseCapture.models.cancel();
    setStatus(`已取消 ${state.modelPulling} 下載。`, "success");
  } catch (error) { setStatus(error.message || "取消模型下載失敗", "error"); }
}

async function refreshCourses() {
  try {
    state.courses = await window.courseCapture.courses.list({ search: els.dbSearch.value, categoryId: els.dbCategory.value, semester: els.dbSemester.value, mediaType: els.dbType.value, status: els.dbStatus.value, trash: state.trashMode });
    els.dbCount.textContent = String(state.courses.length);
    if (!state.courses.length) { els.courseList.innerHTML = `<div class="list-empty">${state.trashMode ? "回收桶目前是空的。" : "還沒有課程，先從首頁匯入或錄製一堂課。"}</div>`; return; }
    els.courseList.innerHTML = state.courses.map((course) => `<button type="button" class="course-card ${course.status || ""}${course.id === state.selectedCourseId ? " selected" : ""}" data-course-id="${escapeHtml(course.id)}"><b>${escapeHtml(course.title)}</b><small>${escapeHtml(course.categoryName || "未分類")} · ${escapeHtml(course.semester || "未指定")} · ${(course.mediaTypes || []).map((item) => item === "video" ? "影片" : "錄音").join("／") || "尚無媒體"}</small><small>${course.segmentCount || 0} 個逐字稿片段 · ${new Date(course.updated_at).toLocaleString("zh-TW")}</small><span class="course-status">${STATUS_LABELS[course.status] || course.status}</span></button>`).join("");
  } catch (error) { els.courseList.innerHTML = `<div class="list-empty">無法載入資料庫：${escapeHtml(error.message || "請重試")}</div>`; setDatabaseMessage(error.message || "資料庫讀取失敗"); }
}

function renderDetailNotes(note) {
  if (!note?.json) return `<div class="empty"><span>✦</span><b>${note?.status === "error" ? "整理失敗" : "尚未產生筆記"}</b><p>${escapeHtml(note?.error || "完成逐字稿後可使用本機 Qwen 整理。")}</p></div>`;
  const json = note.json;
  const list = (items) => (items || []).length ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : `<p class="muted">無資料</p>`;
  return `<p class="model-label">模型：${escapeHtml(note.model || "本機 Qwen")}</p><h3>課程摘要</h3><p>${escapeHtml(json.summary || "無摘要")}</p><h3>核心重點</h3>${list(json.keyPoints)}<h3>重要名詞／公式／定義</h3>${list(json.termsAndFormulas)}<h3>容易混淆或需複習處</h3>${list(json.confusions)}<h3>課後複習問題</h3>${list(json.reviewQuestions)}<h3>一句話總結</h3><p>${escapeHtml(json.takeaway || "無總結")}</p>`;
}

function renderCourseDetail(detail) {
  if (!detail) { els.courseDetail.hidden = true; return; }
  const course = detail.course;
  const video = detail.media.find((item) => item.mediaType === "video" && item.mediaUrl);
  const mediaText = detail.media.map((item) => `${item.mediaType === "video" ? "影片" : "錄音"} · ${formatBytes(item.size)}`).join("／") || "尚無媒體";
  const segments = detail.segments.length
    ? detail.segments.map((item) => `<button type="button" class="segment" data-start-ms="${Number(item.startMs) || 0}"><time>${formatTime(item.startMs)}</time><span>${escapeHtml(item.text)}</span></button>`).join("")
    : `<div class="list-empty">目前沒有逐字稿片段。</div>`;
  const trash = Boolean(course.deleted_at);
  els.courseDetail.hidden = false;
  els.courseDetail.innerHTML = `<div class="detail-header"><div><button type="button" class="quiet-button" data-detail-back>← 返回列表</button><h2>${escapeHtml(course.title)}</h2><small>${escapeHtml(course.categoryName || "未分類")} · ${escapeHtml(course.semester || "未指定")} · ${escapeHtml(mediaText)} · ${STATUS_LABELS[course.status] || course.status}</small></div><div class="detail-actions">${trash ? `<button type="button" data-detail-action="restore">還原</button><button type="button" class="danger" data-detail-action="delete">永久刪除</button>` : `<button type="button" data-detail-action="retry">重新轉錄</button><button type="button" data-detail-action="notes">重新整理筆記</button><button type="button" class="danger" data-detail-action="trash">移到回收桶</button>`}</div></div>${video ? `<div class="media-preview"><video controls preload="metadata" data-detail-video src="${escapeHtml(video.mediaUrl)}"></video></div>` : detail.media.length ? `<div class="audio-note">這門課是錄音檔。依設定不顯示影音預覽，但保留逐字稿時間戳。</div>` : ""}<div class="detail-grid"><section class="detail-section"><h3>完整逐字稿 · ${detail.segments.length} 段</h3><div class="detail-transcript" data-detail-transcript>${segments}</div></section><section class="detail-section"><h3>課程筆記</h3><div class="detail-note">${renderDetailNotes(detail.notes)}</div></section></div>${course.error ? `<div class="retry-box">${escapeHtml(course.error)}<br />可按上方重新轉錄或重新整理筆記。</div>` : ""}`;
  const player = $(`[data-detail-video]`, els.courseDetail);
  if (player) {
    player.addEventListener("timeupdate", () => {
      const current = player.currentTime * 1000;
      $$(".segment", els.courseDetail).forEach((item) => item.classList.toggle("active", Number(item.dataset.startMs) <= current && Number(item.dataset.startMs) + 20000 > current));
    });
  }
}

async function openCourse(courseId) {
  state.selectedCourseId = courseId;
  try { state.lastDetail = await window.courseCapture.courses.get(courseId); renderCourseDetail(state.lastDetail); await refreshCourses(); setDatabaseMessage("點擊逐字稿時間戳可跳到影片片段。"); }
  catch (error) { setDatabaseMessage(error.message || "無法開啟課程"); }
}

async function handleDetailAction(action) {
  const id = state.selectedCourseId;
  if (!id) return;
  try {
    if (action === "back") { state.selectedCourseId = ""; els.courseDetail.hidden = true; return; }
    if (action === "trash") { await window.courseCapture.courses.trash(id); setDatabaseMessage("課程已移到應用內回收桶。30 天內可還原。"); }
    if (action === "restore") { await window.courseCapture.courses.restore(id); setDatabaseMessage("課程已還原。"); }
    if (action === "delete") { if (!window.confirm("永久刪除這門課程及其媒體？媒體會移到 Windows 回收桶。")) return; await window.courseCapture.courses.deletePermanently(id); state.selectedCourseId = ""; els.courseDetail.hidden = true; setDatabaseMessage("課程已永久刪除。"); }
    if (action === "retry") { const job = await window.courseCapture.transcription.retry(id); setDatabaseMessage(`已重新開始轉錄，工作編號 ${job.jobId.slice(0, 8)}。`); }
    if (action === "notes") { await window.courseCapture.notes.generate(id, state.models.selected); setDatabaseMessage("課程筆記已重新整理。"); }
    await openCourse(state.selectedCourseId || id);
  } catch (error) { setDatabaseMessage(error.message || "操作失敗"); }
}

els.nav.forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
els.record.addEventListener("click", () => state.recording ? stopRecording() : startRecording());
els.pauseRecording.addEventListener("click", () => toggleRecordingPause());
els.widgetPause.addEventListener("click", () => toggleRecordingPause());
els.widgetStop.addEventListener("click", stopRecording);
els.widgetMinimize.addEventListener("click", () => window.courseCapture.widget.show());
els.upload.addEventListener("click", uploadMedia);
$(`[data-refresh-sources]`).addEventListener("click", refreshSources);
$(`[data-add-category]`).addEventListener("click", () => showInlineForm("category", true));
$(`[data-add-semester]`).addEventListener("click", () => showInlineForm("semester", true));
$(`[data-save-category]`).addEventListener("click", addCategory);
$(`[data-save-semester]`).addEventListener("click", addSemester);
$(`[data-cancel-category]`).addEventListener("click", () => showInlineForm("category", false));
$(`[data-cancel-semester]`).addEventListener("click", () => showInlineForm("semester", false));
els.sourceList.addEventListener("click", (event) => { const card = event.target.closest("[data-source-id]"); if (card) selectSource(card.dataset.sourceId); });
els.homeOpen.addEventListener("click", () => { setView("database"); if (state.courseId) openCourse(state.courseId); });
els.homeCopy.addEventListener("click", async () => { if (!state.lastDetail?.notes) return; await navigator.clipboard.writeText(notePlainText(state.lastDetail.notes)); setStatus("課程筆記已複製到剪貼簿。", "success"); });
$(`[data-refresh-models]`).addEventListener("click", refreshModels);
$(`[data-cancel-model]`).addEventListener("click", cancelModelPull);
$(`[data-open-ollama]`).addEventListener("click", () => window.courseCapture.models.openDownload());
els.modelStatus.addEventListener("click", (event) => { const button = event.target.closest("[data-model-action]"); if (button) handleModelAction(button.dataset.modelAction, button.dataset.model); });
els.model.addEventListener("change", async () => { try { state.models.selected = els.model.value; await window.courseCapture.models.select(els.model.value); } catch (error) { setStatus(error.message || "模型選擇失敗", "error"); } });
$(`[data-back-home]`).addEventListener("click", () => setView("home"));
$(`[data-toggle-trash]`).addEventListener("click", (event) => { state.trashMode = !state.trashMode; event.currentTarget.textContent = state.trashMode ? "返回課程" : "回收桶"; state.selectedCourseId = ""; els.courseDetail.hidden = true; refreshCourses(); });
[els.dbSearch, els.dbCategory, els.dbSemester, els.dbType, els.dbStatus].forEach((control) => {
  control.addEventListener("input", refreshCourses);
  control.addEventListener("change", refreshCourses);
});
els.courseList.addEventListener("click", (event) => { const card = event.target.closest("[data-course-id]"); if (card) openCourse(card.dataset.courseId); });
els.courseDetail.addEventListener("click", (event) => {
  const segment = event.target.closest("[data-start-ms]");
  if (segment) { const player = $(`[data-detail-video]`, els.courseDetail); if (player) { player.currentTime = Number(segment.dataset.startMs) / 1000; player.play().catch(() => {}); } return; }
  const button = event.target.closest("[data-detail-back], [data-detail-action]");
  if (button) handleDetailAction(button.dataset.detailAction || "back");
});

window.courseCapture.onProgress((data) => {
  if (data?.courseId && data.courseId !== state.courseId && data.courseId !== state.selectedCourseId) return;
  setProgress(data);
  if (data?.courseId && (data.stage === "complete" || data.stage === "error")) {
    refreshHomeNotes(data.courseId);
    if (state.view === "database" && state.selectedCourseId === data.courseId) openCourse(data.courseId);
  }
});
window.courseCapture.onModelProgress((data) => {
  const progress = $(`[data-model-progress="${CSS.escape(data.model)}"]`);
  if (progress && Number.isFinite(Number(data.progress))) progress.style.width = `${data.progress}%`;
  if (data.status === "error") setStatus(data.detail || "模型下載失敗", "error");
});
window.courseCapture.onCourseUpdated((data) => {
  if (data?.courseId === state.courseId) refreshHomeNotes(data.courseId);
  if (state.view === "database") { refreshCourses(); if (state.selectedCourseId === data?.courseId) openCourse(data.courseId); }
});
window.courseCapture.onFocus(() => { if (state.view === "home") refreshSources(); });
window.courseCapture.widget.onAction((action) => {
  if (action === "pause" || action === "resume") toggleRecordingPause(action);
  if (action === "stop") stopRecording();
});

async function initialize() {
  try {
    [state.categories, state.semesters] = await Promise.all([window.courseCapture.categories.list(), window.courseCapture.semesters.list()]);
    renderFilters();
    await Promise.all([refreshSources(), refreshModels(), refreshCourses()]);
    const info = await window.courseCapture.app.info();
    setStatus(`CourseScribe ${info.version} 已準備完成。選擇來源後即可開始。`);
  } catch (error) { setStatus(`初始化失敗：${error.message || "請重新開啟應用程式"}`, "error"); }
}

initialize();
