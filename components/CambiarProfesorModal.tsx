'use client';
import { useState, useMemo, useEffect, type CSSProperties } from 'react';
import { useTeachers } from '@/lib/TeachersContext';
import { isAssignableCell } from '@/lib/cells';
import { AssignmentEmailModal } from '@/components/AssignmentEmailModal';
import { Teacher, Assignment, AssignedSlot, Grid } from '@/types';

// Modal "Cambiar de profesor" (punto 1). Wizard de 4 pasos reutilizable desde
// Alumnos y Setter. Transfiere un alumno de su profesor actual a otro: libera el
// grid anterior, ocupa el nuevo, reapunta la assignment y registra scoring/avisos.

const ALL_SPECIALTIES = ['Adultos', 'Niños', 'Exámenes'] as const;
const DAY_ORDER = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

const SPECIALTY_STYLE: Record<string, { color: string; bg: string; border: string }> = {
  Adultos:  { color: '#2563eb', bg: 'rgba(59,130,246,0.1)', border: 'rgba(59,130,246,0.35)' },
  Niños:    { color: '#ea580c', bg: 'rgba(249,115,22,0.1)', border: 'rgba(249,115,22,0.35)' },
  Exámenes: { color: '#7c3aed', bg: 'rgba(139,92,246,0.1)', border: 'rgba(139,92,246,0.35)' },
};

const REASONS = [
  { id: 'alumno',   label: 'El alumno solicitó el cambio', sub: '−10 pts al profesor anterior' },
  { id: 'profesor', label: 'El profesor solicitó el cambio', sub: '−20 pts al profesor anterior' },
  { id: 'reorg',    label: 'Reorganización interna',        sub: 'Sin penalización' },
] as const;
type Reason = typeof REASONS[number]['id'];

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso);
  if (isNaN(d.getTime())) return iso;
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}
function slotLabel(s: AssignedSlot) { return `${s.day} ${s.hour}`; }
function sortSlots(slots: AssignedSlot[]): AssignedSlot[] {
  return [...slots].sort((a, b) => {
    const d = DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day);
    return d !== 0 ? d : a.hour.localeCompare(b.hour);
  });
}

