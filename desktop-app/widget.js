const time = document.querySelector("[data-time]");
const state = document.querySelector("[data-state]");
const title = document.querySelector("[data-title]");
const dot = document.querySelector("[data-dot]");
const pause = document.querySelector("[data-pause]");

function formatTime(ms) {
  const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${Math.floor(seconds / 3600).toString().padStart(2, "0")}:${Math.floor((seconds % 3600) / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function renderState(snapshot = {}) {
  time.textContent = formatTime(snapshot.elapsedMs);
  state.textContent = snapshot.paused ? "已暫停" : "錄影中";
  title.textContent = snapshot.title || "未命名課程";
  pause.textContent = snapshot.paused ? "繼續" : "暫停";
  dot.classList.toggle("paused", Boolean(snapshot.paused));
}

window.courseCapture.widget.onState(renderState);
window.courseCapture.widget.getState().then(renderState).catch(() => {});

pause.addEventListener("click", () => window.courseCapture.widget.action(pause.textContent === "繼續" ? "resume" : "pause"));
document.querySelector("[data-stop]").addEventListener("click", () => window.courseCapture.widget.action("stop"));
document.querySelector("[data-open]").addEventListener("click", () => window.courseCapture.widget.action("open"));
document.querySelector("[data-close]").addEventListener("click", () => window.courseCapture.widget.action("close"));
