import express from "express";
import cors from "cors";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, readFileSync, writeFileSync, appendFileSync, createWriteStream } from "fs";
import { join, dirname, extname, basename } from "path";
import { fileURLToPath } from "url";
import { randomUUID, createHash } from "crypto";
import { exec } from "child_process";
import { promisify } from "util";
import Database from "better-sqlite3";
import cron from "node-cron";
import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";
import nodemailer from "nodemailer";
import { initRexTools, executeTool as executeRexTool, parseToolCalls, getToolListForPrompt, TOOL_REGISTRY, EXTRA_TOOLS } from "./rex-tools.mjs";
import { initDiscord, startDiscordBot, sendDiscordNotification, getDiscordStatus, disconnectDiscord, getDiscordClient } from "./discord-connector.mjs";
import { ChannelType } from "discord.js";

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT || "3005");
// Resolve LLM key: prefer LLM_API_KEY, fall back to OPENROUTER_API_KEY
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || "";
const LLM_BASE_URL = "https://openrouter.ai/api/v1";
const LLM_MODEL = process.env.LLM_MODEL || "anthropic/claude-sonnet-4";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const UPLOADS_DIR = join(__dirname, "uploads");
const DATA_DIR = join(__dirname, "data");

// Google OAuth2 configuration
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "";

const MEMORY_DIR = join(DATA_DIR, "memory");
const MEMORY_FILE = join(DATA_DIR, "MEMORY.md");
const SOUL_FILE = join(DATA_DIR, "soul.md");
const USER_FILE = join(DATA_DIR, "user.md");

[UPLOADS_DIR, DATA_DIR, MEMORY_DIR].forEach(d => { if (!existsSync(d)) mkdirSync(d, { recursive: true }); });

// Initialize persistent memory files if they don't exist
if (!existsSync(MEMORY_FILE)) {
  writeFileSync(MEMORY_FILE, `# MindMappr Long-Term Memory\n\n## Core Knowledge\n- Owner: Audrey Evans (Revvel). GitHub: MIDNGHTSAPPHIRE. Company: GlowStarLabs.\n- Audrey is AuDHD, 60 years old, cancer survivor. Daughter is legally deaf.\n- Prefers warm, direct, accessible communication. No jargon.\n\n## Key Projects\n- MindMappr: AI agent management platform\n- OpenClaw: AI assistant and tooling platform\n- Revvel Email Organizer: AI-powered email processing\n- Neurooz: Neurodivergent-friendly technology\n\n## Preferences\n- FOSS first, GitHub first\n- Glassmorphism UI/UX\n- Auto-everything, no confirmation questions\n- Production-ready, one-iteration delivery\n\n---\n*Memory is append-only. New entries go below this line.*\n\n`);
  console.log("[Memory] Created MEMORY.md");
}
if (!existsSync(SOUL_FILE)) {
  writeFileSync(SOUL_FILE, `# MindMappr Agent Soul\n\n## Voice & Personality\n- Warm, direct, accessible\n- No corporate fluff or hedging\n- Action-oriented: do first, explain after\n- Inclusive and neurodivergent-friendly\n\n## Core Beliefs\n- Technology should empower diverse users\n- Privacy and ethics are non-negotiable\n- Open-source enables innovation\n- Every line of code is an opportunity to make technology more inclusive\n`);
  console.log("[Memory] Created soul.md");
}
if (!existsSync(USER_FILE)) {
  writeFileSync(USER_FILE, `# User Profile: Audrey Evans (Revvel)\n\n## Identity\n- Name: Audrey Evans\n- Aliases: Revvel, A, Freedom Angel\n- GitHub: MIDNGHTSAPPHIRE\n- Company: GlowStarLabs\n\n## Communication Style\n- Very detailed replies\n- Authentic tone, no guardrails\n- Deep-researched with citations\n- No unnecessary confirmation questions\n\n## Technical Preferences\n- FOSS first\n- Auto-deploy everything\n- OpenRouter for LLM routing\n- Glassmorphism UI/UX\n`);
  console.log("[Memory] Created user.md");
}

// Helper: get today's daily note path
function getDailyNotePath() {
  const today = new Date().toISOString().split("T")[0];
  return join(MEMORY_DIR, `${today}.md`);
}

// NOTE: getMemoryContext() is defined below (after SQLite tables) — merged file + SQLite memory

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
  if (msg.includes("401") || msg.includes("403") || msg.toLowerCase().includes("user not found") || msg.toLowerCase().includes("authentication failed"))
    return `Authentication failed for ${label}. The API key may be invalid or expired. Please check the Connections tab.`;
  if (msg.includes("429"))
    return `${label} rate limit hit. Please wait a minute and try again.`;
  if (msg.includes("timeout") || msg.includes("ETIMEDOUT"))
    return `${label} took too long to respond. Please try again.`;
  if (msg.includes("500") || msg.includes("502") || msg.includes("503"))
    return `${label} is having server issues. Please try again shortly.`;
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
    assigned_agent TEXT DEFAULT NULL,
    enabled INTEGER DEFAULT 1,
    last_run TEXT,
    next_run TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS agent_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    task_type TEXT NOT NULL DEFAULT 'chat',
    input TEXT NOT NULL,
    output TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    cost_estimate REAL DEFAULT 0,
    tokens_used INTEGER DEFAULT 0,
    elapsed_ms INTEGER DEFAULT 0,
    session_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS custom_agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT 'anthropic/claude-sonnet-4',
    role TEXT NOT NULL,
    description TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '🤖',
    color TEXT NOT NULL DEFAULT '#6c5ce7',
    system_prompt TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS agent_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    activity_type TEXT NOT NULL DEFAULT 'idle',
    description TEXT,
    status TEXT DEFAULT 'active',
    metadata TEXT,
    started_at TEXT DEFAULT (datetime('now')),
    ended_at TEXT
  );
  CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    service_name TEXT NOT NULL,
    token TEXT NOT NULL,
    account_name TEXT,
    connected_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// ══════════════════════════════════════════════════════════════════════════════
// ── Content Studio DB Tables (CreatorBuddy-style) ──────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
db.exec(`
  CREATE TABLE IF NOT EXISTS content_studio_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    content TEXT NOT NULL,
    platform TEXT DEFAULT 'general',
    content_type TEXT DEFAULT 'post',
    score INTEGER DEFAULT 0,
    score_details TEXT,
    status TEXT DEFAULT 'draft',
    tags TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    published_at TEXT
  );
  CREATE TABLE IF NOT EXISTS content_studio_inspirations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_url TEXT,
    source_author TEXT,
    original_content TEXT NOT NULL,
    repurposed_content TEXT,
    platform TEXT DEFAULT 'general',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS content_studio_braindumps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_thoughts TEXT NOT NULL,
    generated_posts TEXT,
    generated_article TEXT,
    generated_script TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS content_studio_analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER,
    platform TEXT,
    impressions INTEGER DEFAULT 0,
    engagements INTEGER DEFAULT 0,
    clicks INTEGER DEFAULT 0,
    shares INTEGER DEFAULT 0,
    recorded_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (post_id) REFERENCES content_studio_posts(id)
  );
`);

// ── Skills Table ────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    category TEXT DEFAULT 'General',
    tags TEXT DEFAULT '[]',
    source TEXT DEFAULT 'revvel-custom',
    version TEXT DEFAULT '1.0.0',
    enabled INTEGER DEFAULT 1,
    openclaw_owner TEXT,
    openclaw_slug TEXT,
    openclaw_path TEXT,
    user_invocable INTEGER DEFAULT 1,
    file_count INTEGER DEFAULT 0,
    implementation_type TEXT DEFAULT 'markdown',
    implementation_content TEXT,
    loaded INTEGER DEFAULT 0,
    loaded_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Migrate existing skills table to add new columns
try {
  db.exec(`ALTER TABLE skills ADD COLUMN implementation_type TEXT DEFAULT 'markdown'`);
} catch {} // column may already exist
try {
  db.exec(`ALTER TABLE skills ADD COLUMN implementation_content TEXT`);
} catch {}
try {
  db.exec(`ALTER TABLE skills ADD COLUMN loaded INTEGER DEFAULT 0`);
} catch {}
try {
  db.exec(`ALTER TABLE skills ADD COLUMN loaded_at TEXT`);
} catch {}

// ── In-memory loaded skills registry (for fast execution) ─────────────────
const loadedSkills = new Map();

// Seed skills from catalog JSON on startup (upsert — always sync from catalog)
try {
  const catalogPath = join(__dirname, 'skills-catalog.json');
  if (existsSync(catalogPath)) {
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    const existingCount = db.prepare("SELECT COUNT(*) as c FROM skills").get().c;
    const upsertSkill = db.prepare(
      `INSERT INTO skills (id, name, description, category, tags, source, version, openclaw_owner, openclaw_slug, openclaw_path, user_invocable, file_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         category = excluded.category,
         tags = excluded.tags,
         source = excluded.source,
         version = excluded.version,
         openclaw_owner = excluded.openclaw_owner,
         openclaw_slug = excluded.openclaw_slug,
         openclaw_path = excluded.openclaw_path,
         user_invocable = excluded.user_invocable,
         file_count = excluded.file_count`
    );
    const seedSkills = db.transaction((skills) => {
      for (const s of skills) {
        upsertSkill.run(
          s.id, s.name, s.description || '', s.category || 'General',
          JSON.stringify(s.tags || []), s.source || 'revvel-custom', s.version || '1.0.0',
          s.openclaw_owner || null, s.openclaw_slug || null, s.openclaw_path || null,
          s.user_invocable !== false ? 1 : 0, s.file_count || 0
        );
      }
    });
    seedSkills(catalog);
    const newCount = db.prepare("SELECT COUNT(*) as c FROM skills").get().c;
    console.log(`[Skills] Synced ${catalog.length} skills from catalog (${existingCount} → ${newCount} in DB)`);
  }
} catch (e) { console.error('[Skills] Seed error:', e.message); }

// ── Restore previously loaded skills into memory on startup ─────────────
try {
  const loadedRows = db.prepare(
    "SELECT id, name, implementation_type, implementation_content, source FROM skills WHERE loaded = 1 AND enabled = 1 AND implementation_content IS NOT NULL"
  ).all();
  for (const row of loadedRows) {
    loadedSkills.set(row.id, {
      id: row.id,
      name: row.name,
      type: row.implementation_type,
      content: row.implementation_content,
      url: row.source,
      loadedAt: new Date().toISOString()
    });
  }
  if (loadedRows.length > 0) {
    console.log(`[Skills] Restored ${loadedRows.length} previously loaded skill(s) into memory: ${loadedRows.map(r => r.name).join(", ")}`);
  }
} catch (e) { console.error('[Skills] Restore error:', e.message); }

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

// ══════════════════════════════════════════════════════════════════════════════
// ── Connections: SQLite-backed token retrieval ──────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
function getConnectionToken(serviceId) {
  try {
    const row = db.prepare("SELECT token FROM connections WHERE id = ?").get(serviceId);
    return row ? row.token : null;
  } catch { return null; }
}

// Google OAuth2 token refresh helper
async function getGoogleAccessToken() {
  try {
    // Try SQLite first
    const row = db.prepare("SELECT token FROM connections WHERE id = 'google'").get();
    if (!row) {
      // Fallback to JSON file
      const c = loadObj("connections");
      const google = c["google"];
      if (!google || !google.refreshToken) return null;
      return await refreshGoogleToken(google, c);
    }
    let googleData;
    try { googleData = JSON.parse(row.token); } catch { return row.token; }
    if (!googleData.refreshToken) return googleData.token || null;
    // Check if token is still valid (with 60s buffer)
    if (googleData.expiresAt && Date.now() < googleData.expiresAt - 60000) {
      return googleData.token;
    }
    // Refresh the token
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: googleData.refreshToken,
        grant_type: "refresh_token"
      })
    });
    const tokens = await r.json();
    if (tokens.access_token) {
      googleData.token = tokens.access_token;
      googleData.expiresAt = Date.now() + (tokens.expires_in * 1000);
      // Update SQLite
      db.prepare("UPDATE connections SET token = ?, updated_at = datetime('now') WHERE id = 'google'").run(JSON.stringify(googleData));
      db.prepare("UPDATE connections SET token = ?, updated_at = datetime('now') WHERE id = 'gmail'").run(JSON.stringify(googleData));
      db.prepare("UPDATE connections SET token = ?, updated_at = datetime('now') WHERE id = 'google_drive'").run(JSON.stringify(googleData));
      db.prepare("UPDATE connections SET token = ?, updated_at = datetime('now') WHERE id = 'google_calendar'").run(JSON.stringify(googleData));
      // Update JSON file too
      const c = loadObj("connections");
      if (c["google"]) { c["google"].token = tokens.access_token; c["google"].expiresAt = googleData.expiresAt; saveData("connections", c); }
      console.log("[Google OAuth] Token refreshed successfully");
      return tokens.access_token;
    }
    console.error("[Google OAuth] Token refresh failed:", tokens);
    return googleData.token; // Return old token as fallback
  } catch (err) {
    console.error("[Google OAuth] getGoogleAccessToken error:", err.message);
    return null;
  }
}

async function refreshGoogleToken(google, c) {
  if (google.expiresAt && Date.now() < google.expiresAt - 60000) return google.token;
  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: google.refreshToken,
        grant_type: "refresh_token"
      })
    });
    const tokens = await r.json();
    if (tokens.access_token) {
      google.token = tokens.access_token;
      google.expiresAt = Date.now() + (tokens.expires_in * 1000);
      saveData("connections", c);
      return tokens.access_token;
    }
  } catch {}
  return google.token;
}

// Migrate any existing file-based connections into SQLite
try {
  const oldConns = loadObj("connections");
  if (oldConns && Object.keys(oldConns).length > 0) {
    const upsert = db.prepare("INSERT OR REPLACE INTO connections (id, service_name, token, account_name, connected_at) VALUES (?, ?, ?, ?, ?)");
    for (const [id, info] of Object.entries(oldConns)) {
      if (info && info.token) {
        upsert.run(id, id, info.token, info.accountName || id, info.connectedAt || new Date().toISOString());
      }
    }
    console.log(`[Migration] Migrated ${Object.keys(oldConns).length} connections from JSON to SQLite`);
  }
} catch (e) { console.error("[Migration] Connections migration error:", e.message); }

