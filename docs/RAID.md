# RAID: Risks, Assumptions, Issues, Dependencies

Tracking document for MindMappr Command Center. Updated April 2026.

---

## Risks

### R-001: Single-File Architecture Scaling — HIGH
`server.mjs` exceeds 3,000 lines. Routing, API endpoints, agent orchestration, DB interactions, cron, Discord/Telegram bridges, GitHub sync, OAuth — all in one file. Merge conflicts increase. Debugging gets harder. Single point of failure for all backend logic.
**Mitigation:** Planned modularization in Phase 2 of audit plan. Not currently blocking operations but will become critical as social media module, CRM, and trading interface are added.

### R-002: Force-Push Vulnerability — MITIGATED
April 3 incident destroyed multiple teams' work. Branch protection rules now enforced. PR-only workflow mandated.
**Mitigation:** Branch protection on `master`, required reviews, CI checks. See CONTRIBUTING.md.

### R-003: Ephemeral Storage — MITIGATED
JSON file storage wiped on deploy. Migrated to SQLite.
**Mitigation:** All data in `mindmappr.db`. GitHub sync as backup.

### R-004: Credential Exposure — HIGH
API keys, tokens, and passwords exist in multiple places: env vars, SQLite connections table, memory files. Some credentials were stored in long-term memory (MEMORY.md). No encryption at rest in SQLite. No secret scrubbing in logs.
**Mitigation planned:** Encrypt tokens at rest in SQLite. Scrub secrets from logs and memory files. Move all credentials to env vars + DO secrets. Never store credentials in memory files.

### R-005: Prompt Injection — HIGH
No pre-processing sanitization on user inputs before they reach agents. An attacker could hijack agent behavior via crafted prompts through any input channel.
**Mitigation planned:** Prompt injection defense layer (SEC-01 in TODO_ITEMS.md). Authenticated vs information channel distinction (see DARE AD-008).

### R-006: Destructive Tool Execution Without Approval — HIGH
Tools like `github_merge_pr`, DO deployment actions, Stripe billing execute immediately without human confirmation.
**Mitigation planned:** HITL gating for destructive tools (SEC-02 in TODO_ITEMS.md).

### R-007: LLM Model Availability — MEDIUM
OpenRouter models can be removed, rate-limited, or experience outages without warning. Scheduler agent hit 404 on `mistralai/mistral-small`.
**Mitigation:** Use stable models for critical agents. Build fallback routing. Token cost optimization engine (route to available alternatives).

### R-008: Social Media Account Suspension — MEDIUM
Automated posting and engagement across Reddit, Twitter, Discord, LinkedIn, YouTube carries risk of account suspension if platform TOS is violated or automation is detected.
**Mitigation:** Rate limiting on all social media tools. Human-like posting patterns. Compliance with each platform's API TOS. Lex agent reviews TOS compliance.

### R-009: Trading Losses — HIGH
Autonomous trading with real money ($43 starting capital) carries financial risk.
**Mitigation:** Hard stop-loss limits. Maximum 2% risk per trade. Kill switch (price divergence >1.5%, drawdown >10%, API health check). Paper trading mode first. Triple AI consensus before execution (conservative + standard + aggressive models must agree).

### R-010: Ralph Loop Runaway — MEDIUM
Autonomous coding sessions could run indefinitely, consume resources, or produce broken code without oversight.
**Mitigation:** Session timeout limits. Heartbeat checks every 15 minutes. Mandatory test pass before PR. Daily note logging of all active sessions. Nightly consolidation reviews all work product.

---

## Assumptions

### A-001: OpenRouter Availability
MindMappr depends entirely on OpenRouter for LLM calls. Assumes high availability, consistent API response times, and continued support for required models.

### A-002: DigitalOcean App Platform Reliability
Deployment strategy assumes DO App Platform maintains stable Node.js 20 environment, handles scaling, and preserves SQLite database across container restarts.

### A-003: SQLite Sufficient for Scale
SQLite handles single-user and low-traffic scenarios well. Assumes adequate performance for current use. If scaling to multiple concurrent users or heavy agent workflows, may need PostgreSQL migration.

### A-004: Social Media API Stability
Assumes Twitter API v2, Reddit API, Discord API, LinkedIn API, and YouTube Data API maintain current functionality and pricing tiers. Twitter/X API changes have been unpredictable.

### A-005: Autonomous Revenue Generation is Viable
The $43 → $1M velocity challenge assumes that AI-generated content (market reports, courses) has market demand, that automated lead generation converts, and that autonomous trading can compound capital. This is an experiment with no guaranteed outcome.

