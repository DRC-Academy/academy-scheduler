'use client';
import { useState, useMemo } from 'react';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { useTeachers } from '@/lib/TeachersContext';
import { DAYS, cellKey } from '@/components/VisualCalendar';
import { dbCheckStudentExists } from '@/lib/db';
import { Student, Grid, Assignment } from '@/types';

const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const PLANES = [
  'Inglés general', 'B1 Exámenes', 'B2 Exámenes', 'C1 Exámenes',
  'Intensivos Inglés general', 'B1 Exámenes Intensivo', 'B2 Exámenes Intensivo', 'C1 Exámenes Intensivo',
];

interface DisplayStudent {
  id: string;
  name: string;
  email: string;
  level: string;
  plan: string;
  inStudentsTable: boolean;
  createdAt: string;
}

// ── Duplicate Email Modal ─────────────────────────────────────────────────────
function DuplicateEmailModal({
  existingStudent, onCreateAnyway, onCancel,
}: { existingStudent: Student; onCreateAnyway: () => void; onCancel: () => void }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)', zIndex: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid #35405a', borderRadius: 14, padding: 24, width: '100%', maxWidth: 400 }}>
        <div style={{ fontSize: 24, marginBottom: 10 }}>⚠️</div>
        <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 8 }}>Este alumno ya existe</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20, lineHeight: 1.6 }}>
          Ya hay un alumno registrado con el email <b>{existingStudent.email}</b>:<br />
          <b style={{ color: 'var(--text-primary)' }}>{existingStudent.name}</b> · {existingStudent.level}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button onClick={onCreateAnyway} style={{ padding: '9px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-surface-3)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
            Crear de todas formas (duplicado)
          </button>
          <button onClick={onCancel} style={{ padding: '9px', borderRadius: 8, border: 'none', background: '#1E9E3A', color: 'white', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Edit Student Modal ────────────────────────────────────────────────────────
function EditStudentModal({ student, assignment, teacherGrid, onClose, onSave }: {
  student: DisplayStudent;
  assignment: Assignment | null;
  teacherGrid: Grid;
  onClose: () => void;
  onSave: (s: Student, scheduleData?: { slots: Array<{day:string;hour:string}>; startDate: string }) => Promise<void>;
}) {
  const [form, setForm] = useState({ name: student.name, email: student.email, level: student.level, plan: student.plan ?? '' });
  const [slots, setSlots] = useState<Array<{day:string;hour:string}>>(assignment?.slots || []);
  const [startDate, setStartDate] = useState(assignment?.startDate || '');
  const [saving, setSaving] = useState(false);

  // Available cells: libre + already assigned to this student
  const libreCells = useMemo(() => {
    const studentName = assignment?.studentName ?? student.name;
    return Object.entries(teacherGrid)
      .filter(([, cell]) =>
        cell.state === 'libre' ||
        (cell.state === 'ocupado' && cell.student === studentName)
      )
      .map(([key]) => { const [d, h] = key.split('_'); return { day: d, hour: h }; })
      .sort((a, b) => {
        const dA = DAYS.indexOf(a.day), dB = DAYS.indexOf(b.day);
        return dA !== dB ? dA - dB : parseInt(a.hour) - parseInt(b.hour);
      });
  }, [teacherGrid, assignment, student.name]);

  function getAvailableDays(i: number): string[] {
    const taken = new Set(slots.filter((s, idx) => idx !== i && s.day && s.hour).map(s => `${s.day}_${s.hour}`));
    const avail = new Set(libreCells.filter(c => !taken.has(`${c.day}_${c.hour}`)).map(c => c.day));
    return DAYS.filter(d => avail.has(d));
  }
  function getAvailableHours(i: number, selDay: string): string[] {
    const taken = new Set(slots.filter((s, idx) => idx !== i && s.day && s.hour).map(s => `${s.day}_${s.hour}`));
    return libreCells.filter(c => c.day === selDay && !taken.has(`${c.day}_${c.hour}`)).map(c => c.hour).sort((a, b) => parseInt(a) - parseInt(b));
  }
  function updateSlotDay(i: number, d: string) { setSlots(prev => prev.map((s, idx) => idx === i ? { day: d, hour: '' } : s)); }
  function updateSlotHour(i: number, h: string) { setSlots(prev => prev.map((s, idx) => idx === i ? { ...s, hour: h } : s)); }
  function addSlot() { setSlots(prev => [...prev, { day: '', hour: '' }]); }
  function removeSlot(i: number) { setSlots(prev => prev.filter((_, idx) => idx !== i)); }

  const allSlotsValid = slots.length === 0 || slots.every(s => s.day && s.hour);
  const canSave = !!form.name.trim() && !!form.email.trim() && allSlotsValid && !saving;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    const studentRecord: Student = { id: student.id, createdAt: student.createdAt, ...form };
    if (assignment && slots.length > 0) {
      await onSave(studentRecord, { slots, startDate });
    } else {
      await onSave(studentRecord);
    }
    setSaving(false);
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid #35405a', borderRadius: 16, width: '100%', maxWidth: 480, maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ padding: '22px 24px 18px', flexShrink: 0, borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontWeight: 700, fontSize: 18, color: 'var(--text-primary)' }}>Editar alumno</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 20, cursor: 'pointer' }}>✕</button>
        </div>

        {/* Scrollable body */}
        <div style={{ overflowY: 'auto', padding: '20px 24px 24px', flex: 1 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

            {/* Basic info */}
            <div><label>Nombre completo</label><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} autoFocus /></div>
            <div><label>Email</label><input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} /></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label>Nivel</label>
                <select value={form.level} onChange={e => setForm(f => ({ ...f, level: e.target.value }))}>
                  {LEVELS.map(l => <option key={l}>{l}</option>)}
                </select>
              </div>
              <div>
                <label>Plan</label>
                <select value={form.plan} onChange={e => setForm(f => ({ ...f, plan: e.target.value }))}>
                  <option value="">Sin plan</option>
                  {PLANES.map(p => <option key={p}>{p}</option>)}
                </select>
              </div>
            </div>

            {/* Schedule section */}
            {assignment && (
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginTop: 4 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 10 }}>
                  Horarios asignados
                </div>

                {/* Teacher name (read-only) */}
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontWeight: 600, color: 'var(--text-muted)' }}>Profesor:</span>
                  <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{assignment.teacherName}</span>
                </div>

                {/* Slot rows */}
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
                          <button onClick={() => removeSlot(i)} title="Eliminar horario"
                            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 2px', fontFamily: 'inherit' }}>
                            ×
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                {slots.length < 5 && libreCells.length > slots.length && (
                  <button onClick={addSlot}
                    style={{ fontSize: 12, color: '#1E9E3A', background: 'rgba(30,158,58,0.06)', border: '1px dashed rgba(30,158,58,0.4)', borderRadius: 7, padding: '4px 10px', cursor: 'pointer', fontFamily: 'inherit', marginBottom: 12 }}>
                    + Agregar horario
                  </button>
                )}

                {/* Start date */}
                <div>
                  <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Fecha de inicio
                  </label>
                  <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ width: '100%' }} />
                </div>

                {slots.length > 0 && (
                  <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)' }}>
                    {slots.length} clase{slots.length !== 1 ? 's' : ''}/semana
                    {!allSlotsValid && <span style={{ color: '#f59e0b', marginLeft: 8 }}>· Completá todos los horarios</span>}
                  </div>
                )}
              </div>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <button onClick={onClose} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 14, fontFamily: 'inherit' }}>
                Cancelar
              </button>
              <button onClick={handleSave} disabled={!canSave}
                style={{ flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: canSave ? '#1E9E3A' : 'var(--bg-surface-3)', color: canSave ? 'white' : 'var(--text-muted)', cursor: canSave ? 'pointer' : 'not-allowed', fontSize: 14, fontWeight: 600, fontFamily: 'inherit' }}>
                {saving ? 'Guardando...' : 'Guardar cambios'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StudentsContent() {
  const {
    students, assignments, deleteStudent, updateStudent,
    getTeacherGrid, updateTeacherGrid, updateAssignmentSlots, updateAssignmentStartDate,
  } = useTeachers();
  const [search, setSearch] = useState('');
  const [editingStudent, setEditingStudent] = useState<DisplayStudent | null>(null);
  const [editingAssignment, setEditingAssignment] = useState<Assignment | null>(null);
  const [teacherGridForEdit, setTeacherGridForEdit] = useState<Grid>({});
  const [duplicateStudent, setDuplicateStudent] = useState<Student | null>(null);

  // Merge students from both sources: students table + assignments
  const allStudents = useMemo<DisplayStudent[]>(() => {
    const map = new Map<string, DisplayStudent>();
    for (const s of students) {
      map.set(s.id, { id: s.id, name: s.name, email: s.email, level: s.level, plan: s.plan ?? '', inStudentsTable: true, createdAt: s.createdAt });
    }
    for (const a of assignments) {
      if (!map.has(a.studentId)) {
        map.set(a.studentId, { id: a.studentId, name: a.studentName, email: a.studentEmail, level: a.studentLevel, plan: a.plan ?? '', inStudentsTable: false, createdAt: a.createdAt });
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [students, assignments]);

  const filtered = useMemo(() => {
    if (!search.trim()) return allStudents;
    const q = search.toLowerCase();
    return allStudents.filter(s => s.name.toLowerCase().includes(q) || s.email.toLowerCase().includes(q));
  }, [allStudents, search]);

  async function handleEditClick(s: DisplayStudent) {
    const asgn = assignments.find(a => a.studentId === s.id || a.studentName === s.name) ?? null;
    let tGrid: Grid = {};
    if (asgn) {
      tGrid = await getTeacherGrid(asgn.teacherId);
    }
    setEditingAssignment(asgn);
    setTeacherGridForEdit(tGrid);
    setEditingStudent(s);
  }

  async function handleSave(updated: Student, scheduleData?: { slots: Array<{day:string;hour:string}>; startDate: string }) {
    await updateStudent(updated);
    if (editingAssignment && scheduleData) {
      const { slots, startDate } = scheduleData;
      await updateAssignmentSlots(editingAssignment.id, slots, slots.length);
      if (startDate !== editingAssignment.startDate) {
        await updateAssignmentStartDate(editingAssignment.id, startDate);
      }
      // Update teacher's grid
      const currentGrid = await getTeacherGrid(editingAssignment.teacherId);
      const updatedGrid = { ...currentGrid };
      for (const old of editingAssignment.slots) {
        if (!slots.some(s => s.day === old.day && s.hour === old.hour)) {
          updatedGrid[cellKey(old.day, old.hour)] = { state: 'libre' };
        }
      }
      for (const slot of slots) {
        if (slot.day && slot.hour) {
          updatedGrid[cellKey(slot.day, slot.hour)] = { state: 'ocupado', student: updated.name };
        }
      }
      await updateTeacherGrid(editingAssignment.teacherId, updatedGrid);
    }
    setEditingStudent(null);
    setEditingAssignment(null);
  }

  const thStyle = (minWidth?: number) => ({
    padding: '10px 14px', textAlign: 'left' as const,
    fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
    textTransform: 'uppercase' as const, letterSpacing: '0.04em',
    whiteSpace: 'nowrap' as const,
    minWidth: minWidth ? `${minWidth}px` : undefined,
  });

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }}>
      <NavBar />
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '32px 20px 48px' }}>
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 4px' }}>Alumnos</h1>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>Todos los alumnos registrados y asignados.</p>
        </div>

        {/* Search */}
        <div style={{ marginBottom: 16 }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por nombre o email..." style={{ maxWidth: 360 }} />
        </div>

        {allStudents.length === 0 ? (
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '48px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>👤</div>
            No hay alumnos registrados todavía.<br />
            <span style={{ fontSize: 12 }}>Los alumnos se agregan cuando un setter realiza una asignación.</span>
          </div>
        ) : (
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>Listado</span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {filtered.length === allStudents.length
                  ? `${allStudents.length} alumno${allStudents.length !== 1 ? 's' : ''}`
                  : `${filtered.length} de ${allStudents.length} alumnos`}
              </span>
            </div>

            {filtered.length === 0 ? (
              <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                Sin resultados para &quot;{search}&quot;
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-surface-2)' }}>
                      <th style={thStyle(160)}>Nombre</th>
                      <th style={thStyle(180)}>Email</th>
                      <th style={thStyle(70)}>Nivel</th>
                      <th style={thStyle(130)}>Plan</th>
                      <th style={thStyle(110)}>Profesor</th>
                      <th style={thStyle(160)}>Horarios</th>
                      <th style={{ ...thStyle(160), textAlign: 'right' }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(s => {
                      const studentAssignments = assignments.filter(a => a.studentId === s.id || a.studentName === s.name);
                      return (
                        <tr key={s.id} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td style={{ padding: '11px 14px', minWidth: 160 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                              <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'rgba(59,130,246,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: '#93c5fd', flexShrink: 0 }}>
                                {s.name.split(' ').map(p => p[0]).join('').toUpperCase().slice(0, 2)}
                              </div>
                              <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>{s.name}</span>
                            </div>
                          </td>
                          <td style={{ padding: '11px 14px', fontSize: 12, color: 'var(--text-secondary)', minWidth: 180 }}>{s.email}</td>
                          <td style={{ padding: '11px 14px', minWidth: 70 }}>
                            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 20, background: 'rgba(167,139,250,0.15)', color: '#a78bfa', fontWeight: 600 }}>{s.level || '—'}</span>
                          </td>
                          <td style={{ padding: '11px 14px', fontSize: 12, color: 'var(--text-secondary)', minWidth: 130 }}>
                            <span style={{ display: 'block', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.plan || '—'}</span>
                          </td>
                          <td style={{ padding: '11px 14px', minWidth: 110 }}>
                            {studentAssignments.length === 0 ? (
                              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>—</span>
                            ) : (
                              <div>{studentAssignments.map((a, i) => (
                                <div key={i} style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 1, whiteSpace: 'nowrap' }}>{a.teacherName}</div>
                              ))}</div>
                            )}
                          </td>
                          <td style={{ padding: '11px 14px', minWidth: 160 }}>
                            {studentAssignments.length === 0 ? (
                              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>—</span>
                            ) : (
                              <div>{studentAssignments.map((a, i) => (
                                <div key={i} style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 1 }}>
                                  {a.slots.map(sl => `${sl.day} ${sl.hour}`).join(', ')}
                                </div>
                              ))}</div>
                            )}
                          </td>
                          <td style={{ padding: '11px 14px', minWidth: 160 }}>
                            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                              {s.inStudentsTable && (
                                <button onClick={() => handleEditClick(s)}
                                  style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', fontFamily: 'inherit' }}>
                                  Editar
                                </button>
                              )}
                              <button onClick={() => deleteStudent(s.id, s.name)}
                                style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.08)', color: '#ef4444', cursor: 'pointer', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', fontFamily: 'inherit' }}>
                                Eliminar
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {editingStudent && (
        <EditStudentModal
          student={editingStudent}
          assignment={editingAssignment}
          teacherGrid={teacherGridForEdit}
          onClose={() => { setEditingStudent(null); setEditingAssignment(null); }}
          onSave={handleSave}
        />
      )}

      {duplicateStudent && (
        <DuplicateEmailModal
          existingStudent={duplicateStudent}
          onCreateAnyway={() => setDuplicateStudent(null)}
          onCancel={() => setDuplicateStudent(null)}
        />
      )}
    </div>
  );
}

export default function StudentsPage() {
  return (
    <AuthGuard allowedRoles={['admin', 'setter']}>
      <StudentsContent />
    </AuthGuard>
  );
}
