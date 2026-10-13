'use strict'

// session-flow viewer. Reads a session log (docs/events.md) from the local
// server, builds the tree session → turn → agent → step → call, and draws it
// with a virtualised list, filters and an inspector.

const ROW_H = 30
const POLL_MS = 2000
const GROUP_MIN = 3

const KINDS = [
  { key: 'tool', label: 'Tools', color: '--c-tool' },
  { key: 'hook', label: 'Hooks', color: '--c-hook' },
  { key: 'text', label: 'Text', color: '--c-text' },
  { key: 'thinking', label: 'Thinking', color: '--c-thinking' },
  { key: 'context', label: 'Context', color: '--c-context' },
]

const ICONS = {
  turn: '<path d="M4 5h16v10H9l-5 4z"/>',
  launch: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/>',
  agent: '<path d="M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4z"/><path d="M18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z"/>',
  step: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/>',
  bash: '<path d="M4 17l6-5-6-5"/><path d="M12 19h8"/>',
  read: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  mcp: '<path d="M8 3v6M16 3v6M6 9h12v3a6 6 0 01-12 0zM12 18v3"/>',
  tool: '<path d="M14 6a4 4 0 00-5 5l-6 6 2 2 6-6a4 4 0 005-5l-3 3-2-2z"/>',
  skill: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  hook: '<path d="M8 3v9a4 4 0 008 0v-2"/><path d="M13 13l3-3 3 3"/>',
  text: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  thinking: '<path d="M9 18h6M10 21h4M12 3a6 6 0 00-4 10.5V16h8v-2.5A6 6 0 0012 3z"/>',
  context: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  workflow: '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="9" y="15" width="6" height="6" rx="1"/><path d="M6 9v2a2 2 0 002 2h8a2 2 0 002-2V9M12 13v2"/>',
  message: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/>',
  plan: '<path d="M10 6h10M10 12h10M10 18h10"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>',
  schedule: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  artifact: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/>',
  setup: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  group: '<rect x="4" y="4" width="16" height="5" rx="1"/><rect x="4" y="11" width="16" height="5" rx="1"/><path d="M6 20h12"/>',
  session: '<circle cx="6" cy="12" r="3"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M9 11l7-4M9 13l7 4"/>',
}

const state = {
  sessions: [],
  sid: null,
  records: [],
  offset: 0,
  hooks: {},
  hookConf: [],
  model: null,
  open: new Map(),
  selected: null,
  visible: [],
  follow: false,
  live: false,
  view: 'tree',
  filters: { kinds: new Set(KINDS.map(k => k.key)), q: '', errors: false, steps: true, minMs: 0, emptyThinking: false, families: new Set(), tools: new Set(), scope: 'all' },
  preset: 'everything',
  timer: null,
  hooksAt: 0,
}

const $ = (s, el = document) => el.querySelector(s)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const oneLine = (s, n = 160) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const base = p => String(p ?? '').split('/').filter(Boolean).pop() ?? ''

