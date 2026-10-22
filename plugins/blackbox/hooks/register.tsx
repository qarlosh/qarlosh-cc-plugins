import type { EngineInterface, PluginOptions, Register } from 'claude-code'

// Platforms: macOS is tested; Linux uses the same commands (sh, cat, find, python3); on
// Windows (OS=Windows_NT) the shell steps go through PowerShell instead, untested.
//
// Collector: observes engine events and appends one JSON record per event to
// <logDir>/<sessionId>.jsonl. Format: docs/events.md. Rules: docs/design.md,
// "No interference": every hook passes its event on untouched and returns what
// `next` returned; the collector's own work never throws into the engine and
// never awaits anything before `next`. A hook that fails anyway answers what
// `next` answered (`.catch`; `next` is replay-safe there).

type Json = Record<string, unknown>

const AGENT_STATS = ['status', 'totalDurationMs', 'totalTokens', 'totalToolUseCount', 'resolvedModel', 'outputFile', 'agentId']
const SKILL_STATS = ['commandName', 'status', 'model']
const MAX_BUFFER = 50_000

const GLYPH = '▣'

class Collector {
  readonly maxText: number
  readonly flushMs: number
  readonly logDirOption: string
  readonly viewerPort: number

  sid: string | undefined
  logPath: string | undefined
  clockBase: number | undefined
  perfBase = 0
  seq = 0
  buffer: Json[] = []
  flushing = false
  needsRefresh = false
  sessionInfoSeen = false
  transcriptTries = 0
  home: string | undefined
  windows = false
  stats = { events: {} as Record<string, number>, ownMs: {} as Record<string, number>, errors: [] as string[] }
  statsDirty = false
  // Whether the last write to the log failed; the indicators say so.
  writeFailing = false
  readonly skillNames = new Set<string>()

  constructor(options: PluginOptions) {
    this.maxText = typeof options.maxTextChars === 'number' && options.maxTextChars > 0 ? options.maxTextChars : 20000
    this.flushMs = typeof options.flushMs === 'number' && options.flushMs >= 500 ? options.flushMs : 3000
    this.logDirOption = typeof options.logDir === 'string' ? options.logDir.trim() : ''
    this.viewerPort = typeof options.viewerPort === 'number' && options.viewerPort > 0 ? Math.round(options.viewerPort) : 7777
  }

  now() {
    return this.clockBase === undefined ? Date.now() : this.clockBase + (performance.now() - this.perfBase)
  }

  fail(label: string, err: unknown) {
    if (this.stats.errors.length < 20) this.stats.errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`)
    this.statsDirty = true
  }

  // Runs the collector's own work for one event: timed, and never throwing.
  observe(label: string, fn: () => void) {
    const t0 = performance.now()
    try {
      fn()
    } catch (err) {
      this.fail(label, err)
    }
    this.stats.ownMs[label] = (this.stats.ownMs[label] ?? 0) + (performance.now() - t0)
  }

  push(kind: string, agent: unknown, fields: Json) {
    if (this.buffer.length >= MAX_BUFFER) this.buffer.shift()
    const rec: Json = { v: 1, seq: this.seq++, ts: Math.round(this.now()), sid: this.sid, agent: typeof agent === 'string' ? agent : null, kind, ...fields }
    this.buffer.push(rec)
    this.stats.events[kind] = (this.stats.events[kind] ?? 0) + 1
    this.statsDirty = true
    return rec
  }

  // Sets `rec[key]` to `value`, cutting a long string and noting its length.
  put(rec: Json, key: string, value: unknown) {
    if (value === undefined) return rec
    if (typeof value === 'string' && value.length > this.maxText) {
      rec[key] = value.slice(0, this.maxText)
      rec[`${key}Len`] = value.length
    } else {
      rec[key] = value
    }
    return rec
  }

  cutAll(obj: Json) {
    const out: Json = {}
    for (const [k, v] of Object.entries(obj)) this.put(out, k, v)
    return out
  }

  blocks(content: unknown) {
    return (Array.isArray(content) ? content : []).map((b: any) => {
      switch (b?.type) {
        case 'text':
          return this.put({ type: 'text' }, 'text', b.text)
        case 'thinking':
          return this.put({ type: 'thinking' }, 'text', b.thinking ?? b.text)
        case 'tool_use':
          return { type: 'tool_use', id: b.id, name: b.name }
        case 'tool_result':
          return { type: 'tool_result', toolUseId: b.tool_use_id, isError: b.is_error === true }
        default:
          return { type: typeof b?.type === 'string' ? b.type : 'unknown' }
      }
    })
  }

  // Moves the stats gathered since the last flush into the buffer.
  takeStats() {
    if (!this.statsDirty) return
    const ownMs: Record<string, number> = {}
    for (const [k, v] of Object.entries(this.stats.ownMs)) ownMs[k] = Math.round(v * 100) / 100
    this.buffer.push({ v: 1, seq: this.seq++, ts: Math.round(this.now()), sid: this.sid, agent: null, kind: 'collector.stats', ...this.stats, ownMs })
    this.stats = { events: {}, ownMs: {}, errors: [] }
    this.statsDirty = false
  }
}

function pick(obj: unknown, keys: string[]) {
  if (!obj || typeof obj !== 'object') return undefined
  const out: Json = {}
  for (const k of keys) if ((obj as Json)[k] !== undefined) out[k] = (obj as Json)[k]
  return Object.keys(out).length ? out : undefined
}

// A PowerShell single-quoted string literal. Windows support is written but untested.
function psQuote(s: string) {
  return `'${s.replace(/'/g, "''")}'`
}

