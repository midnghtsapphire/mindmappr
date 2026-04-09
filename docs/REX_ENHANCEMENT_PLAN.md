# Rex Enhancement Plan: Skills, MCP, Scripts, Social Media, Revenue

Rex is the CEO agent. Right now he's a CEO who can't make phone calls, can't send emails, can't post on social media, can't process payments, and can't delegate work. This plan fixes all of that.

---

## Current State (What Rex CAN Do)

| Capability | Tools | Status |
|-----------|-------|--------|
| GitHub management | github_create_repo, github_list_repos, github_push_file, github_create_pr, github_merge_pr, github_list_prs | WORKING |
| DigitalOcean management | do_list_droplets, do_list_apps, do_restart_app | WORKING |
| Web search | web_search (Brave → Google → DDG fallback) | WORKING |
| PDF generation | create_real_pdf | WORKING |
| Spreadsheet creation | create_spreadsheet | WORKING |
| Image generation | generate_image (Leonardo AI) | WORKING (with key) |
| Video generation | create_video (HeyGen) | WORKING (with key) |
| Discord management | discord_create_channel, discord_send_message, discord_list_channels, discord_delete_channel, discord_create_role, discord_list_roles | WORKING |
| Stripe (partial) | stripe_list_customers, stripe_list_payments, stripe_create_invoice | SCAFFOLDING |
| Google Calendar | create_calendar_event | BROKEN (OAuth) |
| Gmail | send_email, read_email | BROKEN (OAuth) |
| Google Drive | upload_to_drive, create_google_doc, create_google_sheet | BROKEN (OAuth) |
| PDF forms | fill_pdf (PDFiller API) | UNTESTED |
| Skill loading | load_skill, discover_skills, scan_repo_skills | 404s on most skills |
| Code execution | run_python | WORKING |
| TTS | elevenlabs_tts | WORKING (with key) |

**21 working tools, 6 broken tools, countless missing tools.**

---

## What Rex NEEDS (Priority Order)

### P0: Fix Broken Connections

#### 1. Google OAuth Fix
The entire Google suite is broken. Rex can't email, can't upload to Drive, can't create docs, can't schedule calendar events. This blocks ALL revenue generation that involves product delivery.

**Root cause investigation needed:**
- Is the OAuth redirect URI correct for the deployed environment?
- Are the scopes sufficient (Gmail send, Drive upload, Calendar write)?
- Are tokens being refreshed properly when they expire?
- Is `getGoogleAccessToken()` actually returning valid tokens?
- Does the Connections tab UI properly trigger the OAuth flow?

**Fix approach:**
1. Add connection health test that attempts a simple Gmail API call
2. Debug the OAuth flow step by step (auth URL → consent → callback → token storage → token refresh)
3. Add error logging at every OAuth step
4. Test with a fresh OAuth consent

#### 2. Connection Status Reality Check
The Connections panel lies. It shows "Connected" based on whether a token is stored, not whether the token actually works.

**Fix:** Add a `testConnection(serviceId)` function that makes a real API call and returns true/false. Update the UI to show real status.

### P1: Social Media Posting Tools

Rex needs to actually post to social media. These are new tools to add to `rex-tools.mjs`:

#### Twitter/X Tools
```
twitter_post        — Post a tweet (text, image, thread)
twitter_reply       — Reply to a tweet
twitter_search      — Search tweets by keyword
twitter_trending    — Get trending topics
twitter_analytics   — Get engagement metrics
```
**API:** Twitter API v2 (Basic tier, $100/mo or free Essential)
**FOSS Alternative:** Use Nitter scraping for reads, direct API for writes
**Auth:** OAuth 2.0 PKCE or Bearer token

#### Reddit Tools
```
reddit_post         — Submit a post to a subreddit
reddit_comment      — Comment on a post
reddit_search       — Search subreddits
reddit_monitor      — Watch subreddit for keywords
reddit_dm           — Send direct message
```
**API:** Reddit API (free with rate limits)
**FOSS Alternative:** PRAW (Python Reddit API Wrapper) or snoowrap (Node.js)
**Auth:** OAuth2 client credentials

