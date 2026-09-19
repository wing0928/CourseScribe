const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const els = {
  views: $$(`[data-view-panel]`),
  nav: $$(`[data-view]`),
  title: $(`[data-course-title]`),
  category: $(`[data-category]`),
  semester: $(`[data-semester]`),
  language: $(`[data-language]`),
  whisperModel: $(`[data-whisper-model]`),
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
  progressEta: $(`[data-progress-eta]`),
  homeNotes: $(`[data-home-notes]`),
  homeTranscript: $(`[data-home-transcript]`),
  reviewTabs: $$(`[data-review-tab]`),
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
  homeReviewTab: "summary",
  homeTranscriptLimit: 160,
  detailTranscriptLimit: 160,
  models: { available: false, models: [], choices: [], selected: "qwen3:4b" },
  modelPulling: "",
  recording: null,
  notesProgress: new Map(),
  courseProgress: new Map(),
  detailProcessRefreshRunning: false,
  detailTranscriptLanguage: "original",
};

const STATUS_LABELS = {
  draft: "草稿", recording: "錄製中", transcribing: "轉錄中", summarizing: "整理中", ready: "已完成", failed: "需處理",
};
const STAGE_LABELS = { model: "WHISPER", audio: "準備音訊", recording: "錄影中", transcribe: "轉錄中", notes: "整理筆記", translate: "翻譯逐字稿", complete: "完成", stopped: "已停止", error: "需要處理" };

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
}

function formatNoteText(value) {
  const text = String(value ?? "");
  const math = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
  let html = "";
  let start = 0;
  for (const match of text.matchAll(math)) {
    html += escapeHtml(text.slice(start, match.index));
    try { html += window.katex?.renderToString(match[1] || match[2], { displayMode: Boolean(match[1]), throwOnError: false, trust: false, strict: "ignore" }) || escapeHtml(match[0]); }
    catch { html += escapeHtml(match[0]); }
    start = match.index + match[0].length;
  }
  return html + escapeHtml(text.slice(start));
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
  if (els.progressEta) els.progressEta.textContent = data.stage === "notes" ? `本機 ${data.model || "Ollama"} · 預估剩餘時間：${formatEta(data.etaSeconds)}` : "";
  if (data.stage === "error") setStatus(data.detail || "處理失敗", "error");
  else if (data.stage === "complete") setStatus(data.detail || "課程處理完成", "success");
  else if (data.detail) setStatus(data.detail);
}

function formatEta(seconds) {
  if (!Number.isFinite(Number(seconds)) || seconds == null) return "估算中";
  const minutes = Math.ceil(Math.max(0, Number(seconds)) / 60);
  if (minutes < 1) return "約 1 分鐘內";
  if (minutes < 60) return `約 ${minutes} 分鐘`;
  return `約 ${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分鐘`;
}

function renderNotes(note, target, modelLabel = "") {
  if (!note?.json) {
    target.className = "notes-content empty";
    target.innerHTML = `<span>✦</span><b>${note?.status === "error" ? "課程筆記尚未完成" : "完成課後轉錄後整理"}</b><p>${escapeHtml(note?.error || "本機 AI 會依逐字稿整理各主題、全課概覽與複習問題。")}</p>`;
    return;
  }
  const data = note.json;
  target.className = "notes-content";
  target.innerHTML = `${modelLabel ? `<p class="model-label">由 ${escapeHtml(modelLabel)} 整理${note.status === "processing" ? " · 正在更新，以下為前次筆記" : note.status === "error" ? " · 本次更新失敗，以下為前次筆記" : ""}</p>` : ""}${renderNoteBody(data)}`;
}

function renderNoteBody(data) {
  const annotations = Array.isArray(data.annotations) ? data.annotations : [];
  const referenced = new Set();
  const annotate = (value) => {
    let html = formatNoteText(value || "");
    for (const [index, annotation] of annotations.entries()) {
      if (referenced.has(annotation.term)) continue;
      const term = escapeHtml(annotation.term);
      if (!term || !html.includes(term)) continue;
      html = html.replace(term, `${term}<button type="button" class="footnote-link" data-footnote-id="footnote-${index}" aria-label="查看註釋 ${term}">[${index + 1}]</button>`);
      referenced.add(annotation.term);
    }
    return html;
  };
  const list = (items) => (Array.isArray(items) && items.length ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : `<p class="muted">無資料</p>`);
  const points = (items) => (Array.isArray(items) && items.length ? `<ul class="evidence-points">${items.map((raw) => {
    const point = typeof raw === "string" ? { text: raw } : raw || {};
    const matched = point.status === "source_matched" && point.quote && point.timestamp;
    const stamp = matched ? `<span class="evidence-stamp">[${escapeHtml(point.timestamp)}]</span> ` : "";
    const source = matched ? point.quote : point.quote ? `引文未在逐字稿中吻合：「${point.quote}」` : "沒有可回查的原文；舊版筆記請重新整理。";
    return `<li>${point.kind === "extension" ? `<small class="note-extension">補充／可能考</small>` : ""}<div class="note-point-text">${annotate(point.text || "")}</div><details class="note-source"><summary><span class="evidence-status ${matched ? "matched" : "pending"}">${stamp}${matched ? "原文吻合 · 查看依據" : "待核 · 查看原因"}</span></summary><blockquote>${escapeHtml(source)}</blockquote></details></li>`;
  }).join("")}</ul>` : `<p class="muted">無資料</p>`);
  const sections = (data.sections || []).map((section) => `<section class="note-topic"><h3>${escapeHtml(section.title)}${section.timestamp ? ` <small>[${escapeHtml(section.timestamp)}]</small>` : ""}</h3>${points(section.points)}</section>`).join("");
  const summary = String(data.summary || "").replace(/^本課涵蓋：[^。]+。/, "").trim() || `已整理 ${(data.sections || []).length} 個課程主題，請依下方時間戳核對。`;
  const footnotes = annotations.length ? `<section class="note-footnotes"><h3>註釋</h3><ol>${annotations.map((item, index) => `<li id="footnote-${index}"><b>${escapeHtml(item.term)}</b>：${escapeHtml(item.note)}</li>`).join("")}</ol></section>` : "";
  return `<p class="note-caveat">AI 依逐字稿歸納主題，並非事實查核；人名、公式或轉錄疑點請回看原片。每個重點可展開原文依據。</p><section class="note-overview"><h3>全課主題概覽</h3><p>${annotate(summary)}</p></section>${sections}<section class="note-followup"><h3>待確認／容易混淆處</h3>${list(data.confusions)}<h3>課後複習問題</h3>${list(data.reviewQuestions)}<h3>一句話總結</h3><p>${annotate(data.takeaway || "無總結")}</p></section>${footnotes}`;
}

