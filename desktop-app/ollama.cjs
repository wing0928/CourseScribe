const { randomUUID } = require("node:crypto");

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "qwen3:4b";
const HIGH_QUALITY_MODEL = "qwen3:8b";
const AVAILABLE_MODELS = Object.freeze([
  { name: DEFAULT_MODEL, label: "Qwen 3 · 快速", size: "約 2.5 GB", description: "適合一般課程與較快整理" },
  { name: HIGH_QUALITY_MODEL, label: "Qwen 3 · 高品質", size: "約 5.2 GB", description: "適合較長或概念密集的課程" },
]);

function stripThinkTags(value) {
  return String(value || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function parseJsonResponse(value) {
  const raw = stripThinkTags(value);
  try { return JSON.parse(raw); } catch { /* try fenced or embedded JSON below */ }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch { /* continue */ }
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch { /* continue */ }
  }
  const error = new Error("Ollama 回傳的內容不是有效 JSON");
  error.code = "OLLAMA_BAD_JSON";
  error.raw = raw.slice(0, 2000);
  throw error;
}

function normalizeNoteShape(value) {
  const source = value && typeof value === "object" ? value : {};
  const list = (key) => Array.isArray(source[key]) ? source[key].map((item) => String(item || "").trim()).filter(Boolean) : [];
  return {
    summary: String(source.summary || "").trim(),
    keyPoints: list("keyPoints"),
    termsAndFormulas: list("termsAndFormulas"),
    confusions: list("confusions"),
    reviewQuestions: list("reviewQuestions"),
    takeaway: String(source.takeaway || "").trim(),
  };
}

class OllamaClient {
  constructor(baseUrl = DEFAULT_BASE_URL) {
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
    this.controllers = new Map();
  }

  async request(path, options = {}, timeoutMs = 20000) {
    const controller = new AbortController();
    const requestId = randomUUID();
    this.controllers.set(requestId, controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, { ...options, signal: controller.signal });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`Ollama 服務回應 ${response.status}`);
        error.code = response.status === 404 ? "OLLAMA_NOT_FOUND" : "OLLAMA_HTTP_ERROR";
        error.status = response.status;
        error.body = text.slice(0, 2000);
        throw error;
      }
      return { response, text };
    } catch (error) {
      if (error.name === "AbortError") {
        const timeout = new Error("Ollama 請求逾時或已取消");
        timeout.code = "OLLAMA_TIMEOUT";
        throw timeout;
      }
      if (error.code === "ECONNREFUSED" || /fetch failed|connect/i.test(String(error.message))) {
        error.code = "OLLAMA_UNAVAILABLE";
      }
      throw error;
    } finally {
      clearTimeout(timer);
      this.controllers.delete(requestId);
    }
  }

  cancelAll() {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }

  async status() {
    try {
      const { text } = await this.request("/api/tags", {}, 5000);
      const payload = JSON.parse(text || "{}");
      return { available: true, models: Array.isArray(payload.models) ? payload.models.map((model) => model.name).filter(Boolean) : [], baseUrl: this.baseUrl };
    } catch (error) {
      return { available: false, models: [], baseUrl: this.baseUrl, error: error.code || error.message };
    }
  }

  async pull(model, onProgress) {
    const name = String(model || DEFAULT_MODEL);
    const controller = new AbortController();
    const requestId = randomUUID();
    this.controllers.set(requestId, controller);
    const timer = setTimeout(() => controller.abort(), 30 * 60 * 1000);
    try {
      const response = await fetch(`${this.baseUrl}/api/pull`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, stream: true }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Ollama 服務回應 ${response.status}`);
      let last = { status: "success", name };
      if (!response.body) return last;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      for (;;) {
        const { done, value } = await reader.read();
        pending += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = pending.split(/\r?\n/);
        pending = done ? "" : lines.pop() || "";
        for (const line of lines.filter(Boolean)) {
          try { last = JSON.parse(line); onProgress?.(last); } catch { /* ignore partial/non-json output */ }
        }
        if (done) break;
      }
      if (pending) {
        try { last = JSON.parse(pending); onProgress?.(last); } catch { /* ignore */ }
      }
      return last;
    } catch (error) {
      if (error.name === "AbortError") {
        const timeout = new Error("Ollama 下載已取消或逾時");
        timeout.code = "OLLAMA_TIMEOUT";
        throw timeout;
      }
      if (error.code === "ECONNREFUSED" || /fetch failed|connect/i.test(String(error.message))) error.code = "OLLAMA_UNAVAILABLE";
      throw error;
    } finally {
      clearTimeout(timer);
      this.controllers.delete(requestId);
    }
  }

  async remove(model) {
    const { text } = await this.request("/api/delete", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: String(model) }) }, 30000);
    return text ? JSON.parse(text) : { status: "success" };
  }

  async generateJson({ model = DEFAULT_MODEL, prompt, system = "", timeoutMs = 120000 }) {
    const { text } = await this.request("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt, system, stream: false, format: "json", options: { temperature: 0.15 } }),
    }, timeoutMs);
    const response = JSON.parse(text || "{}");
    // Qwen3 on newer Ollama versions may place a JSON-only answer in the
    // `thinking` field while leaving `response` empty. Prefer normal content,
    // then accept that field as a compatibility fallback.
    const raw = response.response || response.message?.content || response.thinking || response.message?.thinking || "";
    return { value: normalizeNoteShape(parseJsonResponse(raw)), raw, model };
  }
}

function buildNotePrompt(transcript, courseTitle, language = "zh-TW") {
  const languageInstruction = String(language).toLowerCase().startsWith("zh-tw") ? "請使用臺灣繁體中文，不要輸出簡體字。" : `請使用語言 ${language}。`;
  return `你是課程助教。請根據下列課程逐字稿整理成嚴格 JSON，不要輸出 Markdown 或其他文字。${languageInstruction}
JSON 欄位必須完全包含：summary (string)、keyPoints (string array)、termsAndFormulas (string array)、confusions (string array)、reviewQuestions (string array)、takeaway (string)。不要捏造逐字稿沒有的資訊；不確定的地方放入 confusions。
課程名稱：${courseTitle}
逐字稿：
${transcript}`;
}

module.exports = { OllamaClient, DEFAULT_BASE_URL, DEFAULT_MODEL, HIGH_QUALITY_MODEL, AVAILABLE_MODELS, parseJsonResponse, normalizeNoteShape, buildNotePrompt };
