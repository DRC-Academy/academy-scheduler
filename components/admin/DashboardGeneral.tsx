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

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useTeachers } from '@/lib/TeachersContext';
import type { AssignedSlot } from '@/types';
import { CrearVinculoModal } from '@/components/CrearVinculoModal';
import { getPresentationEmailStatus } from '@/lib/presentationEmailUtils';
import {
  dbAuditStudentAssignments, dbRelinkAssignment, dbSyncAssignmentName, dbMergeDuplicateStudents,
  dbSyncStudentAssignments, dbDiagnoseAllCalendars, dbSyncAllCalendarsToAssignments, dbCreateFullLink,
  dbRepairMisplacedStudent, dbSyncSlotsFromCalendar,
  type CalendarDiagnosisAllRow, type AuditResult,
} from '@/lib/db';

/**
 * Los tres filtros de la pestaña Emails a los que saltan los contadores de
 * presentación. Se escriben acá y no se importan de la página de admin: son
 * parámetros de URL, y traerse el tipo obligaría a importar /admin entero desde
 * el dashboard solo para leer cinco cadenas.
 */
type EmailTileFilter = 'pending' | 'at_risk' | 'overdue';

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

// ─── Dashboard ────────────────────────────────────────────────────────────────

export default function DashboardGeneral() {
  const { teachers, assignments, students } = useTeachers();
  const router = useRouter();

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

  // Referencia temporal para el estado de los emails de presentación. No hace
  // falta un reloj vivo: se recalcula al recargar la página.
  const nowMs = Date.now();
  const presPendingStatuses = assignments.filter(a => !a.presentationEmailSent).map(a => getPresentationEmailStatus(a, nowMs));
  const presOnTimeCount  = presPendingStatuses.filter(s => s.status === 'on_time' || s.status === 'warning').length;
  const presAtRiskCount  = presPendingStatuses.filter(s => s.status === 'at_risk').length;
  const presOverdueCount = presPendingStatuses.filter(s => s.status === 'overdue').length;

  const activeTeachers  = teachers.filter(t => t.status !== 'vacation').length;
  const totalClasses    = teachers.reduce((a, t) => a + t.upcomingClasses.length, 0);
  const totalFreeSpots  = teachers.reduce((a, t) => a + t.freeSpots, 0);
  const blockedCount    = teachers.filter(t => t.isBlocked).length;

  // Punto de severidad de cada alerta (ya no se usan fondos ni iconos).
  const alertColors = { high: '#dc4a38', medium: '#e0912f', low: '#8b8e88' };

  /** Cada contador de presentación lleva a la pestaña Emails con SU filtro puesto. */
  const goToEmails = (filter: EmailTileFilter) => {
    router.push(`/admin?tab=emails&filter=${filter}`, { scroll: true });
  };

  return (
    <>
      {/* KPIs monocromos: color solo en los que comunican estado. */}
      <div className="adm-kpis">
        {[
          { label: 'Activos',       value: activeTeachers,  sub: `de ${teachers.length}`, alert: false },
          { label: 'Clases semana', value: totalClasses,    sub: 'confirmadas',           alert: false },
          { label: 'Cupos libres',  value: totalFreeSpots,  sub: 'disponibles',           alert: false },
          {
            label: 'Conflictos',
            value: conflicts ?? '·',
            sub: conflicts == null ? 'revisando…' : conflicts > 0 ? 'ver el detalle' : 'sin conflictos',
            alert: (conflicts ?? 0) > 0,
            // Solo es clickable si hay algo que mirar.
            onClick: conflicts ? () => setConflictDetail(conflictGroups) : undefined,
            title: conflictGroups.map(g => `${g.items.length} · ${g.label}`).join('\n'),
          },
          { label: 'Alumnos',       value: students.length, sub: 'registrados',           alert: false },
          { label: 'Bloqueados',    value: blockedCount,    sub: 'baja retención',        alert: blockedCount > 0 },
        ].map(s => {
          const clickable = 'onClick' in s && !!s.onClick;
          const Tag = clickable ? 'button' : 'div';
          return (
            <Tag
              key={s.label}
              className={`adm-card adm-kpi${clickable ? ' is-clickable' : ''}`}
              onClick={clickable ? s.onClick : undefined}
              title={('title' in s && s.title) || undefined}
              {...(clickable ? { type: 'button' as const } : {})}
            >
              <div className="adm-kpi-label">
                {s.label}
                {clickable && <span aria-hidden className="adm-kpi-arrow">›</span>}
              </div>
              <div className={`adm-kpi-value${s.alert ? ' is-alert' : ''}`}>
                {s.alert && <span className="adm-dot" style={{ background: '#dc4a38' }} />}
                {s.value}
              </div>
              <div className="adm-kpi-sub">{s.sub}</div>
            </Tag>
          );
        })}
      </div>

      {/* Emails de presentación */}
      <div className="adm-card" style={{ padding: '18px 20px', marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Emails de presentación</span>
          <span style={{ marginLeft: 'auto', fontSize: 12.5, color: '#8b8e88' }}>
            {presPendingStatuses.length} pendiente{presPendingStatuses.length !== 1 ? 's' : ''}
          </span>
        </div>
        {/* Cada contador lleva a la pestaña Emails con SU filtro puesto: el
            admin hace clic en "En riesgo" y ve esos, sin volver a filtrar. */}
        <div className="adm-tiles">
          {[
            { label: 'Pendientes a tiempo',    value: presOnTimeCount,  tone: 'is-ok',    dot: '#16a34a', filter: 'pending' as const },
            { label: 'En riesgo (>12h)',       value: presAtRiskCount,  tone: 'is-warn',  dot: '#e0912f', filter: 'at_risk' as const },
            { label: 'Fuera de tiempo (>24h)', value: presOverdueCount, tone: 'is-alert', dot: '#dc4a38', filter: 'overdue' as const },
          ].map(c => (
            <button
              key={c.label}
              type="button"
              className={`adm-tile ${c.tone} is-clickable`}
              onClick={() => goToEmails(c.filter)}
              title={`Ver ${c.label.toLowerCase()} en la pestaña Emails`}
            >
              <div className="adm-tile-value">
                <span className="adm-dot" style={{ background: c.dot }} />
                {c.value}
              </div>
              <div className="adm-tile-label">
                {c.label}
                <span aria-hidden className="adm-kpi-arrow">›</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Herramientas de mantenimiento. Van al final y plegadas: son acciones
          puntuales, no información de consulta diaria, y en la portada le
          quitarían el sitio a lo que sí se mira todos los días. */}
      <div style={{ marginTop: 26 }}>
        <div className="adm-sec-head" style={{ marginBottom: 4 }}>Herramientas de mantenimiento</div>
        <p style={{ margin: '0 0 2px', fontSize: 12.5, color: 'var(--text-muted)' }}>
          Auditorías y sincronizaciones que se lanzan a mano. Abrí solo la que necesites.
        </p>
      </div>
      <div className="adm-tools">
        <AdminTool
          title="Auditoría de vínculos"
          desc="Revisa la coherencia entre alumnos, asignaciones y fichas."
          openSignal={auditSignal}
        >
          <AuditPanel />
        </AdminTool>

        <AdminTool
          title="Sincronización calendario ↔ asignaciones"
          desc="Detecta alumnos en el calendario sin assignment ni registro."
        >
          <SyncPanel />
        </AdminTool>

        {/* Los dos paneles de Woo viven juntos: son la misma tarea. */}
        <AdminTool
          title="Sincronización con WooCommerce"
          desc="Actualiza planes y fechas de inicio con los datos reales de Woo."
        >
          <PlanSyncPanel />
          <StartDateSyncPanel />
          <CompanyPlanSyncPanel />
        </AdminTool>

        <AdminTool
          title="Estilo de los textos de IA"
          desc="Quita los guiones que la IA usaba como conectores en fichas y análisis ya guardados."
        >
          <CleanDashesPanel />
        </AdminTool>
      </div>

      <div className="adm-bottom">
        <div className="adm-card">
          <div className="adm-sec-head">Alertas</div>
          {/* Alertas REALES. Antes esta lista salía de `mockAlerts`: cinco
              mensajes fijos escritos a mano ("Agustín supera 40 clases
              semanales…") que nombraban profesores de verdad y no respondían
              a ningún dato. Ahora sale de la misma auditoría que alimenta el
              contador de Conflictos, así que las dos cosas no pueden
              contradecirse. */}
          <div className="adm-list">
            {audit == null ? (
              <div className="adm-empty">Revisando…</div>
            ) : blockedCount === 0 && conflictGroups.length === 0 ? (
              <div className="adm-empty">Sin alertas.</div>
            ) : (
              <>
                {blockedCount > 0 && (
                  <div className="adm-alert">
                    <span className="adm-dot" style={{ background: '#dc4a38', marginTop: 4 }} />
                    <span className="adm-alert-text">
                      {blockedCount} profesor{blockedCount !== 1 ? 'es' : ''} bloqueado{blockedCount !== 1 ? 's' : ''} por baja retención — no pueden recibir nuevos alumnos
                    </span>
                  </div>
                )}
                {conflictGroups.map(g => (
                  <button
                    key={g.label}
                    type="button"
                    className="adm-alert adm-alert-link"
                    onClick={() => setConflictDetail([g])}
                    title={`Ver los ${g.items.length} casos`}
                  >
                    <span className="adm-dot" style={{ background: alertColors.high, marginTop: 4 }} />
                    <span className="adm-alert-text">
                      {g.items.length} · {g.label}
                      <span aria-hidden className="adm-kpi-arrow">›</span>
                    </span>
                  </button>
                ))}
              </>
            )}
          </div>
        </div>

        <div className="adm-card">
          <div className="adm-sec-head">Asignaciones recientes</div>
          <div className="adm-list">
            {assignments.length === 0 ? (
              <div className="adm-empty">Sin asignaciones todavía.</div>
            ) : assignments.slice(0, 6).map(a => (
              <div key={a.id} className="adm-row">
                <div style={{ minWidth: 0 }}>
                  <div className="adm-row-name">{a.studentName}</div>
                  <div className="adm-row-meta">
                    <span className="adm-row-teacher">{a.teacherName}</span>
                    {' · '}{a.slots.map(s => `${s.day} ${s.hour}`).join(' · ')} · {a.weeklyHours}h/sem
                  </div>
                </div>
                <span className="adm-row-time">
                  {new Date(a.createdAt).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {conflictDetail && (
        <ConflictDetailModal
          groups={conflictDetail}
          onClose={() => setConflictDetail(null)}
          onOpenAudit={() => { setConflictDetail(null); setAuditSignal(n => n + 1); }}
        />
      )}
    </>
  );
}
