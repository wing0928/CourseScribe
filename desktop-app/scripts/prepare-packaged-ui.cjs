const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { CourseDatabase } = require("../database.cjs");

const root = path.resolve(__dirname, "..", "verification-output", "packaged-ui");
const sample = path.resolve(__dirname, "..", "verification-output", "jfk.wav");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
const db = new CourseDatabase(path.join(root, "coursescribe.sqlite"));
const course = db.createCourse({ id: randomUUID(), title: "封裝版 UI 轉錄驗收", source: "import", language: "en-US", status: "draft" });
const mediaPath = path.join(root, "media-library", course.id, "jfk.wav");
fs.mkdirSync(path.dirname(mediaPath), { recursive: true });
fs.copyFileSync(sample, mediaPath);
const media = db.upsertMedia({ courseId: course.id, filePath: mediaPath, originalName: "jfk.wav", mimeType: "audio/wav", mediaType: "audio", extension: "wav", size: fs.statSync(mediaPath).size, processingStatus: "ready" });
db.close();
console.log(JSON.stringify({ root, courseId: course.id, mediaId: media.id }));

