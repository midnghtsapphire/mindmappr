# MindMappr Agent v4 — Code Review Notes

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
