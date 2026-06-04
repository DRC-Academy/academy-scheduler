'use client';
import { useState } from 'react';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { useTeachers } from '@/lib/TeachersContext';
import { Student } from '@/types';

const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const PLANES = [
  'Inglés general', 'B1 Exámenes', 'B2 Exámenes', 'C1 Exámenes',
  'Intensivos Inglés general', 'B1 Exámenes Intensivo', 'B2 Exámenes Intensivo', 'C1 Exámenes Intensivo',
];

function EditStudentModal({ student, onClose, onSave }: {
  student: Student;
  onClose: () => void;
  onSave: (s: Student) => Promise<void>;
}) {
  const [form, setForm] = useState({ name: student.name, email: student.email, level: student.level, plan: student.plan ?? '' });
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!form.name.trim() || !form.email.trim()) return;
    setSaving(true);
    await onSave({ ...student, ...form });
    setSaving(false);
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid #35405a', borderRadius: 16, width: '100%', maxWidth: 440, padding: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 }}>
          <div style={{ fontWeight: 700, fontSize: 18, color: 'var(--text-primary)' }}>Editar alumno</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 20, cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label>Nombre completo</label>
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} autoFocus />
          </div>
          <div>
            <label>Email</label>
            <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
          </div>
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
          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <button onClick={onClose} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 14 }}>
              Cancelar
            </button>
            <button
              onClick={handleSave}
              disabled={!form.name.trim() || !form.email.trim() || saving}
              style={{ flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: form.name && form.email && !saving ? 'var(--accent-blue)' : 'var(--bg-surface-3)', color: form.name && form.email && !saving ? 'white' : 'var(--text-muted)', cursor: form.name && form.email && !saving ? 'pointer' : 'not-allowed', fontSize: 14, fontWeight: 600 }}>
              {saving ? 'Guardando...' : 'Guardar cambios'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function StudentsContent() {
  const { students, assignments, deleteStudent, updateStudent } = useTeachers();
  const [search, setSearch] = useState('');
  const [editingStudent, setEditingStudent] = useState<Student | null>(null);

  const filtered = students.filter(s => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return s.name.toLowerCase().includes(q) || s.email.toLowerCase().includes(q);
  });

  async function handleSave(updated: Student) {
    await updateStudent(updated);
    setEditingStudent(null);
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }}>
      <NavBar />
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '32px 24px' }}>
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 4px' }}>Alumnos</h1>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>Alumnos registrados. Se agregan automáticamente al asignar clases.</p>
        </div>

        {/* Search */}
        <div style={{ marginBottom: 16 }}>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar por nombre o email..."
            style={{ maxWidth: 360 }}
          />
        </div>

        {students.length === 0 ? (
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
                {filtered.length === students.length
                  ? `${students.length} alumno${students.length !== 1 ? 's' : ''}`
                  : `${filtered.length} de ${students.length} alumnos`}
              </span>
            </div>

            {filtered.length === 0 ? (
              <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                Sin resultados para &quot;{search}&quot;
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-surface-2)' }}>
                    {['Nombre', 'Email', 'Nivel', 'Plan', 'Asignaciones', ''].map(h => (
                      <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(s => {
                    const studentAssignments = assignments.filter(a => a.studentId === s.id || a.studentName === s.name);
                    return (
                      <tr key={s.id} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '12px 16px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                            <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'rgba(59,130,246,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: '#93c5fd', flexShrink: 0 }}>
                              {s.name.split(' ').map(p => p[0]).join('').toUpperCase().slice(0, 2)}
                            </div>
                            <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>{s.name}</span>
                          </div>
                        </td>
                        <td style={{ padding: '12px 16px', fontSize: 13, color: 'var(--text-secondary)' }}>{s.email}</td>
                        <td style={{ padding: '12px 16px' }}>
                          <span style={{ fontSize: 12, padding: '2px 9px', borderRadius: 20, background: 'rgba(167,139,250,0.15)', color: '#a78bfa', fontWeight: 600 }}>{s.level}</span>
                        </td>
                        <td style={{ padding: '12px 16px', fontSize: 13, color: 'var(--text-secondary)' }}>{s.plan || '—'}</td>
                        <td style={{ padding: '12px 16px' }}>
                          {studentAssignments.length === 0 ? (
                            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>—</span>
                          ) : studentAssignments.map((a, i) => (
                            <div key={i} style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 2 }}>
                              {a.teacherName} · {a.slots.map(sl => `${sl.day} ${sl.hour}`).join(', ')}
                            </div>
                          ))}
                        </td>
                        <td style={{ padding: '12px 16px' }}>
                          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                            <button
                              onClick={() => setEditingStudent(s)}
                              style={{ padding: '5px 11px', borderRadius: 7, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                              Editar
                            </button>
                            <button
                              onClick={() => deleteStudent(s.id)}
                              style={{ padding: '5px 11px', borderRadius: 7, border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.08)', color: '#ef4444', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                              Eliminar
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {editingStudent && (
        <EditStudentModal
          student={editingStudent}
          onClose={() => setEditingStudent(null)}
          onSave={handleSave}
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
