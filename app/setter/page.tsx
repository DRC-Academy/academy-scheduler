'use client';
import { useState, useMemo, useEffect } from 'react';
import { NavBar } from '@/components/NavBar';
import { StatusBadge } from '@/components/StatusBadge';
import { AuthGuard } from '@/components/AuthGuard';
import { PullToRefresh } from '@/components/PullToRefresh';
import { LastUpdated } from '@/components/LastUpdated';
import { VisualCalendar, buildGridFromTeacher, cellKey, HOURS_ES, getWeekDates, formatWeekRange } from '@/components/VisualCalendar';
import { dbCheckStudentExists } from '@/lib/db';
import { useTeachers } from '@/lib/TeachersContext';
import { daysOfWeek } from '@/lib/mock-data';
import { Teacher, SlotFilter, Grid, Assignment, Student, AssignedSlot } from '@/types';

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

// ─── Email Modal ──────────────────────────────────────────────────────────────
function EmailModal({ assignment, onClose }: { assignment: Assignment; onClose: () => void }) {
  const [sent, setSent] = useState(false);

  const slotsText = assignment.slots.length === 1
    ? `${assignment.slots[0].day} · ${assignment.slots[0].hour}h - ${String(parseInt(assignment.slots[0].hour) + 1).padStart(2,'0')}:00h (Hora España)`
    : assignment.slots.map(s => `${s.day} ${s.hour}h`).join(' y ') + ' (Hora España)';

  const now = new Date();
  const dateStr = now.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  const greeting = now.getHours() < 13 ? 'Buenos días' : now.getHours() < 20 ? 'Buenas tardes' : 'Buenas noches';

  const firstSlot = assignment.slots[0];
  const firstSlotLabel = firstSlot
    ? `${firstSlot.day} ${now.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' })}`
    : '—';

  const renewalStr = assignment.startDate ? fmtDate(addDays(assignment.startDate, 30)) : null;
  const firstName = assignment.studentName.split(' ')[0];

  const emailSubject = `Info ${assignment.studentName}`;
  const emailBody = `${greeting} ${assignment.teacherName.split(' ')[0]}!

A continuación te envío la info de ${assignment.studentName} para su clase del ${firstSlotLabel}

Recuerda enviarle el correo de presentación y el correo con los datos de la sesión

${assignment.slots.map(s =>
  `Cita: ${s.day} ${dateStr.split(',')[1]?.trim() ?? ''}\nHora: ${s.hour}h - ${String(parseInt(s.hour)+1).padStart(2,'0')}:00  (Hora España).`
).join('\n')}
Email de contacto: ${assignment.studentEmail}
Objetivo: ${firstName} ${assignment.objetivo ? `necesita ${assignment.objetivo.toLowerCase()}` : 'quiere mejorar su nivel'}
Nivel: ${assignment.studentLevel}
Disponibilidad siguientes sesiones: ${slotsText}
Recuerda pedir que te confirmen que han recibido el email.

${firstName} ha comprado su plan ${assignment.plan} de ${assignment.weeklyHours}h semanal${renewalStr ? ` y renueva el ${renewalStr}` : ''}.`;

  const mailtoLink = `mailto:${assignment.teacherEmail}?subject=${encodeURIComponent(emailSubject)}&body=${encodeURIComponent(emailBody)}`;

  function copyBody() { navigator.clipboard.writeText(emailBody).catch(() => {}); }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 18, width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto', padding: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 18, color: 'var(--text-primary)' }}>📧 Enviar email al profesor</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3 }}>Para: {assignment.teacherEmail}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 22, cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Asunto</div>
          <div style={{ background: 'var(--bg-surface-2)', borderRadius: 8, padding: '9px 13px', fontSize: 13, color: 'var(--text-primary)', border: '1px solid var(--border)', fontWeight: 600 }}>{emailSubject}</div>
        </div>
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Cuerpo del email</div>
          <div style={{ background: 'var(--bg-surface-2)', borderRadius: 10, padding: '14px 16px', fontSize: 13, color: 'var(--text-primary)', whiteSpace: 'pre-wrap', lineHeight: 1.7, border: '1px solid var(--border)', maxHeight: 340, overflowY: 'auto' }}>{emailBody}</div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={copyBody} style={{ flex: 1, padding: '11px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--bg-surface-3)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>📋 Copiar cuerpo</button>
          <a href={mailtoLink} onClick={() => setSent(true)}
            style={{ flex: 2, padding: '11px', borderRadius: 9, border: 'none', background: sent ? '#1E9E3A' : '#1E9E3A', color: 'white', cursor: 'pointer', fontSize: 13, fontWeight: 700, textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}>
            {sent ? '✓ Email abierto' : '📧 Abrir en cliente de email'}
          </a>
        </div>
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
          Se abre tu cliente de correo con el email prellenado
        </div>
      </div>
    </div>
  );
}

function EmailTrigger({ assignment }: { assignment: Assignment }) {
  const [show, setShow] = useState(false);
  return (
    <>
      <button onClick={() => setShow(true)} style={{ padding: '7px 14px', borderRadius: 8, border: 'none', background: '#1E9E3A', color: 'white', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>📧 Email</button>
      {show && <EmailModal assignment={assignment} onClose={() => setShow(false)} />}
    </>
  );
}

// ─── Assign Modal ─────────────────────────────────────────────────────────────
const DAY_ORDER = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

function AssignModal({
  teacher, initialSlots, teacherGrid, existingStudents, onClose, onConfirm,
}: {
  teacher: Teacher;
  initialSlots: AssignedSlot[];
  teacherGrid: Grid;
  existingStudents: Student[];
  onClose: () => void;
  onConfirm: (a: Assignment, s: Student) => void;
}) {
  const [tab, setTab] = useState<'existing' | 'new'>('existing');
  const [selectedExisting, setSelectedExisting] = useState('');
  const [newStudent, setNewStudent] = useState({ name: '', email: '', level: 'B1' });

  const availableSlots = useMemo<AssignedSlot[]>(() => {
    return Object.entries(teacherGrid)
      .filter(([, cell]) => cell.state === 'libre')
      .map(([key]) => { const [day, hour] = key.split('_'); return { day, hour }; })
      .sort((a, b) => {
        const d = DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day);
        return d !== 0 ? d : a.hour.localeCompare(b.hour);
      });
  }, [teacherGrid]);

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

  const todayISO = new Date().toISOString().split('T')[0];

  useEffect(() => {
    setSlots(prev => prev.length > weeklyHours ? prev.slice(0, weeklyHours) : prev);
  }, [weeklyHours]);

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
  const hasStudent = tab === 'existing' ? !!selectedExisting : (!!newStudent.name && !!newStudent.email);
  const slotsComplete = slots.length === weeklyHours;
  const canConfirm = hasStudent && slotsComplete && availableSlots.length > 0 && !!startDate;

  async function handleConfirm() {
    if (!canConfirm) return;

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
    const student: Student = overrideStudent ?? (tab === 'existing'
      ? existingStudents.find(s => s.id === selectedExisting)!
      : { id: `s_${Date.now()}`, name: newStudent.name, email: newStudent.email, level: newStudent.level, plan, createdAt: new Date().toISOString() });

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
      plan,
      weeklyHours,
      availability: '',
      notes,
      startDate,
      createdAt: new Date().toISOString(),
    };
    setResultAssignment(assignment);
    onConfirm(assignment, student);
    setSuccess(true);
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
            <div><label>Email *</label><input type="email" value={newStudent.email} onChange={e => setNewStudent(p => ({ ...p, email: e.target.value }))} placeholder="maria@gmail.com" /></div>
            <div><label>Nivel</label>
              <select value={newStudent.level} onChange={e => setNewStudent(p => ({ ...p, level: e.target.value }))}>
                {LEVELS.map(l => <option key={l}>{l}</option>)}
              </select>
            </div>
          </div>
        )}

        <div style={{ marginBottom: 16 }}>
          <label>Horas semanales</label>
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
            <input type="date" value={startDate} min={todayISO} onChange={e => setStartDate(e.target.value)} style={{ maxWidth: 200 }} />
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
    getTeacherGrid(teacher.id).then(g => {
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
              updated = { ...updated, [cellKey(sl.day, sl.hour)]: { state: 'ocupado' as const, student: s.name } };
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

  function addSlotFilter() {
    setSlotFilters(prev => [...prev, { id: Date.now().toString(), day: 'Lunes', hour: '14:00' }]);
  }
  function removeSlotFilter(id: string) {
    setSlotFilters(prev => prev.filter(f => f.id !== id));
  }
  function updateSlotFilter(id: string, field: 'day' | 'hour', value: string) {
    setSlotFilters(prev => prev.map(f => f.id === id ? { ...f, [field]: value } : f));
  }

  // A searched slot counts as available ONLY if the teacher's real grid cell
  // (from teacher_calendars) is exactly 'libre'. libreCells holds those exact
  // `${day}_${hour}` keys — NOT a min-max range — so 'ocupado' / 'bloqueado'
  // ("En recuperación") / 'no_work' cells between free hours never match.
  const teacherHasAllSlots = (t: Teacher) =>
    slotFilters.every(sf => (t.libreCells ?? []).includes(`${sf.day}_${sf.hour}`));

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

  function handleAssigned(a: Assignment, s: Student) {
    addAssignment(a);
    addStudent(s);
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
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' }}>📋 Alumnos sin asignar</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
                Alumnos registrados que todavía no tienen ningún profesor asignado. Ordenados por antigüedad.
              </div>
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
                    return (
                      <div key={s.id} style={{ background: 'var(--bg-surface)', border: `1px solid ${urgent ? 'rgba(239,68,68,0.3)' : 'var(--border)'}`, borderRadius: 12, padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                        <div style={{ width: 40, height: 40, borderRadius: '50%', background: urgent ? 'rgba(239,68,68,0.1)' : 'var(--bg-surface-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 700, color: urgent ? '#ef4444' : 'var(--text-secondary)', flexShrink: 0 }}>
                          {s.name.charAt(0).toUpperCase()}
                        </div>
                        <div style={{ flex: 1, minWidth: 140 }}>
                          <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>{s.name}</div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 1 }}>{s.email}</div>
                          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3 }}>
                            Plan: <b>{s.plan || '—'}</b> · Nivel: <b>{s.level}</b>
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                            Registrado hace {daysWaiting} día{daysWaiting !== 1 ? 's' : ''}
                          </div>
                        </div>
                        {urgent && (
                          <span style={{ padding: '3px 10px', borderRadius: 20, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.35)', color: '#ef4444', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
                            ⚠️ {daysWaiting} días sin asignar
                          </span>
                        )}
                        <button onClick={() => { setSearchName(''); setSpecialtyFilter(''); setActiveTab('search'); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                          style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#1E9E3A', color: 'white', fontWeight: 700, fontSize: 13, cursor: 'pointer', flexShrink: 0 }}>
                          Asignar profesor →
                        </button>
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
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {new Date(a.createdAt).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <EmailTrigger assignment={a} />
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

      {emailAssignment && <EmailModal assignment={emailAssignment} onClose={() => setEmailAssignment(null)} />}
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
