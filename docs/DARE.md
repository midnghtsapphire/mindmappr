# DARE: Decide, Act, Review, Evolve

Strategic decisions, implementation actions, incident reviews, and the evolution roadmap for MindMappr Command Center.

---

## Decide: Architectural Decisions

### AD-001: Single-File Server Architecture
**Date:** Late 2025
**Decision:** Build MindMappr as a single-file server (`server.mjs`).
**Rationale:** Simplifies deployment, reduces overhead for internal tooling. One file = one deploy unit.
**Status:** Active. File exceeds 3K lines. Modularization planned for Phase 2 of audit plan but not blocking current operations.

### AD-002: SQLite for Persistence
**Date:** March 2026
**Decision:** Migrate all data from JSON files to SQLite (`better-sqlite3`).
**Rationale:** DigitalOcean App Platform uses ephemeral containers. JSON files were wiped on every deploy. SQLite survives container restarts.
**Status:** Active. All connections, API keys, custom agents, memory, content, and agent tasks stored in `mindmappr.db`.

### AD-003: Glassmorphism UI
**Date:** Late 2025
**Decision:** Dark cinematic glassmorphism theme for all UI.
**Rationale:** Modern, sleek, accessible. Aligns with Audrey's aesthetic preferences.
**Status:** Active across both `public/index.html` SPA and `src/App.tsx` React build.

### AD-004: OpenRouter as LLM Gateway
**Date:** Late 2025
**Decision:** Route all LLM calls through OpenRouter rather than direct API calls.
**Rationale:** Model flexibility (swap Claude/GPT/Mistral without code changes), cost control, single API key.
**Status:** Active. Default model: `anthropic/claude-sonnet-4`.

### AD-005: Felix-Inspired Autonomous Agent Architecture
**Date:** April 2026
**Decision:** Model Rex and the agent workforce after Felix AI's autonomous business model.
**Rationale:** Felix AI (by Nat Eliason) proved that an AI agent can run a C-Corp autonomously — own bank account, Stripe, social media, sub-agents. MindMappr adapts this for Freedom Angel Corps / Digital Arbitrage Academy.
**Key Elements:**
- Rex as CEO agent (like Felix), orchestrating all operations
- Sub-agent spawning when bottlenecks hit (like Iris for support, Remy for sales)
- Nightly self-improvement consolidation (2AM cron review of all daily activity)
- Ralph Loop for autonomous continuous development
- Authenticated vs information channel security model
**Status:** In progress. Contract defined in `DEPLOYMENT_CONTRACT.md`.

### AD-006: EXRUP Development Methodology
**Date:** April 2026
**Decision:** Adopt eXtreme Rapid Unified Programming as the development methodology.
**Rationale:** No phases, no proposals, no MVPs. One iteration, production-ready, ship or don't ship. Matches Audrey's "auto-everything" preference and enables autonomous agent-driven development via the Ralph Loop.
**Status:** Active. Documented in `DEVELOPMENT_FLOW.md`.

### AD-007: Centralized Documentation in revvel-standards
**Date:** April 2026
**Decision:** All project governance docs (DARE, RAID, use cases, contracts, etc.) will migrate to `revvel-standards/docs/<appname>/` once that repo is configured.
**Rationale:** With many apps (MindMappr, Reese Reviews, Neurooz, Email Organizer), one source of truth prevents fragmentation. AI agents can reference one repo for cross-app context.
**Interim:** Docs remain in `mindmappr/docs/` until migration.
**Status:** Pending. See `REPOSITORY_MAP.md` for full structure.

### AD-008: Credential Security — Authenticated Channels Only
**Date:** April 2026
**Decision:** Distinguish between authenticated command channels and information-only channels.
**Rationale:** Prevents prompt injection and social engineering. Twitter mentions, public email, and Discord public channels are read-only intelligence sources. Commands only accepted from Telegram private chat, Discord DM, and password-protected MindMappr UI.
**Status:** To be implemented. Pattern defined in `DEPLOYMENT_CONTRACT.md`.

### AD-009: Nightly Memory Consolidation
**Date:** April 2026
**Decision:** Implement Thiago Forte-inspired knowledge management with nightly automated consolidation.
**Rationale:** Agents lose context across sessions. A 2AM cron job pulls all daily sessions, extracts vital context, updates memory files, reruns indexing, and self-improves by identifying mistakes and writing new rules. Backup cron at 2:30AM ensures reliability.
**Status:** To be implemented. See `REX_ENHANCEMENT_PLAN.md`.

---

## Act: Implementation Details

### Core Agent Orchestration
The engine in `server.mjs` manages built-in agents (Rex, Watcher, Scheduler, Processor, Generator, Lex) plus custom agents. Each has a role, system prompt, designated LLM model. Message routing, session history, and tool call parsing handled centrally.

