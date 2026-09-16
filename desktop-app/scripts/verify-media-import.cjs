const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const ffmpegPath = require("ffmpeg-static");
const { getMediaType, buildAudioTranscodeArgs, resolveExecutablePath, runFfmpeg, transcodeMediaToWav } = require("../media-utils.cjs");

async function run() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "course-scribe-media-import-"));
  try {
    assert.equal(getMediaType("m4a"), "audio");
    assert.equal(getMediaType("MP4"), "video");
    assert.equal(getMediaType("pdf"), null);

    const virtualFfmpegPath = path.join(tempRoot, "resources", "app.asar", "node_modules", "ffmpeg-static", "ffmpeg.exe");
    const unpackedFfmpegPath = path.join(tempRoot, "resources", "app.asar.unpacked", "node_modules", "ffmpeg-static", "ffmpeg.exe");
    await fs.mkdir(path.dirname(unpackedFfmpegPath), { recursive: true });
    await fs.writeFile(unpackedFfmpegPath, "test");
    assert.equal(resolveExecutablePath(virtualFfmpegPath), unpackedFfmpegPath, "封裝版應從 app.asar.unpacked 執行 ffmpeg");

    const audioInput = path.join(tempRoot, "lesson-audio.m4a");
    const audioOutput = path.join(tempRoot, "lesson-audio.wav");
    await runFfmpeg(ffmpegPath, ["-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=0.4", "-c:a", "aac", audioInput]);
    await transcodeMediaToWav({ ffmpegPath, inputPath: audioInput, outputPath: audioOutput });
    assert.ok((await fs.stat(audioOutput)).size > 44, "M4A 音訊未轉成有效 WAV");

    const videoInput = path.join(tempRoot, "lesson-video.mp4");
    const videoOutput = path.join(tempRoot, "lesson-video.wav");
    await runFfmpeg(ffmpegPath, ["-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", "color=c=black:s=160x90:r=10:d=0.4", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=44100:duration=0.4", "-shortest", "-c:v", "mpeg4", "-c:a", "aac", videoInput]);
    await transcodeMediaToWav({ ffmpegPath, inputPath: videoInput, outputPath: videoOutput });
    assert.ok((await fs.stat(videoOutput)).size > 44, "MP4 影片音訊未轉成有效 WAV");

    const silentVideo = path.join(tempRoot, "no-audio.mp4");
    await runFfmpeg(ffmpegPath, ["-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", "color=c=black:s=160x90:r=10:d=0.2", "-c:v", "mpeg4", silentVideo]);
    await assert.rejects(
      () => transcodeMediaToWav({ ffmpegPath, inputPath: silentVideo, outputPath: path.join(tempRoot, "no-audio.wav") }),
      (error) => error?.code === "NO_AUDIO_TRACK",
      "無音軌影片沒有產生可辨識的錯誤",
    );

    const args = buildAudioTranscodeArgs(videoInput, videoOutput);
    assert.ok(args.includes("0:a:0") && args.includes("16000") && args.includes("pcm_s16le"), "轉檔參數沒有指定第一條音訊、16 kHz 與 PCM WAV");
    console.log(JSON.stringify({ audio: path.basename(audioInput), video: path.basename(videoInput), noAudio: path.basename(silentVideo), outputSampleRate: 16000 }));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
