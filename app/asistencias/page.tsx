'use client';
// ── Sección "Asistencias" del profesor ────────────────────────────────────────
// Vista SEMANAL (navegable) de sus accesos a clase: las clases ya pasadas con su
// estado de ingreso (a tiempo / tarde / no ingresó) y las que están por venir esa
// semana. Reutiliza la MISMA lógica que el panel del admin (lib/attendance), pero
// filtrada solo a las clases del profesor logueado y mostrando también las futuras.
import { useState, useEffect, useMemo } from 'react';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { PullToRefresh } from '@/components/PullToRefresh';
import { LastUpdated } from '@/components/LastUpdated';
import { getSpainParts } from '@/components/VisualCalendar';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import {
  buildAttendanceRows, PUNCT_STYLE, attendanceSubBadge, isoDate, type LogRow,
} from '@/lib/attendance';
import { HelpTooltip } from '@/components/ui';
import type { HelpTooltipKey } from '@/lib/help-tooltips';

// Lunes de la semana que contiene `iso`.
function mondayOf(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1);
  const js = dt.getDay();                 // 0=Dom … 6=Sáb
  dt.setDate(dt.getDate() + (js === 0 ? -6 : 1 - js));
  return dt;
}
function addDays(base: Date, days: number): Date {
  const d = new Date(base); d.setDate(d.getDate() + days); return d;
}
function fmtDayLong(iso: string): string {
  const s = new Date(iso + 'T00:00:00').toLocaleDateString('es-ES', { weekday: 'short', day: '2-digit', month: 'short' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function fmtRange(a: Date, b: Date): string {
  const f = (d: Date) => d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
  return `${f(a)} — ${f(b)}`;
}

function AsistenciasContent() {
  const { user } = useAuth();
  const { teachers, assignments, classJoinLogs, loadClassJoinLogs, reloadAll } = useTeachers();

  const teacher = teachers.find(t => t.id === user?.teacherId) ?? teachers[0];

  // "Ahora" en hora de España, igual que el calendario y el panel del admin.
  const nowSpain = getSpainParts(new Date());
  const todayIso = nowSpain.dateStr;
  const nowMinutes = nowSpain.hour * 60 + nowSpain.minute;

  const [weekOffset, setWeekOffset] = useState(0);

  useEffect(() => {
    loadClassJoinLogs();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const weekStart = useMemo(() => addDays(mondayOf(todayIso), weekOffset * 7), [todayIso, weekOffset]);
  const weekEnd   = useMemo(() => addDays(weekStart, 6), [weekStart]);
  const fromDate  = isoDate(weekStart);
  const toDate    = isoDate(weekEnd);

  const myAssignments = useMemo(
    () => (teacher ? assignments.filter(a => a.teacherId === teacher.id) : []),
    [assignments, teacher],
  );

  const rows = useMemo<LogRow[]>(() => {
    if (!teacher) return [];
    return buildAttendanceRows({
      assignments: myAssignments,
      joinLogs: classJoinLogs,
      teacherId: teacher.id,
      fromDate, toDate, todayIso, nowMinutes,
      includeFuture: true,
    }).sort((x, y) => x.date.localeCompare(y.date) || (parseInt(x.hour) - parseInt(y.hour)));
  }, [teacher, myAssignments, classJoinLogs, fromDate, toDate, todayIso, nowMinutes]);

  // Resumen de la semana visible.
  const registered = rows.filter(r => r.status === 'on_time' || r.status === 'late' || r.status === 'very_late').length;
  const onTime     = rows.filter(r => r.status === 'on_time').length;
  const missed     = rows.filter(r => r.status === 'missed').length;
  const proximas   = rows.filter(r => r.status === 'pending' || r.status === 'upcoming').length;
  const punctualityPct = registered > 0 ? Math.round((onTime / registered) * 100) : 0;

  const cards: Array<{ label: string; value: string | number; color: string; help: HelpTooltipKey }> = [
    { label: 'Clases con ingreso', value: registered, color: '#1E9E3A', help: 'asistencias.conIngreso' },
    { label: 'Puntualidad', value: `${punctualityPct}%`, color: punctualityPct >= 80 ? '#1E9E3A' : punctualityPct >= 60 ? '#f59e0b' : '#ef4444', help: 'asistencias.puntualidad' },
    { label: 'No ingresó', value: missed, color: missed > 0 ? '#ef4444' : '#1E9E3A', help: 'asistencias.noIngreso' },
    { label: 'Próximas', value: proximas, color: '#2563eb', help: 'asistencias.proximas' },
  ];

  const isThisWeek = weekOffset === 0;

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }}>
      <NavBar />
      <PullToRefresh onRefresh={async () => { await reloadAll(); await loadClassJoinLogs(); }}>
        <div style={{ maxWidth: 980, margin: '0 auto', padding: '32px 16px 48px' }}>
          <LastUpdated />
          <div style={{ marginBottom: 20 }}>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 4px' }}>Asistencias</h1>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
              Tus accesos a clase semana a semana: las clases ya dadas y las que están por venir.
            </p>
          </div>

          {!teacher ? (
            <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-muted)' }}>Cargando...</div>
          ) : (
            <>
              {/* Navegación de semana */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 16px', marginBottom: 16 }}>
                <button onClick={() => setWeekOffset(o => o - 1)} aria-label="Semana anterior"
                  style={{ width: 34, height: 34, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-surface-2)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 18, fontFamily: 'inherit' }}>‹</button>
                <div style={{ flex: 1, textAlign: 'center' }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
                    Semana del {fmtRange(weekStart, weekEnd)}
                    {isThisWeek && <span style={{ marginLeft: 8, fontSize: 11, padding: '2px 8px', borderRadius: 10, background: 'rgba(30,158,58,0.12)', color: '#1E9E3A', fontWeight: 700 }}>Esta semana</span>}
                  </div>
                </div>
                <button onClick={() => setWeekOffset(o => o + 1)} aria-label="Semana siguiente"
                  style={{ width: 34, height: 34, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-surface-2)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 18, fontFamily: 'inherit' }}>›</button>
                {!isThisWeek && (
                  <button onClick={() => setWeekOffset(0)}
                    style={{ padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit' }}>Hoy</button>
                )}
              </div>

              {/* Resumen de la semana */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 16 }}>
                {cards.map(c => (
                  <div key={c.label} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px' }}>
                    <div style={{ fontSize: 24, fontWeight: 700, color: c.color }}>{c.value}</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginTop: 3, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      {c.label}
                      <HelpTooltip tooltipKey={c.help} />
                    </div>
                  </div>
                ))}
              </div>

              {/* Tabla de la semana */}
              <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
                {rows.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '40px 16px', color: 'var(--text-muted)', fontSize: 14 }}>
                    No tenés clases programadas esta semana.
                  </div>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <thead>
                        <tr style={{ background: 'var(--bg-surface-2)', textAlign: 'left' }}>
                          {([
                            { h: 'Día' }, { h: 'Hora' }, { h: 'Alumno' },
                            { h: 'Hora ingreso', help: 'asistencias.horaIngreso' },
                            { h: 'Estado', help: 'asistencias.estado' },
                            { h: 'Suscripción', help: 'finanzas.suscripcion' },
                          ] as Array<{ h: string; help?: HelpTooltipKey }>).map(col => (
                            <th key={col.h} style={{ padding: '10px 14px', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                {col.h}
                                {col.help && <HelpTooltip tooltipKey={col.help} />}
                              </span>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map(r => {
                          const ps = PUNCT_STYLE[r.status];
                          const isToday = r.date === todayIso;
                          return (
                            <tr key={r.id} style={{ borderTop: '1px solid var(--border)', background: isToday ? 'rgba(30,158,58,0.04)' : undefined }}>
                              <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
                                {fmtDayLong(r.date)}
                                {isToday && <span style={{ marginLeft: 6, fontSize: 10, padding: '1px 6px', borderRadius: 8, background: 'rgba(30,158,58,0.12)', color: '#1E9E3A', fontWeight: 700 }}>hoy</span>}
                              </td>
                              <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', color: 'var(--text-primary)', fontWeight: 600 }}>{r.hour}</td>
                              <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', color: 'var(--text-primary)' }}>
                                {r.studentName}
                                {!r.hasLink && <span style={{ marginLeft: 6, fontSize: 10, padding: '1px 6px', borderRadius: 8, background: 'rgba(249,115,22,0.12)', color: '#ea580c', fontWeight: 700 }}>sin enlace</span>}
                              </td>
                              <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                                {r.joinedAt ? new Date(r.joinedAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : '—'}
                              </td>
                              <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                                <span style={{ fontSize: 11, padding: '2px 9px', borderRadius: 12, background: ps.bg, color: ps.color, fontWeight: 700 }}>{ps.label}</span>
                              </td>
                              <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                                {(() => {
                                  const sb = attendanceSubBadge(r);
                                  return sb
                                    ? <span style={{ fontSize: 11, padding: '2px 9px', borderRadius: 12, background: sb.bg, color: sb.color, fontWeight: 700 }}>{sb.label}</span>
                                    : <span style={{ color: 'var(--text-muted)' }}>—</span>;
                                })()}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 12, lineHeight: 1.6 }}>
                El ingreso se registra automáticamente al usar el botón <b>“Ingresar a clase”</b> desde el Calendario. Las clases futuras aparecen como <b>Próxima</b> hasta que llegue su horario.
              </div>
            </>
          )}
        </div>
      </PullToRefresh>
    </div>
  );
}

export default function AsistenciasPage() {
  return (
    <AuthGuard allowedRoles={['teacher']}>
      <AsistenciasContent />
    </AuthGuard>
  );
}
