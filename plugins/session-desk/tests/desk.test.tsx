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
}

const PANE = { plugin: 'session-desk', surface: 'desktop', component: 'Pane', requestId: 'session-desk' } as const
const COMMAND = { command: 'session-desk', args: '' } as any

// Beneath the plugin: an in-memory store and clock, the helper's answer, and the
// engine's side of opening a pane and running a command.
async function openPane($: any, on: any) {
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('process.run', async () => ({ value: { exitCode: 0, stdout: JSON.stringify(LISTING), stderr: '' } }))
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