### Rex Tools System
`rex-tools.mjs` provides 21+ real API tools: GitHub (repos, PRs, file push, merge), DigitalOcean (droplets, app restart), Discord (channels, roles, messages), Google Calendar, Stripe (customers, payments, invoices), web search (Brave/Google/DuckDuckGo fallback), PDF/Excel creation, image generation (Leonardo AI), video generation (HeyGen), email (Gmail OAuth + nodemailer), skill loading from GitHub repos.

### Connections & Credentials
UI Connections tab stores tokens in SQLite. `autoConnectServices()` seeds from env vars on startup. `getConnectionToken(serviceId)` retrieves tokens for tool execution. Google OAuth2 flow for Workspace APIs.

### Content Studio
CreatorBuddy-style suite: compose posts (platform-specific), score content (algorithm optimization), braindump ideas (raw → structured), repurpose material (cross-platform), research accounts. All stored in SQLite tables.

### Skills Library
260+ skills from OpenClaw cataloged in `skills-catalog.json` (5.8MB). Skills sourced as `revvel-custom` and `openclaw-skills-hub`. Skill loading via `load_skill` and `discover_skills` tools from `midnghtsapphire/revvel-skills-vault`.

### Loaded Expert Skills (from Memory)
The following specialized skills have been loaded and are available:
- Architecture Decision Framework, IT Strategy, Vendor Management
- SignalPipe (lead generation), Email Technology Expert
- Revvel Skill Manager CLI, S.H.I.F.T. Testing Framework
- Anti-Aging Research, Cardiovascular Disease, Neurodegenerative Disease, Nanotech Surgery, Medical Doctor
- Cybersecurity/Deepfake/Malware Expert, Epstein Files Intelligence
- Legal Brief Writing, Medical Expert Witness, Victim Advocacy
- Presidential/Government Resources, LiDAR Expert
- Marketing: Affiliate, Copywriting/Funnels, Ecommerce/Shopify, Influencer, Meta/Facebook, Podcast, X/Twitter
- Automated Business Operations, Tax Automation, Stealth Inventory Tracker, Stealth Lead Generator
- Twilio Call Center, PassiveBotAI (crypto trading)
- Coding Agent, OpenClaw Discord/Slack/Voice Call, Session Logs, Telegram Todo
- Blog Monitoring Intelligence

---

## Review: Incidents and Lessons Learned

### INC-001: April 3 Force-Push Catastrophe
**What happened:** Multiple teams (Credentials, Activity Window, Content Studio) pushed directly to `master`. Content Studio team force-pushed, overwriting all other commits. Lost `rex-tools.mjs`, Activity Window, tool-use loop.
**Resolution:** Mega-merge from git reflog. Branch protection rules added. PR workflow mandated.
**Lesson:** Never push directly to master. Never force-push. PR-only workflow enforced via CONTRIBUTING.md and GitHub branch protection.

### INC-002: Ephemeral Storage Bug
**What happened:** Connections and API keys stored in JSON files. DigitalOcean App Platform wiped them on every deploy.
**Resolution:** Migrated all persistent data to SQLite.
**Lesson:** Understand the target deployment environment's storage characteristics before designing persistence.

### INC-003: Cosmetic Connections Panel
**What happened:** Connections panel allowed token entry but tokens were never actually used by Rex tools. Connection status was purely cosmetic.
**Resolution:** Added `getConnectionToken(serviceId)` and wired Rex tools to check SQLite connections table.
**Lesson:** If a UI element accepts input, that input must be wired through to actual functionality. No cosmetic features.

### INC-004: Agent LLM Model Errors
**What happened:** Agents configured with free/cheap models (e.g., Scheduler with `mistralai/mistral-small`) hit 404 errors when models were removed from OpenRouter.
**Resolution:** Use non-free models initially, then switch to free models once agents are loaded.
**Lesson:** LLM model availability is volatile. Build fallback routing.

---

## Evolve: Roadmap

### Immediate (In Progress)
- Complete DEPLOYMENT_CONTRACT implementation — social media module, CRM, trading interface, content engine
- Fix remaining connection wiring (see REX_ENHANCEMENT_PLAN.md)
- Implement Ralph Loop for autonomous development iteration
- Implement nightly consolidation cron

### Near-Term
- MCP server setup for Rex (GitHub, filesystem, Brave, Google Workspace)
- Sub-agent spawning (Sales, Support, Trading agents)
- S.H.I.F.T. behavioral testing for all agents
- Social media automation via FOSS tools (snoowrap, twitter-api-v2, etc.)

### Medium-Term
- Claw Mart / skill marketplace integration
- Autonomous trading with Alpaca/Coinbase Pro APIs
- SSE streaming for chat responses
- Visual workflow canvas for agent pipelines
- Token cost optimization engine (route simple tasks to cheap models)

### Long-Term
- Multi-agent debate and consensus protocol
- Long-term graph memory (GraphRAG)
- Agent-to-Agent protocol (A2A/MCP interop)
- Offline mode with local LLMs (Ollama)
- Voice interface ("Hey Rex")
