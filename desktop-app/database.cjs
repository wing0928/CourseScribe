const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const COURSE_STATUSES = Object.freeze(["draft", "recording", "transcribing", "summarizing", "ready", "failed"]);

function now() {
  return new Date().toISOString();
}

function normalizeId(value) {
  return String(value || "").trim();
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .toLowerCase()
    .trim();
}

class CourseDatabase {
  constructor(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.filePath = filePath;
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS courses (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'recording',
        language TEXT NOT NULL DEFAULT 'zh-TW',
        model TEXT NOT NULL DEFAULT 'whisper-small',
        category_id TEXT,
        semester TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        FOREIGN KEY(category_id) REFERENCES categories(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS media (
        id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        original_name TEXT NOT NULL,
        mime_type TEXT,
        media_type TEXT NOT NULL,
        extension TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT,
        duration_ms INTEGER,
        processing_status TEXT NOT NULL DEFAULT 'ready',
        is_trash INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        deleted_at TEXT,
        FOREIGN KEY(course_id) REFERENCES courses(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS transcript_segments (
        id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL,
        media_id TEXT,
        start_ms INTEGER NOT NULL DEFAULT 0,
        end_ms INTEGER,
        text TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        language TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(course_id) REFERENCES courses(id) ON DELETE CASCADE,
        FOREIGN KEY(media_id) REFERENCES media(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS transcript_translations (
        id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        target_language TEXT NOT NULL,
        text TEXT NOT NULL,
        model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(segment_id, target_language),
        FOREIGN KEY(course_id) REFERENCES courses(id) ON DELETE CASCADE,
        FOREIGN KEY(segment_id) REFERENCES transcript_segments(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS course_annotations (
        id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL,
        term TEXT NOT NULL,
        normalized_term TEXT NOT NULL,
        note TEXT NOT NULL,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(course_id, normalized_term),
        FOREIGN KEY(course_id) REFERENCES courses(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL,
        model TEXT,
        status TEXT NOT NULL DEFAULT 'ready',
        json TEXT,
        text TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(course_id) REFERENCES courses(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS note_map_cache (
        course_id TEXT NOT NULL,
        model TEXT NOT NULL,
        guide_hash TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        chunk_hash TEXT NOT NULL,
        json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(course_id, model, guide_hash, chunk_index, chunk_hash),
        FOREIGN KEY(course_id) REFERENCES courses(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS terms (
        id TEXT PRIMARY KEY,
        course_id TEXT,
        term TEXT NOT NULL,
        definition TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(course_id) REFERENCES courses(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS semesters (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        course_id TEXT,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        detail TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(course_id) REFERENCES courses(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_courses_updated ON courses(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_courses_status ON courses(status);
      CREATE INDEX IF NOT EXISTS idx_media_course ON media(course_id);
      CREATE INDEX IF NOT EXISTS idx_media_trash ON media(is_trash);
      CREATE INDEX IF NOT EXISTS idx_segments_course_time ON transcript_segments(course_id, start_ms);
      CREATE INDEX IF NOT EXISTS idx_translations_course_target ON transcript_translations(course_id, target_language);
      CREATE INDEX IF NOT EXISTS idx_annotations_course ON course_annotations(course_id);
    `);
    this.ensureColumn("media", "processing_status", "TEXT NOT NULL DEFAULT 'ready'");
    this.db.prepare("INSERT OR IGNORE INTO settings(key, value, updated_at) VALUES (?, ?, ?)").run("selectedOllamaModel", "qwen3:4b", now());
  }

  ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  run(sql, ...params) {
    return this.db.prepare(sql).run(...params);
  }

  get(sql, ...params) {
    return this.db.prepare(sql).get(...params) || null;
  }

  all(sql, ...params) {
    return this.db.prepare(sql).all(...params);
  }

  createCourse(input = {}) {
    const id = normalizeId(input.id) || randomUUID();
    const timestamp = now();
    const title = String(input.title || "未命名課程").trim() || "未命名課程";
    const status = COURSE_STATUSES.includes(input.status) ? input.status : "draft";
    this.run(
      "INSERT INTO courses(id,title,source,language,model,category_id,semester,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      id,
      title,
      String(input.source || "recording"),
      String(input.language || "zh-TW"),
      String(input.model || "whisper-small"),
      input.categoryId ? String(input.categoryId) : null,
      input.semester ? String(input.semester) : null,
      status,
      timestamp,
      timestamp,
    );
    return this.getCourse(id);
  }

  getCourse(id) {
    return this.get(
      `SELECT c.*, cat.name AS category_name,
        (SELECT COUNT(*) FROM transcript_segments s WHERE s.course_id = c.id) AS segment_count,
        (SELECT COUNT(*) FROM media m WHERE m.course_id = c.id AND m.is_trash = 0) AS media_count
       FROM courses c LEFT JOIN categories cat ON cat.id = c.category_id WHERE c.id = ?`,
      normalizeId(id),
    );
  }

  updateCourse(id, patch = {}) {
    const current = this.getCourse(id);
    if (!current) throw new Error("找不到課程");
    const next = {
      title: patch.title == null ? current.title : String(patch.title).trim() || "未命名課程",
      language: patch.language == null ? current.language : String(patch.language),
      model: patch.model == null ? current.model : String(patch.model),
      categoryId: patch.categoryId === undefined ? current.category_id : (patch.categoryId ? String(patch.categoryId) : null),
      semester: patch.semester === undefined ? current.semester : (patch.semester ? String(patch.semester) : null),
      status: patch.status == null ? current.status : String(patch.status),
      error: patch.error === undefined ? current.error : (patch.error ? String(patch.error) : null),
      deletedAt: patch.deletedAt === undefined ? current.deleted_at : patch.deletedAt,
    };
    if (!COURSE_STATUSES.includes(next.status)) next.status = current.status;
    this.run(
      "UPDATE courses SET title=?,language=?,model=?,category_id=?,semester=?,status=?,error=?,deleted_at=?,updated_at=? WHERE id=?",
      next.title,
      next.language,
      next.model,
      next.categoryId,
      next.semester,
      next.status,
      next.error,
      next.deletedAt,
      now(),
      normalizeId(id),
    );
    return this.getCourse(id);
  }

  setCourseCategory(id, categoryId) {
    const course = this.getCourse(id);
    if (!course || course.deleted_at) throw new Error("找不到可編輯的課程");
    const selected = categoryId == null || categoryId === "" ? null : String(categoryId);
    if (selected && !this.get("SELECT id FROM categories WHERE id=?", selected)) throw new Error("選取的分類不存在");
    return this.updateCourse(id, { categoryId: selected });
  }

  listCourses(filters = {}) {
    const where = [];
    const values = [];
    const trash = filters.trash === true || filters.trash === "1" || filters.trash === "trash";
    where.push(trash ? "c.deleted_at IS NOT NULL" : "c.deleted_at IS NULL");
    if (filters.search) {
      where.push("(c.title LIKE ? OR c.semester LIKE ? OR cat.name LIKE ?)");
      const query = `%${String(filters.search).replace(/[\%_]/g, "\\$&")}%`;
      values.push(query, query, query);
    }
    if (filters.status && filters.status !== "all") {
      where.push("c.status = ?");
      values.push(String(filters.status));
    }
    if (filters.categoryId && filters.categoryId !== "all") {
      where.push("c.category_id = ?");
      values.push(String(filters.categoryId));
    }
    if (filters.semester && filters.semester !== "all") {
      where.push("c.semester = ?");
      values.push(String(filters.semester));
    }
    if (filters.mediaType && filters.mediaType !== "all") {
      where.push("EXISTS (SELECT 1 FROM media mt WHERE mt.course_id=c.id AND mt.media_type=? AND mt.is_trash=0)");
      values.push(String(filters.mediaType));
    }
    return this.all(
      `SELECT c.*, cat.name AS category_name,
        (SELECT COUNT(*) FROM transcript_segments s WHERE s.course_id = c.id) AS segment_count,
        (SELECT COUNT(*) FROM media m WHERE m.course_id = c.id AND m.is_trash=0) AS media_count,
        (SELECT GROUP_CONCAT(DISTINCT m.media_type) FROM media m WHERE m.course_id = c.id AND m.is_trash=0) AS media_types
       FROM courses c LEFT JOIN categories cat ON cat.id = c.category_id
       WHERE ${where.join(" AND ")}
       ORDER BY c.updated_at DESC`,
      ...values,
    );
  }

  upsertMedia(input = {}) {
    const id = normalizeId(input.id) || randomUUID();
    const timestamp = now();
    this.run(
      `INSERT INTO media(id,course_id,file_path,original_name,mime_type,media_type,extension,size,sha256,duration_ms,processing_status,is_trash,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET file_path=excluded.file_path,size=excluded.size,sha256=excluded.sha256,duration_ms=excluded.duration_ms,processing_status=excluded.processing_status,is_trash=excluded.is_trash`,
      id,
      normalizeId(input.courseId),
      String(input.filePath || ""),
      String(input.originalName || "media"),
      input.mimeType ? String(input.mimeType) : null,
      String(input.mediaType || "video"),
      String(input.extension || "webm"),
      Number(input.size) || 0,
      input.sha256 ? String(input.sha256) : null,
      input.durationMs == null ? null : Number(input.durationMs),
      String(input.processingStatus || "ready"),
      input.isTrash ? 1 : 0,
      timestamp,
    );
    return this.getMedia(id);
  }

  getMedia(id) {
    return this.get("SELECT * FROM media WHERE id=?", normalizeId(id));
  }

  listMedia(courseId, includeTrash = false) {
    return this.all("SELECT * FROM media WHERE course_id=? AND (?=1 OR is_trash=0) ORDER BY created_at", normalizeId(courseId), includeTrash ? 1 : 0);
  }

  listProcessingMedia(status = "recording") {
    return this.all("SELECT * FROM media WHERE processing_status=? ORDER BY created_at", String(status));
  }

  markMediaTrash(id, isTrash = true, filePath = null) {
    this.run("UPDATE media SET is_trash=?,file_path=?,deleted_at=? WHERE id=?", isTrash ? 1 : 0, filePath || this.getMedia(id)?.file_path || "", isTrash ? now() : null, normalizeId(id));
    return this.getMedia(id);
  }

  updateMedia(id, patch = {}) {
    const current = this.getMedia(id);
    if (!current) throw new Error("找不到媒體");
    this.run(
      "UPDATE media SET file_path=?,size=?,sha256=?,duration_ms=?,processing_status=?,is_trash=?,deleted_at=? WHERE id=?",
      patch.filePath === undefined ? current.file_path : String(patch.filePath || ""),
      patch.size === undefined ? current.size : Number(patch.size) || 0,
      patch.sha256 === undefined ? current.sha256 : patch.sha256,
      patch.durationMs === undefined ? current.duration_ms : patch.durationMs == null ? null : Number(patch.durationMs),
      patch.processingStatus === undefined ? current.processing_status : String(patch.processingStatus),
      patch.isTrash === undefined ? current.is_trash : patch.isTrash ? 1 : 0,
      patch.deletedAt === undefined ? current.deleted_at : patch.deletedAt,
      normalizeId(id),
    );
    return this.getMedia(id);
  }

  addSegments(courseId, mediaId, segments = [], language = "zh-TW") {
    const inserted = [];
    this.db.exec("BEGIN");
    try {
      const find = this.db.prepare("SELECT id FROM transcript_segments WHERE course_id=? AND normalized_text=? AND ABS(start_ms-?) <= 2000 LIMIT 1");
      const insert = this.db.prepare("INSERT INTO transcript_segments(id,course_id,media_id,start_ms,end_ms,text,normalized_text,language,created_at) VALUES(?,?,?,?,?,?,?,?,?)");
      const update = this.db.prepare("UPDATE transcript_segments SET end_ms=?, text=?, language=? WHERE id=?");
      for (const segment of segments) {
        const text = String(segment?.text || "").trim();
        if (!text) continue;
        const startMs = Math.max(0, Math.round(Number(segment.startMs ?? Number(segment.time || 0) * 1000)));
        const endMs = segment.endMs == null ? null : Math.max(startMs, Math.round(Number(segment.endMs)));
        const normalized = normalizeText(text);
        const existing = find.get(normalizeId(courseId), normalized, startMs);
        if (existing) {
          update.run(endMs, text, language, existing.id);
          continue;
        }
        const id = randomUUID();
        insert.run(id, normalizeId(courseId), mediaId ? normalizeId(mediaId) : null, startMs, endMs, text, normalized, language, now());
        inserted.push({ id, startMs, endMs, text, language });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return inserted;
  }

  clearSegments(courseId) {
    this.run("DELETE FROM transcript_segments WHERE course_id=?", normalizeId(courseId));
  }

  listTranslations(courseId, targetLanguage = null) {
    const where = targetLanguage ? "WHERE course_id=? AND target_language=?" : "WHERE course_id=?";
    const values = targetLanguage ? [normalizeId(courseId), String(targetLanguage)] : [normalizeId(courseId)];
    return this.all(`SELECT segment_id AS segmentId,target_language AS targetLanguage,text,model,updated_at AS updatedAt FROM transcript_translations ${where} ORDER BY segment_id`, ...values);
  }

  saveTranslations(courseId, targetLanguage, items = [], model = null) {
    const timestamp = now();
    const insert = this.db.prepare(`INSERT INTO transcript_translations(id,course_id,segment_id,target_language,text,model,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(segment_id,target_language) DO UPDATE SET text=excluded.text,model=excluded.model,updated_at=excluded.updated_at`);
    this.db.exec("BEGIN");
    try {
      for (const item of items) {
        const segmentId = normalizeId(item?.segmentId);
        const text = String(item?.text || "").trim();
        if (!segmentId || !text) continue;
        insert.run(randomUUID(), normalizeId(courseId), segmentId, String(targetLanguage), text, model ? String(model) : null, timestamp, timestamp);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.listTranslations(courseId, targetLanguage);
  }

  listAnnotations(courseId) {
    return this.all("SELECT id,term,normalized_term AS normalizedTerm,note,aliases_json AS aliasesJson,updated_at AS updatedAt FROM course_annotations WHERE course_id=? ORDER BY created_at", normalizeId(courseId)).map((row) => {
      let aliases = [];
      try { aliases = JSON.parse(row.aliasesJson || "[]"); } catch { aliases = []; }
      return { ...row, aliases: Array.isArray(aliases) ? aliases : [] };
    });
  }

  saveAnnotations(courseId, annotations = []) {
    const timestamp = now();
    this.run("DELETE FROM course_annotations WHERE course_id=?", normalizeId(courseId));
    const insert = this.db.prepare("INSERT INTO course_annotations(id,course_id,term,normalized_term,note,aliases_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)");
    for (const item of annotations) {
      const term = String(item?.term || "").trim();
      const note = String(item?.note || "").trim();
      const aliases = [...new Set((Array.isArray(item?.aliases) ? item.aliases : []).map((alias) => String(alias || "").trim()).filter((alias) => alias && alias !== term))].slice(0, 6);
      if (!term || !note) continue;
      insert.run(randomUUID(), normalizeId(courseId), term, normalizeText(term), note, JSON.stringify(aliases), timestamp, timestamp);
    }
    return this.listAnnotations(courseId);
  }

  listSegments(courseId) {
    return this.all("SELECT id,media_id,start_ms AS startMs,end_ms AS endMs,text,language FROM transcript_segments WHERE course_id=? ORDER BY start_ms,id", normalizeId(courseId));
  }

  saveNotes(courseId, input = {}) {
    const timestamp = now();
    const previous = this.getNotes(courseId);
    const id = input.id || previous?.id || randomUUID();
    const json = input.json === undefined ? previous?.json : input.json;
    const noteText = input.text === undefined ? previous?.text : input.text;
    if (previous) {
      this.run("UPDATE notes SET model=?,status=?,json=?,text=?,error=?,updated_at=? WHERE id=?", input.model || previous.model || null, input.status || "ready", json ? JSON.stringify(json) : null, noteText || null, input.error || null, timestamp, previous.id);
    } else {
      this.run("INSERT INTO notes(id,course_id,model,status,json,text,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)", id, normalizeId(courseId), input.model || null, input.status || "ready", json ? JSON.stringify(json) : null, noteText || null, input.error || null, timestamp, timestamp);
    }
    return this.getNotes(courseId);
  }

  getNotes(courseId) {
    const row = this.get("SELECT * FROM notes WHERE course_id=? ORDER BY updated_at DESC LIMIT 1", normalizeId(courseId));
    if (!row) return null;
    let json = null;
    try { json = row.json ? JSON.parse(row.json) : null; } catch { json = null; }
    return { ...row, json };
  }

  getNoteMap(courseId, model, guideHash, chunkIndex, chunkHash) {
    const row = this.get("SELECT json FROM note_map_cache WHERE course_id=? AND model=? AND guide_hash=? AND chunk_index=? AND chunk_hash=?", normalizeId(courseId), String(model), String(guideHash), Number(chunkIndex), String(chunkHash));
    if (!row) return null;
    try { return JSON.parse(row.json); } catch { return null; }
  }

  saveNoteMap(courseId, model, guideHash, chunkIndex, chunkHash, map) {
    this.run("INSERT OR REPLACE INTO note_map_cache(course_id,model,guide_hash,chunk_index,chunk_hash,json,created_at) VALUES(?,?,?,?,?,?,?)", normalizeId(courseId), String(model), String(guideHash), Number(chunkIndex), String(chunkHash), JSON.stringify(map), now());
  }

  listCategories() {
    return this.all("SELECT id,name,created_at AS createdAt FROM categories ORDER BY name COLLATE NOCASE");
  }

  addCategory(name) {
    const cleaned = String(name || "").trim();
    if (!cleaned) throw new Error("分類名稱不可為空");
    const existing = this.get("SELECT * FROM categories WHERE name=?", cleaned);
    if (existing) return existing;
    const id = randomUUID();
    this.run("INSERT INTO categories(id,name,created_at) VALUES(?,?,?)", id, cleaned, now());
    return this.get("SELECT id,name,created_at AS createdAt FROM categories WHERE id=?", id);
  }

  listSemesters() {
    const values = this.all("SELECT name FROM semesters ORDER BY name DESC").map((row) => row.name);
    const legacy = this.all("SELECT DISTINCT semester FROM courses WHERE semester IS NOT NULL AND semester != '' ORDER BY semester DESC").map((row) => row.semester);
    return [...new Set([...values, ...legacy])];
  }

  addSemester(name) {
    const cleaned = String(name || "").trim();
    if (!cleaned) throw new Error("學期不可為空");
    const existing = this.get("SELECT id,name,created_at AS createdAt FROM semesters WHERE name=?", cleaned);
    if (existing) return existing;
    const id = randomUUID();
    this.run("INSERT INTO semesters(id,name,created_at) VALUES(?,?,?)", id, cleaned, now());
    return this.get("SELECT id,name,created_at AS createdAt FROM semesters WHERE id=?", id);
  }

  listTerms(courseId = null) {
    return courseId ? this.all("SELECT * FROM terms WHERE course_id=? ORDER BY created_at", normalizeId(courseId)) : this.all("SELECT * FROM terms ORDER BY created_at DESC");
  }

  saveTerms(courseId, terms = []) {
    this.run("DELETE FROM terms WHERE course_id=?", normalizeId(courseId));
    const insert = this.db.prepare("INSERT INTO terms(id,course_id,term,definition,created_at) VALUES(?,?,?,?,?)");
    for (const item of terms) {
      const term = String(item?.term || "").trim();
      if (term) insert.run(randomUUID(), normalizeId(courseId), term, item.definition ? String(item.definition) : null, now());
    }
    return this.listTerms(courseId);
  }

  createJob(courseId, type) {
    const id = randomUUID();
    const timestamp = now();
    this.run("INSERT INTO jobs(id,course_id,type,status,progress,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", id, courseId ? normalizeId(courseId) : null, String(type), "queued", 0, timestamp, timestamp);
    return this.getJob(id);
  }

  updateJob(id, patch = {}) {
    const current = this.getJob(id);
    if (!current) return null;
    this.run("UPDATE jobs SET status=?,progress=?,detail=?,error=?,updated_at=? WHERE id=?", patch.status || current.status, patch.progress == null ? current.progress : Number(patch.progress), patch.detail === undefined ? current.detail : patch.detail, patch.error === undefined ? current.error : patch.error, now(), normalizeId(id));
    return this.getJob(id);
  }

  getJob(id) { return this.get("SELECT * FROM jobs WHERE id=?", normalizeId(id)); }

  setSetting(key, value) {
    this.run("INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", String(key), value == null ? null : String(value), now());
    return this.getSetting(key);
  }

  getSetting(key, fallback = null) {
    const row = this.get("SELECT value FROM settings WHERE key=?", String(key));
    return row?.value == null ? fallback : row.value;
  }

  getCourseDetail(courseId) {
    const course = this.getCourse(courseId);
    if (!course) return null;
    return { course, media: this.listMedia(courseId, true), segments: this.listSegments(courseId), notes: this.getNotes(courseId), terms: this.listTerms(courseId), translations: this.listTranslations(courseId), annotations: this.listAnnotations(courseId) };
  }

  trashCourse(courseId) {
    return this.updateCourse(courseId, { deletedAt: now() });
  }

  restoreCourse(courseId) {
    return this.updateCourse(courseId, { deletedAt: null });
  }

  deleteCourse(courseId) {
    const course = this.getCourse(courseId);
    if (!course) return false;
    this.run("DELETE FROM courses WHERE id=?", normalizeId(courseId));
    return true;
  }

  close() {
    try { this.db.close(); } catch { /* already closed */ }
  }
}

module.exports = { CourseDatabase, COURSE_STATUSES, normalizeText };
