'use client';

// DASHBOARD GENERAL DEL NEGOCIO.
//
// Era la pestaña "Resumen" de /admin. Se sacó de ahí en septiembre de 2026 y pasó
// a ser una página propia (/dashboard), primer enlace del header y pantalla de
// entrada del admin: es lo que se mira todos los días, y estaba escondida detrás
// de una pestaña entre otras once.
//
// Se MOVIÓ, no se copió: en app/admin/page.tsx ya no queda nada de esto. Con ello
// vinieron los paneles de mantenimiento, que solo vivían para esta pantalla:
// SyncPanel, PlanSyncPanel, StartDateSyncPanel, CompanyPlanSyncPanel,
// CleanDashesPanel, AuditPanel, y los dos auxiliares AdminTool y
// ConflictDetailModal.
//
// DE DÓNDE SALEN LOS DATOS. Los gruesos (profesores, alumnos, asignaciones) los
// da el contexto `useTeachers`, que ya está cargado desde que arranca la app: esta
// página no dispara ninguna consulta por ellos. Lo único propio es la auditoría de
// vínculos, que alimenta el contador de Conflictos y la lista de Alertas.
//
// Tres secciones, en este orden: los indicadores del día, los emails de
// presentación pendientes y —al final y plegadas— las herramientas de
// mantenimiento, que son acciones puntuales y no información de consulta.
//
// DOS VISTAS, UNOS NÚMEROS. Por debajo de 768 px se muestra DashboardMovil
// (secciones plegables, una columna, navegación inferior) y por encima esta
// rejilla. Las dos leen el objeto `datos` que se arma una sola vez más abajo:
// el cambio de vista es por CSS (.dsh-desk / .dsh-mob) para que no parpadee al
// abrir en el teléfono, y las herramientas de mantenimiento se montan UNA vez,
// compartidas, porque tienen estado propio y cargan cosas al abrirse.

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTeachers } from '@/lib/TeachersContext';
import type { AssignedSlot } from '@/types';
import { CrearVinculoModal } from '@/components/CrearVinculoModal';
import { getPresentationEmailStatus } from '@/lib/presentationEmailUtils';
import { calculateTeacherFinance } from '@/lib/finance';
import { gridOccupancyOfTeacher } from '@/lib/teacherClasses';
// Los números del dashboard: funciones puras sobre lo que el contexto ya trajo.
import {
  monthKey, weekRange, madridDateString, diasEntre,
  alumnosResumen, ocupacionDe, tonoOcupacion, operacionDelMes,
  clasesEnRango, clasesProgramadasSemana, faltasProfesorDelMes,
  transcriptsPendientes, filasProfesores,
  // Los dos números que solo ve el teléfono (reglas provisionales, ver ahí).
  origenDeActivos, movimientoMensual,
} from '@/lib/dashboardMetrics';
// Y las cinco lecturas que no están en memoria.
import {
  loadDashboardExtras, riesgoResumen, esRiesgoRojo, bajasDelMes,
  type DashboardExtras,
} from '@/lib/dashboardExtras';
// La misma pantalla en el teléfono: recibe los números de acá, no calcula nada.
import { DashboardMovil, type DashboardDatos } from './DashboardMovil';
import {
  dbAuditStudentAssignments, dbRelinkAssignment, dbSyncAssignmentName, dbMergeDuplicateStudents,
  dbSyncStudentAssignments, dbDiagnoseAllCalendars, dbSyncAllCalendarsToAssignments, dbCreateFullLink,
  dbRepairMisplacedStudent, dbSyncSlotsFromCalendar,
  type CalendarDiagnosisAllRow, type AuditResult,
} from '@/lib/db';

/** Constante estable: un Set nuevo en cada render rompe la memoización. */
const VACIO_IDS: ReadonlySet<string> = new Set<string>();

const AUDIT_REVIEWED_KEY = 'drc_audit_reviewed_multi';

function loadReviewed(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(AUDIT_REVIEWED_KEY) || '[]')); }
  catch { return new Set(); }
}
function saveReviewed(set: Set<string>) {
  try { localStorage.setItem(AUDIT_REVIEWED_KEY, JSON.stringify([...set])); } catch { /* noop */ }
}

