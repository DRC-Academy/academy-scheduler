'use client';
import { useState, useEffect } from 'react';
import { NavBar } from '@/components/NavBar';
import { StatusBadge } from '@/components/StatusBadge';
import { AuthGuard } from '@/components/AuthGuard';
import { DAYS, HOURS_ES, stateColor, VisualCalendar, buildGridFromTeacher } from '@/components/VisualCalendar';
import { useTeachers } from '@/lib/TeachersContext';
import { mockAlerts } from '@/lib/mock-data';
import { Teacher, Grid } from '@/types';

// ─── New teacher modal ────────────────────────────────────────────────────────
function NewTeacherModal({ onClose, onSave }: { onClose: () => void; onSave: (t: Teacher, username: string) => void }) {
  const [form, setForm] = useState({ name: '', email: '', username: '' });
  const [saved, setSaved] = useState(false);

  function handleSave() {
    if (!form.name || !form.email) return;
    const avatar = form.name.split(' ').map((p: string) => p[0]).join('').toUpperCase().slice(0, 2);
    const username = form.username.trim() || form.name.toLowerCase().replace(/\s+/g, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
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
                💡 Usuario para login: nombre en minúsculas · Contraseña: <code style={{ color: '#93c5fd' }}>profe123</code> (cambiar en lib/auth.ts)
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

  // Build a map: day+hour → list of teachers available
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

  // Hours to show: 9-22
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
              <th style={{ padding: '8px 10px', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', background: 'var(--bg-surface-2)', borderBottom: '1px solid var(--border)', textAlign: 'left', position: 'sticky', left: 0, zIndex: 2, minWidth: 72 }}>
                Hora
              </th>
              {DAYS.map(day => (
                <th key={day} style={{ padding: '8px 6px', fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', background: 'var(--bg-surface-2)', borderBottom: '1px solid var(--border)', textAlign: 'center', minWidth: 90 }}>
                  {day}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {hours.map(hour => (
              <tr key={hour} style={{ borderBottom: '1px solid rgba(42,51,71,0.4)' }}>
                <td style={{ padding: '4px 10px', fontSize: 11, color: 'var(--text-secondary)', background: 'var(--bg-surface-2)', position: 'sticky', left: 0, zIndex: 1, borderRight: '1px solid var(--border)', fontWeight: 600 }}>
                  {hour}
                </td>
                {DAYS.map(day => {
                  const key = `${day}_${hour}`;
                  const names = coverageMap[key] ?? [];
                  const count = names.length;
                  const isHovered = hoveredCell === key;

                  return (
                    <td key={day}
                      onMouseEnter={() => setHoveredCell(key)}
                      onMouseLeave={() => setHoveredCell(null)}
                      style={{
                        height: 36, padding: '2px 4px',
                        background: isHovered && count > 0 ? 'rgba(59,130,246,0.2)' : coverageColor(count),
                        border: `1px solid ${coverageBorder(count)}`,
                        textAlign: 'center', verticalAlign: 'middle',
                        cursor: count > 0 ? 'pointer' : 'default',
                        transition: 'background 0.1s',
                        position: 'relative',
                      }}>
                      {count > 0 && (
                        <span style={{ fontSize: 11, fontWeight: 700, color: count === 1 ? '#ef4444' : count === 2 ? '#f59e0b' : '#4ade80' }}>
                          {count}
                        </span>
                      )}
                      {/* Tooltip */}
                      {isHovered && count > 0 && (
                        <div style={{
                          position: 'absolute', bottom: '110%', left: '50%', transform: 'translateX(-50%)',
                          background: 'var(--bg-surface)', border: '1px solid var(--border-light, #35405a)',
                          borderRadius: 8, padding: '8px 12px', zIndex: 10,
                          minWidth: 140, maxWidth: 200, boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                          whiteSpace: 'nowrap',
                        }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 5, textTransform: 'uppercase' }}>{day} {hour}</div>
                          {names.map(n => (
                            <div key={n} style={{ fontSize: 11, color: 'var(--text-primary)', padding: '1px 0' }}>• {n}</div>
                          ))}
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

// ─── Edit Calendar Modal (Admin) ─────────────────────────────────────────────
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

// ─── Admin Content ────────────────────────────────────────────────────────────
function AdminContent() {
  const { teachers, assignments, students, addTeacher, loadingTeachers, getTeacherGrid, updateTeacherGrid } = useTeachers();
  const [selectedTeacher, setSelectedTeacher] = useState<string | null>(null);
  const [showNewTeacher, setShowNewTeacher] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'teachers' | 'weekly'>('overview');
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
  ] as const;

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }}>
      <NavBar />
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '28px 24px' }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 4px' }}>Admin</h1>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>{teachers.length} profesores · {students.length} alumnos · {assignments.length} asignaciones</p>
          </div>
          <button onClick={() => setShowNewTeacher(true)} style={{ padding: '9px 18px', borderRadius: 9, border: 'none', background: 'var(--accent-blue)', color: 'white', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
            ＋ Nuevo profesor
          </button>
        </div>

        {/* Tabs */}
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
              { icon: '👨‍🏫', label: 'Activos',        value: activeTeachers,  sub: `de ${teachers.length}`,  color: '#3b82f6' },
              { icon: '📚', label: 'Clases semana',  value: totalClasses,     sub: 'confirmadas',             color: '#22c55e' },
              { icon: '🪑', label: 'Cupos libres',   value: totalFreeSpots,   sub: 'disponibles',             color: '#a78bfa' },
              { icon: '⚠️', label: 'Conflictos',     value: conflicts,        sub: conflicts > 0 ? 'atención' : 'ok', color: conflicts > 0 ? '#ef4444' : '#22c55e' },
              { icon: '👤', label: 'Alumnos',        value: students.length,  sub: 'registrados',             color: '#f59e0b' },
              { icon: '✅', label: 'Asignaciones',   value: assignments.length, sub: 'esta sesión',            color: '#22c55e' },
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
            {/* Alerts */}
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

            {/* Recent assignments */}
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

            {/* Teacher detail */}
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
                    <button
                      onClick={() => setEditCalendarTeacher(teacher)}
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
                        <div key={i} style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 3 }}>
                          📅 {slot.day} {slot.from}–{slot.to}
                        </div>
                      ))}
                  </div>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Clases próximas</div>
                    {teacher.upcomingClasses.length === 0
                      ? <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Sin clases.</div>
                      : teacher.upcomingClasses.slice(0, 4).map(cls => (
                        <div key={cls.id} style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 3 }}>
                          👤 {cls.studentName} — {cls.day} {cls.time}
                        </div>
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
                      const teacherAssignments = assignments.filter(a => a.teacherId === teacher.id);
                      if (teacherAssignments.length === 0) {
                        return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Sin alumnos asignados.</div>;
                      }
                      return teacherAssignments.map(a => (
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
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
                Cantidad de profesores disponibles por cada horario. Basado en la disponibilidad cargada en los calendarios.
              </div>
            </div>
            <WeeklyOverview teachers={teachers} />
          </div>
        )}
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