function fmtMs(ms) {
  if (ms == null || !isFinite(ms)) return ''
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}
const fmtNum = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n || 0)))
const fmtClock = ts => (ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '')
function fmtAgo(ts) {
  if (!ts) return ''
  const d = (Date.now() - ts) / 1000
  if (d < 60) return 'just now'
  if (d < 3600) return `${Math.floor(d / 60)} min ago`
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`
  return new Date(ts).toLocaleDateString()
}

// Tools

// Families of tools: colour and icon in the tree, and a filter of their own.
const FAMILIES = {
  bash: { label: 'Shell', color: '--c-bash', icon: 'bash', tools: ['Bash', 'BashOutput', 'KillShell', 'Monitor'] },
  read: { label: 'Read', color: '--c-read', icon: 'read', tools: ['Read', 'NotebookRead'] },
  search: { label: 'Search', color: '--c-search', icon: 'search', tools: ['Glob', 'Grep', 'LSP', 'ToolSearch'] },
  edit: { label: 'Edit', color: '--c-edit', icon: 'edit', tools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] },
  web: { label: 'Web', color: '--c-web', icon: 'web', tools: ['WebFetch', 'WebSearch'] },
  mcp: { label: 'MCP', color: '--c-mcp', icon: 'mcp', tools: ['ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool', 'WaitForMcpServers'] },
  agent: { label: 'Launch agent', color: '--c-agent', icon: 'launch', tools: ['Agent', 'Task'] },
  workflow: { label: 'Workflow', color: '--c-workflow', icon: 'workflow', tools: ['Workflow'] },
  message: { label: 'Agent messages', color: '--c-message', icon: 'message', tools: ['SendMessage', 'SubagentHandback', 'ListAgents', 'FetchInboxMessage', 'ReadNotifications'] },
  user: { label: 'User', color: '--c-user', icon: 'user', tools: ['AskUserQuestion', 'SendUserMessage', 'SendUserFile', 'SendFile', 'PushNotification', 'EndConversation', 'ProposeGoal', 'Poll'] },
  plan: { label: 'Plan and tasks', color: '--c-plan', icon: 'plan', tools: ['TodoWrite', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskStop', 'GetTask', 'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree'] },
  schedule: { label: 'Schedule', color: '--c-schedule', icon: 'schedule', tools: ['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger'] },
  skill: { label: 'Skills', color: '--c-skill', icon: 'skill', tools: ['Skill', 'ListSkills', 'SearchSkills', 'SuggestSkills'] },
  artifact: { label: 'Artifacts and design', color: '--c-artifact', icon: 'artifact', tools: ['Artifact', 'ArtifactCheck', 'ArtifactComments', 'ArtifactData', 'AppifactRepl', 'ClaudeDesign', 'DesignSync', 'ReportFindings'] },
  setup: { label: 'Plugins and setup', color: '--c-setup', icon: 'setup', tools: ['ListPlugins', 'SearchPlugins', 'SuggestPluginInstall', 'PublishPlugin', 'ListConnectors', 'SuggestConnectors', 'SearchMcpRegistry', 'OfferChromeSetup', 'ShareOnboardingGuide', 'ShowOnboardingRolePicker', 'SendFeedback', 'Projects'] },
  tool: { label: 'Other', color: '--c-tool', icon: 'tool', tools: [] },
}
const TOOL_FAMILY = new Map(Object.entries(FAMILIES).flatMap(([f, d]) => d.tools.map(t => [t, f])))
const toolFamily = name => (!name ? 'tool' : name.startsWith('mcp__') ? 'mcp' : TOOL_FAMILY.get(name) ?? 'tool')

function toolSummary(name, input = {}) {
  const i = input || {}
  switch (name) {
    case 'Bash': return i.description || i.command
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': return base(i.file_path || i.notebook_path)
    case 'Glob': return i.pattern
    case 'Grep': return `${i.pattern ?? ''}${i.path ? `  in ${base(i.path)}` : ''}`
    case 'WebFetch': try { const u = new URL(i.url); return u.host + u.pathname } catch { return i.url }
    case 'WebSearch': return i.query
    case 'Agent': case 'Task': return `${i.description ?? ''}${i.subagent_type ? ` · ${i.subagent_type}` : ''}`
    case 'Skill': return i.skill + (i.args ? ` ${i.args}` : '')
    case 'ToolSearch': return i.query
    case 'SendMessage': return i.to
    case 'Workflow': return i.name || (i.scriptPath ? base(i.scriptPath) : 'inline script')
    case 'TodoWrite': return Array.isArray(i.todos) ? `${i.todos.length} todos` : ''
    case 'AskUserQuestion': return i.questions?.[0]?.question
    case 'ScheduleWakeup': return i.stop ? 'stop' : `${i.delaySeconds}s · ${i.reason ?? ''}`
    default: {
      const v = Object.values(i).find(x => typeof x === 'string')
      return v
    }
  }
}
function toolName(name) {
  if (name?.startsWith('mcp__')) {
    const [, server, ...rest] = name.split('__')
    return `${rest.join('__')} · ${server}`
  }
  return name
}

// Hooks: the engine says which event ran a hook, not which command; the
// candidates are the configured hooks for that event whose matcher fits.

const TOOL_HOOK_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied'])

function matcherOk(m, tool) {
  if (!m || m === '*' || !tool) return true
  try {
    return new RegExp(`^(?:${m})$`).test(tool)
  } catch {
    return m.split('|').includes(tool)
  }
}

function hookShort(cmd) {
  const tok = String(cmd ?? '').split(/\s+/).map(t => t.replace(/^["']|["']$/g, '')).find(t => t.includes('/'))
  return tok ? base(tok) : oneLine(cmd, 40)
}

// Model

function build(records, hooks, hookConf = []) {
  const nodes = new Map()
  let seq = 0
  const mk = (id, kind, props = {}) => {
    const n = { id: id ?? `n${seq++}`, kind, children: [], data: {}, status: 'ok', ...props }
    nodes.set(n.id, n)
    return n
  }
  const add = (parent, n) => {
    if (n.parent) {
      const sib = n.parent.children
      sib.splice(sib.indexOf(n), 1)
    }
    n.parent = parent
    parent.children.push(n)
    return n
  }

  const root = mk('session', 'session', { label: 'Session' })
  const S = {
    turn: null, turnN: 0, steps: new Map(), agents: new Map(), tools: new Map(), running: new Map(), lastEnded: new Map(), hookIdx: new Map(),
    pendingPrompt: null, pendingCtx: [], pendingSkill: [], ctxGroups: new Map(),
    info: { reloads: 0 }, offers: { skills: [], agents: [] }, collector: { ms: 0, events: 0, errors: [] },
    first: null, last: null, kinds: {}, toolUses: [],
  }

  const agentNode = a => {
    let n = S.agents.get(a)
    if (!n) {
      n = mk(`agent:${a}`, 'agent', { label: `Agent ${a.slice(0, 8)}`, agent: a })
      add(S.turn ?? root, n)
      S.agents.set(a, n)
    }
    return n
  }
  const container = a => (a ? agentNode(a) : S.turn ?? root)
  const here = a => S.steps.get(a ?? null) ?? container(a)
  const ctxGroup = parent => {
    let g = S.ctxGroups.get(parent.id)
    if (!g) {
      g = mk(`ctx:${parent.id}`, 'ctxgroup', { label: 'Injected context', agent: parent.agent })
      add(parent, g)
      S.ctxGroups.set(parent.id, g)
    }
    return g
  }
  const toolNode = (id, a) => {
    let n = S.tools.get(id)
    if (!n) {
      n = mk(`tool:${id}`, 'tool', { agent: a })
      add(here(a), n)
      S.tools.set(id, n)
    }
    return n
  }

  for (const r of records) {
    const a = r.agent ?? null
    if (r.ts) {
      S.first = S.first ? Math.min(S.first, r.ts) : r.ts
      S.last = S.last ? Math.max(S.last, r.ts) : r.ts
    }
    if (r.kind !== 'collector.stats') S.kinds[r.kind] = (S.kinds[r.kind] ?? 0) + 1
    if (r.kind === 'row' && r.type === 'assistant') for (const b of r.blocks ?? []) if (b.type === 'tool_use') S.toolUses.push(b.name)
    switch (r.kind) {
      case 'session.start':
        if (S.info.start) S.info.reloads++
        else S.info.start = r
        break
      case 'session.info': S.info.transcriptPath = r.transcriptPath; break
      case 'session.end': S.info.end = r; break
      case 'offer.skills': S.offers.skills = r.skills ?? []; break
      case 'offer.agent': S.offers.agents.push(r); break
      case 'collector.stats':
        S.kinds[r.kind] = (S.kinds[r.kind] ?? 0) + 1
        for (const v of Object.values(r.ownMs ?? {})) S.collector.ms += v
        for (const v of Object.values(r.events ?? {})) S.collector.events += v
        S.collector.errors.push(...(r.errors ?? []))
        break

      case 'prompt':
        S.pendingPrompt = r
        break

      case 'turn.start': {
        const p = S.pendingPrompt
        S.pendingPrompt = null
        const isTask = p?.origin === 'task-notification'
        const text = p?.text ?? r.text ?? ''
        const n = mk(`turn:${r.turnId}`, 'turn', { t0: r.ts, label: isTask ? 'Background task finished' : oneLine(text, 200) || '(empty prompt)', agent: null })
        n.data = { prompt: p, start: r, isTask, n: ++S.turnN }
        if (isTask) n.sub = oneLine(text.replace(/<[^>]+>/g, ' '), 160)
        add(root, n)
        S.turn = n
        S.steps.delete(null)
        for (const ctx of S.pendingCtx) add(ctxGroup(n), ctx)
        S.pendingCtx = []
        for (const sk of S.pendingSkill) add(n, sk)
        S.pendingSkill = []
        break
      }
      case 'turn.end':
        if (a === null) {
          const t = nodes.get(`turn:${r.turnId}`) ?? S.turn
          if (t) {
            t.t1 = r.ts
            t.data.end = r
            if (r.reason === 'error' || r.reason === 'refusal' || r.isAborted) t.status = 'error'
          }
        } else {
          const ag = agentNode(a)
          ag.t1 = r.ts
          ;(ag.data.runs ??= []).push(r)
          if (r.reason === 'error' || r.isAborted) ag.status = 'error'
          S.steps.delete(a)
        }
        break

      case 'step.start': {
        const n = mk(`step:${a}:${r.turnId}:${r.index}`, 'step', { t0: r.ts, agent: a })
        n.data.start = r
        add(container(a), n)
        S.steps.set(a, n)
        break
      }
      case 'step.end': {
        const n = nodes.get(`step:${a}:${r.turnId}:${r.index}`)
        if (n) {
          n.t1 = r.ts
          n.data.end = r
        }
        break
      }

      case 'row': {
        const origin = r.origin ?? {}
        if (origin.kind === 'hook') {
          const det = hooks?.[r.uuid]
          const tid = det?.toolUseId
          const run = [...(S.running.get(a) ?? [])]
          const recent = S.lastEnded.get(a)
          const toolEvent = TOOL_HOOK_EVENTS.has(origin.event)
          const guess = !toolEvent ? null : run.length === 1 ? run[0] : !run.length && recent && r.ts - recent.t1 < 2000 ? recent : null
          const parent = (tid && S.tools.get(tid)) || guess || here(a)
          const tool = parent.kind === 'tool' ? parent.data.toolName : null
          const cands = hookConf.filter(h => !h.host && h.event === origin.event && matcherOk(h.matcher, tool))
          const host = hookConf.find(h => h.host)
          const key = `${parent.id}|${origin.event}`
          const idx = S.hookIdx.get(key) ?? 0
          S.hookIdx.set(key, idx + 1)
          // Configured hooks first, in order; rows beyond them are the host app's.
          const pick = det ? null : cands[idx] ?? host ?? (cands.length === 1 ? cands[0] : null)
          const n = mk(`hook:${r.uuid}`, 'hook', { t0: r.ts, agent: a, label: det?.command ? hookShort(det.command) : det?.hookName || (pick ? hookShort(pick.command) : origin.event || 'hook') })
          n.data = { row: r, detail: det, event: null, cands, pick, hookEvent: origin.event }
          n.sub = det ? [origin.event, 'from the transcript'].join(' · ') : [origin.event, r.name !== 'hook_success' ? r.name : null, pick ? pick.source : cands.length ? `${cands.length} candidates` : 'not in settings'].filter(Boolean).join(' · ')
          if (det && (det.exitCode ?? 0) !== 0) n.status = 'error'
          if (det?.durationMs != null) n.t1 = r.ts + det.durationMs
          add(parent, n)
          break
        }
        if (r.type === 'assistant') {
          for (const [i, b] of (r.blocks ?? []).entries()) {
            if (b.type === 'text' && b.text?.trim()) {
              const n = mk(`text:${r.uuid}:${i}`, 'text', { t0: r.ts, agent: a, label: 'Text', sub: oneLine(b.text, 220) })
              n.data = { text: b.text, len: b.textLen }
              add(here(a), n)
            } else if (b.type === 'thinking') {
              const empty = !b.text?.trim()
              const n = mk(`think:${r.uuid}:${i}`, 'thinking', { t0: r.ts, agent: a, label: 'Thinking', sub: empty ? '(content not available)' : oneLine(b.text, 220) })
              n.data = { text: b.text, len: b.textLen, empty }
              add(here(a), n)
            } else if (b.type === 'tool_use' && b.id) {
              const n = toolNode(b.id, a)
              n.data.toolName ??= b.name
            }
          }
          break
        }
        if (r.type === 'user' && (r.door === 'prompt' || r.door === 'tool-result')) break
        // Everything else the engine adds: injected context, notices, deliveries.
        const text = (r.blocks ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n\n')
        if (!text && r.type === 'attachment' && !r.name) break
        const n = mk(`ctx:${r.uuid}`, 'context', { t0: r.ts, agent: a, label: r.name || r.door || r.type, sub: oneLine(text, 180) })
        n.data = { row: r, text }
        if (a) add(ctxGroup(agentNode(a)), n)
        else if (S.pendingPrompt || !S.turn) S.pendingCtx.push(n)
        else add(ctxGroup(S.turn), n)
        break
      }

      case 'tool.start': {
        const n = toolNode(r.toolUseId, a)
        n.t0 = r.ts
        n.data.toolName = r.tool
        n.data.input = r.input
        n.data.start = r
        if (!S.running.has(a)) S.running.set(a, new Set())
        S.running.get(a).add(n)
        break
      }
      case 'permission': {
        const n = S.tools.get(r.toolUseId)
        if (n) {
          n.data.permission = r
          if (r.decision === 'deny') n.status = 'denied'
        }
        break
      }
      case 'tool.end': {
        const n = toolNode(r.toolUseId, a)
        n.t1 = r.ts
        n.data.end = r
        n.data.toolName ??= r.tool
        if (r.denied) n.status = 'denied'
        else if (r.isError) n.status = 'error'
        S.running.get(a)?.delete(n)
        S.lastEnded.set(a, n)
        break
      }

      case 'agent.spawn': {
        const child = r.child ?? `pending-${r.toolUseId}`
        const n = agentNode(child)
        n.t0 = r.ts
        n.label = r.description || r.type || 'Agent'
        n.data.spawn = r
        if (r.denied) n.status = 'denied'
        const parent = S.tools.get(r.toolUseId) ?? container(r.parent ?? null)
        add(parent, n)
        break
      }

      case 'skill.load': {
        if (r.via === 'tool' && S.tools.get(r.toolUseId)) {
          S.tools.get(r.toolUseId).data.skill = r
          break
        }
        const n = mk(`skill:${r.seq}:${r.ts}`, 'skill', { t0: r.ts, agent: a, label: `/${r.skill}`, sub: r.args ? oneLine(r.args, 120) : `loaded (${r.via})` })
        n.data.skill = r
        if (r.via === 'command' && S.pendingPrompt) S.pendingSkill.push(n)
        else add(here(a), n)
        break
      }
      case 'skill.expand': {
        const n = mk(null, 'skill', { t0: r.ts, agent: a, label: r.skill, sub: 'expanded' })
        n.data.skill = r
        add(here(a), n)
        break
      }
      case 'hook': {
        const n = mk(null, 'hook', { t0: r.ts, t1: r.ts + (r.durationMs ?? 0), agent: a, label: r.event, sub: r.outcome ? JSON.stringify(r.outcome) : '' })
        n.data = { event: r }
        add((r.toolUseId && S.tools.get(r.toolUseId)) || here(a), n)
        break
      }
    }
  }

  // Agents are the tree's backbone: the Agent call that launched one becomes
  // its header (one row), its hooks the agent's first children.
  for (const ag of S.agents.values()) {
    const call = ag.parent
    if (call?.kind !== 'tool' || toolFamily(call.data.toolName) !== 'agent' || call.mergedInto) continue
    const hooks = call.children.filter(c => c.kind === 'hook')
    call.children = call.children.filter(c => c !== ag && c.kind !== 'hook')
    const sib = call.parent.children
    sib.splice(sib.indexOf(call), 1, ag)
    ag.parent = call.parent
    for (const h of hooks) h.parent = ag
    ag.children.unshift(...hooks)
    ag.data.call = call
    call.mergedInto = ag
    if (call.t0 != null) ag.t0 = Math.min(call.t0, ag.t0 ?? call.t0)
    if (ag.status === 'ok' && call.status !== 'ok') ag.status = call.status
  }

  // Labels, families and roll-ups.
  const finish = n => {
    for (const c of n.children) finish(c)
    if (n.kind === 'tool') {
      const name = n.data.toolName
      n.family = n.data.skill ? 'skill' : toolFamily(name)
      n.label = toolName(name) ?? 'tool'
      n.sub = oneLine(toolSummary(name, n.data.input), 200)
      if (n.data.end?.denied) n.sub = `denied: ${oneLine(n.data.end.denied, 120)}`
    }
    if (n.kind === 'step') {
      const s = n.data.start ?? {}
      const e = n.data.end ?? {}
      n.label = `Step ${(s.index ?? 0) + 1}`
      const u = e.usage
      n.sub = [s.model, e.stopReason && e.stopReason !== 'tool_use' ? e.stopReason : null].filter(Boolean).join(' · ')
      n.tokens = u ? (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : 0
      n.outTokens = u?.output_tokens ?? 0
    }
    if (n.kind === 'agent') {
      const sp = n.data.spawn ?? {}
      n.sub = [sp.type, sp.model, sp.background ? 'background' : null].filter(Boolean).join(' · ')
    }
    if (n.kind === 'ctxgroup') n.sub = `${n.children.length} blocks`
    if (n.kind === 'skill') {
      n.family = 'skill'
      n.data.toolName ??= 'Skill'
    }
    if (n.t0 == null) n.t0 = n.children.find(c => c.t0 != null)?.t0
    const kidsEnd = Math.max(...n.children.map(c => c.t1 ?? c.t0 ?? 0), 0)
    n.tEnd = Math.max(n.t1 ?? 0, kidsEnd, n.t0 ?? 0)
    n.tot = { tools: 0, errors: 0, tokens: n.tokens ?? 0, out: n.outTokens ?? 0, agents: 0, hooks: 0 }
    for (const c of n.children) {
      n.tot.tools += c.tot.tools + (c.kind === 'tool' ? 1 : 0)
      n.tot.errors += c.tot.errors + (c.status === 'error' || c.status === 'denied' ? 1 : 0)
      n.tot.tokens += c.tot.tokens
      n.tot.out += c.tot.out
      n.tot.agents += c.tot.agents + (c.kind === 'agent' ? 1 : 0)
      n.tot.hooks += c.tot.hooks + (c.kind === 'hook' ? 1 : 0)
    }
  }
  finish(root)

  // Open ends: running while the session is live, otherwise unknown.
  const ended = !!S.info.end
  for (const n of nodes.values()) {
    if (['tool', 'agent', 'step', 'turn'].includes(n.kind) && n.t0 != null && n.t1 == null) {
      if (!ended && state.live) n.status = n.status === 'ok' ? 'running' : n.status
    }
  }
  // Each top-level turn is the time frame of the bars beneath it.
  const frame = (n, f) => {
    n.frame = f
    for (const c of n.children) frame(c, f)
  }
  for (const t of root.children) frame(t, { t0: t.t0 ?? S.first, t1: Math.max(t.tEnd, (t.t0 ?? 0) + 1) })

  return { root, nodes, S }
}

// Visible rows: filters, grouping, steps toggle.

function category(n) {
  if (n.kind === 'tool' || n.kind === 'group' || n.kind === 'skill') return 'tool'
  if (n.kind === 'ctxgroup') return 'context'
  return n.kind
}

function searchText(n) {
  if (n._search) return n._search
  const d = n.data
  const parts = [n.label, n.sub, d.text, d.prompt?.text, d.end?.text, d.end?.answer, d.spawn?.prompt, d.detail?.command, d.detail?.stdout]
  if (d.input) parts.push(JSON.stringify(d.input))
  n._search = parts.filter(Boolean).join('\n').toLowerCase()
  return n._search
}

function filtersActive() {
  const f = state.filters
  return !!(f.q || f.errors || f.minMs)
}

function matches(n) {
  const f = state.filters
  if (f.errors && !(n.status === 'error' || n.status === 'denied')) return false
  if (f.minMs) {
    const d = (n.t1 ?? n.tEnd) - (n.t0 ?? 0)
    if (!(n.t0 && d >= f.minMs)) return false
  }
  if (f.q && !searchText(n).includes(f.q)) return false
  return true
}

function kindShown(n) {
  if (n.kind === 'thinking' && n.data.empty && !state.filters.emptyThinking) return false
  const c = category(n)
  if (c === 'tool') {
    const f = state.filters
    const name = n.kind === 'group' ? n.children[0]?.data.toolName : n.data.toolName
    if (f.families.has(n.family) || f.tools.has(name)) return false
  }
  if (KINDS.some(k => k.key === c)) return state.filters.kinds.has(c)
  return true
}

function isOpen(n) {
  if (state.open.has(n.id)) return state.open.get(n.id)
  if (n.kind === 'turn') return n === state.model?.root.children.at(-1)
  if (n.kind === 'group' || n.kind === 'ctxgroup' || n.kind === 'hook') return false
  if (n.kind === 'tool') return n.children.some(c => c.kind !== 'hook')
  if (n.kind === 'agent') return n.children.some(c => c.kind !== 'hook')
  return true
}

// Children as shown: steps flattened when hidden, runs of one tool grouped.
function shownChildren(n) {
  let kids = []
  for (const c of n.children) {
    if (c.kind === 'step' && !state.filters.steps) kids.push(...shownChildren(c))
    else kids.push(c)
  }
  const out = []
  for (let i = 0; i < kids.length; ) {
    const c = kids[i]
    let j = i
    if (c.kind === 'tool' && c.family !== 'agent') {
      while (j + 1 < kids.length && kids[j + 1].kind === 'tool' && kids[j + 1].data.toolName === c.data.toolName && kids[j + 1].children.every(k => k.kind === 'hook')) j++
    }
    if (j - i + 1 >= GROUP_MIN) {
      const items = kids.slice(i, j + 1)
      const id = `grp:${c.id}`
      let g = state.model.nodes.get(id)
      if (!g) {
        g = { id, kind: 'group', children: items, data: {}, status: 'ok', parent: n, agent: c.agent, family: c.family, frame: c.frame }
        state.model.nodes.set(id, g)
      }
      g.children = items
      g.label = `${toolName(c.data.toolName)} ×${items.length}`
      g.sub = items.map(x => x.sub).filter(Boolean).slice(0, 3).join(' · ')
      g.t0 = Math.min(...items.map(x => x.t0 ?? Infinity))
      g.t1 = Math.max(...items.map(x => x.t1 ?? x.t0 ?? 0))
      g.tEnd = g.t1
      g.status = items.some(x => x.status === 'error' || x.status === 'denied') ? 'error' : items.some(x => x.status === 'running') ? 'running' : 'ok'
      g.tot = { tools: items.length, errors: items.filter(x => x.status !== 'ok' && x.status !== 'running').length, tokens: 0, out: 0, agents: 0, hooks: 0 }
      out.push(g)
      i = j + 1
    } else {
      out.push(c)
      i++
    }
  }
  return out
}

// Children as drawn: a hidden kind never hides its children, they move up a
// level; `via` is the hidden node they came from, shown beside them.
function visibleKids(n) {
  const out = []
  for (const c of shownChildren(n)) {
    if (kindShown(c)) out.push({ n: c })
    else for (const k of visibleKids(c)) out.push({ n: k.n, via: k.via ?? c })
  }
  return out
}

function computeVisible() {
  const rows = []
  const active = filtersActive()
  const scope = state.filters.scope
  const target = scope !== 'all' && scope !== 'main' ? state.model?.nodes.get(scope) : null
  const path = new Set()
  for (let p = target?.parent; p; p = p.parent) path.add(p.id)
  const walk = (n, depth, inside) => {
    let any = false
    for (const { n: c, via } of visibleKids(n)) {
      const inScope = inside || !target || c === target
      if (!inScope && !path.has(c.id)) continue
      const leaf = scope === 'main' && c.kind === 'agent'
      const hasKids = !leaf && visibleKids(c).length > 0
      const forced = !inScope
      const open = forced || active || isOpen(c)
      const mark = rows.length
      const self = active ? matches(c) : true
      rows.push({ n: c, depth, hit: active && self, via, path: forced })
      const kidsShown = hasKids && open ? walk(c, depth + 1, inScope) : false
      if (active && !self && !kidsShown) rows.length = mark
      else {
        any = true
        rows[mark].open = hasKids ? (active || forced ? kidsShown : isOpen(c)) : null
        if (!active && !forced && !isOpen(c) && hasKids) rows.length = mark + 1
      }
    }
    return any
  }
  if (state.model) walk(state.model.root, 0, false)
  // Collapse what the user closed even while filtering.
  if (active) {
    const out = []
    let skipDepth = Infinity
    for (const r of rows) {
      if (r.depth > skipDepth) continue
      skipDepth = Infinity
      if (r.open && state.open.get(r.n.id) === false) {
        r.open = false
        skipDepth = r.depth
      }
      out.push(r)
    }
    return out
  }
  return rows
}

// Drawing

function color(n) {
  if (n.status === 'error' || n.status === 'denied') return 'var(--c-error)'
  if (n.kind === 'tool' || n.kind === 'group') return `var(${FAMILIES[n.family]?.color ?? '--c-tool'})`
  const map = { turn: '--c-turn', agent: '--c-agent', step: '--c-step', skill: '--c-skill', hook: '--c-hook', text: '--c-text', thinking: '--c-thinking', context: '--c-context', ctxgroup: '--c-context', session: '--c-agent' }
  return `var(${map[n.kind] ?? '--c-tool'})`
}
function icon(n) {
  const key = n.kind === 'tool' || n.kind === 'group' ? (n.kind === 'group' ? 'group' : FAMILIES[n.family]?.icon ?? 'tool') : n.kind === 'ctxgroup' ? 'context' : n.kind
  return `<svg viewBox="0 0 24 24">${ICONS[key] ?? ICONS.tool}</svg>`
}

function chips(n) {
  const out = []
  const end = n.t1 ?? (n.status === 'running' ? state.model.S.last : null)
  if (n.t0 && end && ['turn', 'agent', 'step', 'tool', 'group', 'hook'].includes(n.kind)) out.push(`<span class="chip${n.status === 'running' ? ' run' : ''}">${fmtMs(end - n.t0)}</span>`)
  if (n.kind === 'turn' || n.kind === 'agent') {
    if (n.tot.agents) out.push(`<span class="chip ag" title="subagents">${n.tot.agents}✦</span>`)
    if (n.tot.tools) out.push(`<span class="chip" title="tool calls">${n.tot.tools}⚒</span>`)
  }
  if ((n.kind === 'step' || n.kind === 'agent') && n.tot.out) out.push(`<span class="chip" title="output tokens">${fmtNum(n.tot.out)} out</span>`)
  const ownHooks = n.kind === 'tool' ? n.children.filter(c => c.kind === 'hook').length : 0
  if (ownHooks) out.push(`<span class="chip hk">${ownHooks} hook${ownHooks > 1 ? 's' : ''}</span>`)
  if (n.tot?.errors && n.kind !== 'tool') out.push(`<span class="chip err">${n.tot.errors} err</span>`)
  if (n.status === 'denied') out.push('<span class="chip err">denied</span>')
  return out.join('')
}

function bar(n) {
  const f = n.frame
  if (!f || n.t0 == null) return '<span class="tl"></span>'
  const span = Math.max(f.t1 - f.t0, 1)
  const end = n.t1 ?? (n.status === 'running' ? state.model.S.last : n.t0)
  const left = Math.max(0, Math.min(100, ((n.t0 - f.t0) / span) * 100))
  const width = Math.max(0.6, Math.min(100 - left, ((end - n.t0) / span) * 100))
  return `<span class="tl"><i style="left:${left}%;width:${width}%"></i></span>`
}

function rowHtml(r, i) {
  const n = r.n
  const cls = ['row', `k-${n.kind}`, `st-${n.status}`, n.id === state.selected ? 'sel' : '', r.hit ? 'hit' : '', r.path ? 'path' : ''].join(' ')
  const via = r.via ? `<span class="via">in ${esc(r.via.label)}${r.via.sub ? `: ${esc(oneLine(r.via.sub, 60))}` : ''}</span>` : ''
  const tw = r.open == null ? '' : `<span class="tw${r.open ? ' open' : ''}">▶</span>`
  return `<div class="${cls}" data-i="${i}" style="top:${i * ROW_H}px;--d:${r.depth};--c:${color(n)}">
    <span class="main-cell">${tw || '<span class="tw"></span>'}<span class="ico">${icon(n)}</span><span class="lbl${n.sub ? '' : ' wide'}">${esc(n.label)}</span>${n.sub ? `<span class="sub">${esc(n.sub)}</span>` : ''}${via}</span>
    <span class="chips">${chips(n)}</span>
    ${bar(n)}
  </div>`
}

function draw() {
  const tree = $('#tree')
  const rows = state.visible
  $('#spacer').style.height = `${rows.length * ROW_H + 40}px`
  const top = tree.scrollTop
  const h = tree.clientHeight
  const from = Math.max(0, Math.floor(top / ROW_H) - 20)
  const to = Math.min(rows.length, Math.ceil((top + h) / ROW_H) + 20)
  let html = ''
  for (let i = from; i < to; i++) html += rowHtml(rows[i], i)
  $('#rows').innerHTML = html
  $('#empty').hidden = !!state.model
}

function refresh() {
  state.visible = computeVisible()
  if (state.view === 'gantt') drawGantt()
  else if (state.view === 'diagram') drawDiagram()
  else draw()
}

// Inspector

const kv = pairs => `<dl class="kv">${pairs.filter(p => p[1] != null && p[1] !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`
const sec = (title, body, extra = '') => `<div class="sec"><h3><span>${esc(title)}</span>${extra}</h3>${body}</div>`
const pre = (s, tall) => `<pre class="code${tall ? ' tall' : ''}">${esc(s)}</pre>`
const cutNote = (len, shown) => (len && len > (shown?.length ?? 0) ? `<div class="dim">Cut at ${fmtNum(shown.length)} of ${fmtNum(len)} characters (maxTextChars).</div>` : '')
const jump = n => `<a class="jump" data-jump="${esc(n.id)}">${esc(n.label)}</a>`

function usageKv(u) {
  if (!u) return ''
  return kv([
    ['Input', fmtNum(u.input_tokens ?? 0)],
    ['Output', fmtNum(u.output_tokens ?? 0)],
    ['Cache read', fmtNum(u.cache_read_input_tokens ?? 0)],
    ['Cache write', fmtNum(u.cache_creation_input_tokens ?? 0)],
    ['Model', u.model ? esc(u.model) : null],
  ])
}

function inspect(n) {
  const el = $('#inspector')
  if (!n) {
    el.innerHTML = '<div class="insp-empty">Select a row to see everything about it.</div>'
    return
  }
  const path = []
  for (let p = n.parent; p && p.kind !== 'session'; p = p.parent) path.unshift(p)
  const end = n.t1 ?? (n.status === 'running' ? state.model.S.last : null)
  const badges = [
    n.status !== 'ok' ? `<span class="badge ${n.status === 'running' ? 'ok' : 'err'}">${esc(n.status)}</span>` : '',
    n.t0 ? `<span class="badge">${fmtClock(n.t0)}</span>` : '',
    n.t0 && end ? `<span class="badge">${fmtMs(end - n.t0)}</span>` : '',
    n.agent ? `<span class="badge">agent ${esc(String(n.agent).slice(0, 8))}</span>` : '<span class="badge">main</span>',
  ].join('')
  let html = `<div class="insp-head">
    <div class="crumbs">${path.map(p => `<a data-jump="${esc(p.id)}">${esc(oneLine(p.label, 40))}</a>`).join('<span>›</span>')}</div>
    <div class="insp-title k-${n.kind}" style="--c:${color(n)}"><span class="ico">${icon(n)}</span><div><div class="kindtag">${esc(n.kind === 'tool' ? 'tool call' : n.kind)}</div><h2>${esc(n.label)}</h2></div></div>
    <div class="badges">${badges}</div>
  </div>`
  const d = n.data
  switch (n.kind) {
    case 'turn': {
      if (d.prompt?.text) html += sec(d.isTask ? 'Notification' : 'Prompt', `<div class="prose">${esc(d.prompt.text)}</div>`)
      html += sec('Totals', kv([
        ['Duration', fmtMs((n.t1 ?? n.tEnd) - n.t0)],
        ['Subagents', n.tot.agents],
        ['Tool calls', n.tot.tools],
        ['Hooks', n.tot.hooks],
        ['Errors', n.tot.errors],
        ['Tokens out', fmtNum(n.tot.out)],
        ['Origin', d.prompt?.origin ? esc(d.prompt.origin) : null],
      ]))
      if (d.end?.usage) html += sec('Usage (main loop)', usageKv(d.end.usage))
      if (d.end?.answer) html += sec('Answer', `<div class="prose">${esc(d.end.answer)}</div>${cutNote(d.end.answerLen, d.end.answer)}`)
      break
    }
    case 'agent': {
      const sp = d.spawn ?? {}
      html += sec('Agent', kv([
        ['Type', esc(sp.type)],
        ['Model', esc(sp.model)],
        ['Requested model', sp.requestedModel ? esc(sp.requestedModel) : null],
        ['Mode', sp.background ? 'background' : 'foreground'],
        ['Fork', sp.fork ? 'yes' : null],
        ['Name', sp.name ? esc(sp.name) : null],
        ['Permission mode', sp.permissionMode ? esc(sp.permissionMode) : null],
        ['Agent id', `<code>${esc(n.agent)}</code>`],
        ['Launched in', n.parent && n.parent.kind !== 'session' ? jump(n.parent) : null],
      ]))
      html += sec('Totals', kv([['Tool calls', n.tot.tools], ['Subagents', n.tot.agents], ['Errors', n.tot.errors], ['Tokens out', fmtNum(n.tot.out)]]))
      if (sp.prompt) html += sec('Prompt it was given', `<div class="prose">${esc(sp.prompt)}</div>${cutNote(sp.promptLen, sp.prompt)}`)
      for (const run of d.runs ?? []) {
        html += sec(`Run · ${run.reason ?? ''} · ${fmtMs(run.durationMs)}`, `${usageKv(run.usage)}${run.answer ? `<div style="margin-top:8px" class="prose">${esc(run.answer)}</div>` : ''}`)
      }
      if (d.call) html += `<div class="sec divider"><h3><span>The Agent call that launched it</span></h3></div>` + callDetail(d.call, n.children.filter(c => c.kind === 'hook'))
      break
    }
    case 'step': {
      const s = d.start ?? {}
      const e = d.end ?? {}
      html += sec('Model request', kv([
        ['Model', esc(s.model)],
        ['Effort', s.effort ? esc(s.effort) : null],
        ['Messages sent', s.messageCount],
        ['Stop reason', e.stopReason ? esc(e.stopReason) : null],
        ['Tool calls asked', e.toolCount],
      ]))
      if (e.usage) html += sec('Usage', usageKv(e.usage))
      if (e.serverTools?.length) html += sec('Server tools', `<div class="mini-list">${e.serverTools.map(t => `<div><span>${esc(t.name)}</span><span>${fmtMs((t.endedAt ?? t.startedAt) - t.startedAt)}</span></div>`).join('')}</div>`)
      break
    }
    case 'tool':
      html += callDetail(n, n.children.filter(c => c.kind === 'hook'))
      break
    case 'group':
      html += sec('Calls', `<div class="mini-list">${n.children.map(c => `<div><a class="jump" data-jump="${esc(c.id)}">${esc(oneLine(c.sub || c.label, 70))}</a><span>${fmtMs((c.t1 ?? c.t0) - c.t0)}</span></div>`).join('')}</div>`)
      break
    case 'text':
    case 'thinking':
      if (d.empty) {
        html += sec('Thinking', '<div class="dim">The model thought here, but this build of Claude Code hands plugins the block without its text.</div>')
        break
      }
      html += sec(n.kind === 'text' ? 'Text' : 'Thinking', `<div class="prose">${esc(d.text)}</div>${cutNote(d.len, d.text)}`, `<button class="ghost" data-copy="text">Copy</button>`)
      break
    case 'hook':
      html += sec('Hook', hookCard(n))
      if (!d.detail && d.row) html += sec('Note', '<div class="dim">This build of Claude Code reports that a hook ran and for which event, but not its command, output or duration.</div>')
      break
    case 'skill':
      html += sec('Skill', kv(Object.entries(d.skill ?? {}).filter(([k]) => !['v', 'seq', 'sid', 'kind'].includes(k)).map(([k, v]) => [k, esc(k === 'ts' ? fmtClock(v) : v)])))
      break
    case 'context':
    case 'ctxgroup':
      if (n.kind === 'ctxgroup') html += sec('Blocks', `<div class="mini-list">${n.children.map(c => `<div><a class="jump" data-jump="${esc(c.id)}">${esc(c.label)}</a><span>${fmtNum(c.data.text?.length ?? 0)} chars</span></div>`).join('')}</div>`)
      else html += sec(d.row?.name ?? 'Context', d.text ? pre(d.text, true) : '<div class="dim">No text.</div>')
      break
  }
  el.innerHTML = html
  el.scrollTop = 0
}

// What a tool call carries: input, permission, hooks, result, output.
function callDetail(t, hooks) {
  const d = t.data
  const i = d.input ?? {}
  const name = d.toolName
  let html = ''
  if (name === 'Bash' && i.command) {
    html += sec('Command', pre(i.command))
    if (i.description) html += sec('Description', `<div class="prose">${esc(i.description)}</div>`)
  }
  html += sec(d.toolName === 'Agent' ? 'Agent call input' : 'Input', pre(JSON.stringify(i, null, 2)))
  if (d.permission) {
    const p = d.permission
    html += sec('Permission', kv([['Decision', esc(p.decision)], ['Rule', p.rule ? `<code>${esc(p.rule)}</code>` : null], ['Reason', p.reason ? esc(p.reason) : null], ['Decided by hook', p.hook ? esc(p.hook) : null]]))
  }
  if (d.skill) html += sec('Skill', kv([['Skill', esc(d.skill.skill)], ['Args', d.skill.args ? esc(d.skill.args) : null], ['Status', d.skill.status ? esc(d.skill.status) : null]]))
  if (d.end?.stats) html += sec('Result', kv(Object.entries(d.end.stats).map(([k, v]) => [k, esc(typeof v === 'number' && /Ms$/.test(k) ? fmtMs(v) : v)])))
  if (hooks.length) html += sec(`Hooks (${hooks.length})`, hooks.map(hookCard).join(''))
  if (d.end?.denied) html += sec('Denied', `<div class="prose">${esc(d.end.denied)}</div>`)
  if (d.end?.text != null) html += sec(d.end.isError ? 'Error' : name === 'Agent' ? 'Call result' : 'Output', `${pre(d.end.text)}${cutNote(d.end.textLen, d.end.text)}`, `<button class="ghost" data-copy="out">Copy</button>`)
  return html
}

function hookCard(n) {
  const det = n.data.detail
  const ev = n.data.event
  if (!det && !ev) {
    const d = n.data
    const list = [...(d.cands ?? []), ...(d.pick?.host ? [d.pick] : [])].map(h => `<div class="hookcand${h === d.pick ? ' pick' : ''}"><code>${esc(h.command)}</code><span class="dim">${esc(h.source)}${h.matcher ? ` · matcher ${esc(h.matcher)}` : ''}</span></div>`).join('')
    return `<div class="hookcard"><b>${esc(d.hookEvent ?? n.label)}</b> <span class="dim">${esc(d.row?.name ?? '')}</span>
      <div style="margin-top:6px">${d.pick?.host ? 'Not in any settings file: hooks the host app registers as callbacks (Claude Desktop runs some on every tool, and on Stop). It does not say which.' : d.pick ? 'Most likely this hook (matched by event and matcher; the engine does not say which command ran):' : d.cands?.length ? 'One of these configured hooks (the engine does not say which):' : 'No configured hook matches; it may come from a built-in or a --plugin-dir plugin.'}</div>
      ${list}</div>`
  }
  if (ev) return `<div class="hookcard"><b>${esc(ev.event)}</b>${kv([['Duration', fmtMs(ev.durationMs)], ['Outcome', ev.outcome ? `<code>${esc(JSON.stringify(ev.outcome))}</code>` : 'none']])}</div>`
  return `<div class="hookcard"><b>${esc(det.hookName ?? det.hookEvent)}</b>${kv([
    ['Command', det.command ? `<code>${esc(det.command)}</code>` : null],
    ['Duration', det.durationMs != null ? fmtMs(det.durationMs) : null],
    ['Exit code', det.exitCode],
    ['Kind', esc(det.type)],
  ])}${det.stdout ? `<div style="margin-top:6px">${pre(det.stdout)}</div>` : ''}${det.stderr ? `<div style="margin-top:6px">${pre(det.stderr)}</div>` : ''}${det.content ? `<div style="margin-top:6px">${pre(det.content)}</div>` : ''}</div>`
}

// Health: signs that the collector no longer sees what it used to, usually
// after a Claude Code update changed an event (docs/development.md).

const KNOWN_KINDS = new Set(['session.start', 'session.info', 'session.end', 'offer.skills', 'offer.agent', 'collector.stats', 'prompt', 'turn.start', 'turn.end', 'step.start', 'step.end', 'row', 'tool.start', 'tool.end', 'permission', 'agent.spawn', 'skill.load', 'skill.expand', 'hook'])

function health(m) {
  const k = m.S.kinds
  const out = []
  const uses = m.S.toolUses
  const warn = (title, detail) => out.push({ level: 'warn', title, detail })
  const info = (title, detail) => out.push({ level: 'info', title, detail })
  if (uses.length && !k['tool.start']) warn('No tool calls recorded', `The model asked for ${uses.length} tool calls, but no tool.start records exist: the tool.call event may have changed.`)
  else if (uses.length > (k['tool.start'] ?? 0) * 1.5 + 2) warn('Fewer tool calls than asked', `${uses.length} tool_use blocks, ${k['tool.start'] ?? 0} tool.start records.`)
  const agentCalls = uses.filter(n => n === 'Agent' || n === 'Task').length
  if (agentCalls && !k['agent.spawn']) warn('Subagents not linked', `${agentCalls} Agent calls but no agent.spawn records: the agent tree cannot be built.`)
  if (k['step.start'] && !k['step.end']) warn('Model requests never end', 'step.start without step.end: the turn.step stream may have changed.')
  const steps = [...m.nodes.values()].filter(n => n.kind === 'step')
  if (steps.length > 2 && steps.every(n => !n.data.end?.usage)) warn('No token usage', 'No step.end carries usage.')
  if (k.prompt && !k['turn.start']) warn('No turns', 'Prompts were recorded but no turn.start.')
  if (!k['session.info']) info('Transcript not found', 'Hook detail and the host-app check need the transcript path.')
  const unknown = Object.keys(k).filter(x => !KNOWN_KINDS.has(x))
  if (unknown.length) info('Unknown record kinds', `${unknown.join(', ')}: written by a newer collector than this viewer.`)
  const other = [...new Set([...m.nodes.values()].filter(n => n.kind === 'tool' && n.family === 'tool').map(n => n.data.toolName))]
  if (other.length) info('Tools without a family', `${other.join(', ')}: shown as Other (add them to FAMILIES in app.js).`)
  if (m.S.collector.errors.length) warn('Collector errors', [...new Set(m.S.collector.errors)].slice(0, 5).join(' · '))
  return out
}

function drawHealth() {
  const h = health(state.model)
  const warns = h.filter(x => x.level === 'warn').length
  const btn = $('#health')
  btn.hidden = false
  btn.className = `health ${warns ? 'bad' : h.length ? 'meh' : 'ok'}`
  btn.textContent = warns ? `⚠ ${warns} check${warns > 1 ? 's' : ''}` : h.length ? `ⓘ ${h.length} note${h.length > 1 ? 's' : ''}` : '✓ healthy'
  btn.title = 'Does the log look complete? Click for details'
  state.health = h
}

function inspectHealth() {
  const h = state.health ?? []
  $('#inspector').innerHTML = `<div class="insp-head"><div class="insp-title" style="--c:var(${h.some(x => x.level === 'warn') ? '--c-error' : '--c-ok'})"><span class="ico"><svg viewBox="0 0 24 24"><path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"/></svg></span><div><div class="kindtag">health</div><h2>Is this log complete?</h2></div></div></div>
    ${sec('Checks', h.length ? h.map(x => `<div class="hookcard" style="border-left-color:var(${x.level === 'warn' ? '--c-error' : '--c-web'})"><b style="color:var(${x.level === 'warn' ? '--c-error' : '--c-web'})">${esc(x.title)}</b><div class="dim">${esc(x.detail)}</div></div>`).join('') : '<div class="dim">Everything the collector should record is there.</div>')}
    ${sec('Record kinds', kv(Object.entries(state.model.S.kinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, String(v)])))}
    ${sec('After a Claude Code update', '<div class="dim">Run <code>python3 tools/selfcheck.py</code> in the plugin folder: it runs a scripted session and checks the log. See docs/development.md.</div>')}`
}

function sessionStats() {
  const m = state.model
  const el = $('#stats')
  if (!m) {
    el.innerHTML = ''
    return
  }
  const r = m.root
  const turns = r.children.filter(c => c.kind === 'turn')
  const dur = (m.S.info.end?.ts ?? m.S.last) - m.S.first
  const stat = (v, l, c) => `<div class="stat" style="--accent:var(${c})"><b>${v}</b><span>${l}</span></div>`
  el.innerHTML = [
    stat(fmtMs(dur), 'span', '--c-turn'),
    stat(turns.length, 'turns', '--c-turn'),
    stat(r.tot.agents, 'subagents', '--c-agent'),
    stat(r.tot.tools, 'tool calls', '--c-bash'),
    stat(r.tot.hooks, 'hook runs', '--c-hook'),
    stat(r.tot.errors, 'errors', r.tot.errors ? '--c-error' : '--c-ok'),
    stat(fmtNum(r.tot.out), 'tokens out', '--c-thinking'),
    `<div class="stat" style="--accent:var(--c-skill)" title="Time in the collector's own code. Each observed event also costs a round trip to the plugin's process (about 0.5–2 ms), not counted here: see docs/limitations.md."><b>${m.S.collector.ms.toFixed(1)} ms</b><span>collector code ⓘ</span></div>`,
  ].join('')
}

// Sessions

async function loadSessions() {
  try {
    state.sessions = await (await fetch('api/sessions')).json()
  } catch {
    return
  }
  drawSessions()
}

function drawSessions() {
  const q = $('#session-search').value.toLowerCase()
  const list = state.sessions.filter(s => !q || `${s.title} ${s.cwd} ${s.sid}`.toLowerCase().includes(q))
  $('#sessions').innerHTML = list
    .map(s => `<div class="sess${s.sid === state.sid ? ' active' : ''}" data-sid="${esc(s.sid)}">
      ${s.live && !s.ended ? '<span class="dot"></span>' : ''}
      <div class="t">${esc(s.title || '(no prompt yet)')}</div>
      <div class="m"><span>${esc(fmtAgo(s.endedAt))}</span><span class="cwd">${esc(base(s.cwd))}</span><span>${fmtNum(s.size)}B</span></div>
    </div>`)
    .join('')
  $('#side-count').textContent = `${list.length} sessions`
}

async function openSession(sid, nodeId) {
  if (!sid) return
  setMode('sessions')
  state.sid = sid
  state.records = []
  state.offset = 0
  state.hooks = {}
  state.hookConf = []
  state.hooksAt = 0
  state.open = new Map()
  state.selected = null
  location.hash = sid
  drawSessions()
  inspect(null)
  $('#tree').scrollTop = 0
  await poll(true)
  if (nodeId && state.model?.nodes.has(nodeId)) select(nodeId, true)
}

async function poll(first = false) {
  const sid = state.sid
  if (!sid) return
  let res
  try {
    res = await (await fetch(`api/session/${sid}/records?offset=${state.offset}`)).json()
  } catch {
    return
  }
  if (sid !== state.sid || !res.records) return
  const meta = state.sessions.find(s => s.sid === sid)
  state.live = !!(meta?.live && !meta?.ended) && !res.records.some(r => r.kind === 'session.end')
  const grew = res.records.length > 0
  state.records.push(...res.records)
  state.offset = res.offset
  const now = Date.now()
  if (first || (state.live && now - state.hooksAt > 8000)) {
    state.hooksAt = now
    try {
      const [h, c] = await Promise.all([fetch(`api/session/${sid}/hooks`), first ? fetch(`api/session/${sid}/hookconfig`) : null])
      state.hooks = await h.json()
      if (c) state.hookConf = await c.json()
    } catch {}
  }
  if (!grew && !first && !state.live) return
  rebuild()
  if (state.follow && grew) followNewest()
}

function rebuild() {
  state.model = build(state.records, state.hooks, state.hookConf)
  const m = state.model
  const start = m.S.info.start
  const first = m.root.children.find(c => c.kind === 'turn' && !c.data.isTask)
  $('#title').textContent = first?.label || 'Session'
  $('#subtitle').textContent = [start?.cwd, state.sid].filter(Boolean).join('  ·  ')
  $('#live').hidden = !state.live
  sessionStats()
  drawHealth()
  fillScope()
  if (!$('#family-pop').hidden) fillFamilies()
  refresh()
  if (state.selected) inspect(m.nodes.get(state.selected))
}

// Controls: presets, agent scope, kinds and tool families.

const PRESETS = {
  everything: { label: 'Everything', kinds: KINDS.map(k => k.key), steps: true },
  agents: { label: 'Agents only', kinds: [], steps: false },
  hooks: { label: 'Hooks only', kinds: ['hook'], steps: false },
  tools: { label: 'Tools only', kinds: ['tool'], steps: false },
  conversation: { label: 'Conversation', kinds: ['text', 'thinking'], steps: false },
  nocontext: { label: 'No context', kinds: KINDS.map(k => k.key).filter(k => k !== 'context'), steps: true },
}

function applyPreset(key) {
  const p = PRESETS[key]
  if (!p) return
  const f = state.filters
  f.kinds = new Set(p.kinds)
  f.steps = p.steps
  f.families.clear()
  f.tools.clear()
  f.scope = 'all'
  state.preset = key
  syncControls()
  refresh()
}

function changed() {
  state.preset = 'custom'
  syncControls()
  refresh()
}

function syncControls() {
  const f = state.filters
  for (const el of document.querySelectorAll('#kinds .kind')) {
    const k = el.dataset.k
    el.classList.toggle('off', !f.kinds.has(k))
    el.classList.toggle('partial', k === 'tool' && f.kinds.has(k) && (f.families.size > 0 || f.tools.size > 0))
  }
  $('#steps').checked = f.steps
  $('#errors').checked = f.errors
  $('#empty-thinking').checked = f.emptyThinking
  $('#preset').value = state.preset
  $('#scope').value = f.scope
  if (!$('#family-pop').hidden) fillFamilies()
}

function agentList() {
  const out = []
  const walk = (n, depth) => {
    for (const c of n.children) {
      if (c.kind === 'agent') {
        out.push({ n: c, depth })
        walk(c, depth + 1)
      } else walk(c, depth)
    }
  }
  if (state.model) walk(state.model.root, 0)
  return out
}

function fillScope() {
  const sel = $('#scope')
  const agents = agentList()
  if (state.filters.scope !== 'all' && state.filters.scope !== 'main' && !state.model.nodes.has(state.filters.scope)) state.filters.scope = 'all'
  sel.innerHTML = `<option value="all">All agents</option><option value="main">Main agent only</option>${
    agents.length ? `<optgroup label="One agent">${agents.map(a => `<option value="${esc(a.n.id)}">${'· '.repeat(a.depth)}${esc(oneLine(a.n.label, 50))}${a.n.data.spawn?.type ? ` (${esc(a.n.data.spawn.type)})` : ''}</option>`).join('')}</optgroup>` : ''
  }`
  sel.value = state.filters.scope
}

function fillFamilies() {
  const counts = new Map()
  for (const n of state.model?.nodes.values() ?? []) {
    if ((n.kind !== 'tool' && n.kind !== 'skill') || n.mergedInto) continue
    const fam = counts.get(n.family) ?? { n: 0, tools: new Map() }
    fam.n++
    fam.tools.set(n.data.toolName, (fam.tools.get(n.data.toolName) ?? 0) + 1)
    counts.set(n.family, fam)
  }
  const f = state.filters
  const order = Object.keys(FAMILIES).filter(k => counts.has(k))
  $('#family-pop').innerHTML = `<div class="pop-head"><b>Tool families</b><span><button class="ghost" data-fam-all="1">All</button> <button class="ghost" data-fam-all="0">None</button></span></div>${
    order.length ? order.map(k => {
      const fam = counts.get(k)
      const on = !f.families.has(k)
      const tools = [...fam.tools].sort((a, b) => b[1] - a[1])
      return `<div class="fam" style="--c:var(${FAMILIES[k].color})">
        <label><input type="checkbox" data-fam="${k}" ${on ? 'checked' : ''}><span class="ico"><svg viewBox="0 0 24 24">${ICONS[FAMILIES[k].icon]}</svg></span>${esc(FAMILIES[k].label)}<span class="cnt">${fam.n}</span></label>
        ${tools.length > 1 || tools[0][0] !== FAMILIES[k].label ? `<div class="fam-tools">${tools.map(([t, c]) => `<label><input type="checkbox" data-tool="${esc(t)}" ${on && !f.tools.has(t) ? 'checked' : ''} ${on ? '' : 'disabled'}>${esc(toolName(t))}<span class="cnt">${c}</span></label>`).join('')}</div>` : ''}
      </div>`
    }).join('') : '<div class="dim">No tool calls in this session.</div>'
  }<div class="dim pop-foot">⌥-click a kind to show only that kind.</div>`
}

function followNewest() {
  const rows = state.visible
  if (!rows.length) return
  select(rows[rows.length - 1].n.id, true)
}

// Interaction

function select(id, scroll) {
  id = state.model?.nodes.get(id)?.mergedInto?.id ?? id
  state.selected = id
  const n = state.model?.nodes.get(id)
  if (n) {
    // Open the path to it.
    for (let p = n.parent; p && p.kind !== 'session'; p = p.parent) if (!isOpen(p)) state.open.set(p.id, true)
  }
  refresh()
  inspect(n)
  if (scroll) {
    const i = state.visible.findIndex(r => r.n.id === id)
    if (i >= 0) {
      const tree = $('#tree')
      const y = i * ROW_H
      if (y < tree.scrollTop || y > tree.scrollTop + tree.clientHeight - ROW_H * 2) tree.scrollTop = y - tree.clientHeight / 3
      draw()
    }
  }
}

function toggle(n, value) {
  const open = value ?? !isVisibleOpen(n)
  state.open.set(n.id, open)
  refresh()
}
function isVisibleOpen(n) {
  return state.visible.find(r => r.n === n)?.open ?? isOpen(n)
}

function moveSel(delta) {
  const rows = state.visible
  if (!rows.length) return
  let i = rows.findIndex(r => r.n.id === state.selected)
  i = i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + delta))
  select(rows[i].n.id, true)
}

function nextError() {
  const rows = state.visible
  const all = []
  const walk = n => {
    for (const c of n.children) {
      if (c.status === 'error' || c.status === 'denied') all.push(c)
      walk(c)
    }
  }
  walk(state.model.root)
  if (!all.length) return
  const cur = all.findIndex(n => n.id === state.selected)
  select(all[(cur + 1) % all.length].id, true)
  void rows
}

function setAll(open) {
  const walk = n => {
    for (const c of n.children) {
      if (c.children.length) state.open.set(c.id, open)
      walk(c)
    }
  }
  walk(state.model.root)
  for (const [id, g] of state.model.nodes) if (g.kind === 'group') state.open.set(id, open)
  refresh()
}

function wire() {
  const tree = $('#tree')
  tree.addEventListener('scroll', () => requestAnimationFrame(draw))
  window.addEventListener('resize', () => requestAnimationFrame(draw))
  $('#rows').addEventListener('click', e => {
    const row = e.target.closest('.row')
    if (!row) return
    const r = state.visible[+row.dataset.i]
    if (!r) return
    if (e.target.closest('.tw') && r.open != null) {
      toggle(r.n, !r.open)
      return
    }
    if (state.selected === r.n.id && r.open != null) toggle(r.n, !r.open)
    select(r.n.id)
    tree.focus()
  })
  $('#rows').addEventListener('dblclick', e => {
    const row = e.target.closest('.row')
    const r = row && state.visible[+row.dataset.i]
    if (r?.open != null) toggle(r.n, !r.open)
  })
  $('#inspector').addEventListener('click', e => {
    const j = e.target.closest('[data-jump]')
    if (j) select(j.dataset.jump, true)
    const c = e.target.closest('[data-copy]')
    if (c) {
      const pre = c.closest('.sec').querySelector('pre, .prose')
      navigator.clipboard?.writeText(pre?.textContent ?? '')
      c.textContent = 'Copied'
      setTimeout(() => (c.textContent = 'Copy'), 1200)
    }
  })
  $('#sessions').addEventListener('click', e => {
    const s = e.target.closest('.sess')
    if (s) openSession(s.dataset.sid)
  })
  $('#session-search').addEventListener('input', drawSessions)
  for (const b of document.querySelectorAll('.mode')) b.addEventListener('click', () => setMode(b.dataset.mode))
  for (const b of document.querySelectorAll('.view')) b.addEventListener('click', () => setView(b.dataset.view))
  $('#diagram').addEventListener('click', e => {
    const g = e.target.closest('[data-gid]')
    if (!g) return
    select(g.dataset.gid)
    drawDiagram()
  })
  const gantt = $('#gantt')
  gantt.addEventListener('click', e => {
    const g = e.target.closest('[data-gid]')
    if (!g) return
    select(g.dataset.gid)
    drawGantt()
  })
  gantt.addEventListener('wheel', e => {
    if (!(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    const rect = gantt.getBoundingClientRect()
    const mx = e.clientX - rect.left + gantt.scrollLeft - GANTT.LABEL_W
    const old = GANTT.zoom
    GANTT.zoom = Math.max(1, Math.min(200, GANTT.zoom * (e.deltaY < 0 ? 1.25 : 0.8)))
    drawGantt()
    gantt.scrollLeft = Math.max(0, mx * (GANTT.zoom / old) - (e.clientX - rect.left - GANTT.LABEL_W))
  }, { passive: false })
  let drag = null
  gantt.addEventListener('mousedown', e => {
    if (e.target.closest('[data-gid]')) return
    drag = { x: e.clientX, y: e.clientY, l: gantt.scrollLeft, t: gantt.scrollTop }
    gantt.classList.add('dragging')
  })
  window.addEventListener('mousemove', e => {
    const tip = $('#gtip')
    if (drag) {
      gantt.scrollLeft = drag.l - (e.clientX - drag.x)
      gantt.scrollTop = drag.t - (e.clientY - drag.y)
      return
    }
    const g = e.target.closest?.('#gantt .gbar, #gantt .gmark')
    if (!g) {
      tip.hidden = true
      return
    }
    const n = state.model?.nodes.get(g.dataset.gid)
    if (!n) return
    const end = n.t1 ?? (n.status === 'running' ? state.model.S.last : n.t0)
    tip.innerHTML = `<b>${esc(n.label)}</b>${n.sub ? `<span>${esc(oneLine(n.sub, 90))}</span>` : ''}<em>${esc(fmtMs(end - n.t0))} · ${esc(fmtClock(n.t0))}${n.status !== 'ok' ? ` · ${esc(n.status)}` : ''}</em>`
    tip.hidden = false
    const r = gantt.getBoundingClientRect()
    tip.style.left = `${gantt.scrollLeft + Math.min(e.clientX - r.left + 14, r.width - 290)}px`
    tip.style.top = `${gantt.scrollTop + Math.min(e.clientY - r.top + 14, r.height - 90)}px`
  })
  window.addEventListener('mouseup', () => {
    drag = null
    gantt.classList.remove('dragging')
  })
  $('#comp-q').addEventListener('input', drawComponents)
  $('#comp-days').addEventListener('change', e => {
    comp.days = +e.target.value
    loadComponents()
  })
  $('#comp-reload').addEventListener('click', loadComponents)
  $('#health').addEventListener('click', inspectHealth)
  $('#help-btn').addEventListener('click', () => toggleHelp())
  $('#help').addEventListener('click', e => {
    if (e.target.id === 'help' || e.target.closest('[data-close]')) toggleHelp(false)
  })
  $('#comp-body').addEventListener('click', e => {
    const c = e.target.closest('[data-comp]')
    if (c) inspectComponent(c.dataset.comp)
  })

  $('#kinds').innerHTML = KINDS.map(k => `<span class="kind" data-k="${k.key}" style="--k:var(${k.color})" title="Click to show or hide · ⌥-click to show only this"><i></i>${k.label}${k.key === 'tool' ? '<b class="caret" title="Tool families">▾</b>' : ''}</span>`).join('')
  $('#kinds').addEventListener('click', e => {
    const k = e.target.closest('.kind')
    if (!k) return
    if (e.target.closest('.caret')) {
      const pop = $('#family-pop')
      pop.hidden = !pop.hidden
      if (!pop.hidden) {
        const r = k.getBoundingClientRect()
        pop.style.left = `${r.left}px`
        pop.style.top = `${r.bottom + 6}px`
        fillFamilies()
      }
      return
    }
    const f = state.filters.kinds
    const key = k.dataset.k
    if (e.altKey) {
      const only = f.size === 1 && f.has(key)
      state.filters.kinds = new Set(only ? KINDS.map(x => x.key) : [key])
    } else f.has(key) ? f.delete(key) : f.add(key)
    changed()
  })
  $('#family-pop').addEventListener('change', e => {
    const f = state.filters
    const fam = e.target.dataset.fam
    const tool = e.target.dataset.tool
    if (fam) e.target.checked ? f.families.delete(fam) : f.families.add(fam)
    if (tool) e.target.checked ? f.tools.delete(tool) : f.tools.add(tool)
    if (fam || tool) {
      if (f.families.size + f.tools.size > 0) f.kinds.add('tool')
      changed()
    }
  })
  $('#family-pop').addEventListener('click', e => {
    const all = e.target.closest('[data-fam-all]')
    if (!all) return
    const f = state.filters
    f.tools.clear()
    if (all.dataset.famAll === '1') f.families.clear()
    else for (const k of Object.keys(FAMILIES)) f.families.add(k)
    changed()
  })
  document.addEventListener('click', e => {
    const pop = $('#family-pop')
    if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('.caret')) pop.hidden = true
  })
  $('#preset').innerHTML = Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('') + '<option value="custom" disabled>Custom</option>'
  $('#preset').addEventListener('change', e => applyPreset(e.target.value))
  $('#scope').addEventListener('change', e => {
    state.filters.scope = e.target.value
    changed()
  })
  let qt
  $('#q').addEventListener('input', e => {
    clearTimeout(qt)
    qt = setTimeout(() => {
      state.filters.q = e.target.value.trim().toLowerCase()
      refresh()
    }, 120)
  })
  $('#errors').addEventListener('change', e => {
    state.filters.errors = e.target.checked
    changed()
  })
  $('#empty-thinking').addEventListener('change', e => {
    state.filters.emptyThinking = e.target.checked
    changed()
  })
  $('#steps').addEventListener('change', e => {
    state.filters.steps = e.target.checked
    changed()
  })
  $('#mindur').addEventListener('change', e => {
    state.filters.minMs = +e.target.value
    refresh()
  })
  $('#expand-all').addEventListener('click', () => state.model && setAll(true))
  $('#collapse-all').addEventListener('click', () => state.model && setAll(false))
  $('#follow').addEventListener('click', () => setFollow(!state.follow))
  $('#theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'
    document.documentElement.dataset.theme = next
    try {
      localStorage.setItem('session-flow-theme', next)
    } catch {}
  })

  document.addEventListener('keydown', e => {
    if (e.target.matches('input, select, textarea')) {
      if (e.key === 'Escape') e.target.blur()
      return
    }
    const n = state.model?.nodes.get(state.selected)
    const r = state.visible.find(x => x.n.id === state.selected)
    switch (e.key) {
      case 'ArrowDown': case 'j': moveSel(1); break
      case 'ArrowUp': case 'k': moveSel(-1); break
      case 'PageDown': moveSel(15); break
      case 'PageUp': moveSel(-15); break
      case 'ArrowRight': case 'l': if (r?.open === false) toggle(r.n, true); else moveSel(1); break
      case 'ArrowLeft': case 'h':
        if (r?.open) toggle(r.n, false)
        else if (n?.parent && n.parent.kind !== 'session') select(n.parent.id, true)
        break
      case 'Enter': case ' ': if (r?.open != null) toggle(r.n, !r.open); break
      case '/': $('#q').focus(); break
      case '?': toggleHelp(); break
      case 'Escape': toggleHelp(false); break
      case 't': setView({ tree: 'gantt', gantt: 'diagram', diagram: 'tree' }[state.view]); break
      case 'e': state.model && nextError(); break
      case 'f': setFollow(!state.follow); break
      default: return
    }
    e.preventDefault()
  })
}

// Timeline: one lane per agent (nested by who launched whom), model requests
// on a thin top track and tool calls below, stacked when they overlap. Idle
// gaps longer than GAP_MS are folded into a narrow break so long sessions fit.

const GANTT = { zoom: 1, GAP_MS: 20000, BREAK_PX: 34, LABEL_W: 240, MODEL_H: 8, TOOL_H: 14 }

function setView(view) {
  state.view = view
  for (const b of document.querySelectorAll('.view')) b.classList.toggle('on', b.dataset.view === view)
  $('#tree').hidden = view !== 'tree'
  $('#gantt').hidden = view !== 'gantt'
  $('#diagram').hidden = view !== 'diagram'
  refresh()
}

// Lanes the scope allows: all agents, the main one, or one agent and those it launched.
function laneList(m) {
  const scope = state.filters.scope
  const lanes = [{ agent: null, label: 'Main agent', sub: m.root.children.find(t => t.kind === 'turn')?.children.find(c => c.kind === 'step')?.data.start?.model ?? '', depth: 0 }]
  for (const a of agentList()) lanes.push({ agent: a.n.agent, label: a.n.label, sub: [a.n.data.spawn?.type, a.n.data.spawn?.model].filter(Boolean).join(' · '), depth: a.depth + 1, node: a.n })
  if (scope === 'main') return lanes.slice(0, 1)
  if (scope === 'all') return lanes
  const target = m.nodes.get(scope)
  const inside = l => {
    for (let p = l.node; p; p = p.parent) if (p === target) return true
    return false
  }
  return lanes.filter(inside)
}

function laneOf(n) {
  for (let p = n.parent; p; p = p.parent) if (p.kind === 'agent') return p.agent
  return null
}

function drawGantt() {
  const m = state.model
  const inner = $('#gantt-inner')
  if (!m) {
    inner.innerHTML = ''
    return
  }
  const lanes = laneList(m)
  const laneIdx = new Map(lanes.map((l, i) => [l.agent, i]))
  const f = state.filters
  const bars = []
  const marks = []
  for (const n of m.nodes.values()) {
    if (n.mergedInto || n.t0 == null || n.kind === 'group') continue
    const lane = laneIdx.get(n.kind === 'agent' ? laneOf(n) : n.agent ?? null)
    if (lane == null) continue
    const end = n.kind === 'agent' ? n.t1 ?? n.tEnd ?? n.t0 : n.t1 ?? (n.status === 'running' ? m.S.last : n.t0)
    const short = f.minMs && end - n.t0 < f.minMs
    if (n.kind === 'step') {
      if (f.steps && !short) bars.push({ n, lane, track: 'model', t0: n.t0, t1: end })
    } else if (n.kind === 'tool' || n.kind === 'agent') {
      if ((n.kind === 'agent' || kindShown(n)) && !short) bars.push({ n, lane, track: 'tool', t0: n.t0, t1: end })
    } else if (['text', 'thinking', 'hook', 'skill'].includes(n.kind) && kindShown(n) && !f.minMs) marks.push({ n, lane, t: n.t0 })
  }
  const dim = n => (f.q && !searchText(n).includes(f.q)) || (f.errors && n.status !== 'error' && n.status !== 'denied')
  if (!bars.length) {
    inner.innerHTML = '<div class="dim" style="padding:30px">Nothing timed in this session yet.</div>'
    return
  }
  // Fold idle gaps.
  const spans = [...bars.map(b => [b.t0, Math.max(b.t1, b.t0 + 1)]), ...marks.map(k => [k.t, k.t + 1])].sort((a, b) => a[0] - b[0])
  const segs = []
  for (const [a, b] of spans) {
    const last = segs.at(-1)
    if (last && a - last.b <= GANTT.GAP_MS) last.b = Math.max(last.b, b)
    else segs.push({ a, b })
  }
  const active = segs.reduce((t, s) => t + (s.b - s.a), 0)
  const width = Math.max(400, ($('#gantt').clientWidth - GANTT.LABEL_W - 30) * GANTT.zoom)
  const pxPerMs = Math.max(1e-6, (width - GANTT.BREAK_PX * (segs.length - 1)) / Math.max(active, 1))
  let x = 0
  for (const s of segs) {
    s.x0 = x
    x += (s.b - s.a) * pxPerMs + GANTT.BREAK_PX
  }
  const total = x - GANTT.BREAK_PX
  const X = t => {
    let s = segs[0]
    for (const g of segs) if (g.a <= t) s = g
    return s.x0 + Math.max(0, Math.min(t, s.b) - s.a) * pxPerMs
  }
  // Stack overlapping tool bars inside each lane.
  const rowsOf = lanes.map(() => [])
  for (const b of bars.filter(b => b.track === 'tool').sort((p, q) => p.t0 - q.t0)) {
    const rows = rowsOf[b.lane]
    let r = rows.findIndex(end => end <= b.t0)
    if (r < 0) r = rows.push(0) - 1
    rows[r] = b.t1
    b.row = r
  }
  let y = 30
  for (const [i, l] of lanes.entries()) {
    l.y = y
    l.h = 10 + GANTT.MODEL_H + 6 + Math.max(1, rowsOf[i].length) * (GANTT.TOOL_H + 3) + 8 + 8
    y += l.h
  }
  // Axis ticks inside each active segment, relative to the session's first activity.
  const t0 = segs[0].a
  const step = [1e3, 2e3, 5e3, 1e4, 3e4, 6e4, 12e4, 3e5, 6e5, 18e5, 36e5].find(s => s * pxPerMs >= 70) ?? 36e5
  const clock = ms => {
    const t = Math.round(ms / 1000)
    const hh = Math.floor(t / 3600)
    const mm = String(Math.floor((t % 3600) / 60)).padStart(hh ? 2 : 1, '0')
    const ss = String(t % 60).padStart(2, '0')
    return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`
  }
  let axis = ''
  for (const s of segs) {
    for (let t = Math.ceil((s.a - t0) / step) * step + t0; t <= s.b; t += step) axis += `<span class="tick" style="left:${X(t)}px">${clock(t - t0)}</span>`
  }
  const breaks = segs.slice(1).map((s, i) => `<span class="gbreak" style="left:${s.x0 - GANTT.BREAK_PX}px;width:${GANTT.BREAK_PX}px;height:${y}px" title="${esc(fmtMs(s.a - segs[i].b))} idle"><b>${esc(fmtMs(s.a - segs[i].b))}</b></span>`).join('')
  const turnNodes = m.root.children.filter(t => t.kind === 'turn' && t.t0 != null)
  const turns = turnNodes.map((t, i) => {
    const room = (i + 1 < turnNodes.length ? X(turnNodes[i + 1].t0) : total) - X(t.t0) - 8
    return `<span class="gturn" style="left:${X(t.t0)}px;height:${y}px" data-gid="${esc(t.id)}" title="${esc(t.label)}">${room > 30 ? `<b style="max-width:${Math.min(room, 260)}px">${esc(oneLine(t.label, 60))}</b>` : ''}</span>`
  }).join('')
  const barHtml = bars.map(b => {
    const l = lanes[b.lane]
    const left = X(b.t0)
    const w = Math.max(2, X(b.t1) - left)
    const top = b.track === 'model' ? l.y + 10 : l.y + 10 + GANTT.MODEL_H + 6 + 8 + b.row * (GANTT.TOOL_H + 3)
    const h = b.track === 'model' ? GANTT.MODEL_H : GANTT.TOOL_H
    const cls = ['gbar', `g-${b.n.kind}`, `st-${b.n.status}`, b.n.id === state.selected ? 'sel' : '', dim(b.n) ? 'dim' : ''].join(' ')
    const label = w > 60 && b.track === 'tool' ? `<span>${esc(oneLine(b.n.label + (b.n.sub ? ` · ${b.n.sub}` : ''), Math.floor(w / 6.5)))}</span>` : ''
    return `<i class="${cls}" data-gid="${esc(b.n.id)}" style="left:${left}px;top:${top}px;width:${w}px;height:${h}px;--c:${color(b.n)}">${label}</i>`
  }).join('') + marks.map(k => {
    const l = lanes[k.lane]
    return `<i class="gmark g-${k.n.kind}${dim(k.n) ? ' dim' : ''}${k.n.id === state.selected ? ' sel' : ''}" data-gid="${esc(k.n.id)}" style="left:${X(k.t)}px;top:${l.y + 10 + GANTT.MODEL_H + 4}px;--c:${color(k.n)}"></i>`
  }).join('')
  const laneHtml = lanes.map(l => `<div class="glane" style="top:${l.y}px;height:${l.h}px">
      <div class="glabel" style="width:${GANTT.LABEL_W}px;padding-left:${10 + l.depth * 14}px" ${l.node ? `data-gid="${esc(l.node.id)}"` : ''}>
        <span class="ico" style="--c:var(${l.agent ? '--c-agent' : '--c-turn'})"><svg viewBox="0 0 24 24">${ICONS[l.agent ? 'agent' : 'session']}</svg></span>
        <span class="gl-text"><b>${esc(oneLine(l.label, 40))}</b><small>${esc(l.sub)}</small></span>
      </div>
    </div>`).join('')
  inner.style.height = `${y + 20}px`
  inner.innerHTML = `${laneHtml}<div class="gplot" style="left:${GANTT.LABEL_W}px;width:${total + 20}px;height:${y}px"><div class="gaxis">${axis}</div>${breaks}${turns}${barHtml}</div>`
  inner.style.width = `${GANTT.LABEL_W + total + 40}px`
}

