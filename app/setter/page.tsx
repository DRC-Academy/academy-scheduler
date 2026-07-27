'use client';
import { useState, useMemo, useEffect } from 'react';
import { NavBar } from '@/components/NavBar';
import { StatusBadge } from '@/components/StatusBadge';
import { AuthGuard } from '@/components/AuthGuard';
import { PullToRefresh } from '@/components/PullToRefresh';
import { LastUpdated } from '@/components/LastUpdated';
import { VisualCalendar, buildGridFromTeacher, cellKey, HOURS_ES, getWeekDates, formatWeekRange } from '@/components/VisualCalendar';
import { dbCheckStudentExists, dbSetStudentProduct, dbGetAssignmentsByTeacher, dbGetAssignments, dbUpsertStudent, dbRepairStudentLink, dbRepairAllBrokenLinks, dbGetAllGridOccupancy, GridOccupancy } from '@/lib/db';
import { CrearVinculoModal } from '@/components/CrearVinculoModal';
import { CambiarProfesorModal } from '@/components/CambiarProfesorModal';
import { AssignmentEmailModal } from '@/components/AssignmentEmailModal';
import { StudentAutofillCard } from '@/components/StudentAutofillCard';
import { useStudentAutofill } from '@/lib/useStudentAutofill';
import { planBadgeStyle } from '@/lib/productUtils';
import { formatPuntualDate, isAssignableCell, withBaseState } from '@/lib/cells';
import { useTeachers } from '@/lib/TeachersContext';
import { daysOfWeek } from '@/lib/mock-data';
import { Teacher, SlotFilter, Grid, Assignment, Student, AssignedSlot } from '@/types';
import FormStatusBadge from '@/components/FormStatusBadge';
import { fetchFormTokensIndex, lookupToken, type FormTokenInfo } from '@/lib/formClient';
import { isValidEmail } from '@/lib/validation';
import AlumnoYaAsignadoModal from '@/components/AlumnoYaAsignadoModal';
import { findOtherTeacherAssignments, type ExistingAssignmentMatch } from '@/lib/assignmentGuard';
import { checkSubscription, subBadge, type SubscriptionInfo } from '@/lib/useSubscriptionStatus';

type FormIndex = { byId: Map<string, FormTokenInfo>; byName: Map<string, FormTokenInfo> };

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
      padding: '2px 8px', borderRadius: 12,
      background: s.bg, border: `1px solid ${s.border}`,
      color: s.color, fontSize: 10, fontWeight: 700,
      whiteSpace: 'nowrap',
    }}>
      {specialty}
    </span>
  );
}

// ─── Constants ────────────────────────────────────────────────────────────────
const LEVELS       = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const WEEKLY_HOURS = [1, 2, 3, 4, 5];

const PLANES = [
  'Inglés general',
  'B1 Exámenes',
  'B2 Exámenes',
  'C1 Exámenes',
  'Intensivos Inglés general',
  'B1 Exámenes Intensivo',
  'B2 Exámenes Intensivo',
  'C1 Exámenes Intensivo',
];

const OBJETIVOS = [
  'Mejorar nivel general',
  'Preparación B1',
  'Preparación B2 First',
  'Preparación C1 Advanced',
  'Preparación IELTS',
  'Preparación TOEFL',
  'Inglés de negocios',
  'Conversación fluida',
  'Pronunciación',
  'Gramática avanzada',
  'Inglés académico',
  'Inglés para viajes',
];

const DAY_INDEX: Record<string, number> = {
  Lunes: 0, Martes: 1, Miércoles: 2, Jueves: 3, Viernes: 4, Sábado: 5,
};

// ─── Helpers de fecha ─────────────────────────────────────────────────────────
function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