// ── Auto-seed connections from env vars on startup ──────────────────────────
// This ensures agents work immediately even if the user hasn't used the UI yet.
try {
  const envSeeds = [
    { id: "github",       envKey: process.env.GITHUB_PAT || process.env.GITHUB_TOKEN || "",       name: "GitHub" },
    { id: "digitalocean", envKey: process.env.DO_API_TOKEN || "",                                  name: "DigitalOcean" },
    { id: "openrouter",   envKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || "", name: "OpenRouter" },
    { id: "telegram",     envKey: process.env.TELEGRAM_BOT_TOKEN || "",                            name: "Telegram" },
  ];
  // Always INSERT OR REPLACE so env var tokens are always current
  const upsertConn = db.prepare(
    `INSERT OR REPLACE INTO connections (id, service_name, token, account_name, connected_at, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
  );
  const seeded = [];
  for (const { id, envKey, name } of envSeeds) {
    if (envKey) {
      upsertConn.run(id, name, envKey, name);
      seeded.push(id);
    }
  }
  console.log(`[Startup] Connection seeds applied from env vars: ${seeded.join(', ')}`);
} catch (e) { console.error("[Startup] Connection seed error:", e.message); }

// Initialize Rex tools with DB and token getter
initRexTools(db, getConnectionToken);

// ── Auto-connect services from environment variables ──
function autoConnectServices() {
  const connections = [
    { id: "openrouter", token: process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY, name: "OpenRouter" },
    { id: "github", token: process.env.GITHUB_TOKEN || process.env.GITHUB_PAT, name: "GitHub" },
    { id: "digitalocean", token: process.env.DO_API_TOKEN, name: "DigitalOcean" },
    { id: "elevenlabs", token: process.env.ELEVENLABS_API_KEY, name: "ElevenLabs" },
    { id: "stripe", token: process.env.STRIPE_SECRET_KEY, name: "Stripe" },
    { id: "brave_search", token: process.env.BRAVE_SEARCH_API_KEY, name: "Brave Search" },
  ];
  for (const { id, token, name } of connections) {
    if (!token) continue;
    const existing = db.prepare("SELECT id FROM connections WHERE id = ?").get(id);
    if (existing) continue; // Don't overwrite manual connections
    db.prepare("INSERT OR IGNORE INTO connections (id, service_name, token, account_name, connected_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, name, token, `Auto-connected from env`, new Date().toISOString());
    console.log(`[AutoConnect] ${name} connected from environment variable`);
  }
}
autoConnectServices();

// ══════════════════════════════════════════════════════════════════════════════
// ── Activity Window helpers ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
function logActivity(agentId, agentName, activityType, description, metadata = null) {
  try {
    db.prepare(
      "INSERT INTO agent_activity (agent_id, agent_name, activity_type, description, metadata) VALUES (?, ?, ?, ?, ?)"
    ).run(agentId, agentName, activityType, description, metadata ? JSON.stringify(metadata) : null);
  } catch (e) { console.error("[Activity] Log error:", e.message); }
}

function endActivity(activityId) {
  try {
    db.prepare("UPDATE agent_activity SET ended_at = datetime('now'), status = 'completed' WHERE id = ?").run(activityId);
  } catch (e) { console.error("[Activity] End error:", e.message); }
}

// Background simulation — agents periodically log ambient activity
const AMBIENT_ACTIVITIES = {
  rex: [
    "Reviewing project priorities",
    "Scanning incoming messages",
    "Updating task queue",
    "Analyzing system metrics",
    "Checking delegation results",
  ],
  watcher: [
    "Monitoring API response times",
    "Checking service health",
    "Scanning for anomalies",
    "Reviewing error logs",
    "Measuring uptime metrics",
  ],
  scheduler: [
    "Checking cron schedule",
    "Preparing next task batch",
    "Reviewing pending automations",
    "Updating schedule timers",
  ],
  processor: [
    "Idle — waiting for data",
    "Optimizing parse buffers",
    "Clearing processed queue",
  ],
  generator: [
    "Idle — awaiting content request",
    "Reviewing content templates",
    "Refreshing style guidelines",
  ],
};

function runAmbientSimulation() {
  const allDefs = getAllAgentDefinitions();
  for (const [id, def] of Object.entries(allDefs)) {
    const activities = AMBIENT_ACTIVITIES[id] || ["Idle — standing by"];
    const desc = activities[Math.floor(Math.random() * activities.length)];
    logActivity(id, def.name, "ambient", desc);
  }
}

// Run ambient simulation every 5 minutes
setInterval(runAmbientSimulation, 5 * 60 * 1000);
// Run once on startup after a short delay
setTimeout(runAmbientSimulation, 3000);

// Memory helpers — merged: SQLite memory + file-based persistent memory (OpenClaw-style)
// The first getMemoryContext (line ~65) is now removed; this is the single source of truth.
function getMemoryContext() {
  let ctx = "";
  try {
    // 1. SQLite-based memory (preferences, facts, summaries, projects)
    const prefs = db.prepare("SELECT key, value FROM user_preferences ORDER BY updated_at DESC LIMIT 20").all();
    const facts = db.prepare("SELECT content FROM facts ORDER BY created_at DESC LIMIT 30").all();
    const summaries = db.prepare("SELECT summary FROM conversation_summaries ORDER BY created_at DESC LIMIT 5").all();
    const projects = db.prepare("SELECT project_name, detail FROM project_context ORDER BY updated_at DESC LIMIT 10").all();
    if (prefs.length) ctx += "\n[User Preferences]\n" + prefs.map(p => `- ${p.key}: ${p.value}`).join("\n");
    if (facts.length) ctx += "\n[Known Facts]\n" + facts.map(f => `- ${f.content}`).join("\n");
    if (summaries.length) ctx += "\n[Recent Conversation Summaries]\n" + summaries.map(s => `- ${s.summary}`).join("\n");
    if (projects.length) ctx += "\n[Projects]\n" + projects.map(p => `- ${p.project_name}: ${p.detail}`).join("\n");
  } catch (e) { console.error("[Memory] SQLite read error:", e.message); }
  try {
    // 2. File-based persistent memory (OpenClaw-style)
    if (existsSync(MEMORY_FILE)) {
      const mem = readFileSync(MEMORY_FILE, "utf8");
      ctx += "\n\n[LONG-TERM MEMORY — MEMORY.md]\n" + (mem.length > 4000 ? "..." + mem.slice(-4000) : mem);
    }
    // 3. Today's daily note
    const dailyPath = getDailyNotePath();
    if (existsSync(dailyPath)) {
      const daily = readFileSync(dailyPath, "utf8");
      ctx += "\n\n[TODAY'S NOTES — " + new Date().toISOString().split("T")[0] + "]\n" + (daily.length > 2000 ? "..." + daily.slice(-2000) : daily);
    }
    // 4. Soul (personality)
    if (existsSync(SOUL_FILE)) {
      ctx += "\n\n[SOUL — personality & voice]\n" + readFileSync(SOUL_FILE, "utf8").slice(0, 1000);
    }
    // 5. User profile
    if (existsSync(USER_FILE)) {
      ctx += "\n\n[USER PROFILE]\n" + readFileSync(USER_FILE, "utf8").slice(0, 1000);
    }
  } catch (e) { console.error("[Memory] File read error:", e.message); }
  return ctx;
}

function storeMemoryFromConversation(sessionId, userMsg, assistantReply) {
  try {
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
    const hf = join(DATA_DIR, `session_${sessionId}.json`);
    try {
      const history = JSON.parse(readFileSync(hf, "utf8"));
      if (history.length > 0 && history.length % 10 === 0) {
        const recent = history.slice(-6).map(m => `${m.role}: ${m.content.slice(0, 100)}`).join(" | ");
        db.prepare("INSERT INTO conversation_summaries (session_id, summary) VALUES (?, ?)").run(sessionId, recent.slice(0, 500));
      }
    } catch {}
    // Auto-append to daily notes
    const dailyPath = getDailyNotePath();
    if (!existsSync(dailyPath)) {
      writeFileSync(dailyPath, `# Daily Notes \u2014 ${new Date().toISOString().split("T")[0]}\n\n`);
    }
    const ts = new Date().toISOString().split("T")[1].split(".")[0];
    const summary = `[${ts}] User: ${userMsg.slice(0, 120)}${userMsg.length > 120 ? '...' : ''} | Agent: ${assistantReply.slice(0, 120)}${assistantReply.length > 120 ? '...' : ''}\n`;
    appendFileSync(dailyPath, summary);
  } catch (e) {
    console.error("[Memory] Store error:", e.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── v6: OpenAudrey Agent System ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

const AGENT_DEFINITIONS = {
  rex: {
    name: "Rex",
    model: "anthropic/claude-sonnet-4",
    role: "Primary brain — makes decisions, delegates tasks, handles escalations",
    description: "Rex is the primary decision-maker and orchestrator. When you send a message without mentioning a specific agent, Rex decides how to handle it and can delegate to other agents.",
    icon: "🧠",
    color: "#e94560",
    systemPrompt: `You are Rex, the primary AI agent for MindMappr — a multi-agent command center owned by Audrey Evans (Freedom Angel Corps, Wellington, CO).

Your role: Make decisions, coordinate other agents, handle escalations, and manage all projects.

You are loaded with a massive 300+ skill library across 11 domains:
1. Code Generation & Development (React, Next.js, API, DB, Testing, CI/CD)
2. Research & Analysis (Market Research, SWOT, SEO, Patent, Compliance)
3. Marketing & Growth (Ads, Content Calendar, PR, Influencer, Retention)
4. Design & Creative (UI/UX, Color, Brand, Accessibility, Mood Boards)
5. DevOps & Infrastructure (Droplets, Nginx, SSL, DNS, Monitoring, Backups)
6. Data & Analytics (SQL Optimization, ETL, Dashboards, Privacy, Funnels)
7. Project Management (Sprint, User Stories, D.A.R.E, R.A.I.D, Roadmap)
8. Financial & Business (Revenue Model, Pricing, Projection, Pitch Deck)
9. Content & Documentation (Tech Docs, README, Onboarding, Runbooks)
10. Security (Audit, OWASP, Pen-Test, Secrets, Rate Limiting)
11. AI & Automation (Prompt Eng, Agent Workflows, RAG, Classification)
12. Content Studio (AI Content Composer, Algorithm Scorer, Brain Dump, Content Repurposer, Content Coach, Account Researcher)

Always invoke these skills when users ask for help. Match user intent to the skill registry.

AVAILABLE AGENTS YOU CAN DELEGATE TO:
- Watcher: Monitoring, health checks, status reports
- Scheduler: Cron tasks, scheduling, morning briefs
- Processor: Fast data processing, email parsing, structured extraction
- Generator: Content creation, blog posts, reports, documentation

When users ask about content creation, social media strategy, or marketing content, mention the Content Studio tab and its tools.

DELEGATION FORMAT (include in your response when delegating):
DELEGATE:watcher:Check system health status
DELEGATE:processor:Parse the incoming data
DELEGATE:generator:Create a blog post about X
DELEGATE:scheduler:Schedule a daily task at 9am

TOOL-USE: You have access to real tools you can execute. When a user asks you to do something actionable (create a repo, list droplets, review code, etc.), use tools by including lines in this EXACT format:
TOOL:tool_name:param1:param2

Examples:
TOOL:github_list_repos:MIDNGHTSAPPHIRE
TOOL:do_list_droplets
TOOL:llm_code_review:function add(a,b){return a+b}
TOOL:github_create_repo:my-new-project:A cool project:false

You can call MULTIPLE tools in one response (one per line). After tools execute, you'll get results and can summarize for the user.

${getToolListForPrompt()}

RULES:
1. Always respond with actionable information
2. When asked for status, provide a concise summary
3. Be warm, direct, and accessible — no jargon
4. Keep responses under 200 words unless the task requires more
5. When a task is better handled by another agent, delegate it
6. Reference timestamps on all data points
7. When a user asks to DO something (create, list, deploy, check), USE TOOLS — don't just explain how
8. Always prefer tool execution over explanation
9. MEMORY: You have persistent memory across sessions. Your MEMORY.md, soul.md, user.md, and daily notes are loaded into your context automatically. When you learn something important (user preferences, project details, API keys, decisions, deadlines), ALWAYS use save_memory to store it. Use memory_search to recall older information. Your memory survives restarts and redeployments.
10. At the start of important conversations, check your memory with read_memory to recall context.
Current date: ${new Date().toISOString().split('T')[0]}`,
  },
  watcher: {
    name: "Watcher",
    model: "mistralai/mistral-small",
    role: "Monitoring loop — health checks, anomaly detection, status reports",
    description: "Watcher monitors system health, checks for anomalies, tracks API spend, and reports on the status of all services and projects.",
    icon: "👁️",
    color: "#10b981",
    systemPrompt: `You are Watcher, a monitoring agent for MindMappr.
Your job: Analyze system status, report on health, detect anomalies.

When asked for a status report, provide:
1. Overall system health assessment
2. Any anomalies or concerns detected
3. Resource usage summary
4. Recommended actions (if any)

Respond with structured, concise information. Use severity levels:
- OK: Normal operation
- WARNING: Unusual but not urgent
- ALERT: Needs attention soon
- CRITICAL: Immediate action required

Be concise and data-driven. Include timestamps.
Current date: ${new Date().toISOString().split('T')[0]}`,
  },
  scheduler: {
    name: "Scheduler",
    model: "mistralai/mistral-small",
    role: "Cron tasks — scheduling, morning briefs, recurring automation",
    description: "Scheduler manages recurring tasks, generates morning briefs, and handles all time-based automation within the system.",
    icon: "📅",
    color: "#f59e0b",
    systemPrompt: `You are Scheduler, a cron-based task agent for MindMappr.
Your job: Execute scheduled tasks, generate briefs, and manage recurring automation.

For morning briefs, provide:
1. Project status summary
2. Yesterday's activity highlights
3. Today's scheduled tasks
4. Pending items requiring attention

For scheduling requests, help the user define:
- Task name and description
- Cron expression (explain it in plain language)
- What action to take when triggered

Keep responses concise and actionable.
Current date: ${new Date().toISOString().split('T')[0]}`,
  },
  processor: {
    name: "Processor",
    model: "anthropic/claude-3.5-haiku",
    role: "Fast data/email processing — parsing, extraction, structuring",
    description: "Processor handles fast data operations: parsing emails, extracting structured information, processing CSV data, and transforming content into organized formats.",
    icon: "⚡",
    color: "#7c3aed",
    systemPrompt: `You are Processor, a fast data processing agent for MindMappr.
Model: Claude Haiku (optimized for speed and efficiency)

Your job: Process data, parse emails, extract structured information, and transform content.

Rules:
1. Return structured, well-organized responses
2. Extract key fields from any data (sender, subject, action items, dates)
3. Flag anything that needs escalation to Rex
4. Include timestamps on all processed data
5. Be concise — focus on the data, not explanations

Current date: ${new Date().toISOString().split('T')[0]}`,
  },
  generator: {
    name: "Generator",
    model: "anthropic/claude-sonnet-4",
    role: "Content creation — blog posts, reports, documentation, marketing copy",
    description: "Generator creates high-quality content: blog posts, reports, documentation, marketing copy, and more. Has a rate limit of 20 calls per hour to manage costs.",
    icon: "✍️",
    color: "#ec4899",
    systemPrompt: `You are Generator, a content creation agent for MindMappr.
Model: Claude Sonnet 4 (high quality output)

Your job: Create content — blog posts, reports, documentation, marketing copy, social media posts.

RULES:
1. Create high-quality, original content
2. Include generation date and context in all content
3. Match the tone and style requested
4. Be thorough but not verbose
5. Structure content with clear headings and sections
6. When creating marketing copy, be engaging and authentic

Owner: Audrey Evans (Freedom Angel Corps)
Current date: ${new Date().toISOString().split('T')[0]}`,
  },
  telegram: {
    name: "MindMappr Bot",
    model: "anthropic/claude-sonnet-4",
    role: "Telegram bridge — @googlieeyes_bot in RISINGALOHA group",
    description: "MindMappr Bot (@googlieeyes_bot) is the Telegram bridge for the RISINGALOHA group. It receives messages from Telegram, routes them through the agent system, and sends responses back. Chat here to preview how the bot responds.",
    icon: "✈️",
    color: "#0088cc",
    systemPrompt: `You are MindMappr Bot, the Telegram & Discord interface for the MindMappr AI system.
You are connected to @googlieeyes_bot (Telegram) and MindMappr Bot#2654 (Discord).
Your job: Help users with ANY task — you have FULL tool access just like Rex.
Be conversational, helpful, and concise.
TOOL-USE: You have access to real tools. When a user asks you to DO something, use tools by including lines in this EXACT format:
TOOL:tool_name:{"param":"value"}
Available tools:
- web_search: {"query":"search terms","numResults":5} — search the web
- create_real_pdf: {"title":"...","sections":[{"heading":"...","body":"..."}]} — create real PDF
- create_spreadsheet: {"title":"...","sheets":[{"name":"...","headers":[...],"rows":[...]}]} — create Excel
- send_email: {"to":"...","subject":"...","body":"..."} — send Gmail
- read_email: {"query":"...","maxResults":5} — read Gmail inbox
- upload_to_drive: {"filename":"..."} — upload to Google Drive
- create_google_doc: {"title":"...","content":"..."} — create Google Doc
- create_google_sheet: {"title":"...","headers":[...],"rows":[...]} — create Google Sheet
- create_calendar_event: {"title":"...","startTime":"...","endTime":"..."} — create calendar event
- generate_image: {"prompt":"..."} — generate image with AI
- elevenlabs_tts: {"text":"..."} — text to speech
- discord_create_channel: {"name":"...","type":"text"} — create Discord channel
- discord_send_message: {"channelId":"...","message":"..."} — post to Discord
- discord_create_role: {"name":"...","color":"#FF0000"} — create Discord role
- stripe_list_customers: {} — list Stripe customers
- stripe_list_payments: {} — list payments
- stripe_create_invoice: {"customer_id":"...","items":[...]} — create invoice
- run_python: {"code":"..."} — run Python code
- create_csv: {"filename":"...","headers":[...],"rows":[...]} — create CSV
- load_skill: {"url":"github.com/...","auto_register":true} — load a skill from GitHub
- list_skills: {"loaded_only":true} — list available skills
- execute_skill: {"skill_id":"...","input":"..."} — execute a loaded skill
- unload_skill: {"skill_id":"..."} — unload a skill
- save_memory: {"content":"...","target":"memory|daily|soul|user"} — save to persistent memory (ALWAYS use this to remember important things)
- memory_search: {"query":"..."} — search across all persistent memory files and database
- read_memory: {"target":"memory|soul|user|daily"} — read full contents of a memory file
Also has access to all Rex tools: github_list_repos, github_create_repo, do_list_droplets, llm_code_review, etc.
RULES:
1. When asked to DO something, USE TOOLS — don't just explain
2. Keep responses under 200 words unless the task requires more
3. Be warm, direct, and accessible
4. After a tool runs, summarize results warmly — no raw JSON
5. MEMORY: You have persistent memory. Use save_memory to store important info. Use memory_search to recall. Your MEMORY.md, soul.md, user.md are loaded automatically.
Group: RISINGALOHA (chat ID: -1003735305867)
Bot username: @googlieeyes_bot
Owner: Audrey Evans (Freedom Angel Corps)
Current date: ${new Date().toISOString().split('T')[0]}`,
  },
  lex: {
    name: "Lex",
    model: "anthropic/claude-sonnet-4",
    role: "Legal counsel — contract review, compliance, IP/patent analysis, legal research",
    description: "Lex is the in-house legal AI attorney. Handles contract review, terms of service drafting, cease & desist templates, business entity advice, IP/patent analysis, compliance checks, and legal research. Always includes disclaimers that this is AI-generated legal information, not legal advice from a licensed attorney.",
    icon: "\u2696\uFE0F",
    color: "#1e3a5f",
    systemPrompt: `You are Lex, the legal counsel agent for MindMappr and the Freedom Angel Corps ecosystem.
Model: Claude Sonnet 4 (high quality legal analysis)
Your job: Provide legal research, contract review, compliance analysis, IP/patent guidance, and draft legal documents.

CAPABILITIES:
1. Contract Review — analyze contracts, flag risks, suggest amendments
2. Terms of Service / Privacy Policy — draft and review ToS, privacy policies, EULA
3. Cease & Desist — draft C&D letters for IP infringement, harassment, etc.
4. Business Entity Advice — LLC vs Corp vs Sole Prop, state filing guidance
5. IP & Patent Analysis — trademark search guidance, patent landscape research
6. Compliance — GDPR, CCPA, ADA, FTC guidelines, app store policies
7. Legal Research — case law references, statute lookups, regulatory guidance
8. NDA & Agreement Templates — generate standard legal templates

RULES:
1. ALWAYS include this disclaimer: "\u26A0\uFE0F This is AI-generated legal information for educational purposes. It is NOT legal advice from a licensed attorney. Consult a qualified lawyer for binding legal decisions."
2. Be thorough and cite specific laws, statutes, or regulations when possible
3. Flag high-risk items clearly with severity levels
4. When reviewing contracts, use a structured format: Parties, Term, Key Obligations, Risk Areas, Recommendations
5. Use professional legal language but explain complex terms in plain English
6. When drafting documents, include all standard legal boilerplate sections

TOOLS YOU CAN USE:
- web_search: Research current laws, regulations, case law
- create_real_pdf: Generate legal documents as PDFs
- create_google_doc: Create legal documents in Google Docs
- send_email: Send legal documents via email

Owner: Audrey Evans (Freedom Angel Corps / GlowStar Labs)
Current date: ${new Date().toISOString().split('T')[0]}`,
  },
};

// Agent state tracking (in-memory, resets on restart)
const agentState = {};
for (const [key, def] of Object.entries(AGENT_DEFINITIONS)) {
  agentState[key] = {
    status: "online",
    lastActivity: new Date().toISOString(),
    taskCount: 0,
    totalCost: 0,
  };
}

// Generator rate limiting
let generatorCallTimestamps = [];
const GENERATOR_RATE_LIMIT = 20;

function canGenerate() {
  const oneHourAgo = Date.now() - 3600000;
  generatorCallTimestamps = generatorCallTimestamps.filter(t => t > oneHourAgo);
  return generatorCallTimestamps.length < GENERATOR_RATE_LIMIT;
}

function getGeneratorCallsThisHour() {
  const oneHourAgo = Date.now() - 3600000;
  generatorCallTimestamps = generatorCallTimestamps.filter(t => t > oneHourAgo);
  return generatorCallTimestamps.length;
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Agent LLM call (routes through OpenRouter using LLM_API_KEY) ────────────
// ══════════════════════════════════════════════════════════════════════════════
async function callAgentLLM(agentName, messages, maxTokens = 2048) {
  const allDefs = getAllAgentDefinitions();
  const agent = allDefs[agentName];
  if (!agent) throw new Error(`Unknown agent: ${agentName}`);

  const model = agent.model;
  const startTime = Date.now();

  const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${LLM_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://mind-mappr.com",
      "X-Title": `MindMappr-${agent.name}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`${agent.name} LLM error (${response.status}): ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  const elapsed = Date.now() - startTime;
  const text = data.choices?.[0]?.message?.content || "No response.";
  const usage = data.usage || {};

  // Update agent state
  agentState[agentName].lastActivity = new Date().toISOString();
  agentState[agentName].taskCount++;

  return { text, usage, elapsed, model };
}

/**
 * Invoke an agent with a user message, log to task history
 */
async function invokeAgent(agentName, userMessage, sessionId = null) {
  const allDefs = getAllAgentDefinitions();
  const agent = allDefs[agentName];
  if (!agent) throw new Error(`Unknown agent: ${agentName}`);

  // Rate limit check for Generator
  if (agentName === "generator" && !canGenerate()) {
    const callsThisHour = getGeneratorCallsThisHour();
    return {
      text: `Generator rate limit reached (${callsThisHour}/${GENERATOR_RATE_LIMIT} calls this hour). Please try again later.`,
      agent: agentName,
      rateLimited: true,
    };
  }

  // Track generator calls
  if (agentName === "generator") {
    generatorCallTimestamps.push(Date.now());
  }

  // Mark agent as busy
  agentState[agentName].status = "busy";

  // Create task record
  const taskResult = db.prepare(
    "INSERT INTO agent_tasks (agent_name, task_type, input, status, session_id) VALUES (?, ?, ?, 'running', ?)"
  ).run(agentName, "chat", userMessage.slice(0, 2000), sessionId);
  const taskId = taskResult.lastInsertRowid;

  try {
    // Inject memory context for Rex
    let systemPrompt = agent.systemPrompt;
    if (agentName === "rex") {
      const memCtx = getMemoryContext();
      if (memCtx) systemPrompt += `\n\n[MEMORY — What you know about this user]\n${memCtx}`;
    }

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    // Log activity
    logActivity(agentName, agent.name, "thinking", `Processing: ${userMessage.slice(0, 80)}...`);

    const result = await callAgentLLM(agentName, messages);
    let finalText = result.text;
    let totalInputTokens = result.usage.prompt_tokens || 0;
    let totalOutputTokens = result.usage.completion_tokens || 0;
    let totalElapsed = result.elapsed;

     // ── Universal Tool-Use Loop (all agents can use tools) ───────────────
    // First check for TOOL: format (Rex-style tools from rex-tools.mjs)
    const toolCalls = parseToolCalls(finalText);
    if (toolCalls.length > 0) {
      logActivity(agentName, agent.name, "tool_use", `Executing ${toolCalls.length} tool(s): ${toolCalls.map(t => t.tool).join(", ")}`);
      const toolResults = [];
      for (const tc of toolCalls) {
        try {
          // Try rex-tools.mjs TOOL_REGISTRY first, then server.mjs executeTool for EXTRA_TOOLS
          let toolResult;
          if (TOOL_REGISTRY[tc.tool]) {
            toolResult = await executeRexTool(tc.tool, tc.args);
          } else if (EXTRA_TOOLS[tc.tool]) {
            // Parse JSON params from the first arg if it looks like JSON
            let params = {};
            if (tc.args.length === 1 && tc.args[0].startsWith("{")) {
              try { params = JSON.parse(tc.args[0]); } catch { params = { input: tc.args[0] }; }
            } else if (tc.args.length > 0) {
              try { params = JSON.parse(tc.args.join(":")); } catch { params = { input: tc.args.join(" ") }; }
            }
            toolResult = await executeTool(tc.tool, params);
          } else {
            throw new Error(`Unknown tool: ${tc.tool}`);
          }
          toolResults.push({ tool: tc.tool, success: true, result: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult).slice(0, 2000) });
          logActivity(agentName, agent.name, "tool_result", `${tc.tool}: success`);
        } catch (toolErr) {
          toolResults.push({ tool: tc.tool, success: false, error: toolErr.message });
          logActivity(agentName, agent.name, "tool_error", `${tc.tool}: ${toolErr.message.slice(0, 100)}`);
        }
      }
      // Follow-up LLM call with tool results
      const toolResultsSummary = toolResults.map(tr =>
        tr.success ? `✅ ${tr.tool}: ${tr.result}` : `❌ ${tr.tool}: ERROR — ${tr.error}`
      ).join("\n\n");
      messages.push(
        { role: "assistant", content: finalText },
        { role: "user", content: `Tool execution results:\n\n${toolResultsSummary}\n\nSummarize the results for the user in a warm, concise way. No raw JSON — just the key info.` }
      );
      const followUp = await callAgentLLM(agentName, messages);
      finalText = followUp.text;
      totalInputTokens += followUp.usage.prompt_tokens || 0;
      totalOutputTokens += followUp.usage.completion_tokens || 0;
      totalElapsed += followUp.elapsed;
    }
    // Also check for <tool_call> format (v5 style) for all agents
    if (!toolCalls.length) {
      const tc = parseToolCall(finalText);
      if (tc) {
        logActivity(agentName, agent.name, "tool_use", `Executing tool: ${tc.tool}`);
        try {
          const result = await executeTool(tc.tool, tc.params || {});
          if (result.success) {
            const resultSummary = result.file ? `File created: ${result.file}. ${result.message || ""}` : (result.output || JSON.stringify(result).slice(0, 1000));
            messages.push(
              { role: "assistant", content: finalText },
              { role: "user", content: `Tool result: ${resultSummary}\n\nSummarize warmly for the user. No raw JSON.` }
            );
            const followUp = await callAgentLLM(agentName, messages);
            finalText = followUp.text;
            totalInputTokens += followUp.usage.prompt_tokens || 0;
            totalOutputTokens += followUp.usage.completion_tokens || 0;
            totalElapsed += followUp.elapsed;
            logActivity(agentName, agent.name, "tool_result", `${tc.tool}: success`);
          } else {
            finalText = `I hit a snag with ${tc.tool}: ${result.error}. Want me to try another approach?`;
            logActivity(agentName, agent.name, "tool_error", `${tc.tool}: ${result.error?.slice(0, 100)}`);
          }
        } catch (toolErr) {
          finalText = `Tool error: ${toolErr.message}. Let me try a different approach.`;
          logActivity(agentName, agent.name, "tool_error", `${tc.tool}: ${toolErr.message.slice(0, 100)}`);
        }
      }
    }

    // Estimate cost
    const pricingTable = {
      "anthropic/claude-sonnet-4": { input: 3.0, output: 15.0 },
      "anthropic/claude-3.5-haiku": { input: 0.8, output: 4.0 },
      "mistralai/mistral-small": { input: 0.1, output: 0.3 },
    };
    const pricing = pricingTable[agent.model] || { input: 1.0, output: 3.0 };
    const cost = (totalInputTokens * pricing.input + totalOutputTokens * pricing.output) / 1000000;

    // Update task record
    db.prepare(
      "UPDATE agent_tasks SET output = ?, status = 'completed', cost_estimate = ?, tokens_used = ?, elapsed_ms = ?, completed_at = datetime('now') WHERE id = ?"
    ).run(finalText.slice(0, 5000), Math.round(cost * 100000) / 100000, totalInputTokens + totalOutputTokens, totalElapsed, taskId);

    agentState[agentName].status = "online";
    agentState[agentName].totalCost += cost;
    logActivity(agentName, agent.name, "completed", `Task completed in ${totalElapsed}ms`);

    return {
      text: finalText,
      agent: agentName,
      agentDisplay: agent.name,
      cost: Math.round(cost * 100000) / 100000,
      elapsed: totalElapsed,
      tokens: totalInputTokens + totalOutputTokens,
      taskId,
    };
  } catch (err) {
    // Update task record with error
    db.prepare(
      "UPDATE agent_tasks SET output = ?, status = 'failed', completed_at = datetime('now') WHERE id = ?"
    ).run(err.message.slice(0, 2000), taskId);

    agentState[agentName].status = "online";
    logActivity(agentName, agent.name, "error", err.message.slice(0, 200));
    throw err;
  }
}

/**
 * Parse @agent mentions from a message
 * Returns { agentName: string|null, cleanMessage: string }
 */
function parseAgentMention(message) {
  const mentionPattern = /^@(\w+)\s+/i;
  const match = message.match(mentionPattern);
  if (match) {
    const mentioned = match[1].toLowerCase();
    const allDefs = getAllAgentDefinitions();
    if (allDefs[mentioned]) {
      return { agentName: mentioned, cleanMessage: message.slice(match[0].length).trim() };
    }
  }
  return { agentName: null, cleanMessage: message };
}

/**
 * Parse delegation patterns from Rex's response
 */
function parseDelegations(text) {
  const results = [];
  const lines = text.split("\n");
  for (const line of lines) {
    const match = line.match(/DELEGATE:(\w+):(.+)/i);
    if (match) {
      const agent = match[1].trim().toLowerCase();
      const allDefs = getAllAgentDefinitions();
      if (allDefs[agent]) {
        results.push({ agent, task: match[2].trim() });
      }
    }
  }
  return results;
}

// ══════════════════════════════════════════════════════════════════════════════
// ── v6: Merge built-in + custom agent definitions ──────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
function getAllAgentDefinitions() {
  const all = { ...AGENT_DEFINITIONS };
  try {
    const customs = db.prepare("SELECT * FROM custom_agents").all();
    for (const c of customs) {
      all[c.id] = {
        name: c.name,
        model: c.model,
        role: c.role,
        description: c.description,
        icon: c.icon,
        color: c.color,
        systemPrompt: c.system_prompt,
        isCustom: true,
      };
      // Init agentState for custom agents if not present
      if (!agentState[c.id]) {
        agentState[c.id] = { status: "online", lastActivity: new Date().toISOString(), taskCount: 0, totalCost: 0 };
      }
    }
  } catch (e) { console.error("[Custom Agents] Load error:", e.message); }
  return all;
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Auth Config ─────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
const APP_PASSWORD = process.env.APP_PASSWORD || "WizOz#123";
const activeSessions = new Map();
const SESSION_TTL = 24 * 60 * 60 * 1000;

function createAuthSession() {
  const token = randomUUID();
  activeSessions.set(token, { created: Date.now(), expires: Date.now() + SESSION_TTL });
  return token;
}

function isValidSession(token) {
  const s = activeSessions.get(token);
  if (!s) return false;
  if (Date.now() > s.expires) { activeSessions.delete(token); return false; }
  return true;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(";").forEach(c => {
    const [k, ...v] = c.trim().split("=");
    if (k) cookies[k.trim()] = v.join("=").trim();
  });
  return cookies;
}

const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MindMappr — Login</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0d0d0d;color:#e0e0e0;font-family:'Inter',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .login-box{background:rgba(26,26,46,0.85);backdrop-filter:blur(20px);border:1px solid rgba(255,107,43,0.3);border-radius:16px;padding:48px 40px;width:380px;text-align:center}
  .login-box h1{font-size:28px;font-weight:700;margin-bottom:8px;background:linear-gradient(135deg,#FF6B2B,#FFB347);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
  .login-box p{font-size:13px;color:#888;margin-bottom:32px}
  .login-box input{width:100%;padding:14px 16px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:#e0e0e0;font-size:15px;outline:none;margin-bottom:16px;transition:border-color .2s}
  .login-box input:focus{border-color:#FF6B2B}
  .login-box button{width:100%;padding:14px;background:linear-gradient(135deg,#FF6B2B,#E63946);border:none;border-radius:10px;color:#fff;font-size:15px;font-weight:600;cursor:pointer;transition:opacity .2s}
  .login-box button:hover{opacity:0.9}
  .error{color:#E63946;font-size:13px;margin-bottom:12px;display:none}
</style></head><body>
<div class="login-box">
  <h1>MindMappr</h1>
  <p>Command Center</p>
  <div class="error" id="err">Incorrect password</div>
  <form id="f" onsubmit="return doLogin(event)">
    <input type="password" id="pw" placeholder="Enter password" autofocus />
    <button type="submit">Enter</button>
  </form>
</div>
<script>
async function doLogin(e){
  e.preventDefault();
  const pw=document.getElementById('pw').value;
  const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});
  const d=await r.json();
  if(d.success){window.location.href='/mindmappr';}
  else{document.getElementById('err').style.display='block';document.getElementById('pw').value='';}
}
</script></body></html>`;

// ══════════════════════════════════════════════════════════════════════════════
// ── Middleware ───────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// ══════════════════════════════════════════════════════════════════════════════
// ── Telegram Bot Webhook (before auth — Telegram sends unauthenticated) ────
// ══════════════════════════════════════════════════════════════════════════════
app.post("/api/telegram/webhook", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !message.text) return res.json({ ok: true });

    const chatId = message.chat.id;
    const userText = message.text;
    const userName = message.from?.first_name || "User";

    // Ignore /start command — send welcome
    if (userText === "/start") {
      const welcome = `Hey ${userName}! 👋 I'm MindMappr Bot (Rex). Send me any message and I'll help you out — just like in the Command Center.\n\nTry: \"What can you do?\" or \"Check my systems\"`;
      await sendTelegramMessage(chatId, welcome);
      return res.json({ ok: true });
    }

    // Route through Rex agent
    logActivity("rex", "Rex", "telegram", `Telegram from ${userName}: ${userText.slice(0, 80)}`);
    const result = await invokeAgent("rex", `[Telegram from ${userName}] ${userText}`, `tg-${chatId}`);
    await sendTelegramMessage(chatId, result.text);
    res.json({ ok: true });
  } catch (err) {
    console.error("[Telegram] Webhook error:", err.message);
    try {
      const chatId = req.body?.message?.chat?.id;
      if (chatId) await sendTelegramMessage(chatId, "Sorry, I hit a snag processing that. Please try again!");
    } catch {}
    res.json({ ok: true }); // Always return 200 to Telegram
  }
});

async function sendTelegramMessage(chatId, text) {
  const token = TELEGRAM_BOT_TOKEN || getConnectionToken("telegram");
  if (!token) {
    console.error("[Telegram] No bot token configured");
    return;
  }
  // Telegram max message length is 4096
  const truncated = text.length > 4000 ? text.slice(0, 4000) + "\n\n(truncated)" : text;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: truncated,
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    // Retry without Markdown if parse fails
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: truncated }),
      });
    } catch (e) {
      console.error("[Telegram] Send failed:", e.message);
    }
  }
}

