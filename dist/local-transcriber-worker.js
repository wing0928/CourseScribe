import { pipeline } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0";

const models = { live: "onnx-community/whisper-base", refine: "onnx-community/whisper-small" };
const transcribers = new Map();

async function loadModel(tier) {
  if (transcribers.has(tier)) return transcribers.get(tier);
  const options = {
    dtype: "q4",
    progress_callback: (item) => {
      const progress = item?.progress == null ? 0 : Math.min(100, Math.max(0, item.progress));
      self.postMessage({ type: "progress", tier, progress });
    },
  };
  try {
    if (self.navigator?.gpu) options.device = "webgpu";
    const model = await pipeline("automatic-speech-recognition", models[tier], options);
    transcribers.set(tier, model);
    return model;
  } catch (error) {
    if (!options.device) throw error;
    const model = await pipeline("automatic-speech-recognition", models[tier], { ...options, device: "wasm" });
    transcribers.set(tier, model);
    return model;
  }
}

self.addEventListener("message", async ({ data }) => {
  try {
    if (data.type === "load") {
      await loadModel(data.tier);
      self.postMessage({ type: "ready", tier: data.tier });
      return;
    }
    if (data.type !== "transcribe") return;
    const transcriber = await loadModel(data.tier || "live");
    const output = await transcriber(new Float32Array(data.audio), {
      language: data.language,
      task: "transcribe",
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    self.postMessage({ type: "result", id: data.id, text: output?.text || "", chunks: output?.chunks || [] });
  } catch (error) {
    self.postMessage({ type: "error", id: data.id, message: error instanceof Error ? error.message : "本機模型無法完成辨識" });
  }
});
