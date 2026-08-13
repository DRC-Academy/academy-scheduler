'use client';
// ── Próximos a cancelar ───────────────────────────────────────────────────────
//
// Alumnos a los que se les termina el plan, para que ventas les ofrezca
// mantenimiento o un intensivo nuevo antes de que se vayan. Solo admin y setter
// (el profesor no la ve: la retención no es su trabajo y la lista lleva datos
// comerciales de alumnos que no son suyos).
//
// QUIÉN ENTRA no se decide acá: lo decide lib/endingPlans, la misma función que
// usa el cron del aviso. Si esta pantalla filtrara por su cuenta, el email y la
// tabla podrían decir cosas distintas del mismo alumno — que es exactamente el
// problema que arrastramos en las cuatro vistas del transcript.
//
// DOS MARCADORES QUE NO SON LO MISMO. Conviven en la tabla a propósito:
//
//   · "Aviso enviado"        AUTOMÁTICO. Lo pone el cron cuando manda el email
//                            interno. Dice que el equipo se enteró.
//   · "Contactado por ventas" MANUAL. Lo pone una persona cuando ya habló con el
//                            alumno, y guarda en qué quedó. Dice que está
//                            gestionado.
//
// Que el sistema haya avisado no significa que nadie llamara. Por eso son dos
// columnas, dos bloques de resumen y dos filtros separados, cada uno con su
// etiqueta: mezclarlos haría que ventas diera por atendido a quien no lo está.
//
// MARCAR NO SACA AL ALUMNO DE LA LISTA. Sigue visible con su badge hasta que se
// le acabe el plan (ahí sale solo, por la ventana de 30 días). Ventas necesita el
// panorama entero — a quién contactó, con qué resultado y a quién le falta —, no
// solo lo pendiente.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { PullToRefresh } from '@/components/PullToRefresh';
import { LastUpdated } from '@/components/LastUpdated';
import { HelpTooltip } from '@/components/ui/HelpTooltip';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import { useStudentProfiles } from '@/lib/useStudentProfiles';
import {
  buildEndingPlans, endingUrgency, retentionBadge, salesBadge, longDateEs,
  SALES_RESULTS, ENDING_WINDOW_DAYS, ENDING_WARN_DAYS,
  type EndingPlan, type SalesContactResult,
} from '@/lib/endingPlans';
import { madridToday } from '@/lib/subscriptionAccess';

type FiltroAviso  = 'todos' | 'sin_avisar' | 'urgentes';
type FiltroVentas = 'todos' | 'sin_contactar' | SalesContactResult;

const FILTROS_AVISO: Array<{ id: FiltroAviso; label: string }> = [
  { id: 'todos',      label: 'Todos' },
  { id: 'sin_avisar', label: 'Solo sin avisar' },
  { id: 'urgentes',   label: `Termina en ≤${ENDING_WARN_DAYS} días` },
];

const FILTROS_VENTAS: Array<{ id: FiltroVentas; label: string }> = [
  { id: 'todos',         label: 'Todos' },
  { id: 'sin_contactar', label: 'Sin contactar' },
  ...SALES_RESULTS.map(r => ({ id: r.id as FiltroVentas, label: r.label })),
];

const AYUDA_AVISO =
  'Automático: lo marca el sistema cuando sale el email interno de este ciclo. ' +
  'Dice que el equipo se enteró, NO que alguien haya llamado al alumno.';

const AYUDA_VENTAS =
  'Manual: lo marca el equipo de ventas cuando ya contactó al alumno, y guarda en qué quedó. ' +
  'Si el alumno renueva y empieza otro ciclo, el marcador se resetea y vuelve a poder gestionarse.';

/** Enlace a la ficha: /students con el alumno ya filtrado. Es la ficha que admin
 *  y setter SÍ pueden abrir (/mis-alumnos/[id] es del profesor). */
function fichaHref(p: EndingPlan): string {
  return `/students?q=${encodeURIComponent(p.studentEmail || p.studentName)}`;
}

