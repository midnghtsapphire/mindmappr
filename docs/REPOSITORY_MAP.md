# Repository Map & Documentation Structure

Every repository connected to MindMappr, their relationships, and the documentation strategy.

---

## Repository Inventory

### Core Application Repos

| Repository | Purpose | Status |
|-----------|---------|--------|
| `midnghtsapphire/mindmappr` | AI agent command center (Node.js/Express/React v9.4.0) | **Active** — production on DO App Platform |
| `midnghtsapphire/reese-reviews` | Review platform (in Deploy tab dropdown) | **Active** |
| `midnghtsapphire/revvel-skills-vault` | Rex skill YAML files (loaded via `load_skill` tool) | **Referenced** in rex-tools.mjs |

### Standards & Governance

| Repository | Purpose | Status |
|-----------|---------|--------|
| `revvel-standards` | Org-wide coding standards, compliance, governance templates, growlingeyes artifacts | **NOT IMPORTED** — critical gap per audit plan |
| `growlingeyes` | Standards/artifacts (referenced alongside revvel-standards) | **NOT IMPORTED** |

### Related Projects (from Memory)

| Project | What It Is | Relation to MindMappr |
|---------|-----------|----------------------|
| OpenClaw | AI assistant platform | 260+ skills imported into skills-catalog.json |
| OpenAudrey | Agent framework | Agents (Rex, Watcher, etc.) originated here, merged into MindMappr v6 |
| Revvel Email Organizer | AI email processing | Separate project, planned integration |
| Neurooz | Neurodivergent-friendly tech, ADHD app | Separate project — artifacts/docs mentioned but not in this repo |
| Angel Reporter | $5 market insight reports via PayPal, Python agent | Content generation component for Digital Arbitrage Academy |
| PassiveBotAI | Crypto trading bot (XGBoost + triple AI consensus) | Planned integration for autonomous trading interface |
| SignalPipe | Lead generation (Reddit/Twitter signal monitoring) | Planned integration for CRM module |
| Felix AI Model | Autonomous business agent reference architecture | Architectural inspiration — see DEPLOYMENT_CONTRACT.md |

---

## How MindMappr Connects

```
midnghtsapphire/mindmappr (CORE)
│
├── DEPLOYS TO: DigitalOcean App Platform (auto-deploy from master)
│
├── SKILLS FROM:
│   ├── midnghtsapphire/revvel-skills-vault (YAML skills via load_skill)
│   └── OpenClaw skills hub (260+ entries in skills-catalog.json)
│
├── PR MANAGEMENT (Deploy Tab):
│   ├── midnghtsapphire/mindmappr
│   └── midnghtsapphire/reese-reviews
│
├── DATA SYNC: github-sync.mjs → pushes data/ files to this repo
│
├── BOT CONNECTIONS:
│   ├── Discord: MindMappr Bot#2654 (discord-connector.mjs)
│   ├── Telegram: @googlieeyes_bot
│   └── Group: RISINGALOHA (chat ID: -1003735305867)
│
├── EXTERNAL SERVICES:
│   ├── OpenRouter (LLM gateway)
│   ├── GitHub API (repo management via Rex)
│   ├── DigitalOcean API (infrastructure via Rex)
│   ├── Google Workspace (OAuth2: Drive, Gmail, Docs, Sheets, Calendar)
│   ├── Stripe (payments for Digital Arbitrage Academy)
│   ├── PayPal (angelreporters@gmail.com — product delivery)
│   ├── Brave Search (web search with fallback chain)
│   ├── Leonardo AI (image generation)
│   ├── HeyGen (video generation)
│   └── ElevenLabs (TTS)
│
├── STANDARDS (NOT YET IMPORTED):
│   ├── revvel-standards
│   └── growlingeyes
│
└── PLANNED INTEGRATIONS:
    ├── Twitter/X API v2 (social media automation)
    ├── Reddit API (social media + lead gen)
    ├── LinkedIn API (B2B outreach)
    ├── YouTube Data API (content distribution)
    ├── Alpaca Trading API (autonomous trading)
    ├── Coinbase Pro API (crypto trading)
    ├── Alpha Vantage / CoinGecko / FRED / Yahoo Finance (market data)
    └── Claw Mart API (skill marketplace)
```

---

## Documentation Structure Decision

### Strategy: Centralize in `revvel-standards/docs/<appname>/`

With many apps, one source of truth prevents fragmentation. AI agents reference one repo for governance and cross-app context.

**Stays in app repo:**
- `AGENTS.md` — AI tools read from repo root
- `CONTRIBUTING.md` — repo-specific rules
- `REVIEW_NOTES.md` — per-version review notes
- `.github/` — CI/CD workflows
- `.env.example` — env template

**Moves to `revvel-standards/docs/<appname>/`:**
- DARE, RAID, Sprint Backlog, Enhancement Backlog
- Use Cases, Testing Strategy, Deployment Contracts
- Handoff documents, Audit plans
- Architecture decision records

### Target Structure for revvel-standards

```
revvel-standards/
├── docs/
│   ├── organization/          # Org-wide standards
│   │   ├── CODING_STANDARDS.md
│   │   ├── SECURITY_POLICY.md
│   │   ├── BRANCHING_STRATEGY.md
│   │   └── EXRUP_METHODOLOGY.md
│   ├── mindmappr/
│   │   ├── DARE.md
│   │   ├── RAID.md
│   │   ├── DEPLOYMENT_CONTRACT.md
│   │   ├── USE_CASES.md
│   │   ├── TESTING_STRATEGY.md
│   │   ├── REX_ENHANCEMENT_PLAN.md
│   │   ├── SPRINT_BACKLOG.md
│   │   ├── TODO_ITEMS.md
│   │   ├── ENHANCEMENT_BACKLOG.md
│   │   ├── RELEASE_NOTES.md
│   │   └── HANDOFF.md
│   ├── reese-reviews/
│   │   ├── DARE.md
│   │   └── RAID.md
│   ├── neurooz/
│   │   ├── DARE.md
│   │   ├── RAID.md
│   │   └── artifacts/         # neurooz artifacts from docs folder
│   ├── angel-reporter/
│   │   └── DARE.md
│   └── email-organizer/
│       └── DARE.md
├── templates/                 # Reusable doc templates
│   ├── DARE_TEMPLATE.md
│   ├── RAID_TEMPLATE.md
│   ├── HANDOFF_TEMPLATE.md
│   ├── USE_CASES_TEMPLATE.md
│   └── DEPLOYMENT_CONTRACT_TEMPLATE.md
└── growlingeyes/              # growlingeyes standards artifacts
    └── (imported here)
```

### Interim (Now)
Docs stay in `mindmappr/docs/`. When `revvel-standards` is configured:
1. Move docs to `revvel-standards/docs/mindmappr/`
2. Leave `docs/README.md` in mindmappr pointing to new location
3. Keep AGENTS.md, CONTRIBUTING.md, REVIEW_NOTES.md in mindmappr root

---

## Action Items

1. **Create revvel-standards repo** — set up `docs/<appname>` structure
2. **Import growlingeyes** — move into `revvel-standards/growlingeyes/`
3. **Import neurooz artifacts** — move into `revvel-standards/docs/neurooz/`
4. **Audit revvel-skills-vault** — confirm canonical source for YAML skills
5. **Update Deploy tab** — add repos beyond mindmappr and reese-reviews (public/index.html line 860)
6. **Manus references** — removed from skills-catalog.json (4 entries)
7. **Credential scrubbing** — remove API keys from MEMORY.md (see RAID ISS-010)
