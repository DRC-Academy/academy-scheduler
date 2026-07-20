'use client';
import { useState, useEffect, useMemo } from 'react';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { PullToRefresh } from '@/components/PullToRefresh';
import { LastUpdated } from '@/components/LastUpdated';
import { getSpainParts } from '@/components/VisualCalendar';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import { calculateTeacherFinance, recordVerification, ClassFinanceRow, ingresoBadge, classTypeBadge, subscriptionBadge } from '@/lib/finance';
import { dbGetAssignmentsByTeacher } from '@/lib/db';
import { classifyPlan } from '@/lib/productUtils';
import { analyzeTranscriptOnly, saveAnalysis } from '@/lib/aiClient';
import { checkTranscriptDuplicates, transcriptHash, type DupeCheck } from '@/lib/transcriptDupes';
import { Teacher, Assignment, ClassRecordType, ClassRecord } from '@/types';

// Etiquetas singular/plural por tipo de falta (para los mensajes de límite).
const FALTA_TYPE_LABELS: Record<string, { sing: string; plural: string }> = {
  falta_sin_aviso:  { sing: 'falta sin aviso',           plural: 'faltas sin aviso' },
  cancelacion_hora: { sing: 'cancelación sobre la hora', plural: 'cancelaciones sobre la hora' },
};

// Opciones del selector "Tipo de clase".
const CLASS_TYPE_OPTIONS: Array<{ value: ClassRecordType; label: string; needsTranscript: boolean }> = [
  { value: 'normal',           label: 'Clase normal',                needsTranscript: true },
  { value: 'falta_sin_aviso',  label: 'Falta del alumno sin aviso',  needsTranscript: false },
  { value: 'cancelacion_hora', label: 'Cancelación sobre la hora',    needsTranscript: false },
  { value: 'recuperacion',     label: 'Clase de recuperación',        needsTranscript: true },
];

