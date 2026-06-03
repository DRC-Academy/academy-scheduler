'use client';
import { useState, useEffect } from 'react';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { VisualCalendar } from '@/components/VisualCalendar';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import { Grid } from '@/types';

function TeacherContent() {
  const { user } = useAuth();
  const { teachers, getTeacherGrid, updateTeacherGrid } = useTeachers();
  const [activeTab, setActiveTab] = useState<'calendar' | 'classes'>('calendar');
  const [grid, setGrid] = useState<Grid>({});
  const [gridLoading, setGridLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');

  const teacher = teachers.find(t => t.id === user?.teacherId) ?? teachers[0];

  useEffect(() => {
    if (!teacher) return;
    setGridLoading(true);
    getTeacherGrid(teacher.id).then(g => {
      setGrid(g);
      setGridLoading(false);
    });
  }, [teacher?.id]);

  async function handleGridChange(g: Grid) {
    setGrid(g);
    setSaveStatus('saving');
    await updateTeacherGrid(teacher.id, g);
    setSaveStatus('saved');
    setTimeout(() => setSaveStatus('idle'), 2000);
  }

  if (!teacher) return null;

  const freeCount    = Object.values(grid).filter(c => c.state === 'libre').length;
  const ocupadoCount = Object.values(grid).filter(c => c.state === 'ocupado').length;
  const bloqCount    = Object.values(grid).filter(c => c.state === 'bloqueado').length;

  const classes = Object.entries(grid)
    .filter(([, cell]) => cell.state === 'ocupado')
    .map(([key, cell]) => { const [day, hour] = key.split('_'); return { day, hour, student: cell.student ?? '—' }; })
    .sort((a, b) => a.day.localeCompare(b.day) || a.hour.localeCompare(b.hour));

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }}>
      <NavBar />
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '24px 16px 48px' }}>

        {/* Profile */}
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '18px 22px', marginBottom: 18, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ width: 50, height: 50, borderRadius: '50%', background: 'rgba(34,197,94,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 700, color: '#4ade80', flexShrink: 0 }}>{teacher.avatar}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 20, color: 'var(--text-primary)' }}>{teacher.name}</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>{teacher.email}</div>
          </div>
          <div style={{ display: 'flex', gap: 20 }}>
            {[
              { label: 'Libre',     count: freeCount,    color: '#4ade80' },
              { label: 'Ocupado',   count: ocupadoCount, color: '#93c5fd' },
              { label: 'Bloqueado', count: bloqCount,    color: '#fbbf24' },
            ].map(s => (
              <div key={s.label} style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: s.color }}>{s.count}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 18, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 4 }}>
          {[{ id: 'calendar', label: '📅 Mi calendario' }, { id: 'classes', label: '📚 Clases asignadas' }].map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id as any)} style={{ flex: 1, padding: '8px 12px', borderRadius: 7, border: 'none', background: activeTab === tab.id ? 'var(--bg-surface-3)' : 'transparent', color: activeTab === tab.id ? 'var(--text-primary)' : 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontWeight: 500 }}>{tab.label}</button>
          ))}
        </div>

        {activeTab === 'calendar' && (
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' }}>Mi disponibilidad semanal</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>Hacé clic en cualquier celda para cambiar su estado. Se guarda automáticamente.</div>
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: saveStatus === 'saved' ? '#22c55e' : saveStatus === 'saving' ? '#f59e0b' : 'var(--text-muted)' }}>
                {saveStatus === 'saving' && '⏳ Guardando...'}
                {saveStatus === 'saved'  && '✓ Guardado'}
                {saveStatus === 'idle'   && ''}
              </div>
            </div>

            {/* Legend */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
              {[
                { icon: '⬜', label: 'No work',   desc: 'No trabajás ese horario' },
                { icon: '🟢', label: 'Libre',     desc: 'Disponible para clases' },
                { icon: '🔵', label: 'Ocupado',   desc: 'Clase con alumno' },
                { icon: '🟡', label: 'Bloqueado', desc: 'No disponible' },
              ].map(s => (
                <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', background: 'var(--bg-surface-2)', borderRadius: 8, border: '1px solid var(--border)' }}>
                  <span>{s.icon}</span>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>{s.label}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{s.desc}</div>
                  </div>
                </div>
              ))}
            </div>

            {gridLoading ? (
              <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-muted)' }}>Cargando calendario...</div>
            ) : (
              <VisualCalendar mode="teacher" grid={grid} onGridChange={handleGridChange} />
            )}
          </div>
        )}

        {activeTab === 'classes' && (
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '20px' }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 16 }}>Clases asignadas</div>
            {classes.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: 14 }}>
                No hay clases marcadas en tu calendario.<br />
                <span style={{ fontSize: 12 }}>Marcá celdas como "Ocupado" para verlas acá.</span>
              </div>
            ) : classes.map((cls, i) => (
              <div key={i} style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 16px', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>{cls.student}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{cls.day} · {cls.hour} 🇪🇸</div>
                </div>
                <span style={{ fontSize: 11, padding: '3px 10px', borderRadius: 20, background: 'rgba(59,130,246,0.15)', color: '#93c5fd' }}>Confirmada</span>
              </div>
            ))}
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
    </div>
  );
}

export default function TeacherPage() {
  return (
    <AuthGuard allowedRoles={['teacher', 'admin']}>
      <TeacherContent />
    </AuthGuard>
  );
}
