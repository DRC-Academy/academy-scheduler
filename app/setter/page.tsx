'use client';
import { useState, useMemo, useEffect, useRef } from 'react';
import { NavBar } from '@/components/NavBar';
import { StatusBadge } from '@/components/StatusBadge';
import { Badge } from '@/components/ui';
import { Search, Clock } from 'lucide-react';
import { AuthGuard } from '@/components/AuthGuard';
import { PullToRefresh } from '@/components/PullToRefresh';
import { LastUpdated } from '@/components/LastUpdated';
import { VisualCalendar, buildGridFromTeacher, cellKey, getWeekDates, formatWeekRange } from '@/components/VisualCalendar';
import { dbCheckStudentExists, dbSetStudentProduct, dbGetAssignmentsByTeacher, dbGetAssignments, dbUpsertStudent, dbRepairStudentLink, dbRepairAllBrokenLinks, dbGetAllGridOccupancy, GridOccupancy } from '@/lib/db';
import { CrearVinculoModal } from '@/components/CrearVinculoModal';
import { CambiarProfesorModal } from '@/components/CambiarProfesorModal';
import { AssignmentEmailModal } from '@/components/AssignmentEmailModal';
import { StudentAutofillCard } from '@/components/StudentAutofillCard';
import { useStudentAutofill, orderPaidLabel } from '@/lib/useStudentAutofill';
import { planBadgeStyle, addCalendarMonths } from '@/lib/productUtils';
import { isFixedTermProgram, assignmentProgramDecision } from '@/lib/planOrders';
import { madridToday } from '@/lib/subscriptionAccess';
import { useAuth } from '@/lib/AuthContext';
import { adminFetch } from '@/lib/adminSessionClient';
import { formatPuntualDate, isAssignableCell, withBaseState } from '@/lib/cells';
import { useTeachers } from '@/lib/TeachersContext';
import { Teacher, Grid, Assignment, Student, AssignedSlot } from '@/types';
import { ALL_SPECIALTIES } from '@/lib/specialties';
import {
  searchTeachers, pickRecommended, activeSelection, SEARCH_DAYS, DAY_SHORT, DEFAULT_STATUSES,
  type SearchMode, type Coverage, type SortKey, type FilterStatus, type TeacherMatch,
} from '@/lib/setterSearch';
import FormStatusBadge from '@/components/FormStatusBadge';
import { fetchFormTokensIndex, lookupToken, type FormTokenInfo } from '@/lib/formClient';
import { isValidEmail } from '@/lib/validation';
import AlumnoYaAsignadoModal from '@/components/AlumnoYaAsignadoModal';
import { useGridSaver, conflictMessage, calendarErrorMessage } from '@/lib/useGridSaver';
import CalendarLoadError from '@/components/CalendarLoadError';
import { findOtherTeacherAssignments, type ExistingAssignmentMatch } from '@/lib/assignmentGuard';
import { checkSubscription, subBadge, type SubscriptionInfo } from '@/lib/useSubscriptionStatus';

type FormIndex = { byId: Map<string, FormTokenInfo>; byName: Map<string, FormTokenInfo> };

// ─── Specialty chips ──────────────────────────────────────────────────────────
// Esta pantalla sí colorea la especialidad (el resto de la app usa el chip
// neutro de components/ui): el setter escanea la lista buscando "Niños" o
// "Exámenes" y el color le ahorra leer cada fila. Inglés lo tienen todos → gris.
const SPECIALTY_CLASS: Record<string, string> = {
  Adultos: 'is-adultos', Niños: 'is-ninos', Exámenes: 'is-examenes', Teens: 'is-teens',
};

