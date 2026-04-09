# Use Cases: MindMappr Command Center

Every module, every actor, every flow. These are what the system MUST do — not aspirational, not "nice to have." If it's listed here, it gets built and tested.

---

## Module 1: Agent Chat System

### UC-CHAT-001: Basic Agent Conversation
- **Actor:** User
- **Trigger:** User types message in chat
- **Flow:** Message → OpenRouter LLM → response displayed in chat
- **Agents:** Any (Rex, Generator, Watcher, Scheduler, Processor, Lex, custom)
- **Success:** Agent responds within 10 seconds with relevant, actionable content
- **Current Status:** WORKING

### UC-CHAT-002: Agent Tool Execution via Chat
- **Actor:** User
- **Trigger:** User asks Rex to perform an action ("create a repo", "list my droplets")
- **Flow:** Message → Rex → tool call parsed → rex-tools.mjs executes → result returned to chat
- **Success:** Tool executes, result displayed, Activity Window updated
- **Current Status:** PARTIALLY WORKING — tools execute but connections often fail

### UC-CHAT-003: Multi-Agent Routing
- **Actor:** User
- **Trigger:** User selects specific agent from Agent Cards
- **Flow:** Click agent card → chat session opens with that agent's system prompt
- **Success:** Each agent responds in character with their specialization
- **Current Status:** WORKING — but agents don't actually delegate between each other

### UC-CHAT-004: Custom Agent Creation
- **Actor:** User
- **Trigger:** User fills out custom agent form (name, model, role, prompt, icon, color)
- **Flow:** Form submit → saved to SQLite custom_agents → appears in Agents tab
- **Success:** Custom agent is invocable in chat
- **Current Status:** WORKING

### UC-CHAT-005: Multi-Agent Delegation
- **Actor:** Rex
- **Trigger:** Complex task requiring multiple specializations
- **Flow:** Rex analyzes task → delegates subtasks to Watcher/Generator/Processor → collects results → synthesizes response
- **Success:** Coordinated multi-agent execution visible in Activity Window
- **Current Status:** NOT WORKING — agents can't delegate to each other

---

## Module 2: Connections & API Management

### UC-CONN-001: Store API Token
- **Actor:** User
- **Trigger:** User enters token in Connections tab
- **Flow:** Token input → POST /api/connections → stored in SQLite connections table
- **Success:** Token persists across restarts, agent tools can retrieve it
- **Current Status:** PARTIALLY WORKING — tokens save but many are not actually used by tools

### UC-CONN-002: Auto-Connect from Environment Variables
- **Actor:** System (on startup)
- **Trigger:** Server starts
- **Flow:** autoConnectServices() reads env vars → seeds connections table
- **Success:** All env-var services show "Connected" in UI
- **Current Status:** WORKING for services with env vars set

### UC-CONN-003: Google OAuth Connection
- **Actor:** User
- **Trigger:** User clicks "Connect with Google" in Connections tab
- **Flow:** Redirect → Google OAuth consent → callback → tokens stored in SQLite
- **Success:** Gmail, Drive, Docs, Sheets, Calendar all accessible
- **Current Status:** BROKEN — OAuth flow fails, no active authenticated session even with credentials. Scope issues. Manual UI connection required but doesn't complete.

### UC-CONN-004: Verify Connection Actually Works
- **Actor:** User or Agent
- **Trigger:** User clicks "Test" on a connection, or agent attempts to use a service
- **Flow:** Test API call → success/failure → status updated in UI
- **Success:** Green check = actually works, Red X = actually broken
- **Current Status:** NOT IMPLEMENTED — connection status is cosmetic only. Shows "connected" even when the underlying API call fails.

### UC-CONN-005: Stripe Payment Processing
- **Actor:** Rex or automated workflow
- **Trigger:** Customer purchase or invoice creation
- **Flow:** Stripe API call → payment processed → confirmation sent
- **Success:** Real money received in Stripe account
- **Current Status:** SCAFFOLDING ONLY — tools exist (list_customers, create_invoice) but end-to-end payment flow not wired

### UC-CONN-006: PayPal Invoice Creation
- **Actor:** Rex or Generator
- **Trigger:** Product sold, need to collect payment
- **Flow:** Create PayPal invoice → send to customer email → track payment
- **Success:** Invoice sent, payment received at angelreporters@gmail.com
- **Current Status:** NOT IMPLEMENTED — PayPal credentials exist but no tool in rex-tools.mjs

### UC-CONN-007: Social Media API Connection
- **Actor:** User provides API keys, Rex uses them
- **Trigger:** Social media posting or monitoring needed
- **Flow:** Store API keys → tools call Twitter/Reddit/LinkedIn/Discord APIs
- **Success:** Posts created, engagement tracked, leads captured
- **Current Status:** NOT IMPLEMENTED — no Twitter/Reddit/LinkedIn posting tools exist. Discord posting works via discord-connector.mjs.