// Las etiquetas de ingresoBadge / classTypeBadge / subscriptionBadge vienen con
// emoji desde lib/finance (fuente compartida con el panel de admin). Acá solo se
// muestran sin él: se recorta el prefijo no alfanumérico, sin tocar la fuente.
function plainLabel(label: string): string {
  return label.replace(/^[^\p{L}\p{N}€]+/u, '').trim();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const FIN_MONTHS = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

function currentMonthYear(): string {
  const { dateStr } = getSpainParts(new Date());
  return dateStr.slice(0, 7); // 'YYYY-MM'
}
function shiftMonth(monthYear: string, delta: number): string {
  const [y, m] = monthYear.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function monthLabel(monthYear: string): string {
  const [y, m] = monthYear.split('-').map(Number);
  return `${FIN_MONTHS[(m ?? 1) - 1]} ${y}`;
}
function finShortDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  return `${String(d.getDate()).padStart(2, '0')} ${FIN_MONTHS[d.getMonth()].slice(0, 3)}`;
}
function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysDiff(aIso: string, bIso: string): number {
  return Math.round((new Date(bIso + 'T00:00:00').getTime() - new Date(aIso + 'T00:00:00').getTime()) / 86400000);
}

/**
 * Aviso de transcript duplicado. Tres casos:
 *   · blocked      → texto idéntico ya registrado para ESTA clase: no se guarda.
 *   · other-class  → texto idéntico de otro alumno/fecha: se puede confirmar.
 *   · replace      → ya hay transcript de esta clase: se ofrece reemplazarlo.
 */
function DuplicateDialog({ check, onCancel, onConfirm }: {
  check: DupeCheck; onCancel: () => void; onConfirm: () => void;
}) {
  if (check.kind === 'none') return null;

  const when = check.row.class_date ? finShortDate(check.row.class_date) : 'fecha desconocida';

  const copy = check.kind === 'blocked'
    ? {
        title: 'Este transcript ya fue registrado',
        body: `Ya existe exactamente este mismo texto para ${check.row.student_name} el ${when}. No hace falta subirlo otra vez.`,
        confirm: null,
      }
    : check.kind === 'other-class'
      ? {
          title: '¿Es el transcript correcto?',
          body: `Este transcript parece ser el mismo que ya subiste para ${check.row.student_name} el ${when}. ¿Estás seguro de que es correcto?`,
          confirm: 'Confirmar igualmente',
        }
      : {
          title: 'Ya existe un transcript para esta clase',
          body: `Registraste una clase con ${check.row.student_name} el ${when}. ¿Querés reemplazar el transcript existente? Se volverá a analizar con el texto nuevo.`,
          confirm: 'Reemplazar',
        };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 110, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}
      role="alertdialog"
      aria-modal="true"
    >
      <div style={{ background: '#fff', borderRadius: 14, padding: 24, width: '100%', maxWidth: 420 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: check.kind === 'blocked' ? '#dc4a38' : '#e0912f' }} />
          <span style={{ fontSize: 16, fontWeight: 700, color: '#1a1c1a' }}>{copy.title}</span>
        </div>
        <p style={{ fontSize: 13.5, color: '#5f6360', lineHeight: 1.65, margin: '0 0 18px' }}>{copy.body}</p>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={onCancel}
            style={{ flex: 1, padding: '10px', borderRadius: 9, border: '1px solid var(--border)', background: 'transparent', color: '#5f6360', cursor: 'pointer', fontSize: 13.5, fontFamily: 'inherit' }}
          >
            {copy.confirm ? 'Cancelar' : 'Cerrar'}
          </button>
          {copy.confirm && (
            <button
              onClick={onConfirm}
              style={{ flex: 2, padding: '10px', borderRadius: 9, border: 'none', background: '#1E9E3A', color: '#fff', cursor: 'pointer', fontSize: 13.5, fontWeight: 700, fontFamily: 'inherit' }}
            >
              {copy.confirm}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Modal "Añadir clase"
function AddClassModal({ teacher, myAssignments, classRecords, onClose, onSaved }: {
  teacher: Teacher;
  myAssignments: Assignment[];
  classRecords: ClassRecord[];
  onClose: () => void;
  onSaved: (
    studentName: string, date: string, time: string | undefined, transcript: string,
    classType: ClassRecordType, comment: string,
    transcriptHash: string, replaceId: string | null,
  ) => Promise<void>;
}) {
  const studentOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const a of myAssignments) {
      if (!seen.has(a.studentName)) { seen.add(a.studentName); out.push(a.studentName); }
    }
    return out.sort((x, y) => x.localeCompare(y));
  }, [myAssignments]);

  const todayIso = getSpainParts(new Date()).dateStr;
  const [studentName, setStudentName] = useState(studentOptions[0] ?? '');
  const [date, setDate] = useState(todayIso);
  const [time, setTime] = useState('');
  const [transcript, setTranscript] = useState('');
  const [classType, setClassType] = useState<ClassRecordType>('normal');
  const [comment, setComment] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  // Duplicado detectado a la espera de decisión del profesor.
  const [dupe, setDupe] = useState<{ check: DupeCheck; hash: string } | null>(null);

  const needsTranscript = CLASS_TYPE_OPTIONS.find(o => o.value === classType)?.needsTranscript ?? true;
  const isFaltaType = classType === 'falta_sin_aviso' || classType === 'cancelacion_hora';

  // Cuántos registros de ESE tipo ya tiene el alumno (acumulativo, todo el historial).
  const typeCount = useMemo(() => {
    if (!isFaltaType) return 0;
    const nk = (x: string) => (x ?? '').trim().toLowerCase();
    return classRecords.filter(r =>
      r.teacherId === teacher.id && nk(r.studentName) === nk(studentName) && r.classType === classType
    ).length;
  }, [classRecords, teacher.id, studentName, classType, isFaltaType]);
  const limitReached = isFaltaType && typeCount >= 2;
  const typeLabel = FALTA_TYPE_LABELS[classType];

  // Auto-rellenar la hora con el slot recurrente del alumno si el día coincide.
  // Depende solo de alumno+fecha para no pisar una hora editada a mano.
  useEffect(() => {
    if (!studentName || !date) return;
    const jsDay = new Date(date + 'T00:00:00').getDay();
    const dayName = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'][jsDay];
    for (const a of myAssignments.filter(a => a.studentName === studentName)) {
      const slot = (a.slots ?? []).find(s => s.day === dayName);
      if (slot) { setTime(slot.hour.length === 5 ? slot.hour : `${slot.hour.padStart(2, '0')}:00`); return; }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentName, date]);

  // Normal/recuperación: TRANSCRIPT obligatorio (segundo factor de verificación).
  // Falta/cancelación: comentario obligatorio y bloqueado al llegar a 2 de ese tipo.
  const words = transcript.trim() ? transcript.trim().split(/\s+/).length : 0;
  const canSave = !!studentName && !!date && !saving && !limitReached &&
    (needsTranscript ? words >= 30 : !!comment.trim());

  // Guardado real. `replaceId` llega solo cuando el profesor confirmó reemplazar
  // el transcript de una clase ya registrada.
  async function persist(hash: string, replaceId: string | null) {
    setSaving(true); setError('');
    try {
      await onSaved(
        studentName, date, time || undefined,
        needsTranscript ? transcript.trim() : '',
        classType, comment.trim(), hash, replaceId,
      );
      onClose();
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo guardar el registro.');
      setSaving(false);
    }
  }

  async function handleSave() {
    if (!canSave) return;

    // Las faltas/cancelaciones no llevan transcript: nada que verificar.
    if (!needsTranscript) { await persist('', null); return; }

    const hash = transcriptHash(transcript);
    setChecking(true);
    let result: DupeCheck;
    try {
      result = await checkTranscriptDuplicates({
        teacherId: teacher.id, studentName, classDate: date, hash,
      });
    } catch {
      result = { kind: 'none' };   // la verificación nunca debe impedir guardar
    } finally {
      setChecking(false);
    }

    if (result.kind === 'none') { await persist(hash, null); return; }
    setDupe({ check: result, hash });
  }

  const inputStyle = { width: '100%', padding: '9px 12px', borderRadius: 8, border: '1.5px solid var(--border)', fontSize: 13, background: 'white', color: '#111827', fontFamily: 'inherit', boxSizing: 'border-box' as const };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div style={{ background: '#F7F7F5', border: '1px solid var(--border)', borderRadius: 16, width: '100%', maxWidth: 440, padding: 26 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <div style={{ fontWeight: 700, fontSize: 17, color: '#111827' }}>Añadir clase</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#6b7280' }}>✕</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>Alumno</label>
            {studentOptions.length === 0 ? (
              <div style={{ fontSize: 12, color: '#b45309' }}>No tenés alumnos asignados.</div>
            ) : (
              <select value={studentName} onChange={e => setStudentName(e.target.value)} style={inputStyle}>
                {studentOptions.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            )}
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>Tipo de clase <span style={{ color: '#ef4444' }}>*</span></label>
            <select value={classType} onChange={e => setClassType(e.target.value as ClassRecordType)} style={inputStyle}>
              {CLASS_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          {limitReached ? (
            <>
              <div style={{ fontSize: 13, color: '#dc2626', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: 10, padding: '12px 14px', lineHeight: 1.5 }}>
                Este alumno ya registró 2 {typeLabel?.plural}. No se pueden registrar más con este motivo.
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
                <button onClick={onClose} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: '#6b7280', cursor: 'pointer', fontSize: 14, fontFamily: 'inherit' }}>Cerrar</button>
              </div>
            </>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>Fecha de la clase</label>
                  <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle} />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>Hora (España)</label>
                  <input type="time" value={time} onChange={e => setTime(e.target.value)} style={inputStyle} />
                </div>
              </div>
              {needsTranscript ? (
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
                    Transcript de la clase <span style={{ color: '#ef4444' }}>*</span>
                  </label>
                  <textarea
                    value={transcript}
                    onChange={e => { setTranscript(e.target.value); setError(''); }}
                    rows={6}
                    placeholder="Pegá acá el texto que genera Fathom al terminar la sesión..."
                    style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5 }}
                  />
                  <div style={{ fontSize: 11, color: words >= 30 ? '#1E9E3A' : '#6b7280', marginTop: 5 }}>
                    {words} palabras{words < 30 ? ' · mínimo 30' : ''}
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 11.5, color: '#b45309', background: 'rgba(255,196,0,0.1)', border: '1px solid rgba(255,196,0,0.3)', borderRadius: 8, padding: '8px 10px', lineHeight: 1.5 }}>
                  Este tipo de clase <b>SÍ genera cobro</b> (tarifa normal del alumno), pero solo se permite hasta 2 veces. Llevás <b>{typeCount}</b> de 2 registradas. No requiere transcript.
                </div>
              )}
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
                  Comentario {needsTranscript ? '(opcional)' : <span style={{ color: '#ef4444' }}>*</span>}
                </label>
                <textarea value={comment} onChange={e => setComment(e.target.value)} rows={2}
                  placeholder={needsTranscript ? 'Ej: el alumno llegó tarde...' : 'Detallá el motivo (obligatorio)'}
                  style={{ ...inputStyle, resize: 'vertical' }} />
              </div>
              {error && <div style={{ fontSize: 12, color: '#ef4444' }}>{error}</div>}
              <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
                <button onClick={onClose} disabled={saving} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: '#6b7280', cursor: saving ? 'not-allowed' : 'pointer', fontSize: 14, fontFamily: 'inherit' }}>Cancelar</button>
                <button onClick={handleSave} disabled={!canSave || checking} style={{ flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: canSave && !checking ? '#1E9E3A' : '#d1d5db', color: 'white', cursor: canSave && !checking ? 'pointer' : 'not-allowed', fontSize: 14, fontWeight: 700, fontFamily: 'inherit' }}>
                  {checking ? 'Verificando...' : saving ? 'Guardando...' : 'Guardar registro'}
                </button>
              </div>
            </>
          )}
        </div>

        {dupe && (
          <DuplicateDialog
            check={dupe.check}
            onCancel={() => setDupe(null)}
            onConfirm={() => {
              const replaceId = dupe.check.kind === 'replace' ? dupe.check.row.id : null;
              setDupe(null);
              persist(dupe.hash, replaceId);
            }}
          />
        )}
      </div>
    </div>
  );
}

