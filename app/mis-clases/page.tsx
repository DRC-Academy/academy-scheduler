'use client';
import { useState, useEffect, useMemo } from 'react';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { PullToRefresh } from '@/components/PullToRefresh';
import { LastUpdated } from '@/components/LastUpdated';
import { getSpainParts } from '@/components/VisualCalendar';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import { calculateTeacherFinance, recordVerification } from '@/lib/finance';
import { Teacher, Assignment } from '@/types';

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

// Modal "Añadir clase"
function AddClassModal({ teacher, myAssignments, onClose, onSaved }: {
  teacher: Teacher;
  myAssignments: Assignment[];
  onClose: () => void;
  onSaved: (studentName: string, date: string, time: string | undefined, file: File) => Promise<void>;
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

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

  const canSave = !!studentName && !!date && !!file && !saving;

  async function handleSave() {
    if (!canSave || !file) return;
    setSaving(true); setError('');
    try {
      await onSaved(studentName, date, time || undefined, file);
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
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>Captura de pantalla <span style={{ color: '#ef4444' }}>*</span></label>
            <input type="file" accept="image/*" onChange={e => setFile(e.target.files?.[0] ?? null)} style={{ ...inputStyle, padding: '7px 10px' }} />
            {file && <div style={{ fontSize: 11, color: '#1E9E3A', marginTop: 5 }}>📷 {file.name}</div>}
          </div>
          {error && <div style={{ fontSize: 12, color: '#ef4444' }}>{error}</div>}
          <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
            <button onClick={onClose} disabled={saving} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: '#6b7280', cursor: saving ? 'not-allowed' : 'pointer', fontSize: 14, fontFamily: 'inherit' }}>Cancelar</button>
            <button onClick={handleSave} disabled={!canSave} style={{ flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: canSave ? '#1E9E3A' : '#d1d5db', color: 'white', cursor: canSave ? 'pointer' : 'not-allowed', fontSize: 14, fontWeight: 700, fontFamily: 'inherit' }}>
              {saving ? 'Guardando...' : 'Guardar registro'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MyClassesTab({ teacher, myAssignments }: { teacher: Teacher; myAssignments: Assignment[] }) {
  const {
    assignments, classRecords, classJoinLogs, financeRates, financePayments, scoringEvents,
    registerClassRecord,
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

  // Agrupar por alumno.
  const byStudent = useMemo(() => {
    const map = new Map<string, typeof monthRecords>();
    for (const r of monthRecords) {
      if (!map.has(r.studentName)) map.set(r.studentName, []);
      map.get(r.studentName)!.push(r);
    }
    for (const list of map.values()) list.sort((a, b) => a.classDate.localeCompare(b.classDate));
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [monthRecords]);

  // Resumen de pago (cálculo de finanzas).
  const payment = financePayments.find(p => p.teacherId === teacher.id && p.monthYear === monthYear) ?? null;
  const finance = useMemo(() => calculateTeacherFinance({
    teacherId: teacher.id, teacherName: teacher.name, monthYear,
    assignments, joinLogs: classJoinLogs, classRecords, rates: financeRates,
    scoringEvents, payment,
  }), [teacher.id, teacher.name, monthYear, assignments, classJoinLogs, classRecords, financeRates, scoringEvents, payment]);

  function toggle(name: string) {
    setExpanded(prev => { const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n; });
  }

  function planLevelFor(studentName: string): { plan: string; level: string } {
    const a = myAssignments.find(a => a.studentName === studentName);
    return { plan: a?.plan ?? '', level: a?.studentLevel ?? '' };
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
        ].map(c => (
          <div key={c.label} style={card}>
            <div style={{ fontSize: 24, fontWeight: 700, color: c.color }}>{c.value}</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3 }}>{c.label}</div>
          </div>
        ))}
      </div>

      {/* Agrupado por alumno */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>Clases por alumno</div>
        {byStudent.length === 0 ? (
          <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            No registraste clases este mes. Usá <b>＋ Añadir clase</b> para subir una captura.
          </div>
        ) : byStudent.map(([name, records]) => {
          const { plan, level } = planLevelFor(name);
          const isOpen = expanded.has(name);
          return (
            <div key={name} style={{ borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px', cursor: 'pointer' }} onClick={() => toggle(name)}>
                <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'rgba(34,197,94,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: '#16a34a', flexShrink: 0 }}>
                  {name.split(' ').map(p => p[0]).join('').toUpperCase().slice(0, 2)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>{name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{[plan, level].filter(Boolean).join(' · ') || '—'}</div>
                </div>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600 }}>{records.length} clase{records.length !== 1 ? 's' : ''} registrada{records.length !== 1 ? 's' : ''}</span>
                <span style={{ fontSize: 12, color: '#1E9E3A', fontWeight: 600 }}>{isOpen ? 'Ocultar ▲' : 'Ver detalle ▼'}</span>
              </div>
              {isOpen && (
                <div style={{ overflowX: 'auto', borderTop: '1px solid var(--border)', background: 'var(--bg-surface-2)' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 460 }}>
                    <thead>
                      <tr style={{ textAlign: 'left' }}>
                        {['Fecha', 'Hora', 'Captura', 'Verificación'].map(h => (
                          <th key={h} style={{ padding: '8px 16px', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {records.map(r => {
                        const v = recordVerification(r.studentName, r.classDate, classJoinLogs, teacher.id);
                        return (
                          <tr key={r.id} style={{ borderTop: '1px solid var(--border)' }}>
                            <td style={{ padding: '8px 16px', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>{finShortDate(r.classDate)}</td>
                            <td style={{ padding: '8px 16px', whiteSpace: 'nowrap', color: 'var(--text-primary)', fontWeight: 600 }}>{r.classTime ?? '—'}</td>
                            <td style={{ padding: '8px 16px', whiteSpace: 'nowrap' }}>
                              <a href={r.screenshotUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#1E9E3A', fontWeight: 600, textDecoration: 'none' }}>📷 Ver</a>
                            </td>
                            <td style={{ padding: '8px 16px', whiteSpace: 'nowrap' }}>
                              {v === 'detected'
                                ? <span style={{ fontSize: 11, padding: '2px 9px', borderRadius: 12, background: 'rgba(30,158,58,0.1)', color: '#1E9E3A', fontWeight: 700 }}>✅ Ingreso detectado</span>
                                : <span style={{ fontSize: 11, padding: '2px 9px', borderRadius: 12, background: 'rgba(249,115,22,0.12)', color: '#ea580c', fontWeight: 700 }}>⚠️ Sin ingreso detectado</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
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
          onClose={() => setShowAdd(false)}
          onSaved={(studentName, date, time, file) => registerClassRecord(teacher.id, studentName, date, time, file)}
        />
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
function MisClasesContent() {
  const { user } = useAuth();
  const { teachers, assignments, reloadAll, loadFinanceData } = useTeachers();

  useEffect(() => { loadFinanceData(); /* eslint-disable-next-line */ }, []);

  const teacher = teachers.find(t => t.id === user?.teacherId) ?? teachers[0];
  const myAssignments = teacher ? assignments.filter(a => a.teacherId === teacher.id) : [];

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
