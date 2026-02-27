import express from "express";
import cors from "cors";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, readFileSync, writeFileSync } from "fs";
import { join, dirname, extname, basename } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT || "3005");
const LLM_API_KEY = process.env.LLM_API_KEY || "";
const LLM_BASE_URL = "https://openrouter.ai/api/v1";
const LLM_MODEL = process.env.LLM_MODEL || "anthropic/claude-sonnet-4";
const UPLOADS_DIR = join(__dirname, "uploads");
const DATA_DIR = join(__dirname, "data");

[UPLOADS_DIR, DATA_DIR].forEach(d => { if (!existsSync(d)) mkdirSync(d, { recursive: true }); });

// ── Data helpers ──────────────────────────────────────────────────────────────
function loadData(n) { try { return JSON.parse(readFileSync(join(DATA_DIR, n + ".json"), "utf8")); } catch { return []; } }
function loadObj(n)  { try { return JSON.parse(readFileSync(join(DATA_DIR, n + ".json"), "utf8")); } catch { return {}; } }
function saveData(n, d) { writeFileSync(join(DATA_DIR, n + ".json"), JSON.stringify(d, null, 2)); }
function getKey(name) { return loadObj("api_keys")[name] || null; }
function storeKey(name, key) { const k = loadObj("api_keys"); k[name] = key; writeFileSync(join(DATA_DIR, "api_keys.json"), JSON.stringify(k, null, 2)); }
function saveMeta(name, size, type, creator) {
  const m = loadObj("file_meta");
  m[name] = { name, size, type, creator, createdAt: new Date().toISOString() };
  saveData("file_meta", m);
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Serve static files from public/
app.use("/mindmappr", express.static(join(__dirname, "public")));
app.use("/mindmappr/uploads", express.static(UPLOADS_DIR));

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are MindMappr, an AI execution agent owned by Audrey Evans (Revvel/GlowStarLabs). GitHub: MIDNGHTSAPPHIRE.

RULES:
1. You are an EXECUTION AGENT. When asked to create, generate, build, write, or do anything — DO IT with tools. Never explain how. Never show code, API payloads, or technical details unless explicitly asked.
2. Talk in plain, warm, friendly language. Keep responses under 150 words. No jargon.
3. When you need to execute a task, output EXACTLY this on its own line (nothing else on that line):
   <tool_call>{"tool":"TOOLNAME","params":{...}}</tool_call>
4. Available tools:
   - elevenlabs_tts: params: {text, voice_id?} — generates an MP3 audio file
   - generate_image: params: {prompt, width?, height?} — creates a PNG image using ImageMagick
   - create_video: params: {audio_file?, image_file?, title?} — combines audio+image into MP4
   - create_pdf: params: {title, content} — creates a Markdown document
   - run_python: params: {code, output_file?} — runs Python code, can save output files
   - web_scrape: params: {url} — fetches and returns text from a URL
   - create_csv: params: {filename, headers, rows} — creates a CSV file
   - create_html: params: {filename, html} — saves an HTML file
   - send_slack: params: {message, channel?} — sends a Slack message (if connected)
5. After a tool runs successfully, give a warm 1-2 sentence response saying the file is ready. Never show filenames or technical paths.
6. If a tool fails, say so plainly and offer to try another way.

Owner: Audrey Evans, AuDHD, 60, cancer survivor. Daughter is legally deaf. Be warm, direct, accessible.`;

// ── LLM call ──────────────────────────────────────────────────────────────────
async function callLLM(messages, model) {
  const m = model || LLM_MODEL;
  const r = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${LLM_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://meetaudreyevans.com",
      "X-Title": "MindMappr"
    },
    body: JSON.stringify({ model: m, messages, max_tokens: 2048, temperature: 0.7 })
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`LLM ${r.status}: ${t.slice(0, 200)}`); }
  const d = await r.json();
  return d.choices?.[0]?.message?.content || "No response.";
}

// ── Tool call parser ──────────────────────────────────────────────────────────
function parseToolCall(text) {
  const m = text.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
  if (!m) return null;
  try { return JSON.parse(m[1].trim()); } catch { return null; }
}

// ── Tool executor ─────────────────────────────────────────────────────────────
async function executeTool(tool, params) {

  // ── ElevenLabs TTS ──
  if (tool === "elevenlabs_tts") {
    const key = getKey("ELEVENLABS-MINDMAPPR") || getKey("elevenlabs") || getKey("ElevenLabs");
    if (!key) return { success: false, error: "ElevenLabs API key not found. Please add it in the APIs tab." };
    try {
      const vid = params.voice_id || "21m00Tcm4TlvDq8ikWAM";
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}`, {
        method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json", "Accept": "audio/mpeg" },
        body: JSON.stringify({ text: params.text || "Hello", model_id: "eleven_monolingual_v1", voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
      });
      if (!r.ok) { const t = await r.text(); return { success: false, error: `ElevenLabs: ${t.slice(0, 200)}` }; }
      const buf = Buffer.from(await r.arrayBuffer());
      const fname = `tts_${Date.now()}.mp3`;
      writeFileSync(join(UPLOADS_DIR, fname), buf);
      saveMeta(fname, buf.length, "audio/mpeg", "mindmappr");
      return { success: true, file: fname, type: "audio", message: `Audio ready (${Math.round(buf.length / 1024)}KB)` };
    } catch (e) { return { success: false, error: e.message }; }
  }

  // ── Generate image (ImageMagick) ──
  if (tool === "generate_image") {
    try {
      const fname = `img_${Date.now()}.png`;
      const fpath = join(UPLOADS_DIR, fname);
      const w = params.width || 800; const h = params.height || 600;
      const safe = (params.prompt || "Generated image").replace(/["\\`$]/g, "").slice(0, 80);
      // Gradient background + centered text label
      await execAsync(`convert -size ${w}x${h} gradient:"#1a1a2e"-"#16213e" -font DejaVu-Sans -pointsize 28 -fill "#e94560" -gravity Center -annotate 0 "${safe}" "${fpath}"`);
      const size = statSync(fpath).size;
      saveMeta(fname, size, "image/png", "mindmappr");
      return { success: true, file: fname, type: "image", message: "Image created" };
    } catch (e) { return { success: false, error: e.message }; }
  }

  // ── Create video (FFmpeg) ──
  if (tool === "create_video") {
    try {
      const fname = `video_${Date.now()}.mp4`;
      const fpath = join(UPLOADS_DIR, fname);
      const audPath = params.audio_file ? join(UPLOADS_DIR, basename(params.audio_file)) : null;
      const imgPath = params.image_file ? join(UPLOADS_DIR, basename(params.image_file)) : null;
      let cmd;
      if (imgPath && existsSync(imgPath) && audPath && existsSync(audPath)) {
        cmd = `ffmpeg -loop 1 -i "${imgPath}" -i "${audPath}" -c:v libx264 -tune stillimage -c:a aac -b:a 192k -pix_fmt yuv420p -shortest -y "${fpath}"`;
      } else if (audPath && existsSync(audPath)) {
        const tmp = join(UPLOADS_DIR, `tmp_${Date.now()}.png`);
        const title = (params.title || "MindMappr").replace(/["\\`$]/g, "").slice(0, 50);
        await execAsync(`convert -size 1280x720 gradient:"#1a1a2e"-"#0f3460" -font DejaVu-Sans -pointsize 48 -fill white -gravity Center -annotate 0 "${title}" "${tmp}"`);
        cmd = `ffmpeg -loop 1 -i "${tmp}" -i "${audPath}" -c:v libx264 -tune stillimage -c:a aac -b:a 192k -pix_fmt yuv420p -shortest -y "${fpath}"`;
        setTimeout(() => { try { unlinkSync(tmp); } catch {} }, 30000);
      } else {
        return { success: false, error: "Need an audio file first. Ask me to generate audio, then I can make the video." };
      }
      await execAsync(cmd, { timeout: 120000 });
      const size = statSync(fpath).size;
      saveMeta(fname, size, "video/mp4", "mindmappr");
      return { success: true, file: fname, type: "video", message: `Video ready (${Math.round(size / 1024 / 1024 * 10) / 10}MB)` };
    } catch (e) { return { success: false, error: e.message }; }
  }

  // ── Create document (Markdown) ──
  if (tool === "create_pdf") {
    try {
      const fname = `doc_${Date.now()}.md`;
      writeFileSync(join(UPLOADS_DIR, fname), `# ${params.title || "Document"}\n\n${params.content || ""}`);
      const size = statSync(join(UPLOADS_DIR, fname)).size;
      saveMeta(fname, size, "text/markdown", "mindmappr");
      return { success: true, file: fname, type: "document", message: `Document ready: ${params.title || "Document"}` };
    } catch (e) { return { success: false, error: e.message }; }
  }

  // ── Run Python ──
  if (tool === "run_python") {
    try {
      const tmp = `/tmp/mm_${Date.now()}.py`;
      let code = params.code || "print('hello')";
      // If output_file specified, inject UPLOADS_DIR path
      if (params.output_file) {
        const outPath = join(UPLOADS_DIR, basename(params.output_file));
        code = `OUTPUT_FILE = "${outPath}"\n` + code;
      }
      writeFileSync(tmp, code);
      const { stdout, stderr } = await execAsync(`python3 "${tmp}"`, { timeout: 30000 });
      setTimeout(() => { try { unlinkSync(tmp); } catch {} }, 5000);
      // Check if an output file was created
      if (params.output_file) {
        const outPath = join(UPLOADS_DIR, basename(params.output_file));
        if (existsSync(outPath)) {
          const size = statSync(outPath).size;
          const ext = extname(params.output_file).toLowerCase();
          const mimeMap = { ".png": "image/png", ".jpg": "image/jpeg", ".csv": "text/csv", ".txt": "text/plain", ".html": "text/html", ".json": "application/json", ".pdf": "application/pdf" };
          const mime = mimeMap[ext] || "application/octet-stream";
          saveMeta(basename(params.output_file), size, mime, "mindmappr");
          return { success: true, file: basename(params.output_file), type: ext.slice(1) || "file", output: stdout.slice(0, 500), message: `File ready (${Math.round(size / 1024)}KB)` };
        }
      }
      return { success: true, output: stdout.slice(0, 2000), stderr: stderr.slice(0, 500) };
    } catch (e) { return { success: false, error: e.message.slice(0, 500) }; }
  }

  // ── Web scrape ──
  if (tool === "web_scrape") {
    try {
      const r = await fetch(params.url, { headers: { "User-Agent": "Mozilla/5.0 MindMappr/1.0" }, signal: AbortSignal.timeout(10000) });
      const html = await r.text();
      const text = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 3000);
      return { success: true, content: text, url: params.url };
    } catch (e) { return { success: false, error: e.message }; }
  }

  // ── Create CSV ──
  if (tool === "create_csv") {
    try {
      const fname = params.filename ? basename(params.filename).replace(/[^a-zA-Z0-9._-]/g, "_") : `data_${Date.now()}.csv`;
      const finalName = fname.endsWith(".csv") ? fname : fname + ".csv";
      const headers = (params.headers || []).join(",");
      const rows = (params.rows || []).map(r => Array.isArray(r) ? r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",") : r).join("\n");
      const content = headers + "\n" + rows;
      writeFileSync(join(UPLOADS_DIR, finalName), content);
      const size = statSync(join(UPLOADS_DIR, finalName)).size;
      saveMeta(finalName, size, "text/csv", "mindmappr");
      return { success: true, file: finalName, type: "csv", message: `Spreadsheet ready with ${(params.rows || []).length} rows` };
    } catch (e) { return { success: false, error: e.message }; }
  }

  // ── Create HTML ──
  if (tool === "create_html") {
    try {
      const fname = params.filename ? basename(params.filename).replace(/[^a-zA-Z0-9._-]/g, "_") : `page_${Date.now()}.html`;
      const finalName = fname.endsWith(".html") ? fname : fname + ".html";
      writeFileSync(join(UPLOADS_DIR, finalName), params.html || "<html><body>Hello</body></html>");
      const size = statSync(join(UPLOADS_DIR, finalName)).size;
      saveMeta(finalName, size, "text/html", "mindmappr");
      return { success: true, file: finalName, type: "html", message: `HTML page ready` };
    } catch (e) { return { success: false, error: e.message }; }
  }

  // ── Send Slack ──
  if (tool === "send_slack") {
    const conn = loadObj("connections");
    const slack = conn["slack"];
    if (!slack || !slack.token) return { success: false, error: "Slack not connected. Add it in the Connections tab." };
    try {
      const channel = params.channel || "#general";
      const r = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { "Authorization": `Bearer ${slack.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ channel, text: params.message || "" })
      });
      const d = await r.json();
      if (!d.ok) return { success: false, error: `Slack: ${d.error}` };
      return { success: true, message: "Message sent to Slack" };
    } catch (e) { return { success: false, error: e.message }; }
  }

  return { success: false, error: `Unknown tool: ${tool}` };
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/api/health", (_, res) => res.json({
  status: "ok",
  service: "MindMappr Agent v4",
  ts: new Date().toISOString(),
  tools: ["elevenlabs_tts", "generate_image", "create_video", "create_pdf", "run_python", "web_scrape", "create_csv", "create_html", "send_slack"]
}));

// ── Chat ──────────────────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  try {
    const { message, sessionId, attachedFile, model } = req.body;
    if (!message && !attachedFile) return res.status(400).json({ success: false, error: "message required" });
    const sid = sessionId || "web-" + randomUUID().slice(0, 8);
    const hf = join(DATA_DIR, `session_${sid}.json`);
    let history = [];
    try { history = JSON.parse(readFileSync(hf, "utf8")); } catch {}

    let userContent = message || "";
    if (attachedFile) {
      userContent += `\n\n[User attached: ${attachedFile.name} (${attachedFile.type}, ${Math.round((attachedFile.size || 0) / 1024)}KB). File is available at uploads/${attachedFile.name}]`;
    }

    const msgs = [{ role: "system", content: SYSTEM_PROMPT }, ...history.slice(-30), { role: "user", content: userContent }];
    let reply = await callLLM(msgs, model);
    let generatedFile = null;

    const tc = parseToolCall(reply);
    if (tc) {
      const result = await executeTool(tc.tool, tc.params || {});
      if (result.success && result.file) {
        generatedFile = { name: result.file, type: result.type, message: result.message };
        // Ask LLM to give a warm human response now that the file is done
        const fu = await callLLM([
          { role: "system", content: SYSTEM_PROMPT },
          ...history.slice(-10),
          { role: "user", content: userContent },
          { role: "assistant", content: reply },
          { role: "user", content: `Done. File created: ${result.file}. ${result.message}. Give a warm 1-2 sentence plain response saying it is ready. No filenames, no code, no technical details.` }
        ], model);
        reply = fu.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();
      } else if (result.success && result.output) {
        // Python ran but no file — include stdout in follow-up
        const fu = await callLLM([
          { role: "system", content: SYSTEM_PROMPT },
          ...history.slice(-10),
          { role: "user", content: userContent },
          { role: "assistant", content: reply },
          { role: "user", content: `Code ran. Output: ${result.output.slice(0, 800)}. Summarize the result warmly in 1-3 sentences.` }
        ], model);
        reply = fu.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();
      } else if (!result.success) {
        reply = `I hit a snag: ${result.error}. Want me to try another approach?`;
      }
    } else {
      reply = reply.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();
    }

    history.push({ role: "user", content: userContent }, { role: "assistant", content: reply });
    if (history.length > 60) history.splice(0, history.length - 60);
    writeFileSync(hf, JSON.stringify(history));

    // Analytics
    const analytics = loadData("analytics");
    analytics.push({ ts: Date.now(), type: "chat", sessionId: sid });
    saveData("analytics", analytics.slice(-10000));

    res.json({ success: true, data: { reply, sessionId: sid, generatedFile } });
  } catch (e) {
    console.error("[Chat]", e.message);
    res.status(500).json({ success: false, error: "Something went wrong. Please try again." });
  }
});

// ── Chat history ──────────────────────────────────────────────────────────────
app.get("/api/chat/history/:sid", (req, res) => {
  try {
    const h = JSON.parse(readFileSync(join(DATA_DIR, `session_${req.params.sid}.json`), "utf8"));
    res.json({ success: true, data: h });
  } catch { res.json({ success: true, data: [] }); }
});

app.get("/api/chat/sessions", (_, res) => {
  try {
    const files = readdirSync(DATA_DIR).filter(f => f.startsWith("session_") && f.endsWith(".json"));
    const sessions = files.map(f => {
      const sid = f.replace("session_", "").replace(".json", "");
      try {
        const h = JSON.parse(readFileSync(join(DATA_DIR, f), "utf8"));
        const last = h.filter(m => m.role === "user").slice(-1)[0];
        return { sessionId: sid, messageCount: h.length, lastMessage: last?.content?.slice(0, 60) || "", updatedAt: statSync(join(DATA_DIR, f)).mtime.toISOString() };
      } catch { return { sessionId: sid, messageCount: 0, lastMessage: "", updatedAt: "" }; }
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    res.json({ success: true, data: sessions });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete("/api/chat/:sid", (req, res) => {
  try { unlinkSync(join(DATA_DIR, `session_${req.params.sid}.json`)); } catch {}
  res.json({ success: true });
});

// ── File upload (multipart) ───────────────────────────────────────────────────
app.post("/api/files/upload", async (req, res) => {
  try {
    const ct = req.headers["content-type"] || "";
    if (!ct.includes("multipart/form-data")) return res.status(400).json({ success: false, error: "multipart required" });
    const boundary = ct.split("boundary=")[1];
    if (!boundary) return res.status(400).json({ success: false, error: "no boundary" });
    const chunks = []; for await (const c of req) chunks.push(c);
    const buf = Buffer.concat(chunks);
    const sep = Buffer.from("--" + boundary);
    const parts = []; let start = 0;
    while (start < buf.length) {
      const idx = buf.indexOf(sep, start); if (idx === -1) break;
      const end = buf.indexOf(sep, idx + sep.length);
      const part = buf.slice(idx + sep.length + 2, end === -1 ? buf.length : end - 2);
      if (part.length > 0) parts.push(part);
      start = idx + sep.length;
    }
    const saved = [];
    for (const part of parts) {
      const he = part.indexOf("\r\n\r\n"); if (he === -1) continue;
      const headers = part.slice(0, he).toString(); const body = part.slice(he + 4); if (body.length === 0) continue;
      const nm = headers.match(/filename="([^"]+)"/); if (!nm) continue;
      const origName = nm[1]; const ext = extname(origName);
      const safeName = basename(origName, ext).replace(/[^a-zA-Z0-9._-]/g, "_") + ext;
      writeFileSync(join(UPLOADS_DIR, safeName), body);
      const ctm = headers.match(/Content-Type:\s*(\S+)/i);
      const mime = ctm ? ctm[1] : "application/octet-stream";
      saveMeta(safeName, body.length, mime, "user");
      saved.push({ name: safeName, size: body.length, type: mime, uploadedAt: new Date().toISOString(), creator: "user" });
    }
    if (saved.length === 0) return res.status(400).json({ success: false, error: "No files parsed" });
    res.json({ success: true, data: saved });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── File list / download / delete ─────────────────────────────────────────────
app.get("/api/files/list", (_, res) => {
  try {
    const meta = loadObj("file_meta");
    const mimeMap = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".zip": "application/zip", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".csv": "text/csv", ".html": "text/html" };
    const files = readdirSync(UPLOADS_DIR).filter(f => !f.startsWith(".")).map(name => {
      const s = statSync(join(UPLOADS_DIR, name)); const ext = extname(name).toLowerCase();
      const fm = meta[name] || {};
      return { name, size: s.size, type: fm.type || mimeMap[ext] || "application/octet-stream", uploadedAt: fm.createdAt || s.mtime.toISOString(), creator: fm.creator || "user" };
    }).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
    res.json({ success: true, data: files });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/api/files/download/:name", (req, res) => {
  const fp = join(UPLOADS_DIR, basename(req.params.name));
  if (!existsSync(fp)) return res.status(404).json({ success: false, error: "Not found" });
  res.download(fp);
});

app.delete("/api/files/:name", (req, res) => {
  try {
    const fp = join(UPLOADS_DIR, basename(req.params.name));
    if (!existsSync(fp)) return res.status(404).json({ success: false, error: "Not found" });
    unlinkSync(fp);
    const m = loadObj("file_meta"); delete m[req.params.name]; saveData("file_meta", m);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── APIs tab ──────────────────────────────────────────────────────────────────
app.post("/api/agent/apis/register", (req, res) => {
  const { name, baseUrl, apiKey, tier = "free", rateLimit = 100 } = req.body;
  if (!name || !baseUrl || !apiKey) return res.status(400).json({ success: false, error: "name, baseUrl, apiKey required" });
  storeKey(name, apiKey);
  const apis = loadData("apis"); const ei = apis.findIndex(a => a.name === name);
  const entry = { name, baseUrl, tier, rateLimit, registeredAt: new Date().toISOString(), keyHint: apiKey.slice(0, 4) + "****" };
  if (ei >= 0) apis[ei] = entry; else apis.push(entry);
  saveData("apis", apis);
  res.json({ success: true, data: entry });
});

app.get("/api/agent/apis/list", (_, res) => res.json({ success: true, data: loadData("apis") }));

app.post("/api/agent/apis/test", async (req, res) => {
  const { name } = req.body; const apis = loadData("apis"); const api = apis.find(a => a.name === name);
  if (!api) return res.status(404).json({ success: false, error: "API not found" });
  try { const r = await fetch(api.baseUrl, { method: "GET", signal: AbortSignal.timeout(5000) }); res.json({ success: true, data: { status: r.status, ok: r.ok } }); }
  catch (e) { res.json({ success: false, error: e.message }); }
});

app.get("/api/agent/apis/models", (_, res) => res.json({
  success: true, data: [
    { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", tier: "premium" },
    { id: "x-ai/grok-3-mini-beta", name: "Grok 3 Mini Fast", tier: "premium" },
    { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", tier: "free" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", tier: "free" }
  ]
}));

// ── Connections tab ───────────────────────────────────────────────────────────
const CONNECTORS = {
  slack:            { name: "Slack",           icon: "💬", color: "#4A154B", description: "Send messages, manage channels",       keyBased: true },
  google_calendar:  { name: "Google Calendar", icon: "📅", color: "#4285F4", description: "Read and create calendar events",      keyBased: false },
  gmail:            { name: "Gmail",           icon: "📧", color: "#EA4335", description: "Send and read emails",                 keyBased: false },
  meta_ads:         { name: "Meta Ads",        icon: "📢", color: "#1877F2", description: "Manage Facebook & Instagram ads",      keyBased: false },
  stripe:           { name: "Stripe",          icon: "💳", color: "#635BFF", description: "Payments, customers, subscriptions",   keyBased: true },
  canva:            { name: "Canva",           icon: "🎨", color: "#00C4CC", description: "Create and export designs",           keyBased: false },
  github:           { name: "GitHub",          icon: "🐙", color: "#24292E", description: "Repos, issues, deployments",          keyBased: true },
  notion:           { name: "Notion",          icon: "📝", color: "#000000", description: "Pages, databases, blocks",            keyBased: true },
  airtable:         { name: "Airtable",        icon: "🗃️", color: "#18BFFF", description: "Bases, tables, records",              keyBased: true },
  zapier:           { name: "Zapier",          icon: "⚡", color: "#FF4A00", description: "Trigger Zaps via webhooks",           keyBased: true }
};

app.get("/api/connections/list", (_, res) => {
  const stored = loadObj("connections");
  const result = Object.entries(CONNECTORS).map(([id, info]) => ({
    id, ...info,
    connected: !!stored[id],
    connectedAt: stored[id]?.connectedAt || null,
    accountName: stored[id]?.accountName || null
  }));
  res.json({ success: true, data: result });
});

app.post("/api/connections/connect", (req, res) => {
  const { id, token, accountName } = req.body;
  if (!id || !token) return res.status(400).json({ success: false, error: "id and token required" });
  const c = loadObj("connections");
  c[id] = { token, accountName: accountName || id, connectedAt: new Date().toISOString() };
  saveData("connections", c);
  res.json({ success: true, data: { id, connected: true, accountName: c[id].accountName } });
});

app.post("/api/connections/disconnect", (req, res) => {
  const { id } = req.body; const c = loadObj("connections"); delete c[id]; saveData("connections", c);
  res.json({ success: true });
});

// ── Analytics ─────────────────────────────────────────────────────────────────
app.get("/api/analytics", (_, res) => {
  const data = loadData("analytics");
  const now = Date.now();
  const day = 86400000;
  const byDay = {};
  data.forEach(e => {
    const d = new Date(e.ts).toISOString().slice(0, 10);
    byDay[d] = (byDay[d] || 0) + 1;
  });
  res.json({
    success: true, data: {
      total: data.length,
      last24h: data.filter(e => now - e.ts < day).length,
      last7d: data.filter(e => now - e.ts < 7 * day).length,
      byDay: Object.entries(byDay).sort().slice(-30).map(([date, count]) => ({ date, count }))
    }
  });
});

// ── Serve frontend SPA ────────────────────────────────────────────────────────
app.get("/mindmappr", (_, res) => res.sendFile(join(__dirname, "public", "index.html")));
app.get("/mindmappr/*", (req, res) => {
  const fp = join(__dirname, "public", req.path.replace("/mindmappr/", ""));
  if (existsSync(fp) && !fp.endsWith("/")) return res.sendFile(fp);
  res.sendFile(join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`MindMappr Agent v4 running on port ${PORT}`));