// ─── Email Trigger ────────────────────────────────────────────────────────────
// El cuerpo del email de asignación vive en components/AssignmentEmailModal.tsx
// (fuente única, compartida con el flujo de cambio de profesor).
function EmailTrigger({ assignment }: { assignment: Assignment }) {
  const [show, setShow] = useState(false);
  return (
    <>
      <button onClick={() => setShow(true)} style={{ padding: '7px 14px', borderRadius: 8, border: 'none', background: '#1E9E3A', color: 'white', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>📧 Email</button>
      {show && <AssignmentEmailModal assignment={assignment} onClose={() => setShow(false)} />}
    </>
  );
}

// ─── Assign Modal ─────────────────────────────────────────────────────────────
const DAY_ORDER = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

function AssignModal({
  teacher, initialSlots, teacherGrid, existingStudents, initialStudentId, onClose, onConfirm,
}: {
  teacher: Teacher;
  initialSlots: AssignedSlot[];
  teacherGrid: Grid;
  existingStudents: Student[];
  initialStudentId?: string;
  onClose: () => void;
  onConfirm: (a: Assignment, s: Student) => void;
}) {
  const { assignments: allAssignments, removeAssignment } = useTeachers();
  const [tab, setTab] = useState<'existing' | 'new'>('existing');
  const [selectedExisting, setSelectedExisting] = useState(initialStudentId ?? '');
  const [newStudent, setNewStudent] = useState({ name: '', email: '', level: 'B1' });
  // Prevención: el alumno ya tiene profesor. Se detecta por id, email o nombre
  // (ver lib/assignmentGuard): comparar solo el id dejaba pasar los duplicados.
  const [yaAsignado, setYaAsignado] = useState<ExistingAssignmentMatch[] | null>(null);

  const availableSlots = useMemo<AssignedSlot[]>(() => {
    return Object.entries(teacherGrid)
      .filter(([, cell]) => isAssignableCell(cell))
      .map(([key]) => { const [day, hour] = key.split('_'); return { day, hour }; })
      .sort((a, b) => {
        const d = DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day);
        return d !== 0 ? d : a.hour.localeCompare(b.hour);
      });
  }, [teacherGrid]);

  // Diagnóstico: confirma cuántos slots libres se leyeron del grid del profesor.
  useEffect(() => {
    console.log('Slots libres encontrados:', availableSlots.length, availableSlots);
  }, [availableSlots]);

  const [slots, setSlots] = useState<AssignedSlot[]>(() =>
    initialSlots.filter(s => availableSlots.some(as => as.day === s.day && as.hour === s.hour))
  );
  const [weeklyHours, setWeeklyHours] = useState(initialSlots.length > 0 ? Math.max(initialSlots.length, 1) : 1);
  const [objetivo, setObjetivo] = useState('');
  const [plan, setPlan] = useState('');
  const [notes, setNotes] = useState('');
  const [startDate, setStartDate] = useState('');
  const [success, setSuccess] = useState(false);
  const [resultAssignment, setResultAssignment] = useState<Assignment | null>(null);
  const [duplicateStudent, setDuplicateStudent] = useState<Student | null>(null);
  const [checkingEmail, setCheckingEmail] = useState(false);

  useEffect(() => {
    setSlots(prev => prev.length > weeklyHours ? prev.slice(0, weeklyHours) : prev);
  }, [weeklyHours]);

  // Email del alumno actual (existente seleccionado o nuevo tipeado).
  const currentEmail = (tab === 'existing'
    ? (existingStudents.find(s => s.id === selectedExisting)?.email ?? '')
    : newStudent.email).trim().toLowerCase();

  // Autocompletado desde WooCommerce + tabla students.
  const autofill = useStudentAutofill(currentEmail);
  const { woo, detection } = autofill;
  const detecting = autofill.loading;
  const productInfo = woo ? { fullName: woo.productFullName, productType: woo.productType } : null;

  // Precarga de campos al llegar datos nuevos (cuando cambia el email). Nombre y
  // fecha solo se rellenan si están vacíos, para no pisar ediciones manuales.
  useEffect(() => {
    if (detection?.confidence === 'high' && detection.hours != null) {
      setWeeklyHours(Math.min(5, Math.max(1, detection.hours)));
    }
    if (tab === 'new') {
      if (autofill.name)  setNewStudent(p => (p.name.trim() ? p : { ...p, name: autofill.name! }));
      if (autofill.level) setNewStudent(p => ({ ...p, level: autofill.level! }));
    }
    if (autofill.startDate) setStartDate(prev => prev || autofill.startDate!);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autofill.name, autofill.level, autofill.startDate, autofill.detection, tab]);

  function addSlot() {
    const used = new Set(slots.map(s => `${s.day}_${s.hour}`));
    const next = availableSlots.find(as => !used.has(`${as.day}_${as.hour}`));
    if (next) setSlots(prev => [...prev, next]);
  }
  function removeSlot(i: number) { setSlots(prev => prev.filter((_, idx) => idx !== i)); }
  function updateSlotValue(i: number, key: string) {
    const [day, hour] = key.split('_');
    setSlots(prev => prev.map((s, idx) => idx === i ? { day, hour } : s));
  }

  const selectedStudent = tab === 'existing' ? existingStudents.find(s => s.id === selectedExisting) : null;
  const studentName  = tab === 'existing' ? (selectedStudent?.name  ?? '') : newStudent.name;
  const studentLevel = tab === 'existing' ? (selectedStudent?.level ?? '') : newStudent.level;
  // El email tiene que ser válido de verdad: es la clave de cruce con Woo y la
  // dirección a la que va el formulario inicial.
  const hasStudent = tab === 'existing'
    ? !!selectedExisting
    : (!!newStudent.name.trim() && isValidEmail(newStudent.email));
  const slotsComplete = slots.length === weeklyHours;
  const canConfirm = hasStudent && slotsComplete && availableSlots.length > 0 && !!startDate;

  async function handleConfirm() {
    if (!canConfirm) return;

    // Prevención: ¿el alumno ya tiene profesor? Se comprueba por id, email y
    // nombre, tanto para un alumno existente como para uno "nuevo" que en
    // realidad ya estaba dado de alta.
    const identidad = tab === 'existing'
      ? (() => { const s = existingStudents.find(x => x.id === selectedExisting); return { studentId: s?.id, email: s?.email, name: s?.name }; })()
      : { email: newStudent.email, name: newStudent.name };
    const otros = findOtherTeacherAssignments(identidad, allAssignments, teacher.id);
    if (otros.length > 0) { setYaAsignado(otros); return; }

    // Check for duplicate email when creating new student
    if (tab === 'new' && newStudent.email.trim()) {
      setCheckingEmail(true);
      const existing = await dbCheckStudentExists(newStudent.email.trim());
      setCheckingEmail(false);
      if (existing) {
        setDuplicateStudent(existing);
        return;
      }
    }

    doConfirm();
  }

  function doConfirm(overrideStudent?: Student) {
    // El plan a persistir es el producto real de WooCommerce si se detectó.
    const effectivePlan = productInfo?.fullName || plan;
    const student: Student = overrideStudent ?? (tab === 'existing'
      ? existingStudents.find(s => s.id === selectedExisting)!
      : { id: `s_${Date.now()}`, name: newStudent.name, email: newStudent.email, level: newStudent.level, plan: effectivePlan, createdAt: new Date().toISOString() });

    const assignment: Assignment = {
      id: `a_${Date.now()}`,
      teacherId: teacher.id,
      teacherName: teacher.name,
      teacherEmail: teacher.email,
      studentId: student.id,
      studentName: student.name,
      studentEmail: student.email,
      studentLevel: student.level,
      slots,
      objetivo,
      plan: effectivePlan,
      weeklyHours,
      availability: '',
      notes,
      startDate,
      createdAt: new Date().toISOString(),
    };
    setResultAssignment(assignment);
    onConfirm(assignment, student);
    setSuccess(true);
    // Persistir tipo/nombre de producto en el alumno (best-effort).
    if (productInfo?.fullName) {
      dbSetStudentProduct(student.id, (productInfo.productType as 'subscription' | 'one_time' | null) ?? null, productInfo.fullName).catch(() => {});
    }
  }

  if (success && resultAssignment) {
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 18, width: '100%', maxWidth: 480, padding: 28, textAlign: 'center' }}>
          <div style={{ fontSize: 52, marginBottom: 14 }}>✅</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>¡Clase asignada!</div>
          <div style={{ color: 'var(--text-secondary)', fontSize: 14, marginBottom: 4 }}>
            <b>{studentName}</b> → <b>{teacher.name}</b>
          </div>
          <div style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 6 }}>
            {slots.map(s => `${s.day} ${s.hour} 🇪🇸`).join(' · ')}
          </div>
          <div style={{ fontSize: 13, color: '#1E9E3A', fontWeight: 600, marginBottom: 4 }}>
            📌 Horario recurrente — se repite todas las semanas
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 13, fontWeight: 600, marginBottom: 24 }}>
            {weeklyHours}h/semana · {plan}
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <button onClick={onClose} style={{ padding: '10px 20px', borderRadius: 9, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13 }}>Cerrar</button>
            <EmailTrigger assignment={resultAssignment} />
          </div>
        </div>
      </div>
    );
  }

  return (<>
    <div className="modal-cover" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-sheet" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 18, width: '100%', maxWidth: 560, maxHeight: '94vh', overflowY: 'auto', padding: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 19, color: 'var(--text-primary)' }}>Asignar clase</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 3 }}>👨‍🏫 {teacher.name}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 22, cursor: 'pointer' }}>✕</button>
        </div>

        {/* Recurrente note */}
        <div style={{ background: 'rgba(30,158,58,0.07)', border: '1px solid rgba(30,158,58,0.25)', borderRadius: 9, padding: '8px 14px', marginBottom: 16, fontSize: 12, color: '#167a2d', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>📌</span>
          <span><b>Horario recurrente:</b> Este horario se repetirá todas las semanas de forma permanente.</span>
        </div>

        <div style={{ display: 'flex', marginBottom: 18, background: 'var(--bg-surface-2)', borderRadius: 9, padding: 3 }}>
          {(['existing', 'new'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{ flex: 1, padding: '8px 10px', borderRadius: 7, border: 'none', background: tab === t ? 'var(--bg-surface-3)' : 'transparent', color: tab === t ? 'var(--text-primary)' : 'var(--text-secondary)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              {t === 'existing' ? `👤 Existente (${existingStudents.length})` : '✨ Nuevo alumno'}
            </button>
          ))}
        </div>

        {tab === 'existing' && (
          <div style={{ marginBottom: 18 }}>
            <label>Seleccionar alumno</label>
            <select value={selectedExisting} onChange={e => setSelectedExisting(e.target.value)}>
              <option value="">Elegir alumno...</option>
              {existingStudents.map(s => <option key={s.id} value={s.id}>{s.name} — {s.level}</option>)}
            </select>
          </div>
        )}

        {tab === 'new' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 18 }}>
            <div><label>Nombre completo *</label><input value={newStudent.name} onChange={e => setNewStudent(p => ({ ...p, name: e.target.value }))} placeholder="Ej: María González" autoFocus /></div>
            <div>
              <label>Email *</label>
              <input type="email" value={newStudent.email} onChange={e => setNewStudent(p => ({ ...p, email: e.target.value }))} placeholder="maria@gmail.com" />
              {/* Sin esto, el botón se quedaba desactivado sin explicar por qué. */}
              {newStudent.email.trim() !== '' && !isValidEmail(newStudent.email) && (
                <div style={{ fontSize: 11.5, color: '#c2410c', marginTop: 4 }}>
                  Revisa el email: hace falta uno válido para cruzarlo con WooCommerce y enviarle el formulario.
                </div>
              )}
            </div>
            <div><label>Nivel</label>
              <select value={newStudent.level} onChange={e => setNewStudent(p => ({ ...p, level: e.target.value }))}>
                {LEVELS.map(l => <option key={l}>{l}</option>)}
              </select>
            </div>
          </div>
        )}

        {/* Resumen de autocompletado (WooCommerce + tabla students) */}
        {(detecting || autofill.existing || productInfo?.fullName) && (
          <div style={{ marginBottom: 14, marginTop: -6 }}>
            <StudentAutofillCard data={autofill} currentLevel={studentLevel} />
          </div>
        )}

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            Horas semanales
            {detection?.source && (
              <span title={`Detectado desde: ${detection.source}`} style={{ cursor: 'help', fontSize: 12, opacity: 0.7 }}>ℹ️</span>
            )}
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            {WEEKLY_HOURS.map(h => (
              <button key={h} onClick={() => setWeeklyHours(h)} style={{
                flex: 1, padding: '9px 0', borderRadius: 9,
                border: `1.5px solid ${weeklyHours === h ? '#1E9E3A' : 'var(--border)'}`,
                background: weeklyHours === h ? 'rgba(30,158,58,0.1)' : 'var(--bg-surface-2)',
                color: weeklyHours === h ? '#1E9E3A' : 'var(--text-secondary)',
                fontWeight: weeklyHours === h ? 700 : 400,
                fontSize: 15, cursor: 'pointer',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
              }}>
                <span style={{ fontSize: 17 }}>{h}</span>
                <span style={{ fontSize: 9 }}>h/sem</span>
              </button>
            ))}
          </div>
          {detection && (
            <div style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.4, color: detection.confidence === 'high' ? '#1E9E3A' : '#ea580c' }}>
              {detection.confidence === 'high'
                ? `✅ ${detection.source} — puedes editarlo si es incorrecto`
                : detection.message}
            </div>
          )}
        </div>

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Horarios asignados</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: slotsComplete ? '#1E9E3A' : slots.length > 0 ? '#f59e0b' : 'var(--text-muted)' }}>
                {slots.length} de {weeklyHours} horario{weeklyHours !== 1 ? 's' : ''}
              </span>
              {slots.length < weeklyHours && availableSlots.length > slots.length && (
                <button onClick={addSlot} style={{ padding: '4px 10px', borderRadius: 8, border: '1px solid rgba(30,158,58,0.3)', background: 'rgba(30,158,58,0.08)', color: '#1E9E3A', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                  + Agregar
                </button>
              )}
            </div>
          </div>

          {availableSlots.length === 0 ? (
            <div style={{ padding: '14px', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 9, fontSize: 13, color: '#ef4444', textAlign: 'center' }}>
              Este profesor no tiene horarios disponibles en su calendario.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {slots.length === 0 && (
                <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '10px 0', textAlign: 'center' }}>
                  Seleccioná {weeklyHours} horario{weeklyHours !== 1 ? 's' : ''} libre{weeklyHours !== 1 ? 's' : ''} del profesor.
                </div>
              )}
              {slots.map((slot, i) => {
                const currentKey = `${slot.day}_${slot.hour}`;
                const usedKeys = new Set(slots.filter((_, idx) => idx !== i).map(s => `${s.day}_${s.hour}`));
                const options = availableSlots.filter(as => {
                  const k = `${as.day}_${as.hour}`;
                  return k === currentKey || !usedKeys.has(k);
                });
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-surface-2)', borderRadius: 9, padding: '8px 12px', border: '1px solid var(--border)' }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 22, flexShrink: 0 }}>#{i + 1}</span>
                    <select value={currentKey} onChange={e => updateSlotValue(i, e.target.value)} style={{ flex: 1 }}>
                      {options.map(as => {
                        const k = `${as.day}_${as.hour}`;
                        return <option key={k} value={k}>{as.day} {as.hour} 🇪🇸 · Todas las semanas</option>;
                      })}
                    </select>
                    <button onClick={() => removeSlot(i)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18, padding: '0 4px', flexShrink: 0 }}>✕</button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 16 }}>
          <div><label>Plan</label>
            <select value={plan} onChange={e => setPlan(e.target.value)}>
              <option value="">Seleccionar plan...</option>
              {PLANES.map(p => <option key={p}>{p}</option>)}
            </select>
            {productInfo?.fullName && (
              <div style={{ fontSize: 11.5, color: '#1E9E3A', marginTop: 5, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span>📦 Se usará: <b>{productInfo.fullName}</b></span>
                {autofill.classification && (
                  <span style={{ fontSize: 10.5, fontWeight: 700, padding: '1px 7px', borderRadius: 9, background: planBadgeStyle(autofill.classification.type).bg, color: planBadgeStyle(autofill.classification.type).color }}>
                    {autofill.classification.badge}
                  </span>
                )}
              </div>
            )}
          </div>
          <div><label>Objetivo</label>
            <select value={objetivo} onChange={e => setObjetivo(e.target.value)}>
              <option value="">Seleccionar objetivo...</option>
              {OBJETIVOS.map(o => <option key={o}>{o}</option>)}
            </select>
          </div>
          <div><label>Notas internas</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Info adicional sobre el alumno..." rows={2} style={{ resize: 'vertical' }} />
          </div>
          <div><label>Fecha de inicio *</label>
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ maxWidth: 200 }} />
            {currentEmail.includes('@') && !detecting && (
              autofill.startDate
                ? <div style={{ fontSize: 11.5, color: '#1E9E3A', marginTop: 4 }}>📅 Detectada desde WooCommerce — inicio de suscripción</div>
                : <div style={{ fontSize: 11.5, color: '#ea580c', marginTop: 4 }}>⚠️ Fecha no detectada — completá manualmente</div>
            )}
          </div>
        </div>

        <div style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border)', borderRadius: 9, padding: '10px 14px', marginBottom: 16, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>Resumen</div>
          <div>👤 {studentName || '—'} ({studentLevel}) · 👨‍🏫 {teacher.name}</div>
          {slots.length > 0 && <div>📅 {slots.map(s => `${s.day} ${s.hour}`).join(' · ')} 🇪🇸 · <span style={{ color: '#1E9E3A', fontWeight: 600 }}>recurrente</span></div>}
          <div>⏱ {weeklyHours}h/semana {plan && `· ${plan}`}</div>
          {objetivo && <div>🎯 {objetivo}</div>}
          {startDate && (
            <div>📆 Inicio: {fmtDate(startDate)} · Renovación: {fmtDate(addDays(startDate, 30))}</div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose} style={{ flex: 1, padding: '11px', borderRadius: 9, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 14 }}>Cancelar</button>
          <button onClick={handleConfirm} disabled={!canConfirm || checkingEmail} style={{ flex: 2, padding: '11px', borderRadius: 9, border: 'none', background: canConfirm && !checkingEmail ? '#1E9E3A' : 'var(--bg-surface-3)', color: canConfirm && !checkingEmail ? 'white' : 'var(--text-muted)', cursor: canConfirm && !checkingEmail ? 'pointer' : 'not-allowed', fontSize: 14, fontWeight: 700 }}>
            {checkingEmail ? 'Verificando...' : !hasStudent ? 'Elegí un alumno primero' : !slotsComplete ? `Faltan ${weeklyHours - slots.length} horario${weeklyHours - slots.length !== 1 ? 's' : ''}` : !startDate ? 'Ingresá la fecha de inicio' : 'Confirmar asignación ✓'}
          </button>
        </div>
      </div>
    </div>

    {/* Duplicate-teacher warning (punto 4) */}
    {yaAsignado && (
      <AlumnoYaAsignadoModal
        studentName={studentName}
        targetTeacherName={teacher.name}
        matches={yaAsignado}
        onMove={async () => {
          // Mover = quitar las asignaciones anteriores (libera sus calendarios) y
          // seguir con la creación normal de la nueva.
          for (const m of yaAsignado) {
            await removeAssignment(m.assignmentId, m.teacherId, m.studentName, m.slots);
          }
          setYaAsignado(null);
          doConfirm();
        }}
        onKeepBoth={() => { setYaAsignado(null); doConfirm(); }}
        onCancel={() => setYaAsignado(null)}
      />
    )}

    {/* Duplicate email modal */}
    {duplicateStudent && (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)', zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
        <div style={{ background: 'var(--bg-surface)', border: '1px solid #35405a', borderRadius: 14, padding: 24, width: '100%', maxWidth: 400 }}>
          <div style={{ fontSize: 24, marginBottom: 10 }}>⚠️</div>
          <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 8 }}>Este alumno ya existe</div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20, lineHeight: 1.6 }}>
            Ya hay un alumno con el email <b>{duplicateStudent.email}</b>:<br />
            <b style={{ color: 'var(--text-primary)' }}>{duplicateStudent.name}</b> · {duplicateStudent.level}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button
              onClick={() => { setDuplicateStudent(null); setTab('existing'); setSelectedExisting(duplicateStudent.id); }}
              style={{ padding: '10px', borderRadius: 8, border: 'none', background: '#1E9E3A', color: 'white', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
              Usar alumno existente
            </button>
            <button
              onClick={() => { setDuplicateStudent(null); doConfirm(); }}
              style={{ padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
              Crear de todas formas (duplicado)
            </button>
            <button
              onClick={() => setDuplicateStudent(null)}
              style={{ padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
              Cancelar
            </button>
          </div>
        </div>
      </div>
    )}
  </>
  );
}

// ─── Teacher Calendar Modal ───────────────────────────────────────────────────
function TeacherCalendarModal({
  teacher, highlightSlots, existingStudents, onClose, onAssigned,
}: {
  teacher: Teacher;
  highlightSlots: AssignedSlot[];
  existingStudents: Student[];
  onClose: () => void;
  onAssigned: (a: Assignment, s: Student) => void;
}) {
  const { updateTeacherGrid, getTeacherGrid } = useTeachers();
  const baseGrid = useMemo(() => buildGridFromTeacher(teacher.timeSlots, teacher.upcomingClasses), [teacher]);
  const [grid, setGrid] = useState<Grid>(baseGrid);
  const [loadingGrid, setLoadingGrid] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [assignCell, setAssignCell] = useState<AssignedSlot | null>(null);

  useEffect(() => {
    // force=true: leer la disponibilidad viva del profesor, no un snapshot
    // cacheado. Así aparecen los slots que el profesor acaba de marcar libre.
    getTeacherGrid(teacher.id, true).then(g => {
      setGrid(Object.keys(g).length > 0 ? g : baseGrid);
      setLoadingGrid(false);
    });
  }, [teacher.id]);

  function handleGridChange(g: Grid) {
    setGrid(g);
    updateTeacherGrid(teacher.id, g);
  }

  return (
    <div className="modal-cover" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(6px)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}
      onClick={e => { if (e.target === e.currentTarget && !assignCell) onClose(); }}>
      <div className="modal-sheet" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 18, width: '100%', maxWidth: 940, maxHeight: '94vh', overflowY: 'auto', padding: 26 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 42, height: 42, borderRadius: '50%', background: 'rgba(30,158,58,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 15, color: '#1E9E3A' }}>{teacher.avatar}</div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 17, color: 'var(--text-primary)' }}>Calendario de {teacher.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {editMode ? '✏️ Modo edición: clic en cualquier celda para cambiar estado' : '🟢 Clic en celda libre → formulario de asignación · Horario recurrente'}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={() => setEditMode(m => !m)}
              style={{ padding: '7px 14px', borderRadius: 8, border: `1px solid ${editMode ? 'rgba(245,158,11,0.5)' : 'var(--border)'}`, background: editMode ? 'rgba(245,158,11,0.1)' : 'transparent', color: editMode ? '#f59e0b' : 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
              {editMode ? '✏️ Editando' : '✏️ Modo edición'}
            </button>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 22, cursor: 'pointer' }}>✕</button>
          </div>
        </div>

        {highlightSlots.length > 0 && (
          <div style={{ marginBottom: 12, padding: '8px 14px', background: 'rgba(30,158,58,0.06)', border: '1px solid rgba(30,158,58,0.2)', borderRadius: 9, fontSize: 13, color: '#1E9E3A' }}>
            🔍 Buscando: {highlightSlots.map(s => `${s.day} ${s.hour}`).join(' · ')}
          </div>
        )}

        {loadingGrid ? (
          <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-muted)' }}>Cargando calendario...</div>
        ) : editMode ? (
          <VisualCalendar mode="teacher" grid={grid} onGridChange={handleGridChange} highlightSlots={highlightSlots} />
        ) : (
          <VisualCalendar mode="setter" grid={grid} onCellClick={(day, hour) => setAssignCell({ day, hour })} highlightSlots={highlightSlots} />
        )}
      </div>

      {assignCell && (
        <AssignModal
          teacher={teacher}
          initialSlots={[assignCell]}
          teacherGrid={grid}
          existingStudents={existingStudents}
          onClose={() => setAssignCell(null)}
          onConfirm={(a, s) => {
            let updated = { ...grid };
            a.slots.forEach(sl => {
              // withBaseState: no borra una recuperación puntual de esa semana.
              const key = cellKey(sl.day, sl.hour);
              updated = { ...updated, [key]: withBaseState(updated[key], 'ocupado', s.name) };
            });
            handleGridChange(updated);
            setAssignCell(null);
            onAssigned(a, s);
          }}
        />
      )}
    </div>
  );
}

