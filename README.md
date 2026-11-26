# MindMappr


<!-- AUTO-PACKAGE-BADGES:START -->
<!-- Auto-generated package badges -->

![npm version](https://img.shields.io/npm/v/mindmappr-web?style=flat-square&logo=npm&color=blue) ![npm downloads](https://img.shields.io/npm/dw/mindmappr-web?style=flat-square&color=brightgreen) ![npm license](https://img.shields.io/npm/l/mindmappr-web?style=flat-square) [![Deployed](https://img.shields.io/badge/deployed-9.4.0-blue?style=flat-square)](https://www.npmjs.com/package/mindmappr-web)

<!-- AUTO-PACKAGE-BADGES:END -->
**AI-Powered GitHub Project Management Platform**

MindMappr is a comprehensive GitHub project management tool with AI-driven workflow automation.

## Features

- **AI Workflow Automation** — Automated project management
- **Discord Integration** — Real-time notifications  
- **GitHub Sync** — Automated issue/PR management
- **Rex Tools** — AI-powered developer tools (9,649 skills catalog)
- **Custom Skills** — 69 custom skills + 9,580 openclaw skills

## Tech Stack

- Node.js + Express
- Vite (frontend)
- Tailwind CSS
- Discord.js
- GitHub API

---

## Test

| Feature | Status | URL |
|--------|--------|-----|
| Server | ✅ Ready | Run: `node server.mjs` |
| Smoke Test | ✅ 3/3 Pass | Run: `node tests/smoke-test.mjs` |
| Discord | ✅ Ready | Requires credentials |
| GitHub Sync | ✅ Ready | Requires token |

**Smoke Test Results:**
```
✅ PASS: Required files exist
✅ PASS: package.json valid
✅ PASS: Skills catalog — 9649 total
```

---

## Deployment

**Production:** https://mindmappr.vercel.app (or custom domain)
**Build:** `npm run build` if Vite configured
**Start:** `node server.mjs` (port from env)

## Setup

```bash
# Install dependencies
npm install

# Run smoke test
node tests/smoke-test.mjs

# Start server
node server.mjs
```

## Environment Variables

See `.env.example` for required variables.

## Local notes

When MindMappr answers a question (the site chat, Telegram @googlieeyes_bot, or Discord), it reads the index built on the Windows laptop by `midnghtsapphire/mindmappr-brain` (`scripts/learn.ps1`) and sends the closest notes with the question to LM Studio.

The default index folder is `%USERPROFILE%\mindmappr-brain\index` (`mindmappr-brain/index` under the home directory on other systems). `learn.ps1` writes `chunks.json` there, and `embeddings.json` when an embedding model is loaded. Those files stay on the laptop. This repo does not commit them.

| Variable | Default | Purpose |
| --- | --- | --- |
| `LM_STUDIO_BASE_URL` | `http://localhost:1234/v1` | OpenAI-compatible LM Studio server |
| `LM_STUDIO_MODEL` | first loaded chat model | Model id sent to `/chat/completions` |
| `MINDMAPPR_INDEX_DIR` | home `mindmappr-brain/index` | Folder that holds `chunks.json` and `embeddings.json` |
| `MINDMAPPR_INDEX_TOP_K` | `5` | How many notes to attach (maximum 20) |
| `LM_STUDIO_API_KEY` | empty | Sent as a bearer token only when set. LM Studio does not require one. |
| `LM_STUDIO_TIMEOUT_MS` | `20000` | How long to wait on LM Studio before using the existing OpenRouter path |

- If `embeddings.json` is present and LM Studio can embed the question, notes are ranked by cosine similarity.
- Otherwise notes are ranked by keyword overlap with the question.
- Matching notes are added as a system message on the chat request. The prompt text is in `docs/prompts/system/local-notes-context.md`.
- A missing, empty, or unreadable index still sends the question to LM Studio, without notes.
- If LM Studio is not running or returns an error, the answer uses the existing OpenRouter path (`LLM_API_KEY`, `LLM_MODEL`), including a model chosen in the chat request. Notes stay on the local request. They are not sent to OpenRouter.
- `chunks.json` and `embeddings.json` are read again when their contents change.

```bash
node --test tests/knowledge-index.test.mjs
```