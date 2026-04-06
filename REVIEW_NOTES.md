# MindMappr Agent — Code Review Notes

---

## v8.5 — Web Search, Discord Management, Legal Agent, Stripe & Calendar (April 4, 2026)

### Summary
This release adds 11 new tools across 4 categories (search, Discord, Google Calendar, Stripe), a new Lex legal counsel agent, auto-connect services from environment variables, and the Brave Search connector.

### New Agent
- **Lex** — Legal counsel AI attorney (Claude Sonnet 4). Handles contract review, ToS drafting, cease & desist, business entity advice, IP/patent analysis, compliance checks (GDPR, CCPA, ADA, FTC), legal research, and NDA templates. Always includes AI-generated legal disclaimer.

### New Tools Added
- **`web_search`** — Web search with 3-tier fallback: Brave Search API → Google Custom Search JSON API → DuckDuckGo HTML scrape. Params: `{query, numResults?}`
- **`discord_create_channel`** — Create text/voice channels in Discord. Params: `{name, type?, category?, topic?}`
- **`discord_list_channels`** — List all channels in a Discord server. Params: `{guildId?}`
- **`discord_delete_channel`** — Delete a channel by ID. Params: `{channelId}`
- **`discord_send_message`** — Send a message to a Discord channel. Params: `{channelId, message}`
- **`discord_create_role`** — Create a server role. Params: `{name, color?, permissions?}`
- **`discord_list_roles`** — List all roles in a server. Params: `{guildId?}`
- **`create_calendar_event`** — Create Google Calendar events via Calendar API v3. Params: `{title, startTime, endTime?, description?, location?}`
- **`stripe_list_customers`** — List Stripe customers. Params: `{limit?}`
- **`stripe_list_payments`** — List recent payment intents. Params: `{limit?}`
- **`stripe_create_invoice`** — Create draft invoice with line items. Params: `{customer_id, items}`

