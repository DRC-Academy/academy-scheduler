'use client';
import { useState, useEffect } from 'react';
import { NavBar } from '@/components/NavBar';
import { StatusBadge } from '@/components/StatusBadge';
import { AuthGuard } from '@/components/AuthGuard';
import { DAYS, HOURS_ES, stateColor, VisualCalendar, buildGridFromTeacher } from '@/components/VisualCalendar';
import { useTeachers } from '@/lib/TeachersContext';
import { useAuth } from '@/lib/AuthContext';
import { mockAlerts } from '@/lib/mock-data';
import { Teacher, Grid, Assignment, ScoringEvent, ScoringEventType } from '@/types';
import { EVENT_POINTS, EVENT_EUROS } from '@/lib/db';

// ─── Scoring constants ────────────────────────────────────────────────────────
const LEVEL_INFO = {
  1: { name: 'Profesor Junior', color: '#6b7280', bg: 'rgba(107,114,128,0.12)', border: 'rgba(107,114,128,0.35)' },
  2: { name: 'Profesor Senior', color: '#1E9E3A', bg: 'rgba(30,158,58,0.12)',   border: 'rgba(30,158,58,0.4)' },
  3: { name: 'Profesor Elite',  color: '#b8860b', bg: 'rgba(255,196,0,0.15)',   border: '#FFC400' },
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

// ─── New teacher modal ────────────────────────────────────────────────────────
function NewTeacherModal({ onClose, onSave }: { onClose: () => void; onSave: (t: Teacher, username: string) => void }) {
  const [form, setForm] = useState({ name: '', email: '', username: '' });
  const [saved, setSaved] = useState(false);

  function handleSave() {
    if (!form.name || !form.email) return;
    const avatar = form.name.split(' ').map((p: string) => p[0]).join('').toUpperCase().slice(0, 2);
    const username = form.username.trim() || form.name.toLowerCase().replace(/\s+/g, '').normalize('NFD').replace(/[̀-ͯ]/g, '');
    onSave({
      id: `t_${Date.now()}`, name: form.name, email: form.email, avatar,
      status: 'no_availability', weeklyLoad: 0, maxWeeklyLoad: 20,
      freeSpots: 0, totalSpots: 0, specialties: ['Inglés'],
      timeSlots: [], blockedSlots: [], vacations: [], upcomingClasses: [],
    }, username);
    setSaved(true);
    setTimeout(() => { setSaved(false); onClose(); }, 1800);
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid #35405a', borderRadius: 16, width: '100%', maxWidth: 440, padding: 28 }}>
        {saved ? (
          <div style={{ textAlign: 'center', padding: '32px 0' }}>
            <div style={{ fontSize: 44, marginBottom: 12 }}>✅</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>{form.name} agregado</div>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 }}>
              <div style={{ fontWeight: 700, fontSize: 18, color: 'var(--text-primary)' }}>Nuevo profesor</div>
              <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 20, cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div><label>Nombre completo</label><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Ej: María López" autoFocus /></div>
              <div><label>Email</label><input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="maria@drcacademy.com" /></div>
              <div><label>Usuario para login</label><input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} placeholder="Ej: maria (sin espacios, sin acentos)" /></div>
              <div style={{ background: 'rgba(59,130,246,0.07)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: 'var(--text-secondary)' }}>
                💡 Usuario para login: nombre en minúsculas · Contraseña: <code style={{ color: '#93c5fd' }}>profe123</code>
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                <button onClick={onClose} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 14 }}>Cancelar</button>
                <button onClick={handleSave} disabled={!form.name || !form.email} style={{ flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: form.name && form.email ? 'var(--accent-blue)' : 'var(--bg-surface-3)', color: form.name && form.email ? 'white' : 'var(--text-muted)', cursor: form.name && form.email ? 'pointer' : 'not-allowed', fontSize: 14, fontWeight: 600 }}>
                  Agregar profesor
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Weekly overview grid ─────────────────────────────────────────────────────
function WeeklyOverview({ teachers }: { teachers: Teacher[] }) {
  const [hoveredCell, setHoveredCell] = useState<string | null>(null);

  const coverageMap: Record<string, string[]> = {};
  for (const t of teachers) {
    for (const slot of t.timeSlots) {
      const fromH = parseInt(slot.from);
      const toH   = parseInt(slot.to);
      for (let h = fromH; h < toH; h++) {
        const hour = `${h.toString().padStart(2, '0')}:00`;
        const key  = `${slot.day}_${hour}`;
        if (!coverageMap[key]) coverageMap[key] = [];
        coverageMap[key].push(t.name);
      }
    }
  }

  function coverageColor(count: number): string {
    if (count === 0) return 'transparent';
    if (count === 1) return 'rgba(239,68,68,0.25)';
    if (count === 2) return 'rgba(245,158,11,0.25)';
    if (count <= 4)  return 'rgba(34,197,94,0.2)';
    return 'rgba(34,197,94,0.4)';
  }

  function coverageBorder(count: number): string {
    if (count === 0) return 'rgba(42,51,71,0.3)';
    if (count === 1) return 'rgba(239,68,68,0.4)';
    if (count === 2) return 'rgba(245,158,11,0.4)';
    return 'rgba(34,197,94,0.4)';
  }

  const hours = HOURS_ES;

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        {[
          { label: 'Sin cobertura', color: 'rgba(239,68,68,0.4)' },
          { label: '1 profe', color: 'rgba(239,68,68,0.25)' },
          { label: '2 profes', color: 'rgba(245,158,11,0.25)' },
          { label: '3–4 profes', color: 'rgba(34,197,94,0.2)' },
          { label: '5+ profes', color: 'rgba(34,197,94,0.4)' },
        ].map(l => (
          <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 14, height: 14, borderRadius: 3, background: l.color, border: '1px solid rgba(255,255,255,0.1)' }} />
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{l.label}</span>
          </div>
        ))}
        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>Hover para ver quién está disponible</span>
      </div>

      <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid var(--border)' }}>
        <table style={{ borderCollapse: 'collapse', minWidth: 600, width: '100%' }}>
          <thead>
            <tr>
              <th style={{ padding: '8px 10px', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', background: 'var(--bg-surface-2)', borderBottom: '1px solid var(--border)', textAlign: 'left', position: 'sticky', left: 0, zIndex: 2, minWidth: 72 }}>Hora</th>
              {DAYS.map(day => (
                <th key={day} style={{ padding: '8px 6px', fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', background: 'var(--bg-surface-2)', borderBottom: '1px solid var(--border)', textAlign: 'center', minWidth: 90 }}>{day}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {hours.map(hour => (
              <tr key={hour} style={{ borderBottom: '1px solid rgba(42,51,71,0.4)' }}>
                <td style={{ padding: '4px 10px', fontSize: 11, color: 'var(--text-secondary)', background: 'var(--bg-surface-2)', position: 'sticky', left: 0, zIndex: 1, borderRight: '1px solid var(--border)', fontWeight: 600 }}>{hour}</td>
                {DAYS.map(day => {
                  const key = `${day}_${hour}`;
                  const names = coverageMap[key] ?? [];
                  const count = names.length;
                  const isHovered = hoveredCell === key;
                  return (
                    <td key={day}
                      onMouseEnter={() => setHoveredCell(key)}
                      onMouseLeave={() => setHoveredCell(null)}
                      style={{ height: 36, padding: '2px 4px', background: isHovered && count > 0 ? 'rgba(59,130,246,0.2)' : coverageColor(count), border: `1px solid ${coverageBorder(count)}`, textAlign: 'center', verticalAlign: 'middle', cursor: count > 0 ? 'pointer' : 'default', transition: 'background 0.1s', position: 'relative' }}>
                      {count > 0 && (
                        <span style={{ fontSize: 11, fontWeight: 700, color: count === 1 ? '#ef4444' : count === 2 ? '#f59e0b' : '#4ade80' }}>{count}</span>
                      )}
                      {isHovered && count > 0 && (
                        <div style={{ position: 'absolute', bottom: '110%', left: '50%', transform: 'translateX(-50%)', background: 'var(--bg-surface)', border: '1px solid var(--border-light, #35405a)', borderRadius: 8, padding: '8px 12px', zIndex: 10, minWidth: 140, maxWidth: 200, boxShadow: '0 8px 24px rgba(0,0,0,0.4)', whiteSpace: 'nowrap' }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 5, textTransform: 'uppercase' }}>{day} {hour}</div>
                          {names.map(n => <div key={n} style={{ fontSize: 11, color: 'var(--text-primary)', padding: '1px 0' }}>• {n}</div>)}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Edit Calendar Modal ──────────────────────────────────────────────────────
function EditCalendarModal({ teacher, onClose, getTeacherGrid, updateTeacherGrid }: {
  teacher: Teacher;
  onClose: () => void;
  getTeacherGrid: (id: string) => Promise<Grid>;
  updateTeacherGrid: (id: string, grid: Grid) => Promise<void>;
}) {
  const [grid, setGrid] = useState<Grid>(buildGridFromTeacher(teacher.timeSlots, teacher.upcomingClasses));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getTeacherGrid(teacher.id).then(g => {
      setGrid(Object.keys(g).length > 0 ? g : buildGridFromTeacher(teacher.timeSlots, teacher.upcomingClasses));
      setLoading(false);
    });
  }, [teacher.id]);

  async function handleGridChange(g: Grid) {
    setGrid(g);
    setSaving(true);
    await updateTeacherGrid(teacher.id, g);
    setSaving(false);
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(6px)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid #35405a', borderRadius: 18, width: '100%', maxWidth: 940, maxHeight: '94vh', overflowY: 'auto', padding: 26 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 42, height: 42, borderRadius: '50%', background: 'var(--bg-surface-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 15, color: 'var(--text-secondary)' }}>{teacher.avatar}</div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 17, color: 'var(--text-primary)' }}>Disponibilidad de {teacher.name}</div>
              <div style={{ fontSize: 12, color: saving ? '#fbbf24' : 'var(--text-secondary)' }}>
                {saving ? '💾 Guardando...' : '✏️ Clic en cualquier celda para cambiar estado · Guarda automáticamente'}
              </div>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 22, cursor: 'pointer' }}>✕</button>
        </div>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-muted)' }}>Cargando calendario...</div>
        ) : (
          <VisualCalendar mode="teacher" grid={grid} onGridChange={handleGridChange} />
        )}
      </div>
    </div>
  );
}

// ─── Star Rating ──────────────────────────────────────────────────────────────
function StarRating({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [hover, setHover] = useState(0);
  return (
    <div style={{ display: 'flex', gap: 1 }}>
      {[1, 2, 3, 4, 5].map(i => (
        <button key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(0)} onClick={() => onChange(i === value ? 0 : i)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 1px', fontSize: 17, color: i <= (hover || value) ? '#FFC400' : 'var(--text-muted)', transition: 'color 0.1s', lineHeight: 1 }}>
          ★
        </button>
      ))}
    </div>
  );
}

// ─── Level Badge ──────────────────────────────────────────────────────────────
function LevelBadge({ level }: { level: number }) {
  const info = LEVEL_INFO[(level as 1 | 2 | 3)] ?? LEVEL_INFO[1];
  const isElite = level === 3;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '3px 10px', borderRadius: 20,
      background: info.bg, border: `1px solid ${info.border}`,
      color: info.color, fontSize: 11, fontWeight: 700,
      boxShadow: isElite ? '0 0 8px rgba(255,196,0,0.35)' : 'none',
      whiteSpace: 'nowrap',
    }}>
      {isElite ? '⭐ ' : ''}{info.name}
    </span>
  );
}

// ─── Event Modal ──────────────────────────────────────────────────────────────
function EventModal({ teacher, students, createdBy, onClose, onSave }: {
  teacher: Teacher;
  students: { id: string; name: string }[];
  createdBy: string;
  onClose: () => void;
  onSave: (event: Omit<ScoringEvent, 'id' | 'createdAt'>) => Promise<void>;
}) {
  const [eventType, setEventType] = useState<ScoringEventType>('upsell');
  const [note, setNote] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [studentRef, setStudentRef] = useState('');
  const [saving, setSaving] = useState(false);

  const basePoints = EVENT_POINTS[eventType] ?? 0;
  const baseEuros  = EVENT_EUROS[eventType] ?? 0;
  const totalEuros = eventType === 'upsell' ? baseEuros * quantity : baseEuros;
  const isPositive = basePoints > 0;

  async function handleSave() {
    if (!note.trim()) return;
    setSaving(true);
    await onSave({
      teacherId:   teacher.id,
      teacherName: teacher.name,
      eventType,
      points:      basePoints,
      euros:       totalEuros,
      note:        note.trim(),
      createdBy,
      studentRef:  studentRef || undefined,
      quantity:    eventType === 'upsell' ? quantity : undefined,
    });
    setSaving(false);
    onClose();
  }

  const inputStyle = {
    width: '100%', padding: '10px 12px', borderRadius: 8,
    border: '1px solid #d1d5db', fontSize: 13,
    background: 'white', color: '#111827',
    boxSizing: 'border-box' as const,
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: '#F7F7F5', border: '1px solid #e5e7eb', borderRadius: 16, width: '100%', maxWidth: 480, padding: 28, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 17, color: '#111827' }}>➕ Cargar evento</div>
            <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>para {teacher.name}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#6b7280' }}>✕</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>Tipo de evento</label>
            <select value={eventType} onChange={e => setEventType(e.target.value as ScoringEventType)} style={inputStyle}>
              <optgroup label="Eventos negativos">
                <option value="falta">Falta a clase (−15 pts)</option>
                <option value="atraso">Atraso (−8 pts)</option>
                <option value="queja">Queja de alumno (−20 pts)</option>
                <option value="cancelacion_tardia">Cancelación tardía &lt;24hs (−10 pts)</option>
              </optgroup>
              <optgroup label="Eventos positivos">
                <option value="upsell">Upsell (+25 pts + €20/upsell)</option>
                <option value="bonus_retencion">Bonus retención 6 meses (+30 pts + €30)</option>
                <option value="bonus_puntualidad">Bonus puntualidad del mes (+20 pts)</option>
                <option value="review_trustpilot">Reseña Trustpilot (+15 pts)</option>
                <option value="bonus_feedback">Bonus feedback mensual (+10 pts)</option>
              </optgroup>
            </select>
          </div>

          {eventType === 'upsell' && (
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>Cantidad de upsells</label>
              <input type="number" min={1} value={quantity} onChange={e => setQuantity(Math.max(1, parseInt(e.target.value) || 1))} style={inputStyle} />
            </div>
          )}

          {eventType === 'bonus_retencion' && (
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>Alumno que cumplió 6 meses</label>
              <select value={studentRef} onChange={e => setStudentRef(e.target.value)} style={inputStyle}>
                <option value="">— Seleccionar alumno —</option>
                {students.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
              </select>
            </div>
          )}

          {eventType === 'review_trustpilot' && (
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>Alumno que dejó la reseña</label>
              <input value={studentRef} onChange={e => setStudentRef(e.target.value)} placeholder="Nombre del alumno" style={inputStyle} />
            </div>
          )}

          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
              Nota <span style={{ color: '#ef4444' }}>*</span>
            </label>
            <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="Descripción del evento..." rows={3}
              style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
          </div>

          <div style={{ background: isPositive ? 'rgba(30,158,58,0.08)' : 'rgba(239,68,68,0.08)', border: `1px solid ${isPositive ? 'rgba(30,158,58,0.3)' : 'rgba(239,68,68,0.3)'}`, borderRadius: 8, padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 14, color: isPositive ? '#1E9E3A' : '#ef4444', fontWeight: 700 }}>
              {isPositive ? '+' : ''}{basePoints} puntos
            </span>
            {totalEuros > 0 && (
              <span style={{ fontSize: 14, color: '#1E9E3A', fontWeight: 700 }}>+€{totalEuros}</span>
            )}
          </div>

          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <button onClick={onClose} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid #d1d5db', background: 'transparent', color: '#6b7280', cursor: 'pointer', fontSize: 14 }}>Cancelar</button>
            <button onClick={handleSave} disabled={!note.trim() || saving}
              style={{ flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: note.trim() && !saving ? '#1E9E3A' : '#d1d5db', color: 'white', cursor: note.trim() && !saving ? 'pointer' : 'not-allowed', fontSize: 14, fontWeight: 600 }}>
              {saving ? 'Guardando...' : 'Confirmar evento'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Level Requirements helper ────────────────────────────────────────────────
function checkLevelReqs(activeStudents: number, retentionPct: number, faltasThisMonth: number, quejasActive: number, upsellsTotal: number, monthsOnPlatform: number, level: number) {
  if (level === 1) return [
    { label: `Retención ≥50% (actual: ${Math.round(retentionPct)}%)`, met: retentionPct >= 50 },
    { label: `Faltas ≤3 este mes (actual: ${faltasThisMonth})`, met: faltasThisMonth <= 3 },
    { label: `Sin quejas activas (actual: ${quejasActive})`, met: quejasActive === 0 },
  ];
  if (level === 2) return [
    { label: `Retención ≥70% (actual: ${Math.round(retentionPct)}%)`, met: retentionPct >= 70 },
    { label: `Faltas ≤1 este mes (actual: ${faltasThisMonth})`, met: faltasThisMonth <= 1 },
    { label: `≥5 alumnos activos (actual: ${activeStudents})`, met: activeStudents >= 5 },
    { label: `≥1 upsell realizado (actual: ${upsellsTotal})`, met: upsellsTotal >= 1 },
  ];
  return [
    { label: `Retención ≥85% (actual: ${Math.round(retentionPct)}%)`, met: retentionPct >= 85 },
    { label: `Cero faltas este mes (actual: ${faltasThisMonth})`, met: faltasThisMonth === 0 },
    { label: `≥10 alumnos activos (actual: ${activeStudents})`, met: activeStudents >= 10 },
    { label: `≥3 upsells realizados (actual: ${upsellsTotal})`, met: upsellsTotal >= 3 },
    { label: `>6 meses en la plataforma (actual: ${monthsOnPlatform})`, met: monthsOnPlatform >= 6 },
  ];
}

// ─── Scoring Tab ──────────────────────────────────────────────────────────────
function ScoringTab() {
  const { teachers, assignments, students, scoringEvents, addScoringEvent, updateTeacherRating } = useTeachers();
  const { user } = useAuth();
  const [eventModalTeacher, setEventModalTeacher] = useState<Teacher | null>(null);
  const [selectedTeacherId, setSelectedTeacherId] = useState<string | null>(null);
  const [showLevelReqs, setShowLevelReqs] = useState(false);

  const MEDALS = ['🥇', '🥈', '🥉'];
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const monthStart    = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  const scored = teachers.map(t => {
    const ta = assignments.filter(a => a.teacherId === t.id);
    const te = scoringEvents.filter(e => e.teacherId === t.id);
    const monthEvents = te.filter(e => new Date(e.createdAt) >= monthStart);

    const manualPoints   = te.reduce((s, e) => s + e.points, 0);
    const manualEuros    = te.reduce((s, e) => s + e.euros, 0);
    const activeStudents = ta.length;
    const monthlyHours   = t.weeklyLoad * 4;
    const retained       = ta.filter(a => new Date(a.createdAt) < thirtyDaysAgo).length;
    const retentionPct   = activeStudents > 0 ? (retained / activeStudents) * 100 : 0;

    let autoPoints = activeStudents * 10 + monthlyHours * 2;
    if (retentionPct > 85)                           autoPoints += 50;
    else if (retentionPct >= 70)                     autoPoints += 25;
    else if (retentionPct < 50 && activeStudents > 0) autoPoints -= 20;

    const totalScore   = Math.max(0, manualPoints + autoPoints);
    const currentLevel = totalScore >= 300 ? 3 : totalScore >= 150 ? 2 : 1;
    const monthlyEuros = monthEvents.reduce((s, e) => s + e.euros, 0);

    const faltasThisMonth  = monthEvents.filter(e => e.eventType === 'falta').length;
    const quejasActive     = monthEvents.filter(e => e.eventType === 'queja').length;
    const upsellsTotal     = te.filter(e => e.eventType === 'upsell').reduce((s, e) => s + (e.quantity ?? 1), 0);
    const monthsOnPlatform = t.createdAt
      ? Math.floor((Date.now() - new Date(t.createdAt).getTime()) / (30 * 24 * 60 * 60 * 1000))
      : 0;

    return { t, totalScore, totalEuros: manualEuros, currentLevel, activeStudents, retentionPct, monthlyEuros, faltasThisMonth, quejasActive, upsellsTotal, monthsOnPlatform };
  }).sort((a, b) => b.totalScore - a.totalScore);

  const selectedData   = selectedTeacherId ? scored.find(s => s.t.id === selectedTeacherId) : null;
  const selectedEvents = selectedTeacherId ? scoringEvents.filter(e => e.teacherId === selectedTeacherId) : [];

  // Teacher students (assignments for the teacher, for event modal)
  const eventModalStudents = eventModalTeacher
    ? assignments.filter(a => a.teacherId === eventModalTeacher.id).map(a => ({ id: a.studentId, name: a.studentName }))
    : [];

  return (
    <div>
      {/* ── Ranking table ── */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' }}>⭐ Ranking de profesores</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              Score = eventos manuales + alumnos×10 + horas×2 + bonus retención
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            {[
              { color: '#6b7280', label: 'Junior (0–149)' },
              { color: '#1E9E3A', label: 'Senior (150–299)' },
              { color: '#FFC400', label: 'Elite (300+)' },
            ].map(l => (
              <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <div style={{ width: 9, height: 9, borderRadius: '50%', background: l.color }} />
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{l.label}</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-surface-2)' }}>
                {['Pos.', 'Nombre', 'Nivel', 'Score', 'Alumnos', 'Retención', '€ mes', 'Nota', ''].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {scored.map(({ t, totalScore, currentLevel, activeStudents, retentionPct, monthlyEuros }, idx) => {
                const info = LEVEL_INFO[(currentLevel as 1|2|3)];
                const isSelected = selectedTeacherId === t.id;
                const nextThreshold = currentLevel === 1 ? 150 : currentLevel === 2 ? 300 : 300;
                const prevThreshold = currentLevel === 1 ? 0   : currentLevel === 2 ? 150 : 300;
                const scorePct = currentLevel < 3
                  ? Math.min(100, ((totalScore - prevThreshold) / (nextThreshold - prevThreshold)) * 100)
                  : 100;
                return (
                  <tr key={t.id} onClick={() => setSelectedTeacherId(isSelected ? null : t.id)}
                    style={{ borderBottom: '1px solid var(--border)', background: isSelected ? 'rgba(30,158,58,0.05)' : idx === 0 ? 'rgba(255,196,0,0.03)' : 'transparent', cursor: 'pointer', transition: 'background 0.1s' }}>
                    <td style={{ padding: '12px 12px', fontSize: idx < 3 ? 22 : 13, fontWeight: idx >= 3 ? 600 : 400, color: 'var(--text-muted)' }}>
                      {idx < 3 ? MEDALS[idx] : `#${idx + 1}`}
                    </td>
                    <td style={{ padding: '12px 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 34, height: 34, borderRadius: '50%', background: info.bg, border: `1px solid ${info.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: info.color, flexShrink: 0 }}>{t.avatar}</div>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{t.name}</div>
                          {t.createdAt && <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>desde {new Date(t.createdAt).toLocaleDateString('es-ES', { month: 'short', year: 'numeric' })}</div>}
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: '12px 12px' }}><LevelBadge level={currentLevel} /></td>
                    <td style={{ padding: '12px 12px', minWidth: 130 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--bg-surface-3)', overflow: 'hidden' }}>
                          <div style={{ width: `${scorePct}%`, height: '100%', borderRadius: 3, background: info.color, transition: 'width 0.4s' }} />
                        </div>
                        <span style={{ fontSize: 14, fontWeight: 700, color: info.color, minWidth: 36, textAlign: 'right' }}>{totalScore}</span>
                      </div>
                    </td>
                    <td style={{ padding: '12px 12px', fontSize: 15, fontWeight: 700, color: '#1E9E3A' }}>{activeStudents}</td>
                    <td style={{ padding: '12px 12px', fontSize: 13, color: retentionPct >= 85 ? '#1E9E3A' : retentionPct >= 70 ? '#f59e0b' : 'var(--text-secondary)' }}>
                      {Math.round(retentionPct)}%
                    </td>
                    <td style={{ padding: '12px 12px', fontSize: 13, fontWeight: 600, color: monthlyEuros > 0 ? '#1E9E3A' : 'var(--text-muted)' }}>
                      {monthlyEuros > 0 ? `€${monthlyEuros}` : '—'}
                    </td>
                    <td style={{ padding: '12px 12px' }} onClick={e => e.stopPropagation()}>
                      <StarRating value={t.internalRating ?? 0} onChange={v => updateTeacherRating(t.id, v)} />
                    </td>
                    <td style={{ padding: '12px 8px' }} onClick={e => e.stopPropagation()}>
                      <button onClick={() => setEventModalTeacher(t)}
                        style={{ padding: '5px 10px', borderRadius: 7, border: '1px solid #1E9E3A', background: 'rgba(30,158,58,0.1)', color: '#1E9E3A', cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
                        ➕ Evento
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Selected teacher panel ── */}
      {selectedData && (
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '20px 24px', marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>📋 {selectedData.t.name}</div>
              <LevelBadge level={selectedData.currentLevel} />
            </div>
            <button onClick={() => setSelectedTeacherId(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {/* Level requirements */}
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>Requisitos de nivel</div>
              {[1, 2, 3].map(lvl => {
                const reqs = checkLevelReqs(selectedData.activeStudents, selectedData.retentionPct, selectedData.faltasThisMonth, selectedData.quejasActive, selectedData.upsellsTotal, selectedData.monthsOnPlatform, lvl);
                const info = LEVEL_INFO[(lvl as 1|2|3)];
                const allMet = reqs.every(r => r.met);
                return (
                  <div key={lvl} style={{ border: `1px solid ${allMet ? info.border : 'var(--border)'}`, borderRadius: 8, padding: '10px 12px', marginBottom: 8, background: allMet ? info.bg : 'transparent' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: info.color, marginBottom: 6 }}>{info.name}</div>
                    {reqs.map(r => (
                      <div key={r.label} style={{ fontSize: 11, color: r.met ? '#1E9E3A' : 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                        <span>{r.met ? '✅' : '❌'}</span> {r.label}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>

            {/* Event history */}
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
                Historial de eventos ({selectedEvents.length})
              </div>
              {selectedEvents.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', padding: '24px 0' }}>Sin eventos registrados</div>
              ) : selectedEvents.slice(0, 12).map(ev => {
                const isPos = ev.points > 0;
                return (
                  <div key={ev.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '8px 10px', borderRadius: 7, background: isPos ? 'rgba(30,158,58,0.07)' : 'rgba(239,68,68,0.07)', border: `1px solid ${isPos ? 'rgba(30,158,58,0.2)' : 'rgba(239,68,68,0.2)'}`, marginBottom: 6 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: isPos ? '#1E9E3A' : '#ef4444' }}>{EVENT_LABELS[ev.eventType] ?? ev.eventType}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{ev.note}</div>
                      {ev.studentRef && <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>Alumno: {ev.studentRef}</div>}
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{new Date(ev.createdAt).toLocaleDateString('es-ES')} · por {ev.createdBy}</div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 10 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: isPos ? '#1E9E3A' : '#ef4444' }}>{isPos ? '+' : ''}{ev.points}</div>
                      {ev.euros > 0 && <div style={{ fontSize: 11, color: '#1E9E3A' }}>+€{ev.euros}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── Level requirements general section ── */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        <button onClick={() => setShowLevelReqs(v => !v)}
          style={{ width: '100%', padding: '14px 20px', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>📋 Ver requisitos por nivel</span>
          <span style={{ color: 'var(--text-muted)', fontSize: 16 }}>{showLevelReqs ? '▲' : '▼'}</span>
        </button>
        {showLevelReqs && (
          <div style={{ padding: '0 20px 20px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
            {([
              { level: 1, reqs: ['Retención mínima 50%', 'Máx. 3 faltas al mes', 'Sin quejas activas'] },
              { level: 2, reqs: ['Retención mínima 70%', 'Máx. 1 falta al mes', 'Mínimo 5 alumnos activos', 'Al menos 1 upsell'] },
              { level: 3, reqs: ['Retención mínima 85%', 'Cero faltas al mes', 'Mínimo 10 alumnos activos', 'Al menos 3 upsells', 'Más de 6 meses en la plataforma'] },
            ] as const).map(({ level, reqs }) => {
              const info = LEVEL_INFO[(level as 1|2|3)];
              return (
                <div key={level} style={{ border: `1px solid ${info.border}`, borderRadius: 10, padding: '14px 16px', background: info.bg }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: info.color, marginBottom: 8 }}>{level === 3 ? '⭐ ' : ''}{info.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                    Score: {level === 1 ? '0–149' : level === 2 ? '150–299' : '300+'} pts
                  </div>
                  {reqs.map(r => (
                    <div key={r} style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'flex-start', gap: 5, marginBottom: 4 }}>
                      <span style={{ color: info.color }}>•</span> {r}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Event modal ── */}
      {eventModalTeacher && (
        <EventModal
          teacher={eventModalTeacher}
          students={eventModalStudents}
          createdBy={user?.displayName ?? 'Admin'}
          onClose={() => setEventModalTeacher(null)}
          onSave={addScoringEvent}
        />
      )}
    </div>
  );
}

// ─── Admin Content ────────────────────────────────────────────────────────────
function AdminContent() {
  const { teachers, assignments, students, addTeacher, loadingTeachers, getTeacherGrid, updateTeacherGrid } = useTeachers();
  const [selectedTeacher, setSelectedTeacher] = useState<string | null>(null);
  const [showNewTeacher, setShowNewTeacher] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'teachers' | 'weekly' | 'scoring'>('overview');
  const [editCalendarTeacher, setEditCalendarTeacher] = useState<Teacher | null>(null);

  const activeTeachers  = teachers.filter(t => t.status !== 'vacation').length;
  const totalClasses    = teachers.reduce((a, t) => a + t.upcomingClasses.length, 0);
  const totalFreeSpots  = teachers.reduce((a, t) => a + t.freeSpots, 0);
  const conflicts       = mockAlerts.filter(a => a.type === 'conflict').length;

  const alertColors  = { high: '#ef4444', medium: '#f59e0b', low: '#6b7280' };
  const alertBgs     = { high: 'rgba(239,68,68,0.07)', medium: 'rgba(245,158,11,0.07)', low: 'rgba(107,114,128,0.07)' };
  const alertBorders = { high: 'rgba(239,68,68,0.2)', medium: 'rgba(245,158,11,0.2)', low: 'rgba(107,114,128,0.2)' };
  const alertIcons   = { conflict: '⚠️', coverage: '📉', warning: 'ℹ️' };

  const teacher = selectedTeacher ? teachers.find(t => t.id === selectedTeacher) : null;

  const tabs = [
    { id: 'overview', label: '📊 Resumen' },
    { id: 'teachers', label: '👨‍🏫 Profesores' },
    { id: 'weekly',   label: '📅 Vista semanal' },
    { id: 'scoring',  label: '⭐ Scoring' },
  ] as const;

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }}>
      <NavBar />
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '28px 24px' }}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 4px' }}>Admin</h1>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>{teachers.length} profesores · {students.length} alumnos · {assignments.length} asignaciones</p>
          </div>
          <button onClick={() => setShowNewTeacher(true)} style={{ padding: '9px 18px', borderRadius: 9, border: 'none', background: 'var(--accent-blue)', color: 'white', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
            ＋ Nuevo profesor
          </button>
        </div>

        <div style={{ display: 'flex', gap: 4, marginBottom: 22, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 4 }}>
          {tabs.map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{ flex: 1, padding: '8px 12px', borderRadius: 7, border: 'none', background: activeTab === tab.id ? 'var(--bg-surface-3)' : 'transparent', color: activeTab === tab.id ? 'var(--text-primary)' : 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontWeight: 500, transition: 'all 0.12s' }}>
              {tab.label}
            </button>
          ))}
        </div>

        {/* OVERVIEW TAB */}
        {activeTab === 'overview' && (<>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 14, marginBottom: 22 }}>
            {[
              { icon: '👨‍🏫', label: 'Activos',       value: activeTeachers,   sub: `de ${teachers.length}`,  color: '#3b82f6' },
              { icon: '📚', label: 'Clases semana', value: totalClasses,     sub: 'confirmadas',            color: '#22c55e' },
              { icon: '🪑', label: 'Cupos libres',  value: totalFreeSpots,   sub: 'disponibles',            color: '#a78bfa' },
              { icon: '⚠️', label: 'Conflictos',    value: conflicts,        sub: conflicts > 0 ? 'atención' : 'ok', color: conflicts > 0 ? '#ef4444' : '#22c55e' },
              { icon: '👤', label: 'Alumnos',       value: students.length,  sub: 'registrados',            color: '#f59e0b' },
              { icon: '✅', label: 'Asignaciones',  value: assignments.length, sub: 'esta sesión',           color: '#22c55e' },
            ].map(s => (
              <div key={s.label} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px' }}>
                <div style={{ fontSize: 22, marginBottom: 10 }}>{s.icon}</div>
                <div style={{ fontSize: 26, fontWeight: 700, color: s.color }}>{s.value}</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginTop: 3 }}>{s.label}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>{s.sub}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>Alertas</span>
              </div>
              <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {mockAlerts.map(alert => (
                  <div key={alert.id} style={{ background: alertBgs[alert.severity], border: `1px solid ${alertBorders[alert.severity]}`, borderRadius: 8, padding: '10px 12px', display: 'flex', gap: 8 }}>
                    <span>{alertIcons[alert.type]}</span>
                    <span style={{ fontSize: 12, color: alertColors[alert.severity], lineHeight: 1.4 }}>{alert.message}</span>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>Asignaciones recientes</span>
              </div>
              <div style={{ padding: '12px 14px' }}>
                {assignments.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--text-muted)', fontSize: 13 }}>Sin asignaciones todavía.</div>
                ) : assignments.slice(0, 6).map(a => (
                  <div key={a.id} style={{ padding: '8px 0', borderBottom: '1px solid rgba(42,51,71,0.4)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{a.studentName}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{a.teacherName} · {a.slots.map(s => `${s.day} ${s.hour}`).join(' · ')} · {a.weeklyHours}h/sem</div>
                    </div>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                      {new Date(a.createdAt).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>)}

        {/* TEACHERS TAB */}
        {activeTab === 'teachers' && (
          <div>
            <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
              <div style={{ overflowX: 'auto', maxHeight: 500, overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                    <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)' }}>
                      {['Nombre', 'Estado', 'Carga', 'Cupos', 'Próxima clase', ''].map(h => (
                        <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {teachers.map(t => {
                      const loadPct = t.maxWeeklyLoad > 0 ? Math.round((t.weeklyLoad / t.maxWeeklyLoad) * 100) : 0;
                      const loadColor = loadPct >= 90 ? '#ef4444' : loadPct >= 70 ? '#f59e0b' : '#22c55e';
                      return (
                        <tr key={t.id} style={{ borderBottom: '1px solid var(--border)', background: selectedTeacher === t.id ? 'var(--bg-surface-2)' : 'transparent' }}>
                          <td style={{ padding: '11px 14px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--bg-surface-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', flexShrink: 0 }}>{t.avatar}</div>
                              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{t.name}</span>
                            </div>
                          </td>
                          <td style={{ padding: '11px 14px' }}><StatusBadge status={t.status} /></td>
                          <td style={{ padding: '11px 14px', minWidth: 100 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--bg-surface-3)' }}>
                                <div style={{ width: `${loadPct}%`, height: '100%', borderRadius: 2, background: loadColor }} />
                              </div>
                              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t.weeklyLoad}h</span>
                            </div>
                          </td>
                          <td style={{ padding: '11px 14px' }}>
                            <span style={{ fontSize: 13, color: t.freeSpots > 0 ? '#22c55e' : 'var(--text-muted)', fontWeight: 600 }}>{t.freeSpots}</span>
                          </td>
                          <td style={{ padding: '11px 14px', fontSize: 12, color: 'var(--text-secondary)' }}>{t.nextClass ?? '—'}</td>
                          <td style={{ padding: '11px 14px' }}>
                            <button onClick={() => setSelectedTeacher(t.id === selectedTeacher ? null : t.id)} style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid var(--border)', background: selectedTeacher === t.id ? 'var(--bg-surface-3)' : 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12 }}>
                              {selectedTeacher === t.id ? 'Cerrar' : 'Ver'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {teacher && (
              <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '22px 24px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 42, height: 42, borderRadius: '50%', background: 'var(--bg-surface-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 14, color: 'var(--text-secondary)' }}>{teacher.avatar}</div>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 17, color: 'var(--text-primary)' }}>{teacher.name}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{teacher.email}</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <button onClick={() => setEditCalendarTeacher(teacher)}
                      style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid rgba(59,130,246,0.35)', background: 'rgba(59,130,246,0.1)', color: '#93c5fd', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                      📅 Editar disponibilidad
                    </button>
                    <StatusBadge status={teacher.status} />
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 }}>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Disponibilidad</div>
                    {teacher.timeSlots.length === 0
                      ? <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Sin bloques aún.</div>
                      : teacher.timeSlots.slice(0, 5).map((slot, i) => (
                        <div key={i} style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 3 }}>📅 {slot.day} {slot.from}–{slot.to}</div>
                      ))}
                  </div>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Clases próximas</div>
                    {teacher.upcomingClasses.length === 0
                      ? <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Sin clases.</div>
                      : teacher.upcomingClasses.slice(0, 4).map(cls => (
                        <div key={cls.id} style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 3 }}>👤 {cls.studentName} — {cls.day} {cls.time}</div>
                      ))}
                  </div>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Carga</div>
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5 }}>
                        <span>Semanal</span><span>{teacher.weeklyLoad}h / {teacher.maxWeeklyLoad}h</span>
                      </div>
                      <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-surface-3)' }}>
                        <div style={{ width: `${teacher.maxWeeklyLoad > 0 ? Math.round((teacher.weeklyLoad / teacher.maxWeeklyLoad) * 100) : 0}%`, height: '100%', borderRadius: 3, background: '#22c55e' }} />
                      </div>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Cupos libres: <b style={{ color: teacher.freeSpots > 0 ? '#22c55e' : '#ef4444' }}>{teacher.freeSpots}</b></div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Alumnos asignados</div>
                    {(() => {
                      const ta = assignments.filter(a => a.teacherId === teacher.id);
                      if (ta.length === 0) return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Sin alumnos asignados.</div>;
                      return ta.map(a => (
                        <div key={a.id} style={{ marginBottom: 6, paddingBottom: 6, borderBottom: '1px solid rgba(42,51,71,0.4)' }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>👤 {a.studentName}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>{a.studentLevel} · {a.slots.map(sl => `${sl.day} ${sl.hour}`).join(', ')}</div>
                        </div>
                      ));
                    })()}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* WEEKLY VIEW TAB */}
        {activeTab === 'weekly' && (
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '20px' }}>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' }}>Cobertura semanal</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>Cantidad de profesores disponibles por cada horario.</div>
            </div>
            <WeeklyOverview teachers={teachers} />
          </div>
        )}

        {/* SCORING TAB */}
        {activeTab === 'scoring' && <ScoringTab />}
      </div>

      {showNewTeacher && (
        <NewTeacherModal
          onClose={() => setShowNewTeacher(false)}
          onSave={async (t, username) => { await addTeacher(t, username); setShowNewTeacher(false); }}
        />
      )}

      {editCalendarTeacher && (
        <EditCalendarModal
          teacher={editCalendarTeacher}
          onClose={() => setEditCalendarTeacher(null)}
          getTeacherGrid={getTeacherGrid}
          updateTeacherGrid={updateTeacherGrid}
        />
      )}
    </div>
  );
}

export default function AdminPage() {
  return (
    <AuthGuard allowedRoles={['admin']}>
      <AdminContent />
    </AuthGuard>
  );
}
