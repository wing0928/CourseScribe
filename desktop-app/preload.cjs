const { contextBridge, ipcRenderer } = require("electron");

function listen(channel, listener) {
  const wrapped = (_event, data) => listener(data);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld("courseCapture", {
  app: {
    info: () => ipcRenderer.invoke("app:info"),
    openExternal: (url) => ipcRenderer.invoke("app:open-external", url),
    log: (message) => ipcRenderer.invoke("app:log", message),
  },
  courses: {
    list: (filters) => ipcRenderer.invoke("courses:list", filters || {}),
    get: (courseId) => ipcRenderer.invoke("courses:get", courseId),
    create: (input) => ipcRenderer.invoke("courses:create", input || {}),
    update: (courseId, patch) => ipcRenderer.invoke("courses:update", { courseId, patch: patch || {} }),
    trash: (courseId) => ipcRenderer.invoke("courses:trash", courseId),
    restore: (courseId) => ipcRenderer.invoke("courses:restore", courseId),
    deletePermanently: (courseId) => ipcRenderer.invoke("courses:delete-permanently", courseId),
    importMedia: (courseId, sourceId) => ipcRenderer.invoke("courses:import-media", { courseId, sourceId }),
    exportMedia: (mediaId) => ipcRenderer.invoke("courses:export-media", { mediaId }),
  },
  categories: {
    list: () => ipcRenderer.invoke("categories:list"),
    create: (name) => ipcRenderer.invoke("categories:create", name),
  },
  semesters: {
    list: () => ipcRenderer.invoke("semesters:list"),
    create: (name) => ipcRenderer.invoke("semesters:create", name),
  },
  media: {
    choose: () => ipcRenderer.invoke("media:choose"),
  },
  transcription: {
    start: (courseId, mediaId, language) => ipcRenderer.invoke("transcription:start", { courseId, mediaId, language }),
    retry: (courseId) => ipcRenderer.invoke("transcription:retry", { courseId }),
  },
  notes: {
    generate: (courseId, model) => ipcRenderer.invoke("notes:generate", { courseId, model }),
  },
  models: {
    status: () => ipcRenderer.invoke("models:status"),
    select: (model) => ipcRenderer.invoke("models:select", model),
    pull: (model) => ipcRenderer.invoke("models:pull", model),
    remove: (model) => ipcRenderer.invoke("models:remove", model),
    cancel: () => ipcRenderer.invoke("models:cancel"),
    openDownload: () => ipcRenderer.invoke("models:open-download"),
  },
  capture: {
    listSources: () => ipcRenderer.invoke("capture:list"),
    selectSource: (sourceId) => ipcRenderer.invoke("capture:select", sourceId),
  },
  recording: {
    create: (input) => ipcRenderer.invoke("recording:create", input || {}),
    begin: (payload) => ipcRenderer.invoke("recording:begin", payload || {}),
    videoChunk: (courseId, bytes) => ipcRenderer.invoke("recording:video-chunk", { courseId, bytes }),
    audioChunk: (payload) => ipcRenderer.invoke("recording:audio-chunk", payload || {}),
    finish: (courseId) => ipcRenderer.invoke("recording:finish", { courseId }),
  },
  widget: {
    show: () => ipcRenderer.invoke("widget:show"),
    hide: () => ipcRenderer.invoke("widget:hide"),
    update: (state) => ipcRenderer.invoke("widget:update", state || {}),
    getState: () => ipcRenderer.invoke("widget:get-state"),
    action: (action) => ipcRenderer.invoke("widget:action", action),
    onAction: (listener) => listen("widget:action", listener),
    onState: (listener) => listen("widget:state", listener),
  },
  onProgress: (listener) => listen("course:progress", listener),
  onModelProgress: (listener) => listen("model:progress", listener),
  onCourseUpdated: (listener) => listen("course:updated", listener),
  onFocus: (listener) => listen("app:focus", listener),
});
