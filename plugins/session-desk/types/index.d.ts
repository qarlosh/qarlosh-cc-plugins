// A color mark the person puts on a session, by its key in the plugin's palette.
export type Mark = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple'

export type DeskSession = {
  id: string
  title: string
  lastActivityAt: number
  section: string
  project: string
  pinned: boolean
  summary: string
}

// What a dot or palette Client posts to the hooks module.
export type DotMessage =
  | { type: 'picker'; id: string }
  | { type: 'mark'; id: string; mark: Mark | null }
  | { type: 'done'; id: string }

declare module 'claude-code' {
  interface PluginState {
    'session-desk': {
      recent: DeskSession[]
      older: DeskSession[]
      done: Record<string, number>
      marks: Record<string, Mark>
      picking: string
      isLoading: boolean
      showDone: boolean
      showOlder: boolean
      loadedAt: number
      error: string
    }
  }
}
