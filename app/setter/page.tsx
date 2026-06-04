'use client';
import { useState, useMemo, useEffect } from 'react';
import { NavBar } from '@/components/NavBar';
import { StatusBadge } from '@/components/StatusBadge';
import { AuthGuard } from '@/components/AuthGuard';
import { VisualCalendar, buildGridFromTeacher, cellKey, HOURS_ES } from '@/components/VisualCalendar';
import { useTeachers } from '@/lib/TeachersContext';
import { daysOfWeek } from '@/lib/mock-data';
import { Teacher, SlotFilter, Grid, Assignment, Student, AssignedSlot } from '@/types';

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

// ─── Helpers de fecha ────────────────────────────────────────────────────────
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

  function copyBody() {
    navigator.clipboard.writeText(emailBody).catch(() => {});
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid #35405a', borderRadius: 18, width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto', padding: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 18, color: 'var(--text-primary)' }}>📧 Enviar email al profesor</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3 }}>Para: {assignment.teacherEmail}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 22, cursor: 'pointer' }}>✕</button>
        </div>

        {/* Subject */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Asunto</div>
          <div style={{ background: 'var(--bg-surface-2)', borderRadius: 8, padding: '9px 13px', fontSize: 13, color: 'var(--text-primary)', border: '1px solid var(--border)', fontWeight: 600 }}>
            {emailSubject}
          </div>
        </div>

        {/* Body */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Cuerpo del email</div>
          <div style={{ background: 'var(--bg-surface-2)', borderRadius: 10, padding: '14px 16px', fontSize: 13, color: 'var(--text-primary)', whiteSpace: 'pre-wrap', lineHeight: 1.7, border: '1px solid var(--border)', fontFamily: 'inherit', maxHeight: 340, overflowY: 'auto' }}>
            {emailBody}
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={copyBody} style={{ flex: 1, padding: '11px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--bg-surface-3)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            📋 Copiar cuerpo
          </button>
          <a href={mailtoLink} onClick={() => setSent(true)}
            style={{ flex: 2, padding: '11px', borderRadius: 9, border: 'none', background: sent ? '#22c55e' : '#3b82f6', color: 'white', cursor: 'pointer', fontSize: 13, fontWeight: 700, textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, transition: 'background 0.2s' }}>
            {sent ? '✓ Email abierto' : '📧 Abrir en cliente de email'}
          </a>
        </div>
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
          Se abre tu cliente de correo (Outlook, Gmail, etc.) con el email prellenado
        </div>
      </div>
    </div>
  );
}

function EmailTrigger({ assignment }: { assignment: Assignment }) {
  const [show, setShow] = useState(false);
  return (
    <>
      <button onClick={() => setShow(true)} style={{ padding: '7px 14px', borderRadius: 8, border: 'none', background: '#3b82f6', color: 'white', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
        📧 Email
      </button>
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

  // Libre slots from the teacher's grid, sorted day→hour
  const availableSlots = useMemo<AssignedSlot[]>(() => {
    return Object.entries(teacherGrid)
      .filter(([, cell]) => cell.state === 'libre')
      .map(([key]) => { const [day, hour] = key.split('_'); return { day, hour }; })
      .sort((a, b) => {
        const d = DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day);
        return d !== 0 ? d : a.hour.localeCompare(b.hour);
      });
  }, [teacherGrid]);

  // Pre-fill with clicked cell, only if it's actually libre
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

  const todayISO = new Date().toISOString().split('T')[0];

  // When weeklyHours decreases, trim excess slots
  useEffect(() => {
    setSlots(prev => prev.length > weeklyHours ? prev.slice(0, weeklyHours) : prev);
  }, [weeklyHours]);

  function addSlot() {
    const used = new Set(slots.map(s => `${s.day}_${s.hour}`));
    const next = availableSlots.find(as => !used.has(`${as.day}_${as.hour}`));
    if (next) setSlots(prev => [...prev, next]);
  }

  function removeSlot(i: number) {
    setSlots(prev => prev.filter((_, idx) => idx !== i));
  }

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

  function handleConfirm() {
    if (!canConfirm) return;
    const student: Student = tab === 'existing'
      ? existingStudents.find(s => s.id === selectedExisting)!
      : { id: `s_${Date.now()}`, name: newStudent.name, email: newStudent.email, level: newStudent.level, plan, createdAt: new Date().toISOString() };

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
        <div style={{ background: 'var(--bg-surface)', border: '1px solid #35405a', borderRadius: 18, width: '100%', maxWidth: 480, padding: 28, textAlign: 'center' }}>
          <div style={{ fontSize: 52, marginBottom: 14 }}>✅</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>¡Clase asignada!</div>
          <div style={{ color: 'var(--text-secondary)', fontSize: 14, marginBottom: 4 }}>
            <b>{studentName}</b> → <b>{teacher.name}</b>
          </div>
          <div style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 6 }}>
            {slots.map(s => `${s.day} ${s.hour} 🇪🇸`).join(' · ')}
          </div>
          <div style={{ color: '#a78bfa', fontSize: 13, fontWeight: 600, marginBottom: 24 }}>
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

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid #35405a', borderRadius: 18, width: '100%', maxWidth: 560, maxHeight: '94vh', overflowY: 'auto', padding: 28 }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 19, color: 'var(--text-primary)' }}>Asignar clase</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 3 }}>👨‍🏫 {teacher.name}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 22, cursor: 'pointer' }}>✕</button>
        </div>

        {/* Student tabs */}
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

        {/* ── Weekly hours (moved up so slot count target is visible) ── */}
        <div style={{ marginBottom: 16 }}>
          <label>Horas semanales</label>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            {WEEKLY_HOURS.map(h => (
              <button key={h} onClick={() => setWeeklyHours(h)} style={{
                flex: 1, padding: '9px 0', borderRadius: 9,
                border: `1.5px solid ${weeklyHours === h ? '#a78bfa' : 'var(--border)'}`,
                background: weeklyHours === h ? 'rgba(167,139,250,0.15)' : 'var(--bg-surface-2)',
                color: weeklyHours === h ? '#a78bfa' : 'var(--text-secondary)',
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

        {/* ── Slot selector filtered to libre cells ── */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginBottom: 16 }}>
          {/* Progress header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Horarios asignados</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: slotsComplete ? '#22c55e' : slots.length > 0 ? '#f59e0b' : 'var(--text-muted)' }}>
                {slots.length} de {weeklyHours} horario{weeklyHours !== 1 ? 's' : ''}
              </span>
              {slots.length < weeklyHours && availableSlots.length > slots.length && (
                <button onClick={addSlot} style={{ padding: '4px 10px', borderRadius: 8, border: '1px solid rgba(59,130,246,0.35)', background: 'rgba(59,130,246,0.1)', color: '#93c5fd', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                  + Agregar
                </button>
              )}
            </div>
          </div>

          {availableSlots.length === 0 ? (
            <div style={{ padding: '14px', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 9, fontSize: 13, color: '#ef4444', textAlign: 'center' }}>
              Este profesor no tiene horarios disponibles (libres) en su calendario.
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
                    <select
                      value={currentKey}
                      onChange={e => updateSlotValue(i, e.target.value)}
                      style={{ flex: 1 }}>
                      {options.map(as => {
                        const k = `${as.day}_${as.hour}`;
                        return <option key={k} value={k}>{as.day} {as.hour} 🇪🇸</option>;
                      })}
                    </select>
                    <button onClick={() => removeSlot(i)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18, padding: '0 4px', flexShrink: 0 }}>✕</button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Class details ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 16 }}>
          {/* Plan */}
          <div>
            <label>Plan</label>
            <select value={plan} onChange={e => setPlan(e.target.value)}>
              <option value="">Seleccionar plan...</option>
              {PLANES.map(p => <option key={p}>{p}</option>)}
            </select>
          </div>

          {/* Objetivo */}
          <div>
            <label>Objetivo</label>
            <select value={objetivo} onChange={e => setObjetivo(e.target.value)}>
              <option value="">Seleccionar objetivo...</option>
              {OBJETIVOS.map(o => <option key={o}>{o}</option>)}
            </select>
          </div>

          {/* Notes */}
          <div>
            <label>Notas internas</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Info adicional sobre el alumno..." rows={2} style={{ resize: 'vertical' }} />
          </div>

          {/* Start date */}
          <div>
            <label>Fecha de inicio *</label>
            <input
              type="date"
              value={startDate}
              min={todayISO}
              onChange={e => setStartDate(e.target.value)}
              style={{ maxWidth: 200 }}
            />
          </div>
        </div>

        {/* Summary */}
        <div style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border)', borderRadius: 9, padding: '10px 14px', marginBottom: 16, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>Resumen</div>
          <div>👤 {studentName || '—'} ({studentLevel}) · 👨‍🏫 {teacher.name}</div>
          {slots.length > 0 && <div>📅 {slots.map(s => `${s.day} ${s.hour}`).join(' · ')} 🇪🇸</div>}
          <div>⏱ {weeklyHours}h/semana {plan && `· ${plan}`}</div>
          {objetivo && <div>🎯 {objetivo}</div>}
          {startDate && (
            <div>📆 Inicio: {fmtDate(startDate)} · Renovación: {fmtDate(addDays(startDate, 30))}</div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose} style={{ flex: 1, padding: '11px', borderRadius: 9, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 14 }}>Cancelar</button>
          <button onClick={handleConfirm} disabled={!canConfirm} style={{ flex: 2, padding: '11px', borderRadius: 9, border: 'none', background: canConfirm ? '#22c55e' : 'var(--bg-surface-3)', color: canConfirm ? 'white' : 'var(--text-muted)', cursor: canConfirm ? 'pointer' : 'not-allowed', fontSize: 14, fontWeight: 700 }}>
            {!hasStudent ? 'Elegí un alumno primero' : !slotsComplete ? `Faltan ${weeklyHours - slots.length} horario${weeklyHours - slots.length !== 1 ? 's' : ''}` : !startDate ? 'Ingresá la fecha de inicio' : 'Confirmar asignación ✓'}
          </button>
        </div>
      </div>
    </div>
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

  useEffect(() => {
    getTeacherGrid(teacher.id).then(g => {
      setGrid(Object.keys(g).length > 0 ? g : baseGrid);
      setLoadingGrid(false);
    });
  }, [teacher.id]);
  const [assignCell, setAssignCell] = useState<AssignedSlot | null>(null);

  function handleGridChange(g: Grid) {
    setGrid(g);
    updateTeacherGrid(teacher.id, g);
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(6px)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}
      onClick={e => { if (e.target === e.currentTarget && !assignCell) onClose(); }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid #35405a', borderRadius: 18, width: '100%', maxWidth: 940, maxHeight: '94vh', overflowY: 'auto', padding: 26 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 42, height: 42, borderRadius: '50%', background: 'rgba(34,197,94,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 15, color: '#4ade80' }}>{teacher.avatar}</div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 17, color: 'var(--text-primary)' }}>Calendario de {teacher.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {editMode ? '✏️ Modo edición: clic en cualquier celda para cambiar estado' : 'Clic en 🟢 Libre → se abre el formulario de asignación'}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              onClick={() => setEditMode(m => !m)}
              style={{ padding: '7px 14px', borderRadius: 8, border: `1px solid ${editMode ? 'rgba(245,158,11,0.5)' : 'var(--border)'}`, background: editMode ? 'rgba(245,158,11,0.12)' : 'transparent', color: editMode ? '#fbbf24' : 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
              {editMode ? '✏️ Editando' : '✏️ Modo edición'}
            </button>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 22, cursor: 'pointer' }}>✕</button>
          </div>
        </div>

        {highlightSlots.length > 0 && (
          <div style={{ marginBottom: 12, padding: '8px 14px', background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 9, fontSize: 13, color: '#93c5fd' }}>
            🔍 Buscando: {highlightSlots.map(s => `${s.day} ${s.hour}`).join(' · ')}
          </div>
        )}

        {loadingGrid ? (
          <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-muted)' }}>Cargando calendario...</div>
        ) : editMode ? (
          <VisualCalendar
            mode="teacher"
            grid={grid}
            onGridChange={handleGridChange}
            highlightSlots={highlightSlots}
          />
        ) : (
          <VisualCalendar
            mode="setter"
            grid={grid}
            onCellClick={(day, hour) => setAssignCell({ day, hour })}
            highlightSlots={highlightSlots}
          />
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
            // Mark all assigned slots as occupied in the grid
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

// ─── Setter Content ───────────────────────────────────────────────────────────
function SetterContent() {
  const { teachers, students, assignments, addStudent, addAssignment } = useTeachers();

  // Filters — start empty (not mandatory)
  const [slotFilters, setSlotFilters] = useState<SlotFilter[]>([]);
  const [onlyAvailable, setOnlyAvailable] = useState(false);
  const [searchName, setSearchName] = useState('');

  const [calendarTeacher, setCalendarTeacher] = useState<Teacher | null>(null);
  const [emailAssignment, setEmailAssignment] = useState<Assignment | null>(null);
  const [activeTab, setActiveTab] = useState<'search' | 'history'>('search');

  function addSlotFilter() {
    setSlotFilters(prev => [...prev, { id: Date.now().toString(), day: 'Lunes', hour: '14:00' }]);
  }
  function removeSlotFilter(id: string) {
    setSlotFilters(prev => prev.filter(f => f.id !== id));
  }
  function updateSlotFilter(id: string, field: 'day' | 'hour', value: string) {
    setSlotFilters(prev => prev.map(f => f.id === id ? { ...f, [field]: value } : f));
  }

  const filtered = useMemo(() => {
    return teachers.filter(t => {
      if (onlyAvailable && t.status !== 'available' && t.status !== 'almost_full') return false;
      if (searchName && !t.name.toLowerCase().includes(searchName.toLowerCase())) return false;
      // Only filter by slots if there are any filters set
      if (slotFilters.length > 0) {
        const hasAll = slotFilters.every(sf => {
          const h = parseInt(sf.hour);
          return t.timeSlots.some(ts => ts.day === sf.day && h >= parseInt(ts.from) && h < parseInt(ts.to));
        });
        if (!hasAll) return false;
      }
      return true;
    });
  }, [teachers, onlyAvailable, searchName, slotFilters]);

  const recommended = filtered.find(t => t.status === 'available' && t.freeSpots >= Math.max(slotFilters.length, 1));
  const highlightSlots = slotFilters.map(sf => ({ day: sf.day, hour: sf.hour }));

  function handleAssigned(a: Assignment, s: Student) {
    addAssignment(a);
    addStudent(s);
    setCalendarTeacher(null);
    setEmailAssignment(a);
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }}>
      <NavBar />
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '28px 20px' }}>

        {/* Header + tabs */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 4px' }}>Buscar disponibilidad</h1>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>Filtrá por horarios o buscá directamente por nombre.</p>
          </div>
          <div style={{ display: 'flex', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 9, padding: 3, gap: 3 }}>
            {(['search', 'history'] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)} style={{ padding: '7px 16px', borderRadius: 7, border: 'none', background: activeTab === tab ? 'var(--bg-surface-3)' : 'transparent', color: activeTab === tab ? 'var(--text-primary)' : 'var(--text-secondary)', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
                {tab === 'search' ? '🔍 Buscar' : `📋 Historial (${assignments.length})`}
              </button>
            ))}
          </div>
        </div>

        {activeTab === 'search' && (<>
          {/* Filter Panel */}
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '20px 22px', marginBottom: 22 }}>
            <div style={{ marginBottom: 18 }}>
              <label>Buscar por nombre de profesor</label>
              <input value={searchName} onChange={e => setSearchName(e.target.value)} placeholder="Ej: Silvia, Sebastian..." style={{ maxWidth: 280 }} />
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <label style={{ margin: 0 }}>
                  Filtrar por horarios
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 8, textTransform: 'none', letterSpacing: 0 }}>
                    (opcional — dejá vacío para ver todos)
                  </span>
                </label>
                <button onClick={addSlotFilter} style={{ padding: '5px 12px', borderRadius: 8, border: '1px solid rgba(59,130,246,0.3)', background: 'rgba(59,130,246,0.1)', color: '#93c5fd', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>+ Agregar horario</button>
              </div>

              {slotFilters.length === 0 ? (
                <div style={{ padding: '12px 16px', border: '1px dashed var(--border)', borderRadius: 9, fontSize: 13, color: 'var(--text-muted)', textAlign: 'center' }}>
                  Sin filtros de horario — mostrando todos los profesores
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
                  {slotFilters.length > 1 && (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>ℹ️ Solo se muestran profes disponibles en todos los horarios</div>
                  )}
                </div>
              )}
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', margin: 0, fontSize: 13, color: 'var(--text-secondary)', textTransform: 'none', letterSpacing: 0 }}>
              <input type="checkbox" checked={onlyAvailable} onChange={e => setOnlyAvailable(e.target.checked)} style={{ width: 'auto', margin: 0 }} />
              Solo profesores con cupos disponibles
            </label>
          </div>

          {/* Recommended */}
          {recommended && (
            <div style={{ background: 'rgba(34,197,94,0.07)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: 12, padding: '14px 18px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 22 }}>⭐</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#4ade80', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Recomendado</div>
                <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>{recommended.name} — {recommended.freeSpots} cupos libres</div>
                {slotFilters.length > 0 && <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Disponible en: {slotFilters.map(sf => `${sf.day} ${sf.hour}`).join(' · ')}</div>}
              </div>
              <button onClick={() => setCalendarTeacher(recommended)} style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: '#22c55e', color: 'white', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>📅 Ver calendario →</button>
            </div>
          )}

          {/* Results */}
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', fontWeight: 600, marginBottom: 10 }}>
            {filtered.length} profesor{filtered.length !== 1 ? 'es' : ''}
            {slotFilters.length > 0 && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> con disponibilidad en los horarios pedidos</span>}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {filtered.length === 0 ? (
              <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '48px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
                Ningún profesor coincide con los filtros aplicados.
              </div>
            ) : filtered.map(t => {
              const loadPct = t.maxWeeklyLoad > 0 ? Math.round((t.weeklyLoad / t.maxWeeklyLoad) * 100) : 0;
              const loadColor = loadPct >= 90 ? '#ef4444' : loadPct >= 65 ? '#f59e0b' : '#22c55e';
              const isAssignable = true; // Allow setter to view any teacher's calendar
              return (
                <div key={t.id} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: '1 1 150px' }}>
                    <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--bg-surface-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', flexShrink: 0 }}>{t.avatar}</div>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>{t.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t.email}</div>
                    </div>
                  </div>
                  <StatusBadge status={t.status} />
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: isAssignable ? '#22c55e' : 'var(--text-muted)' }}>{t.freeSpots}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>cupos</div>
                  </div>
                  <div style={{ flex: '1 1 110px', minWidth: 100 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}><span>Carga</span><span>{t.weeklyLoad}h</span></div>
                    <div style={{ height: 5, borderRadius: 3, background: 'var(--bg-surface-3)' }}>
                      <div style={{ width: `${loadPct}%`, height: '100%', borderRadius: 3, background: loadColor }} />
                    </div>
                  </div>
                  <button onClick={() => setCalendarTeacher(t)} disabled={!isAssignable} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: isAssignable ? 'var(--accent-blue)' : 'var(--bg-surface-3)', color: isAssignable ? 'white' : 'var(--text-muted)', fontWeight: 700, fontSize: 13, cursor: isAssignable ? 'pointer' : 'not-allowed', flexShrink: 0 }}>
                    {'📅 Ver calendario'}
                  </button>
                </div>
              );
            })}
          </div>
        </>)}

        {/* History tab */}
        {activeTab === 'history' && (
          <div>
            {assignments.length === 0 ? (
              <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '48px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
                <div style={{ fontSize: 32, marginBottom: 10 }}>📋</div>
                Todavía no hay asignaciones en esta sesión.
              </div>
            ) : assignments.map(a => (
              <div key={a.id} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 18px', marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>{a.studentName}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                    👨‍🏫 {a.teacherName} · {a.slots.map(s => `${s.day} ${s.hour}`).join(' · ')} 🇪🇸
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
