import { expect, mock, test } from 'claude-code/testing'

// collect.py is answered here, beneath the plugin: one recent session with a wrap-up
// recap (so no model call) and one older session.
const NOW = Date.now()
const LISTING = {
  recent: [
    {
      id: 'local_a',
      title: 'Alpha',
      lastActivityAt: NOW - 60000,
      section: 'Work',
      folder: 'alpha',
      pinned: true,
      user: 'hi',
      reply: 'ok',
      recap: 'Alpha waits for a review',
    },
  ],
  older: [{ id: 'local_b', title: 'Beta', lastActivityAt: NOW - 9 * 86400000, section: '', folder: 'beta', pinned: false }],
  archived: [] as string[],
}

const PANE = { plugin: 'session-desk', surface: 'desktop', component: 'Pane', requestId: 'session-desk' } as const
const COMMAND = { command: 'session-desk', args: '' } as any

// Beneath the plugin: an in-memory store and clock, the helper's answer, and the
// engine's side of opening a pane and running a command.
async function openPane($: any, on: any, calls: string[][] = []) {
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('process.run', async (_$: any, e: any) => {
    calls.push([...e.argv])
    return { value: { exitCode: 0, stdout: JSON.stringify(LISTING), stderr: '' } }
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('command.run', async () => ({ text: '' }))
  await $.command.run(COMMAND)
  return $.ui.mount({ ...PANE, props: {} })
}

test('the pane lists a recent session with its summary, section, project and pin', async ($, on) => {
  const ui = await openPane($, on)
  expect(await ui.find({ text: 'Alpha waits for a review' })).toBeDefined()
  expect(await ui.find({ text: 'Work' })).toBeDefined()
  expect(await ui.find({ text: 'alpha' })).toBeDefined()
  expect(await ui.find({ text: /pinned/ })).toBeDefined()
  expect(await ui.find({ key: 'toggle-older' })).toBeDefined()
  await ui.unmount()
})

test('a session marked done leaves the list and comes back when restored', async ($, on) => {
  const ui = await openPane($, on)
  await ui.post({ type: 'done', id: 'local_a' }, { in: 'done-local_a' })
  expect(await ui.find({ text: 'Alpha waits for a review' })).toBeUndefined()

  // Opening the pane again reads the mark back from the store.
  await $.command.run(COMMAND)
  await ui.redraw()
  expect(await ui.find({ text: 'Alpha waits for a review' })).toBeUndefined()

  await ui.press({ key: 'toggle-done' })
  await ui.press({ key: 'undo-local_a' })
  expect(await ui.find({ text: 'Alpha waits for a review' })).toBeDefined()
  await ui.unmount()
})

test('a color mark washes the item and survives reopening the pane', async ($, on) => {
  const ui = await openPane($, on)
  await ui.post({ type: 'mark', id: 'local_a', mark: 'red' }, { in: 'dot-local_a' })
  expect((await ui.find({ key: 'item-local_a' }))?.props.backgroundColor).toBe('#ef444424')

  await $.command.run(COMMAND)
  await ui.redraw()
  expect((await ui.find({ key: 'item-local_a' }))?.props.backgroundColor).toBe('#ef444424')

  await ui.post({ type: 'mark', id: 'local_a', mark: null }, { in: 'dot-local_a' })
  expect((await ui.find({ key: 'item-local_a' }))?.props.backgroundColor).toBeUndefined()
  await ui.unmount()
})

test('picking a period lists that range and is remembered', async ($, on) => {
  const calls: string[][] = []
  const ui = await openPane($, on, calls)
  const range = () => calls.filter(c => c.includes('list')).at(-1)!.slice(-2).map(Number)

  const [since48] = range()
  expect(Date.now() - since48!).toBeGreaterThan(47 * 3600000)

  await ui.select({ key: 'period', value: '2d-10d' })
  const [since, until] = range()
  expect(Date.now() - since!).toBeGreaterThan(9.9 * 86400000)
  expect(Date.now() - until!).toBeGreaterThan(47.9 * 3600000)

  // Reopening keeps the period picked in the pane.
  await $.command.run(COMMAND)
  expect((await ui.find({ key: 'period' }))?.props.value).toBe('2d-10d')
  await ui.unmount()
})

test('an archived session leaves the pane but keeps its mark', async ($, on) => {
  const ui = await openPane($, on)
  await ui.post({ type: 'mark', id: 'local_a', mark: 'blue' }, { in: 'dot-local_a' })

  const [alpha] = LISTING.recent
  LISTING.recent = []
  LISTING.archived = ['local_a']
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ key: 'item-local_a' })).toBeUndefined()

  LISTING.recent = [alpha!]
  LISTING.archived = []
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ key: 'item-local_a' }))?.props.backgroundColor).toBe('#3b82f624')
  await ui.unmount()
})

test('done sessions follow the period; those outside it are listed with the outside ones', async ($, on) => {
  const ui = await openPane($, on)
  await ui.press({ key: 'toggle-older' })
  await ui.post({ type: 'done', id: 'local_b' }, { in: 'done-local_b' })
  expect(await ui.find({ key: 'toggle-done' })).toBeUndefined()
  expect(await ui.find({ key: 'undo-local_b' })).toBeDefined()
  await ui.unmount()
})