function MyClassesTab({ teacher, myAssignments }: { teacher: Teacher; myAssignments: Assignment[] }) {
  const {
    students, classRecords, classJoinLogs, financeRates, financePayments, scoringEvents, manualApprovals,
    registerClassRecord, loadFinanceData,
  } = useTeachers();

  const [monthYear, setMonthYear] = useState(currentMonthYear());
  const [showAdd, setShowAdd] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Registros (capturas) del profesor para el mes seleccionado.
  const monthRecords = useMemo(
    () => classRecords.filter(r => r.teacherId === teacher.id && (r.classDate ?? '').slice(0, 7) === monthYear),
    [classRecords, teacher.id, monthYear],
  );

  const detectedCount = monthRecords.filter(r => recordVerification(r.studentName, r.classDate, classJoinLogs, teacher.id) === 'detected').length;
  const notDetectedCount = monthRecords.length - detectedCount;

  // Resumen de pago (cálculo de finanzas).
  const payment = financePayments.find(p => p.teacherId === teacher.id && p.monthYear === monthYear) ?? null;
  const finance = useMemo(() => calculateTeacherFinance({
    teacherId: teacher.id, teacherName: teacher.name, monthYear,
    assignments: myAssignments, joinLogs: classJoinLogs, classRecords, rates: financeRates,
    scoringEvents, students, manualApprovals, payment,
  }), [teacher.id, teacher.name, monthYear, myAssignments, classJoinLogs, classRecords, financeRates, scoringEvents, students, manualApprovals, payment]);

  const todayIso = getSpainParts(new Date()).dateStr;

  // Agrupar las clases detectadas (finance.rows) por alumno, con su desglose.
  const financeGroups = useMemo(() => {
    const map = new Map<string, ClassFinanceRow[]>();
    for (const r of finance.rows) {
      if (!map.has(r.studentName)) map.set(r.studentName, []);
      map.get(r.studentName)!.push(r);
    }
    const groups = [...map.entries()].map(([name, unsorted]) => {
      const rows = [...unsorted].sort((a, b) => a.date.localeCompare(b.date));
      const asgn = myAssignments.find(a => a.studentName.trim().toLowerCase() === name.trim().toLowerCase());
      // Ex-alumno: aparece en el historial de clases pero ya no tiene assignment.
      const isExStudent = !asgn;
      const plan = asgn?.plan || rows[0]?.plan || '';
      const level = asgn?.studentLevel ?? '';
      const startDate = asgn?.startDate;
      const planTypeLabel = classifyPlan({ assignmentPlan: plan, assignmentObjetivo: asgn?.objetivo }).displayName;

      const nuevoRows = rows.filter(r => r.antiquityDays < 30);
      const antiguoRows = rows.filter(r => r.antiquityDays >= 30);
      const oldRate = nuevoRows[0]?.rate ?? 0;
      const newRate = antiguoRows[0]?.rate ?? oldRate;
      const rateChanged = nuevoRows.length > 0 && antiguoRows.length > 0 && oldRate !== newRate;
      const currentRate = rows[rows.length - 1]?.rate ?? 0;
      const antiquityToday = startDate ? Math.max(0, daysDiff(startDate, todayIso)) : 0;

      // Fecha del cruce de umbral (30 días) cuando cambió la tarifa.
      let changeIso = ''; let prevDayLabel = '';
      if (rateChanged && startDate) {
        const t = new Date(startDate + 'T00:00:00'); t.setDate(t.getDate() + 30);
        changeIso = isoOf(t);
        const prev = new Date(t); prev.setDate(prev.getDate() - 1);
        prevDayLabel = String(prev.getDate());
      }

      const pagables = rows.filter(r => r.status === 'pagable');
      const aRevisar = rows.filter(r => r.status === 'a_revisar');
      const subtotal = pagables.reduce((s, r) => s + r.rate, 0);

      return {
        name, rows, plan, planTypeLabel, level, startDate, antiquityToday, isExStudent,
        oldRate, newRate, currentRate, rateChanged, changeIso, prevDayLabel,
        subtotal, total: rows.length, pagablesCount: pagables.length, aRevisarCount: aRevisar.length,
        hasReview: aRevisar.length > 0,
      };
    });
    // Orden: primero los que tienen clases a revisar, luego alfabético.
    groups.sort((a, b) => (Number(b.hasReview) - Number(a.hasReview)) || a.name.localeCompare(b.name));
    return groups;
  }, [finance, myAssignments, todayIso]);

  function toggle(name: string) {
    setExpanded(prev => { const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n; });
  }

  /**
   * Guardar una clase desde "Añadir clase":
   *   1) el registro en class_records (tipo, hora, comentario) — igual que antes,
   *      pero SIN captura: se pasa null al parámetro de archivo.
   *   2) si el tipo requiere transcript, se analiza y se guarda en class_analyses,
   *      que es el segundo factor de verificación del cálculo de finanzas.
   * El análisis es una llamada a la IA: tarda y tiene coste, por eso solo se
   * dispara para clases normales/recuperación.
   */
  async function handleAddClass(
    studentName: string, date: string, time: string | undefined,
    transcript: string, classType: ClassRecordType, comment: string,
    transcriptHashValue: string, replaceId: string | null,
  ) {
    // Al reemplazar un transcript NO se crea otro class_record: la clase ya
    // estaba registrada y duplicarla contaría dos veces en el cálculo.
    if (!replaceId) {
      await registerClassRecord(teacher.id, studentName, date, time, null, classType, comment);
    }

    if (!transcript.trim()) return;
    const asgn = myAssignments.find(a => a.studentName === studentName);
    const base = {
      transcript: transcript.trim(),
      studentName,
      teacherName: teacher.name,
      studentId: asgn?.studentId ?? null,
      teacherId: teacher.id,
      plan: asgn?.plan ?? null,
      level: asgn?.studentLevel ?? null,
      classDate: date,
      transcriptHash: transcriptHashValue || null,
      replaceId,
    };
    // El endpoint separa analizar de guardar: primero el análisis, luego el alta
    // (o la actualización, si replaceId viene informado).
    const analysis = await analyzeTranscriptOnly(base);
    await saveAnalysis({ ...base, analysis });
    await loadFinanceData();
  }

  // Registro (captura) asociado a una clase (alumno + fecha ±1 día), si existe.
  function recordFor(name: string, date: string) {
    return classRecords.find(r =>
      r.teacherId === teacher.id && r.studentName === name && Math.abs(daysDiff(r.classDate, date)) <= 1
    ) ?? null;
  }

  // Alertas de clases a revisar: se indica exactamente cuál de los dos factores
  // falta (ingreso por el botón Meet o transcript).
  const reviewAlerts = finance.rows.filter(r => r.status === 'a_revisar').map(r => ({
    studentName: r.studentName, date: r.date, hour: r.hour,
    missing: !r.hasTranscript
      ? 'subir transcript en Añadir clase'
      : 'ingresar con el botón Meet',
  }));

  return (
    <>
      {/* Barra de mes */}
      <div className="mcf-card mcf-monthbar">
        <div className="mcf-month">
          <button className="mcf-icon-btn" aria-label="Mes anterior" onClick={() => setMonthYear(m => shiftMonth(m, -1))}>‹</button>
          <span className="mcf-month-label">{monthLabel(monthYear)}</span>
          <button className="mcf-icon-btn" aria-label="Mes siguiente" onClick={() => setMonthYear(m => shiftMonth(m, 1))}>›</button>
          <button className="mcf-btn mcf-btn-ghost mcf-btn-sm" onClick={() => setMonthYear(currentMonthYear())}>Hoy</button>
        </div>
        <button className="mcf-btn mcf-btn-primary" onClick={() => setShowAdd(true)}>Añadir clase</button>
      </div>

      <div className="mcf-content">
        {/* KPIs */}
        <div className="mcf-kpis">
          {[
            { label: 'Clases registradas este mes', value: monthRecords.length, dot: null, color: undefined },
            { label: 'Con ingreso detectado', value: detectedCount, dot: '#16a34a', color: undefined },
            { label: 'Sin ingreso detectado', value: notDetectedCount, dot: '#e0912f', color: notDetectedCount > 0 ? '#9a6516' : undefined },
            { label: 'Alumnos con clases este mes', value: financeGroups.length, dot: null, color: undefined },
          ].map(k => (
            <div key={k.label} className="mcf-card mcf-kpi">
              <div className="mcf-kpi-value" style={k.color ? { color: k.color } : undefined}>
                {k.dot && <span className="mcf-dot" style={{ background: k.dot }} />}
                {k.value}
              </div>
              <div className="mcf-kpi-label">{k.label}</div>
            </div>
          ))}
        </div>

        <div className="mcf-body">
          {/* ── Izquierda: clases por alumno ── */}
          <div className="mcf-main">
            <div className="mcf-section-title">Clases por alumno</div>

            {financeGroups.length === 0 ? (
              <div className="mcf-card mcf-empty">
                No hay clases detectadas este mes. Registrá clases con <b>Añadir clase</b> o ingresá con el botón Meet.
              </div>
            ) : financeGroups.map(g => {
              const isOpen = expanded.has(g.name);
              return (
                <div key={g.name} className="mcf-card">
                  <div className="mcf-student-head" onClick={() => toggle(g.name)}>
                    <div className="mcf-avatar">
                      {g.name.split(' ').map(p => p[0]).join('').toUpperCase().slice(0, 2)}
                    </div>

                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span className="mcf-student-name">{g.name}</span>
                        {g.isExStudent && (
                          <span className="mcf-badge-ex" title="Este alumno ya no está activo, pero sus clases del mes siguen contando para el pago">
                            ex-alumno
                          </span>
                        )}
                      </div>
                      <div className="mcf-meta" style={{ marginTop: 4 }}>
                        {g.startDate ? <>Desde {finShortDate(g.startDate)} · {g.antiquityToday} días{g.level ? ' · ' : ''}</> : null}
                        {g.level ? <>Nivel {g.level}</> : null}
                      </div>
                    </div>

                    {g.hasReview && <span className="mcf-pill is-warn"><span className="mcf-dot" style={{ background: '#e0912f' }} />A revisar</span>}

                    <div className="mcf-cols">
                      <div>
                        <div className="mcf-col-label">Plan</div>
                        <div className="mcf-col-value">{g.planTypeLabel}</div>
                      </div>
                      <div>
                        <div className="mcf-col-label">Tarifa · clases</div>
                        <div className="mcf-col-value">€{g.currentRate.toFixed(2)} · {g.total} clase{g.total !== 1 ? 's' : ''}</div>
                      </div>
                      <div>
                        <div className="mcf-col-label">Subtotal del mes</div>
                        <div className="mcf-col-value is-amount">€{g.subtotal.toFixed(2)}</div>
                      </div>
                    </div>

                    {g.rateChanged && (
                      <div className="mcf-note-inline" style={{ gridColumn: '1 / -1' }}>
                        Cambió de tarifa el {finShortDate(g.changeIso)}: €{g.oldRate.toFixed(2)} hasta el {g.prevDayLabel}, luego €{g.newRate.toFixed(2)}
                      </div>
                    )}

                    <button className="mcf-link" onClick={e => { e.stopPropagation(); toggle(g.name); }}>
                      {isOpen ? 'Ocultar detalle de clases' : 'Ver detalle de clases'}
                    </button>
                  </div>

                  {/* Detalle expandible */}
                  {isOpen && (
                    <div>
                      <div className="mcf-detail">
                        <table className="mcf-table">
                          <thead>
                            <tr>
                              {['Fecha', 'Hora', 'Ingreso', 'Transcript', 'Suscripción', 'Tarifa', 'Acción'].map(h => (
                                <th key={h}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {g.rows.map((r, i) => {
                              const rec = recordFor(g.name, r.date);
                              const ing = ingresoBadge(r);
                              const ct = classTypeBadge(r.classType);
                              const isFalta = r.classType === 'falta_sin_aviso' || r.classType === 'cancelacion_hora';
                              const isExcede = r.status === 'excede_limite' || r.status === 'excede_limite_tipo';
                              const complete = r.hasJoinLog && r.hasTranscript;
                              const sub = subscriptionBadge(r.subscriptionStatus);
                              const subDiffer = r.subAtJoin && r.subAtRecord && r.subAtJoin !== r.subAtRecord;
                              return (
                                <tr key={i} className={r.status === 'a_revisar' ? 'is-review' : undefined}>
                                  {/* Fecha */}
                                  <td>
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                      {finShortDate(r.date)}
                                      {isExcede && (
                                        <span className="mcf-dot" style={{ background: '#e0912f' }}
                                          title={r.status === 'excede_limite_tipo' ? 'Supera las 2 cobrables de este tipo' : 'Excede el límite del plan'} />
                                      )}
                                      {r.manuallyApproved && (
                                        <span className="mcf-tag" style={{ background: '#eaf5ec', color: '#1f7a3d' }} title="Aprobada manualmente por el admin">admin</span>
                                      )}
                                      {rec?.comment && (
                                        <span className="mcf-tag" style={{ background: '#f0f1ee', color: '#5f6360', cursor: 'help' }} title={rec.comment}>nota</span>
                                      )}
                                    </span>
                                  </td>
                                  {/* Hora */}
                                  <td style={{ color: '#1a1c1a', fontWeight: 600 }}>{r.hour || '—'}</td>
                                  {/* Ingreso (+ tipo de clase) */}
                                  <td>
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                      <span className="mcf-tag" style={{ background: ing.bg, color: ing.color }}>{plainLabel(ing.label)}</span>
                                      {ct && <span className="mcf-tag" style={{ background: ct.bg, color: ct.color }}>{plainLabel(ct.label)}</span>}
                                    </span>
                                  </td>
                                  {/* Transcript — segundo factor de verificación */}
                                  <td>
                                    {isFalta
                                      ? <span style={{ color: '#a4a7a1' }}>—</span>
                                      : r.hasTranscript
                                        ? <span className="mcf-tag" style={{ background: '#eaf5ec', color: '#1f7a3d' }}>Subido</span>
                                        : <span className="mcf-tag" style={{ background: '#fdf3e7', color: '#9a6516' }}>Sin subir</span>}
                                  </td>
                                  {/* Suscripción */}
                                  <td>
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                      <span className="mcf-tag" style={{ background: sub.bg, color: sub.color }}>{plainLabel(sub.label)}</span>
                                      {subDiffer && (
                                        <span style={{ cursor: 'help', color: '#a4a7a1', fontSize: 12 }}
                                          title={`Al ingresar: ${plainLabel(subscriptionBadge(r.subAtJoin).label)} · Al registrar: ${plainLabel(subscriptionBadge(r.subAtRecord).label)}`}>
                                          ·
                                        </span>
                                      )}
                                    </span>
                                  </td>
                                  {/* Tarifa */}
                                  <td style={{ color: '#1a1c1a', fontWeight: 600 }}>€{r.rate.toFixed(2)}</td>
                                  {/* Acción */}
                                  <td>
                                    {isFalta ? (
                                      r.status === 'excede_limite_tipo'
                                        ? <span className="mcf-tag" style={{ background: '#fdf3e7', color: '#9a6516' }}>Supera 2 · revisión admin</span>
                                        : <span style={{ color: '#1f7a3d', fontWeight: 600 }}>Cobrable</span>
                                    ) : !r.hasTranscript ? (
                                      <span style={{ color: '#9a6516' }}>Falta transcript</span>
                                    ) : complete ? (
                                      <span style={{ color: '#1f7a3d', fontWeight: 600 }}>Completo</span>
                                    ) : (
                                      <span style={{ color: '#a4a7a1' }} title="No se puede falsear el ingreso">
                                        Recordá usar &apos;Ingresar a clase&apos;
                                      </span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <div className="mcf-detail-foot">
                        <div>
                          Total {g.total} · Pagables <b style={{ color: '#1f7a3d' }}>{g.pagablesCount}</b> · A revisar{' '}
                          <b style={{ color: g.aRevisarCount > 0 ? '#9a6516' : '#1a1c1a' }}>{g.aRevisarCount}</b>
                        </div>
                        <div style={{ fontWeight: 600, color: '#1f7a3d' }}>Subtotal €{g.subtotal.toFixed(2)}</div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* ── Derecha (sticky): total y clases a revisar ── */}
          <aside className="mcf-side">
            <div className="mcf-card mcf-card-pad mcf-total">
              <div className="mcf-card-title">Total a cobrar · {monthLabel(monthYear)}</div>
              <div className="mcf-amount">€{finance.totalAPagar.toFixed(2)}</div>
              <span className={`mcf-pill ${finance.paymentStatus === 'paid' ? 'is-ok' : 'is-warn'}`}>
                <span className="mcf-dot" style={{ background: finance.paymentStatus === 'paid' ? '#16a34a' : '#e0912f' }} />
                {finance.paymentStatus === 'paid' ? 'Pagado' : 'Pendiente de pago'}
              </span>

              <div className="mcf-breakdown">
                <div className="mcf-brow">
                  <span className="mcf-brow-label">Clases pagables · {finance.totalPagable}</span>
                  <span className="mcf-brow-value">€{finance.montoPagable.toFixed(2)}</span>
                </div>
                <div className="mcf-brow">
                  <span className="mcf-brow-label">
                    Clases a revisar · {finance.totalARevisar}
                    <span className="mcf-brow-note"> pendiente de verificación</span>
                  </span>
                  <span className="mcf-brow-value" style={{ color: '#8b8e88' }}>€{finance.montoARevisar.toFixed(2)}</span>
                </div>
                <div className="mcf-brow">
                  <span className="mcf-brow-label">Bonos scoring</span>
                  <span className="mcf-brow-value">€{finance.bonusFromScoring.toFixed(2)}</span>
                </div>
              </div>
            </div>

            {reviewAlerts.length > 0 && (
              <div className="mcf-card mcf-card-pad mcf-review">
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
                  <span className="mcf-card-title">Clases a revisar</span>
                  <span className="mcf-counter">{reviewAlerts.length}</span>
                </div>
                {reviewAlerts.map((a, i) => (
                  <div key={i} className="mcf-review-row">
                    <span className="mcf-dot" style={{ background: '#e0912f', marginTop: 5 }} />
                    <div style={{ minWidth: 0 }}>
                      <div className="mcf-review-who">{a.studentName} · {finShortDate(a.date)}</div>
                      <div className="mcf-review-note">Falta: {a.missing}</div>
                    </div>
                    {/* Ya no hay acción de "adjuntar" acá: el transcript se sube
                        desde "Añadir clase", y el ingreso solo se puede registrar
                        durante la clase con el botón Meet. */}
                  </div>
                ))}
              </div>
            )}
          </aside>
        </div>
      </div>

      {showAdd && (
        <AddClassModal
          teacher={teacher}
          myAssignments={myAssignments}
          classRecords={classRecords}
          onClose={() => setShowAdd(false)}
          onSaved={handleAddClass}
        />
      )}

    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
function MisClasesContent() {
  const { user } = useAuth();
  const { teachers, assignments, reloadAll, loadFinanceData } = useTeachers();

  const teacher = teachers.find(t => t.id === user?.teacherId) ?? teachers[0];

  // Las assignments del profesor se traen con query DIRECTA por teacher_id, sin
  // depender del estado del contexto (que puede estar vacío momentáneamente y
  // hacía que "Añadir clase" dijera "no hay alumnos asignados"). Se usa el
  // contexto solo como fallback inicial.
  const [directAssignments, setDirectAssignments] = useState<Assignment[]>([]);
  useEffect(() => {
    loadFinanceData();
    if (teacher) dbGetAssignmentsByTeacher(teacher.id).then(setDirectAssignments);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teacher?.id]);

  const contextAssignments = teacher ? assignments.filter(a => a.teacherId === teacher.id) : [];
  const myAssignments = directAssignments.length > 0 ? directAssignments : contextAssignments;

  return (
    <div style={{ minHeight: '100vh', background: '#f4f5f2' }}>
      <NavBar />
      <PullToRefresh onRefresh={reloadAll}>
        <div className="mcf">
          <header className="mcf-head">
            <div>
              <h1 className="mcf-title">Mis clases</h1>
              <p className="mcf-sub">Registrá tus clases y consultá tu resumen de pago</p>
            </div>
            <div className="mcf-updated">
              <span className="mcf-dot" style={{ background: '#16a34a' }} />
              <LastUpdated />
            </div>
          </header>
          {teacher
            ? <MyClassesTab teacher={teacher} myAssignments={myAssignments} />
            : <div className="mcf-empty">Cargando...</div>}
        </div>
      </PullToRefresh>
    </div>
  );
}

export default function MisClasesPage() {
  return (
    <AuthGuard allowedRoles={['teacher']}>
      <MisClasesContent />
    </AuthGuard>
  );
}
