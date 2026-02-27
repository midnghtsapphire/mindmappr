import express from 'express';
import cors from 'cors';
import { createWriteStream, createReadStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname, extname, basename } from 'path';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT || '3005');
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://api.manus.im/api/llm-proxy/v1';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4.1-mini';
const UPLOADS_DIR = join(__dirname, 'uploads');
const DATA_DIR = join(__dirname, 'data');

// Ensure dirs exist
[UPLOADS_DIR, DATA_DIR].forEach(d => { if (!existsSync(d)) mkdirSync(d, { recursive: true }); });

// ── Data helpers ──────────────────────────────────────────────────────────────
function loadData(name) {
  const f = join(DATA_DIR, name + '.json');
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return []; }
}
function saveData(name, data) {
  writeFileSync(join(DATA_DIR, name + '.json'), JSON.stringify(data, null, 2));
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── In-memory state ───────────────────────────────────────────────────────────
const sessions = new Map();

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are MindMappr, an AI assistant owned by Audrey Evans (Revvel) — angelreporters@gmail.com. Your GitHub organization is MIDNGHTSAPPHIRE and parent company is Audrey Evans Official / GlowStarLabs.
Your personality: provide detailed, authentic replies with no corporate fluff. You auto-execute tasks and don't ask unnecessary questions. You prioritize FOSS and GitHub first.
Key projects: meetaudreyevans.com, PawSitting, TheAltText, Universal OZ, RevvelPress, Neurooz, MindMappr (you!), 200+ repos in MIDNGHTSAPPHIRE org.
Infrastructure: DigitalOcean droplet 164.90.148.7, Telegram @googlieeyes_bot.
Owner: Audrey Evans, AuDHD, age 60, cancer survivor, trafficking survivor, published author/musician. Daughter is legally deaf — accessibility is personal.
Standards: Glassmorphism UI, neurodivergent-friendly, ECO CODE, No Blue Light.
Be concise but thorough. No fluff. Use markdown. Under 500 words unless asked.`;

async function callLLM(messages) {
  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${LLM_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: LLM_MODEL, messages, max_tokens: 1024, temperature: 0.7 }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}`);
  const d = await res.json();
  return d.choices?.[0]?.message?.content || 'No response.';
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'MindMappr Agent v2', ts: new Date().toISOString() }));

// ── Chat ──────────────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    if (!message) return res.status(400).json({ success: false, error: 'message required' });
    const sid = sessionId || 'web-' + randomUUID().slice(0, 8);
    if (!sessions.has(sid)) sessions.set(sid, []);
    const history = sessions.get(sid);
    const msgs = [{ role: 'system', content: SYSTEM_PROMPT }, ...history.slice(-20), { role: 'user', content: message }];
    const reply = await callLLM(msgs);
    history.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
    if (history.length > 40) history.splice(0, history.length - 40);
    // Track analytics
    const analytics = loadData('analytics');
    analytics.push({ ts: Date.now(), type: 'chat', sessionId: sid });
    saveData('analytics', analytics.slice(-10000));
    res.json({ success: true, data: { reply, sessionId: sid } });
  } catch (e) {
    console.error('[Chat]', e.message);
    res.status(500).json({ success: false, error: 'Failed to get response.' });
  }
});

app.delete('/api/chat/:sid', (req, res) => { sessions.delete(req.params.sid); res.json({ success: true }); });

