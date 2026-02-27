import express from "express";
import cors from "cors";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, readFileSync, writeFileSync } from "fs";
import { join, dirname, extname, basename } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { exec } from "child_process";
import { promisify } from "util";
import Database from "better-sqlite3";
import cron from "node-cron";

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

// ══════════════════════════════════════════════════════════════════════════════
// ── v4 Data helpers (unchanged) ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
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

// ══════════════════════════════════════════════════════════════════════════════
// ── v5: Error Recovery — retry with exponential backoff ─────────────────────
// ══════════════════════════════════════════════════════════════════════════════
async function withRetry(fn, { retries = 3, baseDelay = 1000, label = "operation" } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt === retries;
      console.error(`[Retry] ${label} attempt ${attempt}/${retries} failed: ${err.message}`);
      if (isLast) {
        return { success: false, error: friendlyError(err, label) };
      }
      await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt - 1)));
    }
  }
}

function friendlyError(err, label) {
  const msg = err.message || String(err);
  if (msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND"))
    return `Couldn't reach the ${label} service right now. Please try again in a moment.`;
  if (msg.includes("401") || msg.includes("403"))
    return `Authentication failed for ${label}. Please check your API key in the APIs tab.`;
  if (msg.includes("429"))
    return `${label} rate limit hit. Please wait a minute and try again.`;
  if (msg.includes("timeout") || msg.includes("ETIMEDOUT"))
    return `${label} took too long to respond. Please try again.`;
  if (msg.includes("500") || msg.includes("502") || msg.includes("503"))
    return `${label} is having server issues. Please try again shortly.`;
  // Strip stack traces, return first line only
  return `${label} ran into an issue: ${msg.split("\n")[0].slice(0, 150)}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// ── v5: SQLite Long-Term Memory ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
const DB_PATH = join(DATA_DIR, "mindmappr.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS user_preferences (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT DEFAULT 'conversation',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS conversation_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS project_context (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_name TEXT NOT NULL,
    detail TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    cron_expression TEXT NOT NULL,
    task_type TEXT NOT NULL,
    task_config TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    last_run TEXT,
    next_run TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Seed known facts about the owner
const existingFacts = db.prepare("SELECT COUNT(*) as c FROM facts WHERE category = 'owner'").get();
if (existingFacts.c === 0) {
  const seedFacts = [
    { category: "owner", content: "Owner is Audrey Evans, also goes by Revvel/A. GitHub: MIDNGHTSAPPHIRE. Company: GlowStarLabs." },
    { category: "owner", content: "Audrey is AuDHD, 60 years old, cancer survivor. Daughter is legally deaf." },
    { category: "owner", content: "Audrey prefers warm, direct, accessible communication. No jargon." },
  ];
  const ins = db.prepare("INSERT INTO facts (category, content, source) VALUES (?, ?, 'seed')");
  for (const f of seedFacts) ins.run(f.category, f.content);
}

// Memory helpers
function getMemoryContext() {
  const prefs = db.prepare("SELECT key, value FROM user_preferences ORDER BY updated_at DESC LIMIT 20").all();
  const facts = db.prepare("SELECT content FROM facts ORDER BY created_at DESC LIMIT 30").all();
  const summaries = db.prepare("SELECT summary FROM conversation_summaries ORDER BY created_at DESC LIMIT 5").all();
  const projects = db.prepare("SELECT project_name, detail FROM project_context ORDER BY updated_at DESC LIMIT 10").all();

  let ctx = "";
  if (prefs.length) ctx += "\n[User Preferences]\n" + prefs.map(p => `- ${p.key}: ${p.value}`).join("\n");
  if (facts.length) ctx += "\n[Known Facts]\n" + facts.map(f => `- ${f.content}`).join("\n");
  if (summaries.length) ctx += "\n[Recent Conversation Summaries]\n" + summaries.map(s => `- ${s.summary}`).join("\n");
  if (projects.length) ctx += "\n[Projects]\n" + projects.map(p => `- ${p.project_name}: ${p.detail}`).join("\n");
  return ctx;
}

function storeMemoryFromConversation(sessionId, userMsg, assistantReply) {
  // Extract and store facts asynchronously (fire and forget)
  try {
    // Simple heuristic extraction — store user preferences mentioned
    const prefPatterns = [
      { re: /(?:my name is|i'm|i am|call me)\s+(\w+)/i, key: "user_name" },
      { re: /(?:i prefer|i like|i want)\s+(.{5,60})/i, key: "preference" },
    ];
    for (const p of prefPatterns) {
      const m = userMsg.match(p.re);
      if (m) {
        db.prepare("INSERT OR REPLACE INTO user_preferences (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(p.key, m[1].trim());
      }
    }
    // Store a conversation summary every 10 messages
    const hf = join(DATA_DIR, `session_${sessionId}.json`);
    try {
      const history = JSON.parse(readFileSync(hf, "utf8"));
      if (history.length > 0 && history.length % 10 === 0) {
        // Use last few messages as a quick summary
        const recent = history.slice(-6).map(m => `${m.role}: ${m.content.slice(0, 100)}`).join(" | ");
        db.prepare("INSERT INTO conversation_summaries (session_id, summary) VALUES (?, ?)").run(sessionId, recent.slice(0, 500));
      }
    } catch {}
  } catch (e) {
    console.error("[Memory] Store error:", e.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Middleware ───────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use("/mindmappr", express.static(join(__dirname, "public")));
app.use("/mindmappr/uploads", express.static(UPLOADS_DIR));

// ══════════════════════════════════════════════════════════════════════════════
// ── System prompt (v5 — enhanced with memory + multi-step) ──────────────────
// ══════════════════════════════════════════════════════════════════════════════
const SYSTEM_PROMPT = `You are MindMappr v5, an AI execution agent owned by Audrey Evans (Revvel/GlowStarLabs). GitHub: MIDNGHTSAPPHIRE.

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
5. MULTI-STEP TASKS: For complex requests that need multiple tools, output a plan like this:
   <task_plan>[{"step":1,"tool":"elevenlabs_tts","params":{...},"description":"Generate voiceover"},{"step":2,"tool":"generate_image","params":{...},"description":"Create background image"},{"step":3,"tool":"create_video","params":{"audio_file":"{{step1.file}}","image_file":"{{step2.file}}"},"description":"Combine into video"}]</task_plan>
   Use {{stepN.file}} to reference output files from previous steps.
6. After a tool runs successfully, give a warm 1-2 sentence response saying the file is ready. No filenames, no code, no technical details.
7. If a tool fails, say so plainly and offer to try another way.

Owner: Audrey Evans, AuDHD, 60, cancer survivor. Daughter is legally deaf. Be warm, direct, accessible.`;

// ══════════════════════════════════════════════════════════════════════════════
// ── LLM call (v5 — with retry) ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
async function callLLM(messages, model) {
  const m = model || LLM_MODEL;
  return await withRetry(async () => {
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
  }, { retries: 3, baseDelay: 1500, label: "AI model" });
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Tool call parser (v5 — supports both single + multi-step) ───────────────
// ══════════════════════════════════════════════════════════════════════════════
function parseToolCall(text) {
  const m = text.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
  if (!m) return null;
  try { return JSON.parse(m[1].trim()); } catch { return null; }
}

function parseTaskPlan(text) {
  const m = text.match(/<task_plan>([\s\S]*?)<\/task_plan>/);
  if (!m) return null;
  try {
    const plan = JSON.parse(m[1].trim());
    return Array.isArray(plan) ? plan : null;
  } catch { return null; }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Tool executor (v5 — with retry wrapping) ────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
async function executeTool(tool, params) {

  // ── ElevenLabs TTS ──
  if (tool === "elevenlabs_tts") {
    const key = getKey("ELEVENLABS-MINDMAPPR") || getKey("elevenlabs") || getKey("ElevenLabs");
    if (!key) return { success: false, error: "ElevenLabs API key not found. Please add it in the APIs tab." };
    return await withRetry(async () => {
      const vid = params.voice_id || "21m00Tcm4TlvDq8ikWAM";
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}`, {
        method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json", "Accept": "audio/mpeg" },
        body: JSON.stringify({ text: params.text || "Hello", model_id: "eleven_monolingual_v1", voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
      });
      if (!r.ok) { const t = await r.text(); throw new Error(`ElevenLabs ${r.status}: ${t.slice(0, 200)}`); }
      const buf = Buffer.from(await r.arrayBuffer());
      const fname = `tts_${Date.now()}.mp3`;
      writeFileSync(join(UPLOADS_DIR, fname), buf);
      saveMeta(fname, buf.length, "audio/mpeg", "mindmappr");
      return { success: true, file: fname, type: "audio", message: `Audio ready (${Math.round(buf.length / 1024)}KB)` };
    }, { retries: 3, baseDelay: 2000, label: "ElevenLabs TTS" });
  }

  // ── Generate image (ImageMagick) ──
  if (tool === "generate_image") {
    return await withRetry(async () => {
      const fname = `img_${Date.now()}.png`;
      const fpath = join(UPLOADS_DIR, fname);
      const w = params.width || 800; const h = params.height || 600;
      const safe = (params.prompt || "Generated image").replace(/["\\`$]/g, "").slice(0, 80);
      await execAsync(`convert -size ${w}x${h} gradient:"#1a1a2e"-"#16213e" -font DejaVu-Sans -pointsize 28 -fill "#e94560" -gravity Center -annotate 0 "${safe}" "${fpath}"`);
      const size = statSync(fpath).size;
      saveMeta(fname, size, "image/png", "mindmappr");
      return { success: true, file: fname, type: "image", message: "Image created" };
    }, { retries: 2, baseDelay: 1000, label: "Image generation" });
  }

  // ── Create video (FFmpeg) ──
  if (tool === "create_video") {
    return await withRetry(async () => {
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
        throw new Error("Need an audio file first. Ask me to generate audio, then I can make the video.");
      }
      await execAsync(cmd, { timeout: 120000 });
      const size = statSync(fpath).size;
      saveMeta(fname, size, "video/mp4", "mindmappr");
      return { success: true, file: fname, type: "video", message: `Video ready (${Math.round(size / 1024 / 1024 * 10) / 10}MB)` };
    }, { retries: 2, baseDelay: 2000, label: "Video creation" });
  }

  // ── Create document (Markdown) ──
  if (tool === "create_pdf") {
    try {
      const fname = `doc_${Date.now()}.md`;
      writeFileSync(join(UPLOADS_DIR, fname), `# ${params.title || "Document"}\n\n${params.content || ""}`);
      const size = statSync(join(UPLOADS_DIR, fname)).size;
      saveMeta(fname, size, "text/markdown", "mindmappr");
      return { success: true, file: fname, type: "document", message: `Document ready: ${params.title || "Document"}` };
    } catch (e) { return { success: false, error: friendlyError(e, "Document creation") }; }
  }

  // ── Run Python ──
  if (tool === "run_python") {
    try {
      const tmp = `/tmp/mm_${Date.now()}.py`;
      let code = params.code || "print('hello')";
      if (params.output_file) {
        const outPath = join(UPLOADS_DIR, basename(params.output_file));
        code = `OUTPUT_FILE = "${outPath}"\n` + code;
      }
      writeFileSync(tmp, code);
      const { stdout, stderr } = await execAsync(`python3 "${tmp}"`, { timeout: 30000 });
      setTimeout(() => { try { unlinkSync(tmp); } catch {} }, 5000);
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
    } catch (e) { return { success: false, error: friendlyError(e, "Python code") }; }
  }

  // ── Web scrape ──
  if (tool === "web_scrape") {
    return await withRetry(async () => {
      const r = await fetch(params.url, { headers: { "User-Agent": "MindMappr/5.0" }, signal: AbortSignal.timeout(10000) });
      const html = await r.text();
      const text = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 3000);
      return { success: true, content: text, url: params.url };
    }, { retries: 3, baseDelay: 1000, label: "Web scrape" });
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
    } catch (e) { return { success: false, error: friendlyError(e, "CSV creation") }; }
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
    } catch (e) { return { success: false, error: friendlyError(e, "HTML creation") }; }
  }

  // ── Send Slack ──
  if (tool === "send_slack") {
    const conn = loadObj("connections");
    const slack = conn["slack"];
    if (!slack || !slack.token) return { success: false, error: "Slack not connected. Add it in the Connections tab." };
    return await withRetry(async () => {
      const channel = params.channel || "#general";
      const r = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { "Authorization": `Bearer ${slack.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ channel, text: params.message || "" })
      });
      const d = await r.json();
      if (!d.ok) throw new Error(`Slack: ${d.error}`);
      return { success: true, message: "Message sent to Slack" };
    }, { retries: 2, baseDelay: 1000, label: "Slack" });
  }

  return { success: false, error: `I don't know that tool: ${tool}. Try asking in a different way.` };
}

// ══════════════════════════════════════════════════════════════════════════════
// ── v5: Multi-Step Task Planner ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
async function executeTaskPlan(plan, progressCallback) {
  const results = {};
  const files = [];

  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    const stepNum = step.step || (i + 1);
    const desc = step.description || `Step ${stepNum}`;

    if (progressCallback) progressCallback(stepNum, plan.length, desc, "running");

    // Resolve {{stepN.file}} references in params
    let paramsStr = JSON.stringify(step.params || {});
    for (const [key, val] of Object.entries(results)) {
      const ref = `{{${key}.file}}`;
      if (paramsStr.includes(ref) && val.file) {
        paramsStr = paramsStr.replace(new RegExp(ref.replace(/[{}]/g, '\\$&'), 'g'), val.file);
      }
    }
    let resolvedParams;
    try { resolvedParams = JSON.parse(paramsStr); } catch { resolvedParams = step.params || {}; }

    const result = await executeTool(step.tool, resolvedParams);
    results[`step${stepNum}`] = result;

    if (result.success && result.file) {
      files.push({ name: result.file, type: result.type, message: result.message, step: stepNum });
    }

    if (progressCallback) {
      progressCallback(stepNum, plan.length, desc, result.success ? "done" : "failed");
    }

    if (!result.success) {
      return {
        success: false,
        completedSteps: i,
        totalSteps: plan.length,
        error: `Step ${stepNum} (${desc}) failed: ${result.error}`,
        files
      };
    }
  }

  return {
    success: true,
    completedSteps: plan.length,
    totalSteps: plan.length,
    files,
    lastResult: results[`step${plan.length}`]
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Health ───────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
app.get("/api/health", (_, res) => res.json({
  status: "ok",
  service: "MindMappr Agent v5",
  version: "5.0.0",
  features: ["multi_step_planner", "long_term_memory", "error_recovery", "cron_scheduler"],
  ts: new Date().toISOString(),
  tools: ["elevenlabs_tts", "generate_image", "create_video", "create_pdf", "run_python", "web_scrape", "create_csv", "create_html", "send_slack"]
}));

// ══════════════════════════════════════════════════════════════════════════════
// ── Chat (v5 — with memory injection + multi-step + error recovery) ─────────
// ══════════════════════════════════════════════════════════════════════════════
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

    // v5: Inject long-term memory context
    const memoryCtx = getMemoryContext();
    const systemWithMemory = SYSTEM_PROMPT + (memoryCtx ? `\n\n[MEMORY — What you know about this user and their projects]\n${memoryCtx}` : "");

    const msgs = [{ role: "system", content: systemWithMemory }, ...history.slice(-30), { role: "user", content: userContent }];
    let reply = await callLLM(msgs, model);

    // Handle retry failure from callLLM
    if (reply && typeof reply === "object" && reply.success === false) {
      return res.json({ success: true, data: { reply: reply.error, sessionId: sid, generatedFile: null } });
    }

    let generatedFile = null;
    let planProgress = null;

    // v5: Check for multi-step task plan first
    const plan = parseTaskPlan(reply);
    if (plan && plan.length > 1) {
      const planResult = await executeTaskPlan(plan);
      if (planResult.success && planResult.files.length > 0) {
        const lastFile = planResult.files[planResult.files.length - 1];
        generatedFile = { name: lastFile.name, type: lastFile.type, message: lastFile.message };
        planProgress = { steps: plan.map((s, i) => ({ step: s.step || i + 1, description: s.description, status: "done" })) };
        // Get warm response
        const fu = await callLLM([
          { role: "system", content: SYSTEM_PROMPT },
          ...history.slice(-10),
          { role: "user", content: userContent },
          { role: "assistant", content: reply },
          { role: "user", content: `All ${planResult.totalSteps} steps completed successfully! Final file: ${lastFile.name}. ${lastFile.message}. Give a warm 1-2 sentence response saying everything is ready. Mention what was created. No filenames, no code.` }
        ], model);
        reply = (typeof fu === "string" ? fu : "All done!").replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").replace(/<task_plan>[\s\S]*?<\/task_plan>/g, "").trim();
      } else if (!planResult.success) {
        reply = `I got through ${planResult.completedSteps} of ${planResult.totalSteps} steps, but hit a snag: ${planResult.error}. Want me to try a different approach?`;
        if (planResult.files.length > 0) {
          const lastFile = planResult.files[planResult.files.length - 1];
          generatedFile = { name: lastFile.name, type: lastFile.type, message: lastFile.message };
        }
      }
    } else {
      // Single tool call (v4 behavior preserved)
      const tc = parseToolCall(reply);
      if (tc) {
        const result = await executeTool(tc.tool, tc.params || {});
        if (result.success && result.file) {
          generatedFile = { name: result.file, type: result.type, message: result.message };
          const fu = await callLLM([
            { role: "system", content: SYSTEM_PROMPT },
            ...history.slice(-10),
            { role: "user", content: userContent },
            { role: "assistant", content: reply },
            { role: "user", content: `Done. File created: ${result.file}. ${result.message}. Give a warm 1-2 sentence plain response saying it is ready. No filenames, no code, no technical details.` }
          ], model);
          reply = (typeof fu === "string" ? fu : "Your file is ready!").replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();
        } else if (result.success && result.output) {
          const fu = await callLLM([
            { role: "system", content: SYSTEM_PROMPT },
            ...history.slice(-10),
            { role: "user", content: userContent },
            { role: "assistant", content: reply },
            { role: "user", content: `Code ran. Output: ${result.output.slice(0, 800)}. Summarize the result warmly in 1-3 sentences.` }
          ], model);
          reply = (typeof fu === "string" ? fu : "Done!").replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();
        } else if (!result.success) {
          reply = `I hit a snag: ${result.error}. Want me to try another approach?`;
        }
      } else {
        reply = (typeof reply === "string" ? reply : "").replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").replace(/<task_plan>[\s\S]*?<\/task_plan>/g, "").trim();
      }
    }

    history.push({ role: "user", content: userContent }, { role: "assistant", content: reply });
    if (history.length > 60) history.splice(0, history.length - 60);
    writeFileSync(hf, JSON.stringify(history));

    // v5: Store memory
    storeMemoryFromConversation(sid, userContent, reply);

    // Analytics
    const analytics = loadData("analytics");
    analytics.push({ ts: Date.now(), type: "chat", sessionId: sid });
    saveData("analytics", analytics.slice(-10000));

    const responseData = { reply, sessionId: sid, generatedFile };
    if (planProgress) responseData.planProgress = planProgress;

    res.json({ success: true, data: responseData });
  } catch (e) {
    console.error("[Chat]", e.message);
    res.status(500).json({ success: false, error: "Something went wrong. Please try again in a moment." });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ── Chat history (unchanged from v4) ────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
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

// ══════════════════════════════════════════════════════════════════════════════
// ── File upload (unchanged from v4) ─────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
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
  } catch (e) { res.status(500).json({ success: false, error: friendlyError(e, "File upload") }); }
});

// ── File list / download / delete (unchanged from v4) ────────────────────────
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

// ══════════════════════════════════════════════════════════════════════════════
// ── APIs tab (unchanged from v4) ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
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
  catch (e) { res.json({ success: false, error: friendlyError(e, api.name) }); }
});

