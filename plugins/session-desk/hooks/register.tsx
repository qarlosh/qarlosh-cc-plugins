import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DeskSession, DotMessage, Mark } from '../types'
import { TEXTS } from './texts'
import type { Language, Texts } from './texts'

const PANE = 'session-desk'
// Vivid colors that read on light and dark backgrounds, in the order the list groups them.
const PALETTE: { mark: Mark; color: string }[] = [
  { mark: 'red', color: '#ef4444' },
  { mark: 'orange', color: '#f97316' },
  { mark: 'yellow', color: '#eab308' },
  { mark: 'green', color: '#22c55e' },
  { mark: 'blue', color: '#3b82f6' },
  { mark: 'purple', color: '#a855f7' },
]
const MARKS: Mark[] = PALETTE.map(p => p.mark)

const recent = atom({ plugin: 'session-desk', key: 'recent' } as const, [])
const older = atom({ plugin: 'session-desk', key: 'older' } as const, [])
const done = atom({ plugin: 'session-desk', key: 'done' } as const, {})
const marks = atom({ plugin: 'session-desk', key: 'marks' } as const, {})
const picking = atom({ plugin: 'session-desk', key: 'picking' } as const, '')
const isLoading = atom({ plugin: 'session-desk', key: 'isLoading' } as const, false)
const showDone = atom({ plugin: 'session-desk', key: 'showDone' } as const, false)
const showOlder = atom({ plugin: 'session-desk', key: 'showOlder' } as const, false)
const loadedAt = atom({ plugin: 'session-desk', key: 'loadedAt' } as const, 0)
const error = atom({ plugin: 'session-desk', key: 'error' } as const, '')

type Config = { windowDays: number; refreshMs: number; model: string; texts: Texts; groupByColor: boolean }
type Raw = {
  id: string
  title: string
  lastActivityAt: number
  section: string
  folder: string
  pinned: boolean
  user?: string
  reply?: string
  recap?: string
}
type Summaries = Record<string, { at: number; text: string }>

// Set by register from the plugin's options; the refresh timer runs while the pane is open.
const config: Config = { windowDays: 2, refreshMs: 600000, model: 'haiku', texts: TEXTS.en, groupByColor: true }
const timer: { current: { cancel: () => void } | null } = { current: null }

function configure(options: Record<string, unknown>) {
  const days = Number(options.windowDays)
  const minutes = Number(options.refreshMinutes)
  const language: Language = options.language === 'es' ? 'es' : 'en'
  config.windowDays = days > 0 ? days : 2
  config.refreshMs = minutes > 0 ? minutes * 60000 : 0
  config.model = typeof options.model === 'string' && options.model.trim() !== '' ? options.model.trim() : 'haiku'
  config.texts = TEXTS[language]
  config.groupByColor = options.groupByColor !== false
}

function instructions(): string {
  return `You summarize where each of the user's Claude Code sessions was left.
For each session you get its title, the user's last message and the assistant's last reply.
Write one neutral sentence in ${config.texts.summaryLanguage} (at most 110 characters) saying
where it stands: what was done last and what was offered or asked, if anything. Do not judge
whether it is finished. Answer only with a JSON object mapping each session id to its sentence.`
}

function helper($: EngineInterface, args: string[]) {
  return $.process.run(['python3', `${$.plugin.root}/hooks/collect.py`, ...args], { timeoutMs: 60000 })
}

// Done marks, color marks and cached summaries outlive the session in $.store.
async function restore($: EngineInterface) {
  const doneMarks = ((await $.store.get('done')) ?? {}) as Record<string, number>
  const stored = ((await $.store.get('marks')) ?? {}) as Record<string, string>
  const colorMarks = Object.fromEntries(Object.entries(stored).filter(([, m]) => MARKS.includes(m as Mark)))
  await update($, done, () => doneMarks)
  await update($, marks, () => colorMarks as Record<string, Mark>)
}

// Entries for sessions no longer listed (archived or deleted) are dropped from the store.
function keepListed<T>(record: Record<string, T>, ids: Set<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([id]) => ids.has(id)))
}

async function prune($: EngineInterface, ids: Set<string>) {
  const doneMarks = keepListed(await read($, done), ids)
  const colorMarks = keepListed(await read($, marks), ids)
  await $.store.set('done', doneMarks)
  await $.store.set('marks', colorMarks)
  await update($, done, () => doneMarks)
  await update($, marks, () => colorMarks)
}

