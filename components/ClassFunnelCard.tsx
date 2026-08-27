'use client';
// ── El embudo de clases del mes ──────────────────────────────────────────────
//
// Reemplaza a las cuatro tarjetas sueltas que contaba cada una por su cuenta.
// Acá cada clase está en EXACTAMENTE una rama y el total es la suma de las
// ramas; la barra de tres segmentos es la prueba visual de que cuadra, y si
// alguna vez no cuadrara se dice en pantalla en vez de dejar que el número
// mienta (ver `funnelIsConsistent`).
//
// Lo usan el profesor (su propio mes) y el admin (el de cada profesor), con el
// MISMO componente para que no puedan divergir. La única diferencia es
// `showActions`: al profesor se le ofrece reclamar y subir transcripts; al
// admin no, porque no es él quien lo hace.
//
// La jerarquía visual responde a la pregunta 2 de la pantalla ("¿hay algo que
// dependa de mí?"): Reclamables es lo más accionable (fondo ámbar + botón
// sólido), Pendientes de cobro va un escalón por debajo (botón fantasma), y las
// ramas en cero quedan presentes pero apagadas. El rojo NO se usa para
// pendientes: está reservado a penalizaciones y saldos negativos.

import Link from 'next/link';
import { funnelIsConsistent, type ClassFunnel, type FunnelBranch } from '@/lib/classFunnel';

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function mesLabel(my: string): string {
  const [y, m] = my.split('-').map(Number);
  return `${MESES[(m ?? 1) - 1]} ${y}`;
}
const eur = (n: number) => `€${n.toFixed(2).replace('.', ',')}`;

/** Clase del riel de color de cada rama de primer nivel. */
const RAIL: Record<string, string> = {
  con_ingreso: 'is-con',
  sin_ingreso: 'is-sin',
  fuera_calendario: 'is-fuera',
};

/** Por qué está pendiente, en una frase. Solo si el desglose vino en los datos. */
function pendingTitle(b: FunnelBranch): string | undefined {
  const s = b.pendingSplit;
  if (!s || (s.transcript === 0 && s.limite === 0)) return b.hint;
  const partes: string[] = [];
  if (s.transcript > 0) partes.push(`${s.transcript} esperan que subas el transcript`);
  if (s.limite > 0) partes.push(`${s.limite} están retenidas por el límite del plan del alumno (lo resuelve el equipo)`);
  return `De estas ${b.count}: ${partes.join(' · ')}.`;
}

