'use client';
// ── Solicitudes de revisión (clases sin ingreso registrado) ──────────────────
//
// La cola del admin para las clases que el profesor declaró desde /revisiones.
// ESTE es el único punto donde una clase sin clic en "Ingresar a clase" pasa a
// existir para el pago: aprobar crea el ingreso manual (y la constancia, según el
// tipo). Los efectos viven en lib/reviewRequests.dbResolveReviewRequest, no acá.
//
// No se confunde con la pestaña "Validación": aquella juzga el CONTENIDO de un
// transcript ya asociado a una clase que sí existe; esta decide si la clase
// existió.
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTeachers } from '@/lib/TeachersContext';
import { useAuth } from '@/lib/AuthContext';
import {
  dbGetReviewRequests, dbResolveReviewRequest, reviewTypeLabel,
  RESOLVE_TYPE_OPTIONS, resolvedTypeCreatesJoinLog,
  buildMissingJoinClasses, signalLabel, type MissingJoinClass,
} from '@/lib/reviewRequests';
import { studentAbsenceDatesInMonth, ABSENCE_MONTHLY_CAP, durationBadge, estimateClassAmount } from '@/lib/finance';
import { gridOccupancyOfTeacher } from '@/lib/teacherClasses';
import { findStartDateMismatches } from '@/lib/studentPeriod';
import { getTeacherAssignments, dbGetTranscriptForReview, type TranscriptForReview } from '@/lib/db';
import { getSpainParts } from '@/components/VisualCalendar';
import { flagLabel } from '@/lib/transcriptValidation';
import type { Assignment, ClassReviewRequest, ReviewResolvedType } from '@/types';

const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function fmtDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return iso;
  return `${String(d.getDate()).padStart(2, '0')} ${MESES_CORTOS[d.getMonth()]} ${d.getFullYear()}`;
}
function fmtWhen(iso?: string): string {
  return (iso ?? '').replace('T', ' ').slice(0, 16);
}

