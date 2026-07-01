'use client';
import { useState } from 'react';
import { dbCreateFullLink } from '@/lib/db';
import { Teacher, AssignedSlot } from '@/types';

const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const PLANES = [
  'Inglés general',
  'B1 Exámenes', 'B2 Exámenes', 'C1 Exámenes',
  'Intensivos Inglés general',
  'B1 Exámenes Intensivo', 'B2 Exámenes Intensivo', 'C1 Exámenes Intensivo',
];

// Modal "Crear vínculo completo": crea el student (si no existe) + la assignment
// para un alumno que aparece en el calendario del profesor pero no en las tablas.
export function CrearVinculoModal({
  studentName, teacher, slots, defaultEmail = '', defaultLevel = 'B1', defaultPlan = 'Inglés general', onClose, onDone,
}: {
  studentName: string;
  teacher: Teacher;
  slots: AssignedSlot[];
  defaultEmail?: string;
  defaultLevel?: string;
  defaultPlan?: string;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [name, setName] = useState(studentName);
  const [email, setEmail] = useState(defaultEmail);
  const [level, setLevel] = useState(LEVELS.includes(defaultLevel) ? defaultLevel : 'B1');
  const [plan, setPlan] = useState(defaultPlan);
  const [weeklyHours, setWeeklyHours] = useState(Math.max(slots.length, 1));
  const [startDate, setStartDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const canSave = name.trim() && email.trim().includes('@') && !saving;

  async function handleSave() {
    if (!canSave) { setError('Completá nombre y un email válido.'); return; }
    setSaving(true);
    setError('');
    try {
      await dbCreateFullLink({
        teacherId: teacher.id, teacherName: teacher.name, teacherEmail: teacher.email,
        name: name.trim(), email: email.trim(), level, plan,
        weeklyHours, startDate: startDate || undefined, slots,
      });
      onDone(`✅ ${name.trim()} vinculado correctamente con ${teacher.name}`);
    } catch {
      setError('No se pudo crear el vínculo. Reintentá.');
      setSaving(false);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', zIndex: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 18, width: '100%', maxWidth: 480, maxHeight: '92vh', overflowY: 'auto', padding: 26 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 18, color: 'var(--text-primary)' }}>🔗 Crear vínculo completo</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 3 }}>{studentName} · 👨‍🏫 {teacher.name}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 22, cursor: 'pointer' }}>✕</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
          <div><label>Nombre *</label><input value={name} onChange={e => setName(e.target.value)} /></div>
          <div><label>Email * <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>(obligatorio para vincular)</span></label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="alumno@gmail.com" autoFocus />
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 120px' }}><label>Nivel</label>
              <select value={level} onChange={e => setLevel(e.target.value)}>{LEVELS.map(l => <option key={l}>{l}</option>)}</select>
            </div>
            <div style={{ flex: '1 1 120px' }}><label>Horas semanales</label>
              <input type="number" min={1} max={5} value={weeklyHours} onChange={e => setWeeklyHours(Math.min(5, Math.max(1, parseInt(e.target.value) || 1)))} />
            </div>
          </div>
          <div><label>Plan</label>
            <select value={plan} onChange={e => setPlan(e.target.value)}>{PLANES.map(p => <option key={p}>{p}</option>)}</select>
          </div>
          <div><label>Fecha de inicio <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>(permite fechas pasadas)</span></label>
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ maxWidth: 200 }} />
          </div>
          <div>
            <label>Horarios (del calendario)</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {slots.length === 0 ? (
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Sin horarios en el grid</span>
              ) : slots.map((s, i) => (
                <span key={i} style={{ fontSize: 12, fontWeight: 600, padding: '3px 10px', borderRadius: 8, background: 'rgba(30,158,58,0.1)', color: '#1E9E3A', border: '1px solid rgba(30,158,58,0.3)' }}>
                  {s.day} {s.hour}
                </span>
              ))}
            </div>
          </div>
        </div>

        {error && <div style={{ fontSize: 12.5, color: '#ef4444', marginBottom: 12 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose} style={{ flex: 1, padding: '11px', borderRadius: 9, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 14 }}>Cancelar</button>
          <button onClick={handleSave} disabled={!canSave}
            style={{ flex: 2, padding: '11px', borderRadius: 9, border: 'none', background: canSave ? '#1E9E3A' : 'var(--bg-surface-3)', color: canSave ? 'white' : 'var(--text-muted)', cursor: canSave ? 'pointer' : 'not-allowed', fontSize: 14, fontWeight: 700 }}>
            {saving ? 'Creando...' : 'Crear vínculo ✓'}
          </button>
        </div>
      </div>
    </div>
  );
}
