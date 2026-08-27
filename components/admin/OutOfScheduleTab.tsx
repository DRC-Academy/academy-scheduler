'use client';
// ── Clases dadas fuera del horario del alumno ────────────────────────────────
//
// La contrapartida de lo que ve el profesor. En su embudo, «Dadas fuera de tu
// horario» dice cuántas son y se cobran igual, y ahí termina: es un problema que
// él no puede resolver, y pedirle que lo reporte era conseguir veinte mensajes
// sobre lo mismo. Acá está la lista entera, agrupada por alumno y separada por
// los tres motivos, que es lo que hace falta para arreglar los calendarios.
//
// De los tres, solo el primero es un problema. Los otros dos —el cambio de día
// que nadie reflejó en la grilla y las últimas clases de un alumno dado de baja—
// son operación normal, y están para poder descartarlos de un vistazo en vez de
// tener que mirar cada caso.
//
// COSTE. Se carga al abrirla, no al entrar en Finanzas, y son DOS consultas: los
// calendarios de los 22 profesores de una vez y las bajas. Los alumnos y las
// assignments se le pasan desde el contexto, que ya los tiene, y el cálculo de
// finanzas se rehace en memoria.

import { useState, useMemo } from 'react';
import { useTeachers } from '@/lib/TeachersContext';
import { calculateTeacherFinance } from '@/lib/finance';
import { gridOccupancyOfTeacher } from '@/lib/teacherClasses';
import { dbGetAllTeacherAssignments } from '@/lib/db';
import { dbGetStudentDropouts, type StudentDropout } from '@/lib/studentPeriod';
import { buildDriftReport, DRIFT_KINDS, type DriftKind, type DriftStudent } from '@/lib/outOfCalendar';
import type { Assignment } from '@/types';

const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function fmtDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  return isNaN(d.getTime()) ? iso : `${String(d.getDate()).padStart(2, '0')} ${MESES_CORTOS[d.getMonth()]}`;
}

const TONO: Record<DriftKind, { bg: string; border: string; text: string }> = {
  sin_celda_activo: { bg: 'rgba(200,30,30,0.06)', border: 'var(--danger-border)', text: 'var(--danger)' },
  dia_ajeno:        { bg: 'var(--warn-soft)',     border: 'var(--warn-border)',   text: 'var(--warn)' },
  baja:             { bg: 'var(--bg-surface-2)',  border: 'var(--border)',        text: 'var(--text-muted)' },
};