function applyTranscriptCorrections(value, annotations = []) {
  let text = String(value || "");
  for (const annotation of annotations) {
    for (const alias of Array.isArray(annotation.aliases) ? annotation.aliases : []) {
      const escaped = String(alias || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (escaped) text = text.replace(new RegExp(escaped, "gi"), String(annotation.term || alias));
    }
  }
  return text;
}

function setHomeReviewTab(tab) {
  state.homeReviewTab = tab === "transcript" ? "transcript" : "summary";
  els.homeNotes.hidden = state.homeReviewTab !== "summary";
  els.homeTranscript.hidden = state.homeReviewTab !== "transcript";
  for (const button of els.reviewTabs) button.setAttribute("aria-selected", String(button.dataset.reviewTab === state.homeReviewTab));
  els.homeCopy.hidden = state.homeReviewTab !== "summary";
}

function renderHomeTranscript(segments = []) {
  const visible = segments.slice(0, state.homeTranscriptLimit);
  const more = segments.length > visible.length
    ? `<button type="button" class="quiet-button transcript-more" data-home-transcript-more>載入更多逐字稿（尚餘 ${segments.length - visible.length} 段）</button>`
    : "";
  els.homeTranscript.innerHTML = segments.length
    ? `${visible.map((item) => `<div class="home-transcript-line"><time>${formatTime(item.startMs)}</time><span>${escapeHtml(item.text)}</span></div>`).join("")}${more}`
    : `<p class="muted">尚未產生逐字稿；錄影與轉錄完成後會顯示在這裡。</p>`;
}

function notePlainText(note) {
  if (!note) return "";
  const json = note.json;
  if (!json) return note.text || "";
  const summary = String(json.summary || "").replace(/^本課涵蓋：[^。]+。/, "").trim();
  return [`全課概覽\n${summary}`, ...(json.sections || []).map((section) => `${section.title}${section.timestamp ? ` [${section.timestamp}]` : ""}\n${(section.points || []).map((raw) => {
    const point = typeof raw === "string" ? { text: raw } : raw || {};
    return `• ${point.kind === "extension" ? "【補充／可能考】" : ""}${point.text || ""}（${point.status === "source_matched" ? `原文吻合 [${point.timestamp}]：「${point.quote}」` : `待核${point.quote ? `：引文未吻合「${point.quote}」` : "：無可回查原文"}`}）`;
  }).join("\n")}`), `待確認／容易混淆處\n${(json.confusions || []).map((item) => `• ${item}`).join("\n")}`, `課後複習問題\n${(json.reviewQuestions || []).map((item) => `• ${item}`).join("\n")}`, `一句話總結\n${json.takeaway || ""}`].join("\n\n");
}

async function refreshHomeNotes(courseId = state.courseId) {
  if (!courseId) return;
  try {
    const detail = await window.courseCapture.courses.get(courseId);
    if (!detail) return;
    state.lastDetail = detail;
    renderNotes(detail.notes, els.homeNotes, detail.notes?.model || "本機 AI");
    renderHomeTranscript(detail.segments);
    setHomeReviewTab(state.homeReviewTab);
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
    throw new Error("沒有取得系統聲音；請確認課程正在播放，並重新選擇可擷取聲音的螢幕或視窗。");
  }
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const mute = context.createGain();
  mute.gain.value = 0;
  recording.audioContext = context;
  recording.audioProcessor = processor;
  recording.pcm = new Float32Array(0);
  recording.pcmStartSample = Math.round((recording.audioElapsedMs || 0) / 1000 * context.sampleRate);
  recording.sampleRate = context.sampleRate;
  recording.audioQueue ||= Promise.resolve();
  recording.audioLost = false;
  recording.audioSignalSamples = 0;
  recording.audioSignalPeak = 0;
  recording.audioSignalChecked = false;
  for (const track of stream.getAudioTracks()) {
    track.addEventListener("ended", () => {
      recording.audioLost = true;
      setStatus("系統音訊已中斷；影片仍在錄製，但逐字稿已暫停。請先暫停再繼續，以重新取得音訊。", "error");
    }, { once: true });
  }
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
    if (recording.paused || recording.stopping || recording.audioLost) return;
    const channel = event.inputBuffer.getChannelData(0);
    if (!recording.audioSignalChecked) {
      for (const value of channel) recording.audioSignalPeak = Math.max(recording.audioSignalPeak, Math.abs(value));
      recording.audioSignalSamples += channel.length;
      if (recording.audioSignalSamples >= recording.sampleRate * 5) {
        recording.audioSignalChecked = true;
        if (recording.audioSignalPeak < 0.005) setStatus("尚未偵測到有效的系統聲音。請確認課程正在播放且來源未靜音；無聲片段不會產生逐字稿。", "error");
        else if (recording.segmentIndex > 0) setStatus("已確認恢復錄影後有系統聲音。", "success");
      }
    }
    recording.pcm = concatFloat(recording.pcm, channel);
    flush(false);
  };
  source.connect(processor);
  processor.connect(mute);
  mute.connect(context.destination);
  recording.flushPcm = flush;
}

