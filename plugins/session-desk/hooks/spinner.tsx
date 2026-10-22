import type { ClientModule } from 'claude-code'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const Spinner: ClientModule<{ text: string }, number> = (props, surface) => {
  const { Text } = surface.elements
  if (surface.state === undefined) {
    surface.every(100, () => surface.setState(((surface.state ?? 0) + 1) % FRAMES.length))
    surface.setState(0)
  }
  return <Text color="claude">{`${FRAMES[surface.state ?? 0]} ${props.text}`}</Text>
}

export default Spinner
