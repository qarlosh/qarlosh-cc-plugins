import { expect, test } from 'claude-code/testing'

// The footer button opens the viewer; in the terminal it is a mode label.

const MODES = { component: 'SessionMode', props: { modes: ['focus'] } } as const

test('the footer keeps the engine modes and adds blackbox', async $ => {
  const ui = await $.ui.mount({ plugin: 'blackbox', surface: 'desktop', ...MODES })
  expect(await ui.find({ type: 'Text', text: /focus/ })).toBeDefined()
  expect(await ui.find({ key: 'open-viewer' })).toBeDefined()
  await ui.unmount()
})