// Diagram: a sequence diagram. One column per agent, events going down in the
// order they happened (not to scale); runs of one tool fold into one box; an
// arrow goes from where an agent was launched to its column, and back from its
// end to the moment its result reached the launcher.

const DIAG = { COL_W: 200, GAP: 34, ROW_H: 50, TOP: 56 }

function drawDiagram() {
  const m = state.model
  const inner = $('#diagram-inner')
  if (!m) {
    inner.innerHTML = ''
    return
  }
  const f = state.filters
  const lanes = laneList(m)
  const col = new Map(lanes.map((l, i) => [l.agent, i]))
  const dim = n => (f.q && !searchText(n).includes(f.q)) || (f.errors && n.status !== 'error' && n.status !== 'denied')
  // Items in time order: boxes, launches, returns, turn separators.
  const items = []
  for (const n of m.nodes.values()) {
    if (n.mergedInto || n.t0 == null) continue
    if (n.kind === 'agent') {
      const from = col.get(laneOf(n))
      const to = col.get(n.agent)
      if (from != null) items.push({ type: 'launch', n, col: from, to, t: n.t0 })
      if (to != null && n.t1 != null && from != null) items.push({ type: 'return', n, col: from, from: to, t: n.t1 })
      continue
    }
    const c = col.get(n.agent ?? null)
    if (c == null) continue
    const short = f.minMs && (n.t1 ?? n.t0) - n.t0 < f.minMs
    if ((n.kind === 'tool' || n.kind === 'skill') && kindShown(n) && !short) items.push({ type: 'box', n, col: c, t: n.t0 })
    else if ((n.kind === 'text' || (n.kind === 'thinking' && kindShown(n))) && kindShown(n) && !f.minMs) items.push({ type: 'box', n, col: c, t: n.t0 })
  }
  for (const t of m.root.children) if (t.kind === 'turn' && t.t0 != null) items.push({ type: 'turn', n: t, t: t.t0 - 0.5 })
  items.sort((a, b) => a.t - b.t || (a.type === 'turn' ? -1 : 0))
  // Fold runs of one tool in a column (nothing else in that column between them).
  const last = new Map()
  const rows = []
  for (const it of items) {
    if (it.type === 'box' && it.n.kind === 'tool') {
      const prev = last.get(it.col)
      if (prev?.type === 'box' && prev.n.kind === 'tool' && prev.n.data.toolName === it.n.data.toolName) {
        ;(prev.more ??= []).push(it.n)
        continue
      }
    }
    if (it.col != null) last.set(it.col, it)
    if (it.type === 'turn') last.clear()
    it.row = rows.length
    rows.push(it)
  }
  const x = c => 20 + c * (DIAG.COL_W + DIAG.GAP)
  const y = r => DIAG.TOP + r * DIAG.ROW_H
  const width = x(lanes.length) + 20
  const height = y(rows.length) + 40
  // Lifelines: from an agent's launch to its return (or the end).
  const life = lanes.map(l => ({ a: l.agent ? Infinity : 0, b: l.agent ? -Infinity : rows.length }))
  for (const it of rows) {
    if (it.type === 'launch' && it.to != null) life[it.to].a = Math.min(life[it.to].a, it.row)
    if (it.type === 'return' && it.from != null) life[it.from].b = Math.max(life[it.from].b, it.row)
    if (it.type === 'box') {
      life[it.col].a = Math.min(life[it.col].a, it.row)
      life[it.col].b = Math.max(life[it.col].b, it.row + 1)
    }
  }
  let svg = ''
  for (const [i, l] of life.entries()) {
    if (!isFinite(l.a)) continue
    const cx = x(i) + DIAG.COL_W / 2
    svg += `<line class="dlife" x1="${cx}" y1="${y(l.a)}" x2="${cx}" y2="${y(Math.max(l.b, l.a + 1))}"/>`
  }
  let html = ''
  for (const it of rows) {
    const top = y(it.row)
    if (it.type === 'turn') {
      html += `<div class="dturn" style="top:${top + 14}px;width:${width - 20}px" data-gid="${esc(it.n.id)}"><b>${esc(oneLine(it.n.label, 120))}</b></div>`
      continue
    }
    if (it.type === 'launch') {
      const x1 = x(it.col) + DIAG.COL_W / 2
      const x2 = it.to != null ? x(it.to) + DIAG.COL_W / 2 : x1
      html += `<div class="dlaunch${dim(it.n) ? ' dim' : ''}${it.n.id === state.selected ? ' sel' : ''}" style="left:${x(it.col) + 18}px;top:${top + 8}px;width:${DIAG.COL_W - 36}px" data-gid="${esc(it.n.id)}"><span class="ico"><svg viewBox="0 0 24 24">${ICONS.launch}</svg></span><span class="dtxt"><b>${esc(oneLine(it.n.label, 40))}</b><small>${esc(oneLine(it.n.sub, 40))}</small></span></div>`
      if (it.to != null) {
        const yy = top + 26
        const right = x2 > x1
        svg += `<path class="darrow launch" d="M${right ? x(it.col) + DIAG.COL_W - 18 : x(it.col) + 18} ${yy} H${right ? x2 - 8 : x2 + 8}" marker-end="url(#dah)"/>`
      }
      continue
    }
    if (it.type === 'return') {
      const x1 = x(it.from) + DIAG.COL_W / 2
      const x2 = x(it.col) + DIAG.COL_W / 2
      const yy = top + 22
      svg += `<path class="darrow back" d="M${x1} ${yy} H${x2 + (x1 > x2 ? 8 : -8)}" marker-end="url(#dah2)"/>`
      html += `<div class="dreturn" style="left:${Math.min(x1, x2) + 12}px;top:${yy - 18}px;width:${Math.abs(x1 - x2) - 24}px" data-gid="${esc(it.n.id)}">${esc(it.n.data.spawn?.background ? 'result arrives' : 'returns')} · ${esc(fmtMs((it.n.t1 ?? it.n.t0) - it.n.t0))}</div>`
      continue
    }
    const n = it.n
    const more = it.more?.length ?? 0
    const all = [n, ...(it.more ?? [])]
    const dur = all.reduce((t, k) => t + Math.max(0, (k.t1 ?? k.t0) - k.t0), 0)
    const hooks = all.reduce((t, k) => t + k.children.filter(c => c.kind === 'hook').length, 0)
    const bad = all.some(k => k.status === 'error' || k.status === 'denied')
    const label = n.kind === 'text' ? 'Text' : n.kind === 'thinking' ? 'Thinking' : `${n.label}${more ? ` ×${more + 1}` : ''}`
    html += `<div class="dbox k-${n.kind}${bad ? ' st-error' : ''}${dim(n) ? ' dim' : ''}${all.some(k => k.id === state.selected) ? ' sel' : ''}" style="left:${x(it.col) + 10}px;top:${top + 6}px;width:${DIAG.COL_W - 20}px;--c:${color(n)}" data-gid="${esc(n.id)}" title="${esc(oneLine(n.sub ?? '', 200))}">
      <span class="ico">${icon(n)}</span><span class="dtxt"><b>${esc(oneLine(label, 34))}</b><small>${esc(oneLine(n.sub ?? '', 46))}</small></span>
      ${n.kind === 'tool' || n.kind === 'skill' ? `<span class="dmeta">${dur ? esc(fmtMs(dur)) : ''}${hooks && kindShown({ kind: 'hook', data: {} }) ? `<i>${hooks}h</i>` : ''}</span>` : ''}
    </div>`
  }
  const heads = lanes.map((l, i) => `<div class="dhead" style="left:${x(i)}px;width:${DIAG.COL_W}px" ${l.node ? `data-gid="${esc(l.node.id)}"` : ''}><span class="ico" style="--c:var(${l.agent ? '--c-agent' : '--c-turn'})"><svg viewBox="0 0 24 24">${ICONS[l.agent ? 'agent' : 'session']}</svg></span><span class="dtxt"><b>${esc(oneLine(l.label, 30))}</b><small>${esc(oneLine(l.sub, 36))}</small></span></div>`).join('')
  inner.style.width = `${width}px`
  inner.style.height = `${height}px`
  inner.innerHTML = `<svg class="dsvg" width="${width}" height="${height}"><defs>
      <marker id="dah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1L9 5L1 9z" fill="var(--c-agent)"/></marker>
      <marker id="dah2" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1L9 5L1 9z" fill="var(--c-ok)"/></marker>
    </defs>${svg}</svg><div class="dheads" style="width:${width}px">${heads}</div>${html}${rows.length ? '' : '<div class="dim" style="position:absolute;top:80px;left:20px">Nothing to draw with these filters.</div>'}`
}

