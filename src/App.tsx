import { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'

// ─── Types ────────────────────────────────────────────────────────────────────
interface Message { id: string; role: 'user' | 'assistant'; content: string; ts: number; error?: boolean }
interface UploadedFile { name: string; size: number; type: string; uploadedAt: string }

// ─── Constants ────────────────────────────────────────────────────────────────
const API = '/mindmappr/api'
const TABS = ['Chat', 'Files', 'Pipelines', 'APIs', 'Builds', 'App Store', 'Workflows', 'Analytics'] as const
type Tab = typeof TABS[number]
const TAB_ICONS: Record<Tab, string> = {
  Chat: '💬', Files: '📁', Pipelines: '🔄', APIs: '🔌',
  Builds: '🏗️', 'App Store': '📱', Workflows: '⚡', Analytics: '📊'
}
const SUGGESTIONS = [
  'What projects are in MIDNGHTSAPPHIRE?',
  'Trigger a CI/CD pipeline',
  'Show analytics dashboard',
  'Help me upload a file',
]

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatBytes(b: number) {
  if (b < 1024) return b + ' B'
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'
  return (b / 1048576).toFixed(1) + ' MB'
}
function timeAgo(ts: string | number) {
  const d = Date.now() - new Date(ts).getTime()
  if (d < 60000) return 'just now'
  if (d < 3600000) return Math.floor(d / 60000) + 'm ago'
  if (d < 86400000) return Math.floor(d / 3600000) + 'h ago'
  return Math.floor(d / 86400000) + 'd ago'
}

function Badge({ status }: { status: string }) {
  const map: Record<string, string> = {
    success: 'bg-green-500/20 text-green-400', completed: 'bg-green-500/20 text-green-400',
    running: 'bg-blue-500/20 text-blue-400', queued: 'bg-yellow-500/20 text-yellow-400',
    failed: 'bg-red-500/20 text-red-400', active: 'bg-red-500/20 text-red-400',
    premium: 'bg-purple-500/20 text-purple-400', free: 'bg-slate-500/20 text-slate-400',
    pending: 'bg-yellow-500/20 text-yellow-400', resolved: 'bg-green-500/20 text-green-400',
  }
  return <span className={`px-2 py-0.5 rounded-full text-xs ${map[status?.toLowerCase()] || 'bg-slate-500/20 text-slate-400'}`}>{status}</span>
}

// ─── Chat Tab ─────────────────────────────────────────────────────────────────
function ChatTab() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [typing, setTyping] = useState(false)
  const [online, setOnline] = useState<boolean | null>(null)
  const [sessionId] = useState(() => {
    let id = localStorage.getItem('mm_session')
    if (!id) { id = 'web-' + Math.random().toString(36).slice(2); localStorage.setItem('mm_session', id) }
    return id
  })
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    fetch(`${API}/health`).then(r => r.json()).then(d => setOnline(d.status === 'ok')).catch(() => setOnline(false))
  }, [])
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, typing])

  const send = useCallback(async (text: string) => {
    if (!text.trim() || typing) return
    setMessages(m => [...m, { id: Date.now().toString(), role: 'user', content: text.trim(), ts: Date.now() }])
    setInput(''); setTyping(true)
    if (inputRef.current) inputRef.current.style.height = 'auto'
    try {
      const res = await fetch(`${API}/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text.trim(), sessionId })
      })
      const data = await res.json()
      setMessages(m => [...m, {
        id: (Date.now() + 1).toString(), role: 'assistant',
        content: data.success ? data.data.reply : 'Connection error.', ts: Date.now(), error: !data.success
      }])
    } catch {
      setMessages(m => [...m, { id: (Date.now() + 1).toString(), role: 'assistant', content: 'Network error. Please try again.', ts: Date.now(), error: true }])
    }
    setTyping(false); setTimeout(() => inputRef.current?.focus(), 50)
  }, [typing, sessionId])

  return (
    <div className="flex flex-col" style={{ height: 'calc(100vh - 120px)' }}>
      <div className="flex items-center gap-2 px-4 py-2 border-b border-white/5">
        <div className={`w-2 h-2 rounded-full ${online === null ? 'bg-yellow-400 animate-pulse' : online ? 'bg-green-400' : 'bg-red-400'}`} />
        <span className="text-xs text-slate-400">{online === null ? 'Connecting…' : online ? 'Online' : 'Offline'}</span>
        {messages.length > 0 && (
          <button onClick={() => { setMessages([]); localStorage.removeItem('mm_session'); window.location.reload() }}
            className="ml-auto text-xs text-slate-500 hover:text-red-400 transition-colors">Clear chat</button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center py-12">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-orange-500 to-amber-400 flex items-center justify-center shadow-2xl shadow-orange-500/30 mb-4 text-3xl">🧠</div>
            <h2 className="text-xl font-bold text-white mb-2">MindMappr Agent</h2>
            <p className="text-slate-400 text-sm mb-6 max-w-sm">AI assistant with CI/CD, cloud builds, app store, workflows, analytics and file management.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-md">
              {SUGGESTIONS.map(s => (
                <button key={s} onClick={() => send(s)}
                  className="glass hover:bg-white/10 text-left px-3 py-2 rounded-xl text-xs text-slate-300 hover:text-white transition-all border border-transparent hover:border-orange-500/30">{s}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map(msg => (
          <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm ${msg.role === 'user' ? 'bg-gradient-to-br from-orange-500 to-amber-400 text-white' : msg.error ? 'glass border border-red-500/30 text-red-300' : 'glass text-slate-200'}`}>
              {msg.role === 'assistant'
                ? <ReactMarkdown className="prose prose-invert prose-sm max-w-none">{msg.content}</ReactMarkdown>
                : <p className="whitespace-pre-wrap">{msg.content}</p>}
            </div>
          </div>
        ))}
        {typing && <div className="flex justify-start"><div className="glass rounded-2xl px-4 py-3 text-slate-400 text-sm">Thinking…</div></div>}
        <div ref={endRef} />
      </div>
      <div className="p-4 border-t border-white/10">
        <div className="glass rounded-2xl flex items-end gap-2 px-4 py-2 focus-within:border-orange-500/40 transition-all">
          <textarea ref={inputRef} value={input}
            onChange={e => { setInput(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px' }}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input) } }}
            placeholder="Message MindMappr…" rows={1} disabled={typing}
            className="flex-1 bg-transparent text-slate-100 placeholder-slate-500 resize-none outline-none text-sm py-1.5 max-h-[120px] disabled:opacity-50" />
          <button onClick={() => send(input)} disabled={!input.trim() || typing}
            className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all mb-0.5 flex-shrink-0 ${input.trim() && !typing ? 'bg-gradient-to-br from-orange-500 to-amber-400 text-white hover:scale-105 shadow-lg shadow-orange-500/30' : 'bg-white/5 text-slate-600 cursor-not-allowed'}`}>
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" /></svg>
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Files Tab ────────────────────────────────────────────────────────────────
function FilesTab() {
  const [files, setFiles] = useState<UploadedFile[]>([])
  const [uploading, setUploading] = useState(false)
  const [drag, setDrag] = useState(false)
  const [msg, setMsg] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API}/files/list`)
      const d = await r.json()
      if (d.success) setFiles(d.data || [])
    } catch { setMsg('Failed to load files') }
  }, [])
  useEffect(() => { load() }, [load])

  const upload = async (fl: FileList | null) => {
    if (!fl?.length) return
    setUploading(true); setMsg('')
    const form = new FormData()
    Array.from(fl).forEach(f => form.append('files', f))
    try {
      const r = await fetch(`${API}/files/upload`, { method: 'POST', body: form })
      const d = await r.json()
      setMsg(d.success ? `✅ Uploaded ${fl.length} file(s)` : '❌ ' + (d.error || 'Upload failed'))
      if (d.success) load()
    } catch { setMsg('❌ Upload error') }
    setUploading(false)
  }

  const del = async (name: string) => {
    if (!confirm(`Delete ${name}?`)) return
    try {
      const r = await fetch(`${API}/files/${encodeURIComponent(name)}`, { method: 'DELETE' })
      const d = await r.json()
      if (d.success) { setMsg('🗑️ Deleted'); load() }
    } catch { setMsg('Delete failed') }
  }

  const fileIcon = (type: string) =>
    type?.startsWith('image') ? '🖼️' : type?.includes('pdf') ? '📄' :
    type?.startsWith('video') ? '🎬' : type?.startsWith('audio') ? '🎵' : '📎'

  return (
    <div className="p-4 space-y-4">
      <div
        onDragOver={e => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files) }}
        onClick={() => fileRef.current?.click()}
        className={`border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all ${drag ? 'border-orange-500 bg-orange-500/10' : 'border-white/20 hover:border-orange-500/50 hover:bg-white/5'}`}>
        <div className="text-4xl mb-2">📤</div>
        <p className="text-slate-300 font-medium">{uploading ? 'Uploading…' : 'Drop files here or click to upload'}</p>
        <p className="text-slate-500 text-xs mt-1">Max 50MB · Images, PDFs, code, archives, audio, video</p>
        <input ref={fileRef} type="file" multiple className="hidden" onChange={e => upload(e.target.files)} />
      </div>
      {msg && <div className="glass rounded-xl px-4 py-2 text-sm text-slate-300">{msg}</div>}
      <div className="space-y-2">
        {files.length === 0 && <p className="text-slate-500 text-sm text-center py-4">No files uploaded yet.</p>}
        {files.map(f => (
          <div key={f.name} className="glass rounded-xl px-4 py-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <span className="text-2xl">{fileIcon(f.type)}</span>
              <div className="min-w-0">
                <p className="text-slate-200 text-sm font-medium truncate">{f.name}</p>
                <p className="text-slate-500 text-xs">{formatBytes(f.size)} · {timeAgo(f.uploadedAt)}</p>
              </div>
            </div>
            <div className="flex gap-2 flex-shrink-0">
              <a href={`${API}/files/download/${encodeURIComponent(f.name)}`} download={f.name}
                className="px-3 py-1 rounded-lg bg-orange-500/20 text-orange-400 text-xs hover:bg-orange-500/30 transition-all">⬇ Download</a>
              <button onClick={() => del(f.name)}
                className="px-3 py-1 rounded-lg bg-red-500/20 text-red-400 text-xs hover:bg-red-500/30 transition-all">🗑</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Pipelines Tab ────────────────────────────────────────────────────────────
function PipelinesTab() {
  const [repo, setRepo] = useState('MIDNGHTSAPPHIRE/mindmappr')
  const [workflow, setWorkflow] = useState('deploy.yml')
  const [runs, setRuns] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState('')

  const fetchRuns = async () => {
    setLoading(true)
    try {
      const r = await fetch(`${API}/agent/cicd/history?repo=${encodeURIComponent(repo)}&limit=10`)
      const d = await r.json()
      if (d.success) setRuns(d.data || []); else setMsg(d.error || 'Failed')
    } catch { setMsg('Connection error') }
    setLoading(false)
  }

  const trigger = async () => {
    setMsg('')
    try {
      const r = await fetch(`${API}/agent/cicd/trigger`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo, workflow, ref: 'main' })
      })
      const d = await r.json()
      setMsg(d.success ? '✅ Pipeline triggered!' : '❌ ' + d.error)
      if (d.success) setTimeout(fetchRuns, 2000)
    } catch { setMsg('❌ Trigger failed') }
  }

  const simulate = async () => {
    setMsg('')
    try {
      const r = await fetch(`${API}/agent/cicd/simulate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ steps: [
          { name: 'Install', command: 'npm install' },
          { name: 'Test', command: 'npm test' },
          { name: 'Build', command: 'npm run build' },
          { name: 'Deploy', command: 'rsync dist/' }
        ]})
      })
      const d = await r.json()
      setMsg(d.success ? '✅ Sim: ' + (d.data || []).map((s: any) => s.step.name + (s.success ? '✓' : '✗')).join(' → ') : '❌ ' + d.error)
    } catch { setMsg('❌ Sim failed') }
  }

  return (
    <div className="p-4 space-y-4">
      <div className="glass rounded-2xl p-4 space-y-3">
        <h3 className="text-white font-semibold">🔄 CI/CD Pipeline</h3>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-slate-400 text-xs mb-1 block">Repository</label>
            <input value={repo} onChange={e => setRepo(e.target.value)} className="w-full glass rounded-lg px-3 py-2 text-sm text-slate-200 outline-none border border-transparent focus:border-orange-500/50" />
          </div>
          <div>
            <label className="text-slate-400 text-xs mb-1 block">Workflow file</label>
            <input value={workflow} onChange={e => setWorkflow(e.target.value)} className="w-full glass rounded-lg px-3 py-2 text-sm text-slate-200 outline-none border border-transparent focus:border-orange-500/50" />
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={trigger} className="px-4 py-2 rounded-xl bg-orange-500/20 text-orange-400 text-sm hover:bg-orange-500/30 transition-all">▶ Trigger</button>
          <button onClick={simulate} className="px-4 py-2 rounded-xl bg-blue-500/20 text-blue-400 text-sm hover:bg-blue-500/30 transition-all">🧪 Simulate</button>
          <button onClick={fetchRuns} className="px-4 py-2 rounded-xl bg-white/10 text-slate-300 text-sm hover:bg-white/20 transition-all">{loading ? '…' : '↻ Refresh'}</button>
        </div>
        {msg && <div className="text-sm text-slate-300 glass rounded-lg px-3 py-2">{msg}</div>}
      </div>
      <div className="space-y-2">
        <h3 className="text-slate-400 text-xs font-semibold uppercase tracking-wider">Recent Runs</h3>
        {runs.length === 0 && <p className="text-slate-500 text-sm text-center py-4">Click Refresh to load pipeline runs.</p>}
        {runs.map((r: any, i: number) => (
          <div key={r.id || i} className="glass rounded-xl px-4 py-3 flex items-center justify-between">
            <div>
              <p className="text-slate-200 text-sm font-medium">Run #{r.id}</p>
              <p className="text-slate-500 text-xs">{r.createdAt ? timeAgo(r.createdAt) : ''}</p>
            </div>
            <Badge status={r.conclusion || r.status || 'unknown'} />
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── APIs Tab ─────────────────────────────────────────────────────────────────
function APIsTab() {
  const [apis, setApis] = useState<any[]>([])
  const [models, setModels] = useState<any[]>([])
  const [form, setForm] = useState({ name: '', baseUrl: '', apiKey: '', tier: 'free', rateLimit: '100' })
  const [msg, setMsg] = useState('')

  const load = async () => {
    try {
      const [ar, mr] = await Promise.all([
        fetch(`${API}/agent/apis/list`).then(r => r.json()),
        fetch(`${API}/agent/apis/models`).then(r => r.json()),
      ])
      if (ar.success) setApis(ar.data || [])
      if (mr.success) setModels(mr.data || [])
    } catch { setMsg('Failed to load') }
  }
  useEffect(() => { load() }, [])

  const register = async () => {
    if (!form.name || !form.baseUrl || !form.apiKey) { setMsg('❌ Name, URL, and key required'); return }
    try {
      const r = await fetch(`${API}/agent/apis/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, rateLimit: Number(form.rateLimit) })
      })
      const d = await r.json()
      setMsg(d.success ? '✅ Registered!' : '❌ ' + d.error)
      if (d.success) { load(); setForm({ name: '', baseUrl: '', apiKey: '', tier: 'free', rateLimit: '100' }) }
    } catch { setMsg('❌ Failed') }
  }

  const testApi = async (name: string) => {
    try {
      const r = await fetch(`${API}/agent/apis/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
      const d = await r.json()
      setMsg(d.success ? `✅ ${name}: OK` : `❌ ${name}: ${d.error}`)
    } catch { setMsg('Test failed') }
  }

  return (
    <div className="p-4 space-y-4">
      <div className="glass rounded-2xl p-4 space-y-3">
        <h3 className="text-white font-semibold">🔌 Register API</h3>
        <div className="grid grid-cols-2 gap-2">
          <div><label className="text-slate-400 text-xs mb-1 block">Name</label><input value={form.name} onChange={e => setForm(f => ({...f, name: e.target.value}))} className="w-full glass rounded-lg px-3 py-2 text-sm text-slate-200 outline-none border border-transparent focus:border-orange-500/50" /></div>
          <div><label className="text-slate-400 text-xs mb-1 block">Base URL</label><input value={form.baseUrl} onChange={e => setForm(f => ({...f, baseUrl: e.target.value}))} className="w-full glass rounded-lg px-3 py-2 text-sm text-slate-200 outline-none border border-transparent focus:border-orange-500/50" /></div>
          <div><label className="text-slate-400 text-xs mb-1 block">API Key</label><input type="password" value={form.apiKey} onChange={e => setForm(f => ({...f, apiKey: e.target.value}))} className="w-full glass rounded-lg px-3 py-2 text-sm text-slate-200 outline-none border border-transparent focus:border-orange-500/50" /></div>
          <div><label className="text-slate-400 text-xs mb-1 block">Rate Limit/min</label><input type="number" value={form.rateLimit} onChange={e => setForm(f => ({...f, rateLimit: e.target.value}))} className="w-full glass rounded-lg px-3 py-2 text-sm text-slate-200 outline-none border border-transparent focus:border-orange-500/50" /></div>
          <div><label className="text-slate-400 text-xs mb-1 block">Tier</label><select value={form.tier} onChange={e => setForm(f => ({...f, tier: e.target.value}))} className="w-full glass rounded-lg px-3 py-2 text-sm text-slate-200 bg-transparent border border-transparent outline-none"><option value="free">Free</option><option value="premium">Premium</option></select></div>
        </div>
        <button onClick={register} className="px-4 py-2 rounded-xl bg-orange-500/20 text-orange-400 text-sm hover:bg-orange-500/30 transition-all">+ Register</button>
        {msg && <div className="text-sm text-slate-300 glass rounded-lg px-3 py-2">{msg}</div>}
      </div>
      {apis.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-slate-400 text-xs font-semibold uppercase tracking-wider">Registered APIs ({apis.length})</h3>
          {apis.map((a: any) => (
            <div key={a.name} className="glass rounded-xl px-4 py-3 flex items-center justify-between">
              <div><p className="text-slate-200 text-sm font-medium">{a.name}</p><p className="text-slate-500 text-xs">{a.baseUrl} · {a.tier}</p></div>
              <button onClick={() => testApi(a.name)} className="px-3 py-1 rounded-lg bg-blue-500/20 text-blue-400 text-xs hover:bg-blue-500/30 transition-all">Test</button>
            </div>
          ))}
        </div>
      )}
      {models.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-slate-400 text-xs font-semibold uppercase tracking-wider">AI Models ({models.length})</h3>
          {models.map((m: any) => (
            <div key={m.id} className="glass rounded-xl px-4 py-3 flex items-center justify-between">
              <div><p className="text-slate-200 text-sm font-medium">{m.name || m.id}</p><p className="text-slate-500 text-xs">{m.id}</p></div>
              <Badge status={m.tier} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Builds Tab ───────────────────────────────────────────────────────────────
function BuildsTab() {
  const [jobs, setJobs] = useState<any[]>([])
  const [type, setType] = useState('web')
  const [name, setName] = useState('my-app')
  const [msg, setMsg] = useState('')
  const [resources, setResources] = useState<any>(null)

  const load = async () => {
    try {
      const [jr, rr] = await Promise.all([
        fetch(`${API}/agent/builds/list?limit=15`).then(r => r.json()),
        fetch(`${API}/agent/builds/resources`).then(r => r.json()),
      ])
      if (jr.success) setJobs(jr.data || [])
      if (rr.success) setResources(rr.data)
    } catch { setMsg('Failed to load') }
  }
  useEffect(() => { load() }, [])

  const submit = async () => {
    try {
      const r = await fetch(`${API}/agent/builds/submit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { type, name } })
      })
      const d = await r.json()
      setMsg(d.success ? `✅ Job ${(d.data?.id || '').slice(0, 8)} queued!` : '❌ ' + d.error)
      if (d.success) setTimeout(load, 1000)
    } catch { setMsg('❌ Failed') }
  }

  const cancel = async (id: string) => {
    try {
      const r = await fetch(`${API}/agent/builds/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: id }) })
      const d = await r.json()
      setMsg(d.success ? '🛑 Cancelled' : '❌ ' + d.error)
      if (d.success) load()
    } catch { setMsg('Cancel failed') }
  }

  return (
    <div className="p-4 space-y-4">
      {resources && (
        <div className="grid grid-cols-3 gap-2">
          {[['CPU', resources.cpu + '%'], ['Memory', resources.memory + '%'], ['Queue', resources.queueSize + ' jobs']].map(([l, v]) => (
            <div key={l as string} className="glass rounded-xl p-3 text-center">
              <p className="text-2xl font-bold text-orange-400">{v}</p>
              <p className="text-slate-500 text-xs mt-1">{l}</p>
            </div>
          ))}
        </div>
      )}
      <div className="glass rounded-2xl p-4 space-y-3">
        <h3 className="text-white font-semibold">🏗️ Submit Build Job</h3>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-slate-400 text-xs mb-1 block">Type</label>
            <select value={type} onChange={e => setType(e.target.value)} className="w-full glass rounded-lg px-3 py-2 text-sm text-slate-200 bg-transparent border border-transparent outline-none">
              {['web', 'mobile-ios', 'mobile-android', 'video-process', 'ai-inference'].map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label className="text-slate-400 text-xs mb-1 block">App Name</label>
            <input value={name} onChange={e => setName(e.target.value)} className="w-full glass rounded-lg px-3 py-2 text-sm text-slate-200 outline-none border border-transparent focus:border-orange-500/50" />
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={submit} className="px-4 py-2 rounded-xl bg-orange-500/20 text-orange-400 text-sm hover:bg-orange-500/30 transition-all">▶ Submit</button>
          <button onClick={load} className="px-4 py-2 rounded-xl bg-white/10 text-slate-300 text-sm hover:bg-white/20 transition-all">↻ Refresh</button>
        </div>
        {msg && <div className="text-sm text-slate-300 glass rounded-lg px-3 py-2">{msg}</div>}
      </div>
      <div className="space-y-2">
        <h3 className="text-slate-400 text-xs font-semibold uppercase tracking-wider">Build Jobs</h3>
        {jobs.length === 0 && <p className="text-slate-500 text-sm text-center py-4">No jobs yet.</p>}
        {jobs.map((j: any) => (
          <div key={j.id} className="glass rounded-xl px-4 py-3 flex items-center justify-between">
            <div>
              <p className="text-slate-200 text-sm font-medium">{j.type} <span className="text-slate-500 text-xs">#{(j.id || '').slice(0, 8)}</span></p>
              <p className="text-slate-500 text-xs">{j.createdAt ? timeAgo(j.createdAt) : ''}</p>
            </div>
            <div className="flex items-center gap-2">
              <Badge status={j.status} />
              {(j.status === 'queued' || j.status === 'running') && (
                <button onClick={() => cancel(j.id)} className="px-2 py-1 rounded-lg bg-red-500/20 text-red-400 text-xs hover:bg-red-500/30">✕</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── App Store Tab ────────────────────────────────────────────────────────────
function AppStoreTab() {
  const [appName, setAppName] = useState('MindMappr')
  const [platform, setPlatform] = useState('ios')
  const [version, setVersion] = useState('1.0.0')
  const [history, setHistory] = useState<any[]>([])
  const [checklist, setChecklist] = useState<any[]>([])
  const [msg, setMsg] = useState('')

  const load = async () => {
    try {
      const [hr, cr] = await Promise.all([
        fetch(`${API}/agent/appstore/status?appName=${encodeURIComponent(appName)}`).then(r => r.json()),
        fetch(`${API}/agent/appstore/checklist?platform=${platform}`).then(r => r.json()),
      ])
      if (hr.success) setHistory(hr.data || [])
      if (cr.success) setChecklist(cr.data || [])
    } catch { setMsg('Failed to load') }
  }
  useEffect(() => { load() }, [platform])

  const submit = async () => {
    try {
      const r = await fetch(`${API}/agent/appstore/submit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appName, platform, version, metadata: { privacyPolicyUrl: 'https://meetaudreyevans.com/privacy', description: 'MindMappr AI assistant', screenshots: ['s1.png', 's2.png', 's3.png'], ageRating: '4+' } })
      })
      const d = await r.json()
      setMsg(d.success ? `✅ Submission ${(d.data?.id || '').slice(0, 8)} created!` : '❌ ' + d.error)
      if (d.success) load()
    } catch { setMsg('❌ Failed') }
  }

  const bump = async (t: string) => {
    try {
      const r = await fetch(`${API}/agent/appstore/bump-version`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentVersion: version, type: t }) })
      const d = await r.json()
      if (d.success) setVersion(d.data?.newVersion || version)
    } catch { /* ignore */ }
  }

  return (
    <div className="p-4 space-y-4">
      <div className="glass rounded-2xl p-4 space-y-3">
        <h3 className="text-white font-semibold">📱 App Store Submission</h3>
        <div className="grid grid-cols-2 gap-2">
          <div><label className="text-slate-400 text-xs mb-1 block">App Name</label><input value={appName} onChange={e => setAppName(e.target.value)} className="w-full glass rounded-lg px-3 py-2 text-sm text-slate-200 outline-none border border-transparent focus:border-orange-500/50" /></div>
          <div><label className="text-slate-400 text-xs mb-1 block">Platform</label><select value={platform} onChange={e => setPlatform(e.target.value)} className="w-full glass rounded-lg px-3 py-2 text-sm text-slate-200 bg-transparent border border-transparent outline-none"><option value="ios">iOS</option><option value="android">Android</option><option value="web">Web</option></select></div>
          <div className="col-span-2">
            <label className="text-slate-400 text-xs mb-1 block">Version</label>
            <div className="flex gap-1">
              <input value={version} onChange={e => setVersion(e.target.value)} className="flex-1 glass rounded-lg px-3 py-2 text-sm text-slate-200 outline-none border border-transparent focus:border-orange-500/50" />
              {['patch', 'minor', 'major'].map(t => <button key={t} onClick={() => bump(t)} className="px-2 py-1 glass rounded-lg text-slate-400 text-xs hover:text-orange-400 transition-all">+{t[0]}</button>)}
            </div>
          </div>
        </div>
        <button onClick={submit} className="px-4 py-2 rounded-xl bg-orange-500/20 text-orange-400 text-sm hover:bg-orange-500/30 transition-all">📤 Submit</button>
        {msg && <div className="text-sm text-slate-300 glass rounded-lg px-3 py-2">{msg}</div>}
      </div>
      {checklist.length > 0 && (
        <div className="glass rounded-2xl p-4 space-y-1">
          <h3 className="text-white font-semibold text-sm mb-2">✅ Compliance ({platform})</h3>
          {checklist.map((item: any, i: number) => (
            <div key={i} className="flex items-center gap-2 text-sm">
              <span className={item.required ? 'text-orange-400' : 'text-slate-500'}>•</span>
              <span className="text-slate-300">{item.item || item}</span>
              {item.required && <span className="text-xs text-orange-400 ml-auto">req</span>}
            </div>
          ))}
        </div>
      )}
      <div className="space-y-2">
        <h3 className="text-slate-400 text-xs font-semibold uppercase tracking-wider">Submission History</h3>
        {history.length === 0 && <p className="text-slate-500 text-sm text-center py-4">No submissions yet.</p>}
        {history.map((s: any) => (
          <div key={s.id} className="glass rounded-xl px-4 py-3 flex items-center justify-between">
            <div>
              <p className="text-slate-200 text-sm font-medium">{s.appName} v{s.version} <span className="text-slate-500 text-xs">({s.platform})</span></p>
              <p className="text-slate-500 text-xs">{s.createdAt ? timeAgo(s.createdAt) : ''}</p>
            </div>
            <Badge status={s.status || 'pending'} />
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Workflows Tab ────────────────────────────────────────────────────────────
function WorkflowsTab() {
  const [wfs, setWfs] = useState<any[]>([])
  const [name, setName] = useState('My Workflow')
  const [desc, setDesc] = useState('')
  const [msg, setMsg] = useState('')

  const load = async () => {
    try { const r = await fetch(`${API}/agent/workflows/list`); const d = await r.json(); if (d.success) setWfs(d.data || []) } catch { setMsg('Failed') }
  }
  useEffect(() => { load() }, [])

  const create = async () => {
    if (!name) { setMsg('❌ Name required'); return }
    try {
      const r = await fetch(`${API}/agent/workflows/create`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name, description: desc,
          nodes: [
            { id: 'trigger-1', type: 'trigger', name: 'Manual Trigger', config: {} },
            { id: 'llm-1', type: 'llm_prompt', name: 'AI Step', config: { prompt: 'Summarize MindMappr activity' } }
          ],
          edges: [{ from: 'trigger-1', to: 'llm-1' }]
        })
      })
      const d = await r.json()
      setMsg(d.success ? '✅ Created!' : '❌ ' + d.error)
      if (d.success) { load(); setName('My Workflow'); setDesc('') }
    } catch { setMsg('❌ Failed') }
  }

  const run = async (id: string) => {
    try {
      const r = await fetch(`${API}/agent/workflows/run/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const d = await r.json()
      setMsg(d.success ? '✅ Executed!' : '❌ ' + d.error)
    } catch { setMsg('Run failed') }
  }

  const del = async (id: string) => {
    if (!confirm('Delete workflow?')) return
    try {
      const r = await fetch(`${API}/agent/workflows/${id}`, { method: 'DELETE' })
      const d = await r.json()
      if (d.success) { setMsg('🗑️ Deleted'); load() }
    } catch { setMsg('Failed') }
  }

  return (
    <div className="p-4 space-y-4">
      <div className="glass rounded-2xl p-4 space-y-3">
        <h3 className="text-white font-semibold">⚡ Create Workflow</h3>
        <div className="grid grid-cols-2 gap-2">
          <div><label className="text-slate-400 text-xs mb-1 block">Name</label><input value={name} onChange={e => setName(e.target.value)} className="w-full glass rounded-lg px-3 py-2 text-sm text-slate-200 outline-none border border-transparent focus:border-orange-500/50" /></div>
          <div><label className="text-slate-400 text-xs mb-1 block">Description</label><input value={desc} onChange={e => setDesc(e.target.value)} className="w-full glass rounded-lg px-3 py-2 text-sm text-slate-200 outline-none border border-transparent focus:border-orange-500/50" /></div>
        </div>
        <button onClick={create} className="px-4 py-2 rounded-xl bg-orange-500/20 text-orange-400 text-sm hover:bg-orange-500/30 transition-all">+ Create</button>
        {msg && <div className="text-sm text-slate-300 glass rounded-lg px-3 py-2">{msg}</div>}
      </div>
      <div className="space-y-2">
        <h3 className="text-slate-400 text-xs font-semibold uppercase tracking-wider">Workflows ({wfs.length})</h3>
        {wfs.length === 0 && <p className="text-slate-500 text-sm text-center py-4">No workflows yet.</p>}
        {wfs.map((w: any) => (
          <div key={w.id} className="glass rounded-xl px-4 py-3 flex items-center justify-between">
            <div>
              <p className="text-slate-200 text-sm font-medium">{w.name}</p>
              <p className="text-slate-500 text-xs">{w.description || 'No description'} · {w.nodes?.length || 0} nodes</p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => run(w.id)} className="px-3 py-1 rounded-lg bg-green-500/20 text-green-400 text-xs hover:bg-green-500/30 transition-all">▶ Run</button>
              <button onClick={() => del(w.id)} className="px-3 py-1 rounded-lg bg-red-500/20 text-red-400 text-xs hover:bg-red-500/30 transition-all">🗑</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Analytics Tab ────────────────────────────────────────────────────────────
function AnalyticsTab() {
  const [dash, setDash] = useState<any>(null)
  const [alerts, setAlerts] = useState<any[]>([])
  const [form, setForm] = useState({ name: '', metric: 'response_time', condition: 'gt', threshold: '1000' })
  const [msg, setMsg] = useState('')

  const load = async () => {
    try {
      const [dr, ar] = await Promise.all([
        fetch(`${API}/agent/analytics/dashboard`).then(r => r.json()),
        fetch(`${API}/agent/analytics/alerts`).then(r => r.json()),
      ])
      if (dr.success) setDash(dr.data)
      if (ar.success) setAlerts(ar.data || [])
    } catch { setMsg('Failed to load') }
  }
  useEffect(() => { load() }, [])

  const createAlert = async () => {
    if (!form.name) { setMsg('❌ Name required'); return }
    try {
      const r = await fetch(`${API}/agent/analytics/alerts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, threshold: Number(form.threshold) })
      })
      const d = await r.json()
      setMsg(d.success ? '✅ Alert created!' : '❌ ' + d.error)
      if (d.success) load()
    } catch { setMsg('❌ Failed') }
  }

  const resolve = async (id: string) => {
    try { await fetch(`${API}/agent/analytics/alerts/${id}/resolve`, { method: 'POST' }); load() } catch { /* ignore */ }
  }

  return (
    <div className="p-4 space-y-4">
      {dash && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {[
            ['Messages 24h', dash.messages24h ?? 0],
            ['Messages 7d', dash.messages7d ?? 0],
            ['Sessions', dash.activeSessions ?? 0],
            ['LLM Calls', dash.llmCalls ?? 0],
            ['Error Rate', (dash.errorRate ?? 0) + '%'],
            ['Uptime', (dash.uptime ?? 100) + '%'],
          ].map(([l, v]) => (
            <div key={l as string} className="glass rounded-xl p-3 text-center">
              <p className="text-2xl font-bold text-orange-400">{v}</p>
              <p className="text-slate-500 text-xs mt-1">{l}</p>
            </div>
          ))}
        </div>
      )}
      {dash?.topFeatures?.length > 0 && (
        <div className="glass rounded-2xl p-4">
          <h3 className="text-white font-semibold text-sm mb-3">Top Features</h3>
          {dash.topFeatures.map((f: any, i: number) => (
            <div key={i} className="flex items-center gap-2 mb-2">
              <span className="text-slate-400 text-xs w-4">{i + 1}</span>
              <div className="flex-1 bg-white/5 rounded-full h-2">
                <div className="bg-gradient-to-r from-orange-500 to-amber-400 h-2 rounded-full" style={{ width: `${Math.min(100, (f.count / (dash.topFeatures[0]?.count || 1)) * 100)}%` }} />
              </div>
              <span className="text-slate-300 text-xs w-24 truncate">{f.name || f.feature}</span>
              <span className="text-slate-500 text-xs">{f.count}</span>
            </div>
          ))}
        </div>
      )}
      <div className="glass rounded-2xl p-4 space-y-3">
        <h3 className="text-white font-semibold">🔔 Create Alert</h3>
        <div className="grid grid-cols-2 gap-2">
          <div><label className="text-slate-400 text-xs mb-1 block">Alert Name</label><input value={form.name} onChange={e => setForm(f => ({...f, name: e.target.value}))} className="w-full glass rounded-lg px-3 py-2 text-sm text-slate-200 outline-none border border-transparent focus:border-orange-500/50" /></div>
          <div><label className="text-slate-400 text-xs mb-1 block">Metric</label><input value={form.metric} onChange={e => setForm(f => ({...f, metric: e.target.value}))} className="w-full glass rounded-lg px-3 py-2 text-sm text-slate-200 outline-none border border-transparent focus:border-orange-500/50" /></div>
          <div><label className="text-slate-400 text-xs mb-1 block">Condition</label><select value={form.condition} onChange={e => setForm(f => ({...f, condition: e.target.value}))} className="w-full glass rounded-lg px-3 py-2 text-sm text-slate-200 bg-transparent border border-transparent outline-none"><option value="gt">Greater than</option><option value="lt">Less than</option><option value="eq">Equal to</option></select></div>
          <div><label className="text-slate-400 text-xs mb-1 block">Threshold</label><input type="number" value={form.threshold} onChange={e => setForm(f => ({...f, threshold: e.target.value}))} className="w-full glass rounded-lg px-3 py-2 text-sm text-slate-200 outline-none border border-transparent focus:border-orange-500/50" /></div>
        </div>
        <div className="flex gap-2">
          <button onClick={createAlert} className="px-4 py-2 rounded-xl bg-orange-500/20 text-orange-400 text-sm hover:bg-orange-500/30 transition-all">+ Alert</button>
          <button onClick={load} className="px-4 py-2 rounded-xl bg-white/10 text-slate-300 text-sm hover:bg-white/20 transition-all">↻ Refresh</button>
          <a href={`${API}/agent/analytics/export?format=json`} target="_blank" rel="noopener noreferrer" className="px-4 py-2 rounded-xl bg-green-500/20 text-green-400 text-sm hover:bg-green-500/30 transition-all">⬇ Export</a>
        </div>
        {msg && <div className="text-sm text-slate-300 glass rounded-lg px-3 py-2">{msg}</div>}
      </div>
      <div className="space-y-2">
        <h3 className="text-slate-400 text-xs font-semibold uppercase tracking-wider">Active Alerts ({alerts.length})</h3>
        {alerts.length === 0 && <p className="text-slate-500 text-sm text-center py-4">No active alerts.</p>}
        {alerts.map((a: any) => (
          <div key={a.id} className="glass rounded-xl px-4 py-3 flex items-center justify-between">
            <div>
              <p className="text-slate-200 text-sm font-medium">{a.name}</p>
              <p className="text-slate-500 text-xs">{a.metric} · threshold: {a.threshold}</p>
            </div>
            <div className="flex items-center gap-2">
              <Badge status={a.active ? 'active' : 'resolved'} />
              {a.active && <button onClick={() => resolve(a.id)} className="px-2 py-1 rounded-lg bg-green-500/20 text-green-400 text-xs hover:bg-green-500/30">✓</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState<Tab>('Chat')

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white flex flex-col" style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>
      {/* Background orbs */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-40 -left-40 w-96 h-96 bg-orange-500/10 rounded-full blur-3xl animate-pulse" />
        <div className="absolute -bottom-40 -right-40 w-96 h-96 bg-amber-500/8 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />
      </div>

      {/* Header */}
      <header className="flex-shrink-0 border-b border-white/10 bg-black/40 backdrop-blur-xl sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-orange-500 to-amber-400 flex items-center justify-center text-sm shadow-lg shadow-orange-500/30">🧠</div>
            <span className="font-bold text-white">MindMappr</span>
            <span className="text-slate-500 text-xs hidden sm:inline">Agent Tool v2</span>
          </div>
          <a href="https://meetaudreyevans.com" target="_blank" rel="noopener noreferrer" className="text-xs text-slate-500 hover:text-orange-400 transition-colors">GlowStarLabs ↗</a>
        </div>
        {/* Tab bar */}
        <div className="max-w-5xl mx-auto px-4 pb-2 flex gap-1 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {TABS.map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all ${tab === t ? 'bg-orange-500/20 text-orange-400 border border-orange-500/30' : 'text-slate-400 hover:text-white hover:bg-white/10'}`}>
              <span>{TAB_ICONS[t]}</span><span>{t}</span>
            </button>
          ))}
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-y-auto max-w-5xl w-full mx-auto relative z-0">
        {tab === 'Chat' && <ChatTab />}
        {tab === 'Files' && <FilesTab />}
        {tab === 'Pipelines' && <PipelinesTab />}
        {tab === 'APIs' && <APIsTab />}
        {tab === 'Builds' && <BuildsTab />}
        {tab === 'App Store' && <AppStoreTab />}
        {tab === 'Workflows' && <WorkflowsTab />}
        {tab === 'Analytics' && <AnalyticsTab />}
      </main>

      {/* Footer */}
      <footer className="border-t border-white/5 py-2 text-center text-xs text-slate-600 relative z-10 flex-shrink-0">
        Powered by <a href="https://openrouter.ai" target="_blank" rel="noopener noreferrer" className="hover:text-orange-400">OpenRouter</a> · Built by <a href="https://meetaudreyevans.com" target="_blank" rel="noopener noreferrer" className="hover:text-orange-400">GlowStarLabs</a> · Code review by Venice AI
      </footer>
    </div>
  )
}
