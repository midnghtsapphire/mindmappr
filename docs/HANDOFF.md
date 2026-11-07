# HANDOFF: MindMappr Command Center

**Version:** 9.4.0
**Last Updated:** 2026-11-07
**Owner:** Audrey Evans (Revvel, @midnghtsapphire, GlowStarLabs)
**Governance:** revvel-standards (github.com/midnghtsapphire/revvel-standards) is the SSOT for all MIDNGHTSAPPHIRE projects. Read it first.

---

## Read Order for New Agent/Developer

1. `revvel-standards/AGENTS.md` — 25 owner rules (NEVER delete, draft PR only, etc.)
2. `revvel-standards/START_HERE_CALL_CHAIN.md` — WR pipeline flow
3. `revvel-standards/MASTER.md` — UPREV method, conflict resolution
4. This file — MindMappr-specific state
5. `docs/DEPLOYMENT_CONTRACT.md` — full autonomous ops contract
6. `docs/RAID.md` — what's broken and why
7. `docs/DEVELOPMENT_FLOW.md` — EXRUP + Ralph Loop methodology
8. `AGENTS.md` (in this repo) — prime directive + architecture

---

## Architecture

```
server.mjs              # Backend: Express, agents, SQLite, cron, OAuth (~3k+ lines)
rex-tools.mjs           # 21+ Rex tools (GitHub, DO, Discord, Stripe, Google, search, media)
discord-connector.mjs   # Discord bot (MindMappr Bot#2654)
github-sync.mjs         # Pushes data/ to midnghtsapphire/mindmappr-data every 30s
src/App.tsx             # React frontend (Vite)
public/index.html       # SPA frontend (no build step, glassmorphism UI)
skills-catalog.json     # 260+ OpenClaw skills registry (Manus entries removed)
data/mindmappr.db       # SQLite (runtime, ephemeral on DO — github-sync backs it up)
data/MEMORY.md          # Long-term agent memory
data/soul.md            # Agent personality
data/user.md            # Owner profile
tests/smoke-test.mjs    # Pre-deploy smoke test
docs/                   # DARE, RAID, contracts, use cases, testing strategy, etc.
.env.example            # All credential placeholders
```

---

## How to Run

### Local (recommended for development)
```bash
git clone https://github.com/midnghtsapphire/mindmappr.git
cd mindmappr
npm install          # Node.js 20+, needs make/g++/python3 for better-sqlite3
cp .env.example .env # Fill in your keys
npm start            # http://localhost:3005
```

Google OAuth works on localhost. This is the path that actually works for connections.

### DigitalOcean App Platform (production)
1. Connect GitHub repo → master branch
2. Dockerfile auto-detected, run command: `node server.mjs`
3. Set env vars in DO console (see .env.example for full list)
4. github-sync.mjs backs up data/ to midnghtsapphire/mindmappr-data every 30s (requires GITHUB_PAT)

**WARNING:** DO containers are ephemeral. SQLite, memory files, custom agents, and connections get wiped on redeploy/restart unless github-sync is running with a valid GITHUB_PAT.

---

## What Works (November 2026)

| Feature | Status |
|---------|--------|
| Agent chat (Rex, Watcher, Scheduler, Processor, Generator, Lex) | WORKING |
| Rex GitHub tools (repos, PRs, files) | WORKING (with GITHUB_PAT) |
| Rex DigitalOcean tools (droplets, apps) | WORKING (with DO_API_TOKEN) |
| Web search (Brave → Google → DDG fallback) | WORKING (with BRAVE_SEARCH_API_KEY) |
| PDF generation (pdfkit) | WORKING |
| Spreadsheet creation (exceljs) | WORKING |
| Discord bot | WORKING (with DISCORD_BOT_TOKEN) |
| Telegram bot | WORKING (with TELEGRAM_BOT_TOKEN) |
| Content Studio (compose, score, braindump, repurpose) | WORKING |
| Activity Window | WORKING |
| Deploy Tab (PR management) | WORKING |
| Custom agent creation | WORKING (lost on container restart without github-sync) |
| Branch protection | ENFORCED (after April 3 incident) |
| Smoke test CI | WORKING |

## What's Broken / Not Built

| Feature | Status | Root Cause |
|---------|--------|-----------|
| Google OAuth (Gmail, Drive, Docs, Sheets, Calendar) | BROKEN | OAuth redirect URI mismatch on DO; works on localhost |
| Connections panel wiring | COSMETIC | Tokens saved to DB but many tools don't actually read them |
| Skill loading (260+ catalog) | 404s on most | Skills designed for OpenClaw, not MindMappr's execution model |
| Social media automation module | NOT BUILT | No Twitter/Reddit/LinkedIn API integration in rex-tools.mjs |
| CRM module | NOT BUILT | No lead tracking, scoring, or follow-up system |
| Autonomous trading interface | NOT BUILT | No Alpaca/Coinbase API integration |
| Analytics dashboard (revenue tracking) | NOT BUILT | No PayPal/Stripe data aggregation |
| Multi-agent delegation | NOT REAL | Agents don't actually delegate between each other |
| Nightly memory consolidation | NOT BUILT | No 2AM cron job for memory consolidation |
| Ralph Loop (autonomous iteration) | NOT BUILT | No heartbeat, no session tracking |
| Email sending/receiving | BROKEN | Google OAuth not connected |
| Unit/integration tests | NONE | Only smoke-test.mjs exists |
| Prompt injection defense | NONE | No sanitization layer |
| HITL for destructive actions | NONE | Tools execute immediately |