app.get("/api/agent/apis/models", (_, res) => res.json({
  success: true, data: [
    { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", tier: "premium" },
    { id: "x-ai/grok-3-mini-beta", name: "Grok 3 Mini Fast", tier: "premium" },
    { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", tier: "free" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", tier: "free" }
  ]
}));

// ══════════════════════════════════════════════════════════════════════════════
// ── Connections tab (unchanged from v4) ─────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
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

// ══════════════════════════════════════════════════════════════════════════════
// ── Analytics (unchanged from v4) ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
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

// ══════════════════════════════════════════════════════════════════════════════
// ── v5: Memory API endpoints ────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
app.get("/api/memory/facts", (_, res) => {
  try {
    const facts = db.prepare("SELECT * FROM facts ORDER BY created_at DESC LIMIT 50").all();
    res.json({ success: true, data: facts });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/api/memory/facts", (req, res) => {
  try {
    const { category, content } = req.body;
    if (!category || !content) return res.status(400).json({ success: false, error: "category and content required" });
    db.prepare("INSERT INTO facts (category, content, source) VALUES (?, ?, 'manual')").run(category, content);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete("/api/memory/facts/:id", (req, res) => {
  try {
    db.prepare("DELETE FROM facts WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/api/memory/preferences", (_, res) => {
  try {
    const prefs = db.prepare("SELECT * FROM user_preferences ORDER BY updated_at DESC").all();
    res.json({ success: true, data: prefs });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/api/memory/preferences", (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key || !value) return res.status(400).json({ success: false, error: "key and value required" });
    db.prepare("INSERT OR REPLACE INTO user_preferences (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(key, value);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// ── v5: Cron Scheduler ──────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
const activeCrons = new Map();

function loadAndStartSchedules() {
  try {
    const tasks = db.prepare("SELECT * FROM scheduled_tasks WHERE enabled = 1").all();
    for (const task of tasks) {
      startCronJob(task);
    }
    console.log(`[Cron] Loaded ${tasks.length} scheduled tasks`);
  } catch (e) {
    console.error("[Cron] Load error:", e.message);
  }
}

function startCronJob(task) {
  if (activeCrons.has(task.id)) {
    activeCrons.get(task.id).stop();
  }
  if (!cron.validate(task.cron_expression)) {
    console.error(`[Cron] Invalid expression for task ${task.id}: ${task.cron_expression}`);
    return;
  }
  const job = cron.schedule(task.cron_expression, async () => {
    console.log(`[Cron] Running task ${task.id}: ${task.name}`);
    try {
      const config = JSON.parse(task.task_config);
      if (task.task_type === "tool") {
        await executeTool(config.tool, config.params || {});
      } else if (task.task_type === "chat") {
        // Send a message to the LLM and execute any tool calls
        const msgs = [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: config.message }];
        const reply = await callLLM(msgs);
        if (typeof reply === "string") {
          const tc = parseToolCall(reply);
          if (tc) await executeTool(tc.tool, tc.params || {});
        }
      } else if (task.task_type === "webhook") {
        await fetch(config.url, {
          method: config.method || "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(config.body || {})
        });
      }
      db.prepare("UPDATE scheduled_tasks SET last_run = datetime('now') WHERE id = ?").run(task.id);
    } catch (e) {
      console.error(`[Cron] Task ${task.id} error:`, e.message);
    }
  });
  activeCrons.set(task.id, job);
}

// Cron API endpoints
app.post("/api/schedule", (req, res) => {
  try {
    const { name, cron_expression, task_type, task_config } = req.body;
    if (!name || !cron_expression || !task_type || !task_config) {
      return res.status(400).json({ success: false, error: "name, cron_expression, task_type, and task_config are required" });
    }
    if (!cron.validate(cron_expression)) {
      return res.status(400).json({ success: false, error: "Invalid cron expression. Use format like '0 9 * * *' (every day at 9am)." });
    }
    const configStr = typeof task_config === "string" ? task_config : JSON.stringify(task_config);
    const result = db.prepare("INSERT INTO scheduled_tasks (name, cron_expression, task_type, task_config) VALUES (?, ?, ?, ?)").run(name, cron_expression, task_type, configStr);
    const task = db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(result.lastInsertRowid);
    startCronJob(task);
    res.json({ success: true, data: task });
  } catch (e) { res.status(500).json({ success: false, error: friendlyError(e, "Scheduler") }); }
});

app.get("/api/schedules", (_, res) => {
  try {
    const tasks = db.prepare("SELECT * FROM scheduled_tasks ORDER BY created_at DESC").all();
    res.json({ success: true, data: tasks });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete("/api/schedule/:id", (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (activeCrons.has(id)) {
      activeCrons.get(id).stop();
      activeCrons.delete(id);
    }
    db.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.patch("/api/schedule/:id", (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { enabled } = req.body;
    db.prepare("UPDATE scheduled_tasks SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
    const task = db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(id);
    if (enabled) {
      startCronJob(task);
    } else if (activeCrons.has(id)) {
      activeCrons.get(id).stop();
      activeCrons.delete(id);
    }
    res.json({ success: true, data: task });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// ── Serve frontend SPA ──────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
app.get("/mindmappr", (_, res) => res.sendFile(join(__dirname, "public", "index.html")));
app.get("/mindmappr/*", (req, res) => {
  const fp = join(__dirname, "public", req.path.replace("/mindmappr/", ""));
  if (existsSync(fp) && !fp.endsWith("/")) return res.sendFile(fp);
  res.sendFile(join(__dirname, "public", "index.html"));
});

// ══════════════════════════════════════════════════════════════════════════════
// ── Start ───────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`MindMappr Agent v5 running on port ${PORT}`);
  loadAndStartSchedules();
});
