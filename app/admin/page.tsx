'use client';
import { useState, useEffect, useMemo, Fragment, Suspense } from 'react';
import { NavBar } from '@/components/NavBar';
import { StatusBadge } from '@/components/StatusBadge';
import { AuthGuard } from '@/components/AuthGuard';
import { PullToRefresh } from '@/components/PullToRefresh';
import { LastUpdated } from '@/components/LastUpdated';
import { VisualCalendar, buildGridFromTeacher, getSpainParts } from '@/components/VisualCalendar';
import { useTeachers } from '@/lib/TeachersContext';
import { useAuth } from '@/lib/AuthContext';
import { mockAlerts } from '@/lib/mock-data';
import { Teacher, Grid, Assignment, ScoringEvent, ScoringEventType } from '@/types';
import { EVENT_POINTS, EVENT_EUROS, calcCurrentClassNumber, dbUpdateAssignmentStartDate, dbGetAllNotifications,
  dbAuditStudentAssignments, dbRelinkAssignment, dbSyncAssignmentName, dbMergeDuplicateStudents, dbSyncStudentAssignments,
  dbDiagnoseAllCalendars, dbSyncAllCalendarsToAssignments, dbCreateFullLink, CalendarDiagnosisAllRow, AuditResult,
  findDuplicateTeacherAssignments, type DuplicateAssignmentGroup } from '@/lib/db';
import { CambiarProfesorModal } from '@/components/CambiarProfesorModal';
import { CrearVinculoModal } from '@/components/CrearVinculoModal';
import { getPresentationEmailStatus, hoursSinceAssigned, type PresentationEmailStatusKind } from '@/lib/presentationEmailUtils';
import { ALL_SPECIALTIES } from '@/lib/specialties';
import { SpecialtyChip, ToggleChip } from '@/components/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import { AppNotification, ClassJoinLog, AssignedSlot } from '@/types';
import AiRiskTab from '@/components/ai/AiRiskTab';

// ─── Edit Teacher Modal ───────────────────────────────────────────────────────
function EditTeacherModal({ teacher, onClose, onSave }: {
  teacher: Teacher;
  onClose: () => void;
  onSave: (id: string, data: { name: string; email: string; specialties: string[]; notificationEmail: string }) => Promise<void>;
}) {
  const [form, setForm] = useState({
    name:             teacher.name,
    email:            teacher.email,
    notificationEmail: teacher.notificationEmail ?? '',
    specialties:      [...(teacher.specialties ?? [])],
  });
  const [saving, setSaving] = useState(false);

  function toggleSpecialty(s: string) {
    setForm(f => ({
      ...f,
      specialties: f.specialties.includes(s)
        ? f.specialties.filter(x => x !== s)
        : [...f.specialties, s],
    }));
  }

  async function handleSave() {
    if (!form.name.trim()) return;
    setSaving(true);
    await onSave(teacher.id, form);
    setSaving(false);
    onClose();
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: '#F7F7F5', border: '1px solid var(--border)', borderRadius: 16, width: '100%', maxWidth: 440, padding: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 }}>
          <div style={{ fontWeight: 700, fontSize: 17, color: '#111827' }}>Editar profesor</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#6b7280' }}>✕</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 5 }}>Nombre</label>
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1.5px solid var(--border)', fontSize: 13, background: 'white', color: '#111827', fontFamily: 'inherit' }} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 5 }}>Email</label>
            <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1.5px solid var(--border)', fontSize: 13, background: 'white', color: '#111827', fontFamily: 'inherit' }} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 5 }}>Correo de notificaciones</label>
            <input type="email" value={form.notificationEmail} onChange={e => setForm(f => ({ ...f, notificationEmail: e.target.value }))}
              placeholder="Si lo dejás vacío, se usa el correo principal del profesor"
              style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1.5px solid var(--border)', fontSize: 13, background: 'white', color: '#111827', fontFamily: 'inherit' }} />
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 5 }}>Aquí llegan los avisos de bajas de alumnos y novedades importantes.</div>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 8 }}>Especialidades</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {ALL_SPECIALTIES.map(s => {
                const active = form.specialties.includes(s);
                return (
                  <ToggleChip key={s} active={active} onClick={() => toggleSpecialty(s)} style={{ padding: '6px 14px', fontSize: 'var(--fs-sm)' }}>
                    {s}
                  </ToggleChip>
                );
              })}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <button onClick={onClose} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: '#6b7280', cursor: 'pointer', fontSize: 14, fontFamily: 'inherit' }}>Cancelar</button>
            <button onClick={handleSave} disabled={!form.name.trim() || saving}
              style={{ flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: form.name.trim() && !saving ? '#1E9E3A' : '#d1d5db', color: 'white', cursor: form.name.trim() && !saving ? 'pointer' : 'not-allowed', fontSize: 14, fontWeight: 600, fontFamily: 'inherit' }}>
              {saving ? 'Guardando...' : 'Guardar cambios'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Notifications Admin Tab ──────────────────────────────────────────────────
function NotificationsAdminTab() {
  const { teachers, sendNotification } = useTeachers();
  const { user } = useAuth();
  const [targetType, setTargetType] = useState<'all' | 'specific'>('all');
  const [targetTeacherId, setTargetTeacherId] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [allNotifs, setAllNotifs] = useState<AppNotification[]>([]);
  const [loadingNotifs, setLoadingNotifs] = useState(true);

  async function loadAll() {
    setLoadingNotifs(true);
    const data = await dbGetAllNotifications();
    setAllNotifs(data);
    setLoadingNotifs(false);
  }

  useEffect(() => { loadAll(); }, []);

  async function handleSend() {
    if (!title.trim() || !body.trim()) return;
    if (targetType === 'specific' && !targetTeacherId) return;
    setSending(true);
    await sendNotification({
      targetUser: targetType === 'specific' ? targetTeacherId : undefined,
      targetRole: targetType === 'all' ? 'teacher' : undefined,
      title: title.trim(),
      body: body.trim(),
      type: 'circular',
      createdBy: user?.displayName ?? 'Admin',
    });
    setTitle('');
    setBody('');
    setSent(true);
    setSending(false);
    setTimeout(() => setSent(false), 2500);
    await loadAll();
  }

  const inputStyle = {
    width: '100%', padding: '9px 12px', borderRadius: 8,
    border: '1.5px solid var(--border)', fontSize: 13,
    background: 'white', color: '#111827', fontFamily: "'Radio Canada', sans-serif",
    boxSizing: 'border-box' as const,
  };

  const canSend = !!title.trim() && !!body.trim() && !sending && (targetType === 'all' || !!targetTeacherId);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Send form */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '22px 24px' }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 18 }}>📤 Enviar notificación</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Destinatario</label>
            <div style={{ display: 'flex', gap: 8, marginBottom: targetType === 'specific' ? 10 : 0 }}>
              {(['all', 'specific'] as const).map(t => (
                <button key={t} onClick={() => { setTargetType(t); setTargetTeacherId(''); }}
                  style={{ padding: '7px 16px', borderRadius: 8, border: `1.5px solid ${targetType === t ? '#1E9E3A' : 'var(--border)'}`, background: targetType === t ? 'rgba(30,158,58,0.1)' : 'transparent', color: targetType === t ? '#1E9E3A' : 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontWeight: targetType === t ? 700 : 500, fontFamily: 'inherit' }}>
                  {t === 'all' ? '👥 Todos los profesores' : '👤 Un profesor específico'}
                </button>
              ))}
            </div>
            {targetType === 'specific' && (
              <select value={targetTeacherId} onChange={e => setTargetTeacherId(e.target.value)} style={inputStyle}>
                <option value="">— Seleccionar profesor —</option>
                {teachers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Título <span style={{ color: '#ef4444' }}>*</span></label>
            <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Ej: Recordatorio reunión de equipo" style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Mensaje <span style={{ color: '#ef4444' }}>*</span></label>
            <textarea value={body} onChange={e => setBody(e.target.value)} placeholder="Escribí el mensaje completo aquí..." rows={4}
              style={{ ...inputStyle, resize: 'vertical' }} />
          </div>
          <button onClick={handleSend} disabled={!canSend}
            style={{ padding: '11px 20px', borderRadius: 9, border: 'none', background: canSend ? '#1E9E3A' : '#d1d5db', color: 'white', cursor: canSend ? 'pointer' : 'not-allowed', fontSize: 14, fontWeight: 700, fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
            {sent ? '✅ Enviado' : sending ? '⏳ Enviando...' : '📤 Enviar notificación'}
          </button>
        </div>
      </div>

      {/* History */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '22px 24px' }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 16 }}>📋 Historial de enviadas</div>
        {loadingNotifs ? (
          <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)', fontSize: 13 }}>Cargando...</div>
        ) : allNotifs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)', fontSize: 13 }}>Sin notificaciones enviadas todavía.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {allNotifs.map(n => {
              const targetTeacher = n.targetUser ? teachers.find(t => t.id === n.targetUser) : null;
              const dest = targetTeacher ? targetTeacher.name : n.targetRole === 'teacher' ? 'Todos los profesores' : '—';
              return (
                <div key={n.id} style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 18px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)', marginBottom: 4 }}>{n.title}</div>
                      <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 8 }}>{n.body}</div>
                      <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
                        <span>📨 Para: <b style={{ color: 'var(--text-secondary)' }}>{dest}</b></span>
                        <span>📅 {new Date(n.createdAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                        <span>👁 Leído por: <b style={{ color: n.readBy.length > 0 ? '#1E9E3A' : 'var(--text-muted)' }}>{n.readBy.length}</b></span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Scoring constants ────────────────────────────────────────────────────────
const LEVEL_INFO = {
  1: { name: 'Junior',  stars: 1, color: '#6b7280', bg: 'rgba(107,114,128,0.1)',   border: 'rgba(107,114,128,0.3)' },
  2: { name: 'Senior',  stars: 2, color: '#1E9E3A', bg: 'rgba(30,158,58,0.1)',     border: 'rgba(30,158,58,0.35)' },
  3: { name: 'Elite',   stars: 3, color: '#b8860b', bg: 'rgba(255,196,0,0.12)',    border: '#FFC400' },
} as const;

const EVENT_LABELS: Record<string, string> = {
  falta_injustificada: 'Falta injustificada',
  falta_justificada:   'Falta justificada',
  atraso:              'Atraso',
  queja:               'Queja de alumno',
  cancelacion_tardia:  'Cancelación tardía',
  upsell:              'Upsell',
  bonus_retencion:     'Bonus retención',
  bonus_puntualidad:   'Bonus puntualidad',
  review_trustpilot:   'Reseña Trustpilot',
  bonus_feedback:      'Bonus feedback',
  cambio_por_alumno:   'Cambio por alumno',
  cambio_por_profesor: 'Profesor abandonó alumno',
  profe_del_mes:       '🏆 Profe del Mes',
  profe_del_trimestre: '🏆 Profe del Trimestre',
  email_presentacion_tardio: 'Email de presentación tardío',
};

const EVENT_ICONS: Record<string, string> = {
  falta_injustificada: '🚫',
  falta_justificada:   '📋',
  atraso:              '⏰',
  queja:               '😤',
  cancelacion_tardia:  '❌',
  upsell:              '📈',
  bonus_retencion:     '🏅',
  bonus_puntualidad:   '⭐',
  review_trustpilot:   '⭐',
  bonus_feedback:      '💬',
  cambio_por_alumno:   '👤',
  cambio_por_profesor: '⚠️',
  profe_del_mes:       '🏆',
  profe_del_trimestre: '🏆',
  email_presentacion_tardio: '📧',
};

// ─── Seguimiento del email de presentación (resumen para el admin) ────────────
interface PresentationPending {
  studentName: string;
  hours: number;
  statusKind: 'on_time' | 'warning' | 'at_risk' | 'overdue';
  statusLabel: string;
}
interface TeacherPresentationSummary {
  pending: PresentationPending[];
  overdueCount: number;
  badge: { text: string; color: string; bg: string; border: string };
}

const PRES_STATUS_LABEL: Record<string, string> = {
  sent:    '✅ Enviado',
  on_time: '🟢 A tiempo',
  warning: '🟡 A tiempo',
  at_risk: '⏰ En riesgo',
  overdue: '🔴 Fuera de tiempo',
};

// Paleta por estado, en el mismo formato que SPECIALTY_STYLE.
const PRES_STATUS_STYLE: Record<string, { color: string; bg: string; border: string }> = {
  sent:    { color: '#1E9E3A', bg: 'rgba(30,158,58,0.1)',  border: 'rgba(30,158,58,0.3)' },
  on_time: { color: '#1E9E3A', bg: 'rgba(30,158,58,0.1)',  border: 'rgba(30,158,58,0.3)' },
  warning: { color: '#b8860b', bg: 'rgba(255,196,0,0.14)', border: 'rgba(255,196,0,0.5)' },
  at_risk: { color: '#f97316', bg: 'rgba(249,115,22,0.1)', border: 'rgba(249,115,22,0.4)' },
  overdue: { color: '#ef4444', bg: 'rgba(239,68,68,0.1)',  border: 'rgba(239,68,68,0.4)' },
};

// Resume el estado del email de presentación de las asignaciones de un profesor.
// Usa la fuente única lib/presentationEmailUtils para clasificar cada pendiente.
function teacherPresentationSummary(teacherAssignments: Assignment[], now: number): TeacherPresentationSummary {
  const pending: PresentationPending[] = [];
  for (const a of teacherAssignments) {
    if (a.presentationEmailSent) continue;
    const st = getPresentationEmailStatus(a, now);
    if (st.status === 'sent') continue;
    pending.push({ studentName: a.studentName, hours: st.hoursElapsed, statusKind: st.status, statusLabel: PRES_STATUS_LABEL[st.status] ?? '' });
  }
  pending.sort((x, y) => y.hours - x.hours);
  const overdueCount = pending.filter(p => p.statusKind === 'overdue').length;

  let badge: TeacherPresentationSummary['badge'];
  if (pending.length === 0) {
    badge = { text: '✅ Al día', color: '#1E9E3A', bg: 'rgba(30,158,58,0.1)', border: 'rgba(30,158,58,0.3)' };
  } else if (overdueCount > 0) {
    badge = { text: `🔴 ${overdueCount} pendiente${overdueCount !== 1 ? 's' : ''} (+24h)`, color: '#ef4444', bg: 'rgba(239,68,68,0.1)', border: 'rgba(239,68,68,0.4)' };
  } else {
    badge = { text: `⚠️ ${pending.length} pendiente${pending.length !== 1 ? 's' : ''} (<24h)`, color: '#b8860b', bg: 'rgba(255,196,0,0.14)', border: 'rgba(255,196,0,0.5)' };
  }
  return { pending, overdueCount, badge };
}

// ─── Stars display ────────────────────────────────────────────────────────────
function Stars({ level, size = 14 }: { level: number; size?: number }) {
  return (
    <span style={{ fontSize: size, lineHeight: 1 }}>
      {[1, 2, 3].map(i => (
        <span key={i} style={{ color: i <= level ? '#FFC400' : '#d1d5db' }}>★</span>
      ))}
    </span>
  );
}

// ─── Level Badge ──────────────────────────────────────────────────────────────
function LevelBadge({ level, blocked }: { level: number; blocked?: boolean }) {
  if (blocked) {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '3px 10px', borderRadius: 20,
        background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.4)',
        color: '#ef4444', fontSize: 11, fontWeight: 700,
      }}>
        🔴 Bloqueado
      </span>
    );
  }
  const info = LEVEL_INFO[(level as 1 | 2 | 3)] ?? LEVEL_INFO[1];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 10px', borderRadius: 20,
      background: info.bg, border: `1px solid ${info.border}`,
      color: info.color, fontSize: 11, fontWeight: 700,
      boxShadow: level === 3 ? '0 0 8px rgba(255,196,0,0.3)' : 'none',
      whiteSpace: 'nowrap',
    }}>
      <Stars level={level} size={11} />
      {info.name}
    </span>
  );
}

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
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 16, width: '100%', maxWidth: 440, padding: 28 }}>
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
              <div style={{ background: 'rgba(30,158,58,0.06)', border: '1px solid rgba(30,158,58,0.2)', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: 'var(--text-secondary)' }}>
                💡 Contraseña inicial: <code style={{ color: '#1E9E3A' }}>profe123</code>
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                <button onClick={onClose} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 14 }}>Cancelar</button>
                <button onClick={handleSave} disabled={!form.name || !form.email} style={{ flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: form.name && form.email ? '#1E9E3A' : 'var(--bg-surface-3)', color: form.name && form.email ? 'white' : 'var(--text-muted)', cursor: form.name && form.email ? 'pointer' : 'not-allowed', fontSize: 14, fontWeight: 600 }}>
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

// ─── Emails de presentación (pestaña) ─────────────────────────────────────────
// Sustituye a la antigua grilla de cobertura semanal. Lista las asignaciones con
// el estado del email de bienvenida; los pendientes van arriba ordenados por
// mayor retraso, que son los que hay que perseguir.