async function summarize($: EngineInterface, list: Raw[], ids: Set<string>): Promise<Summaries> {
  const cache = keepListed(((await $.store.get('summaries')) ?? {}) as Summaries, ids)
  const missing = list.filter(s => cache[s.id]?.at !== s.lastActivityAt && !s.recap)
  for (const s of list) {
    if (s.recap && cache[s.id]?.at !== s.lastActivityAt) cache[s.id] = { at: s.lastActivityAt, text: s.recap }
  }
  if (missing.length > 0) {
    const prompt = missing.map(s => `### ${s.id}\nTitle: ${s.title}\nUser: ${s.user}\nAssistant: ${s.reply}\n`).join('\n')
    const r = await $.model.complete({ model: config.model, system: instructions(), prompt, maxTokens: 4000 })
    if (!r.isAnswered) throw new Error(`model: ${r.reason}`)
    const answer: Record<string, string> = JSON.parse(r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1))
    for (const s of missing) cache[s.id] = { at: s.lastActivityAt, text: answer[s.id] ?? '' }
  }
  await $.store.set('summaries', cache)
  return cache
}

// The sidebar groups sessions by project folder; a session the app started without a
// folder runs in a scratch workspace, which names no project.
function projectOf(folder: string): string {
  return folder.startsWith('scratch-') ? '' : folder
}

function toSession(s: Raw, summaries: Summaries): DeskSession {
  return {
    id: s.id,
    title: s.title,
    lastActivityAt: s.lastActivityAt,
    section: s.section,
    project: projectOf(s.folder),
    pinned: s.pinned,
    summary: summaries[s.id]?.text ?? '',
  }
}

async function load($: EngineInterface) {
  if (await read($, isLoading)) return
  await update($, isLoading, () => true)
  try {
    const ran = await helper($, ['list', String(config.windowDays)])
    if (ran.exitCode !== 0) throw new Error(ran.stderr.slice(-400) || 'collect.py failed')
    const data: { recent: Raw[]; older: Raw[] } = JSON.parse(ran.stdout)
    const ids = new Set([...data.recent, ...data.older].map(s => s.id))
    const summaries = await summarize($, data.recent, ids)
    // An empty listing more likely means the records could not be read than no sessions.
    if (ids.size > 0) await prune($, ids)
    await update($, recent, () => data.recent.map(s => toSession(s, summaries)))
    await update($, older, () => data.older.map(s => toSession(s, {})))
    await update($, error, () => '')
    await update($, loadedAt, () => Date.now())
  } catch (err) {
    await update($, error, () => String(err).slice(0, 400))
  } finally {
    await update($, isLoading, () => false)
  }
}

async function openPane($: EngineInterface) {
  await restore($)
  await $.ui.open({ id: PANE, title: config.texts.title })
  timer.current?.cancel()
  timer.current = config.refreshMs > 0 ? $.clock.every(config.refreshMs, () => void load($)) : null
  void load($)
}

async function openSession($: EngineInterface, id: string) {
  const ran = await helper($, ['open', `claude://claude.ai/epitaxy/${id}`])
  if (ran.exitCode !== 0) await update($, error, () => ran.stderr.slice(-400) || 'could not open the session')
}

async function markDone($: EngineInterface, id: string, isDone: boolean) {
  const all = [...(await read($, recent)), ...(await read($, older))]
  const at = all.find(s => s.id === id)?.lastActivityAt ?? Date.now()
  const next = { ...(await read($, done)) }
  if (isDone) next[id] = at
  else delete next[id]
  await $.store.set('done', next)
  await update($, done, () => next)
}

async function setMark($: EngineInterface, id: string, mark: Mark | null) {
  const next = { ...(await read($, marks)) }
  if (mark) next[id] = mark
  else delete next[id]
  await $.store.set('marks', next)
  await update($, marks, () => next)
  await update($, picking, () => '')
}

async function togglePicker($: EngineInterface, id: string) {
  await update($, picking, current => (current === id ? '' : id))
}

function ago(ms: number): string {
  return config.texts.ago(Math.max(0, Math.round((Date.now() - ms) / 60000)))
}

// A session marked done comes back once it has activity after the mark.
function isHidden(s: DeskSession, doneMarks: Record<string, number>): boolean {
  const at = doneMarks[s.id]
  return at !== undefined && s.lastActivityAt <= at
}

// Newest first; with groupByColor, marked sessions go first in palette order.
function arrange(list: DeskSession[], colorMarks: Record<string, Mark>): DeskSession[] {
  const rank = (s: DeskSession) => {
    const mark = colorMarks[s.id]
    return config.groupByColor && mark ? MARKS.indexOf(mark) : MARKS.length
  }
  return [...list].sort((a, b) => rank(a) - rank(b) || b.lastActivityAt - a.lastActivityAt)
}