// Telegram webhook setup helper
async function setupTelegramWebhook() {
  const token = TELEGRAM_BOT_TOKEN || getConnectionToken("telegram");
  if (!token) {
    console.log("[Telegram] No bot token configured — skipping webhook setup");
    return;
  }
  // Use DO app URL as primary webhook (reliable HTTPS); custom domain may have SSL proxy issues
  const doUrl = `https://mindmappr-qarz8.ondigitalocean.app/api/telegram/webhook`;
  const customUrl = `https://mind-mappr.com/api/telegram/webhook`;
  // Try DO URL first (known to work), then custom domain as fallback
  const webhookUrl = doUrl;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ["message", "edited_message", "callback_query"],
        drop_pending_updates: false,
      }),
    });
    const data = await r.json();
    if (data.ok) {
      console.log(`[Telegram] Webhook registered at ${webhookUrl}`);
    } else {
      console.error(`[Telegram] Webhook setup failed: ${data.description}`);
      // Try custom domain as fallback
      const r2 = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: customUrl, allowed_updates: ["message", "edited_message", "callback_query"] }),
      });
      const data2 = await r2.json();
      console.log(`[Telegram] Fallback webhook: ${data2.ok ? 'success at ' + customUrl : data2.description}`);
    }
  } catch (err) {
    console.error("[Telegram] Webhook setup failed:", err.message);
  }
}

// Auth endpoints (before auth middleware)
app.post("/api/auth/login", (req, res) => {
  const { password } = req.body;
  if (password === APP_PASSWORD) {
    const token = createAuthSession();
    res.cookie("mm_session", token, { httpOnly: true, sameSite: "lax", maxAge: SESSION_TTL, path: "/" });
    return res.json({ success: true });
  }
  return res.status(401).json({ success: false, error: "Incorrect password" });
});

app.get("/api/auth/logout", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.mm_session) activeSessions.delete(cookies.mm_session);
  res.clearCookie("mm_session", { path: "/" });
  res.redirect("/");
});