#### LinkedIn Tools
```
linkedin_post       — Share an update
linkedin_article    — Publish long-form article
linkedin_message    — Send InMail/message
linkedin_search     — Search people/companies
```
**API:** LinkedIn API (Marketing Developer Platform)
**FOSS Alternative:** linkedin-api (unofficial Node.js)
**Auth:** OAuth 2.0

#### YouTube Tools
```
youtube_upload      — Upload video
youtube_schedule    — Schedule video publish
youtube_analytics   — Channel stats
youtube_comment     — Post comment
```
**API:** YouTube Data API v3 (free quota)
**Auth:** Google OAuth (same flow as Gmail — fix OAuth first)

### P2: Payment Processing Tools

#### PayPal Tools (NEW)
```
paypal_create_invoice    — Create and send invoice
paypal_check_payment     — Check payment status
paypal_list_transactions — List recent transactions
paypal_create_product    — Create a product listing
paypal_generate_link     — Generate payment link
```
**API:** PayPal REST API v2
**Auth:** Client ID + Secret (already have credentials)
**SDK:** `@paypal/checkout-server-sdk` or direct REST

#### Stripe Enhancement
Current tools are read-only. Need:
```
stripe_create_payment_link  — One-click purchase URL
stripe_create_product       — Product + price in catalog
stripe_create_subscription  — Recurring billing
stripe_process_refund       — Refund a payment
stripe_create_checkout      — Full checkout session
```

### P3: Market Data Tools

```
market_stock_quote      — Real-time stock price (Alpha Vantage / Yahoo Finance)
market_crypto_price     — Crypto prices (CoinGecko — free, no key)
market_fear_greed       — Fear & Greed Index
market_trending_crypto  — Trending coins
market_economic_data    — FRED economic indicators
market_news             — Financial news aggregation
```

### P4: CRM / Lead Management Tools

```
crm_add_lead           — Add lead with source, score, contact info
crm_update_lead        — Update lead status (cold → warm → hot → customer)
crm_list_leads         — Filter by status, source, score
crm_send_followup      — Trigger email sequence for a lead
crm_track_conversion   — Record purchase, calculate LTV
```

New SQLite tables:
```sql
CREATE TABLE leads (
  id INTEGER PRIMARY KEY,
  name TEXT, email TEXT, source TEXT,
  score INTEGER DEFAULT 0,
  status TEXT DEFAULT 'cold',
  notes TEXT, created_at TEXT, updated_at TEXT
);

CREATE TABLE email_sequences (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER, sequence_name TEXT,
  step INTEGER, sent_at TEXT, opened BOOLEAN,
  clicked BOOLEAN, FOREIGN KEY (lead_id) REFERENCES leads(id)
);
```

---

## MCP Server Configuration

Rex needs MCP (Model Context Protocol) servers for enhanced capabilities. MCP lets Rex call external tools through a standardized protocol instead of hardcoding every API.

### Recommended MCP Servers

| Server | What It Does | GitHub |
|--------|-------------|--------|
| **@anthropic/mcp-server-filesystem** | Read/write local files | Built-in |
| **@anthropic/mcp-server-github** | Full GitHub API access | Built-in |
| **@anthropic/mcp-server-brave-search** | Web search | Built-in |
| **mcp-server-sqlite** | Query SQLite databases directly | Community |
| **mcp-server-stripe** | Full Stripe operations | Community |
| **mcp-server-slack** | Slack messaging | Community |
| **mcp-server-google-drive** | Google Drive operations | Community |
| **mcp-server-twitter** | Twitter/X API | Community |
| **mcp-server-reddit** | Reddit API | Community |

### MCP Configuration File