// Components: every subagent type, skill and hook across sessions, built from
// the same model as the tree.

const comp = { days: 30, data: null, cache: new Map(), loading: false, selected: null }

function setMode(mode) {
  document.querySelector('.app').dataset.mode = mode
  for (const b of document.querySelectorAll('.mode')) b.classList.toggle('on', b.dataset.mode === mode)
  if (mode === 'components') {
    inspect(null)
    if (!comp.data && !comp.loading) loadComponents()
    else drawComponents()
  }
}

async function loadComponents() {
  comp.loading = true
  const since = comp.days ? Date.now() - comp.days * 86400000 : 0
  const list = state.sessions.filter(s => (s.endedAt ?? s.startedAt ?? 0) >= since)
  const agg = { agents: new Map(), skills: new Map(), hooks: new Map(), sessions: list.length }
  let done = 0
  for (const s of list) {
    $('#comp-body').innerHTML = `<div class="comp-loading"><div class="orbit"><i></i><i></i><i></i></div>Reading ${++done} of ${list.length} sessions…</div>`
    let c = comp.cache.get(s.sid)
    if (!c || c.size !== s.size) {
      try {
        const [r, h] = await Promise.all([fetch(`api/session/${s.sid}/records?offset=0`), fetch(`api/session/${s.sid}/hookconfig`)])
        const recs = (await r.json()).records ?? []
        const conf = await h.json()
        c = { size: s.size, model: build(recs, {}, Array.isArray(conf) ? conf : []) }
        comp.cache.set(s.sid, c)
      } catch {
        continue
      }
    }
    collect(agg, s, c.model)
  }
  comp.data = agg
  comp.loading = false
  drawComponents()
}

