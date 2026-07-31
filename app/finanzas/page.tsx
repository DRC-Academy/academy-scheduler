'use client';
import { useState, useEffect, useMemo, Fragment } from 'react';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { PullToRefresh } from '@/components/PullToRefresh';
import { LastUpdated } from '@/components/LastUpdated';
import { getSpainParts } from '@/components/VisualCalendar';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import { calculateTeacherFinance, TeacherFinanceResult, ClassFinanceRow, ingresoBadge, classTypeBadge, subscriptionBadge, rowHoursLabel, SUBSCRIPTION_STATUS_OPTIONS } from '@/lib/finance';
import { classifyPlan } from '@/lib/productUtils';
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

function ClassDetailRows({ result, studentName, onApproveReview, onApproveExceed }: {
  result: TeacherFinanceResult;
  studentName: string;
  onApproveReview: (date: string) => void;
  onApproveExceed: (date: string) => void;
}) {
  const rows = result.rows.filter(r => r.studentName === studentName);
  return (
    <div style={{ overflowX: 'auto', background: 'var(--bg-surface-2)', borderTop: '1px solid var(--border)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 640 }}>
        <thead>
          <tr style={{ textAlign: 'left' }}>
            {['Fecha', 'Ingresó', 'Transcript', 'Suscripción', 'Tarifa', 'Estado', ''].map((h, i) => (
              <th key={i} style={{ padding: '7px 14px', fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const st = FIN_STATUS_STYLE[r.status];
            const ing = ingresoBadge(r);
            const ct = classTypeBadge(r.classType);
            const sub = subscriptionBadge(r.subscriptionStatus);
            const subDiffer = r.subAtJoin && r.subAtRecord && r.subAtJoin !== r.subAtRecord;
            return (
              <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '7px 14px', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>{finDateShort(r.date)}</td>
                <td style={{ padding: '7px 14px', whiteSpace: 'nowrap' }}>
                  <span style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 10, background: ing.bg, color: ing.color, fontWeight: 700 }}>{ing.label}</span>
                </td>
                {/* Transcript: segundo factor de verificación. */}
                <td style={{ padding: '7px 14px', whiteSpace: 'nowrap' }}>
                  {r.hasTranscript
                    ? <span style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 10, background: '#eaf5ec', color: '#1f7a3d', fontWeight: 700 }}>Subido</span>
                    : <span style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 10, background: '#fdf3e7', color: '#9a6516', fontWeight: 700 }}>No subido</span>}
                </td>
                <td style={{ padding: '7px 14px', whiteSpace: 'nowrap' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 10, background: sub.bg, color: sub.color, fontWeight: 700 }}>{sub.label}</span>
                    {subDiffer && <span style={{ cursor: 'help' }} title={`Al ingresar: ${subscriptionBadge(r.subAtJoin).label.replace(/^[^ ]+ /, '')} · Al registrar: ${subscriptionBadge(r.subAtRecord).label.replace(/^[^ ]+ /, '')}`}>ℹ️</span>}
                  </span>
                </td>
                {/* Importe = tarifa × unidades. Una sesión de 2h cobra 2× la tarifa. */}
                <td style={{ padding: '7px 14px', whiteSpace: 'nowrap', color: 'var(--text-primary)' }}
                  title={r.billingUnits > 1 ? `${r.billingUnits} × €${r.rate.toFixed(2)}` : undefined}>
                  €{(r.rate * r.billingUnits).toFixed(2)}
                  {r.billingUnits > 1 && (
                    <span style={{ marginLeft: 5, fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: 'rgba(30,158,58,0.12)', color: '#1E9E3A' }}>
                      {r.durationHours}h ×{r.billingUnits}
                    </span>
                  )}
                </td>
                <td style={{ padding: '7px 14px', whiteSpace: 'nowrap' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 10, background: st.bg, color: st.color, fontWeight: 700 }}>{st.label}</span>
                    {ct && <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 10, background: ct.bg, color: ct.color, fontWeight: 700 }}>{ct.label}</span>}
                  </span>
                </td>
                <td style={{ padding: '7px 14px', whiteSpace: 'nowrap', textAlign: 'right' }}>
                  {r.manuallyApproved ? (
                    <span style={{ fontSize: 11, color: '#1E9E3A', fontWeight: 700 }}>✓ Aprobada</span>
                  ) : result.paymentStatus !== 'paid' && r.status === 'a_revisar' ? (
                    <button onClick={() => onApproveReview(r.date)} style={{ padding: '4px 10px', borderRadius: 7, border: '1px solid rgba(30,158,58,0.4)', background: 'rgba(30,158,58,0.08)', color: '#1E9E3A', cursor: 'pointer', fontSize: 11, fontWeight: 700, fontFamily: 'inherit' }}>✓ Aprobar manualmente</button>
                  ) : result.paymentStatus !== 'paid' && (r.status === 'excede_limite' || r.status === 'excede_limite_tipo') ? (
                    <button onClick={() => onApproveExceed(r.date)} style={{ padding: '4px 10px', borderRadius: 7, border: '1px solid rgba(30,158,58,0.4)', background: 'rgba(30,158,58,0.08)', color: '#1E9E3A', cursor: 'pointer', fontSize: 11, fontWeight: 700, fontFamily: 'inherit' }}>✓ Incluir igual</button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StudentDetailTable({ result, assignments, onApproveReview, onApproveExceed }: {
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

  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid rgba(30,158,58,0.3)', borderRadius: 12, overflow: 'hidden', marginTop: 4 }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 720 }}>
          <thead>
            <tr style={{ background: 'var(--bg-surface-2)', textAlign: 'left' }}>
              {['Alumno', 'Plan', 'Inicio', 'Antigüedad', 'Tarifa', 'Clases pagables', 'Subtotal', 'Estado'].map(h => (
                <th key={h} style={{ padding: '9px 14px', fontSize: 10.5, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
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
                <Fragment key={name}>
                  <tr style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }} onClick={() => setOpenStudent(isOpen ? null : name)}>
                    <td style={{ padding: '9px 14px', whiteSpace: 'nowrap', color: 'var(--text-primary)', fontWeight: 600 }}>{isOpen ? '▾ ' : '▸ '}{name}</td>
                    <td style={{ padding: '9px 14px', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>{rows[0]?.planLabel ?? '—'}</td>
                    <td style={{ padding: '9px 14px', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>{asgn?.startDate ? finDateShort(asgn.startDate) : '—'}</td>
                    <td style={{ padding: '9px 14px', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>{antiquity}d</td>
                    <td style={{ padding: '9px 14px', whiteSpace: 'nowrap', color: 'var(--text-primary)' }}>€{rate.toFixed(2)}</td>
                    <td style={{ padding: '9px 14px', whiteSpace: 'nowrap', color: 'var(--text-primary)', fontWeight: 600 }}
                      title={pagableUnits !== pagables.length ? `${pagables.length} sesiones · ${pagableUnits} clases (alguna es de 2h)` : undefined}>
                      {pagableUnits}
                    </td>
                    <td style={{ padding: '9px 14px', whiteSpace: 'nowrap', color: '#1E9E3A', fontWeight: 700 }}>€{subtotal.toFixed(2)}</td>
                    <td style={{ padding: '9px 14px', whiteSpace: 'nowrap' }}>
                      {hasReview
                        ? <span style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 10, background: 'rgba(255,196,0,0.15)', color: '#b45309', fontWeight: 700 }}>A revisar</span>
                        : <span style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 10, background: 'rgba(30,158,58,0.1)', color: '#1E9E3A', fontWeight: 700 }}>OK</span>}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={8} style={{ padding: 0 }}>
                        <ClassDetailRows
                          result={result} studentName={name}
                          onApproveReview={date => onApproveReview(name, date)}
                          onApproveExceed={date => onApproveExceed(name, date)}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FinanceTab() {
  const { user } = useAuth();
  const {
    teachers, students, assignments, classJoinLogs, classRecords, financeRates, financePayments,
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
        return calculateTeacherFinance({
          teacherId: t.id, teacherName: t.name, monthYear,
          assignments, joinLogs: classJoinLogs, classRecords, rates: financeRates,
          scoringEvents, students, manualApprovals, payment,
        });
      })
      .filter(r => {
        if (statusFilter === 'paid') return r.paymentStatus === 'paid';
        if (statusFilter === 'pending') return r.paymentStatus !== 'paid';
        return true;
      });
  }, [teachers, students, teacherFilter, statusFilter, monthYear, assignments, classJoinLogs, classRecords, financeRates, scoringEvents, manualApprovals, financePayments]);

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

      {/* Tabla principal por profesor */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        {visible.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: 14 }}>Sin datos de finanzas para {finMonthLabel(monthYear)}.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 880 }}>
              <thead>
                <tr style={{ background: 'var(--bg-surface-2)', textAlign: 'left' }}>
                  {['Profesor', 'Pagables', 'A revisar', 'Excede límite', 'Bonos', 'Total', 'Estado', ''].map(h => (
                    <th key={h} style={{ padding: '10px 14px', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map(r => {
                  const isOpen = expandedTeacher === r.teacherId;
                  return (
                    <Fragment key={r.teacherId}>
                      <tr style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', color: 'var(--text-primary)', fontWeight: 700 }}>{r.teacherName}</td>
                        <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>{r.totalPagable} <span style={{ color: 'var(--text-muted)' }}>· €{r.montoPagable.toFixed(2)}</span></td>
                        <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', color: r.totalARevisar > 0 ? '#b45309' : 'var(--text-secondary)' }}>{r.totalARevisar}</td>
                        <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', color: r.totalExcedeLimite > 0 ? '#ea580c' : 'var(--text-secondary)' }}>{r.totalExcedeLimite} <span style={{ color: 'var(--text-muted)' }}>· €{r.montoRetenido.toFixed(2)}</span></td>
                        <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>€{r.bonusFromScoring.toFixed(2)}</td>
                        <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', color: '#1E9E3A', fontWeight: 700 }}>
                          €{r.totalAPagar.toFixed(2)}
                          {r.hasInactiveSubPayable && (
                            <div style={{ fontSize: 10, color: '#ea580c', fontWeight: 600, marginTop: 2, whiteSpace: 'normal', maxWidth: 150 }}
                              title="Incluye clases pagables donde el alumno NO tenía suscripción activa al momento de darse">
                              ⚠️ Incluye clases con suscripción inactiva
                            </div>
                          )}
                        </td>
                        <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                          <span style={{ fontSize: 11, padding: '2px 9px', borderRadius: 12, fontWeight: 700, background: r.paymentStatus === 'paid' ? 'rgba(30,158,58,0.12)' : 'rgba(255,196,0,0.15)', color: r.paymentStatus === 'paid' ? '#1E9E3A' : '#b45309' }}>
                            {r.paymentStatus === 'paid' ? '✅ Pagado' : '⏳ Pendiente'}
                          </span>
                        </td>
                        <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', textAlign: 'right' }}>
                          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                            <button onClick={() => setExpandedTeacher(isOpen ? null : r.teacherId)} style={{ padding: '6px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 11, fontWeight: 600, fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                              {isOpen ? 'Ocultar' : 'Ver detalle'}
                            </button>
                            {r.paymentStatus !== 'paid' && (
                              <button onClick={() => handlePay(r.teacherId)} disabled={paying === r.teacherId} style={{ padding: '6px 12px', borderRadius: 7, border: 'none', background: '#1E9E3A', color: 'white', cursor: paying === r.teacherId ? 'not-allowed' : 'pointer', fontSize: 11, fontWeight: 700, fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                                {paying === r.teacherId ? '...' : 'Marcar pagado'}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={8} style={{ padding: '0 14px 14px' }}>
                            <StudentDetailTable
                              result={r} assignments={assignments}
                              onApproveReview={(student, date) => approveReviewClass(r.teacherId, student, date, approvedBy)}
                              onApproveExceed={(student, date) => approveExceedLimitClass(r.teacherId, student, date, approvedBy)}
                            />
                            {penaltiesOf(r.teacherId).length > 0 && (
                              <div style={{ marginTop: 14, border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px' }}>
                                <div style={{ fontSize: 12.5, fontWeight: 700, color: '#c0392b', marginBottom: 8 }}>Penalizaciones del mes</div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                  {penaltiesOf(r.teacherId).map(p => (
                                    <div key={p.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, fontSize: 12.5 }}>
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
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

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
