import os from "node:os";
import path from "node:path";
import wavefile from "wavefile";
import { env, pipeline } from "@huggingface/transformers";

const { WaveFile } = wavefile;
env.cacheDir = path.join(os.tmpdir(), "course-capture-whisper-test");

const response = await fetch("https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav");
if (!response.ok) throw new Error(`無法下載 Whisper 測試音檔：${response.status}`);

const wav = new WaveFile(Buffer.from(await response.arrayBuffer()));
wav.toBitDepth("32f");
wav.toSampleRate(16000);
let samples = wav.getSamples();
if (Array.isArray(samples)) samples = samples[0];

const transcribe = await pipeline("automatic-speech-recognition", "onnx-community/whisper-tiny", { dtype: "q4", device: "cpu" });
const result = await transcribe(samples instanceof Float32Array ? samples : new Float32Array(samples), { language: "english", task: "transcribe" });
if (!result?.text?.trim()) throw new Error("Whisper 沒有產生測試逐字稿");
const expected = "And so my fellow Americans, ask not what your country can do for you, ask what you can do for your country.";
const normalize = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
if (normalize(result.text) !== normalize(expected)) {
  throw new Error(`Whisper 字幕比對失敗。\n預期：${expected}\n實際：${result.text.trim()}`);
}
console.log(JSON.stringify({ exact: true, wordErrorRate: 0, transcript: result.text.trim() }));