function collect(agg, s, model) {
  const entry = (map, key, init = {}) => {
    let e = map.get(key)
    if (!e) map.set(key, (e = { key, uses: [], listed: new Set(), sessions: new Set(), repos: new Set(), ...init }))
    return e
  }
  const repo = base(s.cwd)
  const turnOf = n => {
    let p = n
    while (p && p.kind !== 'turn') p = p.parent
    return p
  }
  const launcher = n => {
    for (let p = n.parent; p; p = p.parent) if (p.kind === 'agent') return p.data.spawn?.type ?? p.label
    return 'main'
  }
  for (const sk of model.S.offers.skills) entry(agg.skills, sk.name, { source: sk.source, plugin: sk.plugin }).listed.add(s.sid)
  for (const n of model.nodes.values()) {
    if (n.kind === 'context' && n.label === 'agent_listing_delta') {
      for (const m of String(n.data.text ?? '').matchAll(/^- (\S+?): /gm)) entry(agg.agents, m[1]).listed.add(s.sid)
    }
  }
  const use = (e, n, extra) => {
    const turn = turnOf(n)
    e.uses.push({ sid: s.sid, title: s.title, repo, ts: n.t0, nodeId: n.id, prompt: turn?.data.prompt?.text ?? turn?.label, ...extra })
    e.sessions.add(s.sid)
    if (repo) e.repos.add(repo)
  }
  for (const n of model.nodes.values()) {
    if (n.mergedInto) continue
    if (n.kind === 'agent') {
      const sp = n.data.spawn ?? {}
      use(entry(agg.agents, sp.type || 'unknown'), n, { label: n.label, model: sp.model, background: sp.background, ms: (n.t1 ?? n.tEnd) - n.t0, out: n.tot.out, by: launcher(n), status: n.status })
    } else if ((n.kind === 'tool' && n.data.skill) || (n.kind === 'skill' && n.data.skill?.skill)) {
      const sk = n.data.skill
      use(entry(agg.skills, sk.skill), n, { via: sk.via, args: sk.args, by: launcher(n), status: n.status })
    } else if (n.kind === 'hook' && n.data.hookEvent) {
      const pick = n.data.pick
      const key = `${n.data.hookEvent}|${pick?.command ?? n.data.detail?.command ?? '?'}`
      const e = entry(agg.hooks, key, { label: n.label, event: n.data.hookEvent, command: pick?.command ?? n.data.detail?.command, source: pick?.source ?? (n.data.detail ? 'transcript' : 'not in settings'), host: !!pick?.host, tools: new Map() })
      const tool = n.parent?.kind === 'tool' ? n.parent.data.toolName : n.parent?.kind === 'agent' ? 'Agent' : null
      if (tool) e.tools.set(tool, (e.tools.get(tool) ?? 0) + 1)
      use(e, n, { tool, inferred: !!pick && !n.data.detail, candidates: n.data.cands?.length ?? 0 })
    }
  }
}

