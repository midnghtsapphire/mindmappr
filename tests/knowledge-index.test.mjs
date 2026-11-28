import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { test } from "node:test";
import {
  KnowledgeIndex,
  cosineSimilarity,
  fitContext,
  keywordScore,
  normalizeForTemplate,
  pickChatModel,
  rankByCosine,
  rankByKeyword,
} from "../knowledge-index.mjs";

function writeJson(dir, name, value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  writeFileSync(join(dir, name), text);
}

function chunk(id, text, title = id) {
  return {
    id,
    path: `knowledge/${id}.md`,
    title,
    chunk_index: 0,
    char_count: text.length,
    text,
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

function tempIndex() {
  return mkdtempSync(join(tmpdir(), "mindmappr-index-"));
}

test("keyword score prefers the note that shares the question words", () => {
  const lidar = chunk("lidar", "Free lidar tiles cover the Wellington survey.", "Lidar notes");
  const coffee = chunk("coffee", "The roaster opens at dawn.", "Coffee");
  assert.ok(keywordScore("where are the lidar tiles", lidar) > keywordScore("where are the lidar tiles", coffee));
  const ranked = rankByKeyword([coffee, lidar], "lidar tiles", 5);
  assert.equal(ranked[0].id, "lidar");
  assert.equal(ranked.length, 1);
});

test("cosine similarity ranks the aligned vector first", () => {
  assert.ok(cosineSimilarity([1, 0], [1, 0]) > cosineSimilarity([1, 0], [0, 1]));
  assert.equal(cosineSimilarity([1, 0], [0, 1, 0]), 0);
  const chunks = [
    chunk("a", "alpha lidar satellite notes"),
    chunk("b", "alpha lidar satellite notes extra"),
  ];
  const vectors = new Map([
    ["a", [1, 0]],
    ["b", [0, 1]],
  ]);
  const ranked = rankByCosine(chunks, vectors, [0.9, 0.1], 5);
  assert.equal(ranked[0].id, "a");
});

test("missing index still asks LM Studio and does not throw", async () => {
  const calls = [];
  const index = new KnowledgeIndex({
    dir: join(tempIndex(), "does-not-exist"),
    model: "local-chat",
    baseUrl: "http://127.0.0.1:1234/v1",
    fetchImpl: async (url, options) => {
      calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
      return jsonResponse(200, { choices: [{ message: { content: "still here" } }] });
    },
  });
  const messages = [{ role: "user", content: "hello" }];
  const result = await index.answer(messages);
  assert.equal(result.ok, true);
  assert.equal(result.text, "still here");
  assert.equal(result.indexStatus, "missing");
  assert.equal(result.retrieval, "none");
  assert.equal(result.chunks.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.messages.length, 1);
  assert.equal(calls[0].body.model, "local-chat");
  assert.equal(calls[0].body.messages[0].content, "hello");
});

test("malformed chunks.json is ignored and the question still goes out", async () => {
  const dir = tempIndex();
  writeJson(dir, "chunks.json", "{ this is not json");
  const index = new KnowledgeIndex({
    dir,
    model: "local-chat",
    fetchImpl: async () => jsonResponse(200, { choices: [{ message: { content: "ok" } }] }),
  });
  const result = await index.answer([{ role: "user", content: "lidar" }]);
  assert.equal(result.indexStatus, "invalid");
  assert.equal(result.retrieval, "none");
  assert.equal(result.ok, true);
  rmSync(dir, { recursive: true, force: true });
});

test("keyword retrieval puts the matching note in the chat request", async () => {
  const dir = tempIndex();
  writeJson(dir, "chunks.json", {
    version: 1,
    chunks: [
      chunk("lidar", "The laptop index stores lidar source links.", "Lidar"),
      chunk("coffee", "Beans stay in the hopper.", "Coffee"),
    ],
  });
  const calls = [];
  const index = new KnowledgeIndex({
    dir,
    model: "qwen-local",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body), headers: options.headers });
      return jsonResponse(200, { choices: [{ message: { content: "from the notes" } }] });
    },
  });
  const result = await index.answer([
    { role: "system", content: "You are MindMappr." },
    { role: "user", content: "Where are the lidar links?" },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.retrieval, "keyword");
  assert.equal(result.chunks[0].id, "lidar");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/chat\/completions$/);
  const sent = calls[0].body.messages;
  assert.equal(sent.filter((message) => message.role === "system").length, 1);
  assert.equal(sent[0].role, "system");
  assert.match(sent[0].content, /You are MindMappr/);
  assert.match(sent[0].content, /lidar source links/);
  assert.match(sent[0].content, /knowledge\/lidar\.md/);
  assert.equal(sent[1].role, "user");
  assert.equal(sent[1].content, "Where are the lidar links?");
  assert.equal(calls[0].body.model, "qwen-local");
  assert.equal(calls[0].body.max_tokens, 4096);
  assert.equal(calls[0].headers.Authorization, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("embeddings outrank a keyword overlap when LM Studio returns a query vector", async () => {
  const dir = tempIndex();
  const chunks = [
    chunk("a", "alpha lidar satellite notes"),
    chunk("b", "alpha lidar satellite notes extra"),
  ];
  writeJson(dir, "chunks.json", { version: 1, chunks });
  writeJson(dir, "embeddings.json", {
    version: 1,
    model: "nomic-embed",
    items: [
      { id: "a", model: "nomic-embed", embedding: [1, 0] },
      { id: "b", model: "nomic-embed", embedding: [0, 1] },
    ],
  });
  const calls = [];
  const index = new KnowledgeIndex({
    dir,
    model: "local-chat",
    apiKey: "local-only",
    fetchImpl: async (url, options) => {
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ url: String(url), body, headers: options.headers });
      if (String(url).endsWith("/embeddings")) {
        return jsonResponse(200, { data: [{ embedding: [1, 0] }] });
      }
      return jsonResponse(200, { choices: [{ message: { content: "vector hit" } }] });
    },
  });
  const result = await index.answer([{ role: "user", content: "alpha lidar satellite notes extra" }]);
  assert.equal(result.retrieval, "embedding");
  assert.equal(result.chunks[0].id, "a");
  assert.match(calls[0].url, /\/embeddings$/);
  assert.equal(calls[0].body.model, "nomic-embed");
  assert.equal(calls[0].headers.Authorization, "Bearer local-only");
  assert.match(calls[1].body.messages[0].content, /knowledge\/a\.md/);
  assert.doesNotMatch(calls[1].body.messages[0].content, /knowledge\/b\.md/);
  rmSync(dir, { recursive: true, force: true });
});

