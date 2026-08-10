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

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { PullToRefresh } from '@/components/PullToRefresh';
import { LastUpdated } from '@/components/LastUpdated';
import { useTeachers } from '@/lib/TeachersContext';
import { useStudentProfiles } from '@/lib/useStudentProfiles';
import {
  buildEndingPlans, endingUrgency, retentionBadge, longDateEs,
  ENDING_WINDOW_DAYS, ENDING_WARN_DAYS,
  type EndingPlan,
} from '@/lib/endingPlans';
import { madridToday } from '@/lib/subscriptionAccess';

type Filtro = 'todos' | 'sin_avisar' | 'urgentes';

const FILTROS: Array<{ id: Filtro; label: string }> = [
  { id: 'todos',      label: 'Todos' },
  { id: 'sin_avisar', label: 'Solo sin avisar' },
  { id: 'urgentes',   label: `Termina en ≤${ENDING_WARN_DAYS} días` },
];

/** Enlace a la ficha: /students con el alumno ya filtrado. Es la ficha que admin
 *  y setter SÍ pueden abrir (/mis-alumnos/[id] es del profesor). */
function fichaHref(p: EndingPlan): string {
  return `/students?q=${encodeURIComponent(p.studentEmail || p.studentName)}`;
}

function ProximosCancelarContent() {
  const { students, reloadAll } = useTeachers();
  const { profiles, loading: loadingProfiles } = useStudentProfiles();
  const [filtro, setFiltro] = useState<Filtro>('todos');

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
      })),
      profiles,
      today,
      windowDays: ENDING_WINDOW_DAYS,
    }),
    [students, profiles, today],
  );

  const estaSemana = planes.filter(p => p.daysLeft <= ENDING_WARN_DAYS).length;
  const avisados   = planes.filter(p => p.noticeSent).length;
  const sinAvisar  = planes.length - avisados;

  const visibles = planes.filter(p =>
    filtro === 'sin_avisar' ? !p.noticeSent
    : filtro === 'urgentes' ? p.daysLeft <= ENDING_WARN_DAYS
    : true);

  const cards: Array<{ n: number; label: string; color: string }> = [
    { n: estaSemana, label: `terminan en ≤${ENDING_WARN_DAYS} días`, color: '#b45309' },
    { n: avisados,   label: 'ya avisados',                            color: '#1E9E3A' },
    { n: sinAvisar,  label: 'sin avisar',                             color: 'var(--text-secondary)' },
  ];

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }}>
      <NavBar />
      <PullToRefresh onRefresh={reloadAll}>
        <div style={{ maxWidth: 1100, margin: '0 auto', padding: '32px 20px 48px' }}>
          <LastUpdated />

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 24 }}>
            <div>
              <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 4px' }}>
                Próximos a cancelar
              </h1>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, maxWidth: 620, lineHeight: 1.55 }}>
                Alumnos con activación manual o intensivo que termina en los próximos {ENDING_WINDOW_DAYS} días.
                Contactales por WhatsApp con lo que dice su ficha para ofrecerles mantenimiento o un intensivo nuevo.
              </p>
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
              {visibles.length === planes.length
                ? `${planes.length} alumno${planes.length !== 1 ? 's' : ''}`
                : `${visibles.length} de ${planes.length} alumnos`}
            </div>
          </div>

          {/* Resumen */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 20 }}>
            {cards.map(c => (
              <div key={c.label} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px' }}>
                <div style={{ fontSize: 28, fontWeight: 700, color: c.color, lineHeight: 1.1 }}>{c.n}</div>
                <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 4 }}>{c.label}</div>
              </div>
            ))}
          </div>

          {/* Filtros */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
            {FILTROS.map(f => (
              <button key={f.id} onClick={() => setFiltro(f.id)}
                style={{
                  padding: '6px 14px', borderRadius: 20, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
                  border: `1.5px solid ${filtro === f.id ? '#1E9E3A' : 'var(--border)'}`,
                  background: filtro === f.id ? 'rgba(30,158,58,0.1)' : 'transparent',
                  color: filtro === f.id ? '#1E9E3A' : 'var(--text-secondary)',
                  fontWeight: filtro === f.id ? 700 : 500,
                }}>
                {f.label}
              </button>
            ))}
          </div>

          {loadingProfiles && planes.length === 0 ? (
            <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              Cargando…
            </div>
          ) : visibles.length === 0 ? (
            <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '40px 32px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13.5, lineHeight: 1.6 }}>
              {planes.length === 0
                ? <>No hay ningún alumno con el plan a punto de terminar en los próximos {ENDING_WINDOW_DAYS} días.</>
                : <>Ningún alumno cumple este filtro.</>}
            </div>
          ) : (
            <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5, minWidth: 860 }}>
                  <thead>
                    <tr style={{ background: 'var(--bg-surface-2)' }}>
                      {['Alumno', 'Días restantes', 'Tipo de plan', 'Origen', 'Progreso / riesgo', 'Aviso enviado', 'Ficha'].map((h, i) => (
                        <th key={h} style={{
                          textAlign: i === 0 ? 'left' : 'left', padding: '11px 14px', fontSize: 11.5, fontWeight: 700,
                          color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4,
                          borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
                        }}>{h}</th>
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
            El aviso interno sale solo, una vez por alumno y por ciclo de plan, cuando quedan {ENDING_WARN_DAYS} días o menos.
            Si el alumno renueva y se le alarga la activación, vuelve a poder avisarse al final del ciclo nuevo.
          </p>
        </div>
      </PullToRefresh>
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