function skillKey(name: unknown) {
  return String(name ?? '').replace(/^\//, '')
}

async function resolveSession($: EngineInterface, c: Collector) {
  const [id, clock, posixHome, winHome, os] = await Promise.all([$.session.id(), $.clock.now(), $.env.get('HOME'), $.env.get('USERPROFILE'), $.env.get('OS')])
  const home = posixHome ?? winHome
  c.windows = os === 'Windows_NT'
  c.clockBase = clock
  c.perfBase = performance.now()
  const dir = c.logDirOption ? c.logDirOption.replace(/^~(?=\/|$)/, home ?? '~') : `${home ?? '~'}/.claude/blackbox`
  c.home = home
  c.sid = id
  c.logPath = `${dir}/${id}.jsonl`
}

// The transcript holds what events do not (each settings hook's command,
// output and duration); the viewer joins it. Its file appears with the first
// row, so this runs from flush until it is found, a few times at most.
async function locateTranscript($: EngineInterface, c: Collector) {
  if (c.sessionInfoSeen || !c.home || !c.sid || c.transcriptTries >= 10) return
  c.transcriptTries++
  try {
    const projects = `${c.home}/.claude/projects`
    const res = c.windows
      ? await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', `Get-ChildItem -LiteralPath ${psQuote(projects)} -Depth 1 -Filter ${psQuote(`${c.sid}.jsonl`)} | Select-Object -First 1 -ExpandProperty FullName`], { timeoutMs: 10000 })
      : await $.process.run(['find', projects, '-maxdepth', '2', '-name', `${c.sid}.jsonl`], { timeoutMs: 5000 })
    const path = res.stdout.split('\n')[0]?.trim()
    if (!path) return
    c.sessionInfoSeen = true
    c.observe('session', () => c.push('session.info', null, { transcriptPath: path }))
  } catch (err) {
    c.fail('session.info', err)
  }
}

async function flush($: EngineInterface, c: Collector) {
  if (c.flushing || !c.logPath) return
  await locateTranscript($, c)
  c.takeStats()
  if (c.buffer.length === 0) return
  const batch = c.buffer
  c.buffer = []
  c.flushing = true
  try {
    const text = batch.map(r => JSON.stringify(r.sid ? r : { ...r, sid: c.sid })).join('\n') + '\n'
    const res = c.windows
      ? await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', `$p = ${psQuote(c.logPath)}; [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($p)); [IO.File]::AppendAllText($p, [Console]::In.ReadToEnd(), [Text.UTF8Encoding]::new($false))`], { stdin: text, timeoutMs: 10000 })
      : await $.process.run(['/bin/sh', '-c', 'mkdir -p "$(dirname "$0")" && cat >> "$0"', c.logPath], { stdin: text, timeoutMs: 5000 })
    if (res.exitCode !== 0) throw new Error(res.stderr.slice(0, 200))
    setWriteFailing($, c, false)
  } catch (err) {
    c.buffer = batch.concat(c.buffer).slice(-MAX_BUFFER)
    c.fail('flush', err)
    setWriteFailing($, c, true)
  } finally {
    c.flushing = false
  }
}

// Indicator: a blackbox button in the prompt footer that opens the viewer. It
// draws only; a failure gives the engine's own drawing back.

function setWriteFailing($: EngineInterface, c: Collector, failing: boolean) {
  if (c.writeFailing === failing) return
  c.writeFailing = failing
  $.ui.invalidate('ui.render')
}

async function pressOpenViewer($: EngineInterface, c: Collector) {
  try {
    await flush($, c)
    await openViewer($, c)
  } catch (err) {
    c.fail('viewer', err)
  }
}

async function recordOfferedSkills($: EngineInterface, c: Collector) {
  try {
    const usage: any = await $.session.usage({ breakdown: 'summary' })
    const skills = usage?.context?.breakdown?.skills?.skillFrontmatter
    if (!Array.isArray(skills)) return
    for (const s of skills) if (typeof s?.name === 'string') c.skillNames.add(s.name)
    c.observe('offer', () =>
      c.push('offer.skills', null, {
        skills: skills.map((s: any) => ({ name: s.name, source: s.source, plugin: s.pluginName, tokens: s.tokens })),
      }),
    )
  } catch (err) {
    c.fail('offer.skills', err)
  }
}

async function startSession($: EngineInterface, c: Collector, e: { cwd: unknown; surface: unknown; isInteractive: unknown }) {
  try {
    await resolveSession($, c)
    const continued = c.logPath ? await $.fs.exists(c.logPath) : false
    c.observe('session', () => c.push('session.start', null, { cwd: e.cwd, surface: e.surface, isInteractive: e.isInteractive, continued }))
    $.clock.every(c.flushMs, () => void flush($, c))
    await $.command.register({ name: 'blackbox', description: 'Open the blackbox viewer on this session' })
    void recordOfferedSkills($, c)
  } catch (err) {
    c.fail('session.start', err)
  }
}

// After /clear the session has a new id: records from `fromSeq` on belong to it.
// Starts the viewer (or reuses a running one) and opens it on this session.
async function openViewer($: EngineInterface, c: Collector) {
  const args = [`${$.plugin.root}/viewer/server.py`, '--port', String(c.viewerPort), '--open', c.sid ?? '']
  if (c.logDirOption) args.push('--log-dir', c.logDirOption)
  if (c.windows) {
    await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', `Start-Process -WindowStyle Hidden -FilePath python -ArgumentList ${args.map(a => psQuote(`"${a}"`)).join(',')}`], { timeoutMs: 10000 })
  } else {
    await $.process.run(['/bin/sh', '-c', 'nohup python3 "$@" >/dev/null 2>&1 &', 'sh', ...args], { timeoutMs: 10000 })
  }
}

async function refreshAfterClear($: EngineInterface, c: Collector, fromSeq: number) {
  c.needsRefresh = false
  c.sessionInfoSeen = false
  c.transcriptTries = 0
  try {
    await resolveSession($, c)
    for (const r of c.buffer) if ((r.seq as number) >= fromSeq) r.sid = c.sid
  } catch (err) {
    c.fail('prompt', err)
  }
}

export const register: Register = (on, options) => {
  if (options.enabled === false) return
  const c = new Collector(options)

  // Session

  on('command.run', { command: 'blackbox' }, async $ => {
    await flush($, c)
    await openViewer($, c)
    return { text: 'blackbox viewer opened in the browser.' }
  })

  // Indicator

  on('ui.render', { component: 'SessionMode' }, ($, e, next) => {
    if (e.surface === 'terminal') return next({ ...e, props: { ...e.props, modes: [...e.props.modes, `${GLYPH} blackbox`] } })
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        {e.props.modes.length > 0 && <Text dimColor>{e.props.modes.join(' & ')}</Text>}
        <Button key="open-viewer" label={c.writeFailing ? 'blackbox ⚠' : 'blackbox'} plain dimColor onPress={() => void pressOpenViewer($, c)} />
      </Box>
    )
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await startSession($, c, e)
    return r
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    const r = await next(e)
    c.observe('session', () => c.push('session.end', null, { reason: e.reason }))
    await flush($, c)
    if (e.reason === 'clear') c.needsRefresh = true
    return r
  }).catch(($, e, next) => next(e))

  // Turns and steps

  on('prompt.submit', async ($, e, next) => {
    const fromSeq = c.seq
    let rec: Json | undefined
    c.observe('prompt', () => {
      const ev = e as any
      const fields = c.put({ origin: ev.origin?.kind }, 'text', ev.text)
      if (Array.isArray(ev.attachments) && ev.attachments.length) fields.attachments = ev.attachments.map((a: any) => a?.name ?? a?.type)
      rec = c.push('prompt', null, fields)
      const typed = typeof ev.text === 'string' ? /^\/(\S+)\s*([\s\S]*)$/.exec(ev.text) : null
      if (typed?.[1] && c.skillNames.has(typed[1])) c.push('skill.load', null, { skill: typed[1], via: 'command', args: typed[2] || undefined })
    })
    const r = await next(e)
    if (rec && 'drop' in r) rec.dropped = true
    if (c.needsRefresh) await refreshAfterClear($, c, fromSeq)
    return r
  }).catch(($, e, next) => next(e))

  on('turn.start', ($, e, next) => {
    c.observe('turn', () => c.push('turn.start', null, c.put({ turnId: e.turnId }, 'text', e.text)))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const t0 = c.now()
    c.observe('step', () =>
      c.push('step.start', e.agentId, { turnId: e.turnId, index: e.index, model: e.model, effort: e.effort, messageCount: e.messageCount }),
    )
    const r = yield* next(e)
    c.observe('step', () => {
      const res = r as any
      c.push('step.end', e.agentId, {
        turnId: e.turnId,
        index: e.index,
        durationMs: Math.round(c.now() - t0),
        stopReason: res?.stopReason,
        usage: res?.usage ?? undefined,
        toolCount: Array.isArray(res?.toolUses) ? res.toolUses.length : 0,
        serverTools: Array.isArray(res?.serverToolUses)
          ? res.serverToolUses.map((s: any) => ({ name: s.name, startedAt: s.startedAt, endedAt: s.endedAt }))
          : undefined,
      })
    })
    return r
  })

  on('turn.complete', ($, e, next) => {
    c.observe('turn', () => {
      const ev = e as any
      const rec: Json = { turnId: ev.turnId, durationMs: ev.durationMs, reason: ev.reason, isAborted: ev.isAborted, usage: ev.usage, refusal: ev.refusal }
      c.put(rec, 'answer', ev.answer)
      c.push('turn.end', ev.agentId, rec)
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  // Conversation rows

  on('session.append', ($, e, next) => {
    c.observe('row', () => {
      const ev = e as any
      const m = ev.message ?? {}
      c.push('row', ev.agentId, {
        uuid: ev.uuid,
        type: m.type,
        door: ev.door,
        origin: pick(ev.origin, ['kind', 'event', 'tool', 'model', 'name']),
        name: m.name,
        isMeta: m.isMeta || undefined,
        blocks: c.blocks(m.content),
      })
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  // Tools and permissions

  on('tool.call', async ($, e, next) => {
    const t0 = c.now()
    const { tool, tool_use_id: toolUseId, agentId, requestMeta: _meta, ...input } = e as any
    c.observe('tool', () => c.push('tool.start', agentId, { toolUseId, tool, input: c.cutAll(input) }))
    const r = await next(e)
    c.observe('tool', () => {
      const res = r as any
      const rec: Json = { toolUseId, tool, durationMs: Math.round(c.now() - t0), isError: res?.isError === true }
      if (res?.deny !== undefined) c.put(rec, 'denied', String(res.deny))
      c.put(rec, 'text', res?.text)
      if (tool === 'Agent') rec.stats = pick(res?.result, AGENT_STATS)
      if (tool === 'Skill') rec.stats = pick(res?.result, SKILL_STATS)
      c.push('tool.end', agentId, rec)
      if (tool === 'Skill' && !rec.isError && rec.denied === undefined) {
        c.push('skill.load', agentId, { skill: skillKey(input.skill), via: 'tool', toolUseId, args: input.args, status: res?.result?.status })
      }
    })
    return r
  }).catch(($, e, next) => next(e))

  on('tool.check', async ($, e, next) => {
    const r = await next(e)
    c.observe('permission', () => {
      const ev = e as any
      const res = r as any
      c.push('permission', ev.agentId, { toolUseId: ev.tool_use_id, tool: ev.tool, decision: res?.decision, reason: res?.reason, rule: res?.rule, hook: res?.hook })
    })
    return r
  }).catch(($, e, next) => next(e))

  // Agents

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    c.observe('agent', () => {
      const ev = e as any
      const res = r as any
      const rec: Json = {
        toolUseId: ev.tool_use_id,
        child: res?.agentId ?? res?.teammateId,
        parent: ev.parentAgentId ?? null,
        type: ev.subagentType,
        description: ev.description,
        model: res?.model,
        requestedModel: ev.model,
        background: ev.background,
        fork: ev.fork,
        isTeammate: ev.isTeammate,
        name: ev.name,
        workflow: ev.workflow,
        permissionMode: ev.permissionMode,
      }
      c.put(rec, 'prompt', ev.prompt)
      if (res?.deny !== undefined) c.put(rec, 'denied', String(res.deny))
      c.push('agent.spawn', ev.parentAgentId, rec)
    })
    return r
  }).catch(($, e, next) => next(e))
}