function startCaptureSegment(recording, stream) {
  recording.stream = stream;
  setupPcmCapture(recording, stream);
  const mimeType = recordingMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  recording.recorder = recorder;
  recorder.ondataavailable = (event) => {
    if (!event.data?.size) return;
    recording.videoQueue = recording.videoQueue.then(() => event.data.arrayBuffer()).then((bytes) => window.courseCapture.recording.videoChunk(recording.courseId, bytes));
  };
  recorder.onerror = (event) => { setStatus(`錄影錯誤：${event.error?.message || "無法繼續錄影"}`, "error"); };
  recorder.start(1000);
}

async function closeCaptureSegment(recording) {
  recording.flushPcm?.(true);
  recording.audioElapsedMs = recording.pcmStartSample / recording.sampleRate * 1000;
  const recorder = recording.recorder;
  if (recorder && recorder.state !== "inactive") await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("停止錄影片段逾時；原始資料已保留，請重新開啟應用程式查看草稿。")), 10000);
    recorder.addEventListener("stop", () => { clearTimeout(timeout); resolve(); }, { once: true });
    try { recorder.stop(); } catch (error) { clearTimeout(timeout); reject(error); }
  });
  await recording.videoQueue;
  recording.stream?.getTracks().forEach((track) => track.stop());
  recording.audioProcessor?.disconnect();
  await recording.audioContext?.close();
  recording.recorder = null;
  recording.stream = null;
  return window.courseCapture.recording.pause(recording.courseId);
}

async function startRecording() {
  if (state.recording) return;
  if (!state.selectedSourceId) { setStatus("請先在上方選擇要錄製的螢幕或課程視窗。", "error"); return; }
  let course;
  let stream;
  try {
    course = await window.courseCapture.recording.create(courseInput());
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
    if (!stream.getAudioTracks().some((track) => track.readyState === "live")) throw new Error("錄影來源沒有可用的系統音訊軌，請改選可錄到課程聲音的來源。");
    await window.courseCapture.recording.begin({ courseId: course.id, ...courseInput() });
    const recording = {
      courseId: course.id,
      stream,
      recorder: null,
      videoQueue: Promise.resolve(),
      audioQueue: Promise.resolve(),
      audioElapsedMs: 0,
      stopping: false,
      paused: false,
      startedAt: Date.now(),
      pausedAt: 0,
      pausedTotal: 0,
      clockTimer: null,
    };
    state.recording = recording;
    startCaptureSegment(recording, stream);
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
    stream?.getTracks().forEach((track) => track.stop());
    if (state.recording?.courseId === course?.id) {
      state.recording.audioProcessor?.disconnect();
      state.recording.audioContext?.close().catch(() => {});
      state.recording = null;
    }
    if (course?.id) { try { await window.courseCapture.courses.update(course.id, { status: "failed", error: error.message }); } catch {} }
    setStatus(`無法開始錄影：${error.message || "請確認已選擇來源"}`, "error");
  }
}

