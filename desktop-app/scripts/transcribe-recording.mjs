import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import wavefile from "wavefile";
import ffmpegPath from "ffmpeg-static";
import { env, pipeline } from "@huggingface/transformers";

const { WaveFile } = wavefile;
const input = process.argv[2];
if (!input) throw new Error("請提供 WebM 錄影檔路徑");
const outputPath = process.argv[3] || path.join(process.cwd(), "verification-output", "recording-result.json");
const language = process.argv[4] || "chinese";
const chunkLength = Number(process.argv[5] || (language === "english" ? 20 : 30));
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "course-capture-verify-"));
const wavPath = path.join(tempRoot, "recording.wav");

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let error = "";
    child.stderr.on("data", (chunk) => { error += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(error || `ffmpeg 結束碼 ${code}`)));
  });
}

function getSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parts = String(value ?? "").split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(parts[0]) || 0;
}

function createNotes(text, segments = []) {
  const sourceUnits = segments.map((segment) => String(segment.text || "").trim()).filter(Boolean);
  const sentences = sourceUnits.flatMap((unit) => unit.split(/[。！？!?；;]+/).map((item) => item.trim()).filter(Boolean));
  const fallbackSentences = text.split(/[。！？!?；;]+/).map((item) => item.trim()).filter(Boolean);
  const noteUnits = sentences.length > 1 ? sentences : fallbackSentences;
  const stopWords = new Set(["這篇", "基本上", "可能", "其實", "裡面", "也許", "中間", "所以", "不管", "怎麼樣", "一些", "非常", "重要", "叫做", "分別", "它是", "可以", "就是", "以及", "然後", "這個", "那個", "也有", "其實是", "不管怎麼", "據說是", "他的", "它的", "大概", "包含", "而且", "還有", "但是", "只是", "這些", "那些", "百分之百", "大概包含", "寫進去", "成為", "進去", "據說", "東西", "这篇", "基本上", "其实", "里面", "也许", "中间", "所以", "不管", "怎么样", "一些", "非常", "重要", "叫做", "分别", "它是", "可以", "就是", "以及", "然后", "这个", "那个", "也有", "其实是", "不管怎么", "据说是", "他的", "它的", "大概", "包含", "而且", "还有", "但是", "只是", "这些", "那些", "百分之百", "大概包含", "写进去", "成为", "进去", "据说", "东西"]);
  const words = typeof Intl.Segmenter === "function" ? [...new Intl.Segmenter("zh", { granularity: "word" }).segment(text)].map((item) => item.segment) : text.match(/[A-Za-z]{4,}|[\u4e00-\u9fff]{2,6}/g) || [];
  const tally = new Map();
  words.map((word) => word.trim()).filter((word) => word.length >= 2 && !stopWords.has(word)).forEach((word) => tally.set(word, (tally.get(word) || 0) + 1));
  const keywords = [...tally.entries()].sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length)).slice(0, 6).map(([word]) => word);
  const unique = noteUnits.filter((unit, index) => index === 0 || unit !== noteUnits[index - 1]);
  const informative = unique.filter((unit) => unit.replace(/[\s，、,]/g, "").length >= 8);
  const pool = informative.length >= 3 ? informative : unique;
  const bullets = pool.length <= 5 ? pool : [...new Set(Array.from({ length: 5 }, (_item, index) => pool[Math.round(index * (pool.length - 1) / 4)]))];
  return { bullets, summary: bullets.slice(0, 2).join("；") || "完成轉錄後再整理。", keywords };
}

try {
  await runFfmpeg(["-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", wavPath]);
  const wav = new WaveFile(await fs.readFile(wavPath));
  wav.toBitDepth("32f");
  wav.toSampleRate(16000);
  let samples = wav.getSamples();
  if (Array.isArray(samples)) samples = samples[0];
  const audio = samples instanceof Float32Array ? samples : new Float32Array(samples);
  env.cacheDir = path.join(process.env.APPDATA || os.homedir(), "course-capture-desktop", "whisper-models");
  const transcriber = await pipeline("automatic-speech-recognition", "onnx-community/whisper-small", { dtype: "q4", device: "cpu" });
  const result = await transcriber(audio, { language, task: "transcribe", return_timestamps: true, chunk_length_s: chunkLength, stride_length_s: Math.min(5, Math.max(1, Math.floor(chunkLength / 4))) });
  const text = String(result.text || "").trim();
  const segments = (result.chunks || []).map((chunk) => ({ time: getSeconds(chunk.timestamp?.[0]), text: String(chunk.text || "").trim() })).filter((chunk) => chunk.text);
  const payload = { input, generatedAt: new Date().toISOString(), text, segments, notes: createNotes(text, segments) };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(JSON.stringify({ outputPath, segmentCount: segments.length, characters: text.replace(/\s/g, "").length, preview: text.slice(0, 300) }));
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
