'use client';
import { CSSProperties, ReactNode } from 'react';
import { T, TONE, Tone } from './tokens';

// Pill de estado. El tono es SEMÁNTICO: usar `neutral` para categorías y
// etiquetas (especialidad, rol, nivel) — esas no comunican estado y no llevan
// color propio. Reemplaza el patrón `padding: 3px 9px; borderRadius: 20` que
// estaba copiado a mano por toda la app.
interface Props {
  tone?: Tone;
  /** Ícono lucide a la izquierda. */
  icon?: React.ComponentType<{ size?: number | string; strokeWidth?: number }>;
  /** Punto de color a la izquierda, para leerse sin depender del color del texto. */
  dot?: boolean;
  children: ReactNode;
  style?: CSSProperties;
  title?: string;
}

export function Badge({ tone = 'neutral', icon: Icon, dot = false, children, style, title }: Props) {
  const c = TONE[tone];
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: T.space(1),
        padding: '2px 8px',
        borderRadius: T.radius.pill,
        background: c.bg,
        border: `1px solid ${c.border}`,
        color: c.fg,
        fontSize: T.fs.micro,
        lineHeight: T.lh.micro,
        fontWeight: T.fw.medium,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {dot && <Dot tone={tone} />}
      {Icon && <Icon size={12} strokeWidth={2.25} />}
      {children}
    </span>
  );
}

// Punto de color. Es la forma correcta de una leyenda de color — un emoji nunca
// lo fue, y además mentía: la leyenda del calendario decía 🔵 azul para Ocupado
// mientras la grilla lo pintaba rojo.
export function Dot({ tone = 'neutral', outline = false, size = 8 }: {
  tone?: Tone;
  /** Solo borde, sin relleno. Para categorías "vacías" (ej: No work). */
  outline?: boolean;
  size?: number;
}) {
  const c = TONE[tone];
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block', flexShrink: 0,
        width: size, height: size,
        borderRadius: '50%',
        background: outline ? 'transparent' : c.fg,
        border: outline ? `1.5px solid ${T.border.light}` : 'none',
      }}
    />
  );
}