// ── File Upload (manual multipart parser — no multer needed) ──────────────────
app.post('/api/files/upload', async (req, res) => {
  try {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return res.status(400).json({ success: false, error: 'multipart required' });
    }
    const boundary = contentType.split('boundary=')[1];
    if (!boundary) return res.status(400).json({ success: false, error: 'no boundary' });

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    const sep = Buffer.from('--' + boundary);
    const parts = [];
    let start = 0;
    while (start < buf.length) {
      const idx = buf.indexOf(sep, start);
      if (idx === -1) break;
      const end = buf.indexOf(sep, idx + sep.length);
      const part = buf.slice(idx + sep.length + 2, end === -1 ? buf.length : end - 2);
      if (part.length > 0) parts.push(part);
      start = idx + sep.length;
    }

    const saved = [];
    for (const part of parts) {
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;
      const headers = part.slice(0, headerEnd).toString();
      const body = part.slice(headerEnd + 4);
      if (body.length === 0) continue;
      const nameMatch = headers.match(/filename="([^"]+)"/);
      if (!nameMatch) continue;
      const origName = nameMatch[1];
      const ext = extname(origName);
      const safeName = basename(origName, ext).replace(/[^a-zA-Z0-9._-]/g, '_') + ext;
      const dest = join(UPLOADS_DIR, safeName);
      writeFileSync(dest, body);
      const ctMatch = headers.match(/Content-Type:\s*(\S+)/i);
      saved.push({ name: safeName, size: body.length, type: ctMatch ? ctMatch[1] : 'application/octet-stream', uploadedAt: new Date().toISOString() });
    }

    if (saved.length === 0) return res.status(400).json({ success: false, error: 'No files parsed' });
    res.json({ success: true, data: saved });
  } catch (e) {
    console.error('[Upload]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/files/list', (_req, res) => {
  try {
    const files = readdirSync(UPLOADS_DIR).filter(f => !f.startsWith('.')).map(name => {
      const s = statSync(join(UPLOADS_DIR, name));
      const ext = extname(name).toLowerCase();
      const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.zip': 'application/zip', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json' };
      return { name, size: s.size, type: mimeMap[ext] || 'application/octet-stream', uploadedAt: s.mtime.toISOString() };
    });
    res.json({ success: true, data: files });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/files/download/:name', (req, res) => {
  const fp = join(UPLOADS_DIR, basename(req.params.name));
  if (!existsSync(fp)) return res.status(404).json({ success: false, error: 'Not found' });
  res.download(fp);
});

app.delete('/api/files/:name', (req, res) => {
  try {
    const fp = join(UPLOADS_DIR, basename(req.params.name));
    if (!existsSync(fp)) return res.status(404).json({ success: false, error: 'Not found' });
    unlinkSync(fp);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── CI/CD ─────────────────────────────────────────────────────────────────────
app.post('/api/agent/cicd/trigger', async (req, res) => {
  try {
    const { repo, workflow = 'deploy.yml', ref = 'main' } = req.body;
    if (!repo) return res.status(400).json({ success: false, error: 'repo required' });
    const runs = loadData('cicd_runs');
    const run = { id: randomUUID().slice(0, 8), repo, workflow, ref, status: 'queued', conclusion: null, createdAt: new Date().toISOString() };
    runs.unshift(run); saveData('cicd_runs', runs.slice(0, 100));
    // Simulate async completion
    setTimeout(() => {
      const all = loadData('cicd_runs');
      const r = all.find(x => x.id === run.id);
      if (r) { r.status = 'completed'; r.conclusion = 'success'; r.completedAt = new Date().toISOString(); saveData('cicd_runs', all); }
    }, 5000);
    res.json({ success: true, data: run });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/agent/cicd/history', (req, res) => {
  const runs = loadData('cicd_runs');
  const limit = parseInt(req.query.limit) || 20;
  const repo = req.query.repo;
  const filtered = repo ? runs.filter(r => r.repo === repo) : runs;
  res.json({ success: true, data: filtered.slice(0, limit) });
});

app.post('/api/agent/cicd/simulate', (req, res) => {
  const { steps = [] } = req.body;
  const results = steps.map(step => ({ step, success: Math.random() > 0.1, duration: Math.floor(Math.random() * 3000) + 500 }));
  res.json({ success: true, data: results });
});

// ── API Access ────────────────────────────────────────────────────────────────
app.post('/api/agent/apis/register', (req, res) => {
  const { name, baseUrl, apiKey, tier = 'free', rateLimit = 100 } = req.body;
  if (!name || !baseUrl || !apiKey) return res.status(400).json({ success: false, error: 'name, baseUrl, apiKey required' });
  const apis = loadData('apis');
  const existing = apis.findIndex(a => a.name === name);
  const entry = { name, baseUrl, tier, rateLimit, registeredAt: new Date().toISOString(), keyHint: apiKey.slice(0, 4) + '****' };
  if (existing >= 0) apis[existing] = entry; else apis.push(entry);
  saveData('apis', apis);
  res.json({ success: true, data: entry });
});

app.get('/api/agent/apis/list', (_req, res) => res.json({ success: true, data: loadData('apis') }));

app.post('/api/agent/apis/test', async (req, res) => {
  const { name } = req.body;
  const apis = loadData('apis');
  const api = apis.find(a => a.name === name);
  if (!api) return res.status(404).json({ success: false, error: 'API not found' });
  try {
    const r = await fetch(api.baseUrl, { method: 'GET', signal: AbortSignal.timeout(5000) });
    res.json({ success: true, data: { status: r.status, ok: r.ok } });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/agent/apis/models', (_req, res) => {
  res.json({ success: true, data: [
    { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', tier: 'premium' },
    { id: 'anthropic/claude-haiku-4-5', name: 'Claude Haiku 4.5', tier: 'premium' },
    { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', tier: 'free' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', tier: 'free' },
    { id: 'venice-ai/llama-3.3-70b', name: 'Venice Llama 3.3 70B', tier: 'premium' },
  ]});
});

// ── Cloud Builds ──────────────────────────────────────────────────────────────
app.post('/api/agent/builds/submit', (req, res) => {
  const { config = {} } = req.body;
  const jobs = loadData('build_jobs');
  const job = { id: randomUUID(), type: config.type || 'web', name: config.name || 'app', status: 'queued', createdAt: new Date().toISOString() };
  jobs.unshift(job); saveData('build_jobs', jobs.slice(0, 200));
  setTimeout(() => {
    const all = loadData('build_jobs');
    const j = all.find(x => x.id === job.id);
    if (j) { j.status = 'completed'; j.completedAt = new Date().toISOString(); saveData('build_jobs', all); }
  }, 8000);
  res.json({ success: true, data: job });
});

app.get('/api/agent/builds/list', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  res.json({ success: true, data: loadData('build_jobs').slice(0, limit) });
});

app.post('/api/agent/builds/cancel', (req, res) => {
  const { jobId } = req.body;
  const jobs = loadData('build_jobs');
  const j = jobs.find(x => x.id === jobId);
  if (!j) return res.status(404).json({ success: false, error: 'Job not found' });
  j.status = 'cancelled'; j.cancelledAt = new Date().toISOString();
  saveData('build_jobs', jobs);
  res.json({ success: true, data: j });
});

app.get('/api/agent/builds/resources', (_req, res) => {
  res.json({ success: true, data: { cpu: Math.floor(Math.random() * 40) + 10, memory: Math.floor(Math.random() * 50) + 20, queueSize: loadData('build_jobs').filter(j => j.status === 'queued').length } });
});

// ── App Store ─────────────────────────────────────────────────────────────────
app.post('/api/agent/appstore/submit', (req, res) => {
  const { appName, platform, version, metadata = {} } = req.body;
  if (!appName || !platform || !version) return res.status(400).json({ success: false, error: 'appName, platform, version required' });
  const subs = loadData('appstore_subs');
  const sub = { id: randomUUID(), appName, platform, version, metadata, status: 'pending', createdAt: new Date().toISOString() };
  subs.unshift(sub); saveData('appstore_subs', subs.slice(0, 100));
  res.json({ success: true, data: sub });
});

app.get('/api/agent/appstore/status', (req, res) => {
  const { appName } = req.query;
  const subs = loadData('appstore_subs');
  const filtered = appName ? subs.filter(s => s.appName === appName) : subs;
  res.json({ success: true, data: filtered });
});

app.get('/api/agent/appstore/checklist', (req, res) => {
  const { platform = 'ios' } = req.query;
  const lists = {
    ios: [{ item: 'App icon (1024x1024)', required: true }, { item: 'Screenshots (6.7" + 6.1")', required: true }, { item: 'Privacy policy URL', required: true }, { item: 'Age rating', required: true }, { item: 'App description', required: true }, { item: 'Keywords', required: false }, { item: 'Support URL', required: false }],
    android: [{ item: 'App icon (512x512)', required: true }, { item: 'Feature graphic (1024x500)', required: true }, { item: 'Screenshots (phone)', required: true }, { item: 'Privacy policy URL', required: true }, { item: 'Content rating', required: true }, { item: 'Short description', required: true }],
    web: [{ item: 'manifest.json', required: true }, { item: 'Service worker', required: false }, { item: 'HTTPS', required: true }, { item: 'Responsive design', required: true }],
  };
  res.json({ success: true, data: lists[platform] || lists.ios });
});

app.post('/api/agent/appstore/bump-version', (req, res) => {
  const { currentVersion = '1.0.0', type = 'patch' } = req.body;
  const [maj, min, pat] = currentVersion.split('.').map(Number);
  const newVersion = type === 'major' ? `${maj + 1}.0.0` : type === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
  res.json({ success: true, data: { newVersion } });
});

// ── Workflows ─────────────────────────────────────────────────────────────────
app.post('/api/agent/workflows/create', (req, res) => {
  const { name, description, nodes = [], edges = [] } = req.body;
  if (!name) return res.status(400).json({ success: false, error: 'name required' });
  const wfs = loadData('workflows');
  const wf = { id: randomUUID(), name, description, nodes, edges, createdAt: new Date().toISOString() };
  wfs.unshift(wf); saveData('workflows', wfs.slice(0, 100));
  res.json({ success: true, data: wf });
});

app.get('/api/agent/workflows/list', (_req, res) => res.json({ success: true, data: loadData('workflows') }));

app.post('/api/agent/workflows/run/:id', async (req, res) => {
  const wfs = loadData('workflows');
  const wf = wfs.find(w => w.id === req.params.id);
  if (!wf) return res.status(404).json({ success: false, error: 'Workflow not found' });
  const results = [];
  for (const node of (wf.nodes || [])) {
    if (node.type === 'llm_prompt' && node.config?.prompt) {
      try {
        const reply = await callLLM([{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: node.config.prompt }]);
        results.push({ nodeId: node.id, type: node.type, output: reply, success: true });
      } catch (e) { results.push({ nodeId: node.id, type: node.type, output: e.message, success: false }); }
    } else {
      results.push({ nodeId: node.id, type: node.type, output: 'executed', success: true });
    }
  }
  res.json({ success: true, data: { workflowId: wf.id, results } });
});

app.delete('/api/agent/workflows/:id', (req, res) => {
  const wfs = loadData('workflows').filter(w => w.id !== req.params.id);
  saveData('workflows', wfs);
  res.json({ success: true });
});

// ── Analytics ─────────────────────────────────────────────────────────────────
app.get('/api/agent/analytics/dashboard', (_req, res) => {
  const analytics = loadData('analytics');
  const now = Date.now();
  const day = 86400000;
  const msgs24h = analytics.filter(e => e.type === 'chat' && now - e.ts < day).length;
  const msgs7d = analytics.filter(e => e.type === 'chat' && now - e.ts < 7 * day).length;
  const sessions = new Set(analytics.map(e => e.sessionId)).size;
  const llmCalls = analytics.filter(e => e.type === 'chat').length;
  const features = ['chat', 'files', 'cicd', 'builds', 'appstore', 'workflows', 'analytics', 'apis'];
  const topFeatures = features.map(f => ({ name: f, count: analytics.filter(e => e.type === f || e.feature === f).length })).sort((a, b) => b.count - a.count);
  res.json({ success: true, data: { messages24h: msgs24h, messages7d: msgs7d, activeSessions: sessions, llmCalls, errorRate: 0, uptime: 99.9, topFeatures } });
});

app.get('/api/agent/analytics/alerts', (_req, res) => res.json({ success: true, data: loadData('alerts') }));

app.post('/api/agent/analytics/alerts', (req, res) => {
  const { name, metric, condition, threshold } = req.body;
  if (!name) return res.status(400).json({ success: false, error: 'name required' });
  const alerts = loadData('alerts');
  const alert = { id: randomUUID(), name, metric, condition, threshold, active: true, createdAt: new Date().toISOString() };
  alerts.unshift(alert); saveData('alerts', alerts.slice(0, 100));
  res.json({ success: true, data: alert });
});

app.post('/api/agent/analytics/alerts/:id/resolve', (req, res) => {
  const alerts = loadData('alerts');
  const a = alerts.find(x => x.id === req.params.id);
  if (a) { a.active = false; a.resolvedAt = new Date().toISOString(); saveData('alerts', alerts); }
  res.json({ success: true });
});

app.get('/api/agent/analytics/export', (_req, res) => {
  const data = { analytics: loadData('analytics'), alerts: loadData('alerts'), exportedAt: new Date().toISOString() };
  res.setHeader('Content-Disposition', 'attachment; filename="mindmappr-analytics.json"');
  res.json(data);
});

// ── Static UI ─────────────────────────────────────────────────────────────────
app.use('/mindmappr', express.static(join(__dirname, 'public')));
app.use(express.static(join(__dirname, 'public')));
app.get(['/mindmappr', '/mindmappr/*'], (_req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`[MindMappr Agent v2] Port ${PORT}`));
