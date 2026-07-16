'use client';
import { CSSProperties, ReactNode } from 'react';
import { T } from './tokens';

// Pill seleccionable: filtros y toggles de categoría. El estado activo se marca
// con el acento — UNO solo, siempre el mismo. Antes cada chip de especialidad
// se activaba con su propio color (azul/naranja/violeta), así que el color del
// filtro no significaba "activo", significaba "Niños".
interface Props {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  style?: CSSProperties;
  disabled?: boolean;
}

export function ToggleChip({ active, onClick, children, style, disabled }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      style={{
        padding: '4px 12px',
        borderRadius: T.radius.pill,
        border: `1px solid ${active ? T.accent.border : T.border.base}`,
        background: active ? T.accent.soft : 'transparent',
        color: active ? T.accent.base : T.text.secondary,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        fontSize: T.fs.caption,
        lineHeight: T.lh.caption,
        fontWeight: active ? T.fw.semibold : T.fw.regular,
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
        transition: 'background 0.12s, border-color 0.12s',
        ...style,
      }}
    >
      {children}
    </button>
  );
}
