'use client';
import { useState, useEffect, useMemo, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { PullToRefresh } from '@/components/PullToRefresh';
import {
  VisualCalendar, DAYS, cellKey, getSpainParts, CAL_STATE_META,
  CAL_DEFAULT_START, CAL_DEFAULT_END, type RecuperacionData,
} from '@/components/VisualCalendar';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import { calcRegisteredClassNumber, dbCheckStudentExists, dbSetStudentProduct, dbEnsureStudentAndAssignment, dbSaveTeacherCalendarHours, getTeacherAssignments } from '@/lib/db';
import type { StudentLeftGrid } from '@/lib/db';
import { checkSubscription, resolveSubscriptionEmail, subCategory } from '@/lib/useSubscriptionStatus';
import { planBadgeStyle } from '@/lib/productUtils';
import { isAssignableCell, withBaseState, baseStudentOf } from '@/lib/cells';
import { checkRecovery, existingRecoveriesOf, type RecoveryVerdict } from '@/lib/recovery';
import { lostClassHours, recoveryLedgerOf, type RecoveryLedger } from '@/lib/recoveryLedger';
import { sessionRangeLabel } from '@/lib/sessions';
import { isoDateLocal, classesForDate, groupContiguousClasses, sessionHoursLabel, gridOccupancyOfTeacher } from '@/lib/teacherClasses';
import { periodIndex, dbGetStudentDropouts, type StudentDropout } from '@/lib/studentPeriod';
import { StudentAutofillCard } from '@/components/StudentAutofillCard';
import { useStudentAutofill } from '@/lib/useStudentAutofill';
import { usePresentationSent, presentationBtnStyle, PresentationEmailBadge } from '@/components/teacherPanelUi';
import { RETENTION_BONUS_DAYS, retentionDaysActive, retentionStartDate, retentionBonusDate, hasRetentionBonus } from '@/lib/retention';
import { Grid, Teacher, Assignment, ScoringEvent, Student, AppNotification, ClassRecord } from '@/types';
import FormStatusBadge from '@/components/FormStatusBadge';
import { maybeSendBonusEmail } from '@/lib/milestoneEmails';
import { fetchFormTokensIndex, lookupToken, type FormTokenInfo } from '@/lib/formClient';
import { AVOID_ITEMS, AVOID_TITLE } from '@/lib/interventions';
import { PresentationModal } from '@/components/PresentationModal';
import { ALL_SPECIALTIES } from '@/lib/specialties';
import { isValidOptionalEmail } from '@/lib/validation';
import { SpecialtyChip, ToggleChip } from '@/components/ui';
import AlumnoYaAsignadoModal from '@/components/AlumnoYaAsignadoModal';
import { findOtherTeacherAssignments, type ExistingAssignmentMatch } from '@/lib/assignmentGuard';

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
  // VACÍA a propósito. Antes venía con la fecha de HOY y nadie la tocaba, así que
  // "inicio de clases" acababa siendo "día en que lo cargué": un alumno dado de
  // alta el 20 de septiembre para empezar el 5 de octubre arrastraba dos semanas
  // de clases fantasma. Ahora hay que decirlo.
  const [startDate, setStartDate] = useState('');
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
    // La de WooCommerce solo rellena el campo VACÍO: si el profesor ya escribió
    // una fecha, manda la suya.
    if (autofill.startDate) setStartDate(prev => (prev ? prev : autofill.startDate!));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autofill.name, autofill.level, autofill.startDate, tab]);

  // Compute cells available for slot picking: all libre cells + clicked cell
  const libreCells: Array<{ day: string; hour: string }> = [];
  const seenKeys = new Set<string>();
  libreCells.push({ day, hour });
  seenKeys.add(`${day}_${hour}`);
  for (const [key, cell] of Object.entries(grid)) {
    // isAssignableCell: incluye horarios con una recuperación puntual encima, que
    // siguen libres para un alumno recurrente el resto de las semanas.
    if (isAssignableCell(cell) && !seenKeys.has(key)) {
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
  // Sin fecha de inicio no se guarda: es lo que define desde cuándo existen sus
  // clases (ver lib/studentPeriod).
  const puedeGuardarExistente = allSlotsValid && !!startDate;

  function selectStudent(a: Assignment) {
    setSelectedAssignment(a);
    const base = [...(a.slots || [])];
    if (!base.some(s => s.day === day && s.hour === hour)) base.unshift({ day, hour });
    setSlots(base);
    // Sin fecha guardada se deja VACÍO, no "hoy": que la diga quien la sabe.
    setStartDate(a.startDate || '');
    setStep(2);
  }

  function handleTabChange(t: 'existing' | 'new') {
    setTab(t);
    setStep(1);
    setSelectedAssignment(null);
    setSlots([{ day, hour }]);
    // Vacía, como al abrir: cambiar de pestaña no puede dejar puesta una fecha
    // que nadie eligió.
    setStartDate('');
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
                    {myAssignments.length === 0 ? 'No tienes alumnos asignados aún.' : 'Sin resultados.'}
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
                style={{ padding: '11px', borderRadius: 9, border: 'none', background: puedeGuardarExistente ? '#1E9E3A' : 'var(--bg-surface-3)', color: puedeGuardarExistente ? 'white' : 'var(--text-muted)', cursor: puedeGuardarExistente ? 'pointer' : 'not-allowed', fontSize: 14, fontWeight: 700, fontFamily: 'inherit' }}>
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
                const canCreate = !!newName.trim() && isValidOptionalEmail(newEmail) && allSlotsValid && !!startDate && !checkingEmail;
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
        // Sugerencia de intervención: el cuerpo lleva saltos de línea y se
        // acompaña del recordatorio plegado de "qué evitar".
        const isRiskAlert = n.type === 'risk_alert';
        return (
          <div key={av.key} style={{ ...cardStyle, background: isRead ? 'var(--bg-surface)' : 'rgba(30,158,58,0.04)', border: `1.5px solid ${isRead ? 'var(--border)' : 'rgba(30,158,58,0.3)'}` }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <span style={{ fontSize: 20, marginTop: 2 }}>{n.type === 'new_assignment' ? '📚' : isRiskAlert ? '🧭' : '📢'}</span>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>{n.title}</div>
                  {!isRead && <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 10, background: 'rgba(30,158,58,0.15)', border: '1px solid rgba(30,158,58,0.3)', color: '#1E9E3A', fontWeight: 700 }}>NUEVO</span>}
                  {asgn && sent && <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 10, background: 'rgba(30,158,58,0.12)', border: '1px solid rgba(30,158,58,0.3)', color: '#1E9E3A', fontWeight: 700 }}>📧 Presentación enviada</span>}
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 6, whiteSpace: isRiskAlert ? 'pre-wrap' : undefined }}>{n.body}</div>
                {isRiskAlert && (
                  <details style={{ marginBottom: 6 }}>
                    <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-muted)' }}>{AVOID_TITLE}</summary>
                    <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, lineHeight: 1.6, color: 'var(--text-muted)' }}>
                      {AVOID_ITEMS.map(t => <li key={t}>{t}</li>)}
                    </ul>
                  </details>
                )}
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

