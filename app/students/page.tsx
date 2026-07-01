'use client';
import { useState, useMemo, useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { PullToRefresh } from '@/components/PullToRefresh';
import { LastUpdated } from '@/components/LastUpdated';
import { useTeachers } from '@/lib/TeachersContext';
import { useAuth } from '@/lib/AuthContext';
import { DAYS, cellKey } from '@/components/VisualCalendar';
import { dbCheckStudentExists, dbSetStudentManualActive, dbActivateOneTimeAccess } from '@/lib/db';
import { classifyPlan, planBadgeStyle } from '@/lib/productUtils';
import { Student, Grid, Assignment } from '@/types';

// Detecta viewport mobile (< breakpoint). Alterna tabla (desktop) ↔ cards (mobile).
function useIsMobile(breakpoint = 1024): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < breakpoint);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [breakpoint]);
  return isMobile;
}

// Ítem del menú de tres puntos de cada card de alumno.
function MenuItem({ children, onClick, danger }: { children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 8, padding: '9px 12px', borderRadius: 7, border: 'none', background: 'transparent', color: danger ? '#dc2626' : 'var(--text-primary)', cursor: 'pointer', fontSize: 13, fontWeight: 500, fontFamily: 'inherit', textAlign: 'left' }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-surface-2)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
      {children}
    </button>
  );
}

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
  phone: string;
  productType?: 'subscription' | 'one_time';
  productName?: string;
  manualActiveUntil?: string;
  inStudentsTable: boolean;
  createdAt: string;
}

