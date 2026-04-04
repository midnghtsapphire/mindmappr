#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════
// ── MindMappr Pre-Deploy Smoke Test ─────────────────────────────────────────
// ── Verifies server starts, all endpoints respond, and build is clean ────────
// ══════════════════════════════════════════════════════════════════════════════

import { spawn, execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = 13005; // Use a non-conflicting port for testing
const BASE_URL = `http://localhost:${PORT}`;

// ── Notification helpers ────────────────────────────────────────────────────
async function sendTelegramNotification(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "Markdown" }),
    });
  } catch (e) {
    console.warn("[Notify] Telegram notification failed:", e.message);
  }
}

async function sendDiscordWebhook(message) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }),
    });
  } catch (e) {
    console.warn("[Notify] Discord webhook notification failed:", e.message);
  }
}

async function notify(message) {
  await Promise.allSettled([
    sendTelegramNotification(message),
    sendDiscordWebhook(message),
  ]);
}

// ── Test runner ─────────────────────────────────────────────────────────────
const results = [];
let serverProcess = null;

function log(icon, msg) {
  console.log(`${icon} ${msg}`);
}

function pass(name, detail = "") {
  results.push({ name, status: "PASS", detail });
  log("✅", `PASS: ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name, detail = "") {
  results.push({ name, status: "FAIL", detail });
  log("❌", `FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
}

function skip(name, detail = "") {
  results.push({ name, status: "SKIP", detail });
  log("⏭️", `SKIP: ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── Test 1: Check required files exist ──────────────────────────────────────
function testRequiredFiles() {
  const requiredFiles = [
    "server.mjs",
    "package.json",
    "skills-catalog.json",
    "rex-tools.mjs",
    "discord-connector.mjs",
  ];
  let allExist = true;
  for (const f of requiredFiles) {
    if (!existsSync(join(ROOT, f))) {
      fail(`Required file: ${f}`, "File not found");
      allExist = false;
    }
  }
  if (allExist) pass("Required files exist", requiredFiles.join(", "));
}

// ── Test 2: Check package.json is valid ─────────────────────────────────────
function testPackageJson() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    if (!pkg.dependencies) { fail("package.json", "No dependencies"); return; }
    const required = ["express", "better-sqlite3", "cors", "discord.js"];
    const missing = required.filter(d => !pkg.dependencies[d]);
    if (missing.length > 0) {
      fail("package.json dependencies", `Missing: ${missing.join(", ")}`);
    } else {
      pass("package.json valid", `v${pkg.version}, ${Object.keys(pkg.dependencies).length} deps`);
    }
  } catch (e) {
    fail("package.json", e.message);
  }
}

// ── Test 3: Check skills catalog loads ──────────────────────────────────────
function testSkillsCatalog() {
  try {
    const catalog = JSON.parse(readFileSync(join(ROOT, "skills-catalog.json"), "utf8"));
    if (!Array.isArray(catalog)) { fail("Skills catalog", "Not an array"); return; }
    const openclawCount = catalog.filter(s => s.source === "openclaw-skills-hub").length;
    const customCount = catalog.filter(s => s.source !== "openclaw-skills-hub").length;
    pass("Skills catalog", `${catalog.length} total (${customCount} custom + ${openclawCount} openclaw)`);
  } catch (e) {
    fail("Skills catalog", e.message);
  }
}

// ── Test 4: Check node_modules exist ────────────────────────────────────────
function testNodeModules() {
  if (existsSync(join(ROOT, "node_modules"))) {
    pass("node_modules installed");
  } else {
    skip("node_modules", "Not installed — run npm install first");
  }
}

// ── Test 5: Syntax check server.mjs ─────────────────────────────────────────
function testSyntaxCheck() {
  try {
    execSync(`node --check ${join(ROOT, "server.mjs")}`, { timeout: 10000, stdio: "pipe" });
    pass("server.mjs syntax check");
  } catch (e) {
    fail("server.mjs syntax check", e.stderr?.toString()?.slice(0, 200) || e.message);
  }
}

// ── Test 6: Start server and check it boots ─────────────────────────────────
function startServer() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: String(PORT),
      LLM_API_KEY: process.env.LLM_API_KEY || "test-key",
      NODE_ENV: "test",
    };

    serverProcess = spawn("node", ["server.mjs"], {
      cwd: ROOT,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let started = false;

    serverProcess.stdout.on("data", (data) => {
      stdout += data.toString();
      if (!started && stdout.includes("running on port")) {
        started = true;
        resolve(true);
      }
    });

    serverProcess.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    serverProcess.on("error", (err) => {
      if (!started) reject(new Error(`Server failed to start: ${err.message}`));
    });

    serverProcess.on("exit", (code) => {
      if (!started) reject(new Error(`Server exited with code ${code}. stderr: ${stderr.slice(0, 300)}`));
    });

    // Timeout after 15 seconds
    setTimeout(() => {
      if (!started) reject(new Error(`Server did not start within 15s. stdout: ${stdout.slice(0, 300)}, stderr: ${stderr.slice(0, 300)}`));
    }, 15000);
  });
}

// ── Test 7: Check API endpoints ─────────────────────────────────────────────
async function testEndpoint(name, path, checks = {}) {
  try {
    const res = await fetch(`${BASE_URL}${path}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      fail(name, `HTTP ${res.status}`);
      return;
    }
    const body = await res.json();
    if (checks.hasSuccess && !body.success) {
      fail(name, "success: false in response");
      return;
    }
    if (checks.hasData && !body.data && !body.status) {
      fail(name, "No data in response");
      return;
    }
    if (checks.minItems && (!Array.isArray(body.data) || body.data.length < checks.minItems)) {
      fail(name, `Expected at least ${checks.minItems} items, got ${body.data?.length || 0}`);
      return;
    }
    let detail = `HTTP ${res.status}`;
    if (body.status) detail += `, status: ${body.status}`;
    if (body.total) detail += `, total: ${body.total}`;
    if (Array.isArray(body.data)) detail += `, items: ${body.data.length}`;
    pass(name, detail);
  } catch (e) {
    fail(name, e.message);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  MindMappr Pre-Deploy Smoke Test");
  console.log("═══════════════════════════════════════════════════════════\n");

  // Static checks
  testRequiredFiles();
  testPackageJson();
  testSkillsCatalog();
  testNodeModules();

  // Syntax check (doesn't need node_modules for basic parse)
  // Only run if node_modules exist (imports will fail otherwise)
  if (existsSync(join(ROOT, "node_modules"))) {
    testSyntaxCheck();
  } else {
    skip("Syntax check", "Skipped — node_modules not installed");
  }

  // Server boot + endpoint checks (only if node_modules exist)
  if (existsSync(join(ROOT, "node_modules"))) {
    console.log("\n── Starting server for endpoint tests... ──\n");
    try {
      await startServer();
      pass("Server starts without crashing");

      // Wait a moment for DB init
      await new Promise(r => setTimeout(r, 2000));

      // Test all endpoints
      await testEndpoint("GET /api/health", "/api/health", { hasData: true });
      await testEndpoint("GET /api/agents", "/api/agents", { hasSuccess: true, hasData: true, minItems: 1 });
      await testEndpoint("GET /api/connections/list", "/api/connections/list", { hasSuccess: true, hasData: true });
      await testEndpoint("GET /api/skills", "/api/skills", { hasSuccess: true, hasData: true });
      await testEndpoint("GET /api/skills (openclaw)", "/api/skills?source=openclaw-skills-hub&limit=5", { hasSuccess: true, hasData: true });
      await testEndpoint("GET /api/agents/rex/skills", "/api/agents/rex/skills", { hasSuccess: true, hasData: true });
      await testEndpoint("GET /api/chat/sessions", "/api/chat/sessions", { hasSuccess: true });
      await testEndpoint("GET /api/tools", "/api/tools", { hasSuccess: true, hasData: true });
      await testEndpoint("GET /api/files/list", "/api/files/list", { hasSuccess: true });
      await testEndpoint("GET /api/activity/live", "/api/activity/live", { hasSuccess: true, hasData: true });
      await testEndpoint("GET /api/agent/apis/list", "/api/agent/apis/list", { hasSuccess: true });
      await testEndpoint("GET /api/agent/apis/models", "/api/agent/apis/models", { hasSuccess: true, hasData: true });

    } catch (e) {
      fail("Server starts without crashing", e.message);
    } finally {
      if (serverProcess) {
        serverProcess.kill("SIGTERM");
        await new Promise(r => setTimeout(r, 1000));
        try { serverProcess.kill("SIGKILL"); } catch {}
      }
    }
  } else {
    skip("Server boot test", "Skipped — node_modules not installed");
    skip("Endpoint tests", "Skipped — server not started");
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  RESULTS SUMMARY");
  console.log("═══════════════════════════════════════════════════════════\n");

  const passed = results.filter(r => r.status === "PASS").length;
  const failed = results.filter(r => r.status === "FAIL").length;
  const skipped = results.filter(r => r.status === "SKIP").length;

  console.log(`  Passed:  ${passed}`);
  console.log(`  Failed:  ${failed}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Total:   ${results.length}`);
  console.log("");

  const allPassed = failed === 0;
  const emoji = allPassed ? "✅" : "❌";
  const status = allPassed ? "PASSED" : "FAILED";

  console.log(`  ${emoji} Overall: ${status}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // Send notification
  const commitSha = process.env.GITHUB_SHA?.slice(0, 7) || "local";
  const branch = process.env.GITHUB_REF_NAME || "local";
  const notifyMsg = `${emoji} *MindMappr Deploy ${status}*\n\nBranch: \`${branch}\`\nCommit: \`${commitSha}\`\nPassed: ${passed}/${results.length}\nFailed: ${failed}\nSkipped: ${skipped}${failed > 0 ? "\n\nFailed tests:\n" + results.filter(r => r.status === "FAIL").map(r => `• ${r.name}: ${r.detail}`).join("\n") : ""}`;

  await notify(notifyMsg);

  // Exit with appropriate code
  process.exit(allPassed ? 0 : 1);
}

main().catch((e) => {
  console.error("Smoke test crashed:", e);
  process.exit(1);
});
