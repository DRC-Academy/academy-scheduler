// Puente tipado entre los design tokens (globals.css) y los estilos inline.
// La app no usa Tailwind: los estilos se escriben inline, así que los tokens se
// consumen como var(--x). Este módulo evita tipear los nombres a mano.
//
// Regla: si un valor visual no está acá, no se escribe a mano en un componente.
// Se agrega primero como token en globals.css.

export const T = {
  // Tipografía
  fs: {
    display: 'var(--fs-display)',
    title:   'var(--fs-title)',
    body:    'var(--fs-body)',
    sm:      'var(--fs-sm)',
    caption: 'var(--fs-caption)',
    micro:   'var(--fs-micro)',
  },
  lh: {
    display: 'var(--lh-display)',
    title:   'var(--lh-title)',
    body:    'var(--lh-body)',
    sm:      'var(--lh-sm)',
    caption: 'var(--lh-caption)',
    micro:   'var(--lh-micro)',
  },
  fw: {
    regular:  'var(--fw-regular)',
    medium:   'var(--fw-medium)',
    semibold: 'var(--fw-semibold)',
  },
  // Spacing (base 4)
  space: (n: 1 | 2 | 3 | 4 | 5 | 6 | 7) => `var(--space-${n})`,
  // Radios
  radius: {
    sm:   'var(--radius-sm)',
    md:   'var(--radius-md)',
    lg:   'var(--radius-lg)',
    pill: 'var(--radius-pill)',
  },
  shadow: { overlay: 'var(--shadow-overlay)' },
  // Neutros
  bg: {
    base:     'var(--bg-base)',
    surface:  'var(--bg-surface)',
    surface2: 'var(--bg-surface-2)',
    surface3: 'var(--bg-surface-3)',
  },
  border: { base: 'var(--border)', light: 'var(--border-light)' },
  text: {
    primary:   'var(--text-primary)',
    secondary: 'var(--text-secondary)',
    muted:     'var(--text-muted)',
    onFilled:  '#FFFFFF',
  },
  // Acento y semánticos
  accent: {
    base:   'var(--accent)',
    hover:  'var(--accent-hover)',
    soft:   'var(--accent-soft)',
    border: 'var(--accent-border)',
  },
} as const;

// Tonos semánticos. Son los ÚNICOS colores con significado de la app:
// ok = correcto/enviado/disponible · warn = pendiente/atención · danger = error/atrasado
// neutral = sin significado (categorías, etiquetas, datos)
export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';

export const TONE: Record<Tone, { fg: string; bg: string; border: string }> = {
  neutral: { fg: 'var(--text-secondary)', bg: 'var(--bg-surface-2)', border: 'var(--border)' },
  ok:      { fg: 'var(--ok)',             bg: 'var(--ok-soft)',      border: 'var(--ok-border)' },
  warn:    { fg: 'var(--warn)',           bg: 'var(--warn-soft)',    border: 'var(--warn-border)' },
  danger:  { fg: 'var(--danger)',         bg: 'var(--danger-soft)',  border: 'var(--danger-border)' },
  accent:  { fg: 'var(--accent)',         bg: 'var(--accent-soft)',  border: 'var(--accent-border)' },
};