const ORDINALES = ['', '1.ª', '2.ª', '3.ª', '4.ª', '5.ª'];

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function monthLabel(my: string): string {
  const [y, m] = my.split('-').map(Number);
  return `${MESES[(m ?? 1) - 1]} ${y}`;
}
function shiftMonth(my: string, delta: number): string {
  const [y, m] = my.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function monthRange(my: string): { from: string; to: string } {
  const [y, m] = my.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return { from: `${my}-01`, to: `${my}-${String(last).padStart(2, '0')}` };
}

type Filtro = 'pendiente' | 'resueltas' | 'todas';

/**
 * Las clases sin ingreso de TODOS los profesores, tal como las ve el admin.
 *
 * La pantalla del profesor está acotada al mes en curso y solo enseña las clases
 * con algún rastro (transcript o registro): sin ese filtro son 492 filas en
 * agosto de 2026 contra 146, y preguntarle por una clase de la que no quedó nada
 * es pedirle que adivine. Acá NO se oculta nada: el filtro existe para no abrumar
 * al profesor, no para esconderle información al admin.
 */
function ClasesSinIngreso() {
  const { teachers, classJoinLogs, classRecords, classAnalyses } = useTeachers();
  const spain = getSpainParts(new Date());

  const [monthYear, setMonthYear] = useState(spain.dateStr.slice(0, 7));
  const [conSeñalSolo, setConSeñalSolo] = useState(true);
  const [asgsByTeacher, setAsgsByTeacher] = useState<Record<string, Assignment[]>>({});
  const [cargando, setCargando] = useState(true);
  const [abierto, setAbierto] = useState<string | null>(null);

  // Los alumnos y sus horarios salen del GRID, igual que en la pantalla del
  // profesor. Filtrar `assignments` por teacherId daría el horario de la ficha,
  // que incluye a alumnos que ya no están en el calendario.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const pares = await Promise.all(teachers.map(async t => [t.id, await getTeacherAssignments(t)] as const));
      if (cancelled) return;
      setAsgsByTeacher(Object.fromEntries(pares));
      setCargando(false);
    })().catch(err => console.error('[admin] No se pudieron leer los horarios:', err));
    return () => { cancelled = true; };
  }, [teachers]);

  const porProfesor = useMemo(() => {
    const { from, to } = monthRange(monthYear);
    const out: Array<{ id: string; name: string; clases: MissingJoinClass[] }> = [];
    for (const t of teachers) {
      const asgs = asgsByTeacher[t.id];
      if (!asgs) continue;
      const clases = buildMissingJoinClasses({
        assignments: asgs, joinLogs: classJoinLogs, classRecords, requests: [],
        analyses: classAnalyses, teacherId: t.id,
        fromDate: from, toDate: to,
        todayIso: spain.dateStr, nowMinutes: spain.hour * 60 + spain.minute,
        gridOccupancy: gridOccupancyOfTeacher(t),
        onlyWithSignal: conSeñalSolo,
      });
      if (clases.length) out.push({ id: t.id, name: t.name, clases });
    }
    return out.sort((a, b) => b.clases.length - a.clases.length);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teachers, asgsByTeacher, classJoinLogs, classRecords, classAnalyses, monthYear, conSeñalSolo]);

  const total = porProfesor.reduce((s, p) => s + p.clases.length, 0);

  // Fechas de inicio incoherentes con los hechos, en TODA la academia (no solo
  // en el mes elegido: una fecha mal cargada no es un problema de este mes).
  const mismatches = useMemo(() => {
    const todas = Object.values(asgsByTeacher).flat();
    if (todas.length === 0) return [];
    return findStartDateMismatches({
      assignments: todas, joinLogs: classJoinLogs, classRecords, analyses: classAnalyses,
    });
  }, [asgsByTeacher, classJoinLogs, classRecords, classAnalyses]);

  return (
    <div style={{ marginTop: 30, borderTop: '1px solid var(--border)', paddingTop: 24 }}>
      <h3 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 5px' }}>
        Clases sin ingreso registrado
      </h3>
      <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: '0 0 14px', lineHeight: 1.6, maxWidth: 760 }}>
        Todo lo que el calendario dice que tocaba y no tiene clic en «Ingresar a clase». El profesor solo ve
        el mes en curso y las que dejaron algún rastro; acá podés ver el resto.
      </p>

      {/* Fechas de inicio que no cuadran con los hechos. No se corrigen solas:
          solo el profesor sabe si aquello fue una clase de prueba o el inicio de
          verdad. Sin esta lista, los casos se pierden en un comentario. */}
      {mismatches.length > 0 && (
        <div style={{ background: 'rgba(255,196,0,0.10)', border: '1px solid rgba(255,196,0,0.45)', borderRadius: 10, padding: '12px 15px', marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#8a6d00', marginBottom: 5 }}>
            {mismatches.length} alumno{mismatches.length === 1 ? '' : 's'} con clases anteriores a su fecha de inicio
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: 9 }}>
            O empezaron antes de lo previsto, o la fecha está mal cargada. No se toca sola porque cambiarla
            mueve qué clases existen: preguntale al profesor. Las clases se siguen viendo y cobrando igual.
          </div>
          {mismatches.map(m => (
            <div key={`${m.teacherId}|${m.studentName}`} style={{ fontSize: 12.5, color: 'var(--text-primary)', padding: '3px 0' }}>
              <b>{m.studentName}</b> <span style={{ color: 'var(--text-muted)' }}>({m.teacherName})</span> — inicio
              declarado {fmtDate(m.declared)}, pero hay {m.source === 'ingreso' ? 'un ingreso' : m.source === 'registro' ? 'un registro' : 'un transcript'} del{' '}
              {fmtDate(m.firstFact)} <span style={{ color: '#8a6d00' }}>({m.daysBefore} {m.daysBefore === 1 ? 'día' : 'días'} antes)</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={() => setMonthYear(m => shiftMonth(m, -1))} aria-label="Mes anterior"
            style={{ width: 28, height: 28, borderRadius: 7, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', color: 'var(--text-secondary)' }}>‹</button>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)', minWidth: 120, textAlign: 'center' }}>
            {monthLabel(monthYear)}
          </span>
          <button onClick={() => setMonthYear(m => shiftMonth(m, 1))} aria-label="Mes siguiente"
            style={{ width: 28, height: 28, borderRadius: 7, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', color: 'var(--text-secondary)' }}>›</button>
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={!conSeñalSolo} onChange={e => setConSeñalSolo(!e.target.checked)}
            style={{ width: 14, height: 14, accentColor: '#12a04b', cursor: 'pointer' }} />
          Mostrar también las que no tienen ninguna señal
        </label>
        <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{total} clases</span>
      </div>

      {cargando ? (
        <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Cargando horarios…</div>
      ) : porProfesor.length === 0 ? (
        <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          Ninguna clase sin ingreso en {monthLabel(monthYear)}.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {porProfesor.map(p => (
            <div key={p.id} style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
              <button onClick={() => setAbierto(a => a === p.id ? null : p.id)}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'var(--bg-surface-2)', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
                <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)', flex: 1 }}>{p.name}</span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {p.clases.filter(c => c.signal).length} con rastro · {p.clases.length} en total
                </span>
                <span style={{ color: 'var(--text-muted)' }}>{abierto === p.id ? '▾' : '▸'}</span>
              </button>
              {abierto === p.id && (
                <div>
                  {p.clases.map(c => (
                    <div key={c.key} style={{ display: 'flex', gap: 12, padding: '8px 14px', borderTop: '1px solid var(--border)', fontSize: 12.5, flexWrap: 'wrap' }}>
                      <span style={{ minWidth: 82, color: 'var(--text-secondary)' }}>{fmtDate(c.date)}</span>
                      <span style={{ minWidth: 100, color: 'var(--text-muted)' }}>{c.hoursLabel}</span>
                      <span style={{ flex: 1, minWidth: 150, color: 'var(--text-primary)', fontWeight: 600 }}>{c.studentName}</span>
                      <span style={{ color: c.signal === 'transcript' ? 'var(--ok)' : c.signal ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
                        {signalLabel(c.signal)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Resumen previo a validar en bloque: qué se va a crear y cuánto suma.
 *
 * Va ANTES de ejecutar porque aprobar es lo que hace existir la clase para el
 * pago: es la acción que mueve dinero y no tiene deshacer directo.
 */
function BulkConfirm({ items, amount, saving, horasDe, onCancel, onConfirm }: {
  items: ClassReviewRequest[];
  amount: number;
  /** Horas efectivas de cada solicitud: incluyen la corrección del admin. */
  horasDe: (r: ClassReviewRequest) => number;
  saving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const porProfesor = new Map<string, number>();
  const porTipo = new Map<string, number>();
  for (const r of items) {
    porProfesor.set(r.teacherName, (porProfesor.get(r.teacherName) ?? 0) + 1);
    porTipo.set(r.requestedType, (porTipo.get(r.requestedType) ?? 0) + 1);
  }
  const clases = items.reduce((s, r) => s + horasDe(r), 0);

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 130, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget && !saving) onCancel(); }}
      role="alertdialog" aria-modal="true"
    >
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 24, width: '100%', maxWidth: 500, maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ fontWeight: 700, fontSize: 16.5, color: 'var(--text-primary)', marginBottom: 12 }}>
          Aprobar {items.length} solicitud{items.length === 1 ? '' : 'es'}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 16 }}>
          {[
            { k: 'Solicitudes', v: String(items.length) },
            { k: 'Clases', v: String(clases) },
            { k: 'Suma aprox.', v: `€${amount.toFixed(2)}` },
          ].map(x => (
            <div key={x.k} style={{ background: 'var(--bg-surface-2)', borderRadius: 10, padding: '11px 13px' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 3 }}>{x.k}</div>
              <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>{x.v}</div>
            </div>
          ))}
        </div>

        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: 14 }}>
          <div><b>Profesores:</b> {[...porProfesor.entries()].map(([n, c]) => `${n} (${c})`).join(' · ')}</div>
          <div><b>Tipos:</b> {[...porTipo.entries()].map(([t, c]) => `${reviewTypeLabel(t as ReviewResolvedType)} (${c})`).join(' · ')}</div>
        </div>

        <div style={{ fontSize: 12, color: 'var(--text-muted)', background: 'var(--bg-surface-2)', borderRadius: 9, padding: '10px 12px', marginBottom: 16, lineHeight: 1.6 }}>
          Se aprueban con el tipo que eligió cada profesor. Para reclasificar alguna, sacala de la
          selección y resolvela por separado. La suma es aproximada: el cupo mensual del alumno puede
          retener alguna clase.
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onCancel} disabled={saving}
            style={{ flex: 1, padding: '11px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: saving ? 'not-allowed' : 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
            Cancelar
          </button>
          <button onClick={onConfirm} disabled={saving}
            style={{ flex: 2, padding: '11px', borderRadius: 8, border: 'none', background: saving ? 'var(--bg-surface-3)' : '#1E9E3A', color: 'white', cursor: saving ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
            {saving ? 'Aprobando…' : `Aprobar ${items.length}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Estado de validación en palabras, para el modal. */
function estadoLabel(s: string | null): { label: string; color: string; bg: string } {
  switch (s) {
    case 'auto_approved': return { label: 'Auto-aprobada', color: 'var(--ok)', bg: 'var(--ok-soft)' };
    case 'approved':      return { label: 'Aprobada por el equipo', color: 'var(--ok)', bg: 'var(--ok-soft)' };
    case 'review':        return { label: 'En revisión', color: '#8a6d00', bg: 'rgba(255,196,0,0.2)' };
    case 'rejected':      return { label: 'Rechazada', color: '#b42318', bg: 'rgba(239,68,68,0.1)' };
    case 'ok':            return { label: 'Válida', color: 'var(--ok)', bg: 'var(--ok-soft)' };
    default:              return { label: 'Sin validar', color: 'var(--text-muted)', bg: 'var(--bg-surface-3)' };
  }
}

/**
 * Lectura del transcript de UNA solicitud, con su veredicto, para decidir sin
 * cambiar de pantalla. El texto llega por `dbGetTranscriptForReview`, que se
 * llama solo al abrir esta fila: los listados nunca traen la columna.
 */
function TranscriptModal({ request, data, loading, busy, onClose, onApprove, onReject }: {
  request: ClassReviewRequest;
  data: TranscriptForReview | null;
  loading: boolean;
  busy: boolean;
  onClose: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const estado = estadoLabel(data?.validationStatus ?? null);
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 130, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}
      role="dialog" aria-modal="true"
    >
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14, width: '100%', maxWidth: 780, maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '18px 22px 14px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{request.studentName}</div>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 2 }}>
                {request.teacherName} · {fmtDate(request.classDate)}{request.classTime ? ` · ${request.classTime}` : ''}
                {request.durationHours > 1 && ` · sesión de ${request.durationHours}h`}
              </div>
            </div>
            <button onClick={onClose} disabled={busy} aria-label="Cerrar"
              style={{ background: 'none', border: 'none', fontSize: 20, cursor: busy ? 'not-allowed' : 'pointer', color: 'var(--text-muted)', lineHeight: 1 }}>✕</button>
          </div>

          {/* Veredicto del validador: score, estado y señales. */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, fontWeight: 700, padding: '4px 10px', borderRadius: 7, background: estado.bg, color: estado.color }}>
              {estado.label}
            </span>
            {data?.score != null && (
              <span style={{
                fontSize: 12, fontWeight: 700, padding: '4px 10px', borderRadius: 7,
                background: data.score >= 80 ? 'var(--ok-soft)' : data.score >= 15 ? 'rgba(255,196,0,0.2)' : 'rgba(239,68,68,0.1)',
                color: data.score >= 80 ? 'var(--ok)' : data.score >= 15 ? '#8a6d00' : '#b42318',
              }}>
                Score {data.score}/100
              </span>
            )}
            {(data?.flags ?? []).length === 0 && !loading && (
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Sin señales marcadas</span>
            )}
            {(data?.flags ?? []).map(f => (
              <span key={f} style={{ fontSize: 11.5, padding: '3px 9px', borderRadius: 999, background: 'var(--bg-surface-3)', color: 'var(--text-secondary)' }}>
                {flagLabel(f)}
              </span>
            ))}
          </div>
        </div>

        {/* Texto */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 22px', minHeight: 180 }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: 13 }}>
              Cargando la transcripción…
            </div>
          ) : !data?.transcript ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: 13 }}>
              Esta solicitud no tiene transcripción guardada.
            </div>
          ) : (
            <pre style={{
              margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              fontSize: 12.5, lineHeight: 1.65, color: 'var(--text-primary)',
              fontFamily: 'var(--font-app), system-ui, sans-serif',
            }}>
              {data.transcript}
            </pre>
          )}
        </div>

        {/* Decidir sin cerrar y volver a buscar la fila. */}
        {request.status === 'pendiente' && (
          <div style={{ padding: '14px 22px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ flex: 1, fontSize: 12, color: 'var(--text-muted)' }}>
              Se registra como <b style={{ color: 'var(--text-secondary)' }}>{reviewTypeLabel(request.requestedType)}</b>.
              Para reclasificarla, cerrá y usá el selector de la fila.
            </span>
            <button onClick={onReject} disabled={busy}
              style={{ padding: '9px 16px', borderRadius: 8, border: '1px solid rgba(239,68,68,0.4)', background: 'transparent', color: '#b42318', cursor: busy ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>
              Rechazar
            </button>
            <button onClick={onApprove} disabled={busy}
              style={{ padding: '9px 18px', borderRadius: 8, border: 'none', background: busy ? 'var(--bg-surface-3)' : '#1E9E3A', color: '#fff', cursor: busy ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
              {busy ? 'Guardando…' : 'Aprobar'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ReviewRequestsTab() {
  const { user } = useAuth();
  const { classRecords, loadFinanceData, assignments, students, financeRates } = useTeachers();
  const [requests, setRequests] = useState<ClassReviewRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [filtro, setFiltro] = useState<Filtro>('pendiente');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  // Reclasificación elegida por el admin, por solicitud. Sin entrada = el tipo
  // que declaró el profesor.
  const [reclass, setReclass] = useState<Record<string, ReviewResolvedType>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  /**
   * Horas con las que el admin va a resolver cada solicitud. Vacío = las que
   * trae la solicitud (la foto automática del calendario). Mismo patrón que
   * `reclass` y `notes`: se guarda al aprobar, no antes.
   */
  const [horas, setHoras] = useState<Record<string, number>>({});

  /** Las horas efectivas de una solicitud: la corrección del admin si la hay. */
  const horasDe = useCallback(
    (r: ClassReviewRequest): number => horas[r.id] ?? r.durationHours ?? 1,
    [horas],
  );
  // Validación en bloque: si un profesor manda 44, resolverlas de a una no es
  // una opción. La reclasificación sigue siendo individual a propósito.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);

  // Lectura del transcript: una fila por vez, bajo demanda.
  const [viewing, setViewing] = useState<ClassReviewRequest | null>(null);
  const [txLoading, setTxLoading] = useState(false);
  const [txData, setTxData] = useState<TranscriptForReview | null>(null);
  // Caché en memoria por analysisId: si ya lo leí en esta sesión no vuelvo a
  // pedirlo. `useRef` y no estado — cachear no tiene que repintar nada.
  const txCache = useRef(new Map<string, TranscriptForReview>());

  useEffect(() => {
    const id = viewing?.analysisId;
    if (!id) { setTxData(null); return; }
    const cached = txCache.current.get(id);
    if (cached) { setTxData(cached); return; }
    let cancelled = false;
    setTxLoading(true);
    setTxData(null);
    dbGetTranscriptForReview(id)
      .then(d => {
        txCache.current.set(id, d);
        if (!cancelled) setTxData(d);
      })
      .catch(err => console.error('[admin] No se pudo leer la transcripción:', err))
      .finally(() => { if (!cancelled) setTxLoading(false); });
    return () => { cancelled = true; };
  }, [viewing]);

  const reviewerName = user?.displayName || user?.username || 'admin';

  // Sin `setLoading(true)` al principio: el estado ya nace en true y la relectura
  // posterior a resolver no debe vaciar la lista (la fila que se está guardando ya
  // se atenúa sola con `busy`). Además así el efecto no llama a setState de forma
  // síncrona, que es lo que dispara renders en cascada.
  const load = useCallback(async () => {
    try { setRequests(await dbGetReviewRequests()); }
    catch (e) { console.error('[admin] No se pudieron leer las solicitudes:', e); }
    finally { setLoading(false); }
  }, []);

  // `load` es async: sus setState ocurren DESPUÉS del await, no en el cuerpo del
  // efecto. La regla no puede verlo desde acá.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  const visibles = useMemo(() => {
    const list = filtro === 'todas' ? requests
      : filtro === 'pendiente' ? requests.filter(r => r.status === 'pendiente')
        : requests.filter(r => r.status !== 'pendiente');
    // Pendientes: la más vieja primero (es la que lleva más tiempo sin cobrar).
    return [...list].sort((a, b) => filtro === 'pendiente'
      ? a.classDate.localeCompare(b.classDate)
      : b.classDate.localeCompare(a.classDate));
  }, [requests, filtro]);

  const pendientes = requests.filter(r => r.status === 'pendiente').length;

  /**
   * Cuántas faltas sin aviso lleva ese alumno en el mes de la clase, contando
   * CLASES distintas — la misma función que el cupo del profesor, para que el
   * "2.ª del mes" que lee el admin y el tope que aplica el pago no discrepen.
   * El +1 es esta solicitud, que todavía no creó su registro.
   */
  function absenceOrdinal(r: ClassReviewRequest): number {
    const ya = studentAbsenceDatesInMonth(classRecords, r.teacherId, r.studentName, r.classDate.slice(0, 7)).length;
    return ya + 1;
  }

  const nk = (s: string) => (s ?? '').trim().toLowerCase();

  /** Lo que valdría esa solicitud, con la misma cadena de tarifas que finanzas. */
  function amountOf(r: ClassReviewRequest): number {
    const a = assignments.find(x => x.teacherId === r.teacherId && nk(x.studentName) === nk(r.studentName));
    const s = students.find(x => nk(x.name) === nk(r.studentName));
    // Las cancelaciones no se pagan: no suman al resumen.
    const tipo = reclass[r.id] ?? r.requestedType;
    if (!resolvedTypeCreatesJoinLog(tipo)) return 0;
    return estimateClassAmount({
      assignment: a, student: s, rates: financeRates,
      // Las horas EFECTIVAS: si el admin las corrigió, el importe estimado tiene
      // que decir lo que se va a pagar y no lo que decía el calendario.
      date: r.classDate, durationHours: horasDe(r),
    });
  }

  const pendientesVisibles = useMemo(() => visibles.filter(r => r.status === 'pendiente'), [visibles]);
  const seleccionadas = useMemo(
    () => pendientesVisibles.filter(r => selected.has(r.id)),
    [pendientesVisibles, selected],
  );
  const todasMarcadas = pendientesVisibles.length > 0 && pendientesVisibles.every(r => selected.has(r.id));
  const sumaSeleccion = seleccionadas.reduce((s, r) => s + amountOf(r), 0);

  function toggleSel(id: string) {
    setSelected(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  /**
   * Aprueba en bloque. Secuencial y tolerante a fallos parciales: cada solicitud
   * crea su ingreso y su constancia, y cortar en la primera que falle dejaría la
   * tanda a medias sin decir cuáles pasaron.
   */
  async function aprobarBloque() {
    setBulkSaving(true); setError('');
    let ok = 0;
    const fallos: string[] = [];
    for (const r of seleccionadas) {
      try {
        await dbResolveReviewRequest({
          request: r, decision: 'aprobada',
          resolvedType: reclass[r.id] ?? r.requestedType,
          durationHours: horasDe(r),
          reviewerName, note: notes[r.id]?.trim() || undefined,
        });
        ok++;
      } catch (e) {
        fallos.push(`${r.studentName} ${r.classDate}: ${e instanceof Error ? e.message : 'error'}`);
      }
    }
    setSelected(new Set());
    setConfirmBulk(false);
    setBulkSaving(false);
    if (fallos.length) setError(`${ok} aprobadas, ${fallos.length} fallaron. ${fallos[0]}`);
    await load();
    await loadFinanceData();
  }

  async function resolve(r: ClassReviewRequest, decision: 'aprobada' | 'rechazada') {
    setBusy(r.id); setError('');
    try {
      await dbResolveReviewRequest({
        request: r,
        decision,
        resolvedType: reclass[r.id] ?? r.requestedType,
        durationHours: horasDe(r),
        reviewerName,
        note: notes[r.id]?.trim() || undefined,
      });
      await load();
      // La liquidación cambia al instante: el ingreso manual ya existe.
      await loadFinanceData();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo resolver la solicitud.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 5px' }}>
          Solicitudes de revisión
        </h2>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.6, maxWidth: 760 }}>
          Clases que están en el calendario del profesor pero <b>no tienen ingreso registrado</b>, así que hoy
          no existen para el pago. Aprobar una crea el ingreso manual (y la constancia, según el tipo);
          rechazarla se lo avisa al profesor. Podés reclasificar si eligió mal el tipo.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {([
          { id: 'pendiente' as Filtro, label: `Pendientes${pendientes ? ` (${pendientes})` : ''}` },
          { id: 'resueltas' as Filtro, label: 'Resueltas' },
          { id: 'todas' as Filtro, label: 'Todas' },
        ]).map(f => (
          <button key={f.id} onClick={() => setFiltro(f.id)}
            style={{
              padding: '7px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
              border: `1px solid ${filtro === f.id ? 'var(--ok)' : 'var(--border)'}`,
              background: filtro === f.id ? 'var(--ok-soft)' : 'transparent',
              color: filtro === f.id ? 'var(--ok)' : 'var(--text-secondary)',
            }}>
            {f.label}
          </button>
        ))}
      </div>

      {/* Barra de selección múltiple. Solo sobre las PENDIENTES visibles: aprobar
          en bloque algo que no se ve en pantalla es justo lo que después nadie
          sabe reconstruir. */}
      {!loading && pendientesVisibles.length > 0 && (
        <div style={{
          background: seleccionadas.length > 0 ? 'var(--ok-soft)' : 'var(--bg-surface-2)',
          border: `1px solid ${seleccionadas.length > 0 ? 'var(--ok)' : 'var(--border)'}`,
          borderRadius: 10, padding: '10px 14px', marginBottom: 14,
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={todasMarcadas}
              onChange={() => setSelected(todasMarcadas ? new Set() : new Set(pendientesVisibles.map(r => r.id)))}
              style={{ width: 15, height: 15, accentColor: '#12a04b', cursor: 'pointer' }}
            />
            Seleccionar las {pendientesVisibles.length} pendientes
          </label>
          <span style={{ flex: 1 }} />
          {seleccionadas.length > 0 && (
            <>
              <span style={{ fontSize: 12.5, color: 'var(--ok)', fontWeight: 700 }}>
                {seleccionadas.length} · €{sumaSeleccion.toFixed(2)} aprox.
              </span>
              <button onClick={() => setSelected(new Set())} disabled={bulkSaving}
                style={{ padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12.5, fontFamily: 'inherit' }}>
                Quitar selección
              </button>
              <button onClick={() => setConfirmBulk(true)} disabled={bulkSaving}
                style={{ padding: '7px 15px', borderRadius: 8, border: 'none', background: '#1E9E3A', color: '#fff', cursor: bulkSaving ? 'not-allowed' : 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit' }}>
                Aprobar {seleccionadas.length}
              </button>
            </>
          )}
        </div>
      )}

      {error && (
        <div style={{ fontSize: 13, color: '#b42318', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 9, padding: '10px 13px', marginBottom: 14 }}>
          {error}
        </div>
      )}

      {confirmBulk && (
        <BulkConfirm
          items={seleccionadas}
          horasDe={horasDe}
          amount={sumaSeleccion}
          saving={bulkSaving}
          onCancel={() => { if (!bulkSaving) setConfirmBulk(false); }}
          onConfirm={aprobarBloque}
        />
      )}

      {viewing && (
        <TranscriptModal
          request={viewing}
          data={txData}
          loading={txLoading}
          busy={busy === viewing.id}
          onClose={() => setViewing(null)}
          // Se decide desde el modal y se cierra solo: volver a buscar la fila
          // entre 44 para pulsar el botón que ya se tenía delante no tiene sentido.
          onApprove={async () => { const r = viewing; setViewing(null); await resolve(r, 'aprobada'); }}
          onReject={async () => { const r = viewing; setViewing(null); await resolve(r, 'rechazada'); }}
        />
      )}

      {loading ? (
        <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13.5 }}>Cargando…</div>
      ) : visibles.length === 0 ? (
        <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13.5 }}>
          {filtro === 'pendiente' ? 'No hay solicitudes esperando.' : 'Sin solicitudes.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {visibles.map(r => {
            const tipo: ReviewResolvedType = reclass[r.id] ?? r.requestedType;
            const cambiado = tipo !== r.requestedType;
            const pagable = resolvedTypeCreatesJoinLog(tipo);
            const dur = durationBadge(horasDe(r));
            const horasCorregidas = horasDe(r) !== (r.durationHours ?? 1);
            const esFalta = tipo === 'falta_sin_aviso';
            const ordinal = esFalta ? absenceOrdinal(r) : 0;
            const superaCupo = esFalta && ordinal > ABSENCE_MONTHLY_CAP;
            const working = busy === r.id;

            return (
              <div key={r.id} style={{
                background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '15px 17px',
                opacity: working ? 0.6 : 1,
              }}>
                {/* Cabecera de la fila */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
                  {r.status === 'pendiente' && (
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggleSel(r.id)}
                      disabled={working || bulkSaving}
                      aria-label={`Seleccionar la solicitud de ${r.studentName} del ${fmtDate(r.classDate)}`}
                      style={{ width: 15, height: 15, accentColor: '#12a04b', cursor: 'pointer', margin: 0 }}
                    />
                  )}
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
                    {r.studentName}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                    {r.teacherName} · {fmtDate(r.classDate)}{r.classTime ? ` · ${r.classTime}` : ''}
                  </div>
                  {dur && (
                    <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 5, color: dur.color, background: dur.bg }}>
                      {dur.label}
                    </span>
                  )}
                  <span style={{ flex: 1 }} />
                  {r.status !== 'pendiente' && (
                    <span style={{
                      fontSize: 12, fontWeight: 700, padding: '4px 10px', borderRadius: 999,
                      color: r.status === 'aprobada' ? 'var(--ok)' : '#b42318',
                      background: r.status === 'aprobada' ? 'var(--ok-soft)' : 'rgba(239,68,68,0.1)',
                    }}>
                      {r.status === 'aprobada' ? 'Aprobada' : 'Rechazada'}
                    </span>
                  )}
                </div>

                {/* Lo que declaró el profesor */}
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>El profesor eligió:</span>
                  <span style={{ fontSize: 12.5, fontWeight: 700, padding: '4px 10px', borderRadius: 7, background: 'var(--bg-surface-3)', color: 'var(--text-primary)' }}>
                    {reviewTypeLabel(r.requestedType)}
                  </span>
                  {r.requestedType === 'normal' && (
                    r.analysisId ? (
                      // El texto se pide SOLO al pulsar esto, de esta fila: el
                      // listado nunca trae la columna `transcript`.
                      <button
                        onClick={() => setViewing(r)}
                        style={{ padding: '4px 11px', borderRadius: 7, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit' }}
                      >
                        Ver transcript
                      </button>
                    ) : (
                      <span style={{ fontSize: 12, color: '#b45309' }}>SIN transcript</span>
                    )
                  )}
                  {esFalta && (
                    <span style={{
                      fontSize: 12, fontWeight: 700, padding: '4px 10px', borderRadius: 7,
                      color: superaCupo ? '#b42318' : '#b45309',
                      background: superaCupo ? 'rgba(239,68,68,0.1)' : 'rgba(255,196,0,0.2)',
                    }}>
                      {ORDINALES[ordinal] ?? `${ordinal}.ª`} del mes
                      {superaCupo && ` · supera las ${ABSENCE_MONTHLY_CAP} cobrables`}
                    </span>
                  )}
                </div>

                {r.comment && (
                  <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', background: 'var(--bg-surface-2)', borderRadius: 8, padding: '9px 12px', marginBottom: 10, lineHeight: 1.55 }}>
                    {r.comment}
                  </div>
                )}

                {r.status === 'pendiente' ? (
                  <>
                    {/* Reclasificación */}
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
                      <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>Registrar como:</label>
                      <select
                        value={tipo}
                        onChange={e => setReclass(p => ({ ...p, [r.id]: e.target.value as ReviewResolvedType }))}
                        disabled={working}
                        style={{ padding: '7px 10px', borderRadius: 8, border: `1.5px solid ${cambiado ? 'var(--warn)' : 'var(--border)'}`, background: 'var(--bg-surface-2)', color: 'var(--text-primary)', fontSize: 12.5, fontFamily: 'inherit' }}
                      >
                        {RESOLVE_TYPE_OPTIONS.map(o => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                      <span style={{ fontSize: 12, color: pagable ? 'var(--ok)' : 'var(--text-muted)' }}>
                        {RESOLVE_TYPE_OPTIONS.find(o => o.value === tipo)?.note}
                      </span>
                    </div>

                    {/* Horas de la sesión. El número que trae la solicitud es una
                        foto AUTOMÁTICA del calendario del día en que el profesor
                        la declaró, y solo pisa al calendario de hoy si es >= 2
                        (ver sessionSpanFor). Corregirlo acá lo convierte en una
                        decisión del equipo, y entonces vale en los dos sentidos:
                        también para bajar. Solo tiene sentido en los tipos que
                        crean ingreso; los demás no se pagan. */}
                    {pagable && (
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
                        <label htmlFor={`horas-${r.id}`} style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          Horas de la clase:
                        </label>
                        <input
                          id={`horas-${r.id}`}
                          type="number"
                          min={1}
                          max={8}
                          step={1}
                          value={horasDe(r)}
                          onChange={e => {
                            const n = Math.round(Number(e.target.value));
                            // El tope no es decorativo: un 22 en vez de un 2
                            // pagaría 22 horas y nadie lo vería hasta la
                            // liquidación.
                            if (Number.isFinite(n) && n >= 1 && n <= 8) setHoras(p => ({ ...p, [r.id]: n }));
                          }}
                          disabled={working}
                          style={{
                            width: 62, padding: '7px 9px', borderRadius: 8,
                            border: `1.5px solid ${horasCorregidas ? 'var(--warn)' : 'var(--border)'}`,
                            background: 'var(--bg-surface-2)', color: 'var(--text-primary)',
                            fontSize: 12.5, fontFamily: 'inherit',
                          }}
                        />
                        <span style={{ fontSize: 12, color: horasCorregidas ? '#b45309' : 'var(--text-muted)' }}>
                          {horasCorregidas
                            ? `Corregido a mano · el calendario del día decía ${r.durationHours} h`
                            : `Automático, del calendario del día de la clase`}
                        </span>
                      </div>
                    )}

                    {/* Aprobar crea el ingreso, y eso desactiva por sí solo la
                        señal "sin acceso registrado" del transcript — que se
                        disparaba justamente por el ingreso que falta. Si el texto
                        tenía ADEMÁS otra señal, se queda en la cola normal. */}
                    {tipo === 'normal' && (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.55 }}>
                        Aprobar crea el ingreso y descarta del transcript la señal <i>sin acceso registrado</i>.
                        Si el texto tenía además otra señal, sigue en <b>Validación</b> hasta que la mires.
                      </div>
                    )}

                    <input
                      value={notes[r.id] ?? ''}
                      onChange={e => setNotes(p => ({ ...p, [r.id]: e.target.value }))}
                      placeholder="Nota para el profesor (opcional; obligatoria de hecho si rechazás)"
                      disabled={working}
                      style={{ width: '100%', padding: '8px 11px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-surface-2)', color: 'var(--text-primary)', fontSize: 12.5, fontFamily: 'inherit', boxSizing: 'border-box', marginBottom: 11 }}
                    />

                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                      <button onClick={() => resolve(r, 'aprobada')} disabled={working}
                        style={{ padding: '9px 18px', borderRadius: 8, border: 'none', background: working ? 'var(--bg-surface-3)' : '#1E9E3A', color: '#fff', cursor: working ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
                        {working ? 'Guardando…' : 'Aprobar'}
                      </button>
                      <button onClick={() => resolve(r, 'rechazada')} disabled={working}
                        style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid rgba(239,68,68,0.4)', background: 'transparent', color: '#b42318', cursor: working ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>
                        Rechazar
                      </button>
                    </div>
                  </>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                    {r.status === 'aprobada' && <>Registrada como <b style={{ color: 'var(--text-secondary)' }}>{reviewTypeLabel(r.resolvedType)}</b>{r.joinLogId ? ' · ingreso creado' : ' · sin ingreso (no se paga)'} · </>}
                    {r.reviewedBy || 'equipo'}{r.reviewedAt ? ` · ${fmtWhen(r.reviewedAt)}` : ''}
                    {r.reviewNote && <> · {r.reviewNote}</>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <ClasesSinIngreso />
    </div>
  );
}
