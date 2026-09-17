const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const ffmpegPath = require("ffmpeg-static");
const { runFfmpeg } = require("../media-utils.cjs");
const { segmentPath, findSegments, prepareRecordingMedia, inspectRecordingAudio } = require("../recording-segments.cjs");

async function createClip(filePath, frequency, withAudio = true) {
  const args = ["-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10"];
  if (withAudio) args.push("-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000`);
  args.push("-t", "2", "-c:v", "libvpx-vp9", "-deadline", "realtime", "-b:v", "100k");
  if (withAudio) args.push("-c:a", "libopus", "-shortest");
  else args.push("-an");
  args.push("-f", "webm", filePath);
  await runFfmpeg(ffmpegPath, args);
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coursescribe-recording-"));
  try {
    const id = "11111111-2222-4333-8444-555555555555";
    const first = segmentPath(root, id, 0);
    const second = segmentPath(root, id, 1);
    await createClip(first, 440);
    await createClip(second, 880);
    assert.deepEqual(await findSegments(root, id, first), [first, second]);
    const joined = await prepareRecordingMedia({ ffmpegPath, stagingRoot: root, courseId: id, segmentPaths: [first, second] });
    const health = await inspectRecordingAudio(ffmpegPath, joined.filePath);
    assert.ok(health.audioOk, `暫停後音訊必須延續到合併影片末尾：${JSON.stringify(health)}`);
    assert.ok(health.videoSeconds > 3.5 && health.audioSeconds > 3.5, "兩段影像與音訊都必須保存");
    assert.equal((await fs.stat(first)).size > 0, true, "合併成功前原始片段不得刪除");
    const badId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const badFirst = segmentPath(root, badId, 0);
    const badSecond = segmentPath(root, badId, 1);
    await createClip(badFirst, 440);
    await createClip(badSecond, 880, false);
    const badJoined = await prepareRecordingMedia({ ffmpegPath, stagingRoot: root, courseId: badId, segmentPaths: [badFirst, badSecond] });
    const badHealth = await inspectRecordingAudio(ffmpegPath, badJoined.filePath);
    assert.equal(badHealth.audioOk, false, `後半段缺少音軌時不可宣稱錄影成功：${JSON.stringify(badHealth)}`);
    console.log(JSON.stringify({ ok: true, merged: health, missingAudioDetected: badHealth }));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
