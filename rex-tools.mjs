// ══════════════════════════════════════════════════════════════════════════════
// ── Rex Tool-Use System — 21 real tool functions for GitHub, DO, OpenRouter ──
// ══════════════════════════════════════════════════════════════════════════════
// Each tool checks SQLite connections table first, falls back to env vars.

let _getConnectionToken = null;
let _db = null;

/**
 * Initialize rex-tools with the database and connection token getter.
 * Called once from server.mjs after DB is ready.
 */
export function initRexTools(db, getConnectionToken) {
  _db = db;
  _getConnectionToken = getConnectionToken;
}

function getToken(serviceId, envVar) {
  if (_getConnectionToken) {
    const t = _getConnectionToken(serviceId);
    if (t) return t;
  }
  return process.env[envVar] || "";
}

// ══════════════════════════════════════════════════════════════════════════════
// ── GitHub Tools ────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

async function ghFetch(url, opts = {}) {
  const token = getToken("github", "GITHUB_PAT");
  if (!token) throw new Error("GitHub not connected. Add your GitHub token in the Connections tab or set GITHUB_PAT env var.");
  const res = await fetch(url, {
    ...opts,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
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

export async function github_create_repo(name, description = "", isPrivate = true) {
  const data = await ghFetch("https://api.github.com/user/repos", {
    method: "POST",
    body: JSON.stringify({ name, description, private: isPrivate, auto_init: true }),
  });
  return { success: true, repo: data.full_name, url: data.html_url, private: data.private };
}

export async function github_list_repos() {
  const data = await ghFetch("https://api.github.com/user/repos?sort=updated&per_page=30");
  return {
    success: true,
    repos: data.map(r => ({
      name: r.full_name,
      description: r.description,
      private: r.private,
      url: r.html_url,
      updated: r.updated_at,
      language: r.language,
    })),
  };
}

export async function github_create_pr(repo, title, head, base = "main", body = "") {
  const data = await ghFetch(`https://api.github.com/repos/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({ title, head, base, body }),
  });
  return { success: true, pr_number: data.number, url: data.html_url, title: data.title };
}

export async function github_merge_pr(repo, pr_number) {
  const data = await ghFetch(`https://api.github.com/repos/${repo}/pulls/${pr_number}/merge`, {
    method: "PUT",
    body: JSON.stringify({ merge_method: "merge" }),
  });
  return { success: true, merged: true, sha: data.sha, message: data.message };
}

export async function github_list_prs(repo, state = "open") {
  const data = await ghFetch(`https://api.github.com/repos/${repo}/pulls?state=${state}&per_page=30`);
  return {
    success: true,
    prs: data.map(pr => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      user: pr.user?.login,
      branch: pr.head?.ref,
      url: pr.html_url,
      created: pr.created_at,
    })),
  };
}

