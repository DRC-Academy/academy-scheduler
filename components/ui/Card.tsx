'use client';
import { CSSProperties, ReactNode } from 'react';
import { T } from './tokens';

// Contenedor estándar. UN solo estilo: borde + fondo, sin sombra.
// Las sombras se reservan para lo que flota (modales, dropdowns).
interface Props {
  /** none: la card solo aporta el marco; el contenido maneja su padding (tablas). */
  padding?: 'none' | 'sm' | 'md' | 'lg';
  children: ReactNode;
  style?: CSSProperties;
  className?: string;
}

const PAD: Record<NonNullable<Props['padding']>, string | undefined> = {
  none: undefined,
  sm:   'var(--space-3)',
  md:   'var(--space-4)',
  lg:   'var(--space-5)',
};

export function Card({ padding = 'md', children, style, className }: Props) {
  return (
    <div
      className={className}
      style={{
        background: T.bg.surface,
        border: `1px solid ${T.border.base}`,
        borderRadius: T.radius.md,
        padding: PAD[padding],
        ...style,
      }}
    >
      {children}
    </div>
  );
}
