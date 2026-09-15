const { spawn } = require("node:child_process");

const AUDIO_EXTENSIONS = Object.freeze(["mp3", "wav", "m4a", "aac", "ogg", "oga", "opus", "flac", "wma", "aiff", "aif"]);
const VIDEO_EXTENSIONS = Object.freeze(["mp4", "webm", "mov", "mkv", "avi", "mpeg", "mpg", "m4v", "3gp", "ts"]);
const SUPPORTED_MEDIA_EXTENSIONS = Object.freeze([...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS]);

function normalizeMediaExtension(value) {
  return String(value || "").trim().replace(/^\./, "").toLowerCase();
}

function getMediaType(extension) {
  const normalized = normalizeMediaExtension(extension);
  if (AUDIO_EXTENSIONS.includes(normalized)) return "audio";
  if (VIDEO_EXTENSIONS.includes(normalized)) return "video";
  return null;
}

function buildAudioTranscodeArgs(inputPath, outputPath) {
  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    inputPath,
    "-map",
    "0:a:0",
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    "-f",
    "wav",
    outputPath,
  ];
}

function createFfmpegError(stderr, exitCode) {
  const diagnostics = String(stderr || "");
  let message = "無法讀取這個影音檔案，請確認檔案完整且格式受支援。";
  let code = "MEDIA_CONVERSION_FAILED";

  if (/matches no streams|does not contain any stream|no audio|stream specifier.*matches no streams/i.test(diagnostics)) {
    message = "這個檔案沒有可用的音訊軌，請選擇包含聲音的錄音或影片。";
    code = "NO_AUDIO_TRACK";
  } else if (/invalid data found|unknown format|invalid argument|could not find codec parameters|moov atom not found|end of file|conversion failed/i.test(diagnostics)) {
    message = "檔案格式不受支援或檔案可能已損毀，請改用完整的 MP4、WebM、MP3、M4A 或 WAV 檔案。";
    code = "UNSUPPORTED_MEDIA";
  }

  const error = new Error(message);
  error.code = code;
  error.exitCode = exitCode;
  error.diagnostics = diagnostics.slice(-8000);
  return error;
}

function runFfmpeg(ffmpegPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (cause) => {
      const error = new Error("無法啟動本機音訊轉換工具，請重新安裝課間捕手後再試一次。");
      error.code = "FFMPEG_START_FAILED";
      error.diagnostics = String(cause?.stack || cause?.message || cause);
      reject(error);
    });
    child.on("close", (exitCode) => exitCode === 0 ? resolve() : reject(createFfmpegError(stderr, exitCode)));
  });
}

async function transcodeMediaToWav({ ffmpegPath, inputPath, outputPath }) {
  await runFfmpeg(ffmpegPath, buildAudioTranscodeArgs(inputPath, outputPath));
  return outputPath;
}

module.exports = {
  AUDIO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  SUPPORTED_MEDIA_EXTENSIONS,
  normalizeMediaExtension,
  getMediaType,
  buildAudioTranscodeArgs,
  createFfmpegError,
  runFfmpeg,
  transcodeMediaToWav,
};
