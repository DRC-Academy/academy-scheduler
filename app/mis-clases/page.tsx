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
import { Teacher, Assignment, ClassRecordType, ClassRecord } from '@/types';

// Etiquetas singular/plural por tipo de falta (para los mensajes de límite).
const FALTA_TYPE_LABELS: Record<string, { sing: string; plural: string }> = {
  falta_sin_aviso:  { sing: 'falta sin aviso',           plural: 'faltas sin aviso' },
  cancelacion_hora: { sing: 'cancelación sobre la hora', plural: 'cancelaciones sobre la hora' },
};

// Opciones del selector "Tipo de clase".
const CLASS_TYPE_OPTIONS: Array<{ value: ClassRecordType; label: string; needsCapture: boolean }> = [
  { value: 'normal',           label: '📸 Clase normal',                needsCapture: true },
  { value: 'falta_sin_aviso',  label: '🚫 Falta del alumno sin aviso',  needsCapture: false },
  { value: 'cancelacion_hora', label: '⏰ Cancelación sobre la hora',    needsCapture: false },
  { value: 'recuperacion',     label: '📋 Clase de recuperación',        needsCapture: true },
];

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

// Modal "Añadir clase"
function AddClassModal({ teacher, myAssignments, classRecords, onClose, onSaved }: {
  teacher: Teacher;
  myAssignments: Assignment[];
  classRecords: ClassRecord[];
  onClose: () => void;
  onSaved: (studentName: string, date: string, time: string | undefined, file: File | null, classType: ClassRecordType, comment: string) => Promise<void>;
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
  const [file, setFile] = useState<File | null>(null);
  const [classType, setClassType] = useState<ClassRecordType>('normal');
  const [comment, setComment] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const needsCapture = CLASS_TYPE_OPTIONS.find(o => o.value === classType)?.needsCapture ?? true;
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

  // Normal/recuperación: captura obligatoria. Falta/cancelación: comentario
  // obligatorio y bloqueado si ya llegó al límite de 2 de ese tipo.
  const canSave = !!studentName && !!date && !saving && !limitReached &&
    (needsCapture ? !!file : !!comment.trim());

  async function handleSave() {
    if (!canSave) return;
    setSaving(true); setError('');
    try {
      await onSaved(studentName, date, time || undefined, needsCapture ? file : null, classType, comment.trim());
      onClose();
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo guardar el registro.');
      setSaving(false);
    }
  }

  const inputStyle = { width: '100%', padding: '9px 12px', borderRadius: 8, border: '1.5px solid var(--border)', fontSize: 13, background: 'white', color: '#111827', fontFamily: 'inherit', boxSizing: 'border-box' as const };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div style={{ background: '#F7F7F5', border: '1px solid var(--border)', borderRadius: 16, width: '100%', maxWidth: 440, padding: 26 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <div style={{ fontWeight: 700, fontSize: 17, color: '#111827' }}>➕ Añadir clase</div>
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
                ⚠️ Este alumno ya registró 2 {typeLabel?.plural}. No se pueden registrar más con este motivo.
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
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>Hora 🇪🇸</label>
                  <input type="time" value={time} onChange={e => setTime(e.target.value)} style={inputStyle} />
                </div>
              </div>
              {needsCapture ? (
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>Captura de pantalla <span style={{ color: '#ef4444' }}>*</span></label>
                  <input type="file" accept="image/*" onChange={e => setFile(e.target.files?.[0] ?? null)} style={{ ...inputStyle, padding: '7px 10px' }} />
                  {file && <div style={{ fontSize: 11, color: '#1E9E3A', marginTop: 5 }}>📷 {file.name}</div>}
                </div>
              ) : (
                <div style={{ fontSize: 11.5, color: '#b45309', background: 'rgba(255,196,0,0.1)', border: '1px solid rgba(255,196,0,0.3)', borderRadius: 8, padding: '8px 10px', lineHeight: 1.5 }}>
                  Este tipo de clase <b>SÍ genera cobro</b> (tarifa normal del alumno), pero solo se permite hasta 2 veces. Llevás <b>{typeCount}</b> de 2 registradas.
                </div>
              )}
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
                  Comentario {needsCapture ? '(opcional)' : <span style={{ color: '#ef4444' }}>*</span>}
                </label>
                <textarea value={comment} onChange={e => setComment(e.target.value)} rows={2}
                  placeholder={needsCapture ? 'Ej: el alumno llegó tarde...' : 'Detallá el motivo (obligatorio)'}
                  style={{ ...inputStyle, resize: 'vertical' }} />
              </div>
              {error && <div style={{ fontSize: 12, color: '#ef4444' }}>{error}</div>}
              <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
                <button onClick={onClose} disabled={saving} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: '#6b7280', cursor: saving ? 'not-allowed' : 'pointer', fontSize: 14, fontFamily: 'inherit' }}>Cancelar</button>
                <button onClick={handleSave} disabled={!canSave} style={{ flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: canSave ? '#1E9E3A' : '#d1d5db', color: 'white', cursor: canSave ? 'pointer' : 'not-allowed', fontSize: 14, fontWeight: 700, fontFamily: 'inherit' }}>
                  {saving ? 'Guardando...' : 'Guardar registro'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Modal "Adjuntar captura" a una clase puntual existente.
function AttachScreenshotModal({ studentName, date, hour, onClose, onSaved }: {
  studentName: string;
  date: string;
  hour: string;
  onClose: () => void;
  onSaved: (file: File, comment: string) => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [comment, setComment] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const canSave = !!file && !saving;

  async function handleSave() {
    if (!file) return;
    setSaving(true); setError('');
    try {
      await onSaved(file, comment.trim());
      onClose();
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo guardar la captura.');
      setSaving(false);
    }
  }

  const inputStyle = { width: '100%', padding: '9px 12px', borderRadius: 8, border: '1.5px solid var(--border)', fontSize: 13, background: 'white', color: '#111827', fontFamily: 'inherit', boxSizing: 'border-box' as const };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div style={{ background: '#F7F7F5', border: '1px solid var(--border)', borderRadius: 16, width: '100%', maxWidth: 420, padding: 26 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <div style={{ fontWeight: 700, fontSize: 16, color: '#111827' }}>📷 Adjuntar captura</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#6b7280' }}>✕</button>
        </div>
        <div style={{ fontSize: 12.5, color: '#6b7280', marginBottom: 16 }}>
          <b style={{ color: '#111827' }}>{studentName}</b> — {finShortDate(date)}{hour ? ` ${hour}` : ''}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>Captura de pantalla <span style={{ color: '#ef4444' }}>*</span></label>
            <input type="file" accept="image/*" onChange={e => setFile(e.target.files?.[0] ?? null)} style={{ ...inputStyle, padding: '7px 10px' }} />
            {file && <div style={{ fontSize: 11, color: '#1E9E3A', marginTop: 5 }}>📷 {file.name}</div>}
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>Comentario (opcional)</label>
            <textarea value={comment} onChange={e => setComment(e.target.value)} rows={2} placeholder="Ej: Clase de recuperación, el alumno llegó tarde..." style={{ ...inputStyle, resize: 'vertical' }} />
          </div>
          {error && <div style={{ fontSize: 12, color: '#ef4444' }}>{error}</div>}
          <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
            <button onClick={onClose} disabled={saving} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: '#6b7280', cursor: saving ? 'not-allowed' : 'pointer', fontSize: 14, fontFamily: 'inherit' }}>Cancelar</button>
            <button onClick={handleSave} disabled={!canSave} style={{ flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: canSave ? '#1E9E3A' : '#d1d5db', color: 'white', cursor: canSave ? 'pointer' : 'not-allowed', fontSize: 14, fontWeight: 700, fontFamily: 'inherit' }}>
              {saving ? 'Guardando...' : 'Guardar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MyClassesTab({ teacher, myAssignments }: { teacher: Teacher; myAssignments: Assignment[] }) {
  const {
    students, classRecords, classJoinLogs, financeRates, financePayments, scoringEvents, manualApprovals,
    registerClassRecord, attachScreenshotToClass,
  } = useTeachers();

  const [monthYear, setMonthYear] = useState(currentMonthYear());
  const [showAdd, setShowAdd] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Clase a la que se le va a adjuntar una captura desde la tabla.
  const [attachTarget, setAttachTarget] = useState<{ studentName: string; date: string; hour: string } | null>(null);

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

  // Registro (captura) asociado a una clase (alumno + fecha ±1 día), si existe.
  function recordFor(name: string, date: string) {
    return classRecords.find(r =>
      r.teacherId === teacher.id && r.studentName === name && Math.abs(daysDiff(r.classDate, date)) <= 1
    ) ?? null;
  }

  // Alertas de clases a revisar (qué falta).
  const reviewAlerts = finance.rows.filter(r => r.status === 'a_revisar').map(r => ({
    studentName: r.studentName, date: r.date,
    missing: !r.hasScreenshot ? 'registrar con captura' : 'ingresar con el botón Meet',
  }));

  const card = { background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header: mes + añadir */}
      <div style={{ ...card, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 17, color: 'var(--text-primary)' }}>Mis clases — {monthLabel(monthYear)}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <button onClick={() => setMonthYear(m => shiftMonth(m, -1))} style={{ padding: '5px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}>‹ Mes anterior</button>
            <button onClick={() => setMonthYear(currentMonthYear())} style={{ padding: '5px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-surface-2)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit' }}>Hoy</button>
            <button onClick={() => setMonthYear(m => shiftMonth(m, 1))} style={{ padding: '5px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}>Mes siguiente ›</button>
          </div>
        </div>
        <button onClick={() => setShowAdd(true)} style={{ padding: '10px 18px', borderRadius: 9, border: 'none', background: '#1E9E3A', color: 'white', fontWeight: 700, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit' }}>
          ＋ Añadir clase
        </button>
      </div>

      {/* Contadores */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        {[
          { label: 'Total clases registradas este mes', value: monthRecords.length, color: 'var(--text-primary)' },
          { label: 'Con ingreso detectado', value: `${detectedCount} ✅`, color: '#1E9E3A' },
          { label: 'Sin ingreso detectado', value: `${notDetectedCount} ⚠️`, color: notDetectedCount > 0 ? '#ea580c' : '#1E9E3A' },
          { label: 'Alumnos con clases este mes', value: financeGroups.length, color: '#1E9E3A' },
        ].map(c => (
          <div key={c.label} style={card}>
            <div style={{ fontSize: 24, fontWeight: 700, color: c.color }}>{c.value}</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3 }}>{c.label}</div>
          </div>
        ))}
      </div>

      {/* Clases por alumno — desglose detallado */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>Clases por alumno</div>
        {financeGroups.length === 0 ? (
          <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            No hay clases detectadas este mes. Registrá clases con <b>＋ Añadir clase</b> o ingresá con el botón Meet.
          </div>
        ) : financeGroups.map(g => {
          const isOpen = expanded.has(g.name);
          return (
            <div key={g.name} style={{ borderBottom: '1px solid var(--border)' }}>
              {/* Cabecera de la card */}
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '14px 18px', cursor: 'pointer' }} onClick={() => toggle(g.name)}>
                <div style={{ width: 38, height: 38, borderRadius: '50%', background: 'rgba(34,197,94,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#16a34a', flexShrink: 0 }}>
                  {g.name.split(' ').map(p => p[0]).join('').toUpperCase().slice(0, 2)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                    <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>
                      {g.name}
                      {g.isExStudent && <span style={{ marginLeft: 7, fontSize: 11, fontWeight: 600, color: '#9ca3af' }} title="Este alumno ya no está activo, pero sus clases del mes siguen contando para el pago">[ex-alumno]</span>}
                    </div>
                    <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                      {g.total} clase{g.total !== 1 ? 's' : ''} · €{g.currentRate.toFixed(2)}/clase
                    </div>
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 3 }}>
                    Plan: <b style={{ color: 'var(--text-secondary)' }}>{g.planTypeLabel}</b>{g.level ? <> · Nivel: <b style={{ color: 'var(--text-secondary)' }}>{g.level}</b></> : null}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
                    {g.startDate ? <>Inicio: <b style={{ color: 'var(--text-secondary)' }}>{finShortDate(g.startDate)}</b> · Antigüedad: <b style={{ color: 'var(--text-secondary)' }}>{g.antiquityToday} días</b> · </> : null}
                    Tarifa actual: <b style={{ color: 'var(--text-secondary)' }}>€{g.currentRate.toFixed(2)}</b>
                    {g.rateChanged && <span style={{ color: 'var(--text-muted)' }}> (€{g.oldRate.toFixed(2)} hasta el {g.prevDayLabel}, luego €{g.newRate.toFixed(2)})</span>}
                  </div>
                  <div style={{ fontSize: 12, color: '#1E9E3A', fontWeight: 700, marginTop: 5 }}>
                    Subtotal del mes: €{g.subtotal.toFixed(2)}
                  </div>
                  {/* Indicador de cambio de tarifa */}
                  {g.rateChanged && (
                    <div style={{ marginTop: 8, fontSize: 11.5, color: '#b45309', background: 'rgba(255,196,0,0.12)', border: '1px solid rgba(255,196,0,0.4)', borderRadius: 8, padding: '6px 10px', display: 'inline-block' }}>
                      📈 Este alumno cambió de tarifa el {finShortDate(g.changeIso)} (pasó a tarifa de alumno con antigüedad)
                    </div>
                  )}
                  <div style={{ fontSize: 12, color: '#1E9E3A', fontWeight: 600, marginTop: 8 }}>
                    {isOpen ? 'Ocultar detalle de clases ▲' : 'Ver detalle de clases ▼'}
                  </div>
                </div>
                {g.hasReview && (
                  <span style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 10, background: 'rgba(255,196,0,0.15)', color: '#b45309', fontWeight: 700, whiteSpace: 'nowrap', flexShrink: 0 }}>A revisar</span>
                )}
              </div>

              {/* Detalle expandible */}
              {isOpen && (
                <div>
                  <div style={{ overflowX: 'auto', borderTop: '1px solid var(--border)', background: 'var(--bg-surface-2)' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 760 }}>
                      <thead>
                        <tr style={{ textAlign: 'left' }}>
                          {['Fecha', 'Hora', 'Ingreso', 'Captura', 'Suscripción', 'Tarifa', 'Acción'].map(h => (
                            <th key={h} style={{ padding: '8px 16px', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{h}</th>
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
                          const complete = r.hasJoinLog && r.hasScreenshot;
                          const sub = subscriptionBadge(r.subscriptionStatus);
                          const subDiffer = r.subAtJoin && r.subAtRecord && r.subAtJoin !== r.subAtRecord;
                          return (
                            <tr key={i} style={{ borderTop: '1px solid var(--border)', background: r.status === 'a_revisar' ? 'rgba(255,196,0,0.07)' : 'transparent' }}>
                              {/* Fecha */}
                              <td style={{ padding: '8px 16px', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                  {finShortDate(r.date)}
                                  {isExcede && <span title={r.status === 'excede_limite_tipo' ? 'Supera las 2 cobrables de este tipo' : 'Excede el límite del plan'}>🔶</span>}
                                  {r.manuallyApproved && <span style={{ fontSize: 10, color: '#1E9E3A', fontWeight: 700 }} title="Aprobada manualmente por el admin">✓admin</span>}
                                  {rec?.comment && <span title={rec.comment} style={{ cursor: 'help' }}>💬</span>}
                                </span>
                              </td>
                              {/* Hora */}
                              <td style={{ padding: '8px 16px', whiteSpace: 'nowrap', color: 'var(--text-primary)', fontWeight: 600 }}>{r.hour || '—'}</td>
                              {/* Ingreso (+ tipo de clase) */}
                              <td style={{ padding: '8px 16px', whiteSpace: 'nowrap' }}>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                                  <span style={{ fontSize: 11, padding: '2px 9px', borderRadius: 12, background: ing.bg, color: ing.color, fontWeight: 700 }}>{ing.label}</span>
                                  {ct && <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 10, background: ct.bg, color: ct.color, fontWeight: 700 }}>{ct.label}</span>}
                                </span>
                              </td>
                              {/* Captura */}
                              <td style={{ padding: '8px 16px', whiteSpace: 'nowrap' }}>
                                {isFalta
                                  ? <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>—</span>
                                  : r.hasScreenshot
                                    ? <a href={rec?.screenshotUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, padding: '2px 9px', borderRadius: 12, background: 'rgba(30,158,58,0.1)', color: '#1E9E3A', fontWeight: 700, textDecoration: 'none' }}>📷 Ver</a>
                                    : <span style={{ fontSize: 11, padding: '2px 9px', borderRadius: 12, background: 'rgba(255,196,0,0.18)', color: '#b45309', fontWeight: 700 }}>⚠️ Sin cargar</span>}
                              </td>
                              {/* Suscripción */}
                              <td style={{ padding: '8px 16px', whiteSpace: 'nowrap' }}>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                  <span style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 10, background: sub.bg, color: sub.color, fontWeight: 700 }}>{sub.label}</span>
                                  {subDiffer && <span style={{ cursor: 'help' }} title={`Al ingresar: ${subscriptionBadge(r.subAtJoin).label.replace(/^[^ ]+ /, '')} · Al registrar: ${subscriptionBadge(r.subAtRecord).label.replace(/^[^ ]+ /, '')}`}>ℹ️</span>}
                                </span>
                              </td>
                              {/* Tarifa */}
                              <td style={{ padding: '8px 16px', whiteSpace: 'nowrap', color: 'var(--text-primary)', fontWeight: 600 }}>€{r.rate.toFixed(2)}</td>
                              {/* Acción */}
                              <td style={{ padding: '8px 16px', whiteSpace: 'nowrap' }}>
                                {isFalta ? (
                                  r.status === 'excede_limite_tipo'
                                    ? <span style={{ fontSize: 11, padding: '2px 9px', borderRadius: 12, background: 'rgba(249,115,22,0.12)', color: '#ea580c', fontWeight: 700 }}>Supera 2 · revisión admin</span>
                                    : <span style={{ fontSize: 11, color: '#1E9E3A', fontWeight: 700 }}>✓ Cobrable</span>
                                ) : !r.hasScreenshot ? (
                                  <button onClick={() => setAttachTarget({ studentName: g.name, date: r.date, hour: r.hour })}
                                    style={{ padding: '5px 11px', borderRadius: 7, border: '1px solid rgba(30,158,58,0.4)', background: 'rgba(30,158,58,0.08)', color: '#1E9E3A', cursor: 'pointer', fontSize: 11, fontWeight: 700, fontFamily: 'inherit' }}>
                                    📷 Adjuntar captura
                                  </button>
                                ) : complete ? (
                                  <span style={{ fontSize: 11, color: '#1E9E3A', fontWeight: 700 }}>✓ Completo</span>
                                ) : (
                                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }} title="No se puede falsear el ingreso">ℹ️ Recordá usar &apos;Ingresar a clase&apos; la próxima vez</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {/* Pie de la card */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 18px', borderTop: '1px solid var(--border)', background: 'var(--bg-surface-2)' }}>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      Total clases: <b style={{ color: 'var(--text-primary)' }}>{g.total}</b> · Pagables: <b style={{ color: '#1E9E3A' }}>{g.pagablesCount}</b> · A revisar: <b style={{ color: g.aRevisarCount > 0 ? '#b45309' : 'var(--text-primary)' }}>{g.aRevisarCount}</b>
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#1E9E3A' }}>Subtotal: €{g.subtotal.toFixed(2)}</div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Resumen de pago */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 22px' }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)', marginBottom: 14 }}>Resumen de pago — {monthLabel(monthYear)}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, maxWidth: 460 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--text-secondary)' }}>Clases pagables: <b style={{ color: 'var(--text-primary)' }}>{finance.totalPagable}</b></span>
            <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>€{finance.montoPagable.toFixed(2)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--text-secondary)' }}>Clases a revisar: <b style={{ color: 'var(--text-primary)' }}>{finance.totalARevisar}</b> <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>(pendiente de verificación)</span></span>
            <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>€{finance.montoARevisar.toFixed(2)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--text-secondary)' }}>Bonos (scoring):</span>
            <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>€{finance.bonusFromScoring.toFixed(2)}</span>
          </div>
          <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15 }}>
            <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>Total a cobrar:</span>
            <span style={{ color: '#1E9E3A', fontWeight: 800 }}>€{finance.totalAPagar.toFixed(2)}</span>
          </div>
          <div style={{ marginTop: 4 }}>
            <span style={{ fontSize: 12, padding: '3px 12px', borderRadius: 12, fontWeight: 700, background: finance.paymentStatus === 'paid' ? 'rgba(30,158,58,0.12)' : 'rgba(255,196,0,0.15)', color: finance.paymentStatus === 'paid' ? '#1E9E3A' : '#b45309' }}>
              {finance.paymentStatus === 'paid' ? '✅ Pagado' : '⏳ Pendiente de pago'}
            </span>
          </div>
        </div>

        {reviewAlerts.length > 0 && (
          <div style={{ marginTop: 18 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>Clases a revisar</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {reviewAlerts.map((a, i) => (
                <div key={i} style={{ fontSize: 12, color: '#b45309', background: 'rgba(255,196,0,0.1)', border: '1px solid rgba(255,196,0,0.3)', borderRadius: 8, padding: '7px 12px' }}>
                  ⚠️ <b>{a.studentName}</b> — {finShortDate(a.date)} — Falta: {a.missing}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {showAdd && (
        <AddClassModal
          teacher={teacher}
          myAssignments={myAssignments}
          classRecords={classRecords}
          onClose={() => setShowAdd(false)}
          onSaved={(studentName, date, time, file, classType, comment) => registerClassRecord(teacher.id, studentName, date, time, file, classType, comment)}
        />
      )}

      {attachTarget && (
        <AttachScreenshotModal
          studentName={attachTarget.studentName}
          date={attachTarget.date}
          hour={attachTarget.hour}
          onClose={() => setAttachTarget(null)}
          onSaved={(file, comment) => attachScreenshotToClass(teacher.id, attachTarget.studentName, attachTarget.date, attachTarget.hour || undefined, file, comment || undefined)}
        />
      )}
    </div>
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
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }}>
      <NavBar />
      <PullToRefresh onRefresh={reloadAll}>
        <div style={{ maxWidth: 980, margin: '0 auto', padding: '32px 16px 48px' }}>
          <LastUpdated />
          <div style={{ marginBottom: 24 }}>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 4px' }}>💰 Mis clases</h1>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>Registrá tus clases y consultá tu resumen de pago</p>
          </div>
          {teacher
            ? <MyClassesTab teacher={teacher} myAssignments={myAssignments} />
            : <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-muted)' }}>Cargando...</div>}
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
