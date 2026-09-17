const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { resolveExecutablePath, runFfmpeg } = require("./media-utils.cjs");

function segmentPath(stagingRoot, courseId, index) {
  if (!/^[0-9a-f-]{36}$/i.test(courseId) || !Number.isInteger(index) || index < 0 || index > 999) throw new Error("無效的錄影片段識別碼");
  return path.join(stagingRoot, `${courseId}-${String(index).padStart(3, "0")}.webm.part`);
}

async function findSegments(stagingRoot, courseId, fallbackPath) {
  const names = await fs.readdir(stagingRoot);
  const numbered = names.filter((name) => new RegExp(`^${courseId}-(\\d{3})\\.webm\\.part$`, "i").test(name)).sort();
  if (numbered.length) return numbered.map((name) => path.join(stagingRoot, name));
  if (fallbackPath) {
    try { if ((await fs.stat(fallbackPath)).isFile()) return [fallbackPath]; } catch { /* no recoverable file */ }
  }
  return [];
}

async function prepareRecordingMedia({ ffmpegPath, stagingRoot, courseId, segmentPaths }) {
  const paths = [];
  for (const filePath of segmentPaths) {
    const stats = await fs.stat(filePath);
    if (stats.isFile() && stats.size > 0) paths.push(filePath);
  }
  if (!paths.length) throw new Error("錄影沒有留下可用的影片片段。");
  if (paths.length === 1) return { filePath: paths[0], cleanup: [] };
  const nonce = randomUUID();
  const listPath = path.join(stagingRoot, `${courseId}-${nonce}.concat.txt`);
  const outputPath = path.join(stagingRoot, `${courseId}-${nonce}.webm`);
  const lines = paths.map((filePath) => `file '${path.basename(filePath).replace(/'/g, "'\\''")}'`).join("\n");
  await fs.writeFile(listPath, `${lines}\n`, "utf8");
  try {
    await runFfmpeg(ffmpegPath, ["-hide_banner", "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", outputPath]);
    if ((await fs.stat(outputPath)).size <= 0) throw new Error("合併後的影片是空白檔案。");
    return { filePath: outputPath, cleanup: [...paths, listPath] };
  } catch (error) {
    await fs.rm(outputPath, { force: true });
    throw new Error(`錄影片段合併失敗；原始片段已保留：${error.message}`);
  }
}

function streamDuration(ffmpegPath, inputPath, stream) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveExecutablePath(ffmpegPath), ["-hide_banner", "-nostdin", "-nostats", "-i", inputPath, "-map", `0:${stream}:0`, "-c", "copy", "-f", "null", "-"], { windowsHide: true });
    let diagnostics = "";
    child.stderr.on("data", (part) => { diagnostics += part.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return resolve(null);
      const stamps = [...diagnostics.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
      const last = stamps.at(-1);
      resolve(last ? (Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3])) : null);
    });
  });
}

async function inspectRecordingAudio(ffmpegPath, inputPath, toleranceSeconds = 1) {
  const [videoSeconds, audioSeconds] = await Promise.all([
    streamDuration(ffmpegPath, inputPath, "v"),
    streamDuration(ffmpegPath, inputPath, "a"),
  ]);
  return { videoSeconds, audioSeconds, audioOk: videoSeconds != null && audioSeconds != null && videoSeconds - audioSeconds <= toleranceSeconds };
}

module.exports = { segmentPath, findSegments, prepareRecordingMedia, inspectRecordingAudio };
