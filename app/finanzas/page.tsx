'use client';
import { useState, useEffect, useMemo } from 'react';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { PullToRefresh } from '@/components/PullToRefresh';
import { LastUpdated } from '@/components/LastUpdated';
import { getSpainParts } from '@/components/VisualCalendar';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import { calculateTeacherFinance, TeacherFinanceResult, ClassFinanceRow, ingresoBadge, classTypeBadge, subscriptionBadge, rowHoursLabel, financeStatusBadge, pendingTranscriptSummary, transcriptStateBadge, absenceBreakdownLabel, isStudentAbsence, mixedSessionBadge, recoveryCreditLabel, SUBSCRIPTION_STATUS_OPTIONS } from '@/lib/finance';
import { classifyPlan } from '@/lib/productUtils';
import { gridOccupancyOfTeacher } from '@/lib/teacherClasses';
import { dbRevertPenalty } from '@/lib/db';
import { Assignment, ScoringEvent, FinanceManualApproval } from '@/types';

// ─── Finance helpers ──────────────────────────────────────────────────────────
const FIN_MONTHS_ADMIN = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
function finMonthLabel(monthYear: string): string {
  const [y, m] = monthYear.split('-').map(Number);
  return `${FIN_MONTHS_ADMIN[(m ?? 1) - 1]} ${y}`;
}
function finDateShort(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  return `${String(d.getDate()).padStart(2, '0')} ${FIN_MONTHS_ADMIN[d.getMonth()].slice(0, 3)}`;
}

// Las etiquetas y colores de estado salen de lib/finance (financeStatusBadge):
// una sola fuente para esta pantalla y la del profesor.

const PILL_OK   = { background: 'var(--ok-soft)',   color: 'var(--ok)' };

/**
 * Quién aprobó a mano esa clase y cuándo. Pagar una clase sin transcript es la
 * única forma de saltarse el nivel 2, así que la fila tiene que poder responder
 * quién lo decidió sin ir a buscarlo a la base.
 */
const nkStudent = (s: string) => (s ?? '').trim().toLowerCase();
function findApproval(approvals: FinanceManualApproval[], teacherId: string, studentName: string, date: string) {
  return approvals.find(a =>
    a.teacherId === teacherId && nkStudent(a.studentName) === nkStudent(studentName) && a.classDate === date);
}
function approvalBy(approvals: FinanceManualApproval[], teacherId: string, studentName: string, date: string): string {
  const a = findApproval(approvals, teacherId, studentName, date);
  return a?.approvedBy ? ` · ${a.approvedBy}` : '';
}
function approvalTrace(approvals: FinanceManualApproval[], teacherId: string, studentName: string, date: string): string {
  const a = findApproval(approvals, teacherId, studentName, date);
  if (!a) return 'Aprobada manualmente por el equipo';
  const cuando = (a.approvedAt ?? '').replace('T', ' ').slice(0, 16);
  const motivo = a.reason === 'excede_limite_aprobado' ? 'incluida pese a exceder el límite' : 'pagada sin transcript';
  return `${motivo} — ${a.approvedBy || 'sin registrar'}${cuando ? ` el ${cuando}` : ''}`;
}
const PILL_WARN = { background: 'var(--warn-soft)', color: 'var(--warn)' };

/**
 * Saldo del mes del profesor. Va ARRIBA del detalle porque es el dato que se
 * busca al abrirlo: antes solo estaba en una columna de la fila plegada, que es
 * justo la que se pierde de vista cuando la tabla se desplaza en horizontal.
 */
function TeacherTotalCard({ result, monthLabel }: { result: TeacherFinanceResult; monthLabel: string }) {
  const pendiente = pendingTranscriptSummary(result);
  const desglose: Array<{ label: string; value: string; tone?: 'ok' | 'warn' | 'danger' }> = [
    { label: 'Clases pagables', value: `${result.totalPagable} · €${result.montoPagable.toFixed(2)}` },
  ];
  if (pendiente)
    desglose.push({ label: 'Pendiente de transcript', value: `${pendiente.classes} · €${pendiente.amount.toFixed(2)}`, tone: 'warn' });
  if (result.montoRetenido > 0)
    desglose.push({ label: 'Retenido', value: `€${result.montoRetenido.toFixed(2)}`, tone: 'warn' });
  if (result.bonusFromScoring > 0)
    desglose.push({ label: 'Bonos', value: `+€${result.bonusFromScoring.toFixed(2)}`, tone: 'ok' });
  if (result.penaltiesFromScoring < 0)
    desglose.push({ label: 'Penalizaciones', value: `−€${Math.abs(result.penaltiesFromScoring).toFixed(2)}`, tone: 'danger' });

  return (
    <div className="afd-total">
      <div className="afd-total-head">
        <div>
          <div className="afd-total-label">Total a cobrar · {monthLabel}</div>
          <div className="afd-total-value">€{result.totalAPagar.toFixed(2)}</div>
        </div>
        <span className="afd-pill" style={result.paymentStatus === 'paid' ? PILL_OK : PILL_WARN}>
          {result.paymentStatus === 'paid' ? '✅ Pagado' : '⏳ Pendiente'}
        </span>
      </div>
      {/* Estado de la suscripción de las clases pagables. Una línea por estado,
          para que "pendiente de cancelación" (el alumno estaba al día) no se lea
          igual que "en espera" (no podía tomar clases). Ninguna cambia el importe. */}
      {result.payableSubStatuses.map(s => (
        <div key={s.status} style={{
          marginTop: 'var(--space-2)', fontSize: 'var(--fs-caption)',
          color: s.countsAsActive ? 'var(--text-muted)' : 'var(--warn)',
        }}>
          {s.countsAsActive ? 'ℹ️' : '⚠️'} {s.count === 1 ? '1 clase pagable' : `${s.count} clases pagables`}
          {' '}con la suscripción en «{s.label}»
          {s.countsAsActive ? ' (vigente: el alumno podía tomar clases).' : ' (sin acceso al momento de darse).'}
        </div>
      ))}
      <div className="afd-break">
        {desglose.map(d => (
          <div key={d.label}>
            <div className="afd-brow-label">{d.label}</div>
            <div className={`afd-brow-value${d.tone ? ` is-${d.tone}` : ''}`}>{d.value}</div>
          </div>
        ))}
      </div>
      {/* El total de arriba NO incluye lo pendiente: se dice explícitamente para
          que nadie sume mentalmente las dos cifras. */}
      {pendiente && (
        <div style={{ marginTop: 'var(--space-2)', fontSize: 'var(--fs-caption)', color: '#9a6516' }}>
          {pendiente.label} — no suma al total hasta que el profesor suba el transcript.
        </div>
      )}
    </div>
  );
}