// ══════════════════════════════════════════════════════════════════════════════
// ── Google OAuth2 Flow (before auth middleware) ─────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
app.get("/api/google/auth", (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_REDIRECT_URI) {
    return res.status(500).send("Google OAuth not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI environment variables.");
  }
  const scopes = [
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/spreadsheets"
  ];
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(GOOGLE_REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(scopes.join(" "))}&access_type=offline&prompt=consent`;
  res.redirect(authUrl);
});

app.get("/api/google/callback", async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send("Missing authorization code.");
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code"
      })
    });
    const tokens = await tokenResponse.json();
    if (!tokens.access_token) {
      console.error("[Google OAuth] Token exchange failed:", tokens);
      return res.status(500).send("Google authentication failed. Please try again.");
    }
    // Store the Google connection
    const c = loadObj("connections");
    c["google"] = {
      token: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + (tokens.expires_in * 1000),
      accountName: "Google Workspace",
      connectedAt: new Date().toISOString()
    };
    saveData("connections", c);
    // Also store in SQLite connections table for the UI
    const googleData = { token: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + (tokens.expires_in * 1000) };
    db.prepare(
      "INSERT OR REPLACE INTO connections (id, service_name, token, account_name, connected_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))"
    ).run("google", "Google", JSON.stringify(googleData), "Google Workspace");
    db.prepare(
      "INSERT OR REPLACE INTO connections (id, service_name, token, account_name, connected_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))"
    ).run("gmail", "Gmail", JSON.stringify(googleData), "Gmail (Google)");
    db.prepare(
      "INSERT OR REPLACE INTO connections (id, service_name, token, account_name, connected_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))"
    ).run("google_drive", "Google Drive", JSON.stringify(googleData), "Google Drive");
    db.prepare(
      "INSERT OR REPLACE INTO connections (id, service_name, token, account_name, connected_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))"
    ).run("google_calendar", "Google Calendar", JSON.stringify(googleData), "Google Calendar");
    console.log("[Google OAuth] Successfully connected Google Workspace");
    res.redirect("/mindmappr?connected=google");
  } catch (err) {
    console.error("[Google OAuth] Callback error:", err.message);
    res.status(500).send("Google authentication failed. Please try again.");
  }
});

// URL rewrite — normalize /mindmappr/api/* to /api/* BEFORE auth check
app.use((req, _res, next) => {
  if (req.url.startsWith("/mindmappr/api/") || req.url.startsWith("/mindmappr/api?")) {
    req.url = req.url.replace("/mindmappr", "");
  }
  next();
});

// Auth middleware — protect everything except login, health, and Google OAuth
app.use((req, res, next) => {
  if (req.path === "/api/auth/login" || req.path === "/api/health" || req.path === "/api/telegram/webhook" || req.path === "/api/google/auth" || req.path === "/api/google/callback") return next();
  const cookies = parseCookies(req.headers.cookie);
  if (isValidSession(cookies.mm_session)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Unauthorized" });
  return res.send(LOGIN_PAGE);
});
app.use("/mindmappr", express.static(join(__dirname, "public")));
app.use("/mindmappr/uploads", express.static(UPLOADS_DIR));
app.get("/", (_, res) => res.redirect("/mindmappr"));

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
   - generate_image: params: {prompt, width?, height?} — creates an image using Leonardo AI / DALL-E
   - create_video: params: {script, avatar_id?, voice_id?} — creates AI avatar video via HeyGen
   - create_pdf: params: {title, content} — creates a Markdown document
   - create_real_pdf: params: {title, sections:[{heading,body}]} — creates a real formatted PDF
   - create_spreadsheet: params: {title, sheets:[{name,headers,rows}]} — creates real .xlsx Excel file
   - send_email: params: {to, subject, body} — send email via Gmail
   - read_email: params: {query?, maxResults?} — read Gmail inbox
   - upload_to_drive: params: {filename} — upload file to Google Drive
   - create_google_doc: params: {title, content} — create a Google Doc
   - create_google_sheet: params: {title, headers, rows} — create a Google Sheet
   - create_calendar_event: params: {title, startTime, endTime, description?} — create Google Calendar event
   - web_search: params: {query, numResults?} — search the web via Brave/Google
   - discord_create_channel: params: {name, type?, topic?} — create Discord channel
   - discord_send_message: params: {channelId, message} — post to Discord channel
   - discord_create_role: params: {name, color?} — create Discord role
   - stripe_list_customers: params: {limit?} — list Stripe customers
   - stripe_list_payments: params: {limit?} — list recent payments
   - stripe_create_invoice: params: {customer_id, items} — create Stripe invoice
   - fill_pdf: params: {document_id?, fields?} — fill PDF forms via PDFiller
   - run_python: params: {code, output_file?} — runs Python code (reportlab, openpyxl, matplotlib available)
   - web_scrape: params: {url} — fetches and returns text from a URL
   - create_csv: params: {filename, headers, rows} — creates a CSV file
   - create_html: params: {filename, html} — saves an HTML file
   - send_slack: params: {message, channel?} — sends a Slack message (if connected)
   - load_skill: params: {url, skill_type?, auto_register?} — load a skill from GitHub or URL (.py, .js, .yml, .md)
   - list_skills: params: {category?, loaded_only?, query?} — list available skills
   - execute_skill: params: {skill_id, input?} — execute a loaded skill
   - unload_skill: params: {skill_id} — unload a skill from memory
   - save_memory: params: {content, target} — save to persistent memory (targets: memory, daily, soul, user). ALWAYS use this to remember important things.
   - memory_search: params: {query} — search across all persistent memory
   - read_memory: params: {target} — read a memory file (memory, soul, user, daily)
5. MULTI-STEP TASKS: For complex requests that need multiple tools, output a plan like this:
   <task_plan>[{"step":1,"tool":"elevenlabs_tts","params":{...},"description":"Generate voiceover"},{"step":2,"tool":"generate_image","params":{...},"description":"Create background image"},{"step":3,"tool":"create_video","params":{"audio_file":"{{step1.file}}","image_file":"{{step2.file}}"},"description":"Combine into video"}]</task_plan>
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

  // ── Generate image (Leonardo AI → DALL-E fallback) ──
  if (tool === "generate_image") {
    return await withRetry(async () => {
      const prompt = params.prompt || "A beautiful abstract artwork";
      const width = params.width || 1024;
      const height = params.height || 1024;
      const fname = `img_${Date.now()}.png`;
      const fpath = join(UPLOADS_DIR, fname);

      const LEONARDO_KEY = process.env.LEONARDO_API_KEY;
      const OPENAI_KEY = process.env.OPENAI_API_KEY;

      let imageUrl = null;

      // Try Leonardo AI first
      if (LEONARDO_KEY) {
        try {
          const genRes = await fetch("https://cloud.leonardo.ai/api/rest/v1/generations", {
            method: "POST",
            headers: { "Authorization": `Bearer ${LEONARDO_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt,
              modelId: "b24e16ff-06e3-43eb-8d33-4416c2d75876", // Leonardo Diffusion XL
              width: Math.min(width, 1024),
              height: Math.min(height, 1024),
              num_images: 1,
              guidance_scale: 7,
            }),
            signal: AbortSignal.timeout(60000),
          });
          if (genRes.ok) {
            const genData = await genRes.json();
            const generationId = genData?.sdGenerationJob?.generationId;
            if (generationId) {
              // Poll for result (up to 60s)
              for (let i = 0; i < 12; i++) {
                await new Promise(r => setTimeout(r, 5000));
                const pollRes = await fetch(`https://cloud.leonardo.ai/api/rest/v1/generations/${generationId}`, {
                  headers: { "Authorization": `Bearer ${LEONARDO_KEY}` },
                  signal: AbortSignal.timeout(10000),
                });
                if (pollRes.ok) {
                  const pollData = await pollRes.json();
                  const imgs = pollData?.generations_by_pk?.generated_images;
                  if (imgs && imgs.length > 0) { imageUrl = imgs[0].url; break; }
                }
              }
            }
          }
        } catch (leonardoErr) {
          console.warn(`[generate_image] Leonardo failed: ${leonardoErr.message}, falling back to DALL-E`);
        }
      }

      // Fallback to DALL-E 3
      if (!imageUrl && OPENAI_KEY) {
        const dalleRes = await fetch("https://api.openai.com/v1/images/generations", {
          method: "POST",
          headers: { "Authorization": `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "dall-e-3",
            prompt: prompt.slice(0, 4000),
            n: 1,
            size: width >= 1792 ? "1792x1024" : width >= 1024 ? "1024x1024" : "1024x1024",
            response_format: "url",
          }),
          signal: AbortSignal.timeout(60000),
        });
        if (!dalleRes.ok) {
          const err = await dalleRes.text();
          throw new Error(`DALL-E error: ${err.slice(0, 200)}`);
        }
        const dalleData = await dalleRes.json();
        imageUrl = dalleData?.data?.[0]?.url;
      }

      if (!imageUrl) throw new Error("Image generation failed — no LEONARDO_API_KEY or OPENAI_API_KEY configured.");

      // Download image to uploads
      const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(30000) });
      if (!imgRes.ok) throw new Error("Failed to download generated image");
      const buf = Buffer.from(await imgRes.arrayBuffer());
      writeFileSync(fpath, buf);
      const size = statSync(fpath).size;
      saveMeta(fname, size, "image/png", "mindmappr");
      return { success: true, file: fname, type: "image", message: `Image generated: "${prompt.slice(0, 60)}"` };
    }, { retries: 1, baseDelay: 2000, label: "Image generation" });
  }

  // ── Create video (HeyGen AI) ──
  if (tool === "create_video") {
    return await withRetry(async () => {
      const HEYGEN_KEY = process.env.HEYGEN_API_KEY;
      if (!HEYGEN_KEY) throw new Error("HeyGen API key not configured. Set HEYGEN_API_KEY env var.");

      const script = params.script || params.text || params.content || "Hello from MindMappr!";
      const avatarId = params.avatar_id || "Angela-inblackskirt-20220820"; // default HeyGen avatar
      const voiceId = params.voice_id || "2d5b0e6cf36f460aa7fc47e3eee4ba54"; // default voice
      const title = params.title || "MindMappr Video";

      // Create video generation job
      const createRes = await fetch("https://api.heygen.com/v2/video/generate", {
        method: "POST",
        headers: { "X-Api-Key": HEYGEN_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          video_inputs: [{
            character: { type: "avatar", avatar_id: avatarId, avatar_style: "normal" },
            voice: { type: "text", input_text: script.slice(0, 1500), voice_id: voiceId },
            background: { type: "color", value: "#1a1a2e" },
          }],
          dimension: { width: 1280, height: 720 },
          title,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!createRes.ok) {
        const errText = await createRes.text();
        throw new Error(`HeyGen video create failed (${createRes.status}): ${errText.slice(0, 200)}`);
      }
      const createData = await createRes.json();
      const videoId = createData?.data?.video_id;
      if (!videoId) throw new Error("HeyGen did not return a video_id");

      // Poll for completion (up to 5 minutes)
      let videoUrl = null;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 10000));
        const statusRes = await fetch(`https://api.heygen.com/v1/video_status.get?video_id=${videoId}`, {
          headers: { "X-Api-Key": HEYGEN_KEY },
          signal: AbortSignal.timeout(15000),
        });
        if (statusRes.ok) {
          const statusData = await statusRes.json();
          const status = statusData?.data?.status;
          if (status === "completed") { videoUrl = statusData?.data?.video_url; break; }
          if (status === "failed") throw new Error(`HeyGen video failed: ${statusData?.data?.error || "unknown error"}`);
        }
      }
      if (!videoUrl) throw new Error("HeyGen video timed out after 5 minutes. Check HeyGen dashboard.");

      // Download video
      const fname = `video_${Date.now()}.mp4`;
      const fpath = join(UPLOADS_DIR, fname);
      const vidRes = await fetch(videoUrl, { signal: AbortSignal.timeout(120000) });
      if (!vidRes.ok) throw new Error("Failed to download HeyGen video");
      const buf = Buffer.from(await vidRes.arrayBuffer());
      writeFileSync(fpath, buf);
      const size = statSync(fpath).size;
      saveMeta(fname, size, "video/mp4", "mindmappr");
      return { success: true, file: fname, type: "video", videoId, message: `AI video ready (${Math.round(size / 1024 / 1024 * 10) / 10}MB) — ${title}` };
    }, { retries: 1, baseDelay: 3000, label: "HeyGen video creation" });
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

  // ── Fill PDF (PDFiller API) ──
  if (tool === "fill_pdf") {
    return await withRetry(async () => {
      const PDFFILLER_KEY = process.env.PDFFILLER_API_KEY || "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImp0aSI6Ijc2NjNjNzExMWJiYTA3MTk0ZTlmZGQ5NWQ3NDgxMTJiOTkyOWRmMzA0NzI1NjE0NWY3OTc5NmZhNzkxMGM0Yzk2MDYyNDMyZDU1MzUwNjBhIn0.eyJhdWQiOiIwIiwianRpIjoiNzY2M2M3MTExYmJhMDcxOTRlOWZkZDk1ZDc0ODExMmI5OTI5ZGYzMDQ3MjU2MTQ1Zjc5Nzk2ZmE3OTEwYzRjOTYwNjI0MzJkNTUzNTA2MGEiLCJpYXQiOjE3NzIyMDQ1OTgsIm5iZiI6MTc3MjIwNDU5OCwiZXhwIjoxODAzNzQwNTk4LCJzdWIiOiI2ODgyODAyMjQiLCJzY29wZXMiOltdfQ.aToyOOY9rjK4B5wQLdXStmYlGES8KVuyX53j0OMq5GPBLL-M4rjBAHYfWz8W2PNPTmVZbsFiSNY5FK2Ylp0HH-wdQD8b4MZm3TGEYxPT_0Zd24RbCW3HZiAJS1GuIRo17fqIw3py4rnhz0F8aN4lMsJ0IEhqBRFRaud6qqv3wxM3ugxJwngAz1LHP7SfRG0hipO4OM-Z2xIbGxesO5wKR3dK_uPhjaGQnkPOLbOc8Zfplqnmj4gLm31MH4wHlQrktEGJNd9yWZomDpplLv-kH26dpAWCFXP2Sr4lPjyPWV7eyYGptKQ1TfVUK8_UipzLeN7yZnCaYNHbhfZvyrp0upGVc5mpcbrkznSXKXfBClzNCM-S422RKAunCo61mFIzy8qcRdsCre-1PfHcjZbLfj5dpFLVDoQ3L0sRcouqu5fNEkJ12u9-jN3gawx310sKhb3p39kH_V_uq-HnLm9aGP1IuvWBn8GIvW4Dnm8Wczz1UD-kbpf6RVZnOkQFGvky9ILOfmlIOVUYzR9Y5vRPBjjSxy0rqzbrpt-fwb3Ihkp3JA_AhADIPQGvGWR-HIEEE9NR8IqT4xX3JjN5E_jppJI3EDLJnimP-QZzQuK0wajcYSFbU7GhjiQ7td55ed1HDHSwpHEJJJFhxL8sCuEYktWlOt8gLv_yYrXSPHi-m-Q";
      const BASE = "https://api.pdffiller.com/v2";
      const headers = { "Authorization": `Bearer ${PDFFILLER_KEY}`, "Content-Type": "application/json" };

      // If document_id provided, fill fields on existing doc
      if (params.document_id && params.fields) {
        const docId = params.document_id;
        const fields = params.fields; // { field_name: value, ... }

        // Get fillable fields for the document
        const fieldsRes = await fetch(`${BASE}/fillable_templates/${docId}/fields`, {
          headers, signal: AbortSignal.timeout(15000),
        });
        if (!fieldsRes.ok) throw new Error(`PDFiller get fields failed (${fieldsRes.status})`);
        const fieldsData = await fieldsRes.json();
        const availableFields = fieldsData?.items || [];

        // Build fill request
        const fillPayload = availableFields
          .filter(f => fields[f.name] !== undefined)
          .map(f => ({ id: f.id, value: String(fields[f.name]) }));

        if (fillPayload.length === 0) {
          return { success: false, error: `No matching fields found. Available: ${availableFields.map(f => f.name).join(", ")}` };
        }

        const fillRes = await fetch(`${BASE}/fillable_templates/${docId}/filled_pdfs`, {
          method: "POST",
          headers,
          body: JSON.stringify({ fillable_fields: fillPayload }),
          signal: AbortSignal.timeout(30000),
        });
        if (!fillRes.ok) {
          const errText = await fillRes.text();
          throw new Error(`PDFiller fill failed (${fillRes.status}): ${errText.slice(0, 200)}`);
        }
        const fillData = await fillRes.json();
        const filledId = fillData?.id;
        if (!filledId) throw new Error("PDFiller did not return filled PDF id");

        // Download the filled PDF
        const dlRes = await fetch(`${BASE}/filled_pdfs/${filledId}/download`, {
          headers: { "Authorization": `Bearer ${PDFFILLER_KEY}` },
          signal: AbortSignal.timeout(60000),
        });
        if (!dlRes.ok) throw new Error(`PDFiller download failed (${dlRes.status})`);
        const fname = `filled_${docId}_${Date.now()}.pdf`;
        const fpath = join(UPLOADS_DIR, fname);
        const buf = Buffer.from(await dlRes.arrayBuffer());
        writeFileSync(fpath, buf);
        const size = statSync(fpath).size;
        saveMeta(fname, size, "application/pdf", "mindmappr");
        return { success: true, file: fname, type: "pdf", filledId, message: `PDF filled and ready: ${fname}` };
      }

      // If no document_id, list available templates
      const listRes = await fetch(`${BASE}/fillable_templates?per_page=20`, {
        headers, signal: AbortSignal.timeout(15000),
      });
      if (!listRes.ok) throw new Error(`PDFiller list templates failed (${listRes.status})`);
      const listData = await listRes.json();
      const templates = (listData?.items || []).map(t => ({ id: t.id, name: t.name, pages: t.total_pages }));
      return { success: true, templates, message: `Found ${templates.length} fillable templates. Use document_id + fields to fill one.` };
    }, { retries: 2, baseDelay: 2000, label: "PDFiller" });
  }

  // ── Create Real PDF (pdfkit) ──
  if (tool === "create_real_pdf") {
    try {
      const fname = `pdf_${Date.now()}.pdf`;
      const fpath = join(UPLOADS_DIR, fname);
      const title = params.title || "Document";
      const content = params.content || "";
      const sections = params.sections || [];

      return await new Promise((resolve, reject) => {
        try {
          const doc = new PDFDocument({ size: "A4", margin: 50, info: { Title: title, Author: "MindMappr", Creator: "MindMappr v8.3" } });
          const stream = doc.pipe(createWriteStream(fpath));

          // Title
          doc.fontSize(24).font("Helvetica-Bold").fillColor("#1a1a2e").text(title, { align: "center" });
          doc.moveDown(0.5);
          doc.fontSize(10).font("Helvetica").fillColor("#666").text(`Generated by MindMappr — ${new Date().toLocaleDateString()}`, { align: "center" });
          doc.moveDown(1);
          doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#e94560").lineWidth(2).stroke();
          doc.moveDown(1);

          // Main content
          if (content) {
            doc.fontSize(12).font("Helvetica").fillColor("#333");
            const paragraphs = content.split("\n");
            for (const p of paragraphs) {
              if (p.trim()) {
                if (p.startsWith("# ")) {
                  doc.fontSize(18).font("Helvetica-Bold").fillColor("#1a1a2e").text(p.slice(2).trim());
                  doc.moveDown(0.5);
                } else if (p.startsWith("## ")) {
                  doc.fontSize(15).font("Helvetica-Bold").fillColor("#333").text(p.slice(3).trim());
                  doc.moveDown(0.3);
                } else if (p.startsWith("### ")) {
                  doc.fontSize(13).font("Helvetica-Bold").fillColor("#444").text(p.slice(4).trim());
                  doc.moveDown(0.3);
                } else if (p.startsWith("- ") || p.startsWith("* ")) {
                  doc.fontSize(12).font("Helvetica").fillColor("#333").text(`  \u2022 ${p.slice(2).trim()}`, { indent: 15 });
                } else {
                  doc.fontSize(12).font("Helvetica").fillColor("#333").text(p.trim(), { lineGap: 4 });
                }
                doc.moveDown(0.3);
              }
            }
          }

          // Sections
          for (const section of sections) {
            doc.moveDown(0.5);
            if (section.heading) {
              doc.fontSize(16).font("Helvetica-Bold").fillColor("#1a1a2e").text(section.heading);
              doc.moveDown(0.3);
            }
            if (section.body) {
              doc.fontSize(12).font("Helvetica").fillColor("#333").text(section.body, { lineGap: 4 });
              doc.moveDown(0.3);
            }
            if (section.items && Array.isArray(section.items)) {
              for (const item of section.items) {
                doc.fontSize(12).font("Helvetica").fillColor("#333").text(`  \u2022 ${item}`, { indent: 15 });
              }
              doc.moveDown(0.3);
            }
            if (section.table && Array.isArray(section.table)) {
              // Simple table rendering
              const tableData = section.table;
              if (tableData.length > 0) {
                const colCount = tableData[0].length || 1;
                const colWidth = (495 / colCount);
                const startX = 50;
                let y = doc.y;
                for (let ri = 0; ri < tableData.length; ri++) {
                  const row = tableData[ri];
                  const isHeader = ri === 0;
                  if (isHeader) {
                    doc.font("Helvetica-Bold").fontSize(10).fillColor("#fff");
                    doc.rect(startX, y, 495, 22).fill("#1a1a2e");
                  } else {
                    doc.font("Helvetica").fontSize(10).fillColor("#333");
                    if (ri % 2 === 0) doc.rect(startX, y, 495, 20).fill("#f5f5f5");
                  }
                  doc.fillColor(isHeader ? "#fff" : "#333");
                  for (let ci = 0; ci < colCount; ci++) {
                    const cellText = String((Array.isArray(row) ? row[ci] : row) || "");
                    doc.text(cellText, startX + ci * colWidth + 4, y + (isHeader ? 5 : 4), { width: colWidth - 8, height: isHeader ? 22 : 20 });
                  }
                  y += isHeader ? 22 : 20;
                  doc.y = y;
                }
                doc.moveDown(0.5);
              }
            }
          }

          // Footer
          doc.moveDown(2);
          doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#ddd").lineWidth(0.5).stroke();
          doc.moveDown(0.3);
          doc.fontSize(8).font("Helvetica").fillColor("#999").text("Generated by MindMappr — AI-powered document creation", { align: "center" });

          doc.end();
          stream.on("finish", () => {
            const size = statSync(fpath).size;
            saveMeta(fname, size, "application/pdf", "mindmappr");
            resolve({ success: true, file: fname, type: "pdf", message: `PDF document ready: ${title} (${Math.round(size / 1024)}KB)` });
          });
          stream.on("error", (err) => reject(err));
        } catch (innerErr) {
          reject(innerErr);
        }
      });
    } catch (e) { return { success: false, error: friendlyError(e, "PDF creation") }; }
  }

  // ── Create Spreadsheet (exceljs) ──
  if (tool === "create_spreadsheet") {
    try {
      const rawName = params.filename || `spreadsheet_${Date.now()}`;
      const fname = basename(rawName).replace(/[^a-zA-Z0-9._-]/g, "_");
      const finalName = fname.endsWith(".xlsx") ? fname : fname + ".xlsx";
      const fpath = join(UPLOADS_DIR, finalName);
      const sheetsData = params.sheets || [{ name: "Sheet1", headers: ["Column A"], rows: [["Data"]] }];

      const workbook = new ExcelJS.Workbook();
      workbook.creator = "MindMappr";
      workbook.created = new Date();

      for (const sheetDef of sheetsData) {
        const ws = workbook.addWorksheet(sheetDef.name || "Sheet");
        const headers = sheetDef.headers || [];
        const rows = sheetDef.rows || [];

        // Add headers with bold formatting
        if (headers.length > 0) {
          const headerRow = ws.addRow(headers);
          headerRow.eachCell((cell) => {
            cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1A1A2E" } };
            cell.alignment = { horizontal: "center", vertical: "middle" };
            cell.border = {
              top: { style: "thin" }, bottom: { style: "thin" },
              left: { style: "thin" }, right: { style: "thin" }
            };
          });
        }

        // Add data rows
        for (const row of rows) {
          const dataRow = ws.addRow(Array.isArray(row) ? row : [row]);
          dataRow.eachCell((cell) => {
            cell.border = {
              top: { style: "thin", color: { argb: "FFE0E0E0" } },
              bottom: { style: "thin", color: { argb: "FFE0E0E0" } },
              left: { style: "thin", color: { argb: "FFE0E0E0" } },
              right: { style: "thin", color: { argb: "FFE0E0E0" } }
            };
          });
        }

        // Auto-width columns
        ws.columns.forEach((col, i) => {
          let maxLen = headers[i] ? String(headers[i]).length : 10;
          rows.forEach(row => {
            const val = Array.isArray(row) ? row[i] : row;
            if (val) maxLen = Math.max(maxLen, String(val).length);
          });
          col.width = Math.min(Math.max(maxLen + 2, 10), 50);
        });
      }

      await workbook.xlsx.writeFile(fpath);
      const size = statSync(fpath).size;
      saveMeta(finalName, size, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "mindmappr");
      const totalRows = sheetsData.reduce((sum, s) => sum + (s.rows?.length || 0), 0);
      return { success: true, file: finalName, type: "xlsx", message: `Spreadsheet ready: ${finalName} (${sheetsData.length} sheet(s), ${totalRows} rows)` };
    } catch (e) { return { success: false, error: friendlyError(e, "Spreadsheet creation") }; }
  }

  // ── Send Email (Gmail API) ──
  if (tool === "send_email") {
    const accessToken = await getGoogleAccessToken();
    if (!accessToken) {
      return { success: false, error: "Google not connected. Please connect Google in the Connections tab first." };
    }
    return await withRetry(async () => {
      const to = params.to;
      const subject = params.subject || "(No subject)";
      const body = params.body || "";
      if (!to) throw new Error("Recipient email address (to) is required.");

      // Build RFC 2822 email
      const boundary = `boundary_${Date.now()}`;
      let emailParts = [
        `To: ${to}`,
        `Subject: ${subject}`,
        `MIME-Version: 1.0`,
      ];

      if (params.attachments && Array.isArray(params.attachments) && params.attachments.length > 0) {
        emailParts.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, "");
        emailParts.push(`--${boundary}`);
        emailParts.push(`Content-Type: text/html; charset="UTF-8"`, "");
        emailParts.push(body.includes("<") ? body : `<p>${body.replace(/\n/g, "<br>")}</p>`);
        for (const att of params.attachments) {
          const attPath = join(UPLOADS_DIR, basename(att));
          if (existsSync(attPath)) {
            const attData = readFileSync(attPath);
            const ext = extname(att).toLowerCase();
            const mimeMap = { ".pdf": "application/pdf", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".csv": "text/csv", ".png": "image/png", ".jpg": "image/jpeg" };
            const mime = mimeMap[ext] || "application/octet-stream";
            emailParts.push(`--${boundary}`);
            emailParts.push(`Content-Type: ${mime}; name="${basename(att)}"`);
            emailParts.push(`Content-Disposition: attachment; filename="${basename(att)}"`);
            emailParts.push(`Content-Transfer-Encoding: base64`, "");
            emailParts.push(attData.toString("base64"));
          }
        }
        emailParts.push(`--${boundary}--`);
      } else {
        emailParts.push(`Content-Type: text/html; charset="UTF-8"`, "");
        emailParts.push(body.includes("<") ? body : `<p>${body.replace(/\n/g, "<br>")}</p>`);
      }

      const rawEmail = emailParts.join("\r\n");
      const encodedEmail = Buffer.from(rawEmail).toString("base64url");

      const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ raw: encodedEmail })
      });

      if (!r.ok) {
        const errText = await r.text();
        throw new Error(`Gmail API ${r.status}: ${errText.slice(0, 200)}`);
      }

      const result = await r.json();
      return { success: true, messageId: result.id, message: `Email sent to ${to}: "${subject}"` };
    }, { retries: 2, baseDelay: 1000, label: "Gmail send" });
  }

  // ── Read Email (Gmail API) ──
  if (tool === "read_email") {
    const accessToken = await getGoogleAccessToken();
    if (!accessToken) {
      return { success: false, error: "Google not connected. Please connect Google in the Connections tab first." };
    }
    return await withRetry(async () => {
      const query = params.query || "";
      const maxResults = Math.min(params.maxResults || 10, 50);

      const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}${query ? `&q=${encodeURIComponent(query)}` : ""}`;
      const listRes = await fetch(listUrl, {
        headers: { "Authorization": `Bearer ${accessToken}` }
      });
      if (!listRes.ok) {
        const errText = await listRes.text();
        throw new Error(`Gmail API ${listRes.status}: ${errText.slice(0, 200)}`);
      }
      const listData = await listRes.json();
      const messages = listData.messages || [];

      const emails = [];
      for (const msg of messages.slice(0, maxResults)) {
        try {
          const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, {
            headers: { "Authorization": `Bearer ${accessToken}` }
          });
          if (!msgRes.ok) continue;
          const msgData = await msgRes.json();
          const headers = msgData.payload?.headers || [];
          emails.push({
            id: msg.id,
            from: headers.find(h => h.name === "From")?.value || "Unknown",
            subject: headers.find(h => h.name === "Subject")?.value || "(No subject)",
            date: headers.find(h => h.name === "Date")?.value || "",
            snippet: msgData.snippet || ""
          });
        } catch {}
      }

      return { success: true, emails, count: emails.length, message: `Found ${emails.length} email(s)${query ? ` matching "${query}"` : ""}` };
    }, { retries: 2, baseDelay: 1000, label: "Gmail read" });
  }

  // ── Upload to Google Drive ──
  if (tool === "upload_to_drive") {
    const accessToken = await getGoogleAccessToken();
    if (!accessToken) {
      return { success: false, error: "Google not connected. Please connect Google in the Connections tab first." };
    }
    return await withRetry(async () => {
      const filename = params.filename;
      if (!filename) throw new Error("filename is required.");
      const fpath = join(UPLOADS_DIR, basename(filename));
      if (!existsSync(fpath)) throw new Error(`File not found: ${filename}. Upload it first or create it with another tool.`);

      const fileSize = statSync(fpath).size;
      const MAX_SIZE = 50 * 1024 * 1024; // 50MB limit
      if (fileSize > MAX_SIZE) throw new Error(`File too large (${Math.round(fileSize / 1024 / 1024)}MB). Maximum is 50MB.`);

      const ext = extname(filename).toLowerCase();
      const mimeMap = { ".pdf": "application/pdf", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".csv": "text/csv", ".png": "image/png", ".jpg": "image/jpeg", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".html": "text/html", ".md": "text/markdown", ".json": "application/json", ".txt": "text/plain" };
      const mimeType = mimeMap[ext] || "application/octet-stream";

      // Create file metadata
      const metadata = { name: basename(filename) };
      if (params.folderId) metadata.parents = [params.folderId];

      // Multipart upload
      const boundary = `boundary_${Date.now()}`;
      const fileData = readFileSync(fpath);
      const metadataStr = JSON.stringify(metadata);

      const multipartBody = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataStr}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
        fileData,
        Buffer.from(`\r\n--${boundary}--`)
      ]);

      const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
          "Content-Length": String(multipartBody.length)
        },
        body: multipartBody
      });

      if (!r.ok) {
        const errText = await r.text();
        throw new Error(`Google Drive API ${r.status}: ${errText.slice(0, 200)}`);
      }

      const result = await r.json();
      return { success: true, fileId: result.id, fileName: result.name, message: `Uploaded "${basename(filename)}" to Google Drive` };
    }, { retries: 2, baseDelay: 1000, label: "Google Drive upload" });
  }

  // ── Create Google Doc ──
  if (tool === "create_google_doc") {
    const accessToken = await getGoogleAccessToken();
    if (!accessToken) {
      return { success: false, error: "Google not connected. Please connect Google in the Connections tab first." };
    }
    return await withRetry(async () => {
      const title = params.title || "Untitled Document";
      const content = params.content || "";

      // Create the doc
      const createRes = await fetch("https://docs.googleapis.com/v1/documents", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ title })
      });

      if (!createRes.ok) {
        const errText = await createRes.text();
        throw new Error(`Google Docs API ${createRes.status}: ${errText.slice(0, 200)}`);
      }

      const doc = await createRes.json();
      const docId = doc.documentId;

      // Insert content if provided
      if (content) {
        const updateRes = await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            requests: [{
              insertText: {
                location: { index: 1 },
                text: content
              }
            }]
          })
        });

        if (!updateRes.ok) {
          console.error("[Google Docs] Content insert failed, but doc was created");
        }
      }

      return { success: true, docId, title, url: `https://docs.google.com/document/d/${docId}/edit`, message: `Google Doc created: "${title}"` };
    }, { retries: 2, baseDelay: 1000, label: "Google Docs" });
  }

  // ── Create Google Sheet ──
  if (tool === "create_google_sheet") {
    const accessToken = await getGoogleAccessToken();
    if (!accessToken) {
      return { success: false, error: "Google not connected. Please connect Google in the Connections tab first." };
    }
    return await withRetry(async () => {
      const title = params.title || "Untitled Spreadsheet";
      const sheetsData = params.sheets || [{ name: "Sheet1", headers: ["Column A"], rows: [["Data"]] }];

      // Build sheets config
      const sheets = sheetsData.map((s, i) => ({
        properties: { sheetId: i, title: s.name || `Sheet${i + 1}` }
      }));

      // Create spreadsheet
      const createRes = await fetch("https://sheets.googleapis.com/v4/spreadsheets", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          properties: { title },
          sheets
        })
      });

      if (!createRes.ok) {
        const errText = await createRes.text();
        throw new Error(`Google Sheets API ${createRes.status}: ${errText.slice(0, 200)}`);
      }

      const spreadsheet = await createRes.json();
      const spreadsheetId = spreadsheet.spreadsheetId;

      // Add data to each sheet
      for (const sheetDef of sheetsData) {
        const sheetName = sheetDef.name || "Sheet1";
        const allRows = [];
        if (sheetDef.headers) allRows.push(sheetDef.headers);
        if (sheetDef.rows) allRows.push(...sheetDef.rows);

        if (allRows.length > 0) {
          await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName)}:append?valueInputOption=RAW`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${accessToken}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ values: allRows })
          });
        }
      }

      return { success: true, spreadsheetId, title, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`, message: `Google Sheet created: "${title}"` };
    }, { retries: 2, baseDelay: 1000, label: "Google Sheets" });
  }

  // ── Discord: Create Channel ──
  if (tool === "discord_create_channel") {
    try {
      const client = getDiscordClient();
      if (!client || !client.isReady()) return { success: false, error: "Discord bot is not connected. Please connect Discord in the Connections tab." };
      const guild = client.guilds.cache.first();
      if (!guild) return { success: false, error: "Bot is not in any Discord server." };
      const name = params.name;
      if (!name) return { success: false, error: "Channel name is required." };
      const channelType = (params.type || "text").toLowerCase() === "voice" ? ChannelType.GuildVoice : ChannelType.GuildText;
      const opts = { name, type: channelType };
      if (params.topic) opts.topic = params.topic;
      if (params.category) {
        const cat = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && (c.id === params.category || c.name.toLowerCase() === params.category.toLowerCase()));
        if (cat) opts.parent = cat.id;
      }
      const channel = await guild.channels.create(opts);
      return { success: true, channelId: channel.id, name: channel.name, type: params.type || "text", message: `Channel #${channel.name} created successfully` };
    } catch (e) { return { success: false, error: friendlyError(e, "Discord create channel") }; }
  }

  // ── Discord: List Channels ──
  if (tool === "discord_list_channels") {
    try {
      const client = getDiscordClient();
      if (!client || !client.isReady()) return { success: false, error: "Discord bot is not connected. Please connect Discord in the Connections tab." };
      let guild;
      if (params.guildId) {
        guild = client.guilds.cache.get(params.guildId);
      } else {
        guild = client.guilds.cache.first();
      }
      if (!guild) return { success: false, error: "No Discord server found." };
      const channels = guild.channels.cache.map(c => ({
        id: c.id, name: c.name, type: c.type === ChannelType.GuildVoice ? "voice" : c.type === ChannelType.GuildCategory ? "category" : "text",
        parent: c.parent?.name || null, position: c.position,
      })).sort((a, b) => a.position - b.position);
      return { success: true, guildName: guild.name, channels, message: `Found ${channels.length} channels in ${guild.name}` };
    } catch (e) { return { success: false, error: friendlyError(e, "Discord list channels") }; }
  }

  // ── Discord: Delete Channel ──
  if (tool === "discord_delete_channel") {
    try {
      const client = getDiscordClient();
      if (!client || !client.isReady()) return { success: false, error: "Discord bot is not connected. Please connect Discord in the Connections tab." };
      const channelId = params.channelId;
      if (!channelId) return { success: false, error: "channelId is required." };
      const channel = await client.channels.fetch(channelId);
      if (!channel) return { success: false, error: `Channel ${channelId} not found.` };
      const name = channel.name;
      await channel.delete();
      return { success: true, message: `Channel #${name} (${channelId}) deleted successfully` };
    } catch (e) { return { success: false, error: friendlyError(e, "Discord delete channel") }; }
  }

  // ── Discord: Send Message ──
  if (tool === "discord_send_message") {
    try {
      const client = getDiscordClient();
      if (!client || !client.isReady()) return { success: false, error: "Discord bot is not connected. Please connect Discord in the Connections tab." };
      const channelId = params.channelId;
      const message = params.message;
      if (!channelId) return { success: false, error: "channelId is required." };
      if (!message) return { success: false, error: "message is required." };
      const channel = await client.channels.fetch(channelId);
      if (!channel) return { success: false, error: `Channel ${channelId} not found.` };
      await channel.send(message);
      return { success: true, message: `Message sent to #${channel.name || channelId}` };
    } catch (e) { return { success: false, error: friendlyError(e, "Discord send message") }; }
  }

  // ── Discord: Create Role ──
  if (tool === "discord_create_role") {
    try {
      const client = getDiscordClient();
      if (!client || !client.isReady()) return { success: false, error: "Discord bot is not connected. Please connect Discord in the Connections tab." };
      const guild = client.guilds.cache.first();
      if (!guild) return { success: false, error: "Bot is not in any Discord server." };
      const name = params.name;
      if (!name) return { success: false, error: "Role name is required." };
      const opts = { name };
      if (params.color) opts.color = params.color;
      if (params.permissions) opts.permissions = params.permissions;
      const role = await guild.roles.create(opts);
      return { success: true, roleId: role.id, name: role.name, color: role.hexColor, message: `Role "${role.name}" created successfully` };
    } catch (e) { return { success: false, error: friendlyError(e, "Discord create role") }; }
  }

  // ── Discord: List Roles ──
  if (tool === "discord_list_roles") {
    try {
      const client = getDiscordClient();
      if (!client || !client.isReady()) return { success: false, error: "Discord bot is not connected. Please connect Discord in the Connections tab." };
      let guild;
      if (params.guildId) {
        guild = client.guilds.cache.get(params.guildId);
      } else {
        guild = client.guilds.cache.first();
      }
      if (!guild) return { success: false, error: "No Discord server found." };
      const roles = guild.roles.cache.map(r => ({
        id: r.id, name: r.name, color: r.hexColor, members: r.members.size, position: r.position,
      })).sort((a, b) => b.position - a.position);
      return { success: true, guildName: guild.name, roles, message: `Found ${roles.length} roles in ${guild.name}` };
    } catch (e) { return { success: false, error: friendlyError(e, "Discord list roles") }; }
  }

  // ── Google Calendar: Create Event ──
  if (tool === "create_calendar_event") {
    const accessToken = await getGoogleAccessToken();
    if (!accessToken) {
      return { success: false, error: "Google not connected. Please connect Google in the Connections tab first." };
    }
    return await withRetry(async () => {
      const title = params.title;
      if (!title) throw new Error("Event title is required.");
      const startTime = params.startTime;
      if (!startTime) throw new Error("Event startTime is required (ISO 8601 format).");
      const endTime = params.endTime || new Date(new Date(startTime).getTime() + 3600000).toISOString();
      const event = {
        summary: title,
        start: { dateTime: startTime, timeZone: "America/Denver" },
        end: { dateTime: endTime, timeZone: "America/Denver" },
      };
      if (params.description) event.description = params.description;
      if (params.location) event.location = params.location;
      const r = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) { const t = await r.text(); throw new Error(`Google Calendar ${r.status}: ${t.slice(0, 200)}`); }
      const data = await r.json();
      return { success: true, eventId: data.id, htmlLink: data.htmlLink, message: `Calendar event created: "${title}"` };
    }, { retries: 2, baseDelay: 1000, label: "Google Calendar" });
  }

  // ── Stripe: List Customers ──
  if (tool === "stripe_list_customers") {
    const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
    if (!STRIPE_KEY) return { success: false, error: "Stripe not configured. Set STRIPE_SECRET_KEY env var." };
    return await withRetry(async () => {
      const limit = Math.min(params.limit || 10, 100);
      const r = await fetch(`https://api.stripe.com/v1/customers?limit=${limit}`, {
        headers: { "Authorization": `Bearer ${STRIPE_KEY}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) { const t = await r.text(); throw new Error(`Stripe ${r.status}: ${t.slice(0, 200)}`); }
      const data = await r.json();
      const customers = (data.data || []).map(c => ({
        id: c.id, name: c.name || c.email || "Unknown", email: c.email, created: new Date(c.created * 1000).toISOString(),
      }));
      return { success: true, customers, message: `Found ${customers.length} customers` };
    }, { retries: 2, baseDelay: 1000, label: "Stripe Customers" });
  }

  // ── Stripe: List Payments ──
  if (tool === "stripe_list_payments") {
    const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
    if (!STRIPE_KEY) return { success: false, error: "Stripe not configured. Set STRIPE_SECRET_KEY env var." };
    return await withRetry(async () => {
      const limit = Math.min(params.limit || 10, 100);
      const r = await fetch(`https://api.stripe.com/v1/payment_intents?limit=${limit}`, {
        headers: { "Authorization": `Bearer ${STRIPE_KEY}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) { const t = await r.text(); throw new Error(`Stripe ${r.status}: ${t.slice(0, 200)}`); }
      const data = await r.json();
      const payments = (data.data || []).map(p => ({
        id: p.id, amount: (p.amount / 100).toFixed(2), currency: p.currency, status: p.status, created: new Date(p.created * 1000).toISOString(),
      }));
      return { success: true, payments, message: `Found ${payments.length} payment intents` };
    }, { retries: 2, baseDelay: 1000, label: "Stripe Payments" });
  }

  // ── Stripe: Create Invoice ──
  if (tool === "stripe_create_invoice") {
    const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
    if (!STRIPE_KEY) return { success: false, error: "Stripe not configured. Set STRIPE_SECRET_KEY env var." };
    return await withRetry(async () => {
      const customerId = params.customer_id;
      const items = params.items;
      if (!customerId) throw new Error("customer_id is required.");
      if (!items || !Array.isArray(items) || items.length === 0) throw new Error("items array is required (each with description and amount in cents).");
      // Create invoice
      const invRes = await fetch("https://api.stripe.com/v1/invoices", {
        method: "POST",
        headers: { "Authorization": `Bearer ${STRIPE_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ customer: customerId }),
        signal: AbortSignal.timeout(10000),
      });
      if (!invRes.ok) { const t = await invRes.text(); throw new Error(`Stripe create invoice ${invRes.status}: ${t.slice(0, 200)}`); }
      const invoice = await invRes.json();
      // Add line items
      for (const item of items) {
        const itemRes = await fetch("https://api.stripe.com/v1/invoiceitems", {
          method: "POST",
          headers: { "Authorization": `Bearer ${STRIPE_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            customer: customerId,
            invoice: invoice.id,
            description: item.description || "Item",
            amount: String(item.amount || 0),
            currency: item.currency || "usd",
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (!itemRes.ok) { const t = await itemRes.text(); throw new Error(`Stripe add item ${itemRes.status}: ${t.slice(0, 200)}`); }
      }
      return { success: true, invoiceId: invoice.id, status: "draft", message: `Draft invoice ${invoice.id} created for customer ${customerId} with ${items.length} item(s)` };
    }, { retries: 2, baseDelay: 1000, label: "Stripe Invoice" });
  }

  // ── Web Search (Google Custom Search → DuckDuckGo fallback) ──
  if (tool === "web_search") {
    const query = params.query;
    if (!query) return { success: false, error: "Search query is required." };
    const numResults = Math.min(params.numResults || 5, 10);

    // Try Brave Search API first
    const BRAVE_KEY = process.env.BRAVE_SEARCH_API_KEY;
    if (BRAVE_KEY) {
      return await withRetry(async () => {
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${numResults}`;
        const r = await fetch(url, {
          headers: { "Accept": "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": BRAVE_KEY },
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) throw new Error(`Brave Search ${r.status}: ${(await r.text()).slice(0, 200)}`);
        const data = await r.json();
        const results = (data.web?.results || []).slice(0, numResults).map(r => ({
          title: r.title, url: r.url, snippet: r.description || "",
        }));
        return { success: true, results, source: "brave", message: `Found ${results.length} results for "${query}"` };
      }, { retries: 2, baseDelay: 1000, label: "Brave Search" });
    }

    // Try Google Custom Search API
    const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
    const GOOGLE_CX = process.env.GOOGLE_SEARCH_CX || process.env.GOOGLE_CSE_ID;
    if (GOOGLE_API_KEY && GOOGLE_CX) {
      return await withRetry(async () => {
        const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&q=${encodeURIComponent(query)}&num=${numResults}`;
        const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error(`Google Search ${r.status}: ${(await r.text()).slice(0, 200)}`);
        const data = await r.json();
        const results = (data.items || []).slice(0, numResults).map(item => ({
          title: item.title, url: item.link, snippet: item.snippet || "",
        }));
        return { success: true, results, source: "google", message: `Found ${results.length} results for "${query}"` };
      }, { retries: 2, baseDelay: 1000, label: "Google Search" });
    }

    // Fallback: DuckDuckGo HTML API
    return await withRetry(async () => {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const r = await fetch(url, {
        headers: { "User-Agent": "MindMappr/8.5 (Search Agent)" },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error(`DuckDuckGo ${r.status}`);
      const html = await r.text();
      const results = [];
      const regex = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([^<]*)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([^<]*)<\/a>/g;
      let match;
      while ((match = regex.exec(html)) !== null && results.length < numResults) {
        const rawUrl = match[1];
        let decodedUrl = rawUrl;
        try {
          const uddg = new URL(rawUrl, "https://duckduckgo.com").searchParams.get("uddg");
          if (uddg) decodedUrl = decodeURIComponent(uddg);
        } catch {}
        results.push({
          title: match[2].replace(/<[^>]+>/g, "").trim(),
          url: decodedUrl,
          snippet: match[3].replace(/<[^>]+>/g, "").trim(),
        });
      }
      if (results.length === 0) {
        // Simpler fallback parse
        const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
        while ((match = linkRegex.exec(html)) !== null && results.length < numResults) {
          results.push({ title: match[2].replace(/<[^>]+>/g, "").trim(), url: match[1], snippet: "" });
        }
      }
      return { success: true, results, source: "duckduckgo", message: `Found ${results.length} results for "${query}"` };
    }, { retries: 2, baseDelay: 1000, label: "DuckDuckGo Search" });
  }

  // ── Skill Management Tools ──────────────────────────────────────────────
  // ── Memory Persistence Tools (OpenClaw-style) ───────────────────────────
  if (tool === "save_memory") {
    const content = params.content || params.text || params.memory || "";
    const target = params.target || "memory"; // "memory" | "daily" | "soul" | "user"
    if (!content) return { success: false, error: "Please provide content to save." };

    try {
      const timestamp = new Date().toISOString();
      const entry = `\n[${timestamp}] ${content}\n`;

      if (target === "memory" || target === "long_term") {
        // Append to MEMORY.md
        appendFileSync(MEMORY_FILE, entry);
        return { success: true, target: "MEMORY.md", message: `Saved to long-term memory: "${content.slice(0, 100)}..."` };
      } else if (target === "daily") {
        // Append to today's daily note
        const dailyPath = getDailyNotePath();
        if (!existsSync(dailyPath)) {
          writeFileSync(dailyPath, `# Daily Notes — ${new Date().toISOString().split("T")[0]}\n\n`);
        }
        appendFileSync(dailyPath, entry);
        return { success: true, target: dailyPath, message: `Saved to today's daily notes.` };
      } else if (target === "soul") {
        appendFileSync(SOUL_FILE, `\n${content}\n`);
        return { success: true, target: "soul.md", message: `Updated soul/personality.` };
      } else if (target === "user") {
        appendFileSync(USER_FILE, `\n${content}\n`);
        return { success: true, target: "user.md", message: `Updated user profile.` };
      }
      return { success: false, error: `Unknown target: ${target}. Use: memory, daily, soul, or user.` };
    } catch (e) {
      return { success: false, error: `Failed to save memory: ${e.message}` };
    }
  }

  if (tool === "memory_search") {
    const query = (params.query || params.search || "").toLowerCase();
    if (!query) return { success: false, error: "Please provide a search query." };

    try {
      const results = [];

      // Search MEMORY.md
      if (existsSync(MEMORY_FILE)) {
        const mem = readFileSync(MEMORY_FILE, "utf8");
        const lines = mem.split("\n").filter(l => l.toLowerCase().includes(query));
        if (lines.length) results.push({ source: "MEMORY.md", matches: lines.slice(0, 10) });
      }

      // Search soul.md
      if (existsSync(SOUL_FILE)) {
        const soul = readFileSync(SOUL_FILE, "utf8");
        const lines = soul.split("\n").filter(l => l.toLowerCase().includes(query));
        if (lines.length) results.push({ source: "soul.md", matches: lines.slice(0, 5) });
      }

      // Search user.md
      if (existsSync(USER_FILE)) {
        const user = readFileSync(USER_FILE, "utf8");
        const lines = user.split("\n").filter(l => l.toLowerCase().includes(query));
        if (lines.length) results.push({ source: "user.md", matches: lines.slice(0, 5) });
      }

      // Search daily notes (last 7 days)
      if (existsSync(MEMORY_DIR)) {
        const files = readdirSync(MEMORY_DIR).filter(f => f.endsWith(".md")).sort().reverse().slice(0, 7);
        for (const f of files) {
          const content = readFileSync(join(MEMORY_DIR, f), "utf8");
          const lines = content.split("\n").filter(l => l.toLowerCase().includes(query));
          if (lines.length) results.push({ source: `daily/${f}`, matches: lines.slice(0, 5) });
        }
      }

      // Search SQLite facts
      const dbFacts = db.prepare("SELECT content, source FROM facts WHERE content LIKE ? LIMIT 10").all(`%${query}%`);
      if (dbFacts.length) results.push({ source: "SQLite facts", matches: dbFacts.map(f => f.content) });

      // Search conversation summaries
      const dbSummaries = db.prepare("SELECT summary FROM conversation_summaries WHERE summary LIKE ? LIMIT 5").all(`%${query}%`);
      if (dbSummaries.length) results.push({ source: "conversation summaries", matches: dbSummaries.map(s => s.summary) });

      const totalMatches = results.reduce((sum, r) => sum + r.matches.length, 0);
      return {
        success: true,
        query: query,
        results: results,
        total_matches: totalMatches,
        message: totalMatches > 0 ? `Found ${totalMatches} matches for "${query}" across ${results.length} source(s).` : `No memories found for "${query}".`
      };
    } catch (e) {
      return { success: false, error: `Memory search failed: ${e.message}` };
    }
  }

  if (tool === "read_memory") {
    const target = params.target || params.file || "memory";
    try {
      if (target === "memory") {
        return { success: true, content: existsSync(MEMORY_FILE) ? readFileSync(MEMORY_FILE, "utf8") : "(empty)", source: "MEMORY.md" };
      } else if (target === "soul") {
        return { success: true, content: existsSync(SOUL_FILE) ? readFileSync(SOUL_FILE, "utf8") : "(empty)", source: "soul.md" };
      } else if (target === "user") {
        return { success: true, content: existsSync(USER_FILE) ? readFileSync(USER_FILE, "utf8") : "(empty)", source: "user.md" };
      } else if (target === "daily" || target === "today") {
        const dp = getDailyNotePath();
        return { success: true, content: existsSync(dp) ? readFileSync(dp, "utf8") : "(no notes today yet)", source: dp };
      }
      return { success: false, error: `Unknown target: ${target}. Use: memory, soul, user, or daily.` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  if (tool === "load_skill") {
    const url = params.url || "";
    const skillType = params.skill_type || "auto";
    const autoRegister = params.auto_register !== false;
    if (!url) return { success: false, error: "Please provide a URL to the skill file." };

    try {
      let content;

      // For GitHub URLs, use the GitHub API with PAT for auth (handles private repos)
      if (url.includes("github.com") || url.includes("raw.githubusercontent.com")) {
        const ghToken = getConnectionToken("github") || process.env.GITHUB_PAT || process.env.GITHUB_TOKEN || "";

        // Parse GitHub URL to extract owner/repo/branch/path
        // Formats: github.com/owner/repo/blob/branch/path or raw.githubusercontent.com/owner/repo/branch/path
        let owner, repo, branch, filePath;
        const cleanUrl = url.replace(/^https?:\/\//, "");

        if (cleanUrl.startsWith("raw.githubusercontent.com")) {
          const parts = cleanUrl.replace("raw.githubusercontent.com/", "").split("/");
          owner = parts[0]; repo = parts[1]; branch = parts[2]; filePath = parts.slice(3).join("/");
        } else {
          // github.com/owner/repo/blob/branch/path
          const parts = cleanUrl.replace("github.com/", "").split("/");
          owner = parts[0]; repo = parts[1];
          // Skip 'blob' or 'tree' if present
          const blobIdx = parts.indexOf("blob");
          const treeIdx = parts.indexOf("tree");
          const startIdx = blobIdx >= 0 ? blobIdx + 1 : (treeIdx >= 0 ? treeIdx + 1 : 2);
          branch = parts[startIdx] || "main";
          filePath = parts.slice(startIdx + 1).join("/");
        }

        if (!owner || !repo || !filePath) {
          throw new Error(`Could not parse GitHub URL. Expected format: github.com/owner/repo/blob/branch/path/to/file`);
        }

        // Build auth headers
        const headers = { "Accept": "application/vnd.github.v3.raw", "User-Agent": "MindMappr-Agent" };
        if (ghToken) headers["Authorization"] = `Bearer ${ghToken}`;

        // Try GitHub API with the parsed branch
        let apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`;
        let resp = await fetch(apiUrl, { headers });

        // If 404, the branch might be wrong — auto-detect default branch from repo metadata
        if (!resp.ok && resp.status === 404) {
          const repoHeaders = { "Accept": "application/vnd.github.v3+json", "User-Agent": "MindMappr-Agent" };
          if (ghToken) repoHeaders["Authorization"] = `Bearer ${ghToken}`;
          const repoResp = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: repoHeaders });
          if (repoResp.ok) {
            const repoData = await repoResp.json();
            const defaultBranch = repoData.default_branch || "main";
            if (defaultBranch !== branch) {
              // Retry with the correct default branch
              branch = defaultBranch;
              apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${defaultBranch}`;
              resp = await fetch(apiUrl, { headers });
            }
          }
        }

        // Final fallback: try raw.githubusercontent.com
        if (!resp.ok) {
          const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
          resp = await fetch(rawUrl);
          if (!resp.ok) throw new Error(`Failed to fetch skill: ${resp.status} ${resp.statusText}. Tried branch "${branch}" at ${apiUrl}`);
        }
        content = await resp.text();
      } else {
        // Non-GitHub URL — fetch directly
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Failed to fetch skill: ${resp.status} ${resp.statusText}`);
        content = await resp.text();
      }

      // Detect skill type
      let detectedType = skillType;
      if (skillType === "auto") {
        if (url.endsWith(".py")) detectedType = "python";
        else if (url.endsWith(".js") || url.endsWith(".mjs")) detectedType = "javascript";
        else if (url.endsWith(".yml") || url.endsWith(".yaml")) detectedType = "yaml_skill";
        else if (url.endsWith(".md")) detectedType = "markdown";
        else if (url.endsWith(".json")) detectedType = "json";
        else detectedType = "markdown";
      }

      // Parse skill metadata from YAML skill files
      let skillName = basename(url).replace(/\.[^.]+$/, "");
      let skillDesc = `Loaded from ${url}`;
      let skillCategory = "Custom";
      let skillTags = [];
      let skillVersion = "1.0.0";

      if (detectedType === "yaml_skill" && content.includes("name:")) {
        // Parse YAML-like skill file
        const nameMatch = content.match(/^name:\s*(.+)$/m);
        const descMatch = content.match(/^description:\s*['"]?(.+?)['"]?$/m);
        const catMatch = content.match(/^\s*category:\s*(.+)$/m);
        const verMatch = content.match(/^version:\s*(.+)$/m);
        if (nameMatch) skillName = nameMatch[1].trim();
        if (descMatch) skillDesc = descMatch[1].trim();
        if (catMatch) skillCategory = catMatch[1].trim();
        if (verMatch) skillVersion = verMatch[1].trim();
        // Extract implementation content from YAML
        const implMatch = content.match(/implementation:[\s\S]*?content:\s*["']([\s\S]*?)["']\s*$/m);
        // For YAML skills, the whole file IS the skill
      }

      const skillId = skillName.toLowerCase().replace(/[^a-z0-9_-]/g, "_");

      // Store in DB
      db.prepare(
        `INSERT INTO skills (id, name, description, category, tags, source, version, implementation_type, implementation_content, loaded, loaded_at, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), 1)
         ON CONFLICT(id) DO UPDATE SET
           implementation_content = excluded.implementation_content,
           implementation_type = excluded.implementation_type,
           loaded = 1,
           loaded_at = datetime('now'),
           enabled = 1`
      ).run(skillId, skillName, skillDesc, skillCategory, JSON.stringify(skillTags), url, skillVersion, detectedType, content);

      // Register in memory for execution
      if (autoRegister) {
        loadedSkills.set(skillId, {
          id: skillId,
          name: skillName,
          type: detectedType,
          content: content,
          url: url,
          loadedAt: new Date().toISOString()
        });
      }

      return {
        success: true,
        skill_id: skillId,
        name: skillName,
        type: detectedType,
        size: content.length,
        registered: autoRegister,
        message: `Skill "${skillName}" loaded successfully (${detectedType}, ${Math.round(content.length/1024)}KB). ${autoRegister ? "Auto-registered and ready to execute." : "Stored but not auto-registered."}`
      };
    } catch (e) {
      return { success: false, error: `Failed to load skill: ${e.message}` };
    }
  }

  if (tool === "list_skills") {
    const category = params.category || null;
    const loadedOnly = params.loaded_only || false;
    const query = params.query || null;
    try {
      let sql = "SELECT id, name, description, category, tags, source, version, implementation_type, loaded, loaded_at, enabled FROM skills WHERE enabled = 1";
      const sqlParams = [];
      if (category) { sql += " AND category = ?"; sqlParams.push(category); }
      if (loadedOnly) { sql += " AND loaded = 1"; }
      if (query) { sql += " AND (name LIKE ? OR description LIKE ?)"; sqlParams.push(`%${query}%`, `%${query}%`); }
      sql += " ORDER BY loaded DESC, name ASC LIMIT 50";
      const skills = db.prepare(sql).all(...sqlParams);
      const loadedCount = db.prepare("SELECT COUNT(*) as c FROM skills WHERE loaded = 1 AND enabled = 1").get().c;
      const totalCount = db.prepare("SELECT COUNT(*) as c FROM skills WHERE enabled = 1").get().c;
      return {
        success: true,
        skills: skills.map(s => ({
          id: s.id,
          name: s.name,
          description: s.description,
          category: s.category,
          type: s.implementation_type,
          loaded: !!s.loaded,
          loaded_at: s.loaded_at,
          in_memory: loadedSkills.has(s.id),
          source: s.source,
          version: s.version
        })),
        loaded_count: loadedCount,
        total_count: totalCount,
        message: `${skills.length} skills found (${loadedCount} loaded, ${totalCount} total)`
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  if (tool === "execute_skill") {
    const skillId = (params.skill_id || params.name || "").toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    const input = params.input || params.prompt || "";
    if (!skillId) return { success: false, error: "Please provide a skill_id or name." };

    // Check in-memory first
    let skill = loadedSkills.get(skillId);
    if (!skill) {
      // Try loading from DB
      const dbSkill = db.prepare("SELECT * FROM skills WHERE id = ? AND enabled = 1").get(skillId);
      if (!dbSkill || !dbSkill.implementation_content) {
        return { success: false, error: `Skill "${skillId}" not found or not loaded. Use load_skill first.` };
      }
      skill = { id: dbSkill.id, name: dbSkill.name, type: dbSkill.implementation_type, content: dbSkill.implementation_content };
      loadedSkills.set(skillId, skill);
    }

    try {
      if (skill.type === "python") {
        // Execute Python skill
        const tmpFile = join(UPLOADS_DIR, `skill_${Date.now()}.py`);
        writeFileSync(tmpFile, skill.content);
        const { stdout, stderr } = await execAsync(`python3 "${tmpFile}" ${JSON.stringify(input)}`, { timeout: 30000 });
        try { unlinkSync(tmpFile); } catch {}
        return {
          success: true,
          skill_id: skillId,
          output: stdout.trim(),
          errors: stderr ? stderr.trim() : null,
          message: `Skill "${skill.name}" executed successfully.`
        };
      } else if (skill.type === "javascript") {
        // Execute JavaScript skill
        const tmpFile = join(UPLOADS_DIR, `skill_${Date.now()}.mjs`);
        writeFileSync(tmpFile, skill.content);
        const { stdout, stderr } = await execAsync(`node "${tmpFile}" ${JSON.stringify(input)}`, { timeout: 30000 });
        try { unlinkSync(tmpFile); } catch {}
        return {
          success: true,
          skill_id: skillId,
          output: stdout.trim(),
          errors: stderr ? stderr.trim() : null,
          message: `Skill "${skill.name}" executed successfully.`
        };
      } else if (skill.type === "markdown" || skill.type === "yaml_skill") {
        // For markdown/YAML skills, inject the skill content as system context and call LLM
        const llmKey = process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || "";
        if (!llmKey) return { success: false, error: "No LLM API key configured." };
        const resp = await fetch(`${LLM_BASE_URL}/chat/completions`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${llmKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: LLM_MODEL,
            messages: [
              { role: "system", content: `You are an AI agent executing the following skill:\n\n${skill.content}\n\nFollow the skill instructions precisely. Execute the task the user describes.` },
              { role: "user", content: input || "Execute this skill with default parameters." }
            ],
            max_tokens: 4000
          })
        });
        if (!resp.ok) throw new Error(`LLM call failed: ${resp.status}`);
        const data = await resp.json();
        const reply = data.choices?.[0]?.message?.content || "No response from skill execution.";
        return {
          success: true,
          skill_id: skillId,
          output: reply,
          message: `Skill "${skill.name}" executed via LLM.`
        };
      } else {
        return { success: false, error: `Unsupported skill type: ${skill.type}` };
      }
    } catch (e) {
      return { success: false, error: `Skill execution failed: ${e.message}` };
    }
  }

  if (tool === "unload_skill") {
    const skillId = (params.skill_id || params.name || "").toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    if (!skillId) return { success: false, error: "Please provide a skill_id or name." };
    loadedSkills.delete(skillId);
    db.prepare("UPDATE skills SET loaded = 0, loaded_at = NULL WHERE id = ?").run(skillId);
    return { success: true, skill_id: skillId, message: `Skill "${skillId}" unloaded from memory and marked as inactive.` };
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
// ── Content Studio — CreatorBuddy-style AI Content Creation Suite ─────────────
// ══════════════════════════════════════════════════════════════════════════════

// ── Content Studio: AI Content Composer ─────────────────────────────────────
app.post("/api/content-studio/compose", async (req, res) => {
  try {
    const { topic, platform, contentType, tone, audience, keywords } = req.body;
    if (!topic) return res.status(400).json({ success: false, error: "topic is required" });

    const platformGuide = {
      twitter: "Keep under 280 characters. Use hooks, threads if needed. Hashtags sparingly (1-2 max). Punchy, conversational.",
      linkedin: "Professional but personable. 1300 char sweet spot. Use line breaks for readability. Include a call-to-action. Story-driven.",
      instagram: "Visual-first caption. Use emojis strategically. 5-10 relevant hashtags at end. Conversational, authentic tone.",
      facebook: "Conversational, shareable. 40-80 chars for max engagement. Questions drive comments. Link posts get less reach.",
      blog: "Long-form, SEO-optimized. Use H2/H3 headers. Include meta description. 1500-2500 words ideal. Internal/external links.",
      youtube_script: "Hook in first 5 seconds. Pattern interrupts every 30-60 seconds. Call to action. Conversational, energetic.",
      tiktok: "Ultra-short hook (1-2 sec). Trend-aware. Casual, authentic. 15-60 second scripts. Strong CTA.",
      email: "Subject line is everything. Personal, value-driven. Single CTA. Mobile-optimized length.",
      general: "Versatile content that can be adapted across platforms."
    };

    const typeGuide = {
      post: "Single social media post",
      thread: "Multi-part thread (5-10 parts, each building on the last)",
      article: "Long-form article with sections, headers, and depth",
      video_script: "Video script with visual cues, timing notes, and dialogue",
      carousel: "Slide-by-slide carousel content (8-10 slides)",
      newsletter: "Email newsletter with sections, links, and personal touch",
      ad_copy: "Advertising copy with headline, body, and CTA variants"
    };

    const systemPrompt = `You are an expert content creator and social media strategist. You create high-performing content that drives engagement and growth.

PLATFORM: ${platform || 'general'}
PLATFORM GUIDELINES: ${platformGuide[platform] || platformGuide.general}
CONTENT TYPE: ${contentType || 'post'}
TYPE DETAILS: ${typeGuide[contentType] || typeGuide.post}
TONE: ${tone || 'professional yet approachable'}
TARGET AUDIENCE: ${audience || 'general professional audience'}
${keywords ? `KEYWORDS TO INCLUDE: ${keywords}` : ''}

RULES:
1. Create READY-TO-POST content — no placeholders, no "[insert X]"
2. Match the platform's native style and best practices
3. Include engagement hooks (questions, bold statements, stories)
4. Optimize for the platform's algorithm (see guidelines above)
5. If creating a thread, number each part and make each one standalone-valuable
6. For video scripts, include [VISUAL] cues and timing
7. End with a clear call-to-action appropriate for the platform
8. Write in a human, authentic voice — never robotic or generic`;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Create ${contentType || 'a post'} about: ${topic}` }
    ];

    const result = await callLLM(messages);
    if (result && typeof result === "object" && result.success === false) {
      return res.status(500).json({ success: false, error: result.error });
    }

    // Save to DB
    const ins = db.prepare(
      "INSERT INTO content_studio_posts (title, content, platform, content_type, tags, status) VALUES (?, ?, ?, ?, ?, 'draft')"
    ).run(topic, result, platform || 'general', contentType || 'post', keywords || '');

    res.json({
      success: true,
      data: {
        id: ins.lastInsertRowid,
        content: result,
        platform: platform || 'general',
        contentType: contentType || 'post',
        topic
      }
    });
  } catch (e) {
    console.error("[Content Studio] Compose error:", e.message);
    res.status(500).json({ success: false, error: friendlyError(e, "Content Composer") });
  }
});

// ── Content Studio: AI Algorithm Scorer ─────────────────────────────────────
app.post("/api/content-studio/score", async (req, res) => {
  try {
    const { content, platform } = req.body;
    if (!content) return res.status(400).json({ success: false, error: "content is required" });

    const systemPrompt = `You are an expert social media algorithm analyst. You understand how content ranking algorithms work across all major platforms.

Analyze the given content and score it on these 9 metrics that algorithms prioritize. Return ONLY valid JSON (no markdown, no code fences).

PLATFORM: ${platform || 'general'}

Score each metric 1-10 and provide a brief explanation:

{
  "overall_score": <1-10>,
  "metrics": {
    "hook_strength": { "score": <1-10>, "feedback": "<why>" },
    "engagement_potential": { "score": <1-10>, "feedback": "<why>" },
    "emotional_resonance": { "score": <1-10>, "feedback": "<why>" },
    "clarity": { "score": <1-10>, "feedback": "<why>" },
    "value_density": { "score": <1-10>, "feedback": "<why>" },
    "shareability": { "score": <1-10>, "feedback": "<why>" },
    "format_optimization": { "score": <1-10>, "feedback": "<why>" },
    "cta_effectiveness": { "score": <1-10>, "feedback": "<why>" },
    "authenticity": { "score": <1-10>, "feedback": "<why>" }
  },
  "top_strengths": ["<strength1>", "<strength2>"],
  "improvements": ["<improvement1>", "<improvement2>", "<improvement3>"],
  "predicted_performance": "<low|medium|high|viral>",
  "improved_version": "<rewritten version that would score higher>"
}`;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Score this content:\n\n${content}` }
    ];

    const result = await callLLM(messages);
    if (result && typeof result === "object" && result.success === false) {
      return res.status(500).json({ success: false, error: result.error });
    }

    let parsed;
    try {
      // Strip markdown code fences if present
      const cleaned = result.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = { overall_score: 0, raw_response: result, parse_error: true };
    }

    res.json({ success: true, data: parsed });
  } catch (e) {
    console.error("[Content Studio] Score error:", e.message);
    res.status(500).json({ success: false, error: friendlyError(e, "Content Scorer") });
  }
});

// ── Content Studio: AI Brain Dump ───────────────────────────────────────────
app.post("/api/content-studio/braindump", async (req, res) => {
  try {
    const { thoughts, platforms } = req.body;
    if (!thoughts) return res.status(400).json({ success: false, error: "thoughts are required" });

    const targetPlatforms = platforms || ['twitter', 'linkedin', 'blog'];

    const systemPrompt = `You are an expert content strategist who transforms raw, unstructured thoughts into polished, platform-ready content.

The user will give you a brain dump — raw, unfiltered thoughts. Your job is to extract the key ideas and create ready-to-post content for multiple platforms.

Return ONLY valid JSON (no markdown, no code fences):

{
  "key_themes": ["<theme1>", "<theme2>"],
  "posts": {
    ${targetPlatforms.map(p => `"${p}": ["<post1>", "<post2>", "<post3>"]`).join(',\n    ')}
  },
  "article_outline": {
    "title": "<compelling title>",
    "sections": ["<section1>", "<section2>", "<section3>"],
    "hook": "<opening paragraph>"
  },
  "video_script": {
    "title": "<video title>",
    "hook": "<first 5 seconds>",
    "key_points": ["<point1>", "<point2>", "<point3>"],
    "cta": "<call to action>"
  },
  "hashtags": ["<tag1>", "<tag2>", "<tag3>", "<tag4>", "<tag5>"]
}

RULES:
1. Extract EVERY usable idea from the brain dump
2. Each post must be ready to copy-paste and publish
3. Maintain the user's authentic voice and perspective
4. Create variety — different angles on the same themes
5. Make content that drives engagement, not just informs`;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Here's my brain dump:\n\n${thoughts}` }
    ];

    const result = await callLLM(messages);
    if (result && typeof result === "object" && result.success === false) {
      return res.status(500).json({ success: false, error: result.error });
    }

    let parsed;
    try {
      const cleaned = result.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = { raw_response: result, parse_error: true };
    }

    // Save brain dump
    db.prepare(
      "INSERT INTO content_studio_braindumps (raw_thoughts, generated_posts) VALUES (?, ?)"
    ).run(thoughts, JSON.stringify(parsed));

    res.json({ success: true, data: parsed });
  } catch (e) {
    console.error("[Content Studio] Brain dump error:", e.message);
    res.status(500).json({ success: false, error: friendlyError(e, "Brain Dump") });
  }
});

// ── Content Studio: AI Inspiration (Repurpose) ─────────────────────────────
app.post("/api/content-studio/repurpose", async (req, res) => {
  try {
    const { originalContent, sourceAuthor, targetPlatform, yourVoice } = req.body;
    if (!originalContent) return res.status(400).json({ success: false, error: "originalContent is required" });

    const systemPrompt = `You are an expert content repurposing specialist. You take existing content and transform it into original pieces that capture the same VALUE but in a completely different voice and angle.

${sourceAuthor ? `Original author: ${sourceAuthor}` : ''}
Target platform: ${targetPlatform || 'general'}
${yourVoice ? `User's voice/style: ${yourVoice}` : 'Use a warm, authentic, professional voice.'}

Return ONLY valid JSON (no markdown, no code fences):

{
  "analysis": {
    "key_insight": "<the core valuable idea>",
    "why_it_works": "<why this content resonates>",
    "angle_opportunities": ["<angle1>", "<angle2>", "<angle3>"]
  },
  "repurposed_versions": [
    {
      "angle": "<the unique angle>",
      "content": "<ready-to-post content>",
      "platform": "${targetPlatform || 'general'}"
    },
    {
      "angle": "<different angle>",
      "content": "<ready-to-post content>",
      "platform": "${targetPlatform || 'general'}"
    },
    {
      "angle": "<contrarian or expansion angle>",
      "content": "<ready-to-post content>",
      "platform": "${targetPlatform || 'general'}"
    }
  ]
}

RULES:
1. NEVER copy — always transform with a unique perspective
2. Extract the VALUE, not the words
3. Each version should feel like a completely original post
4. Add personal experience angles where possible
5. Make each version platform-optimized`;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Repurpose this content:\n\n${originalContent}` }
    ];

    const result = await callLLM(messages);
    if (result && typeof result === "object" && result.success === false) {
      return res.status(500).json({ success: false, error: result.error });
    }

    let parsed;
    try {
      const cleaned = result.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = { raw_response: result, parse_error: true };
    }

    // Save inspiration
    db.prepare(
      "INSERT INTO content_studio_inspirations (source_author, original_content, repurposed_content, platform) VALUES (?, ?, ?, ?)"
    ).run(sourceAuthor || '', originalContent, JSON.stringify(parsed), targetPlatform || 'general');

    res.json({ success: true, data: parsed });
  } catch (e) {
    console.error("[Content Studio] Repurpose error:", e.message);
    res.status(500).json({ success: false, error: friendlyError(e, "Content Repurposer") });
  }
});