export function ClassFunnelCard({ funnel, claimAmount, showActions = false, onPick, intro }: {
  funnel: ClassFunnel;
  /** Importe estimado de las clases reclamables. */
  claimAmount?: number;
  /** true en la vista del profesor: se le ofrece actuar. */
  showActions?: boolean;
  /** Llevar al detalle. Recibe la clave de la rama pulsada. */
  onPick?: (key: string) => void;
  intro?: React.ReactNode;
}) {
  const cuadra = funnelIsConsistent(funnel);
  const suma = funnel.branches.reduce((s, b) => s + b.count, 0);
  const pick = (key: string) => onPick ? () => onPick(key) : undefined;

  /** Una línea hija normal (no accionable). */
  function Child({ c }: { c: FunnelBranch }) {
    const zero = c.count === 0;
    const warn = c.key === 'pendientes' || c.key === 'fuera_pendientes';
    return (
      <button
        type="button"
        className={`fnl-child${zero ? ' is-zero' : ''}`}
        onClick={zero ? undefined : pick(c.key)}
        disabled={zero || !onPick}
        title={warn ? pendingTitle(c) : c.hint}
      >
        <span className="fnl-child-name">{c.label}</span>
        {c.amount != null && (
          <span className={`fnl-child-eur${zero ? ' is-zero' : warn ? ' is-warn' : ''}`}>{eur(c.amount)}</span>
        )}
        <span className="fnl-child-n">{c.count}</span>
      </button>
    );
  }

  return (
    <div className="fnl">
      <div className="fnl-head">
        <div className="fnl-head-row">
          <span className="fnl-eyebrow">Clases de {mesLabel(funnel.monthYear)}</span>
          <span className="fnl-total">{funnel.total}</span>
        </div>

        {/* Los segmentos SON las ramas: juntos llenan el ancho, y debajo va la
            suma escrita. Es la forma discreta de mostrar que cuadra. */}
        <div className="fnl-bar" aria-hidden>
          {funnel.branches.filter(b => b.count > 0).map(b => (
            <div key={b.key} className={`fnl-seg ${RAIL[b.key] ?? ''}`} style={{ flexGrow: b.count }} />
          ))}
        </div>
        <div className={`fnl-check${cuadra ? '' : ' is-broken'}`}>
          {cuadra ? (
            <>
              <span className="fnl-check-ok">✓</span>
              <span>
                {funnel.branches.map(b => b.count).join(' + ')} = {funnel.total} · cada clase está en un solo lugar
              </span>
            </>
          ) : (
            <span>Las ramas suman {suma} y el total dice {funnel.total}.</span>
          )}
        </div>

        {intro && <p className="fnl-act-sub" style={{ marginTop: 'var(--space-3)' }}>{intro}</p>}
      </div>

      {funnel.branches.map(b => {
        const zero = b.count === 0;
        return (
          <div key={b.key}>
            <button
              type="button"
              className={`fnl-branch ${zero ? 'is-zero' : (RAIL[b.key] ?? '')}`}
              onClick={zero ? undefined : pick(b.key)}
              disabled={zero || !onPick}
            >
              <span className="fnl-branch-body">
                <span className="fnl-branch-name">{b.label}</span>
                {b.hint && <span className="fnl-hint" style={{ display: 'block' }}>{b.hint}</span>}
              </span>
              <span className="fnl-branch-n">{b.count}</span>
            </button>

            {(b.children ?? []).map(c => {
              // ── Reclamables: lo más accionable de la pantalla ──
              if (c.key === 'reclamables' && c.count > 0) {
                return (
                  <div key={c.key} className="fnl-act is-claim">
                    <span className="fnl-act-body">
                      <span className="fnl-act-top">
                        <span className="fnl-act-name">Reclamables</span>
                        {claimAmount != null && claimAmount > 0 && (
                          <span className="fnl-act-eur">≈ {eur(claimAmount)}</span>
                        )}
                      </span>
                      <span className="fnl-act-sub" style={{ display: 'block' }}>
                        Tienen el transcript subido: es dinero que podés cobrar por clases que ya diste.
                      </span>
                    </span>
                    <span className="fnl-act-n">{c.count}</span>
                    {showActions && (
                      <Link href="/revisiones" className="fnl-act-btn">
                        Reclamar en Revisiones →
                      </Link>
                    )}
                  </div>
                );
              }

              // ── Pendientes con importe: accionable, un escalón por debajo ──
              const esPendiente = c.key === 'pendientes' || c.key === 'fuera_pendientes';
              if (esPendiente && c.count > 0) {
                const s = c.pendingSplit;
                return (
                  <div key={c.key} className="fnl-act" title={pendingTitle(c)}>
                    <span className="fnl-act-body">
                      <span className="fnl-act-top">
                        <span className="fnl-act-name">{c.label}</span>
                        {c.amount != null && <span className="fnl-act-eur">{eur(c.amount)}</span>}
                      </span>
                      {/* Se dice cuántas dependen de él y cuántas no: pedirle un
                          transcript por una clase retenida por el límite del plan
                          es mandarlo a hacer algo que no cambia nada. */}
                      {s && (s.transcript > 0 || s.limite > 0) && (
                        <span className="fnl-act-sub" style={{ display: 'block' }}>
                          {s.transcript > 0 && <>{s.transcript} esperan tu transcript</>}
                          {s.transcript > 0 && s.limite > 0 && ' · '}
                          {s.limite > 0 && <>{s.limite} retenidas por el límite del plan (lo resuelve el equipo)</>}
                        </span>
                      )}
                    </span>
                    <span className="fnl-act-n">{c.count}</span>
                    {showActions && s && s.transcript > 0 && (
                      <button type="button" className="fnl-act-btn is-ghost" onClick={pick(c.key)}>
                        Ver y subir
                      </button>
                    )}
                  </div>
                );
              }

              return <Child key={c.key} c={c} />;
            })}

            {/* Sin nada que reclamar: se explica, y no se ofrece una acción que
                no existe. Es el caso del profesor que no usa el botón. */}
            {b.key === 'sin_ingreso' && b.count > 0
              && (b.children ?? []).find(c => c.key === 'reclamables')?.count === 0 && (
              <div className="fnl-nothing">
                No hay nada que reclamar: de estas clases no quedó transcript ni registro.
                Usá «Ingresar a clase» para que cuenten.
              </div>
            )}
          </div>
        );
      })}

      {/* Un total que no es la suma de sus partes es un bug, y prefiero verlo a
          que pase inadvertido. No debería aparecer nunca. */}
      {!cuadra && (
        <div className="fnl-broken">
          Las ramas no suman el total. Es un error de cálculo: avisá al equipo antes de usar estos números.
        </div>
      )}
    </div>
  );
}

export default ClassFunnelCard;