function drawComponents() {
  const d = comp.data
  const el = $('#comp-body')
  if (!d) return
  const q = $('#comp-q').value.trim().toLowerCase()
  const keep = e => !q || `${e.key} ${e.label ?? ''} ${e.command ?? ''}`.toLowerCase().includes(q)
  const max = Math.max(1, ...[...d.agents.values(), ...d.skills.values(), ...d.hooks.values()].map(e => e.uses.length))
  const card = (kind, e, title, sub, badges) => {
    const unused = !e.uses.length
    const last = Math.max(...e.uses.map(u => u.ts ?? 0), 0)
    return `<div class="comp${unused ? ' unused' : ''}${comp.selected === `${kind}:${e.key}` ? ' sel' : ''}" data-comp="${esc(`${kind}:${e.key}`)}">
      <span class="ico" style="--c:var(${kind === 'agents' ? '--c-agent' : kind === 'skills' ? '--c-skill' : '--c-hook'})"><svg viewBox="0 0 24 24">${ICONS[kind === 'agents' ? 'agent' : kind === 'skills' ? 'skill' : 'hook']}</svg></span>
      <span class="comp-name"><b>${esc(title)}</b><small>${esc(sub)}</small></span>
      <span class="comp-badges">${badges}</span>
      <span class="comp-bar"><i style="width:${(e.uses.length / max) * 100}%"></i></span>
      <span class="comp-num">${e.uses.length}</span>
      <span class="comp-last">${unused ? 'never' : esc(fmtAgo(last))}</span>
    </div>`
  }
  const sort = m => [...m.values()].filter(keep).sort((a, b) => b.uses.length - a.uses.length || a.key.localeCompare(b.key))
  const listedBadge = e => (e.listed.size ? `<span class="badge${e.uses.length ? '' : ' warn'}" title="Sessions where it was offered to the model">used in ${e.sessions.size} of ${Math.max(e.listed.size, e.sessions.size)} sessions</span>` : `<span class="badge">${e.sessions.size} sessions</span>`)
  const agents = sort(d.agents)
  const skills = sort(d.skills)
  const hooks = sort(d.hooks)
  const section = (title, hint, rows) => `<div class="comp-sec"><h2>${esc(title)} <small>${esc(hint)}</small></h2>${rows || '<div class="dim">Nothing in these sessions.</div>'}</div>`
  el.innerHTML = `<div class="comp-sum">${d.sessions} sessions read · ${d.agents.size} agent types · ${d.skills.size} skills · ${d.hooks.size} hooks</div>` +
    section('Subagents', 'by type · runs', agents.map(e => card('agents', e, e.key, [...new Set(e.uses.map(u => u.model).filter(Boolean))].join(', ') || 'offered, never run', `${listedBadge(e)}${e.repos.size ? `<span class="badge">${e.repos.size} repo${e.repos.size > 1 ? 's' : ''}</span>` : ''}`)).join('')) +
    section('Skills', 'loads', skills.map(e => card('skills', e, e.key, e.plugin ? `plugin ${e.plugin}` : e.source ?? '', `${listedBadge(e)}${e.uses.some(u => u.via === 'command') ? '<span class="badge">typed</span>' : ''}`)).join('')) +
    section('Hooks', 'inferred runs', hooks.map(e => card('hooks', e, e.label, `${e.event} · ${e.source}`, `<span class="badge">${e.sessions.size} sessions</span>${e.tools.size ? `<span class="badge" title="Tools it ran around">${[...e.tools].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => esc(t)).join(', ')}</span>` : ''}`)).join(''))
}

