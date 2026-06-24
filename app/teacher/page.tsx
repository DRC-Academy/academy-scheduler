'use client';
import { useState, useEffect } from 'react';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { PullToRefresh } from '@/components/PullToRefresh';
import { LastUpdated } from '@/components/LastUpdated';
import { VisualCalendar, DAYS, cellKey } from '@/components/VisualCalendar';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import { calcCurrentClassNumber, dbCheckStudentExists } from '@/lib/db';
import { Grid, Teacher, Assignment, ScoringEvent, Student } from '@/types';

// ── localStorage helpers for milestone banner persistence ─────────────────────
function hasSeenBanner(teacherId: string, studentName: string, milestone: number): boolean {
  try { return localStorage.getItem(`banner_seen_${teacherId}_${studentName}_${milestone}`) === '1'; }
  catch { return false; }
}
function markBannerSeen(teacherId: string, studentName: string, milestone: number): void {
  try { localStorage.setItem(`banner_seen_${teacherId}_${studentName}_${milestone}`, '1'); }
  catch {}
}

// ── localStorage helpers for 6-month bonus banner ────────────────────────────
function hasSeenBonusBanner(teacherId: string, studentName: string, assignmentId: string): boolean {
  try { return localStorage.getItem(`banner_6meses_seen_${teacherId}_${studentName}_${assignmentId}`) === '1'; }
  catch { return false; }
}
function markBonusBannerSeen(teacherId: string, studentName: string, assignmentId: string): void {
  try { localStorage.setItem(`banner_6meses_seen_${teacherId}_${studentName}_${assignmentId}`, '1'); }
  catch {}
}

// ── Milestone date estimator ──────────────────────────────────────────────────
function estimateMilestoneDate(startDate: string, milestone: number, slotsPerWeek: number): string {
  const weeksNeeded = Math.ceil(milestone / slotsPerWeek);
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const start  = new Date(sy, sm - 1, sd);
  const target = new Date(start.getTime() + weeksNeeded * 7 * 24 * 60 * 60 * 1000);
  return target.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
}

// ── AssignConfirmData ─────────────────────────────────────────────────────────
interface AssignConfirmData {
  isNew: boolean;
  studentName: string;
  slots: Array<{ day: string; hour: string }>;
  startDate: string;
  weeklyHours: number;
  newStudentData?: { name: string; email: string; level: string; plan: string };
  existingAssignment?: Assignment;
  // Use existing student record without creating a new one
  useExistingStudent?: { id: string; name: string; email: string; level: string };
}

