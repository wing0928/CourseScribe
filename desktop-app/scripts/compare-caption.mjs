import fs from "node:fs/promises";

const captionPath = process.argv[2];
const resultPath = process.argv[3];
const limitSeconds = Number(process.argv[4] || 60);
if (!captionPath || !resultPath) throw new Error("請提供字幕檔與 Whisper JSON 路徑");

const captionText = await fs.readFile(captionPath, "utf8");
const result = JSON.parse(await fs.readFile(resultPath, "utf8"));

function toSeconds(value) {
  const parts = value.replace(",", ".").split(":").map(Number);
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
}

const reference = captionText.split(/\r?\n\r?\n/).flatMap((block) => {
  const lines = block.split(/\r?\n/);
  const timestampIndex = lines.findIndex((line) => line.includes("-->"));
  if (timestampIndex < 0 || toSeconds(lines[timestampIndex].split(" --> ")[0]) >= limitSeconds) return [];
  return [lines.slice(timestampIndex + 1).join(" ")];
}).join(" ");

const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9']+/g, " ").trim();
const referenceWords = normalize(reference).split(/\s+/).filter(Boolean);
const whisperWords = normalize(result.text || "").split(/\s+/).filter(Boolean);
const referenceChars = [...reference.replace(/[^a-z0-9]/gi, "").toLowerCase()];
const whisperChars = [...String(result.text || "").replace(/[^a-z0-9]/gi, "").toLowerCase()];

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_item, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column];
      previous[column] = Math.min(previous[column] + 1, previous[column - 1] + 1, diagonal + (left[row - 1] === right[column - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[right.length];
}

const wordEdits = editDistance(referenceWords, whisperWords);
const charEdits = editDistance(referenceChars, whisperChars);
const report = {
  limitSeconds,
  referenceWords: referenceWords.length,
  whisperWords: whisperWords.length,
  wordEditDistance: wordEdits,
  wordErrorRate: Number((wordEdits / Math.max(referenceWords.length, 1)).toFixed(3)),
  referenceChars: referenceChars.length,
  whisperChars: whisperChars.length,
  charErrorRate: Number((charEdits / Math.max(referenceChars.length, 1)).toFixed(3)),
};
console.log(JSON.stringify(report, null, 2));
console.log(`REFERENCE: ${reference}`);
console.log(`WHISPER: ${result.text || ""}`);
