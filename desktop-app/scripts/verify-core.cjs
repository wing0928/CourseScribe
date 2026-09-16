const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CourseDatabase } = require("../database.cjs");
const { toTraditionalTaiwan } = require("../text-utils.cjs");
const { parseJsonResponse, normalizeNoteShape } = require("../ollama.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "coursescribe-core-"));
const db = new CourseDatabase(path.join(root, "courses.sqlite"));
let reopened;
try {
  const category = db.addCategory("資料結構");
  const course = db.createCourse({ title: "本機持久化測試", categoryId: category.id, semester: "2026 春季" });
  const media = db.upsertMedia({ courseId: course.id, filePath: path.join(root, "lesson.webm"), originalName: "lesson.webm", mediaType: "video", extension: "webm", size: 10, sha256: "abc" });
  db.addSegments(course.id, null, [{ startMs: 1000, text: "简体课程内容。" }, { startMs: 1500, text: "简体课程内容。" }], "zh-TW");
  assert.equal(db.listCourses({}).length, 1);
  assert.equal(db.listSegments(course.id).length, 1, "2 秒重疊去重應合併相同片段");
  db.clearSegments(course.id);
  assert.equal(db.listSegments(course.id).length, 0, "重新轉錄前應能清除舊片段");
  db.upsertMedia({ id: media.id, courseId: course.id, filePath: path.join(root, "lesson.part"), originalName: "lesson.webm", mediaType: "video", extension: "webm", size: 10, sha256: "abc", processingStatus: "recording" });
  assert.equal(db.listProcessingMedia("recording").length, 1, "錄影中的媒體應可被啟動復原流程找到");
  reopened = new CourseDatabase(path.join(root, "courses.sqlite"));
  assert.equal(reopened.getCourseDetail(course.id).course.title, "本機持久化測試");
  assert.equal(toTraditionalTaiwan("简体课程、软件和视频", "zh-TW"), "簡體課程、軟體和影片");
  assert.equal(toTraditionalTaiwan("简体课程", "zh-CN"), "简体课程", "簡體中文模式不應被轉換");
  reopened.trashCourse(course.id);
  assert.equal(reopened.listCourses({}).some((item) => item.id === course.id), false);
  assert.equal(reopened.listCourses({ trash: true }).some((item) => item.id === course.id), true);
  reopened.restoreCourse(course.id);
  assert.equal(reopened.listCourses({}).some((item) => item.id === course.id), true);
  assert.equal(parseJsonResponse('{"summary":"x","keyPoints":["y"]}').summary, "x");
  assert.deepEqual(normalizeNoteShape({ summary: "x", keyPoints: ["y"] }), { summary: "x", keyPoints: ["y"], termsAndFormulas: [], confusions: [], reviewQuestions: [], takeaway: "" });
  const main = fs.readFileSync(path.join(__dirname, "..", "main.cjs"), "utf8");
  assert.match(main, /requestSingleInstanceLock/);
  assert.match(main, /coursescribe-media/);
  assert.match(main, /TRASH_RETENTION_MS/);
  assert.match(main, /purgeExpiredTrash/);
  console.log(JSON.stringify({ ok: true, persistence: true, opencc: true, ollamaJson: true, singleInstance: true }));
} finally {
  try { db.close(); } catch {}
  try { reopened?.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