function SpecialtyChip({ specialty }: { specialty: string }) {
  return <span className={`stx-spec ${SPECIALTY_CLASS[specialty] ?? ''}`}>{specialty}</span>;
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

// ─── Programa de pago único (oferta nueva) ────────────────────────────────────
// Lo que el modal de asignación pide activar al confirmar. Viaja con la
// asignación hasta handleAssigned, que lo manda DESPUÉS de guardar el alumno y
// la asignación (el alumno nuevo tiene que existir en la base).
type ProgramActivation = {
  productId: number;
  orderId: number | null;
  start: string;
  /** Fin editado a mano (solo lo guarda un admin); null = inicio + meses del plan. */
  until: string | null;
};

/**
 * Activa el programa en el servidor (app/api/asignacion/programa). Devuelve el
 * texto a mostrar si algo no salió del todo bien, o null.
 */
async function activateProgram(
  act: ProgramActivation, studentId: string,
  creds: { username: string; password: string } | null,
): Promise<string | null> {
  try {
    const res = await adminFetch('/api/asignacion/programa', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ studentId, ...act }),
    }, creds);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return `Asignado, pero no se pudo activar el programa: ${j.error ?? `error ${res.status}`}`;
    const avisos = [j.warning, ...(j.warnings ?? [])].filter(Boolean);
    return avisos.length ? `Programa activado hasta el ${fmtDate(j.finalUntil)}.\n\n${avisos.join('\n')}` : null;
  } catch (e) {
    return `Asignado, pero no se pudo activar el programa: ${e instanceof Error ? e.message : String(e)}`;
  }
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
  onConfirm: (a: Assignment, s: Student, program?: ProgramActivation) => void;
}) {
  const { assignments: allAssignments, removeAssignment } = useTeachers();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
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
  // Fecha de fin del programa de pago único: sale sola de inicio + meses hasta
  // que se edita a mano (entonces se queda la editada aunque cambie el inicio).
  const [endDate, setEndDate] = useState('');
  const [endEdited, setEndEdited] = useState(false);
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

  // ── Oferta nueva: el tipo de plan sale del catálogo (por ID de producto) ──
  // Pago único con meses → fecha de fin; fraccionado → fin de la suscripción;
  // cualquier otro (mensual, plan antiguo, fuera del catálogo) → como siempre.
  const catalog = autofill.catalog;
  const oneTime = isFixedTermProgram(catalog) ? catalog : null;
  const fraccionado = catalog?.kind === 'fraccionado';
  const planUntil = oneTime && startDate ? addCalendarMonths(startDate, oneTime.months) : null;
  const shownEnd = endEdited ? endDate : (planUntil ?? '');
  // Un setter no puede guardar una fecha a mano: se guarda la del plan.
  const manualSaved = endEdited && isAdmin;
  const currentUntil = selectedStudent?.manualActiveUntil ?? autofill.existing?.manualActiveUntil ?? null;
  const program = oneTime && startDate
    ? assignmentProgramDecision({ product: oneTime, start: startDate, until: manualSaved ? endDate : null, currentUntil, today: madridToday() })
    : null;
  const endInvalid = !!oneTime && endEdited && (!endDate || (!!startDate && endDate <= startDate));
  function changeEnd(v: string) {
    setEndDate(v);
    setEndEdited(!!v && v !== planUntil);
  }
  // Otro alumno / otro plan: la fecha a mano del anterior no vale.
  useEffect(() => { setEndEdited(false); setEndDate(''); }, [oneTime?.id, currentEmail]);

  const canConfirm = hasStudent && slotsComplete && availableSlots.length > 0 && !!startDate && !endInvalid;

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
    const programAct: ProgramActivation | undefined = oneTime && program
      ? { productId: oneTime.id, orderId: autofill.woo?.orderId ?? null, start: startDate, until: manualSaved ? endDate : null }
      : undefined;
    onConfirm(assignment, student, programAct);
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
          {oneTime ? (
            // PROGRAMA DE PAGO ÚNICO: inicio (editable, precargado con la fecha de
            // pago) + fin = inicio + meses del plan, recalculado solo.
            <div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 160px', maxWidth: 220 }}><label>Fecha de inicio *</label>
                  <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
                  {orderPaidLabel(autofill, startDate) && (
                    <div style={{ fontSize: 11.5, color: '#1E9E3A', marginTop: 4 }}>📅 {orderPaidLabel(autofill, startDate)}</div>
                  )}
                </div>
                <div style={{ flex: '1 1 160px', maxWidth: 220 }}><label>Fecha de fin *</label>
                  <input type="date" value={shownEnd} onChange={e => changeEnd(e.target.value)} disabled={!startDate} />
                  {endEdited && planUntil && (
                    <div style={{ fontSize: 11.5, color: '#ea580c', marginTop: 4 }}>✏️ Fecha modificada a mano (por plan serían {fmtDate(planUntil)})</div>
                  )}
                  {!endEdited && planUntil && (
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>Inicio + {oneTime.months} meses del plan</div>
                  )}
                </div>
              </div>
              {endInvalid && (
                <div style={{ fontSize: 11.5, color: '#ef4444', marginTop: 6 }}>La fecha de fin tiene que ser posterior a la de inicio.</div>
              )}
              {endEdited && !isAdmin && planUntil && (
                <div style={{ fontSize: 11.5, color: '#c2410c', marginTop: 6 }}>
                  ⚠️ La fecha a mano solo la guarda un admin; se guardará la del plan ({fmtDate(planUntil)}).
                </div>
              )}
              {program?.warning && (
                <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 8, background: 'rgba(255,196,0,0.10)', border: '1px solid rgba(255,196,0,0.4)', fontSize: 12, color: '#8a6d00', lineHeight: 1.5 }}>
                  ⚠️ {program.warning}
                </div>
              )}
            </div>
          ) : (
            <div style={fraccionado ? { display: 'flex', gap: 12, flexWrap: 'wrap' } : undefined}>
              <div style={fraccionado ? { flex: '1 1 160px', maxWidth: 220 } : undefined}><label>Fecha de inicio *</label>
                <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ maxWidth: 200 }} />
                {currentEmail.includes('@') && !detecting && (
                  autofill.startDate
                    ? <div style={{ fontSize: 11.5, color: '#1E9E3A', marginTop: 4 }}>📅 Detectada desde WooCommerce — inicio de suscripción</div>
                    : <div style={{ fontSize: 11.5, color: '#ea580c', marginTop: 4 }}>⚠️ Fecha no detectada — completá manualmente</div>
                )}
              </div>
              {fraccionado && (
                // PROGRAMA FRACCIONADO: el fin es el de la suscripción de Woo (solo
                // lectura). El acceso lo sigue dando la suscripción.
                <div style={{ flex: '1 1 160px', maxWidth: 220 }}><label>Fecha de fin del programa</label>
                  <input type="date" value={autofill.woo?.programEndDate ?? ''} readOnly disabled />
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
                    {autofill.woo?.programEndDate ? 'Fin de la suscripción en WooCommerce' : 'Sin fecha de fin en WooCommerce'}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border)', borderRadius: 9, padding: '10px 14px', marginBottom: 16, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>Resumen</div>
          <div>👤 {studentName || '—'} ({studentLevel}) · 👨‍🏫 {teacher.name}</div>
          {slots.length > 0 && <div>📅 {slots.map(s => `${s.day} ${s.hour}`).join(' · ')} 🇪🇸 · <span style={{ color: '#1E9E3A', fontWeight: 600 }}>recurrente</span></div>}
          <div>⏱ {weeklyHours}h/semana {plan && `· ${plan}`}</div>
          {objetivo && <div>🎯 {objetivo}</div>}
          {startDate && (
            oneTime
              ? <div>📆 Inicio: {fmtDate(startDate)} · Fin del programa: {program ? fmtDate(program.requestedUntil) : '—'}</div>
              : fraccionado
                ? <div>📆 Inicio: {fmtDate(startDate)} · Próxima cuota: {autofill.woo?.nextPaymentDate ? fmtDate(autofill.woo.nextPaymentDate) : '—'} · Fin del programa: {autofill.woo?.programEndDate ? fmtDate(autofill.woo.programEndDate) : '—'}</div>
                : <div>📆 Inicio: {fmtDate(startDate)} · Renovación: {fmtDate(addDays(startDate, 30))}</div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose} style={{ flex: 1, padding: '11px', borderRadius: 9, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 14 }}>Cancelar</button>
          <button onClick={handleConfirm} disabled={!canConfirm || checkingEmail} style={{ flex: 2, padding: '11px', borderRadius: 9, border: 'none', background: canConfirm && !checkingEmail ? '#1E9E3A' : 'var(--bg-surface-3)', color: canConfirm && !checkingEmail ? 'white' : 'var(--text-muted)', cursor: canConfirm && !checkingEmail ? 'pointer' : 'not-allowed', fontSize: 14, fontWeight: 700 }}>
            {checkingEmail ? 'Verificando...' : !hasStudent ? 'Elegí un alumno primero' : !slotsComplete ? `Faltan ${weeklyHours - slots.length} horario${weeklyHours - slots.length !== 1 ? 's' : ''}` : !startDate ? 'Ingresá la fecha de inicio' : endInvalid ? 'Revisá la fecha de fin' : 'Confirmar asignación ✓'}
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
  onAssigned: (a: Assignment, s: Student, program?: ProgramActivation) => void;
}) {
  const { getTeacherGrid } = useTeachers();
  const baseGrid = useMemo(() => buildGridFromTeacher(teacher.timeSlots, teacher.upcomingClasses), [teacher]);
  const [grid, setGrid] = useState<Grid>(baseGrid);
  // Último grid conocido (lo de la base + clics en camino): el "antes" de cada
  // guardado por casillas. Si el profesor no tiene calendario todavía, arranca
  // vacío aunque en pantalla se vea el grid de muestra, así el primer guardado
  // lo escribe entero.
  const gridRef = useRef<Grid>({});
  const [loadingGrid, setLoadingGrid] = useState(true);
  const [gridError, setGridError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [editMode, setEditMode] = useState(false);
  const [assignCell, setAssignCell] = useState<AssignedSlot | null>(null);
  const saveGrid = useGridSaver('setter');

  useEffect(() => {
    // force=true: leer la disponibilidad viva del profesor, no un snapshot
    // cacheado. Así aparecen los slots que el profesor acaba de marcar libre.
    getTeacherGrid(teacher.id, true).then(g => {
      gridRef.current = g;
      setGridError(null);
      setGrid(Object.keys(g).length > 0 ? g : baseGrid);
    }).catch(err => setGridError(calendarErrorMessage(err)))
      .finally(() => setLoadingGrid(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teacher.id, reload]);

  async function handleGridChange(g: Grid) {
    const prev = gridRef.current;
    gridRef.current = g;
    setGrid(g);
    try {
      const r = await saveGrid(teacher.id, prev, g);
      if (r.idle) { gridRef.current = r.grid; setGrid(r.grid); }
      if (r.conflicts.length > 0) alert(conflictMessage(r.conflicts));
    } catch (err) {
      setGridError(calendarErrorMessage(err));
    }
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
        ) : gridError ? (
          <CalendarLoadError message={gridError} onRetry={() => { setGridError(null); setLoadingGrid(true); setReload(n => n + 1); }} />
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
          onConfirm={(a, s, program) => {
            let updated = { ...(Object.keys(gridRef.current).length > 0 ? gridRef.current : grid) };
            a.slots.forEach(sl => {
              // withBaseState: no borra una recuperación puntual de esa semana.
              const key = cellKey(sl.day, sl.hour);
              updated = { ...updated, [key]: withBaseState(updated[key], 'ocupado', s.name) };
            });
            handleGridChange(updated);
            setAssignCell(null);
            onAssigned(a, s, program);
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
//
// Al confirmar PINTA las casillas en el calendario del profesor. Hasta sep/2026
// no lo hacía: la ficha se creaba con sus horarios pero el alumno nunca aparecía
// en el calendario (probable origen del caso María do Mar Campos Souto).
function LinkCreateAssign({
  teacher, student, existingStudents, onClose, onAssigned,
}: {
  teacher: Teacher;
  student: Student;
  existingStudents: Student[];
  onClose: () => void;
  onAssigned: (a: Assignment, s: Student, program?: ProgramActivation) => void;
}) {
  const { getTeacherGrid } = useTeachers();
  const saveGrid = useGridSaver('setter');
  const baseGrid = useMemo(() => buildGridFromTeacher(teacher.timeSlots, teacher.upcomingClasses), [teacher]);
  const [grid, setGrid] = useState<Grid | null>(null);
  // Lo que hay de verdad en la base: el "antes" del guardado por casillas.
  const serverRef = useRef<Grid>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getTeacherGrid(teacher.id, true).then(g => {
      serverRef.current = g;
      setGrid(Object.keys(g).length > 0 ? g : baseGrid);
    }).catch(err => setError(calendarErrorMessage(err)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teacher.id]);

  async function confirm(a: Assignment, s: Student, program?: ProgramActivation) {
    const base = grid ?? {};
    let updated: Grid = { ...base };
    for (const sl of a.slots) {
      const key = cellKey(sl.day, sl.hour);
      updated = { ...updated, [key]: withBaseState(updated[key], 'ocupado', s.name) };
    }
    try {
      const r = await saveGrid(teacher.id, serverRef.current, updated);
      if (r.conflicts.length > 0) alert(conflictMessage(r.conflicts));
    } catch (err) {
      alert('No se pudo marcar el horario en el calendario del profesor, así que NO se creó la asignación.\n\n' + calendarErrorMessage(err));
      return;
    }
    onAssigned(a, s, program);
  }

  if (error) {
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
        <div style={{ maxWidth: 460, width: '100%' }}>
          <CalendarLoadError message={error} onRetry={onClose} />
        </div>
      </div>
    );
  }

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
      onConfirm={confirm}
    />
  );
}

// ─── Setter Content ───────────────────────────────────────────────────────────

/** Orden de la lista. 'suggested' es el orden que ya devolvía `filtered` — es el
 *  valor por defecto para que el rediseño no altere lo que se ve hoy. */
const SORT_LABELS: Record<SortKey, string> = {
  suggested: 'Sugerido',
  spots:     'Más cupos libres',
  load:      'Menos carga',
  name:      'Nombre (A–Z)',
};

const MODE_HINT: Record<SearchMode, string> = {
  dayhour: 'Cada día se combina con cada hora (ej. Lun 18:00, Mar 18:00…).',
  day:     'Profesores con algún hueco libre en los días elegidos.',
  hour:    'Profesores libres a esas horas, cualquier día.',
};

// Franjas horarias del selector de horas (hora de España). Madrugada va aparte
// porque casi nunca se usa: oculta por defecto salvo que tenga algo elegido.
const hh = (n: number) => `${String(n).padStart(2, '0')}:00`;
const hourBand = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => hh(from + i));
const HOUR_BANDS = [
  { key: 'madrugada', label: 'Madrugada', hours: hourBand(0, 6) },
  { key: 'manana',    label: 'Mañana',    hours: hourBand(7, 12) },
  { key: 'tarde',     label: 'Tarde',     hours: hourBand(13, 18) },
  { key: 'noche',     label: 'Noche',     hours: hourBand(19, 23) },
];

const STATUS_CHIPS: Array<{ value: FilterStatus; label: string; dot: string }> = [
  { value: 'available',   label: 'Disponible', dot: 'is-ok' },
  { value: 'almost_full', label: 'Casi lleno', dot: 'is-warn' },
  { value: 'busy',        label: 'Completo',   dot: 'is-danger' },
];

// Barra de carga semanal: verde < 45 %, ámbar 45–75 %, rojo desde 75 %.
const loadTone = (pct: number) => (pct >= 75 ? 'is-danger' : pct >= 45 ? 'is-warn' : 'is-ok');
const MAX_FRANJA_TAGS = 8;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function initials(name: string): string {
  // Solo palabras que empiezan con letra: "Sebastian (test)" → "S", no "S(".
  const parts = name.trim().split(/\s+/).filter(w => /^\p{L}/u.test(w));
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

function SetterContent() {
  const { teachers, students, assignments, unassignedStudents, addStudent, addAssignment, reloadAll } = useTeachers();
  const { user } = useAuth();

  const [searchMode, setSearchMode] = useState<SearchMode>('dayhour');
  const [days, setDays] = useState<string[]>([]);
  const [hours, setHours] = useState<string[]>([]);
  const [coverage, setCoverage] = useState<Coverage>('all');
  const [specialties, setSpecialties] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<FilterStatus[]>(DEFAULT_STATUSES);
  const [showMadrugada, setShowMadrugada] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey>('suggested');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [searchName, setSearchName] = useState('');
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

  // ── Selección (todos los selectores se encienden y se apagan al pulsarlos) ──
  const toggleIn = <V,>(list: V[], v: V) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v]);
  const toggleDay  = (d: string) => setDays(prev => toggleIn(prev, d));
  const toggleHour = (h: string) => setHours(prev => toggleIn(prev, h));
  // "Toda la franja" agrega las horas que falten; si ya estaban todas, las quita.
  function toggleBand(bandHours: string[]) {
    setHours(prev => bandHours.every(h => prev.includes(h))
      ? prev.filter(h => !bandHours.includes(h))
      : [...prev, ...bandHours.filter(h => !prev.includes(h))]);
  }
  const toggleSpecialty = (sp: string) => setSpecialties(prev => toggleIn(prev, sp));
  const toggleStatus = (st: FilterStatus) => setStatuses(prev => toggleIn(prev, st));

  const query = { mode: searchMode, days, hours, coverage, name: searchName, specialties, statuses };
  // Lo que de verdad cuenta: el bloque atenuado se ignora, y "Día + hora" con
  // solo días u horas se comporta como "Solo día" / "Solo hora".
  const sel = activeSelection(query);
  const totalFranjas = sel.mode === 'dayhour' ? sel.days.length * sel.hours.length
    : sel.mode === 'day' ? sel.days.length
    : sel.mode === 'hour' ? sel.hours.length : 0;

  const results = useMemo(
    () => searchTeachers(teachers, query, sortBy),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [teachers, searchMode, days, hours, coverage, searchName, specialties, statuses, sortBy],
  );
  const recommended = useMemo(() => pickRecommended(results), [results]);
  // "Libre en todas" sin nadie que cumpla: en vez de la mejor opción, se ofrece
  // pasar a "Alguna franja" con un toque.
  const nobodyCoversAll = coverage === 'all' && totalFranjas > 0 && results.length === 0;

  // Aviso para los horarios que están libres pero tienen una recuperación puntual
  // en una semana concreta. Un solo renglón por profesor (antes era uno por
  // horario y con varias franjas la fila se llenaba de avisos).
  const puntualNotes = (t: Teacher, slots: AssignedSlot[]): string[] => {
    const items = slots
      .map(sf => {
        const date = (t.puntualCells ?? {})[`${sf.day}_${sf.hour}`];
        return date ? `${DAY_SHORT[sf.day] ?? sf.day} ${sf.hour} (${formatPuntualDate(date)})` : null;
      })
      .filter((n): n is string => n !== null);
    return items.length ? [`Libre todas las semanas salvo una recuperación puntual: ${items.join(' · ')}`] : [];
  };

  // Celdas a resaltar en el calendario del profesor que se está viendo: en
  // "Día + hora" todas las combinaciones buscadas; en "Solo día" / "Solo hora"
  // las celdas libres que hacen que ese día u hora cuente.
  const highlightSlots = useMemo<AssignedSlot[]>(() => {
    if (sel.mode === 'dayhour') return sel.days.flatMap(day => sel.hours.map(hour => ({ day, hour })));
    if (!calendarTeacher || sel.mode === 'none') return [];
    return results.find(m => m.teacher.id === calendarTeacher.id)?.freeCells ?? [];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendarTeacher, results, searchMode, days, hours]);

  // Píldoras del resumen: cada día y cada hora que está en juego, quitables.
  const selectionPills = [
    ...sel.days.map(d => ({ key: `d_${d}`, label: DAY_SHORT[d] ?? d, clear: () => toggleDay(d) })),
    ...sel.hours.map(h => ({ key: `h_${h}`, label: h, clear: () => toggleHour(h) })),
  ];
  const statusesChanged = statuses.length !== DEFAULT_STATUSES.length || !DEFAULT_STATUSES.every(s => statuses.includes(s));
  const activeCount = selectionPills.length + specialties.length + (searchName.trim() ? 1 : 0) + (statusesChanged ? 1 : 0);

  const summaryTitle = sel.mode === 'dayhour'
    ? `${plural(sel.days.length, 'día', 'días')} × ${plural(sel.hours.length, 'hora', 'horas')} = ${plural(totalFranjas, 'franja', 'franjas')}`
    : sel.mode === 'day' ? `${plural(sel.days.length, 'día elegido', 'días elegidos')}`
    : sel.mode === 'hour' ? `${plural(sel.hours.length, 'hora elegida', 'horas elegidas')}`
    : 'Sin días ni horas';

  const madrugadaHours = HOUR_BANDS[0].hours;
  const madrugadaVisible = showMadrugada || hours.some(h => madrugadaHours.includes(h));

  function clearFilters() {
    setSearchMode('dayhour');
    setDays([]);
    setHours([]);
    setCoverage('all');
    setSearchName('');
    setSpecialties([]);
    setStatuses(DEFAULT_STATUSES);
    setShowMadrugada(false);
  }

  // Motivo de la "mejor opción" y de cada fila: "libre en 6 de 6 · 14 cupos libres".
  const matchReason = (m: TeacherMatch) => [
    m.total > 0 ? `libre en ${m.matched} de ${m.total}` : null,
    plural(m.teacher.freeSpots, 'cupo libre', 'cupos libres'),
  ].filter(Boolean).join(' · ');

  async function handleAssigned(a: Assignment, s: Student, program?: ProgramActivation) {
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
    // Programa de pago único: se activa con las fechas del modal una vez que el
    // alumno ya existe. Un fallo no deshace la asignación: se avisa y listo.
    if (program) {
      const aviso = await activateProgram(program, s.id, user?.role === 'admin' ? { username: user.username, password: user.password } : null);
      if (aviso) alert(aviso);
    }
  }

  return (
    <div className="stx-page">
      <NavBar />
      <PullToRefresh onRefresh={reloadAll}>

      {/* Header INTERNO de la pantalla. No es sticky: scrollea con el contenido.
          El único elemento fijo de la app sigue siendo el header global .tnav. */}
      <header className="stx-head">
        <div className="stx-head-inner">
          <div className="stx-head-top">
            <div>
              <h1 className="stx-title">Setter</h1>
              <p className="stx-sub">Elegí días y horas, y te mostramos qué profesores pueden tomar al alumno.</p>
            </div>
            <span className="stx-stamp">
              <span className="stx-stamp-dot" aria-hidden />
              <LastUpdated />
            </span>
          </div>

          {/* Botones con aria-pressed, no role="tab": un tablist completo exige
              tabpanel + aria-controls por panel, y una ARIA a medias confunde
              más que la que no está. El original no declaraba ninguna. */}
          <div className="stx-tabs" role="group" aria-label="Secciones del setter">
            {(['search', 'unassigned', 'agenda', 'history'] as const).map(tab => {
              const active = activeTab === tab;
              return (
                <button key={tab} type="button" aria-pressed={active} onClick={() => setActiveTab(tab)}
                  className={`stx-tab${active ? ' is-active' : ''}`}>
                  {tab === 'search' ? 'Buscar'
                    : tab === 'unassigned' ? 'Sin asignar'
                    : tab === 'agenda' ? 'Agenda'
                    : 'Historial'}
                  {tab === 'unassigned' && unassignedStudents.length > 0 && (
                    <span className="stx-tab-count is-alert">{unassignedStudents.length}</span>
                  )}
                  {tab === 'history' && <span className="stx-tab-count">{assignments.length}</span>}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      <div className="stx-body">

        {activeTab === 'search' && (
          <div className="stx-grid">

            {/* ── Barra de filtros en MÓVIL ────────────────────────────────
                El buscador queda siempre a la vista y el resto del panel se
                pliega. Lo elegido sigue visible en la tarjeta de resumen de
                arriba de los resultados, así nunca se pierde qué se filtra. */}
            <div className="stx-mob">
              <div className="stx-mob-bar">
                <div className="stx-search">
                  <Search size={16} aria-hidden className="stx-search-ico" />
                  <input value={searchName} onChange={e => setSearchName(e.target.value)}
                    placeholder="Buscar profesor..." aria-label="Buscar por nombre de profesor" />
                </div>
                <button type="button" className={`stx-mob-toggle${filtersOpen ? ' is-on' : ''}`}
                  aria-expanded={filtersOpen} onClick={() => setFiltersOpen(o => !o)}>
                  Filtros
                  {activeCount > 0 && <span className="stx-mob-n">{activeCount}</span>}
                </button>
              </div>
            </div>

            {/* ── Panel de filtros ─────────────────────────────────────────
                Todo se aplica al instante: no hay botón de "Buscar". */}
            <aside className={`stx-rail${filtersOpen ? '' : ' is-collapsed'}`} aria-label="Filtros">
              <div className="stx-rail-head">
                <span className="stx-rail-title">Filtros</span>
                <button type="button" className="stx-link" onClick={clearFilters}>Limpiar todo</button>
              </div>

              {/* 1. Buscar profesor */}
              <div className="stx-field stx-deskonly">
                <label className="stx-label" htmlFor="stx-name">Buscar profesor</label>
                <div className="stx-search">
                  <Search size={16} aria-hidden className="stx-search-ico" />
                  <input id="stx-name" value={searchName} onChange={e => setSearchName(e.target.value)}
                    placeholder="Ej: Silvia, Sebastian..." />
                </div>
              </div>

              {/* 2. Buscar por */}
              <div className="stx-field">
                <span className="stx-label">Buscar por</span>
                <div className="stx-seg" role="group" aria-label="Buscar por">
                  {([
                    ['dayhour', 'Día + hora'],
                    ['day',     'Solo día'],
                    ['hour',    'Solo hora'],
                  ] as const).map(([m, label]) => (
                    <button key={m} type="button" aria-pressed={searchMode === m}
                      className={`stx-seg-btn${searchMode === m ? ' is-active' : ''}`}
                      onClick={() => setSearchMode(m)}>
                      {label}
                    </button>
                  ))}
                </div>
                <div className="stx-hint">{MODE_HINT[searchMode]}</div>
              </div>

              {/* 3. Días — selección múltiple. Atenuado en "Solo hora". */}
              <fieldset className={`stx-field stx-fs${searchMode === 'hour' ? ' is-off' : ''}`}
                disabled={searchMode === 'hour'} aria-label="Días">
                <div className="stx-field-head">
                  <span className="stx-label">Días · podés elegir varios</span>
                </div>
                <div className="stx-days">
                  {SEARCH_DAYS.map(d => {
                    const on = days.includes(d);
                    return (
                      <button key={d} type="button" aria-pressed={on} aria-label={d} title={d}
                        className={`stx-opt stx-day${on ? ' is-active' : ''}`} onClick={() => toggleDay(d)}>
                        {DAY_SHORT[d]}
                      </button>
                    );
                  })}
                </div>
                <div className="stx-shortcuts">
                  <button type="button" className="stx-link" onClick={() => setDays(['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes'])}>Lun a Vie</button>
                  {/* El calendario de los profesores no tiene domingo: fin de semana = sábado. */}
                  <button type="button" className="stx-link" onClick={() => setDays(['Sábado'])} title="Sábado (el calendario no tiene domingo)">Fin de semana</button>
                  <button type="button" className="stx-link" onClick={() => setDays([])} disabled={days.length === 0}>Quitar días</button>
                </div>
              </fieldset>

              {/* 4. Horas (España) — selección múltiple por franja. Atenuado en "Solo día". */}
              <fieldset className={`stx-field stx-fs${searchMode === 'day' ? ' is-off' : ''}`}
                disabled={searchMode === 'day'} aria-label="Horas">
                <div className="stx-field-head">
                  <span className="stx-label">Horas (España) · varias</span>
                  <button type="button" className="stx-link" onClick={() => setHours([])} disabled={hours.length === 0}>Quitar horas</button>
                </div>
                {!hours.some(h => madrugadaHours.includes(h)) && (
                  <button type="button" className="stx-link stx-madrugada" onClick={() => setShowMadrugada(v => !v)}>
                    {madrugadaVisible ? 'Ocultar madrugada' : 'Mostrar madrugada (00–06)'}
                  </button>
                )}
                {HOUR_BANDS.filter(b => b.key !== 'madrugada' || madrugadaVisible).map(b => {
                  const allOn = b.hours.every(h => hours.includes(h));
                  return (
                    <div key={b.key} className="stx-band">
                      <div className="stx-band-head">
                        <span className="stx-band-t">
                          {b.label} <span className="stx-band-r">{b.hours[0].slice(0, 2)}–{b.hours[b.hours.length - 1].slice(0, 2)}</span>
                        </span>
                        <button type="button" className="stx-link" onClick={() => toggleBand(b.hours)}>
                          {allOn ? 'Quitar franja' : 'Toda la franja'}
                        </button>
                      </div>
                      <div className="stx-hours">
                        {b.hours.map(h => {
                          const on = hours.includes(h);
                          return (
                            <button key={h} type="button" aria-pressed={on} aria-label={h}
                              className={`stx-hour${on ? ' is-active' : ''}`} onClick={() => toggleHour(h)}>
                              {h.slice(0, 2)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </fieldset>

              {/* 5. Cobertura */}
              <div className="stx-field">
                <span className="stx-label">El profesor debe estar libre en</span>
                <div className="stx-seg" role="group" aria-label="El profesor debe estar libre en">
                  {([
                    ['all', 'Todas las franjas'],
                    ['any', 'Alguna franja'],
                  ] as const).map(([c, label]) => (
                    <button key={c} type="button" aria-pressed={coverage === c}
                      className={`stx-seg-btn${coverage === c ? ' is-active' : ''}`}
                      onClick={() => setCoverage(c)}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 6. Especialidad — varias = el profesor tiene que tenerlas todas. */}
              <div className="stx-field">
                <span className="stx-label">Especialidad</span>
                <div className="stx-opts">
                  <button type="button" aria-pressed={specialties.length === 0}
                    className={`stx-opt${specialties.length === 0 ? ' is-active' : ''}`}
                    onClick={() => setSpecialties([])}>
                    Todas
                  </button>
                  {ALL_SPECIALTIES.map(sp => {
                    const on = specialties.includes(sp);
                    return (
                      <button key={sp} type="button" aria-pressed={on}
                        className={`stx-opt${on ? ' is-active' : ''}`} onClick={() => toggleSpecialty(sp)}>
                        {sp}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 7. Estado */}
              <div className="stx-field">
                <span className="stx-label">Estado</span>
                <div className="stx-opts">
                  {STATUS_CHIPS.map(s => {
                    const on = statuses.includes(s.value);
                    return (
                      <button key={s.value} type="button" aria-pressed={on}
                        className={`stx-opt${on ? ' is-active' : ''}`} onClick={() => toggleStatus(s.value)}>
                        <span className={`stx-dot ${s.dot}`} aria-hidden />{s.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Solo móvil: cierre del panel. */}
              <div className="stx-rail-actions">
                <button type="button" className="stx-cta stx-cta-ghost" onClick={clearFilters}>Limpiar todo</button>
                <button type="button" className="stx-cta" onClick={() => setFiltersOpen(false)}>
                  Ver {plural(results.length, 'profesor', 'profesores')}
                </button>
              </div>
            </aside>

            {/* ── Resultados ───────────────────────────────────────────────*/}
            <section className="stx-results" aria-label="Profesores">

              {/* Resumen de la búsqueda */}
              <div className="stx-panel stx-summary">
                <div className="stx-summary-top">
                  <span className="stx-summary-ico" aria-hidden><Clock size={18} /></span>
                  <span className="stx-summary-t">{summaryTitle}</span>
                  {totalFranjas > 0 && (
                    <span className="stx-summary-cov">{coverage === 'all' ? 'Libre en todas' : 'Libre en alguna'}</span>
                  )}
                </div>
                {selectionPills.length > 0 ? (
                  <div className="stx-pills">
                    {selectionPills.map(p => (
                      <button key={p.key} type="button" className="stx-pill" onClick={p.clear} aria-label={`Quitar ${p.label}`}>
                        {p.label}<span className="stx-pill-x" aria-hidden>×</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="stx-summary-empty">Todavía no elegiste días ni horas: se muestran todos los profesores.</p>
                )}
              </div>

              {/* Mejor opción, o el aviso si nadie cubre todas las franjas */}
              {nobodyCoversAll ? (
                <div className="stx-warn" role="status">
                  <span className="stx-warn-t">Ningún profesor está libre en todas las franjas elegidas.</span>
                  <button type="button" className="stx-cta stx-cta-ghost" onClick={() => setCoverage('any')}>
                    Mostrar los que cubren alguna
                  </button>
                </div>
              ) : recommended && (
                <div className="stx-best">
                  <div className="stx-avatar is-best" aria-hidden>{initials(recommended.teacher.name)}</div>
                  <div className="stx-best-body">
                    <div className="stx-label" style={{ marginBottom: 2 }}>Mejor opción ahora</div>
                    <div className="stx-best-name">{recommended.teacher.name} — {matchReason(recommended)}</div>
                    {puntualNotes(recommended.teacher, recommended.freeCells).map(note => (
                      <div key={note} className="stx-note stx-note-warn">♻️ {note}</div>
                    ))}
                  </div>
                  <button type="button" className="stx-cta" onClick={() => setCalendarTeacher(recommended.teacher)}>Ver calendario</button>
                </div>
              )}

              {/* Cuántos hay y orden */}
              <div className="stx-statusline">
                <span className="stx-count">
                  <span className="stx-count-n">{results.length}</span> {results.length === 1 ? 'profesor' : 'profesores'}
                </span>
                <div className="stx-sort">
                  <label className="stx-label" htmlFor="stx-sort" style={{ margin: 0 }}>Orden</label>
                  <select id="stx-sort" value={sortBy} onChange={e => setSortBy(e.target.value as SortKey)}>
                    {(Object.keys(SORT_LABELS) as SortKey[]).map(k => (
                      <option key={k} value={k}>{SORT_LABELS[k]}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="stx-card">
                {results.length === 0 ? (
                  <div className="stx-empty">
                    <div className="stx-empty-d">No hay profesores con estos filtros. Probá quitar alguna hora o cambiar a &lsquo;Alguna franja&rsquo;.</div>
                  </div>
                ) : results.map(m => {
                  const t = m.teacher;
                  const max = t.maxWeeklyLoad > 0 ? t.maxWeeklyLoad : 20;
                  const loadPct = Math.min(100, Math.round((t.weeklyLoad / max) * 100));
                  const isBlocked = t.isBlocked ?? false;
                  const isFull = t.status === 'busy';
                  const matchTone = m.total === 0 ? 'is-none' : m.matched === m.total ? 'is-ok' : 'is-warn';
                  const extra = m.franjas.length - MAX_FRANJA_TAGS;

                  return (
                    <div key={t.id} className={`stx-row${isBlocked ? ' is-blocked' : ''}`}>
                      <div className="stx-row-main">
                        <div className="stx-avatar" aria-hidden>{initials(t.name)}</div>
                        <div style={{ minWidth: 0 }}>
                          <div className="stx-name-line">
                            <span className="stx-name">{t.name}</span>
                            {/* El estado nunca se comunica solo por color: punto + texto. */}
                            {isBlocked ? <Badge tone="danger" dot>Bloqueado</Badge> : <StatusBadge status={t.status} />}
                          </div>
                          <div className="stx-email">{t.email}</div>
                          {(t.specialties ?? []).length > 0 && (
                            <div className="stx-tags">
                              {(t.specialties ?? []).map(sp => <SpecialtyChip key={sp} specialty={sp} />)}
                            </div>
                          )}
                          {puntualNotes(t, m.freeCells).map(note => (
                            <div key={note} className="stx-note stx-note-warn">♻️ {note}</div>
                          ))}
                        </div>
                      </div>

                      <div className="stx-match">
                        <div className={`stx-match-t ${matchTone}`}>
                          {m.total === 0 ? 'Sin franja elegida'
                            : m.matched === m.total ? `Libre en todas · ${m.matched} de ${m.total}`
                            : `Libre en ${m.matched} de ${m.total}`}
                        </div>
                        {m.total > 0 && (
                          <div className="stx-ftags">
                            {m.franjas.slice(0, MAX_FRANJA_TAGS).map(f => (
                              <span key={f.key} className={`stx-ftag${f.free ? ' is-free' : ' is-busy'}`}
                                title={`${f.label}: ${f.free ? 'libre' : 'ocupado'}`}>
                                {f.label}
                              </span>
                            ))}
                            {extra > 0 && <span className="stx-ftag is-more">+{extra}</span>}
                          </div>
                        )}
                      </div>

                      <div className="stx-metric">
                        <div className={`stx-metric-n${t.freeSpots > 0 && !isBlocked ? '' : ' is-zero'}`}>{t.freeSpots}</div>
                        <div className="stx-metric-l">Cupos</div>
                      </div>

                      <div className="stx-load">
                        <div className="stx-load-top"><span>Carga semanal</span><span>{t.weeklyLoad}h</span></div>
                        <div className="stx-load-bar" title={`${t.weeklyLoad}h de ${max}h`}>
                          <div className={`stx-load-fill ${loadTone(loadPct)}`} style={{ width: `${loadPct}%` }} />
                        </div>
                      </div>

                      <button type="button" className={`stx-cta stx-row-cta${isFull ? ' stx-cta-ghost' : ''}`}
                        onClick={() => setCalendarTeacher(t)} disabled={isBlocked}
                        title={isBlocked ? 'Profesor bloqueado por baja retención' : undefined}>
                        {isBlocked ? 'No disponible' : 'Ver calendario'}
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        )}

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
                          <button onClick={() => { setSearchName(''); setSpecialties([]); setActiveTab('search'); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
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
          onAssigned={(a, s, program) => { handleAssigned(a, s, program); setCreateAssign(null); }}
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