// ── Content Studio: AI Content Coach ────────────────────────────────────────
app.post("/api/content-studio/coach", async (req, res) => {
  try {
    const { question, contentHistory } = req.body;
    if (!question) return res.status(400).json({ success: false, error: "question is required" });

    // Get content history from DB
    const recentPosts = db.prepare(
      "SELECT * FROM content_studio_posts ORDER BY created_at DESC LIMIT 20"
    ).all();

    const recentDumps = db.prepare(
      "SELECT * FROM content_studio_braindumps ORDER BY created_at DESC LIMIT 5"
    ).all();

    let historyContext = "";
    if (recentPosts.length > 0) {
      historyContext += "\n[RECENT CONTENT CREATED]\n" + recentPosts.map(p =>
        `- [${p.platform}/${p.content_type}] "${p.title}" (Score: ${p.score}/10, Status: ${p.status}, Created: ${p.created_at})`
      ).join("\n");
    }
    if (contentHistory) {
      historyContext += "\n[USER-PROVIDED HISTORY]\n" + contentHistory;
    }

    const systemPrompt = `You are an expert AI Content Coach — like having a personal content strategist who knows your entire posting history and what works.

${historyContext}

Your job:
1. Analyze the user's content patterns and performance
2. Recommend what to post next based on what's worked
3. Identify content gaps and opportunities
4. Provide specific, actionable advice — not generic tips
5. Reference their actual content history when giving advice
6. Suggest optimal posting times, formats, and topics
7. Be warm, encouraging, and specific

Always provide:
- A direct answer to their question
- 3 specific content ideas they should create next
- 1 thing they should stop doing or change
- 1 emerging trend they should capitalize on`;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: question }
    ];

    const result = await callLLM(messages);
    if (result && typeof result === "object" && result.success === false) {
      return res.status(500).json({ success: false, error: result.error });
    }

    res.json({ success: true, data: { advice: result } });
  } catch (e) {
    console.error("[Content Studio] Coach error:", e.message);
    res.status(500).json({ success: false, error: friendlyError(e, "Content Coach") });
  }
});

