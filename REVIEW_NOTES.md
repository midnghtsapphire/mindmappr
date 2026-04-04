# MindMappr Agent — Code Review Notes

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