// "5h" / "3 días": pasadas 48 h el retraso en horas deja de leerse.
function formatDelay(hours: number): string {
  const h = Math.floor(Math.max(0, hours));
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)} días`;
}

interface EmailRow {
  id: string;
  studentName: string;
  teacherName: string;
  sent: boolean;
  statusKind: PresentationEmailStatusKind;
  statusLabel: string;
  delayHours: number;
  createdAt: string;
}

function PresentationEmailsTab({ assignments, nowMs }: { assignments: Assignment[]; nowMs: number }) {
  const [filter, setFilter] = useState<'pending' | 'sent' | 'all'>('pending');

  const rows = useMemo<EmailRow[]>(() => {
    const mapped = assignments.map(a => {
      const st = getPresentationEmailStatus(a, nowMs);
      return {
        id: a.id,
        studentName: a.studentName,
        teacherName: a.teacherName,
        sent: st.status === 'sent',
        statusKind: st.status,
        statusLabel: PRES_STATUS_LABEL[st.status] ?? '',
        delayHours: hoursSinceAssigned(a.createdAt, nowMs),
        createdAt: a.createdAt,
      };
    });
    // Pendientes primero (mayor retraso arriba); los enviados, por recencia.
    mapped.sort((x, y) => {
      if (x.sent !== y.sent) return x.sent ? 1 : -1;
      if (!x.sent) return y.delayHours - x.delayHours;
      return new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime();
    });
    return mapped;
  }, [assignments, nowMs]);

  const pendingCount = rows.filter(r => !r.sent).length;
  const overdueCount = rows.filter(r => r.statusKind === 'overdue').length;
  const visible = rows.filter(r => filter === 'all' || (filter === 'pending' ? !r.sent : r.sent));

  const filters = [
    { id: 'pending', label: `Pendientes${pendingCount > 0 ? ` (${pendingCount})` : ''}` },
    { id: 'sent',    label: 'Enviados' },
    { id: 'all',     label: 'Todos' },
  ] as const;

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        {filters.map(f => {
          const active = filter === f.id;
          return (
            <button key={f.id} onClick={() => setFilter(f.id)}
              style={{ padding: '4px 12px', borderRadius: 20, border: `1.5px solid ${active ? '#1E9E3A' : 'var(--border)'}`, background: active ? 'rgba(30,158,58,0.1)' : 'transparent', color: active ? '#1E9E3A' : 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, fontWeight: active ? 700 : 500, fontFamily: 'inherit' }}>
              {f.label}
            </button>
          );
        })}
        {overdueCount > 0 && (
          <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: '#ef4444' }}>
            🔴 {overdueCount} fuera de tiempo
          </span>
        )}
      </div>

      {visible.length === 0 ? (
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '32px 14px', textAlign: 'center', fontSize: 13, color: 'var(--text-muted)' }}>
          {filter === 'pending' ? '✅ No hay emails de presentación pendientes.' : 'No hay asignaciones que mostrar.'}
        </div>
      ) : (
        <>
          {/* Desktop: table */}
          <div className="desk-only" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto', maxHeight: 500, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                  <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)' }}>
                    {['Alumno', 'Profesor', 'Estado', 'Retraso', 'Asignada'].map(h => (
                      <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visible.map(r => {
                    const st = PRES_STATUS_STYLE[r.statusKind];
                    return (
                      <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '11px 14px', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{r.studentName}</td>
                        <td style={{ padding: '11px 14px', fontSize: 13, color: 'var(--text-secondary)' }}>{r.teacherName}</td>
                        <td style={{ padding: '11px 14px' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 9px', borderRadius: 20, background: st.bg, border: `1px solid ${st.border}`, color: st.color, fontSize: 11, fontWeight: 700 }}>
                            {r.statusLabel}
                          </span>
                        </td>
                        <td style={{ padding: '11px 14px', fontSize: 13, fontWeight: r.sent ? 400 : 700, color: r.sent ? 'var(--text-muted)' : st.color }}>
                          {r.sent ? '—' : formatDelay(r.delayHours)}
                        </td>
                        <td style={{ padding: '11px 14px', fontSize: 12, color: 'var(--text-muted)' }}>
                          {new Date(r.createdAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile: cards */}
          <div className="mob-only" style={{ flexDirection: 'column', gap: 10 }}>
            {visible.map(r => {
              const st = PRES_STATUS_STYLE[r.statusKind];
              return (
                <div key={r.id} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <div style={{ flex: 1, minWidth: 0, fontWeight: 700, fontSize: 14, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.studentName}</div>
                    {!r.sent && <span style={{ fontSize: 13, fontWeight: 700, color: st.color, flexShrink: 0 }}>{formatDelay(r.delayHours)}</span>}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 9 }}>
                    {r.teacherName} · asignada el {new Date(r.createdAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}
                  </div>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 9px', borderRadius: 20, background: st.bg, border: `1px solid ${st.border}`, color: st.color, fontSize: 11, fontWeight: 700 }}>
                    {r.statusLabel}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
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
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 18, width: '100%', maxWidth: 940, maxHeight: '94vh', overflowY: 'auto', padding: 26 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 42, height: 42, borderRadius: '50%', background: 'var(--bg-surface-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 15, color: 'var(--text-secondary)' }}>{teacher.avatar}</div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 17, color: 'var(--text-primary)' }}>Disponibilidad de {teacher.name}</div>
              <div style={{ fontSize: 12, color: saving ? '#FFC400' : 'var(--text-secondary)' }}>
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
  const isNegative = basePoints < 0;

  const isFalta = eventType === 'falta_injustificada' || eventType === 'falta_justificada';
  const isCambio = eventType === 'cambio_por_alumno' || eventType === 'cambio_por_profesor';

  const inputStyle = {
    width: '100%', padding: '10px 12px', borderRadius: 8,
    border: '1.5px solid var(--border)', fontSize: 13,
    background: 'white', color: '#111827',
    boxSizing: 'border-box' as const,
    fontFamily: "'Radio Canada', sans-serif",
  };

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

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: '#F7F7F5', border: '1px solid var(--border)', borderRadius: 16, width: '100%', maxWidth: 480, padding: 28, boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
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
              <optgroup label="Faltas">
                <option value="falta_injustificada">🚫 Falta injustificada (−15 pts · baja nivel)</option>
                <option value="falta_justificada">📋 Falta justificada (−5 pts)</option>
              </optgroup>
              <optgroup label="Desempeño negativo">
                <option value="atraso">⏰ Atraso (−8 pts)</option>
                <option value="queja">😤 Queja de alumno (−20 pts)</option>
                <option value="cancelacion_tardia">❌ Cancelación tardía &lt;24hs (−10 pts)</option>
              </optgroup>
              <optgroup label="Cambio de profesor">
                <option value="cambio_por_alumno">👤 Cambio solicitado por alumno (−10 pts)</option>
                <option value="cambio_por_profesor">⚠️ Profesor abandonó al alumno (−20 pts)</option>
              </optgroup>
              <optgroup label="Logros positivos">
                <option value="upsell">📈 Upsell (+25 pts + €20/upsell)</option>
                <option value="bonus_retencion">🏅 Bonus retención 6 meses (+30 pts + €30)</option>
                <option value="bonus_puntualidad">⭐ Bonus puntualidad del mes (+20 pts)</option>
                <option value="review_trustpilot">⭐ Reseña Trustpilot (+15 pts)</option>
                <option value="bonus_feedback">💬 Bonus feedback mensual (+10 pts)</option>
              </optgroup>
            </select>
          </div>

          {/* Falta warnings */}
          {eventType === 'falta_injustificada' && (
            <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '10px 14px', fontSize: 12 }}>
              <div style={{ color: '#ef4444', fontWeight: 700, marginBottom: 3 }}>⚠️ Falta injustificada</div>
              <div style={{ color: '#6b7280' }}>−15 puntos · Baja de nivel automático · 0 faltas injustificadas permitidas en cualquier nivel</div>
            </div>
          )}
          {eventType === 'falta_justificada' && (
            <div style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 8, padding: '10px 14px', fontSize: 12 }}>
              <div style={{ color: '#f59e0b', fontWeight: 700, marginBottom: 3 }}>📋 Falta justificada</div>
              <div style={{ color: '#6b7280' }}>−5 puntos · No baja de nivel · Máximo 1 falta justificada por mes</div>
            </div>
          )}

          {/* Cambio warnings */}
          {isCambio && (
            <div style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 8, padding: '10px 14px', fontSize: 12 }}>
              <div style={{ color: '#ef4444', fontWeight: 700, marginBottom: 2 }}>
                {eventType === 'cambio_por_profesor' ? '⚠️ Causa directa' : '👤 Causa externa'}
              </div>
              <div style={{ color: '#6b7280' }}>{basePoints} puntos</div>
            </div>
          )}

          {/* Alumno reference for falta/cambio */}
          {(isFalta || isCambio || eventType === 'review_trustpilot') && (
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
                Alumno involucrado {isFalta || isCambio ? '' : '(opcional)'}
              </label>
              <select value={studentRef} onChange={e => setStudentRef(e.target.value)} style={inputStyle}>
                <option value="">— Seleccionar alumno —</option>
                {students.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
              </select>
            </div>
          )}

          {/* Retention bonus student */}
          {eventType === 'bonus_retencion' && (
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>Alumno que cumplió 6 meses</label>
              <select value={studentRef} onChange={e => setStudentRef(e.target.value)} style={inputStyle}>
                <option value="">— Seleccionar alumno —</option>
                {students.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
              </select>
            </div>
          )}

          {/* Upsell quantity */}
          {eventType === 'upsell' && (
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>Cantidad de upsells</label>
              <input type="number" min={1} value={quantity} onChange={e => setQuantity(Math.max(1, parseInt(e.target.value) || 1))} style={inputStyle} />
            </div>
          )}

          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
              Nota <span style={{ color: '#ef4444' }}>*</span>
            </label>
            <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="Descripción del evento..." rows={3}
              style={{ ...inputStyle, resize: 'vertical', fontFamily: "'Radio Canada', sans-serif" }} />
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
            <button onClick={onClose} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: '#6b7280', cursor: 'pointer', fontSize: 14 }}>Cancelar</button>
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
function checkLevelReqs(
  activeStudents: number,
  retentionPct: number,
  faltasInjust: number,
  faltasJust: number,
  upsellsTotal: number,
  monthsOnPlatform: number,
  level: number,
) {
  if (level === 1) return [
    { label: `Retención ≥65% (actual: ${Math.round(retentionPct)}%)`, met: retentionPct >= 65 },
    { label: `0 faltas injustificadas (actual: ${faltasInjust})`, met: faltasInjust === 0 },
    { label: `Máx. 1 falta justificada al mes (actual: ${faltasJust})`, met: faltasJust <= 1 },
  ];
  if (level === 2) return [
    { label: `Retención ≥80% (actual: ${Math.round(retentionPct)}%)`, met: retentionPct >= 80 },
    { label: `0 faltas injustificadas (actual: ${faltasInjust})`, met: faltasInjust === 0 },
    { label: `≥5 alumnos activos (actual: ${activeStudents})`, met: activeStudents >= 5 },
    { label: `≥1 upsell realizado (actual: ${upsellsTotal})`, met: upsellsTotal >= 1 },
  ];
  return [
    { label: `Retención ≥85% (actual: ${Math.round(retentionPct)}%)`, met: retentionPct >= 85 },
    { label: `0 faltas absolutas (actual: ${faltasInjust + faltasJust})`, met: faltasInjust === 0 && faltasJust === 0 },
    { label: `≥10 alumnos activos (actual: ${activeStudents})`, met: activeStudents >= 10 },
    { label: `≥3 upsells realizados (actual: ${upsellsTotal})`, met: upsellsTotal >= 3 },
    { label: `>6 meses en la plataforma (actual: ${monthsOnPlatform})`, met: monthsOnPlatform >= 6 },
  ];
}

// ─── Profe del Mes Modal ──────────────────────────────────────────────────────
function ProfeDelMesModal({ scored, isQuarter, onClose, onConfirm }: {
  scored: Array<{ t: Teacher; totalScore: number; currentLevel: number }>;
  isQuarter: boolean;
  onClose: () => void;
  onConfirm: (teacherId: string, euros: number) => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState(scored[0]?.t.id ?? '');
  const [euros, setEuros] = useState(isQuarter ? 150 : 75);
  const [saving, setSaving] = useState(false);

  const min = isQuarter ? 100 : 50;
  const max = isQuarter ? 300 : 150;

  async function handleConfirm() {
    if (!selectedId) return;
    setSaving(true);
    await onConfirm(selectedId, euros);
    setSaving(false);
    onClose();
  }

  const selectedTeacher = scored.find(s => s.t.id === selectedId)?.t;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: '#F7F7F5', border: '1px solid var(--border)', borderRadius: 16, width: '100%', maxWidth: 440, padding: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 17, color: '#111827' }}>
              🏆 {isQuarter ? 'Profe del Trimestre' : 'Profe del Mes'}
            </div>
            <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>
              {isQuarter ? '+100 pts · Bonus €100–300' : '+50 pts · Bonus €50–150'}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#6b7280' }}>✕</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
              Seleccionar profesor ganador
            </label>
            <select value={selectedId} onChange={e => setSelectedId(e.target.value)} style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1.5px solid var(--border)', fontSize: 13, background: 'white', color: '#111827', fontFamily: "'Radio Canada', sans-serif" }}>
              {scored.slice(0, 10).map((s, i) => (
                <option key={s.t.id} value={s.t.id}>
                  {i === 0 ? '⭐ ' : `#${i + 1} `}{s.t.name} — {s.totalScore} pts
                </option>
              ))}
            </select>
          </div>

          {selectedTeacher && (
            <div style={{ background: 'rgba(255,196,0,0.1)', border: '1px solid rgba(255,196,0,0.4)', borderRadius: 10, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'rgba(255,196,0,0.2)', border: '2px solid #FFC400', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 16, color: '#b8860b' }}>{selectedTeacher.avatar}</div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15, color: '#111827' }}>{selectedTeacher.name}</div>
                <div style={{ fontSize: 12, color: '#b8860b' }}>{scored.find(s => s.t.id === selectedId)?.totalScore ?? 0} pts · Nivel {scored.find(s => s.t.id === selectedId)?.currentLevel}</div>
              </div>
              <div style={{ marginLeft: 'auto', fontSize: 28 }}>🏆</div>
            </div>
          )}

          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
              Bonus en euros (€{min} – €{max})
            </label>
            <input
              type="number"
              min={min} max={max} step={5}
              value={euros}
              onChange={e => setEuros(Math.min(max, Math.max(min, parseInt(e.target.value) || min)))}
              style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1.5px solid var(--border)', fontSize: 13, background: 'white', color: '#111827', fontFamily: "'Radio Canada', sans-serif" }}
            />
          </div>

          <div style={{ background: 'rgba(255,196,0,0.1)', border: '1px solid rgba(255,196,0,0.3)', borderRadius: 8, padding: '10px 14px', display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 14, color: '#1E9E3A', fontWeight: 700 }}>
              +{isQuarter ? 100 : 50} puntos
            </span>
            <span style={{ fontSize: 14, color: '#b8860b', fontWeight: 700 }}>+€{euros}</span>
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={onClose} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: '#6b7280', cursor: 'pointer', fontSize: 14 }}>Cancelar</button>
            <button onClick={handleConfirm} disabled={!selectedId || saving}
              style={{ flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: selectedId && !saving ? '#FFC400' : '#d1d5db', color: selectedId ? '#111827' : '#6b7280', cursor: selectedId && !saving ? 'pointer' : 'not-allowed', fontSize: 14, fontWeight: 700 }}>
              {saving ? 'Guardando...' : '🏆 Confirmar ganador'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Scoring Tab ──────────────────────────────────────────────────────────────
function ScoringTab() {
  const {
    teachers, assignments, students, scoringEvents,
    addScoringEvent, assignTeacherOfMonth, assignTeacherOfQuarter,
    forceMonthlyReset, forceQuarterlyReset, reloadAll,
  } = useTeachers();
  const { user } = useAuth();
  const [eventModalTeacher, setEventModalTeacher]   = useState<Teacher | null>(null);
  const [selectedTeacherId, setSelectedTeacherId]   = useState<string | null>(null);
  const [showLevelReqs, setShowLevelReqs]           = useState(false);
  const [showProfeDelMes, setShowProfeDelMes]       = useState(false);
  const [showProfeDelTrimestre, setShowProfeDelTrimestre] = useState(false);
  const [resetting, setResetting]                   = useState<'monthly' | 'quarterly' | null>(null);
  // Criterio de orden del ranking. 'score' = orden por defecto; 'retention' =
  // ordena por margen de retención (con dirección desc/asc).
  const [rankSort, setRankSort]                     = useState<'score' | 'retention'>('score');
  const [retDir, setRetDir]                         = useState<'desc' | 'asc'>('desc');

  const MEDALS = ['🥇', '🥈', '🥉'];
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const monthStart    = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  // Next reset dates
  const now = new Date();
  const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const daysToMonthly = Math.ceil((nextMonthStart.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  const nextQtrMonth = Math.ceil((now.getMonth() + 1) / 3) * 3;
  const nextQtrYear = nextQtrMonth > 11 ? now.getFullYear() + 1 : now.getFullYear();
  const nextQtrStart = new Date(nextQtrYear, nextQtrMonth % 12, 1);
  const daysToQuarterly = Math.ceil((nextQtrStart.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  const scored = teachers.map(t => {
    const ta = assignments.filter(a => a.teacherId === t.id);
    const te = scoringEvents.filter(e => e.teacherId === t.id);
    const monthEvents = te.filter(e => new Date(e.createdAt) >= monthStart);

    const manualPoints   = te.reduce((s, e) => s + e.points, 0);
    const manualEuros    = te.reduce((s, e) => s + e.euros, 0);
    const activeStudents = ta.length;
    const monthlyHours   = t.weeklyLoad * 4;
    // Retención churn-aware: se prefiere el valor persistido (activos vs. bajas,
    // calculado en dbRecalculateTeacherScore). Respaldo por antigüedad solo si
    // aún no se recalculó para este profesor.
    const retainedByAge  = ta.filter(a => {
      const date = a.startDate ? new Date(a.startDate) : new Date(a.createdAt);
      return date < thirtyDaysAgo;
    }).length;
    const retentionPct   = t.retentionRate ?? (activeStudents > 0 ? (retainedByAge / activeStudents) * 100 : 100);

    let autoPoints = activeStudents * 10 + monthlyHours * 2;
    if (retentionPct >= 85)                               autoPoints += 50;
    else if (retentionPct >= 80)                          autoPoints += 25;
    else if (retentionPct < 65 && activeStudents > 0)     autoPoints -= 30;

    const totalScore   = Math.max(0, manualPoints + autoPoints);
    const currentLevel = totalScore >= 300 ? 3 : totalScore >= 150 ? 2 : 1;
    const monthlyEuros = monthEvents.reduce((s, e) => s + e.euros, 0);
    const isBlocked    = (t.isBlocked ?? false) || (activeStudents > 0 && retentionPct < 65);

    const faltasInjust  = monthEvents.filter(e => e.eventType === 'falta_injustificada').length;
    const faltasJust    = monthEvents.filter(e => e.eventType === 'falta_justificada').length;
    const upsellsTotal  = te.filter(e => e.eventType === 'upsell').reduce((s, e) => s + (e.quantity ?? 1), 0);
    const monthsOnPlatform = t.createdAt
      ? Math.floor((Date.now() - new Date(t.createdAt).getTime()) / (30 * 24 * 60 * 60 * 1000))
      : 0;

    return { t, totalScore, totalEuros: manualEuros, currentLevel, activeStudents, retentionPct, monthlyEuros, faltasInjust, faltasJust, upsellsTotal, monthsOnPlatform, isBlocked };
  }).sort((a, b) => b.totalScore - a.totalScore);

  // Filas de la tabla del ranking, reordenadas según el criterio elegido. Cuando
  // se ordena por retención se desempata por score para un orden estable.
  const rankRows = useMemo(() => {
    if (rankSort !== 'retention') return scored;
    return [...scored].sort((a, b) => {
      const diff = retDir === 'desc' ? b.retentionPct - a.retentionPct : a.retentionPct - b.retentionPct;
      return diff !== 0 ? diff : b.totalScore - a.totalScore;
    });
  }, [scored, rankSort, retDir]);

  const selectedData   = selectedTeacherId ? scored.find(s => s.t.id === selectedTeacherId) : null;
  const selectedEvents = selectedTeacherId ? scoringEvents.filter(e => e.teacherId === selectedTeacherId) : [];

  const eventModalStudents = eventModalTeacher
    ? assignments.filter(a => a.teacherId === eventModalTeacher.id).map(a => ({ id: a.studentId, name: a.studentName }))
    : [];

  const teacherOfMonth = teachers.find(t => t.isTeacherOfMonth);
  const teacherOfQuarter = teachers.find(t => t.isTeacherOfQuarter);
  const monthLabel = now.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
  const quarter = Math.floor(now.getMonth() / 3) + 1;

  async function handleForceReset(type: 'monthly' | 'quarterly') {
    setResetting(type);
    if (type === 'monthly') await forceMonthlyReset();
    else await forceQuarterlyReset();
    setResetting(null);
  }

  return (
    <div>

      {/* ── Profe del Mes section ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14, marginBottom: 20 }}>

        {/* Profe del Mes */}
        <div style={{
          background: teacherOfMonth
            ? 'linear-gradient(135deg, rgba(255,196,0,0.12) 0%, rgba(255,220,80,0.06) 100%)'
            : 'var(--bg-surface)',
          border: `1px solid ${teacherOfMonth ? '#FFC400' : 'var(--border)'}`,
          borderRadius: 12, padding: '18px 20px',
          boxShadow: teacherOfMonth ? '0 0 20px rgba(255,196,0,0.15)' : 'none',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
                🏆 Profe del Mes
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{monthLabel}</div>
            </div>
            <button onClick={() => setShowProfeDelMes(true)}
              style={{ padding: '5px 12px', borderRadius: 8, border: '1px solid rgba(255,196,0,0.4)', background: 'rgba(255,196,0,0.1)', color: '#b8860b', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
              {teacherOfMonth ? 'Cambiar' : 'Asignar'}
            </button>
          </div>
          {teacherOfMonth ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 42, height: 42, borderRadius: '50%', background: 'rgba(255,196,0,0.2)', border: '2px solid #FFC400', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 15, color: '#b8860b' }}>{teacherOfMonth.avatar}</div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>{teacherOfMonth.name}</div>
                <div style={{ fontSize: 12, color: '#b8860b' }}>
                  Badge: 🏆 Profe del Mes — {monthLabel}
                </div>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic' }}>
              Sin asignar — top del ranking este mes: {scored[0]?.t.name ?? '—'}
            </div>
          )}
        </div>

        {/* Profe del Trimestre */}
        <div style={{
          background: teacherOfQuarter
            ? 'linear-gradient(135deg, rgba(255,196,0,0.12) 0%, rgba(255,220,80,0.06) 100%)'
            : 'var(--bg-surface)',
          border: `1px solid ${teacherOfQuarter ? '#FFC400' : 'var(--border)'}`,
          borderRadius: 12, padding: '18px 20px',
          boxShadow: teacherOfQuarter ? '0 0 20px rgba(255,196,0,0.15)' : 'none',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
                🏆 Profe del Trimestre
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Q{quarter} {now.getFullYear()} · Bonus €150 + 100 pts</div>
            </div>
            <button onClick={() => setShowProfeDelTrimestre(true)}
              style={{ padding: '5px 12px', borderRadius: 8, border: '1px solid rgba(255,196,0,0.4)', background: 'rgba(255,196,0,0.1)', color: '#b8860b', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
              {teacherOfQuarter ? 'Cambiar' : 'Asignar'}
            </button>
          </div>
          {teacherOfQuarter ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 42, height: 42, borderRadius: '50%', background: 'rgba(255,196,0,0.2)', border: '2px solid #FFC400', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 15, color: '#b8860b' }}>{teacherOfQuarter.avatar}</div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>{teacherOfQuarter.name}</div>
                <div style={{ fontSize: 12, color: '#b8860b' }}>Q{quarter} {now.getFullYear()}</div>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic' }}>
              Sin asignar este trimestre
            </div>
          )}
        </div>
      </div>

      {/* ── Reset management ── */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 20px', marginBottom: 20 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)', marginBottom: 12 }}>🔄 Ciclos de reset</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div style={{ background: 'var(--bg-surface-2)', borderRadius: 9, padding: '12px 14px' }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Próximo reset mensual</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>{daysToMonthly} días</div>
            <button
              onClick={() => handleForceReset('monthly')}
              disabled={resetting !== null}
              style={{ padding: '6px 14px', borderRadius: 7, border: '1px solid rgba(30,158,58,0.4)', background: 'rgba(30,158,58,0.08)', color: '#1E9E3A', fontSize: 12, fontWeight: 600, cursor: resetting ? 'wait' : 'pointer' }}>
              {resetting === 'monthly' ? '⏳ Reseteando...' : 'Forzar reset mensual'}
            </button>
          </div>
          <div style={{ background: 'var(--bg-surface-2)', borderRadius: 9, padding: '12px 14px' }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Próximo reset trimestral</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>{daysToQuarterly} días</div>
            <button
              onClick={() => handleForceReset('quarterly')}
              disabled={resetting !== null}
              style={{ padding: '6px 14px', borderRadius: 7, border: '1px solid rgba(245,158,11,0.4)', background: 'rgba(245,158,11,0.08)', color: '#f59e0b', fontSize: 12, fontWeight: 600, cursor: resetting ? 'wait' : 'pointer' }}>
              {resetting === 'quarterly' ? '⏳ Reseteando...' : 'Forzar reset trimestral'}
            </button>
          </div>
        </div>
      </div>

      {/* ── Tabla de puntos del sistema ── */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 20px', marginBottom: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)', marginBottom: 12 }}>📋 Tabla de puntos del sistema</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8 }}>
          {Object.entries(EVENT_POINTS).map(([key, pts]) => (
            <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '7px 11px', borderRadius: 8, background: 'var(--bg-surface-2)' }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {EVENT_ICONS[key] ?? '📌'} {EVENT_LABELS[key] ?? key}{key === 'email_presentacion_tardio' ? ' (>24h)' : ''}
              </span>
              <span style={{ fontSize: 12, fontWeight: 800, color: pts >= 0 ? '#1E9E3A' : '#ef4444', whiteSpace: 'nowrap' }}>
                {pts > 0 ? '+' : ''}{pts} puntos
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Ranking table ── */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' }}>⭐ Ranking de profesores</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              Score = eventos manuales + alumnos×10 + horas×2 + bonus retención
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              💡 Hacé clic en <b>Score</b> o <b>Retención</b> para reordenar la tabla
              {rankSort === 'retention' && <span style={{ color: '#1E9E3A', fontWeight: 600 }}> — ordenado por retención {retDir === 'desc' ? '(mayor a menor)' : '(menor a mayor)'}</span>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            {[
              { color: '#6b7280', label: '⭐ Junior (0–149)' },
              { color: '#1E9E3A', label: '⭐⭐ Senior (150–299)' },
              { color: '#FFC400', label: '⭐⭐⭐ Elite (300+)' },
              { color: '#ef4444', label: '🔴 Bloqueado' },
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
                {['Pos.', 'Nombre', 'Nivel', 'Score', 'Alumnos', 'Retención', '€ mes', ''].map(h => {
                  const thStyle = { padding: '10px 12px', textAlign: 'left' as const, fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' as const, letterSpacing: '0.04em', whiteSpace: 'nowrap' as const };
                  if (h === 'Score') {
                    const active = rankSort === 'score';
                    return (
                      <th key={h} style={thStyle}>
                        <button onClick={() => setRankSort('score')} title="Ordenar por score"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', textTransform: 'inherit', letterSpacing: 'inherit', color: active ? '#1E9E3A' : 'var(--text-muted)', fontWeight: active ? 700 : 600 }}>
                          {h}<span style={{ fontSize: 9 }}>{active ? '▼' : '↕'}</span>
                        </button>
                      </th>
                    );
                  }
                  if (h === 'Retención') {
                    const active = rankSort === 'retention';
                    return (
                      <th key={h} style={thStyle}>
                        <button
                          onClick={() => {
                            if (rankSort !== 'retention') { setRankSort('retention'); setRetDir('desc'); }
                            else setRetDir(d => (d === 'desc' ? 'asc' : 'desc'));
                          }}
                          title="Ordenar por margen de retención"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', textTransform: 'inherit', letterSpacing: 'inherit', color: active ? '#1E9E3A' : 'var(--text-muted)', fontWeight: active ? 700 : 600 }}>
                          {h}<span style={{ fontSize: 9 }}>{active ? (retDir === 'desc' ? '▼' : '▲') : '↕'}</span>
                        </button>
                      </th>
                    );
                  }
                  return <th key={h} style={thStyle}>{h}</th>;
                })}
              </tr>
            </thead>
            <tbody>
              {rankRows.map(({ t, totalScore, currentLevel, activeStudents, retentionPct, monthlyEuros, isBlocked }, idx) => {
                const showMedal = rankSort === 'score' && idx < 3;
                const info = LEVEL_INFO[(currentLevel as 1|2|3)];
                const isSelected = selectedTeacherId === t.id;
                const nextThreshold = currentLevel === 1 ? 150 : currentLevel === 2 ? 300 : 300;
                const prevThreshold = currentLevel === 1 ? 0   : currentLevel === 2 ? 150 : 300;
                const scorePct = currentLevel < 3
                  ? Math.min(100, ((totalScore - prevThreshold) / (nextThreshold - prevThreshold)) * 100)
                  : 100;
                const retColor = retentionPct >= 85 ? '#1E9E3A' : retentionPct >= 65 ? '#f59e0b' : '#ef4444';
                const isToM = t.isTeacherOfMonth;
                const isToQ = t.isTeacherOfQuarter;

                return (
                  <tr key={t.id} onClick={() => setSelectedTeacherId(isSelected ? null : t.id)}
                    style={{
                      borderBottom: '1px solid var(--border)',
                      background: isBlocked ? 'rgba(239,68,68,0.03)'
                        : isSelected ? 'rgba(30,158,58,0.04)'
                        : idx === 0 ? 'rgba(255,196,0,0.03)' : 'transparent',
                      cursor: 'pointer', transition: 'background 0.1s',
                    }}>
                    <td style={{ padding: '12px 12px', fontSize: showMedal ? 22 : 13, fontWeight: showMedal ? 400 : 600, color: 'var(--text-muted)' }}>
                      {showMedal ? MEDALS[idx] : `#${idx + 1}`}
                    </td>
                    <td style={{ padding: '12px 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{
                          width: 34, height: 34, borderRadius: '50%',
                          background: isBlocked ? 'rgba(239,68,68,0.1)' : info.bg,
                          border: `2px solid ${isBlocked ? 'rgba(239,68,68,0.4)' : info.border}`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 12, fontWeight: 700,
                          color: isBlocked ? '#ef4444' : info.color, flexShrink: 0,
                        }}>{t.avatar}</div>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            {t.name}
                            {isToM && <span title="Profe del Mes" style={{ fontSize: 14 }}>🏆</span>}
                            {isToQ && <span title="Profe del Trimestre" style={{ fontSize: 12 }}>🏅</span>}
                          </div>
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 3 }}>
                            {(t.specialties ?? []).map(sp => <SpecialtyChip key={sp} specialty={sp} />)}
                          </div>
                          {t.createdAt && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>desde {new Date(t.createdAt).toLocaleDateString('es-ES', { month: 'short', year: 'numeric' })}</div>}
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: '12px 12px' }}><LevelBadge level={currentLevel} blocked={isBlocked} /></td>
                    <td style={{ padding: '12px 12px', minWidth: 130 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--bg-surface-3)', overflow: 'hidden' }}>
                          <div style={{ width: `${scorePct}%`, height: '100%', borderRadius: 3, background: isBlocked ? '#ef4444' : info.color, transition: 'width 0.4s' }} />
                        </div>
                        <span style={{ fontSize: 14, fontWeight: 700, color: isBlocked ? '#ef4444' : info.color, minWidth: 36, textAlign: 'right' }}>{totalScore}</span>
                      </div>
                    </td>
                    <td style={{ padding: '12px 12px', fontSize: 15, fontWeight: 700, color: '#1E9E3A' }}>{activeStudents}</td>
                    <td style={{ padding: '12px 12px' }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: retColor }}>
                        {Math.round(retentionPct)}%
                        {retentionPct < 65 && activeStudents > 0 && <span style={{ marginLeft: 4, fontSize: 11 }}>🔴</span>}
                        {retentionPct >= 65 && retentionPct < 80 && <span style={{ marginLeft: 4, fontSize: 11 }}>⚠️</span>}
                      </span>
                    </td>
                    <td style={{ padding: '12px 12px', fontSize: 13, fontWeight: 600, color: monthlyEuros > 0 ? '#1E9E3A' : 'var(--text-muted)' }}>
                      {monthlyEuros > 0 ? `€${monthlyEuros}` : '—'}
                    </td>
                    <td style={{ padding: '12px 8px' }} onClick={e => e.stopPropagation()}>
                      <button onClick={() => setEventModalTeacher(t)}
                        style={{ padding: '8px 10px', borderRadius: 7, border: '1px solid #1E9E3A', background: 'rgba(30,158,58,0.08)', color: '#1E9E3A', cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', minHeight: 40 }}>
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
              <LevelBadge level={selectedData.currentLevel} blocked={selectedData.isBlocked} />
              {selectedData.isBlocked && (
                <span style={{ fontSize: 12, color: '#ef4444', background: 'rgba(239,68,68,0.08)', padding: '3px 8px', borderRadius: 6, border: '1px solid rgba(239,68,68,0.2)' }}>
                  ⚠️ Retención baja ({Math.round(selectedData.retentionPct)}%) — no puede recibir nuevos alumnos
                </span>
              )}
            </div>
            <button onClick={() => setSelectedTeacherId(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
            {/* Level requirements */}
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>Requisitos de nivel</div>
              {[1, 2, 3].map(lvl => {
                const reqs = checkLevelReqs(selectedData.activeStudents, selectedData.retentionPct, selectedData.faltasInjust, selectedData.faltasJust, selectedData.upsellsTotal, selectedData.monthsOnPlatform, lvl);
                const info = LEVEL_INFO[(lvl as 1|2|3)];
                const allMet = reqs.every(r => r.met);
                return (
                  <div key={lvl} style={{ border: `1px solid ${allMet ? info.border : 'var(--border)'}`, borderRadius: 8, padding: '10px 12px', marginBottom: 8, background: allMet ? info.bg : 'transparent' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: info.color, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Stars level={lvl} size={11} /> {info.name}
                    </div>
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
                const icon = EVENT_ICONS[ev.eventType] ?? '📌';
                return (
                  <div key={ev.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '8px 10px', borderRadius: 7, background: isPos ? 'rgba(30,158,58,0.06)' : 'rgba(239,68,68,0.06)', border: `1px solid ${isPos ? 'rgba(30,158,58,0.15)' : 'rgba(239,68,68,0.15)'}`, marginBottom: 6 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: isPos ? '#1E9E3A' : '#ef4444', display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span>{icon}</span>
                        {EVENT_LABELS[ev.eventType] ?? ev.eventType}
                      </div>
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
          <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>📋 Requisitos por nivel</span>
          <span style={{ color: 'var(--text-muted)', fontSize: 16 }}>{showLevelReqs ? '▲' : '▼'}</span>
        </button>
        {showLevelReqs && (
          <div style={{ padding: '0 20px 20px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
            {([
              {
                level: 1,
                reqs: ['Retención mínima 65%', '0 faltas injustificadas', 'Máx. 1 falta justificada al mes'],
                score: '0–149 pts',
              },
              {
                level: 2,
                reqs: ['Retención mínima 80%', '0 faltas injustificadas', 'Mínimo 5 alumnos activos', 'Al menos 1 upsell'],
                score: '150–299 pts',
              },
              {
                level: 3,
                reqs: ['Retención mínima 85%', '0 faltas absolutas', 'Mínimo 10 alumnos activos', 'Al menos 3 upsells', 'Más de 6 meses'],
                score: '300+ pts',
              },
            ] as const).map(({ level, reqs, score }) => {
              const info = LEVEL_INFO[(level as 1|2|3)];
              return (
                <div key={level} style={{ border: `1px solid ${info.border}`, borderRadius: 10, padding: '14px 16px', background: info.bg }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: info.color, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Stars level={level} size={13} /> {info.name}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>Score: {score}</div>
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

      {/* Modals */}
      {eventModalTeacher && (
        <EventModal
          teacher={eventModalTeacher}
          students={eventModalStudents}
          createdBy={user?.displayName ?? 'Admin'}
          onClose={() => setEventModalTeacher(null)}
          onSave={addScoringEvent}
        />
      )}

      {showProfeDelMes && (
        <ProfeDelMesModal
          scored={scored}
          isQuarter={false}
          onClose={() => setShowProfeDelMes(false)}
          onConfirm={assignTeacherOfMonth}
        />
      )}

      {showProfeDelTrimestre && (
        <ProfeDelMesModal
          scored={scored}
          isQuarter={true}
          onClose={() => setShowProfeDelTrimestre(false)}
          onConfirm={assignTeacherOfQuarter}
        />
      )}
    </div>
  );
}

// ─── Class Tracking helpers ───────────────────────────────────────────────────
function TrackingMiniBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div style={{ height: 4, borderRadius: 2, background: 'var(--bg-surface-3)', overflow: 'hidden', minWidth: 70 }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 2 }} />
    </div>
  );
}

// ─── Class Tracking Tab ───────────────────────────────────────────────────────
function ClassTrackingTab() {
  const { assignments, teachers } = useTeachers();

  const [search, setSearch]               = useState('');
  const [teacherFilter, setTeacherFilter] = useState('');
  const [statusFilter, setStatusFilter]   = useState<'all' | 'near15' | 'near30' | 'near6m' | 'bonus'>('all');
  const [sortCol, setSortCol]             = useState<'urgency' | 'classNum' | 'seniority' | 'name' | 'teacher'>('urgency');
  const [sortDir, setSortDir]             = useState<'asc' | 'desc'>('asc');

  const today = new Date();

  const rows = assignments.map(a => {
    const classNum   = calcCurrentClassNumber(a);
    const totalDays  = a.startDate
      ? Math.max(0, Math.floor((today.getTime() - new Date(a.startDate + 'T00:00:00').getTime()) / 86400000))
      : null;
    const seniorityMonths = totalDays !== null ? Math.floor(totalDays / 30) : null;
    const seniorityDays   = totalDays !== null ? totalDays % 30 : null;
    const daysToBonus     = totalDays !== null ? Math.max(0, 180 - totalDays) : null;
    const bonusAvailable  = totalDays !== null && totalDays >= 180;
    const bonusPct        = totalDays !== null ? Math.min(100, (totalDays / 180) * 100) : 0;
    const toClass15       = Math.max(0, 15 - classNum);
    const class15Reached  = classNum >= 15;
    const class15Pct      = Math.min(100, (classNum / 15) * 100);
    const toClass30       = Math.max(0, 30 - classNum);
    const class30Reached  = classNum >= 30;
    const class30Pct      = Math.min(100, (classNum / 30) * 100);
    return {
      a, classNum, totalDays, seniorityMonths, seniorityDays,
      daysToBonus, bonusAvailable, bonusPct,
      toClass15, class15Reached, class15Pct,
      toClass30, class30Reached, class30Pct,
    };
  });

  const near15Count     = rows.filter(d => !d.class15Reached && d.toClass15 <= 3).length;
  const near30Count     = rows.filter(d => d.class15Reached && !d.class30Reached && d.toClass30 <= 3).length;
  const bonusAvailCount = rows.filter(d => d.bonusAvailable).length;

  function handleSort(col: typeof sortCol) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  }

  const filtered = rows.filter(d => {
    const q = search.toLowerCase();
    if (q && !d.a.studentName.toLowerCase().includes(q) && !d.a.teacherName.toLowerCase().includes(q)) return false;
    if (teacherFilter && d.a.teacherId !== teacherFilter) return false;
    if (statusFilter === 'near15' && (d.class15Reached || d.toClass15 > 3)) return false;
    if (statusFilter === 'near30' && (!d.class15Reached || d.class30Reached || d.toClass30 > 3)) return false;
    if (statusFilter === 'near6m' && (d.bonusAvailable || d.daysToBonus === null || d.daysToBonus > 15)) return false;
    if (statusFilter === 'bonus'  && !d.bonusAvailable) return false;
    return true;
  });

  function urgencyOf(d: typeof rows[0]) {
    return Math.min(
      !d.class15Reached && d.toClass15 <= 3 ? d.toClass15 : 9999,
      d.class15Reached && !d.class30Reached && d.toClass30 <= 3 ? d.toClass30 : 9999,
      !d.bonusAvailable && d.daysToBonus !== null && d.daysToBonus <= 15 ? d.daysToBonus : 9999,
    );
  }

  const sorted = [...filtered].sort((a, b) => {
    let v = 0;
    if      (sortCol === 'urgency')   v = urgencyOf(a) - urgencyOf(b);
    else if (sortCol === 'classNum')  v = a.classNum - b.classNum;
    else if (sortCol === 'seniority') v = (a.totalDays ?? -1) - (b.totalDays ?? -1);
    else if (sortCol === 'name')      v = a.a.studentName.localeCompare(b.a.studentName);
    else if (sortCol === 'teacher')   v = a.a.teacherName.localeCompare(b.a.teacherName);
    return sortDir === 'asc' ? v : -v;
  });

  const uniqueTeachers = teachers.filter(t => assignments.some(a => a.teacherId === t.id));

  function arrow(col: typeof sortCol) {
    if (sortCol !== col) return <span style={{ color: 'var(--text-muted)', marginLeft: 4, fontSize: 10 }}>↕</span>;
    return <span style={{ color: '#1E9E3A', marginLeft: 4, fontSize: 10 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>;
  }

  const thBase = {
    padding: '10px 12px', textAlign: 'left' as const, fontSize: 11, fontWeight: 600,
    color: 'var(--text-muted)', textTransform: 'uppercase' as const, letterSpacing: '0.04em',
    whiteSpace: 'nowrap' as const, background: 'var(--bg-surface-2)', borderBottom: '1px solid var(--border)',
  };

  const alertCards = [
    { icon: '🎬', count: near15Count,     status: 'near15' as const, label: 'cerca de clase 15',    color: '#b8860b', bg: 'rgba(255,196,0,0.1)',    border: 'rgba(255,196,0,0.6)' },
    { icon: '🏆', count: near30Count,     status: 'near30' as const, label: 'cerca de clase 30',    color: '#1E9E3A', bg: 'rgba(30,158,58,0.08)',   border: 'rgba(30,158,58,0.4)' },
    { icon: '🎁', count: bonusAvailCount, status: 'bonus'  as const, label: 'bono 6 meses listo',   color: '#92400E', bg: 'rgba(255,196,0,0.12)',   border: '#D97706' },
  ];

  const filterOpts = [
    { val: 'all'    as const, label: 'Todos' },
    { val: 'near15' as const, label: '🎬 Cerca clase 15' },
    { val: 'near30' as const, label: '🏆 Cerca clase 30' },
    { val: 'near6m' as const, label: '⏳ Cerca del bono' },
    { val: 'bonus'  as const, label: '🎁 Bono disponible' },
  ];

  return (
    <div>
      {/* Alert summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 20 }}>
        {alertCards.map(card => (
          <button key={card.status}
            onClick={() => setStatusFilter(statusFilter === card.status ? 'all' : card.status)}
            style={{
              background: statusFilter === card.status ? card.bg : 'var(--bg-surface)',
              border: `2px solid ${statusFilter === card.status ? card.border : 'var(--border)'}`,
              borderRadius: 12, padding: '16px 20px', cursor: 'pointer',
              textAlign: 'left', fontFamily: "'Radio Canada', sans-serif",
              transition: 'all 0.12s', width: '100%',
            }}>
            <div style={{ fontSize: 24, marginBottom: 6 }}>{card.icon}</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: card.color, marginBottom: 2 }}>{card.count}</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
              alumnos {card.label}
            </div>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 16px', marginBottom: 16, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="🔍 Buscar alumno o profesor..."
          style={{ flex: 1, minWidth: 180, padding: '7px 12px', borderRadius: 8, border: '1.5px solid var(--border)', background: 'var(--bg-surface-2)', color: 'var(--text-primary)', fontSize: 13, fontFamily: "'Radio Canada', sans-serif" }}
        />
        <select
          value={teacherFilter}
          onChange={e => setTeacherFilter(e.target.value)}
          style={{ padding: '7px 12px', borderRadius: 8, border: '1.5px solid var(--border)', background: 'var(--bg-surface-2)', color: 'var(--text-primary)', fontSize: 13, fontFamily: "'Radio Canada', sans-serif" }}>
          <option value="">Todos los profesores</option>
          {uniqueTeachers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {filterOpts.map(opt => (
            <button key={opt.val}
              onClick={() => setStatusFilter(opt.val)}
              style={{ padding: '5px 11px', borderRadius: 8, border: `1px solid ${statusFilter === opt.val ? '#1E9E3A' : 'var(--border)'}`, background: statusFilter === opt.val ? 'rgba(30,158,58,0.1)' : 'transparent', color: statusFilter === opt.val ? '#1E9E3A' : 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, fontWeight: statusFilter === opt.val ? 700 : 400, fontFamily: "'Radio Canada', sans-serif", whiteSpace: 'nowrap' }}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>📋 Seguimiento de alumnos</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{sorted.length} alumno{sorted.length !== 1 ? 's' : ''}</span>
        </div>

        {sorted.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-muted)', fontSize: 13 }}>
            Sin resultados con los filtros actuales.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 820 }}>
              <thead>
                <tr>
                  <th onClick={() => handleSort('name')}    style={{ ...thBase, cursor: 'pointer', userSelect: 'none' }}>Alumno{arrow('name')}</th>
                  <th onClick={() => handleSort('teacher')} style={{ ...thBase, cursor: 'pointer', userSelect: 'none' }}>Profesor{arrow('teacher')}</th>
                  <th onClick={() => handleSort('classNum')} style={{ ...thBase, cursor: 'pointer', userSelect: 'none' }}>Clase actual{arrow('classNum')}</th>
                  <th style={thBase}>Progreso clase 15</th>
                  <th style={thBase}>Progreso clase 30</th>
                  <th onClick={() => handleSort('seniority')} style={{ ...thBase, cursor: 'pointer', userSelect: 'none' }}>Antigüedad{arrow('seniority')}</th>
                  <th style={thBase}>Bono 6 meses</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(d => {
                  const barColor = d.classNum >= 30 ? '#1E9E3A' : d.classNum >= 15 ? '#FFC400' : '#6b7280';
                  return (
                    <tr key={d.a.id} style={{ borderBottom: '1px solid var(--border)' }}>

                      {/* Alumno */}
                      <td style={{ padding: '12px 12px', minWidth: 150 }}>
                        <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>{d.a.studentName}</div>
                        {d.a.slots.length > 0 && (
                          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                            {d.a.slots.map(s => `${s.day} ${s.hour}`).join(' · ')}
                          </div>
                        )}
                      </td>

                      {/* Profesor */}
                      <td style={{ padding: '12px 12px', fontSize: 13, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                        {d.a.teacherName}
                      </td>

                      {/* Clase actual + barra */}
                      <td style={{ padding: '12px 12px', minWidth: 140 }}>
                        <div style={{ fontWeight: 700, fontSize: 14, color: barColor, marginBottom: 5 }}>
                          Clase {d.classNum}
                          {d.classNum >= 30 ? ' 🏆' : d.classNum >= 15 ? ' 🎬' : ''}
                        </div>
                        <div style={{ position: 'relative', height: 6, borderRadius: 3, background: 'var(--bg-surface-3)', overflow: 'visible', minWidth: 100 }}>
                          <div style={{ width: `${Math.min(100, (d.classNum / 30) * 100)}%`, height: '100%', background: barColor, borderRadius: 3 }} />
                          <div style={{ position: 'absolute', left: '50%', top: -1, width: 1.5, height: 8, background: 'rgba(0,0,0,0.25)', transform: 'translateX(-50%)' }} />
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--text-muted)', marginTop: 2, minWidth: 100 }}>
                          <span>1</span><span>15</span><span>30</span>
                        </div>
                      </td>

                      {/* Progreso clase 15 */}
                      <td style={{ padding: '12px 12px', minWidth: 130 }}>
                        {d.class15Reached ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 9px', borderRadius: 12, background: 'rgba(30,158,58,0.1)', border: '1px solid rgba(30,158,58,0.3)', color: '#1E9E3A', fontSize: 11, fontWeight: 700 }}>
                            ✅ Alcanzada
                          </span>
                        ) : (
                          <>
                            <div style={{ fontSize: 12, color: d.toClass15 <= 3 ? '#b8860b' : 'var(--text-secondary)', fontWeight: d.toClass15 <= 3 ? 700 : 400, marginBottom: 4 }}>
                              Faltan {d.toClass15} clases
                            </div>
                            <TrackingMiniBar pct={d.class15Pct} color={d.toClass15 <= 3 ? '#FFC400' : '#6b7280'} />
                          </>
                        )}
                      </td>

                      {/* Progreso clase 30 */}
                      <td style={{ padding: '12px 12px', minWidth: 130 }}>
                        {d.class30Reached ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 9px', borderRadius: 12, background: 'rgba(30,158,58,0.1)', border: '1px solid rgba(30,158,58,0.3)', color: '#1E9E3A', fontSize: 11, fontWeight: 700 }}>
                            ✅ Alcanzada
                          </span>
                        ) : (
                          <>
                            <div style={{ fontSize: 12, color: d.toClass30 <= 3 && d.class15Reached ? '#1E9E3A' : 'var(--text-secondary)', fontWeight: d.toClass30 <= 3 && d.class15Reached ? 700 : 400, marginBottom: 4 }}>
                              Faltan {d.toClass30} clases
                            </div>
                            <TrackingMiniBar pct={d.class30Pct} color={d.toClass30 <= 3 && d.class15Reached ? '#1E9E3A' : '#6b7280'} />
                          </>
                        )}
                      </td>

                      {/* Antigüedad */}
                      <td style={{ padding: '12px 12px', fontSize: 13, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                        {d.totalDays === null
                          ? <span style={{ color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 11 }}>Sin fecha</span>
                          : d.seniorityMonths! > 0
                            ? `${d.seniorityMonths} mes${d.seniorityMonths !== 1 ? 'es' : ''}, ${d.seniorityDays} día${d.seniorityDays !== 1 ? 's' : ''}`
                            : `${d.totalDays} días`
                        }
                      </td>

                      {/* Bono 6 meses */}
                      <td style={{ padding: '12px 12px', minWidth: 140 }}>
                        {d.totalDays === null ? (
                          <span style={{ color: 'var(--text-muted)', fontSize: 11, fontStyle: 'italic' }}>Sin fecha</span>
                        ) : d.bonusAvailable ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 12, background: 'rgba(255,196,0,0.15)', border: '1px solid #D97706', color: '#92400E', fontSize: 11, fontWeight: 700, boxShadow: '0 0 6px rgba(255,196,0,0.2)' }}>
                            🎁 Disponible
                          </span>
                        ) : (
                          <>
                            <div style={{ fontSize: 12, color: d.daysToBonus! <= 15 ? '#b8860b' : 'var(--text-secondary)', fontWeight: d.daysToBonus! <= 15 ? 700 : 400, marginBottom: 4 }}>
                              Faltan {d.daysToBonus} días
                            </div>
                            <TrackingMiniBar pct={d.bonusPct} color={d.daysToBonus! <= 15 ? '#FFC400' : '#6b7280'} />
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Class Log Tab (Registro de clases) ───────────────────────────────────────
const DAY_NAMES_BY_JSDAY_ADMIN = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
function isoDateAdmin(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function minutesLate(scheduledDate: string, scheduledTime: string, clickedAt: string): number {
  const [y, m, d] = scheduledDate.split('-').map(Number);
  const hour = parseInt(scheduledTime);
  const scheduled = new Date(y, (m ?? 1) - 1, d ?? 1, isNaN(hour) ? 0 : hour, 0, 0, 0);
  return (new Date(clickedAt).getTime() - scheduled.getTime()) / 60000;
}

const PUNCT_STYLE: Record<string, { label: string; color: string; bg: string }> = {
  on_time:   { label: '✅ A tiempo',  color: '#1E9E3A', bg: 'rgba(30,158,58,0.1)' },
  late:      { label: '🟡 Tarde',     color: '#b45309', bg: 'rgba(245,158,11,0.12)' },
  very_late: { label: '🟠 Muy tarde', color: '#ea580c', bg: 'rgba(249,115,22,0.12)' },
  missed:    { label: '🔴 No ingresó', color: '#dc2626', bg: 'rgba(239,68,68,0.1)' },
  pending:   { label: '⏳ Pendiente',  color: 'var(--text-muted)', bg: 'var(--bg-surface-3)' },
};

function subscriptionBadge(r: { joinedAt?: string; subscriptionStatus?: string; enteredWithoutActive?: boolean; subscriptionDaysRemaining?: number }):
  { label: string; color: string; bg: string } | null {
  if (!r.joinedAt) return null; // no se registró ingreso (no ingresó)
  if (r.enteredWithoutActive) {
    const days = (r.subscriptionDaysRemaining != null && r.subscriptionDaysRemaining > 0)
      ? ` · ${r.subscriptionDaysRemaining}d`
      : '';
    return { label: `⚠️ Inactiva (ingresó igual)${days}`, color: '#ea580c', bg: 'rgba(249,115,22,0.12)' };
  }
  if (r.subscriptionStatus === 'active') return { label: '✅ Activa', color: '#1E9E3A', bg: 'rgba(30,158,58,0.1)' };
  return { label: '❓ No verificado', color: 'var(--text-muted)', bg: 'var(--bg-surface-3)' };
}

interface LogRow {
  id: string;
  date: string;
  hour: string;
  teacherId: string;
  teacherName: string;
  studentName: string;
  joinedAt?: string;
  status: 'on_time' | 'late' | 'very_late' | 'missed' | 'pending';
  hasLink: boolean;
  subscriptionStatus?: string;
  enteredWithoutActive?: boolean;
  subscriptionDaysRemaining?: number;
}

function ClassLogTab() {
  const { teachers, assignments, classJoinLogs, loadClassJoinLogs } = useTeachers();

  // "Ahora" se calcula SIEMPRE en hora de España (Europe/Madrid), igual que el
  // indicador de hora actual del calendario — no importa dónde esté el admin.
  const nowSpain = getSpainParts(new Date());
  const todayIso = nowSpain.dateStr;
  const nowMinutes = nowSpain.hour * 60 + nowSpain.minute;

  const [sy, sm, sd] = todayIso.split('-').map(Number);
  const spainToday = new Date(sy, (sm ?? 1) - 1, sd ?? 1);
  const defaultFrom = new Date(spainToday); defaultFrom.setDate(spainToday.getDate() - 30);

  const [teacherFilter, setTeacherFilter] = useState<string>('');
  const [fromDate, setFromDate] = useState(isoDateAdmin(defaultFrom));
  const [toDate, setToDate] = useState(todayIso);
  const [statusFilter, setStatusFilter] = useState<'all' | 'on_time' | 'late' | 'missed' | 'pending' | 'no_link' | 'no_sub'>('all');
  const [expandedTeacher, setExpandedTeacher] = useState<string | null>(null);

  useEffect(() => {
    loadClassJoinLogs();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Build all rows: expected recurring class instances over the range + any extra logs.
  const baseRows = useMemo<LogRow[]>(() => {
    const rows: LogRow[] = [];
    const consumedLogs = new Set<string>();

    const relevantAssignments = assignments.filter(a => !teacherFilter || a.teacherId === teacherFilter);

    // Index logs by composite key for fast matching
    const logByKey = new Map<string, ClassJoinLog>();
    for (const log of classJoinLogs) {
      logByKey.set(`${log.teacherId}|${log.studentName}|${log.scheduledDate}|${log.scheduledTime}`, log);
    }

    const start = new Date(fromDate + 'T00:00:00');
    const end   = new Date(toDate + 'T00:00:00');
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return rows;

    // Cap iteration to a reasonable window
    const maxDays = 370;
    for (const a of relevantAssignments) {
      const hasLink = !!a.meetLink;
      const cursor = new Date(start);
      let dayCount = 0;
      while (cursor <= end && dayCount <= maxDays) {
        const dayName = DAY_NAMES_BY_JSDAY_ADMIN[cursor.getDay()];
        for (const slot of a.slots) {
          if (slot.day !== dayName) continue;
          const dateIso = isoDateAdmin(cursor);
          const key = `${a.teacherId}|${a.studentName}|${dateIso}|${slot.hour}`;
          const log = logByKey.get(key);
          if (log) {
            consumedLogs.add(key);
            rows.push({
              id: `${a.id}_${dateIso}_${slot.hour}`,
              date: dateIso, hour: slot.hour,
              teacherId: a.teacherId, teacherName: a.teacherName, studentName: a.studentName,
              joinedAt: log.clickedAt, status: log.punctuality, hasLink,
              subscriptionStatus: log.subscriptionStatus, enteredWithoutActive: log.enteredWithoutActive,
              subscriptionDaysRemaining: log.subscriptionDaysRemaining,
            });
          } else {
            // No hay registro de ingreso para esta clase programada. Decidimos su
            // estado según el reloj de España (todayIso / nowMinutes):
            //  · día anterior            → "No ingresó"
            //  · hoy y su hora ya pasó   → "No ingresó"
            //  · hoy y todavía no llegó  → "Pendiente" (gris)
            //  · fecha futura            → no se incluye en este reporte
            let status: LogRow['status'] | null = null;
            if (dateIso < todayIso) {
              status = 'missed';
            } else if (dateIso === todayIso) {
              const startMinutes = (parseInt(slot.hour) || 0) * 60;
              status = startMinutes < nowMinutes ? 'missed' : 'pending';
            }
            if (status) {
              rows.push({
                id: `${a.id}_${dateIso}_${slot.hour}`,
                date: dateIso, hour: slot.hour,
                teacherId: a.teacherId, teacherName: a.teacherName, studentName: a.studentName,
                status, hasLink,
              });
            }
          }
        }
        cursor.setDate(cursor.getDate() + 1);
        dayCount++;
      }
    }

    // Include logs that didn't match a current assignment slot (e.g. slot changed afterwards)
    for (const log of classJoinLogs) {
      if (teacherFilter && log.teacherId !== teacherFilter) continue;
      if (log.scheduledDate < fromDate || log.scheduledDate > toDate) continue;
      const key = `${log.teacherId}|${log.studentName}|${log.scheduledDate}|${log.scheduledTime}`;
      if (consumedLogs.has(key)) continue;
      const linkedAssignment = assignments.find(a => a.teacherId === log.teacherId && a.studentName === log.studentName);
      rows.push({
        id: log.id,
        date: log.scheduledDate, hour: log.scheduledTime,
        teacherId: log.teacherId, teacherName: log.teacherName, studentName: log.studentName,
        joinedAt: log.clickedAt, status: log.punctuality, hasLink: !!linkedAssignment?.meetLink,
        subscriptionStatus: log.subscriptionStatus, enteredWithoutActive: log.enteredWithoutActive,
        subscriptionDaysRemaining: log.subscriptionDaysRemaining,
      });
    }

    return rows.sort((x, y) => (y.date.localeCompare(x.date)) || (parseInt(y.hour) - parseInt(x.hour)));
  }, [assignments, classJoinLogs, teacherFilter, fromDate, toDate, todayIso, nowMinutes]);

  // Summary metrics — las clases "Pendiente" (hoy, aún sin pasar) no cuentan como
  // registradas ni como perdidas.
  const totalRegistered = baseRows.filter(r => r.status !== 'missed' && r.status !== 'pending').length;
  const onTimeCount     = baseRows.filter(r => r.status === 'on_time').length;
  const missedCount     = baseRows.filter(r => r.status === 'missed').length;
  const punctualityPct  = totalRegistered > 0 ? Math.round((onTimeCount / totalRegistered) * 100) : 0;
  const noLinkCount     = assignments.filter(a => (!teacherFilter || a.teacherId === teacherFilter) && !a.meetLink).length;

  const visibleRows = baseRows.filter(r => {
    if (statusFilter === 'all') return true;
    if (statusFilter === 'on_time') return r.status === 'on_time';
    if (statusFilter === 'late') return r.status === 'late' || r.status === 'very_late';
    if (statusFilter === 'missed') return r.status === 'missed';
    if (statusFilter === 'pending') return r.status === 'pending';
    if (statusFilter === 'no_link') return !r.hasLink;
    if (statusFilter === 'no_sub') return r.enteredWithoutActive === true;
    return true;
  });

  // Per-teacher expandable summary
  function teacherSummary(teacherId: string) {
    const trows = baseRows.filter(r => r.teacherId === teacherId);
    const registered = trows.filter(r => r.status !== 'missed' && r.status !== 'pending');
    const onTime = trows.filter(r => r.status === 'on_time').length;
    const late   = trows.filter(r => r.status === 'late' || r.status === 'very_late').length;
    const missed = trows.filter(r => r.status === 'missed').length;
    const joinLogsForTeacher = classJoinLogs.filter(l =>
      l.teacherId === teacherId && l.scheduledDate >= fromDate && l.scheduledDate <= toDate
    );
    const avgMin = joinLogsForTeacher.length > 0
      ? Math.round(joinLogsForTeacher.reduce((s, l) => s + Math.max(0, minutesLate(l.scheduledDate, l.scheduledTime, l.clickedAt)), 0) / joinLogsForTeacher.length)
      : 0;
    const regTotal = registered.length;
    return {
      total: trows.length,
      onTimePct: regTotal > 0 ? Math.round((onTime / regTotal) * 100) : 0,
      latePct:   regTotal > 0 ? Math.round((late / regTotal) * 100) : 0,
      missed, avgMin,
    };
  }

  const cards = [
    { label: 'Clases registradas', value: totalRegistered, color: '#1E9E3A' },
    { label: 'Puntualidad', value: `${punctualityPct}%`, color: punctualityPct >= 80 ? '#1E9E3A' : punctualityPct >= 60 ? '#f59e0b' : '#ef4444' },
    { label: 'Clases perdidas', value: missedCount, color: missedCount > 0 ? '#ef4444' : '#1E9E3A' },
    { label: 'Sin enlace', value: noLinkCount, color: noLinkCount > 0 ? '#ea580c' : '#1E9E3A' },
  ];

  const statusChips: Array<{ id: typeof statusFilter; label: string }> = [
    { id: 'all', label: 'Todos' },
    { id: 'on_time', label: 'A tiempo' },
    { id: 'late', label: 'Tarde' },
    { id: 'missed', label: 'No ingresó' },
    { id: 'pending', label: 'Pendiente' },
    { id: 'no_link', label: 'Sin enlace' },
    { id: 'no_sub', label: 'Sin suscripción' },
  ];

  return (
    <div>
      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14, marginBottom: 18 }}>
        {cards.map(c => (
          <div key={c.label} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px' }}>
            <div style={{ fontSize: 26, fontWeight: 700, color: c.color }}>{c.value}</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginTop: 3 }}>{c.label}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px', marginBottom: 18 }}>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 14 }}>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 5 }}>Profesor</label>
            <select value={teacherFilter} onChange={e => setTeacherFilter(e.target.value)} style={{ minWidth: 180 }}>
              <option value="">Todos</option>
              {teachers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 5 }}>Desde</label>
            <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 5 }}>Hasta</label>
            <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {statusChips.map(chip => (
            <button key={chip.id} onClick={() => setStatusFilter(chip.id)}
              style={{ padding: '5px 14px', borderRadius: 20, border: `1.5px solid ${statusFilter === chip.id ? '#1E9E3A' : 'var(--border)'}`, background: statusFilter === chip.id ? 'rgba(30,158,58,0.1)' : 'transparent', color: statusFilter === chip.id ? '#1E9E3A' : 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, fontWeight: statusFilter === chip.id ? 700 : 500, fontFamily: 'inherit' }}>
              {chip.label}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        {visibleRows.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: 14 }}>
            Sin registros para los filtros seleccionados.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--bg-surface-2)', textAlign: 'left' }}>
                  {['Fecha', 'Hora', 'Profesor', 'Alumno', 'Hora ingreso', 'Puntualidad', 'Suscripción'].map(h => (
                    <th key={h} style={{ padding: '10px 14px', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map(r => {
                  const ps = PUNCT_STYLE[r.status];
                  return (
                    <tr key={r.id} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
                        {new Date(r.date + 'T00:00:00').toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })}
                      </td>
                      <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', color: 'var(--text-primary)', fontWeight: 600 }}>{r.hour}</td>
                      <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                        <button onClick={() => setExpandedTeacher(prev => prev === r.teacherId ? null : r.teacherId)}
                          style={{ background: 'none', border: 'none', color: '#1E9E3A', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', padding: 0, textAlign: 'left' }}>
                          {r.teacherName}
                        </button>
                      </td>
                      <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', color: 'var(--text-primary)' }}>
                        {r.studentName}
                        {!r.hasLink && <span style={{ marginLeft: 6, fontSize: 10, padding: '1px 6px', borderRadius: 8, background: 'rgba(249,115,22,0.12)', color: '#ea580c', fontWeight: 700 }}>sin enlace</span>}
                      </td>
                      <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                        {r.joinedAt ? new Date(r.joinedAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : '—'}
                      </td>
                      <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                        <span style={{ fontSize: 11, padding: '2px 9px', borderRadius: 12, background: ps.bg, color: ps.color, fontWeight: 700 }}>{ps.label}</span>
                      </td>
                      <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                        {(() => {
                          const sb = subscriptionBadge(r);
                          return sb
                            ? <span style={{ fontSize: 11, padding: '2px 9px', borderRadius: 12, background: sb.bg, color: sb.color, fontWeight: 700 }}>{sb.label}</span>
                            : <span style={{ color: 'var(--text-muted)' }}>—</span>;
                        })()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Expanded teacher summary */}
      {expandedTeacher && (() => {
        const t = teachers.find(x => x.id === expandedTeacher);
        const s = teacherSummary(expandedTeacher);
        return (
          <div style={{ background: 'var(--bg-surface)', border: '1px solid rgba(30,158,58,0.3)', borderRadius: 12, padding: '18px 20px', marginTop: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>Resumen de {t?.name ?? 'profesor'}</div>
              <button onClick={() => setExpandedTeacher(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12 }}>
              {[
                { label: 'Total clases', value: s.total, color: 'var(--text-primary)' },
                { label: '% a tiempo', value: `${s.onTimePct}%`, color: '#1E9E3A' },
                { label: '% tarde', value: `${s.latePct}%`, color: '#b45309' },
                { label: 'No ingresadas', value: s.missed, color: s.missed > 0 ? '#ef4444' : '#1E9E3A' },
                { label: 'Atraso promedio', value: `${s.avgMin} min`, color: 'var(--text-primary)' },
              ].map(m => (
                <div key={m.label} style={{ background: 'var(--bg-surface-2)', borderRadius: 10, padding: '12px 14px' }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color: m.color }}>{m.value}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{m.label}</div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ─── Audit Panel (Auditoría de vínculos) ──────────────────────────────────────
const AUDIT_REVIEWED_KEY = 'drc_audit_reviewed_multi';

function loadReviewed(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(AUDIT_REVIEWED_KEY) || '[]')); }
  catch { return new Set(); }
}
function saveReviewed(set: Set<string>) {
  try { localStorage.setItem(AUDIT_REVIEWED_KEY, JSON.stringify([...set])); } catch { /* noop */ }
}

const auditCard = { background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px' };
const auditSectionTitle = (color: string) => ({ fontSize: 13, fontWeight: 700, color, marginBottom: 10 });
const auditBtn = (color: string, bg: string, border: string) => ({
  padding: '5px 11px', borderRadius: 7, border: `1px solid ${border}`, background: bg,
  color, cursor: 'pointer', fontSize: 11, fontWeight: 700, fontFamily: 'inherit', whiteSpace: 'nowrap' as const,
});

// ─── Panel de sincronización calendario ↔ assignments/students ────────────────
function SyncPanel() {
  const { teachers, students, reloadAll } = useTeachers();
  const [open, setOpen] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [rows, setRows] = useState<CalendarDiagnosisAllRow[] | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [modalRow, setModalRow] = useState<CalendarDiagnosisAllRow | null>(null);

  const rowKey = (r: CalendarDiagnosisAllRow) => `${r.teacherId}|${r.studentNameInGrid.trim().toLowerCase()}`;

  async function runAnalyze() {
    setAnalyzing(true);
    setMsg(null);
    try { setRows(await dbDiagnoseAllCalendars()); }
    finally { setAnalyzing(false); }
  }

  async function syncAllAuto() {
    setSyncing(true);
    setMsg(null);
    try {
      const { autoFixed, pendingManual } = await dbSyncAllCalendarsToAssignments();
      await reloadAll();
      await runAnalyze();
      setMsg(`✅ ${autoFixed} assignment${autoFixed !== 1 ? 's' : ''} creada${autoFixed !== 1 ? 's' : ''} automáticamente${pendingManual.length > 0 ? ` · ⚠️ ${pendingManual.length} requiere${pendingManual.length !== 1 ? 'n' : ''} datos manuales` : ''}`);
    } finally {
      setSyncing(false);
    }
  }

  // Alumno YA existe en students pero falta la assignment → crear automáticamente.
  async function crearAssignmentAuto(r: CalendarDiagnosisAllRow) {
    const t = teachers.find(x => x.id === r.teacherId);
    if (!t) return;
    const nk = r.studentNameInGrid.trim().toLowerCase();
    const stu = students.find(s => s.id === r.studentId) ?? students.find(s => s.name.trim().toLowerCase() === nk);
    if (!stu) return;
    setBusyKey(rowKey(r));
    try {
      await dbCreateFullLink({
        teacherId: t.id, teacherName: t.name, teacherEmail: t.email,
        name: stu.name, email: stu.email, level: stu.level, plan: stu.plan || 'Inglés general',
        weeklyHours: r.slots.length, slots: r.slots,
      });
      await reloadAll();
      await runAnalyze();
      setMsg(`✅ ${stu.name} vinculado correctamente con ${t.name}`);
    } finally {
      setBusyKey(null);
    }
  }

  async function handleModalDone(text: string) {
    setModalRow(null);
    await reloadAll();
    await runAnalyze();
    setMsg(text);
  }

  const problemCount = rows?.filter(r => !(r.existsInAssignments && r.existsInStudents)).length ?? 0;

  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginTop: 16 }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>🔄 Sincronización calendario ↔ asignaciones</span>
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ padding: '0 18px 18px', borderTop: '1px solid var(--border)' }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: '12px 0 14px', lineHeight: 1.5 }}>
            Detecta alumnos que aparecen en el calendario de un profesor (celda "ocupado") pero no tienen assignment ni registro en la tabla de alumnos.
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
            <button onClick={runAnalyze} disabled={analyzing}
              style={{ padding: '9px 16px', borderRadius: 8, border: 'none', background: '#1E9E3A', color: 'white', cursor: analyzing ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
              {analyzing ? 'Analizando...' : '🔍 Analizar desconexiones'}
            </button>
            <button onClick={syncAllAuto} disabled={syncing}
              style={{ padding: '9px 16px', borderRadius: 8, border: 'none', background: '#FFC400', color: '#1a1a1a', cursor: syncing ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
              {syncing ? 'Sincronizando...' : '⚡ Sincronizar todos automáticamente'}
            </button>
          </div>

          {msg && <div style={{ margin: '0 0 14px', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{msg}</div>}

          {rows && (
            rows.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '10px 0' }}>No hay alumnos en los calendarios.</div>
            ) : (
              <>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
                  {rows.length} alumno{rows.length !== 1 ? 's' : ''} en calendarios · {problemCount > 0 ? <b style={{ color: '#ea580c' }}>{problemCount} desconexión{problemCount !== 1 ? 'es' : ''}</b> : <b style={{ color: '#1E9E3A' }}>todo sincronizado</b>}
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                    <thead>
                      <tr style={{ textAlign: 'left', color: 'var(--text-muted)' }}>
                        <th style={{ padding: '6px 10px', fontWeight: 700 }}>Profesor</th>
                        <th style={{ padding: '6px 10px', fontWeight: 700 }}>Alumno en grid</th>
                        <th style={{ padding: '6px 10px', fontWeight: 700, whiteSpace: 'nowrap' }}>En assignments</th>
                        <th style={{ padding: '6px 10px', fontWeight: 700, whiteSpace: 'nowrap' }}>En students</th>
                        <th style={{ padding: '6px 10px', fontWeight: 700 }}>Acción</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(r => {
                        const ok = r.existsInAssignments && r.existsInStudents;
                        const onlyStudent = r.existsInStudents && !r.existsInAssignments;
                        const busy = busyKey === rowKey(r);
                        return (
                          <tr key={rowKey(r)} style={{ borderTop: '1px solid var(--border)', background: ok ? 'transparent' : 'rgba(234,88,12,0.05)' }}>
                            <td style={{ padding: '8px 10px', color: 'var(--text-primary)', fontWeight: 600 }}>{r.teacherName}</td>
                            <td style={{ padding: '8px 10px', color: 'var(--text-primary)' }}>
                              {r.studentNameInGrid}
                              <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{r.slots.map(s => `${s.day} ${s.hour}`).join(' · ')}</div>
                            </td>
                            <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{r.existsInAssignments ? '✅ Sí' : '❌ No'}</td>
                            <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{r.existsInStudents ? '✅ Sí' : '❌ No'}</td>
                            <td style={{ padding: '8px 10px' }}>
                              {ok ? (
                                <span style={{ color: '#1E9E3A', fontWeight: 700 }}>✅ OK</span>
                              ) : onlyStudent ? (
                                <button onClick={() => crearAssignmentAuto(r)} disabled={busy}
                                  style={{ padding: '5px 12px', borderRadius: 7, border: 'none', background: busy ? 'var(--bg-surface-3)' : '#1E9E3A', color: busy ? 'var(--text-muted)' : 'white', cursor: busy ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 700, fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                                  {busy ? '...' : 'Crear assignment'}
                                </button>
                              ) : (
                                <button onClick={() => setModalRow(r)}
                                  style={{ padding: '5px 12px', borderRadius: 7, border: 'none', background: '#FFC400', color: '#1a1a1a', cursor: 'pointer', fontSize: 12, fontWeight: 700, fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                                  Crear todo
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )
          )}
        </div>
      )}

      {modalRow && (() => {
        const t = teachers.find(x => x.id === modalRow.teacherId);
        if (!t) return null;
        return (
          <CrearVinculoModal
            studentName={modalRow.studentNameInGrid}
            teacher={t}
            slots={modalRow.slots as AssignedSlot[]}
            onClose={() => setModalRow(null)}
            onDone={handleModalDone}
          />
        );
      })()}
    </div>
  );
}

// Sincronización masiva de planes con WooCommerce. Recorre TODOS los alumnos en
// lotes de 5 (delay 500ms entre lotes) para no sobrecargar la API de WooCommerce
// ni exceder timeouts serverless, mostrando progreso real.
function PlanSyncPanel() {
  const { students, reloadAll } = useTeachers();
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ updated: number; unchanged: number; notFound: number } | null>(null);

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  async function run() {
    setConfirming(false);
    setRunning(true);
    setResult(null);
    const withEmail = students.filter(s => s.email?.trim());
    setProgress({ done: 0, total: withEmail.length });
    let updated = 0, unchanged = 0, notFound = 0;
    try {
      for (let i = 0; i < withEmail.length; i += 5) {
        const batch = withEmail.slice(i, i + 5).map(s => ({ id: s.id, email: s.email, plan: s.plan, level: s.level }));
        try {
          const res = await fetch('/api/admin/sync-student-plans', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ students: batch }),
          });
          const data = await res.json();
          updated   += data.updated   ?? 0;
          unchanged += data.unchanged ?? 0;
          notFound  += data.notFound  ?? 0;
        } catch {
          notFound += batch.length;
        }
        setProgress({ done: Math.min(i + 5, withEmail.length), total: withEmail.length });
        if (i + 5 < withEmail.length) await sleep(500);
      }
      setResult({ updated, unchanged, notFound });
      await reloadAll();
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px', marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>🔄 Sincronizar planes con WooCommerce</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 3, lineHeight: 1.5 }}>
            Actualiza el plan de todos los alumnos con el producto real de WooCommerce. Puede tardar varios minutos.
          </div>
        </div>
        <button onClick={() => setConfirming(true)} disabled={running}
          style={{ padding: '9px 16px', borderRadius: 8, border: 'none', background: running ? 'var(--bg-surface-3)' : '#FFC400', color: running ? 'var(--text-muted)' : '#1a1a1a', cursor: running ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
          {running ? 'Sincronizando...' : 'Sincronizar planes'}
        </button>
      </div>

      {progress && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 6 }}>
            Sincronizando... {progress.done}/{progress.total} alumnos
          </div>
          <div style={{ height: 8, borderRadius: 5, background: 'var(--bg-surface-3)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`, background: '#1E9E3A', transition: 'width 0.2s' }} />
          </div>
        </div>
      )}

      {result && (
        <div style={{ marginTop: 14, fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
          ✅ {result.updated} plan{result.updated !== 1 ? 'es' : ''} actualizado{result.updated !== 1 ? 's' : ''} · {result.unchanged} sin cambios · {result.notFound} no encontrado{result.notFound !== 1 ? 's' : ''} en WooCommerce
        </div>
      )}

      {confirming && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)', zIndex: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 24, width: '100%', maxWidth: 420 }}>
            <div style={{ fontSize: 24, marginBottom: 10 }}>⚠️</div>
            <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 8 }}>Sincronizar planes</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20, lineHeight: 1.6 }}>
              Esto actualizará el plan de todos los alumnos con los datos reales de WooCommerce. ¿Continuar?
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setConfirming(false)}
                style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
                Cancelar
              </button>
              <button onClick={run}
                style={{ flex: 1, padding: '10px', borderRadius: 8, border: 'none', background: '#1E9E3A', color: 'white', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
                Sí, continuar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Sincronización de la fecha de inicio (start_date) de las asignaciones con la
// fecha real de suscripción/compra en WooCommerce. Recorre las asignaciones en
// lotes de 5 (delay 500ms) llamando a /api/admin/sync-start-dates. El botón
// combinado corre además la sincronización de planes en la misma pasada.
const sleepMs = (ms: number) => new Promise(r => setTimeout(r, ms));

type DateSyncResult = { updated: number; notFound: number; errors: number; total: number };
type PlanSyncResult = { updated: number; unchanged: number; notFound: number };

function StartDateSyncPanel() {
  const { assignments, students, reloadAll } = useTeachers();
  const [choosing, setChoosing] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [dateResult, setDateResult] = useState<DateSyncResult | null>(null);
  const [planResult, setPlanResult] = useState<PlanSyncResult | null>(null);

  // Sincroniza start_date de las asignaciones. mode 'empty' → solo las que no
  // tienen fecha; mode 'all' (force) → todas las asignaciones con email.
  async function runDateSync(mode: 'empty' | 'all', labelPrefix = ''): Promise<DateSyncResult> {
    const candidates = assignments.filter(a => a.studentEmail?.trim() && (mode === 'all' || !a.startDate));
    const acc: DateSyncResult = { updated: 0, notFound: 0, errors: 0, total: candidates.length };
    setProgress({ done: 0, total: candidates.length, label: `${labelPrefix}Fechas` });
    for (let i = 0; i < candidates.length; i += 5) {
      const batch = candidates.slice(i, i + 5).map(a => ({ id: a.id, email: a.studentEmail }));
      try {
        const res = await fetch('/api/admin/sync-start-dates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assignments: batch }),
        });
        const data = await res.json();
        acc.updated  += data.updated  ?? 0;
        acc.notFound += data.notFound ?? 0;
        acc.errors   += data.errors   ?? 0;
      } catch {
        acc.errors += batch.length;
      }
      setProgress({ done: Math.min(i + 5, candidates.length), total: candidates.length, label: `${labelPrefix}Fechas` });
      if (i + 5 < candidates.length) await sleepMs(500);
    }
    return acc;
  }

  async function runPlanSync(labelPrefix = ''): Promise<PlanSyncResult> {
    const withEmail = students.filter(s => s.email?.trim());
    const acc: PlanSyncResult = { updated: 0, unchanged: 0, notFound: 0 };
    setProgress({ done: 0, total: withEmail.length, label: `${labelPrefix}Planes` });
    for (let i = 0; i < withEmail.length; i += 5) {
      const batch = withEmail.slice(i, i + 5).map(s => ({ id: s.id, email: s.email, plan: s.plan, level: s.level }));
      try {
        const res = await fetch('/api/admin/sync-student-plans', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ students: batch }),
        });
        const data = await res.json();
        acc.updated   += data.updated   ?? 0;
        acc.unchanged += data.unchanged ?? 0;
        acc.notFound  += data.notFound  ?? 0;
      } catch {
        acc.notFound += batch.length;
      }
      setProgress({ done: Math.min(i + 5, withEmail.length), total: withEmail.length, label: `${labelPrefix}Planes` });
      if (i + 5 < withEmail.length) await sleepMs(500);
    }
    return acc;
  }

  async function startDateSync(mode: 'empty' | 'all') {
    setChoosing(false);
    setRunning(true);
    setDateResult(null);
    setPlanResult(null);
    try {
      const r = await runDateSync(mode);
      setDateResult(r);
      await reloadAll();
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  async function startCombinedSync() {
    setRunning(true);
    setDateResult(null);
    setPlanResult(null);
    try {
      const p = await runPlanSync('1/2 · ');
      setPlanResult(p);
      const d = await runDateSync('empty', '2/2 · ');
      setDateResult(d);
      await reloadAll();
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  const noDateCount = assignments.filter(a => a.studentEmail?.trim() && !a.startDate).length;

  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px', marginTop: 16 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>🔄 Sincronización con WooCommerce</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 3, lineHeight: 1.5 }}>
        Trae la fecha real de inicio de suscripción de cada alumno. {noDateCount > 0 ? `${noDateCount} asignación${noDateCount !== 1 ? 'es' : ''} sin fecha.` : 'Todas las asignaciones tienen fecha.'}
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
        <button onClick={() => setChoosing(true)} disabled={running}
          style={{ padding: '9px 16px', borderRadius: 8, border: 'none', background: running ? 'var(--bg-surface-3)' : '#FFC400', color: running ? 'var(--text-muted)' : '#1a1a1a', cursor: running ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
          📅 Sincronizar fechas de inicio
        </button>
        <button onClick={startCombinedSync} disabled={running}
          style={{ padding: '9px 16px', borderRadius: 8, border: '1px solid var(--border)', background: running ? 'var(--bg-surface-3)' : 'var(--bg-surface-2)', color: running ? 'var(--text-muted)' : 'var(--text-primary)', cursor: running ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
          🔄 Sincronizar planes y fechas
        </button>
      </div>

      {progress && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 6 }}>
            {progress.label} · Procesando... {progress.done}/{progress.total} alumnos
          </div>
          <div style={{ height: 8, borderRadius: 5, background: 'var(--bg-surface-3)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`, background: '#1E9E3A', transition: 'width 0.2s' }} />
          </div>
        </div>
      )}

      {(dateResult || planResult) && !running && (
        <div style={{ marginTop: 14, fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.7 }}>
          {planResult && (
            <div>🗂️ Planes: ✅ {planResult.updated} actualizado{planResult.updated !== 1 ? 's' : ''} · {planResult.unchanged} sin cambios · {planResult.notFound} no encontrado{planResult.notFound !== 1 ? 's' : ''}</div>
          )}
          {dateResult && (<>
            <div>✅ {dateResult.updated} fecha{dateResult.updated !== 1 ? 's' : ''} actualizada{dateResult.updated !== 1 ? 's' : ''}</div>
            <div>❓ {dateResult.notFound} alumno{dateResult.notFound !== 1 ? 's' : ''} no encontrado{dateResult.notFound !== 1 ? 's' : ''} en WooCommerce</div>
            <div>⚠️ {dateResult.errors} error{dateResult.errors !== 1 ? 'es' : ''}</div>
          </>)}
        </div>
      )}

      {choosing && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)', zIndex: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 24, width: '100%', maxWidth: 440 }}>
            <div style={{ fontSize: 24, marginBottom: 10 }}>📅</div>
            <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 8 }}>Sincronizar fechas de inicio</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20, lineHeight: 1.6 }}>
              Elegí qué asignaciones actualizar con la fecha real de WooCommerce.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button onClick={() => startDateSync('empty')}
                style={{ padding: '12px 14px', borderRadius: 9, border: '1px solid rgba(30,158,58,0.4)', background: 'rgba(30,158,58,0.08)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 13.5, fontWeight: 700, fontFamily: 'inherit', textAlign: 'left' }}>
                Solo alumnos sin fecha <span style={{ color: '#1E9E3A' }}>(recomendado, más rápido)</span>
                <div style={{ fontWeight: 500, fontSize: 12, color: 'var(--text-secondary)', marginTop: 3 }}>{noDateCount} asignación{noDateCount !== 1 ? 'es' : ''}</div>
              </button>
              <button onClick={() => startDateSync('all')}
                style={{ padding: '12px 14px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--bg-surface-2)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 13.5, fontWeight: 700, fontFamily: 'inherit', textAlign: 'left' }}>
                Todos los alumnos
                <div style={{ fontWeight: 500, fontSize: 12, color: 'var(--text-secondary)', marginTop: 3 }}>Puede tardar varios minutos · reescribe fechas existentes</div>
              </button>
            </div>
            <button onClick={() => setChoosing(false)}
              style={{ width: '100%', marginTop: 14, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AuditPanel() {
  const { students, reloadAll } = useTeachers();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AuditResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const [relinkFor, setRelinkFor] = useState<AuditResult['orphanAssignments'][number] | null>(null);
  const [relinkSearch, setRelinkSearch] = useState('');
  const [mergeFor, setMergeFor] = useState<AuditResult['duplicateEmails'][number] | null>(null);
  const [mergeKeepId, setMergeKeepId] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  useEffect(() => { setReviewed(loadReviewed()); }, []);

  async function runAudit() {
    setRunning(true);
    try { setResult(await dbAuditStudentAssignments()); }
    finally { setRunning(false); }
  }

  async function runSync() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const fixed = await dbSyncStudentAssignments();
      await reloadAll();
      setSyncMsg(fixed > 0 ? `✅ ${fixed} vínculo${fixed === 1 ? '' : 's'} corregido${fixed === 1 ? '' : 's'}` : '✅ Todo sincronizado — no había vínculos rotos');
    } catch {
      setSyncMsg('⚠️ No se pudo sincronizar. Reintentá.');
    } finally {
      setSyncing(false);
    }
  }

  async function withBusy(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try { await fn(); await reloadAll(); await runAudit(); }
    finally { setBusy(null); }
  }

  function toggleReviewed(key: string) {
    setReviewed(prev => {
      const n = new Set(prev);
      n.has(key) ? n.delete(key) : n.add(key);
      saveReviewed(n);
      return n;
    });
  }

  function exportCsv() {
    if (!result) return;
    const rows: string[] = ['Tipo,Detalle 1,Detalle 2,Detalle 3'];
    const q = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    for (const a of result.studentsWithoutAssignment) rows.push(['A - Sin profesor', q(a.name), q(a.email), ''].join(','));
    for (const b of result.orphanAssignments) rows.push(['B - Asignacion sin alumno', q(b.studentName), q(b.studentEmail), q(b.teacherName)].join(','));
    for (const c of result.nameMismatches) rows.push(['C - Nombre inconsistente', q(c.nameStudents), q(c.nameAssignments), q(c.teacherName)].join(','));
    for (const d of result.duplicateEmails) rows.push(['D - Email duplicado', q(d.email), q(d.names), q(d.total)].join(','));
    for (const e of result.multipleAssignments) rows.push(['E - Multiples asignaciones', q(e.studentName), q(e.teachers), q(e.total)].join(','));
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `auditoria_vinculos_${new Date().toISOString().slice(0, 10)}.csv`; link.click();
    URL.revokeObjectURL(url);
  }

  const visibleMultiples = result?.multipleAssignments.filter(m => !reviewed.has(`${m.studentId}|${m.studentName}`)) ?? [];
  const allClean = result &&
    result.studentsWithoutAssignment.length === 0 &&
    result.orphanAssignments.length === 0 &&
    result.nameMismatches.length === 0 &&
    result.duplicateEmails.length === 0 &&
    visibleMultiples.length === 0;

  const relinkStudents = students.filter(s => {
    const q = relinkSearch.trim().toLowerCase();
    if (!q) return true;
    return s.name.toLowerCase().includes(q) || s.email.toLowerCase().includes(q);
  }).slice(0, 30);

  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginTop: 16 }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>🔍 Auditoría de vínculos</span>
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ padding: '0 18px 18px', borderTop: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '14px 0 16px' }}>
            <button onClick={runAudit} disabled={running}
              style={{ padding: '9px 16px', borderRadius: 8, border: 'none', background: '#1E9E3A', color: 'white', cursor: running ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
              {running ? 'Ejecutando...' : '▶ Ejecutar auditoría'}
            </button>
            <button onClick={runSync} disabled={syncing}
              style={{ padding: '9px 16px', borderRadius: 8, border: 'none', background: '#FFC400', color: '#1a1a1a', cursor: syncing ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
              {syncing ? 'Sincronizando...' : '🔄 Sincronizar vínculos'}
            </button>
            {result && (
              <button onClick={exportCsv}
                style={{ padding: '9px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-surface-2)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>
                ⬇ Exportar reporte
              </button>
            )}
          </div>
          {syncMsg && (
            <div style={{ margin: '-6px 0 14px', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{syncMsg}</div>
          )}

          {!result ? (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '8px 0' }}>Ejecutá la auditoría para detectar inconsistencias entre alumnos y asignaciones.</div>
          ) : allClean ? (
            <div style={{ padding: '24px', textAlign: 'center', color: '#1E9E3A', fontSize: 15, fontWeight: 700, background: 'rgba(30,158,58,0.08)', borderRadius: 10 }}>
              ✅ Todo en orden — No se encontraron inconsistencias
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* A */}
              {result.studentsWithoutAssignment.length > 0 && (
                <div style={auditCard}>
                  <div style={auditSectionTitle('#ea580c')}>A · Alumnos sin profesor asignado ({result.studentsWithoutAssignment.length})</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    {result.studentsWithoutAssignment.map(s => (
                      <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, fontSize: 12.5, flexWrap: 'wrap' }}>
                        <span><b style={{ color: 'var(--text-primary)' }}>{s.name}</b> <span style={{ color: 'var(--text-muted)' }}>· {s.email || '—'}</span></span>
                        <button onClick={() => router.push('/setter')} style={auditBtn('#1E9E3A', 'rgba(30,158,58,0.08)', 'rgba(30,158,58,0.4)')}>Asignar profesor →</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* B */}
              {result.orphanAssignments.length > 0 && (
                <div style={auditCard}>
                  <div style={auditSectionTitle('#dc2626')}>B · Asignaciones sin alumno válido ({result.orphanAssignments.length})</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    {result.orphanAssignments.map(b => (
                      <div key={b.assignmentId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, fontSize: 12.5, flexWrap: 'wrap' }}>
                        <span><b style={{ color: 'var(--text-primary)' }}>{b.studentName}</b> <span style={{ color: 'var(--text-muted)' }}>· {b.studentEmail || 'sin email'} · 👨‍🏫 {b.teacherName}</span></span>
                        <button onClick={() => { setRelinkFor(b); setRelinkSearch(b.studentName); }} style={auditBtn('#2563eb', 'rgba(37,99,235,0.08)', 'rgba(37,99,235,0.4)')}>Vincular alumno</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* C */}
              {result.nameMismatches.length > 0 && (
                <div style={auditCard}>
                  <div style={auditSectionTitle('#b45309')}>C · Nombres inconsistentes ({result.nameMismatches.length})</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    {result.nameMismatches.map(c => (
                      <div key={c.assignmentId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, fontSize: 12.5, flexWrap: 'wrap' }}>
                        <span style={{ color: 'var(--text-secondary)' }}>En alumnos: <b style={{ color: 'var(--text-primary)' }}>{c.nameStudents}</b> · En asignación: <b style={{ color: '#b45309' }}>{c.nameAssignments}</b></span>
                        <button disabled={busy === c.assignmentId} onClick={() => withBusy(c.assignmentId, () => dbSyncAssignmentName(c.assignmentId, c.nameStudents))} style={auditBtn('#1E9E3A', 'rgba(30,158,58,0.08)', 'rgba(30,158,58,0.4)')}>
                          {busy === c.assignmentId ? '...' : 'Sincronizar nombre'}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* D */}
              {result.duplicateEmails.length > 0 && (
                <div style={auditCard}>
                  <div style={auditSectionTitle('#7c3aed')}>D · Alumnos duplicados ({result.duplicateEmails.length})</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    {result.duplicateEmails.map(d => (
                      <div key={d.email} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, fontSize: 12.5, flexWrap: 'wrap' }}>
                        <span><b style={{ color: 'var(--text-primary)' }}>{d.email}</b> <span style={{ color: 'var(--text-muted)' }}>· {d.names}</span></span>
                        <button onClick={() => { setMergeFor(d); setMergeKeepId(d.students.find(s => s.hasAssignment)?.id ?? d.students[0].id); }} style={auditBtn('#7c3aed', 'rgba(124,58,237,0.08)', 'rgba(124,58,237,0.4)')}>Fusionar</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* E */}
              {visibleMultiples.length > 0 && (
                <div style={auditCard}>
                  <div style={auditSectionTitle('#2563eb')}>E · Múltiples asignaciones ({visibleMultiples.length})</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 10, fontStyle: 'italic' }}>
                    Algunos alumnos pueden tener clases con más de un profesor (es válido). Revisá si es intencional.
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    {visibleMultiples.map(m => (
                      <div key={`${m.studentId}|${m.studentName}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, fontSize: 12.5, flexWrap: 'wrap' }}>
                        <span><b style={{ color: 'var(--text-primary)' }}>{m.studentName}</b> <span style={{ color: 'var(--text-muted)' }}>· {m.total} profesores: {m.teachers}</span></span>
                        <button onClick={() => toggleReviewed(`${m.studentId}|${m.studentName}`)} style={auditBtn('var(--text-secondary)', 'transparent', 'var(--border)')}>Marcar como revisado</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Modal: Vincular alumno (B) */}
      {relinkFor && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget) setRelinkFor(null); }}>
          <div style={{ background: '#F7F7F5', border: '1px solid var(--border)', borderRadius: 16, width: '100%', maxWidth: 460, padding: 24, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: '#111827', marginBottom: 4 }}>Vincular alumno</div>
            <div style={{ fontSize: 12.5, color: '#6b7280', marginBottom: 14 }}>Asignación de <b>{relinkFor.studentName}</b> ({relinkFor.teacherName}). Elegí el alumno real:</div>
            <input value={relinkSearch} onChange={e => setRelinkSearch(e.target.value)} placeholder="Buscar por nombre o email..."
              style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1.5px solid var(--border)', fontSize: 13, background: 'white', color: '#111827', fontFamily: 'inherit', boxSizing: 'border-box', marginBottom: 12 }} />
            <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {relinkStudents.map(s => (
                <button key={s.id} disabled={busy === relinkFor.assignmentId}
                  onClick={() => withBusy(relinkFor.assignmentId, async () => { await dbRelinkAssignment(relinkFor.assignmentId, { id: s.id, name: s.name, email: s.email, level: s.level }); setRelinkFor(null); })}
                  style={{ textAlign: 'left', padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'white', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
                  <b style={{ color: '#111827' }}>{s.name}</b> <span style={{ color: '#6b7280' }}>· {s.email || '—'} · {s.level}</span>
                </button>
              ))}
              {relinkStudents.length === 0 && <div style={{ fontSize: 12, color: '#9ca3af', padding: 8 }}>Sin resultados.</div>}
            </div>
            <button onClick={() => setRelinkFor(null)} style={{ marginTop: 12, padding: '9px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: '#6b7280', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>Cancelar</button>
          </div>
        </div>
      )}

      {/* Modal: Fusionar duplicados (D) */}
      {mergeFor && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget) setMergeFor(null); }}>
          <div style={{ background: '#F7F7F5', border: '1px solid var(--border)', borderRadius: 16, width: '100%', maxWidth: 440, padding: 24 }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: '#111827', marginBottom: 4 }}>Fusionar alumnos duplicados</div>
            <div style={{ fontSize: 12.5, color: '#6b7280', marginBottom: 14 }}>Email <b>{mergeFor.email}</b>. Elegí cuál conservar — las asignaciones del resto se reapuntarán y los duplicados se eliminarán.</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
              {mergeFor.students.map(s => (
                <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 8, border: `1.5px solid ${mergeKeepId === s.id ? '#1E9E3A' : 'var(--border)'}`, background: mergeKeepId === s.id ? 'rgba(30,158,58,0.06)' : 'white', cursor: 'pointer' }}>
                  <input type="radio" checked={mergeKeepId === s.id} onChange={() => setMergeKeepId(s.id)} />
                  <span style={{ fontSize: 13, color: '#111827' }}><b>{s.name}</b>{s.hasAssignment && <span style={{ color: '#1E9E3A', fontWeight: 700 }}> · con asignación</span>}</span>
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setMergeFor(null)} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: '#6b7280', cursor: 'pointer', fontSize: 14, fontFamily: 'inherit' }}>Cancelar</button>
              <button disabled={busy === 'merge'} onClick={() => withBusy('merge', async () => {
                const removeIds = mergeFor.students.filter(s => s.id !== mergeKeepId).map(s => s.id);
                for (const rid of removeIds) await dbMergeDuplicateStudents(mergeKeepId, rid);
                setMergeFor(null);
              })} style={{ flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: '#1E9E3A', color: 'white', cursor: 'pointer', fontSize: 14, fontWeight: 700, fontFamily: 'inherit' }}>
                {busy === 'merge' ? 'Fusionando...' : 'Fusionar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Alerta de alumnos con múltiples profesores (punto 4) ─────────────────────
const DUP_REVIEWED_KEY = 'dup_teachers_reviewed';

function DuplicatesBanner() {
  const { assignments, teachers, removeAssignment } = useTeachers();
  const [open, setOpen] = useState(false);
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [changeFor, setChangeFor] = useState<{ group: DuplicateAssignmentGroup } | null>(null);

  // Marcados como "revisado" (localStorage) para no volver a alertar.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DUP_REVIEWED_KEY);
      if (raw) setReviewed(new Set(JSON.parse(raw)));
    } catch {}
  }, []);

  const allDuplicates = useMemo(() => findDuplicateTeacherAssignments(assignments), [assignments]);
  const duplicates = allDuplicates.filter(d => !reviewed.has(d.key));

  function markReviewed(key: string) {
    setReviewed(prev => {
      const next = new Set(prev).add(key);
      try { localStorage.setItem(DUP_REVIEWED_KEY, JSON.stringify([...next])); } catch {}
      return next;
    });
  }

  // "Mantener solo con [teacher]": elimina las demás assignments del alumno.
  async function keepOnly(group: DuplicateAssignmentGroup, keepAssignmentId: string) {
    setBusy(true);
    try {
      for (const a of group.assignments) {
        if (a.assignmentId === keepAssignmentId) continue;
        await removeAssignment(a.assignmentId, a.teacherId, group.studentName, a.slots);
      }
    } finally {
      setBusy(false);
    }
  }

  if (duplicates.length === 0) return null;

  const changeGroupAssignment = changeFor
    ? assignments.find(a => a.id === changeFor.group.assignments[0].assignmentId)
    : null;

  return (
    <>
      <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.4)', borderRadius: 12, padding: '14px 18px', marginBottom: 18, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220, fontSize: 13.5, color: '#dc2626', fontWeight: 600, lineHeight: 1.5 }}>
          ⚠️ {duplicates.length} alumno{duplicates.length !== 1 ? 's' : ''} asignado{duplicates.length !== 1 ? 's' : ''} a múltiples profesores — esto puede causar errores en finanzas y calendarios.
        </div>
        <button onClick={() => setOpen(true)}
          style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#dc2626', color: 'white', fontWeight: 700, fontSize: 13, cursor: 'pointer', flexShrink: 0 }}>
          Ver y resolver →
        </button>
      </div>

      {open && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)', zIndex: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget && !busy) setOpen(false); }}>
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 18, width: '100%', maxWidth: 620, maxHeight: '92vh', overflowY: 'auto', padding: 26 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 18, color: 'var(--text-primary)' }}>⚠️ Alumnos con múltiples profesores</div>
                <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 3 }}>Resolvé cada caso para evitar errores en finanzas y calendarios.</div>
              </div>
              <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 22, cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {duplicates.map(group => (
                <div key={group.key} style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                    <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'rgba(30,158,58,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#1E9E3A', flexShrink: 0 }}>
                      {group.studentName.split(' ').map(p => p[0]).join('').toUpperCase().slice(0, 2)}
                    </div>
                    <div style={{ fontWeight: 700, fontSize: 14.5, color: 'var(--text-primary)' }}>{group.studentName}</div>
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.6 }}>
                    Asignada a: {group.assignments.map((a, i) => (
                      <span key={a.assignmentId}>
                        {i > 0 && ' y '}
                        <b style={{ color: 'var(--text-primary)' }}>{a.teacherName}</b> ({a.slots.map(s => `${s.day} ${s.hour}`).join(', ') || '—'})
                      </span>
                    ))}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    {group.assignments.map(a => (
                      <button key={a.assignmentId} onClick={() => keepOnly(group, a.assignmentId)} disabled={busy}
                        style={{ padding: '9px 12px', borderRadius: 8, border: '1px solid rgba(30,158,58,0.4)', background: 'rgba(30,158,58,0.08)', color: '#1E9E3A', fontWeight: 700, fontSize: 12.5, cursor: busy ? 'not-allowed' : 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>
                        ✓ Mantener solo con {a.teacherName} (elimina las demás y libera su grid)
                      </button>
                    ))}
                    <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                      <button onClick={() => markReviewed(group.key)} disabled={busy}
                        style={{ flex: '1 1 180px', padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-surface-3)', color: 'var(--text-secondary)', fontWeight: 600, fontSize: 12.5, cursor: busy ? 'not-allowed' : 'pointer', fontFamily: 'inherit' }}>
                        Ambas son correctas (tiene clases con las dos)
                      </button>
                      <button onClick={() => setChangeFor({ group })} disabled={busy}
                        style={{ flex: '1 1 150px', padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontWeight: 600, fontSize: 12.5, cursor: busy ? 'not-allowed' : 'pointer', fontFamily: 'inherit' }}>
                        🔄 Usar "Cambiar de profesor"
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {changeFor && changeGroupAssignment && (
        <CambiarProfesorModal
          student={{ id: changeGroupAssignment.studentId, name: changeGroupAssignment.studentName, email: changeGroupAssignment.studentEmail, level: changeGroupAssignment.studentLevel }}
          currentAssignment={changeGroupAssignment}
          onClose={() => setChangeFor(null)}
          onDone={() => setChangeFor(null)}
        />
      )}
    </>
  );
}

// ─── Admin Content ────────────────────────────────────────────────────────────
const ADMIN_TABS = ['overview', 'teachers', 'emails', 'scoring', 'tracking', 'classlog', 'ai', 'notifications'] as const;
type AdminTab = typeof ADMIN_TABS[number];

function AdminContent() {
  const { teachers, assignments, students, addTeacher, loadingTeachers, getTeacherGrid, updateTeacherGrid, checkAndRunResets, reloadAll, updateTeacherInfo } = useTeachers();
  const [selectedTeacher, setSelectedTeacher] = useState<string | null>(null);
  const [showNewTeacher, setShowNewTeacher] = useState(false);
  const [activeTab, setActiveTab] = useState<AdminTab>('overview');

  // El campanario del header navega a /admin?tab=notifications. Sincronizamos la
  // pestaña con la URL (sistema externo) para aterrizar en Avisos; la pestaña
  // sigue siendo estado local para que cambiarla no cueste un round-trip de red.
  const searchParams = useSearchParams();
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    const t = searchParams.get('tab');
    if (t && (ADMIN_TABS as readonly string[]).includes(t)) setActiveTab(t as AdminTab);
  }, [searchParams]);
  const [editCalendarTeacher, setEditCalendarTeacher] = useState<Teacher | null>(null);
  const [editTeacher, setEditTeacher] = useState<Teacher | null>(null);
  const [specialtyFilter, setSpecialtyFilter] = useState<string>('');
  const [editingStartDate, setEditingStartDate] = useState<Record<string, string>>({});
  const [savingStartDate, setSavingStartDate] = useState<Set<string>>(new Set());
  const [emailDetail, setEmailDetail] = useState<string | null>(null);   // profe con el detalle de emails abierto

  // Referencia temporal para el estado de los emails de presentación (no requiere
  // reloj vivo en admin: se recalcula al recargar / cambiar de pestaña).
  const nowMs = Date.now();
  const presPendingStatuses = assignments.filter(a => !a.presentationEmailSent).map(a => getPresentationEmailStatus(a, nowMs));
  const presOnTimeCount  = presPendingStatuses.filter(s => s.status === 'on_time' || s.status === 'warning').length;
  const presAtRiskCount  = presPendingStatuses.filter(s => s.status === 'at_risk').length;
  const presOverdueCount = presPendingStatuses.filter(s => s.status === 'overdue').length;

  // Check for resets on load
  useEffect(() => {
    checkAndRunResets();
  }, []);

  const activeTeachers  = teachers.filter(t => t.status !== 'vacation').length;
  const totalClasses    = teachers.reduce((a, t) => a + t.upcomingClasses.length, 0);
  const totalFreeSpots  = teachers.reduce((a, t) => a + t.freeSpots, 0);
  const conflicts       = mockAlerts.filter(a => a.type === 'conflict').length;
  const blockedCount    = teachers.filter(t => t.isBlocked).length;

  const alertColors  = { high: '#ef4444', medium: '#f59e0b', low: '#6b7280' };
  const alertBgs     = { high: 'rgba(239,68,68,0.07)', medium: 'rgba(245,158,11,0.07)', low: 'rgba(107,114,128,0.07)' };
  const alertBorders = { high: 'rgba(239,68,68,0.2)', medium: 'rgba(245,158,11,0.2)', low: 'rgba(107,114,128,0.2)' };
  const alertIcons   = { conflict: '⚠️', coverage: '📉', warning: 'ℹ️' };

  const teacher = selectedTeacher ? teachers.find(t => t.id === selectedTeacher) : null;

  const tabs = [
    { id: 'overview',       label: '📊 Resumen' },
    { id: 'teachers',       label: '👨‍🏫 Profesores' },
    { id: 'emails',         label: '📧 Emails' },
    { id: 'scoring',        label: '⭐ Scoring' },
    { id: 'tracking',       label: '📈 Seguimiento' },
    { id: 'classlog',       label: '📊 Registro de clases' },
    { id: 'ai',             label: '🤖 IA y Riesgo' },
    { id: 'notifications',  label: '🔔 Notificaciones' },
  ] as const;

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }}>
      <NavBar />
      <PullToRefresh onRefresh={reloadAll}>
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '28px 24px' }}>
        <LastUpdated />

        <DuplicatesBanner />

        <div className="admin-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 4px' }}>Admin</h1>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
              {teachers.length} profesores · {students.length} alumnos · {assignments.length} asignaciones
              {blockedCount > 0 && <span style={{ color: '#ef4444', fontWeight: 700 }}> · {blockedCount} bloqueado{blockedCount !== 1 ? 's' : ''}</span>}
            </p>
          </div>
          <button className="admin-header-btn" onClick={() => setShowNewTeacher(true)} style={{ padding: '9px 18px', borderRadius: 9, border: 'none', background: '#1E9E3A', color: 'white', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
            ＋ Nuevo profesor
          </button>
        </div>

        <div className="tabs-scroll" style={{ display: 'flex', gap: 4, marginBottom: 22, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 4 }}>
          {tabs.map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{ flex: 1, padding: '8px 12px', borderRadius: 7, border: 'none', background: activeTab === tab.id ? '#1E9E3A' : 'transparent', color: activeTab === tab.id ? 'white' : 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontWeight: activeTab === tab.id ? 700 : 500, transition: 'all 0.12s' }}>
              {tab.label}
            </button>
          ))}
        </div>

        {/* OVERVIEW TAB */}
        {activeTab === 'overview' && (<>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 14, marginBottom: 22 }}>
            {[
              { icon: '👨‍🏫', label: 'Activos',       value: activeTeachers,    sub: `de ${teachers.length}`,   color: '#1E9E3A' },
              { icon: '📚', label: 'Clases semana', value: totalClasses,      sub: 'confirmadas',             color: '#1E9E3A' },
              { icon: '🪑', label: 'Cupos libres',  value: totalFreeSpots,    sub: 'disponibles',             color: '#a78bfa' },
              { icon: '⚠️', label: 'Conflictos',    value: conflicts,         sub: conflicts > 0 ? 'atención' : 'ok', color: conflicts > 0 ? '#ef4444' : '#1E9E3A' },
              { icon: '👤', label: 'Alumnos',       value: students.length,   sub: 'registrados',             color: '#f59e0b' },
              { icon: '🔴', label: 'Bloqueados',    value: blockedCount,      sub: 'baja retención',          color: blockedCount > 0 ? '#ef4444' : '#1E9E3A' },
            ].map(s => (
              <div key={s.label} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px' }}>
                <div style={{ fontSize: 22, marginBottom: 10 }}>{s.icon}</div>
                <div style={{ fontSize: 26, fontWeight: 700, color: s.color }}>{s.value}</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginTop: 3 }}>{s.label}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>{s.sub}</div>
              </div>
            ))}
          </div>

          {/* Resumen de emails de presentación */}
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px', marginBottom: 22 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
              <span style={{ fontSize: 18 }}>📧</span>
              <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Emails de presentación</span>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>
                {presPendingStatuses.length} pendiente{presPendingStatuses.length !== 1 ? 's' : ''}
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
              {[
                { label: 'Pendientes a tiempo', value: presOnTimeCount,  icon: '✅', color: '#1E9E3A', bg: 'rgba(30,158,58,0.08)',  border: 'rgba(30,158,58,0.3)' },
                { label: 'En riesgo (>12h)',    value: presAtRiskCount,  icon: '⚠️', color: '#b8860b', bg: 'rgba(255,196,0,0.12)',  border: 'rgba(255,196,0,0.5)' },
                { label: 'Fuera de tiempo (>24h)', value: presOverdueCount, icon: '🔴', color: '#ef4444', bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.35)' },
              ].map(c => (
                <div key={c.label} style={{ background: c.bg, border: `1px solid ${c.border}`, borderRadius: 10, padding: '12px 14px' }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: c.color }}>{c.icon} {c.value}</div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginTop: 2 }}>{c.label}</div>
                </div>
              ))}
            </div>
          </div>

          <AuditPanel />
          <SyncPanel />
          <PlanSyncPanel />
          <StartDateSyncPanel />

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, marginTop: 16 }}>
            <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>Alertas</span>
              </div>
              <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {blockedCount > 0 && (
                  <div style={{ background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 8, padding: '10px 12px', display: 'flex', gap: 8 }}>
                    <span>🔴</span>
                    <span style={{ fontSize: 12, color: '#ef4444', lineHeight: 1.4 }}>
                      {blockedCount} profesor{blockedCount !== 1 ? 'es' : ''} bloqueado{blockedCount !== 1 ? 's' : ''} por baja retención — no pueden recibir nuevos alumnos
                    </span>
                  </div>
                )}
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
                  <div key={a.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
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
            {/* Specialty filter */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>Filtrar por especialidad:</span>
              {(['', ...ALL_SPECIALTIES] as string[]).map(sp => {
                const active = specialtyFilter === sp;
                return (
                  <ToggleChip key={sp || 'all'} active={active} onClick={() => setSpecialtyFilter(sp)}>
                    {sp || 'Todas'}
                  </ToggleChip>
                );
              })}
            </div>

            {/* Desktop: table */}
            <div className="desk-only" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
              <div style={{ overflowX: 'auto', maxHeight: 500, overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                    <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)' }}>
                      {['Nombre', 'Especialidades', 'Estado', 'Nivel', 'Carga', 'Cupos', '📧 Emails', ''].map(h => (
                        <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {teachers
                      .filter(t => !specialtyFilter || (t.specialties ?? []).includes(specialtyFilter))
                      .map(t => {
                      const loadPct = t.maxWeeklyLoad > 0 ? Math.round((t.weeklyLoad / t.maxWeeklyLoad) * 100) : 0;
                      const loadColor = loadPct >= 90 ? '#ef4444' : loadPct >= 70 ? '#f59e0b' : '#1E9E3A';
                      const isBlocked = t.isBlocked ?? false;
                      const presSum = teacherPresentationSummary(assignments.filter(a => a.teacherId === t.id), nowMs);
                      const emailOpen = emailDetail === t.id;
                      return (
                        <Fragment key={t.id}>
                        <tr style={{ borderBottom: '1px solid var(--border)', background: isBlocked ? 'rgba(239,68,68,0.02)' : selectedTeacher === t.id ? 'var(--bg-surface-2)' : 'transparent' }}>
                          <td style={{ padding: '11px 14px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div style={{ width: 30, height: 30, borderRadius: '50%', background: isBlocked ? 'rgba(239,68,68,0.1)' : 'var(--bg-surface-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: isBlocked ? '#ef4444' : 'var(--text-secondary)', flexShrink: 0 }}>{t.avatar}</div>
                              <div>
                                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{t.name}</span>
                                {isBlocked && <span style={{ marginLeft: 6, fontSize: 10, color: '#ef4444', fontWeight: 700 }}>🔴 BLOQUEADO</span>}
                              </div>
                            </div>
                          </td>
                          <td style={{ padding: '11px 14px' }}>
                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                              {(t.specialties ?? []).map(sp => <SpecialtyChip key={sp} specialty={sp} />)}
                              {(t.specialties ?? []).length === 0 && <span style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>—</span>}
                            </div>
                          </td>
                          <td style={{ padding: '11px 14px' }}><StatusBadge status={t.status} /></td>
                          <td style={{ padding: '11px 14px' }}>
                            {isBlocked
                              ? <LevelBadge level={t.currentLevel ?? 1} blocked />
                              : <LevelBadge level={t.currentLevel ?? 1} />}
                          </td>
                          <td style={{ padding: '11px 14px', minWidth: 100 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--bg-surface-3)' }}>
                                <div style={{ width: `${loadPct}%`, height: '100%', borderRadius: 2, background: loadColor }} />
                              </div>
                              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t.weeklyLoad}h</span>
                            </div>
                          </td>
                          <td style={{ padding: '11px 14px' }}>
                            <span style={{ fontSize: 13, color: t.freeSpots > 0 ? '#1E9E3A' : 'var(--text-muted)', fontWeight: 600 }}>{t.freeSpots}</span>
                          </td>
                          <td style={{ padding: '11px 14px' }}>
                            <button
                              onClick={() => { if (presSum.pending.length > 0) setEmailDetail(emailOpen ? null : t.id); }}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 9px', borderRadius: 20, background: presSum.badge.bg, border: `1px solid ${presSum.badge.border}`, color: presSum.badge.color, fontSize: 11, fontWeight: 700, cursor: presSum.pending.length > 0 ? 'pointer' : 'default', fontFamily: 'inherit' }}>
                              {presSum.badge.text}
                              {presSum.pending.length > 0 && <span style={{ opacity: 0.7 }}>{emailOpen ? '▲' : '▼'}</span>}
                            </button>
                          </td>
                          <td style={{ padding: '11px 14px' }}>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button onClick={() => setEditTeacher(t)} style={{ padding: '5px 10px', borderRadius: 7, border: '1px solid rgba(30,158,58,0.35)', background: 'rgba(30,158,58,0.07)', color: '#1E9E3A', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                                Editar
                              </button>
                              <button onClick={() => setSelectedTeacher(t.id === selectedTeacher ? null : t.id)} style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid var(--border)', background: selectedTeacher === t.id ? 'var(--bg-surface-3)' : 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12 }}>
                                {selectedTeacher === t.id ? 'Cerrar' : 'Ver'}
                              </button>
                            </div>
                          </td>
                        </tr>
                        {emailOpen && presSum.pending.length > 0 && (
                          <tr style={{ background: 'var(--bg-surface-2)' }}>
                            <td colSpan={8} style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
                              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>{t.name} — Email pendiente:</div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                {presSum.pending.map((p, i) => (
                                  <div key={i} style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                                    {p.studentName} · Asignada hace {p.hours}h · <span style={{ fontWeight: 700, color: p.statusKind === 'overdue' ? '#ef4444' : p.statusKind === 'at_risk' ? '#f97316' : '#b8860b' }}>{p.statusLabel}</span>
                                  </div>
                                ))}
                              </div>
                            </td>
                          </tr>
                        )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Mobile: cards */}
            <div className="mob-only" style={{ flexDirection: 'column', gap: 10, marginBottom: 16 }}>
              {teachers
                .filter(t => !specialtyFilter || (t.specialties ?? []).includes(specialtyFilter))
                .map(t => {
                const isBlocked = t.isBlocked ?? false;
                const teacherAssignments = assignments.filter(a => a.teacherId === t.id);
                const presSum = teacherPresentationSummary(teacherAssignments, nowMs);
                return (
                  <div key={t.id} style={{ background: 'var(--bg-surface)', border: `1px solid ${isBlocked ? 'rgba(239,68,68,0.25)' : 'var(--border)'}`, borderRadius: 12, padding: 14, opacity: isBlocked ? 0.9 : 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                      <div style={{ width: 38, height: 38, borderRadius: '50%', background: isBlocked ? 'rgba(239,68,68,0.1)' : 'var(--bg-surface-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: isBlocked ? '#ef4444' : 'var(--text-secondary)', flexShrink: 0 }}>{t.avatar}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>{teacherAssignments.length} alumnos · {t.weeklyLoad}h/sem</div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                      {(t.specialties ?? []).map(sp => <SpecialtyChip key={sp} specialty={sp} />)}
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
                      <StatusBadge status={t.status} />
                      {isBlocked ? <LevelBadge level={t.currentLevel ?? 1} blocked /> : <LevelBadge level={t.currentLevel ?? 1} />}
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 9px', borderRadius: 20, background: presSum.badge.bg, border: `1px solid ${presSum.badge.border}`, color: presSum.badge.color, fontSize: 11, fontWeight: 700 }}>
                        {presSum.badge.text}
                      </span>
                    </div>
                    {presSum.pending.length > 0 && (
                      <div style={{ marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 3 }}>
                        {presSum.pending.map((p, i) => (
                          <div key={i} style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                            📧 {p.studentName} · hace {p.hours}h · <span style={{ fontWeight: 700, color: p.statusKind === 'overdue' ? '#ef4444' : p.statusKind === 'at_risk' ? '#f97316' : '#b8860b' }}>{p.statusLabel}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => setEditTeacher(t)} style={{ flex: 1, padding: '8px', borderRadius: 8, border: '1px solid rgba(30,158,58,0.35)', background: 'rgba(30,158,58,0.07)', color: '#1E9E3A', cursor: 'pointer', fontSize: 12, fontWeight: 700, fontFamily: 'inherit' }}>
                        Editar
                      </button>
                      <button onClick={() => setSelectedTeacher(t.id === selectedTeacher ? null : t.id)} style={{ flex: 2, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: selectedTeacher === t.id ? 'var(--bg-surface-3)' : 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>
                        {selectedTeacher === t.id ? 'Cerrar detalle' : 'Ver detalle →'}
                      </button>
                    </div>
                  </div>
                );
              })}
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
                      style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid rgba(30,158,58,0.35)', background: 'rgba(30,158,58,0.08)', color: '#1E9E3A', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
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
                        <div style={{ width: `${teacher.maxWeeklyLoad > 0 ? Math.round((teacher.weeklyLoad / teacher.maxWeeklyLoad) * 100) : 0}%`, height: '100%', borderRadius: 3, background: '#1E9E3A' }} />
                      </div>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Cupos libres: <b style={{ color: teacher.freeSpots > 0 ? '#1E9E3A' : '#ef4444' }}>{teacher.freeSpots}</b></div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Alumnos asignados</div>
                    {(() => {
                      const ta = assignments.filter(a => a.teacherId === teacher.id);
                      if (ta.length === 0) return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Sin alumnos asignados.</div>;
                      const sorted = [...ta].sort((a, b) => calcCurrentClassNumber(b) - calcCurrentClassNumber(a));
                      return sorted.map(a => {
                        const classNum = calcCurrentClassNumber(a);
                        const isMilestone = classNum >= 15;
                        const isEditing = editingStartDate[a.id] !== undefined;
                        return (
                          <div key={a.id} style={{ marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>👤 {a.studentName}</div>
                              {classNum > 0 && (
                                <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 10, background: classNum >= 30 ? 'rgba(30,158,58,0.15)' : isMilestone ? 'rgba(255,196,0,0.2)' : 'rgba(30,158,58,0.1)', border: `1px solid ${classNum >= 30 ? 'rgba(30,158,58,0.4)' : isMilestone ? '#FFC400' : 'rgba(30,158,58,0.3)'}`, color: classNum >= 30 ? '#1E9E3A' : isMilestone ? '#b8860b' : '#1E9E3A', fontWeight: 700 }}>
                                  {classNum >= 30 ? '🏆 ' : isMilestone ? '🎯 ' : ''}Clase {classNum}
                                </span>
                              )}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{a.studentLevel} · {a.slots.map(sl => `${sl.day} ${sl.hour}`).join(', ')}</div>
                            {/* Inline start_date editor */}
                            <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                              {isEditing ? (
                                <>
                                  <input
                                    type="date"
                                    value={editingStartDate[a.id]}
                                    onChange={e => setEditingStartDate(prev => ({ ...prev, [a.id]: e.target.value }))}
                                    style={{ fontSize: 11, padding: '2px 6px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg-surface-2)', color: 'var(--text-primary)' }}
                                  />
                                  <button
                                    disabled={savingStartDate.has(a.id)}
                                    onClick={async () => {
                                      if (!editingStartDate[a.id]) return;
                                      setSavingStartDate(prev => new Set([...prev, a.id]));
                                      await dbUpdateAssignmentStartDate(a.id, editingStartDate[a.id]);
                                      setSavingStartDate(prev => { const n = new Set(prev); n.delete(a.id); return n; });
                                      setEditingStartDate(prev => { const n = { ...prev }; delete n[a.id]; return n; });
                                    }}
                                    style={{ fontSize: 11, padding: '2px 8px', borderRadius: 5, border: 'none', background: '#1E9E3A', color: 'white', cursor: savingStartDate.has(a.id) ? 'wait' : 'pointer', fontFamily: 'inherit' }}>
                                    {savingStartDate.has(a.id) ? '...' : 'Guardar'}
                                  </button>
                                  <button
                                    onClick={() => setEditingStartDate(prev => { const n = { ...prev }; delete n[a.id]; return n; })}
                                    style={{ fontSize: 11, padding: '2px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'inherit' }}>
                                    Cancelar
                                  </button>
                                </>
                              ) : (
                                <button
                                  onClick={() => setEditingStartDate(prev => ({ ...prev, [a.id]: a.startDate ?? new Date().toISOString().split('T')[0] }))}
                                  style={{ fontSize: 10, padding: '2px 7px', borderRadius: 5, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'inherit' }}>
                                  {a.startDate ? `Inicio: ${new Date(a.startDate + 'T00:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })} ✏️` : '+ Fecha inicio'}
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      });
                    })()}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* WEEKLY VIEW TAB */}
        {activeTab === 'emails' && (
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '20px' }}>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' }}>Emails de presentación</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>Estado del email de bienvenida por alumno. Los pendientes con más retraso, arriba.</div>
            </div>
            <PresentationEmailsTab assignments={assignments} nowMs={nowMs} />
          </div>
        )}

        {/* SCORING TAB */}
        {activeTab === 'scoring' && <ScoringTab />}

        {/* TRACKING TAB */}
        {activeTab === 'tracking' && <ClassTrackingTab />}

        {/* CLASS LOG TAB */}
        {activeTab === 'classlog' && <ClassLogTab />}

        {/* AI & RISK TAB */}
        {activeTab === 'ai' && <AiRiskTab teachers={teachers} assignments={assignments} />}

        {/* NOTIFICATIONS TAB */}
        {activeTab === 'notifications' && <NotificationsAdminTab />}
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

      {editTeacher && (
        <EditTeacherModal
          teacher={editTeacher}
          onClose={() => setEditTeacher(null)}
          onSave={async (id, data) => { await updateTeacherInfo(id, data); setEditTeacher(null); }}
        />
      )}
      </PullToRefresh>
    </div>
  );
}

export default function AdminPage() {
  return (
    <AuthGuard allowedRoles={['admin']}>
      {/* AdminContent lee ?tab= con useSearchParams: requiere un boundary. */}
      <Suspense>
        <AdminContent />
      </Suspense>
    </AuthGuard>
  );
}
