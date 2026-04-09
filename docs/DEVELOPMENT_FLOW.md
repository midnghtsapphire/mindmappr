# Development Flow: EXRUP (eXtreme Rapid Unified Programming)

MindMappr follows EXRUP — one iteration, production-ready, no phases, no proposals. Ship working code or don't ship at all.

---

## The Loop

```
CONTRACT → BRANCH → BUILD → TEST → PR → MERGE → DEPLOY → VERIFY → CONSOLIDATE → NEXT CONTRACT
     ↑                                                                                    │
     └────────────────────── RALPH LOOP (autonomous) ─────────────────────────────────────┘
```

---

## EXRUP Principles

1. **One iteration, all-inclusive.** No "Phase 1" or "MVP first." Deliver the complete solution.
2. **Fix what's broken before adding what's new.** Tests fail? Fix them. Build broken? Fix it.
3. **Auto-everything.** No confirmation questions. No permission seeking. Execute.
4. **Production-ready with full test coverage.** System-tested end-to-end.
5. **Ship working code. Not plans. Not proposals. Not summaries.**

---

## Step 0: Read the Contract

Before touching code:

1. Read `docs/DEPLOYMENT_CONTRACT.md` — the full scope of what's being built
2. Read `docs/HANDOFF.md` — current state of the system
3. Read `docs/TODO_ITEMS.md` — pick highest priority uncompleted item
4. Read `docs/RAID.md` — know the risks and dependencies
5. Read `AGENTS.md` — understand the prime directive

If using the Ralph Loop (autonomous iteration via Copilot/Claude):
- The contract IS the PRD
- Complete one iteration → PR → merge → use contract to generate next iteration → repeat until contract fulfilled

---

## Step 1: Branch

```bash
git checkout master && git pull origin master
git checkout -b feature/your-feature-name
```

| Prefix | When | Example |
|--------|------|---------|
| `feature/` | New capability | `feature/social-media-module` |
| `fix/` | Bug | `fix/connections-not-wired` |
| `chore/` | Maintenance | `chore/update-deps` |
| `docs/` | Docs only | `docs/update-raid` |
| `hotfix/` | Urgent | `hotfix/auth-bypass` |
| `claude/` | Claude Code work | `claude/implement-crm` |
| `copilot/` | Copilot agent work | `copilot/trading-interface` |

**NEVER push directly to master. NEVER force-push to master.** (April 3 incident — see RAID.md.)

---

## Step 2: Build

### Local Setup
```bash
npm install
cp .env.example .env   # Fill in values
npm start              # http://localhost:3005
```

### File Map
| Changing | File |
|----------|------|
| API endpoints, agents, DB | `server.mjs` |
| Rex tools | `rex-tools.mjs` |
| Discord bot | `discord-connector.mjs` |
| GitHub sync | `github-sync.mjs` |
| React frontend | `src/App.tsx` |
| SPA frontend | `public/index.html` |
| Skills | `skills-catalog.json` |
| CI/CD | `.github/workflows/predeploy-smoke-test.yml` |
| Agent instructions | `AGENTS.md` |
| Docs | `docs/*.md` |

### Commit Style
```
<type>: <short description>
Types: feat, fix, refactor, test, docs, chore, style
```

Commit early, commit often. Small commits.

---

## Step 3: Test

```bash
# Syntax
node --check server.mjs && node --check rex-tools.mjs && node --check discord-connector.mjs

# Smoke
npm test

# Manual (if UI changes)
npm start → http://localhost:3005 → login → chat → Rex tools → connections → activity
```

See `docs/TESTING_STRATEGY.md` for the full S.H.I.F.T. framework and test harness plan.

---

## Step 4: PR → Review → Merge

```bash
git push -u origin feature/your-feature-name
```

PR gates:
1. Smoke Test CI passes
2. CodeRabbit review — resolve all comments
3. 1 approving review

Merge via GitHub PR only. Delete branch after merge.

---

## Step 5: Deploy