### A-006: FOSS Tools Cover Social Media Automation
Assumes libraries like snoowrap (Reddit), twitter-api-v2 (Twitter), discord.js (Discord), googleapis (YouTube) provide sufficient functionality for automated posting, engagement tracking, and campaign management without needing paid SaaS tools.

### A-007: Rex Can Self-Improve
The nightly consolidation model assumes Rex (via Scheduler) can meaningfully analyze daily performance, identify mistakes, and write improved rules/templates. This is based on the Felix AI model but hasn't been validated in MindMappr's architecture yet.

---

## Issues

### ISS-001: April 3 Force-Push Incident — RESOLVED
Multiple teams force-pushed to `master`, destroying work. Recovered via git reflog mega-merge. Branch protection now enforced.

### ISS-002: Ephemeral Storage Bug — RESOLVED
JSON files wiped on deploy. Migrated to SQLite.

### ISS-003: Cosmetic Connections Panel — RESOLVED
Tokens stored but not used by tools. `getConnectionToken()` added and wired.

### ISS-004: Agent Model 404 Errors — PARTIALLY RESOLVED
Scheduler agent hit 404 on removed model. Workaround: use non-free models initially. Permanent fix: model fallback routing not yet implemented.

### ISS-005: Skills Not Executable — OPEN
260+ skills cataloged in `skills-catalog.json` but most are just metadata entries. Loading a skill via `load_skill` fetches YAML from GitHub but not all skills have executable implementations wired into `rex-tools.mjs`.
**Plan:** See REX_ENHANCEMENT_PLAN.md Phase 1.

### ISS-006: revvel-standards Not Imported — OPEN
Referenced in audit plan as critical gap. No `revvel-standards` or `growlingeyes` artifacts exist in this repo. Cannot prove standards compliance.
**Plan:** Owner to provide repos. See REPOSITORY_MAP.md.

### ISS-007: neurooz Artifacts Missing — OPEN
Neurooz referenced in memory as key project. Docs and artifacts mentioned by owner as existing under `docs/neurooz/` and in the neurooz folder. Not present in mindmappr repo.
**Plan:** Owner to provide location. Will be organized into `revvel-standards/docs/neurooz/`.

### ISS-008: No Unit or Integration Tests — OPEN
Only a smoke test exists. No unit tests for Rex tools, no integration tests for API flows, no E2E tests for UI.
**Plan:** See TESTING_STRATEGY.md.

### ISS-009: AGENTS.md Contains Sessiono Context — OPEN
The `AGENTS.md` file's "Project-Specific Context" section describes "Sessiono" (a session musician platform), not MindMappr. This is a copy-paste from another repo.
**Plan:** Fix in this sprint (see below).

### ISS-010: Memory File Contains Credentials — CRITICAL
The MEMORY.md file in `data/` contains raw API keys, passwords, and payment credentials from the April 8 autonomous operation setup. These should never be stored in memory files.
**Plan:** Scrub credentials from memory files. Store only in env vars and DO secrets. Add a pre-save filter to the memory system that strips anything matching API key patterns.

---

## Dependencies

### DEP-001: Node.js 20
Runtime dependency. Dockerfile uses `node:20-slim`. `better-sqlite3` requires native build tools (`make`, `g++`, `python3`).

### DEP-002: better-sqlite3
Core persistence. Requires native compilation. Critical dependency — if it breaks, all data access fails.

### DEP-003: OpenRouter API
All LLM calls route through OpenRouter. Requires valid API key. Default model: `anthropic/claude-sonnet-4`.

### DEP-004: DigitalOcean App Platform
Production deployment target. Auto-deploys from `master` branch.

### DEP-005: GitHub API
Rex tools depend on GitHub PAT for repo management, PR operations, file push. Also used by `github-sync.mjs` for data persistence backup.

### DEP-006: discord.js v14
Discord bot connector. Requires bot token and guild ID.

### DEP-007: googleapis
Google Workspace integration (Drive, Gmail, Docs, Sheets, Calendar). Requires OAuth2 client credentials.

### DEP-008: Stripe API
Payment processing. Currently scaffolded with list/invoice tools. Full integration needed for Digital Arbitrage Academy revenue.

### DEP-009: Social Media APIs (Planned)
Twitter API v2 (Basic tier minimum), Reddit API, LinkedIn API, YouTube Data API. Required for the social media automation module.

### DEP-010: Trading APIs (Planned)
Alpaca Trading API (commission-free), Coinbase Pro API (crypto). Required for the autonomous trading interface.

### DEP-011: revvel-standards Repository
Governance and compliance standards. Currently not imported. Blocks standards compliance verification.

### DEP-012: revvel-skills-vault Repository
Source of Rex YAML skill files. Referenced in `rex-tools.mjs` for `load_skill` and `discover_skills` tools.