Create `mcp-config.json` in project root:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-filesystem", "--root", "/home/user/mindmappr"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PAT}" }
    },
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-brave-search"],
      "env": { "BRAVE_API_KEY": "${BRAVE_SEARCH_API_KEY}" }
    },
    "sqlite": {
      "command": "npx",
      "args": ["-y", "mcp-server-sqlite", "--db", "data/mindmappr.db"]
    }
  }
}
```

### Integration Approach

Two options for MCP in MindMappr:

**Option A: MCP as tool provider** — Rex's tool execution loop checks MCP servers alongside rex-tools.mjs. When a tool isn't in rex-tools, check if an MCP server provides it.

**Option B: MCP bridge** — New endpoint `/api/mcp/invoke` that proxies tool calls to MCP servers. Rex tools call this endpoint for external operations.

Recommendation: **Option A** — Rex gets MCP tools natively. Add MCP client to server.mjs that discovers tools from configured servers on startup.

---

## Skill Format: MindMappr Native (.skill.md)

OpenClaw skills don't work in MindMappr. Different platform, different runtime. Need a native format.

### MindMappr Skill Format

```markdown
---
name: twitter_marketing
version: 1.0.0
description: Post, analyze, and engage on Twitter/X
category: social-media
author: revvel-custom
requires:
  connections: [twitter]
  tools: [web_search]
  env: [TWITTER_BEARER_TOKEN]
---

## System Prompt Extension
You are an expert Twitter/X marketing agent. When asked to post, engage,
or analyze Twitter content, use these tools and follow these strategies...

## Tools Provided
### twitter_post
- params: {text, media_url?, reply_to?}
- does: Posts a tweet via Twitter API v2

### twitter_search
- params: {query, max_results?}
- does: Searches recent tweets matching query

