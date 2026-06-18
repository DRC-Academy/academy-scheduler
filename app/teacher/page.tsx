'use client';
import { useState, useEffect } from 'react';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { VisualCalendar } from '@/components/VisualCalendar';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import { calcCurrentClassNumber } from '@/lib/db';
import { Grid, Teacher, Assignment, ScoringEvent, Student } from '@/types';

// ── localStorage helpers for milestone alert persistence ─────────────────────
function hasSeenAlert(teacherId: string, studentName: string, milestone: number): boolean {
  try { return localStorage.getItem(`alert_seen_${teacherId}_${studentName}_${milestone}`) === '1'; }
  catch { return false; }
}
function markAlertSeen(teacherId: string, studentName: string, milestone: number): void {
  try { localStorage.setItem(`alert_seen_${teacherId}_${studentName}_${milestone}`, '1'); }
  catch {}
}

// ── Milestone date estimator ──────────────────────────────────────────────────
function estimateMilestoneDate(startDate: string, milestone: number, slotsPerWeek: number): string {
  const weeksNeeded = Math.ceil(milestone / slotsPerWeek);
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const start  = new Date(sy, sm - 1, sd);
  const target = new Date(start.getTime() + weeksNeeded * 7 * 24 * 60 * 60 * 1000);
  return target.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
}

