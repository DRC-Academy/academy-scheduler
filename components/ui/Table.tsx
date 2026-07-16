'use client';
import { CSSProperties, ReactNode } from 'react';
import { T } from './tokens';

// Primitivas de tabla. Deliberadamente NO es una tabla data-driven: cada pantalla
// compone sus celdas, pero el estilo (paddings, header sticky, bordes, tamaños)
// vive acá una sola vez. Antes este patrón estaba copiado a mano 4 veces.
//
// Patrón responsive de la app: la tabla va en .desk-only y las cards mobile en
// .mob-only. `TableWrap` ya trae el .desk-only.

export function TableWrap({ maxHeight = 500, children, style }: {
  maxHeight?: number | string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div className="desk-only" style={{
      background: T.bg.surface,
      border: `1px solid ${T.border.base}`,
      borderRadius: T.radius.md,
      overflow: 'hidden',
      ...style,
    }}>
      <div style={{ overflowX: 'auto', maxHeight, overflowY: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>{children}</table>
      </div>
    </div>
  );
}

export function THead({ columns }: { columns: ReactNode[] }) {
  return (
    <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
      <tr style={{ borderBottom: `1px solid ${T.border.base}`, background: T.bg.surface }}>
        {columns.map((c, i) => (
          <th key={i} style={{
            padding: `${T.space(2)} ${T.space(3)}`,
            textAlign: 'left',
            fontSize: T.fs.micro, lineHeight: T.lh.micro,
            fontWeight: T.fw.medium,
            color: T.text.muted,
            whiteSpace: 'nowrap',
          }}>
            {c}
          </th>
        ))}
      </tr>
    </thead>
  );
}

export function TR({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <tr style={{ borderBottom: `1px solid ${T.border.base}`, ...style }}>{children}</tr>;
}

export function TD({ children, align = 'left', muted = false, strong = false, colSpan, style }: {
  children?: ReactNode;
  align?: 'left' | 'right' | 'center';
  muted?: boolean;
  strong?: boolean;
  colSpan?: number;
  style?: CSSProperties;
}) {
  return (
    <td colSpan={colSpan} style={{
      padding: `${T.space(3)} ${T.space(3)}`,
      textAlign: align,
      fontSize: T.fs.sm, lineHeight: T.lh.sm,
      fontWeight: strong ? T.fw.semibold : T.fw.regular,
      color: muted ? T.text.muted : T.text.primary,
      ...style,
    }}>
      {children}
    </td>
  );
}

// Contenedor de las cards equivalentes en mobile.
export function CardList({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="mob-only" style={{ flexDirection: 'column', gap: T.space(2), ...style }}>
      {children}
    </div>
  );
}
