'use client';
import { useState, useEffect, useMemo, Suspense, type CSSProperties } from 'react';
import { useSearchParams } from 'next/navigation';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { PullToRefresh } from '@/components/PullToRefresh';
import { VisualCalendar, DAYS, cellKey, getSpainParts, CAL_STATE_META, type RecuperacionData } from '@/components/VisualCalendar';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import { calcRegisteredClassNumber, dbCheckStudentExists, dbSetStudentProduct, dbEnsureStudentAndAssignment } from '@/lib/db';
import { classCategoryBadge } from '@/lib/finance';
import { planBadgeStyle } from '@/lib/productUtils';
import { StudentAutofillCard } from '@/components/StudentAutofillCard';
import { useStudentAutofill } from '@/lib/useStudentAutofill';
import { checkSubscription, subBadge, type SubscriptionInfo } from '@/lib/useSubscriptionStatus';
import { isMilestone, getMilestoneSlides, getMilestoneCopy, MILESTONES, MILESTONE_SLIDES, MILESTONE_TITLES } from '@/lib/milestones';
import { RETENTION_BONUS_DAYS, retentionDaysActive, retentionStartDate, retentionBonusDate, hasRetentionBonus } from '@/lib/retention';
import { Grid, Teacher, Assignment, ScoringEvent, Student, AppNotification, ClassRecord } from '@/types';
import FormStatusBadge from '@/components/FormStatusBadge';
import { maybeSendBonusEmail } from '@/lib/milestoneEmails';
import { fetchFormTokensIndex, lookupToken, formStateOf, type FormTokenInfo } from '@/lib/formClient';
import { getPresentationEmailStatus } from '@/lib/presentationEmailUtils';
import { PresentationModal } from '@/components/PresentationModal';
import { ALL_SPECIALTIES } from '@/lib/specialties';
import { SpecialtyChip, ToggleChip } from '@/components/ui';

// Índice de tokens de formulario (por id/nombre de alumno). Se pasa a los tabs.
type FormIndex = { byId: Map<string, FormTokenInfo>; byName: Map<string, FormTokenInfo> };
const EMPTY_FORM_INDEX: FormIndex = { byId: new Map(), byName: new Map() };

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
  newStudentData?: { name: string; email: string; level: string; plan: string; productType?: 'subscription' | 'one_time' | null };
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

  // Autocompletado desde WooCommerce + tabla students (alumno nuevo, por email).
  const autofill = useStudentAutofill(newEmail, tab === 'new');
  const { woo, detection } = autofill;
  const productInfo = woo ? { fullName: woo.productFullName, productType: woo.productType } : null;

  // Precarga de campos al llegar datos nuevos (cuando cambia el email). Nombre y
  // fecha solo se rellenan si están vacíos, para no pisar ediciones manuales.
  useEffect(() => {
    if (tab !== 'new') return;
    if (autofill.name)  setNewName(prev => (prev.trim() ? prev : autofill.name!));
    if (autofill.level) setNewLevel(autofill.level!);
    if (autofill.startDate) setStartDate(prev => (prev && prev !== today ? prev : autofill.startDate!));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autofill.name, autofill.level, autofill.startDate, tab]);

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
                        {a.studentLevel} · {(a.slots ?? []).length} h/sem · {(a.slots ?? []).map(s => `${s.day} ${s.hour}`).join(', ')}
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
              {productInfo?.fullName && (
                <div style={{ fontSize: 11.5, color: '#1E9E3A', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span>📦 Se usará: <b>{productInfo.fullName}</b></span>
                  {autofill.classification && (
                    <span style={{ fontSize: 10.5, fontWeight: 700, padding: '1px 7px', borderRadius: 9, background: planBadgeStyle(autofill.classification.type).bg, color: planBadgeStyle(autofill.classification.type).color }}>
                      {autofill.classification.badge}
                    </span>
                  )}
                </div>
              )}
              {(autofill.loading || autofill.existing || productInfo?.fullName) && (
                <StudentAutofillCard data={autofill} currentLevel={newLevel} />
              )}
              {detection && productInfo?.fullName && (
                <div style={{ fontSize: 11.5, lineHeight: 1.45, color: detection.confidence === 'high' ? '#1E9E3A' : '#ea580c' }}>
                  {detection.confidence === 'high' && detection.hours != null
                    ? `🕐 El producto sugiere ${detection.hours}h/sem — seleccioná ${detection.hours} horario${detection.hours === 1 ? '' : 's'}`
                    : detection.message}
                </div>
              )}
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                {slotEditor}
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Fecha de inicio *
                </label>
                <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ width: '100%' }} />
                {newEmail.includes('@') && !autofill.loading && (
                  autofill.startDate
                    ? <div style={{ fontSize: 11, color: '#1E9E3A', marginTop: 4 }}>📅 Detectada desde WooCommerce — inicio de suscripción</div>
                    : <div style={{ fontSize: 11, color: '#ea580c', marginTop: 4 }}>⚠️ Fecha no detectada — completá manualmente</div>
                )}
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
                      onConfirm({ isNew: true, studentName: newName.trim(), slots, startDate, weeklyHours: slots.length, newStudentData: { name: newName.trim(), email: newEmail, level: newLevel, plan: productInfo?.fullName || newPlan, productType: (productInfo?.productType as 'subscription' | 'one_time' | null) ?? null } });
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
                            onClick={() => { setDuplicateStudent(null); onConfirm({ isNew: true, studentName: newName.trim(), slots, startDate, weeklyHours: slots.length, newStudentData: { name: newName.trim(), email: newEmail, level: newLevel, plan: productInfo?.fullName || newPlan, productType: (productInfo?.productType as 'subscription' | 'one_time' | null) ?? null } }); }}
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
  email_presentacion_tardio: '📧 Email de presentación tardío',
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
  // Retención churn-aware: valor persistido (activos vs. bajas de la ventana),
  // con respaldo por antigüedad si aún no se recalculó para este profesor.
  const thirtyDaysAgo  = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const retainedByAge  = myAssignments.filter(a => new Date(a.createdAt) < thirtyDaysAgo).length;
  const retentionPct   = teacher.retentionRate ?? (activeStudents > 0 ? (retainedByAge / activeStudents) * 100 : 0);

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
    const daysActive = retentionDaysActive(a, today);
    const pct        = Math.min(100, (daysActive / RETENTION_BONUS_DAYS) * 100);
    const hasBonus   = hasRetentionBonus(myEvents, a.studentName);
    return { a, daysActive, pct, hasBonus, start: retentionStartDate(a) };
  }).sort((a, b) => b.daysActive - a.daysActive);

  const availableBonuses = studentProgress.filter(s => s.daysActive >= RETENTION_BONUS_DAYS && !s.hasBonus);
  const nextBonus        = studentProgress.filter(s => s.daysActive < RETENTION_BONUS_DAYS).sort((a, b) => b.daysActive - a.daysActive)[0];

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

