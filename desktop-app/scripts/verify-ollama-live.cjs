const assert = require("node:assert/strict");
const {
  OllamaClient, DEFAULT_MODEL, MAP_SCHEMA, SYNTHESIS_SCHEMA,
  getNoteGuide, buildMapPrompt, buildSynthesisPrompt, verifyMapEvidence, assembleCourseNotes,
} = require("../ollama.cjs");

async function main() {
  const client = new OllamaClient();
  const status = await client.status();
  assert.equal(status.available, true, `Ollama 服務無法連線：${status.error || "unknown"}`);
  const model = process.env.COURSESCRIBE_TEST_MODEL || DEFAULT_MODEL;
  assert.ok(status.models.includes(model), `尚未安裝 ${model}`);
  const guide = getNoteGuide();
  const chunks = [
    "[00:00] 今天先說明研究問題如何形成。觀察、提出假設、設計測試，是三個不同步驟。\n[01:00] 在測試時必須控制變因，並記錄可重複的結果。",
    "[04:00] 接著討論資料如何呈現。表格適合比較數值，圖表適合觀察變化趨勢。\n[05:00] 如果樣本太少，結果可能不穩定，不能直接概括全部情況。",
  ];
  const startedAt = Date.now();
  const maps = [];
  for (const chunk of chunks) {
    const result = await client.generateJson({
      model, prompt: buildMapPrompt(chunk, "跨主題課程"), system: guide, schema: MAP_SCHEMA,
      maxOutputTokens: 1100, timeoutMs: 600000,
    });
    const map = verifyMapEvidence(result.value, chunk);
    assert.ok(map.sections.length, "分段未產生任何主題");
    maps.push(map);
  }
  const final = await client.generateJson({
    model, prompt: buildSynthesisPrompt(maps, "跨主題課程"), system: guide, schema: SYNTHESIS_SCHEMA,
    maxOutputTokens: 600, timeoutMs: 600000,
  });
  assert.equal(final.value.summaryParts?.length, chunks.length, "摘要必須對每個分段各寫一句");
  const note = assembleCourseNotes(maps, final.value);
  assert.ok(note.sections.some((section) => /假設|變因|測試/.test(section.title + section.points.map((point) => point.text).join(""))), "研究方法主題遺漏");
  assert.ok(note.sections.some((section) => /表格|圖表|樣本/.test(section.title + section.points.map((point) => point.text).join(""))), "資料呈現主題遺漏");
  assert.ok(note.sections.some((section) => section.points.some((point) => point.status === "source_matched")), "至少一個重點須有原文吻合");
  console.log(JSON.stringify({ model, seconds: Math.round((Date.now() - startedAt) / 1000), calls: chunks.length + 1, sections: note.sections.map((section) => section.title), summary: note.summary }));
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