function inspectComponent(id) {
  comp.selected = id
  drawComponents()
  const [kind, ...rest] = id.split(':')
  const key = rest.join(':')
  const e = comp.data?.[kind]?.get(key)
  const el = $('#inspector')
  if (!e) return
  const title = kind === 'hooks' ? e.label : e.key
  const color = kind === 'agents' ? '--c-agent' : kind === 'skills' ? '--c-skill' : '--c-hook'
  const icon = ICONS[kind === 'agents' ? 'agent' : kind === 'skills' ? 'skill' : 'hook']
  const uses = [...e.uses].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
  let html = `<div class="insp-head"><div class="insp-title" style="--c:var(${color})"><span class="ico"><svg viewBox="0 0 24 24">${icon}</svg></span><div><div class="kindtag">${esc(kind.slice(0, -1))}</div><h2>${esc(title)}</h2></div></div>
    <div class="badges"><span class="badge">${e.uses.length} uses</span><span class="badge">${e.sessions.size} sessions</span>${e.listed.size ? `<span class="badge">offered in ${e.listed.size}</span>` : ''}</div></div>`
  const stats = [['Repos', esc([...e.repos].join(', ')) || null]]
  if (kind === 'agents') {
    const ms = e.uses.map(u => u.ms).filter(x => x > 0)
    stats.push(['Models', esc([...new Set(e.uses.map(u => u.model).filter(Boolean))].join(', ')) || null], ['Launched by', esc([...new Set(e.uses.map(u => u.by))].join(', ')) || null], ['Median run', ms.length ? fmtMs(ms.sort((a, b) => a - b)[Math.floor(ms.length / 2)]) : null], ['Tokens out', fmtNum(e.uses.reduce((t, u) => t + (u.out ?? 0), 0))], ['Background', `${e.uses.filter(u => u.background).length} of ${e.uses.length}`])
  }
  if (kind === 'skills') stats.push(['Source', esc(e.plugin ? `plugin ${e.plugin}` : e.source) || null], ['Via', esc([...new Set(e.uses.map(u => u.via))].join(', ')) || null], ['Loaded by', esc([...new Set(e.uses.map(u => u.by))].join(', ')) || null])
  if (kind === 'hooks') stats.push(['Event', esc(e.event)], ['Command', e.command ? `<code>${esc(e.command)}</code>` : null], ['Source', esc(e.source)], ['Around tools', esc([...e.tools].map(([t, c]) => `${t} ×${c}`).join(', ')) || null], ['How it is known', e.host ? 'host app callbacks (not which one)' : e.uses.some(u => u.inferred) ? 'inferred from event and matcher' : 'from the transcript'])
  html += sec('Summary', kv(stats))
  if (e.listed.size && e.sessions.size < e.listed.size) html += sec('Offered but not used', `<div class="dim">Listed to the model in ${e.listed.size - e.sessions.size} session(s) where it was never ${kind === 'skills' ? 'loaded' : 'run'}. If you expected it there, its description may not match how you ask.</div>`)
  html += sec(`Uses (${uses.length})`, uses.length ? `<div class="uses">${uses.slice(0, 80).map(u => `<a class="use" href="#${esc(u.sid)}~${esc(u.nodeId)}">
      <span class="u-top"><b>${esc(u.label ? oneLine(u.label, 60) : u.args ? oneLine(u.args, 60) : u.tool ?? '')}</b><span>${esc(fmtAgo(u.ts))}</span></span>
      <span class="u-sub">${esc(u.repo)} · ${esc(oneLine(u.prompt, 90))}</span>
    </a>`).join('')}</div>` : '<div class="dim">Never used in these sessions.</div>')
  el.innerHTML = html
}