---

## Module 3: Rex Tools & Infrastructure

### UC-REX-001: GitHub Repository Management
- **Actor:** Rex
- **Trigger:** User asks to create repo, list repos, push files, create/merge PRs
- **Flow:** Rex tool call → GitHub API → result
- **Tools:** github_create_repo, github_list_repos, github_push_file, github_create_pr, github_merge_pr, github_list_prs
- **Success:** Repos created, files pushed, PRs managed
- **Current Status:** WORKING when GITHUB_PAT is set

### UC-REX-002: DigitalOcean Infrastructure
- **Actor:** Rex
- **Trigger:** User asks to manage droplets, apps, deployments
- **Flow:** Rex tool call → DO API → result
- **Tools:** do_list_droplets, do_list_apps, do_restart_app
- **Success:** Infrastructure managed autonomously
- **Current Status:** WORKING when DO_API_TOKEN is set

### UC-REX-003: Web Search
- **Actor:** Rex
- **Trigger:** User asks to search the web
- **Flow:** Brave Search API → fallback Google Custom Search → fallback DuckDuckGo scrape
- **Tools:** web_search
- **Success:** Relevant search results returned
- **Current Status:** WORKING — 3-tier fallback

### UC-REX-004: Skill Loading from External Sources
- **Actor:** Rex
- **Trigger:** User asks to load a skill from GitHub
- **Flow:** load_skill → fetch YAML from GitHub → register in skills table
- **Tools:** load_skill, discover_skills, scan_repo_skills
- **Success:** Skill loaded and available for invocation
- **Current Status:** PARTIALLY WORKING — many skills 404 because they're OpenClaw format, not MindMappr format. Platform mismatch.

### UC-REX-005: PDF Generation
- **Actor:** Rex or Generator
- **Trigger:** User asks for a PDF report
- **Flow:** create_real_pdf → pdfkit → A4 PDF with sections, tables, headers
- **Success:** PDF saved to uploads/, downloadable
- **Current Status:** WORKING

### UC-REX-006: Spreadsheet Generation
- **Actor:** Rex or Processor
- **Trigger:** User asks for Excel file
- **Flow:** create_spreadsheet → exceljs → .xlsx with formatting
- **Success:** Spreadsheet saved to uploads/, downloadable
- **Current Status:** WORKING

### UC-REX-007: Email Send/Read
- **Actor:** Rex
- **Trigger:** User asks to send or read email
- **Flow:** Gmail API via OAuth → send/read → result
- **Tools:** send_email, read_email
- **Success:** Email sent or inbox displayed
- **Current Status:** BROKEN — depends on UC-CONN-003 (Google OAuth broken)

### UC-REX-008: Google Drive Upload
- **Actor:** Rex
- **Trigger:** User asks to upload file to Drive
- **Flow:** upload_to_drive → Google Drive API → file uploaded
- **Success:** File in Drive, shareable link returned
- **Current Status:** BROKEN — depends on UC-CONN-003

### UC-REX-009: Calendar Event Creation
- **Actor:** Rex or Scheduler
- **Trigger:** User asks to create calendar event
- **Flow:** create_calendar_event → Google Calendar API → event created
- **Success:** Event on calendar
- **Current Status:** BROKEN — depends on UC-CONN-003

### UC-REX-010: Image Generation
- **Actor:** Rex or Generator
- **Trigger:** User asks for an image
- **Flow:** generate_image → Leonardo AI → fallback DALL-E 3
- **Success:** Image saved to uploads/
- **Current Status:** WORKING when LEONARDO_API_KEY set

### UC-REX-011: Video Generation
- **Actor:** Rex or Generator
- **Trigger:** User asks for a video
- **Flow:** create_video → HeyGen API → AI avatar video
- **Success:** Video saved to uploads/
- **Current Status:** WORKING when HEYGEN_API_KEY set

### UC-REX-012: Discord Channel Management
- **Actor:** Rex
- **Trigger:** User asks to manage Discord
- **Flow:** discord_create_channel, discord_send_message, etc. → Discord API
- **Success:** Channels created, messages sent, roles managed
- **Current Status:** WORKING when Discord bot connected

---

## Module 4: Content Studio

### UC-CS-001: Compose Marketing Content
- **Actor:** User via Content Studio tab
- **Trigger:** User selects "Compose" and provides topic + platform
- **Flow:** Generator agent → platform-optimized content → saved to content_studio_posts
- **Success:** Post ready for publishing with platform-specific formatting
- **Current Status:** WORKING

