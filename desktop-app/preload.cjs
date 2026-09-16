const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("courseCapture", {
  listCaptureSources: () => ipcRenderer.invoke("capture:list"),
  selectCaptureSource: (id) => ipcRenderer.invoke("capture:select", id),
  selectDesktopSource: () => ipcRenderer.invoke("capture:select-desktop"),
  log: (message) => ipcRenderer.invoke("app:log", message),
  saveRecording: (payload) => ipcRenderer.invoke("recording:save", payload),
  chooseMediaFile: () => ipcRenderer.invoke("recording:choose-media"),
  transcribeRecording: (payload) => ipcRenderer.invoke("recording:transcribe", payload),
  exportRecording: (payload) => ipcRenderer.invoke("recording:export", payload),
  exportImportedMedia: (payload) => ipcRenderer.invoke("recording:export-imported", payload),
  onProgress: (listener) => ipcRenderer.on("whisper:progress", (_event, data) => listener(data)),
  onTranscript: (listener) => ipcRenderer.on("whisper:transcript", (_event, data) => listener(data)),
});
