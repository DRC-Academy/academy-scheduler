'use client';
import { CSSProperties, ReactNode } from 'react';
import { T } from './tokens';

// Primitivas de tabla. Deliberadamente NO es una tabla data-driven: cada pantalla
// compone sus celdas, pero el estilo (paddings, header sticky, bordes, tamaños)
// vive acá una sola vez. Antes este patrón estaba copiado a mano 4 veces.
//
// Patrón responsive de la app: la tabla va en .desk-only y las cards mobile en
// .mob-only, que es lo que traen `TableWrap` y `CardList` por defecto. Una
// pantalla con más columnas de lo normal puede sustituir esa clase (prop
// `className`) por un breakpoint propio sin mover el global de 768px — lo hace
// la tabla de profesores del admin, que cambia a cards a 1024px.
//
// Los DOS defaults que importan: sin scroll interno (`maxHeight: 'none'`) y sin
// scroll lateral (`fixed` + un <colgroup>). Cuando esto tenía `maxHeight: 500`
// y una <table> de anchos automáticos, la card escondía filas y desbordaba a lo
// ancho a la vez.

export function TableWrap({
  maxHeight = 'none', fixed = false, className = 'desk-only', children, style,
}: {
  /**
   * Alto máximo del cuerpo. Por defecto 'none': scrollea la PÁGINA, no la card.
   * Una card con scroll propio esconde filas sin decirlo y obliga a rodar dos
   * ruedas distintas; solo se pone un tope cuando la tabla es un anexo dentro
   * de otra pantalla, nunca cuando es el contenido principal.
   */
  maxHeight?: number | string;
  /**
   * `table-layout: fixed`: los anchos los mandan las columnas (un `<colgroup>`),
   * no el contenido. Es lo que evita el scroll horizontal — con el algoritmo
   * automático `width: 100%` es un mínimo, no un máximo, y una celda larga
   * desborda la card.
   */
  fixed?: boolean;
  /** Clase de visibilidad. Se puede sustituir por un breakpoint propio. */
  className?: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const scrolls = maxHeight !== 'none';
  return (
    <div className={className} style={{
      background: T.bg.surface,
      border: `1px solid ${T.border.base}`,
      borderRadius: T.radius.md,
      overflow: 'hidden',
      ...style,
    }}>
      <div style={scrolls ? { overflowX: 'auto', maxHeight, overflowY: 'auto' } : { overflowX: 'auto' }}>
        <table style={{
          width: '100%',
          borderCollapse: 'collapse',
          tableLayout: fixed ? 'fixed' : undefined,
        }}>
          {children}
        </table>
      </div>
    </div>
  );
}

export function THead({ columns, sticky = true, align }: {
  columns: ReactNode[];
  /** Solo tiene sentido si el cuerpo scrollea (`maxHeight`). Sin scroll interno, estorba. */
  sticky?: boolean;
  /** Alineación por columna. Debe acompañar a la de las celdas (ej. acciones a la derecha). */
  align?: Array<'left' | 'right' | 'center' | undefined>;
}) {
  return (
    <thead style={sticky ? { position: 'sticky', top: 0, zIndex: 1 } : undefined}>
      <tr style={{ borderBottom: `1px solid ${T.border.base}`, background: T.bg.surface }}>
        {columns.map((c, i) => (
          <th key={i} style={{
            padding: `${T.space(2)} ${T.space(3)}`,
            textAlign: align?.[i] ?? 'left',
            fontSize: T.fs.micro, lineHeight: T.lh.micro,
            fontWeight: T.fw.medium,
            color: T.text.muted,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
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
export function CardList({ className = 'mob-only', children, style }: {
  /** Clase de visibilidad. Se puede sustituir por un breakpoint propio. */
  className?: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div className={className} style={{ flexDirection: 'column', gap: T.space(2), ...style }}>
      {children}
    </div>
  );
}