export const register: Register = (on, options) => {
  configure(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'session-desk', description: 'Show a reminder of your open sessions in a pane' })
    return next(e)
  })

  on('command.run', { command: 'session-desk' }, async $ => {
    await openPane($)
    return { text: config.texts.opened }
  })

  on('ui.close', { id: PANE }, async (_$, e, next) => {
    timer.current?.cancel()
    timer.current = null
    return next(e)
  })

  on('ui.message', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const data = e.data as DotMessage
    if (data.type === 'picker') await togglePicker($, data.id)
    if (data.type === 'mark') await setMark($, data.id, data.mark)
    if (data.type === 'done') await markDone($, data.id, true)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t = config.texts
    if (e.surface !== 'desktop' && e.surface !== 'terminal') {
      const { Text } = $.ui.resolve(e)
      return <Text>{t.unsupported}</Text>
    }
    const { Box, Text, Button, Client } = $.ui.resolve(e)
    const doneMarks = await read($, done)
    const colorMarks = await read($, marks)
    const picker = await read($, picking)
    const all = await read($, recent)
    const visible = arrange(all.filter(s => !isHidden(s, doneMarks)), colorMarks)
    const hidden = [...all, ...(await read($, older))].filter(s => isHidden(s, doneMarks))
    const old = arrange((await read($, older)).filter(s => !isHidden(s, doneMarks)), colorMarks)
    const loading = await read($, isLoading)
    const when = await read($, loadedAt)
    const err = await read($, error)
    const doneOpen = await read($, showDone)
    const olderOpen = await read($, showOlder)

    // The desktop paints a Button's text in its own style, so the colored dot, the
    // palette and the done check are a Client of the plugin's that takes the click itself.
    const dot = (s: DeskSession, mode: 'dot' | 'palette' | 'done') => (
      <Client
        key={`${mode}-${s.id}`}
        module="./dot.tsx"
        props={{ mode, id: s.id, current: colorMarks[s.id] ?? null, colors: PALETTE }}
      />
    )

    // A marked item takes a light wash of its color over the whole entry.
    const wash = (s: DeskSession) => {
      const color = PALETTE.find(p => p.mark === colorMarks[s.id])?.color
      return color ? `${color}24` : undefined
    }

    const item = (s: DeskSession) => (
      <Box key={`item-${s.id}`} flexDirection="column" backgroundColor={wash(s)} paddingX={1}>
        <Box flexDirection="row" gap={1}>
          {dot(s, 'dot')}
          <Button key={`open-${s.id}`} plain hover={{ underline: true }} onPress={() => void openSession($, s.id)}>
            {s.title}
          </Button>
        </Box>
        {picker === s.id && <Box paddingLeft={2}>{dot(s, 'palette')}</Box>}
        <Box flexDirection="column" paddingLeft={2}>
          {s.summary !== '' && <Text dimColor>{s.summary}</Text>}
          <Box flexDirection="row" gap={1}>
            {dot(s, 'done')}
            {s.section !== '' && <Text color="suggestion">{s.section}</Text>}
            {s.project !== '' && <Text dimColor>{s.project}</Text>}
            {s.pinned && <Text dimColor>{t.pinned}</Text>}
            <Text dimColor>{ago(s.lastActivityAt)}</Text>
          </Box>
        </Box>
      </Box>
    )

    const intro =
      when === 0 ? '' : visible.length === 0 ? t.nothing(config.windowDays) : t.count(visible.length, config.windowDays)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          {loading ? (
            <Client key="spinner" module="./spinner.tsx" props={{ text: t.reading }} />
          ) : (
            <Button key="refresh" onPress={() => void load($)}>
              {t.refresh}
            </Button>
          )}
          {!loading && when !== 0 && <Text dimColor>{t.updated(ago(when))}</Text>}
        </Box>
        {err !== '' && <Text color="error">{err}</Text>}
        {intro !== '' && <Text>{intro}</Text>}
        {visible.map(item)}
        {old.length > 0 && (
          <Box flexDirection="column" gap={1}>
            <Button key="toggle-older" plain dimColor onPress={() => void update($, showOlder, v => !v)}>
              {t.older(olderOpen, old.length)}
            </Button>
            {olderOpen && old.map(item)}
          </Box>
        )}
        {hidden.length > 0 && (
          <Box flexDirection="column">
            <Button key="toggle-done" plain dimColor onPress={() => void update($, showDone, v => !v)}>
              {t.done(doneOpen, hidden.length)}
            </Button>
            {doneOpen &&
              hidden.map(s => (
                <Box key={`hidden-${s.id}`} flexDirection="row" gap={1} paddingLeft={2}>
                  <Text dimColor strikethrough>
                    {s.title}
                  </Text>
                  <Button key={`undo-${s.id}`} plain dimColor onPress={() => void markDone($, s.id, false)}>
                    {t.restore}
                  </Button>
                </Box>
              ))}
          </Box>
        )}
      </Box>
    )
  })
}