test("a failed embedding call falls back to keyword scoring", async () => {
  const dir = tempIndex();
  writeJson(dir, "chunks.json", {
    version: 1,
    chunks: [chunk("lidar", "Lidar tiles live in the knowledge folder.", "Lidar")],
  });
  writeJson(dir, "embeddings.json", {
    version: 1,
    model: "nomic-embed",
    items: [{ id: "lidar", model: "nomic-embed", embedding: [0.2, 0.8] }],
  });
  const calls = [];
  const index = new KnowledgeIndex({
    dir,
    model: "local-chat",
    fetchImpl: async (url, options) => {
      calls.push(String(url));
      if (String(url).endsWith("/embeddings")) throw new Error("connection refused");
      return jsonResponse(200, { choices: [{ message: { content: "keyword fallback" } }] });
    },
  });
  const result = await index.answer([{ role: "user", content: "lidar tiles" }]);
  assert.equal(result.retrieval, "keyword");
  assert.equal(result.text, "keyword fallback");
  assert.equal(calls.length, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("LM Studio being down returns a miss instead of throwing", async () => {
  const dir = tempIndex();
  writeJson(dir, "chunks.json", { version: 1, chunks: [chunk("lidar", "lidar notes", "Lidar")] });
  const index = new KnowledgeIndex({
    dir,
    model: "local-chat",
    fetchImpl: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:1234"); },
  });
  const result = await index.answer([{ role: "user", content: "lidar" }]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "lm-studio-unavailable");
  assert.equal(result.retrieval, "keyword");
  rmSync(dir, { recursive: true, force: true });
});

test("an HTTP error from LM Studio is a miss", async () => {
  const index = new KnowledgeIndex({
    dir: tempIndex(),
    model: "local-chat",
    fetchImpl: async () => jsonResponse(503, { error: "no model loaded" }),
  });
  const result = await index.answer([{ role: "user", content: "hello" }]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "lm-studio-http-503");
});

test("local chat runs a tool and sends the result back", async () => {
  const calls = [];
  const index = new KnowledgeIndex({
    dir: tempIndex(),
    model: "qwen-local",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      const toolMsgs = body.messages.filter((message) => message.role === "tool");
      if (toolMsgs.length === 0) {
        return jsonResponse(200, {
          choices: [{
            message: {
              content: null,
              tool_calls: [{ id: "t1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"lidar\"}" } }],
            },
          }],
        });
      }
      return jsonResponse(200, { choices: [{ message: { content: "from the tool" } }] });
    },
  });
  const result = await index.answer([{ role: "user", content: "where is lidar" }], {
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }],
    executeTool: async (_name, args) => ({ success: true, q: args.q }),
    confirmRequired: [],
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, "from the tool");
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages.find((message) => message.role === "tool").content, /lidar/);
});