## Execution Scripts
```javascript
// Inline Node.js that gets registered as a tool
async function twitter_post({ text, media_url, reply_to }) {
  const token = await getConnectionToken('twitter');
  if (!token) return { success: false, error: 'Twitter not connected. Add Bearer Token in Connections tab.' };
  // Twitter API v2 post
  const res = await fetch('https://api.twitter.com/2/tweets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });
  return { success: res.ok, data: await res.json() };
}
` ``
```

### Skill Loader Enhancement

Update `load_skill` in rex-tools.mjs to:
1. Detect format (OpenClaw YAML vs MindMappr .skill.md)
2. Parse MindMappr skills: extract system prompt, tools, scripts
3. Register tools dynamically
4. Inject system prompt extension into agent context
5. Store in SQLite skills table

---

## Ralph Loop Implementation

### What It Is
Autonomous iteration: Rex reads the contract, writes a PRD, spawns a coding agent, monitors progress, merges results, picks next task, repeats.

### Implementation in server.mjs

```javascript
// Ralph Loop - autonomous iteration engine
async function startRalphLoop(contractPath) {
  const contract = readFileSync(contractPath, 'utf8');

  while (true) {
    // 1. Pick next uncompleted item from contract
    const nextTask = await askRex(`Read this contract and identify the highest priority uncompleted task:\n${contract}`);

    if (nextTask.includes('ALL TASKS COMPLETE')) break;

    // 2. Write PRD for this task
    const prd = await askRex(`Write a detailed PRD for this task: ${nextTask}`);

    // 3. Create branch
    const branch = `feature/ralph-${Date.now()}`;
    await executeTool('github_create_branch', { branch, from: 'master' });

    // 4. Log in daily notes
    await appendToDaily(`Ralph Loop started: ${nextTask}\nBranch: ${branch}\nStatus: IN PROGRESS`);

    // 5. Execute the work (Rex does the coding)
    const result = await askRex(`Implement this PRD. Write the code, create the files, test it:\n${prd}`);

    // 6. Commit and PR
    await executeTool('github_create_pr', {
      title: `[Ralph] ${nextTask.substring(0, 60)}`,
      body: prd,
      head: branch,
      base: 'master'
    });

    // 7. Log completion
    await appendToDaily(`Ralph Loop completed: ${nextTask}\nBranch: ${branch}\nStatus: PR CREATED`);
  }
}
```

### Heartbeat (every 15 minutes)

```javascript
// Heartbeat checks daily notes for stalled Ralph sessions
cron.schedule('*/15 * * * *', async () => {
  const dailyNote = readDailyNote();
  const activeSessions = parseActiveSessions(dailyNote);

  for (const session of activeSessions) {
    if (session.status === 'IN PROGRESS' && session.age > 60 * 60 * 1000) {
      // Session stalled for > 1 hour, restart
      await restartRalphSession(session);
      logActivity('scheduler', `Restarted stalled Ralph session: ${session.task}`);
    }
  }
});
```

---

## FOSS Social Media Tools

For social media automation without paid APIs:

| Tool | What It Does | Language | License |
|------|-------------|----------|---------|
| **snoowrap** | Reddit API wrapper | Node.js | MIT |
| **twit** / **twitter-api-v2** | Twitter API | Node.js | MIT |
| **linkedin-api** | LinkedIn (unofficial) | Node.js | MIT |
| **yt-dlp** | YouTube download/metadata | Python | Unlicense |
| **google-api-nodejs-client** | YouTube upload via Data API | Node.js | Apache-2.0 |
| **n8n** | Workflow automation (self-hosted) | Node.js | Sustainable Use |
| **Huginn** | Agent-based automation | Ruby | MIT |
| **Social Poster** | Multi-platform posting | Python | MIT |
| **Buffer API** | Social scheduling (free tier) | REST | N/A |

### NPM Packages to Add

```json
{
  "twitter-api-v2": "^1.17.0",
  "snoowrap": "^1.23.0",
  "@paypal/checkout-server-sdk": "^1.0.4",
  "alpha-vantage-cli": "^2.0.0",
  "coingecko-api-v3": "^0.0.26"
}
```

---

## Agent-to-Agent Delegation

Rex currently can't delegate to other agents. Fix:

### Simple Delegation Protocol

Add to server.mjs:

```javascript
async function delegateToAgent(fromAgent, toAgent, task) {
  logActivity(fromAgent, `Delegating to ${toAgent}: ${task}`);

  const response = await invokeAgent(toAgent, task);

  logActivity(toAgent, `Completed task from ${fromAgent}: ${task.substring(0, 100)}`);
  logActivity(fromAgent, `Received result from ${toAgent}`);

  return response;
}
```

Rex's system prompt gets updated:
```
When you need content created, delegate to Generator: DELEGATE:generator:<task>
When you need data processed, delegate to Processor: DELEGATE:processor:<task>
When you need something monitored, delegate to Watcher: DELEGATE:watcher:<task>
When you need something scheduled, delegate to Scheduler: DELEGATE:scheduler:<task>
When you need legal review, delegate to Lex: DELEGATE:lex:<task>
```

Tool execution loop parses `DELEGATE:` calls and routes to the correct agent.

---

## Implementation Roadmap

### Week 1: Fix What's Broken
- [ ] Debug and fix Google OAuth flow
- [ ] Add real connection health checks
- [ ] Add connection test button to UI
- [ ] Write connection health tests

### Week 2: Social Media + Payments
- [ ] Add Twitter API v2 tools (twitter-api-v2 npm)
- [ ] Add Reddit API tools (snoowrap npm)
- [ ] Add PayPal REST API tools
- [ ] Enhance Stripe tools (payment links, checkout)
- [ ] Add market data tools (CoinGecko, Alpha Vantage)

### Week 3: Agent Intelligence
- [ ] Implement agent delegation protocol
- [ ] Add CRM tables and tools
- [ ] Build email sequence engine
- [ ] Implement nightly consolidation cron
- [ ] Add MindMappr native skill format

### Week 4: Automation
- [ ] Wire daily market analysis pipeline
- [ ] Implement Ralph Loop
- [ ] Add heartbeat monitoring
- [ ] Set up MCP server configuration
- [ ] Integration test the full revenue pipeline