### UC-CS-002: Score Content
- **Actor:** User via Content Studio
- **Trigger:** User submits content for scoring
- **Flow:** Generator analyzes against platform algorithm → score 0-100 with suggestions
- **Success:** Actionable score with improvement recommendations
- **Current Status:** WORKING

### UC-CS-003: Braindump to Draft
- **Actor:** User
- **Trigger:** User pastes raw thoughts
- **Flow:** Generator → structured draft → saved to content_studio_braindumps
- **Success:** Raw ideas transformed into publishable content
- **Current Status:** WORKING

### UC-CS-004: Repurpose Content
- **Actor:** User
- **Trigger:** User provides URL or existing content
- **Flow:** Generator → multiple platform versions (blog → tweet thread → LinkedIn → email)
- **Success:** One piece of content becomes 4-5 platform-specific versions
- **Current Status:** WORKING

### UC-CS-005: Generate Market Analysis Report (Digital Arbitrage Academy)
- **Actor:** Rex + Generator
- **Trigger:** Scheduled (6AM daily) or manual request
- **Flow:** web_search for market data → Processor analyzes → Generator writes report → create_real_pdf → upload_to_drive → email to subscribers
- **Success:** PDF report generated, delivered to paying subscribers
- **Current Status:** NOT WORKING END-TO-END — individual pieces work but the pipeline isn't wired together. Google OAuth broken breaks delivery.

### UC-CS-006: Auto-Post to Social Media
- **Actor:** Generator + scheduled workflow
- **Trigger:** Content Studio creates post → scheduled for publishing
- **Flow:** Content → platform API → posted to Twitter/Reddit/LinkedIn
- **Success:** Content published across platforms automatically
- **Current Status:** NOT IMPLEMENTED — no social media posting tools

### UC-CS-007: Create Course Materials
- **Actor:** Generator
- **Trigger:** User requests course module for Digital Arbitrage Academy
- **Flow:** Generator → structured curriculum → PDFs → uploaded to Drive
- **Success:** Complete course module with lessons, exercises, resources
- **Current Status:** PARTIALLY WORKING — content generation works, delivery chain broken

---

## Module 5: Activity Window & Observability

### UC-AW-001: Real-Time Agent Status
- **Actor:** User
- **Trigger:** User opens Activity tab
- **Flow:** GET /api/activity/live → agent statuses from agent_activity table
- **Success:** Virtual office view showing what each agent is doing
- **Current Status:** WORKING

### UC-AW-002: Tool Execution Logging
- **Actor:** System
- **Trigger:** Any tool executes
- **Flow:** Tool result → logged to agent_activity → displayed in Activity Window
- **Success:** Complete audit trail of all tool executions
- **Current Status:** WORKING

### UC-AW-003: Task History
- **Actor:** User
- **Trigger:** User checks task history
- **Flow:** agent_tasks table → list of completed/failed tasks with timing and cost
- **Success:** Full history with status, duration, token cost
- **Current Status:** WORKING

---

## Module 6: Scheduling & Automation

### UC-SCHED-001: Create Cron Job
- **Actor:** User
- **Trigger:** User defines scheduled task
- **Flow:** POST /api/schedule → stored in scheduled_tasks → node-cron executes
- **Success:** Task runs on schedule
- **Current Status:** WORKING

### UC-SCHED-002: Daily Market Analysis Pipeline
- **Actor:** Scheduler
- **Trigger:** 6:00 AM cron
- **Flow:** Scan market data → generate report → create social posts → email subscribers → post to Reddit
- **Success:** Full pipeline executes autonomously before market open
- **Current Status:** NOT WORKING — pipeline not wired, Google OAuth broken, no social posting tools

### UC-SCHED-003: Nightly Memory Consolidation
- **Actor:** Scheduler
- **Trigger:** 2:00 AM cron
- **Flow:** Pull day's sessions → extract context → update MEMORY.md/daily notes → reindex → self-improve
- **Success:** Memory fresh every morning, mistakes identified and corrected
- **Current Status:** NOT IMPLEMENTED — concept documented but cron not built

### UC-SCHED-004: Ralph Loop Heartbeat
- **Actor:** Scheduler
- **Trigger:** Every 15 minutes
- **Flow:** Check daily notes for active coding sessions → verify alive → restart if crashed → report if complete
- **Success:** Autonomous development continues without human intervention
- **Current Status:** NOT IMPLEMENTED

---

## Module 7: Deploy Center

### UC-DEPLOY-001: View Open PRs
- **Actor:** User
- **Trigger:** User opens Deploy tab
- **Flow:** Select repo from dropdown → GET GitHub PRs → display list
- **Success:** All open PRs visible with status
- **Current Status:** WORKING