// ── Assign Student Modal ──────────────────────────────────────────────────────
function AssignStudentModal({
  day, hour, myAssignments, onConfirm, onCancel,
}: {
  day: string;
  hour: string;
  myAssignments: Assignment[];
  onConfirm: (studentName: string, isNew: boolean, newData?: { name: string; email: string; level: string; plan: string }) => void;
  onCancel: () => void;
}) {
  const [tab, setTab]       = useState<'existing' | 'new'>('existing');
  const [search, setSearch] = useState('');
  const [newName, setNewName]   = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newLevel, setNewLevel] = useState('B1');
  const [newPlan, setNewPlan]   = useState('Inglés general');

  const uniqueStudents = Array.from(new Map(myAssignments.map(a => [a.studentName, a])).values());
  const filtered = uniqueStudents.filter(a => a.studentName.toLowerCase().includes(search.toLowerCase()));

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid #35405a', borderRadius: 16, width: '100%', maxWidth: 440, overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ padding: '18px 22px 0' }}>
          <div style={{ fontWeight: 700, fontSize: 17, color: 'var(--text-primary)', marginBottom: 3 }}>Asignar alumno</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
            {day} · {hour} — ¿quién ocupa este horario?
          </div>
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border)' }}>
            {(['existing', 'new'] as const).map(id => (
              <button key={id} onClick={() => setTab(id)} style={{
                flex: 1, padding: '8px 12px', border: 'none',
                borderBottom: `2px solid ${tab === id ? '#1E9E3A' : 'transparent'}`,
                background: 'transparent', color: tab === id ? '#1E9E3A' : 'var(--text-muted)',
                cursor: 'pointer', fontSize: 13, fontWeight: tab === id ? 700 : 400,
              }}>
                {id === 'existing' ? 'Mis alumnos' : 'Nuevo alumno'}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div style={{ padding: '16px 22px 22px' }}>
          {tab === 'existing' ? (
            <>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar alumno..." autoFocus style={{ marginBottom: 12 }} />
              <div style={{ maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {filtered.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-muted)', fontSize: 13 }}>
                    {myAssignments.length === 0 ? 'No tenés alumnos asignados aún.' : 'Sin resultados.'}
                  </div>
                ) : filtered.map(a => (
                  <button key={a.id} onClick={() => onConfirm(a.studentName, false)} style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 9,
                    border: '1px solid var(--border)', background: 'var(--bg-surface-2)', cursor: 'pointer', textAlign: 'left',
                  }}>
                    <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'rgba(30,158,58,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#1E9E3A', flexShrink: 0 }}>
                      {a.studentName.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{a.studentName}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{a.studentLevel} · {a.studentEmail}</div>
                    </div>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div><label>Nombre *</label><input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Nombre completo" autoFocus /></div>
              <div><label>Email</label><input value={newEmail} onChange={e => setNewEmail(e.target.value)} placeholder="email@ejemplo.com" type="email" /></div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label>Nivel</label>
                  <select value={newLevel} onChange={e => setNewLevel(e.target.value)}>
                    {['A1','A2','B1','B2','C1','C2'].map(l => <option key={l}>{l}</option>)}
                  </select>
                </div>
                <div>
                  <label>Plan</label>
                  <select value={newPlan} onChange={e => setNewPlan(e.target.value)}>
                    {['Inglés general','B1 Exámenes','B2 Exámenes','C1 Exámenes','Intensivo'].map(p => <option key={p}>{p}</option>)}
                  </select>
                </div>
              </div>
              <button
                onClick={() => newName.trim() && onConfirm(newName.trim(), true, { name: newName.trim(), email: newEmail, level: newLevel, plan: newPlan })}
                disabled={!newName.trim()}
                style={{ marginTop: 4, padding: '11px', borderRadius: 9, border: 'none', background: newName.trim() ? '#1E9E3A' : 'var(--bg-surface-3)', color: newName.trim() ? 'white' : 'var(--text-muted)', cursor: newName.trim() ? 'pointer' : 'not-allowed', fontSize: 14, fontWeight: 700, fontFamily: 'inherit' }}>
                Crear y asignar
              </button>
            </div>
          )}
          <button onClick={onCancel} style={{ marginTop: 10, width: '100%', padding: '9px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}

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
  const faltasThisMonth  = myMonthEvents.filter(e => e.eventType === 'falta_injustificada' || e.eventType === 'falta_justificada').length;
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
  const { teachers, assignments, scoringEvents, getTeacherGrid, updateTeacherGrid, addStudent, addAssignment } = useTeachers();
  const [activeTab, setActiveTab] = useState<'calendar' | 'classes' | 'scoring'>('calendar');
  const [grid, setGrid]           = useState<Grid>({});
  const [gridLoading, setGridLoading]   = useState(true);
  const [saveStatus, setSaveStatus]     = useState<'idle' | 'saving' | 'saved'>('idle');
  const [dismissedInSession, setDismissedInSession] = useState<Set<string>>(new Set());
  const [pendingOcupado, setPendingOcupado] = useState<{ day: string; hour: string; resolve: (name: string) => void } | null>(null);

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

  function handleOcupadoNeed(day: string, hour: string, resolve: (name: string) => void, cancel: () => void) {
    setPendingOcupado({ day, hour, resolve });
  }

  async function handleAssignStudent(studentName: string, isNew: boolean, newData?: { name: string; email: string; level: string; plan: string }) {
    if (!teacher || !pendingOcupado) return;
    const { day, hour, resolve } = pendingOcupado;
    let finalName = studentName;

    if (isNew && newData) {
      const newStudent: Student = {
        id: crypto.randomUUID(),
        name: newData.name,
        email: newData.email,
        level: newData.level,
        plan: newData.plan,
        createdAt: new Date().toISOString(),
      };
      await addStudent(newStudent);

      const today = new Date().toISOString().split('T')[0];
      const newAssignment: Assignment = {
        id: crypto.randomUUID(),
        teacherId: teacher.id,
        teacherName: teacher.name,
        teacherEmail: teacher.email,
        studentId: newStudent.id,
        studentName: newStudent.name,
        studentEmail: newStudent.email,
        studentLevel: newStudent.level,
        slots: [{ day, hour }],
        objetivo: newData.plan,
        plan: newData.plan,
        weeklyHours: 1,
        availability: `${day} ${hour}`,
        notes: '',
        startDate: today,
        createdAt: new Date().toISOString(),
      };
      await addAssignment(newAssignment);
      finalName = newStudent.name;
    }

    resolve(finalName);
    setPendingOcupado(null);
  }

  function handleAssignCancel() {
    setPendingOcupado(null);
  }

  function dismissBanner(teacherId: string, studentName: string, milestone: number) {
    markAlertSeen(teacherId, studentName, milestone);
    setDismissedInSession(prev => new Set([...prev, `${studentName}_${milestone}`]));
  }

  if (!teacher) return null;

  const myAssignments = assignments.filter(a => a.teacherId === teacher.id);
  const myEvents      = scoringEvents.filter(e => e.teacherId === teacher.id);

  const freeCount    = Object.values(grid).filter(c => c.state === 'libre').length;
  const ocupadoCount = Object.values(grid).filter(c => c.state === 'ocupado').length;
  const bloqCount    = Object.values(grid).filter(c => c.state === 'bloqueado').length;

  // Compute visible milestone banners from assignments (auto time-based)
  type BannerEntry = { studentName: string; milestone: 15 | 30; startDate: string; slotsPerWeek: number };
  const visibleBanners: BannerEntry[] = [];
  for (const a of myAssignments) {
    if (!a.startDate) continue;
    const classNum = calcCurrentClassNumber(a);
    for (const milestone of [15, 30] as const) {
      if (classNum >= milestone && !hasSeenAlert(teacher.id, a.studentName, milestone) && !dismissedInSession.has(`${a.studentName}_${milestone}`)) {
        visibleBanners.push({ studentName: a.studentName, milestone, startDate: a.startDate, slotsPerWeek: a.slots.length });
        break;
      }
    }
  }

  // Grid-only students (ocupado cells without a DB assignment)
  const assignedNames = new Set(myAssignments.map(a => a.studentName));
  const gridOcupado = Object.entries(grid)
    .filter(([, cell]) => cell.state === 'ocupado' && cell.student && !assignedNames.has(cell.student))
    .map(([key, cell]) => { const [day, hour] = key.split('_'); return { day, hour, student: cell.student! }; });
  const legacyMap = new Map<string, { student: string; slots: { day: string; hour: string }[] }>();
  for (const c of gridOcupado) {
    if (!legacyMap.has(c.student)) legacyMap.set(c.student, { student: c.student, slots: [] });
    legacyMap.get(c.student)!.slots.push({ day: c.day, hour: c.hour });
  }
  const legacyList = Array.from(legacyMap.values());

  const tabs = [
    { id: 'calendar', label: '📅 Mi calendario' },
    { id: 'classes',  label: '📚 Clases asignadas' },
    { id: 'scoring',  label: '⭐ Mi Scoring' },
  ] as const;

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }}>
      <NavBar />
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '24px 16px 48px' }}>

        {/* Milestone banners */}
        {visibleBanners.map(banner => (
          <div key={`${banner.studentName}_${banner.milestone}`} style={{
            background: banner.milestone === 15 ? '#FFC400' : '#1E9E3A',
            color: banner.milestone === 15 ? '#1a0f00' : 'white',
            borderRadius: 12, padding: '14px 20px', marginBottom: 14,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
          }}>
            <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.5 }}>
              {banner.milestone === 15
                ? `🎉 ¡Clase 15 con ${banner.studentName}! Es un buen momento para pedir una reseña en Trustpilot y consultar si quiere continuar con el plan. Fecha estimada de clase 30: ${estimateMilestoneDate(banner.startDate, 30, banner.slotsPerWeek)}.`
                : `🏆 ¡Clase 30 con ${banner.studentName}! Este alumno es un ejemplo de retención. Recordá que podés solicitar el bono de retención al admin.`
              }
            </div>
            <button
              onClick={() => dismissBanner(teacher.id, banner.studentName, banner.milestone)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: 'inherit', flexShrink: 0, opacity: 0.75, fontFamily: 'inherit', lineHeight: 1 }}
            >
              ✕
            </button>
          </div>
        ))}

        {/* Profile */}
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '18px 22px', marginBottom: 18, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ width: 50, height: 50, borderRadius: '50%', background: 'rgba(34,197,94,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 700, color: '#4ade80', flexShrink: 0 }}>{teacher.avatar}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 20, color: 'var(--text-primary)' }}>{teacher.name}</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>{teacher.email}</div>
          </div>
          <div style={{ display: 'flex', gap: 20 }}>
            {[
              { label: 'Libre',          count: freeCount,    color: '#4ade80' },
              { label: 'Ocupado',        count: ocupadoCount, color: '#93c5fd' },
              { label: 'En recuperación', count: bloqCount,   color: '#fbbf24' },
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
                { icon: '⬜', label: 'No work',          desc: 'No trabajás ese horario' },
                { icon: '🟢', label: 'Libre',            desc: 'Disponible para clases' },
                { icon: '🔵', label: 'Ocupado',          desc: 'Clase con alumno' },
                { icon: '🩹', label: 'En recuperación',  desc: 'Clase de recuperación o ajuste' },
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
              <VisualCalendar mode="teacher" grid={grid} onGridChange={handleGridChange} onOcupadoNeed={handleOcupadoNeed} />
            )}
          </div>
        )}

        {activeTab === 'classes' && (
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '20px' }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 4 }}>Clases asignadas</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 18 }}>El contador se actualiza automáticamente según la fecha de inicio y los días asignados.</div>

            {myAssignments.length === 0 && legacyList.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: 14 }}>
                No tenés alumnos asignados todavía.<br />
                <span style={{ fontSize: 12 }}>Hacé clic en una celda "Ocupado" del calendario para asignar un alumno.</span>
              </div>
            ) : (
              <>
                {/* DB assignments with auto class count */}
                {myAssignments.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    {myAssignments.map(a => {
                      const classNum = calcCurrentClassNumber(a);
                      const barPct   = Math.min(100, (classNum / 30) * 100);
                      const isMilestone = classNum >= 15;
                      const slotsPerWeek = a.slots.length;
                      const est15 = a.startDate ? estimateMilestoneDate(a.startDate, 15, slotsPerWeek) : null;
                      const est30 = a.startDate ? estimateMilestoneDate(a.startDate, 30, slotsPerWeek) : null;

                      return (
                        <div key={a.id} style={{ background: 'var(--bg-surface-2)', border: `1px solid ${classNum >= 30 ? '#1E9E3A' : classNum >= 15 ? '#FFC400' : 'var(--border)'}`, borderRadius: 12, padding: '16px 20px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
                            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                              <div style={{ width: 42, height: 42, borderRadius: '50%', background: 'rgba(30,158,58,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, fontWeight: 700, color: '#1E9E3A', flexShrink: 0 }}>
                                {a.studentName.charAt(0).toUpperCase()}
                              </div>
                              <div>
                                <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--text-primary)' }}>{a.studentName}</div>
                                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                                  {a.slots.map(sl => `${sl.day} ${sl.hour}`).join(' · ')}
                                  {a.studentLevel && ` · ${a.studentLevel}`}
                                </div>
                              </div>
                            </div>
                            <div style={{ textAlign: 'right', flexShrink: 0 }}>
                              <div style={{ fontSize: 18, fontWeight: 800, color: classNum >= 30 ? '#1E9E3A' : classNum >= 15 ? '#b45309' : 'var(--text-primary)' }}>
                                Clase {classNum}
                              </div>
                              {classNum >= 30 && <div style={{ fontSize: 11, color: '#1E9E3A', fontWeight: 700 }}>🏆 Milestone</div>}
                              {classNum >= 15 && classNum < 30 && <div style={{ fontSize: 11, color: '#b45309', fontWeight: 700 }}>🎯 Milestone</div>}
                            </div>
                          </div>

                          {/* Progress bar */}
                          <div style={{ position: 'relative', marginBottom: 6 }}>
                            <div style={{ height: 10, borderRadius: 5, background: '#e5e7eb', overflow: 'hidden' }}>
                              <div style={{ width: `${barPct}%`, height: '100%', background: classNum >= 30 ? '#1E9E3A' : classNum >= 15 ? '#FFC400' : '#3b82f6', borderRadius: 5, transition: 'width 0.4s ease' }} />
                            </div>
                            <div style={{ position: 'absolute', left: '50%', top: 0, width: 2, height: 10, background: '#FFC400', transform: 'translateX(-50%)', zIndex: 2, pointerEvents: 'none' }} />
                          </div>
                          <div style={{ position: 'relative', height: 15, fontSize: 10, color: 'var(--text-muted)', marginBottom: 10 }}>
                            <span style={{ position: 'absolute', left: 0 }}>Clase 1</span>
                            <span style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)' }}>15</span>
                            <span style={{ position: 'absolute', right: 0 }}>30</span>
                          </div>

                          {/* Estimated dates */}
                          {a.startDate && (
                            <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--text-muted)' }}>
                              <span>Inicio: <b>{new Date(a.startDate + 'T00:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}</b></span>
                              {classNum < 15 && est15 && <span>Clase 15 est.: <b>{est15}</b></span>}
                              {classNum < 30 && est30 && <span>Clase 30 est.: <b>{est30}</b></span>}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Legacy: grid-only ocupado students without a DB assignment */}
                {legacyList.length > 0 && (
                  <div style={{ marginTop: myAssignments.length > 0 ? 20 : 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Sin registro de inicio</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {legacyList.map(s => (
                        <div key={s.student} style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'rgba(107,114,128,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#6b7280', flexShrink: 0 }}>
                            {s.student.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>{s.student}</div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.slots.map(sl => `${sl.day} ${sl.hour}`).join(' · ')}</div>
                          </div>
                          <div style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>Sin fecha de inicio registrada</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
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

      {/* Assign student modal (triggered from calendar ocupado cell) */}
      {pendingOcupado && (
        <AssignStudentModal
          day={pendingOcupado.day}
          hour={pendingOcupado.hour}
          myAssignments={myAssignments}
          onConfirm={handleAssignStudent}
          onCancel={handleAssignCancel}
        />
      )}
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