const auditCard = { background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px' };
const auditSectionTitle = (color: string) => ({ fontSize: 13, fontWeight: 700, color, marginBottom: 10 });
const auditBtn = (color: string, bg: string, border: string) => ({
  padding: '5px 11px', borderRadius: 7, border: `1px solid ${border}`, background: bg,
  color, cursor: 'pointer', fontSize: 11, fontWeight: 700, fontFamily: 'inherit', whiteSpace: 'nowrap' as const,
});

// ─── Panel de sincronización calendario ↔ assignments/students ────────────────
function SyncPanel() {
  const { teachers, students, reloadAll } = useTeachers();
  const [open, setOpen] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [rows, setRows] = useState<CalendarDiagnosisAllRow[] | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [modalRow, setModalRow] = useState<CalendarDiagnosisAllRow | null>(null);

  const rowKey = (r: CalendarDiagnosisAllRow) => `${r.teacherId}|${r.studentNameInGrid.trim().toLowerCase()}`;

  async function runAnalyze() {
    setAnalyzing(true);
    setMsg(null);
    try { setRows(await dbDiagnoseAllCalendars()); }
    finally { setAnalyzing(false); }
  }

  async function syncAllAuto() {
    setSyncing(true);
    setMsg(null);
    try {
      const { autoFixed, pendingManual } = await dbSyncAllCalendarsToAssignments();
      await reloadAll();
      await runAnalyze();
      setMsg(`✅ ${autoFixed} assignment${autoFixed !== 1 ? 's' : ''} creada${autoFixed !== 1 ? 's' : ''} automáticamente${pendingManual.length > 0 ? ` · ⚠️ ${pendingManual.length} requiere${pendingManual.length !== 1 ? 'n' : ''} datos manuales` : ''}`);
    } finally {
      setSyncing(false);
    }
  }

  // Alumno YA existe en students pero falta la assignment → crear automáticamente.
  async function crearAssignmentAuto(r: CalendarDiagnosisAllRow) {
    const t = teachers.find(x => x.id === r.teacherId);
    if (!t) return;
    const nk = r.studentNameInGrid.trim().toLowerCase();
    const stu = students.find(s => s.id === r.studentId) ?? students.find(s => s.name.trim().toLowerCase() === nk);
    if (!stu) return;
    setBusyKey(rowKey(r));
    try {
      await dbCreateFullLink({
        teacherId: t.id, teacherName: t.name, teacherEmail: t.email,
        name: stu.name, email: stu.email, level: stu.level, plan: stu.plan || 'Inglés general',
        weeklyHours: r.slots.length, slots: r.slots,
      });
      await reloadAll();
      await runAnalyze();
      setMsg(`✅ ${stu.name} vinculado correctamente con ${t.name}`);
    } finally {
      setBusyKey(null);
    }
  }

  async function handleModalDone(text: string) {
    setModalRow(null);
    await reloadAll();
    await runAnalyze();
    setMsg(text);
  }

  const problemCount = rows?.filter(r => !(r.existsInAssignments && r.existsInStudents)).length ?? 0;

  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginTop: 16 }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Estado actual</span>
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ padding: '0 18px 18px', borderTop: '1px solid var(--border)' }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: '12px 0 14px', lineHeight: 1.5 }}>
            Detecta alumnos que aparecen en el calendario de un profesor (celda "ocupado") pero no tienen assignment ni registro en la tabla de alumnos.
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
            <button onClick={runAnalyze} disabled={analyzing}
              style={{ padding: '9px 16px', borderRadius: 8, border: 'none', background: '#1E9E3A', color: 'white', cursor: analyzing ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
              {analyzing ? 'Analizando...' : '🔍 Analizar desconexiones'}
            </button>
            <button onClick={syncAllAuto} disabled={syncing}
              style={{ padding: '9px 16px', borderRadius: 8, border: 'none', background: '#fff', color: '#5f6360', cursor: syncing ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>
              {syncing ? 'Sincronizando...' : 'Sincronizar todos automáticamente'}
            </button>
          </div>

          {msg && <div style={{ margin: '0 0 14px', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{msg}</div>}

          {rows && (
            rows.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '10px 0' }}>No hay alumnos en los calendarios.</div>
            ) : (
              <>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
                  {rows.length} alumno{rows.length !== 1 ? 's' : ''} en calendarios · {problemCount > 0 ? <b style={{ color: '#ea580c' }}>{problemCount} desconexión{problemCount !== 1 ? 'es' : ''}</b> : <b style={{ color: '#1E9E3A' }}>todo sincronizado</b>}
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                    <thead>
                      <tr style={{ textAlign: 'left', color: 'var(--text-muted)' }}>
                        <th style={{ padding: '6px 10px', fontWeight: 700 }}>Profesor</th>
                        <th style={{ padding: '6px 10px', fontWeight: 700 }}>Alumno en grid</th>
                        <th style={{ padding: '6px 10px', fontWeight: 700, whiteSpace: 'nowrap' }}>En assignments</th>
                        <th style={{ padding: '6px 10px', fontWeight: 700, whiteSpace: 'nowrap' }}>En students</th>
                        <th style={{ padding: '6px 10px', fontWeight: 700 }}>Acción</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(r => {
                        const ok = r.existsInAssignments && r.existsInStudents;
                        const onlyStudent = r.existsInStudents && !r.existsInAssignments;
                        const busy = busyKey === rowKey(r);
                        return (
                          <tr key={rowKey(r)} style={{ borderTop: '1px solid var(--border)', background: ok ? 'transparent' : 'rgba(234,88,12,0.05)' }}>
                            <td style={{ padding: '8px 10px', color: 'var(--text-primary)', fontWeight: 600 }}>{r.teacherName}</td>
                            <td style={{ padding: '8px 10px', color: 'var(--text-primary)' }}>
                              {r.studentNameInGrid}
                              <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{r.slots.map(s => `${s.day} ${s.hour}`).join(' · ')}</div>
                            </td>
                            <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{r.existsInAssignments ? '✅ Sí' : '❌ No'}</td>
                            <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{r.existsInStudents ? '✅ Sí' : '❌ No'}</td>
                            <td style={{ padding: '8px 10px' }}>
                              {ok ? (
                                <span style={{ color: '#1E9E3A', fontWeight: 700 }}>✅ OK</span>
                              ) : onlyStudent ? (
                                <button onClick={() => crearAssignmentAuto(r)} disabled={busy}
                                  style={{ padding: '5px 12px', borderRadius: 7, border: 'none', background: busy ? 'var(--bg-surface-3)' : '#1E9E3A', color: busy ? 'var(--text-muted)' : 'white', cursor: busy ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 700, fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                                  {busy ? '...' : 'Crear assignment'}
                                </button>
                              ) : (
                                <button onClick={() => setModalRow(r)}
                                  style={{ padding: '5px 12px', borderRadius: 7, border: 'none', background: '#fff', color: '#5f6360', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                                  Crear todo
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )
          )}
        </div>
      )}

      {modalRow && (() => {
        const t = teachers.find(x => x.id === modalRow.teacherId);
        if (!t) return null;
        return (
          <CrearVinculoModal
            studentName={modalRow.studentNameInGrid}
            teacher={t}
            slots={modalRow.slots as AssignedSlot[]}
            onClose={() => setModalRow(null)}
            onDone={handleModalDone}
          />
        );
      })()}
    </div>
  );
}

// Sincronización masiva de planes con WooCommerce. Recorre TODOS los alumnos en
// lotes de 5 (delay 500ms entre lotes) para no sobrecargar la API de WooCommerce
// ni exceder timeouts serverless, mostrando progreso real.
function PlanSyncPanel() {
  const { students, reloadAll } = useTeachers();
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ updated: number; unchanged: number; notFound: number } | null>(null);

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  async function run() {
    setConfirming(false);
    setRunning(true);
    setResult(null);
    const withEmail = students.filter(s => s.email?.trim());
    setProgress({ done: 0, total: withEmail.length });
    let updated = 0, unchanged = 0, notFound = 0;
    try {
      for (let i = 0; i < withEmail.length; i += 5) {
        const batch = withEmail.slice(i, i + 5).map(s => ({ id: s.id, email: s.email, plan: s.plan, level: s.level }));
        try {
          const res = await fetch('/api/admin/sync-student-plans', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ students: batch }),
          });
          const data = await res.json();
          updated   += data.updated   ?? 0;
          unchanged += data.unchanged ?? 0;
          notFound  += data.notFound  ?? 0;
        } catch {
          notFound += batch.length;
        }
        setProgress({ done: Math.min(i + 5, withEmail.length), total: withEmail.length });
        if (i + 5 < withEmail.length) await sleep(500);
      }
      setResult({ updated, unchanged, notFound });
      await reloadAll();
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px', marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Planes</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 3, lineHeight: 1.5 }}>
            Actualiza el plan de todos los alumnos con el producto real de WooCommerce. Puede tardar varios minutos.
          </div>
        </div>
        <button onClick={() => setConfirming(true)} disabled={running}
          style={{ padding: '9px 16px', borderRadius: 8, border: 'none', background: running ? 'var(--bg-surface-3)' : '#FFC400', color: running ? 'var(--text-muted)' : '#1a1a1a', cursor: running ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
          {running ? 'Sincronizando...' : 'Sincronizar planes'}
        </button>
      </div>

      {progress && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 6 }}>
            Sincronizando... {progress.done}/{progress.total} alumnos
          </div>
          <div style={{ height: 8, borderRadius: 5, background: 'var(--bg-surface-3)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`, background: '#1E9E3A', transition: 'width 0.2s' }} />
          </div>
        </div>
      )}

      {result && (
        <div style={{ marginTop: 14, fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
          ✅ {result.updated} plan{result.updated !== 1 ? 'es' : ''} actualizado{result.updated !== 1 ? 's' : ''} · {result.unchanged} sin cambios · {result.notFound} no encontrado{result.notFound !== 1 ? 's' : ''} en WooCommerce
        </div>
      )}

      {confirming && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)', zIndex: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 24, width: '100%', maxWidth: 420 }}>
            <div style={{ fontSize: 24, marginBottom: 10 }}>⚠️</div>
            <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 8 }}>Sincronizar planes</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20, lineHeight: 1.6 }}>
              Esto actualizará el plan de todos los alumnos con los datos reales de WooCommerce. ¿Continuar?
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setConfirming(false)}
                style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
                Cancelar
              </button>
              <button onClick={run}
                style={{ flex: 1, padding: '10px', borderRadius: 8, border: 'none', background: '#1E9E3A', color: 'white', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
                Sí, continuar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Sincronización de la fecha de inicio (start_date) de las asignaciones con la
// fecha real de suscripción/compra en WooCommerce. Recorre las asignaciones en
// lotes de 5 (delay 500ms) llamando a /api/admin/sync-start-dates. El botón
// combinado corre además la sincronización de planes en la misma pasada.
const sleepMs = (ms: number) => new Promise(r => setTimeout(r, ms));

type DateSyncResult = { updated: number; notFound: number; errors: number; total: number };
type PlanSyncResult = { updated: number; unchanged: number; notFound: number };

function StartDateSyncPanel() {
  const { assignments, students, reloadAll } = useTeachers();
  const [choosing, setChoosing] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [dateResult, setDateResult] = useState<DateSyncResult | null>(null);
  const [planResult, setPlanResult] = useState<PlanSyncResult | null>(null);

  // Sincroniza start_date de las asignaciones. mode 'empty' → solo las que no
  // tienen fecha; mode 'all' (force) → todas las asignaciones con email.
  async function runDateSync(mode: 'empty' | 'all', labelPrefix = ''): Promise<DateSyncResult> {
    const candidates = assignments.filter(a => a.studentEmail?.trim() && (mode === 'all' || !a.startDate));
    const acc: DateSyncResult = { updated: 0, notFound: 0, errors: 0, total: candidates.length };
    setProgress({ done: 0, total: candidates.length, label: `${labelPrefix}Fechas` });
    for (let i = 0; i < candidates.length; i += 5) {
      const batch = candidates.slice(i, i + 5).map(a => ({ id: a.id, email: a.studentEmail }));
      try {
        const res = await fetch('/api/admin/sync-start-dates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assignments: batch }),
        });
        const data = await res.json();
        acc.updated  += data.updated  ?? 0;
        acc.notFound += data.notFound ?? 0;
        acc.errors   += data.errors   ?? 0;
      } catch {
        acc.errors += batch.length;
      }
      setProgress({ done: Math.min(i + 5, candidates.length), total: candidates.length, label: `${labelPrefix}Fechas` });
      if (i + 5 < candidates.length) await sleepMs(500);
    }
    return acc;
  }

  async function runPlanSync(labelPrefix = ''): Promise<PlanSyncResult> {
    const withEmail = students.filter(s => s.email?.trim());
    const acc: PlanSyncResult = { updated: 0, unchanged: 0, notFound: 0 };
    setProgress({ done: 0, total: withEmail.length, label: `${labelPrefix}Planes` });
    for (let i = 0; i < withEmail.length; i += 5) {
      const batch = withEmail.slice(i, i + 5).map(s => ({ id: s.id, email: s.email, plan: s.plan, level: s.level }));
      try {
        const res = await fetch('/api/admin/sync-student-plans', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ students: batch }),
        });
        const data = await res.json();
        acc.updated   += data.updated   ?? 0;
        acc.unchanged += data.unchanged ?? 0;
        acc.notFound  += data.notFound  ?? 0;
      } catch {
        acc.notFound += batch.length;
      }
      setProgress({ done: Math.min(i + 5, withEmail.length), total: withEmail.length, label: `${labelPrefix}Planes` });
      if (i + 5 < withEmail.length) await sleepMs(500);
    }
    return acc;
  }

  async function startDateSync(mode: 'empty' | 'all') {
    setChoosing(false);
    setRunning(true);
    setDateResult(null);
    setPlanResult(null);
    try {
      const r = await runDateSync(mode);
      setDateResult(r);
      await reloadAll();
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  async function startCombinedSync() {
    setRunning(true);
    setDateResult(null);
    setPlanResult(null);
    try {
      const p = await runPlanSync('1/2 · ');
      setPlanResult(p);
      const d = await runDateSync('empty', '2/2 · ');
      setDateResult(d);
      await reloadAll();
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  const noDateCount = assignments.filter(a => a.studentEmail?.trim() && !a.startDate).length;

  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px', marginTop: 16 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Fechas de inicio</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 3, lineHeight: 1.5 }}>
        Trae la fecha real de inicio de suscripción de cada alumno. {noDateCount > 0 ? `${noDateCount} asignación${noDateCount !== 1 ? 'es' : ''} sin fecha.` : 'Todas las asignaciones tienen fecha.'}
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
        <button onClick={() => setChoosing(true)} disabled={running}
          style={{ padding: '9px 16px', borderRadius: 8, border: 'none', background: running ? 'var(--bg-surface-3)' : '#FFC400', color: running ? 'var(--text-muted)' : '#1a1a1a', cursor: running ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
          Sincronizar fechas de inicio
        </button>
        <button onClick={startCombinedSync} disabled={running}
          style={{ padding: '9px 16px', borderRadius: 8, border: '1px solid var(--border)', background: running ? 'var(--bg-surface-3)' : 'var(--bg-surface-2)', color: running ? 'var(--text-muted)' : 'var(--text-primary)', cursor: running ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
          Sincronizar planes y fechas
        </button>
      </div>

      {progress && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 6 }}>
            {progress.label} · Procesando... {progress.done}/{progress.total} alumnos
          </div>
          <div style={{ height: 8, borderRadius: 5, background: 'var(--bg-surface-3)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`, background: '#1E9E3A', transition: 'width 0.2s' }} />
          </div>
        </div>
      )}

      {(dateResult || planResult) && !running && (
        <div style={{ marginTop: 14, fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.7 }}>
          {planResult && (
            <div>🗂️ Planes: ✅ {planResult.updated} actualizado{planResult.updated !== 1 ? 's' : ''} · {planResult.unchanged} sin cambios · {planResult.notFound} no encontrado{planResult.notFound !== 1 ? 's' : ''}</div>
          )}
          {dateResult && (<>
            <div>✅ {dateResult.updated} fecha{dateResult.updated !== 1 ? 's' : ''} actualizada{dateResult.updated !== 1 ? 's' : ''}</div>
            <div>❓ {dateResult.notFound} alumno{dateResult.notFound !== 1 ? 's' : ''} no encontrado{dateResult.notFound !== 1 ? 's' : ''} en WooCommerce</div>
            <div>⚠️ {dateResult.errors} error{dateResult.errors !== 1 ? 'es' : ''}</div>
          </>)}
        </div>
      )}

      {choosing && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)', zIndex: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 24, width: '100%', maxWidth: 440 }}>
            <div style={{ fontSize: 24, marginBottom: 10 }}>📅</div>
            <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 8 }}>Sincronizar fechas de inicio</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20, lineHeight: 1.6 }}>
              Elegí qué asignaciones actualizar con la fecha real de WooCommerce.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button onClick={() => startDateSync('empty')}
                style={{ padding: '12px 14px', borderRadius: 9, border: '1px solid rgba(30,158,58,0.4)', background: 'rgba(30,158,58,0.08)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 13.5, fontWeight: 700, fontFamily: 'inherit', textAlign: 'left' }}>
                Solo alumnos sin fecha <span style={{ color: '#1E9E3A' }}>(recomendado, más rápido)</span>
                <div style={{ fontWeight: 500, fontSize: 12, color: 'var(--text-secondary)', marginTop: 3 }}>{noDateCount} asignación{noDateCount !== 1 ? 'es' : ''}</div>
              </button>
              <button onClick={() => startDateSync('all')}
                style={{ padding: '12px 14px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--bg-surface-2)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 13.5, fontWeight: 700, fontFamily: 'inherit', textAlign: 'left' }}>
                Todos los alumnos
                <div style={{ fontWeight: 500, fontSize: 12, color: 'var(--text-secondary)', marginTop: 3 }}>Puede tardar varios minutos · reescribe fechas existentes</div>
              </button>
            </div>
            <button onClick={() => setChoosing(false)}
              style={{ width: '100%', marginTop: 14, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Planes de EMPRESA: activación automática por duración ────────────────────
//
// Los productos "Empresas *" son de pago único y llevan la duración contratada en
// la variación ("B1 · 1h semanal · 6 Meses"). WooCommerce no vence un pago único,
// así que la fecha de fin la calcula el sistema (pedido + N meses) y la escribe en
// `manual_active_until`, el mismo campo que ya usaban las activaciones a mano.
//
// Siempre en dos pasos: primero la SIMULACIÓN (GET, no escribe) para ver la tabla,
// después aplicar (POST). Esto toca el acceso a clase de personas reales.
type CompanyRowAction = 'set' | 'extend' | 'keep_manual' | 'unchanged' | 'not_company' | 'no_months' | 'no_order' | 'error';
type CompanyRow = {
  id: string; name: string; email: string;
  product: string | null; variation: string | null;
  months: number | null; start: string | null;
  computedUntil: string | null; currentUntil: string | null; finalUntil: string | null;
  result: CompanyRowAction; reason: string;
};
type CompanyResult = {
  applied: boolean; today: string; scanned: number;
  activated: number; extended: number; keptManual: number; unchanged: number;
  skipped: number; errors: number; rows: CompanyRow[];
};

// Cómo se lee cada resultado en la tabla. El color separa lo que CAMBIA (verde)
// de lo que se deja como estaba (neutro) y de lo que falló (rojo).
const COMPANY_ACTION_META: Record<CompanyRowAction, { label: string; color: string; bg: string }> = {
  set:         { label: 'Activado',        color: '#1f7a3d', bg: 'rgba(30,158,58,0.12)' },
  extend:      { label: 'Extendido',       color: '#1f7a3d', bg: 'rgba(30,158,58,0.12)' },
  keep_manual: { label: 'Margen manual',   color: '#9a6516', bg: 'rgba(255,196,0,0.18)' },
  unchanged:   { label: 'Ya estaba bien',  color: 'var(--text-muted)', bg: 'var(--bg-surface-3)' },
  not_company: { label: 'No es empresa',   color: 'var(--text-muted)', bg: 'var(--bg-surface-3)' },
  no_months:   { label: 'Sin duración',    color: 'var(--text-muted)', bg: 'var(--bg-surface-3)' },
  no_order:    { label: 'Pedido sin fecha', color: 'var(--text-muted)', bg: 'var(--bg-surface-3)' },
  error:       { label: 'Error',           color: '#c73a28', bg: 'rgba(239,68,68,0.10)' },
};

function CompanyPlanSyncPanel() {
  const { reloadAll } = useTeachers();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CompanyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(method: 'GET' | 'POST') {
    setRunning(true); setError(null);
    try {
      const res = await fetch('/api/admin/sync-company-plans', { method });
      const raw = await res.text();
      let data: Record<string, unknown> = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch { /* respuesta sin JSON */ }
      if (!res.ok) {
        console.error('[sync-company-plans]', res.status, raw.slice(0, 400));
        throw new Error(typeof data.error === 'string' ? data.error : `Error ${res.status}`);
      }
      setResult(data as unknown as CompanyResult);
      if (method === 'POST') await reloadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo ejecutar la sincronización.');
    } finally {
      setRunning(false);
    }
  }

  const changing = result ? result.activated + result.extended : 0;

  return (
    <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Planes de empresa</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 3, lineHeight: 1.5 }}>
        Lee la duración contratada de la variación (&quot;6 Meses&quot;) y activa al alumno hasta la fecha de fin.
        Nunca acorta una fecha vigente puesta a mano.
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
        <button onClick={() => run('GET')} disabled={running}
          style={{ padding: '10px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: running ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>
          {running ? 'Calculando...' : 'Simular (no escribe nada)'}
        </button>
        <button onClick={() => run('POST')} disabled={running}
          style={{ padding: '10px 16px', borderRadius: 8, border: 'none', background: running ? '#8fc7a0' : '#1E9E3A', color: 'white', cursor: running ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
          {running ? 'Aplicando...' : 'Aplicar fechas de fin'}
        </button>
      </div>

      {error && <div style={{ marginTop: 12, fontSize: 13, color: '#c73a28', lineHeight: 1.5 }}>{error}</div>}

      {result && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: result.applied ? '#1f7a3d' : 'var(--text-secondary)', lineHeight: 1.6 }}>
            {result.applied ? '✅ Aplicado' : '🔍 Simulación'} · {result.scanned} alumno{result.scanned !== 1 ? 's' : ''} de empresa ·{' '}
            {result.activated} activado{result.activated !== 1 ? 's' : ''} · {result.extended} extendido{result.extended !== 1 ? 's' : ''} ·{' '}
            {result.keptManual} con margen manual · {result.unchanged} sin cambios
            {result.errors > 0 && <> · <span style={{ color: '#c73a28' }}>{result.errors} error{result.errors !== 1 ? 'es' : ''}</span></>}
            {!result.applied && changing > 0 && <> — nada escrito todavía.</>}
          </div>

          <div style={{ marginTop: 12, overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 720 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--text-muted)' }}>
                  <th style={{ padding: '6px 8px', fontWeight: 600 }}>Alumno</th>
                  <th style={{ padding: '6px 8px', fontWeight: 600 }}>Duración</th>
                  <th style={{ padding: '6px 8px', fontWeight: 600 }}>Compra</th>
                  <th style={{ padding: '6px 8px', fontWeight: 600 }}>Fin calculado</th>
                  <th style={{ padding: '6px 8px', fontWeight: 600 }}>Antes</th>
                  <th style={{ padding: '6px 8px', fontWeight: 600 }}>Queda</th>
                  <th style={{ padding: '6px 8px', fontWeight: 600 }}>Resultado</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map(r => {
                  const meta = COMPANY_ACTION_META[r.result] ?? COMPANY_ACTION_META.error;
                  return (
                    <tr key={r.id} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '7px 8px', color: 'var(--text-primary)', fontWeight: 600 }}>
                        {r.name}
                        <div style={{ fontWeight: 400, fontSize: 11, color: 'var(--text-muted)' }}>{r.product ?? '—'}</div>
                      </td>
                      <td style={{ padding: '7px 8px', whiteSpace: 'nowrap' }}>{r.months != null ? `${r.months} meses` : '—'}</td>
                      <td style={{ padding: '7px 8px', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>{r.start ?? '—'}</td>
                      <td style={{ padding: '7px 8px', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>{r.computedUntil ?? '—'}</td>
                      <td style={{ padding: '7px 8px', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>{r.currentUntil ?? '(vacío)'}</td>
                      <td style={{ padding: '7px 8px', whiteSpace: 'nowrap', fontWeight: 700, color: 'var(--text-primary)' }}>{r.finalUntil ?? '—'}</td>
                      <td style={{ padding: '7px 8px', whiteSpace: 'nowrap' }}>
                        <span title={r.reason} style={{ display: 'inline-block', padding: '2px 9px', borderRadius: 12, fontSize: 11.5, fontWeight: 700, background: meta.bg, color: meta.color }}>
                          {meta.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
        Solo entra en esta lógica un producto cuyo nombre en WooCommerce diga &quot;Empresas&quot;. Ningún otro plan se activa
        automáticamente, aunque su nombre lleve meses.
      </div>
    </div>
  );
}

// Limpieza de guiones en los textos de IA ya guardados (fichas y análisis).
// Los textos NUEVOS ya salen limpios: las reglas de estilo van en todos los
// system prompts y la respuesta pasa por cleanAiDeep (lib/textCleanup.ts).
// Este botón es solo para lo que quedó guardado antes de ese cambio.
type DashResult = { totalAffected: number; totalUpdated: number; applied: boolean;
  profiles: { scanned: number; affected: number }; analyses: { scanned: number; affected: number } };

function CleanDashesPanel() {
  const [running, setRunning] = useState(false);
  const [preview, setPreview] = useState<DashResult | null>(null);
  const [done, setDone] = useState<DashResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function call(method: 'GET' | 'POST'): Promise<DashResult> {
    const res = await fetch('/api/admin/clean-ai-dashes', { method });
    const raw = await res.text();
    let data: Record<string, unknown> = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { /* respuesta sin JSON */ }
    if (!res.ok) {
      console.error('[clean-ai-dashes] Respuesta', res.status, raw.slice(0, 400));
      throw new Error(typeof data.error === 'string' ? data.error : `Error ${res.status}`);
    }
    return data as unknown as DashResult;
  }

  async function run(method: 'GET' | 'POST') {
    setRunning(true); setError(null);
    try {
      const r = await call(method);
      if (method === 'GET') { setPreview(r); setDone(null); }
      else { setDone(r); setPreview(null); }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo ejecutar la limpieza.');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button
          onClick={() => run('GET')}
          disabled={running}
          style={{ padding: '10px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: running ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}
        >
          {running ? 'Revisando...' : 'Ver cuántos textos tienen guiones'}
        </button>
        <button
          onClick={() => run('POST')}
          disabled={running}
          style={{ padding: '10px 16px', borderRadius: 8, border: 'none', background: running ? '#8fc7a0' : '#1E9E3A', color: 'white', cursor: running ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}
        >
          {running ? 'Limpiando...' : 'Limpiar guiones de textos de IA'}
        </button>
      </div>

      {error && (
        <div style={{ marginTop: 12, fontSize: 13, color: '#c73a28', lineHeight: 1.5 }}>{error}</div>
      )}
      {preview && (
        <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          {preview.totalAffected === 0
            ? 'No hay textos con guiones. Todo limpio.'
            : `${preview.totalAffected} texto${preview.totalAffected !== 1 ? 's' : ''} con guiones: ${preview.profiles.affected} ficha${preview.profiles.affected !== 1 ? 's' : ''} y ${preview.analyses.affected} análisis. Nada modificado todavía.`}
        </div>
      )}
      {done && (
        <div style={{ marginTop: 12, fontSize: 13, color: '#1f7a3d', lineHeight: 1.6 }}>
          Listo: {done.totalUpdated} texto{done.totalUpdated !== 1 ? 's' : ''} actualizado{done.totalUpdated !== 1 ? 's' : ''}
          {' '}({done.profiles.scanned} fichas y {done.analyses.scanned} análisis revisados).
        </div>
      )}
      <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
        No toca las transcripciones: son el texto original de Fathom, no un texto generado.
      </div>
    </div>
  );
}

function AuditPanel() {
  const { students, reloadAll } = useTeachers();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AuditResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const [relinkFor, setRelinkFor] = useState<AuditResult['orphanAssignments'][number] | null>(null);
  const [relinkSearch, setRelinkSearch] = useState('');
  const [mergeFor, setMergeFor] = useState<AuditResult['duplicateEmails'][number] | null>(null);
  const [mergeKeepId, setMergeKeepId] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  useEffect(() => { setReviewed(loadReviewed()); }, []);

  async function runAudit() {
    setRunning(true);
    try { setResult(await dbAuditStudentAssignments()); }
    finally { setRunning(false); }
  }

  async function runSync() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const fixed = await dbSyncStudentAssignments();
      await reloadAll();
      setSyncMsg(fixed > 0 ? `✅ ${fixed} vínculo${fixed === 1 ? '' : 's'} corregido${fixed === 1 ? '' : 's'}` : '✅ Todo sincronizado — no había vínculos rotos');
    } catch {
      setSyncMsg('⚠️ No se pudo sincronizar. Reintentá.');
    } finally {
      setSyncing(false);
    }
  }

  async function withBusy(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try { await fn(); await reloadAll(); await runAudit(); }
    finally { setBusy(null); }
  }

  function toggleReviewed(key: string) {
    setReviewed(prev => {
      const n = new Set(prev);
      n.has(key) ? n.delete(key) : n.add(key);
      saveReviewed(n);
      return n;
    });
  }

  function exportCsv() {
    if (!result) return;
    const rows: string[] = ['Tipo,Detalle 1,Detalle 2,Detalle 3'];
    const q = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    for (const a of result.studentsWithoutAssignment) rows.push(['A - Sin profesor', q(a.name), q(a.email), ''].join(','));
    for (const b of result.orphanAssignments) rows.push(['B - Asignacion sin alumno', q(b.studentName), q(b.studentEmail), q(b.teacherName)].join(','));
    for (const c of result.nameMismatches) rows.push(['C - Nombre inconsistente', q(c.nameStudents), q(c.nameAssignments), q(c.teacherName)].join(','));
    for (const d of result.duplicateEmails) rows.push(['D - Email duplicado', q(d.email), q(d.names), q(d.total)].join(','));
    for (const e of result.multipleAssignments) rows.push(['E - Multiples asignaciones', q(e.studentName), q(e.teachers), q(e.total)].join(','));
    for (const f of result.misplacedStudents) rows.push(['F - Cambio de profesor a medias', q(f.studentName), q(`ficha: ${f.assignedTeacherName}`), q(`calendario: ${f.gridTeacherName}`)].join(','));
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `auditoria_vinculos_${new Date().toISOString().slice(0, 10)}.csv`; link.click();
    URL.revokeObjectURL(url);
  }

  const visibleMultiples = result?.multipleAssignments.filter(m => !reviewed.has(`${m.studentId}|${m.studentName}`)) ?? [];
  const allClean = result &&
    result.studentsWithoutAssignment.length === 0 &&
    result.orphanAssignments.length === 0 &&
    result.nameMismatches.length === 0 &&
    result.duplicateEmails.length === 0 &&
    result.misplacedStudents.length === 0 &&
    visibleMultiples.length === 0;

  const relinkStudents = students.filter(s => {
    const q = relinkSearch.trim().toLowerCase();
    if (!q) return true;
    return s.name.toLowerCase().includes(q) || s.email.toLowerCase().includes(q);
  }).slice(0, 30);

  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginTop: 16 }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Estado actual</span>
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ padding: '0 18px 18px', borderTop: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '14px 0 16px' }}>
            <button onClick={runAudit} disabled={running}
              style={{ padding: '9px 16px', borderRadius: 8, border: 'none', background: '#1E9E3A', color: 'white', cursor: running ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
              {running ? 'Ejecutando...' : '▶ Ejecutar auditoría'}
            </button>
            <button onClick={runSync} disabled={syncing}
              style={{ padding: '9px 16px', borderRadius: 8, border: 'none', background: '#fff', color: '#5f6360', cursor: syncing ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>
              {syncing ? 'Sincronizando...' : '🔄 Sincronizar vínculos'}
            </button>
            {result && (
              <button onClick={exportCsv}
                style={{ padding: '9px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-surface-2)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>
                ⬇ Exportar reporte
              </button>
            )}
          </div>
          {syncMsg && (
            <div style={{ margin: '-6px 0 14px', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{syncMsg}</div>
          )}

          {!result ? (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '8px 0' }}>Ejecutá la auditoría para detectar inconsistencias entre alumnos y asignaciones.</div>
          ) : allClean ? (
            <div style={{ padding: '24px', textAlign: 'center', color: '#1E9E3A', fontSize: 15, fontWeight: 700, background: 'rgba(30,158,58,0.08)', borderRadius: 10 }}>
              ✅ Todo en orden — No se encontraron inconsistencias
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* A */}
              {result.studentsWithoutAssignment.length > 0 && (
                <div style={auditCard}>
                  <div style={auditSectionTitle('#ea580c')}>A · Alumnos sin profesor asignado ({result.studentsWithoutAssignment.length})</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    {result.studentsWithoutAssignment.map(s => (
                      <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, fontSize: 12.5, flexWrap: 'wrap' }}>
                        <span><b style={{ color: 'var(--text-primary)' }}>{s.name}</b> <span style={{ color: 'var(--text-muted)' }}>· {s.email || '—'}</span></span>
                        <button onClick={() => router.push('/setter')} style={auditBtn('#1E9E3A', 'rgba(30,158,58,0.08)', 'rgba(30,158,58,0.4)')}>Asignar profesor →</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* B */}
              {result.orphanAssignments.length > 0 && (
                <div style={auditCard}>
                  <div style={auditSectionTitle('#dc2626')}>B · Asignaciones sin alumno válido ({result.orphanAssignments.length})</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    {result.orphanAssignments.map(b => (
                      <div key={b.assignmentId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, fontSize: 12.5, flexWrap: 'wrap' }}>
                        <span><b style={{ color: 'var(--text-primary)' }}>{b.studentName}</b> <span style={{ color: 'var(--text-muted)' }}>· {b.studentEmail || 'sin email'} · 👨‍🏫 {b.teacherName}</span></span>
                        <button onClick={() => { setRelinkFor(b); setRelinkSearch(b.studentName); }} style={auditBtn('#2563eb', 'rgba(37,99,235,0.08)', 'rgba(37,99,235,0.4)')}>Vincular alumno</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* C */}
              {result.nameMismatches.length > 0 && (
                <div style={auditCard}>
                  <div style={auditSectionTitle('#b45309')}>C · Nombres inconsistentes ({result.nameMismatches.length})</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    {result.nameMismatches.map(c => (
                      <div key={c.assignmentId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, fontSize: 12.5, flexWrap: 'wrap' }}>
                        <span style={{ color: 'var(--text-secondary)' }}>En alumnos: <b style={{ color: 'var(--text-primary)' }}>{c.nameStudents}</b> · En asignación: <b style={{ color: '#b45309' }}>{c.nameAssignments}</b></span>
                        <button disabled={busy === c.assignmentId} onClick={() => withBusy(c.assignmentId, () => dbSyncAssignmentName(c.assignmentId, c.nameStudents))} style={auditBtn('#1E9E3A', 'rgba(30,158,58,0.08)', 'rgba(30,158,58,0.4)')}>
                          {busy === c.assignmentId ? '...' : 'Sincronizar nombre'}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* D */}
              {result.duplicateEmails.length > 0 && (
                <div style={auditCard}>
                  <div style={auditSectionTitle('#7c3aed')}>D · Alumnos duplicados ({result.duplicateEmails.length})</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    {result.duplicateEmails.map(d => (
                      <div key={d.email} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, fontSize: 12.5, flexWrap: 'wrap' }}>
                        <span><b style={{ color: 'var(--text-primary)' }}>{d.email}</b> <span style={{ color: 'var(--text-muted)' }}>· {d.names}</span></span>
                        <button onClick={() => { setMergeFor(d); setMergeKeepId(d.students.find(s => s.hasAssignment)?.id ?? d.students[0].id); }} style={auditBtn('#7c3aed', 'rgba(124,58,237,0.08)', 'rgba(124,58,237,0.4)')}>Fusionar</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* E */}
              {visibleMultiples.length > 0 && (
                <div style={auditCard}>
                  <div style={auditSectionTitle('#2563eb')}>E · Múltiples asignaciones ({visibleMultiples.length})</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 10, fontStyle: 'italic' }}>
                    Algunos alumnos pueden tener clases con más de un profesor (es válido). Revisá si es intencional.
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    {visibleMultiples.map(m => (
                      <div key={`${m.studentId}|${m.studentName}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, fontSize: 12.5, flexWrap: 'wrap' }}>
                        <span><b style={{ color: 'var(--text-primary)' }}>{m.studentName}</b> <span style={{ color: 'var(--text-muted)' }}>· {m.total} profesores: {m.teachers}</span></span>
                        <button onClick={() => toggleReviewed(`${m.studentId}|${m.studentName}`)} style={auditBtn('var(--text-secondary)', 'transparent', 'var(--border)')}>Marcar como revisado</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* F — transferencias que quedaron a medias. Va primero visualmente
                  por color (rojo) porque es la única sección donde el alumno está
                  literalmente en dos sitios distintos según a quién le preguntes. */}
              {result.misplacedStudents.length > 0 && (
                <div style={auditCard}>
                  <div style={auditSectionTitle('#dc2626')}>
                    F · Cambios de profesor a medias ({result.misplacedStudents.length})
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 10, fontStyle: 'italic' }}>
                    La ficha del alumno dice un profesor y el calendario dice otro. Reparar reapunta la ficha
                    al profesor del calendario, con los horarios que ocupa ahí. No se toca ningún calendario.
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                    {result.misplacedStudents.map(m => (
                      <div key={m.assignmentId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, fontSize: 12.5, flexWrap: 'wrap' }}>
                        <span>
                          ⚠️ <b style={{ color: 'var(--text-primary)' }}>{m.studentName}</b>
                          <span style={{ color: 'var(--text-muted)' }}>
                            {' '}· asignada a <b>{m.assignedTeacherName}</b> pero ocupa el calendario
                            de <b>{m.gridTeacherName}</b> ({m.gridSlots.map(s => `${s.day} ${s.hour}`).join(', ')})
                            {m.otherGridTeachers.length > 0 && ` · también en: ${m.otherGridTeachers.join(', ')}`}
                          </span>
                        </span>
                        <button
                          disabled={busy === m.assignmentId}
                          onClick={() => withBusy(m.assignmentId, async () => { await dbRepairMisplacedStudent(m); })}
                          style={auditBtn('#dc2626', 'rgba(239,68,68,0.08)', 'rgba(239,68,68,0.35)')}>
                          {busy === m.assignmentId ? 'Reparando…' : `Reparar → ${m.gridTeacherName}`}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* G — clases de 2h que solo ve una de las dos fuentes. NO hay botón
                  reparación es en un solo sentido: la ficha se pone al día con el
                  calendario, nunca al revés. El calendario es la prueba real de qué
                  clases y horarios existen — si el profesor acuerda otro horario con
                  el alumno, se refleja ahí — así que la ficha es su espejo. */}
              {result.contiguityMismatches.length > 0 && (
                <div style={auditCard}>
                  <div style={auditSectionTitle('#b45309')}>
                    G · Fichas desactualizadas respecto al calendario ({result.contiguityMismatches.length})
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 10, fontStyle: 'italic' }}>
                    El calendario manda: es la prueba real del horario. Estas fichas se quedaron con un horario
                    viejo, y como de la ficha salen la agenda y la duración de la clase (dos horas seguidas se
                    pagan como 2), conviene ponerlas al día antes de liquidar el mes. Reparar copia a la ficha
                    el horario COMPLETO que dice el calendario; no toca ningún calendario.
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                    {result.contiguityMismatches.map(m => {
                      const key = `${m.teacherId}|${m.studentName}`;
                      return (
                        <div key={`${key}|${m.day}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, fontSize: 12.5, lineHeight: 1.6, flexWrap: 'wrap' }}>
                          <span>
                            <b style={{ color: 'var(--text-primary)' }}>{m.studentName}</b>
                            <span style={{ color: 'var(--text-muted)' }}>
                              {' '}· {m.teacherName} · {m.day} · calendario: <b>{m.gridHours.join(' + ')}</b>
                              {' '}({m.gridDuration > 1 ? `sesión de ${m.gridDuration}h` : 'suelta'})
                              {' '}· ficha: <b>{m.slotHours.join(' + ')}</b>
                              {' '}({m.slotDuration > 1 ? `sesión de ${m.slotDuration}h` : 'suelta'})
                            </span>
                          </span>
                          <button
                            disabled={busy === key}
                            onClick={() => withBusy(key, async () => { await dbSyncSlotsFromCalendar(m.teacherId, m.studentName); })}
                            style={auditBtn('#b45309', 'rgba(255,196,0,0.12)', 'rgba(255,196,0,0.5)')}>
                            {busy === key ? 'Actualizando…' : 'Actualizar ficha desde el calendario'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Modal: Vincular alumno (B) */}
      {relinkFor && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget) setRelinkFor(null); }}>
          <div style={{ background: '#F7F7F5', border: '1px solid var(--border)', borderRadius: 16, width: '100%', maxWidth: 460, padding: 24, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: '#111827', marginBottom: 4 }}>Vincular alumno</div>
            <div style={{ fontSize: 12.5, color: '#6b7280', marginBottom: 14 }}>Asignación de <b>{relinkFor.studentName}</b> ({relinkFor.teacherName}). Elegí el alumno real:</div>
            <input value={relinkSearch} onChange={e => setRelinkSearch(e.target.value)} placeholder="Buscar por nombre o email..."
              style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1.5px solid var(--border)', fontSize: 13, background: 'white', color: '#111827', fontFamily: 'inherit', boxSizing: 'border-box', marginBottom: 12 }} />
            <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {relinkStudents.map(s => (
                <button key={s.id} disabled={busy === relinkFor.assignmentId}
                  onClick={() => withBusy(relinkFor.assignmentId, async () => { await dbRelinkAssignment(relinkFor.assignmentId, { id: s.id, name: s.name, email: s.email, level: s.level }); setRelinkFor(null); })}
                  style={{ textAlign: 'left', padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'white', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
                  <b style={{ color: '#111827' }}>{s.name}</b> <span style={{ color: '#6b7280' }}>· {s.email || '—'} · {s.level}</span>
                </button>
              ))}
              {relinkStudents.length === 0 && <div style={{ fontSize: 12, color: '#9ca3af', padding: 8 }}>Sin resultados.</div>}
            </div>
            <button onClick={() => setRelinkFor(null)} style={{ marginTop: 12, padding: '9px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: '#6b7280', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>Cancelar</button>
          </div>
        </div>
      )}

      {/* Modal: Fusionar duplicados (D) */}
      {mergeFor && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget) setMergeFor(null); }}>
          <div style={{ background: '#F7F7F5', border: '1px solid var(--border)', borderRadius: 16, width: '100%', maxWidth: 440, padding: 24 }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: '#111827', marginBottom: 4 }}>Fusionar alumnos duplicados</div>
            <div style={{ fontSize: 12.5, color: '#6b7280', marginBottom: 14 }}>Email <b>{mergeFor.email}</b>. Elegí cuál conservar — las asignaciones del resto se reapuntarán y los duplicados se eliminarán.</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
              {mergeFor.students.map(s => (
                <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 8, border: `1.5px solid ${mergeKeepId === s.id ? '#1E9E3A' : 'var(--border)'}`, background: mergeKeepId === s.id ? 'rgba(30,158,58,0.06)' : 'white', cursor: 'pointer' }}>
                  <input type="radio" checked={mergeKeepId === s.id} onChange={() => setMergeKeepId(s.id)} />
                  <span style={{ fontSize: 13, color: '#111827' }}><b>{s.name}</b>{s.hasAssignment && <span style={{ color: '#1E9E3A', fontWeight: 700 }}> · con asignación</span>}</span>
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setMergeFor(null)} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: '#6b7280', cursor: 'pointer', fontSize: 14, fontFamily: 'inherit' }}>Cancelar</button>
              <button disabled={busy === 'merge'} onClick={() => withBusy('merge', async () => {
                const removeIds = mergeFor.students.filter(s => s.id !== mergeKeepId).map(s => s.id);
                for (const rid of removeIds) await dbMergeDuplicateStudents(mergeKeepId, rid);
                setMergeFor(null);
              })} style={{ flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: '#1E9E3A', color: 'white', cursor: 'pointer', fontSize: 14, fontWeight: 700, fontFamily: 'inherit' }}>
                {busy === 'merge' ? 'Fusionando...' : 'Fusionar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Contenedor colapsable para las herramientas del resumen. Cerrado por defecto:
// son acciones de mantenimiento puntuales, no información de consulta diaria.
function AdminTool({ title, desc, children, openSignal }: {
  title: string; desc: string; children: React.ReactNode;
  /**
   * Cada incremento abre la herramienta y la trae a la vista. Lo usa el contador
   * de "Conflictos" del dashboard: el admin hace clic en el número y aterriza en
   * la lista de casos, en vez de tener que buscar el desplegable a mano.
   */
  openSignal?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openSignal) return;   // 0 / undefined = nadie ha pedido abrirla
    setOpen(true);
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [openSignal]);

  return (
    <div className="adm-card adm-tool" ref={ref}>
      <button className="adm-tool-head" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span className="adm-tool-title">
          {title}
          <span className="adm-tool-desc" style={{ display: 'block' }}>{desc}</span>
        </span>
        <span aria-hidden className={`adm-tool-caret${open ? ' is-open' : ''}`}>▼</span>
      </button>
      {open && <div className="adm-tool-body">{children}</div>}
    </div>
  );
}

/**
 * Un tipo de conflicto del dashboard, con sus casos concretos. El detalle vive
 * acá y no solo en el contador porque un número suelto ("6 conflictos") no le
 * dice al admin ni qué pasa ni a quién le pasa.
 */
interface ConflictGroup {
  label: string;
  help: string;
  items: Array<{ main: string; detail: string }>;
}

/**
 * Detalle de los conflictos: QUÉ pasa, a QUÉ alumno y con QUÉ profesor. El
 * contador del dashboard abre todos los grupos; cada alerta abre el suyo.
 * Solo informa — las acciones de reparación viven en la Auditoría de vínculos,
 * a la que se llega con el botón del pie.
 */
function ConflictDetailModal({ groups, onClose, onOpenAudit }: {
  groups: ConflictGroup[];
  onClose: () => void;
  onOpenAudit: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const total = groups.reduce((s, g) => s + g.items.length, 0);

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)', zIndex: 95, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog" aria-modal="true" aria-label="Detalle de conflictos"
    >
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 16, width: '100%', maxWidth: 620, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 22px 14px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
              {groups.length === 1 ? groups[0].label : 'Conflictos detectados'}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>
              {total} caso{total !== 1 ? 's' : ''} que requieren revisión
            </div>
          </div>
          <button onClick={onClose} aria-label="Cerrar"
            style={{ marginLeft: 'auto', background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: 'var(--text-muted)', lineHeight: 1 }}>
            ✕
          </button>
        </div>

        <div style={{ overflowY: 'auto', padding: '6px 22px 18px' }}>
          {groups.map(g => (
            <div key={g.label} style={{ marginTop: 16 }}>
              {groups.length > 1 && (
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                  {g.label} <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>· {g.items.length}</span>
                </div>
              )}
              <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.55, margin: '4px 0 10px' }}>{g.help}</div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {g.items.map((it, i) => (
                  <div key={i} style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>{it.main}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.5 }}>{it.detail}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 10, padding: '14px 22px', borderTop: '1px solid var(--border)' }}>
          <button onClick={onClose}
            style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
            Cerrar
          </button>
          <button onClick={onOpenAudit}
            style={{ flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: '#1E9E3A', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
            Abrir la auditoría para repararlos
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Piezas visuales ─────────────────────────────────────────────────────────

const TONO = {
  rojo:     { fg: '#B42318', bg: 'rgba(220,74,56,0.08)', bd: 'rgba(220,74,56,0.30)' },
  aviso:    { fg: '#8a6d00', bg: 'rgba(255,196,0,0.12)', bd: 'rgba(255,196,0,0.45)' },
  ok:       { fg: '#167A2D', bg: 'var(--bg-surface)',    bd: 'var(--border)' },
} as const;
type Tono = keyof typeof TONO;

const eur = (n: number) => `${Math.round(n).toLocaleString('es-ES')} €`;

/** Cabecera de sección, con su enlace al detalle. */
function SecHead({ title, sub, href, cta = 'Ver detalle' }: {
  title: string; sub?: string; href?: string; cta?: string;
}) {
  return (
    <div className="dsh-sechead">
      <div>
        <h2 className="dsh-h2">{title}</h2>
        {sub && <p className="dsh-sub">{sub}</p>}
      </div>
      {href && <Link href={href} className="dsh-link">{cta} ›</Link>}
    </div>
  );
}

/**
 * Una cola que espera a alguien.
 *
 * A cero se apaga —fondo blanco y guion en vez del número— en lugar de
 * desaparecer: que la tarjeta esté siempre en el mismo sitio es lo que permite
 * mirar la fila entera de un vistazo y ver que no hay nada pendiente. Si
 * apareciera y desapareciera, habría que leerlas todas cada vez.
 */
function Accion({ n, label, detalle, tono, href, onClick, cargando }: {
  n: number | null; label: string; detalle: string; tono: Tono;
  href?: string; onClick?: () => void; cargando?: boolean;
}) {
  const vacio = n === 0;
  const t = vacio ? TONO.ok : TONO[tono];
  const inner = (
    <>
      <div className="dsh-accion-n" style={{ color: vacio || n == null ? 'var(--text-muted)' : t.fg }}>
        {cargando ? '·' : vacio ? '—' : n}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="dsh-accion-l">{label}</div>
        <div className="dsh-accion-d">{cargando ? 'Cargando…' : vacio ? 'Nada pendiente' : detalle}</div>
      </div>
      <span aria-hidden className="dsh-chev">›</span>
    </>
  );
  const style = { background: vacio ? 'var(--bg-surface)' : t.bg, borderColor: vacio ? 'var(--border)' : t.bd };

  if (onClick) {
    return <button type="button" className="dsh-accion" style={style} onClick={onClick}>{inner}</button>;
  }
  return <Link href={href ?? '#'} className="dsh-accion" style={style}>{inner}</Link>;
}

function Barra({ pct, color = '#1E9E3A' }: { pct: number; color?: string }) {
  return (
    <div className="dsh-track" aria-hidden>
      <div className="dsh-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: color }} />
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export default function DashboardGeneral() {
  const {
    teachers, students, assignments,
    classRecords, classJoinLogs, classAnalyses,
    financeRates, financePayments, scoringEvents, manualApprovals,
  } = useTeachers();
  const router = useRouter();

  // ── Lo que no está en memoria ──────────────────────────────────────────────
  // Cinco lecturas ligeras, una sola vez. El resto de la pantalla se pinta sin
  // esperarlas: hasta que llegan, sus tarjetas muestran "·".
  const [extras, setExtras] = useState<DashboardExtras | null>(null);
  useEffect(() => {
    let cancelado = false;
    loadDashboardExtras().then(e => { if (!cancelado) setExtras(e); }).catch(() => {});
    return () => { cancelado = true; };
  }, []);

  // El "ahora" se congela al montar. Leerlo en cada render haría que las fechas
  // se movieran solas entre renders, y el linter de pureza lo prohíbe con razón.
  const [ahora] = useState(() => new Date());
  const mes = monthKey(ahora);
  const semana = weekRange(ahora);
  const hoyIso = madridDateString(ahora);

  // ── Conflictos REALES ──────────────────────────────────────────────────────
  // Hasta ahora este contador salía de `mockAlerts`, un array fijo de lib/mock-data:
  // decía "2" pasara lo que pasara en la academia. Ahora sale de la auditoría de
  // vínculos, que es la que sabe de verdad qué está descuadrado.
  //
  // Se carga en segundo plano (lee todos los calendarios) y hasta que llega se
  // muestra "·" en vez de 0: un cero mientras carga sería otra forma de mentir.
  const [audit, setAudit] = useState<AuditResult | null>(null);
  useEffect(() => { dbAuditStudentAssignments().then(setAudit).catch(() => {}); }, []);

  /**
   * Qué cuenta como conflicto. Se EXCLUYE `multipleAssignments`: un alumno con
   * dos profesores es válido en la academia (la propia auditoría lo dice y ofrece
   * marcarlo como revisado), así que contarlo daría un número siempre alto que
   * nadie miraría.
   */
  const conflictGroups: ConflictGroup[] = audit ? [
    {
      label: 'Alumnos sin asignación',
      help: 'Están en la tabla de alumnos pero no tienen ninguna asignación con un profesor, así que no aparecen en ninguna agenda.',
      items: audit.studentsWithoutAssignment.map(s => ({ main: s.name, detail: s.email || 'sin email' })),
    },
    {
      label: 'Asignaciones huérfanas',
      help: 'La asignación apunta a un alumno que ya no existe en la tabla de alumnos.',
      items: audit.orphanAssignments.map(a => ({ main: a.studentName, detail: `profe ${a.teacherName} · alumno inexistente (${a.studentId})` })),
    },
    {
      label: 'Nombres desincronizados',
      help: 'El nombre del alumno en su ficha y en la asignación no coinciden. El cruce por nombre (transcripts, calendario) puede fallar.',
      items: audit.nameMismatches.map(m => ({ main: m.nameStudents, detail: `en la asignación figura como "${m.nameAssignments}" · profe ${m.teacherName}` })),
    },
    {
      label: 'Alumnos duplicados',
      help: 'Dos o más fichas de alumno con el mismo email: las clases se reparten entre ellas y ninguna refleja el total.',
      items: audit.duplicateEmails.map(d => ({ main: d.email, detail: `${d.total} fichas: ${d.names}` })),
    },
    {
      label: 'Cambios de profesor a medias',
      help: 'La ficha del alumno dice un profesor y el calendario dice otro: una transferencia que quedó sin terminar.',
      items: audit.misplacedStudents.map(m => ({
        main: m.studentName,
        detail: `ficha: ${m.assignedTeacherName} · calendario: ${m.gridTeacherName} (${m.gridSlots.map(s => `${s.day} ${s.hour}`).join(', ')})`,
      })),
    },
    {
      label: 'Fichas desactualizadas respecto al calendario',
      help: 'El calendario manda: es la prueba real del horario. Estas fichas se quedaron con uno viejo, y de la ficha salen la agenda y la duración de la clase (dos horas seguidas se pagan como 2). Se arreglan desde la auditoría, copiando el horario del calendario a la ficha.',
      items: audit.contiguityMismatches.map(m => ({
        main: `${m.studentName} · ${m.teacherName} · ${m.day}`,
        detail: `calendario ${m.gridHours.join(' + ')} (${m.gridDuration}h) · ficha ${m.slotHours.join(' + ')} (${m.slotDuration}h)` +
          ` → hoy se paga como ${m.slotDuration}; según el calendario debería ser ${m.gridDuration}`,
      })),
    },
  ].filter(g => g.items.length > 0) : [];
  const conflicts = audit ? conflictGroups.reduce((s, g) => s + g.items.length, 0) : null;

  /**
   * Grupos cuyo detalle se está mirando (null = modal cerrado). Es una lista y no
   * un grupo suelto porque el contador de Conflictos abre TODOS y cada alerta
   * abre el suyo, con el mismo modal.
   */
  const [conflictDetail, setConflictDetail] = useState<ConflictGroup[] | null>(null);

  // Abre la Auditoría de vínculos y la trae a la vista (contador "Conflictos").
  const [auditSignal, setAuditSignal] = useState(0);

  // ── Los números ────────────────────────────────────────────────────────────
  // Todo esto sale de lo que el contexto ya tiene cargado. Ni una consulta.
  const alumnos = alumnosResumen(students, assignments);
  const ocup = ocupacionDe(teachers);
  const op = operacionDelMes(classRecords, mes);
  const clasesSemana = clasesEnRango(classRecords, semana);
  const programadas = clasesProgramadasSemana(assignments);
  const faltasProfe = faltasProfesorDelMes(scoringEvents, mes);
  const profesActivos = teachers.filter(t => t.status !== 'vacation').length;

  // Sin useMemo a propósito: el proyecto compila con el compilador de React, que
  // memoiza esto solo. Un useMemo escrito a mano se lo impide — el linter lo
  // señala como "Existing memoization could not be preserved".
  const pendientes = transcriptsPendientes(classJoinLogs, classAnalyses, { hoy: hoyIso });

  const filas = filasProfesores({
    teachers, records: classRecords, mes,
    pendientes, teacherIdsConIA: extras?.teacherIdsConIA ?? VACIO_IDS,
  });

  const riesgo = riesgoResumen(extras?.risk ?? []);
  const urgentes = (extras?.risk ?? [])
    .filter(esRiesgoRojo)
    .slice(0, 5)
    .map(r => ({
      alumno: r.student_name ?? '—',
      profe: teachers.find(t => t.id === r.teacher_id)?.name ?? '—',
      causa: (r.risk_explanation ?? '').trim() || 'Sin explicación registrada',
      dias: r.risk_updated_at ? diasEntre(r.risk_updated_at.slice(0, 10), hoyIso) : null,
    }));

  // ── Finanzas ───────────────────────────────────────────────────────────────
  // MISMAS entradas que /finanzas y que la vista del profesor. Si esta llamada y
  // esa no reciben lo mismo, el dashboard y la liquidación dirían cosas distintas
  // del mismo mes.
  // Una sola pasada por profesor: `calculateTeacherFinance` es lo más caro de la
  // pantalla y llamarlo cuatro veces por cada uno, una por importe, era pagar el
  // cálculo entero cuatro veces.
  const finanzas = (() => {
    let total = 0, pagable = 0, aRevisar = 0, retenido = 0, pagados = 0;
    for (const t of teachers) {
      const payment = financePayments.find(p => p.teacherId === t.id && p.monthYear === mes) ?? null;
      const r = calculateTeacherFinance({
        teacherId: t.id, teacherName: t.name, monthYear: mes,
        assignments, joinLogs: classJoinLogs, classRecords, classAnalyses,
        rates: financeRates, scoringEvents, students, manualApprovals, payment,
        gridOccupancy: gridOccupancyOfTeacher(t),
      });
      total += r.totalAPagar;
      pagable += r.montoPagable;
      aRevisar += r.montoARevisar;
      retenido += r.montoRetenido;
      if (r.paymentStatus === 'paid') pagados += 1;
    }
    return { total, pagable, aRevisar, retenido, pagados };
  })();

  // ── Emails de presentación ─────────────────────────────────────────────────
  const nowMs = ahora.getTime();
  const presStatuses = assignments.filter(a => !a.presentationEmailSent).map(a => getPresentationEmailStatus(a, nowMs));
  const presOnTime  = presStatuses.filter(s => s.status === 'on_time' || s.status === 'warning').length;
  const presAtRisk  = presStatuses.filter(s => s.status === 'at_risk').length;
  const presOverdue = presStatuses.filter(s => s.status === 'overdue').length;

  const cargandoExtras = extras == null;
  const pctSemana = programadas > 0 ? Math.round((clasesSemana / programadas) * 100) : 0;
  const tonoOc = tonoOcupacion(ocup.pct);

  const kpis = [
    { label: 'Alumnos con clase', valor: String(alumnos.conClase), pie: `de ${alumnos.total} en la base` },
    { label: 'Profesores activos', valor: String(profesActivos), pie: `de ${teachers.length}` },
    { label: 'Clases esta semana', valor: String(clasesSemana), pie: `${programadas} programadas · ${pctSemana}%` },
    { label: 'Coste profesores', valor: eur(finanzas.total), pie: `del mes en curso` },
    {
      label: 'Ocupación', valor: `${ocup.pct} %`,
      pie: `${ocup.ocupados} de ${ocup.total} horas`,
      barra: ocup.pct,
      color: tonoOc === 'ok' ? '#1E9E3A' : tonoOc === 'aviso' ? '#FFC400' : '#dc4a38',
    },
  ];

  // ── Lo que ve el teléfono ──────────────────────────────────────────────────
  // Los mismos números de arriba, empaquetados, más dos que el escritorio no
  // muestra y salen de reglas PROVISIONALES (lib/dashboardMetrics, al final):
  // el origen del acceso sin consultar Woo y las altas por primera asignación.
  // Las colas de "Requiere acción" NO van al teléfono (pedido del admin).
  const datos: DashboardDatos = {
    ahora, cargandoExtras,
    alumnos: { conClase: alumnos.conClase, total: alumnos.total },
    origen: origenDeActivos(students, assignments, hoyIso),
    movimiento: movimientoMensual(assignments, extras?.dropouts ?? [], mes),
    finanzas: { total: finanzas.total, pagable: finanzas.pagable, pendiente: finanzas.aRevisar + finanzas.retenido },
    semana, clasesSemana, programadas,
    faltasSinAvisoMes: op.faltasSinAviso,
    riesgo, urgentes,
    solicitudesRevision: extras?.solicitudesRevision ?? null,
  };

  return (
    <>
      {/* Escritorio y tablet: la rejilla. */}
      <div className="dsh-desk">
      {/* ── Indicadores ── */}
      <div className="dsh-kpis">
        {kpis.map(k => (
          <div key={k.label} className="dsh-kpi">
            <div className="dsh-kpi-l">{k.label}</div>
            <div className="dsh-kpi-v">{k.valor}</div>
            {k.barra != null && <Barra pct={k.barra} color={k.color} />}
            <div className="dsh-kpi-p">{k.pie}</div>
          </div>
        ))}
      </div>

      {/* ── Requiere acción ── */}
      <section className="dsh-sec">
        <SecHead title="Requiere acción hoy" sub="Las colas que esperan a alguien. A cero se apagan, pero no se mueven de sitio." />
        <div className="dsh-acciones">
          <Accion n={extras?.validaciones.total ?? null} cargando={cargandoExtras}
            label="Validaciones pendientes" tono="rojo"
            detalle={extras && extras.validaciones.oldestDays > 0 ? `la más antigua, ${extras.validaciones.oldestDays} días` : 'esperando revisión'}
            href="/admin?tab=validacion" />

          <Accion n={presOverdue} label="Emails de presentación tarde" tono="rojo"
            detalle="más de 24 h sin enviar" href="/admin?tab=emails&filter=overdue" />

          <Accion n={riesgo.sinAtender} cargando={cargandoExtras}
            label="Alumnos en riesgo" tono="rojo"
            detalle="sin intervención registrada" href="/admin?tab=ai" />

          {/* A Finanzas y no a Seguimiento: esa pestaña es de hitos (clase 15, 30),
              no de transcripts. Donde se ven clase a clase es en el embudo de
              cada profesor, que además explica por qué no suman todavía. */}
          <Accion n={pendientes.length} label="Transcripts sin subir" tono="aviso"
            detalle={pendientes.length > 0 ? `el más viejo, hace ${pendientes[0].dias} días` : ''}
            href="/finanzas" />

          <Accion n={extras?.solicitudesRevision ?? null} cargando={cargandoExtras}
            label="Solicitudes de revisión" tono="aviso"
            detalle="clases que el profe no cobra" href="/finanzas" />

          <Accion n={presAtRisk} label="Emails en riesgo" tono="aviso"
            detalle="más de 12 h sin enviar" href="/admin?tab=emails&filter=at_risk" />

          <Accion n={conflicts} cargando={audit == null}
            label="Conflictos de datos" tono="aviso"
            detalle={conflictGroups.length > 0 ? `${conflictGroups.length} tipos distintos` : ''}
            onClick={() => conflicts ? setConflictDetail(conflictGroups) : setAuditSignal(n => n + 1)} />

          <Accion n={extras?.analisisFallidos ?? null} cargando={cargandoExtras}
            label="Análisis de IA fallidos" tono="aviso"
            detalle="sin reintentar" href="/admin?tab=validacion" />
        </div>
      </section>

      {/* ── Riesgo ── */}
      <section className="dsh-sec">
        <SecHead title="Riesgo de baja"
          sub="La IA clasifica cada clase en verde o rojo. No hay nivel intermedio."
          href="/admin?tab=ai" />
        <div className="dsh-g-risk">
          <div className="adm-card dsh-card">
            <div className="dsh-cardhead">Reparto</div>
            {cargandoExtras ? <div className="dsh-vacio">Cargando…</div> : riesgo.rojo + riesgo.verde === 0 ? (
              <div className="dsh-vacio">Todavía no hay clases analizadas.</div>
            ) : (
              <>
                <div style={{ textAlign: 'center', padding: '6px 0 2px' }}>
                  <div className="dsh-risk-big">{riesgo.rojo}</div>
                  <div className="dsh-risk-cap">
                    en rojo · {Math.round((riesgo.rojo / (riesgo.rojo + riesgo.verde)) * 100)}% de los analizados
                  </div>
                </div>
                <div className="dsh-stack" style={{ marginTop: 14 }} aria-hidden>
                  <div className="dsh-seg" style={{ width: `${(riesgo.verde / (riesgo.rojo + riesgo.verde)) * 100}%`, background: '#1E9E3A' }} />
                  <div className="dsh-seg" style={{ width: `${(riesgo.rojo / (riesgo.rojo + riesgo.verde)) * 100}%`, background: '#dc4a38' }} />
                </div>
                <ul className="dsh-list" style={{ marginTop: 10 }}>
                  <li className="dsh-row"><span className="adm-dot" style={{ background: '#1E9E3A' }} /><span className="dsh-row-l">Sin señales</span><span className="dsh-row-n">{riesgo.verde}</span></li>
                  <li className="dsh-row"><span className="adm-dot" style={{ background: '#dc4a38' }} /><span className="dsh-row-l">Con alerta</span><span className="dsh-row-n">{riesgo.rojo}</span></li>
                </ul>
              </>
            )}
          </div>

          <div className="adm-card dsh-card">
            <div className="dsh-cardhead">Los más urgentes</div>
            {cargandoExtras ? <div className="dsh-vacio">Cargando…</div> : urgentes.length === 0 ? (
              <div className="dsh-vacio">Ningún alumno en rojo.</div>
            ) : (
              <ul className="dsh-urg">
                {urgentes.map((u, i) => (
                  <li key={`${u.alumno}-${i}`} className="dsh-urow">
                    <span className="adm-dot" style={{ background: '#dc4a38', marginTop: 6 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="dsh-uname">{u.alumno}</div>
                      <div className="dsh-ucausa">{u.causa}</div>
                    </div>
                    <div className="dsh-umeta">
                      {u.profe}
                      {u.dias != null && <div className="dsh-udias">hace {u.dias} d</div>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      {/* ── Operación ── */}
      <section className="dsh-sec">
        <SecHead title="Operación de clases" sub="Esta semana y lo que arrastra el mes." href="/admin?tab=classlog" />
        <div className="dsh-g3">
          <div className="adm-card dsh-card">
            <div className="dsh-cardhead">Dadas esta semana</div>
            <div className="dsh-big">{clasesSemana}<span className="dsh-of"> / {programadas}</span></div>
            <Barra pct={pctSemana} />
            <p className="dsh-note">
              {pctSemana}% de lo que el calendario tiene previsto. Del {semana.from.slice(8)} al {semana.to.slice(8)}.
            </p>
          </div>

          <div className="adm-card dsh-card">
            <div className="dsh-cardhead">Del mes</div>
            <ul className="dsh-list">
              <li className="dsh-row"><span className="adm-dot" style={{ background: '#1E9E3A' }} /><span className="dsh-row-l">Clases dadas</span><span className="dsh-row-n">{op.dadas}</span></li>
              <li className="dsh-row"><span className="adm-dot" style={{ background: '#dc4a38' }} /><span className="dsh-row-l">Faltas del alumno sin aviso</span><span className="dsh-row-n">{op.faltasSinAviso}</span></li>
              <li className="dsh-row"><span className="adm-dot" style={{ background: '#dc4a38' }} /><span className="dsh-row-l">Cancelaciones del profesor</span><span className="dsh-row-n">{faltasProfe}</span></li>
              <li className="dsh-row"><span className="adm-dot" style={{ background: '#FFC400' }} /><span className="dsh-row-l">Pendientes de recuperar</span><span className="dsh-row-n">{op.recuperacionesPendientes}</span></li>
            </ul>
          </div>

          <div className="adm-card dsh-card">
            <div className="dsh-cardhead">Bajas y recuperaciones</div>
            <ul className="dsh-list">
              <li className="dsh-row"><span className="adm-dot" style={{ background: '#dc4a38' }} /><span className="dsh-row-l">Bajas este mes</span><span className="dsh-row-n">{cargandoExtras ? '·' : bajasDelMes(extras.dropouts, mes)}</span></li>
              <li className="dsh-row"><span className="adm-dot" style={{ background: '#2563eb' }} /><span className="dsh-row-l">Recuperaciones dadas</span><span className="dsh-row-n">{op.recuperaciones}</span></li>
              <li className="dsh-row"><span className="adm-dot" style={{ background: 'var(--text-muted)' }} /><span className="dsh-row-l">Clases que no se dieron</span><span className="dsh-row-n">{op.noDadas}</span></li>
            </ul>
            <p className="dsh-note">Una falta sin aviso no cuenta como pendiente de recuperar: se le cobró al alumno.</p>
          </div>
        </div>
      </section>

      {/* ── Profesores ── */}
      <section className="dsh-sec">
        <SecHead title="Profesores" sub="Carga del mes, cupos y quién arrastra transcripts." href="/admin?tab=teachers" />
        <div className="dsh-g-prof">
          <div className="adm-card dsh-card">
            <div className="dsh-cardhead">Clases del mes</div>
            {filas.length === 0 ? <div className="dsh-vacio">Sin profesores.</div> : (
              <ul className="dsh-rank">
                {filas.slice(0, 8).map(f => (
                  <li key={f.teacherId} className="dsh-rrow">
                    <span className="dsh-rname">{f.teacherName}</span>
                    <span className="dsh-rtrack">
                      <span className="dsh-rfill" style={{ width: `${filas[0].clases > 0 ? (f.clases / filas[0].clases) * 100 : 0}%` }} />
                    </span>
                    <span className="dsh-rn">{f.clases}</span>
                    <span className="dsh-tags">
                      {f.cuposLibres > 0 && <span className="dsh-tag dsh-tag-ok">{f.cuposLibres} libres</span>}
                      {f.transcriptsPendientes > 0 && <span className="dsh-tag dsh-tag-w">{f.transcriptsPendientes} sin subir</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="adm-card dsh-card">
            <div className="dsh-cardhead">
              Uso de la IA
              <Link href="/admin?tab=aiusage" className="dsh-link" style={{ marginLeft: 'auto', fontSize: 12 }}>Ver detalle ›</Link>
            </div>
            {cargandoExtras ? <div className="dsh-vacio">Cargando…</div> : (() => {
              const usan = filas.filter(f => f.usaIA).length;
              return (
                <>
                  <div className="dsh-big">{usan}<span className="dsh-of"> / {filas.length}</span></div>
                  <Barra pct={filas.length > 0 ? (usan / filas.length) * 100 : 0} />
                  <p className="dsh-note">
                    Profesores que han generado alguna clase con IA.
                    {filas.length - usan > 0 && ` Los ${filas.length - usan} restantes no han usado la herramienta.`}
                  </p>
                </>
              );
            })()}
          </div>
        </div>
      </section>

      {/* ── Finanzas ── */}
      <section className="dsh-sec">
        <SecHead title="Finanzas del mes" sub="Lo que se le debe a los profesores." href="/finanzas" />
        <div className="dsh-g3">
          <div className="adm-card dsh-card">
            <div className="dsh-cardhead">Total a pagar</div>
            <div className="dsh-fin-big">{eur(finanzas.total)}</div>
            <p className="dsh-note">Incluye bonus y penalizaciones del mes.</p>
          </div>

          <div className="adm-card dsh-card">
            <div className="dsh-cardhead">En qué estado está</div>
            {(() => {
              const t = finanzas.pagable + finanzas.aRevisar + finanzas.retenido;
              const w = (n: number) => (t > 0 ? (n / t) * 100 : 0);
              return (
                <>
                  <div className="dsh-stack" aria-hidden>
                    <div className="dsh-seg" style={{ width: `${w(finanzas.pagable)}%`, background: '#1E9E3A' }} />
                    <div className="dsh-seg" style={{ width: `${w(finanzas.aRevisar)}%`, background: '#FFC400' }} />
                    <div className="dsh-seg" style={{ width: `${w(finanzas.retenido)}%`, background: '#C8C8C0' }} />
                  </div>
                  <ul className="dsh-list">
                    <li className="dsh-row"><span className="adm-dot" style={{ background: '#1E9E3A' }} /><span className="dsh-row-l">Pagable</span><span className="dsh-row-n">{eur(finanzas.pagable)}</span></li>
                    <li className="dsh-row"><span className="adm-dot" style={{ background: '#FFC400' }} /><span className="dsh-row-l">A revisar</span><span className="dsh-row-n">{eur(finanzas.aRevisar)}</span></li>
                    <li className="dsh-row"><span className="adm-dot" style={{ background: '#C8C8C0' }} /><span className="dsh-row-l">Retenido</span><span className="dsh-row-n">{eur(finanzas.retenido)}</span></li>
                  </ul>
                  <p className="dsh-note">«A revisar» son clases esperando validación: hasta que se resuelvan, el profesor no cobra.</p>
                </>
              );
            })()}
          </div>

          <div className="adm-card dsh-card">
            <div className="dsh-cardhead">Pagos hechos</div>
            <div className="dsh-big">{finanzas.pagados}<span className="dsh-of"> / {teachers.length}</span></div>
            <Barra pct={teachers.length > 0 ? (finanzas.pagados / teachers.length) * 100 : 0} />
            <p className="dsh-note">Profesores marcados como pagados este mes.</p>
          </div>
        </div>
      </section>

      {/* ── Emails de presentación ── */}
      <section className="dsh-sec">
        <SecHead title="Emails de presentación"
          sub={`${presStatuses.length} pendiente${presStatuses.length !== 1 ? 's' : ''} de enviar.`}
          href="/admin?tab=emails" />
        <div className="adm-tiles">
          {[
            { label: 'Pendientes a tiempo',    value: presOnTime,  tone: 'is-ok',    dot: '#16a34a', filter: 'pending' },
            { label: 'En riesgo (>12h)',       value: presAtRisk,  tone: 'is-warn',  dot: '#e0912f', filter: 'at_risk' },
            { label: 'Fuera de tiempo (>24h)', value: presOverdue, tone: 'is-alert', dot: '#dc4a38', filter: 'overdue' },
          ].map(c => (
            <button key={c.label} type="button" className={`adm-tile ${c.tone} is-clickable`}
              onClick={() => router.push(`/admin?tab=emails&filter=${c.filter}`, { scroll: true })}
              title={`Ver ${c.label.toLowerCase()} en la pestaña Emails`}>
              <div className="adm-tile-value"><span className="adm-dot" style={{ background: c.dot }} />{c.value}</div>
              <div className="adm-tile-label">{c.label}<span aria-hidden className="adm-kpi-arrow">›</span></div>
            </button>
          ))}
        </div>
      </section>

      </div>

      {/* Teléfono: secciones plegables y navegación inferior. Mismos números. */}
      <div className="dsh-mob">
        <DashboardMovil datos={datos} />
      </div>

      {/* ── Herramientas ── Se montan una vez; en el teléfono no se muestran. */}
      <section className="dsh-sec dsh-tools" id="herramientas">
        <SecHead title="Herramientas de mantenimiento"
          sub="Auditorías y sincronizaciones que se lanzan a mano. Abrí solo la que necesites." />
        <div className="adm-tools">
          <AdminTool title="Auditoría de vínculos"
            desc="Revisa la coherencia entre alumnos, asignaciones y fichas."
            openSignal={auditSignal}>
            <AuditPanel />
          </AdminTool>

          <AdminTool title="Sincronización calendario ↔ asignaciones"
            desc="Detecta alumnos en el calendario sin assignment ni registro.">
            <SyncPanel />
          </AdminTool>

          {/* Los dos paneles de Woo viven juntos: son la misma tarea. */}
          <AdminTool title="Sincronización con WooCommerce"
            desc="Actualiza planes y fechas de inicio con los datos reales de Woo.">
            <PlanSyncPanel />
            <StartDateSyncPanel />
            <CompanyPlanSyncPanel />
          </AdminTool>

          <AdminTool title="Estilo de los textos de IA"
            desc="Quita los guiones que la IA usaba como conectores en fichas y análisis ya guardados.">
            <CleanDashesPanel />
          </AdminTool>
        </div>
      </section>

      {conflictDetail && (
        <ConflictDetailModal
          groups={conflictDetail}
          onClose={() => setConflictDetail(null)}
          onOpenAudit={() => { setConflictDetail(null); setAuditSignal(n => n + 1); }}
        />
      )}

      <style>{ESTILOS}</style>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Estilos propios del dashboard, con prefijo `dsh-`. Las tarjetas y los tiles
// reutilizan las clases `adm-*` que ya existen; esto es solo lo que el Resumen
// viejo no tenía. Colores: el verde de marca #1E9E3A para superficies y barras,
// y --accent (#167A2D) para texto y enlaces, que es el que llega al contraste
// mínimo en tamaño pequeño.
// ─────────────────────────────────────────────────────────────────────────────

const ESTILOS = `
/* ── Qué vista se ve. 768 px es el corte: debajo, la de teléfono. ── */
.dsh-mob { display: none; }
@media (max-width: 767.98px) {
  .dsh-desk { display: none; }
  .dsh-mob { display: block; }
  /* El título "Dashboard" de la página sobra en el teléfono: la fecha va en su lugar. */
  .dsh-head { display: none; }
  /* Las herramientas de mantenimiento son de escritorio. */
  .dsh-tools { display: none; }
}

.dsh-kpis { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 30px; }
.dsh-kpi { background: var(--bg-surface); border: 1px solid #e6e7e2; border-radius: 14px; padding: 14px 16px 15px; }
.dsh-kpi-l { font-size: 11.5px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--text-muted); }
.dsh-kpi-v { font-size: 27px; font-weight: 700; line-height: 1.15; margin-top: 5px; color: var(--text-primary); }
.dsh-kpi-p { font-size: 11.5px; color: var(--text-muted); margin-top: 4px; }

.dsh-track { height: 6px; border-radius: 3px; background: var(--bg-surface-3); overflow: hidden; margin-top: 8px; }
.dsh-fill { height: 100%; border-radius: 3px; }

.dsh-sec { margin-bottom: 34px; }
.dsh-sechead { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
.dsh-h2 { font-size: 17px; font-weight: 700; margin: 0; letter-spacing: -0.01em; color: var(--text-primary); }
.dsh-sub { margin: 2px 0 0; font-size: 13px; color: var(--text-muted); }
.dsh-link { font-size: 13px; font-weight: 600; color: var(--accent); text-decoration: none; white-space: nowrap; }
.dsh-link:hover { color: var(--accent-hover); text-decoration: underline; }

.dsh-card { padding: 16px 18px 18px; display: flex; flex-direction: column; }
.dsh-cardhead { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 700; letter-spacing: 0.045em; text-transform: uppercase; color: var(--text-muted); margin-bottom: 12px; }
.dsh-note { margin: 10px 0 0; font-size: 11.5px; color: var(--text-muted); line-height: 1.5; }
.dsh-vacio { padding: 18px 0; text-align: center; font-size: 13px; color: var(--text-muted); }

.dsh-acciones { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.dsh-accion { display: flex; align-items: center; gap: 12px; border: 1px solid; border-radius: 12px; padding: 13px 14px; text-decoration: none; color: inherit; text-align: left; font-family: inherit; cursor: pointer; transition: transform 0.12s ease; }
.dsh-accion:hover { transform: translateY(-1px); }
.dsh-accion-n { font-size: 26px; font-weight: 700; line-height: 1; min-width: 34px; }
.dsh-accion-l { font-size: 13px; font-weight: 600; color: var(--text-primary); line-height: 1.3; }
.dsh-accion-d { font-size: 11.5px; color: var(--text-muted); margin-top: 2px; }
.dsh-chev { color: var(--text-muted); font-size: 17px; }

.dsh-g3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
.dsh-g-risk { display: grid; grid-template-columns: 1fr 1.6fr; gap: 14px; }
.dsh-g-prof { display: grid; grid-template-columns: 1.7fr 1fr; gap: 14px; }

.dsh-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 9px; }
.dsh-row { display: flex; align-items: center; gap: 9px; font-size: 13px; }
.dsh-row-l { color: var(--text-secondary); }
.dsh-row-n { margin-left: auto; font-weight: 700; color: var(--text-primary); }

.dsh-stack { display: flex; height: 10px; border-radius: 5px; overflow: hidden; gap: 2px; margin-bottom: 12px; }
.dsh-seg { height: 100%; }

.dsh-risk-big { font-size: 42px; font-weight: 700; line-height: 1; color: #B42318; }
.dsh-risk-cap { font-size: 12.5px; color: var(--text-muted); margin-top: 4px; }
.dsh-urg { list-style: none; margin: 0; padding: 0; }
.dsh-urow { display: flex; gap: 10px; align-items: flex-start; padding: 10px 0; border-top: 1px solid var(--border); }
.dsh-urow:first-child { border-top: 0; padding-top: 0; }
.dsh-uname { font-size: 13.5px; font-weight: 600; color: var(--text-primary); }
.dsh-ucausa { font-size: 12px; color: var(--text-muted); margin-top: 1px; line-height: 1.45; }
.dsh-umeta { text-align: right; font-size: 12px; color: var(--text-secondary); white-space: nowrap; }
.dsh-udias { font-size: 11px; color: var(--text-muted); }

.dsh-big { font-size: 32px; font-weight: 700; line-height: 1.1; color: var(--text-primary); }
.dsh-of { font-size: 17px; font-weight: 500; color: var(--text-muted); }
.dsh-fin-big { font-size: 30px; font-weight: 700; line-height: 1.1; color: var(--text-primary); }

.dsh-rank { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.dsh-rrow { display: grid; grid-template-columns: 90px 1fr 32px 150px; align-items: center; gap: 10px; }
.dsh-rname { font-size: 13px; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-rtrack { height: 8px; border-radius: 4px; background: var(--bg-surface-2); overflow: hidden; }
.dsh-rfill { display: block; height: 100%; background: #1E9E3A; border-radius: 4px; }
.dsh-rn { font-size: 12.5px; font-weight: 700; text-align: right; color: var(--text-secondary); }
.dsh-tags { display: flex; gap: 5px; justify-content: flex-end; }
.dsh-tag { font-size: 10.5px; font-weight: 700; padding: 2px 7px; border-radius: 999px; white-space: nowrap; }
.dsh-tag-ok { background: rgba(22,122,45,0.10); color: #167A2D; }
.dsh-tag-w { background: rgba(255,196,0,0.20); color: #8a6d00; }

@media (max-width: 1100px) {
  .dsh-kpis { grid-template-columns: repeat(3, 1fr); }
  .dsh-acciones { grid-template-columns: repeat(2, 1fr); }
  .dsh-g3 { grid-template-columns: 1fr 1fr; }
  .dsh-g-risk, .dsh-g-prof { grid-template-columns: 1fr; }
}
`;