// ── Assign Student Modal ──────────────────────────────────────────────────────
function AssignStudentModal({
  day, hour, grid, myAssignments, onConfirm, onCancel,
}: {
  day: string;
  hour: string;
  grid: Grid;
  myAssignments: Assignment[];
  onConfirm: (data: AssignConfirmData) => void;
  onCancel: () => void;
}) {
  const today = new Date().toISOString().split('T')[0];
  const [tab, setTab]       = useState<'existing' | 'new'>('existing');
  const [search, setSearch] = useState('');
  const [step, setStep]     = useState<1 | 2>(1);
  const [selectedAssignment, setSelectedAssignment] = useState<Assignment | null>(null);
  const [slots, setSlots]       = useState<Array<{ day: string; hour: string }>>([{ day, hour }]);
  const [startDate, setStartDate] = useState(today);
  const [newName, setNewName]   = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newLevel, setNewLevel] = useState('B1');
  const [newPlan, setNewPlan]   = useState('Inglés general');
  const [duplicateStudent, setDuplicateStudent] = useState<{ id: string; name: string; email: string; level: string } | null>(null);
  const [checkingEmail, setCheckingEmail] = useState(false);

  // Compute cells available for slot picking: all libre cells + clicked cell
  const libreCells: Array<{ day: string; hour: string }> = [];
  const seenKeys = new Set<string>();
  libreCells.push({ day, hour });
  seenKeys.add(`${day}_${hour}`);
  for (const [key, cell] of Object.entries(grid)) {
    if (cell.state === 'libre' && !seenKeys.has(key)) {
      const [d, h] = key.split('_');
      libreCells.push({ day: d, hour: h });
      seenKeys.add(key);
    }
  }

  function getAvailableDays(slotIndex: number): string[] {
    const taken = new Set(
      slots.filter((s, i) => i !== slotIndex && s.day && s.hour).map(s => `${s.day}_${s.hour}`)
    );
    const avail = new Set(libreCells.filter(c => !taken.has(`${c.day}_${c.hour}`)).map(c => c.day));
    return DAYS.filter(d => avail.has(d));
  }

  function getAvailableHours(slotIndex: number, selDay: string): string[] {
    const taken = new Set(
      slots.filter((s, i) => i !== slotIndex && s.day && s.hour).map(s => `${s.day}_${s.hour}`)
    );
    return libreCells
      .filter(c => c.day === selDay && !taken.has(`${c.day}_${c.hour}`))
      .map(c => c.hour)
      .sort((a, b) => parseInt(a) - parseInt(b));
  }

  function updateSlotDay(i: number, d: string) {
    setSlots(prev => prev.map((s, idx) => idx === i ? { day: d, hour: '' } : s));
  }
  function updateSlotHour(i: number, h: string) {
    setSlots(prev => prev.map((s, idx) => idx === i ? { ...s, hour: h } : s));
  }
  function addSlot() { setSlots(prev => [...prev, { day: '', hour: '' }]); }
  function removeSlot(i: number) { setSlots(prev => prev.filter((_, idx) => idx !== i)); }

  const allSlotsValid = slots.length > 0 && slots.every(s => s.day && s.hour);

  function selectStudent(a: Assignment) {
    setSelectedAssignment(a);
    const base = [...(a.slots || [])];
    if (!base.some(s => s.day === day && s.hour === hour)) base.unshift({ day, hour });
    setSlots(base);
    setStartDate(a.startDate || today);
    setStep(2);
  }

  function handleTabChange(t: 'existing' | 'new') {
    setTab(t);
    setStep(1);
    setSelectedAssignment(null);
    setSlots([{ day, hour }]);
    setStartDate(today);
  }

  const uniqueStudents = Array.from(new Map(myAssignments.map(a => [a.studentName, a])).values());
  const filtered = uniqueStudents.filter(a => a.studentName.toLowerCase().includes(search.toLowerCase()));

  // Slot editor (shared between step 2 and new-student tab)
  const slotEditor = (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        Horarios · {slots.length} {slots.length === 1 ? 'clase' : 'clases'}/semana
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
        {slots.map((slot, i) => {
          const availDays  = getAvailableDays(i);
          const availHours = slot.day ? getAvailableHours(i, slot.day) : [];
          const dayOpts  = slot.day && !availDays.includes(slot.day) ? [slot.day, ...availDays] : availDays;
          const hourOpts = slot.hour && !availHours.includes(slot.hour) ? [slot.hour, ...availHours] : availHours;
          return (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 16, textAlign: 'right' }}>{i + 1}.</span>
              <select value={slot.day} onChange={e => updateSlotDay(i, e.target.value)} style={{ flex: 1, fontSize: 12 }}>
                <option value="">Día...</option>
                {dayOpts.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
              <select value={slot.hour} onChange={e => updateSlotHour(i, e.target.value)} disabled={!slot.day} style={{ flex: 1, fontSize: 12 }}>
                <option value="">Hora...</option>
                {hourOpts.map(h => <option key={h} value={h}>{h} 🇪🇸</option>)}
              </select>
              {slots.length > 1 && (
                <button onClick={() => removeSlot(i)} title="Eliminar"
                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 2px', fontFamily: 'inherit' }}>
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>
      {slots.length < 5 && (
        <button onClick={addSlot}
          style={{ fontSize: 12, color: '#1E9E3A', background: 'rgba(30,158,58,0.06)', border: '1px dashed rgba(30,158,58,0.4)', borderRadius: 7, padding: '5px 12px', cursor: 'pointer', fontFamily: 'inherit', marginBottom: 4 }}>
          + Agregar horario
        </button>
      )}
    </div>
  );

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid #35405a', borderRadius: 16, width: '100%', maxWidth: 460, maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ padding: '18px 22px 0', flexShrink: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 17, color: 'var(--text-primary)', marginBottom: 2 }}>Asignar alumno</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>{day} · {hour} 🇪🇸</div>

          {step === 1 ? (
            <div style={{ display: 'flex', borderBottom: '1px solid var(--border)' }}>
              {(['existing', 'new'] as const).map(id => (
                <button key={id} onClick={() => handleTabChange(id)} style={{
                  flex: 1, padding: '8px 12px', border: 'none',
                  borderBottom: `2px solid ${tab === id ? '#1E9E3A' : 'transparent'}`,
                  background: 'transparent', color: tab === id ? '#1E9E3A' : 'var(--text-muted)',
                  cursor: 'pointer', fontSize: 13, fontWeight: tab === id ? 700 : 400, fontFamily: 'inherit',
                }}>
                  {id === 'existing' ? 'Mis alumnos' : 'Nuevo alumno'}
                </button>
              ))}
            </div>
          ) : (
            <div style={{ paddingBottom: 12, borderBottom: '1px solid var(--border)' }}>
              <button onClick={() => { setStep(1); setSelectedAssignment(null); }}
                style={{ background: 'none', border: 'none', color: '#1E9E3A', cursor: 'pointer', fontSize: 13, fontWeight: 600, padding: 0, fontFamily: 'inherit' }}>
                ← Volver
              </button>
              <span style={{ fontSize: 13, color: 'var(--text-muted)', marginLeft: 10 }}>
                Horario de <b style={{ color: 'var(--text-primary)' }}>{selectedAssignment?.studentName}</b>
              </span>
            </div>
          )}
        </div>

        {/* Scrollable body */}
        <div style={{ overflowY: 'auto', padding: '14px 22px 22px', flex: 1 }}>

          {/* Existing — step 1: student list */}
          {tab === 'existing' && step === 1 && (
            <>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar alumno..." autoFocus style={{ marginBottom: 10 }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {filtered.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-muted)', fontSize: 13 }}>
                    {myAssignments.length === 0 ? 'No tenés alumnos asignados aún.' : 'Sin resultados.'}
                  </div>
                ) : filtered.map(a => (
                  <button key={a.id} onClick={() => selectStudent(a)} style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 9,
                    border: '1px solid var(--border)', background: 'var(--bg-surface-2)', cursor: 'pointer',
                    textAlign: 'left', width: '100%', fontFamily: 'inherit',
                  }}>
                    <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'rgba(30,158,58,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#1E9E3A', flexShrink: 0 }}>
                      {a.studentName.charAt(0).toUpperCase()}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{a.studentName}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {a.studentLevel} · {a.slots.length} h/sem · {a.slots.map(s => `${s.day} ${s.hour}`).join(', ')}
                      </div>
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Editar →</span>
                  </button>
                ))}
              </div>
            </>
          )}

          {/* Existing — step 2: slot editor */}
          {tab === 'existing' && step === 2 && selectedAssignment && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {slotEditor}
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Fecha de inicio
                </label>
                <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ width: '100%' }} />
              </div>
              <button
                onClick={() => allSlotsValid && onConfirm({ isNew: false, studentName: selectedAssignment.studentName, slots, startDate, weeklyHours: slots.length, existingAssignment: selectedAssignment })}
                disabled={!allSlotsValid}
                style={{ padding: '11px', borderRadius: 9, border: 'none', background: allSlotsValid ? '#1E9E3A' : 'var(--bg-surface-3)', color: allSlotsValid ? 'white' : 'var(--text-muted)', cursor: allSlotsValid ? 'pointer' : 'not-allowed', fontSize: 14, fontWeight: 700, fontFamily: 'inherit' }}>
                Confirmar — {slots.length} {slots.length === 1 ? 'clase' : 'clases'}/semana
              </button>
            </div>
          )}

          {/* New student tab */}
          {tab === 'new' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div><label>Nombre *</label><input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Nombre completo" /></div>
              <div><label>Email</label><input value={newEmail} onChange={e => setNewEmail(e.target.value)} placeholder="email@ejemplo.com" type="email" /></div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div><label>Nivel</label>
                  <select value={newLevel} onChange={e => setNewLevel(e.target.value)}>
                    {['A1','A2','B1','B2','C1','C2'].map(l => <option key={l}>{l}</option>)}
                  </select>
                </div>
                <div><label>Plan</label>
                  <select value={newPlan} onChange={e => setNewPlan(e.target.value)}>
                    {['Inglés general','B1 Exámenes','B2 Exámenes','C1 Exámenes','Intensivo'].map(p => <option key={p}>{p}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                {slotEditor}
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Fecha de inicio *
                </label>
                <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ width: '100%' }} />
              </div>
              {(() => {
                const canCreate = !!newName.trim() && allSlotsValid && !!startDate && !checkingEmail;
                return (<>
                  <button
                    onClick={async () => {
                      if (!canCreate) return;
                      if (newEmail.trim()) {
                        setCheckingEmail(true);
                        const existing = await dbCheckStudentExists(newEmail.trim());
                        setCheckingEmail(false);
                        if (existing) { setDuplicateStudent(existing); return; }
                      }
                      onConfirm({ isNew: true, studentName: newName.trim(), slots, startDate, weeklyHours: slots.length, newStudentData: { name: newName.trim(), email: newEmail, level: newLevel, plan: newPlan } });
                    }}
                    disabled={!canCreate}
                    style={{ padding: '11px', borderRadius: 9, border: 'none', background: canCreate ? '#1E9E3A' : 'var(--bg-surface-3)', color: canCreate ? 'white' : 'var(--text-muted)', cursor: canCreate ? 'pointer' : 'not-allowed', fontSize: 14, fontWeight: 700, fontFamily: 'inherit' }}>
                    {checkingEmail ? 'Verificando...' : `Crear y asignar — ${slots.length} ${slots.length === 1 ? 'clase' : 'clases'}/semana`}
                  </button>

                  {/* Duplicate email overlay */}
                  {duplicateStudent && (
                    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)', zIndex: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
                      <div style={{ background: 'var(--bg-surface)', border: '1px solid #35405a', borderRadius: 14, padding: 24, width: '100%', maxWidth: 400 }}>
                        <div style={{ fontSize: 24, marginBottom: 10 }}>⚠️</div>
                        <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 8 }}>Este alumno ya existe</div>
                        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20, lineHeight: 1.6 }}>
                          Ya hay un alumno registrado con el email <b>{duplicateStudent.email}</b>:<br />
                          <b style={{ color: 'var(--text-primary)' }}>{duplicateStudent.name}</b> · {duplicateStudent.level}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <button
                            onClick={() => { setDuplicateStudent(null); onConfirm({ isNew: false, studentName: duplicateStudent.name, slots, startDate, weeklyHours: slots.length, useExistingStudent: duplicateStudent }); }}
                            style={{ padding: '10px', borderRadius: 8, border: 'none', background: '#1E9E3A', color: 'white', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
                            Usar alumno existente
                          </button>
                          <button
                            onClick={() => { setDuplicateStudent(null); onConfirm({ isNew: true, studentName: newName.trim(), slots, startDate, weeklyHours: slots.length, newStudentData: { name: newName.trim(), email: newEmail, level: newLevel, plan: newPlan } }); }}
                            style={{ padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
                            Crear de todas formas (duplicado)
                          </button>
                          <button onClick={() => setDuplicateStudent(null)}
                            style={{ padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
                            Cancelar
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </>);
              })()}
            </div>
          )}

          <button onClick={onCancel} style={{ marginTop: 12, width: '100%', padding: '9px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Level constants ──────────────────────────────────────────────────────────
const LEVEL_INFO = {
  1: { name: 'Profesor Junior', color: '#6b7280', bg: 'rgba(107,114,128,0.1)', border: 'rgba(107,114,128,0.3)' },
  2: { name: 'Profesor Senior', color: '#1E9E3A', bg: 'rgba(30,158,58,0.1)',   border: 'rgba(30,158,58,0.35)' },
  3: { name: 'Profesor Elite',  color: '#b8860b', bg: 'rgba(255,196,0,0.15)',  border: '#FFC400' },
} as const;

const EVENT_LABELS: Record<string, string> = {
  falta:              'Falta a clase',
  atraso:             'Atraso',
  queja:              'Queja de alumno',
  cancelacion_tardia: 'Cancelación tardía',
  upsell:             'Upsell',
  bonus_retencion:    'Bonus retención',
  bonus_puntualidad:  'Bonus puntualidad',
  review_trustpilot:  'Reseña Trustpilot',
  bonus_feedback:     'Bonus feedback',
};

const MOTIVATIONAL: Record<number, string> = {
  1: '¡Buen comienzo! Seguí creciendo para alcanzar el nivel Senior.',
  2: '¡Excelente trabajo! Estás en camino de convertirte en Profesor Elite.',
  3: '¡Sos un Profesor Elite! Seguí siendo el mejor ejemplo en la academia.',
};

// ─── Teacher Scoring Tab ──────────────────────────────────────────────────────
function TeacherScoringTab({ teacher, myAssignments, myEvents }: {
  teacher: Teacher;
  myAssignments: Assignment[];
  myEvents: ScoringEvent[];
}) {
  const today      = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  const myMonthEvents = myEvents.filter(e => new Date(e.createdAt) >= monthStart);

  // Score calculation
  const manualPoints   = myEvents.reduce((s, e) => s + e.points, 0);
  const activeStudents = myAssignments.length;
  const monthlyHours   = teacher.weeklyLoad * 4;
  const thirtyDaysAgo  = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const retained       = myAssignments.filter(a => new Date(a.createdAt) < thirtyDaysAgo).length;
  const retentionPct   = activeStudents > 0 ? (retained / activeStudents) * 100 : 0;

  let autoPoints = activeStudents * 10 + monthlyHours * 2;
  if (retentionPct > 85)                           autoPoints += 50;
  else if (retentionPct >= 70)                     autoPoints += 25;
  else if (retentionPct < 50 && activeStudents > 0) autoPoints -= 20;

  const totalScore    = Math.max(0, manualPoints + autoPoints);
  const currentLevel  = totalScore >= 300 ? 3 : totalScore >= 150 ? 2 : 1;
  const nextLevel     = Math.min(3, currentLevel + 1);
  const prevThreshold = currentLevel === 1 ? 0   : currentLevel === 2 ? 150 : 300;
  const nextThreshold = currentLevel === 1 ? 150 : currentLevel === 2 ? 300 : 300;
  const progressToNext = currentLevel < 3
    ? Math.min(100, ((totalScore - prevThreshold) / (nextThreshold - prevThreshold)) * 100)
    : 100;

  const levelInfo     = LEVEL_INFO[(currentLevel as 1|2|3)];
  const nextLevelInfo = LEVEL_INFO[(nextLevel as 1|2|3)];

  // Bonuses this month
  const totalMonthlyEuros  = myMonthEvents.reduce((s, e) => s + e.euros, 0);
  const upsellEuros        = myMonthEvents.filter(e => e.eventType === 'upsell').reduce((s, e) => s + e.euros, 0);
  const retentionEuros     = myMonthEvents.filter(e => e.eventType === 'bonus_retencion').reduce((s, e) => s + e.euros, 0);
  const trustpilotCount    = myMonthEvents.filter(e => e.eventType === 'review_trustpilot').length;
  const upsellCount        = myMonthEvents.filter(e => e.eventType === 'upsell').reduce((s, e) => s + (e.quantity ?? 1), 0);
  const retentionCount     = myMonthEvents.filter(e => e.eventType === 'bonus_retencion').length;

  // Level requirements
  const faltasThisMonth  = myMonthEvents.filter(e => e.eventType === 'falta_injustificada' || e.eventType === 'falta_justificada').length;
  const quejasActive     = myMonthEvents.filter(e => e.eventType === 'queja').length;
  const upsellsTotal     = myEvents.filter(e => e.eventType === 'upsell').reduce((s, e) => s + (e.quantity ?? 1), 0);
  const monthsOnPlatform = teacher.createdAt
    ? Math.floor((Date.now() - new Date(teacher.createdAt).getTime()) / (30 * 24 * 60 * 60 * 1000))
    : 0;

  // Retention progress per student
  const studentProgress = myAssignments.map(a => {
    const start      = new Date(a.startDate ?? a.createdAt);
    const daysActive = Math.floor((today.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
    const pct        = Math.min(100, (daysActive / 180) * 100);
    const hasBonus   = myEvents.some(e => e.eventType === 'bonus_retencion' && e.studentRef === a.studentName);
    return { a, daysActive, pct, hasBonus, start };
  }).sort((a, b) => b.daysActive - a.daysActive);

  const availableBonuses = studentProgress.filter(s => s.daysActive >= 180 && !s.hasBonus);
  const nextBonus        = studentProgress.filter(s => s.daysActive < 180).sort((a, b) => b.daysActive - a.daysActive)[0];

  const currentReqs = currentLevel === 1
    ? [
        { label: `Retención ≥50% (actual: ${Math.round(retentionPct)}%)`, met: retentionPct >= 50 },
        { label: `Faltas ≤3 este mes (actual: ${faltasThisMonth})`, met: faltasThisMonth <= 3 },
        { label: `Sin quejas activas (actual: ${quejasActive})`, met: quejasActive === 0 },
      ]
    : currentLevel === 2
      ? [
          { label: `Retención ≥70% (actual: ${Math.round(retentionPct)}%)`, met: retentionPct >= 70 },
          { label: `Faltas ≤1 este mes (actual: ${faltasThisMonth})`, met: faltasThisMonth <= 1 },
          { label: `≥5 alumnos activos (actual: ${activeStudents})`, met: activeStudents >= 5 },
          { label: `≥1 upsell realizado (actual: ${upsellsTotal})`, met: upsellsTotal >= 1 },
        ]
      : [
          { label: `Retención ≥85% (actual: ${Math.round(retentionPct)}%)`, met: retentionPct >= 85 },
          { label: `Cero faltas este mes (actual: ${faltasThisMonth})`, met: faltasThisMonth === 0 },
          { label: `≥10 alumnos activos (actual: ${activeStudents})`, met: activeStudents >= 10 },
          { label: `≥3 upsells realizados (actual: ${upsellsTotal})`, met: upsellsTotal >= 3 },
          { label: `>6 meses en la plataforma (actual: ${monthsOnPlatform})`, met: monthsOnPlatform >= 6 },
        ];

  const nextReqs = nextLevel === 2
    ? [
        { label: `Retención ≥70%`, current: `${Math.round(retentionPct)}%`, pct: Math.min(100, retentionPct / 70 * 100) },
        { label: `Máx. 1 falta al mes`, current: `${faltasThisMonth} faltas`, pct: faltasThisMonth <= 1 ? 100 : 0 },
        { label: `5 alumnos activos`, current: `${activeStudents}`, pct: Math.min(100, (activeStudents / 5) * 100) },
        { label: `1 upsell`, current: `${upsellsTotal}`, pct: upsellsTotal >= 1 ? 100 : 0 },
      ]
    : nextLevel === 3
      ? [
          { label: `Retención ≥85%`, current: `${Math.round(retentionPct)}%`, pct: Math.min(100, retentionPct / 85 * 100) },
          { label: `Cero faltas al mes`, current: `${faltasThisMonth} faltas`, pct: faltasThisMonth === 0 ? 100 : 0 },
          { label: `10 alumnos activos`, current: `${activeStudents}`, pct: Math.min(100, (activeStudents / 10) * 100) },
          { label: `3 upsells`, current: `${upsellsTotal}`, pct: Math.min(100, (upsellsTotal / 3) * 100) },
          { label: `6+ meses en la plataforma`, current: `${monthsOnPlatform} meses`, pct: Math.min(100, (monthsOnPlatform / 6) * 100) },
        ]
      : [];

  const cardStyle = {
    background: '#F7F7F5', border: '1px solid #e5e7eb', borderRadius: 14, padding: '20px 24px',
  } as const;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* ── Level card ── */}
      <div style={{ ...cardStyle, border: `2px solid ${levelInfo.border}`, background: levelInfo.bg }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 12 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 16px', borderRadius: 24, background: 'white', border: `1px solid ${levelInfo.border}`, color: levelInfo.color, fontSize: 14, fontWeight: 700, boxShadow: currentLevel === 3 ? '0 0 10px rgba(255,196,0,0.4)' : 'none' }}>
            {currentLevel === 3 ? '⭐ ' : ''}{levelInfo.name}
          </span>
          <span style={{ fontSize: 30, fontWeight: 800, color: '#111827' }}>{totalScore} pts</span>
        </div>

        {currentLevel < 3 && (
          <>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>
              Progreso hacia {nextLevelInfo.name} — {nextThreshold - totalScore > 0 ? `faltan ${nextThreshold - totalScore} puntos` : 'nivel alcanzado'}
            </div>
            <div style={{ height: 10, borderRadius: 5, background: 'rgba(0,0,0,0.08)', overflow: 'hidden' }}>
              <div style={{ width: `${progressToNext}%`, height: '100%', borderRadius: 5, background: levelInfo.color, transition: 'width 0.5s ease' }} />
            </div>
          </>
        )}

        <div style={{ fontSize: 13, color: '#374151', marginTop: 12, fontStyle: 'italic' }}>
          {MOTIVATIONAL[currentLevel]}
        </div>
      </div>

      {/* ── Bonuses card ── */}
      <div style={cardStyle}>
        <div style={{ fontWeight: 700, fontSize: 15, color: '#111827', marginBottom: 14 }}>💰 Mis bonos del mes</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 36, fontWeight: 800, color: '#1E9E3A' }}>€{totalMonthlyEuros}</span>
          <span style={{ fontSize: 13, color: '#6b7280' }}>este mes</span>
        </div>
        {(upsellCount > 0 || retentionCount > 0 || trustpilotCount > 0) ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {upsellCount > 0 && (
              <div style={{ fontSize: 13, color: '#374151' }}>
                • {upsellCount} upsell{upsellCount > 1 ? 's' : ''} <span style={{ color: '#1E9E3A', fontWeight: 600 }}>(€{upsellEuros})</span>
              </div>
            )}
            {retentionCount > 0 && (
              <div style={{ fontSize: 13, color: '#374151' }}>
                • {retentionCount} bono{retentionCount > 1 ? 's' : ''} retención <span style={{ color: '#1E9E3A', fontWeight: 600 }}>(€{retentionEuros})</span>
              </div>
            )}
            <div style={{ fontSize: 13, color: '#374151' }}>
              • Reseñas Trustpilot este mes: <b>{trustpilotCount}</b>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 13, color: '#6b7280' }}>Sin bonos este mes todavía.</div>
        )}

        {availableBonuses.length > 0 && (
          <div style={{ marginTop: 12, background: 'rgba(30,158,58,0.1)', border: '1px solid rgba(30,158,58,0.3)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#1E9E3A', fontWeight: 600 }}>
            🎉 Bono disponible: {availableBonuses.map(b => b.a.studentName).join(', ')}
          </div>
        )}

        {nextBonus && availableBonuses.length === 0 && (
          <div style={{ marginTop: 12, fontSize: 13, color: '#6b7280' }}>
            Próximo bono: te faltan <b style={{ color: '#374151' }}>{180 - nextBonus.daysActive} días</b> para el bono de <b style={{ color: '#374151' }}>{nextBonus.a.studentName}</b>
          </div>
        )}
      </div>

      {/* ── Requirements card ── */}
      <div style={cardStyle}>
        <div style={{ fontWeight: 700, fontSize: 15, color: '#111827', marginBottom: 14 }}>📋 Requisitos de nivel</div>

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: levelInfo.color, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Mi nivel actual — {levelInfo.name}
          </div>
          {currentReqs.map(r => (
            <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: r.met ? '#1E9E3A' : '#6b7280', marginBottom: 5 }}>
              <span style={{ fontSize: 14 }}>{r.met ? '✅' : '❌'}</span> {r.label}
            </div>
          ))}
        </div>

        {nextReqs.length > 0 && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: nextLevelInfo.color, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Siguiente nivel — {nextLevelInfo.name}
            </div>
            {nextReqs.map(r => (
              <div key={r.label} style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#374151', marginBottom: 3 }}>
                  <span>{r.label}</span>
                  <span style={{ color: r.pct >= 100 ? '#1E9E3A' : '#6b7280', fontWeight: 600 }}>{r.current}</span>
                </div>
                <div style={{ height: 5, borderRadius: 3, background: '#e5e7eb', overflow: 'hidden' }}>
                  <div style={{ width: `${r.pct}%`, height: '100%', borderRadius: 3, background: r.pct >= 100 ? '#1E9E3A' : nextLevelInfo.color, transition: 'width 0.4s' }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Event history ── */}
      <div style={cardStyle}>
        <div style={{ fontWeight: 700, fontSize: 15, color: '#111827', marginBottom: 14 }}>📅 Últimos eventos</div>
        {myEvents.length === 0 ? (
          <div style={{ fontSize: 13, color: '#6b7280', textAlign: 'center', padding: '20px 0' }}>Sin eventos registrados todavía.</div>
        ) : myEvents.slice(0, 10).map(ev => {
          const isPos = ev.points > 0;
          return (
            <div key={ev.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '10px 12px', borderRadius: 8, background: isPos ? 'rgba(30,158,58,0.07)' : 'rgba(239,68,68,0.07)', border: `1px solid ${isPos ? 'rgba(30,158,58,0.2)' : 'rgba(239,68,68,0.2)'}`, marginBottom: 8 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: isPos ? '#1E9E3A' : '#ef4444' }}>{EVENT_LABELS[ev.eventType] ?? ev.eventType}</div>
                <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{ev.note}</div>
                <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>{new Date(ev.createdAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 12 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: isPos ? '#1E9E3A' : '#ef4444' }}>{isPos ? '+' : ''}{ev.points}</div>
                {ev.euros > 0 && <div style={{ fontSize: 11, color: '#1E9E3A' }}>+€{ev.euros}</div>}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Retention progress ── */}
      {studentProgress.length > 0 && (
        <div style={cardStyle}>
          <div style={{ fontWeight: 700, fontSize: 15, color: '#111827', marginBottom: 14 }}>👥 Progreso de retención por alumno</div>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>Bono disponible al cumplir 180 días (6 meses) de continuidad.</div>
          {studentProgress.map(({ a, daysActive, pct, hasBonus }) => (
            <div key={a.id} style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{a.studentName}</span>
                  {daysActive >= 180 && !hasBonus && (
                    <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 12, background: 'rgba(30,158,58,0.15)', border: '1px solid rgba(30,158,58,0.3)', color: '#1E9E3A', fontWeight: 700 }}>🎉 Bono disponible</span>
                  )}
                  {hasBonus && (
                    <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 12, background: 'rgba(107,114,128,0.1)', color: '#6b7280' }}>✓ Bono cobrado</span>
                  )}
                </div>
                <span style={{ fontSize: 12, color: daysActive >= 180 ? '#1E9E3A' : '#6b7280', fontWeight: 600 }}>
                  {daysActive} / 180 días
                </span>
              </div>
              <div style={{ height: 8, borderRadius: 4, background: '#e5e7eb', overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', borderRadius: 4, background: daysActive >= 180 ? '#1E9E3A' : daysActive >= 120 ? '#FFC400' : '#3b82f6', transition: 'width 0.4s' }} />
              </div>
              <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 3 }}>
                Inicio: {new Date(a.startDate ?? a.createdAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })}
                {daysActive < 180 && ` · faltan ${180 - daysActive} días`}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Teacher Content ──────────────────────────────────────────────────────────
function TeacherContent() {
  const { user } = useAuth();
  const { teachers, assignments, scoringEvents, getTeacherGrid, updateTeacherGrid, addStudent, addAssignment, updateAssignmentAdjustment, updateAssignmentStartDate, updateAssignmentSlots, reloadAll } = useTeachers();
  const [activeTab, setActiveTab] = useState<'calendar' | 'classes' | 'scoring'>('calendar');
  const [grid, setGrid]           = useState<Grid>({});
  const [gridLoading, setGridLoading]   = useState(true);
  const [saveStatus, setSaveStatus]     = useState<'idle' | 'saving' | 'saved'>('idle');
  const [dismissedInSession, setDismissedInSession] = useState<Set<string>>(new Set());
  const [dismissedBonusInSession, setDismissedBonusInSession] = useState<Set<string>>(new Set());
  const [pendingOcupado, setPendingOcupado] = useState<{ day: string; hour: string; resolve: (name: string) => void } | null>(null);
  const [deductConfirm, setDeductConfirm] = useState<Assignment | null>(null);
  const [startDateModal, setStartDateModal] = useState<{ assignment: Assignment; date: string } | null>(null);
  const [adjustSaving, setAdjustSaving] = useState<string | null>(null);

  const teacher = teachers.find(t => t.id === user?.teacherId) ?? teachers[0];

  useEffect(() => {
    if (!teacher) return;
    setGridLoading(true);
    getTeacherGrid(teacher.id).then(g => {
      setGrid(g);
      setGridLoading(false);
    });
  }, [teacher?.id]);

  async function handleGridChange(g: Grid) {
    setGrid(g);
    setSaveStatus('saving');
    await updateTeacherGrid(teacher.id, g);
    setSaveStatus('saved');
    setTimeout(() => setSaveStatus('idle'), 2000);
  }

  function handleOcupadoNeed(day: string, hour: string, resolve: (name: string) => void, cancel: () => void) {
    setPendingOcupado({ day, hour, resolve });
  }

  async function handleAssignStudent(data: AssignConfirmData) {
    if (!teacher || !pendingOcupado) return;
    let finalName = data.studentName;

    if (data.isNew && data.newStudentData) {
      const newStudent: Student = {
        id: crypto.randomUUID(),
        name: data.newStudentData.name,
        email: data.newStudentData.email,
        level: data.newStudentData.level,
        plan: data.newStudentData.plan,
        createdAt: new Date().toISOString(),
      };
      await addStudent(newStudent);

      const newAssignment: Assignment = {
        id: crypto.randomUUID(),
        teacherId: teacher.id,
        teacherName: teacher.name,
        teacherEmail: teacher.email,
        studentId: newStudent.id,
        studentName: newStudent.name,
        studentEmail: newStudent.email,
        studentLevel: newStudent.level,
        slots: data.slots,
        objetivo: data.newStudentData.plan,
        plan: data.newStudentData.plan,
        weeklyHours: data.slots.length,
        availability: data.slots.map(s => `${s.day} ${s.hour}`).join(', '),
        notes: '',
        startDate: data.startDate,
        createdAt: new Date().toISOString(),
      };
      await addAssignment(newAssignment);
      finalName = newStudent.name;
    } else if (data.existingAssignment) {
      await updateAssignmentSlots(data.existingAssignment.id, data.slots, data.slots.length);
      if (data.startDate && data.startDate !== data.existingAssignment.startDate) {
        await updateAssignmentStartDate(data.existingAssignment.id, data.startDate);
      }
    } else if (data.useExistingStudent) {
      // Existing student record, new assignment for this teacher
      const es = data.useExistingStudent;
      const newAssignment: Assignment = {
        id: crypto.randomUUID(),
        teacherId: teacher.id,
        teacherName: teacher.name,
        teacherEmail: teacher.email,
        studentId: es.id,
        studentName: es.name,
        studentEmail: es.email,
        studentLevel: es.level,
        slots: data.slots,
        objetivo: '',
        plan: '',
        weeklyHours: data.slots.length,
        availability: data.slots.map(s => `${s.day} ${s.hour}`).join(', '),
        notes: '',
        startDate: data.startDate,
        createdAt: new Date().toISOString(),
      };
      await addAssignment(newAssignment);
      finalName = es.name;
    }

    // Update grid for all new slots and revert removed slots to libre
    const updatedGrid = { ...grid };
    if (data.existingAssignment) {
      for (const old of data.existingAssignment.slots) {
        if (!data.slots.some(s => s.day === old.day && s.hour === old.hour)) {
          updatedGrid[cellKey(old.day, old.hour)] = { state: 'libre' };
        }
      }
    }
    for (const slot of data.slots) {
      updatedGrid[cellKey(slot.day, slot.hour)] = { state: 'ocupado', student: finalName };
    }
    await handleGridChange(updatedGrid);
    setPendingOcupado(null);
  }

  function handleAssignCancel() {
    setPendingOcupado(null);
  }

  async function handleAdjust(a: Assignment, delta: number) {
    setAdjustSaving(a.id);
    const newAdj = (a.manualClassAdjustment ?? 0) + delta;
    await updateAssignmentAdjustment(a.id, newAdj);
    setAdjustSaving(null);
  }

  async function handleDeductConfirmAction() {
    if (!deductConfirm) return;
    await handleAdjust(deductConfirm, -1);
    setDeductConfirm(null);
  }

  async function handleStartDateSave() {
    if (!startDateModal) return;
    await updateAssignmentStartDate(startDateModal.assignment.id, startDateModal.date);
    setStartDateModal(null);
  }

  function dismissBanner(teacherId: string, studentName: string, milestone: number) {
    markBannerSeen(teacherId, studentName, milestone);
    setDismissedInSession(prev => new Set([...prev, `${studentName}_${milestone}`]));
  }

  function dismissBonusBanner(teacherId: string, studentName: string, assignmentId: string) {
    markBonusBannerSeen(teacherId, studentName, assignmentId);
    setDismissedBonusInSession(prev => new Set([...prev, `${studentName}_${assignmentId}`]));
  }

  if (!teacher) return null;

  const myAssignments = assignments.filter(a => a.teacherId === teacher.id);
  const myEvents      = scoringEvents.filter(e => e.teacherId === teacher.id);

  const freeCount    = Object.values(grid).filter(c => c.state === 'libre').length;
  const ocupadoCount = Object.values(grid).filter(c => c.state === 'ocupado').length;
  const bloqCount    = Object.values(grid).filter(c => c.state === 'bloqueado').length;

  // checkClass15And30Banners: revisa cantidad de clases, sin mencionar bonos
  type BannerEntry = { studentName: string; milestone: 15 | 30; startDate: string; slotsPerWeek: number };
  const visibleBanners: BannerEntry[] = [];
  for (const a of myAssignments) {
    if (!a.startDate) continue;
    const classNum = calcCurrentClassNumber(a);
    for (const milestone of [15, 30] as const) {
      if (classNum >= milestone && !hasSeenBanner(teacher.id, a.studentName, milestone) && !dismissedInSession.has(`${a.studentName}_${milestone}`)) {
        visibleBanners.push({ studentName: a.studentName, milestone, startDate: a.startDate, slotsPerWeek: a.slots.length });
        break;
      }
    }
  }

  // check6MonthBonusBanners: revisa antigüedad en meses desde start_date, independiente de clases
  type BonusBannerEntry = { studentName: string; assignmentId: string };
  const visibleBonusBanners: BonusBannerEntry[] = [];
  const today6m = new Date();
  for (const a of myAssignments) {
    if (!a.startDate) continue;
    const startDate6m = new Date(a.startDate + 'T00:00:00');
    const monthsElapsed =
      (today6m.getFullYear() - startDate6m.getFullYear()) * 12 +
      (today6m.getMonth() - startDate6m.getMonth());
    if (
      monthsElapsed >= 6 &&
      !hasSeenBonusBanner(teacher.id, a.studentName, a.id) &&
      !dismissedBonusInSession.has(`${a.studentName}_${a.id}`)
    ) {
      visibleBonusBanners.push({ studentName: a.studentName, assignmentId: a.id });
    }
  }

  // Grid-only students (ocupado cells without a DB assignment)
  const assignedNames = new Set(myAssignments.map(a => a.studentName));
  const gridOcupado = Object.entries(grid)
    .filter(([, cell]) => cell.state === 'ocupado' && cell.student && !assignedNames.has(cell.student))
    .map(([key, cell]) => { const [day, hour] = key.split('_'); return { day, hour, student: cell.student! }; });
  const legacyMap = new Map<string, { student: string; slots: { day: string; hour: string }[] }>();
  for (const c of gridOcupado) {
    if (!legacyMap.has(c.student)) legacyMap.set(c.student, { student: c.student, slots: [] });
    legacyMap.get(c.student)!.slots.push({ day: c.day, hour: c.hour });
  }
  const legacyList = Array.from(legacyMap.values());

  const tabs = [
    { id: 'calendar', label: '📅 Mi calendario' },
    { id: 'classes',  label: '📚 Clases asignadas' },
    { id: 'scoring',  label: '⭐ Mi Scoring' },
  ] as const;

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }}>
      <NavBar />
      <PullToRefresh onRefresh={reloadAll}>
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '24px 16px 48px' }}>
        <LastUpdated />

        {/* Milestone banners — clase 15 (amarillo) y clase 30 (verde), sin mencionar bonos */}
        {visibleBanners.map(banner => (
          <div key={`${banner.studentName}_${banner.milestone}`} className="milestone-banner" style={{
            background: banner.milestone === 15 ? '#FFC400' : '#1E9E3A',
            color: banner.milestone === 15 ? '#1a0f00' : 'white',
            borderRadius: 12, padding: '14px 20px', marginBottom: 14,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
          }}>
            <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.5 }}>
              {banner.milestone === 15
                ? `🎬 ¡Clase 15 con ${banner.studentName}! Recordá grabar la clase y compartir el enlace de Fathom en el Excel. ¡Gran trabajo!`
                : `🏆 ¡Clase 30 con ${banner.studentName}! Excelente continuidad, seguí así. ¡Gran trabajo!`
              }
            </div>
            <button
              className="milestone-banner-close"
              onClick={() => dismissBanner(teacher.id, banner.studentName, banner.milestone)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: 'inherit', flexShrink: 0, opacity: 0.75, fontFamily: 'inherit', lineHeight: 1 }}
            >
              ✕
            </button>
          </div>
        ))}

        {/* 6-month bonus banners — dorado, independiente de cantidad de clases */}
        {visibleBonusBanners.map(banner => (
          <div key={`bonus_6m_${banner.assignmentId}`} className="milestone-banner" style={{
            background: '#FFFBEB',
            border: '2px solid #D97706',
            borderLeft: '5px solid #D97706',
            borderRadius: 12, padding: '14px 20px', marginBottom: 14,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
          }}>
            <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.5, color: '#92400E' }}>
              {`🎁 ¡${banner.studentName} cumplió 6 meses! Recordá solicitar el bono de retención escribiendo a `}
              <span style={{ fontWeight: 700, color: '#B45309' }}>pagos@drcacademy.com</span>
            </div>
            <button
              className="milestone-banner-close"
              onClick={() => dismissBonusBanner(teacher.id, banner.studentName, banner.assignmentId)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: '#92400E', flexShrink: 0, opacity: 0.75, fontFamily: 'inherit', lineHeight: 1 }}
            >
              ✕
            </button>
          </div>
        ))}

        {/* Profile */}
        <div className="teacher-profile-card" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '18px 22px', marginBottom: 18, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ width: 50, height: 50, borderRadius: '50%', background: 'rgba(34,197,94,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 700, color: '#4ade80', flexShrink: 0 }}>{teacher.avatar}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 20, color: 'var(--text-primary)' }}>{teacher.name}</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>{teacher.email}</div>
          </div>
          <div className="teacher-profile-stats" style={{ display: 'flex', gap: 20 }}>
            {[
              { label: 'Libre',          count: freeCount,    color: '#4ade80' },
              { label: 'Ocupado',        count: ocupadoCount, color: '#93c5fd' },
              { label: 'En recuperación', count: bloqCount,   color: '#fbbf24' },
            ].map(s => (
              <div key={s.label} style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: s.color }}>{s.count}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 18, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 4 }}>
          {tabs.map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id as any)} style={{ flex: 1, padding: '7px 4px', borderRadius: 7, border: 'none', background: activeTab === tab.id ? 'var(--bg-surface-3)' : 'transparent', color: activeTab === tab.id ? 'var(--text-primary)' : 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, fontWeight: 500, whiteSpace: 'normal', textAlign: 'center', lineHeight: '1.3' }}>
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === 'calendar' && (
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' }}>Mi disponibilidad semanal</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>Hacé clic en cualquier celda para cambiar su estado. Se guarda automáticamente.</div>
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: saveStatus === 'saved' ? '#22c55e' : saveStatus === 'saving' ? '#f59e0b' : 'var(--text-muted)' }}>
                {saveStatus === 'saving' && '⏳ Guardando...'}
                {saveStatus === 'saved'  && '✓ Guardado'}
              </div>
            </div>

            <div className="states-legend" style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
              {[
                { icon: '⬜', label: 'No work',          desc: 'No trabajás ese horario' },
                { icon: '🟢', label: 'Libre',            desc: 'Disponible para clases' },
                { icon: '🔵', label: 'Ocupado',          desc: 'Clase con alumno' },
                { icon: '🩹', label: 'En recuperación',  desc: 'Clase de recuperación o ajuste' },
              ].map(s => (
                <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', background: 'var(--bg-surface-2)', borderRadius: 8, border: '1px solid var(--border)' }}>
                  <span>{s.icon}</span>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>{s.label}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{s.desc}</div>
                  </div>
                </div>
              ))}
            </div>

            {gridLoading ? (
              <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-muted)' }}>Cargando calendario...</div>
            ) : (
              <VisualCalendar mode="teacher" grid={grid} onGridChange={handleGridChange} onOcupadoNeed={handleOcupadoNeed} />
            )}
          </div>
        )}

        {activeTab === 'classes' && (
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '20px' }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 4 }}>Clases asignadas</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 18 }}>El contador se actualiza automáticamente según la fecha de inicio y los días asignados.</div>

            {myAssignments.length === 0 && legacyList.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: 14 }}>
                No tenés alumnos asignados todavía.<br />
                <span style={{ fontSize: 12 }}>Hacé clic en una celda "Ocupado" del calendario para asignar un alumno.</span>
              </div>
            ) : (
              <>
                {/* DB assignments with auto class count */}
                {myAssignments.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    {myAssignments.map(a => {
                      const classNum = calcCurrentClassNumber(a);
                      const barPct   = Math.min(100, (classNum / 30) * 100);
                      const isMilestone = classNum >= 15;
                      const slotsPerWeek = a.slots.length;
                      const est15 = a.startDate ? estimateMilestoneDate(a.startDate, 15, slotsPerWeek) : null;
                      const est30 = a.startDate ? estimateMilestoneDate(a.startDate, 30, slotsPerWeek) : null;

                      return (
                        <div key={a.id} style={{ background: 'var(--bg-surface-2)', border: `1px solid ${classNum >= 30 ? '#1E9E3A' : classNum >= 15 ? '#FFC400' : 'var(--border)'}`, borderRadius: 12, padding: '16px 20px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
                            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                              <div style={{ width: 42, height: 42, borderRadius: '50%', background: 'rgba(30,158,58,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, fontWeight: 700, color: '#1E9E3A', flexShrink: 0 }}>
                                {a.studentName.charAt(0).toUpperCase()}
                              </div>
                              <div>
                                <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--text-primary)' }}>{a.studentName}</div>
                                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                                  {a.slots.map(sl => `${sl.day} ${sl.hour}`).join(' · ')}
                                  {a.studentLevel && ` · ${a.studentLevel}`}
                                </div>
                              </div>
                            </div>
                            <div style={{ textAlign: 'right', flexShrink: 0 }}>
                              <div style={{ fontSize: 18, fontWeight: 800, color: classNum >= 30 ? '#1E9E3A' : classNum >= 15 ? '#b45309' : 'var(--text-primary)' }}>
                                Clase {classNum}
                              </div>
                              {classNum >= 30 && <div style={{ fontSize: 11, color: '#1E9E3A', fontWeight: 700 }}>🏆 Milestone</div>}
                              {classNum >= 15 && classNum < 30 && <div style={{ fontSize: 11, color: '#b45309', fontWeight: 700 }}>🎯 Milestone</div>}
                            </div>
                          </div>

                          {/* Progress bar */}
                          <div style={{ position: 'relative', marginBottom: 6 }}>
                            <div style={{ height: 10, borderRadius: 5, background: '#e5e7eb', overflow: 'hidden' }}>
                              <div style={{ width: `${barPct}%`, height: '100%', background: classNum >= 30 ? '#1E9E3A' : classNum >= 15 ? '#FFC400' : '#3b82f6', borderRadius: 5, transition: 'width 0.4s ease' }} />
                            </div>
                            <div style={{ position: 'absolute', left: '50%', top: 0, width: 2, height: 10, background: '#FFC400', transform: 'translateX(-50%)', zIndex: 2, pointerEvents: 'none' }} />
                          </div>
                          <div style={{ position: 'relative', height: 15, fontSize: 10, color: 'var(--text-muted)', marginBottom: 10 }}>
                            <span style={{ position: 'absolute', left: 0 }}>Clase 1</span>
                            <span style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)' }}>15</span>
                            <span style={{ position: 'absolute', right: 0 }}>30</span>
                          </div>

                          {/* Estimated dates */}
                          {a.startDate && (
                            <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--text-muted)' }}>
                              <span>Inicio: <b>{new Date(a.startDate + 'T00:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}</b></span>
                              {classNum < 15 && est15 && <span>Clase 15 est.: <b>{est15}</b></span>}
                              {classNum < 30 && est30 && <span>Clase 30 est.: <b>{est30}</b></span>}
                            </div>
                          )}

                          {/* Action buttons */}
                          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                            <button
                              className="class-action-btn"
                              onClick={() => handleAdjust(a, +1)}
                              disabled={adjustSaving === a.id}
                              style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 7, border: '1px solid rgba(30,158,58,0.4)', background: 'rgba(30,158,58,0.08)', color: '#1E9E3A', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit', opacity: adjustSaving === a.id ? 0.6 : 1 }}>
                              + Sumar clase
                            </button>
                            <button
                              className="class-action-btn"
                              onClick={() => setDeductConfirm(a)}
                              disabled={adjustSaving === a.id}
                              style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 7, border: '1px solid rgba(239,68,68,0.35)', background: 'rgba(239,68,68,0.07)', color: '#dc2626', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit', opacity: adjustSaving === a.id ? 0.6 : 1 }}>
                              − Descontar clase
                            </button>
                            <button
                              className="class-action-btn"
                              onClick={() => setStartDateModal({ assignment: a, date: a.startDate ?? new Date().toISOString().split('T')[0] })}
                              style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-surface-3)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, fontWeight: 500, fontFamily: 'inherit' }}>
                              📅 Fecha inicio
                            </button>
                            {(a.manualClassAdjustment ?? 0) !== 0 && (
                              <span style={{ fontSize: 11, color: (a.manualClassAdjustment ?? 0) > 0 ? '#1E9E3A' : '#dc2626', alignSelf: 'center' }}>
                                Ajuste manual: {(a.manualClassAdjustment ?? 0) > 0 ? '+' : ''}{a.manualClassAdjustment}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Legacy: grid-only ocupado students without a DB assignment */}
                {legacyList.length > 0 && (
                  <div style={{ marginTop: myAssignments.length > 0 ? 20 : 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Sin registro de inicio</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {legacyList.map(s => (
                        <div key={s.student} style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'rgba(107,114,128,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#6b7280', flexShrink: 0 }}>
                            {s.student.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>{s.student}</div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.slots.map(sl => `${sl.day} ${sl.hour}`).join(' · ')}</div>
                          </div>
                          <div style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>Sin fecha de inicio registrada</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {activeTab === 'scoring' && (
          <TeacherScoringTab
            teacher={teacher}
            myAssignments={myAssignments}
            myEvents={myEvents}
          />
        )}

        <div style={{ marginTop: 16, border: '1px dashed var(--border)', borderRadius: 10, padding: '12px 18px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span>📆</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>Google Calendar</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Sincronización disponible en Fase 2</div>
          </div>
          <span style={{ marginLeft: 'auto', fontSize: 11, padding: '3px 10px', borderRadius: 20, background: 'var(--bg-surface-3)', color: 'var(--text-muted)' }}>Próximamente</span>
        </div>
      </div>

      {/* Assign student modal (triggered from calendar ocupado cell) */}
      {pendingOcupado && (
        <AssignStudentModal
          day={pendingOcupado.day}
          hour={pendingOcupado.hour}
          grid={grid}
          myAssignments={myAssignments}
          onConfirm={handleAssignStudent}
          onCancel={handleAssignCancel}
        />
      )}

      {/* Deduct class confirmation modal */}
      {deductConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget) setDeductConfirm(null); }}>
          <div style={{ background: 'var(--bg-surface)', border: '1px solid #35405a', borderRadius: 14, padding: 24, width: '100%', maxWidth: 380 }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 10 }}>Confirmar falta</div>
            <div style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 20, lineHeight: 1.5 }}>
              ¿Confirmás que <b>{deductConfirm.studentName}</b> faltó a la clase?
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setDeductConfirm(null)} style={{ flex: 1, padding: '9px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
                Cancelar
              </button>
              <button onClick={handleDeductConfirmAction} style={{ flex: 2, padding: '9px', borderRadius: 8, border: '1px solid rgba(239,68,68,0.35)', background: 'rgba(239,68,68,0.15)', color: '#dc2626', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
                Sí, descontar clase
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Start date modal */}
      {startDateModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget) setStartDateModal(null); }}>
          <div style={{ background: 'var(--bg-surface)', border: '1px solid #35405a', borderRadius: 14, padding: 24, width: '100%', maxWidth: 380 }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 6 }}>Modificar fecha de inicio</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
              Alumno: <b style={{ color: 'var(--text-primary)' }}>{startDateModal.assignment.studentName}</b>
            </div>
            <input
              type="date"
              value={startDateModal.date}
              onChange={e => setStartDateModal(prev => prev ? { ...prev, date: e.target.value } : null)}
              style={{ width: '100%', marginBottom: 16 }}
            />
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setStartDateModal(null)} style={{ flex: 1, padding: '9px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
                Cancelar
              </button>
              <button onClick={handleStartDateSave} disabled={!startDateModal.date} style={{ flex: 2, padding: '9px', borderRadius: 8, border: 'none', background: startDateModal.date ? '#1E9E3A' : 'var(--bg-surface-3)', color: startDateModal.date ? 'white' : 'var(--text-muted)', cursor: startDateModal.date ? 'pointer' : 'not-allowed', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
                Guardar fecha
              </button>
            </div>
          </div>
        </div>
      )}
      </PullToRefresh>
    </div>
  );
}

export default function TeacherPage() {
  return (
    <AuthGuard allowedRoles={['teacher', 'admin']}>
      <TeacherContent />
    </AuthGuard>
  );
}
