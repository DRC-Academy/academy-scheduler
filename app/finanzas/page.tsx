'use client';
import { useState, useEffect, useMemo } from 'react';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { PullToRefresh } from '@/components/PullToRefresh';
import { LastUpdated } from '@/components/LastUpdated';
import { getSpainParts } from '@/components/VisualCalendar';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import { calculateTeacherFinance, TeacherFinanceResult, ClassFinanceRow, ingresoBadge, classTypeBadge, subscriptionBadge, rowHoursLabel, SUBSCRIPTION_STATUS_OPTIONS } from '@/lib/finance';
import { classifyPlan } from '@/lib/productUtils';
import { gridOccupancyOfTeacher } from '@/lib/teacherClasses';
import { dbRevertPenalty } from '@/lib/db';
import { Assignment, ScoringEvent } from '@/types';

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

const FIN_STATUS_STYLE: Record<string, { label: string; color: string; bg: string }> = {
  pagable:            { label: 'Pagable',          color: '#1E9E3A', bg: 'rgba(30,158,58,0.1)' },
  a_revisar:          { label: 'A revisar',        color: '#b45309', bg: 'rgba(255,196,0,0.15)' },
  excede_limite:      { label: 'Excede límite',    color: '#ea580c', bg: 'rgba(249,115,22,0.12)' },
  excede_limite_tipo: { label: 'Supera 2/tipo',    color: '#ea580c', bg: 'rgba(249,115,22,0.12)' },
  no_cobrable:        { label: 'No cobrable',       color: 'var(--text-muted)', bg: 'var(--bg-surface-3)' },
};

const PILL_OK   = { background: 'var(--ok-soft)',   color: 'var(--ok)' };
const PILL_WARN = { background: 'var(--warn-soft)', color: 'var(--warn)' };

/**
 * Saldo del mes del profesor. Va ARRIBA del detalle porque es el dato que se
 * busca al abrirlo: antes solo estaba en una columna de la fila plegada, que es
 * justo la que se pierde de vista cuando la tabla se desplaza en horizontal.
 */