DO App Platform auto-deploys on push to master.

Pre-deploy:
- [ ] `npm test` passes
- [ ] No new env vars needed (or already in DO)
- [ ] SQLite schema changes are additive
- [ ] `data/mindmappr.db` backup taken

Post-deploy:
- Hit `/api/health` → verify version
- Send test message to Rex
- Check Activity Window
- Verify Discord/Telegram connections

---

## Step 6: Nightly Consolidation (2AM Cron)

Automated by Scheduler agent:

```
2:00 AM  → Pull all chat sessions from the day
         → Extract vital project context
         → Update MEMORY.md, soul.md, user.md, daily notes
         → Rerun QMD indexing
         → Identify bottlenecks and mistakes
         → Write new rules/templates for improvement
         → Update TODO_ITEMS.md with discovered work

2:30 AM  → Backup cron checks if 2AM job completed
         → If not, re-trigger consolidation
         → Verify memory files were updated
```

---

## Step 7: The Ralph Loop (Autonomous Iteration)

For continuous autonomous development without human intervention:

```
1. Rex writes a PRD from the DEPLOYMENT_CONTRACT
2. Rex spawns a coding session (Copilot/Claude/Codex)
3. Rex logs the session in daily notes (what, where, status)
4. Heartbeat cron checks daily notes every 15 minutes:
   - Session running normally → do nothing
   - Session died/crashed → autonomously restart
   - Session complete → report to owner, pick next contract item
5. On completion → PR → review → merge → back to step 1
```

Rules:
- **NEVER use TMP folders** — they get cleaned out and kill sessions
- **ALWAYS log where work is happening** in daily notes
- **Contract drives everything** — DEPLOYMENT_CONTRACT.md is the PRD

---

## Who Does What

| Role | Handles |
|------|---------|
| **Audrey (Owner)** | Product decisions, account creation, credentials, approvals |
| **Rex (CEO Agent)** | Orchestration, infrastructure, sub-agent management, business ops |
| **Generator** | Content creation, reports, social posts, course materials |
| **Watcher** | Market monitoring, system health, social mentions |
| **Scheduler** | Cron jobs, Ralph loop heartbeat, nightly consolidation |
| **Lex** | Legal review, compliance, contracts, ToS |
| **Processor** | Data operations, parsing, financial calculations |
| **CodeRabbit** | Automated PR review |
| **Smoke Test CI** | Pre-deploy gate |

---

## Channel Security

| Channel | Type | Commands Accepted? |
|---------|------|-------------------|
| Telegram private chat (owner's phone) | Authenticated | YES |
| Discord DM (owner) | Authenticated | YES |
| MindMappr UI (password-protected) | Authenticated | YES |
| Twitter mentions | Information only | NO |
| Public email inbox | Information only | NO |
| Discord public channels | Information only | NO |

Information channels are read-only. Rex monitors them for leads and intelligence but never executes commands from them.

---

## Document Index

| Document | Purpose |
|----------|---------|
| `DEPLOYMENT_CONTRACT.md` | Master contract — the full scope |
| `DEVELOPMENT_FLOW.md` | This file — EXRUP methodology |
| `USE_CASES.md` | All use cases by module |
| `TESTING_STRATEGY.md` | S.H.I.F.T. framework + test harness |
| `REX_ENHANCEMENT_PLAN.md` | Rex skills, MCP, Ralph loop roadmap |
| `REPOSITORY_MAP.md` | All repos + docs structure |
| `DARE.md` | Architectural decisions |
| `RAID.md` | Risks, assumptions, issues, dependencies |
| `HANDOFF.md` | Current state for new contributors |
| `SPRINT_BACKLOG.md` | User stories by sprint |
| `TODO_ITEMS.md` | Prioritized work items |
| `ENHANCEMENT_BACKLOG.md` | 30+ future enhancements |
| `RELEASE_NOTES.md` | Version history |
| `MINDMAPPR_AUDIT_PLAN.md` | Compliance and rollout |