export async function github_push_file(repo, path, content, message = "Update file", branch = "main") {
  // Check if file exists first to get sha
  let sha = undefined;
  try {
    const existing = await ghFetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`);
    sha = existing.sha;
  } catch { /* file doesn't exist yet */ }

  const payload = {
    message,
    content: Buffer.from(content).toString("base64"),
    branch,
  };
  if (sha) payload.sha = sha;

  const data = await ghFetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  return { success: true, path: data.content?.path, sha: data.content?.sha, url: data.content?.html_url };
}

export async function github_get_file(repo, path, branch = null) {
  // Auto-detect default branch if not specified
  if (!branch) {
    try {
      const repoData = await ghFetch(`https://api.github.com/repos/${repo}`);
      branch = repoData.default_branch || "main";
    } catch { branch = "main"; }
  }
  let data;
  try {
    data = await ghFetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`);
  } catch (e) {
    // If branch fails, try auto-detecting
    if (e.message && e.message.includes("404")) {
      try {
        const repoData = await ghFetch(`https://api.github.com/repos/${repo}`);
        const defaultBranch = repoData.default_branch || "main";
        if (defaultBranch !== branch) {
          data = await ghFetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${defaultBranch}`);
        } else { throw e; }
      } catch { throw e; }
    } else { throw e; }
  }
  const content = data.encoding === "base64" ? Buffer.from(data.content, "base64").toString("utf8") : data.content;
  return { success: true, path: data.path, content, sha: data.sha, size: data.size, branch };
}

export async function github_trigger_copilot(repo, issue) {
  // Create an issue with a label that Copilot can pick up
  const data = await ghFetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: `[Copilot] ${issue}`,
      body: issue,
      labels: ["copilot"],
    }),
  });
  return { success: true, issue_number: data.number, url: data.html_url };
}

export async function github_list_issues(repo, state = "open") {
  const data = await ghFetch(`https://api.github.com/repos/${repo}/issues?state=${state}&per_page=30`);
  return {
    success: true,
    issues: data.filter(i => !i.pull_request).map(i => ({
      number: i.number,
      title: i.title,
      state: i.state,
      user: i.user?.login,
      labels: i.labels?.map(l => l.name),
      url: i.html_url,
      created: i.created_at,
    })),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// ── DigitalOcean Tools ──────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

async function doFetch(url, opts = {}) {
  const token = getToken("digitalocean", "DO_API_TOKEN");
  if (!token) throw new Error("DigitalOcean not connected. Add your DO token in the Connections tab or set DO_API_TOKEN env var.");
  const res = await fetch(url, {
    ...opts,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body?.message || `DO API returned ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

export async function do_list_droplets() {
  const data = await doFetch("https://api.digitalocean.com/v2/droplets?per_page=50");
  return {
    success: true,
    droplets: (data.droplets || []).map(d => ({
      id: d.id,
      name: d.name,
      status: d.status,
      ip: d.networks?.v4?.[0]?.ip_address,
      region: d.region?.slug,
      size: d.size_slug,
      created: d.created_at,
    })),
  };
}

export async function do_list_apps() {
  const data = await doFetch("https://api.digitalocean.com/v2/apps?per_page=50");
  return {
    success: true,
    apps: (data.apps || []).map(a => ({
      id: a.id,
      name: a.spec?.name || a.id,
      status: a.active_deployment?.phase || "unknown",
      url: a.live_url || a.default_ingress,
      region: a.region?.slug,
      updated: a.updated_at,
    })),
  };
}

export async function do_get_app_logs(app_id) {
  try {
    // Get active deployment first
    const app = await doFetch(`https://api.digitalocean.com/v2/apps/${app_id}`);
    const deployId = app.app?.active_deployment?.id;
    if (!deployId) return { success: true, logs: "No active deployment found." };

    // Get component name
    const compName = app.app?.spec?.services?.[0]?.name || app.app?.spec?.workers?.[0]?.name || "service";

    const logData = await doFetch(
      `https://api.digitalocean.com/v2/apps/${app_id}/deployments/${deployId}/components/${compName}/logs?type=RUN&follow=false`
    );
    return { success: true, logs: logData.historic_urls?.[0] || logData.live_url || "Logs endpoint returned no data." };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export async function do_restart_app(app_id) {
  const data = await doFetch(`https://api.digitalocean.com/v2/apps/${app_id}/deployments`, {
    method: "POST",
    body: JSON.stringify({ force_build: true }),
  });
  return {
    success: true,
    deployment_id: data.deployment?.id,
    phase: data.deployment?.phase,
    message: "App restart/redeploy triggered.",
  };
}

export async function do_get_droplet_status(droplet_id) {
  const data = await doFetch(`https://api.digitalocean.com/v2/droplets/${droplet_id}`);
  const d = data.droplet;
  return {
    success: true,
    id: d.id,
    name: d.name,
    status: d.status,
    ip: d.networks?.v4?.[0]?.ip_address,
    memory: d.memory,
    vcpus: d.vcpus,
    disk: d.disk,
    region: d.region?.slug,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// ── OpenRouter / LLM Tools ──────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

function getLLMKey() {
  // Check SQLite connections first, then fall back to env vars
  return getToken("openrouter", "LLM_API_KEY") || process.env.OPENROUTER_API_KEY || getToken("openai", "OPENAI_API_KEY") || "";
}

export async function llm_call(model = "anthropic/claude-sonnet-4", prompt = "", system = "") {
  const key = getLLMKey();
  if (!key) throw new Error("No LLM API key found. Add OpenRouter key in Connections tab or set LLM_API_KEY env var.");

  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://mind-mappr.com",
      "X-Title": "MindMappr-RexTools",
    },
    body: JSON.stringify({ model, messages, max_tokens: 2048, temperature: 0.7 }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`LLM API error (${res.status}): ${t.slice(0, 200)}`);
  }

  const data = await res.json();
  return {
    success: true,
    response: data.choices?.[0]?.message?.content || "No response.",
    model: data.model,
    tokens: (data.usage?.prompt_tokens || 0) + (data.usage?.completion_tokens || 0),
  };
}

export async function llm_code_review(code, language = "javascript") {
  return await llm_call(
    "anthropic/claude-sonnet-4",
    `Review this ${language} code for bugs, security issues, performance problems, and best practices. Be specific and actionable.\n\n\`\`\`${language}\n${code}\n\`\`\``,
    "You are an expert code reviewer. Provide a structured review with: 1) Critical Issues, 2) Warnings, 3) Suggestions, 4) Overall Assessment. Be concise."
  );
}

export async function llm_generate_code(spec, language = "javascript", framework = "") {
  return await llm_call(
    "anthropic/claude-sonnet-4",
    `Generate ${language}${framework ? ` (${framework})` : ""} code for: ${spec}\n\nReturn ONLY the code, no explanations.`,
    "You are an expert software engineer. Generate clean, production-ready code. Include error handling and comments."
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Utility Tools ───────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

export async function deploy_to_do(repo, app_name = "") {
  const token = getToken("digitalocean", "DO_API_TOKEN");
  if (!token) throw new Error("DigitalOcean not connected.");
  const ghToken = getToken("github", "GITHUB_PAT");

  // Check if app already exists
  const apps = await doFetch("https://api.digitalocean.com/v2/apps?per_page=50");
  const existing = (apps.apps || []).find(a => a.spec?.name === (app_name || repo.split("/")[1]));

  if (existing) {
    // Trigger redeploy
    const result = await do_restart_app(existing.id);
    return { success: true, action: "redeployed", app_id: existing.id, ...result };
  }

  return {
    success: true,
    action: "info",
    message: `To deploy ${repo} as a new DO app, use the DO dashboard or CLI. Existing apps can be redeployed via do_restart_app.`,
    repo,
  };
}

export async function run_tests(repo) {
  // Trigger a workflow dispatch or just report test info
  try {
    const workflows = await ghFetch(`https://api.github.com/repos/${repo}/actions/workflows`);
    const testWorkflow = (workflows.workflows || []).find(w =>
      w.name.toLowerCase().includes("test") || w.name.toLowerCase().includes("ci")
    );

    if (testWorkflow) {
      await ghFetch(`https://api.github.com/repos/${repo}/actions/workflows/${testWorkflow.id}/dispatches`, {
        method: "POST",
        body: JSON.stringify({ ref: "main" }),
      });
      return { success: true, message: `Triggered workflow "${testWorkflow.name}" on ${repo}`, workflow: testWorkflow.name };
    }

    return { success: true, message: `No test/CI workflow found in ${repo}. Consider adding GitHub Actions.`, workflows: (workflows.workflows || []).map(w => w.name) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Tool Registry — all available tools with metadata ───────────────────────
// ══════════════════════════════════════════════════════════════════════════════

export const TOOL_REGISTRY = {
  github_create_repo: {
    fn: github_create_repo,
    category: "GitHub",
    description: "Create a new GitHub repository",
    params: ["name", "description", "private"],
    example: "TOOL:github_create_repo:my-new-repo:A cool project:true",
  },
  github_list_repos: {
    fn: github_list_repos,
    category: "GitHub",
    description: "List your GitHub repositories",
    params: [],
    example: "TOOL:github_list_repos",
  },
  github_create_pr: {
    fn: github_create_pr,
    category: "GitHub",
    description: "Create a pull request",
    params: ["repo", "title", "head", "base", "body"],
    example: "TOOL:github_create_pr:owner/repo:Fix bug:feature-branch:main:Fixes issue #1",
  },
  github_merge_pr: {
    fn: github_merge_pr,
    category: "GitHub",
    description: "Merge a pull request",
    params: ["repo", "pr_number"],
    example: "TOOL:github_merge_pr:owner/repo:42",
  },
  github_list_prs: {
    fn: github_list_prs,
    category: "GitHub",
    description: "List pull requests for a repo",
    params: ["repo", "state"],
    example: "TOOL:github_list_prs:owner/repo:open",
  },
  github_push_file: {
    fn: github_push_file,
    category: "GitHub",
    description: "Push/update a file in a GitHub repo",
    params: ["repo", "path", "content", "message", "branch"],
    example: "TOOL:github_push_file:owner/repo:README.md:# Hello:Update readme:main",
  },
  github_get_file: {
    fn: github_get_file,
    category: "GitHub",
    description: "Get file contents from a GitHub repo",
    params: ["repo", "path", "branch"],
    example: "TOOL:github_get_file:owner/repo:package.json:main",
  },
  github_trigger_copilot: {
    fn: github_trigger_copilot,
    category: "GitHub",
    description: "Create a Copilot-labeled issue for AI assistance",
    params: ["repo", "issue"],
    example: "TOOL:github_trigger_copilot:owner/repo:Add unit tests for auth module",
  },
  github_list_issues: {
    fn: github_list_issues,
    category: "GitHub",
    description: "List issues for a GitHub repo",
    params: ["repo", "state"],
    example: "TOOL:github_list_issues:owner/repo:open",
  },
  do_list_droplets: {
    fn: do_list_droplets,
    category: "DigitalOcean",
    description: "List all DigitalOcean droplets",
    params: [],
    example: "TOOL:do_list_droplets",
  },
  do_list_apps: {
    fn: do_list_apps,
    category: "DigitalOcean",
    description: "List all DigitalOcean App Platform apps",
    params: [],
    example: "TOOL:do_list_apps",
  },
  do_get_app_logs: {
    fn: do_get_app_logs,
    category: "DigitalOcean",
    description: "Get logs for a DigitalOcean app",
    params: ["app_id"],
    example: "TOOL:do_get_app_logs:abc123-def456",
  },
  do_restart_app: {
    fn: do_restart_app,
    category: "DigitalOcean",
    description: "Restart/redeploy a DigitalOcean app",
    params: ["app_id"],
    example: "TOOL:do_restart_app:abc123-def456",
  },
  do_get_droplet_status: {
    fn: do_get_droplet_status,
    category: "DigitalOcean",
    description: "Get status of a specific droplet",
    params: ["droplet_id"],
    example: "TOOL:do_get_droplet_status:12345678",
  },
  llm_call: {
    fn: llm_call,
    category: "LLM",
    description: "Call an LLM model with a prompt",
    params: ["model", "prompt", "system"],
    example: "TOOL:llm_call:anthropic/claude-sonnet-4:Explain quantum computing:You are a physics teacher",
  },
  llm_code_review: {
    fn: llm_code_review,
    category: "LLM",
    description: "AI code review for bugs and best practices",
    params: ["code", "language"],
    example: "TOOL:llm_code_review:function add(a,b){return a+b}:javascript",
  },
  llm_generate_code: {
    fn: llm_generate_code,
    category: "LLM",
    description: "Generate code from a specification",
    params: ["spec", "language", "framework"],
    example: "TOOL:llm_generate_code:REST API for todo app:javascript:express",
  },
  deploy_to_do: {
    fn: deploy_to_do,
    category: "Utility",
    description: "Deploy a GitHub repo to DigitalOcean App Platform",
    params: ["repo", "app_name"],
    example: "TOOL:deploy_to_do:owner/repo:my-app",
  },
  run_tests: {
    fn: run_tests,
    category: "Utility",
    description: "Trigger test/CI workflow on a GitHub repo",
    params: ["repo"],
    example: "TOOL:run_tests:owner/repo",
  },
};

// ══════════════════════════════════════════════════════════════════════════════
// ── Additional execution-tools (handled in server.mjs executeTool) ──────────
// ── These are listed here so getToolListForPrompt() includes them ────────────
// ══════════════════════════════════════════════════════════════════════════════
export const EXTRA_TOOLS = {
  create_real_pdf: {
    category: "Document",
    description: "Create a professionally formatted PDF document with headers, paragraphs, tables, and sections",
    params: ["title", "content", "sections"],
    example: 'TOOL:create_real_pdf:{"title":"Report","content":"Hello world"}',
  },
  create_spreadsheet: {
    category: "Document",
    description: "Create a real .xlsx Excel spreadsheet with formatted headers, auto-width columns, and multiple sheets",
    params: ["filename", "sheets"],
    example: 'TOOL:create_spreadsheet:{"filename":"data.xlsx","sheets":[{"name":"Sheet1","headers":["Name","Value"],"rows":[["A","1"]]}]}',
  },
  send_email: {
    category: "Google",
    description: "Send an email via Gmail (requires Google connection)",
    params: ["to", "subject", "body", "attachments"],
    example: 'TOOL:send_email:{"to":"user@example.com","subject":"Hello","body":"Hi there!"}',
  },
  read_email: {
    category: "Google",
    description: "Read emails from Gmail inbox (requires Google connection)",
    params: ["query", "maxResults"],
    example: 'TOOL:read_email:{"query":"is:unread","maxResults":5}',
  },
  upload_to_drive: {
    category: "Google",
    description: "Upload a file from uploads to Google Drive (requires Google connection)",
    params: ["filename", "folderId"],
    example: 'TOOL:upload_to_drive:{"filename":"report.pdf"}',
  },
  create_google_doc: {
    category: "Google",
    description: "Create a Google Doc with content (requires Google connection)",
    params: ["title", "content"],
    example: 'TOOL:create_google_doc:{"title":"Meeting Notes","content":"Notes from today..."}',
  },
  create_google_sheet: {
    category: "Google",
    description: "Create a Google Sheet with data (requires Google connection)",
    params: ["title", "sheets"],
    example: 'TOOL:create_google_sheet:{"title":"Budget","sheets":[{"name":"Q1","headers":["Item","Cost"],"rows":[["Hosting","$50"]]}]}',
  },
  fill_pdf: {
    category: "Document",
    description: "Fill a PDF form using PDFiller API. Provide document_id + fields to fill, or omit to list available templates.",
    params: ["document_id", "fields"],
    example: 'TOOL:fill_pdf:{"document_id":"12345","fields":{"Name":"John Doe","Date":"2026-04-04"}}',
  },
  generate_image: {
    category: "Media",
    description: "Generate an image using Leonardo AI (or DALL-E fallback). Provide a detailed prompt.",
    params: ["prompt", "width", "height"],
    example: 'TOOL:generate_image:{"prompt":"A futuristic city at sunset, cyberpunk style","width":1024,"height":1024}',
  },
  create_video: {
    category: "Media",
    description: "Create an AI avatar video using HeyGen. Provide script text, optional avatar_id and voice_id.",
    params: ["script", "title", "avatar_id", "voice_id"],
    example: 'TOOL:create_video:{"script":"Welcome to MindMappr! Here is your weekly report.","title":"Weekly Report"}',
  },
  web_search: {
    category: "Search",
    description: "Search the web using Brave Search, Google Custom Search, or DuckDuckGo fallback",
    params: ["query", "numResults"],
    example: 'TOOL:web_search:{"query":"latest AI news","numResults":5}',
  },
  discord_create_channel: {
    category: "Discord",
    description: "Create a text or voice channel in the Discord server",
    params: ["name", "type", "category", "topic"],
    example: 'TOOL:discord_create_channel:{"name":"general-chat","type":"text","topic":"General discussion"}',
  },
  discord_list_channels: {
    category: "Discord",
    description: "List all channels in the Discord server",
    params: ["guildId"],
    example: 'TOOL:discord_list_channels:{}',
  },
  discord_delete_channel: {
    category: "Discord",
    description: "Delete a channel from the Discord server by channel ID",
    params: ["channelId"],
    example: 'TOOL:discord_delete_channel:{"channelId":"123456789"}',
  },
  discord_send_message: {
    category: "Discord",
    description: "Send a message to a specific Discord channel",
    params: ["channelId", "message"],
    example: 'TOOL:discord_send_message:{"channelId":"123456789","message":"Hello from MindMappr!"}',
  },
  discord_create_role: {
    category: "Discord",
    description: "Create a new role in the Discord server",
    params: ["name", "color", "permissions"],
    example: 'TOOL:discord_create_role:{"name":"Moderator","color":"#FF0000"}',
  },
  discord_list_roles: {
    category: "Discord",
    description: "List all roles in the Discord server",
    params: ["guildId"],
    example: 'TOOL:discord_list_roles:{}',
  },
  create_calendar_event: {
    category: "Google",
    description: "Create a Google Calendar event (requires Google connection)",
    params: ["title", "startTime", "endTime", "description", "location"],
    example: 'TOOL:create_calendar_event:{"title":"Team Meeting","startTime":"2026-04-05T10:00:00-06:00","endTime":"2026-04-05T11:00:00-06:00"}',
  },
  stripe_list_customers: {
    category: "Stripe",
    description: "List Stripe customers (requires STRIPE_SECRET_KEY)",
    params: ["limit"],
    example: 'TOOL:stripe_list_customers:{"limit":10}',
  },
  stripe_list_payments: {
    category: "Stripe",
    description: "List recent Stripe payment intents (requires STRIPE_SECRET_KEY)",
    params: ["limit"],
    example: 'TOOL:stripe_list_payments:{"limit":10}',
  },
  stripe_create_invoice: {
    category: "Stripe",
    description: "Create a draft Stripe invoice for a customer with line items (requires STRIPE_SECRET_KEY)",
    params: ["customer_id", "items"],
    example: 'TOOL:stripe_create_invoice:{"customer_id":"cus_xxx","items":[{"description":"Consulting","amount":5000,"currency":"usd"}]}',
  },
  load_skill: {
    category: "Skills",
    description: "Load a skill from GitHub or any URL. Supports .py, .js, .yml, .md files. Auto-detects type and registers for execution.",
    params: ["url", "skill_type", "auto_register"],
    example: 'TOOL:load_skill:{"url":"github.com/midnghtsapphire/revvel-skills-vault/blob/main/skills/custom/web_scraper.skill.yml","auto_register":true}',
  },
  list_skills: {
    category: "Skills",
    description: "List available skills. Filter by category, loaded status, or search query.",
    params: ["category", "loaded_only", "query"],
    example: 'TOOL:list_skills:{"loaded_only":true}',
  },
  execute_skill: {
    category: "Skills",
    description: "Execute a loaded skill by ID or name. Python/JS skills run directly. Markdown/YAML skills run via LLM with skill content as context.",
    params: ["skill_id", "input"],
    example: 'TOOL:execute_skill:{"skill_id":"web_scraper","input":"Scrape https://example.com"}',
  },
  unload_skill: {
    category: "Skills",
    description: "Unload a skill from memory and mark as inactive.",
    params: ["skill_id"],
    example: 'TOOL:unload_skill:{"skill_id":"web_scraper"}',
  },
  save_memory: {
    category: "Memory",
    description: "Save information to persistent memory. Targets: 'memory' (long-term MEMORY.md), 'daily' (today's notes), 'soul' (personality), 'user' (user profile). ALWAYS use this to remember important things across sessions.",
    params: ["content", "target"],
    example: 'TOOL:save_memory:{"content":"User prefers dark mode and glassmorphism UI","target":"memory"}',
  },
  memory_search: {
    category: "Memory",
    description: "Search across all persistent memory (MEMORY.md, daily notes, soul.md, user.md, SQLite facts, conversation summaries). Use to recall older information.",
    params: ["query"],
    example: 'TOOL:memory_search:{"query":"stripe api key"}',
  },
  read_memory: {
    category: "Memory",
    description: "Read the full contents of a memory file. Targets: 'memory' (MEMORY.md), 'soul' (soul.md), 'user' (user.md), 'daily' (today's notes).",
    params: ["target"],
    example: 'TOOL:read_memory:{"target":"memory"}',
  },
  discover_skills: {
    category: "Skills",
    description: "Scan ALL GitHub repos for the user/org and find skill repositories. Auto-discovers repos with 'skill', 'agent', 'tool', 'plugin', 'expert' in the name, scans them for skill files (.py, .js, .yml, .md), and auto-loads them all. Use when user says 'find my skills' or 'load all skills'.",
    params: ["owner", "auto_load"],
    example: 'TOOL:discover_skills:{"owner":"midnghtsapphire","auto_load":true}',
  },
  scan_repo_skills: {
    category: "Skills",
    description: "Scan a specific GitHub repo for skill files and load them. Use when user points to a specific repo.",
    params: ["repo", "auto_load"],
    example: 'TOOL:scan_repo_skills:{"repo":"midnghtsapphire/revvel-skills-vault","auto_load":true}',
  },
};

/**
 * Execute a tool by name with positional arguments.
 * @param {string} toolName
 * @param {string[]} args
 * @returns {Promise<object>}
 */
export async function executeTool(toolName, args = []) {
  const tool = TOOL_REGISTRY[toolName];
  if (!tool) {
    return { success: false, error: `Unknown tool: ${toolName}. Available: ${Object.keys(TOOL_REGISTRY).join(", ")}` };
  }
  try {
    const result = await tool.fn(...args);
    return result;
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Parse TOOL: lines from LLM response text.
 * Format: TOOL:tool_name:param1:param2:...
 * Returns array of { tool, args } objects.
 */
export function parseToolCalls(text) {
  const results = [];
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("TOOL:")) {
      const parts = trimmed.slice(5).split(":");
      const toolName = parts[0];
      const args = parts.slice(1).map(a => a.trim());
      if (toolName && (TOOL_REGISTRY[toolName] || EXTRA_TOOLS[toolName])) {
        results.push({ tool: toolName, args });
      }
    }
  }
  return results;
}

/**
 * Get tool list for Rex's system prompt.
 */
export function getToolListForPrompt() {
  const categories = {};
  for (const [name, info] of Object.entries(TOOL_REGISTRY)) {
    if (!categories[info.category]) categories[info.category] = [];
    categories[info.category].push(`  - ${name}(${info.params.join(", ")}): ${info.description}`);
  }
  // Include extra tools (handled in server.mjs executeTool)
  for (const [name, info] of Object.entries(EXTRA_TOOLS)) {
    if (!categories[info.category]) categories[info.category] = [];
    categories[info.category].push(`  - ${name}(${info.params.join(", ")}): ${info.description}`);
  }
  let prompt = "\nAVAILABLE TOOLS (use TOOL:name:param1:param2 format on its own line):\n";
  for (const [cat, tools] of Object.entries(categories)) {
    prompt += `\n[${cat}]\n${tools.join("\n")}\n`;
  }
  prompt += `\nEXAMPLES:\nTOOL:github_list_repos\nTOOL:do_list_apps\nTOOL:llm_call:anthropic/claude-sonnet-4:Write a haiku about coding\n`;
  prompt += `\nDOCUMENT, MEDIA & GOOGLE TOOLS (use JSON params):\nTOOL:create_real_pdf:{"title":"Report","content":"Content here","sections":[{"heading":"Section 1","body":"Details"}]}\nTOOL:create_spreadsheet:{"filename":"data.xlsx","sheets":[{"name":"Sheet1","headers":["Name","Value"],"rows":[["A","1"]]}]}\nTOOL:fill_pdf:{"document_id":"12345","fields":{"Name":"John Doe","Date":"2026-04-04"}}\nTOOL:generate_image:{"prompt":"A futuristic city at sunset","width":1024,"height":1024}\nTOOL:create_video:{"script":"Welcome to MindMappr!","title":"Intro Video"}\nTOOL:send_email:{"to":"user@example.com","subject":"Hello","body":"Hi there!"}\nTOOL:read_email:{"query":"is:unread","maxResults":5}\nTOOL:upload_to_drive:{"filename":"report.pdf"}\nTOOL:create_google_doc:{"title":"Meeting Notes","content":"Notes from today..."}\nTOOL:create_google_sheet:{"title":"Budget","sheets":[{"name":"Q1","headers":["Item","Cost"],"rows":[["Hosting","$50"]]}]}\n`;
  prompt += `\nRULES FOR TOOL USE:\n1. Put each TOOL: call on its own line\n2. Parameters are colon-separated for simple tools, or use JSON for document/Google tools\n3. You can use multiple tools in one response\n4. After tools execute, you'll get results to summarize for the user\n5. Only use tools when the user's request requires real action (creating, listing, deploying, etc.)\n6. For Google tools (send_email, read_email, upload_to_drive, create_google_doc, create_google_sheet), Google must be connected first\n`;
  return prompt;
}