async function toggleRecordingPause(forceAction = "") {
  const recording = state.recording;
  if (!recording || recording.stopping || recording.transitioning) return;
  recording.transitioning = true;
  els.pauseRecording.disabled = true;
  els.record.disabled = true;
  const shouldResume = forceAction === "resume" || (!forceAction && recording.paused);
  const shouldPause = forceAction === "pause" || (!forceAction && !recording.paused);
  try {
    if (shouldPause && !recording.paused) {
      recording.paused = true;
      recording.pausedAt = Date.now();
      const health = await closeCaptureSegment(recording);
      els.pauseRecording.textContent = "繼續錄影";
      els.state.textContent = "已暫停";
      setStatus(health.audioOk ? "錄影已暫停；繼續時會重新取得系統聲音。" : "錄影已暫停，但本段聲音可能提早中斷；影片已保留，繼續時會重新取得音訊。", health.audioOk ? "success" : "error");
    } else if (shouldResume && recording.paused) {
      const sources = await window.courseCapture.capture.listSources();
      if (!sources.some((source) => source.id === state.selectedSourceId) || !await window.courseCapture.capture.selectSource(state.selectedSourceId)) {
        throw new Error("原課程視窗或螢幕來源已不存在；請在首頁重新選擇來源後再繼續。");
      }
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
      if (!stream.getAudioTracks().some((track) => track.readyState === "live")) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("重新擷取後仍沒有系統音訊；錄影維持暫停，請重新選擇來源。");
      }
      try {
        await window.courseCapture.recording.resume(recording.courseId);
        recording.videoQueue = Promise.resolve();
        recording.segmentIndex = (recording.segmentIndex || 0) + 1;
        startCaptureSegment(recording, stream);
      } catch (error) {
        stream.getTracks().forEach((track) => track.stop());
        recording.audioProcessor?.disconnect();
        recording.audioContext?.close().catch(() => {});
        await window.courseCapture.recording.pause(recording.courseId).catch(() => {});
        throw error;
      }
      recording.pausedTotal += Date.now() - recording.pausedAt;
      recording.pausedAt = 0;
      recording.paused = false;
      els.pauseRecording.textContent = "暫停錄影";
      els.state.textContent = "錄製中";
      setStatus("已重新取得系統音訊軌，正在確認是否有有效聲音。", "success");
    }
    publishRecordingWidget();
  } catch (error) {
    setStatus(`暫停／繼續錄影失敗：${error.message || "請再試一次"}。原始片段已保留，必要時請按停止。`, "error");
  } finally {
    recording.transitioning = false;
    els.pauseRecording.disabled = false;
    els.record.disabled = false;
  }
}