/** ISO → '13/08/26'. En hora de España, igual que el resto de la pestaña: los
 *  días restantes se cuentan en Madrid y una gestión marcada a las 23:30 de
 *  Argentina no debe leerse como si fuera de otro día. */
function shortDateEs(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('es-ES', {
    day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'Europe/Madrid',
  });
}

/** ISO → '13/08/2026, 17:42' para el title del badge. */
function fullDateEs(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('es-ES', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid',
  });
}

// ── Celda "Contactado por ventas" ────────────────────────────────────────────
//
// El selector de resultado se abre DENTRO de la celda, no en un desplegable
// flotante: la tabla vive en un `overflow-x: auto` y cualquier menú posicionado
// en absoluto quedaría cortado por el borde. Ocupa dos líneas más mientras está
// abierto y se cierra al guardar.
function SalesContactCell({ plan, onSave }: {
  plan: EndingPlan;
  /** Devuelve el motivo del fallo, o null si guardó bien. */
  onSave: (result: SalesContactResult) => Promise<string | null>;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving]   = useState<SalesContactResult | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const sc = plan.salesContact;

  async function choose(result: SalesContactResult) {
    if (saving) return;
    setSaving(result);
    setError(null);
    const motivo = await onSave(result);
    setSaving(null);
    if (motivo) { setError(motivo); return; }   // el selector queda abierto para reintentar
    setEditing(false);
  }

  if (editing) {
    return (
      <div style={{ display: 'grid', gap: 5, minWidth: 168 }}>
        {SALES_RESULTS.map(o => {
          const b = salesBadge(o.id);
          const cargando = saving === o.id;
          const elegido = sc?.result === o.id;
          return (
            <button key={o.id} onClick={() => choose(o.id)} disabled={saving !== null}
              style={{
                padding: '5px 10px', borderRadius: 8, fontSize: 12, fontFamily: 'inherit',
                fontWeight: elegido ? 700 : 600, textAlign: 'left',
                border: `1.5px solid ${b.border}`, background: b.bg, color: b.color,
                cursor: saving ? 'default' : 'pointer', opacity: saving && !cargando ? 0.5 : 1,
              }}>
              {cargando ? 'Guardando…' : b.label}{elegido && !cargando ? ' ·  actual' : ''}
            </button>
          );
        })}
        <button onClick={() => { setEditing(false); setError(null); }} disabled={saving !== null}
          style={{
            padding: '2px 4px', border: 'none', background: 'none', cursor: 'pointer',
            fontSize: 11.5, fontFamily: 'inherit', color: 'var(--text-muted)', textAlign: 'left',
          }}>
          Cancelar
        </button>
        {error && (
          <div style={{ fontSize: 11, color: '#b91c1c', lineHeight: 1.4, maxWidth: 200 }}>{error}</div>
        )}
      </div>
    );
  }

  if (!sc) {
    return (
      <button onClick={() => setEditing(true)}
        style={{
          padding: '5px 11px', borderRadius: 8, fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
          border: '1.5px dashed var(--border)', background: 'transparent',
          color: 'var(--text-secondary)', cursor: 'pointer', whiteSpace: 'nowrap',
        }}>
        + Marcar contactado
      </button>
    );
  }

  const b = salesBadge(sc.result);
  const quien = sc.by || 'sin registrar';
  return (
    <div style={{ display: 'grid', gap: 3, justifyItems: 'start' }}>
      <span
        title={`Gestionado el ${fullDateEs(sc.at)} por ${quien}`}
        style={{
          display: 'inline-block', padding: '3px 10px', borderRadius: 12, fontSize: 12,
          fontWeight: 700, background: b.bg, color: b.color, border: `1px solid ${b.border}`,
          whiteSpace: 'nowrap',
        }}>
        {b.label}
      </span>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
        {shortDateEs(sc.at)} · {quien}
      </span>
      <button onClick={() => setEditing(true)}
        style={{
          padding: 0, border: 'none', background: 'none', cursor: 'pointer',
          fontSize: 11.5, fontFamily: 'inherit', color: '#1E9E3A', fontWeight: 600,
        }}>
        Editar
      </button>
    </div>
  );
}