// ─── Agenda Semanal ───────────────────────────────────────────────────────────
function AgendaSemanal({ assignments }: { assignments: Assignment[] }) {
  const [weekOffset, setWeekOffset] = useState(0);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const weekDates = getWeekDates(weekOffset);
  const weekLabel = formatWeekRange(weekDates);

  const MONTH_NAMES_SHORT = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

  // Generate all classes for the current week based on recurring assignments
  const weekClasses = useMemo(() => {
    const classes: Array<{
      id: string;
      day: string;
      date: Date;
      dateLabel: string;
      hour: string;
      studentName: string;
      teacherName: string;
      plan: string;
      level: string;
    }> = [];

    for (const a of assignments) {
      for (const slot of a.slots) {
        const dayIdx = DAY_INDEX[slot.day];
        if (dayIdx === undefined) continue;
        const date = weekDates[dayIdx];
        classes.push({
          id: `${a.id}_${slot.day}_${slot.hour}`,
          day: slot.day,
          date,
          dateLabel: `${slot.day} ${date.getDate()} ${MONTH_NAMES_SHORT[date.getMonth()]}`,
          hour: slot.hour,
          studentName: a.studentName,
          teacherName: a.teacherName,
          plan: a.plan,
          level: a.studentLevel,
        });
      }
    }

    return classes.sort((a, b) => {
      const dayDiff = (DAY_INDEX[a.day] ?? 0) - (DAY_INDEX[b.day] ?? 0);
      return dayDiff !== 0 ? dayDiff : a.hour.localeCompare(b.hour);
    });
  }, [assignments, weekOffset]);

  const dayFilters = weekDates.map((date, i) => ({
    day: Object.keys(DAY_INDEX)[i],
    label: `${Object.keys(DAY_INDEX)[i].substring(0, 3)} ${date.getDate()}`,
    count: weekClasses.filter(c => c.day === Object.keys(DAY_INDEX)[i]).length,
  }));

  const filtered = selectedDay ? weekClasses.filter(c => c.day === selectedDay) : weekClasses;

  return (
    <div>
      {/* Week nav */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 18px' }}>
        <button onClick={() => setWeekOffset(o => o - 1)} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 7, padding: '5px 14px', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 16 }}>‹</button>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>Agenda — {weekLabel}</div>
          <div style={{ fontSize: 11, color: '#1E9E3A', marginTop: 2 }}>{weekClasses.length} clase{weekClasses.length !== 1 ? 's' : ''} esta semana</div>
        </div>
        <button onClick={() => setWeekOffset(o => o + 1)} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 7, padding: '5px 14px', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 16 }}>›</button>
      </div>

      {/* Day filters */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        <button onClick={() => setSelectedDay(null)} style={{ padding: '6px 14px', borderRadius: 20, border: `1px solid ${selectedDay === null ? '#1E9E3A' : 'var(--border)'}`, background: selectedDay === null ? 'rgba(30,158,58,0.1)' : 'transparent', color: selectedDay === null ? '#1E9E3A' : 'var(--text-secondary)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
          Todos ({weekClasses.length})
        </button>
        {dayFilters.map(df => (
          <button key={df.day} onClick={() => setSelectedDay(df.day === selectedDay ? null : df.day)} style={{ padding: '6px 14px', borderRadius: 20, border: `1px solid ${selectedDay === df.day ? '#1E9E3A' : 'var(--border)'}`, background: selectedDay === df.day ? 'rgba(30,158,58,0.1)' : 'transparent', color: selectedDay === df.day ? '#1E9E3A' : 'var(--text-secondary)', fontSize: 12, fontWeight: df.count > 0 ? 600 : 400, cursor: 'pointer' }}>
            {df.label} {df.count > 0 && <span style={{ background: df.count > 0 ? '#1E9E3A' : 'var(--bg-surface-3)', color: df.count > 0 ? 'white' : 'var(--text-muted)', borderRadius: 10, padding: '1px 6px', fontSize: 10, marginLeft: 4 }}>{df.count}</span>}
          </button>
        ))}
      </div>

      {/* Classes list */}
      {filtered.length === 0 ? (
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '48px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
          <div style={{ fontSize: 32, marginBottom: 10 }}>📅</div>
          Sin clases {selectedDay ? `el ${selectedDay}` : 'esta semana'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.map(cls => (
            <div key={cls.id} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 11, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 90, textAlign: 'center', background: 'rgba(30,158,58,0.08)', borderRadius: 8, padding: '6px 10px', flexShrink: 0 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#1E9E3A' }}>{cls.dateLabel}</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{cls.hour}</div>
              </div>
              <div style={{ flex: 1, minWidth: 120 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>👤 {cls.studentName}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>👨‍🏫 {cls.teacherName} · {cls.level}</div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{cls.plan}</div>
              <div style={{ fontSize: 10, color: '#1E9E3A', fontWeight: 600, background: 'rgba(30,158,58,0.08)', padding: '3px 8px', borderRadius: 10 }}>📌 Recurrente</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Vincular Modal (reparar vínculo roto manualmente) ────────────────────────
function VincularModal({
  student, teachers, assignments, onClose, onRepaired, onCreateNew,
}: {
  student: Student;
  teachers: Teacher[];
  assignments: Assignment[];
  onClose: () => void;
  onRepaired: (msg: string) => Promise<void> | void;
  onCreateNew: (teacher: Teacher) => void;
}) {
  const [search, setSearch] = useState('');
  const [selectedTeacher, setSelectedTeacher] = useState<Teacher | null>(null);
  const [teacherAssignments, setTeacherAssignments] = useState<Assignment[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [repairing, setRepairing] = useState(false);

  const filteredTeachers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return teachers.filter(t => !q || t.name.toLowerCase().includes(q) || t.email.toLowerCase().includes(q));
  }, [teachers, search]);

  const studentCount = (t: Teacher) => assignments.filter(a => a.teacherId === t.id).length;

  async function selectTeacher(t: Teacher) {
    setSelectedTeacher(t);
    setTeacherAssignments(null);
    setLoading(true);
    try { setTeacherAssignments(await dbGetAssignmentsByTeacher(t.id)); }
    catch { setTeacherAssignments([]); }
    finally { setLoading(false); }
  }

  async function useAssignment(a: Assignment) {
    setRepairing(true);
    try {
      // Asegurar que el alumno exista en `students`, luego reparar el vínculo.
      await dbUpsertStudent(student);
      await dbRepairStudentLink(student.id, student.email, student.name, a.id);
      await onRepaired('✅ Vínculo reparado correctamente');
    } finally { setRepairing(false); }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 18, width: '100%', maxWidth: 520, maxHeight: '92vh', overflowY: 'auto', padding: 26 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 18, color: 'var(--text-primary)' }}>🔗 Vincular alumno</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 3 }}>{student.name} · {student.email}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 22, cursor: 'pointer' }}>✕</button>
        </div>

        <div style={{ background: 'rgba(255,196,0,0.08)', border: '1px solid rgba(255,196,0,0.35)', borderRadius: 9, padding: '9px 13px', marginBottom: 16, fontSize: 12, color: '#8a6d00', lineHeight: 1.5 }}>
          Usá esta opción si el alumno <b>ya tiene una asignación en Supabase</b> pero aparece como "sin asignar" por un vínculo roto. Seleccioná el profesor y reparalo.
        </div>

        {/* PASO 1 — Seleccionar profesor */}
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>1 · Seleccionar profesor</div>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar profesor por nombre..." style={{ width: '100%', marginBottom: 10 }} />
        <div style={{ maxHeight: 210, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 18 }}>
          {filteredTeachers.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', padding: '14px 0' }}>Ningún profesor coincide.</div>
          ) : filteredTeachers.map(t => {
            const active = selectedTeacher?.id === t.id;
            return (
              <button key={t.id} onClick={() => selectTeacher(t)}
                style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 12px', borderRadius: 10, border: `1.5px solid ${active ? '#1E9E3A' : 'var(--border)'}`, background: active ? 'rgba(30,158,58,0.08)' : 'var(--bg-surface-2)', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>
                <div style={{ width: 34, height: 34, borderRadius: '50%', background: active ? 'rgba(30,158,58,0.15)' : 'var(--bg-surface-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: active ? '#1E9E3A' : 'var(--text-secondary)', flexShrink: 0 }}>{t.avatar}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--text-primary)' }}>{t.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{studentCount(t)} alumno{studentCount(t) !== 1 ? 's' : ''} · {t.email}</div>
                </div>
                {active && <span style={{ color: '#1E9E3A', fontSize: 16 }}>✓</span>}
              </button>
            );
          })}
        </div>

        {/* PASO 2 — Asignaciones existentes del profesor */}
        {selectedTeacher && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>2 · Asignaciones de {selectedTeacher.name}</div>
            {loading ? (
              <div style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', padding: '16px 0' }}><span className="drc-spinner-xs" /> Buscando asignaciones...</div>
            ) : (teacherAssignments && teacherAssignments.length > 0) ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {teacherAssignments.map(a => (
                  <div key={a.id} style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '11px 14px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 150 }}>
                      <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--text-primary)' }}>{a.studentName}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>
                        {a.slots.map(sl => `${sl.day} ${sl.hour}`).join(' · ') || '—'}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                        {a.startDate ? `Inicio: ${fmtDate(a.startDate)}` : 'Sin fecha de inicio'}{a.studentEmail ? ` · ${a.studentEmail}` : ''}
                      </div>
                    </div>
                    <button onClick={() => useAssignment(a)} disabled={repairing}
                      style={{ padding: '8px 14px', borderRadius: 8, border: 'none', background: repairing ? 'var(--bg-surface-3)' : '#1E9E3A', color: repairing ? 'var(--text-muted)' : 'white', fontWeight: 700, fontSize: 12.5, cursor: repairing ? 'not-allowed' : 'pointer', flexShrink: 0 }}>
                      {repairing ? 'Reparando...' : 'Usar esta asignación'}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ background: 'var(--bg-surface-2)', border: '1px dashed var(--border)', borderRadius: 10, padding: '16px', textAlign: 'center' }}>
                <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>No se encontraron asignaciones previas para este profesor</div>
                <button onClick={() => onCreateNew(selectedTeacher)}
                  style={{ padding: '9px 18px', borderRadius: 8, border: 'none', background: '#1E9E3A', color: 'white', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                  Crear nueva asignación
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Carga la grilla del profesor y abre el AssignModal precargado con el alumno.
function LinkCreateAssign({
  teacher, student, existingStudents, onClose, onAssigned,
}: {
  teacher: Teacher;
  student: Student;
  existingStudents: Student[];
  onClose: () => void;
  onAssigned: (a: Assignment, s: Student) => void;
}) {
  const { getTeacherGrid } = useTeachers();
  const baseGrid = useMemo(() => buildGridFromTeacher(teacher.timeSlots, teacher.upcomingClasses), [teacher]);
  const [grid, setGrid] = useState<Grid | null>(null);

  useEffect(() => {
    getTeacherGrid(teacher.id, true).then(g => setGrid(Object.keys(g).length > 0 ? g : baseGrid));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teacher.id]);

  if (!grid) {
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: 'white', fontSize: 14 }}>Cargando calendario...</div>
      </div>
    );
  }

  return (
    <AssignModal
      teacher={teacher}
      initialSlots={[]}
      teacherGrid={grid}
      existingStudents={existingStudents}
      initialStudentId={student.id}
      onClose={onClose}
      onConfirm={onAssigned}
    />
  );
}

// ─── Setter Content ───────────────────────────────────────────────────────────
function SetterContent() {
  const { teachers, students, assignments, unassignedStudents, addStudent, addAssignment, reloadAll } = useTeachers();

  const [searchMode, setSearchMode] = useState<'dayhour' | 'day' | 'hour'>('dayhour');
  const [dayOnly, setDayOnly] = useState('Lunes');
  const [hourOnly, setHourOnly] = useState('18:00');
  const [slotFilters, setSlotFilters] = useState<SlotFilter[]>([]);
  const [onlyAvailable, setOnlyAvailable] = useState(false);
  const [searchName, setSearchName] = useState('');
  const [specialtyFilter, setSpecialtyFilter] = useState<string>('');
  const [calendarTeacher, setCalendarTeacher] = useState<Teacher | null>(null);
  const [emailAssignment, setEmailAssignment] = useState<Assignment | null>(null);
  const [activeTab, setActiveTab] = useState<'search' | 'unassigned' | 'agenda' | 'history'>('search');

  // Vinculación manual de alumnos "sin asignar".
  const [linkStudent, setLinkStudent] = useState<Student | null>(null);
  const [createAssign, setCreateAssign] = useState<{ teacher: Teacher; student: Student } | null>(null);
  const [changeTeacherAsg, setChangeTeacherAsg] = useState<Assignment | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [brokenLinks, setBrokenLinks] = useState<Record<string, Assignment>>({});
  const [verifying, setVerifying] = useState(false);
  const [repairingAll, setRepairingAll] = useState(false);
  const [formIndex, setFormIndex] = useState<FormIndex>({ byId: new Map(), byName: new Map() });
  const refreshFormIndex = () => { fetchFormTokensIndex().then(setFormIndex).catch(() => {}); };
  useEffect(() => { refreshFormIndex(); }, []);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(t => (t === msg ? null : t)), 3500);
  }

  // Diagnóstico: busca, para cada alumno sin asignar, una assignment cuyo
  // student_email coincida (aunque el student_id difiera) → vínculo roto.
  async function verifyBrokenLinks() {
    setVerifying(true);
    try {
      const all = await dbGetAssignments();
      const byEmail = new Map<string, Assignment>();
      for (const a of all) {
        const k = (a.studentEmail ?? '').trim().toLowerCase();
        if (k && !byEmail.has(k)) byEmail.set(k, a);
      }
      const found: Record<string, Assignment> = {};
      for (const s of unassignedStudents) {
        const k = (s.email ?? '').trim().toLowerCase();
        const hit = k ? byEmail.get(k) : undefined;
        if (hit) found[s.id] = hit;
      }
      setBrokenLinks(found);
      const n = Object.keys(found).length;
      showToast(n > 0 ? `⚠️ ${n} vínculo${n !== 1 ? 's' : ''} roto${n !== 1 ? 's' : ''} encontrado${n !== 1 ? 's' : ''}` : '✅ No se encontraron vínculos rotos');
    } finally {
      setVerifying(false);
    }
  }

  async function repairOne(student: Student, a: Assignment) {
    await dbRepairStudentLink(student.id, student.email, student.name, a.id);
    await reloadAll();
    setBrokenLinks(prev => { const n = { ...prev }; delete n[student.id]; return n; });
    showToast('✅ Vínculo reparado correctamente');
  }

  async function repairAll() {
    setRepairingAll(true);
    try {
      const n = await dbRepairAllBrokenLinks();
      await reloadAll();
      setBrokenLinks({});
      showToast(`✅ ${n} vínculo${n !== 1 ? 's' : ''} reparado${n !== 1 ? 's' : ''}`);
    } finally {
      setRepairingAll(false);
    }
  }

  async function handleLinkRepaired(msg: string) {
    await reloadAll();
    setLinkStudent(null);
    showToast(msg);
  }

  // Estado de suscripción de los alumnos SIN ASIGNAR. Sin esto, el setter podía
  // asignarle profesor a alguien que ya había cancelado: el badge existía en el
  // panel de Alumnos y en las clases del profesor, pero no aquí, que es justo
  // donde se toma la decisión de asignar.
  const [subs, setSubs] = useState<Record<string, SubscriptionInfo>>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // De a poco (5 en 5) para no disparar 40 peticiones a Woo de golpe.
      const pendientes = unassignedStudents.filter(s => s.email && !subs[s.email.trim().toLowerCase()]);
      for (let i = 0; i < pendientes.length; i += 5) {
        const lote = pendientes.slice(i, i + 5);
        const res = await Promise.all(lote.map(async s => [s.email.trim().toLowerCase(), await checkSubscription(s.email)] as const));
        if (cancelled) return;
        setSubs(prev => ({ ...prev, ...Object.fromEntries(res) }));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unassignedStudents.length]);

  // Ocupación de los calendarios (Tipo B: alumno en grid sin assignment).
  const [gridOccupancy, setGridOccupancy] = useState<GridOccupancy[]>([]);
  const [createLinkFor, setCreateLinkFor] = useState<{ student: Student; occ: GridOccupancy; teacher: Teacher } | null>(null);

  function refreshOccupancy() {
    dbGetAllGridOccupancy().then(setGridOccupancy).catch(() => {});
  }
  useEffect(() => { refreshOccupancy(); }, [unassignedStudents.length]);

  const occByName = useMemo(() => {
    const m = new Map<string, GridOccupancy>();
    for (const o of gridOccupancy) {
      const k = o.studentName.trim().toLowerCase();
      if (!m.has(k)) m.set(k, o);
    }
    return m;
  }, [gridOccupancy]);

  // Tipo B: el alumno aparece en el grid de un profesor pero no tiene assignment.
  function typeBFor(s: Student): { occ: GridOccupancy; teacher: Teacher } | null {
    const occ = occByName.get(s.name.trim().toLowerCase());
    if (!occ) return null;
    const teacher = teachers.find(t => t.id === occ.teacherId);
    if (!teacher) return null;
    return { occ, teacher };
  }

  async function handleCreateLinkDone(msg: string) {
    setCreateLinkFor(null);
    await reloadAll();
    refreshOccupancy();
    showToast(msg);
  }

  function addSlotFilter() {
    setSlotFilters(prev => [...prev, { id: Date.now().toString(), day: 'Lunes', hour: '14:00' }]);
  }
  function removeSlotFilter(id: string) {
    setSlotFilters(prev => prev.filter(f => f.id !== id));
  }
  function updateSlotFilter(id: string, field: 'day' | 'hour', value: string) {
    setSlotFilters(prev => prev.map(f => f.id === id ? { ...f, [field]: value } : f));
  }

  // A searched slot counts as available if the teacher's real grid cell (from
  // teacher_calendars) admite un alumno recurrente. libreCells holds those exact
  // `${day}_${hour}` keys — NOT a min-max range — so 'ocupado' / 'no_work' cells
  // between free hours never match. Una celda "En recuperación" SÍ matchea: es una
  // clase puntual de una semana, el horario de fondo sigue libre (ver lib/cells).
  const teacherHasAllSlots = (t: Teacher) =>
    slotFilters.every(sf => (t.libreCells ?? []).includes(`${sf.day}_${sf.hour}`));

  // Avisos para los horarios que están libres pero tienen una recuperación puntual
  // en una semana concreta.
  const puntualNotes = (t: Teacher, slots: Array<{ day: string; hour: string }>) =>
    slots
      .map(sf => {
        const date = (t.puntualCells ?? {})[`${sf.day}_${sf.hour}`];
        return date
          ? `${sf.day} ${sf.hour}: disponible — tiene una recuperación puntual el ${formatPuntualDate(date)}, el resto de semanas es libre`
          : null;
      })
      .filter((n): n is string => n !== null);

  // Horarios en juego según el modo de búsqueda activo, para los avisos de arriba.
  const searchedSlots = (t: Teacher): Array<{ day: string; hour: string }> => {
    if (searchMode === 'day')  return freeHoursOnDay(t, dayOnly).map(h => ({ day: dayOnly, hour: h }));
    if (searchMode === 'hour') return freeDaysAtHour(t, hourOnly).map(d => ({ day: d, hour: hourOnly }));
    return slotFilters.map(sf => ({ day: sf.day, hour: sf.hour }));
  };

  // Horas libres de un profesor un día dado (modo "Solo por día").
  const freeHoursOnDay = (t: Teacher, day: string) =>
    (t.libreCells ?? []).filter(k => k.split('_')[0] === day).map(k => k.split('_')[1])
      .sort((a, b) => parseInt(a) - parseInt(b));
  // Días libres de un profesor a una hora dada (modo "Solo por hora").
  const freeDaysAtHour = (t: Teacher, hour: string) => {
    const set = new Set((t.libreCells ?? []).filter(k => k.split('_')[1] === hour).map(k => k.split('_')[0]));
    return daysOfWeek.filter(d => set.has(d));
  };

  const filtered = useMemo(() => {
    // Filtros comunes a todos los modos: cupos, nombre, especialidad.
    const base = teachers.filter(t => {
      if (onlyAvailable && t.status !== 'available' && t.status !== 'almost_full') return false;
      if (searchName && !t.name.toLowerCase().includes(searchName.toLowerCase())) return false;
      if (specialtyFilter && !(t.specialties ?? []).includes(specialtyFilter)) return false;
      return true;
    });
    if (searchMode === 'day') {
      return base.filter(t => freeHoursOnDay(t, dayOnly).length > 0)
        .sort((a, b) => freeHoursOnDay(b, dayOnly).length - freeHoursOnDay(a, dayOnly).length);
    }
    if (searchMode === 'hour') {
      return base.filter(t => freeDaysAtHour(t, hourOnly).length > 0)
        .sort((a, b) => freeDaysAtHour(b, hourOnly).length - freeDaysAtHour(a, hourOnly).length);
    }
    return base.filter(t => slotFilters.length === 0 || teacherHasAllSlots(t));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teachers, onlyAvailable, searchName, specialtyFilter, slotFilters, searchMode, dayOnly, hourOnly]);

  // Recomendado: el primero de la lista (ya ordenada) que pueda recibir alumnos.
  const recommended = useMemo(() => {
    if (searchMode === 'day' || searchMode === 'hour') {
      return filtered.find(t => !t.isBlocked && t.status === 'available' && t.freeSpots > 0);
    }
    return filtered.find(t =>
      !t.isBlocked && t.status === 'available' &&
      t.freeSpots >= Math.max(slotFilters.length, 1) &&
      (slotFilters.length === 0 || teacherHasAllSlots(t))
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, searchMode, slotFilters]);

  // Celdas a resaltar en el calendario del profesor que se está viendo.
  const highlightSlots = useMemo<AssignedSlot[]>(() => {
    if (searchMode === 'day' && calendarTeacher) return freeHoursOnDay(calendarTeacher, dayOnly).map(h => ({ day: dayOnly, hour: h }));
    if (searchMode === 'hour' && calendarTeacher) return freeDaysAtHour(calendarTeacher, hourOnly).map(d => ({ day: d, hour: hourOnly }));
    return slotFilters.map(sf => ({ day: sf.day, hour: sf.hour }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchMode, calendarTeacher, dayOnly, hourOnly, slotFilters]);

  async function handleAssigned(a: Assignment, s: Student) {
    // El alumno PRIMERO (la assignment tiene FK a students), y con manejo de
    // error: si el guardado falla, no seguimos como si se hubiera asignado.
    try {
      await addStudent(s);
      await addAssignment(a);
    } catch (e) {
      console.error('[setter handleAssigned] no se pudo asignar:', e);
      alert('No se pudo guardar la asignación: ' + (e instanceof Error ? e.message : String(e)));
      return;
    }
    setCalendarTeacher(null);
    setEmailAssignment(a);
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }}>
      <NavBar />
      <PullToRefresh onRefresh={reloadAll}>
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '28px 20px' }}>
        <LastUpdated />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 4px' }}>Setter</h1>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>Asigná alumnos a profesores disponibles.</p>
          </div>
          <div style={{ display: 'flex', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 9, padding: 3, gap: 3, flexWrap: 'wrap' }}>
            {(['search', 'unassigned', 'agenda', 'history'] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)} style={{ padding: '7px 16px', borderRadius: 7, border: 'none', background: activeTab === tab ? '#1E9E3A' : 'transparent', color: activeTab === tab ? 'white' : 'var(--text-secondary)', fontSize: 13, fontWeight: activeTab === tab ? 700 : 500, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {tab === 'search' ? '🔍 Buscar'
                  : tab === 'unassigned' ? '📋 Sin asignar'
                  : tab === 'agenda' ? '📅 Agenda'
                  : `📋 Historial (${assignments.length})`}
                {tab === 'unassigned' && unassignedStudents.length > 0 && (
                  <span style={{ background: activeTab === tab ? 'rgba(255,255,255,0.25)' : '#ef4444', color: 'white', borderRadius: 10, padding: '0 7px', fontSize: 11, fontWeight: 700, minWidth: 18, textAlign: 'center' }}>
                    {unassignedStudents.length}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {activeTab === 'search' && (<>
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '20px 22px', marginBottom: 22 }}>
            <div style={{ marginBottom: 18 }}>
              <label>Buscar por nombre de profesor</label>
              <input value={searchName} onChange={e => setSearchName(e.target.value)} placeholder="Ej: Silvia, Sebastian..." style={{ maxWidth: 280 }} />
            </div>

            {/* Selector de modo de búsqueda */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', marginBottom: 8, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Tipo de búsqueda</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {([
                  ['dayhour', '📅 Día + Hora específica'],
                  ['day',     '📆 Solo por día'],
                  ['hour',    '🕐 Solo por hora'],
                ] as const).map(([m, label]) => {
                  const active = searchMode === m;
                  return (
                    <button key={m} onClick={() => setSearchMode(m)}
                      style={{ padding: '7px 14px', borderRadius: 20, border: `1.5px solid ${active ? '#1E9E3A' : 'var(--border)'}`, background: active ? 'rgba(30,158,58,0.1)' : 'transparent', color: active ? '#1E9E3A' : 'var(--text-secondary)', cursor: 'pointer', fontSize: 12.5, fontWeight: active ? 700 : 500, fontFamily: 'inherit' }}>
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* MODO 1 — Día + Hora específica */}
            {searchMode === 'dayhour' && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <label style={{ margin: 0 }}>
                    Filtrar por horarios
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 8, textTransform: 'none', letterSpacing: 0 }}>(opcional)</span>
                  </label>
                  <button onClick={addSlotFilter} style={{ padding: '5px 12px', borderRadius: 8, border: '1px solid rgba(30,158,58,0.3)', background: 'rgba(30,158,58,0.08)', color: '#1E9E3A', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>+ Agregar horario</button>
                </div>

                {slotFilters.length === 0 ? (
                  <div style={{ padding: '12px 16px', border: '1px dashed var(--border)', borderRadius: 9, fontSize: 13, color: 'var(--text-muted)', textAlign: 'center' }}>
                    Sin filtros — mostrando todos los profesores
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {slotFilters.map((sf, idx) => (
                      <div key={sf.id} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg-surface-2)', borderRadius: 10, padding: '10px 14px', border: '1px solid var(--border)', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', minWidth: 64 }}>Horario {idx + 1}</span>
                        <select value={sf.day} onChange={e => updateSlotFilter(sf.id, 'day', e.target.value)} style={{ flex: '1 1 110px', minWidth: 100 }}>
                          {daysOfWeek.map(d => <option key={d}>{d}</option>)}
                        </select>
                        <select value={sf.hour} onChange={e => updateSlotFilter(sf.id, 'hour', e.target.value)} style={{ flex: '1 1 90px', minWidth: 80 }}>
                          {HOURS_ES.map(h => <option key={h} value={h}>{h} 🇪🇸</option>)}
                        </select>
                        <button onClick={() => removeSlotFilter(sf.id)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18, padding: '0 4px' }}>✕</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* MODO 2 — Solo por día */}
            {searchMode === 'day' && (
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', marginBottom: 8, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Día</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {daysOfWeek.map(d => {
                    const active = dayOnly === d;
                    return (
                      <button key={d} onClick={() => setDayOnly(d)}
                        style={{ padding: '6px 14px', borderRadius: 20, border: `1.5px solid ${active ? '#1E9E3A' : 'var(--border)'}`, background: active ? 'rgba(30,158,58,0.1)' : 'transparent', color: active ? '#1E9E3A' : 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, fontWeight: active ? 700 : 500, fontFamily: 'inherit' }}>
                        {d}
                      </button>
                    );
                  })}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 8 }}>Profesores con al menos una hora libre el {dayOnly}, ordenados por cantidad de horas libres.</div>
              </div>
            )}

            {/* MODO 3 — Solo por hora */}
            {searchMode === 'hour' && (
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', marginBottom: 8, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Hora 🇪🇸</label>
                <select value={hourOnly} onChange={e => setHourOnly(e.target.value)} style={{ maxWidth: 170 }}>
                  {HOURS_ES.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 8 }}>Profesores con la hora {hourOnly} libre en cualquier día, ordenados por cantidad de días libres.</div>
              </div>
            )}

            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', marginBottom: 8, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Especialidad
                <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 8, textTransform: 'none', letterSpacing: 0 }}>(opcional)</span>
              </label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {(['', ...ALL_SPECIALTIES] as string[]).map(sp => {
                  const active = specialtyFilter === sp;
                  const st = sp ? SPECIALTY_STYLE[sp] : null;
                  return (
                    <button key={sp || 'all'} onClick={() => setSpecialtyFilter(sp)}
                      style={{ padding: '5px 14px', borderRadius: 20, border: `1.5px solid ${active ? (st?.border ?? '#1E9E3A') : 'var(--border)'}`, background: active ? (st?.bg ?? 'rgba(30,158,58,0.1)') : 'transparent', color: active ? (st?.color ?? '#1E9E3A') : 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, fontWeight: active ? 700 : 500, fontFamily: 'inherit' }}>
                      {sp || 'Todas'}
                    </button>
                  );
                })}
              </div>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', margin: 0, fontSize: 13, color: 'var(--text-secondary)', textTransform: 'none', letterSpacing: 0 }}>
              <input type="checkbox" checked={onlyAvailable} onChange={e => setOnlyAvailable(e.target.checked)} style={{ width: 'auto', margin: 0 }} />
              Solo profesores con cupos disponibles
            </label>
          </div>

          {/* Recommended */}
          {recommended && (
            <div style={{ background: 'rgba(30,158,58,0.06)', border: '1px solid rgba(30,158,58,0.25)', borderRadius: 12, padding: '14px 18px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 22 }}>⭐</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#1E9E3A', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Recomendado</div>
                {searchMode === 'day' ? (() => {
                  const hrs = freeHoursOnDay(recommended, dayOnly);
                  return (<>
                    <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>{recommended.name} — {hrs.length} horario{hrs.length !== 1 ? 's' : ''} libre{hrs.length !== 1 ? 's' : ''} el {dayOnly}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{hrs.join(', ')}</div>
                  </>);
                })() : searchMode === 'hour' ? (() => {
                  const dys = freeDaysAtHour(recommended, hourOnly);
                  return (<>
                    <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>{recommended.name} — Libre a las {hourOnly} en {dys.length} día{dys.length !== 1 ? 's' : ''}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{dys.join(', ')}</div>
                  </>);
                })() : (<>
                  <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>{recommended.name} — {recommended.freeSpots} cupos libres</div>
                  {slotFilters.length > 0 && (() => {
                    const freeSearched = slotFilters.filter(sf => (recommended.libreCells ?? []).includes(`${sf.day}_${sf.hour}`));
                    return freeSearched.length > 0 && <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Disponible en: {freeSearched.map(sf => `${sf.day} ${sf.hour}`).join(' · ')}</div>;
                  })()}
                </>)}
                {puntualNotes(recommended, searchedSlots(recommended)).map(note => (
                  <div key={note} style={{ fontSize: 11, color: '#f59e0b', fontWeight: 600, marginTop: 4 }}>♻️ {note}</div>
                ))}
              </div>
              <button onClick={() => setCalendarTeacher(recommended)} style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: '#1E9E3A', color: 'white', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>📅 Ver calendario →</button>
            </div>
          )}

          <div style={{ fontSize: 13, color: 'var(--text-secondary)', fontWeight: 600, marginBottom: 10 }}>
            {filtered.length} profesor{filtered.length !== 1 ? 'es' : ''}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {filtered.length === 0 ? (
              <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '48px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
                Ningún profesor coincide con los filtros aplicados.
              </div>
            ) : filtered.map(t => {
              const loadPct = t.maxWeeklyLoad > 0 ? Math.round((t.weeklyLoad / t.maxWeeklyLoad) * 100) : 0;
              const loadColor = loadPct >= 90 ? '#ef4444' : loadPct >= 65 ? '#f59e0b' : '#1E9E3A';
              const isBlocked = t.isBlocked ?? false;

              return (
                <div key={t.id} style={{ background: 'var(--bg-surface)', border: `1px solid ${isBlocked ? 'rgba(239,68,68,0.25)' : 'var(--border)'}`, borderRadius: 12, padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', opacity: isBlocked ? 0.85 : 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: '1 1 150px' }}>
                    <div style={{ width: 36, height: 36, borderRadius: '50%', background: isBlocked ? 'rgba(239,68,68,0.1)' : 'var(--bg-surface-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: isBlocked ? '#ef4444' : 'var(--text-secondary)', flexShrink: 0 }}>{t.avatar}</div>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>{t.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{t.email}</div>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {(t.specialties ?? []).map(sp => <SpecialtyChip key={sp} specialty={sp} />)}
                      </div>
                      {searchMode === 'day' && (
                        <div style={{ fontSize: 11, color: '#1E9E3A', fontWeight: 600, marginTop: 5 }}>
                          🕐 Libre el {dayOnly}: {freeHoursOnDay(t, dayOnly).join(', ') || '—'}
                        </div>
                      )}
                      {searchMode === 'hour' && (
                        <div style={{ fontSize: 11, color: '#1E9E3A', fontWeight: 600, marginTop: 5 }}>
                          📆 Libre a las {hourOnly}: {freeDaysAtHour(t, hourOnly).join(', ') || '—'}
                        </div>
                      )}
                      {puntualNotes(t, searchedSlots(t)).map(note => (
                        <div key={note} style={{ fontSize: 11, color: '#f59e0b', fontWeight: 600, marginTop: 4 }}>
                          ♻️ {note}
                        </div>
                      ))}
                    </div>
                  </div>

                  {isBlocked ? (
                    <span style={{ padding: '3px 10px', borderRadius: 20, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.35)', color: '#ef4444', fontSize: 11, fontWeight: 700 }}>
                      🔴 Bloqueado
                    </span>
                  ) : (
                    <StatusBadge status={t.status} />
                  )}

                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: isBlocked ? '#ef4444' : t.freeSpots > 0 ? '#1E9E3A' : 'var(--text-muted)' }}>{t.freeSpots}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>cupos</div>
                  </div>

                  <div style={{ flex: '1 1 110px', minWidth: 100 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}><span>Carga</span><span>{t.weeklyLoad}h</span></div>
                    <div style={{ height: 5, borderRadius: 3, background: 'var(--bg-surface-3)' }}>
                      <div style={{ width: `${loadPct}%`, height: '100%', borderRadius: 3, background: loadColor }} />
                    </div>
                  </div>

                  {isBlocked ? (
                    <div style={{ position: 'relative' }}>
                      <button
                        disabled
                        title="Profesor bloqueado por baja retención"
                        style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: 'rgba(239,68,68,0.1)', color: '#ef4444', fontWeight: 700, fontSize: 12, cursor: 'not-allowed', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5 }}>
                        🔴 No disponible
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => setCalendarTeacher(t)} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#1E9E3A', color: 'white', fontWeight: 700, fontSize: 13, cursor: 'pointer', flexShrink: 0 }}>
                      📅 Ver calendario
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </>)}

        {activeTab === 'unassigned' && (
          <div>
            <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' }}>📋 Alumnos sin asignar</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
                  Alumnos registrados que todavía no tienen ningún profesor asignado. Ordenados por antigüedad.
                </div>
              </div>
              {unassignedStudents.length > 0 && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button onClick={verifyBrokenLinks} disabled={verifying}
                    style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-surface-2)', color: 'var(--text-primary)', fontWeight: 600, fontSize: 12.5, cursor: verifying ? 'not-allowed' : 'pointer' }}>
                    {verifying ? 'Verificando...' : '🔍 Verificar vínculos rotos'}
                  </button>
                  {Object.keys(brokenLinks).length > 0 && (
                    <button onClick={repairAll} disabled={repairingAll}
                      style={{ padding: '8px 14px', borderRadius: 8, border: 'none', background: '#FFC400', color: '#1a1a1a', fontWeight: 700, fontSize: 12.5, cursor: repairingAll ? 'not-allowed' : 'pointer' }}>
                      {repairingAll ? 'Reparando...' : `🔧 Reparar todos (${Object.keys(brokenLinks).length})`}
                    </button>
                  )}
                </div>
              )}
            </div>

            {unassignedStudents.length === 0 ? (
              <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '48px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
                <div style={{ fontSize: 32, marginBottom: 10 }}>✅</div>
                Todos los alumnos tienen profesor asignado.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[...unassignedStudents]
                  .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
                  .map(s => {
                    const daysWaiting = Math.floor((Date.now() - new Date(s.createdAt).getTime()) / 86400000);
                    const urgent = daysWaiting > 3;
                    const broken = brokenLinks[s.id];
                    const tb = !broken ? typeBFor(s) : null; // Tipo B: en calendario sin assignment
                    const borderColor = broken ? 'rgba(234,88,12,0.4)' : tb ? 'rgba(255,196,0,0.5)' : urgent ? 'rgba(239,68,68,0.3)' : 'var(--border)';
                    return (
                      <div key={s.id} style={{ background: 'var(--bg-surface)', border: `1px solid ${borderColor}`, borderRadius: 12, padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                        <div style={{ width: 40, height: 40, borderRadius: '50%', background: urgent ? 'rgba(239,68,68,0.1)' : 'var(--bg-surface-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 700, color: urgent ? '#ef4444' : 'var(--text-secondary)', flexShrink: 0 }}>
                          {s.name.charAt(0).toUpperCase()}
                        </div>
                        <div style={{ flex: 1, minWidth: 140 }}>
                          <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>{s.name}</div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 1 }}>{s.email}</div>
                          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                            <span>Plan: <b>{s.plan || '—'}</b> · Nivel: <b>{s.level}</b></span>
                            {(() => {
                              const b = subBadge(subs[(s.email ?? '').trim().toLowerCase()]);
                              return (
                                <span style={{ padding: '2px 9px', borderRadius: 20, fontSize: 11, fontWeight: 700, color: b.color, background: b.bg, whiteSpace: 'nowrap' }}>
                                  {b.spin ? 'Verificando…' : b.label}
                                </span>
                              );
                            })()}
                          </div>
                          {tb ? (
                            <div style={{ fontSize: 11, color: '#8a6d00', marginTop: 2 }}>
                              📅 En el calendario de <b>{tb.teacher.name}</b>: {tb.occ.slots.map(sl => `${sl.day} ${sl.hour}`).join(' · ')}
                            </div>
                          ) : (
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                              Registrado hace {daysWaiting} día{daysWaiting !== 1 ? 's' : ''}
                            </div>
                          )}
                        </div>
                        {broken ? (
                          <span style={{ padding: '3px 10px', borderRadius: 20, background: 'rgba(234,88,12,0.1)', border: '1px solid rgba(234,88,12,0.4)', color: '#ea580c', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
                            ⚠️ Vínculo roto — tiene asignación
                          </span>
                        ) : tb ? (
                          <span style={{ padding: '3px 10px', borderRadius: 20, background: 'rgba(255,196,0,0.12)', border: '1px solid rgba(255,196,0,0.5)', color: '#8a6d00', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
                            🟡 En calendario sin assignment
                          </span>
                        ) : (
                          <span style={{ padding: '3px 10px', borderRadius: 20, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.35)', color: '#ef4444', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
                            🔴 {urgent ? `${daysWaiting} días sin asignar` : 'Sin profesor asignado'}
                          </span>
                        )}
                        <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
                          {broken && (
                            <button onClick={() => repairOne(s, broken)}
                              style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#FFC400', color: '#1a1a1a', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                              🔧 Reparar
                            </button>
                          )}
                          {tb && (
                            <button onClick={() => setCreateLinkFor({ student: s, occ: tb.occ, teacher: tb.teacher })}
                              style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#FFC400', color: '#1a1a1a', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                              🔗 Crear vínculo
                            </button>
                          )}
                          <button onClick={() => { setSearchName(''); setSpecialtyFilter(''); setActiveTab('search'); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                            style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#1E9E3A', color: 'white', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                            Asignar profesor →
                          </button>
                          <button onClick={() => setLinkStudent(s)}
                            style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-surface-2)', color: 'var(--text-primary)', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                            🔗 Vincular
                          </button>
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
        )}

        {activeTab === 'agenda' && (
          <AgendaSemanal assignments={assignments} />
        )}

        {activeTab === 'history' && (
          <div>
            {assignments.length === 0 ? (
              <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '48px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
                <div style={{ fontSize: 32, marginBottom: 10 }}>📋</div>
                Todavía no hay asignaciones registradas.
              </div>
            ) : assignments.map(a => (
              <div key={a.id} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 18px', marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>{a.studentName}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                    👨‍🏫 {a.teacherName} · {a.slots.map(s => `${s.day} ${s.hour}`).join(' · ')} 🇪🇸 · <span style={{ color: '#1E9E3A', fontWeight: 600 }}>Recurrente</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    ⏱ {a.weeklyHours}h/sem · {a.plan} {a.objetivo && `· 🎯 ${a.objetivo}`}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {new Date(a.createdAt).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <button onClick={() => setChangeTeacherAsg(a)}
                    style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-surface-2)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
                    🔄 Cambiar profesor
                  </button>
                  <EmailTrigger assignment={a} />
                  <FormStatusBadge
                    student={{ id: a.studentId, name: a.studentName, email: a.studentEmail }}
                    teacher={{ id: a.teacherId, name: a.teacherName }}
                    assignment={{ id: a.id, plan: a.plan, level: a.studentLevel }}
                    info={lookupToken(formIndex, { id: a.studentId, name: a.studentName })}
                    onRefresh={refreshFormIndex}
                    compact
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {calendarTeacher && (
        <TeacherCalendarModal
          teacher={calendarTeacher}
          highlightSlots={highlightSlots}
          existingStudents={students}
          onClose={() => setCalendarTeacher(null)}
          onAssigned={handleAssigned}
        />
      )}

      {emailAssignment && <AssignmentEmailModal assignment={emailAssignment} onClose={() => setEmailAssignment(null)} />}

      {changeTeacherAsg && (
        <CambiarProfesorModal
          student={{ id: changeTeacherAsg.studentId, name: changeTeacherAsg.studentName, email: changeTeacherAsg.studentEmail, level: changeTeacherAsg.studentLevel }}
          currentAssignment={changeTeacherAsg}
          onClose={() => setChangeTeacherAsg(null)}
          onDone={(msg) => { setChangeTeacherAsg(null); showToast(msg); }}
        />
      )}

      {linkStudent && (
        <VincularModal
          student={linkStudent}
          teachers={teachers}
          assignments={assignments}
          onClose={() => setLinkStudent(null)}
          onRepaired={handleLinkRepaired}
          onCreateNew={(t) => { setCreateAssign({ teacher: t, student: linkStudent }); setLinkStudent(null); }}
        />
      )}

      {createAssign && (
        <LinkCreateAssign
          teacher={createAssign.teacher}
          student={createAssign.student}
          existingStudents={students}
          onClose={() => setCreateAssign(null)}
          onAssigned={(a, s) => { handleAssigned(a, s); setCreateAssign(null); }}
        />
      )}

      {createLinkFor && (
        <CrearVinculoModal
          studentName={createLinkFor.student.name}
          teacher={createLinkFor.teacher}
          slots={createLinkFor.occ.slots}
          defaultEmail={createLinkFor.student.email}
          defaultLevel={createLinkFor.student.level}
          defaultPlan={createLinkFor.student.plan || 'Inglés general'}
          onClose={() => setCreateLinkFor(null)}
          onDone={handleCreateLinkDone}
        />
      )}

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 90, background: 'var(--text-primary)', color: 'var(--bg-surface)', padding: '11px 20px', borderRadius: 10, fontSize: 13.5, fontWeight: 600, boxShadow: '0 6px 24px rgba(0,0,0,0.25)', maxWidth: '90vw', textAlign: 'center' }}>
          {toast}
        </div>
      )}
      </PullToRefresh>
    </div>
  );
}

export default function SetterPage() {
  return (
    <AuthGuard allowedRoles={['setter', 'admin']}>
      <SetterContent />
    </AuthGuard>
  );
}