function toggleHelp(show) {
  const el = $('#help')
  const on = show ?? el.hidden
  el.hidden = !on
  if (!on) return
  const legend = (key, label, cls, c) => `<span class="lg"><span class="ico ${cls}" style="--c:var(${c})"><svg viewBox="0 0 24 24">${ICONS[key]}</svg></span>${label}</span>`
  el.querySelector('.help').innerHTML = `
    <div class="help-head"><h2>Session Flow</h2><button class="ghost" data-close>Close · Esc</button></div>
    <p class="dim">What your Claude Code sessions did: every subagent, tool call, skill, hook and text, recorded by the session-flow plugin without changing the session.</p>
    <div class="help-grid">
      <section><h3>Views</h3>
        <p><b>Sessions → Tree</b>: turns, then what each agent did. A subagent is one row (its Agent call is merged into it); its own work hangs below.</p>
        <p><b>Sessions → Timeline</b> (<kbd>t</kbd>): one lane per agent. Thin bars are model requests, thick bars tool calls, striped bars subagents running. Idle gaps are folded (hatched). <kbd>⌘</kbd>+wheel zooms, drag to pan.</p>
        <p><b>Sessions → Diagram</b>: a sequence diagram, one column per agent, events going down in the order they happened. Violet arrows launch a subagent; green arrows bring its result back. Runs of one tool fold into one box.</p>
        <p><b>Components</b>: your subagent types, skills and hooks across sessions: how often, where, launched by whom, and where they were offered but not used.</p>
      </section>
      <section><h3>Shapes and colours</h3>
        <div class="legend">
          ${legend('agent', 'Agent (circle)', 'lg-agent', '--c-agent')}
          ${legend('bash', 'Tool call (square, colour = family)', 'lg-tool', '--c-bash')}
          ${legend('launch', 'Launch agent', 'lg-tool', '--c-agent')}
          ${legend('workflow', 'Workflow', 'lg-tool', '--c-workflow')}
          ${legend('skill', 'Skill (a tool family)', 'lg-tool', '--c-skill')}
          ${legend('hook', 'Hook', 'lg-dot', '--c-hook')}
          ${legend('text', 'Text', 'lg-dot', '--c-text')}
          ${legend('thinking', 'Thinking', 'lg-dot', '--c-thinking')}
          ${legend('turn', 'Turn, step, context (outline)', 'lg-struct', '--c-turn')}
        </div>
      </section>
      <section><h3>Filters</h3>
        <p><b>Presets</b> set everything at once (Agents only shows just who launched whom). <b>Scope</b> picks all agents, the main one, or one agent.</p>
        <p><b>Kinds</b>: click to hide, <kbd>⌥</kbd>-click to show only one. Hidden kinds never hide their children: those move up and say where they came from. <b>Tools ▾</b> filters by family and tool.</p>
      </section>
      <section><h3>Keys</h3>
        <div class="keys"><kbd>↑</kbd><kbd>↓</kbd> / <kbd>j</kbd><kbd>k</kbd> move · <kbd>→</kbd><kbd>←</kbd> open, close · <kbd>Enter</kbd> toggle · <kbd>/</kbd> search · <kbd>e</kbd> next error · <kbd>f</kbd> follow live · <kbd>t</kbd> next view (tree, timeline, diagram) · <kbd>?</kbd> help</div>
      </section>
      <section class="wide"><h3>What it cannot see</h3>
        <p class="dim">Which hook command ran is inferred from your settings (Claude Code reports only the event); hooks of the Claude Desktop app are callbacks no settings file lists; some thinking arrives without text; skills preloaded into a subagent are not seen. The <b>health</b> badge in the header warns when a log looks incomplete, which usually means a Claude Code update changed something. Full list: docs/limitations.md.</p>
      </section>
    </div>`
}

function setFollow(on) {
  state.follow = on
  $('#follow').classList.toggle('on', on)
  if (on) followNewest()
}

async function main() {
  try {
    const t = localStorage.getItem('session-flow-theme')
    if (t) document.documentElement.dataset.theme = t
    else if (matchMedia('(prefers-color-scheme: light)').matches) document.documentElement.dataset.theme = 'light'
  } catch {}
  wire()
  syncControls()
  await loadSessions()
  const [hashSid, hashNode] = location.hash.slice(1).split('~')
  const sid = hashSid || state.sessions[0]?.sid
  if (sid) await openSession(sid, hashNode)
  state.timer = setInterval(async () => {
    await loadSessions()
    if (state.live || state.sessions.find(s => s.sid === state.sid)?.live) await poll()
  }, POLL_MS)
  window.addEventListener('hashchange', () => {
    const [h, node] = location.hash.slice(1).split('~')
    if (h && h !== state.sid) openSession(h, node)
  })
}

main()