function ProximosCancelarContent() {
  const { user } = useAuth();
  const { students, reloadAll, markSalesContact } = useTeachers();
  const { profiles, loading: loadingProfiles } = useStudentProfiles();
  const [filtroAviso, setFiltroAviso]   = useState<FiltroAviso>('todos');
  const [filtroVentas, setFiltroVentas] = useState<FiltroVentas>('todos');

  const today = madridToday();

  const planes = useMemo(
    () => buildEndingPlans({
      students: students.map(s => ({
        id: s.id,
        name: s.name,
        email: s.email,
        productType: s.productType ?? null,
        productName: s.productName ?? null,
        plan: s.plan ?? null,
        manualActiveUntil: s.manualActiveUntil ?? null,
        companyPlanMonths: s.companyPlanMonths ?? null,
        endingNoticeSentAt: s.endingNoticeSentAt ?? null,
        endingNoticeForDate: s.endingNoticeForDate ?? null,
        salesContactedAt: s.salesContactedAt ?? null,
        salesContactResult: s.salesContactResult ?? null,
        salesContactedBy: s.salesContactedBy ?? null,
        salesContactForDate: s.salesContactForDate ?? null,
      })),
      profiles,
      today,
      windowDays: ENDING_WINDOW_DAYS,
    }),
    [students, profiles, today],
  );

  const estaSemana   = planes.filter(p => p.daysLeft <= ENDING_WARN_DAYS).length;
  const avisados     = planes.filter(p => p.noticeSent).length;
  const sinAvisar    = planes.length - avisados;
  const sinContactar = planes.filter(p => !p.salesContact).length;
  const porResultado = (r: SalesContactResult) => planes.filter(p => p.salesContact?.result === r).length;

  // ORDEN: primero los que ventas tiene que atender (sin contactar) y, dentro de
  // cada grupo, los más urgentes. Los ya gestionados bajan pero NO desaparecen:
  // el alumno se queda en la lista con su badge hasta que se le acabe el plan.
  const visibles = useMemo(() => {
    const filtrados = planes.filter(p => {
      const okAviso =
        filtroAviso === 'sin_avisar' ? !p.noticeSent
        : filtroAviso === 'urgentes' ? p.daysLeft <= ENDING_WARN_DAYS
        : true;
      const okVentas =
        filtroVentas === 'todos'         ? true
        : filtroVentas === 'sin_contactar' ? !p.salesContact
        : p.salesContact?.result === filtroVentas;
      return okAviso && okVentas;
    });
    return filtrados.sort((a, b) =>
      (a.salesContact ? 1 : 0) - (b.salesContact ? 1 : 0)
      || a.daysLeft - b.daysLeft
      || a.studentName.localeCompare(b.studentName, 'es'));
  }, [planes, filtroAviso, filtroVentas]);

  // Quién queda registrado como responsable de la gestión. La pestaña ya está
  // cerrada a admin y setter por el AuthGuard, así que cualquiera que llegue acá
  // puede marcar; lo único que hace falta es saber su nombre.
  const marcadoPor = (user?.displayName || user?.username || '').trim();

  async function guardarGestion(p: EndingPlan, result: SalesContactResult): Promise<string | null> {
    try {
      // `p.endDate` es el fin del ciclo VIGENTE: es lo que hace que, si el alumno
      // renueva y se le alarga la activación, esta marca deje de contar y vuelva
      // a aparecer como pendiente al final del ciclo nuevo.
      await markSalesContact(p.studentId, result, marcadoPor, p.endDate);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : 'No se pudo guardar. Probá de nuevo.';
    }
  }

  const cardsPlan: Array<{ n: number; label: string; color: string }> = [
    { n: estaSemana, label: `terminan en ≤${ENDING_WARN_DAYS} días`, color: '#b45309' },
    { n: avisados,   label: 'ya avisados',                            color: '#1E9E3A' },
    { n: sinAvisar,  label: 'sin avisar',                             color: 'var(--text-secondary)' },
  ];

  const cardsVentas: Array<{ n: number; label: string; color: string }> = [
    { n: sinContactar,               label: 'sin contactar',  color: '#b45309' },
    { n: porResultado('interesado'), label: 'interesados',    color: '#1f7a3d' },
    { n: porResultado('no_interesado'), label: 'no interesados', color: 'var(--text-secondary)' },
    { n: porResultado('renovo'),     label: 'renovaron',      color: '#1E9E3A' },
  ];

  const columnas: Array<{ label: string; help?: string }> = [
    { label: 'Alumno' },
    { label: 'Días restantes' },
    { label: 'Tipo de plan' },
    { label: 'Origen' },
    { label: 'Progreso / riesgo' },
    { label: 'Aviso enviado', help: AYUDA_AVISO },
    { label: 'Contactado por ventas', help: AYUDA_VENTAS },
    { label: 'Ficha' },
  ];

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }}>
      <NavBar />
      <PullToRefresh onRefresh={reloadAll}>
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '32px 20px 48px' }}>
          <LastUpdated />

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 24 }}>
            <div>
              <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 4px' }}>
                Próximos a cancelar
              </h1>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, maxWidth: 640, lineHeight: 1.55 }}>
                Alumnos con activación manual o intensivo que termina en los próximos {ENDING_WINDOW_DAYS} días.
                Contactales por WhatsApp con lo que dice su ficha para ofrecerles mantenimiento o un intensivo nuevo,
                y marcá en qué quedó cada gestión: el alumno se queda en la lista con su resultado hasta que le termine el plan.
              </p>
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
              {visibles.length === planes.length
                ? `${planes.length} alumno${planes.length !== 1 ? 's' : ''}`
                : `${visibles.length} de ${planes.length} alumnos`}
            </div>
          </div>

          {/* Resumen. Dos bloques etiquetados y no siete tarjetas seguidas: el de
              arriba lo mueve el sistema, el de abajo lo mueve el equipo. */}
          <BloqueResumen titulo="Fin de plan y aviso automático" cards={cardsPlan} />
          <BloqueResumen titulo="Gestión de ventas (manual)" cards={cardsVentas} />

          {/* Filtros. Los dos ejes son independientes y se aplican a la vez: se
              puede pedir "termina en ≤7 días" Y "sin contactar", que es la lista
              con la que ventas empieza el día. */}
          <div style={{ display: 'grid', gap: 8, marginBottom: 20 }}>
            <FilaFiltros titulo="Aviso" opciones={FILTROS_AVISO} valor={filtroAviso} onChange={setFiltroAviso} />
            <FilaFiltros titulo="Ventas" opciones={FILTROS_VENTAS} valor={filtroVentas} onChange={setFiltroVentas} />
          </div>

          {loadingProfiles && planes.length === 0 ? (
            <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              Cargando…
            </div>
          ) : visibles.length === 0 ? (
            <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '40px 32px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13.5, lineHeight: 1.6 }}>
              {planes.length === 0
                ? <>No hay ningún alumno con el plan a punto de terminar en los próximos {ENDING_WINDOW_DAYS} días.</>
                : <>Ningún alumno cumple estos filtros.</>}
            </div>
          ) : (
            <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5, minWidth: 1040 }}>
                  <thead>
                    <tr style={{ background: 'var(--bg-surface-2)' }}>
                      {columnas.map(c => (
                        <th key={c.label} style={{
                          textAlign: 'left', padding: '11px 14px', fontSize: 11.5, fontWeight: 700,
                          color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4,
                          borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
                        }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                            {c.label}
                            {c.help && <HelpTooltip content={c.help} label={`Qué es ${c.label}`} maxWidth={300} />}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibles.map(p => {
                      const u = retentionBadge(p);
                      const d = endingUrgency(p.daysLeft);
                      return (
                        <tr key={p.studentId} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td style={{ padding: '12px 14px' }}>
                            <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{p.studentName}</div>
                            <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>termina el {longDateEs(p.endDate)}</div>
                          </td>

                          <td style={{ padding: '12px 14px', whiteSpace: 'nowrap' }}>
                            <span style={{ display: 'inline-block', padding: '3px 10px', borderRadius: 12, fontSize: 12.5, fontWeight: 700, background: d.bg, color: d.color }}>
                              {d.label}
                            </span>
                          </td>

                          <td style={{ padding: '12px 14px', color: 'var(--text-secondary)', maxWidth: 260 }}>
                            {p.planLabel}
                          </td>

                          <td style={{ padding: '12px 14px', whiteSpace: 'nowrap' }}>
                            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                              {p.planKind === 'empresa' ? 'Empresa · automático'
                                : p.planKind === 'intensivo' ? 'Intensivo · manual'
                                : 'Activación manual'}
                            </span>
                          </td>

                          <td style={{ padding: '12px 14px', whiteSpace: 'nowrap' }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600, background: u.bg, color: u.color }}>
                              <span style={{ width: 7, height: 7, borderRadius: 999, background: u.dot }} />
                              {u.label}
                            </span>
                          </td>

                          <td style={{ padding: '12px 14px', whiteSpace: 'nowrap' }}>
                            {p.noticeSent
                              ? <span style={{ color: '#1E9E3A', fontWeight: 700 }} title="El aviso interno de este ciclo ya salió">✓ Avisado</span>
                              : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                          </td>

                          <td style={{ padding: '12px 14px', verticalAlign: 'top' }}>
                            <SalesContactCell plan={p} onSave={r => guardarGestion(p, r)} />
                          </td>

                          <td style={{ padding: '12px 14px', whiteSpace: 'nowrap' }}>
                            <Link href={fichaHref(p)} style={{ color: '#1E9E3A', fontWeight: 600, textDecoration: 'none', fontSize: 12.5 }}>
                              Ver ficha ›
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 16, lineHeight: 1.6 }}>
            <strong>Aviso enviado</strong> lo marca el sistema solo, una vez por alumno y por ciclo de plan, cuando quedan {ENDING_WARN_DAYS} días o menos.
            <strong> Contactado por ventas</strong> lo marcás vos cuando ya hablaste con el alumno; queda registrado quién y cuándo.
            Los dos se resetean si el alumno renueva y se le alarga la activación, para poder avisar y gestionar de nuevo al final del ciclo siguiente.
          </p>
        </div>
      </PullToRefresh>
    </div>
  );
}

/** Un bloque de tarjetas con su etiqueta. */
function BloqueResumen({ titulo, cards }: {
  titulo: string;
  cards: Array<{ n: number; label: string; color: string }>;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
        {titulo}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
        {cards.map(c => (
          <div key={c.label} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px' }}>
            <div style={{ fontSize: 28, fontWeight: 700, color: c.color, lineHeight: 1.1 }}>{c.n}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 4 }}>{c.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Una fila de chips de filtro con su etiqueta delante. */
function FilaFiltros<T extends string>({ titulo, opciones, valor, onChange }: {
  titulo: string;
  opciones: Array<{ id: T; label: string }>;
  valor: T;
  onChange: (v: T) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, minWidth: 52 }}>
        {titulo}
      </span>
      {opciones.map(o => (
        <button key={o.id} onClick={() => onChange(o.id)}
          style={{
            padding: '6px 14px', borderRadius: 20, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
            border: `1.5px solid ${valor === o.id ? '#1E9E3A' : 'var(--border)'}`,
            background: valor === o.id ? 'rgba(30,158,58,0.1)' : 'transparent',
            color: valor === o.id ? '#1E9E3A' : 'var(--text-secondary)',
            fontWeight: valor === o.id ? 700 : 500,
          }}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function ProximosCancelarPage() {
  return (
    <AuthGuard allowedRoles={['admin', 'setter']}>
      <ProximosCancelarContent />
    </AuthGuard>
  );
}
