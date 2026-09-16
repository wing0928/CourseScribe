const assert = require("node:assert/strict");
const http = require("node:http");
const { OllamaClient } = require("../ollama.cjs");

const note = {
  summary: "本機測試摘要",
  keyPoints: ["可保存結構化結果"],
  termsAndFormulas: ["測試名詞"],
  confusions: [],
  reviewQuestions: ["測試問題？"],
  takeaway: "測試完成",
};

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
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ response: "", thinking: JSON.stringify(note) }));
    return;
  }
  response.statusCode = 404;
  response.end();
});

server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  const client = new OllamaClient(`http://127.0.0.1:${address.port}`);
  try {
    const status = await client.status();
    assert.equal(status.available, true);
    assert.deepEqual(status.models, ["qwen3:4b"]);
    const progress = [];
    const pulled = await client.pull("qwen3:4b", (item) => progress.push(item.status));
    assert.equal(pulled.status, "success");
    assert.deepEqual(progress, ["pulling manifest", "success"]);
    const generated = await client.generateJson({ model: "qwen3:4b", prompt: "測試" });
    assert.equal(generated.value.takeaway, note.takeaway);
    console.log(JSON.stringify({ ok: true, status: true, pullStream: true, structuredJson: true }));
    server.close();
  } catch (error) {
    server.close();
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
});