// La agenda del profesor ("Mis clases") ya no es una pestaña de esta página:
// vive en /clases con su botón propio en el header. El componente está en
// components/MisClasesPanel y los helpers que comparte con la pestaña Avisos, en
// components/teacherPanelUi.

// ─── Mini modal "En recuperación" (punto 3) ───────────────────────────────────
// Al marcar una celda como "En recuperación", pide qué alumno recupera, la fecha
// de la clase original que se perdió y una nota opcional.
//
// La fecha se COMPRUEBA contra las reglas de la academia (lib/recovery) en cuanto
// se escribe, y el botón queda bloqueado si no cumple. Antes no había ninguna
// comprobación: en agosto de 2026, de 187 recuperaciones solo 12 correspondían a
// una clase perdida con derecho a recuperarse.
//
// El bloqueo trae SALIDA. Cuando no consta nada en esa fecha —el caso más común,
// 54 de 187— el modal ofrece registrar ahí mismo la falta con aviso y continuar.
// Bloquear sin dar salida es garantizar que el profesor no cambie de hábito: hoy
// el alumno avisa por WhatsApp y ese aviso no llega al sistema.
function RecuperacionModal({ day, hour, date, studentNames, verdictOf, ledgerOf, freeHours, onRegisterAbsence, onConfirm, onCancel }: {
  day: string; hour: string;
  /** Fecha real de la celda que se está marcando. */
  date: string;
  studentNames: string[];
  /** Las reglas, resueltas por la pantalla (que es quien tiene los datos). */
  verdictOf: (studentName: string, lostDate: string) => RecoveryVerdict;
  /** Saldo de la clase perdida: cuánto valía y cuánto queda por reponer. */
  ledgerOf: (studentName: string, lostDate: string) => RecoveryLedger;
  /** Horas seguidas libres desde esta celda (incluida): decide si cabe el bloque. */
  freeHours: number;
  /** Registra la falta con aviso de esa fecha. Es la salida del bloqueo. */
  onRegisterAbsence: (studentName: string, lostDate: string) => Promise<void>;
  onConfirm: (data: RecuperacionData) => void;
  onCancel: () => void;
}) {
  const [student, setStudent] = useState(studentNames[0] ?? '');
  const [customName, setCustomName] = useState('');
  const [recoveryFor, setRecoveryFor] = useState('');
  const [note, setNote] = useState('');
  const [registrando, setRegistrando] = useState(false);
  const [registrada, setRegistrada] = useState(false);
  const [errorRegistro, setErrorRegistro] = useState('');
  // Clase perdida de 2 h: ¿se repone junta (un bloque) o partida en dos días?
  const [juntas, setJuntas] = useState(true);

  const finalName = (studentNames.length === 0 ? customName : student).trim();
  // Se comprueba mientras escribe: el motivo aparece antes de pulsar nada.
  const verdict = finalName && recoveryFor ? verdictOf(finalName, recoveryFor) : null;
  const canConfirm = !!finalName && !!recoveryFor && !!verdict?.ok;

  // Saldo de la clase que se está saldando. Solo cuando la elección es válida:
  // con una fecha a medio escribir no significa nada.
  const ledger = canConfirm ? ledgerOf(finalName, recoveryFor) : null;
  const pendientes = ledger?.pendingHours ?? 1;
  // Lo que cabe de verdad: lo que falta por reponer, limitado por las horas
  // libres que hay a continuación en el calendario.
  const cabenJuntas = Math.min(pendientes, Math.max(1, freeHours));
  const puedeElegir = pendientes > 1 && cabenJuntas > 1;
  const horasAMarcar = puedeElegir && juntas ? cabenJuntas : 1;

  async function registrarFalta() {
    setRegistrando(true); setErrorRegistro('');
    try {
      await onRegisterAbsence(finalName, recoveryFor);
      setRegistrada(true);
    } catch (e) {
      setErrorRegistro(e instanceof Error ? e.message : 'No se pudo registrar la falta.');
    } finally {
      setRegistrando(false);
    }
  }

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
        {/* `max`: no se puede recuperar una clase que todavía no se dio. El
            navegador ya no deja elegirla, y la regla se comprueba igual abajo —
            un date input se puede escribir a mano. */}
        <input type="date" value={recoveryFor} max={date}
          onChange={e => { setRecoveryFor(e.target.value); setRegistrada(false); setErrorRegistro(''); }}
          style={{ width: '100%', marginBottom: verdict && !verdict.ok ? 10 : 14 }} />

        {/* Por qué no se puede, dicho antes de pulsar nada. */}
        {verdict && !verdict.ok && (
          <div style={{
            background: verdict.kind === 'sin_registro' ? 'rgba(255,196,0,0.12)' : 'rgba(239,68,68,0.08)',
            border: `1px solid ${verdict.kind === 'sin_registro' ? 'rgba(255,196,0,0.45)' : 'rgba(239,68,68,0.30)'}`,
            borderRadius: 10, padding: '11px 13px', marginBottom: 14,
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: verdict.kind === 'sin_registro' ? '#9a6516' : '#b91c1c', marginBottom: 3 }}>
              {verdict.title}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.55 }}>{verdict.detail}</div>

            {/* LA SALIDA: registrar la falta con aviso y seguir sin salir de acá. */}
            {verdict.offerRegister && !registrada && (
              <button onClick={registrarFalta} disabled={registrando}
                style={{ marginTop: 10, width: '100%', padding: '9px', borderRadius: 8, border: 'none', background: registrando ? 'var(--bg-surface-3)' : '#e0912f', color: registrando ? 'var(--text-muted)' : 'white', cursor: registrando ? 'not-allowed' : 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit' }}>
                {registrando ? 'Registrando…' : `Registrar que el alumno avisó el ${recoveryFor.split('-').reverse().join('/')}`}
              </button>
            )}
            {errorRegistro && (
              <div style={{ marginTop: 8, fontSize: 12, color: '#c0392b' }}>{errorRegistro}</div>
            )}
          </div>
        )}
        {registrada && verdict?.ok && (
          <div style={{ background: '#eaf5ec', border: '1px solid rgba(22,122,45,0.30)', borderRadius: 10, padding: '10px 13px', marginBottom: 14, fontSize: 12.5, color: '#1f7a3d', lineHeight: 1.5 }}>
            Falta con aviso registrada. Ya podés marcar la recuperación.
          </div>
        )}

        {/* Clase perdida de más de una hora: juntas o partida. El profesor cobra
            lo mismo en los dos casos; lo que cambia es si son una clase de 2 h
            (un transcript) o dos clases de 1 h (un transcript cada una). */}
        {ledger && ledger.lostHours > 1 && (
          <div style={{ background: 'rgba(255,196,0,0.10)', border: '1px solid rgba(255,196,0,0.45)', borderRadius: 10, padding: '11px 13px', marginBottom: 14 }}>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: puedeElegir ? 9 : 0 }}>
              Esa clase era de <b>{ledger.lostHours} horas</b>
              {ledger.recoveredHours > 0 && <> y ya tiene <b>{ledger.recoveredHours} h</b> repuesta{ledger.recoveredHours > 1 ? 's' : ''}</>}
              . Quedan <b>{pendientes} h</b> por recuperar.
            </div>
            {puedeElegir ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {([
                  { on: true,  label: `Las ${cabenJuntas} horas juntas (${sessionRangeLabel(hour, cabenJuntas)})`, sub: 'Una clase de varias horas: un transcript, se paga por todas.' },
                  { on: false, label: 'Solo esta hora, el resto otro día', sub: `Queda${pendientes - 1 > 1 ? 'n' : ''} ${pendientes - 1} h por marcar en otro día. Cada hora es una clase con su transcript.` },
                ]).map(opt => (
                  <button key={String(opt.on)} type="button" onClick={() => setJuntas(opt.on)}
                    style={{ display: 'block', textAlign: 'left', padding: '9px 12px', borderRadius: 9, fontFamily: 'inherit', cursor: 'pointer',
                      border: `1.5px solid ${juntas === opt.on ? '#1E9E3A' : 'var(--border)'}`,
                      background: juntas === opt.on ? 'rgba(30,158,58,0.08)' : 'var(--bg-surface)',
                      color: 'var(--text-primary)', fontSize: 13 }}>
                    <div style={{ fontWeight: 600 }}>{juntas === opt.on ? '🔘' : '⚪'} {opt.label}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2, marginLeft: 22 }}>{opt.sub}</div>
                  </button>
                ))}
              </div>
            ) : pendientes > 1 ? (
              <div style={{ fontSize: 12, color: '#9a6516', lineHeight: 1.5 }}>
                La hora siguiente no está libre, así que esta recuperación es de 1 h: quedará{pendientes - 1 > 1 ? 'n' : ''} {pendientes - 1} h para otro día.
              </div>
            ) : (
              <div style={{ fontSize: 12, color: '#1f7a3d', lineHeight: 1.5 }}>Esta hora completa la clase.</div>
            )}
          </div>
        )}

        <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Nota (opcional)</label>
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="Ej: la faltó por viaje" style={{ width: '100%', marginBottom: 18 }} />

        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onCancel} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>Cancelar</button>
          <button onClick={() => canConfirm && onConfirm({ student: finalName, recoveryFor, note: note.trim() || undefined, hours: horasAMarcar })} disabled={!canConfirm}
            style={{ flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: canConfirm ? '#1E9E3A' : 'var(--bg-surface-3)', color: canConfirm ? 'white' : 'var(--text-muted)', cursor: canConfirm ? 'pointer' : 'not-allowed', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
            {horasAMarcar > 1 ? `Marcar recuperación de ${horasAMarcar} h` : 'Marcar recuperación'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Teacher Content ──────────────────────────────────────────────────────────
const TEACHER_TABS = ['calendar', 'scoring', 'notifications'] as const;
type TeacherTab = typeof TEACHER_TABS[number];

function TeacherContent() {
  const { user } = useAuth();
  const { teachers, students, assignments, scoringEvents, notifications, classRecords, getTeacherGrid, updateTeacherGrid, addStudent, addAssignment, updateAssignmentStartDate, updateAssignmentSlots, reloadAll, updateTeacherSpecialties, loadNotifications, markNotificationRead, updateMeetLink, addRecoveryClass, removeAssignment, classJoinLogs, registerClassRecord } = useTeachers();
  const [activeTab, setActiveTab] = useState<TeacherTab>('calendar');

  // El campanario del header navega a /teacher?tab=notifications. Sincronizamos
  // la pestaña con la URL (sistema externo) para aterrizar en Avisos; la pestaña
  // sigue siendo estado local para que cambiarla no cueste un round-trip de red.
  const searchParams = useSearchParams();
  const router = useRouter();
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    const t = searchParams.get('tab');
    // "Mis clases" dejó de ser pestaña: los enlaces viejos (?tab=upcoming) van a
    // su sección propia en vez de quedarse en el calendario sin explicación.
    if (t === 'upcoming') { router.replace('/clases'); return; }
    if (t && (TEACHER_TABS as readonly string[]).includes(t)) setActiveTab(t as TeacherTab);
  }, [searchParams, router]);
  const [showSpecialtiesModal, setShowSpecialtiesModal] = useState(false);
  const [specialtiesDraft, setSpecialtiesDraft] = useState<string[]>([]);
  const [savingSpecialties, setSavingSpecialties] = useState(false);
  const [grid, setGrid]           = useState<Grid>({});
  const [calendarRange, setCalendarRange] = useState({ start: CAL_DEFAULT_START, end: CAL_DEFAULT_END });
  const [gridLoading, setGridLoading]   = useState(true);
  const [saveStatus, setSaveStatus]     = useState<'idle' | 'saving' | 'saved'>('idle');
  const [dismissedInSession, setDismissedInSession] = useState<Set<string>>(new Set());
  const [dismissedBonusInSession, setDismissedBonusInSession] = useState<Set<string>>(new Set());
  const [pendingOcupado, setPendingOcupado] = useState<{ day: string; hour: string; resolve: (name: string) => void } | null>(null);
  // Aviso "este alumno ya tiene profesor": guarda la asignación a la espera de decisión.
  const [yaAsignado, setYaAsignado] = useState<{ data: AssignConfirmData; matches: ExistingAssignmentMatch[] } | null>(null);
  const [pendingRecuperacion, setPendingRecuperacion] = useState<{ day: string; hour: string; date: string; resolve: (data: RecuperacionData) => void } | null>(null);
  const [formIndex, setFormIndex] = useState<FormIndex>(EMPTY_FORM_INDEX);

  const refreshFormIndex = () => { fetchFormTokensIndex().then(setFormIndex).catch(() => {}); };
  useEffect(() => { refreshFormIndex(); }, []);

  const teacher = teachers.find(t => t.id === user?.teacherId) ?? teachers[0];

  // El popup recordatorio de emails de presentación se monta en el NavBar
  // (components/PresentationEmailReminder), así aparece en toda la app del profesor.

  useEffect(() => {
    if (!teacher) return;
    setGridLoading(true);
    setCalendarRange({
      start: teacher.calendarStartHour ?? CAL_DEFAULT_START,
      end:   teacher.calendarEndHour   ?? CAL_DEFAULT_END,
    });
    getTeacherGrid(teacher.id).then(g => {
      setGrid(g);
      setGridLoading(false);
    });
  }, [teacher?.id]);

  // ── Alumnos del profesor: FUENTE ÚNICA DE VERDAD ───────────────────────────
  //
  // Un alumno pertenece a este profesor si y solo si tiene al menos una celda en
  // su grid. `getStudentsForTeacher` es la ÚNICA función que lo decide: acá ya no
  // se filtra `assignments` por teacherId, que era lo que dejaba colgados en
  // Asistencias / Próximas clases / Mis alumnos a los alumnos sin celdas.
  const [myAssignments, setMyAssignments] = useState<Assignment[]>([]);
  // Bajas, para cerrar el período de cada alumno (ver lib/studentPeriod).
  const [headerDropouts, setHeaderDropouts] = useState<StudentDropout[]>([]);
  useEffect(() => { dbGetStudentDropouts().then(setHeaderDropouts).catch(() => {}); }, []);

  // Alumnos SIN suscripción activa, resueltos EN VIVO contra WooCommerce (la
  // misma `checkSubscription` que el badge de Alumnos, con su caché de 5 min
  // compartida). Se MARCAN en el calendario, nunca se filtran: una suscripción
  // vencida no significa que el alumno dejó de venir, y esconder su clase le
  // borraría al profesor una clase real.
  const [inactiveStudents, setInactiveStudents] = useState<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out = new Set<string>();
      for (const a of myAssignments) {
        const email = resolveSubscriptionEmail(
          students.find(s => s.name.trim().toLowerCase() === a.studentName.trim().toLowerCase())?.email,
          a.studentEmail);
        if (!email) continue;
        try {
          const info = await checkSubscription(email);
          // Solo lo que es DE VERDAD una anomalía: 'unverified' y 'pending' no
          // se marcan, para que el aviso signifique algo cuando aparece.
          if (subCategory(info) === 'inactive') out.add(a.studentName.trim().toLowerCase());
        } catch { /* si Woo falla no se marca nada: mejor sin aviso que uno falso */ }
      }
      if (!cancelled) setInactiveStudents(out);
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myAssignments.length, students.length]);

  // Alumno que se quedó sin horario Y con la suscripción cancelada: se le AVISA
  // al profesor de lo que acaba de pasar. Nada más: el profesor desvincula, no
  // elimina. El aviso se limita al caso de suscripción cancelada porque el
  // calendario autoguarda en cada clic y mover a alguien de hora deja un instante
  // con cero celdas — sin ese filtro saltaría en cada reorganización de horarios.
  const [removalPrompt, setRemovalPrompt] = useState<StudentLeftGrid | null>(null);

  // Firma de la ocupación: cambia solo si cambia QUIÉN ocupa QUÉ celda. Sin esto
  // habría que releer en cada repintado del calendario.
  const gridOccupancy = useMemo(() => Object.entries(grid)
    .map(([key, cell]) => {
      // baseStudentOf, no cell.student: una recuperación puntual tapa la celda
      // esa semana y el alumno fijo del horario vive en baseStudent.
      const name = baseStudentOf(cell)?.trim();
      return name ? `${key}:${name.toLowerCase()}` : null;
    })
    .filter(Boolean).sort().join('|'), [grid]);

  // Depende del ID, no del objeto `teacher`: la lista de profesores se recarga
  // cada 60 s y su identidad cambia en cada recarga, lo que dispararía una
  // relectura en bucle. Mismo criterio que el efecto del grid de acá arriba.
  useEffect(() => {
    if (!teacher) return;
    let cancelled = false;
    getTeacherAssignments(teacher)
      .then(rows => { if (!cancelled) setMyAssignments(rows); })
      .catch(err => console.error('[teacher] No se pudieron leer los alumnos del grid:', err));
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teacher?.id, gridOccupancy]);

  async function handleGridChange(g: Grid) {
    setGrid(g);
    setSaveStatus('saving');
    const sinHorario = await updateTeacherGrid(teacher.id, g);
    setSaveStatus('saved');
    setTimeout(() => setSaveStatus('idle'), 2000);

    // Alguien se quedó sin ninguna celda: ya está DESVINCULADO de su horario, y
    // eso es todo lo que pasa. Sigue siendo alumno de este profesor y aparece en
    // "Mis alumnos" como «Actualmente sin tomar clases» (getStudentsForTeacher →
    // activo:false), listo para volver a asignarle una celda cuando regrese.
    //
    // Si además su suscripción está CANCELADA se le avisa, porque en ese caso el
    // equipo probablemente tenga que darlo de baja de la plataforma — algo que
    // hace el admin desde "Alumnos", nunca el profesor desde acá.
    for (const s of sinHorario) {
      if (!s.studentEmail) continue;
      try {
        const info = await checkSubscription(s.studentEmail);
        if (info.status === 'cancelled') { setRemovalPrompt(s); return; }
      } catch { /* si Woo falla, no se avisa de nada: la desvinculación ya está hecha */ }
    }
  }

  // Ampliación del rango de horas del calendario. El estado local manda mientras
  // dura la sesión (la lista de profesores se recarga cada 60 s) y la preferencia
  // queda guardada en teachers.calendar_start_hour / calendar_end_hour.
  async function handleRangeChange(startHour: number, endHour: number) {
    setCalendarRange({ start: startHour, end: endHour });
    setSaveStatus('saving');
    try {
      await dbSaveTeacherCalendarHours(teacher.id, startHour, endHour);
      setSaveStatus('saved');
    } catch {
      setSaveStatus('idle');
    }
    setTimeout(() => setSaveStatus('idle'), 2000);
  }

  function handleOcupadoNeed(day: string, hour: string, resolve: (name: string) => void, cancel: () => void) {
    setPendingOcupado({ day, hour, resolve });
  }

  function handleRecuperacionNeed(day: string, hour: string, date: string, resolve: (data: RecuperacionData) => void, cancel: () => void) {
    setPendingRecuperacion({ day, hour, date, resolve });
  }

  /**
   * Las reglas de la recuperación, resueltas con lo que tiene la pantalla: los
   * registros del alumno, sus ingresos y las recuperaciones que ya existen (las
   * celdas del calendario y los class_records). La decisión vive en lib/recovery;
   * acá solo se le pasan los datos.
   */
  function recoveryVerdictOf(studentName: string, lostDate: string): RecoveryVerdict {
    return checkRecovery({
      studentName,
      recoveryDate: pendingRecuperacion?.date ?? isoDateLocal(new Date()),
      recoveryHour: pendingRecuperacion?.hour,
      lostDate,
      // Una clase perdida de 2 h admite DOS horas de recuperación (juntas o
      // partidas); una de 1 h sigue admitiendo una sola.
      lostHours: lostClassHours({
        studentName, lostDate, classRecords, occupancy: gridOccupancyOfTeacher(teacher),
      }),
      classRecords, joinLogs: classJoinLogs,
      existing: existingRecoveriesOf({ studentName, classRecords, recoveryCells: celdasDeRecuperacion() }),
    });
  }

  /** Las celdas de recuperación del profesor, con su hora (la necesita el saldo). */
  function celdasDeRecuperacion() {
    return (teacher?.recoveryCells ?? []).map(c => ({
      studentName: c.studentName, date: c.date, hour: c.hour, recoveryFor: c.recoveryFor,
    }));
  }

  /** Saldo de la clase perdida: lo que mira el modal para ofrecer junta o partida. */
  function recoveryLedgerFor(studentName: string, lostDate: string): RecoveryLedger {
    return recoveryLedgerOf({
      studentName, lostDate, classRecords,
      existing: existingRecoveriesOf({ studentName, classRecords, recoveryCells: celdasDeRecuperacion() }),
      occupancy: gridOccupancyOfTeacher(teacher),
      // La celda que se está marcando ahora no cuenta como recuperación hecha.
      exclude: pendingRecuperacion
        ? { date: pendingRecuperacion.date, hour: pendingRecuperacion.hour }
        : undefined,
    });
  }

  /**
   * Horas seguidas libres a partir de esa celda (la propia incluida, así que
   * nunca es menos de 1). Decide si una recuperación de 2 h cabe JUNTA: sin esto
   * el bloque se comería la clase recurrente del alumno de al lado.
   */
  function freeHoursFrom(day: string, hour: string): number {
    const start = parseInt(hour, 10);
    if (!Number.isFinite(start)) return 1;
    let n = 1;
    for (let h = start + 1; h <= start + 3; h++) {
      const cell = grid[cellKey(day, `${String(h).padStart(2, '0')}:00`)];
      // Libre de verdad: sin celda, ofrecida o sin trabajar. Una recuperación de
      // otro alumno también ocupa, aunque el horario de fondo esté libre.
      if (cell && cell.state !== 'libre' && cell.state !== 'no_work') break;
      n++;
    }
    return n;
  }

  /**
   * La salida del bloqueo: registrar la falta CON aviso de esa fecha para poder
   * seguir con la recuperación. No mueve dinero —una falta avisada se ignora en
   * el cálculo del pago (lib/finance.ts:721)— pero deja constancia de que el
   * alumno avisó, que es justo lo que hoy se pierde cuando el aviso llega por
   * WhatsApp y no entra al sistema.
   */
  async function registrarFaltaConAviso(studentName: string, lostDate: string) {
    if (!teacher) throw new Error('Sin profesor cargado.');
    await registerClassRecord(
      teacher.id, studentName, lostDate, undefined, null, 'falta_con_aviso',
      'Registrada al marcar una recuperación: el alumno había avisado.',
    );
  }

  // Confirma la recuperación: pinta la celda (via resolve) y registra la clase de
  // recuperación (class_records, class_date = HOY) vinculada al alumno y a la
  // fecha original. Cuenta para el pago con la tarifa normal del alumno.
  async function handleRecuperacionConfirm(data: RecuperacionData) {
    if (!teacher || !pendingRecuperacion) return;
    const { date, hour } = pendingRecuperacion;
    pendingRecuperacion.resolve(data); // aplica la celda 'bloqueado' con student + recoveryFor
    setPendingRecuperacion(null);
    try {
      await addRecoveryClass({
        teacherId: teacher.id, teacherName: teacher.name, studentName: data.student,
        // La fecha de la CLASE de recuperación, no la de hoy. Marcar el lunes la
        // recuperación del jueves dejaba la constancia sellada el lunes: la fila
        // caía en otro día y el saldo de horas no la reconocía.
        recoveryDate: date, originalDate: data.recoveryFor,
        note: data.note, classTime: hour,
      });
    } catch { /* la constancia de finanzas no debe romper el marcado del grid */ }
  }

  /**
   * Guard: ¿el alumno ya tiene profesor? Se comprueba ANTES de crear nada. Si lo
   * tiene, se guarda la asignación pendiente y se muestra el aviso; el flujo real
   * continúa en `aplicarAsignacion` cuando el profesor decide mover o mantener.
   *
   * Este flujo no tenía ningún control: el calendario del profesor creaba la
   * asignación directamente, y así es como salían los alumnos con dos profesores.
   */
  async function handleAssignStudent(data: AssignConfirmData) {
    if (!teacher || !pendingOcupado) return;

    // Reasignar horarios del MISMO profesor no dispara el aviso.
    if (!data.existingAssignment) {
      const identidad = data.isNew
        ? { email: data.newStudentData?.email, name: data.newStudentData?.name ?? data.studentName }
        : { studentId: data.useExistingStudent?.id, email: data.useExistingStudent?.email, name: data.studentName };
      const otros = findOtherTeacherAssignments(identidad, assignments, teacher.id);
      if (otros.length > 0) { setYaAsignado({ data, matches: otros }); return; }
    }

    await aplicarAsignacion(data);
  }

  async function aplicarAsignacion(data: AssignConfirmData) {
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
          const key = cellKey(old.day, old.hour);
          updatedGrid[key] = withBaseState(updatedGrid[key], 'libre');
        }
      }
    }
    // withBaseState: si la celda tiene una recuperación puntual, esta sigue pintada
    // en su semana y el alumno recurrente ocupa el resto.
    for (const slot of data.slots) {
      const key = cellKey(slot.day, slot.hour);
      updatedGrid[key] = withBaseState(updatedGrid[key], 'ocupado', finalName);
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

  // Alumnos del profesor. Hoy manda `assignments`; con ?strictGrid=1 se
  // previsualiza la REGLA NUEVA: pertenece quien tiene al menos una celda en el
  // grid. Es un ensayo sin efectos, para revisar el panel antes de cambiarlo
  // para todos (hay 22 assignments sin celdas, 14 de alumnos reales).
  // Ver scripts/diagnose-orphan-assignments.mjs y getStudentsForTeacher().
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

  // "Mis clases" ya no está acá: es su propia sección (/clases), con botón en el
  // header. La redirección de abajo cubre los enlaces viejos a ?tab=upcoming.
  const tabs = [
    { id: 'calendar',      label: 'Mi calendario' },
    { id: 'scoring',       label: 'Mi Scoring' },
    { id: 'notifications', label: 'Avisos' },
  ] as const;

  // ── Header mini-stats ──────────────────────────────────────────────────────
  const uniqueStudentCount = new Set([
    ...myAssignments.map(a => a.studentName),
    ...legacyList.map(l => l.student),
  ]).size;

  // Cabecera: día y hora de España, la misma referencia que la agenda. Antes usaba
  // la hora local del navegador y podía anunciar la clase de otro día.
  const spainHeader = getSpainParts(new Date());
  // Período de cada alumno: sin esto "Próxima clase" podía anunciar la de un
  // alumno que todavía no empezó (ver lib/studentPeriod).
  const periodosHeader = periodIndex(myAssignments, headerDropouts, teacher?.id ?? '');
  // Agrupada como en el resto de la app: una sesión de 2h es UNA clase que sigue
  // en curso hasta su hora de fin (endHourNum), no hasta la hora siguiente.
  const todayClassesHeader = groupContiguousClasses(
    classesForDate(myAssignments, spainHeader.dateStr, periodosHeader), teacher.id,
    gridOccupancyOfTeacher(teacher),
  );
  const nowDecimalHeader = spainHeader.hour + spainHeader.minute / 60;
  const nextClassHeader = todayClassesHeader.find(c => c.endHourNum > nowDecimalHeader);
  const nextClassLabel = nextClassHeader
    ? `Hoy ${sessionHoursLabel(nextClassHeader)} · ${nextClassHeader.studentName}`
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
          // `data-onboarding`: primer paso del tutorial guiado. La disponibilidad
          // es la condición de todo lo demás (sin celdas libres no hay alumnos).
          <div data-onboarding="calendar-grid" style={{ background: '#fff', border: '1px solid #e6e7e2', borderRadius: 18, padding: 22, boxShadow: '0 1px 2px rgba(16,24,16,0.04)' }}>
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
              <VisualCalendar
                mode="teacher"
                grid={grid}
                startHour={calendarRange.start}
                endHour={calendarRange.end}
                onRangeChange={handleRangeChange}
                onGridChange={handleGridChange}
                onOcupadoNeed={handleOcupadoNeed}
                onRecuperacionNeed={handleRecuperacionNeed}
                inactiveStudents={inactiveStudents}
              />
            )}
          </div>
        )}

        {/* Alumno sin horario Y con la suscripción cancelada. AVISO, no decisión:
            el calendario del profesor DESVINCULA (libera las celdas) y nunca
            elimina a nadie de la plataforma. Con cualquier otro estado de
            suscripción no aparece nada y el profesor reorganiza horarios con
            total tranquilidad. */}
        {removalPrompt && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
            onClick={e => { if (e.target === e.currentTarget) setRemovalPrompt(null); }}
            role="alertdialog" aria-modal="true">
            <div style={{ background: '#F7F7F5', border: '2px solid #FFC400', borderRadius: 16, padding: 26, width: '100%', maxWidth: 440 }}>
              <div style={{ fontSize: 17, fontWeight: 700, color: '#1a1c1a', marginBottom: 8 }}>
                {removalPrompt.studentName} quedó desvinculado de tu horario
              </div>
              <div style={{ fontSize: 13.5, color: '#5f6360', lineHeight: 1.6, marginBottom: 14 }}>
                Lo sacaste del calendario y su suscripción figura como <b style={{ color: '#c73a28' }}>cancelada</b>.
                Su franja ya está libre para otro alumno.
              </div>
              <div style={{ fontSize: 12.5, color: '#3f423f', background: 'rgba(30,158,58,0.10)', border: '1px solid rgba(30,158,58,0.45)', borderRadius: 8, padding: '10px 12px', marginBottom: 18, lineHeight: 1.55 }}>
                <b>Sigue siendo tu alumno.</b> Lo tenés en «Mis alumnos» con la etiqueta
                «Actualmente sin tomar clases», con su ficha y su historial intactos: si
                vuelve, solo tenés que asignarle un horario otra vez.
                <b> Tus clases ya dadas se conservan y se pagan igual.</b> Darlo de baja de
                la plataforma lo hace el equipo desde «Alumnos».
              </div>
              <button onClick={() => setRemovalPrompt(null)}
                style={{ width: '100%', padding: '11px', borderRadius: 9, border: 'none', background: '#1E9E3A', color: '#fff', cursor: 'pointer', fontSize: 13.5, fontWeight: 700, fontFamily: 'inherit' }}>
                Entendido
              </button>
            </div>
          </div>
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

      {/* Aviso: el alumno ya tiene profesor (antes de crear la asignación). */}
      {yaAsignado && teacher && (
        <AlumnoYaAsignadoModal
          studentName={yaAsignado.data.studentName}
          targetTeacherName={teacher.name}
          matches={yaAsignado.matches}
          onMove={async () => {
            // Quitar las asignaciones anteriores libera el calendario del otro
            // profesor; después se crea la nueva con el flujo de siempre.
            for (const m of yaAsignado.matches) {
              await removeAssignment(m.assignmentId, m.teacherId, m.studentName, m.slots);
            }
            const pend = yaAsignado.data;
            setYaAsignado(null);
            await aplicarAsignacion(pend);
          }}
          onKeepBoth={async () => {
            const pend = yaAsignado.data;
            setYaAsignado(null);
            await aplicarAsignacion(pend);
          }}
          onCancel={() => { setYaAsignado(null); setPendingOcupado(null); }}
        />
      )}

      {/* Recuperación modal (triggered from calendar "En recuperación" cell) */}
      {pendingRecuperacion && (
        <RecuperacionModal
          day={pendingRecuperacion.day}
          hour={pendingRecuperacion.hour}
          date={pendingRecuperacion.date}
          verdictOf={recoveryVerdictOf}
          ledgerOf={recoveryLedgerFor}
          freeHours={freeHoursFrom(pendingRecuperacion.day, pendingRecuperacion.hour)}
          onRegisterAbsence={registrarFaltaConAviso}
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