async function stopRecording() {
  const recording = state.recording;
  if (!recording || recording.stopping || recording.transitioning) return;
  recording.stopping = true;
  clearInterval(recording.clockTimer);
  els.record.disabled = true;
  els.pauseRecording.disabled = true;
  setStatus("正在保存影片並完成最後一段背景轉錄…");
  try {
    if (!recording.paused) await closeCaptureSegment(recording);
    let queueError = null;
    try { await recording.videoQueue; } catch (error) { queueError = error; }
    try { await recording.audioQueue; } catch (error) { queueError = queueError || error; }
    await window.courseCapture.recording.finish(recording.courseId);
    state.courseId = recording.courseId;
    setProgress({ courseId: recording.courseId, stage: "transcribe", detail: "影片已保存，正在完成課程結果", progress: 60 });
    setStatus(queueError ? "錄影已停止，但有一段背景處理失敗；請到資料庫確認檔案。" : "錄影已停止，正在合併片段並檢查音軌；完成後可到資料庫查看。", queueError ? "error" : "success");
  } catch (error) {
    await window.courseCapture.recording.finish(recording.courseId).catch(() => {});
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
  els.upload.disabled = true;
  try {
    const chosen = await window.courseCapture.media.choose();
    if (chosen.canceled) return;
    const course = await window.courseCapture.courses.create({ ...courseInput(), source: "upload" });
    state.courseId = course.id;
    beginProgressForCourse(course.id, `正在匯入${chosen.mediaType === "video" ? "影片" : "錄音"}`);
    els.state.textContent = "檔案已匯入";
    setStatus(`正在安全匯入「${chosen.name}」…`);
    const media = await window.courseCapture.courses.importMedia(course.id, chosen.sourceId);
    const job = await window.courseCapture.transcription.start(course.id, media.id, course.language);
    setStatus(`已匯入「${chosen.name}」，Whisper 正在本機轉錄。工作編號 ${job.jobId.slice(0, 8)}。`, "success");
  } catch (error) { setStatus(`匯入失敗：${error.message || "請重新選擇檔案"}`, "error"); }
  finally { els.upload.disabled = false; }
}

function renderModelStatus() {
  const modelState = state.models;
  const installed = new Set(modelState.models || []);
  if (els.cancelModel) els.cancelModel.hidden = !state.modelPulling;
  if (els.cancelModel) els.cancelModel.textContent = state.modelPulling ? `取消 ${state.modelPulling}` : "取消下載";
  els.model.innerHTML = (modelState.choices || []).map((choice) => `<option value="${escapeHtml(choice.name)}"${choice.name === modelState.selected ? " selected" : ""}>${escapeHtml(choice.label)}</option>`).join("");
  if (!modelState.choices?.length) els.model.innerHTML = `<option value="qwen3:4b">Qwen 3 · 4B（較快）</option><option value="qwen3:8b">Qwen 3 · 8B（較慢）</option><option value="gemma4:e2b">Gemma 4 · E2B</option>`;
  els.ollamaBadge.textContent = modelState.available ? "Ollama 已連線" : "需要設定";
  els.ollamaBadge.className = modelState.available ? "ollama-ok" : "ollama-error";
  if (!modelState.available) {
    els.modelStatus.innerHTML = `<p class="ollama-error">尚未連線到本機 Ollama。</p><p>安裝後啟動 Ollama，再下載一個 AI 模型（如 Qwen 或 Gemma）即可使用免費本機 AI 整理。</p>`;
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
  if (!note?.json) return `<div class="empty"><span>✦</span><b>${note?.status === "error" ? "整理失敗" : "尚未產生筆記"}</b><p>${escapeHtml(note?.error || "完成逐字稿後可使用本機 AI 整理。")}</p></div>`;
  return `<p class="model-label">模型：${escapeHtml(note.model || "本機 AI")}${note.status === "processing" ? " · 正在重新整理，以下為前次筆記" : note.status === "error" ? " · 本次整理失敗，以下為前次筆記" : ""}</p>${renderNoteBody(note.json)}`;
}

function jobTypeLabel(type) {
  if (String(type || "").startsWith("transcription")) return "逐字稿轉錄";
  if (type === "translation") return "英文翻譯";
  if (type === "notes") return "課程筆記";
  return String(type || "處理工作");
}

function jobStatusLabel(status) {
  return ({ queued: "排隊中", running: "處理中", completed: "已完成", interrupted: "已中斷", failed: "失敗" })[status] || String(status || "處理中");
}

function stageForJob(job) {
  if (String(job?.type || "").startsWith("transcription")) return Number(job?.progress) <= 4 ? "audio" : "transcribe";
  if (job?.type === "translation") return "translate";
  return "notes";
}

function latestProcessSnapshot(detail) {
  const live = state.courseProgress.get(detail.course.id);
  if (live) return live;
  const job = (detail.jobs || []).find((item) => ["queued", "running"].includes(item.status));
  if (!job) return null;
  return { courseId: detail.course.id, stage: stageForJob(job), detail: job.detail || jobTypeLabel(job.type), progress: job.progress, persisted: true, updatedAt: job.updatedAt };
}

function renderProcessHistory(detail) {
  const snapshot = latestProcessSnapshot(detail);
  const active = snapshot || (["recording", "transcribing", "summarizing"].includes(detail.course.status) ? { stage: detail.course.status === "recording" ? "recording" : detail.course.status === "summarizing" ? "notes" : "transcribe", detail: STATUS_LABELS[detail.course.status], progress: null } : null);
  if (!active && !(detail.jobs || []).length) return "";
  const safeProgress = Number.isFinite(Number(active?.progress)) ? Math.max(0, Math.min(100, Math.round(Number(active.progress)))) : null;
  const segmentCount = detail.segments?.length || 0;
  const currentStep = String(active?.detail || "正在處理課程");
  const time = active?.updatedAt ? new Date(active.updatedAt).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "剛剛";
  const history = (detail.jobs || []).slice(0, 4).map((job) => `<li class="process-history-item ${escapeHtml(job.status)}"><span>${escapeHtml(jobTypeLabel(job.type))}</span><b>${escapeHtml(jobStatusLabel(job.status))}</b><small>${escapeHtml(job.detail || job.error || "尚未回報細節")}${Number.isFinite(Number(job.progress)) ? ` · ${Math.round(Number(job.progress))}%` : ""}</small></li>`).join("");
  return `<section class="detail-process" data-detail-process aria-live="polite"><div class="detail-process-top"><div><p class="eyebrow">LIVE TRANSCRIPTION</p><h3>${escapeHtml(STAGE_LABELS[active?.stage] || "處理中")}</h3></div><strong>${safeProgress == null ? "處理中" : `${safeProgress}%`}</strong></div><p class="detail-process-copy">${escapeHtml(currentStep)}</p><div class="progress-track"><i style="width:${safeProgress == null ? 8 : safeProgress}%"></i></div><div class="detail-process-meta"><span>已寫入 <b>${segmentCount}</b> 個逐字稿片段</span><span>最後更新 ${escapeHtml(time)}</span></div>${history ? `<details class="process-history" open><summary>查看處理紀錄</summary><ul>${history}</ul></details>` : ""}</section>`;
}

function renderCourseDetail(detail) {
  if (!detail) { els.courseDetail.hidden = true; return; }
  const course = detail.course;
  const video = detail.media.find((item) => item.mediaType === "video" && item.mediaUrl);
  const mediaText = detail.media.map((item) => `${item.mediaType === "video" ? "影片" : "錄音"} · ${formatBytes(item.size)}`).join("／") || "尚無媒體";
  const translations = new Map((detail.translations || []).filter((item) => item.targetLanguage === state.detailTranscriptLanguage).map((item) => [item.segmentId, item.text]));
  const translated = state.detailTranscriptLanguage !== "original";
  const englishCount = (detail.translations || []).filter((item) => item.targetLanguage === "en").length;
  const chineseCount = (detail.translations || []).filter((item) => item.targetLanguage === "zh-TW").length;
  const transcriptTools = `<div class="transcript-tools"><button type="button" data-detail-translate="en" ${englishCount === detail.segments.length ? "disabled" : ""}>翻譯成英文</button><button type="button" data-detail-translate="zh-TW" ${chineseCount === detail.segments.length ? "disabled" : ""}>翻譯成繁體中文</button><button type="button" data-detail-language-view="original" class="${!translated ? "selected" : ""}">原文</button><button type="button" data-detail-language-view="en" class="${state.detailTranscriptLanguage === "en" ? "selected" : ""}" ${englishCount ? "" : "disabled"}>English</button><button type="button" data-detail-language-view="zh-TW" class="${state.detailTranscriptLanguage === "zh-TW" ? "selected" : ""}" ${chineseCount ? "" : "disabled"}>繁體中文</button></div>`;
  const visibleSegments = detail.segments.slice(0, state.detailTranscriptLimit);
  const segments = detail.segments.length
    ? `${visibleSegments.map((item) => `<button type="button" class="segment" data-start-ms="${Number(item.startMs) || 0}"><time>${formatTime(item.startMs)}</time><span>${escapeHtml(translated ? (translations.get(item.id) || "（尚未翻譯）") : applyTranscriptCorrections(item.text, detail.annotations))}</span></button>`).join("")}${detail.segments.length > visibleSegments.length ? `<button type="button" class="quiet-button transcript-more" data-detail-transcript-more>載入更多逐字稿（尚餘 ${detail.segments.length - visibleSegments.length} 段）</button>` : ""}`
    : `<div class="list-empty">目前沒有逐字稿片段。</div>`;
  const trash = Boolean(course.deleted_at);
  const categoryOptions = state.categories.map((item) => `<option value="${escapeHtml(item.id)}"${item.id === course.categoryId ? " selected" : ""}>${escapeHtml(item.name)}</option>`).join("");
  const semesterOptions = state.semesters.map((item) => `<option value="${escapeHtml(item)}"${item === course.semester ? " selected" : ""}>${escapeHtml(item)}</option>`).join("");
  const modelOptions = (state.models.choices || []).map((item) => `<option value="${escapeHtml(item.name)}"${item.name === course.model ? " selected" : ""}>${escapeHtml(item.label)}</option>`).join("");
  const canStopTranscription = !trash && course.status === "transcribing" && (detail.jobs || []).some((item) => item.status === "running" && String(item.type || "").startsWith("transcription"));
  const courseEditor = trash ? "" : `<details class="course-editor"><summary>編輯這堂課的資訊</summary><div class="course-edit-grid"><label>課程名稱<input data-detail-title value="${escapeHtml(course.title)}" maxlength="200"></label><label>分類<select data-detail-category><option value=""${!course.categoryId ? " selected" : ""}>未分類</option>${categoryOptions}<option value="__new__">＋ 新增分類</option></select><input data-detail-new-category-input hidden placeholder="新增分類名稱" maxlength="80"></label><label>學期<select data-detail-semester><option value=""${!course.semester ? " selected" : ""}>未指定</option>${semesterOptions}<option value="__new__">＋ 新增學期</option></select><input data-detail-new-semester-input hidden placeholder="新增學期，例如 114-1" maxlength="40"></label><label>逐字稿語言<select data-detail-language><option value="zh-TW"${course.language === "zh-TW" ? " selected" : ""}>繁體中文（臺灣）</option><option value="zh-CN"${course.language === "zh-CN" ? " selected" : ""}>簡體中文</option><option value="en-US"${course.language === "en-US" ? " selected" : ""}>English</option><option value="ja-JP"${course.language === "ja-JP" ? " selected" : ""}>日本語</option></select></label><label>筆記模型<select data-detail-model>${modelOptions}</select></label></div><button type="button" data-detail-save>儲存全部資訊</button></details>`;
  els.courseDetail.hidden = false;
  els.courseDetail.innerHTML = `<div class="detail-header"><div><button type="button" class="quiet-button" data-detail-back>← 返回列表</button><h2>${escapeHtml(course.title)}</h2><small>${escapeHtml(course.categoryName || "未分類")} · ${escapeHtml(course.semester || "未指定")} · ${escapeHtml(mediaText)} · ${STATUS_LABELS[course.status] || course.status}</small></div><div class="detail-actions">${trash ? `<button type="button" data-detail-action="restore">還原</button><button type="button" class="danger" data-detail-action="delete">永久刪除</button>` : `${canStopTranscription ? `<button type="button" class="danger" data-detail-action="stop-transcription">停止轉錄</button>` : ""}<button type="button" data-detail-action="retry">重新轉錄</button><button type="button" data-detail-action="notes">重新整理筆記</button><button type="button" class="danger" data-detail-action="trash">移到回收桶</button>`}</div></div>${courseEditor}<div data-detail-process-host>${renderProcessHistory(detail)}</div>${video ? `<div class="media-preview"><video controls preload="metadata" data-detail-video src="${escapeHtml(video.mediaUrl)}"></video></div>` : detail.media.length ? `<div class="audio-note">這門課是錄音檔。依設定不顯示影音預覽，但保留逐字稿時間戳。</div>` : ""}<div class="detail-grid"><section class="detail-section"><div class="detail-section-head"><h3>完整逐字稿 · ${detail.segments.length} 段</h3>${transcriptTools}</div><div class="detail-transcript" data-detail-transcript>${segments}</div></section><section class="detail-section"><h3>課程筆記</h3><div class="detail-note">${renderDetailNotes(detail.notes)}</div></section></div>${course.error ? `<div class="retry-box">${escapeHtml(course.error)}<br />可按上方重新轉錄或重新整理筆記。</div>` : ""}`;
  renderDetailProgress(course.id);
  const player = $(`[data-detail-video]`, els.courseDetail);
  if (player) {
    let activeSegment = null;
    player.addEventListener("timeupdate", () => {
      const current = player.currentTime * 1000;
      const nextSegment = $$(".segment", els.courseDetail).find((item) => Number(item.dataset.startMs) <= current && Number(item.dataset.startMs) + 20000 > current) || null;
      if (nextSegment === activeSegment) return;
      if (activeSegment) activeSegment.classList.remove("active");
      if (nextSegment) nextSegment.classList.add("active");
      activeSegment = nextSegment;
    });
  }
}

function renderDetailProgress(courseId) {
  if (courseId !== state.selectedCourseId || !state.lastDetail) return;
  const host = $(`[data-detail-process-host]`, els.courseDetail);
  if (host) host.innerHTML = renderProcessHistory(state.lastDetail);
}

async function openCourse(courseId) {
  state.selectedCourseId = courseId;
  state.detailTranscriptLimit = 160;
  state.detailTranscriptLanguage = "original";
  try { state.lastDetail = await window.courseCapture.courses.get(courseId); renderCourseDetail(state.lastDetail); await refreshCourses(); setDatabaseMessage("點擊逐字稿時間戳可跳到影片片段。"); }
  catch (error) { setDatabaseMessage(error.message || "無法開啟課程"); }
}

async function saveDetailCourse() {
  const id = state.selectedCourseId;
  const select = $(`[data-detail-category]`, els.courseDetail);
  if (!id || !select) return;
  const button = $(`[data-detail-save]`, els.courseDetail);
  button.disabled = true;
  try {
    let categoryId = select.value || null;
    if (categoryId === "__new__") {
      const name = $(`[data-detail-new-category-input]`, els.courseDetail).value.trim();
      if (!name) throw new Error("請輸入新分類名稱。");
      const created = await window.courseCapture.categories.create(name);
      categoryId = created.id;
      state.categories = await window.courseCapture.categories.list();
      renderFilters();
    }
    const semesterSelect = $(`[data-detail-semester]`, els.courseDetail);
    let semester = semesterSelect?.value || "";
    if (semester === "__new__") {
      const name = $(`[data-detail-new-semester-input]`, els.courseDetail).value.trim();
      if (!name) throw new Error("請輸入新學期名稱。");
      await window.courseCapture.semesters.create(name);
      semester = name;
    }
    await window.courseCapture.courses.update(id, {
      title: $(`[data-detail-title]`, els.courseDetail).value,
      categoryId,
      semester: semester || null,
      language: $(`[data-detail-language]`, els.courseDetail).value,
      model: $(`[data-detail-model]`, els.courseDetail).value || state.models.selected,
    });
    [state.categories, state.semesters] = await Promise.all([window.courseCapture.categories.list(), window.courseCapture.semesters.list()]);
    renderFilters();
    await openCourse(id);
    setDatabaseMessage("已儲存這堂課的全部資訊。");
  } catch (error) {
    setDatabaseMessage(error.message || "無法儲存分類");
  } finally { button.disabled = false; }
}

async function handleDetailAction(action, targetLanguage = "en") {
  const id = state.selectedCourseId;
  if (!id) return;
  try {
    if (action === "back") { state.selectedCourseId = ""; els.courseDetail.hidden = true; return; }
    if (action === "trash") { await window.courseCapture.courses.trash(id); setDatabaseMessage("課程已移到應用內回收桶。30 天內可還原。"); }
    if (action === "restore") { await window.courseCapture.courses.restore(id); setDatabaseMessage("課程已還原。"); }
    if (action === "delete") { if (!window.confirm("永久刪除這門課程及其媒體？媒體會移到 Windows 回收桶。")) return; await window.courseCapture.courses.deletePermanently(id); state.selectedCourseId = ""; els.courseDetail.hidden = true; setDatabaseMessage("課程已永久刪除。"); }
    if (action === "retry") { const job = await window.courseCapture.transcription.retry(id); setDatabaseMessage(`已重新開始轉錄，工作編號 ${job.jobId.slice(0, 8)}。`); }
    if (action === "stop-transcription") { const result = await window.courseCapture.transcription.cancel(id); setDatabaseMessage(result.stopped ? "已停止轉錄；已完成片段與媒體已保留。" : result.reason); }
    if (action === "notes") { await window.courseCapture.notes.generate(id, state.models.selected); setDatabaseMessage("課程筆記已重新整理。"); }
    if (action === "translate") {
      await window.courseCapture.translations.generate(id, targetLanguage, state.models.selected);
      setDatabaseMessage(`${targetLanguage === "zh-TW" ? "繁體中文" : "英文"}逐字稿已儲存，可切換查看。`);
    }
    await openCourse(state.selectedCourseId || id);
  } catch (error) { setDatabaseMessage(error.message || "操作失敗"); }
}

function enableInAppWidgetDrag() {
  const handle = $(`[data-recording-widget] .widget-drag-handle`);
  if (!handle) return;
  let drag = null;
  handle.addEventListener("pointerdown", (event) => {
    const rect = els.recordingWidget.getBoundingClientRect();
    drag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    handle.setPointerCapture(event.pointerId);
    handle.style.cursor = "grabbing";
  });
  handle.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const rect = els.recordingWidget.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, event.clientX - drag.x));
    const top = Math.max(8, Math.min(window.innerHeight - rect.height - 8, event.clientY - drag.y));
    els.recordingWidget.style.left = `${left}px`;
    els.recordingWidget.style.top = `${top}px`;
    els.recordingWidget.style.right = "auto";
    els.recordingWidget.style.bottom = "auto";
  });
  const stop = () => { drag = null; handle.style.cursor = "grab"; };
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
}

