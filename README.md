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