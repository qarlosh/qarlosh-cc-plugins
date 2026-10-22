// Every string the pane draws, by the `language` option.
export type Language = 'en' | 'es'

export const TEXTS = {
  en: {
    title: 'Open sessions',
    opened: 'Session pane opened.',
    refresh: 'Refresh',
    reading: 'Going through your sessions…',
    updated: (ago: string) => `Updated ${ago}`,
    nothing: (days: number) => `Nothing open in the last ${days} days.`,
    count: (n: number, days: number) => `You have ${n} open ${n === 1 ? 'session' : 'sessions'} from the last ${days} days.`,
    older: (open: boolean, n: number) => `${open ? '▾' : '▸'} Plus ${n} older open ${n === 1 ? 'session' : 'sessions'}`,
    done: (open: boolean, n: number) => `${open ? '▾' : '▸'} ${n} marked done`,
    restore: '↩ restore',
    pinned: '· pinned',
    unsupported: 'This pane needs Claude Desktop or the terminal.',
    ago: (min: number) => (min < 60 ? `${min} min ago` : min < 1440 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} d ago`),
    summaryLanguage: 'English',
  },
  es: {
    title: 'Sesiones abiertas',
    opened: 'Panel de sesiones abierto.',
    refresh: 'Actualizar',
    reading: 'Repasando tus sesiones…',
    updated: (ago: string) => `Actualizado ${ago}`,
    nothing: (days: number) => `Nada abierto en los últimos ${days} días.`,
    count: (n: number, days: number) =>
      `Tienes ${n} ${n === 1 ? 'sesión abierta' : 'sesiones abiertas'} de los últimos ${days} días.`,
    older: (open: boolean, n: number) =>
      `${open ? '▾' : '▸'} Además tienes ${n} ${n === 1 ? 'sesión abierta más antigua' : 'sesiones abiertas más antiguas'}`,
    done: (open: boolean, n: number) => `${open ? '▾' : '▸'} ${n} ${n === 1 ? 'marcada como hecha' : 'marcadas como hechas'}`,
    restore: '↩ recuperar',
    pinned: '· fijada',
    unsupported: 'Este panel necesita Claude Desktop o la terminal.',
    ago: (min: number) => (min < 60 ? `hace ${min} min` : min < 1440 ? `hace ${Math.round(min / 60)} h` : `hace ${Math.round(min / 1440)} d`),
    summaryLanguage: 'Spanish',
  },
} as const

export type Texts = (typeof TEXTS)[Language]