---

## LLM Layer 0 Rule (from revvel-standards)

Local LLMs first. `REVVEL_LLM_ALLOW_CLOUD` must be `"1"` to spend on cloud LLMs.

Fallback chain: LM Studio → Ollama → OpenRouter

This was created after ~$80 of OpenRouter spend appeared in one day. MindMappr currently violates this — it goes straight to OpenRouter. Future work: add LM Studio/Ollama support to the LLM routing in server.mjs.

---

## Key Env Vars (see .env.example for all)

| Var | Required | Purpose |
|-----|----------|---------|
| PORT | No (default 3005) | Server port |
| APP_PASSWORD | YES | Login password |
| LLM_API_KEY | YES | OpenRouter key |
| GITHUB_PAT | YES for Rex tools + github-sync | GitHub Personal Access Token |
| DO_API_TOKEN | For DO management | DigitalOcean API token |
| DISCORD_BOT_TOKEN | For Discord bot | Discord bot token |
| TELEGRAM_BOT_TOKEN | For Telegram bot | Telegram bot token |
| GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI | For Google Workspace | Google OAuth2 |
| STRIPE_SECRET_KEY | For payments | Stripe API key |
| BRAVE_SEARCH_API_KEY | For web search | Brave Search |

---

## Database Schema (SQLite — mindmappr.db)

| Table | Purpose |
|-------|---------|
| user_preferences | UI settings (key-value) |
| facts | Long-term agent memory (categorized facts) |
| conversation_summaries | Chat session summaries |
| project_context | Project details |
| scheduled_tasks | Cron job configs |
| agent_tasks | Task history (status, cost) |
| custom_agents | User-created agents (lost on container restart) |
| agent_activity | Real-time action logs (Activity Window) |
| connections | API tokens for external services |
| content_studio_posts | Generated content |
| content_studio_inspirations | Repurposed content sources |
| content_studio_braindumps | Raw ideas and drafts |
| content_studio_analytics | Content performance metrics |
| skills | Loaded skill registry |

---

## Agent Roster

| Agent | Role | Model | Key Tools |
|-------|------|-------|-----------|
| Rex | CEO / Infrastructure | Claude Sonnet | 21+ rex-tools (GitHub, DO, Discord, Stripe, Google, search, media) |
| Watcher | Monitoring | Claude Sonnet | System health, logs, anomaly detection |
| Scheduler | Automation | Mistral Small | Cron jobs, task scheduling |
| Processor | Data | Claude Sonnet | Parsing, extraction, fast data ops |
| Generator | Content | Claude Sonnet | Content Studio, reports, social posts |
| Lex | Legal Counsel | Claude Sonnet | Contracts, ToS, compliance, legal research |

---

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | /api/auth/login | Authenticate with APP_PASSWORD |
| GET | /api/health | Server status and version |
| POST | /api/chat | Message default agent |
| POST | /api/agents/:name/invoke | Message specific agent |
| GET | /api/agents | List all agents |
| GET | /api/activity/live | Activity Window data |
| GET | /api/tools | List Rex tools |
| POST | /api/tools/execute | Execute a Rex tool |
| GET | /api/connections/list | List connections |
| POST | /api/schedule | Create scheduled task |
| POST | /api/content-studio/compose | Generate content |
| GET | /api/agents/rex/skills | Skills registry |
| GET | /api/google/auth | Start Google OAuth flow |
| GET | /api/google/callback | Google OAuth callback |

---

## Connected Repos

| Repo | Relationship |
|------|-------------|
| midnghtsapphire/mindmappr | This repo (app code) |
| midnghtsapphire/mindmappr-data | github-sync backup target (SQLite + memory files) |
| midnghtsapphire/revvel-standards | SSOT for governance, standards, skills, templates |
| midnghtsapphire/revvel-skills-vault | Rex YAML skills (loaded via load_skill tool) |
| midnghtsapphire/reese-reviews | Review platform (in Deploy tab) |

---

## Priority Fix Order

1. **Fix Google OAuth** — change GOOGLE_REDIRECT_URI to match actual deployment URL. Test on localhost first.
2. **Wire connections to tools** — getConnectionToken() exists but many tools don't call it.
3. **Add unit tests** — rex-tools.mjs functions, API endpoint tests, connection health checks.
4. **Build social media module** — Twitter API v2, Reddit API in rex-tools.mjs.
5. **Build nightly consolidation** — 2AM cron in Scheduler agent.
6. **Build Ralph Loop** — heartbeat cron, session tracking, autonomous iteration.

---

## What NOT to Do (from revvel-standards Owner Rules)

- NEVER delete files, code, docs, or rules
- NEVER rewrite/overwrite existing work wholesale
- To retire something, COMMENT IT OUT with dated note
- All changes via draft PR for owner review
- Agents never merge their own PRs
- Everything worked on goes in the repo. EVERYTHING.