// Normaliza un nombre para comparaciones tolerantes (sin acentos, minúsculas).
function stripAccentsLower(s: string): string {
  return (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

// Extrae el nombre del alumno del cuerpo de la notificación de nuevo alumno
// ("Se te asignó {nombre}. ...").
function studentNameFromNotifBody(body: string): string {
  const m = body.match(/se te asign[oó]\s+(.+?)\./i);
  return m ? m[1].trim() : '';
}

// Resuelve la assignment referida por una notificación de nuevo alumno con un
// match tolerante (acentos/mayúsculas/espacios), como el resto del sistema.
function resolveAssignmentForNotif(body: string, myAssignments: Assignment[]): Assignment | undefined {
  const parsed = stripAccentsLower(studentNameFromNotifBody(body));
  const bodyNorm = stripAccentsLower(body);
  return myAssignments.find(a => {
    const an = stripAccentsLower(a.studentName);
    if (!an) return false;
    if (parsed && (an === parsed || parsed.includes(an) || an.includes(parsed))) return true;
    return bodyNorm.includes(an);
  });
}

// ─── Notifications Tab (teacher) ─────────────────────────────────────────────
function TeacherNotificationsTab({ teacher, myAssignments, students, classRecords, notifications, loadNotifications, markNotificationRead, updateMeetLink, formIndex, refreshFormIndex }: {
  teacher: Teacher;
  myAssignments: Assignment[];
  students: Student[];
  classRecords: ClassRecord[];
  notifications: AppNotification[];
  loadNotifications: (userId: string, role: string) => Promise<void>;
  markNotificationRead: (notifId: string, userId: string) => Promise<void>;
  formIndex: FormIndex;
  refreshFormIndex: () => void;
  updateMeetLink: (assignmentId: string, link: string) => Promise<void>;
}) {
  const today = new Date();
  const [presentationModal, setPresentationModal] = useState<Assignment | null>(null);
  const { isSent, markSent } = usePresentationSent(teacher.id);

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
    .map(a => ({ a, classNum: calcRegisteredClassNumber(a, classRecords) }))
    .filter(({ classNum }) => classNum < 15 && (15 - classNum) <= 3)
    .map(({ a, classNum }) => ({ name: a.studentName, classNum, faltanClases: 15 - classNum }));

  // Section B: near 6 months (≤15 days or already there).
  // Fuente única (lib/retention.ts): ya NO se descartan las asignaciones sin
  // startDate (antes `.filter(a => a.startDate)` las dejaba fuera del bono).
  const near6m = myAssignments
    .map(a => {
      const daysActive = retentionDaysActive(a, today);
      const daysTo6m   = Math.max(0, RETENTION_BONUS_DAYS - daysActive);
      return { a, daysActive, daysTo6m, bonusDate: retentionBonusDate(a), bonusAvailable: daysActive >= RETENTION_BONUS_DAYS };
    })
    .filter(({ daysTo6m, bonusAvailable }) => bonusAvailable || daysTo6m <= 15);

  // Aviso por email de los bonos ya disponibles. maybeSendBonusEmail no reenvía:
  // se anota en assignments.milestone_emails_sent con la etiqueta 'bonus6m'.
  const bonusReady = near6m.filter(d => d.bonusAvailable);
  useEffect(() => {
    if (bonusReady.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const d of bonusReady) {
        if (cancelled) return;
        await maybeSendBonusEmail({
          assignmentId: d.a.id,
          teacherId: teacher.id,
          studentName: d.a.studentName,
        });
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teacher.id, bonusReady.length]);

  const cardStyle = { borderRadius: 12, padding: '13px 16px', marginBottom: 8 };

  // ── Lista unificada ─────────────────────────────────────────────────────────
  // Antes esto eran tres secciones fijas con subtítulo, que se pintaban aunque
  // estuvieran vacías ("Ningún alumno está a…"). Ahora es una sola lista plana
  // ordenada por urgencia, y lo que no tiene contenido simplemente no aparece.
  //
  // Prioridad (menor = más arriba):
  //   0 bono disponible  · dinero sobre la mesa, accionable ya
  //   1 aviso sin leer   · info nueva; incluye alumno nuevo (email a 24 h)
  //   2 cerca de clase 15
  //   3 cerca de 6 meses
  //   4 aviso ya leído   · archivo
  // Desempate dentro de cada grupo: menos clases/días restantes, o más reciente.
  const avisos = [
    ...near15.map(d => ({
      kind: 'near15' as const, key: `n15_${d.name}`, priority: 2, sort: d.faltanClases, data: d,
    })),
    ...near6m.map(d => ({
      kind: 'near6m' as const, key: `n6m_${d.a.id}`,
      priority: d.bonusAvailable ? 0 : 3,
      sort: d.bonusAvailable ? -d.daysActive : d.daysTo6m,
      data: d,
    })),
    ...notifications.map(n => ({
      kind: 'notif' as const, key: n.id,
      priority: n.readBy.includes(teacher.id) ? 4 : 1,
      sort: -new Date(n.createdAt).getTime(),
      data: n,
    })),
  ].sort((x, y) => x.priority - y.priority || x.sort - y.sort);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>

      {avisos.length === 0 && (
        <div style={{ ...cardStyle, background: 'var(--bg-surface)', border: '1px solid var(--border)', textAlign: 'center', padding: '40px 20px' }}>
          <div style={{ fontSize: 30, marginBottom: 8 }}>🔔</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)' }}>No hay avisos por el momento</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>Te avisaremos cuando haya novedades</div>
        </div>
      )}

      {avisos.map(av => {
        if (av.kind === 'near15') {
          const item = av.data;
          return (
            <div key={av.key} style={{ ...cardStyle, background: 'rgba(255,196,0,0.1)', border: '1.5px solid rgba(255,196,0,0.5)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 22 }}>🎬</span>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, color: '#92400E' }}>{item.name}</div>
                  <div style={{ fontSize: 13, color: '#b45309', marginTop: 2 }}>
                    Clase actual: <b>{item.classNum}</b> · Faltan <b>{item.faltanClases}</b> {item.faltanClases === 1 ? 'clase' : 'clases'} para la clase 15
                  </div>
                </div>
              </div>
            </div>
          );
        }

        if (av.kind === 'near6m') {
          const item = av.data;
          return (
            <div key={av.key} style={{ ...cardStyle, background: item.bonusAvailable ? 'rgba(255,196,0,0.12)' : 'rgba(249,115,22,0.07)', border: `1.5px solid ${item.bonusAvailable ? '#D97706' : 'rgba(249,115,22,0.35)'}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 22 }}>🎁</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: '#92400E' }}>{item.a.studentName}</div>
                  <div style={{ fontSize: 13, color: '#b45309', marginTop: 2 }}>
                    {/* startDate puede faltar: retention.ts ya no descarta esas asignaciones. */}
                    {item.a.startDate && (
                      <>Inicio: {new Date(item.a.startDate + 'T00:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' })}{' · '}</>
                    )}
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
          );
        }

        const n = av.data;
        const isRead = n.readBy.includes(teacher.id);
        // Solo en la notificación de nuevo alumno mostramos "Enviar presentación".
        // La assignment se resuelve con match tolerante (acentos/mayúsculas).
        const asgn = n.type === 'new_assignment'
          ? resolveAssignmentForNotif(n.body, myAssignments)
          : undefined;
        const sent = asgn ? isSent(asgn.studentName) : false;
        return (
          <div key={av.key} style={{ ...cardStyle, background: isRead ? 'var(--bg-surface)' : 'rgba(30,158,58,0.04)', border: `1.5px solid ${isRead ? 'var(--border)' : 'rgba(30,158,58,0.3)'}` }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <span style={{ fontSize: 20, marginTop: 2 }}>{n.type === 'new_assignment' ? '📚' : '📢'}</span>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>{n.title}</div>
                  {!isRead && <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 10, background: 'rgba(30,158,58,0.15)', border: '1px solid rgba(30,158,58,0.3)', color: '#1E9E3A', fontWeight: 700 }}>NUEVO</span>}
                  {asgn && sent && <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 10, background: 'rgba(30,158,58,0.12)', border: '1px solid rgba(30,158,58,0.3)', color: '#1E9E3A', fontWeight: 700 }}>📧 Presentación enviada</span>}
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 6 }}>{n.body}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {new Date(n.createdAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </div>
                {asgn && (
                  <button onClick={() => setPresentationModal(asgn)} style={presentationBtnStyle(sent)}>
                    {sent ? '📧 Reenviar presentación' : '📧 Enviar presentación al alumno'}
                  </button>
                )}
                {asgn && <PresentationEmailBadge assignment={asgn} />}
                {asgn && (
                  <div style={{ marginTop: 8 }}>
                    <FormStatusBadge
                      student={{ id: asgn.studentId, name: asgn.studentName, email: asgn.studentEmail }}
                      teacher={{ id: teacher.id, name: teacher.name }}
                      assignment={{ id: asgn.id, plan: asgn.plan, level: asgn.studentLevel }}
                      info={lookupToken(formIndex, { id: asgn.studentId, name: asgn.studentName })}
                      onRefresh={refreshFormIndex}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {presentationModal && (
        <PresentationModal
          assignment={presentationModal}
          teacher={teacher}
          students={students}
          updateMeetLink={updateMeetLink}
          onClose={() => setPresentationModal(null)}
          onSent={markSent}
          onFormTokenReady={refreshFormIndex}
        />
      )}
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

// El estado de suscripción se verifica con la fuente única de verdad
// (lib/useSubscriptionStatus.ts): mismo endpoint, misma interpretación y mismo
// cache compartido que el panel "Alumnos". Ver checkSubscription / subBadge.
const SUB_TTL_MS = 5 * 60 * 1000;

interface TodayClass {
  key: string;
  assignment: Assignment;
  studentName: string;
  hour: string;       // "HH:00"
  level: string;
  plan: string;
  meetLink?: string;
  isRecovery?: boolean;   // clase puntual de recuperación (celda 'bloqueado' del grid)
  recoveryFor?: string;   // 'YYYY-MM-DD' de la clase original que se recupera
}

// All classes for a given date, built from recurring assignment slots, sorted by hour.
function classesForDate(myAssignments: Assignment[], date: Date): TodayClass[] {
  const dayName = dayNameFromDate(date);
  const list: TodayClass[] = [];
  for (const a of myAssignments) {
    for (const slot of a.slots ?? []) {
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

// Lunes (ISO) de la semana que contiene la fecha dada.
function mondayIsoOf(d: Date): string {
  const dow = d.getDay();                    // 0=Dom … 6=Sáb
  const diff = dow === 0 ? -6 : 1 - dow;     // retroceder hasta el lunes
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  return isoDateLocal(monday);
}

// Match tolerante de una celda de recuperación a una assignment por nombre.
function findAssignmentForName(myAssignments: Assignment[], name: string): Assignment | undefined {
  const nk = (x: string) => x.trim().toLowerCase();
  const full = nk(name);
  const first = nk(name.split(' ')[0]);
  return myAssignments.find(a => nk(a.studentName) === full)
      ?? myAssignments.find(a => { const c = nk(a.studentName); return c === first || c.startsWith(first) || full.startsWith(c); });
}

// FUENTE 2 de "Próximas clases": celdas de recuperación del grid ('bloqueado' con
// alumno + weekDate) cuya fecha real (lunes de weekDate + día de la celda) cae en
// la fecha pedida. Se vinculan a la assignment del alumno para heredar enlace de
// Meet, plan, nivel, email (necesarios para Ingresar a clase y suscripción). Las
// que no matchean ninguna assignment se omiten (siguen visibles en el calendario).
function recoveriesForDate(grid: Grid, date: Date, myAssignments: Assignment[]): TodayClass[] {
  const targetIso = isoDateLocal(date);
  const list: TodayClass[] = [];
  for (const [key, cell] of Object.entries(grid)) {
    if (cell.state !== 'bloqueado' || !cell.student || !cell.weekDate) continue;
    const usc = key.lastIndexOf('_');
    if (usc < 0) continue;
    const day = key.slice(0, usc);
    const hour = key.slice(usc + 1);
    const dayIdx = DAYS.indexOf(day);
    if (dayIdx < 0) continue;
    // Fecha real de la celda = lunes(weekDate) + índice de día.
    const monday = new Date(cell.weekDate + 'T00:00:00');
    if (isNaN(monday.getTime())) continue;
    const cellDate = new Date(monday);
    cellDate.setDate(monday.getDate() + dayIdx);
    if (isoDateLocal(cellDate) !== targetIso) continue;

    const a = findAssignmentForName(myAssignments, cell.student);
    if (!a) continue;
    list.push({
      key:         `rec_${key}_${targetIso}`,
      assignment:  a,
      studentName: cell.student,
      hour,
      level:       a.studentLevel,
      plan:        a.plan || a.objetivo || '',
      meetLink:    a.meetLink,
      isRecovery:  true,
      recoveryFor: cell.recoveryFor,
    });
  }
  return list;
}

// ─── Email de presentación (nuevo alumno) ─────────────────────────────────────
// El modal y el armado del cuerpo del email viven en components/PresentationModal
// (fuente única, reutilizada por el popup recordatorio del NavBar).

// Marca en localStorage qué presentaciones ya se enviaron (por alumno) para el
// badge "Presentación enviada" y el estado del botón (Enviar / Reenviar).
function usePresentationSent(teacherId: string) {
  const [sent, setSent] = useState<Set<string>>(new Set());
  // localStorage no está disponible en SSR: se lee tras montar (sync desde un
  // sistema externo, patrón usado en el resto del archivo).
  useEffect(() => {
    try {
      const prefix = `presentation_sent_${teacherId}_`;
      const found = new Set<string>();
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix) && localStorage.getItem(k) === '1') found.add(k.slice(prefix.length));
      }
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSent(found);
    } catch {}
  }, [teacherId]);
  const markSent = (studentName: string) => {
    try { localStorage.setItem(`presentation_sent_${teacherId}_${studentName}`, '1'); } catch {}
    setSent(prev => new Set(prev).add(studentName));
  };
  return { isSent: (name: string) => sent.has(name), markSent };
}

// Estilo del botón "Enviar/Reenviar presentación" (verde si nuevo, gris si ya se envió).
function presentationBtnStyle(sent: boolean): CSSProperties {
  const base: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 8,
    padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontFamily: 'inherit',
  };
  return sent
    ? { ...base, border: '1px solid var(--border)', background: 'var(--bg-surface-3)', color: 'var(--text-muted)', fontWeight: 600 }
    : { ...base, border: 'none', background: '#1E9E3A', color: 'white', fontWeight: 700 };
}

// Convierte un color hex (#RRGGBB) en rgba con la opacidad dada.
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g2 = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g2}, ${b}, ${alpha})`;
}

// Badge dinámico del seguimiento del email de presentación. Se actualiza solo
// cada minuto (reloj propio) y toma TODO el estado visual de la fuente única
// lib/presentationEmailUtils.getPresentationEmailStatus.
function PresentationEmailBadge({ assignment }: { assignment: Assignment }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);

  // Antes del montaje usamos createdAt como referencia estable (evita el desajuste
  // de hidratación de usar Date.now() en el render del servidor).
  const st = getPresentationEmailStatus(assignment, now ?? new Date(assignment.createdAt).getTime());
  const animClass = st.pulse ? 'pres-email-badge-pulse' : st.blink ? 'pres-email-badge-blink' : '';
  const textColor = st.badgeColor === '#FFC400' ? '#8a6d00' : st.badgeColor;

  return (
    <div style={{ marginTop: 8 }}>
      <span
        className={animClass}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '5px 11px', borderRadius: 999, fontSize: 12, fontWeight: 700,
          color: textColor,
          background: hexToRgba(st.badgeColor, 0.12),
          border: `1.5px solid ${hexToRgba(st.badgeColor, 0.42)}`,
        }}
      >
        {st.badgeText}
      </span>
      {st.subtextMessage && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.45, maxWidth: 340 }}>
          {st.subtextMessage}
        </div>
      )}
    </div>
  );
}

// El modal "Email de presentación" se importa desde components/PresentationModal.

// ─── Materiales de clase (diapositivas por hito) ──────────────────────────────
// Desplegable discreto dentro de "Próximas clases". Cerrado por defecto; su
// estado se recuerda en localStorage. Pensado para tener los materiales a mano
// sin ocupar espacio ni distraer del flujo de clases.
function ClassMaterialsSection() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);

  useEffect(() => {
    try { if (localStorage.getItem('materials_section_open') === '1') setOpen(true); }
    catch {}
  }, []);

  function toggle() {
    setOpen(prev => {
      const next = !prev;
      try { localStorage.setItem('materials_section_open', next ? '1' : '0'); } catch {}
      return next;
    });
  }

  async function copyLink(m: number) {
    const url = MILESTONE_SLIDES[m];
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch {}
      document.body.removeChild(ta);
    }
    setCopied(m);
    setTimeout(() => setCopied(c => (c === m ? null : c)), 2000);
  }

  return (
    <div className="cm">
      <button className="cm-head" onClick={toggle} aria-expanded={open} aria-controls="cm-panel">
        <span style={{ flex: 1, minWidth: 0 }}>
          <span className="cm-title" style={{ display: 'block' }}>Materiales de clase</span>
          <span className="cm-sub">Presentaciones organizadas por hito de la trayectoria del alumno</span>
        </span>
        <span className="cm-chip">{MILESTONES.length} hitos</span>
        <span aria-hidden className={`cm-caret${open ? ' is-open' : ''}`}>▼</span>
      </button>

      {/* Contenido colapsable */}
      <div id="cm-panel" className="cm-panel" style={{ maxHeight: open ? 1600 : 0 }}>
        <ol className="cm-list">
          {MILESTONES.map((m, i) => {
            const info = MILESTONE_TITLES[m];
            const c = MILESTONE_COLORS[i % MILESTONE_COLORS.length];
            const vars = {
              '--cm-base': c.base, '--cm-soft': c.soft,
              '--cm-border': c.border, '--cm-text': c.text,
            } as CSSProperties;
            return (
              <li key={m} className="cm-item" style={vars}>
                <div className="cm-badge">
                  <span className="cm-badge-label">CLASE</span>
                  <span className="cm-badge-num">{m}</span>
                </div>
                <div className="cm-body">
                  <span className="cm-tag">{info.title}</span>
                  <span className="cm-desc">{info.description}</span>
                  <div className="cm-actions">
                    <button className="cm-btn cm-btn-primary"
                      onClick={() => window.open(MILESTONE_SLIDES[m], '_blank', 'noopener,noreferrer')}>
                      Abrir presentación
                    </button>
                    <button className={`cm-btn cm-btn-ghost${copied === m ? ' is-copied' : ''}`}
                      onClick={() => copyLink(m)}>
                      {copied === m ? 'Copiado' : 'Copiar enlace'}
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

// Un tono por hito, misma saturación/luminosidad. Se indexa por POSICIÓN en
// MILESTONES (hito 1..4), no por número de clase.
const MILESTONE_COLORS = [
  { base: '#16a34a', soft: '#eef6ef', border: '#dcecde', text: '#2f7a42' },
  { base: '#0f766e', soft: '#eaf4f2', border: '#d3e8e4', text: '#0f766e' },
  { base: '#2563eb', soft: '#eef2fb', border: '#d6e0f6', text: '#3b5b9e' },
  { base: '#7c3aed', soft: '#f2edfb', border: '#e2d6f6', text: '#6d34c9' },
] as const;

// ─── Modal "Reprogramar clase" (punto 2) ──────────────────────────────────────
const RESCHEDULE_REASONS = [
  { id: 'alumno_antic', label: 'El alumno avisó con anticipación' },
  { id: 'alumno_hora',  label: 'El alumno avisó sobre la hora' },
  { id: 'profesor',     label: 'Yo (el profesor) necesito cambiarla' },
] as const;
type RescheduleReason = typeof RESCHEDULE_REASONS[number]['id'];

function RescheduleModal({ studentName, currentDate, currentHour, saving, onConfirm, onClose }: {
  studentName: string; currentDate: string; currentHour: string; saving: boolean;
  onConfirm: (data: { reason: RescheduleReason; reasonLabel: string; newDate: string; newTime: string }) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<RescheduleReason>('alumno_antic');
  const [newDate, setNewDate] = useState('');
  const [newTime, setNewTime] = useState(currentHour || '');
  const canConfirm = !!newDate && !!newTime && !saving;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 85, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 24, width: '100%', maxWidth: 420 }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 4 }}>📅 Reprogramar clase</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 16 }}>{studentName} — {fmtDateDMY(currentDate)} {currentHour}</div>

        <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', display: 'block', marginBottom: 8 }}>¿Qué pasó con esta clase?</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 16 }}>
          {RESCHEDULE_REASONS.map(r => (
            <button key={r.id} onClick={() => setReason(r.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 12px', borderRadius: 9, textAlign: 'left', fontFamily: 'inherit', cursor: 'pointer',
                border: `1.5px solid ${reason === r.id ? '#1E9E3A' : 'var(--border)'}`,
                background: reason === r.id ? 'rgba(30,158,58,0.08)' : 'var(--bg-surface-2)',
                color: 'var(--text-primary)', fontSize: 13 }}>
              <span>{reason === r.id ? '🔘' : '⚪'}</span>{r.label}
            </button>
          ))}
        </div>
        {reason === 'alumno_hora' && (
          <div style={{ fontSize: 11.5, color: '#b45309', background: 'rgba(255,196,0,0.12)', border: '1px solid rgba(255,196,0,0.4)', borderRadius: 8, padding: '8px 12px', marginBottom: 14, lineHeight: 1.5 }}>
            ⏰ Se registrará como cancelación sobre la hora (cobrable, hasta 2 por alumno).
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 18 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Nueva fecha</label>
            <input type="date" value={newDate} onChange={e => setNewDate(e.target.value)} style={{ width: '100%' }} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Nueva hora 🇪🇸</label>
            <input type="time" value={newTime} onChange={e => setNewTime(e.target.value)} style={{ width: '100%' }} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose} disabled={saving} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: saving ? 'not-allowed' : 'pointer', fontSize: 13, fontFamily: 'inherit' }}>Cancelar</button>
          <button onClick={() => canConfirm && onConfirm({ reason, reasonLabel: RESCHEDULE_REASONS.find(r => r.id === reason)!.label, newDate, newTime })} disabled={!canConfirm}
            style={{ flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: canConfirm ? '#1E9E3A' : 'var(--bg-surface-3)', color: canConfirm ? 'white' : 'var(--text-muted)', cursor: canConfirm ? 'pointer' : 'not-allowed', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
            {saving ? 'Guardando...' : 'Reprogramar ✓'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Teacher Upcoming Classes Tab ─────────────────────────────────────────────
function TeacherUpcomingTab({ teacher, myAssignments, students, classRecords, grid, onGridChange, updateMeetLink, logClassJoin, addRescheduleRecord, formIndex, refreshFormIndex }: {
  teacher: Teacher;
  myAssignments: Assignment[];
  students: Student[];
  classRecords: ClassRecord[];
  grid: Grid;
  onGridChange: (g: Grid) => Promise<void>;
  updateMeetLink: (assignmentId: string, link: string) => Promise<void>;
  logClassJoin: (teacherId: string, teacherName: string, studentName: string, scheduledDate: string, scheduledTime: string, subscriptionStatus?: string, enteredWithoutActive?: boolean, subscriptionDaysRemaining?: number | null) => Promise<void>;
  addRescheduleRecord: (p: { teacherId: string; teacherName: string; studentName: string; originalDate: string; originalTime?: string; newDate: string; newTime?: string; classType: 'reprogramada' | 'cancelacion_hora'; comment: string }) => Promise<void>;
  formIndex: FormIndex;
  refreshFormIndex: () => void;
}) {
  const [rescheduleModal, setRescheduleModal] = useState<{ c: TodayClass; date: string } | null>(null);
  const [savingReschedule, setSavingReschedule] = useState(false);
  const [linkModal, setLinkModal] = useState<{ assignment: Assignment; value: string } | null>(null);
  const [presentationModal, setPresentationModal] = useState<Assignment | null>(null);
  const { isSent, markSent } = usePresentationSent(teacher.id);
  const [savingLink, setSavingLink] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // Navegador de fechas: desplazamiento en días respecto de hoy (0 = hoy).
  const [dayOffset, setDayOffset] = useState(0);
  // Fila cuyo menú "⋯" está abierto (una sola a la vez).
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [showPastToday, setShowPastToday] = useState(false);
  const [joined, setJoined] = useState<Set<string>>(new Set());
  const [checkingKey, setCheckingKey] = useState<string | null>(null);
  const [subModal, setSubModal] = useState<{ c: TodayClass; status: string; daysRemaining: number | null; endDate: string | null } | null>(null);
  const [subInfo, setSubInfo] = useState<Record<string, SubscriptionInfo>>({});
  // Disclaimer de hito: se muestra ANTES del flujo de suscripción cuando la clase
  // a la que se va a ingresar es la 1, 15, 30 o 50.
  const [milestoneModal, setMilestoneModal] = useState<{ c: TodayClass; classNumber: number } | null>(null);

  // Lookup de alumnos por email/nombre para clasificar el plan con TODOS los campos
  // (plan + objetivo de la assignment + plan/producto del alumno).
  const studentByEmail = useMemo(() => {
    const m = new Map<string, Student>();
    for (const s of students) {
      if (s.email) m.set(s.email.trim().toLowerCase(), s);
      m.set(`name:${s.name.trim().toLowerCase()}`, s);
    }
    return m;
  }, [students]);
  const studentForAssignment = (a: Assignment): Student | undefined =>
    (a.studentEmail && studentByEmail.get(a.studentEmail.trim().toLowerCase())) ||
    studentByEmail.get(`name:${a.studentName.trim().toLowerCase()}`);

  // Email a usar para verificar la suscripción. CRÍTICO para la consistencia con
  // el panel "Alumnos": se prefiere SIEMPRE el email de la tabla students (el que
  // está en WooCommerce); el de la assignment es solo el fallback. Si difieren,
  // students.email manda — es lo que garantiza el mismo resultado en ambos lados.
  const subEmailForAssignment = (a: Assignment): string => {
    const student = studentForAssignment(a);
    return (student?.email?.trim().toLowerCase()) || (a.studentEmail?.trim().toLowerCase()) || '';
  };

  // Live "now" — set on mount (avoids SSR hydration mismatch) and refreshed every
  // minute so each class's state (pasada / en curso / próxima) updates on its own.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(id);
  }, []);

  // Cierra el menú "⋯" al hacer clic fuera o pulsar Escape.
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-mc-menu]')) setOpenMenu(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenMenu(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [openMenu]);

  const refDate = now ?? new Date();
  const todayIso = isoDateLocal(refDate);

  // Fecha visible = hoy + dayOffset. `refDate` sigue siendo "ahora" y es lo único
  // que decide el estado horario de las filas (solo aplica cuando se mira hoy).
  const viewDate = new Date(refDate);
  viewDate.setDate(viewDate.getDate() + dayOffset);
  const viewIso  = isoDateLocal(viewDate);
  const isToday  = dayOffset === 0;

  // Current time in Spain (Europe/Madrid) — the calendar's reference timezone.
  const spain = now ? getSpainParts(now) : null;
  const currentDecimal = spain ? spain.hour + spain.minute / 60 : -1;

  // Lista del día = FUENTE 1 (slots recurrentes) + FUENTE 2 (recuperaciones del
  // grid que caen en este día), unidas y ordenadas por hora.
  const todayClasses = useMemo(
    () => [...classesForDate(myAssignments, viewDate), ...recoveriesForDate(grid, viewDate, myAssignments)]
      .sort((x, y) => parseInt(x.hour) - parseInt(y.hour)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [myAssignments, grid, viewIso],
  );

  type ClassStatus = 'passed' | 'inprogress' | 'next' | 'future';
  function statusOf(c: TodayClass): ClassStatus {
    // En días distintos de hoy no hay "en curso" ni "pasada": todo es futuro.
    if (!isToday || currentDecimal < 0) return 'future';
    const h = parseInt(c.hour);
    if (h <= currentDecimal && h + 1 > currentDecimal) return 'inprogress';
    if (h + 1 <= currentDecimal) return 'passed';
    return 'future';
  }
  // The "next" class is the earliest one that has not started yet.
  const nextKey = isToday
    ? todayClasses.find(c => parseInt(c.hour) > currentDecimal)?.key ?? null
    : null;

  const pastClasses    = todayClasses.filter(c => statusOf(c) === 'passed');
  const currentClasses = todayClasses.filter(c => statusOf(c) !== 'passed');

  // Unique emails of every student visible in this tab (today + next 2 days, y
  // además el día que se esté mirando con el navegador de fechas — si no, al
  // navegar lejos el badge de suscripción se quedaría cargando para siempre).
  const visibleEmails = useMemo(() => {
    const set = new Set<string>();
    for (const off of new Set([0, 1, 2, dayOffset])) {
      const d = new Date();
      d.setDate(d.getDate() + off);
      for (const c of [...classesForDate(myAssignments, d), ...recoveriesForDate(grid, d, myAssignments)]) {
        const e = subEmailForAssignment(c.assignment);
        if (e) set.add(e);
      }
    }
    return [...set].sort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myAssignments, students, grid, dayOffset]);
  const emailsKey = visibleEmails.join('|');

  // Fetch all subscription states once when the tab opens (parallel, in-memory).
  useEffect(() => {
    if (visibleEmails.length === 0) return;
    let cancelled = false;
    Promise.all(visibleEmails.map(async e => [e, await checkSubscription(e)] as const)).then(results => {
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

  // Badge del estado de suscripción. Delega en la fuente única (subBadge) para
  // garantizar el MISMO texto/color que el panel "Alumnos". `undefined` → spinner.
  function subBadgeFor(email?: string): { label: string; color: string; bg: string; spin?: boolean } | null {
    const e = email?.trim().toLowerCase();
    if (!e) return null;
    return subBadge(subInfo[e]);
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

  // Etiqueta del navegador: "Martes, 21 jul" (con "Hoy"/"Mañana" cuando aplica).
  const dateLabel = viewDate.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'short' })
    .replace(/\.$/, '')
    .replace(/^(\w)/, m => m.toUpperCase());
  const relLabel = dayOffset === 0 ? 'Hoy' : dayOffset === 1 ? 'Mañana' : dayOffset === -1 ? 'Ayer' : null;

  // Reprogramación (punto 2): ¿esta clase (alumno + fecha) fue reprogramada?
  function rescheduledFor(studentName: string, date: string): string | null {
    const nk = (x: string) => x.trim().toLowerCase();
    const rec = classRecords.find(r =>
      r.teacherId === teacher.id && !!r.rescheduledTo &&
      nk(r.studentName) === nk(studentName) && r.classDate === date,
    );
    return rec?.rescheduledTo ?? null;
  }

  async function handleRescheduleConfirm(data: { reason: RescheduleReason; reasonLabel: string; newDate: string; newTime: string }) {
    if (!rescheduleModal) return;
    const { c, date } = rescheduleModal;
    setSavingReschedule(true);
    try {
      const classType = data.reason === 'alumno_hora' ? 'cancelacion_hora' : 'reprogramada';
      const comment = `Reprogramada para ${data.newDate}${data.newTime ? ` ${data.newTime}` : ''} — Motivo: ${data.reasonLabel}`;
      await addRescheduleRecord({
        teacherId: teacher.id, teacherName: teacher.name, studentName: c.studentName,
        originalDate: date, originalTime: c.hour,
        newDate: data.newDate, newTime: data.newTime || undefined,
        classType, comment,
      });

      // Reflejar el movimiento en el grid (best-effort, no bloquea la constancia):
      //  · celda ORIGINAL → 'reprogramada' (tachada, gris) esa semana.
      //  · celda de la NUEVA fecha/hora → 'bloqueado' (recuperación) → aparece en
      //    Próximas clases el día correcto y cuenta al darse (finanzas).
      try {
        const origDate = new Date(date + 'T00:00:00');
        const newDate  = new Date(data.newDate + 'T00:00:00');
        const newHour  = `${(data.newTime || c.hour).slice(0, 2)}:00`;
        if (!isNaN(origDate.getTime()) && !isNaN(newDate.getTime())) {
          const origKey = cellKey(dayNameFromDate(origDate), c.hour);
          const newKey  = cellKey(dayNameFromDate(newDate), newHour);
          const next: Grid = { ...grid };
          const prevOrig = grid[origKey];
          next[origKey] = {
            state: 'reprogramada', student: c.studentName,
            weekDate: mondayIsoOf(origDate),
            baseState: prevOrig && prevOrig.state !== 'reprogramada' && prevOrig.state !== 'bloqueado' ? prevOrig.state : 'ocupado',
            rescheduledTo: data.newDate,
          };
          const prevNew = grid[newKey];
          // No pisar una clase recurrente real en la nueva celda.
          if (!prevNew || prevNew.state !== 'ocupado') {
            next[newKey] = {
              state: 'bloqueado', student: c.studentName,
              weekDate: mondayIsoOf(newDate),
              baseState: prevNew && prevNew.state !== 'bloqueado' && prevNew.state !== 'reprogramada' ? prevNew.state : 'libre',
              recoveryFor: date,
            };
          }
          await onGridChange(next);
        }
      } catch { /* el grid es secundario; la constancia ya quedó registrada */ }

      setRescheduleModal(null);
      showToast(`📅 Clase reprogramada para ${fmtDateDMY(data.newDate)}`);
    } finally {
      setSavingReschedule(false);
    }
  }

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

  // Punto de entrada del botón "Ingresar a clase". Si la clase a la que se va a
  // ingresar es un hito (1/15/30/50), muestra primero el disclaimer de hito; al
  // confirmar continúa con el flujo normal (verificación de suscripción + Meet).
  function handleJoin(c: TodayClass) {
    if (!c.meetLink || checkingKey) return;
    const nextClass = calcRegisteredClassNumber(c.assignment, classRecords) + 1;
    if (isMilestone(nextClass)) {
      setMilestoneModal({ c, classNumber: nextClass });
      return;
    }
    proceedJoin(c);
  }

  // Verifies the student's WooCommerce subscription before joining. Reuses the
  // in-memory result from tab load; only re-fetches if it's older than 5 min.
  async function proceedJoin(c: TodayClass) {
    if (!c.meetLink || checkingKey) return;
    const email = subEmailForAssignment(c.assignment);
    // Log temporal de diagnóstico: confirma qué email se usa vs. las dos fuentes.
    console.log('Verificando suscripción:', {
      studentName: c.assignment.studentName,
      emailUsado: email,
      sourceEmail: c.assignment.studentEmail,
      studentEmail: studentForAssignment(c.assignment)?.email,
    });
    if (!email) {
      doJoin(c, 'not_verified', false);
      showToast('No se pudo verificar la suscripción, ingreso permitido', 3000);
      return;
    }

    let info = subInfo[email];
    if (!info || Date.now() - info.fetchedAt >= SUB_TTL_MS) {
      setCheckingKey(c.key);
      info = await checkSubscription(email);
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

  function ClassRow({ c, status, date }: { c: TodayClass; status: ClassStatus; date: string }) {
    const passed     = status === 'passed';
    const inProgress = status === 'inprogress';
    const isNext     = status === 'next';
    // Una clase RECURRENTE se considera reprogramada si hay constancia; una fila de
    // recuperación (destino del movimiento) nunca se pinta como reprogramada.
    const rescheduledTo = c.isRecovery ? null : rescheduledFor(c.studentName, date);
    const rescheduled   = !!rescheduledTo;

    const hasLink = !!c.meetLink;
    const menuId  = `${c.key}_${date}`;
    const menuOpen = openMenu === menuId;
    const sent    = isSent(c.studentName);

    // Tag de tipo de clase: la etiqueta la sigue decidiendo classCategoryBadge
    // (fuente única); acá solo se le aplica la paleta sobria de esta vista.
    const stu = studentForAssignment(c.assignment);
    const cat = classCategoryBadge({
      assignmentPlan: c.assignment.plan,
      assignmentObjetivo: c.assignment.objetivo,
      studentPlan: stu?.plan,
      productName: stu?.productName,
    });
    const tagPalette = /ex[aá]men/i.test(cat.label)
      ? { background: '#eef1f8', color: '#3b5b9e' }
      : { background: '#eef4ef', color: '#2f6b3f' };

    const sb = subBadgeFor(subEmailForAssignment(c.assignment));
    const formInfo = lookupToken(formIndex, { id: c.assignment.studentId, name: c.studentName });
    const hasForm  = formStateOf(formInfo) !== 'none';
    const presentationSent = !!c.assignment.presentationEmailSent;
    // Botón "Enviar presentación": solo para clases normales sin presentación enviada.
    const showPresentationBtn = !passed && !rescheduled && !c.isRecovery && !presentationSent;
    const showPresentationSent = !passed && !rescheduled && !c.isRecovery && presentationSent;

    const nextClassNum = calcRegisteredClassNumber(c.assignment, classRecords) + 1;
    const slides = !passed && isMilestone(nextClassNum) ? getMilestoneSlides(nextClassNum) : null;

    const desde = (() => {
      if (!c.assignment.startDate) return null;
      const sd = new Date(c.assignment.startDate + 'T00:00:00');
      if (isNaN(sd.getTime())) return null;
      const dias = Math.max(0, Math.floor((Date.now() - sd.getTime()) / 86_400_000));
      return `Desde ${sd.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })} · ${dias} día${dias !== 1 ? 's' : ''}`;
    })();

    return (
      <div className={`mc-card${passed ? ' is-passed' : ''}`} style={rescheduled ? { opacity: 0.5 } : undefined}>
        <div className="mc-row">
          <div className="mc-left">
            <div className="mc-hour">{c.hour}</div>
            <div className={`mc-accent${inProgress ? ' is-live' : isNext ? ' is-next' : ''}`} />
            <div className="mc-avatar">{c.studentName.charAt(0).toUpperCase()}</div>
          </div>

          <div className="mc-main">
            <div className="mc-nameline">
              <span className={`mc-name${rescheduled ? ' is-struck' : ''}`}>{c.studentName}</span>
              {c.isRecovery && <span className="mc-badge-recovery">Recuperación</span>}
              {rescheduled && <span className="mc-badge-resched">Reprogramada → {fmtDateDMY(rescheduledTo)}</span>}
              <span className="mc-tag" style={tagPalette}>{cat.label}</span>
              {inProgress && !rescheduled && (
                <span className="mc-live">
                  <span className="mc-dot" style={{ background: '#16a34a' }} />En curso
                </span>
              )}
            </div>
            <div className="mc-course">{c.plan || 'Clase'}{c.level ? ` · ${c.level}` : ''}</div>
            {c.isRecovery && c.recoveryFor && <div className="mc-meta">Recupera clase del {fmtDateDMY(c.recoveryFor)}</div>}
            {desde && !c.isRecovery && <div className="mc-meta">{desde}</div>}
          </div>

          {/* Estado del enlace primero: es la información clave para el profesor. */}
          <div className="mc-right">
            {rescheduled ? (
              <span className="mc-status is-muted">
                <span className="mc-dot" style={{ background: '#a4a7a1' }} />
                Reprogramada
              </span>
            ) : (
              <span className={`mc-status ${passed ? 'is-muted' : hasLink ? 'is-ready' : 'is-missing'}`}>
                <span className="mc-dot" style={{ background: passed ? '#a4a7a1' : hasLink ? '#16a34a' : '#e0912f' }} />
                {passed ? 'Clase finalizada' : hasLink ? 'Enlace listo' : 'Sin enlace'}
              </span>
            )}

            <div className="mc-actions">
              {rescheduled ? (
                <button className="mc-btn mc-btn-ghost" disabled>Reprogramada</button>
              ) : passed ? (
                <button className="mc-btn mc-btn-ghost" disabled>Finalizada</button>
              ) : hasLink ? (
                <button className="mc-btn mc-btn-primary" onClick={() => handleJoin(c)} disabled={checkingKey === c.key}>
                  {checkingKey === c.key
                    ? <><span className="drc-spinner" />Verificando…</>
                    : 'Ingresar a clase'}
                </button>
              ) : (
                <button className="mc-btn mc-btn-primary" onClick={() => setLinkModal({ assignment: c.assignment, value: '' })}>
                  Definir enlace
                </button>
              )}

              <div className="mc-menu-wrap" data-mc-menu>
                <button className="mc-more" aria-haspopup="menu" aria-expanded={menuOpen} aria-label={`Más acciones para ${c.studentName}`}
                  onClick={() => setOpenMenu(menuOpen ? null : menuId)}>
                  ⋯
                </button>
                {menuOpen && (
                  <div className="mc-menu" role="menu">
                    <button className="mc-menu-item" role="menuitem"
                      onClick={() => { setOpenMenu(null); setRescheduleModal({ c, date }); }}>
                      Reprogramar clase
                    </button>
                    <button className="mc-menu-item" role="menuitem"
                      onClick={() => { setOpenMenu(null); setLinkModal({ assignment: c.assignment, value: c.meetLink ?? '' }); }}>
                      {hasLink ? 'Cambiar enlace' : 'Definir enlace'}
                    </button>
                    <button className="mc-menu-item" role="menuitem"
                      onClick={() => { setOpenMenu(null); setPresentationModal(c.assignment); }}>
                      {sent ? 'Reenviar presentación' : 'Enviar presentación'}
                    </button>
                    {slides && (
                      <button className="mc-menu-item" role="menuitem"
                        onClick={() => { setOpenMenu(null); window.open(slides, '_blank', 'noopener,noreferrer'); }}>
                        Diapositivas · clase {nextClassNum}
                      </button>
                    )}
                    {hasLink && (
                      <>
                        <div className="mc-menu-sep" />
                        <div className="mc-menu-extra mc-meta" style={{ wordBreak: 'break-all' }}>
                          {stripProtocol(c.meetLink!)}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Acción secundaria: enviar la presentación si aún no se envió. */}
            {showPresentationBtn && (
              <button className="mc-pres-btn" onClick={() => setPresentationModal(c.assignment)}>
                ✉️ Enviar presentación
              </button>
            )}
            {showPresentationSent && (
              <span className="mc-pres-sent">Presentación enviada ✓</span>
            )}
          </div>
        </div>

        {/* Zona secundaria: avisos que no compiten con la acción principal. */}
        {(sb || hasForm || (showPresentationBtn)) && (
          <div className="mc-foot">
            {sb && (
              <span className="mc-status" style={{ background: sb.bg, color: sb.color }}>
                {sb.spin && <span className="drc-spinner-xs" />}
                {sb.label}
              </span>
            )}
            <FormStatusBadge
              student={{ id: c.assignment.studentId, name: c.studentName, email: c.assignment.studentEmail }}
              teacher={{ id: teacher.id, name: teacher.name }}
              assignment={{ id: c.assignment.id, plan: c.assignment.plan, level: c.assignment.studentLevel }}
              info={formInfo}
              onRefresh={refreshFormIndex}
              compact
            />
            {showPresentationBtn && <PresentationEmailBadge assignment={c.assignment} />}
          </div>
        )}
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
    <div className="mc">
      <div className="mc-head">
        <div>
          <div className="mc-title">Mis clases</div>
          <div className="mc-count">
            {todayClasses.length === 0
              ? 'Sin clases'
              : `${todayClasses.length} ${todayClasses.length === 1 ? 'clase' : 'clases'}`}
            {relLabel ? ` · ${relLabel}` : ''}
          </div>
        </div>

        {/* Navegador de fechas */}
        <div className="mc-nav">
          <button className="mc-nav-btn" aria-label="Día anterior" onClick={() => setDayOffset(o => o - 1)}>‹</button>
          <span className="mc-nav-label">{dateLabel}</span>
          <button className="mc-nav-btn" aria-label="Día siguiente" onClick={() => setDayOffset(o => o + 1)}>›</button>
          {!isToday && (
            <button className="mc-today-btn" onClick={() => setDayOffset(0)}>Hoy</button>
          )}
        </div>
      </div>

      {/* Materiales de clase (diapositivas por hito) — desplegable discreto */}
      <ClassMaterialsSection />

      {/* Aviso de alumnos sin enlace definido */}
      {missingLinks.length > 0 && (
        <div className="mc-banner">
          <div style={{ flex: 1 }}>
            {missingLinks.length} alumno{missingLinks.length !== 1 ? 's' : ''} sin enlace definido: {missingNames.join(', ')}
          </div>
          <button className="mc-btn mc-btn-ghost" onClick={() => setLinkModal({ assignment: missingLinks[0].assignment, value: '' })}>
            Definir enlaces
          </button>
        </div>
      )}

      {/* Clases del día seleccionado */}
      {todayClasses.length === 0 ? (
        <div className="mc-empty">
          {isToday ? 'No tenés clases hoy.' : 'No tenés clases este día.'}
        </div>
      ) : (
        <div className="mc-list">
          {/* Clases ya pasadas de hoy — plegadas por defecto */}
          {pastClasses.length > 0 && (
            <div>
              <button className="mc-collapse" onClick={() => setShowPastToday(s => !s)}>
                <span>Clases pasadas de hoy ({pastClasses.length})</span>
                <span>{showPastToday ? '↑' : '↓'}</span>
              </button>
              {showPastToday && (
                <div className="mc-list" style={{ marginTop: 10 }}>
                  {pastClasses.map(c => <ClassRow key={c.key} c={c} status="passed" date={viewIso} />)}
                </div>
              )}
            </div>
          )}

          {currentClasses.length === 0 ? (
            <div className="mc-empty">No quedan más clases por hoy.</div>
          ) : (
            currentClasses.map(c => <ClassRow key={c.key} c={c} status={rowStatus(c)} date={viewIso} />)
          )}
        </div>
      )}

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

      {/* Milestone disclaimer (clase hito 1/15/30/50) */}
      {milestoneModal && (() => {
        const { c, classNumber } = milestoneModal;
        const slides = getMilestoneSlides(classNumber);
        const copy = getMilestoneCopy(classNumber, c.studentName) ?? '';
        return (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 85, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
            onClick={e => { if (e.target === e.currentTarget) setMilestoneModal(null); }}>
            <div style={{ background: '#F7F7F5', border: '2px solid #FFC400', borderRadius: 16, padding: 26, width: '100%', maxWidth: 440 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
                <span style={{ fontSize: 24, fontWeight: 800, color: '#1E9E3A' }}>🎯 Clase {classNumber}</span>
              </div>
              <div style={{ fontSize: 14, color: '#374151', fontWeight: 600, marginBottom: 14 }}>
                con {c.studentName}
              </div>
              <div style={{ fontSize: 14, color: '#374151', lineHeight: 1.6, marginBottom: 18 }}>
                {copy}
              </div>
              {slides && (
                <a href={slides} target="_blank" rel="noopener noreferrer"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '9px 16px', borderRadius: 8, border: '1.5px solid #1E9E3A', background: 'white', color: '#1E9E3A', cursor: 'pointer', fontSize: 13, fontWeight: 700, textDecoration: 'none', marginBottom: 20 }}>
                  📊 Ver diapositivas de clase {classNumber}
                </a>
              )}
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => setMilestoneModal(null)} style={{ flex: 1, padding: '11px', borderRadius: 8, border: '1px solid var(--border)', background: 'white', color: '#6b7280', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
                  Cancelar
                </button>
                <button onClick={() => { setMilestoneModal(null); proceedJoin(c); }}
                  style={{ flex: 2, padding: '11px', borderRadius: 8, border: 'none', background: '#1E9E3A', color: 'white', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
                  ✅ Entendido — Ingresar a clase
                </button>
              </div>
            </div>
          </div>
        );
      })()}

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

      {/* Presentation email modal */}
      {presentationModal && (
        <PresentationModal
          assignment={presentationModal}
          teacher={teacher}
          students={students}
          updateMeetLink={updateMeetLink}
          onClose={() => setPresentationModal(null)}
          onSent={markSent}
          onFormTokenReady={refreshFormIndex}
        />
      )}

      {/* Reschedule modal (punto 2) */}
      {rescheduleModal && (
        <RescheduleModal
          studentName={rescheduleModal.c.studentName}
          currentDate={rescheduleModal.date}
          currentHour={rescheduleModal.c.hour}
          saving={savingReschedule}
          onConfirm={handleRescheduleConfirm}
          onClose={() => setRescheduleModal(null)}
        />
      )}

      {/* Toast */}
      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: '#1E9E3A', color: 'white', padding: '10px 22px', borderRadius: 24, fontSize: 14, fontWeight: 700, zIndex: 90, boxShadow: '0 4px 16px rgba(0,0,0,0.25)' }}>
          {toast}
        </div>
      )}
    </div>
  );
}

// ─── Mini modal "En recuperación" (punto 3) ───────────────────────────────────
// Al marcar una celda como "En recuperación", pide qué alumno recupera, la fecha
// de la clase original que se perdió y una nota opcional.
function RecuperacionModal({ day, hour, studentNames, onConfirm, onCancel }: {
  day: string; hour: string;
  studentNames: string[];
  onConfirm: (data: RecuperacionData) => void;
  onCancel: () => void;
}) {
  const [student, setStudent] = useState(studentNames[0] ?? '');
  const [customName, setCustomName] = useState('');
  const [recoveryFor, setRecoveryFor] = useState('');
  const [note, setNote] = useState('');

  const finalName = (studentNames.length === 0 ? customName : student).trim();
  const canConfirm = !!finalName && !!recoveryFor;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 85, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div style={{ background: 'var(--bg-surface)', border: '2px solid #FFC400', borderRadius: 14, padding: 24, width: '100%', maxWidth: 400 }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 4 }}>🩹 ¿Qué alumno recupera esta clase?</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>{day} · {hour} 🇪🇸</div>

        <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Alumno</label>
        {studentNames.length === 0 ? (
          <input value={customName} onChange={e => setCustomName(e.target.value)} placeholder="Nombre del alumno..." autoFocus style={{ width: '100%', marginBottom: 14 }} />
        ) : (
          <select value={student} onChange={e => setStudent(e.target.value)} style={{ width: '100%', marginBottom: 14 }}>
            {studentNames.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        )}

        <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Fecha de la clase original que se recupera</label>
        <input type="date" value={recoveryFor} onChange={e => setRecoveryFor(e.target.value)} style={{ width: '100%', marginBottom: 14 }} />

        <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Nota (opcional)</label>
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="Ej: la faltó por viaje" style={{ width: '100%', marginBottom: 18 }} />

        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onCancel} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>Cancelar</button>
          <button onClick={() => canConfirm && onConfirm({ student: finalName, recoveryFor, note: note.trim() || undefined })} disabled={!canConfirm}
            style={{ flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: canConfirm ? '#1E9E3A' : 'var(--bg-surface-3)', color: canConfirm ? 'white' : 'var(--text-muted)', cursor: canConfirm ? 'pointer' : 'not-allowed', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
            Marcar recuperación
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Teacher Content ──────────────────────────────────────────────────────────
const TEACHER_TABS = ['calendar', 'upcoming', 'scoring', 'notifications'] as const;
type TeacherTab = typeof TEACHER_TABS[number];

function TeacherContent() {
  const { user } = useAuth();
  const { teachers, students, assignments, scoringEvents, notifications, classRecords, getTeacherGrid, updateTeacherGrid, addStudent, addAssignment, updateAssignmentStartDate, updateAssignmentSlots, reloadAll, updateTeacherSpecialties, loadNotifications, markNotificationRead, updateMeetLink, logClassJoin, addRecoveryClass, addRescheduleRecord } = useTeachers();
  const [activeTab, setActiveTab] = useState<TeacherTab>('calendar');

  // El campanario del header navega a /teacher?tab=notifications. Sincronizamos
  // la pestaña con la URL (sistema externo) para aterrizar en Avisos; la pestaña
  // sigue siendo estado local para que cambiarla no cueste un round-trip de red.
  const searchParams = useSearchParams();
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    const t = searchParams.get('tab');
    if (t && (TEACHER_TABS as readonly string[]).includes(t)) setActiveTab(t as TeacherTab);
  }, [searchParams]);
  const [showSpecialtiesModal, setShowSpecialtiesModal] = useState(false);
  const [specialtiesDraft, setSpecialtiesDraft] = useState<string[]>([]);
  const [savingSpecialties, setSavingSpecialties] = useState(false);
  const [grid, setGrid]           = useState<Grid>({});
  const [gridLoading, setGridLoading]   = useState(true);
  const [saveStatus, setSaveStatus]     = useState<'idle' | 'saving' | 'saved'>('idle');
  const [dismissedInSession, setDismissedInSession] = useState<Set<string>>(new Set());
  const [dismissedBonusInSession, setDismissedBonusInSession] = useState<Set<string>>(new Set());
  const [pendingOcupado, setPendingOcupado] = useState<{ day: string; hour: string; resolve: (name: string) => void } | null>(null);
  const [pendingRecuperacion, setPendingRecuperacion] = useState<{ day: string; hour: string; resolve: (data: RecuperacionData) => void } | null>(null);
  const [formIndex, setFormIndex] = useState<FormIndex>(EMPTY_FORM_INDEX);

  const refreshFormIndex = () => { fetchFormTokensIndex().then(setFormIndex).catch(() => {}); };
  useEffect(() => { refreshFormIndex(); }, []);

  const teacher = teachers.find(t => t.id === user?.teacherId) ?? teachers[0];

  // El popup recordatorio de emails de presentación se monta en el NavBar
  // (components/PresentationEmailReminder), así aparece en toda la app del profesor.

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

  function handleRecuperacionNeed(day: string, hour: string, resolve: (data: RecuperacionData) => void, cancel: () => void) {
    setPendingRecuperacion({ day, hour, resolve });
  }

  // Confirma la recuperación: pinta la celda (via resolve) y registra la clase de
  // recuperación (class_records, class_date = HOY) vinculada al alumno y a la
  // fecha original. Cuenta para el pago con la tarifa normal del alumno.
  async function handleRecuperacionConfirm(data: RecuperacionData) {
    if (!teacher || !pendingRecuperacion) return;
    pendingRecuperacion.resolve(data); // aplica la celda 'bloqueado' con student + recoveryFor
    setPendingRecuperacion(null);
    try {
      await addRecoveryClass({
        teacherId: teacher.id, teacherName: teacher.name, studentName: data.student,
        recoveryDate: isoDateLocal(new Date()), originalDate: data.recoveryFor,
        note: data.note, classTime: pendingRecuperacion.hour,
      });
    } catch { /* la constancia de finanzas no debe romper el marcado del grid */ }
  }

  async function handleAssignStudent(data: AssignConfirmData) {
    if (!teacher || !pendingOcupado) return;
    let finalName = data.studentName;

    // Todo el guardado en base va dentro de un try: si algo falla, NO pintamos
    // la celda del grid, para que calendario ↔ students ↔ assignments queden
    // siempre coordinados (nunca un alumno en el calendario sin su asignación).
    try {
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
        // Persistir tipo de producto detectado (best-effort).
        if (data.newStudentData.productType !== undefined) {
          dbSetStudentProduct(newStudent.id, data.newStudentData.productType ?? null, data.newStudentData.plan).catch(() => {});
        }

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

      // PREVENCIÓN / red de seguridad idempotente: garantiza que el alumno y su
      // assignment existan y estén bien vinculados. Ahora participa del try, así
      // que si el guardado real falla, se corta ANTES de pintar la celda.
      const ensureEmail = data.isNew ? data.newStudentData?.email
        : data.useExistingStudent?.email ?? data.existingAssignment?.studentEmail;
      const ensureLevel = data.isNew ? data.newStudentData?.level
        : data.useExistingStudent?.level ?? data.existingAssignment?.studentLevel;
      await dbEnsureStudentAndAssignment({
        teacherId: teacher.id, teacherName: teacher.name, teacherEmail: teacher.email,
        studentName: finalName, studentEmail: ensureEmail, studentLevel: ensureLevel,
        plan: data.isNew ? data.newStudentData?.plan : undefined,
        slots: data.slots, startDate: data.startDate,
      });
    } catch (e) {
      console.error('[handleAssignStudent] no se pudo guardar la asignación:', e);
      alert(
        'No se pudo guardar la asignación en la base de datos, así que la celda NO se marcó ' +
        '(para mantener el calendario y las asignaciones coordinados). Volvé a intentarlo.\n\n' +
        'Detalle técnico: ' + (e instanceof Error ? e.message : String(e))
      );
      setPendingOcupado(null);
      return;
    }

    // Update grid — SOLO si el guardado en base fue exitoso.
    const updatedGrid = { ...grid };
    if (data.existingAssignment) {
      for (const old of data.existingAssignment.slots ?? []) {
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
    const classNum = calcRegisteredClassNumber(a, classRecords);
    for (const milestone of [15, 30] as const) {
      if (classNum >= milestone && !hasSeenBanner(teacher.id, a.studentName, milestone) && !dismissedInSession.has(`${a.studentName}_${milestone}`)) {
        visibleBanners.push({ studentName: a.studentName, milestone, startDate: a.startDate, slotsPerWeek: (a.slots ?? []).length });
        break;
      }
    }
  }

  // check6MonthBonusBanners: fuente única (lib/retention.ts). Ya NO descarta las
  // asignaciones sin start_date, y mide días de continuidad como el resto.
  type BonusBannerEntry = { studentName: string; assignmentId: string };
  const visibleBonusBanners: BonusBannerEntry[] = [];
  const today6m = new Date();
  for (const a of myAssignments) {
    if (
      retentionDaysActive(a, today6m) >= RETENTION_BONUS_DAYS &&
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
    { id: 'calendar',      label: 'Mi calendario' },
    { id: 'upcoming',      label: 'Mis clases' },
    { id: 'scoring',       label: 'Mi Scoring' },
    { id: 'notifications', label: 'Avisos' },
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
    ? `Hoy ${nextClassHeader.hour} · ${nextClassHeader.studentName}`
    : 'Sin clases hoy';

  const headerLevel = (teacher.currentLevel as 1 | 2 | 3) ?? 1;
  const headerLevelShort = headerLevel === 1 ? 'Junior' : headerLevel === 2 ? 'Senior' : 'Elite';

  return (
    <div style={{ minHeight: '100vh', background: '#f4f5f2' }}>
      <NavBar />
      <PullToRefresh onRefresh={reloadAll}>
      <div className="thd" style={{ maxWidth: 1180, margin: '0 auto', padding: '20px 16px 48px' }}>

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
        <div className="thd-card">
          <div className="thd-idrow">
            <div className="thd-avatar">{teacher.avatar}</div>

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span className="thd-name">{teacher.name}</span>
                <span className="thd-tags">
                  {(teacher.specialties ?? []).map(sp => <SpecialtyChip key={sp} specialty={sp} />)}
                  <span className="thd-tag" style={{ background: '#fdf3e7', color: '#9a6516' }}>
                    Nivel {headerLevelShort}
                  </span>
                </span>
              </div>
              <div className="thd-meta">
                {teacher.email} · {uniqueStudentCount} alumno{uniqueStudentCount !== 1 ? 's' : ''} activo{uniqueStudentCount !== 1 ? 's' : ''}
              </div>
            </div>

            {/* Solo edita especialidades: se nombra por lo que hace, no "Editar perfil". */}
            <button className="thd-edit"
              onClick={() => { setSpecialtiesDraft([...(teacher.specialties ?? [])]); setShowSpecialtiesModal(true); }}>
              {(teacher.specialties ?? []).length === 0 ? 'Añadir especialidades' : 'Editar especialidades'}
            </button>
          </div>

          <div className="thd-row">
            <div className="thd-next">
              <span className="thd-next-caret" aria-hidden>▸</span>
              <div style={{ minWidth: 0 }}>
                <div className="thd-next-label">Próxima clase</div>
                <div className="thd-next-value">{nextClassLabel}</div>
              </div>
            </div>

            {/* Los números no llevan color propio: el punto ya identifica el estado,
                y el color sale de la misma fuente que pinta la grilla. */}
            <div className="thd-kpis">
              {([
                { state: 'libre'     as const, count: freeCount },
                { state: 'ocupado'   as const, count: ocupadoCount },
                { state: 'bloqueado' as const, count: bloqCount },
              ]).map(s => {
                const meta = CAL_STATE_META[s.state];
                return (
                  <div key={s.state} className="thd-kpi">
                    <div className="thd-kpi-value">{s.count}</div>
                    <div className="thd-kpi-label">
                      <span aria-hidden className="vc-dot" style={{ background: meta.dotColor }} />
                      {meta.label}
                    </div>
                  </div>
                );
              })}
            </div>
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
                  return (
                    <ToggleChip
                      key={s}
                      active={active}
                      onClick={() => setSpecialtiesDraft(prev => active ? prev.filter(x => x !== s) : [...prev, s])}
                      style={{ padding: '8px 18px', fontSize: 'var(--fs-body)' }}
                    >
                      {s}
                    </ToggleChip>
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
        <div className="thd-tabs" role="tablist">
          {tabs.map(tab => (
            <button key={tab.id} role="tab" aria-selected={activeTab === tab.id}
              className={`thd-tab${activeTab === tab.id ? ' is-active' : ''}`}
              onClick={() => setActiveTab(tab.id as any)}>
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === 'calendar' && (
          <div style={{ background: '#fff', border: '1px solid #e6e7e2', borderRadius: 18, padding: 22, boxShadow: '0 1px 2px rgba(16,24,16,0.04)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
              <div>
                <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em', color: '#1a1c1a' }}>Mi disponibilidad semanal</div>
                <div style={{ fontSize: 13, color: '#8b8e88', marginTop: 3 }}>Hacé clic en cualquier celda para cambiar su estado. Se guarda automáticamente.</div>
              </div>
              {/* Estado de guardado: punto de color en vez de emoji. */}
              {saveStatus !== 'idle' && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 600, color: saveStatus === 'saved' ? '#1f7a3d' : '#9a6516' }}>
                  <span className="vc-dot" style={{ background: saveStatus === 'saved' ? '#16a34a' : '#e0912f' }} />
                  {saveStatus === 'saved' ? 'Guardado' : 'Guardando…'}
                </span>
              )}
            </div>

            {/* La leyenda ya no vive acá: se fusionó con los contadores en los
                chips que renderiza VisualCalendar (una sola fila, una sola fuente). */}
            {gridLoading ? (
              <div style={{ textAlign: 'center', padding: '48px 0', color: '#8b8e88' }}>Cargando calendario...</div>
            ) : (
              <VisualCalendar mode="teacher" grid={grid} onGridChange={handleGridChange} onOcupadoNeed={handleOcupadoNeed} onRecuperacionNeed={handleRecuperacionNeed} />
            )}
          </div>
        )}

        {activeTab === 'upcoming' && (
          <TeacherUpcomingTab
            teacher={teacher}
            myAssignments={myAssignments}
            students={students}
            classRecords={classRecords}
            grid={grid}
            onGridChange={handleGridChange}
            updateMeetLink={updateMeetLink}
            logClassJoin={logClassJoin}
            addRescheduleRecord={addRescheduleRecord}
            formIndex={formIndex}
            refreshFormIndex={refreshFormIndex}
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
              students={students}
              classRecords={classRecords}
              notifications={notifications}
              loadNotifications={loadNotifications}
              markNotificationRead={markNotificationRead}
              updateMeetLink={updateMeetLink}
              formIndex={formIndex}
              refreshFormIndex={refreshFormIndex}
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

      {/* Recuperación modal (triggered from calendar "En recuperación" cell) */}
      {pendingRecuperacion && (
        <RecuperacionModal
          day={pendingRecuperacion.day}
          hour={pendingRecuperacion.hour}
          studentNames={Array.from(new Set(myAssignments.map(a => a.studentName))).sort()}
          onConfirm={handleRecuperacionConfirm}
          onCancel={() => setPendingRecuperacion(null)}
        />
      )}

      {/* El popup recordatorio y su modal se montan en el NavBar
          (components/PresentationEmailReminder), común a toda la app del profesor. */}

      </PullToRefresh>
    </div>
  );
}

export default function TeacherPage() {
  return (
    <AuthGuard allowedRoles={['teacher', 'admin']}>
      {/* TeacherContent lee ?tab= con useSearchParams: requiere un boundary. */}
      <Suspense>
        <TeacherContent />
      </Suspense>
    </AuthGuard>
  );
}