function TeacherTotalCard({ result, monthLabel }: { result: TeacherFinanceResult; monthLabel: string }) {
  const desglose: Array<{ label: string; value: string; tone?: 'ok' | 'warn' | 'danger' }> = [
    { label: 'Clases pagables', value: `${result.totalPagable} · €${result.montoPagable.toFixed(2)}` },
  ];
  if (result.totalARevisar > 0)
    desglose.push({ label: 'A revisar', value: `${result.totalARevisar} · €${result.montoARevisar.toFixed(2)}`, tone: 'warn' });
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
      {result.hasInactiveSubPayable && (
        <div style={{ marginTop: 'var(--space-2)', fontSize: 'var(--fs-caption)', color: 'var(--warn)' }}>
          ⚠️ Incluye clases pagables en las que el alumno no tenía suscripción activa.
        </div>
      )}
      <div className="afd-break">
        {desglose.map(d => (
          <div key={d.label}>
            <div className="afd-brow-label">{d.label}</div>
            <div className={`afd-brow-value${d.tone ? ` is-${d.tone}` : ''}`}>{d.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Clases de un alumno. Una tarjeta por clase en vez de una fila de tabla: los
 * badges envuelven en lugar de estirar el ancho, así que no hay `min-width` que
 * obligue a desplazarse en horizontal para leer el estado o el botón de aprobar.
 */
function ClassCards({ result, studentName, onApproveReview, onApproveExceed }: {
  result: TeacherFinanceResult;
  studentName: string;
  onApproveReview: (date: string) => void;
  onApproveExceed: (date: string) => void;
}) {
  const rows = result.rows.filter(r => r.studentName === studentName);
  if (rows.length === 0) return <div className="afd-empty">Sin clases registradas este mes.</div>;

  return (
    <div className="afd-classes">
      {rows.map((r, i) => {
        const st = FIN_STATUS_STYLE[r.status];
        const ing = ingresoBadge(r);
        const ct = classTypeBadge(r.classType);
        const sub = subscriptionBadge(r.subscriptionStatus);
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
              <span className="afd-pill" style={{ background: ing.bg, color: ing.color }}>{ing.label}</span>
              {/* Transcript: segundo factor de verificación. */}
              <span className="afd-pill" style={r.hasTranscript ? PILL_OK : PILL_WARN}>
                {r.hasTranscript ? 'Transcript subido' : 'Sin transcript'}
              </span>
              <span className="afd-pill" style={{ background: sub.bg, color: sub.color }}>{sub.label}</span>
              {subDiffer && (
                <span style={{ cursor: 'help' }} title={`Al ingresar: ${subscriptionBadge(r.subAtJoin).label.replace(/^[^ ]+ /, '')} · Al registrar: ${subscriptionBadge(r.subAtRecord).label.replace(/^[^ ]+ /, '')}`}>ℹ️</span>
              )}
              {r.manuallyApproved && <span className="afd-pill" style={PILL_OK}>✓ Aprobada</span>}
            </div>
            {editable && r.status === 'a_revisar' && (
              <div className="afd-action">
                <button className="afd-btn" onClick={() => onApproveReview(r.date)}>✓ Aprobar manualmente</button>
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
function StudentDetailList({ result, assignments, onApproveReview, onApproveExceed }: {
  result: TeacherFinanceResult;
  assignments: Assignment[];
  onApproveReview: (studentName: string, date: string) => void;
  onApproveExceed: (studentName: string, date: string) => void;
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
          const hasReview = rows.some(r => r.status === 'a_revisar');
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
                  <span className="afd-pill" style={hasReview ? PILL_WARN : PILL_OK}>{hasReview ? 'A revisar' : 'OK'}</span>
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
                  </div>
                  <ClassCards
                    result={result} studentName={name}
                    onApproveReview={date => onApproveReview(name, date)}
                    onApproveExceed={date => onApproveExceed(name, date)}
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
    loadFinanceData, markPaymentAsPaid, approveReviewClass, approveExceedLimitClass,
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
  const sumRetenido  = visible.reduce((s, r) => s + r.montoRetenido, 0);

  const cards = [
    { label: 'Total a pagar', value: `€${sumTotal.toFixed(2)}`, color: '#1E9E3A' },
    { label: 'Clases pagables', value: sumPagables, color: 'var(--text-primary)' },
    { label: 'Clases a revisar', value: sumARevisar, color: sumARevisar > 0 ? '#b45309' : '#1E9E3A' },
    { label: 'Monto retenido', value: `€${sumRetenido.toFixed(2)}`, color: sumRetenido > 0 ? '#ea580c' : '#1E9E3A' },
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
          <div key={c.label} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px' }}>
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
                        title="Incluye clases pagables donde el alumno NO tenía suscripción activa al momento de darse">
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
                  <div className="afd-brow-label">A revisar</div>
                  <div className={`afd-brow-value${r.totalARevisar > 0 ? ' is-warn' : ''}`}>{r.totalARevisar}</div>
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
                        result={r} assignments={assignments}
                        onApproveReview={(student, date) => approveReviewClass(r.teacherId, student, date, approvedBy)}
                        onApproveExceed={(student, date) => approveExceedLimitClass(r.teacherId, student, date, approvedBy)}
                      />
                      {penaltiesOf(r.teacherId).length > 0 && (
                        <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', background: 'var(--bg-surface)' }}>
                          <div style={{ fontSize: 12.5, fontWeight: 700, color: '#c0392b', marginBottom: 8 }}>Penalizaciones del mes</div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {penaltiesOf(r.teacherId).map(p => (
                              <div key={p.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, fontSize: 12.5, flexWrap: 'wrap' }}>
                                <span style={{ color: p.reverted ? 'var(--text-muted)' : 'var(--text-secondary)', textDecoration: p.reverted ? 'line-through' : undefined }}>
                                  {p.note.replace('Falta sin aviso registrada — ', '')} · −€{Math.abs(p.euros).toFixed(2)}
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
// Explica las dos condiciones que hacen pagable una clase. Solo informativo.
function HowItWorksModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 520, maxHeight: '88vh', overflowY: 'auto', padding: 26, fontFamily: "'Public Sans', system-ui, sans-serif" }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#1a1c1a', marginBottom: 6 }}>
          Cómo se aprueba una clase para el pago
        </div>
        <p style={{ fontSize: 13.5, color: '#5f6360', lineHeight: 1.65, margin: '0 0 18px' }}>
          Para que una clase sea considerada <b>pagable</b> deben cumplirse DOS condiciones:
        </p>

        <ol style={{ margin: '0 0 18px', paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <li>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#1a1c1a' }}>Acceso mediante el botón</div>
            <div style={{ fontSize: 13.5, color: '#5f6360', lineHeight: 1.6, marginTop: 3 }}>
              El profesor debe haber accedido a la clase con el botón &laquo;Ingresar a clase&raquo; en
              &laquo;Mis clases&raquo;. El acceso queda registrado automáticamente con la hora exacta.
            </div>
          </li>
          <li>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#1a1c1a' }}>Transcript subido</div>
            <div style={{ fontSize: 13.5, color: '#5f6360', lineHeight: 1.6, marginTop: 3 }}>
              El profesor debe haber subido el transcript de la clase en &laquo;Mis clases&raquo; →
              &laquo;Añadir clase&raquo;. Es el texto que genera Fathom al finalizar la sesión.
            </div>
          </li>
        </ol>

        <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#8b8e88', marginBottom: 8 }}>
          Estados posibles
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
          {[
            { dot: '#16a34a', label: 'Pagable', desc: 'ambas condiciones cumplidas' },
            { dot: '#e0912f', label: 'A revisar', desc: 'solo una condición cumplida — el admin puede aprobarla manualmente' },
            { dot: '#a4a7a1', label: 'No incluida', desc: 'ninguna condición cumplida' },
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
          Las clases de tipo &laquo;Falta sin aviso&raquo; y &laquo;Cancelación sobre la hora&raquo; tienen
          reglas propias y no requieren transcript.
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
              ¿Cómo se aprueba una clase?
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