test("an unset model prefers a tool-capable LM Studio model", () => {
  assert.equal(pickChatModel(["nomic-embed", "llama-3-8b", "qwen2.5-7b-instruct"]), "qwen2.5-7b-instruct");
  assert.equal(pickChatModel(["llama-3-8b", "nomic-embed"]), "llama-3-8b");
  assert.equal(pickChatModel(["nomic-embed"]), "nomic-embed");
});

test("the chat model is chosen from LM Studio when none is configured", async () => {
  const calls = [];
  const index = new KnowledgeIndex({
    dir: tempIndex(),
    model: "",
    fetchImpl: async (url, options) => {
      calls.push(String(url));
      if (String(url).endsWith("/models")) {
        return jsonResponse(200, { data: [{ id: "nomic-embed" }, { id: "qwen" }] });
      }
      const body = JSON.parse(options.body);
      assert.equal(body.model, "qwen");
      return jsonResponse(200, { choices: [{ message: { content: "picked" } }] });
    },
  });
  const result = await index.answer([{ role: "user", content: "hi" }]);
  assert.equal(result.ok, true);
  assert.equal(result.model, "qwen");
  assert.ok(calls[0].endsWith("/models"));
});

test("the index reloads after chunks.json changes", async () => {
  const dir = tempIndex();
  writeJson(dir, "chunks.json", {
    version: 1,
    chunks: [chunk("apple", "An apple pie cools on the rack.", "Apple")],
  });
  const seen = [];
  const index = new KnowledgeIndex({
    dir,
    model: "local-chat",
    fetchImpl: async (_url, options) => {
      seen.push(JSON.parse(options.body).messages.map((message) => message.content).join("\n"));
      return jsonResponse(200, { choices: [{ message: { content: "ok" } }] });
    },
  });
  const first = await index.answer([{ role: "user", content: "apple pie" }]);
  assert.equal(first.retrieval, "keyword");
  assert.match(seen[0], /apple pie cools/);

  writeJson(dir, "chunks.json", {
    version: 1,
    chunks: [chunk("zebra", "Zebras graze on the open plain.", "Zebra")],
  });
  const later = new Date(Date.now() + 2000);
  utimesSync(join(dir, "chunks.json"), later, later);
  const second = await index.answer([{ role: "user", content: "apple pie" }]);
  assert.equal(second.retrieval, "none");
  assert.doesNotMatch(seen[1], /apple pie cools/);

  const third = await index.answer([{ role: "user", content: "where do zebras graze" }]);
  assert.equal(third.chunks[0].id, "zebra");
  assert.match(seen[2], /open plain/);
  rmSync(dir, { recursive: true, force: true });
});

test("the caller token budget is sent to LM Studio", async () => {
  const dir = tempIndex();
  writeJson(dir, "chunks.json", { version: 1, chunks: [chunk("lidar", "Lidar notes stay local.", "Lidar")] });
  let maxTokens = 0;
  const index = new KnowledgeIndex({
    dir,
    model: "local-chat",
    fetchImpl: async (_url, options) => {
      maxTokens = JSON.parse(options.body).max_tokens;
      return jsonResponse(200, { choices: [{ message: { content: "ok" } }] });
    },
  });
  await index.answer([{ role: "user", content: "lidar" }], { maxTokens: 16384 });
  assert.equal(maxTokens, 16384);
  rmSync(dir, { recursive: true, force: true });
});

test("an unchanged index is reused without reading the files again", () => {
  const dir = tempIndex();
  writeJson(dir, "chunks.json", { version: 1, chunks: [chunk("lidar", "Cached lidar note.", "Lidar")] });
  const index = new KnowledgeIndex({ dir, model: "local-chat" });
  const first = index.load();
  const second = index.load();
  assert.equal(second, first);
  assert.equal(second.chunks[0].id, "lidar");
  rmSync(dir, { recursive: true, force: true });
});

