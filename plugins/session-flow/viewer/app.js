'use strict'

// session-flow viewer. Reads a session log (docs/events.md) from the local
// server, builds the tree session → turn → agent → step → call, and draws it
// with a virtualised list, filters and an inspector.

const ROW_H = 30
const POLL_MS = 2000
const GROUP_MIN = 3

const KINDS = [
  { key: 'tool', label: 'Tools', color: '--c-tool' },
  { key: 'skill', label: 'Skills', color: '--c-skill' },
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
    first: null, last: null,
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
  if (n.kind === 'tool' || n.kind === 'group') return n.family === 'skill' ? 'skill' : 'tool'
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
  draw()
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

async function openSession(sid) {
  if (!sid) return
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
  tools: { label: 'Tools only', kinds: ['tool', 'skill'], steps: false },
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
    if (n.kind !== 'tool' || n.mergedInto || n.family === 'skill') continue
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
    else for (const k of Object.keys(FAMILIES)) if (k !== 'skill') f.families.add(k)
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
      case 'e': state.model && nextError(); break
      case 'f': setFollow(!state.follow); break
      default: return
    }
    e.preventDefault()
  })
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
  const sid = location.hash.slice(1) || state.sessions[0]?.sid
  if (sid) await openSession(sid)
  state.timer = setInterval(async () => {
    await loadSessions()
    if (state.live || state.sessions.find(s => s.sid === state.sid)?.live) await poll()
  }, POLL_MS)
  window.addEventListener('hashchange', () => {
    const h = location.hash.slice(1)
    if (h && h !== state.sid) openSession(h)
  })
}

main()
