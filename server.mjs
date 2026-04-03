import express from "express";
import cors from "cors";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, readFileSync, writeFileSync } from "fs";
import { join, dirname, extname, basename } from "path";
import { fileURLToPath } from "url";
import { randomUUID, createHash } from "crypto";
import { exec } from "child_process";
import { promisify } from "util";
import Database from "better-sqlite3";
import cron from "node-cron";
import { initRexTools, executeTool as executeRexTool, parseToolCalls, getToolListForPrompt, TOOL_REGISTRY } from "./rex-tools.mjs";

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

// Initialize Rex tools with DB and token getter
initRexTools(db, getConnectionToken);

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

    // ── Rex Tool-Use Loop ──────────────────────────────────────────────
    if (agentName === "rex") {
      const toolCalls = parseToolCalls(finalText);
      if (toolCalls.length > 0) {
        logActivity(agentName, agent.name, "tool_use", `Executing ${toolCalls.length} tool(s): ${toolCalls.map(t => t.tool).join(", ")}`);

        const toolResults = [];
        for (const tc of toolCalls) {
          try {
            const toolResult = await executeRexTool(tc.tool, tc.args);
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

// URL rewrite — normalize /mindmappr/api/* to /api/* BEFORE auth check
app.use((req, _res, next) => {
  if (req.url.startsWith("/mindmappr/api/") || req.url.startsWith("/mindmappr/api?")) {
    req.url = req.url.replace("/mindmappr", "");
  }
  next();
});

// Auth middleware — protect everything except login and health
app.use((req, res, next) => {
  if (req.path === "/api/auth/login" || req.path === "/api/health") return next();
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
app.get("/api/health", (_, res) => res.json({
  status: "ok",
  service: "MindMappr Agent v8 — Command Center + Content Studio + Activity Window + Rex Tools",
  version: "8.0.0",
  features: ["multi_step_planner", "long_term_memory", "error_recovery", "cron_scheduler", "agent_system", "task_history", "content_studio", "ai_content_composer", "algorithm_scorer", "brain_dump", "content_repurposer", "content_coach", "account_researcher", "activity_window", "rex_tool_use", "sqlite_connections"],
  agents: Object.keys(getAllAgentDefinitions()),
  ts: new Date().toISOString(),
  tools: ["elevenlabs_tts", "generate_image", "create_video", "create_pdf", "run_python", "web_scrape", "create_csv", "create_html", "send_slack"],
  rexTools: Object.keys(TOOL_REGISTRY)
}));

// ══════════════════════════════════════════════════════════════════════════════
// ── v6: Agent API Endpoints ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

// Get Rex skills registry
app.get("/api/agents/rex/skills", (req, res) => {
  try {
    const skillsPath = path.join(process.cwd(), "..", "openaudrey", "core", "skills", "rex-skills-registry.json");
    if (fs.existsSync(skillsPath)) {
      const skills = JSON.parse(fs.readFileSync(skillsPath, "utf8"));
      res.json({ success: true, data: skills });
    } else {
      res.status(404).json({ success: false, error: "Skills registry not found" });
    }
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
  slack:            { name: "Slack",           icon: "💬", color: "#4A154B", description: "Send messages, manage channels",       keyBased: true },
  google_calendar:  { name: "Google Calendar", icon: "📅", color: "#4285F4", description: "Read and create calendar events",      keyBased: false },
  gmail:            { name: "Gmail",           icon: "📧", color: "#EA4335", description: "Send and read emails",                 keyBased: false },
  meta_ads:         { name: "Meta Ads",        icon: "📢", color: "#1877F2", description: "Manage Facebook & Instagram ads",      keyBased: false },
  stripe:           { name: "Stripe",          icon: "💳", color: "#635BFF", description: "Payments, customers, subscriptions",   keyBased: true },
  canva:            { name: "Canva",           icon: "🎨", color: "#00C4CC", description: "Create and export designs",           keyBased: false },
  github:           { name: "GitHub",          icon: "🐙", color: "#24292E", description: "Repos, issues, deployments — Rex uses this for GitHub tools", keyBased: true },
  notion:           { name: "Notion",          icon: "📝", color: "#000000", description: "Pages, databases, blocks",            keyBased: true },
  airtable:         { name: "Airtable",        icon: "🗃️", color: "#18BFFF", description: "Bases, tables, records",              keyBased: true },
  zapier:           { name: "Zapier",          icon: "⚡", color: "#FF4A00", description: "Trigger Zaps via webhooks",           keyBased: true },
  digitalocean:     { name: "DigitalOcean",    icon: "🌊", color: "#0080FF", description: "Droplets, apps, deployments — Rex uses this for DO tools", keyBased: true },
  openrouter:       { name: "OpenRouter",      icon: "🧠", color: "#6366f1", description: "LLM gateway — Rex uses this for AI tool calls",       keyBased: true },
};

app.get("/api/connections/list", (_, res) => {
  try {
    const storedRows = db.prepare("SELECT * FROM connections").all();
    const stored = {};
    for (const row of storedRows) {
      stored[row.id] = { token: row.token, accountName: row.account_name, connectedAt: row.connected_at };
    }
    const result = Object.entries(CONNECTORS).map(([id, info]) => ({
      id, ...info,
      connected: !!stored[id],
      connectedAt: stored[id]?.connectedAt || null,
      accountName: stored[id]?.accountName || null
    }));
    res.json({ success: true, data: result });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/api/connections/connect", (req, res) => {
  try {
    const { id, token, accountName } = req.body;
    if (!id || !token) return res.status(400).json({ success: false, error: "id and token required" });
    const serviceName = CONNECTORS[id]?.name || id;
    db.prepare(
      "INSERT OR REPLACE INTO connections (id, service_name, token, account_name, connected_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))"
    ).run(id, serviceName, token, accountName || id);
    res.json({ success: true, data: { id, connected: true, accountName: accountName || id } });
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
    res.json({ success: true, data: tools });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/api/tools/execute", async (req, res) => {
  try {
    const { tool, args } = req.body;
    if (!tool) return res.status(400).json({ success: false, error: "tool name required" });
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
  console.log(`MindMappr Agent v8 \u2014 Command Center + Content Studio + Activity Window + Rex Tools running on port ${PORT}`);
  console.log(`Agents online: ${Object.values(getAllAgentDefinitions()).map(a => a.name).join(", ")}`);
  loadAndStartSchedules();
});