test("a byte-order mark on chunks.json still loads", async () => {
  const dir = tempIndex();
  writeFileSync(join(dir, "chunks.json"), `\uFEFF${JSON.stringify({
    version: 1,
    chunks: [chunk("lidar", "Marked lidar note.", "Lidar")],
  })}`);
  const index = new KnowledgeIndex({
    dir,
    model: "local-chat",
    fetchImpl: async () => jsonResponse(200, { choices: [{ message: { content: "ok" } }] }),
  });
  const result = await index.answer([{ role: "user", content: "lidar note" }]);
  assert.equal(result.indexStatus, "ok");
  assert.equal(result.chunks[0].id, "lidar");
  rmSync(dir, { recursive: true, force: true });
});

test("chat messages are merged into one system and strict user/assistant turns", () => {
  const normalized = normalizeForTemplate([
    { role: "system", content: "You are MindMappr." },
    { role: "system", content: "Notes from the local MindMappr knowledge index.\n\nlidar" },
    { role: "user", content: "first" },
    { role: "user", content: "second" },
    { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"lidar\"}" } }] },
    { role: "tool", tool_call_id: "1", content: "{\"hit\":\"lidar\"}" },
  ], { textTools: true });
  assert.equal(normalized.filter((message) => message.role === "system").length, 1);
  assert.match(normalized[0].content, /You are MindMappr/);
  assert.match(normalized[0].content, /lidar/);
  assert.deepEqual(normalized.slice(1).map((message) => message.role), ["user", "assistant", "user"]);
  assert.equal(normalized.some((message) => message.role === "tool"), false);
  assert.match(normalized[2].content, /TOOL:lookup/);
  assert.match(normalized[3].content, /Tool results/);
});

test("a conversation that starts with the assistant gets a user turn first", () => {
  const normalized = normalizeForTemplate([
    { role: "assistant", content: "hello" },
    { role: "assistant", content: "still here" },
  ], { textTools: true });
  assert.deepEqual(normalized.map((message) => message.role), ["user", "assistant"]);
  assert.match(normalized[1].content, /hello/);
  assert.match(normalized[1].content, /still here/);
});

test("an unloaded model or a 27B model is not chosen on its own", () => {
  assert.equal(pickChatModel([
    { id: "qwen/qwen3.5-9b", state: "not-loaded" },
    { id: "qwen/qwen3.8-27b", state: "loaded", loaded_context_length: 8192 },
    { id: "mindmappr-local", state: "loaded", loaded_context_length: 8192 },
    { id: "google/gemma-3-4b", state: "loaded", loaded_context_length: 131072 },
    { id: "nomic-embed-text", state: "loaded" },
  ]), "mindmappr-local");
  assert.equal(pickChatModel([
    { id: "google/gemma-3-4b", state: "loaded" },
    { id: "qwen/qwen3.5-9b", state: "loaded" },
    { id: "qwen/qwen3.8-27b", state: "loaded" },
  ]), "qwen/qwen3.5-9b");
  assert.equal(pickChatModel([{ id: "qwen/qwen3.8-27b", state: "loaded" }]), "");
  assert.equal(pickChatModel([{ id: "qwen/qwen3.5-9b", state: "not-loaded" }]), "");
  assert.equal(pickChatModel(["qwen/qwen3.8-27b", "google/gemma-3-4b"]), "google/gemma-3-4b");
});

test("old history is trimmed before the latest question", () => {
  const history = [{
    role: "system",
    content: `You are MindMappr.\n\nNotes from the local MindMappr knowledge index.\n${"n".repeat(8000)}`,
  }];
  for (let i = 0; i < 12; i++) {
    history.push({ role: "user", content: `old question ${i} ${"q".repeat(800)}` });
    history.push({ role: "assistant", content: `old answer ${i} ${"a".repeat(800)}` });
  }
  history.push({ role: "user", content: "keep this question" });
  const fitted = fitContext(history, { contextLength: 8192, ratio: 0.75, textTools: true });
  const joined = fitted.map((message) => message.content || "").join("\n");
  assert.match(joined, /keep this question/);
  assert.doesNotMatch(joined, /old question 0/);
  assert.equal(fitted.filter((message) => message.role === "system").length, 1);
  const roles = fitted.filter((message) => message.role !== "system").map((message) => message.role);
  roles.forEach((role, index) => {
    assert.equal(role, index % 2 === 0 ? "user" : "assistant");
  });
});