### Infrastructure
- **Auto-connect services** — `autoConnectServices()` on startup seeds connections from env vars (OpenRouter, GitHub, DigitalOcean, ElevenLabs, Stripe, Brave Search)
- **New connector** — `brave_search` added to CONNECTORS object (🔍, #FB542B)
- **Discord connector** — `getDiscordClient()` exported for channel/role management; `ChannelType` imported from discord.js; Lex aliases added

### Environment Variables Added
- `BRAVE_SEARCH_API_KEY` — Brave Search API key (optional, DuckDuckGo fallback)
- `GOOGLE_API_KEY` / `GOOGLE_SEARCH_CX` — Google Custom Search (optional)

### Files Changed
- `package.json` — version 8.5.0
- `server.mjs` — 11 new tools in executeTool, Lex agent, autoConnectServices, brave_search connector, health endpoint v8.5.0
- `rex-tools.mjs` — 11 new entries in EXTRA_TOOLS
- `discord-connector.mjs` — ChannelType import, getDiscordClient export, lex aliases
- `REVIEW_NOTES.md` — this changelog

### Quality Standards
- Full try/catch on every new tool with friendlyError() or explicit error messages
- withRetry on all network-dependent tools (search, calendar, stripe)
- Graceful "not connected" messages when services aren't configured
- All tools registered in EXTRA_TOOLS, health endpoint, and agent system prompts

---

## v8.4 — Real Tool Capabilities Upgrade (April 4, 2026)

### Summary
This release replaces all stub/limited tool implementations with real, production-grade integrations. Agents now have genuine capabilities: real PDF generation, real Excel files, Google Workspace integration, AI image generation, AI avatar video creation, and PDF form filling.

### New NPM Dependencies
- `pdfkit` — Real PDF generation with headers, paragraphs, tables, sections
- `exceljs` — Real .xlsx Excel file creation with formatting
- `googleapis` — Google Drive, Gmail, Docs, Sheets APIs
- `nodemailer` — Email sending via SMTP fallback

### New Tools Added
- **`create_real_pdf`** — pdfkit-based A4 PDF with sections, tables, headers
- **`create_spreadsheet`** — exceljs .xlsx with bold headers, auto-width, borders, multi-sheet
- **`send_email`** — Gmail API via Google OAuth; nodemailer SMTP fallback
- **`read_email`** — Gmail inbox reading with query support
- **`upload_to_drive`** — Upload files from uploads/ to Google Drive
- **`create_google_doc`** — Create Google Docs with content
- **`create_google_sheet`** — Create Google Sheets with data
- **`fill_pdf`** — PDFiller API v2: list templates or fill form fields and download

### Upgraded Tools
- **`generate_image`** — Now uses Leonardo AI (Diffusion XL) with DALL-E 3 fallback. No more ImageMagick placeholders.
- **`create_video`** — Now uses HeyGen API v2 for real AI avatar videos. No more FFmpeg static image+audio.

### Google OAuth2 Flow
- `GET /api/google/auth` — initiates OAuth2 with Gmail/Drive/Docs/Sheets/Calendar scopes
- `GET /api/google/callback` — stores tokens in SQLite connections table
- `getGoogleAccessToken()` — auto-refreshes tokens
- Env vars: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`

### Frontend Changes
- Connections tab: Google connectors show **"Connect with Google"** OAuth button (blue, Google logo SVG)
- Non-OAuth connectors unchanged

### New CONNECTORS
- `google_drive` — Google Drive, Docs & Sheets (OAuth)
- `google` — Google Workspace all-in-one (OAuth)

### Environment Variables Added
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`
- `LEONARDO_API_KEY`, `OPENAI_API_KEY`, `HEYGEN_API_KEY`
- `CLAUDE_API_KEY`, `STRIPE_SECRET_KEY`, `GITHUB_TOKEN`

### Quality Standards
- Full try/catch on every new tool, friendly error messages
- withRetry on all network-dependent tools
- Graceful "Please connect Google" messages when OAuth not configured
- Proper MIME types for all file outputs

### Files Changed
- `package.json` — new deps, version 8.4.0
- `Dockerfile` — python3-pip + scientific packages
- `server.mjs` — OAuth flow, 7 new tools, upgraded generate_image/create_video, fill_pdf
- `rex-tools.mjs` — EXTRA_TOOLS registry, updated getToolListForPrompt
- `public/index.html` — Google OAuth button in Connections tab
- `REVIEW_NOTES.md` — this file

---

# MindMappr Agent v4 — Code Review Notes (Original)

## Review Summary (Pre-Push)

### Security
- `basename()` used on all file path inputs to prevent path traversal in uploads, downloads, and deletes
- API keys stored in a local JSON file (not in env vars) — acceptable for single-user droplet; upgrade to env vars for multi-tenant
- No auth on API endpoints — acceptable for internal/personal use; add Bearer token middleware before exposing publicly
- Shell injection risk in `generate_image` and `create_video`: user-supplied strings are sanitized with `.replace(/["\\`$]/g, "")` before being passed to `execAsync`

### Error Handling
- All tool executors wrapped in try/catch returning `{success:false, error}`
- LLM errors propagate up with status code included
- Chat endpoint has top-level try/catch returning 500

### Performance
- Chat history capped at 60 messages per session (last 30 sent to LLM)
- Analytics array capped at 10,000 entries
- File reads are synchronous — fine for low-traffic personal use

### What's New in v4
- 9 execution tools: elevenlabs_tts, generate_image, create_video, create_pdf, run_python, web_scrape, create_csv, create_html, send_slack
- Chat persistence with server-side session JSON files
- Session list endpoint (`GET /api/chat/sessions`)
- File metadata tracking (creator: user vs mindmappr)
- Analytics endpoint
- Connections tab (10 services)
- New self-contained frontend (no build step required)
- Inline file previews: images, audio player, video player, file cards
- File attach in chat (multipart upload)
