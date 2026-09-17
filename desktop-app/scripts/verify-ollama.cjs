const assert = require("node:assert/strict");
const http = require("node:http");
const {
  OllamaClient, MAP_SCHEMA, SYNTHESIS_SCHEMA, getNoteGuide,
  buildMapPrompt, buildSynthesisPrompt, prepareTranscriptChunks, verifyMapEvidence, assembleCourseNotes, normalizeNoteShape,
} = require("../ollama.cjs");

const map = { sections: [
  { title: "概念一", timestamp: "00:00", points: [{ text: "第一個概念的條件與結論", quote: "第一個概念的條件" }] },
  { title: "概念二", timestamp: "03:20", points: [{ text: "第二個概念的步驟", quote: "第二個概念的步驟" }] },
], uncertainties: ["一個詞辨識不清"] };
const synthesis = { summaryParts: ["課程比較兩個概念及其使用條件。"], reviewQuestions: ["兩者有何不同？"], takeaway: "依條件選擇方法。" };
const generateRequests = [];

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/api/tags") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ models: [{ name: "qwen3:4b" }] }));
    return;
  }
  if (request.method === "POST" && request.url === "/api/pull") {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.write(`${JSON.stringify({ status: "pulling manifest", completed: 1, total: 2 })}\n`);
    response.end(`${JSON.stringify({ status: "success", completed: 2, total: 2 })}\n`);
    return;
  }
  if (request.method === "POST" && request.url === "/api/generate") {
    const parts = [];
    for await (const part of request) parts.push(part);
    const payload = JSON.parse(Buffer.concat(parts).toString("utf8"));
    generateRequests.push(payload);
    const answer = JSON.stringify(payload.format.required.includes("sections") ? map : synthesis);
    if (payload.stream) {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write(`${JSON.stringify({ response: answer.slice(0, 30), done: false })}\n`);
      response.end(`${JSON.stringify({ response: answer.slice(30), done: true, eval_count: 123 })}\n`);
    } else {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ response: "", thinking: answer }));
    }
    return;
  }
  response.statusCode = 404;
  response.end();
});

server.listen(0, "127.0.0.1", async () => {
  const client = new OllamaClient(`http://127.0.0.1:${server.address().port}`);
  try {
    const status = await client.status();
    assert.deepEqual(status.models, ["qwen3:4b"]);
    const pulled = await client.pull("qwen3:4b");
    assert.equal(pulled.status, "success");
    const guide = getNoteGuide();
    assert.match(guide, /任何科目/);
    const chunks = prepareTranscriptChunks([
      { startMs: 0, text: "第一個概念的條件" },
      { startMs: 1000, text: "第一個概念的條件" },
      { startMs: 200000, text: "第二個概念的步驟" },
    ], 150);
    assert.equal(chunks.join("\n").match(/第一個概念的條件/g).length, 1, "只去除相鄰的完全重複文字");
    const updates = [];
    const first = await client.generateJson({ model: "qwen3:4b", prompt: buildMapPrompt(chunks.join("\n"), "測試課程"), system: guide, schema: MAP_SCHEMA, maxOutputTokens: 1100, onProgress: (item) => updates.push(item) });
    assert.equal(generateRequests.at(-1).stream, true);
    assert.equal(generateRequests.at(-1).system, guide, "Markdown 規範必須實際傳給 Ollama");
    assert.equal(generateRequests.at(-1).think, false);
    assert.equal(generateRequests.at(-1).options.num_predict, 1100);
    assert.equal(updates.at(-1).evalCount, 123);
    assert.equal(first.value.sections.length, 2);
    const verified = verifyMapEvidence(first.value, chunks.join("\n"));
    assert.equal(verified.sections[0].points[0].status, "source_matched");
    assert.equal(verified.sections[0].points[0].timestamp, "00:00");
    assert.equal(verified.sections[1].points[0].status, "source_matched");
    const falseQuote = verifyMapEvidence({ sections: [{ title: "未佐證", timestamp: "99:99", points: [{ text: "模型捏造的內容", quote: "逐字稿根本沒說這件事" }] }], uncertainties: [] }, chunks.join("\n"));
    assert.equal(falseQuote.sections[0].points[0].status, "needs_review");
    assert.equal(falseQuote.sections[0].points[0].timestamp, "");
    assert.equal(normalizeNoteShape({ sections: [{ title: "舊版", points: ["舊筆記"] }] }).sections[0].points[0].status, "needs_review");
    const second = await client.generateJson({ model: "qwen3:4b", prompt: buildSynthesisPrompt([verified], "測試課程"), system: guide, schema: SYNTHESIS_SCHEMA });
    const notes = assembleCourseNotes([verified], second.value);
    assert.equal(notes.sections.length, 2, "全課摘要不得吞掉分段主題");
    const repeated = assembleCourseNotes([{ sections: [map.sections[0], map.sections[0], map.sections[1]], uncertainties: [] }], synthesis);
    assert.equal(repeated.sections.length, 2, "相鄰同名主題應去重但不得遺失其他主題");
    assert.equal(notes.summary, synthesis.summaryParts[0], "全課概覽不應被冗長的主題清單蓋過");
    const partial = assembleCourseNotes([{ sections: [verified.sections[0]], uncertainties: [] }, { sections: [verified.sections[1]], uncertainties: [] }], synthesis);
    assert.match(partial.summary, /第 2 段討論 概念二/, "模型漏寫某段概覽時必須保留該段主題");
    const pendingSummary = assembleCourseNotes([falseQuote], { summaryParts: ["模型捏造的概覽"] });
    assert.match(pendingSummary.summary, /重點皆待核/, "沒有來源吻合的段落不可採信模型摘要");
    assert.deepEqual(notes.confusions, map.uncertainties);
    assert.ok(!Object.hasOwn(notes, "historicalFigures"), "不得再輸出固定的人物欄位");
    console.log(JSON.stringify({ ok: true, markdownSent: true, evidenceMatched: true, unmatchedNeedsReview: true, legacyNeedsReview: true, everySectionPreserved: true, streamProgress: true }));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  } finally { server.close(); }
});