test("only a loaded model is sent to LM Studio", async () => {
  let seen = "";
  const index = new KnowledgeIndex({
    dir: tempIndex(),
    model: "",
    fetchImpl: async (url, options) => {
      if (String(url).includes("/api/v0/models")) {
        return jsonResponse(200, {
          data: [
            { id: "qwen/qwen3.5-9b", state: "not-loaded" },
            { id: "qwen/qwen3.8-27b", state: "not-loaded" },
            { id: "mindmappr-local", state: "loaded", loaded_context_length: 8192 },
            { id: "nomic-embed-text", state: "loaded" },
          ],
        });
      }
      seen = JSON.parse(options.body).model;
      return jsonResponse(200, { choices: [{ message: { content: "local" } }] });
    },
  });
  const result = await index.answer([{ role: "user", content: "hi" }]);
  assert.equal(result.ok, true);
  assert.equal(result.model, "mindmappr-local");
  assert.equal(seen, "mindmappr-local");
});

test("an explicit local model is kept even when it is large", async () => {
  let seen = "";
  const index = new KnowledgeIndex({
    dir: tempIndex(),
    model: "qwen/qwen3.8-27b",
    fetchImpl: async (_url, options) => {
      seen = JSON.parse(options.body).model;
      return jsonResponse(200, { choices: [{ message: { content: "explicit" } }] });
    },
  });
  const result = await index.answer([{ role: "user", content: "hi" }]);
  assert.equal(result.ok, true);
  assert.equal(seen, "qwen/qwen3.8-27b");
});

test("a context overflow is trimmed harder and retried once", async () => {
  const bodies = [];
  const index = new KnowledgeIndex({
    dir: tempIndex(),
    model: "mindmappr-local",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      if (bodies.length === 1) {
        return jsonResponse(400, { error: "request (8381 tokens) exceeds the available context size (8192 tokens)" });
      }
      return jsonResponse(200, { choices: [{ message: { content: "short enough" } }] });
    },
  });
  const messages = [];
  for (let i = 0; i < 10; i++) {
    messages.push({ role: "user", content: `earlier ${i} ${"x".repeat(1500)}` });
    messages.push({ role: "assistant", content: `reply ${i} ${"y".repeat(1500)}` });
  }
  messages.push({ role: "user", content: "latest question" });
  const result = await index.answer(messages);
  assert.equal(result.ok, true);
  assert.equal(result.text, "short enough");
  assert.equal(bodies.length, 2);
  const size = (body) => body.messages.map((message) => message.content || "").join("").length;
  assert.ok(size(bodies[1]) < size(bodies[0]));
  assert.match(bodies[1].messages.map((message) => message.content).join("\n"), /latest question/);
});

test("a Jinja template rejection is retried once as plain user and assistant text", async () => {
  const bodies = [];
  const index = new KnowledgeIndex({
    dir: tempIndex(),
    model: "google/gemma-3-4b",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      if (bodies.length === 1) {
        return jsonResponse(400, { error: "Unable to generate parser for this template. Jinja Exception: Conversation roles must alternate user/assistant/user/assistant/..." });
      }
      return jsonResponse(200, { choices: [{ message: { content: "alternating" } }] });
    },
  });
  const result = await index.answer([
    { role: "system", content: "You are MindMappr." },
    { role: "system", content: "Notes from the local MindMappr knowledge index.\nlidar" },
    { role: "user", content: "hello" },
    { role: "user", content: "again" },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.text, "alternating");
  assert.equal(bodies.length, 2);
  for (const body of bodies) {
    assert.equal(body.tools, undefined);
    assert.equal(body.messages.filter((message) => message.role === "system").length, 1);
    assert.equal(body.messages.some((message) => message.role === "tool"), false);
    const roles = body.messages.filter((message) => message.role !== "system").map((message) => message.role);
    roles.forEach((role, index) => {
      assert.equal(role, index % 2 === 0 ? "user" : "assistant");
    });
  }
  assert.match(bodies[0].messages.find((message) => message.role === "user").content, /hello/);
  assert.match(bodies[0].messages.find((message) => message.role === "user").content, /again/);
});
