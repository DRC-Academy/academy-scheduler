'use client';
import { useState, useEffect, useMemo } from 'react';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { PullToRefresh } from '@/components/PullToRefresh';
import { LastUpdated } from '@/components/LastUpdated';
import { VisualCalendar, DAYS, cellKey, getSpainParts } from '@/components/VisualCalendar';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import { calcCurrentClassNumber, dbCheckStudentExists } from '@/lib/db';
import { classCategoryBadge } from '@/lib/finance';
import { Grid, Teacher, Assignment, ScoringEvent, Student, AppNotification } from '@/types';

// ─── Specialty constants ──────────────────────────────────────────────────────
const ALL_SPECIALTIES = ['Adultos', 'Niños', 'Exámenes'] as const;

const SPECIALTY_STYLE: Record<string, { color: string; bg: string; border: string }> = {
  Adultos:   { color: '#2563eb', bg: 'rgba(59,130,246,0.1)',    border: 'rgba(59,130,246,0.35)' },
  Niños:     { color: '#ea580c', bg: 'rgba(249,115,22,0.1)',    border: 'rgba(249,115,22,0.35)' },
  Exámenes:  { color: '#7c3aed', bg: 'rgba(139,92,246,0.1)',    border: 'rgba(139,92,246,0.35)' },
};

function SpecialtyChip({ specialty }: { specialty: string }) {
  const s = SPECIALTY_STYLE[specialty] ?? { color: '#6b7280', bg: 'rgba(107,114,128,0.1)', border: 'rgba(107,114,128,0.3)' };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '2px 9px', borderRadius: 12,
      background: s.bg, border: `1px solid ${s.border}`,
      color: s.color, fontSize: 11, fontWeight: 700,
      whiteSpace: 'nowrap',
    }}>
      {specialty}
    </span>
  );
}

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

