'use client';
// ── El embudo de clases del mes ──────────────────────────────────────────────
//
// Reemplaza a las cuatro tarjetas sueltas que contaba cada una por su cuenta.
// Acá cada clase está en EXACTAMENTE una rama y el total es la suma de las
// ramas; si alguna vez no suma, se dice en pantalla en vez de dejar que el
// número mienta (ver `funnelIsConsistent`).
//
// Lo usan el profesor (su propio mes) y el admin (el de cada profesor), con el
// mismo componente para que no puedan divergir. La única diferencia es
// `showActions`: al profesor se le ofrece reclamar; al admin, no.

import Link from 'next/link';
import { funnelIsConsistent, type ClassFunnel, type FunnelBranch } from '@/lib/classFunnel';

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function mesLabel(my: string): string {
  const [y, m] = my.split('-').map(Number);
  return `${MESES[(m ?? 1) - 1]} ${y}`;
}

const COLOR: Record<string, string> = {
  con_ingreso:      '#1f7a3d',
  sin_ingreso:      '#9a6516',
  fuera_calendario: '#3b5b9e',
};

function Rama({ b, depth, claimAmount, showActions, onPick }: {
  b: FunnelBranch;
  depth: number;
  claimAmount?: number;
  showActions: boolean;
  onPick?: (key: string) => void;
}) {
  const esHijo = depth > 0;
  const clicable = !!onPick;
  const reclamable = b.key === 'reclamables';

  return (
    <>
      <div
        onClick={clicable ? () => onPick!(b.key) : undefined}
        role={clicable ? 'button' : undefined}
        tabIndex={clicable ? 0 : undefined}
        onKeyDown={clicable ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick!(b.key); } } : undefined}
        style={{
          display: 'flex', alignItems: 'baseline', gap: 10,
          padding: esHijo ? '7px 14px 7px 34px' : '11px 14px',
          borderTop: '1px solid var(--border, #eceee9)',
          cursor: clicable ? 'pointer' : 'default',
          background: esHijo ? 'transparent' : 'rgba(0,0,0,0.015)',
        }}
      >
        <span style={{
          flex: 1, minWidth: 0,
          fontSize: esHijo ? 13 : 13.5,
          fontWeight: esHijo ? 500 : 700,
          color: esHijo ? 'var(--text-secondary, #5f6360)' : (COLOR[b.key] ?? 'var(--text-primary, #1a1c1a)'),
        }}>
          {b.label}
          {b.hint && (
            <span style={{ display: 'block', fontSize: 11.5, fontWeight: 400, color: 'var(--text-muted, #8b8e88)', marginTop: 2, lineHeight: 1.45 }}>
              {b.hint}
            </span>
          )}
        </span>

        {/* El importe de "Reclamables" es lo que el profesor deja de cobrar si no
            lo pide: va al lado del número, no escondido en un tooltip. */}
        {reclamable && claimAmount != null && claimAmount > 0 && (
          <span style={{ fontSize: 12.5, fontWeight: 700, color: '#9a6516', whiteSpace: 'nowrap' }}>
            €{claimAmount.toFixed(2)}
          </span>
        )}
        {b.amount != null && b.amount > 0 && (
          <span style={{ fontSize: 12.5, color: 'var(--text-muted, #8b8e88)', whiteSpace: 'nowrap' }}>
            €{b.amount.toFixed(2)}
          </span>
        )}
        <span style={{
          fontSize: esHijo ? 14 : 16, fontWeight: 700, minWidth: 34, textAlign: 'right',
          color: esHijo ? 'var(--text-primary, #1a1c1a)' : (COLOR[b.key] ?? 'var(--text-primary, #1a1c1a)'),
        }}>
          {b.count}
        </span>
      </div>

      {reclamable && showActions && b.count > 0 && (
        <div style={{ padding: '0 14px 10px 34px' }}>
          <Link href="/revisiones" style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 8,
            background: '#1E9E3A', color: '#fff', fontSize: 12.5, fontWeight: 700, textDecoration: 'none',
          }}>
            Reclamar {b.count} {b.count === 1 ? 'clase' : 'clases'} en Revisiones →
          </Link>
        </div>
      )}

      {(b.children ?? []).map(c => (
        <Rama key={c.key} b={c} depth={depth + 1} claimAmount={claimAmount} showActions={showActions} onPick={onPick} />
      ))}
    </>
  );
}

export function ClassFunnelCard({ funnel, claimAmount, showActions = false, onPick, intro }: {
  funnel: ClassFunnel;
  /** Importe estimado de las clases reclamables. */
  claimAmount?: number;
  /** true en la vista del profesor: se le ofrece reclamar. */
  showActions?: boolean;
  onPick?: (key: string) => void;
  intro?: React.ReactNode;
}) {
  const cuadra = funnelIsConsistent(funnel);

  // En la vista del profesor, "sin transcript ni registro" no lleva desglose ni
  // acción: no puede hacer nada con esas clases y ofrecerle algo sería mandarlo a
  // un callejón. Se deja el número, que sí le sirve para entender el total.
  const branches = funnel.branches.map(b => b.key !== 'sin_ingreso' ? b : {
    ...b,
    children: (b.children ?? []).map(c =>
      c.key === 'sin_rastro' && showActions ? { ...c, hint: undefined } : c),
  });

  return (
    <div style={{ background: 'var(--bg-surface, #fff)', border: '1px solid var(--border, #e4e5e1)', borderRadius: 14, overflow: 'hidden', marginBottom: 16 }}>
      <div style={{ padding: '14px 16px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-secondary, #5f6360)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
            Clases de {mesLabel(funnel.monthYear)}
          </span>
          <span style={{ fontSize: 26, fontWeight: 700, color: 'var(--text-primary, #1a1c1a)', lineHeight: 1 }}>
            {funnel.total}
          </span>
        </div>
        {intro && (
          <p style={{ fontSize: 12.5, color: 'var(--text-secondary, #5f6360)', lineHeight: 1.6, margin: '10px 0 0' }}>
            {intro}
          </p>
        )}
      </div>

      {branches.map(b => (
        <Rama key={b.key} b={b} depth={0} claimAmount={claimAmount} showActions={showActions} onPick={onPick} />
      ))}

      {/* Un total que no es la suma de sus partes es un bug, y prefiero verlo a
          que pase inadvertido. No debería aparecer nunca. */}
      {!cuadra && (
        <div style={{ padding: '10px 14px', background: 'rgba(239,68,68,0.08)', color: '#b42318', fontSize: 12.5, fontWeight: 600, borderTop: '1px solid rgba(239,68,68,0.3)' }}>
          Las ramas no suman el total. Es un error de cálculo: avisá al equipo antes de usar estos números.
        </div>
      )}
    </div>
  );
}

export default ClassFunnelCard;
