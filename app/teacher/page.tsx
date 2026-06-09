'use client';
import { useState, useEffect } from 'react';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { VisualCalendar } from '@/components/VisualCalendar';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import { Grid, Teacher, Assignment, ScoringEvent } from '@/types';

// ─── Level constants ──────────────────────────────────────────────────────────
const LEVEL_INFO = {
  1: { name: 'Profesor Junior', color: '#6b7280', bg: 'rgba(107,114,128,0.1)', border: 'rgba(107,114,128,0.3)' },
  2: { name: 'Profesor Senior', color: '#1E9E3A', bg: 'rgba(30,158,58,0.1)',   border: 'rgba(30,158,58,0.35)' },
  3: { name: 'Profesor Elite',  color: '#b8860b', bg: 'rgba(255,196,0,0.15)',  border: '#FFC400' },
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

const MOTIVATIONAL: Record<number, string> = {
  1: '¡Buen comienzo! Seguí creciendo para alcanzar el nivel Senior.',
  2: '¡Excelente trabajo! Estás en camino de convertirte en Profesor Elite.',
  3: '¡Sos un Profesor Elite! Seguí siendo el mejor ejemplo en la academia.',
};

// ─── Teacher Scoring Tab ──────────────────────────────────────────────────────
function TeacherScoringTab({ teacher, myAssignments, myEvents }: {
  teacher: Teacher;
  myAssignments: Assignment[];
  myEvents: ScoringEvent[];
}) {
  const today      = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  const myMonthEvents = myEvents.filter(e => new Date(e.createdAt) >= monthStart);

  // Score calculation
  const manualPoints   = myEvents.reduce((s, e) => s + e.points, 0);
  const activeStudents = myAssignments.length;
  const monthlyHours   = teacher.weeklyLoad * 4;
  const thirtyDaysAgo  = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const retained       = myAssignments.filter(a => new Date(a.createdAt) < thirtyDaysAgo).length;
  const retentionPct   = activeStudents > 0 ? (retained / activeStudents) * 100 : 0;

  let autoPoints = activeStudents * 10 + monthlyHours * 2;
  if (retentionPct > 85)                           autoPoints += 50;
  else if (retentionPct >= 70)                     autoPoints += 25;
  else if (retentionPct < 50 && activeStudents > 0) autoPoints -= 20;

  const totalScore    = Math.max(0, manualPoints + autoPoints);
  const currentLevel  = totalScore >= 300 ? 3 : totalScore >= 150 ? 2 : 1;
  const nextLevel     = Math.min(3, currentLevel + 1);
  const prevThreshold = currentLevel === 1 ? 0   : currentLevel === 2 ? 150 : 300;
  const nextThreshold = currentLevel === 1 ? 150 : currentLevel === 2 ? 300 : 300;
  const progressToNext = currentLevel < 3
    ? Math.min(100, ((totalScore - prevThreshold) / (nextThreshold - prevThreshold)) * 100)
    : 100;

  const levelInfo     = LEVEL_INFO[(currentLevel as 1|2|3)];
  const nextLevelInfo = LEVEL_INFO[(nextLevel as 1|2|3)];

  // Bonuses this month
  const totalMonthlyEuros  = myMonthEvents.reduce((s, e) => s + e.euros, 0);
  const upsellEuros        = myMonthEvents.filter(e => e.eventType === 'upsell').reduce((s, e) => s + e.euros, 0);
  const retentionEuros     = myMonthEvents.filter(e => e.eventType === 'bonus_retencion').reduce((s, e) => s + e.euros, 0);
  const trustpilotCount    = myMonthEvents.filter(e => e.eventType === 'review_trustpilot').length;
  const upsellCount        = myMonthEvents.filter(e => e.eventType === 'upsell').reduce((s, e) => s + (e.quantity ?? 1), 0);
  const retentionCount     = myMonthEvents.filter(e => e.eventType === 'bonus_retencion').length;

  // Level requirements
  const faltasThisMonth  = myMonthEvents.filter(e => e.eventType === 'falta').length;
  const quejasActive     = myMonthEvents.filter(e => e.eventType === 'queja').length;
  const upsellsTotal     = myEvents.filter(e => e.eventType === 'upsell').reduce((s, e) => s + (e.quantity ?? 1), 0);
  const monthsOnPlatform = teacher.createdAt
    ? Math.floor((Date.now() - new Date(teacher.createdAt).getTime()) / (30 * 24 * 60 * 60 * 1000))
    : 0;

  // Retention progress per student
  const studentProgress = myAssignments.map(a => {
    const start      = new Date(a.startDate ?? a.createdAt);
    const daysActive = Math.floor((today.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
    const pct        = Math.min(100, (daysActive / 180) * 100);
    const hasBonus   = myEvents.some(e => e.eventType === 'bonus_retencion' && e.studentRef === a.studentName);
    return { a, daysActive, pct, hasBonus, start };
  }).sort((a, b) => b.daysActive - a.daysActive);

  const availableBonuses = studentProgress.filter(s => s.daysActive >= 180 && !s.hasBonus);
  const nextBonus        = studentProgress.filter(s => s.daysActive < 180).sort((a, b) => b.daysActive - a.daysActive)[0];

  const currentReqs = currentLevel === 1
    ? [
        { label: `Retención ≥50% (actual: ${Math.round(retentionPct)}%)`, met: retentionPct >= 50 },
        { label: `Faltas ≤3 este mes (actual: ${faltasThisMonth})`, met: faltasThisMonth <= 3 },
        { label: `Sin quejas activas (actual: ${quejasActive})`, met: quejasActive === 0 },
      ]
    : currentLevel === 2
      ? [
          { label: `Retención ≥70% (actual: ${Math.round(retentionPct)}%)`, met: retentionPct >= 70 },
          { label: `Faltas ≤1 este mes (actual: ${faltasThisMonth})`, met: faltasThisMonth <= 1 },
          { label: `≥5 alumnos activos (actual: ${activeStudents})`, met: activeStudents >= 5 },
          { label: `≥1 upsell realizado (actual: ${upsellsTotal})`, met: upsellsTotal >= 1 },
        ]
      : [
          { label: `Retención ≥85% (actual: ${Math.round(retentionPct)}%)`, met: retentionPct >= 85 },
          { label: `Cero faltas este mes (actual: ${faltasThisMonth})`, met: faltasThisMonth === 0 },
          { label: `≥10 alumnos activos (actual: ${activeStudents})`, met: activeStudents >= 10 },
          { label: `≥3 upsells realizados (actual: ${upsellsTotal})`, met: upsellsTotal >= 3 },
          { label: `>6 meses en la plataforma (actual: ${monthsOnPlatform})`, met: monthsOnPlatform >= 6 },
        ];

  const nextReqs = nextLevel === 2
    ? [
        { label: `Retención ≥70%`, current: `${Math.round(retentionPct)}%`, pct: Math.min(100, retentionPct / 70 * 100) },
        { label: `Máx. 1 falta al mes`, current: `${faltasThisMonth} faltas`, pct: faltasThisMonth <= 1 ? 100 : 0 },
        { label: `5 alumnos activos`, current: `${activeStudents}`, pct: Math.min(100, (activeStudents / 5) * 100) },
        { label: `1 upsell`, current: `${upsellsTotal}`, pct: upsellsTotal >= 1 ? 100 : 0 },
      ]
    : nextLevel === 3
      ? [
          { label: `Retención ≥85%`, current: `${Math.round(retentionPct)}%`, pct: Math.min(100, retentionPct / 85 * 100) },
          { label: `Cero faltas al mes`, current: `${faltasThisMonth} faltas`, pct: faltasThisMonth === 0 ? 100 : 0 },
          { label: `10 alumnos activos`, current: `${activeStudents}`, pct: Math.min(100, (activeStudents / 10) * 100) },
          { label: `3 upsells`, current: `${upsellsTotal}`, pct: Math.min(100, (upsellsTotal / 3) * 100) },
          { label: `6+ meses en la plataforma`, current: `${monthsOnPlatform} meses`, pct: Math.min(100, (monthsOnPlatform / 6) * 100) },
        ]
      : [];

  const cardStyle = {
    background: '#F7F7F5', border: '1px solid #e5e7eb', borderRadius: 14, padding: '20px 24px',
  } as const;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* ── Level card ── */}
      <div style={{ ...cardStyle, border: `2px solid ${levelInfo.border}`, background: levelInfo.bg }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 12 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 16px', borderRadius: 24, background: 'white', border: `1px solid ${levelInfo.border}`, color: levelInfo.color, fontSize: 14, fontWeight: 700, boxShadow: currentLevel === 3 ? '0 0 10px rgba(255,196,0,0.4)' : 'none' }}>
            {currentLevel === 3 ? '⭐ ' : ''}{levelInfo.name}
          </span>
          <span style={{ fontSize: 30, fontWeight: 800, color: '#111827' }}>{totalScore} pts</span>
        </div>

        {currentLevel < 3 && (
          <>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>
              Progreso hacia {nextLevelInfo.name} — {nextThreshold - totalScore > 0 ? `faltan ${nextThreshold - totalScore} puntos` : 'nivel alcanzado'}
            </div>
            <div style={{ height: 10, borderRadius: 5, background: 'rgba(0,0,0,0.08)', overflow: 'hidden' }}>
              <div style={{ width: `${progressToNext}%`, height: '100%', borderRadius: 5, background: levelInfo.color, transition: 'width 0.5s ease' }} />
            </div>
          </>
        )}

        <div style={{ fontSize: 13, color: '#374151', marginTop: 12, fontStyle: 'italic' }}>
          {MOTIVATIONAL[currentLevel]}
        </div>
      </div>

      {/* ── Bonuses card ── */}
      <div style={cardStyle}>
        <div style={{ fontWeight: 700, fontSize: 15, color: '#111827', marginBottom: 14 }}>💰 Mis bonos del mes</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 36, fontWeight: 800, color: '#1E9E3A' }}>€{totalMonthlyEuros}</span>
          <span style={{ fontSize: 13, color: '#6b7280' }}>este mes</span>
        </div>
        {(upsellCount > 0 || retentionCount > 0 || trustpilotCount > 0) ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {upsellCount > 0 && (
              <div style={{ fontSize: 13, color: '#374151' }}>
                • {upsellCount} upsell{upsellCount > 1 ? 's' : ''} <span style={{ color: '#1E9E3A', fontWeight: 600 }}>(€{upsellEuros})</span>
              </div>
            )}
            {retentionCount > 0 && (
              <div style={{ fontSize: 13, color: '#374151' }}>
                • {retentionCount} bono{retentionCount > 1 ? 's' : ''} retención <span style={{ color: '#1E9E3A', fontWeight: 600 }}>(€{retentionEuros})</span>
              </div>
            )}
            <div style={{ fontSize: 13, color: '#374151' }}>
              • Reseñas Trustpilot este mes: <b>{trustpilotCount}</b>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 13, color: '#6b7280' }}>Sin bonos este mes todavía.</div>
        )}

        {availableBonuses.length > 0 && (
          <div style={{ marginTop: 12, background: 'rgba(30,158,58,0.1)', border: '1px solid rgba(30,158,58,0.3)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#1E9E3A', fontWeight: 600 }}>
            🎉 Bono disponible: {availableBonuses.map(b => b.a.studentName).join(', ')}
          </div>
        )}

        {nextBonus && availableBonuses.length === 0 && (
          <div style={{ marginTop: 12, fontSize: 13, color: '#6b7280' }}>
            Próximo bono: te faltan <b style={{ color: '#374151' }}>{180 - nextBonus.daysActive} días</b> para el bono de <b style={{ color: '#374151' }}>{nextBonus.a.studentName}</b>
          </div>
        )}
      </div>

      {/* ── Requirements card ── */}
      <div style={cardStyle}>
        <div style={{ fontWeight: 700, fontSize: 15, color: '#111827', marginBottom: 14 }}>📋 Requisitos de nivel</div>

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: levelInfo.color, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Mi nivel actual — {levelInfo.name}
          </div>
          {currentReqs.map(r => (
            <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: r.met ? '#1E9E3A' : '#6b7280', marginBottom: 5 }}>
              <span style={{ fontSize: 14 }}>{r.met ? '✅' : '❌'}</span> {r.label}
            </div>
          ))}
        </div>

        {nextReqs.length > 0 && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: nextLevelInfo.color, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Siguiente nivel — {nextLevelInfo.name}
            </div>
            {nextReqs.map(r => (
              <div key={r.label} style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#374151', marginBottom: 3 }}>
                  <span>{r.label}</span>
                  <span style={{ color: r.pct >= 100 ? '#1E9E3A' : '#6b7280', fontWeight: 600 }}>{r.current}</span>
                </div>
                <div style={{ height: 5, borderRadius: 3, background: '#e5e7eb', overflow: 'hidden' }}>
                  <div style={{ width: `${r.pct}%`, height: '100%', borderRadius: 3, background: r.pct >= 100 ? '#1E9E3A' : nextLevelInfo.color, transition: 'width 0.4s' }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Event history ── */}
      <div style={cardStyle}>
        <div style={{ fontWeight: 700, fontSize: 15, color: '#111827', marginBottom: 14 }}>📅 Últimos eventos</div>
        {myEvents.length === 0 ? (
          <div style={{ fontSize: 13, color: '#6b7280', textAlign: 'center', padding: '20px 0' }}>Sin eventos registrados todavía.</div>
        ) : myEvents.slice(0, 10).map(ev => {
          const isPos = ev.points > 0;
          return (
            <div key={ev.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '10px 12px', borderRadius: 8, background: isPos ? 'rgba(30,158,58,0.07)' : 'rgba(239,68,68,0.07)', border: `1px solid ${isPos ? 'rgba(30,158,58,0.2)' : 'rgba(239,68,68,0.2)'}`, marginBottom: 8 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: isPos ? '#1E9E3A' : '#ef4444' }}>{EVENT_LABELS[ev.eventType] ?? ev.eventType}</div>
                <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{ev.note}</div>
                <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>{new Date(ev.createdAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 12 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: isPos ? '#1E9E3A' : '#ef4444' }}>{isPos ? '+' : ''}{ev.points}</div>
                {ev.euros > 0 && <div style={{ fontSize: 11, color: '#1E9E3A' }}>+€{ev.euros}</div>}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Retention progress ── */}
      {studentProgress.length > 0 && (
        <div style={cardStyle}>
          <div style={{ fontWeight: 700, fontSize: 15, color: '#111827', marginBottom: 14 }}>👥 Progreso de retención por alumno</div>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>Bono disponible al cumplir 180 días (6 meses) de continuidad.</div>
          {studentProgress.map(({ a, daysActive, pct, hasBonus }) => (
            <div key={a.id} style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{a.studentName}</span>
                  {daysActive >= 180 && !hasBonus && (
                    <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 12, background: 'rgba(30,158,58,0.15)', border: '1px solid rgba(30,158,58,0.3)', color: '#1E9E3A', fontWeight: 700 }}>🎉 Bono disponible</span>
                  )}
                  {hasBonus && (
                    <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 12, background: 'rgba(107,114,128,0.1)', color: '#6b7280' }}>✓ Bono cobrado</span>
                  )}
                </div>
                <span style={{ fontSize: 12, color: daysActive >= 180 ? '#1E9E3A' : '#6b7280', fontWeight: 600 }}>
                  {daysActive} / 180 días
                </span>
              </div>
              <div style={{ height: 8, borderRadius: 4, background: '#e5e7eb', overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', borderRadius: 4, background: daysActive >= 180 ? '#1E9E3A' : daysActive >= 120 ? '#FFC400' : '#3b82f6', transition: 'width 0.4s' }} />
              </div>
              <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 3 }}>
                Inicio: {new Date(a.startDate ?? a.createdAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })}
                {daysActive < 180 && ` · faltan ${180 - daysActive} días`}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Teacher Content ──────────────────────────────────────────────────────────
function TeacherContent() {
  const { user } = useAuth();
  const { teachers, assignments, scoringEvents, getTeacherGrid, updateTeacherGrid } = useTeachers();
  const [activeTab, setActiveTab] = useState<'calendar' | 'classes' | 'scoring'>('calendar');
  const [grid, setGrid]           = useState<Grid>({});
  const [gridLoading, setGridLoading]   = useState(true);
  const [saveStatus, setSaveStatus]     = useState<'idle' | 'saving' | 'saved'>('idle');

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

  const myAssignments = assignments.filter(a => a.teacherId === teacher.id);
  const myEvents      = scoringEvents.filter(e => e.teacherId === teacher.id);

  const tabs = [
    { id: 'calendar', label: '📅 Mi calendario' },
    { id: 'classes',  label: '📚 Clases asignadas' },
    { id: 'scoring',  label: '⭐ Mi Scoring' },
  ] as const;

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
          {tabs.map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id as any)} style={{ flex: 1, padding: '8px 12px', borderRadius: 7, border: 'none', background: activeTab === tab.id ? 'var(--bg-surface-3)' : 'transparent', color: activeTab === tab.id ? 'var(--text-primary)' : 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontWeight: 500 }}>
              {tab.label}
            </button>
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
              </div>
            </div>

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
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{cls.day} · {cls.hour}</div>
                </div>
                <span style={{ fontSize: 11, padding: '3px 10px', borderRadius: 20, background: 'rgba(59,130,246,0.15)', color: '#93c5fd' }}>Confirmada</span>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'scoring' && (
          <TeacherScoringTab
            teacher={teacher}
            myAssignments={myAssignments}
            myEvents={myEvents}
          />
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
