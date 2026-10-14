import { expect, test } from 'claude-code/testing'

// The footer button opens the viewer; the band only shows its intro after a session starts.

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, width: 80 } as any } as const
const MODES = { component: 'SessionMode', props: { modes: ['focus'] } } as const

test('the band stays empty outside the intro', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ plugin: 'blackbox', surface: 'terminal', ...BAND })
  expect(await ui.find({ key: 'dismiss-intro' })).toBeUndefined()
  await ui.unmount()
})

test('the footer keeps the engine modes and adds blackbox', async $ => {
  const ui = await $.ui.mount({ plugin: 'blackbox', surface: 'desktop', ...MODES })
  expect(await ui.find({ type: 'Text', text: /focus/ })).toBeDefined()
  expect(await ui.find({ key: 'open-viewer' })).toBeDefined()
  await ui.unmount()
})