// WhatsApp de baja — mensaje precargado (reemplaza [Nombre]).
function buildWhatsAppLink(phone: string, studentName: string): string {
  const digits = phone.replace(/\D/g, ''); // solo dígitos con código de país
  const msg =
    `Hola ${studentName.split(' ')[0]}, Queremos informarte que has finalizado tu plan con la academia. ` +
    `Por lo tanto, ya no puedes continuar con clases. Si deseas seguir aprendiendo con nosotros, ` +
    `puedes renovar tu plan cuando lo desees 😊`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(msg)}`;
}

// ── Subscription / one-time access status (WooCommerce) ───────────────────────
interface SubInfo {
  active: boolean | null;
  status: string;
  daysRemaining: number | null;
  endDate: string | null;
  productType: 'subscription' | 'one_time' | null;
  productName: string | null;
  manualActiveUntil: string | null;
  fetchedAt: number;
}
type SubCategory = 'active' | 'inactive' | 'pending' | 'unverified';

async function fetchSubInfo(email: string): Promise<SubInfo> {
  try {
    const res = await fetch(`/api/check-subscription?email=${encodeURIComponent(email)}`);
    const data = await res.json();
    return {
      active:            data.active ?? null,
      status:            data.status ?? 'error',
      daysRemaining:     data.daysRemaining ?? null,
      endDate:           data.endDate ?? null,
      productType:       data.productType ?? null,
      productName:       data.productName ?? null,
      manualActiveUntil: data.manualActiveUntil ?? null,
      fetchedAt:         Date.now(),
    };
  } catch {
    return { active: null, status: 'error', daysRemaining: null, endDate: null, productType: null, productName: null, manualActiveUntil: null, fetchedAt: Date.now() };
  }
}

function subCategory(info: SubInfo | undefined): SubCategory {
  if (!info) return 'unverified';
  if (info.active === true) return 'active';                                    // active / manual_active / manual_override
  if (info.status === 'pending-cancel') return 'pending';
  if (info.active === null || info.status === 'error' || info.status === 'not_found') return 'unverified';
  return 'inactive';   // cancelled, expired, on-hold, one_time_no_access (expirado o sin activar)
}

// Formatea 'YYYY-MM-DD' (o ISO) como 'DD/MM'.
function shortDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso);
  if (isNaN(d.getTime())) return '';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function subBadge(info: SubInfo | undefined): { label: string; color: string; bg: string; spin?: boolean } {
  if (!info) return { label: '...', color: 'var(--text-muted)', bg: 'var(--bg-surface-3)', spin: true };
  const green  = { color: '#1E9E3A', bg: 'rgba(30,158,58,0.1)' };
  const red    = { color: '#dc2626', bg: 'rgba(239,68,68,0.1)' };
  const gray   = { color: 'var(--text-muted)', bg: 'var(--bg-surface-3)' };

  // PAGO ÚNICO
  if (info.productType === 'one_time') {
    if (info.status === 'manual_active' && info.manualActiveUntil) {
      return { label: `🎯 Activo hasta ${shortDate(info.manualActiveUntil)}`, ...green };
    }
    if (info.manualActiveUntil) return { label: '❌ Expirado', ...red }; // tenía fecha y ya pasó
    return { label: '⚪ Sin activar', ...gray };
  }

  // SUSCRIPCIÓN (y desconocido)
  if (info.status === 'manual_override') {
    const tail = info.manualActiveUntil ? ` hasta ${shortDate(info.manualActiveUntil)}` : (info.endDate ? ` hasta ${shortDate(info.endDate)}` : '');
    return { label: `✅ Activa (manual${tail})`, ...green };
  }
  switch (info.status) {
    case 'active':         return { label: '✅ Activa', ...green };
    case 'pending-cancel': {
      const d = info.daysRemaining;
      const tail = d != null && d > 0 ? ` (${d} día${d === 1 ? '' : 's'})` : '';
      return { label: `⏳ Pendiente cancelar${tail}`, color: '#b45309', bg: 'rgba(255,196,0,0.15)' };
    }
    case 'on-hold':        return { label: '⚠️ En espera', color: '#ea580c', bg: 'rgba(249,115,22,0.12)' };
    case 'cancelled':      return { label: '❌ Cancelada', ...red };
    case 'expired':        return { label: '❌ Expirada', ...red };
    default:               return { label: '❓ Sin verificar', ...gray }; // error / not_found
  }
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
  onSave: (s: Student, scheduleData?: { slots: Array<{day:string;hour:string}>; startDate: string; weeklyHours: number }) => Promise<void>;
}) {
  const [form, setForm] = useState({ name: student.name, email: student.email, level: student.level, plan: student.plan ?? '' });
  const [slots, setSlots] = useState<Array<{day:string;hour:string}>>(assignment?.slots || []);
  const [startDate, setStartDate] = useState(assignment?.startDate || '');
  const [weeklyHours, setWeeklyHours] = useState<number>(assignment?.weeklyHours || assignment?.slots.length || 1);
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
      await onSave(studentRecord, { slots, startDate, weeklyHours });
    } else {
      await onSave(studentRecord);
    }
    setSaving(false);
  }

  return (
    <div className="modal-cover" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-sheet" style={{ background: 'var(--bg-surface)', border: '1px solid #35405a', borderRadius: 16, width: '100%', maxWidth: 480, maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

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

                {/* Weekly hours + Start date */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div>
                    <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      Horas semanales
                    </label>
                    <input type="number" min={1} max={5} value={weeklyHours}
                      onChange={e => setWeeklyHours(Math.min(5, Math.max(1, parseInt(e.target.value) || 1)))}
                      style={{ width: '100%' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      Fecha de inicio
                    </label>
                    <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ width: '100%' }} />
                  </div>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: -4 }}>
                  El límite mensual de clases se calcula con este valor. Editá si la detección automática fue incorrecta.
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

// ── Delete confirmation + WhatsApp notice ─────────────────────────────────────
function DeleteStudentModal({ student, onConfirm, onCancel }: {
  student: DisplayStudent;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  const [phone, setPhone] = useState(student.phone || '');
  const [loadingPhone, setLoadingPhone] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // If there's no local phone, try to get it from WooCommerce (billing.phone).
  useEffect(() => {
    if (phone || !student.email) return;
    let cancelled = false;
    setLoadingPhone(true);
    fetch(`/api/check-subscription?email=${encodeURIComponent(student.email)}`)
      .then(r => r.json())
      .then(d => { if (!cancelled && d?.phone) setPhone(String(d.phone)); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingPhone(false); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const waLink = phone ? buildWhatsAppLink(phone, student.name) : null;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)', zIndex: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget && !deleting) onCancel(); }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid #35405a', borderRadius: 14, padding: 24, width: '100%', maxWidth: 420 }}>
        <div style={{ fontSize: 24, marginBottom: 10 }}>🗑️</div>
        <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 8 }}>Eliminar alumno</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.6 }}>
          ¿Seguro que querés eliminar a <b style={{ color: 'var(--text-primary)' }}>{student.name}</b>? Se borrarán sus asignaciones y se liberará su horario. Esta acción no se puede deshacer.
        </div>

        {/* WhatsApp notice */}
        <div style={{ marginBottom: 18 }}>
          {waLink ? (
            <a href={waLink} target="_blank" rel="noopener noreferrer"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', padding: '10px', borderRadius: 8, border: 'none', background: '#25D366', color: 'white', cursor: 'pointer', fontSize: 13, fontWeight: 700, textDecoration: 'none' }}>
              📱 Enviar WhatsApp de baja
            </a>
          ) : (
            <button disabled title={loadingPhone ? 'Buscando teléfono...' : 'Sin teléfono registrado'}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-surface-3)', color: 'var(--text-muted)', cursor: 'not-allowed', fontSize: 13, fontWeight: 600 }}>
              {loadingPhone ? <><span className="drc-spinner-xs" /> Buscando teléfono...</> : '📱 Sin teléfono registrado'}
            </button>
          )}
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onCancel} disabled={deleting}
            style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: deleting ? 'not-allowed' : 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
            Cancelar
          </button>
          <button onClick={async () => { setDeleting(true); await onConfirm(); }} disabled={deleting}
            style={{ flex: 2, padding: '10px', borderRadius: 8, border: '1px solid rgba(239,68,68,0.35)', background: 'rgba(239,68,68,0.15)', color: '#dc2626', cursor: deleting ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
            {deleting ? 'Eliminando...' : 'Eliminar alumno'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Manual subscription activation modal ──────────────────────────────────────
function ManualActivateModal({ student, onConfirm, onCancel }: {
  student: DisplayStudent;
  onConfirm: (until: string) => Promise<void>;
  onCancel: () => void;
}) {
  // Valor por defecto: 30 días desde hoy.
  const defaultUntil = (() => {
    const d = new Date(); d.setDate(d.getDate() + 30);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  const todayStr = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  const [until, setUntil] = useState(defaultUntil);
  const [saving, setSaving] = useState(false);

  const canSave = !!until && until >= todayStr && !saving;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)', zIndex: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget && !saving) onCancel(); }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid #35405a', borderRadius: 14, padding: 24, width: '100%', maxWidth: 420 }}>
        <div style={{ fontSize: 24, marginBottom: 10 }}>✅</div>
        <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 8 }}>Activar suscripción manualmente</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 18, lineHeight: 1.6 }}>
          <b style={{ color: 'var(--text-primary)' }}>{student.name}</b> no cuenta con suscripción activa en WooCommerce.
          Podés activarla manualmente en el sistema hasta una fecha específica.
        </div>
        <div style={{ marginBottom: 20 }}>
          <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            ¿Hasta qué fecha deseas activarla?
          </label>
          <input type="date" value={until} min={todayStr} onChange={e => setUntil(e.target.value)} style={{ width: '100%' }} />
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onCancel} disabled={saving}
            style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: saving ? 'not-allowed' : 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
            Cancelar
          </button>
          <button onClick={async () => { setSaving(true); await onConfirm(until); }} disabled={!canSave}
            style={{ flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: canSave ? '#1E9E3A' : 'var(--bg-surface-3)', color: canSave ? 'white' : 'var(--text-muted)', cursor: canSave ? 'pointer' : 'not-allowed', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
            {saving ? 'Activando...' : 'Activar'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── One-time access modal (Gestionar acceso) ──────────────────────────────────
function AccessModal({ student, onConfirm, onCancel }: {
  student: DisplayStudent;
  onConfirm: (until: string) => Promise<void>;
  onCancel: () => void;
}) {
  const todayStr = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  const productName = student.productName || student.plan || 'Producto de pago único';

  // Sugerencia de fin según el producto: Intensivo +4 semanas, Empresas +8.
  function suggestEnd(start: string): string {
    const weeks = /empresas/i.test(productName) ? 8 : /intensivo/i.test(productName) ? 4 : 4;
    const d = new Date((start || todayStr) + 'T00:00:00');
    d.setDate(d.getDate() + weeks * 7);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  const [start, setStart] = useState(todayStr);
  const [until, setUntil] = useState(suggestEnd(todayStr));
  const [saving, setSaving] = useState(false);

  // Reajustar la sugerencia de fin al cambiar la fecha de inicio.
  function onStartChange(v: string) {
    setStart(v);
    setUntil(suggestEnd(v));
  }

  const canSave = !!until && until >= todayStr && until >= start && !saving;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)', zIndex: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget && !saving) onCancel(); }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid #35405a', borderRadius: 14, padding: 24, width: '100%', maxWidth: 440 }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 4 }}>Gestionar acceso — {student.name}</div>
        <div style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px', margin: '14px 0 18px' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>📦 {productName}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>Tipo: Pago único</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Fecha de inicio</label>
            <input type="date" value={start} onChange={e => onStartChange(e.target.value)} style={{ width: '100%' }} />
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Fecha de finalización <span style={{ color: '#ef4444' }}>*</span></label>
            <input type="date" value={until} min={start} onChange={e => setUntil(e.target.value)} style={{ width: '100%' }} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onCancel} disabled={saving}
            style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: saving ? 'not-allowed' : 'pointer', fontSize: 13, fontFamily: 'inherit' }}>Cancelar</button>
          <button onClick={async () => { setSaving(true); await onConfirm(until); }} disabled={!canSave}
            style={{ flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: canSave ? '#1E9E3A' : 'var(--bg-surface-3)', color: canSave ? 'white' : 'var(--text-muted)', cursor: canSave ? 'pointer' : 'not-allowed', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
            {saving ? 'Guardando...' : 'Guardar acceso'}
          </button>
        </div>
      </div>
    </div>
  );
}

function StudentsContent() {
  const {
    students, assignments, deleteStudent, updateStudent,
    getTeacherGrid, updateTeacherGrid, updateAssignmentSlots, updateAssignmentStartDate, reloadAll,
  } = useTeachers();
  const { user } = useAuth();
  const [search, setSearch] = useState('');
  const [editingStudent, setEditingStudent] = useState<DisplayStudent | null>(null);
  const [editingAssignment, setEditingAssignment] = useState<Assignment | null>(null);
  const [teacherGridForEdit, setTeacherGridForEdit] = useState<Grid>({});
  const [duplicateStudent, setDuplicateStudent] = useState<Student | null>(null);
  const [deletingStudent, setDeletingStudent] = useState<DisplayStudent | null>(null);
  const [activatingStudent, setActivatingStudent] = useState<DisplayStudent | null>(null);
  const [accessStudent, setAccessStudent] = useState<DisplayStudent | null>(null);
  const [subFilter, setSubFilter] = useState<'all' | SubCategory>('all');
  const [subInfo, setSubInfo] = useState<Record<string, SubInfo>>({});
  const [verifyingSubs, setVerifyingSubs] = useState(false);
  const [subProgress, setSubProgress] = useState<{ done: number; total: number } | null>(null);
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set());
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(50);
  const router = useRouter();

  // Merge students from both sources: students table + assignments.
  // Una assignment ya representada por un alumno de la tabla (por id, email o
  // nombre) NO genera una fila aparte — solo las assignments verdaderamente
  // huérfanas (sin alumno en la tabla) se muestran como entrada propia.
  const allStudents = useMemo<DisplayStudent[]>(() => {
    const map = new Map<string, DisplayStudent>();
    for (const s of students) {
      map.set(s.id, { id: s.id, name: s.name, email: s.email, level: s.level, plan: s.plan ?? '', phone: s.phone ?? '', productType: s.productType, productName: s.productName, manualActiveUntil: s.manualActiveUntil, inStudentsTable: true, createdAt: s.createdAt });
    }
    const studentMatchesAssignment = (s: Student, a: Assignment) =>
      a.studentId === s.id ||
      (!!a.studentEmail && !!s.email && a.studentEmail.trim().toLowerCase() === s.email.trim().toLowerCase()) ||
      a.studentName.trim().toLowerCase() === s.name.trim().toLowerCase();

    for (const a of assignments) {
      const represented = students.some(s => studentMatchesAssignment(s, a));
      if (!represented && !map.has(a.studentId)) {
        map.set(a.studentId, { id: a.studentId, name: a.studentName, email: a.studentEmail, level: a.studentLevel, plan: a.plan ?? '', phone: '', inStudentsTable: false, createdAt: a.createdAt });
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [students, assignments]);

  // Matching robusto alumno ↔ assignment: id (principal), email (fallback),
  // nombre (último recurso) — tolerante a mayúsculas y espacios.
  function assignmentsForStudent(s: DisplayStudent): Assignment[] {
    const sEmail = s.email?.trim().toLowerCase();
    const sName  = s.name.trim().toLowerCase();
    return assignments.filter(a =>
      a.studentId === s.id ||
      (!!a.studentEmail && !!sEmail && a.studentEmail.trim().toLowerCase() === sEmail) ||
      a.studentName.trim().toLowerCase() === sName
    );
  }

  // Unique student emails — fetch all subscription states once when the page loads.
  const subEmails = useMemo(() => {
    const set = new Set<string>();
    for (const s of allStudents) {
      const e = s.email?.trim().toLowerCase();
      if (e) set.add(e);
    }
    return [...set].sort();
  }, [allStudents]);
  const subEmailsKey = subEmails.join('|');

  // Verify subscriptions in batches of 5 (not all 90+ at once) to avoid
  // saturating our API and WooCommerce, with a live progress indicator.
  useEffect(() => {
    if (subEmails.length === 0) return;
    let cancelled = false;
    const BATCH_SIZE = 5;

    setVerifyingSubs(true);
    setSubProgress({ done: 0, total: subEmails.length });

    (async () => {
      for (let i = 0; i < subEmails.length; i += BATCH_SIZE) {
        if (cancelled) return;
        const batch = subEmails.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(async e => [e, await fetchSubInfo(e)] as const));
        if (cancelled) return;
        setSubInfo(prev => {
          const next = { ...prev };
          for (const [e, info] of results) next[e] = info;
          return next;
        });
        setSubProgress({ done: Math.min(subEmails.length, i + batch.length), total: subEmails.length });
      }
      if (!cancelled) {
        setVerifyingSubs(false);
        setSubProgress(null);
      }
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subEmailsKey]);

  // Manual re-check for a single student (e.g. after a failed verification).
  async function refreshOne(email?: string) {
    const e = email?.trim().toLowerCase();
    if (!e || refreshing.has(e)) return;
    setRefreshing(prev => new Set(prev).add(e));
    const info = await fetchSubInfo(e);
    setSubInfo(prev => ({ ...prev, [e]: info }));
    setRefreshing(prev => { const n = new Set(prev); n.delete(e); return n; });
  }

  const filtered = useMemo(() => {
    let list = allStudents;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(s => s.name.toLowerCase().includes(q) || s.email.toLowerCase().includes(q));
    }
    if (subFilter !== 'all') {
      list = list.filter(s => subCategory(subInfo[s.email?.trim().toLowerCase() ?? '']) === subFilter);
    }
    return list;
  }, [allStudents, search, subFilter, subInfo]);

  const visible = filtered.slice(0, visibleCount);

  // Abre WhatsApp con el teléfono del alumno (solo dígitos).
  function openWhatsApp(phone?: string) {
    const digits = (phone ?? '').replace(/\D/g, '');
    if (digits) window.open(`https://wa.me/${digits}`, '_blank');
  }

  // Plan a mostrar: productName de WooCommerce (principal) → producto persistido
  // → plan local (fallback).
  function planFor(s: DisplayStudent): string {
    const info = subInfo[s.email?.trim().toLowerCase() ?? ''];
    return info?.productName || s.productName || s.plan || '—';
  }

  function renderSubBadge(student: DisplayStudent) {
    const e = student.email?.trim().toLowerCase();
    if (!e) return <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>—</span>;
    const isRefreshing = refreshing.has(e);
    const info = subInfo[e];
    const b = subBadge(isRefreshing ? undefined : info);
    const showRetry = !isRefreshing && info != null && info.active === null;

    const pType = info?.productType ?? student.productType;
    const isOneTime = pType === 'one_time';
    const hasActiveAccess = info?.status === 'manual_active';
    // Pago único: "Gestionar acceso" siempre visible (admin/setter). Suscripción:
    // "✓ Activar" (override manual) solo cuando no está activa.
    const showAccess   = !isRefreshing && info != null && student.inStudentsTable && isOneTime;
    const showActivate = !isRefreshing && info != null && student.inStudentsTable && !isOneTime && subCategory(info) !== 'active';

    const openAccess = () => setAccessStudent({ ...student, productName: info?.productName ?? student.productName });

    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 12, background: b.bg, color: b.color, whiteSpace: 'nowrap' }}>
          {b.spin && <span className="drc-spinner-xs" />}
          {b.label}
        </span>
        {showRetry && (
          <button onClick={() => refreshOne(e)} title="Reintentar verificación"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 2, color: 'var(--text-muted)', fontFamily: 'inherit' }}>
            🔄
          </button>
        )}
        {showAccess && (
          <button onClick={openAccess} title="Gestionar acceso de pago único"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 3, borderRadius: 10, cursor: 'pointer', fontSize: 10, fontWeight: 700, lineHeight: 1, padding: '3px 8px', fontFamily: 'inherit', whiteSpace: 'nowrap',
              ...(hasActiveAccess
                ? { background: 'var(--bg-surface-3)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }
                : { background: 'rgba(37,99,235,0.08)', border: '1px solid rgba(37,99,235,0.4)', color: '#2563eb' }) }}>
            📅 {hasActiveAccess ? 'Modificar fecha' : 'Activar acceso'}
          </button>
        )}
        {showActivate && (
          <button onClick={() => setActivatingStudent(student)} title="Activar suscripción manualmente"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: 'rgba(30,158,58,0.08)', border: '1px solid rgba(30,158,58,0.4)', borderRadius: 10, cursor: 'pointer', fontSize: 10, fontWeight: 700, lineHeight: 1, padding: '3px 7px', color: '#1E9E3A', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
            ✓ Activar
          </button>
        )}
      </span>
    );
  }

  async function handleEditClick(s: DisplayStudent) {
    const asgn = assignmentsForStudent(s)[0] ?? null;
    let tGrid: Grid = {};
    if (asgn) {
      tGrid = await getTeacherGrid(asgn.teacherId);
    }
    setEditingAssignment(asgn);
    setTeacherGridForEdit(tGrid);
    setEditingStudent(s);
  }

  async function handleSave(updated: Student, scheduleData?: { slots: Array<{day:string;hour:string}>; startDate: string; weeklyHours: number }) {
    await updateStudent(updated);
    if (editingAssignment && scheduleData) {
      const { slots, startDate, weeklyHours } = scheduleData;
      await updateAssignmentSlots(editingAssignment.id, slots, weeklyHours);
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

  const isMobile = useIsMobile(768);
  const twoCols = !useIsMobile(1400); // 2 columnas en pantallas anchas

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }}>
      <NavBar />
      <PullToRefresh onRefresh={reloadAll}>
      <div style={{ maxWidth: twoCols ? 1400 : 900, margin: '0 auto', padding: '32px 20px 48px' }}>
        <LastUpdated />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 24 }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 4px' }}>Alumnos</h1>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>Todos los alumnos registrados y asignados.</p>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
              {filtered.length === allStudents.length
                ? `${allStudents.length} alumno${allStudents.length !== 1 ? 's' : ''}`
                : `${filtered.length} de ${allStudents.length} alumnos`}
            </div>
            {verifyingSubs && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                <span className="drc-spinner-xs" /> Verificando... {subProgress ? `${subProgress.done}/${subProgress.total}` : ''}
              </div>
            )}
          </div>
        </div>

        {/* Search — ancho completo en mobile, acotado en desktop */}
        <div style={{ marginBottom: 12 }}>
          <input value={search} onChange={e => { setSearch(e.target.value); setVisibleCount(50); }} placeholder="Buscar por nombre o email..."
            style={{ width: '100%', maxWidth: isMobile ? '100%' : 360 }} />
        </div>

        {/* Subscription filter — chips con scroll horizontal en mobile */}
        <div style={{
          display: 'flex', gap: 8, alignItems: 'center', marginBottom: 20,
          ...(isMobile
            ? { flexWrap: 'nowrap' as const, overflowX: 'auto' as const, paddingBottom: 4, WebkitOverflowScrolling: 'touch' as const }
            : { flexWrap: 'wrap' as const }),
        }}>
          {([
            { id: 'all',        label: 'Todos' },
            { id: 'active',     label: 'Activa' },
            { id: 'inactive',   label: 'Inactiva' },
            { id: 'pending',    label: 'Pendiente cancelar' },
            { id: 'unverified', label: 'Sin verificar' },
          ] as const).map(chip => (
            <button key={chip.id} onClick={() => { setSubFilter(chip.id); setVisibleCount(50); }}
              style={{ flexShrink: 0, padding: '6px 14px', borderRadius: 20, border: `1.5px solid ${subFilter === chip.id ? '#1E9E3A' : 'var(--border)'}`, background: subFilter === chip.id ? 'rgba(30,158,58,0.1)' : 'transparent', color: subFilter === chip.id ? '#1E9E3A' : 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, fontWeight: subFilter === chip.id ? 700 : 500, fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
              {chip.label}
            </button>
          ))}
        </div>

        {allStudents.length === 0 ? (
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '48px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>👤</div>
            No hay alumnos registrados todavía.<br />
            <span style={{ fontSize: 12 }}>Los alumnos se agregan cuando un setter realiza una asignación.</span>
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '32px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            Sin resultados para &quot;{search}&quot;
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: twoCols ? '1fr 1fr' : '1fr', gap: 12, alignItems: 'start' }}>
              {visible.map(s => {
                const studentAssignments = assignmentsForStudent(s);
                const horarios = studentAssignments.flatMap(a => a.slots.map(sl => `${sl.day} ${sl.hour}`)).join(', ');
                const profes = studentAssignments.map(a => a.teacherName).join(', ');
                const hasTeacher = studentAssignments.length > 0;
                const planText = planFor(s);
                const cls = classifyPlan({ studentPlan: s.plan ?? null, productName: planText === '—' ? null : planText });
                const clsStyle = planBadgeStyle(cls.type);
                const menuOpen = menuOpenId === s.id;
                const hasPhone = !!s.phone?.trim();
                return (
                  <div key={s.id} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 16 }}>
                    {/* Fila superior: avatar + nombre/email + badge suscripción + ⋮ */}
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11 }}>
                      <div style={{ width: 42, height: 42, borderRadius: '50%', background: 'rgba(30,158,58,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, color: '#1E9E3A', flexShrink: 0 }}>
                        {s.name.split(' ').map(p => p[0]).join('').toUpperCase().slice(0, 2)}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)', wordBreak: 'break-word' }}>{s.name}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', wordBreak: 'break-word' }}>{s.email || '—'}</div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                        {s.email && <div style={{ maxWidth: 200 }}>{renderSubBadge(s)}</div>}
                        {/* Menú tres puntos */}
                        <div style={{ position: 'relative', flexShrink: 0 }}>
                          <button onClick={() => setMenuOpenId(menuOpen ? null : s.id)} title="Acciones"
                            style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid var(--border)', background: menuOpen ? 'var(--bg-surface-3)' : 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 18, lineHeight: 1, fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            ⋮
                          </button>
                          {menuOpen && (
                            <>
                              <div onClick={() => setMenuOpenId(null)} style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
                              <div style={{ position: 'absolute', top: 36, right: 0, zIndex: 31, minWidth: 190, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.18)', overflow: 'hidden', padding: 4 }}>
                                {s.inStudentsTable && (
                                  <MenuItem onClick={() => { setMenuOpenId(null); handleEditClick(s); }}>✏️ Editar</MenuItem>
                                )}
                                {!hasTeacher && (
                                  <MenuItem onClick={() => { setMenuOpenId(null); router.push('/setter'); }}>🔗 Vincular</MenuItem>
                                )}
                                {hasPhone && (
                                  <MenuItem onClick={() => { setMenuOpenId(null); openWhatsApp(s.phone); }}>📱 Enviar WhatsApp</MenuItem>
                                )}
                                <MenuItem danger onClick={() => { setMenuOpenId(null); setDeletingStudent(s); }}>🗑️ Eliminar</MenuItem>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Fila secundaria: nivel · plan + clasificación */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 12 }}>
                      <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{s.level || 'Sin nivel'}</span>
                      <span style={{ color: 'var(--text-muted)' }}>·</span>
                      <span style={{ wordBreak: 'break-word', minWidth: 0 }}>{planText}</span>
                      {planText !== '—' && (
                        <span title={cls.displayName} style={{ fontSize: 10.5, fontWeight: 700, padding: '1px 8px', borderRadius: 10, background: clsStyle.bg, color: clsStyle.color, whiteSpace: 'nowrap' }}>
                          {cls.badge}
                        </span>
                      )}
                    </div>

                    {/* Fila terciaria: profesor · horarios, o "sin profesor" */}
                    <div style={{ fontSize: 12.5, marginTop: 6 }}>
                      {hasTeacher ? (
                        <span style={{ color: 'var(--text-secondary)' }}>
                          <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{profes}</span>
                          {horarios && <> · {horarios}</>}
                        </span>
                      ) : (
                        <span style={{ color: '#dc2626', fontWeight: 600 }}>Sin profesor asignado</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {filtered.length > visibleCount && (
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: 20 }}>
                <button onClick={() => setVisibleCount(c => c + 50)}
                  style={{ padding: '10px 24px', borderRadius: 10, border: '1.5px solid #1E9E3A', background: 'rgba(30,158,58,0.08)', color: '#1E9E3A', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
                  Cargar más ({filtered.length - visibleCount} restantes)
                </button>
              </div>
            )}
          </>
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

      {deletingStudent && (
        <DeleteStudentModal
          student={deletingStudent}
          onConfirm={async () => {
            const studentName = deletingStudent.name;
            const affected = await deleteStudent(deletingStudent.id, studentName, user?.username);
            // Aviso por email a los profesores afectados (server-side via API).
            const recipients = affected
              .map(t => ({ email: t.notificationEmail || t.email, name: t.name }))
              .filter(r => r.email);
            if (recipients.length > 0) {
              fetch('/api/send-cancellation-email', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ studentName, recipients }),
              }).catch(() => { /* el email no debe romper la baja */ });
            }
            setDeletingStudent(null);
          }}
          onCancel={() => setDeletingStudent(null)}
        />
      )}

      {activatingStudent && (
        <ManualActivateModal
          student={activatingStudent}
          onConfirm={async (until) => {
            await dbSetStudentManualActive(activatingStudent.id, until);
            setActivatingStudent(null);
            await reloadAll();
            // Re-verificar la suscripción: ahora devolverá "manual_override".
            await refreshOne(activatingStudent.email);
          }}
          onCancel={() => setActivatingStudent(null)}
        />
      )}

      {accessStudent && (
        <AccessModal
          student={accessStudent}
          onConfirm={async (until) => {
            await dbActivateOneTimeAccess(accessStudent.id, accessStudent.name, until, accessStudent.productName ?? null);
            setAccessStudent(null);
            await reloadAll();
            await refreshOne(accessStudent.email); // ahora devolverá 'manual_active'
          }}
          onCancel={() => setAccessStudent(null)}
        />
      )}
      </PullToRefresh>
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
