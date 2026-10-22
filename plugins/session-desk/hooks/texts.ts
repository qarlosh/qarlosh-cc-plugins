import type { Period } from '../types'

// Every string the pane draws, by the `language` option.
export type Language = 'en' | 'es'

export const TEXTS = {
  en: {
    title: 'Open sessions',
    opened: 'Session pane opened.',
    refresh: 'Refresh',
    reading: 'Going through your sessions…',
    updated: (ago: string) => `Updated ${ago}`,
    periods: { '48h': 'Last 48 hours', '2d-10d': '48 hours to 10 days ago', week: 'This week', '30d': 'Last 30 days' } as Record<Period, string>,
    nothing: 'Nothing open in this period.',
    count: (n: number) => `You have ${n} open ${n === 1 ? 'session' : 'sessions'} in this period.`,
    older: (open: boolean, n: number) => `${open ? '▾' : '▸'} Plus ${n} open ${n === 1 ? 'session' : 'sessions'} outside this period`,
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
    periods: { '48h': 'Últimas 48 horas', '2d-10d': 'Entre 48 horas y 10 días', week: 'Semana actual', '30d': 'Últimos 30 días' } as Record<Period, string>,
    nothing: 'Nada abierto en este periodo.',
    count: (n: number) => `Tienes ${n} ${n === 1 ? 'sesión abierta' : 'sesiones abiertas'} en este periodo.`,
    older: (open: boolean, n: number) =>
      `${open ? '▾' : '▸'} Además tienes ${n} ${n === 1 ? 'sesión abierta' : 'sesiones abiertas'} fuera de este periodo`,
    done: (open: boolean, n: number) => `${open ? '▾' : '▸'} ${n} ${n === 1 ? 'marcada como hecha' : 'marcadas como hechas'}`,
    restore: '↩ recuperar',
    pinned: '· fijada',
    unsupported: 'Este panel necesita Claude Desktop o la terminal.',
    ago: (min: number) => (min < 60 ? `hace ${min} min` : min < 1440 ? `hace ${Math.round(min / 60)} h` : `hace ${Math.round(min / 1440)} d`),
    summaryLanguage: 'Spanish',
  },
} as const

export type Texts = (typeof TEXTS)[Language]
