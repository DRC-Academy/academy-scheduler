'use client';
import { useState, useEffect, useMemo, Fragment } from 'react';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { PullToRefresh } from '@/components/PullToRefresh';
import { LastUpdated } from '@/components/LastUpdated';
import { getSpainParts } from '@/components/VisualCalendar';
import { useTeachers } from '@/lib/TeachersContext';
import { calculateTeacherFinance, TeacherFinanceResult, ClassFinanceRow } from '@/lib/finance';
import { Assignment } from '@/types';

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
  pagable:       { label: 'Pagable',       color: '#1E9E3A', bg: 'rgba(30,158,58,0.1)' },
  a_revisar:     { label: 'A revisar',     color: '#b45309', bg: 'rgba(255,196,0,0.15)' },
  excede_limite: { label: 'Excede límite', color: '#ea580c', bg: 'rgba(249,115,22,0.12)' },
};

function ClassDetailRows({ result, studentName, classRecords, onApproveReview, onApproveExceed }: {
  result: TeacherFinanceResult;
  studentName: string;
  classRecords: import('@/types').ClassRecord[];
  onApproveReview: (date: string) => void;
  onApproveExceed: (date: string) => void;
}) {
  const rows = result.rows.filter(r => r.studentName === studentName);
  function screenshotUrl(date: string): string | null {
    const rec = classRecords.find(r =>
      r.teacherId === result.teacherId && r.studentName === studentName &&
      Math.abs((new Date(r.classDate + 'T00:00:00').getTime() - new Date(date + 'T00:00:00').getTime()) / 86400000) <= 1
    );
    return rec?.screenshotUrl ?? null;
  }
  return (
    <div style={{ overflowX: 'auto', background: 'var(--bg-surface-2)', borderTop: '1px solid var(--border)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 560 }}>
        <thead>
          <tr style={{ textAlign: 'left' }}>
            {['Fecha', 'Ingresó', 'Captura', 'Tarifa', 'Estado', ''].map((h, i) => (
              <th key={i} style={{ padding: '7px 14px', fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const st = FIN_STATUS_STYLE[r.status];
            const url = screenshotUrl(r.date);
            return (
              <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '7px 14px', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>{finDateShort(r.date)}</td>
                <td style={{ padding: '7px 14px', whiteSpace: 'nowrap' }}>{r.hasJoinLog ? '✅' : '—'}</td>
                <td style={{ padding: '7px 14px', whiteSpace: 'nowrap' }}>
                  {url ? <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: '#1E9E3A', fontWeight: 600, textDecoration: 'none' }}>📷 Ver</a> : '—'}
                </td>
                <td style={{ padding: '7px 14px', whiteSpace: 'nowrap', color: 'var(--text-primary)' }}>€{r.rate.toFixed(2)}</td>
                <td style={{ padding: '7px 14px', whiteSpace: 'nowrap' }}>
                  <span style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 10, background: st.bg, color: st.color, fontWeight: 700 }}>{st.label}</span>
                </td>
                <td style={{ padding: '7px 14px', whiteSpace: 'nowrap', textAlign: 'right' }}>
                  {result.paymentStatus !== 'paid' && r.status === 'a_revisar' && (
                    <button onClick={() => onApproveReview(r.date)} style={{ padding: '4px 10px', borderRadius: 7, border: '1px solid rgba(30,158,58,0.4)', background: 'rgba(30,158,58,0.08)', color: '#1E9E3A', cursor: 'pointer', fontSize: 11, fontWeight: 700, fontFamily: 'inherit' }}>✓ Aprobar manualmente</button>
                  )}
                  {result.paymentStatus !== 'paid' && r.status === 'excede_limite' && (
                    <button onClick={() => onApproveExceed(r.date)} style={{ padding: '4px 10px', borderRadius: 7, border: '1px solid rgba(30,158,58,0.4)', background: 'rgba(30,158,58,0.08)', color: '#1E9E3A', cursor: 'pointer', fontSize: 11, fontWeight: 700, fontFamily: 'inherit' }}>✓ Incluir igual</button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StudentDetailTable({ result, assignments, classRecords, onApproveReview, onApproveExceed }: {
  result: TeacherFinanceResult;
  assignments: Assignment[];
  classRecords: import('@/types').ClassRecord[];
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
              const subtotal = pagables.reduce((s, r) => s + r.rate, 0);
              const antiquity = rows[0]?.antiquityDays ?? 0;
              const rate = rows[0]?.rate ?? 0;
              const isOpen = openStudent === name;
              const hasReview = rows.some(r => r.status === 'a_revisar');
              return (
                <Fragment key={name}>
                  <tr style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }} onClick={() => setOpenStudent(isOpen ? null : name)}>
                    <td style={{ padding: '9px 14px', whiteSpace: 'nowrap', color: 'var(--text-primary)', fontWeight: 600 }}>{isOpen ? '▾ ' : '▸ '}{name}</td>
                    <td style={{ padding: '9px 14px', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>{asgn?.plan || '—'}</td>
                    <td style={{ padding: '9px 14px', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>{asgn?.startDate ? finDateShort(asgn.startDate) : '—'}</td>
                    <td style={{ padding: '9px 14px', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>{antiquity}d</td>
                    <td style={{ padding: '9px 14px', whiteSpace: 'nowrap', color: 'var(--text-primary)' }}>€{rate.toFixed(2)}</td>
                    <td style={{ padding: '9px 14px', whiteSpace: 'nowrap', color: 'var(--text-primary)', fontWeight: 600 }}>{pagables.length}</td>
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
                          result={result} studentName={name} classRecords={classRecords}
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
  const {
    teachers, assignments, classJoinLogs, classRecords, financeRates, financePayments, scoringEvents,
    loadFinanceData, markPaymentAsPaid, approveReviewClass, approveExceedLimitClass,
  } = useTeachers();

  const nowSpain = getSpainParts(new Date());
  const [monthYear, setMonthYear] = useState(nowSpain.dateStr.slice(0, 7));
  const [teacherFilter, setTeacherFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'paid' | 'pending'>('all');
  const [expandedTeacher, setExpandedTeacher] = useState<string | null>(null);
  const [paying, setPaying] = useState<string | null>(null);

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
          scoringEvents, payment,
        });
      })
      .filter(r => {
        if (statusFilter === 'paid') return r.paymentStatus === 'paid';
        if (statusFilter === 'pending') return r.paymentStatus !== 'paid';
        return true;
      });
  }, [teachers, teacherFilter, statusFilter, monthYear, assignments, classJoinLogs, classRecords, financeRates, scoringEvents, financePayments]);

  // Solo mostrar profesores con actividad en el mes (o el filtrado explícito).
  const visible = results.filter(r => teacherFilter || r.rows.length > 0 || r.bonusFromScoring > 0 || r.paymentStatus === 'paid');

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
    const lines = ['Profesor,Alumno,Fecha,Tarifa,Estado,Total profesor'];
    for (const r of visible) {
      for (const row of r.rows) {
        lines.push([
          `"${r.teacherName}"`, `"${row.studentName}"`, row.date,
          row.rate.toFixed(2), row.status, r.totalAPagar.toFixed(2),
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
                        <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', color: '#1E9E3A', fontWeight: 700 }}>€{r.totalAPagar.toFixed(2)}</td>
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
                              result={r} assignments={assignments} classRecords={classRecords}
                              onApproveReview={(student, date) => approveReviewClass(r.teacherId, student, date)}
                              onApproveExceed={(student, date) => approveExceedLimitClass(r.teacherId, student, date)}
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
        )}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
function FinanzasContent() {
  const { reloadAll } = useTeachers();
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }}>
      <NavBar />
      <PullToRefresh onRefresh={reloadAll}>
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '32px 20px 48px' }}>
          <LastUpdated />
          <div style={{ marginBottom: 24 }}>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 4px' }}>💰 Finanzas</h1>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>Gestión de pagos a profesores</p>
          </div>
          <FinanceTab />
        </div>
      </PullToRefresh>
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