export default function OutOfScheduleTab({ monthYear, monthLabel }: {
  monthYear: string;
  monthLabel: string;
}) {
  const {
    teachers, students, assignments, classJoinLogs, classRecords, classAnalyses,
    financeRates, scoringEvents, manualApprovals,
  } = useTeachers();

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // Cargado para el mes que se pidió: si se cambia de mes, se vuelve a pedir.
  const [datos, setDatos] = useState<{ grids: Map<string, Assignment[]>; dropouts: StudentDropout[] } | null>(null);
  const [abierto, setAbierto] = useState<string | null>(null);

  async function abrir() {
    setOpen(true);
    if (datos || loading) return;
    setLoading(true); setError('');
    try {
      const [grids, dropouts] = await Promise.all([
        // Los alumnos y las assignments ya están en el contexto: pasárselos deja
        // esto en una sola consulta, la de los calendarios.
        dbGetAllTeacherAssignments({ teachers, students, assignments }),
        dbGetStudentDropouts(),
      ]);
      setDatos({ grids, dropouts });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar el diagnóstico.');
    } finally {
      setLoading(false);
    }
  }

  const report = useMemo<DriftStudent[]>(() => {
    if (!datos) return [];
    return buildDriftReport({
      monthYear,
      dropouts: datos.dropouts,
      teachers: teachers.map(t => ({
        teacherId: t.id,
        teacherName: t.name,
        // Las del CALENDARIO: las mismas que consume el embudo del profesor.
        assignments: datos.grids.get(t.id) ?? [],
        // Y las MISMAS entradas de finanzas que el resto del panel, para que las
        // clases que salen acá sean exactamente las de su rama del embudo.
        rows: calculateTeacherFinance({
          teacherId: t.id, teacherName: t.name, monthYear,
          assignments, joinLogs: classJoinLogs, classRecords, classAnalyses,
          rates: financeRates, scoringEvents, students, manualApprovals, payment: null,
          gridOccupancy: gridOccupancyOfTeacher(t),
        }).rows,
      })),
    });
  }, [datos, monthYear, teachers, assignments, classJoinLogs, classRecords, classAnalyses,
      financeRates, scoringEvents, students, manualApprovals]);

  const totalClases = report.reduce((s, g) => s + g.units, 0);
  const grupos = DRIFT_KINDS.map(k => ({ ...k, items: report.filter(g => g.kind === k.key) }));

  return (
    <div style={{ marginTop: 30, borderTop: '1px solid var(--border)', paddingTop: 24 }}>
      <h3 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 5px' }}>
        Clases dadas fuera del horario del alumno
      </h3>
      <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: '0 0 14px', lineHeight: 1.6, maxWidth: 780 }}>
        Clases que ocurrieron un día que el calendario no tiene marcado para ese alumno, sin ser recuperación
        ni falta. Al profesor se le cobran igual y no se le pide nada: las que están mal son las de aquí.
      </p>

      {!open ? (
        <button
          onClick={abrir}
          style={{ border: '1px solid var(--border)', background: 'var(--bg-surface)', borderRadius: 9, padding: '9px 15px', fontFamily: 'inherit', fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', cursor: 'pointer', minHeight: 40 }}
        >
          Revisar {monthLabel}
        </button>
      ) : loading ? (
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Cargando calendarios…</div>
      ) : error ? (
        <div style={{ fontSize: 13, color: 'var(--danger)' }}>{error}</div>
      ) : report.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          Ninguna clase de {monthLabel} se dio fuera del horario del alumno.
        </div>
      ) : (
        <>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
            <b style={{ color: 'var(--text-primary)' }}>{totalClases}</b> clases · {report.length} alumno{report.length === 1 ? '' : 's'} · {monthLabel}
          </div>

          {grupos.map(g => {
            if (g.items.length === 0) return null;
            const clases = g.items.reduce((s, x) => s + x.units, 0);
            const euros = g.items.reduce((s, x) => s + x.amount, 0);
            const tono = TONO[g.key];
            return (
              <div key={g.key} style={{ marginBottom: 18 }}>
                <div style={{ background: tono.bg, border: `1px solid ${tono.border}`, borderRadius: 10, padding: '11px 14px', marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13.5, fontWeight: 700, color: tono.text }}>{g.label}</span>
                    <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                      {g.items.length} alumno{g.items.length === 1 ? '' : 's'} · {clases} clase{clases === 1 ? '' : 's'} · €{euros.toFixed(2)}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55, marginTop: 4 }}>{g.hint}</div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {g.items.map(s => {
                    const id = `${s.teacherId}|${s.studentName}`;
                    const isOpen = abierto === id;
                    return (
                      <div key={id} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10 }}>
                        <button
                          onClick={() => setAbierto(isOpen ? null : id)}
                          style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', fontFamily: 'inherit', cursor: 'pointer', padding: '11px 14px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}
                        >
                          <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)', minWidth: 0 }}>
                            {s.studentName}
                          </span>
                          <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{s.teacherName}</span>
                          <span style={{ flexGrow: 1 }} />
                          {/* Lo que hay que arreglar, dicho en una línea: qué días
                              tiene en la grilla frente a los días en que dio clase. */}
                          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                            {s.scheduledDays.length > 0
                              ? `en grilla: ${s.scheduledDays.join(', ')}`
                              : 'sin ninguna celda'}
                          </span>
                          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', minWidth: 78, textAlign: 'right' }}>
                            {s.units} clase{s.units === 1 ? '' : 's'}
                          </span>
                          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)', minWidth: 64, textAlign: 'right' }}>
                            €{s.amount.toFixed(2)}
                          </span>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }} aria-hidden>{isOpen ? '▾' : '▸'}</span>
                        </button>

                        {isOpen && (
                          <div style={{ borderTop: '1px solid var(--bg-surface-2)', padding: '4px 14px 10px' }}>
                            {s.classes.map((c, i) => (
                              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0', fontSize: 12.5, color: 'var(--text-secondary)', borderBottom: i < s.classes.length - 1 ? '1px solid var(--bg-surface-2)' : undefined }}>
                                <span style={{ minWidth: 58 }}>{fmtDate(c.date)}</span>
                                <span style={{ minWidth: 52, color: 'var(--text-muted)' }}>{c.hour || '--:--'}</span>
                                <span style={{ flexGrow: 1, color: 'var(--text-muted)' }}>
                                  {c.units > 1 ? `cuenta como ${c.units}` : ''}
                                </span>
                                <span style={{ color: c.status === 'pagable' ? 'var(--accent)' : 'var(--warn)' }}>
                                  {c.status === 'pagable' ? 'pagable' : 'pendiente'}
                                </span>
                                <span style={{ minWidth: 60, textAlign: 'right', fontWeight: 600, color: 'var(--text-primary)' }}>
                                  €{c.amount.toFixed(2)}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
