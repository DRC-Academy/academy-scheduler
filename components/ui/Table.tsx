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

/**
 * Alto de la barra de navegación fija (.tnav): 10 px de margen + la caja de
 * 50 px. Una cabecera pegada a `top: 0` quedaría escondida debajo de ella.
 */
export const NAV_STICKY_TOP = 'var(--tnav-h, 60px)';

export function TableWrap({
  maxHeight = 'none', fixed = false, stickyHeader = false, className = 'desk-only', children, style,
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
  /**
   * Cabecera fija al hacer scroll de la PÁGINA (acompaña a `<THead sticky
   * top={NAV_STICKY_TOP}>`). Cualquier ancestro con `overflow` distinto de
   * `visible` convierte la cabecera en fija DENTRO de esa caja, que no se mueve,
   * y por eso nunca se quedaba pegada. Con esto:
   *   · el recorte de las esquinas pasa a `overflow: clip`, que recorta igual
   *     pero no crea una caja de scroll;
   *   · desaparece la caja de scroll lateral. Solo tiene sentido con `fixed`
   *     (los anchos los manda el <colgroup> y no hay nada que desplazar).
   */
  stickyHeader?: boolean;
  /** Clase de visibilidad. Se puede sustituir por un breakpoint propio. */
  className?: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const scrolls = maxHeight !== 'none';
  const table = (
    <table style={{
      width: '100%',
      borderCollapse: 'collapse',
      tableLayout: fixed ? 'fixed' : undefined,
    }}>
      {children}
    </table>
  );
  return (
    <div className={className} style={{
      background: T.bg.surface,
      border: `1px solid ${T.border.base}`,
      borderRadius: T.radius.md,
      overflow: stickyHeader ? 'clip' : 'hidden',
      ...style,
    }}>
      {stickyHeader ? table : (
        <div style={scrolls ? { overflowX: 'auto', maxHeight, overflowY: 'auto' } : { overflowX: 'auto' }}>
          {table}
        </div>
      )}
    </div>
  );
}

export function THead({ columns, sticky = true, top = 0, align }: {
  columns: ReactNode[];
  /**
   * Cabecera fija. Con scroll interno (`maxHeight`) se pega arriba de la card;
   * con scroll de la página hace falta `TableWrap stickyHeader` y
   * `top={NAV_STICKY_TOP}`.
   */
  sticky?: boolean;
  /** Distancia al borde superior donde se pega. */
  top?: number | string;
  /** Alineación por columna. Debe acompañar a la de las celdas (ej. acciones a la derecha). */
  align?: Array<'left' | 'right' | 'center' | undefined>;
}) {
  return (
    <thead style={sticky ? { position: 'sticky', top, zIndex: 2 } : undefined}>
      <tr style={{ borderBottom: `1px solid ${T.border.base}`, background: T.bg.surface }}>
        {columns.map((c, i) => (
          <th key={i} style={{
            // Con `border-collapse` el borde de la fila no viaja con la cabecera
            // fija: la línea inferior va como sombra de cada celda.
            background: T.bg.surface,
            boxShadow: sticky ? `inset 0 -1px 0 ${T.border.base}` : undefined,
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