export function CambiarProfesorModal({
  student, currentAssignment, onClose, onDone,
}: {
  student: { id: string; name: string; email: string; level: string };
  currentAssignment: Assignment;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const { teachers, assignments, getTeacherGrid, changeStudentTeacher } = useTeachers();

  const fromTeacher = useMemo(
    () => teachers.find(t => t.id === currentAssignment.teacherId),
    [teachers, currentAssignment.teacherId],
  );

  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [search, setSearch] = useState('');
  const [specialtyFilter, setSpecialtyFilter] = useState<string>('');
  const [newTeacher, setNewTeacher] = useState<Teacher | null>(null);
  const [newGrid, setNewGrid] = useState<Grid | null>(null);
  const [loadingGrid, setLoadingGrid] = useState(false);
  const [weeklyHours, setWeeklyHours] = useState(
    currentAssignment.weeklyHours || currentAssignment.slots.length || 1,
  );
  const [selectedSlots, setSelectedSlots] = useState<AssignedSlot[]>([]);
  const [reason, setReason] = useState<Reason>('alumno');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Paso 2 (post-confirmación): email de asignación pre-armado para el nuevo
  // profesor. Cuando está seteado, el wizard se reemplaza por el modal de email.
  const [sentAssignment, setSentAssignment] = useState<Assignment | null>(null);
  const [doneMsg, setDoneMsg] = useState('');

  const currentSlots = sortSlots(currentAssignment.slots);

  // Profesores candidatos (excluye el actual), con filtro por nombre y especialidad.
  const filteredTeachers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return teachers
      .filter(t => t.id !== currentAssignment.teacherId)
      .filter(t => !q || t.name.toLowerCase().includes(q) || t.email.toLowerCase().includes(q))
      .filter(t => !specialtyFilter || (t.specialties ?? []).includes(specialtyFilter));
  }, [teachers, search, specialtyFilter, currentAssignment.teacherId]);

  async function selectTeacher(t: Teacher) {
    setNewTeacher(t);
    setSelectedSlots([]);
    setLoadingGrid(true);
    setNewGrid(null);
    try {
      const g = await getTeacherGrid(t.id);
      setNewGrid(g);
    } finally {
      setLoadingGrid(false);
    }
    setStep(3);
  }

  // Celdas libres del profesor nuevo (única fuente para elegir horarios).
  const availableSlots = useMemo<AssignedSlot[]>(() => {
    if (!newGrid) return [];
    return sortSlots(
      Object.entries(newGrid)
        .filter(([, cell]) => isAssignableCell(cell))
        .map(([key]) => { const [day, hour] = key.split('_'); return { day, hour }; }),
    );
  }, [newGrid]);

  function toggleSlot(s: AssignedSlot) {
    const k = `${s.day}_${s.hour}`;
    setSelectedSlots(prev => {
      const exists = prev.some(x => `${x.day}_${x.hour}` === k);
      if (exists) return prev.filter(x => `${x.day}_${x.hour}` !== k);
      if (prev.length >= weeklyHours) return prev; // no superar las horas pactadas
      return [...prev, s];
    });
  }
  // Al reducir las horas, recorta la selección.
  useEffect(() => {
    setSelectedSlots(prev => prev.length > weeklyHours ? prev.slice(0, weeklyHours) : prev);
  }, [weeklyHours]);

  const slotsComplete = selectedSlots.length === weeklyHours && weeklyHours > 0;

  async function handleConfirm() {
    if (!newTeacher || !fromTeacher || !slotsComplete || saving) return;
    setSaving(true);
    setError('');
    const newSlots = sortSlots(selectedSlots);
    try {
      await changeStudentTeacher({
        assignmentId: currentAssignment.id,
        studentName:  currentAssignment.studentName,
        studentEmail: currentAssignment.studentEmail,
        weeklyHours,
        from: { id: fromTeacher.id, name: fromTeacher.name, email: fromTeacher.email },
        to:   { id: newTeacher.id, name: newTeacher.name, email: newTeacher.email },
        oldSlots: currentAssignment.slots,
        newSlots,
        reason,
        plan:      currentAssignment.plan,
        level:     currentAssignment.studentLevel,
        startDate: currentAssignment.startDate,
      });
      // Paso 2: armar el email de asignación para el NUEVO profesor. El "Para" usa
      // notification_email si existe, si no el email de login. El resto (plan,
      // nivel, objetivo, fecha de inicio) se arrastra de la assignment original.
      setSentAssignment({
        ...currentAssignment,
        teacherId:    newTeacher.id,
        teacherName:  newTeacher.name,
        teacherEmail: newTeacher.notificationEmail?.trim() || newTeacher.email,
        slots:        newSlots,
        weeklyHours,
        availability: newSlots.map(s => `${s.day} ${s.hour}`).join(', '),
      });
      setDoneMsg(`✅ ${currentAssignment.studentName} transferido a ${newTeacher.name}`);
    } catch {
      setError('No se pudo completar el cambio. Reintentá.');
      setSaving(false);
    }
  }

  const studentCount = (t: Teacher) => assignments.filter(a => a.teacherId === t.id).length;

  const labelStyle = { fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' as const, letterSpacing: '0.05em', marginBottom: 8 };
  const stepDots = [1, 2, 3, 4] as const;

  // PASO 2 (post-confirmación) — email de asignación para el nuevo profesor.
  // Al cerrar/omitir se dispara onDone (cierra el flujo y avisa al caller).
  if (sentAssignment) {
    return (
      <AssignmentEmailModal
        assignment={sentAssignment}
        title="📧 Notificar al nuevo profesor"
        banner="Cambio realizado correctamente. Ahora puedes notificar al nuevo profesor."
        skipLabel="Omitir por ahora"
        onClose={() => onDone(doneMsg)}
      />
    );
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', zIndex: 95, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 18, width: '100%', maxWidth: 560, maxHeight: '94vh', overflowY: 'auto', padding: 26 }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 18, color: 'var(--text-primary)' }}>🔄 Cambiar de profesor</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 3 }}>{currentAssignment.studentName}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 22, cursor: 'pointer' }}>✕</button>
        </div>

        {/* Step dots */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 18 }}>
          {stepDots.map(n => (
            <div key={n} style={{ flex: 1, height: 4, borderRadius: 2, background: step >= n ? '#1E9E3A' : 'var(--bg-surface-3)' }} />
          ))}
        </div>

        {/* PASO 1 — Situación actual */}
        {step === 1 && (
          <div>
            <div style={{ ...labelStyle }}>Paso 1 · Situación actual</div>
            <div style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px', marginBottom: 18, lineHeight: 1.8, fontSize: 13.5, color: 'var(--text-secondary)' }}>
              <div>👨‍🏫 Profesor actual: <b style={{ color: 'var(--text-primary)' }}>{fromTeacher?.name ?? currentAssignment.teacherName}</b></div>
              <div>🕐 Horarios actuales: <b style={{ color: 'var(--text-primary)' }}>{currentSlots.length ? currentSlots.map(slotLabel).join(' · ') : '—'}</b></div>
              <div>📆 Fecha de inicio: <b style={{ color: 'var(--text-primary)' }}>{fmtDate(currentAssignment.startDate)}</b></div>
              <div>⏱ Carga: <b style={{ color: 'var(--text-primary)' }}>{currentAssignment.weeklyHours || currentSlots.length}h/semana</b></div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={onClose} style={btnGhost}>Cancelar</button>
              <button onClick={() => setStep(2)} style={btnPrimary(true)}>Elegir nuevo profesor →</button>
            </div>
          </div>
        )}

        {/* PASO 2 — Seleccionar nuevo profesor */}
        {step === 2 && (
          <div>
            <div style={{ ...labelStyle }}>Paso 2 · Nuevo profesor</div>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar profesor por nombre..." style={{ width: '100%', marginBottom: 10 }} />
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
              <button onClick={() => setSpecialtyFilter('')}
                style={chip(specialtyFilter === '')}>Todas</button>
              {ALL_SPECIALTIES.map(sp => (
                <button key={sp} onClick={() => setSpecialtyFilter(specialtyFilter === sp ? '' : sp)}
                  style={chip(specialtyFilter === sp)}>{sp}</button>
              ))}
            </div>
            <div style={{ maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 18 }}>
              {filteredTeachers.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', padding: '20px 0' }}>Ningún profesor coincide.</div>
              ) : filteredTeachers.map(t => (
                <button key={t.id} onClick={() => selectTeacher(t)}
                  style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 12px', borderRadius: 10, border: '1.5px solid var(--border)', background: 'var(--bg-surface-2)', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>
                  <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'var(--bg-surface-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', flexShrink: 0 }}>{t.avatar}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      {t.name}
                      {t.isBlocked && <span style={{ fontSize: 10, color: '#dc2626', fontWeight: 700 }}>🔴 bloqueado</span>}
                      {(t.specialties ?? []).map(sp => {
                        const s = SPECIALTY_STYLE[sp];
                        return s ? <span key={sp} style={{ fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 8, background: s.bg, color: s.color }}>{sp}</span> : null;
                      })}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                      🪑 {t.freeSpots} cupo{t.freeSpots !== 1 ? 's' : ''} libre{t.freeSpots !== 1 ? 's' : ''} · {studentCount(t)} alumno{studentCount(t) !== 1 ? 's' : ''}
                    </div>
                  </div>
                  <span style={{ color: '#1E9E3A', fontSize: 16 }}>→</span>
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setStep(1)} style={btnGhost}>← Atrás</button>
            </div>
          </div>
        )}

        {/* PASO 3 — Elegir nuevos horarios */}
        {step === 3 && newTeacher && (
          <div>
            <div style={{ ...labelStyle }}>Paso 3 · Nuevos horarios con {newTeacher.name}</div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Horas semanales</label>
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                {[1, 2, 3, 4, 5].map(h => (
                  <button key={h} onClick={() => setWeeklyHours(h)} style={{
                    flex: 1, padding: '8px 0', borderRadius: 9,
                    border: `1.5px solid ${weeklyHours === h ? '#1E9E3A' : 'var(--border)'}`,
                    background: weeklyHours === h ? 'rgba(30,158,58,0.1)' : 'var(--bg-surface-2)',
                    color: weeklyHours === h ? '#1E9E3A' : 'var(--text-secondary)',
                    fontWeight: weeklyHours === h ? 700 : 400, fontSize: 15, cursor: 'pointer', fontFamily: 'inherit',
                  }}>{h}</button>
                ))}
              </div>
            </div>

            <div style={{ background: 'rgba(30,158,58,0.07)', border: '1px solid rgba(30,158,58,0.25)', borderRadius: 9, padding: '8px 14px', marginBottom: 12, fontSize: 12.5, color: '#167a2d' }}>
              Este alumno tiene <b>{weeklyHours}h/sem</b> — seleccioná <b>{weeklyHours}</b> horario{weeklyHours !== 1 ? 's' : ''} libre{weeklyHours !== 1 ? 's' : ''}
              <span style={{ float: 'right', fontWeight: 700 }}>{selectedSlots.length}/{weeklyHours}</span>
            </div>

            {loadingGrid ? (
              <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-muted)', fontSize: 13 }}>Cargando calendario...</div>
            ) : availableSlots.length === 0 ? (
              <div style={{ padding: '14px', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 9, fontSize: 13, color: '#ef4444', textAlign: 'center', marginBottom: 16 }}>
                {newTeacher.name} no tiene horarios libres en su calendario.
              </div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 18, maxHeight: 220, overflowY: 'auto' }}>
                {availableSlots.map(s => {
                  const k = `${s.day}_${s.hour}`;
                  const active = selectedSlots.some(x => `${x.day}_${x.hour}` === k);
                  const disabled = !active && selectedSlots.length >= weeklyHours;
                  return (
                    <button key={k} onClick={() => toggleSlot(s)} disabled={disabled}
                      style={{
                        padding: '7px 12px', borderRadius: 9, fontSize: 12.5, fontWeight: active ? 700 : 500, fontFamily: 'inherit',
                        border: `1.5px solid ${active ? '#1E9E3A' : 'var(--border)'}`,
                        background: active ? 'rgba(30,158,58,0.12)' : 'var(--bg-surface-2)',
                        color: active ? '#1E9E3A' : disabled ? 'var(--text-muted)' : 'var(--text-secondary)',
                        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
                      }}>
                      {active ? '✓ ' : ''}{s.day} {s.hour}
                    </button>
                  );
                })}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setStep(2)} style={btnGhost}>← Atrás</button>
              <button onClick={() => setStep(4)} disabled={!slotsComplete} style={btnPrimary(slotsComplete)}>
                {slotsComplete ? 'Revisar cambio →' : `Faltan ${weeklyHours - selectedSlots.length} horario${weeklyHours - selectedSlots.length !== 1 ? 's' : ''}`}
              </button>
            </div>
          </div>
        )}

        {/* PASO 4 — Confirmar */}
        {step === 4 && newTeacher && (
          <div>
            <div style={{ ...labelStyle }}>Paso 4 · Confirmar cambio</div>

            <div style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px', marginBottom: 16, fontSize: 13.5, lineHeight: 1.9 }}>
              <div style={{ color: '#dc2626' }}>De: <b>{fromTeacher?.name ?? currentAssignment.teacherName}</b> — {currentSlots.map(slotLabel).join(', ') || '—'}</div>
              <div style={{ color: '#1E9E3A' }}>A: <b>{newTeacher.name}</b> — {sortSlots(selectedSlots).map(slotLabel).join(', ')}</div>
            </div>

            <div style={{ ...labelStyle }}>Motivo del cambio</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
              {REASONS.map(r => (
                <button key={r.id} onClick={() => setReason(r.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 10, textAlign: 'left', fontFamily: 'inherit', cursor: 'pointer',
                    border: `1.5px solid ${reason === r.id ? '#1E9E3A' : 'var(--border)'}`,
                    background: reason === r.id ? 'rgba(30,158,58,0.08)' : 'var(--bg-surface-2)',
                  }}>
                  <span style={{ fontSize: 16 }}>{reason === r.id ? '🔘' : '⚪'}</span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{r.label}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.sub}</div>
                  </div>
                </button>
              ))}
            </div>

            {error && <div style={{ fontSize: 12.5, color: '#ef4444', marginBottom: 12 }}>{error}</div>}

            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setStep(3)} disabled={saving} style={btnGhost}>← Atrás</button>
              <button onClick={handleConfirm} disabled={saving} style={btnPrimary(!saving)}>
                {saving ? 'Aplicando cambio...' : 'Confirmar cambio ✓'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const btnGhost: CSSProperties = { flex: 1, padding: '11px', borderRadius: 9, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 14, fontFamily: 'inherit' };
function btnPrimary(enabled: boolean): CSSProperties {
  return { flex: 2, padding: '11px', borderRadius: 9, border: 'none', background: enabled ? '#1E9E3A' : 'var(--bg-surface-3)', color: enabled ? 'white' : 'var(--text-muted)', cursor: enabled ? 'pointer' : 'not-allowed', fontSize: 14, fontWeight: 700, fontFamily: 'inherit' };
}
function chip(active: boolean): CSSProperties {
  return { padding: '5px 13px', borderRadius: 20, border: `1.5px solid ${active ? '#1E9E3A' : 'var(--border)'}`, background: active ? 'rgba(30,158,58,0.1)' : 'transparent', color: active ? '#1E9E3A' : 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, fontWeight: active ? 700 : 500, fontFamily: 'inherit' };
}