els.nav.forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
els.record.addEventListener("click", () => state.recording ? stopRecording() : startRecording());
els.pauseRecording.addEventListener("click", () => toggleRecordingPause());
els.widgetPause.addEventListener("click", () => toggleRecordingPause());
els.widgetStop.addEventListener("click", stopRecording);
els.widgetMinimize.addEventListener("click", () => window.courseCapture.widget.show());
enableInAppWidgetDrag();
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
els.reviewTabs.forEach((button) => button.addEventListener("click", () => setHomeReviewTab(button.dataset.reviewTab)));
els.homeTranscript.addEventListener("click", (event) => {
  if (!event.target.closest("[data-home-transcript-more]")) return;
  state.homeTranscriptLimit += 160;
  renderHomeTranscript(state.lastDetail?.segments || []);
});
els.homeCopy.addEventListener("click", async () => { if (!state.lastDetail?.notes) return; await navigator.clipboard.writeText(notePlainText(state.lastDetail.notes)); setStatus("課程筆記已複製到剪貼簿。", "success"); });
$(`[data-refresh-models]`).addEventListener("click", refreshModels);
$(`[data-cancel-model]`).addEventListener("click", cancelModelPull);
$(`[data-open-ollama]`).addEventListener("click", () => window.courseCapture.models.openDownload());
els.modelStatus.addEventListener("click", (event) => { const button = event.target.closest("[data-model-action]"); if (button) handleModelAction(button.dataset.modelAction, button.dataset.model); });
els.model.addEventListener("change", async () => { try { state.models.selected = els.model.value; await window.courseCapture.models.select(els.model.value); } catch (error) { setStatus(error.message || "模型選擇失敗", "error"); } });
els.whisperModel.addEventListener("change", async () => {
  try {
    await window.courseCapture.transcription.selectModel(els.whisperModel.value);
    setStatus("轉錄模式已儲存；下一個匯入或重新轉錄的工作會使用此模式。", "success");
  } catch (error) { setStatus(error.message || "無法切換轉錄模式", "error"); }
});
$(`[data-back-home]`).addEventListener("click", () => setView("home"));
$(`[data-toggle-trash]`).addEventListener("click", (event) => { state.trashMode = !state.trashMode; event.currentTarget.textContent = state.trashMode ? "返回課程" : "回收桶"; state.selectedCourseId = ""; els.courseDetail.hidden = true; refreshCourses(); });
[els.dbSearch, els.dbCategory, els.dbSemester, els.dbType, els.dbStatus].forEach((control) => {
  control.addEventListener("input", refreshCourses);
  control.addEventListener("change", refreshCourses);
});
els.courseList.addEventListener("click", (event) => { const card = event.target.closest("[data-course-id]"); if (card) openCourse(card.dataset.courseId); });
els.courseDetail.addEventListener("click", (event) => {
  if (event.target.closest("[data-detail-save]")) { saveDetailCourse(); return; }
  const translateButton = event.target.closest("[data-detail-translate]");
  if (translateButton) { handleDetailAction("translate", translateButton.dataset.detailTranslate); return; }
  const view = event.target.closest("[data-detail-language-view]");
  if (view) { state.detailTranscriptLanguage = view.dataset.detailLanguageView; renderCourseDetail(state.lastDetail); return; }
  const footnote = event.target.closest("[data-footnote-id]");
  if (footnote) { document.getElementById(footnote.dataset.footnoteId)?.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
  if (event.target.closest("[data-detail-transcript-more]")) { state.detailTranscriptLimit += 160; renderCourseDetail(state.lastDetail); return; }
  const segment = event.target.closest("[data-start-ms]");
  if (segment) { const player = $(`[data-detail-video]`, els.courseDetail); if (player) { player.currentTime = Number(segment.dataset.startMs) / 1000; player.play().catch(() => {}); } return; }
  const button = event.target.closest("[data-detail-back], [data-detail-action]");
  if (button) handleDetailAction(button.dataset.detailAction || "back");
});
els.courseDetail.addEventListener("change", (event) => {
  if (event.target.matches("[data-detail-category]")) {
    const input = $(`[data-detail-new-category-input]`, els.courseDetail);
    input.hidden = event.target.value !== "__new__";
    if (!input.hidden) input.focus();
  }
  if (event.target.matches("[data-detail-semester]")) {
    const input = $(`[data-detail-new-semester-input]`, els.courseDetail);
    input.hidden = event.target.value !== "__new__";
    if (!input.hidden) input.focus();
  }
});

window.courseCapture.onProgress((data) => {
  if (data?.courseId) state.courseProgress.set(data.courseId, data);
  if (data?.courseId && (data.stage === "notes" || data.stage === "translate")) state.notesProgress.set(data.courseId, data);
  if (data?.courseId && (data.stage === "complete" || data.stage === "error" || ((data.stage === "notes" || data.stage === "translate") && data.progress === 100))) { state.notesProgress.delete(data.courseId); state.courseProgress.delete(data.courseId); }
  if (data?.courseId === state.selectedCourseId) renderDetailProgress(data.courseId);
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
    await Promise.all([refreshSources(), refreshModels(), refreshCourses(), window.courseCapture.transcription.model().then((modelId) => { els.whisperModel.value = modelId; })]);
    const info = await window.courseCapture.app.info();
    const versionLabel = document.querySelector("[data-app-version]");
    if (versionLabel) versionLabel.textContent = info.version;
    setStatus(`CourseScribe ${info.version} 已準備完成。選擇來源後即可開始。`);
  } catch (error) { setStatus(`初始化失敗：${error.message || "請重新開啟應用程式"}`, "error"); }
}

initialize();
