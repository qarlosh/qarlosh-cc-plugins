import { expect, test } from 'claude-code/testing'

// The collector must observe only: what reaches the engine, and what comes back
// from it, is exactly what would without the plugin.

test('a tool call reaches the engine untouched and its result comes back unchanged', async ($, on) => {
  let seen: unknown
  on('tool.call', (_$, e) => {
    seen = e
    return { result: { stdout: 'hi', stderr: '', interrupted: false }, text: 'hi' } as any
  })
  const call = { tool: 'Bash', command: 'echo hi', description: 'Say hi' }
  const r: any = await ($.tool.call as any)(call)
  expect(seen).toMatchObject(call)
  expect(r.text).toBe('hi')
  expect(r.isError).toBeUndefined()
  expect(r.deny).toBeUndefined()
})

test('a prompt reaches the engine with the same text', async ($, on) => {
  let seen: unknown
  on('prompt.submit', (_$, e) => {
    seen = e.text
    return { text: e.text }
  })
  await $.prompt.submit({ text: 'hello there' } as any)
  expect(seen).toBe('hello there')
})