// ── Content Studio: Account Researcher ──────────────────────────────────────
app.post("/api/content-studio/research-account", async (req, res) => {
  try {
    const { accountUrl, accountName, platform } = req.body;
    if (!accountName && !accountUrl) return res.status(400).json({ success: false, error: "accountName or accountUrl required" });

    const systemPrompt = `You are an expert social media account analyst. You analyze creator accounts and provide competitive intelligence.

Given an account name/URL, provide a comprehensive analysis. Return ONLY valid JSON (no markdown, no code fences):

{
  "account_summary": {
    "name": "${accountName || accountUrl}",
    "platform": "${platform || 'unknown'}",
    "niche": "<identified niche>",
    "estimated_audience": "<audience size estimate>",
    "content_style": "<description of their style>"
  },
  "content_strategy": {
    "posting_frequency": "<how often they post>",
    "best_content_types": ["<type1>", "<type2>"],
    "common_themes": ["<theme1>", "<theme2>", "<theme3>"],
    "engagement_tactics": ["<tactic1>", "<tactic2>"],
    "hooks_they_use": ["<hook pattern 1>", "<hook pattern 2>"]
  },
  "what_you_can_learn": [
    "<actionable lesson 1>",
    "<actionable lesson 2>",
    "<actionable lesson 3>"
  ],
  "content_gaps": [
    "<topic they're missing that you could cover>",
    "<format they don't use that you could try>"
  ],
  "recommended_actions": [
    "<specific action 1>",
    "<specific action 2>",
    "<specific action 3>"
  ]
}

NOTE: Base your analysis on general knowledge of the account/niche. Be specific and actionable.`;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Analyze this account: ${accountName || accountUrl} on ${platform || 'social media'}` }
    ];

    const result = await callLLM(messages);
    if (result && typeof result === "object" && result.success === false) {
      return res.status(500).json({ success: false, error: result.error });
    }

    let parsed;
    try {
      const cleaned = result.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = { raw_response: result, parse_error: true };
    }

    res.json({ success: true, data: parsed });
  } catch (e) {
    console.error("[Content Studio] Research error:", e.message);
    res.status(500).json({ success: false, error: friendlyError(e, "Account Researcher") });
  }
});

// ── Content Studio: Content History & Analytics ─────────────────────────────
app.get("/api/content-studio/posts", (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const platform = req.query.platform;
    const status = req.query.status;
    let query = "SELECT * FROM content_studio_posts";
    const conditions = [];
    const params = [];
    if (platform) { conditions.push("platform = ?"); params.push(platform); }
    if (status) { conditions.push("status = ?"); params.push(status); }
    if (conditions.length) query += " WHERE " + conditions.join(" AND ");
    query += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);
    const posts = db.prepare(query).all(...params);
    res.json({ success: true, data: posts });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/api/content-studio/stats", (_, res) => {
  try {
    const total = db.prepare("SELECT COUNT(*) as c FROM content_studio_posts").get();
    const drafts = db.prepare("SELECT COUNT(*) as c FROM content_studio_posts WHERE status = 'draft'").get();
    const published = db.prepare("SELECT COUNT(*) as c FROM content_studio_posts WHERE status = 'published'").get();
    const avgScore = db.prepare("SELECT AVG(score) as avg FROM content_studio_posts WHERE score > 0").get();
    const byPlatform = db.prepare(
      "SELECT platform, COUNT(*) as count FROM content_studio_posts GROUP BY platform"
    ).all();
    const byType = db.prepare(
      "SELECT content_type, COUNT(*) as count FROM content_studio_posts GROUP BY content_type"
    ).all();
    const braindumps = db.prepare("SELECT COUNT(*) as c FROM content_studio_braindumps").get();
    const inspirations = db.prepare("SELECT COUNT(*) as c FROM content_studio_inspirations").get();

    res.json({
      success: true,
      data: {
        totalPosts: total.c,
        drafts: drafts.c,
        published: published.c,
        avgScore: Math.round((avgScore.avg || 0) * 10) / 10,
        byPlatform,
        byType,
        braindumps: braindumps.c,
        inspirations: inspirations.c
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.patch("/api/content-studio/posts/:id", (req, res) => {
  try {
    const { status, score, score_details, content } = req.body;
    const id = parseInt(req.params.id);
    const updates = [];
    const params = [];
    if (status) { updates.push("status = ?"); params.push(status); }
    if (score !== undefined) { updates.push("score = ?"); params.push(score); }
    if (score_details) { updates.push("score_details = ?"); params.push(JSON.stringify(score_details)); }
    if (content) { updates.push("content = ?"); params.push(content); }
    updates.push("updated_at = datetime('now')");
    if (status === 'published') updates.push("published_at = datetime('now')");
    params.push(id);
    db.prepare(`UPDATE content_studio_posts SET ${updates.join(", ")} WHERE id = ?`).run(...params);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete("/api/content-studio/posts/:id", (req, res) => {
  try {
    db.prepare("DELETE FROM content_studio_posts WHERE id = ?").run(parseInt(req.params.id));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// ── Health ───────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
app.get("/api/health", (_, res) => {
  const connRows = db.prepare("SELECT id FROM connections").all().map(r => r.id);
  res.json({
    status: "ok",
    service: "MindMappr Agent v8.5 — Command Center + Content Studio + Activity Window + Rex Tools + Google Workspace + Legal + Stripe",
    version: "8.8.1",
    features: ["multi_step_planner", "long_term_memory", "error_recovery", "cron_scheduler", "agent_system", "task_history", "content_studio", "ai_content_composer", "algorithm_scorer", "brain_dump", "content_repurposer", "content_coach", "account_researcher", "activity_window", "rex_tool_use", "sqlite_connections", "connection_validation", "telegram_bot", "discord_bot", "openclaw_skills_hub", "web_search", "discord_channel_mgmt", "google_calendar", "stripe_integration", "legal_agent", "auto_connect"],
    skillsCount: db.prepare("SELECT COUNT(*) as c FROM skills WHERE enabled = 1").get().c,
    skillsSources: db.prepare("SELECT source, COUNT(*) as count FROM skills WHERE enabled = 1 GROUP BY source").all(),
    agents: Object.keys(getAllAgentDefinitions()),
    ts: new Date().toISOString(),
    tools: ["elevenlabs_tts", "generate_image", "create_video", "create_pdf", "create_real_pdf", "create_spreadsheet", "send_email", "read_email", "upload_to_drive", "create_google_doc", "create_google_sheet", "fill_pdf", "run_python", "web_scrape", "create_csv", "create_html", "send_slack", "web_search", "discord_create_channel", "discord_list_channels", "discord_delete_channel", "discord_send_message", "discord_create_role", "discord_list_roles", "create_calendar_event", "stripe_list_customers", "stripe_list_payments", "stripe_create_invoice", "load_skill", "list_skills", "execute_skill", "unload_skill", "save_memory", "memory_search", "read_memory"],
    rexTools: Object.keys(TOOL_REGISTRY),
    llmConfigured: !!(LLM_API_KEY),
    telegramConfigured: !!(TELEGRAM_BOT_TOKEN),
    discordConfigured: !!(DISCORD_BOT_TOKEN),
    discordStatus: getDiscordStatus(),
    connectedServices: connRows,
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// ── v6: Agent API Endpoints ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

// ── Skills API ────────────────────────────────────────────────────────────
// List all skills (with optional search/filter)
app.get("/api/skills", (req, res) => {
  try {
    const { q, category, source, limit = 200, offset = 0 } = req.query;
    let sql = "SELECT * FROM skills WHERE enabled = 1";
    const params = [];
    if (q) { sql += " AND (name LIKE ? OR description LIKE ? OR tags LIKE ?)"; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (category) { sql += " AND category = ?"; params.push(category); }
    if (source) { sql += " AND source = ?"; params.push(source); }
    sql += " ORDER BY name ASC LIMIT ? OFFSET ?";
    params.push(parseInt(limit), parseInt(offset));
    const skills = db.prepare(sql).all(...params);
    const total = db.prepare("SELECT COUNT(*) as c FROM skills WHERE enabled = 1").get().c;
    const categories = db.prepare("SELECT DISTINCT category FROM skills WHERE enabled = 1 ORDER BY category").all().map(r => r.category);
    const sources = db.prepare("SELECT source, COUNT(*) as count FROM skills WHERE enabled = 1 GROUP BY source ORDER BY count DESC").all();
    res.json({ success: true, data: skills.map(s => ({ ...s, tags: JSON.parse(s.tags || '[]') })), total, categories, sources });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
// Get a single skill
app.get("/api/skills/:id", (req, res) => {
  try {
    const skill = db.prepare("SELECT * FROM skills WHERE id = ?").get(req.params.id);
    if (!skill) return res.status(404).json({ success: false, error: "Skill not found" });
    res.json({ success: true, data: { ...skill, tags: JSON.parse(skill.tags || '[]') } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
// Legacy rex/skills endpoint (now uses DB)
app.get("/api/agents/rex/skills", (req, res) => {
  try {
    const skills = db.prepare("SELECT * FROM skills WHERE enabled = 1 ORDER BY name ASC").all();
    res.json({ success: true, data: skills.map(s => ({ ...s, tags: JSON.parse(s.tags || '[]') })) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// List all agents with status
app.get("/api/agents", (_, res) => {
  try {
    const allDefs = getAllAgentDefinitions();
    const agents = Object.entries(allDefs).map(([key, def]) => {
      const state = agentState[key] || { status: "online", lastActivity: new Date().toISOString(), taskCount: 0, totalCost: 0 };
      const recentTasks = db.prepare(
        "SELECT COUNT(*) as count FROM agent_tasks WHERE agent_name = ? AND created_at > datetime('now', '-24 hours')"
      ).get(key);
      return {
        id: key,
        name: def.name,
        model: def.model,
        role: def.role,
        description: def.description,
        icon: def.icon,
        color: def.color,
        status: state.status,
        lastActivity: state.lastActivity,
        taskCount: state.taskCount,
        tasksLast24h: recentTasks?.count || 0,
        totalCost: Math.round(state.totalCost * 100000) / 100000,
        isCustom: !!def.isCustom,
        ...(key === "generator" ? { callsThisHour: getGeneratorCallsThisHour(), rateLimit: GENERATOR_RATE_LIMIT } : {}),
      };
    });
    res.json({ success: true, data: agents });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Create a new custom agent
app.post("/api/agents", (req, res) => {
  try {
    const { id: rawId, name, model, role, description, icon, color, systemPrompt } = req.body;
    if (!name || !role || !systemPrompt) return res.status(400).json({ success: false, error: "name, role, and systemPrompt are required" });
    const id = (rawId || name).toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    if (AGENT_DEFINITIONS[id]) return res.status(409).json({ success: false, error: "Cannot override built-in agent" });
    const existing = db.prepare("SELECT id FROM custom_agents WHERE id = ?").get(id);
    if (existing) return res.status(409).json({ success: false, error: `Agent '${id}' already exists` });
    db.prepare(
      "INSERT INTO custom_agents (id, name, model, role, description, icon, color, system_prompt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, name, model || 'anthropic/claude-sonnet-4', role, description || role, icon || '\u{1F916}', color || '#6c5ce7', systemPrompt);
    agentState[id] = { status: "online", lastActivity: new Date().toISOString(), taskCount: 0, totalCost: 0 };
    res.json({ success: true, data: { id, name, model: model || 'anthropic/claude-sonnet-4', role, description: description || role, icon: icon || '\u{1F916}', color: color || '#6c5ce7' } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Update a custom agent
app.put("/api/agents/:id", (req, res) => {
  try {
    const agentId = req.params.id;
    if (AGENT_DEFINITIONS[agentId]) return res.status(403).json({ success: false, error: "Cannot modify built-in agents" });
    const existing = db.prepare("SELECT * FROM custom_agents WHERE id = ?").get(agentId);
    if (!existing) return res.status(404).json({ success: false, error: "Agent not found" });
    const { name, model, role, description, icon, color, systemPrompt } = req.body;
    db.prepare(
      "UPDATE custom_agents SET name=?, model=?, role=?, description=?, icon=?, color=?, system_prompt=?, updated_at=datetime('now') WHERE id=?"
    ).run(
      name || existing.name, model || existing.model, role || existing.role,
      description || existing.description, icon || existing.icon, color || existing.color,
      systemPrompt || existing.system_prompt, agentId
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Delete a custom agent
app.delete("/api/agents/:id", (req, res) => {
  try {
    const agentId = req.params.id;
    if (AGENT_DEFINITIONS[agentId]) return res.status(403).json({ success: false, error: "Cannot delete built-in agents" });
    const result = db.prepare("DELETE FROM custom_agents WHERE id = ?").run(agentId);
    if (result.changes === 0) return res.status(404).json({ success: false, error: "Agent not found" });
    delete agentState[agentId];
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Invoke a specific agent directly (built-in OR custom)
app.post("/api/agents/:name/invoke", async (req, res) => {
  try {
    const agentName = req.params.name.toLowerCase();
    const { message, sessionId } = req.body;
    if (!message) return res.status(400).json({ success: false, error: "message required" });
    const allDefs = getAllAgentDefinitions();
    if (!allDefs[agentName]) return res.status(404).json({ success: false, error: `Unknown agent: ${agentName}` });

    const result = await invokeAgent(agentName, message, sessionId);
    res.json({ success: true, data: result });
  } catch (e) {
    console.error(`[Agent] ${req.params.name} error:`, e.message);
    res.status(500).json({ success: false, error: friendlyError(e, req.params.name) });
  }
});

// Task history
app.get("/api/agent-tasks", (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const agent = req.query.agent;
    let query = "SELECT * FROM agent_tasks";
    const params = [];
    if (agent) {
      query += " WHERE agent_name = ?";
      params.push(agent.toLowerCase());
    }
    query += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);
    const tasks = db.prepare(query).all(...params);
    res.json({ success: true, data: tasks });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Task history stats
app.get("/api/agent-tasks/stats", (_, res) => {
  try {
    const totalTasks = db.prepare("SELECT COUNT(*) as count FROM agent_tasks").get();
    const completedTasks = db.prepare("SELECT COUNT(*) as count FROM agent_tasks WHERE status = 'completed'").get();
    const failedTasks = db.prepare("SELECT COUNT(*) as count FROM agent_tasks WHERE status = 'failed'").get();
    const totalCost = db.prepare("SELECT COALESCE(SUM(cost_estimate), 0) as total FROM agent_tasks").get();
    const byAgent = db.prepare(
      "SELECT agent_name, COUNT(*) as count, COALESCE(SUM(cost_estimate), 0) as cost FROM agent_tasks GROUP BY agent_name"
    ).all();
    res.json({
      success: true,
      data: {
        total: totalTasks.count,
        completed: completedTasks.count,
        failed: failedTasks.count,
        totalCost: Math.round(totalCost.total * 100000) / 100000,
        byAgent,
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ── Chat (v6 — with agent routing + memory + multi-step + error recovery) ───
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

    // v6: Check for @agent mention
    const { agentName, cleanMessage } = parseAgentMention(userContent);
    let reply = "";
    let generatedFile = null;
    let planProgress = null;
    let respondingAgent = null;

    if (agentName) {
      // Direct agent invocation via @mention
      const allDefs = getAllAgentDefinitions();
      try {
        const agentResult = await invokeAgent(agentName, cleanMessage, sid);
        reply = agentResult.text;
        respondingAgent = { name: allDefs[agentName].name, icon: allDefs[agentName].icon, id: agentName };

        // Check if Rex delegated to other agents
        if (agentName === "rex") {
          const delegations = parseDelegations(reply);
          if (delegations.length > 0) {
            let delegationResults = [];
            for (const d of delegations) {
              try {
                const dResult = await invokeAgent(d.agent, d.task, sid);
                delegationResults.push(`**${allDefs[d.agent].name}** ${allDefs[d.agent].icon}: ${dResult.text}`);
              } catch (err) {
                delegationResults.push(`**${allDefs[d.agent].name}**: Error — ${err.message}`);
              }
            }
            // Clean delegation markers from Rex's reply
            reply = reply.replace(/DELEGATE:\w+:.+/gi, "").trim();
            if (delegationResults.length > 0) {
              reply += "\n\n---\n" + delegationResults.join("\n\n");
            }
          }
        }
      } catch (err) {
        reply = `${allDefs[agentName].name} ran into an issue: ${friendlyError(err, allDefs[agentName].name)}`;
        respondingAgent = { name: allDefs[agentName].name, icon: allDefs[agentName].icon, id: agentName };
      }
    } else {
      // No agent mentioned — use existing MindMappr flow (tool execution)
      // But first, check if Rex should route this
      const isAgentQuestion = /\b(agent|rex|watcher|scheduler|processor|generator|status|brief|monitor|delegate)\b/i.test(userContent);

      if (isAgentQuestion) {
        // Route through Rex
        const allDefs = getAllAgentDefinitions();
        try {
          const rexResult = await invokeAgent("rex", userContent, sid);
          reply = rexResult.text;
          respondingAgent = { name: "Rex", icon: "🧠", id: "rex" };

          // Handle delegations
          const delegations = parseDelegations(reply);
          if (delegations.length > 0) {
            let delegationResults = [];
            for (const d of delegations) {
              try {
                const dResult = await invokeAgent(d.agent, d.task, sid);
                delegationResults.push(`**${allDefs[d.agent].name}** ${allDefs[d.agent].icon}: ${dResult.text}`);
              } catch (err) {
                delegationResults.push(`**${allDefs[d.agent].name}**: Error — ${err.message}`);
              }
            }
            reply = reply.replace(/DELEGATE:\w+:.+/gi, "").trim();
            if (delegationResults.length > 0) {
              reply += "\n\n---\n" + delegationResults.join("\n\n");
            }
          }
        } catch (err) {
          reply = `Rex ran into an issue: ${friendlyError(err, "Rex")}`;
          respondingAgent = { name: "Rex", icon: "🧠", id: "rex" };
        }
      } else {
        // Standard MindMappr tool execution flow (v5 behavior preserved)
        const memoryCtx = getMemoryContext();
        const systemWithMemory = SYSTEM_PROMPT + (memoryCtx ? `\n\n[MEMORY — What you know about this user and their projects]\n${memoryCtx}` : "");

        const msgs = [{ role: "system", content: systemWithMemory }, ...history.slice(-30), { role: "user", content: userContent }];
        reply = await callLLM(msgs, model);

        // Handle retry failure from callLLM
        if (reply && typeof reply === "object" && reply.success === false) {
          return res.json({ success: true, data: { reply: reply.error, sessionId: sid, generatedFile: null } });
        }

        // v5: Check for multi-step task plan first
        const plan = parseTaskPlan(reply);
        if (plan && plan.length > 1) {
          const planResult = await executeTaskPlan(plan);
          if (planResult.success && planResult.files.length > 0) {
            const lastFile = planResult.files[planResult.files.length - 1];
            generatedFile = { name: lastFile.name, type: lastFile.type, message: lastFile.message };
            planProgress = { steps: plan.map((s, i) => ({ step: s.step || i + 1, description: s.description, status: "done" })) };
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
      }
    }

    history.push({ role: "user", content: userContent }, { role: "assistant", content: reply });
    if (history.length > 60) history.splice(0, history.length - 60);
    writeFileSync(hf, JSON.stringify(history));

    // v5: Store memory
    storeMemoryFromConversation(sid, userContent, reply);

    // Analytics
    const analytics = loadData("analytics");
    analytics.push({ ts: Date.now(), type: "chat", sessionId: sid, agent: respondingAgent?.id || null });
    saveData("analytics", analytics.slice(-10000));

    const responseData = { reply, sessionId: sid, generatedFile };
    if (planProgress) responseData.planProgress = planProgress;
    if (respondingAgent) responseData.respondingAgent = respondingAgent;

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
// ── Connections tab (v8 — SQLite-backed, wired to Rex tools) ─────────────
// ══════════════════════════════════════════════════════════════════════════════
const CONNECTORS = {
  google:           { name: "Google Workspace",icon: "🔗", color: "#4285F4", description: "One-click connect for Gmail, Drive, Docs, Sheets & Calendar", keyBased: false, oauthUrl: "/api/google/auth" },
  github:           { name: "GitHub",          icon: "🐙", color: "#24292E", description: "Repos, issues, deployments — Rex uses this for GitHub tools", keyBased: true },
  digitalocean:     { name: "DigitalOcean",    icon: "🌊", color: "#0080FF", description: "Droplets, apps, deployments — Rex uses this for DO tools", keyBased: true },
  discord:          { name: "Discord",         icon: "🎮", color: "#5865F2", description: "MindMappr Bot — all agents accessible via Discord", keyBased: true },
  telegram:         { name: "Telegram",        icon: "✈️", color: "#0088cc", description: "MindMappr Bot — chat with Rex via @googlieeyes_bot", keyBased: true },
  stripe:           { name: "Stripe",          icon: "💳", color: "#635BFF", description: "Payments, customers, subscriptions",   keyBased: true },
  openrouter:       { name: "OpenRouter",      icon: "🧠", color: "#6366f1", description: "LLM gateway — Rex uses this for AI tool calls",       keyBased: true },
  slack:            { name: "Slack",           icon: "💬", color: "#4A154B", description: "Send messages, manage channels",       keyBased: true },
  brave_search:     { name: "Brave Search",    icon: "🔍", color: "#FB542B", description: "Web search API for real-time information", keyBased: true },
  notion:           { name: "Notion",          icon: "📝", color: "#000000", description: "Pages, databases, blocks",            keyBased: true },
  meta_ads:         { name: "Meta Ads",        icon: "📢", color: "#1877F2", description: "Manage Facebook & Instagram ads",      keyBased: true },
  canva:            { name: "Canva",           icon: "🎨", color: "#00C4CC", description: "Create and export designs",           keyBased: true },
  airtable:         { name: "Airtable",        icon: "🗃️", color: "#18BFFF", description: "Bases, tables, records",              keyBased: true },
  zapier:           { name: "Zapier",          icon: "⚡", color: "#FF4A00", description: "Trigger Zaps via webhooks",           keyBased: true },
};

// Debug endpoint to check raw DB state
app.get("/api/connections/debug", (req, res) => {
  // Use the same cookie-based session check as requireAuth
  const cookies = req.cookies || {};
  if (!isValidSession(cookies.mm_session)) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const rows = db.prepare("SELECT id, service_name, length(token) as token_len, account_name, connected_at FROM connections").all();
    const envCheck = {
      GITHUB_PAT: !!(process.env.GITHUB_PAT),
      GITHUB_TOKEN: !!(process.env.GITHUB_TOKEN),
      DO_API_TOKEN: !!(process.env.DO_API_TOKEN),
      LLM_API_KEY: !!(process.env.LLM_API_KEY),
      OPENROUTER_API_KEY: !!(process.env.OPENROUTER_API_KEY),
      TELEGRAM_BOT_TOKEN: !!(process.env.TELEGRAM_BOT_TOKEN),
      GOOGLE_CLIENT_ID: !!(process.env.GOOGLE_CLIENT_ID),
      GOOGLE_CLIENT_SECRET: !!(process.env.GOOGLE_CLIENT_SECRET),
    };
    res.json({ success: true, rows, envCheck });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/connections/list", (_, res) => {
  try {
    const storedRows = db.prepare("SELECT * FROM connections").all();
    const stored = {};
    for (const row of storedRows) {
      stored[row.id] = { token: row.token, accountName: row.account_name, connectedAt: row.connected_at };
    }
    const result = Object.entries(CONNECTORS).map(([id, info]) => ({
      id, ...info,
      connected: !!(stored[id]?.token),
      connectedAt: stored[id]?.connectedAt || null,
      accountName: stored[id]?.accountName || null,
      oauthUrl: info.oauthUrl || null
    }));
    res.json({ success: true, data: result });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/api/connections/connect", async (req, res) => {
  try {
    const { id, token, accountName } = req.body;
    if (!id || !token) return res.status(400).json({ success: false, error: "id and token required" });
    const serviceName = CONNECTORS[id]?.name || id;

    // Validate the token before saving
    let resolvedName = accountName || id;
    try {
      if (id === "github") {
        const r = await fetch("https://api.github.com/user", {
          headers: { "Authorization": `Bearer ${token}`, "Accept": "application/vnd.github+json" },
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) return res.status(400).json({ success: false, error: `GitHub token invalid (${r.status}). Check your PAT.` });
        const u = await r.json();
        resolvedName = u.login || resolvedName;
      } else if (id === "digitalocean") {
        const r = await fetch("https://api.digitalocean.com/v2/account", {
          headers: { "Authorization": `Bearer ${token}` },
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) return res.status(400).json({ success: false, error: `DigitalOcean token invalid (${r.status}). Check your API token.` });
        const u = await r.json();
        resolvedName = u.account?.email || resolvedName;
      } else if (id === "openrouter") {
        const r = await fetch("https://openrouter.ai/api/v1/auth/key", {
          headers: { "Authorization": `Bearer ${token}` },
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) return res.status(400).json({ success: false, error: `OpenRouter key invalid (${r.status}). Check your API key at openrouter.ai/keys.` });
        const u = await r.json();
        resolvedName = u.data?.label || u.data?.name || resolvedName;
      } else if (id === "telegram") {
        const r = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return res.status(400).json({ success: false, error: `Telegram bot token invalid (${r.status}).` });
        const u = await r.json();
        if (!u.ok) return res.status(400).json({ success: false, error: `Telegram bot token invalid: ${u.description}` });
        resolvedName = u.result?.username ? `@${u.result.username}` : resolvedName;
      } else if (id === "discord") {
        // Validate Discord bot token by checking the gateway
        const r = await fetch("https://discord.com/api/v10/users/@me", {
          headers: { "Authorization": `Bot ${token}` },
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) return res.status(400).json({ success: false, error: `Discord bot token invalid (${r.status}). Create a bot at discord.com/developers.` });
        const u = await r.json();
        resolvedName = u.username ? `${u.username}#${u.discriminator || '0'}` : resolvedName;
        // Start the Discord bot after successful validation
        try {
          await startDiscordBot(token);
          console.log(`[Discord] Bot started after connection: ${resolvedName}`);
        } catch (discordErr) {
          console.error(`[Discord] Bot start failed after connection: ${discordErr.message}`);
        }
      }
    } catch (validationErr) {
      if (validationErr.name === "TimeoutError" || validationErr.name === "AbortError") {
        console.warn(`[Connections] Validation timeout for ${id} — saving anyway`);
      } else if (validationErr.message?.includes("invalid")) {
        return res.status(400).json({ success: false, error: validationErr.message });
      }
      // For other errors (network issues), save anyway
    }

    db.prepare(
      "INSERT OR REPLACE INTO connections (id, service_name, token, account_name, connected_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))"
    ).run(id, serviceName, token, resolvedName);
    console.log(`[Connections] ${id} connected as ${resolvedName}`);
    res.json({ success: true, data: { id, connected: true, accountName: resolvedName } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/api/connections/disconnect", (req, res) => {
  try {
    const { id } = req.body;
    db.prepare("DELETE FROM connections WHERE id = ?").run(id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
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

      // v6: If task has an assigned agent, route to that agent
      const allDefs = getAllAgentDefinitions();
      if (task.assigned_agent && allDefs[task.assigned_agent]) {
        const agentMessage = config.message || `Execute scheduled task: ${task.name}`;
        await invokeAgent(task.assigned_agent, agentMessage);
      } else if (task.task_type === "tool") {
        await executeTool(config.tool, config.params || {});
      } else if (task.task_type === "chat") {
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
    const { name, cron_expression, task_type, task_config, assigned_agent } = req.body;
    if (!name || !cron_expression || !task_type || !task_config) {
      return res.status(400).json({ success: false, error: "name, cron_expression, task_type, and task_config are required" });
    }
    if (!cron.validate(cron_expression)) {
      return res.status(400).json({ success: false, error: "Invalid cron expression. Use format like '0 9 * * *' (every day at 9am)." });
    }
    const configStr = typeof task_config === "string" ? task_config : JSON.stringify(task_config);
    const allDefs = getAllAgentDefinitions();
    const agentStr = assigned_agent && allDefs[assigned_agent] ? assigned_agent : null;
    const result = db.prepare("INSERT INTO scheduled_tasks (name, cron_expression, task_type, task_config, assigned_agent) VALUES (?, ?, ?, ?, ?)").run(name, cron_expression, task_type, configStr, agentStr);
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
// ── GitHub Deploy — PR listing & merging ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || ""; // Set GITHUB_TOKEN env var in your deployment platform

async function ghFetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.headers || {}),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body?.message || `GitHub API returned ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

// List open PRs for a repo
app.get("/api/github/prs", async (req, res) => {
  try {
    const repo = req.query.repo;
    if (!repo || !repo.includes("/")) {
      return res.status(400).json({ success: false, error: "Missing or invalid 'repo' query param (expected OWNER/REPO)" });
    }
    const prs = await withRetry(
      () => ghFetch(`https://api.github.com/repos/${repo}/pulls?state=open&sort=created&direction=desc&per_page=50`),
      { label: "GitHub PR list" }
    );
    if (prs && prs.error) return res.status(502).json({ success: false, error: prs.error });
    const data = (prs || []).map(pr => ({
      number: pr.number,
      title: pr.title,
      branch: pr.head?.ref || "",
      createdAt: pr.created_at,
      user: pr.user?.login || "",
      url: pr.html_url,
      mergeable: pr.mergeable,
    }));
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Merge a specific PR
app.post("/api/github/merge-pr", async (req, res) => {
  try {
    const { repo, prNumber } = req.body;
    if (!repo || !prNumber) {
      return res.status(400).json({ success: false, error: "Missing 'repo' or 'prNumber' in request body" });
    }
    const result = await withRetry(
      () => ghFetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/merge`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merge_method: "merge" }),
      }),
      { label: "GitHub PR merge" }
    );
    if (result && result.error) return res.status(502).json({ success: false, error: result.error });
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ── Activity Window API ───────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
app.get("/api/activity", (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const agentId = req.query.agent;
    let query = "SELECT * FROM agent_activity";
    const params = [];
    if (agentId) {
      query += " WHERE agent_id = ?";
      params.push(agentId);
    }
    query += " ORDER BY started_at DESC LIMIT ?";
    params.push(limit);
    const activities = db.prepare(query).all(...params);
    res.json({ success: true, data: activities });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/api/activity/live", (_, res) => {
  try {
    // Get the most recent activity for each agent (virtual office view)
    const allDefs = getAllAgentDefinitions();
    const liveStatus = Object.entries(allDefs).map(([id, def]) => {
      const latest = db.prepare(
        "SELECT * FROM agent_activity WHERE agent_id = ? ORDER BY started_at DESC LIMIT 1"
      ).get(id);
      const state = agentState[id] || { status: "online", lastActivity: new Date().toISOString(), taskCount: 0, totalCost: 0 };
      return {
        agentId: id,
        agentName: def.name,
        icon: def.icon,
        color: def.color,
        status: state.status,
        currentActivity: latest?.description || "Standing by",
        activityType: latest?.activity_type || "idle",
        lastSeen: latest?.started_at || state.lastActivity,
        taskCount: state.taskCount,
      };
    });
    res.json({ success: true, data: liveStatus });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete("/api/activity", (_, res) => {
  try {
    db.prepare("DELETE FROM agent_activity WHERE started_at < datetime('now', '-7 days')").run();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// ── Rex Tools API ─────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
app.get("/api/tools", (_, res) => {
  try {
    const tools = Object.entries(TOOL_REGISTRY).map(([name, info]) => ({
      name,
      description: info.description,
      category: info.category,
      params: info.params,
      example: info.example,
    }));
    // Include extra tools (document & Google)
    const extraTools = Object.entries(EXTRA_TOOLS).map(([name, info]) => ({
      name,
      description: info.description,
      category: info.category,
      params: info.params,
      example: info.example,
    }));
    res.json({ success: true, data: [...tools, ...extraTools] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/api/tools/execute", async (req, res) => {
  try {
    const { tool, args } = req.body;
    if (!tool) return res.status(400).json({ success: false, error: "tool name required" });
    // Check if it's an extra tool (handled by server.mjs executeTool)
    if (EXTRA_TOOLS[tool]) {
      logActivity("rex", "Rex", "tool_use", `Manual execution: ${tool}`);
      const params = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
      const result = await executeTool(tool, params);
      logActivity("rex", "Rex", "tool_result", `${tool}: completed`);
      return res.json({ success: true, data: result });
    }
    if (!TOOL_REGISTRY[tool]) return res.status(404).json({ success: false, error: `Unknown tool: ${tool}` });
    logActivity("rex", "Rex", "tool_use", `Manual execution: ${tool}`);
    // args can be an array (positional) or object (named) — normalize to array
    const argsArray = Array.isArray(args) ? args : (args && typeof args === 'object' ? Object.values(args) : []);  
    const result = await executeRexTool(tool, argsArray);
    logActivity("rex", "Rex", "tool_result", `${tool}: completed`);
    res.json({ success: true, data: result });
  } catch (e) {
    logActivity("rex", "Rex", "tool_error", `${req.body.tool}: ${e.message.slice(0, 100)}`);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ── Serve frontend SPA ────────────────────────────────────────────────────
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
  console.log(`MindMappr Agent v8.5 \u2014 Command Center + Content Studio + Activity Window + Rex Tools + Legal + Stripe running on port ${PORT}`);
  console.log(`Agents online: ${Object.values(getAllAgentDefinitions()).map(a => a.name).join(", ")}`);
  loadAndStartSchedules();
  // Set up Telegram webhook after a short delay to ensure server is ready
  setTimeout(setupTelegramWebhook, 5000);

  // Initialize and start Discord bot
  initDiscord({ invokeAgent: invokeAgent, getAllAgentDefinitions: getAllAgentDefinitions, logActivity: logActivity, getConnectionToken: getConnectionToken });
  const discordToken = DISCORD_BOT_TOKEN || getConnectionToken("discord");
  if (discordToken) {
    setTimeout(() => {
      startDiscordBot(discordToken).then(client => {
        if (client) console.log("[Discord] Bot started successfully");
      }).catch(err => console.error("[Discord] Bot start error:", err.message));
    }, 3000);
  } else {
    console.log("[Discord] No bot token configured — add one in Connections tab or set DISCORD_BOT_TOKEN env var");
  }
});
