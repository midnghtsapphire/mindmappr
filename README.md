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

When MindMappr answers a question in site chat, Telegram @googlieeyes_bot, Discord, or a direct question to a built-in agent, it reads the index built on the Windows laptop by `midnghtsapphire/mindmappr-brain` (`scripts/learn.ps1`) and sends the closest notes with the question to LM Studio. Content studio, scheduled tasks, a chat request that names its own model, and a custom agent with a saved model stay on the existing OpenRouter path.

The DigitalOcean app at mind-mappr.com runs in its own container. That container does not have the laptop index or LM Studio. There, the same code finds no notes, cannot reach `localhost:1234`, and answers through OpenRouter. Notes are used when this server runs on the machine that holds the index and LM Studio.

The default index folder is `%USERPROFILE%\mindmappr-brain\index` (`mindmappr-brain/index` under the home directory on other systems). `learn.ps1` writes `chunks.json` there, and `embeddings.json` when an embedding model is loaded. Those files stay on the laptop. This repo does not commit them.

| Variable | Default | Purpose |
| --- | --- | --- |
| `LM_STUDIO_BASE_URL` | `http://localhost:1234/v1` | OpenAI-compatible LM Studio server |
| `LM_STUDIO_MODEL` | unset: a model LM Studio reports as loaded, preferring a tool-capable name such as qwen when one is loaded; otherwise the first loaded chat model. Models at 20B and above, including a 27B model, are not chosen unless this is set. | Model id sent to `/chat/completions` |
| `AGENT_LOOP_MAX_STEPS` | `8` | How many tool rounds one answer may take |
| `AGENT_LOOP_TIMEOUT_MS` | `120000` | How long one tool loop may run before it stops |
| `MINDMAPPR_INDEX_DIR` | home `mindmappr-brain/index` | Folder that holds `chunks.json` and `embeddings.json` |
| `MINDMAPPR_INDEX_TOP_K` | `5` | How many notes to attach (maximum 20) |
| `LM_STUDIO_API_KEY` | empty | Sent as a bearer token only when set. LM Studio does not require one. |
| `LM_STUDIO_TIMEOUT_MS` | `120000` | How long to wait for a chat completion before using the existing OpenRouter path |
| `LM_STUDIO_LOOKUP_TIMEOUT_MS` | `5000` | How long to wait for `/models` and `/embeddings` |

- If `embeddings.json` is present and LM Studio can embed the question, notes are ranked by cosine similarity.
- Otherwise notes are ranked by keyword overlap with the question.
- Matching notes are added as reference material on the chat request. The prompt text is in `docs/prompts/system/local-notes-context.md`.
- A missing, empty, or unreadable index still sends the question to LM Studio, without notes.
- If LM Studio is not running or returns an error before a tool succeeds, the answer uses the existing OpenRouter path (`LLM_API_KEY`, `LLM_MODEL`), including a model chosen in the chat request. Notes stay on the local request. They are not sent to OpenRouter.
- Local and OpenRouter answers can call tools and use the results on the next step. Set `LM_STUDIO_MODEL` when you want a specific local model, including a large one. Leave it unset and MindMappr asks LM Studio which models are loaded (`/api/v0/models`) and will not start a model that is only on disk. A loaded qwen is preferred. A 20B or 27B model is not chosen on its own.
- Before a local request is sent, notes are folded into one opening system message and the turns alternate user then assistant. Gemma, which cannot take tool roles, sees tool calls as plain text. If LM Studio rejects the template, that text form is tried once.
- The local prompt is kept under about three quarters of the loaded context (`loaded_context_length`, or 8192 when LM Studio does not say). Oldest chat turns, notes, and long tool results are shortened first. If LM Studio still says the request exceeds the context, it is shortened again and tried once.
- Agent answers keep the agent's token budget (up to 16384) on that request. Plain chat uses 4096. The prompt itself is still trimmed to the loaded context.
- `chunks.json` and `embeddings.json` are read again when their size or timestamps change. A repeat question stats the files and reuses the loaded index.

```bash
node --test tests/knowledge-index.test.mjs
```