// ─── Notifications Tab (teacher) ─────────────────────────────────────────────
function TeacherNotificationsTab({ teacher, myAssignments, notifications, loadNotifications, markNotificationRead }: {
  teacher: Teacher;
  myAssignments: Assignment[];
  notifications: AppNotification[];
  loadNotifications: (userId: string, role: string) => Promise<void>;
  markNotificationRead: (notifId: string, userId: string) => Promise<void>;
}) {
  const today = new Date();

  useEffect(() => {
    loadNotifications(teacher.id, 'teacher');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teacher.id]);

  // Auto-mark as read
  useEffect(() => {
    for (const n of notifications) {
      if (!n.readBy.includes(teacher.id)) {
        markNotificationRead(n.id, teacher.id);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notifications.length]);

  // Section A: near clase 15 (≤3 clases para llegar)
  const near15 = myAssignments
    .map(a => ({ a, classNum: calcCurrentClassNumber(a) }))
    .filter(({ classNum }) => classNum < 15 && (15 - classNum) <= 3)
    .map(({ a, classNum }) => ({ name: a.studentName, classNum, faltanClases: 15 - classNum }));

  // Section B: near 6 months (≤15 days or already there)
  const near6m = myAssignments
    .filter(a => a.startDate)
    .map(a => {
      const start     = new Date(a.startDate! + 'T00:00:00');
      const daysActive = Math.floor((today.getTime() - start.getTime()) / 86400000);
      const daysTo6m   = Math.max(0, 180 - daysActive);
      const bonusDate  = new Date(start.getTime() + 180 * 86400000);
      return { a, daysActive, daysTo6m, bonusDate, bonusAvailable: daysActive >= 180 };
    })
    .filter(({ daysTo6m, bonusAvailable }) => bonusAvailable || daysTo6m <= 15);

  const cardStyle = { borderRadius: 12, padding: '16px 20px', marginBottom: 10 };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>

      {/* Section A */}
      <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)', marginBottom: 6, marginTop: 4 }}>🎬 Alumnos cerca de clase 15</div>
      {near15.length === 0 ? (
        <div style={{ ...cardStyle, background: 'var(--bg-surface)', border: '1px solid var(--border)', fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', padding: '20px' }}>
          Ningún alumno está a 3 clases o menos de la clase 15.
        </div>
      ) : near15.map(item => (
        <div key={item.name} style={{ ...cardStyle, background: 'rgba(255,196,0,0.1)', border: '1.5px solid rgba(255,196,0,0.5)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 24 }}>🎬</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: '#92400E' }}>{item.name}</div>
              <div style={{ fontSize: 13, color: '#b45309', marginTop: 2 }}>
                Clase actual: <b>{item.classNum}</b> · Faltan <b>{item.faltanClases}</b> {item.faltanClases === 1 ? 'clase' : 'clases'} para la clase 15
              </div>
            </div>
          </div>
        </div>
      ))}

      {/* Section B */}
      <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)', marginBottom: 6, marginTop: 10 }}>🎁 Alumnos cerca de 6 meses</div>
      {near6m.length === 0 ? (
        <div style={{ ...cardStyle, background: 'var(--bg-surface)', border: '1px solid var(--border)', fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', padding: '20px' }}>
          Ningún alumno está a 15 días o menos de cumplir 6 meses.
        </div>
      ) : near6m.map(item => (
        <div key={item.a.id} style={{ ...cardStyle, background: item.bonusAvailable ? 'rgba(255,196,0,0.12)' : 'rgba(249,115,22,0.07)', border: `1.5px solid ${item.bonusAvailable ? '#D97706' : 'rgba(249,115,22,0.35)'}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 24 }}>🎁</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: '#92400E' }}>{item.a.studentName}</div>
              <div style={{ fontSize: 13, color: '#b45309', marginTop: 2 }}>
                Inicio: {new Date(item.a.startDate! + 'T00:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' })}
                {' · '}
                {item.bonusAvailable
                  ? <span style={{ fontWeight: 700 }}>¡Cumplió 6 meses! Solicitar bono</span>
                  : <>Cumple 6 meses el <b>{item.bonusDate.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' })}</b> · Faltan <b>{item.daysTo6m}</b> días</>
                }
              </div>
              {item.bonusAvailable && (
                <div style={{ marginTop: 6, fontSize: 12, background: 'rgba(255,196,0,0.2)', border: '1px solid #D97706', borderRadius: 7, padding: '5px 10px', color: '#92400E', fontWeight: 600 }}>
                  🎁 Bono disponible — escribir a <span style={{ fontWeight: 700 }}>pagos@drcacademy.com</span>
                </div>
              )}
            </div>
          </div>
        </div>
      ))}

      {/* Section C */}
      <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)', marginBottom: 6, marginTop: 10 }}>📢 Avisos y circulares</div>
      {notifications.length === 0 ? (
        <div style={{ ...cardStyle, background: 'var(--bg-surface)', border: '1px solid var(--border)', fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', padding: '20px' }}>
          No hay avisos por el momento.
        </div>
      ) : notifications.map(n => {
        const isRead = n.readBy.includes(teacher.id);
        return (
          <div key={n.id} style={{ ...cardStyle, background: isRead ? 'var(--bg-surface)' : 'rgba(30,158,58,0.04)', border: `1.5px solid ${isRead ? 'var(--border)' : 'rgba(30,158,58,0.3)'}` }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <span style={{ fontSize: 22, marginTop: 2 }}>📢</span>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>{n.title}</div>
                  {!isRead && <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 10, background: 'rgba(30,158,58,0.15)', border: '1px solid rgba(30,158,58,0.3)', color: '#1E9E3A', fontWeight: 700 }}>NUEVO</span>}
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 6 }}>{n.body}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {new Date(n.createdAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Date / class helpers (Próximas clases) ───────────────────────────────────
const DAY_NAMES_BY_JSDAY = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

function dayNameFromDate(d: Date): string {
  return DAY_NAMES_BY_JSDAY[d.getDay()];
}
function isoDateLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
function normalizeUrl(url: string): string {
  const t = url.trim();
  if (!t) return t;
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

function fmtDateDMY(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

// Builds the inactive-subscription disclaimer copy + styling per WooCommerce status.
function subDisclaimer(name: string, status: string, daysRemaining: number | null, endDate: string | null):
  { title: string; body: string; accent: string; bg: string; soft: boolean } {
  switch (status) {
    case 'pending-cancel':
      if (daysRemaining != null && daysRemaining > 0) {
        return {
          title: '⏳ Suscripción pendiente de cancelar',
          body: `${name} tiene su suscripción en estado 'pendiente de cancelar'. Finaliza definitivamente en ${daysRemaining} día${daysRemaining === 1 ? '' : 's'} (el ${fmtDateDMY(endDate)}).`,
          accent: '#D97706', bg: '#FFFBEB', soft: true,
        };
      }
      return {
        title: '⏳ Suscripción pendiente de cancelar',
        body: `${name} tiene su suscripción pendiente de cancelar.`,
        accent: '#D97706', bg: '#FFFBEB', soft: true,
      };
    case 'on-hold':
      return {
        title: '⚠️ Pago pendiente',
        body: `${name} tiene un pago pendiente de procesar. Su suscripción está en espera.`,
        accent: '#ea580c', bg: 'rgba(249,115,22,0.06)', soft: false,
      };
    case 'cancelled':
      return {
        title: '❌ Suscripción cancelada',
        body: `${name} canceló su suscripción.`,
        accent: '#dc2626', bg: 'rgba(239,68,68,0.05)', soft: false,
      };
    case 'expired':
      return {
        title: '❌ Suscripción expirada',
        body: `${name} tiene su suscripción expirada.`,
        accent: '#dc2626', bg: 'rgba(239,68,68,0.05)', soft: false,
      };
    case 'not_found':
      return {
        title: '❓ Sin suscripción registrada',
        body: 'No se encontró ninguna suscripción asociada a este email en el sistema de pagos.',
        accent: '#6b7280', bg: 'rgba(107,114,128,0.06)', soft: false,
      };
    default:
      return {
        title: '⚠️ Suscripción inactiva',
        body: `${name} no cuenta con una suscripción activa en este momento.`,
        accent: '#D97706', bg: '#FFFBEB', soft: false,
      };
  }
}

// Cached WooCommerce subscription state per student email.
interface SubInfo {
  active: boolean | null;
  status: string;
  daysRemaining: number | null;
  endDate: string | null;
  fetchedAt: number;
}
const SUB_TTL_MS = 5 * 60 * 1000;

async function fetchSubInfo(email: string): Promise<SubInfo> {
  try {
    const res = await fetch(`/api/check-subscription?email=${encodeURIComponent(email)}`);
    const data = await res.json();
    return {
      active:        data.active ?? null,
      status:        data.status ?? 'error',
      daysRemaining: data.daysRemaining ?? null,
      endDate:       data.endDate ?? null,
      fetchedAt:     Date.now(),
    };
  } catch {
    return { active: null, status: 'error', daysRemaining: null, endDate: null, fetchedAt: Date.now() };
  }
}

interface TodayClass {
  key: string;
  assignment: Assignment;
  studentName: string;
  hour: string;       // "HH:00"
  level: string;
  plan: string;
  meetLink?: string;
}

// All classes for a given date, built from recurring assignment slots, sorted by hour.
function classesForDate(myAssignments: Assignment[], date: Date): TodayClass[] {
  const dayName = dayNameFromDate(date);
  const list: TodayClass[] = [];
  for (const a of myAssignments) {
    for (const slot of a.slots) {
      if (slot.day !== dayName) continue;
      list.push({
        key:         `${a.id}_${slot.hour}`,
        assignment:  a,
        studentName: a.studentName,
        hour:        slot.hour,
        level:       a.studentLevel,
        plan:        a.plan || a.objetivo || '',
        meetLink:    a.meetLink,
      });
    }
  }
  return list.sort((x, y) => parseInt(x.hour) - parseInt(y.hour));
}

// ─── Teacher Upcoming Classes Tab ─────────────────────────────────────────────
function TeacherUpcomingTab({ teacher, myAssignments, updateMeetLink, logClassJoin }: {
  teacher: Teacher;
  myAssignments: Assignment[];
  updateMeetLink: (assignmentId: string, link: string) => Promise<void>;
  logClassJoin: (teacherId: string, teacherName: string, studentName: string, scheduledDate: string, scheduledTime: string, subscriptionStatus?: string, enteredWithoutActive?: boolean, subscriptionDaysRemaining?: number | null) => Promise<void>;
}) {
  const [linkModal, setLinkModal] = useState<{ assignment: Assignment; value: string } | null>(null);
  const [savingLink, setSavingLink] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [showNextDays, setShowNextDays] = useState(false);
  const [showPastToday, setShowPastToday] = useState(false);
  const [joined, setJoined] = useState<Set<string>>(new Set());
  const [checkingKey, setCheckingKey] = useState<string | null>(null);
  const [subModal, setSubModal] = useState<{ c: TodayClass; status: string; daysRemaining: number | null; endDate: string | null } | null>(null);
  const [subInfo, setSubInfo] = useState<Record<string, SubInfo>>({});

  // Live "now" — set on mount (avoids SSR hydration mismatch) and refreshed every
  // minute so each class's state (pasada / en curso / próxima) updates on its own.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(id);
  }, []);

  const refDate = now ?? new Date();
  const todayIso = isoDateLocal(refDate);

  // Current time in Spain (Europe/Madrid) — the calendar's reference timezone.
  const spain = now ? getSpainParts(now) : null;
  const currentDecimal = spain ? spain.hour + spain.minute / 60 : -1;

  const todayClasses = classesForDate(myAssignments, refDate);

  type ClassStatus = 'passed' | 'inprogress' | 'next' | 'future';
  function statusOf(c: TodayClass): ClassStatus {
    if (currentDecimal < 0) return 'future';
    const h = parseInt(c.hour);
    if (h <= currentDecimal && h + 1 > currentDecimal) return 'inprogress';
    if (h + 1 <= currentDecimal) return 'passed';
    return 'future';
  }
  // The "next" class is the earliest one that has not started yet.
  const nextKey = todayClasses.find(c => parseInt(c.hour) > currentDecimal)?.key ?? null;

  const pastClasses    = todayClasses.filter(c => statusOf(c) === 'passed');
  const currentClasses = todayClasses.filter(c => statusOf(c) !== 'passed');

  // Unique emails of every student visible in this tab (today + next 2 days).
  const visibleEmails = useMemo(() => {
    const set = new Set<string>();
    for (let off = 0; off <= 2; off++) {
      const d = new Date();
      d.setDate(d.getDate() + off);
      for (const c of classesForDate(myAssignments, d)) {
        const e = c.assignment.studentEmail?.trim().toLowerCase();
        if (e) set.add(e);
      }
    }
    return [...set].sort();
  }, [myAssignments]);
  const emailsKey = visibleEmails.join('|');

  // Fetch all subscription states once when the tab opens (parallel, in-memory).
  useEffect(() => {
    if (visibleEmails.length === 0) return;
    let cancelled = false;
    Promise.all(visibleEmails.map(async e => [e, await fetchSubInfo(e)] as const)).then(results => {
      if (cancelled) return;
      setSubInfo(prev => {
        const next = { ...prev };
        for (const [e, info] of results) next[e] = info;
        return next;
      });
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emailsKey]);

  // Badge config from cached subscription state (undefined entry → still verifying).
  function subBadgeFor(email?: string): { label: string; color: string; bg: string; spin?: boolean } | null {
    const e = email?.trim().toLowerCase();
    if (!e) return null;
    const info = subInfo[e];
    if (!info) return { label: 'Verificando...', color: 'var(--text-muted)', bg: 'var(--bg-surface-3)', spin: true };
    if (info.status === 'manual_override') return { label: '✅ Activa (manual)', color: '#1E9E3A', bg: 'rgba(30,158,58,0.1)' };
    if (info.active === true) return { label: '✅ Suscripción activa', color: '#1E9E3A', bg: 'rgba(30,158,58,0.1)' };
    if (info.active === false && info.status === 'pending-cancel') {
      const d = info.daysRemaining;
      const tail = d != null && d > 0 ? ` (${d} día${d === 1 ? '' : 's'})` : '';
      return { label: `⏳ Pendiente de cancelar${tail}`, color: '#b45309', bg: 'rgba(255,196,0,0.15)' };
    }
    if (info.active === false) return { label: '⚠️ Sin suscripción activa', color: '#ea580c', bg: 'rgba(249,115,22,0.12)' };
    return { label: '❓ No verificado', color: 'var(--text-muted)', bg: 'var(--bg-surface-3)' };
  }

  // Assignments today missing a meet link (deduped by assignment)
  const missingSeen = new Set<string>();
  const missingLinks: TodayClass[] = [];
  for (const c of todayClasses) {
    if (!c.meetLink && !missingSeen.has(c.assignment.id)) {
      missingSeen.add(c.assignment.id);
      missingLinks.push(c);
    }
  }
  const missingNames = missingLinks.map(c => c.studentName.split(' ')[0]);

  const todayLabel = refDate.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });

  // Next two days
  const nextDays = [1, 2].map(offset => {
    const d = new Date(refDate);
    d.setDate(refDate.getDate() + offset);
    return {
      label: d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' }),
      classes: classesForDate(myAssignments, d),
    };
  });

  async function handleSaveLink() {
    if (!linkModal) return;
    setSavingLink(true);
    await updateMeetLink(linkModal.assignment.id, linkModal.value);
    setSavingLink(false);
    setLinkModal(null);
  }

  function showToast(msg: string, ms = 2500) {
    setToast(msg);
    setTimeout(() => setToast(null), ms);
  }

  // Opens the Meet link and records the join with the verified subscription status.
  function doJoin(c: TodayClass, subscriptionStatus: string, enteredWithoutActive: boolean, daysRemaining: number | null = null) {
    if (!c.meetLink) return;
    window.open(normalizeUrl(c.meetLink), '_blank', 'noopener,noreferrer');
    logClassJoin(teacher.id, teacher.name, c.studentName, todayIso, c.hour, subscriptionStatus, enteredWithoutActive, daysRemaining);
    setJoined(prev => new Set([...prev, c.key]));
  }

  // Verifies the student's WooCommerce subscription before joining. Reuses the
  // in-memory result from tab load; only re-fetches if it's older than 5 min.
  async function handleJoin(c: TodayClass) {
    if (!c.meetLink || checkingKey) return;
    const email = c.assignment.studentEmail?.trim().toLowerCase();
    if (!email) {
      doJoin(c, 'not_verified', false);
      showToast('No se pudo verificar la suscripción, ingreso permitido', 3000);
      return;
    }

    let info = subInfo[email];
    if (!info || Date.now() - info.fetchedAt >= SUB_TTL_MS) {
      setCheckingKey(c.key);
      info = await fetchSubInfo(email);
      setSubInfo(prev => ({ ...prev, [email]: info! }));
      setCheckingKey(null);
    }

    if (info.active === true) {
      doJoin(c, 'active', false);
      showToast('✅ Ingreso registrado');
    } else if (info.active === false) {
      setSubModal({ c, status: info.status, daysRemaining: info.daysRemaining, endDate: info.endDate });
    } else {
      doJoin(c, 'error', false);
      showToast('No se pudo verificar la suscripción, ingreso permitido', 3000);
    }
  }

  // Confirmed join from the inactive-subscription disclaimer.
  function handleJoinAnyway() {
    if (!subModal) return;
    doJoin(subModal.c, subModal.status, true, subModal.daysRemaining);
    setSubModal(null);
    showToast('✅ Ingreso registrado');
  }

  function ClassRow({ c, status }: { c: TodayClass; status: ClassStatus }) {
    const passed     = status === 'passed';
    const inProgress = status === 'inprogress';
    const isNext     = status === 'next';
    const highlight  = inProgress || isNext;

    return (
      <div style={{
        background: 'var(--bg-surface-2)',
        border: `1.5px solid ${highlight ? '#1E9E3A' : 'var(--border)'}`,
        boxShadow: highlight ? '0 0 0 3px rgba(30,158,58,0.1)' : 'none',
        borderRadius: 12, padding: '14px 16px',
        opacity: passed ? 0.55 : 1,
        transition: 'opacity 0.3s',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'rgba(30,158,58,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 700, color: '#1E9E3A', flexShrink: 0 }}>
            {c.studentName.charAt(0).toUpperCase()}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>{c.studentName}</span>
              {(() => { const cat = classCategoryBadge(c.plan); return (
                <span style={{ fontSize: 10, padding: '1px 9px', borderRadius: 10, background: cat.bg, color: cat.color, fontWeight: 700 }}>{cat.label}</span>
              ); })()}
              {inProgress && (
                <span className="upcoming-live-badge" style={{ fontSize: 10, padding: '1px 9px', borderRadius: 10, background: 'rgba(220,38,38,0.12)', border: '1px solid rgba(220,38,38,0.4)', color: '#dc2626', fontWeight: 700 }}>
                  🔴 En curso
                </span>
              )}
              {isNext && (
                <span style={{ fontSize: 10, padding: '1px 9px', borderRadius: 10, background: 'rgba(30,158,58,0.15)', border: '1px solid rgba(30,158,58,0.35)', color: '#1E9E3A', fontWeight: 700 }}>
                  Próxima
                </span>
              )}
              {passed && (
                <span style={{ fontSize: 10, padding: '1px 9px', borderRadius: 10, background: 'var(--bg-surface-3)', color: 'var(--text-muted)', fontWeight: 600 }}>
                  ✓ Finalizada
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              {c.plan || 'Clase'}{c.level ? ` · ${c.level}` : ''}
            </div>
            {(() => {
              const sb = subBadgeFor(c.assignment.studentEmail);
              if (!sb) return null;
              return (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 6, fontSize: 10, fontWeight: 700, padding: '2px 9px', borderRadius: 10, background: sb.bg, color: sb.color }}>
                  {sb.spin && <span className="drc-spinner-xs" />}
                  {sb.label}
                </span>
              );
            })()}
          </div>
          <div style={{ fontSize: 18, fontWeight: 800, color: passed ? 'var(--text-muted)' : highlight ? '#1E9E3A' : 'var(--text-primary)', flexShrink: 0 }}>{c.hour}</div>
        </div>

        {/* Link area */}
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
          {c.meetLink ? (
            <>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8, wordBreak: 'break-all' }}>
                🔗 {stripProtocol(c.meetLink)}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {passed ? (
                  <button disabled
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-surface-3)', color: 'var(--text-muted)', cursor: 'not-allowed', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>
                    Clase finalizada
                  </button>
                ) : (
                  <button onClick={() => handleJoin(c)} disabled={checkingKey === c.key}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 8, border: 'none', background: '#1E9E3A', color: 'white', cursor: checkingKey === c.key ? 'wait' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', opacity: checkingKey === c.key ? 0.8 : 1 }}>
                    {checkingKey === c.key
                      ? <><span className="drc-spinner" /> Verificando...</>
                      : <>🎥 Ingresar a clase</>}
                  </button>
                )}
                <button onClick={() => setLinkModal({ assignment: c.assignment, value: c.meetLink ?? '' })}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-surface-3)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>
                  ✏️ Cambiar enlace
                </button>
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 12, color: passed ? 'var(--text-muted)' : '#b45309', marginBottom: passed ? 0 : 8, fontWeight: 600 }}>⚠️ Sin enlace definido</div>
              {!passed && (
                <button onClick={() => setLinkModal({ assignment: c.assignment, value: '' })}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 8, border: '1px solid rgba(30,158,58,0.4)', background: 'rgba(30,158,58,0.08)', color: '#1E9E3A', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
                  🔗 Definir enlace
                </button>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  // Resolves the visual status, promoting the earliest not-started class to "next".
  function rowStatus(c: TodayClass): ClassStatus {
    const s = statusOf(c);
    if (s === 'future' && c.key === nextKey) return 'next';
    return s;
  }

  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '20px' }}>
      <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 4, textTransform: 'capitalize' }}>
        Próximas clases — {todayLabel}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
        Definí el enlace de Meet/Zoom de cada alumno una sola vez. Se reutiliza siempre para esa persona.
      </div>

      {/* Missing links banner */}
      {missingLinks.length > 0 && (
        <div style={{ background: 'rgba(249,115,22,0.08)', border: '1px solid rgba(249,115,22,0.35)', borderRadius: 10, padding: '12px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, fontSize: 13, color: '#b45309', fontWeight: 600 }}>
            ⚠️ Tenés {missingLinks.length} alumno{missingLinks.length !== 1 ? 's' : ''} sin enlace de Meet definido: {missingNames.join(', ')}
          </div>
          <button onClick={() => setLinkModal({ assignment: missingLinks[0].assignment, value: '' })}
            style={{ padding: '7px 14px', borderRadius: 8, border: 'none', background: '#ea580c', color: 'white', cursor: 'pointer', fontSize: 12, fontWeight: 700, fontFamily: 'inherit', flexShrink: 0 }}>
            Definir todos →
          </button>
        </div>
      )}

      {/* Today's classes */}
      {todayClasses.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: 14 }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📅</div>
          No tenés clases hoy.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Past classes — collapsed by default */}
          {pastClasses.length > 0 && (
            <div>
              <button onClick={() => setShowPastToday(s => !s)}
                style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 14px', borderRadius: 9, border: '1px dashed var(--border)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit' }}>
                <span>Ver clases pasadas de hoy ({pastClasses.length})</span>
                <span>{showPastToday ? '▲' : '▼'}</span>
              </button>
              {showPastToday && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
                  {pastClasses.map(c => <ClassRow key={c.key} c={c} status="passed" />)}
                </div>
              )}
            </div>
          )}

          {/* In-progress / next / future — always visible */}
          {currentClasses.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-muted)', fontSize: 13 }}>
              No quedan más clases por hoy.
            </div>
          ) : (
            currentClasses.map(c => <ClassRow key={c.key} c={c} status={rowStatus(c)} />)
          )}
        </div>
      )}

      {/* Next days */}
      <div style={{ marginTop: 18 }}>
        <button onClick={() => setShowNextDays(s => !s)}
          style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--bg-surface-2)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>
          <span>📆 Ver próximos días</span>
          <span>{showNextDays ? '▲' : '▼'}</span>
        </button>
        {showNextDays && (
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {nextDays.map(nd => (
              <div key={nd.label}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'capitalize' }}>{nd.label}</div>
                {nd.classes.length === 0 ? (
                  <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '8px 0' }}>Sin clases.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {nd.classes.map(c => <ClassRow key={c.key} c={c} status="future" />)}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Link modal */}
      {linkModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget) setLinkModal(null); }}>
          <div style={{ background: 'var(--bg-surface)', border: '1px solid #35405a', borderRadius: 14, padding: 24, width: '100%', maxWidth: 420 }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 6 }}>
              {linkModal.assignment.meetLink ? 'Cambiar enlace' : 'Definir enlace'}
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.5 }}>
              Este enlace se usará siempre para <b style={{ color: 'var(--text-primary)' }}>{linkModal.assignment.studentName}</b>, no hace falta volver a definirlo.
            </div>
            <input
              value={linkModal.value}
              onChange={e => setLinkModal(prev => prev ? { ...prev, value: e.target.value } : null)}
              placeholder="https://meet.google.com/abc-xyz"
              autoFocus
              style={{ width: '100%', marginBottom: 16 }}
            />
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setLinkModal(null)} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
                Cancelar
              </button>
              <button onClick={handleSaveLink} disabled={savingLink || !linkModal.value.trim()}
                style={{ flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: savingLink || !linkModal.value.trim() ? 'var(--bg-surface-3)' : '#1E9E3A', color: savingLink || !linkModal.value.trim() ? 'var(--text-muted)' : 'white', cursor: savingLink || !linkModal.value.trim() ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
                {savingLink ? 'Guardando...' : 'Guardar enlace'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Inactive subscription disclaimer */}
      {subModal && (() => {
        const d = subDisclaimer(subModal.c.studentName, subModal.status, subModal.daysRemaining, subModal.endDate);
        return (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 85, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
            onClick={e => { if (e.target === e.currentTarget) setSubModal(null); }}>
            <div style={{ background: d.bg, border: `2px solid ${d.accent}`, borderRadius: 14, padding: 24, width: '100%', maxWidth: 420 }}>
              <div style={{ fontWeight: 700, fontSize: 17, color: d.accent, marginBottom: 12 }}>{d.title}</div>
              <div style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 18, lineHeight: 1.6 }}>
                {d.body}
              </div>
              <div style={{ fontSize: 14, color: 'var(--text-primary)', fontWeight: 600, marginBottom: 20 }}>
                ¿Seguro que deseas ingresar a la clase de todas formas?
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => setSubModal(null)} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
                  Cancelar
                </button>
                {/* "pending-cancel" sigue activo hasta la fecha → CTA con menor énfasis (outline) */}
                <button onClick={handleJoinAnyway} style={{
                  flex: 2, padding: '10px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
                  border: d.soft ? `1.5px solid ${d.accent}` : 'none',
                  background: d.soft ? 'transparent' : d.accent,
                  color: d.soft ? d.accent : 'white',
                }}>
                  Ingresar de todas formas
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Toast */}
      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: '#1E9E3A', color: 'white', padding: '10px 22px', borderRadius: 24, fontSize: 14, fontWeight: 700, zIndex: 90, boxShadow: '0 4px 16px rgba(0,0,0,0.25)' }}>
          {toast}
        </div>
      )}
    </div>
  );
}

// ─── Teacher Content ──────────────────────────────────────────────────────────
function TeacherContent() {
  const { user } = useAuth();
  const { teachers, assignments, scoringEvents, notifications, getTeacherGrid, updateTeacherGrid, addStudent, addAssignment, updateAssignmentStartDate, updateAssignmentSlots, reloadAll, updateTeacherSpecialties, loadNotifications, markNotificationRead, updateMeetLink, logClassJoin } = useTeachers();
  const [activeTab, setActiveTab] = useState<'calendar' | 'upcoming' | 'scoring' | 'notifications'>('calendar');
  const [showSpecialtiesModal, setShowSpecialtiesModal] = useState(false);
  const [specialtiesDraft, setSpecialtiesDraft] = useState<string[]>([]);
  const [savingSpecialties, setSavingSpecialties] = useState(false);
  const [grid, setGrid]           = useState<Grid>({});
  const [gridLoading, setGridLoading]   = useState(true);
  const [saveStatus, setSaveStatus]     = useState<'idle' | 'saving' | 'saved'>('idle');
  const [dismissedInSession, setDismissedInSession] = useState<Set<string>>(new Set());
  const [dismissedBonusInSession, setDismissedBonusInSession] = useState<Set<string>>(new Set());
  const [pendingOcupado, setPendingOcupado] = useState<{ day: string; hour: string; resolve: (name: string) => void } | null>(null);

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
    { id: 'calendar',      label: '📅 Mi calendario' },
    { id: 'upcoming',      label: '🎥 Próximas clases' },
    { id: 'scoring',       label: '⭐ Mi Scoring' },
    { id: 'notifications', label: '🔔 Avisos' },
  ] as const;

  // ── Header mini-stats ──────────────────────────────────────────────────────
  const uniqueStudentCount = new Set([
    ...myAssignments.map(a => a.studentName),
    ...legacyList.map(l => l.student),
  ]).size;

  const nowHeader = new Date();
  const todayClassesHeader = classesForDate(myAssignments, nowHeader);
  const nextClassHeader = todayClassesHeader.find(c => parseInt(c.hour) + 1 > nowHeader.getHours() + nowHeader.getMinutes() / 60);
  const nextClassLabel = nextClassHeader
    ? `Hoy ${nextClassHeader.hour} — ${nextClassHeader.studentName}`
    : 'Sin clases hoy';

  const headerLevel = (teacher.currentLevel as 1 | 2 | 3) ?? 1;
  const headerLevelInfo = LEVEL_INFO[headerLevel];
  const headerLevelStars = '⭐'.repeat(headerLevel);
  const headerLevelShort = headerLevel === 1 ? 'Junior' : headerLevel === 2 ? 'Senior' : 'Elite';

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
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 20, color: 'var(--text-primary)' }}>{teacher.name}</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>{teacher.email}</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
              {(teacher.specialties ?? []).map(sp => <SpecialtyChip key={sp} specialty={sp} />)}
              <button onClick={() => { setSpecialtiesDraft([...(teacher.specialties ?? [])]); setShowSpecialtiesModal(true); }}
                style={{ padding: '2px 10px', borderRadius: 12, border: '1px dashed var(--border)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' }}>
                {(teacher.specialties ?? []).length === 0 ? '+ Mis especialidades' : '✏️ Editar'}
              </button>
            </div>

            {/* Mini-stats row */}
            <div className="teacher-header-ministats" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 10, fontSize: 12, color: 'var(--text-secondary)' }}>
              <span>🎥 Próxima clase: <b style={{ color: 'var(--text-primary)' }}>{nextClassLabel}</b></span>
              <span style={{ color: 'var(--border)' }}>·</span>
              <span>👥 <b style={{ color: 'var(--text-primary)' }}>{uniqueStudentCount}</b> alumno{uniqueStudentCount !== 1 ? 's' : ''} activo{uniqueStudentCount !== 1 ? 's' : ''}</span>
              <span style={{ color: 'var(--border)' }}>·</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                Nivel: <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 9px', borderRadius: 12, background: headerLevelInfo.bg, border: `1px solid ${headerLevelInfo.border}`, color: headerLevelInfo.color, fontWeight: 700 }}>{headerLevelStars} {headerLevelShort}</span>
              </span>
            </div>
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

        {/* Specialties modal */}
        {showSpecialtiesModal && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
            onClick={e => { if (e.target === e.currentTarget) setShowSpecialtiesModal(false); }}>
            <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 16, width: '100%', maxWidth: 400, padding: 28 }}>
              <div style={{ fontWeight: 700, fontSize: 17, color: 'var(--text-primary)', marginBottom: 16 }}>Mis especialidades</div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
                {ALL_SPECIALTIES.map(s => {
                  const active = specialtiesDraft.includes(s);
                  const st = SPECIALTY_STYLE[s];
                  return (
                    <button key={s} onClick={() => setSpecialtiesDraft(prev => active ? prev.filter(x => x !== s) : [...prev, s])}
                      style={{ padding: '8px 18px', borderRadius: 20, border: `2px solid ${active ? st.border : 'var(--border)'}`, background: active ? st.bg : 'transparent', color: active ? st.color : 'var(--text-secondary)', cursor: 'pointer', fontSize: 14, fontWeight: active ? 700 : 500, fontFamily: 'inherit', transition: 'all 0.12s' }}>
                      {s}
                    </button>
                  );
                })}
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => setShowSpecialtiesModal(false)} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 14, fontFamily: 'inherit' }}>Cancelar</button>
                <button
                  onClick={async () => {
                    setSavingSpecialties(true);
                    await updateTeacherSpecialties(teacher.id, specialtiesDraft);
                    setSavingSpecialties(false);
                    setShowSpecialtiesModal(false);
                  }}
                  disabled={savingSpecialties}
                  style={{ flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: savingSpecialties ? '#d1d5db' : '#1E9E3A', color: 'white', cursor: savingSpecialties ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 700, fontFamily: 'inherit' }}>
                  {savingSpecialties ? 'Guardando...' : 'Guardar especialidades'}
                </button>
              </div>
            </div>
          </div>
        )}

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

        {activeTab === 'upcoming' && (
          <TeacherUpcomingTab
            teacher={teacher}
            myAssignments={myAssignments}
            updateMeetLink={updateMeetLink}
            logClassJoin={logClassJoin}
          />
        )}

        {activeTab === 'scoring' && (
          <TeacherScoringTab
            teacher={teacher}
            myAssignments={myAssignments}
            myEvents={myEvents}
          />
        )}

        {activeTab === 'notifications' && (
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '20px' }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 4 }}>Notificaciones</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 18 }}>Alertas automáticas y avisos del equipo DRC.</div>
            <TeacherNotificationsTab
              teacher={teacher}
              myAssignments={myAssignments}
              notifications={notifications}
              loadNotifications={loadNotifications}
              markNotificationRead={markNotificationRead}
            />
          </div>
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