/**
 * Clases de un alumno. Una tarjeta por clase en vez de una fila de tabla: los
 * badges envuelven en lugar de estirar el ancho, así que no hay `min-width` que
 * obligue a desplazarse en horizontal para leer el estado o el botón de aprobar.
 */
function ClassCards({ result, studentName, approvals, onApproveReview, onApproveExceed, onRevertAbsence }: {
  result: TeacherFinanceResult;
  studentName: string;
  approvals: FinanceManualApproval[];
  onApproveReview: (date: string) => void;
  onApproveExceed: (date: string) => void;
  onRevertAbsence: (row: ClassFinanceRow) => void;
}) {
  const rows = result.rows.filter(r => r.studentName === studentName);
  if (rows.length === 0) return <div className="afd-empty">Sin clases registradas este mes.</div>;

  return (
    <div className="afd-classes">
      {rows.map((r, i) => {
        const st = financeStatusBadge(r.status);
        const ing = ingresoBadge(r);
        const ct = classTypeBadge(r.classType);
        const ts = transcriptStateBadge(r.transcriptState);
        const isFalta = r.classType === 'falta_sin_aviso' || r.classType === 'cancelacion_hora';
        const sub = subscriptionBadge(r.subscriptionStatus);
        // Bloque de 2h "normal + recuperación": por qué paga doble y qué clase
        // perdida salda. Mismas funciones que usa el panel del profesor.
        const mixed = mixedSessionBadge(r);
        const recNote = recoveryCreditLabel(r);
        const subDiffer = r.subAtJoin && r.subAtRecord && r.subAtJoin !== r.subAtRecord;
        const editable = result.paymentStatus !== 'paid' && !r.manuallyApproved;
        return (
          <div className="afd-class" key={i}>
            <div className="afd-class-date">{finDateShort(r.date)}</div>
            {/* Importe = tarifa × unidades. Una sesión de 2h cobra 2× la tarifa. */}
            <div className="afd-class-amount" title={r.billingUnits > 1 ? `${r.billingUnits} × €${r.rate.toFixed(2)}` : undefined}>
              €{(r.rate * r.billingUnits).toFixed(2)}
              {r.billingUnits > 1 && (
                <span className="afd-pill" style={{ ...PILL_OK, marginLeft: 6 }}>{r.durationHours}h ×{r.billingUnits}</span>
              )}
            </div>
            <div className="afd-badges">
              <span className="afd-pill" style={{ background: st.bg, color: st.color }}>{st.label}</span>
              {ct && <span className="afd-pill" style={{ background: ct.bg, color: ct.color }}>{ct.label}</span>}
              {mixed && <span className="afd-pill" style={{ background: mixed.bg, color: mixed.color }} title={recNote ?? undefined}>{mixed.label}</span>}
              <span className="afd-pill" style={{ background: ing.bg, color: ing.color }}>{ing.label}</span>
              {/* Transcript: NIVEL 2. Los cuatro estados salen de lib/finance, para
                  que el admin lea exactamente lo mismo que ve el profesor. Una
                  falta no lleva transcript, así que ahí no se pide ninguno. */}
              {isFalta
                ? <span className="afd-pill" style={{ background: 'var(--bg-surface-3)', color: 'var(--text-muted)' }}>Sin transcript (no aplica)</span>
                : <span className="afd-pill" style={{ background: ts.bg, color: ts.color }}>{ts.label}</span>}
              <span className="afd-pill" style={{ background: sub.bg, color: sub.color }}>{sub.label}</span>
              {subDiffer && (
                <span style={{ cursor: 'help' }} title={`Al ingresar: ${subscriptionBadge(r.subAtJoin).label.replace(/^[^ ]+ /, '')} · Al registrar: ${subscriptionBadge(r.subAtRecord).label.replace(/^[^ ]+ /, '')}`}>ℹ️</span>
              )}
              {/* Trazabilidad: pagar sin transcript es una decisión manual, así que
                  la fila dice quién la tomó y cuándo (finance_manual_approvals). */}
              {r.manuallyApproved && (
                <span className="afd-pill" style={PILL_OK} title={approvalTrace(approvals, result.teacherId, r.studentName, r.date)}>
                  ✓ Aprobada{approvalBy(approvals, result.teacherId, r.studentName, r.date)}
                </span>
              )}
            </div>
            {/* Falta sin aviso del alumno: qué se cobró y por qué. Misma frase
                que ve el profesor en su desglose (fuente única, lib/finance). */}
            {absenceBreakdownLabel(r) && (
              <div style={{ fontSize: 12.5, color: '#b45309', lineHeight: 1.5, marginTop: 2 }}>
                {absenceBreakdownLabel(r)}
              </div>
            )}
            {/* Parte de RECUPERACIÓN: por qué la sesión paga las horas que paga y
                cuántas clases del mes consume de verdad. Misma frase que ve el
                profesor (fuente única, lib/finance.recoveryCreditLabel). */}
            {recNote && (
              <div style={{ fontSize: 12.5, color: '#8a6d00', lineHeight: 1.5, marginTop: 2 }}>
                {recNote}
              </div>
            )}
            {/* Revertir una falta marcada por error. La clase vuelve a pendiente y
                deja de contar para el pago, el tope del mes y el cupo del alumno. */}
            {isStudentAbsence(r.classType) && r.recordId && result.paymentStatus !== 'paid' && (
              <div className="afd-action">
                <button className="afd-btn" onClick={() => onRevertAbsence(r)}>↩ Revertir falta</button>
              </div>
            )}
            {/* Pagar una clase que entró (tiene ingreso) pero sigue sin transcript.
                No hay botón para las que nunca entraron: sin ingreso no hay fila. */}
            {editable && r.status === 'a_revisar' && (
              <div className="afd-action">
                <button className="afd-btn" onClick={() => onApproveReview(r.date)}>✓ Pagar sin transcript</button>
              </div>
            )}
            {editable && (r.status === 'excede_limite' || r.status === 'excede_limite_tipo') && (
              <div className="afd-action">
                <button className="afd-btn" onClick={() => onApproveExceed(r.date)}>✓ Incluir igual</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Alumnos del profesor, plegados. La fila plegada deja ver lo que importa para
 * comparar (nombre, clases, subtotal, estado); al abrir aparecen la ficha y las
 * clases, sin tabla anidada y por tanto sin scroll lateral.
 */
function StudentDetailList({ result, assignments, approvals, onApproveReview, onApproveExceed, onRevertAbsence }: {
  result: TeacherFinanceResult;
  assignments: Assignment[];
  approvals: FinanceManualApproval[];
  onApproveReview: (studentName: string, date: string) => void;
  onApproveExceed: (studentName: string, date: string) => void;
  onRevertAbsence: (row: ClassFinanceRow) => void;
}) {
  const [openStudent, setOpenStudent] = useState<string | null>(null);

  // Agrupar filas por alumno.
  const byStudent = new Map<string, ClassFinanceRow[]>();
  for (const r of result.rows) {
    if (!byStudent.has(r.studentName)) byStudent.set(r.studentName, []);
    byStudent.get(r.studentName)!.push(r);
  }
  const students = [...byStudent.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  if (students.length === 0) return <div className="afd-empty">Sin clases registradas este mes.</div>;

  return (
    <div>
      <div className="afd-section-title">Alumnos ({students.length})</div>
      <div className="afd-students">
        {students.map(([name, rows]) => {
          const asgn = assignments.find(a => a.teacherId === result.teacherId && a.studentName === name);
          const pagables = rows.filter(r => r.status === 'pagable');
          // En unidades: una sesión de 2h son 2 clases pagables y 2× la tarifa.
          const pagableUnits = pagables.reduce((s, r) => s + r.billingUnits, 0);
          const subtotal = pagables.reduce((s, r) => s + r.rate * r.billingUnits, 0);
          const antiquity = rows[0]?.antiquityDays ?? 0;
          const rate = rows[0]?.rate ?? 0;
          const isOpen = openStudent === name;
          // Clases dadas que todavía no se cobran por no tener transcript.
          const pendientes = rows.filter(r => r.status === 'a_revisar');
          const hasReview = pendientes.length > 0;
          const pendienteAmount = pendientes.reduce((s, r) => s + r.rate * r.billingUnits, 0);
          return (
            <div key={name} className={`afd-student${isOpen ? ' is-open' : ''}`}>
              <button className="afd-student-head" aria-expanded={isOpen}
                onClick={() => setOpenStudent(isOpen ? null : name)}>
                <span className="afd-student-name">
                  <span aria-hidden>{isOpen ? '▾' : '▸'}</span>
                  <span style={{ overflowWrap: 'anywhere' }}>{name}</span>
                </span>
                <span className="afd-student-right">
                  <span className="afd-student-count">{pagableUnits} {pagableUnits === 1 ? 'clase' : 'clases'}</span>
                  <span className="afd-pill" style={hasReview ? PILL_WARN : PILL_OK}
                    title={hasReview ? `€${pendienteAmount.toFixed(2)} sin cobrar por falta de transcript` : undefined}>
                    {hasReview ? 'Pendiente de transcript' : 'OK'}
                  </span>
                  <span className="afd-student-amount">€{subtotal.toFixed(2)}</span>
                </span>
              </button>

              {isOpen && (
                <>
                  <div className="afd-meta">
                    <div>
                      <div className="afd-meta-label">Plan</div>
                      <div className="afd-meta-value">{rows[0]?.planLabel ?? '—'}</div>
                    </div>
                    <div>
                      <div className="afd-meta-label">Inicio</div>
                      <div className="afd-meta-value">{asgn?.startDate ? finDateShort(asgn.startDate) : '—'}</div>
                    </div>
                    <div>
                      <div className="afd-meta-label">Antigüedad</div>
                      <div className="afd-meta-value">{antiquity}d</div>
                    </div>
                    <div>
                      <div className="afd-meta-label">Tarifa</div>
                      <div className="afd-meta-value">€{rate.toFixed(2)}</div>
                    </div>
                    <div>
                      <div className="afd-meta-label">Clases pagables</div>
                      <div className="afd-meta-value">
                        {pagableUnits}
                        {pagableUnits !== pagables.length && ` (${pagables.length} sesiones)`}
                      </div>
                    </div>
                    <div>
                      <div className="afd-meta-label">Subtotal</div>
                      <div className="afd-meta-value" style={{ color: 'var(--ok)', fontWeight: 'var(--fw-semibold)' }}>€{subtotal.toFixed(2)}</div>
                    </div>
                    {hasReview && (
                      <div>
                        <div className="afd-meta-label">Pendiente de transcript</div>
                        <div className="afd-meta-value" style={{ color: '#9a6516', fontWeight: 'var(--fw-semibold)' }}>
                          €{pendienteAmount.toFixed(2)} · {pendientes.length}
                        </div>
                      </div>
                    )}
                  </div>
                  <ClassCards
                    result={result} studentName={name} approvals={approvals}
                    onApproveReview={date => onApproveReview(name, date)}
                    onApproveExceed={date => onApproveExceed(name, date)}
                    onRevertAbsence={onRevertAbsence}
                  />
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FinanceTab() {
  const { user } = useAuth();
  const {
    teachers, students, assignments, classJoinLogs, classRecords, classAnalyses, financeRates, financePayments,
    scoringEvents, manualApprovals,
    loadFinanceData, markPaymentAsPaid, approveReviewClass, approveExceedLimitClass, revertStudentAbsence,
  } = useTeachers();
  const approvedBy = user?.displayName || user?.username || 'admin';

  const nowSpain = getSpainParts(new Date());
  const [monthYear, setMonthYear] = useState(nowSpain.dateStr.slice(0, 7));
  const [teacherFilter, setTeacherFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'paid' | 'pending'>('all');
  const [subFilter, setSubFilter] = useState('all'); // estado de suscripción
  const [expandedTeacher, setExpandedTeacher] = useState<string | null>(null);
  const [paying, setPaying] = useState<string | null>(null);
  // Reversión de penalización (Bloque 4.5).
  const [revertModal, setRevertModal] = useState<ScoringEvent | null>(null);
  const [revertReason, setRevertReason] = useState('');
  const [reverting, setReverting] = useState(false);
  // Reversión de una falta sin aviso del ALUMNO (otra cosa que la penalización).
  const [absenceModal, setAbsenceModal] = useState<{ row: ClassFinanceRow; teacherName: string } | null>(null);
  const [absenceError, setAbsenceError] = useState('');
  const [revertingAbsence, setRevertingAbsence] = useState(false);

  async function handleRevertAbsence() {
    if (!absenceModal?.row.recordId) return;
    setRevertingAbsence(true); setAbsenceError('');
    try {
      await revertStudentAbsence(absenceModal.row.recordId, approvedBy);
      setAbsenceModal(null);
      await loadFinanceData();
    } catch (e) {
      setAbsenceError((e as Error).message || 'No se pudo revertir la falta.');
    } finally {
      setRevertingAbsence(false);
    }
  }

  async function handleRevert() {
    if (!revertModal || !revertReason.trim()) return;
    setReverting(true);
    try {
      await dbRevertPenalty({
        penaltyId: revertModal.id, teacherId: revertModal.teacherId, teacherName: revertModal.teacherName,
        originalDate: (revertModal.createdAt ?? '').slice(0, 10), studentName: revertModal.studentRef,
        reason: revertReason.trim(), adminName: approvedBy,
        amount: Math.abs(revertModal.euros ?? 5),   // devuelve lo que se descontó
      });
      setRevertModal(null); setRevertReason('');
      await loadFinanceData();
    } catch (e) {
      alert(`No se pudo revertir: ${(e as Error).message}`);
    } finally {
      setReverting(false);
    }
  }

  // Toda penalización del mes = cualquier evento con euros negativos, sea del tipo
  // que sea (falta sin aviso del calendario, falta injustificada del admin…). Si se
  // filtrara por un event_type concreto, una penalización de otro tipo restaría del
  // total sin salir en la lista ni poder revertirse.
  const penaltiesOf = (teacherId: string): ScoringEvent[] => scoringEvents.filter(e =>
    e.teacherId === teacherId && (e.euros ?? 0) < 0 &&
    (e.createdAt ?? '').slice(0, 7) === monthYear);

  useEffect(() => { loadFinanceData(); /* eslint-disable-next-line */ }, []);

  // Calcular finanzas por profesor (filtrados).
  const results = useMemo<TeacherFinanceResult[]>(() => {
    return teachers
      .filter(t => !teacherFilter || t.id === teacherFilter)
      .map(t => {
        const payment = financePayments.find(p => p.teacherId === t.id && p.monthYear === monthYear) ?? null;
        // MISMAS entradas que la vista del profesor (app/mis-clases) y que la
        // liquidación (TeachersContext.markPaymentAsPaid). Si esta llamada y esa
        // no reciben lo mismo, el admin y el profesor ven finanzas distintas del
        // mismo mes — que es exactamente lo que pasaba sin `classAnalyses`.
        const occ = gridOccupancyOfTeacher(t);
        return calculateTeacherFinance({
          teacherId: t.id, teacherName: t.name, monthYear,
          // Assignments SIN tocar: finanzas no saca clases de los slots (salen de
          // ingresos y registros), y necesita el horario de la ficha como último
          // horario conocido de los alumnos que ya no están en el calendario. Si
          // se los vaciáramos, sus sesiones de 2h pasadas valdrían 1.
          assignments,
          joinLogs: classJoinLogs, classRecords, classAnalyses, rates: financeRates,
          scoringEvents, students, manualApprovals, payment,
          // El calendario de ESE profesor decide qué es una clase de 2h.
          gridOccupancy: occ,
        });
      })
      .filter(r => {
        if (statusFilter === 'paid') return r.paymentStatus === 'paid';
        if (statusFilter === 'pending') return r.paymentStatus !== 'paid';
        return true;
      });
  }, [teachers, students, teacherFilter, statusFilter, monthYear, assignments, classJoinLogs, classRecords, classAnalyses, financeRates, scoringEvents, manualApprovals, financePayments]);

  // Solo mostrar profesores con actividad en el mes (o el filtrado explícito).
  let visible = results.filter(r => teacherFilter || r.rows.length > 0 || r.bonusFromScoring > 0 || r.penaltiesFromScoring < 0 || r.paymentStatus === 'paid');
  // Filtro por estado de suscripción: profesores con alguna clase de ese estado.
  if (subFilter !== 'all') {
    visible = visible.filter(r => r.rows.some(row => (row.subscriptionStatus ?? 'error') === subFilter));
  }

  // Cards de resumen.
  const sumTotal     = visible.reduce((s, r) => s + r.totalAPagar, 0);
  const sumPagables  = visible.reduce((s, r) => s + r.totalPagable, 0);
  const sumARevisar  = visible.reduce((s, r) => s + r.totalARevisar, 0);
  const sumPendiente = visible.reduce((s, r) => s + r.montoARevisar, 0);
  const sumRetenido  = visible.reduce((s, r) => s + r.montoRetenido, 0);

  const cards = [
    { label: 'Total a pagar', value: `€${sumTotal.toFixed(2)}`, color: '#1E9E3A', hint: 'Solo clases pagables (ingreso + transcript) más bonos y penalizaciones' },
    { label: 'Clases pagables', value: sumPagables, color: 'var(--text-primary)', hint: 'Con ingreso registrado y transcript validado' },
    { label: 'Pendiente de transcript', value: `€${sumPendiente.toFixed(2)}`, color: sumARevisar > 0 ? '#9a6516' : '#1E9E3A', hint: `${sumARevisar} clases dadas con ingreso pero sin transcript: NO suman al total` },
    { label: 'Monto retenido', value: `€${sumRetenido.toFixed(2)}`, color: sumRetenido > 0 ? '#ea580c' : '#1E9E3A', hint: 'Clases que superan el límite mensual del plan o las 2 por tipo' },
  ];

  function exportCsv() {
    // Horas/Cuenta como: una sesión de 2h es una fila que vale 2 clases, así que
    // el importe de la fila es tarifa × unidades y el CSV tiene que decirlo.
    const lines = ['Profesor,Alumno,Fecha,Hora,Horas,Cuenta como,Tarifa,Importe,Estado,Total profesor'];
    for (const r of visible) {
      for (const row of r.rows) {
        lines.push([
          `"${r.teacherName}"`, `"${row.studentName}"`, row.date,
          `"${rowHoursLabel(row)}"`, row.durationHours, row.billingUnits,
          row.rate.toFixed(2), (row.rate * row.billingUnits).toFixed(2),
          row.status, r.totalAPagar.toFixed(2),
        ].join(','));
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `finanzas_${monthYear}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  async function handlePay(teacherId: string) {
    setPaying(teacherId);
    await markPaymentAsPaid(teacherId, monthYear);
    setPaying(null);
  }

  const inputStyle = { padding: '8px 12px', borderRadius: 8, border: '1.5px solid var(--border)', fontSize: 13, background: 'var(--bg-surface)', color: 'var(--text-primary)', fontFamily: 'inherit' };

  return (
    <div>
      {/* Cards de resumen */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 14, marginBottom: 18 }}>
        {cards.map(c => (
          <div key={c.label} title={c.hint} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px' }}>
            <div style={{ fontSize: 26, fontWeight: 700, color: c.color }}>{c.value}</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginTop: 3 }}>{c.label}</div>
          </div>
        ))}
      </div>

      {/* Filtros */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px', marginBottom: 18, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 5 }}>Profesor</label>
          <select value={teacherFilter} onChange={e => setTeacherFilter(e.target.value)} style={{ ...inputStyle, minWidth: 180 }}>
            <option value="">Todos</option>
            {teachers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 5 }}>Mes</label>
          <input type="month" value={monthYear} onChange={e => setMonthYear(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 5 }}>Estado</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {([['all','Todos'],['paid','Pagado'],['pending','Pendiente']] as const).map(([id, label]) => (
              <button key={id} onClick={() => setStatusFilter(id)} style={{ padding: '7px 14px', borderRadius: 20, border: `1.5px solid ${statusFilter === id ? '#1E9E3A' : 'var(--border)'}`, background: statusFilter === id ? 'rgba(30,158,58,0.1)' : 'transparent', color: statusFilter === id ? '#1E9E3A' : 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, fontWeight: statusFilter === id ? 700 : 500, fontFamily: 'inherit' }}>{label}</button>
            ))}
          </div>
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 5 }}>Suscripción</label>
          <select value={subFilter} onChange={e => setSubFilter(e.target.value)} style={inputStyle}>
            <option value="all">Todas</option>
            {SUBSCRIPTION_STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <button onClick={exportCsv} style={{ marginLeft: 'auto', padding: '9px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-surface-2)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>
          ⬇ Exportar CSV
        </button>
      </div>

      {/* Profesores del mes */}
      {visible.length === 0 ? (
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: 14 }}>
          Sin datos de finanzas para {finMonthLabel(monthYear)}.
        </div>
      ) : (
        <div className="afd-list">
          {visible.map(r => {
          const isOpen = expandedTeacher === r.teacherId;
          return (
            <div key={r.teacherId} className={`afd-teacher${isOpen ? ' is-open' : ''}`}>
              <div className="afd-teacher-head">
                <div className="afd-teacher-name">{r.teacherName}</div>
                <div className="afd-teacher-right">
                  <span className="afd-pill" style={r.paymentStatus === 'paid' ? PILL_OK : PILL_WARN}>
                    {r.paymentStatus === 'paid' ? '✅ Pagado' : '⏳ Pendiente'}
                  </span>
                  <span className="afd-teacher-amount">
                    €{r.totalAPagar.toFixed(2)}
                    {/* Solo el icono: el aviso completo está en la cabecera del detalle. */}
                    {r.hasInactiveSubPayable && (
                      <span style={{ marginLeft: 5, cursor: 'help' }}
                        title={`Clases pagables sin suscripción con acceso: ${
                          r.payableSubStatuses.filter(s => !s.countsAsActive).map(s => `${s.count} en «${s.label}»`).join(', ')
                        }`}>
                        ⚠️
                      </span>
                    )}
                  </span>
                </div>
              </div>

              <div className="afd-stats">
                <div>
                  <div className="afd-brow-label">Pagables</div>
                  <div className="afd-brow-value">{r.totalPagable} · €{r.montoPagable.toFixed(2)}</div>
                </div>
                <div>
                  <div className="afd-brow-label">Pendiente de transcript</div>
                  <div className={`afd-brow-value${r.totalARevisar > 0 ? ' is-warn' : ''}`}>
                    {r.totalARevisar} · €{r.montoARevisar.toFixed(2)}
                  </div>
                </div>
                <div>
                  <div className="afd-brow-label">Excede límite</div>
                  <div className={`afd-brow-value${r.totalExcedeLimite > 0 ? ' is-warn' : ''}`}>
                    {r.totalExcedeLimite} · €{r.montoRetenido.toFixed(2)}
                  </div>
                </div>
                <div>
                  <div className="afd-brow-label">Bonos</div>
                  <div className="afd-brow-value">€{r.bonusFromScoring.toFixed(2)}</div>
                </div>
              </div>

              <div className="afd-actions">
                <button className="afd-btn-ghost" onClick={() => setExpandedTeacher(isOpen ? null : r.teacherId)} aria-expanded={isOpen}>
                  {isOpen ? 'Ocultar detalle' : 'Ver detalle'}
                </button>
                {r.paymentStatus !== 'paid' && (
                  <button className="afd-btn-pay" onClick={() => handlePay(r.teacherId)} disabled={paying === r.teacherId}>
                    {paying === r.teacherId ? '…' : 'Marcar pagado'}
                  </button>
                )}
              </div>

              {isOpen && (
                  <div className="afd-panel">
                    <div className="afd">
                      <TeacherTotalCard result={r} monthLabel={finMonthLabel(monthYear)} />
                      <StudentDetailList
                        result={r} assignments={assignments} approvals={manualApprovals}
                        onApproveReview={(student, date) => approveReviewClass(r.teacherId, student, date, approvedBy)}
                        onApproveExceed={(student, date) => approveExceedLimitClass(r.teacherId, student, date, approvedBy)}
                        onRevertAbsence={row => { setAbsenceModal({ row, teacherName: r.teacherName }); setAbsenceError(''); }}
                      />
                      {penaltiesOf(r.teacherId).length > 0 && (
                        <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', background: 'var(--bg-surface)' }}>
                          <div style={{ fontSize: 12.5, fontWeight: 700, color: '#c0392b', marginBottom: 8 }}>Penalizaciones del mes</div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {penaltiesOf(r.teacherId).map(p => (
                              <div key={p.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, fontSize: 12.5, flexWrap: 'wrap' }}>
                                <span style={{ color: p.reverted ? 'var(--text-muted)' : 'var(--text-secondary)', textDecoration: p.reverted ? 'line-through' : undefined }}>
                                  {p.note.replace(/^(Falta sin aviso registrada|Cancelación sin antelación) — /, '')} · −€{Math.abs(p.euros).toFixed(2)}
                                </span>
                                {p.reverted ? (
                                  <span style={{ fontSize: 11.5, color: '#1f7a3d', fontWeight: 700, whiteSpace: 'nowrap' }}>Revertida{p.revertedBy ? ` · ${p.revertedBy}` : ''}</span>
                                ) : (
                                  <button onClick={() => { setRevertModal(p); setRevertReason(''); }}
                                    style={{ padding: '4px 11px', borderRadius: 7, border: '1px solid #f0c4bd', background: 'white', color: '#c0392b', cursor: 'pointer', fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                                    Revertir
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
              )}
            </div>
          );
          })}
        </div>
      )}

      {/* Modal de reversión de una FALTA SIN AVISO DEL ALUMNO.
          No confundir con el de abajo: aquel devuelve euros de una penalización al
          profesor; este QUITA una clase que se le estaba pagando. */}
      {absenceModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget && !revertingAbsence) setAbsenceModal(null); }}>
          <div style={{ background: '#F7F7F5', border: '1px solid var(--border)', borderRadius: 14, padding: 24, width: '100%', maxWidth: 460 }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: '#111827', marginBottom: 8 }}>Revertir falta sin aviso</div>
            <div style={{ fontSize: 13, color: '#5f6360', lineHeight: 1.6, marginBottom: 16 }}>
              Se quitará la marca de falta de la clase de <b>{absenceModal.row.studentName}</b> del{' '}
              <b>{absenceModal.row.date}</b> ({absenceModal.teacherName}). La clase vuelve a
              <b> pendiente de transcript</b>: deja de sumar los{' '}
              <b>€{(absenceModal.row.rate * absenceModal.row.billingUnits).toFixed(2)}</b> al pago, libera el
              cupo mensual del alumno y el hueco del tope de faltas del mes. Queda el registro de que
              la falta existió y de quién la revirtió.
            </div>
            {absenceError && (
              <div style={{ fontSize: 12.5, color: '#c0392b', background: 'rgba(239,68,68,0.08)', borderRadius: 8, padding: '9px 12px', marginBottom: 12 }}>
                {absenceError}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setAbsenceModal(null)} disabled={revertingAbsence}
                style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: '#6b7280', cursor: revertingAbsence ? 'not-allowed' : 'pointer', fontSize: 13, fontFamily: 'inherit' }}>Cancelar</button>
              <button onClick={handleRevertAbsence} disabled={revertingAbsence}
                style={{ flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: revertingAbsence ? '#d1d5db' : '#1E9E3A', color: 'white', cursor: revertingAbsence ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
                {revertingAbsence ? 'Revirtiendo…' : 'Confirmar reversión'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de reversión de penalización (Bloque 4.5) */}
      {revertModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget && !reverting) setRevertModal(null); }}>
          <div style={{ background: '#F7F7F5', border: '1px solid var(--border)', borderRadius: 14, padding: 24, width: '100%', maxWidth: 440 }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: '#111827', marginBottom: 8 }}>Revertir penalización</div>
            <div style={{ fontSize: 13, color: '#5f6360', lineHeight: 1.6, marginBottom: 16 }}>
              Se devolverán <b>5,00 €</b> al balance de <b>{revertModal.teacherName}</b> por la falta registrada
              el {(revertModal.createdAt ?? '').slice(0, 10)}{revertModal.studentRef ? ` con ${revertModal.studentRef}` : ''}.
            </div>
            <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Motivo de la reversión</label>
            <textarea value={revertReason} onChange={e => setRevertReason(e.target.value)} rows={3} autoFocus
              placeholder="Ej: el alumno confirmó que avisó por WhatsApp"
              style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1.5px solid var(--border)', fontSize: 13, background: 'white', color: '#111827', fontFamily: 'inherit', boxSizing: 'border-box', resize: 'vertical' }} />
            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <button onClick={() => setRevertModal(null)} disabled={reverting} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: '#6b7280', cursor: reverting ? 'not-allowed' : 'pointer', fontSize: 13, fontFamily: 'inherit' }}>Cancelar</button>
              <button onClick={handleRevert} disabled={reverting || !revertReason.trim()}
                style={{ flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: reverting || !revertReason.trim() ? '#d1d5db' : '#1E9E3A', color: 'white', cursor: reverting || !revertReason.trim() ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
                {reverting ? 'Revirtiendo…' : 'Confirmar reversión'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
// Explica la regla de DOS NIVELES (entrada y pago). Solo informativo.
function HowItWorksModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: '#F7F7F5', borderRadius: 16, width: '100%', maxWidth: 520, maxHeight: '88vh', overflowY: 'auto', padding: 26, fontFamily: 'var(--font-app)' }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#1a1c1a', marginBottom: 6 }}>
          Cómo entra y cómo se paga una clase
        </div>
        <p style={{ fontSize: 13.5, color: '#5f6360', lineHeight: 1.65, margin: '0 0 18px' }}>
          Son <b>dos preguntas distintas</b>, y en este orden:
        </p>

        <ol style={{ margin: '0 0 18px', paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <li>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#1a1c1a' }}>
              ¿Entra a finanzas? — lo decide el clic en &laquo;Unirse a clase&raquo;
            </div>
            <div style={{ fontSize: 13.5, color: '#5f6360', lineHeight: 1.6, marginTop: 3 }}>
              El acceso queda registrado con la hora exacta y es lo que hace que la clase exista para
              el pago. <b>Si el profesor no pulsó el botón, la clase no aparece acá</b>: no se cuenta
              ni siquiera como pendiente, y subir el transcript después no la trae de vuelta.
            </div>
          </li>
          <li>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#1a1c1a' }}>
              ¿Se cobra? — lo decide el transcript
            </div>
            <div style={{ fontSize: 13.5, color: '#5f6360', lineHeight: 1.6, marginTop: 3 }}>
              De las clases que entraron, se pagan las que tienen el transcript subido y validado
              (&laquo;Mis clases&raquo; → &laquo;Añadir clase&raquo;, el texto que genera Fathom).
              Las demás quedan pendientes y pasan a pagables solas en cuanto se sube.
            </div>
          </li>
        </ol>

        <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#8b8e88', marginBottom: 8 }}>
          Estados posibles
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
          {[
            { dot: '#1E9E3A', label: 'Pagable', desc: 'clic + transcript validado — suma al total a cobrar' },
            { dot: '#FFC400', label: 'Pendiente de transcript', desc: 'clic sin transcript: la clase se dio y se ve, pero NO suma al total' },
            { dot: '#a4a7a1', label: 'No aparece', desc: 'sin clic en «Unirse a clase» la clase no entró a finanzas' },
          ].map(s => (
            <div key={s.label} style={{ display: 'grid', gridTemplateColumns: '9px 1fr', gap: 10, alignItems: 'start' }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: s.dot, marginTop: 6 }} />
              <span style={{ fontSize: 13.5, color: '#5f6360', lineHeight: 1.55 }}>
                <b style={{ color: '#1a1c1a' }}>{s.label}</b> — {s.desc}
              </span>
            </div>
          ))}
        </div>

        <div style={{ fontSize: 12.5, color: '#9a6516', background: '#fdf3e7', border: '1px solid #f2e2c9', borderRadius: 10, padding: '10px 13px', lineHeight: 1.6, marginBottom: 18 }}>
          Única excepción al clic: <b>falta sin aviso</b> y <b>cancelación sobre la hora</b>. El alumno
          no vino, así que no puede haber ingreso: entran por el registro que crea el profesor y se
          cobran las 2 primeras de cada tipo por alumno, sin transcript.
        </div>

        <button
          onClick={onClose}
          style={{ width: '100%', padding: '11px', borderRadius: 10, border: 'none', background: '#1E9E3A', color: '#fff', fontFamily: 'inherit', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
        >
          Entendido
        </button>
      </div>
    </div>
  );
}

function FinanzasContent() {
  const { reloadAll } = useTeachers();
  const [howOpen, setHowOpen] = useState(false);
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }}>
      <NavBar />
      <PullToRefresh onRefresh={reloadAll}>
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '32px 20px 48px' }}>
          <LastUpdated />
          <div style={{ marginBottom: 24, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 4px' }}>Finanzas</h1>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>Gestión de pagos a profesores</p>
            </div>
            <button
              onClick={() => setHowOpen(true)}
              style={{ border: '1px solid var(--border)', background: 'var(--bg-surface)', borderRadius: 9, padding: '8px 14px', fontFamily: 'inherit', fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', cursor: 'pointer', minHeight: 40 }}
            >
              ¿Cómo entra y se paga una clase?
            </button>
          </div>
          <FinanceTab />
        </div>
      </PullToRefresh>
      {howOpen && <HowItWorksModal onClose={() => setHowOpen(false)} />}
    </div>
  );
}

export default function FinanzasPage() {
  return (
    <AuthGuard allowedRoles={['admin']}>
      <FinanzasContent />
    </AuthGuard>
  );
}
