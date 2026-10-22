import type { ClientModule, ClientPointerEvent } from 'claude-code'

import type { Mark } from '../types'

// A session's color mark, drawn as plain colored text: the desktop paints a Button's
// text in its own style, so this module takes the click itself.
// `dot` draws the session's mark and asks for the palette; `palette` draws every
// color, two columns each, and a ✕ that clears the mark; `done` is a green check
// that marks the session done.
type Props = {
  mode: 'dot' | 'palette' | 'done'
  id: string
  current: Mark | null
  colors: { mark: Mark; color: string }[]
}
// `latest` is read by the pointer listener, which is set once on the first call.
// The module holds the pointer, which leaves the surface's own hover inert, so
// `hover` is the slot under the pointer (0 for a dot or a check), or -1.
type Local = { latest: Props; hover: number }

const Dot: ClientModule<Props, Local> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (surface.state) surface.state.latest = props
  const hover = surface.state?.hover ?? -1

  if (surface.state === undefined) {
    const local: Local = { latest: props, hover: -1 }
    surface.onPointer((e: ClientPointerEvent) => {
      const p = surface.state?.latest ?? local.latest
      if (e.type === 'enter' || e.type === 'move' || e.type === 'leave') {
        const slot = e.type === 'leave' ? -1 : p.mode === 'palette' ? Math.floor(e.x / 2) : 0
        if (slot !== (surface.state?.hover ?? -1)) surface.setState({ latest: p, hover: slot })
        return
      }
      if (e.type !== 'down' || e.button !== 'left') return
      if (p.mode === 'dot' || p.mode === 'done') {
        surface.post({ type: p.mode === 'dot' ? 'picker' : 'done', id: p.id })
        return
      }
      const slot = Math.floor(e.x / 2)
      const pick = p.colors[slot]
      if (pick) surface.post({ type: 'mark', id: p.id, mark: pick.mark })
      else if (slot === p.colors.length) surface.post({ type: 'mark', id: p.id, mark: null })
    })
    surface.setState(local)
  }

  if (props.mode === 'done') {
    return (
      <Text color={hover === 0 ? '#ffffff' : '#16a34a'} backgroundColor={hover === 0 ? '#22c55e' : '#22c55e2e'} bold>
        {' ✓ '}
      </Text>
    )
  }

  if (props.mode === 'dot') {
    const color = props.colors.find(c => c.mark === props.current)?.color
    if (hover === 0) return <Text color={color ?? '#9ca3af'}>◉</Text>
    return color ? <Text color={color}>●</Text> : <Text dimColor>○</Text>
  }

  return (
    <Box flexDirection="row">
      {props.colors.map((c, i) => (
        <Text color={c.color} bold={hover === i}>{c.mark === props.current || hover === i ? '◉ ' : '● '}</Text>
      ))}
      <Text dimColor={hover !== props.colors.length} bold={hover === props.colors.length}>✕</Text>
    </Box>
  )
}

export default Dot