### UC-DEPLOY-002: Merge PR from UI
- **Actor:** User
- **Trigger:** User clicks Merge on a PR
- **Flow:** github_merge_pr → PR merged
- **Success:** PR merged, deploy triggered
- **Current Status:** WORKING when GITHUB_PAT set

---

## Module 8: Revenue Generation (Digital Arbitrage Academy)

### UC-REV-001: Sell Market Analysis Report ($5-$20)
- **Actor:** Rex + Generator + automated pipeline
- **Trigger:** Customer requests report or scheduled content
- **Flow:** Generate report → create PDF → create PayPal invoice → deliver via email/Drive
- **Success:** Customer pays, receives report, revenue tracked
- **Current Status:** NOT WORKING — no PayPal tool, Google delivery broken

### UC-REV-002: Sell Academy Course ($47-$197)
- **Actor:** Rex + Generator
- **Trigger:** Customer enrolls via payment link
- **Flow:** Stripe payment → onboarding email sequence → drip course materials → track engagement
- **Success:** Customer enrolled, materials delivered, revenue tracked
- **Current Status:** NOT WORKING — Stripe scaffolding only, email broken

### UC-REV-003: Lead Generation via Social Media
- **Actor:** Rex + Generator + Watcher
- **Trigger:** Monitoring keywords on Reddit/Twitter/LinkedIn
- **Flow:** Watcher monitors → identifies buying signals → Generator creates engagement post → Rex captures lead → automated follow-up
- **Success:** Email captured, added to CRM, nurture sequence started
- **Current Status:** NOT WORKING — no social media monitoring tools, no CRM

### UC-REV-004: Automated Email Sequences
- **Actor:** Scheduler + Generator
- **Trigger:** New lead enters CRM
- **Flow:** Welcome email → value drip (day 1, 3, 5, 7) → offer → follow-up
- **Success:** Automated nurture converts leads to customers
- **Current Status:** NOT WORKING — email broken, no CRM, no sequence engine

### UC-REV-005: Track Revenue Across All Streams
- **Actor:** Processor + Analytics Dashboard
- **Trigger:** Daily or on-demand
- **Flow:** Pull Stripe data + PayPal data → calculate totals → display dashboard
- **Success:** Single view of all revenue with per-channel breakdown
- **Current Status:** NOT IMPLEMENTED

---

## Module 9: Trading Interface (Future)

### UC-TRADE-001: Real-Time Market Data
- **Actor:** Watcher
- **Trigger:** Market open or on-demand
- **Flow:** Alpha Vantage/CoinGecko/Yahoo Finance API → data displayed
- **Success:** Live market data in dashboard
- **Current Status:** NOT IMPLEMENTED

### UC-TRADE-002: Automated Trade Execution
- **Actor:** Rex + PassiveBotAI logic
- **Trigger:** Signal generated by analysis
- **Flow:** 15 safety checks → Triple AI consensus → execute via Alpaca/Coinbase → log result
- **Success:** Trade executed with risk controls, P&L tracked
- **Current Status:** NOT IMPLEMENTED

### UC-TRADE-003: Portfolio Tracking
- **Actor:** Processor
- **Trigger:** On-demand or scheduled
- **Flow:** Pull positions from broker APIs → calculate performance → display
- **Success:** Current portfolio with gains/losses
- **Current Status:** NOT IMPLEMENTED

---

## Priority Matrix

### P0 — Fix What's Broken (Before Anything Else)
| Use Case | Problem | Fix |
|----------|---------|-----|
| UC-CONN-003 | Google OAuth broken | Debug OAuth flow, fix scope/redirect issues |
| UC-CONN-004 | Connection status is cosmetic | Add real health checks per connection |
| UC-REX-004 | Skills 404 (OpenClaw ≠ MindMappr) | Create MindMappr-native skill format |
| UC-CONN-007 | No social media posting tools | Build Twitter/Reddit/LinkedIn tools |
| UC-CONN-006 | No PayPal tool | Build PayPal invoice/payment tool |

### P1 — Wire the Revenue Pipeline
| Use Case | What's Needed |
|----------|--------------|
| UC-CS-005 | Wire daily report pipeline end-to-end |
| UC-REV-001 | PayPal integration + Google Drive delivery |
| UC-REV-003 | Social media monitoring + lead capture |
| UC-SCHED-002 | Daily market analysis cron |
| UC-SCHED-003 | Nightly consolidation cron |

### P2 — Scale
| Use Case | What's Needed |
|----------|--------------|
| UC-CHAT-005 | Multi-agent delegation protocol |
| UC-REV-002 | Stripe course enrollment flow |
| UC-REV-004 | Email sequence engine |
| UC-SCHED-004 | Ralph Loop heartbeat |
| UC-TRADE-001-003 | Trading interface |
