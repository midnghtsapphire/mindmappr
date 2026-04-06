# MindMappr Audit, Compliance, and Rollout Plan

This document captures the current state of MindMappr, gaps blocking compliance, and a phased upgrade and rollout plan. Sources reviewed: `server.mjs`, `rex-tools.mjs`, `discord-connector.mjs`, `github-sync.mjs`, `src/`, `docs/RAID.md`, `docs/DARE.md`, `docs/TODO_ITEMS.md`, `docs/ENHANCEMENT_BACKLOG.md`, `docs/SPRINT_BACKLOG.md`, `tests/smoke-test.mjs`, and `skills-catalog.json`. No `revvel-standards` or `growlingeyes` artifacts are present in this repo; ingest them when available and re-run this checklist.

## Current Snapshot
- **Architecture:** Single-file backend (`server.mjs` ~3k+ lines) handles auth, agent orchestration, API endpoints, cron, Discord/Telegram bridges, GitHub syncing, and SQLite access. Frontend lives in `src/` (Vite React UI) plus `public/` SPA served from Express.
- **Data & memory:** SQLite (`data/mindmappr.db`) with agent tables (`agent_tasks`, `agent_activity`, `custom_agents`, `scheduled_tasks`, `content_studio_*`, `connections`, `skills`, `facts`, `user_preferences`, etc.) plus file-backed memory (`data/MEMORY.md`, `data/soul.md`, `data/user.md`, daily notes).
- **Integrations:** OpenRouter LLMs, Discord bot, Telegram webhook, GitHub + DigitalOcean tools, Google OAuth, Stripe scaffolding in prompts, cron via `node-cron`, PDF/Excel generators.
- **Security posture:** Password gate with default `APP_PASSWORD` fallback, tokens stored in SQLite (no encryption), env-seeded connections, no prompt-injection filter, no rate limiting on APIs, no HITL for destructive tools.
- **Testing & ops:** Only smoke test (`npm test`) with skips when `node_modules` is absent; no unit/integration coverage. No `.env.example`. Branch protection not enforced (risk noted in RAID/DARE). Dockerfile present; no build script.

## Gaps and Risks (priority-ordered)
1. **Standards parity:** `revvel-standards` and `growlingeyes` references are missing, so compliance cannot be proven; no import/checklist automation exists.
2. **Security & safety:** Default password; no prompt-injection guard; destructive tools execute without approval; tokens stored unhashed; no audit logging for privileged actions; no rate limiting or CSRF protection.
3. **Reliability & change safety:** Monolithic server file, no migrations for schema drift, no automated tests around agents/tools/APIs, health checks rely on runtime only, no feature flags for risky rollouts.
4. **Data integrity:** SQLite writes lack backups/snapshots; GitHub sync exists but restore path not rehearsed; no validation on external payloads (webhooks, uploads, Google callbacks).
5. **Docs & runbooks:** No README or operator runbook; no rollback SOP; env requirements implicit; backlog spread across multiple docs without single authoritative view.

## Improvement Plan (phased, non-destructive)
**Phase 0 — Standards & baseline**
- Import `revvel-standards` and `growlingeyes` canonical docs into `docs/standards/` and map them to current endpoints, tools, and UI flows.
- Add `.env.example` with required/optional keys (APP_PASSWORD, LLM_API_KEY/OPENROUTER_API_KEY, GITHUB_PAT/TOKEN, DO_API_TOKEN, DISCORD_BOT_TOKEN, TELEGRAM_BOT_TOKEN, GOOGLE_*).
- Add top-level `README.md` summarizing run/deploy steps, linking to RAID/DARE/backlog, and the new audit/rollout doc.

**Phase 1 — Security & guardrails (aligns with TODO SEC-01/02)**
- Add prompt-injection sanitizer before agent routing and log blocked prompts.
- Add HITL gating for destructive tools (`github_merge_pr`, DO actions, Stripe billing) with approval status surfaced to UI.
- Replace default password with required env var; add rate limits and audit logs for auth, tool execution, and webhooks.
- Encrypt tokens at rest in SQLite (per-tenant secret derived from env) and scrub secrets from logs.

**Phase 2 — Reliability & observability (aligns with TODO ARCH-01, ENHANCEMENT backlog)**
- Refactor `server.mjs` into modules (routes, agents, tools, auth, storage) with shared error-handling middleware.
- Add migration runner for SQLite (e.g., `better-sqlite3-migrations` or custom), including backup/export before applying.
- Expand tests: API smoke for `/api/health`, `/api/chat`, tool execution happy path with mocks, connection flows; keep `tests/smoke-test.mjs` as predeploy gate.
- Add structured logging + tracing per request/agent task; emit metrics for agent cost, tool failures, webhook latency.

**Phase 3 — Product completeness**
- Implement SSE streaming for chat responses; add feature-flag toggle.
- Add workflow/agent backlog sync between UI and DB (user-entered + agent-generated tasks) with ownership and SLA fields.
- Harden upload path (size/type limits), add checksum + metadata to `file_meta`, and surface download URLs with signed tokens if exposed publicly.

## Rollout & Rollback Playbook
- **Pre-deploy:** Backup `data/mindmappr.db` (copy + gzip), capture Git SHA, export `data/*.md`. Verify `npm test` and smoke tests pass with dependencies installed.
- **Canary:** Deploy to staging or a single DO App instance with feature flags off; run health (`/api/health`), chat, tool smoke (GitHub list, DO list), and webhook checks (Telegram/Discord).
- **Gradual enable:** Toggle features (prompt guard, HITL, SSE) per flag; monitor agent cost/error metrics and DB locks.
- **Rollback:** If errors > agreed threshold or auth/tool failures occur, revert to prior image/commit, restore `mindmappr.db` backup, clear new migrations, and disable new flags. Announce status in Discord/Telegram channels.

## Backlog Consolidation (agent-executable vs owner actions)
- **Agent-executable (prioritized):**  
  - Implement prompt guard + logging (SEC-01)  
  - Add HITL for destructive tools (SEC-02)  
  - Add self-healing tool retries with bounded attempts (ARCH-01)  
  - Add `/api/health` deep checks (DB, GitHub, DO, LLM) and surface in UI  
  - Add migration runner + automated backup/export command  
  - Add SSE chat streaming behind feature flag  
  - Add workflow/backlog endpoints for user + agent-created tasks (status/owner/SLA)
- **Owner/ops actions:**  
  - Provide `revvel-standards` and `growlingeyes` source docs; approve mapping to enforcement checks.  
  - Configure branch protection (require PRs, lint/test checks, no force-push).  
  - Set non-default `APP_PASSWORD`, rotate tokens, and store in DO secrets.  
  - Approve staging environment for canary rollouts; schedule weekly DB backups.  
  - Decide encryption key management approach for SQLite secrets (env-based or KMS).

## Why agents fail to “ship” and fixes
- **Root causes:** No enforced PR workflow or tests; missing standards documents; monolithic server hinders parallel work; destructive tools lack HITL; absent feature flags makes rollouts risky; credentials defaults slow onboarding.  
- **Fixes:** Enforce branch protection + required checks; add prompt/HITL/flag layers; modularize server and add smoke/API tests; publish standards + env template; adopt staged deploy + backup/rollback routine; keep a single authoritative backlog (above) surfaced in UI for both agent- and user-created tasks.
