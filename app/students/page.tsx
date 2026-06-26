'use client';
import { useState, useMemo, useEffect } from 'react';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { PullToRefresh } from '@/components/PullToRefresh';
import { LastUpdated } from '@/components/LastUpdated';
import { useTeachers } from '@/lib/TeachersContext';
import { useAuth } from '@/lib/AuthContext';
import { DAYS, cellKey } from '@/components/VisualCalendar';
import { dbCheckStudentExists } from '@/lib/db';
import { Student, Grid, Assignment } from '@/types';

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

// ── Subscription status (WooCommerce) ─────────────────────────────────────────
interface SubInfo {
  active: boolean | null;
  status: string;
  daysRemaining: number | null;
  fetchedAt: number;
}
const SUB_TTL_MS = 5 * 60 * 1000;
type SubCategory = 'active' | 'inactive' | 'pending' | 'unverified';

async function fetchSubInfo(email: string): Promise<SubInfo> {
  try {
    const res = await fetch(`/api/check-subscription?email=${encodeURIComponent(email)}`);
    const data = await res.json();
    return {
      active:        data.active ?? null,
      status:        data.status ?? 'error',
      daysRemaining: data.daysRemaining ?? null,
      fetchedAt:     Date.now(),
    };
  } catch {
    return { active: null, status: 'error', daysRemaining: null, fetchedAt: Date.now() };
  }
}

function subCategory(info: SubInfo | undefined): SubCategory {
  if (!info) return 'unverified';
  if (info.active === true) return 'active';
  if (info.active === false && info.status === 'pending-cancel') return 'pending';
  if (info.active === false) return 'inactive';
  return 'unverified';
}

function subBadge(info: SubInfo | undefined): { label: string; color: string; bg: string; spin?: boolean } {
  if (!info) return { label: '...', color: 'var(--text-muted)', bg: 'var(--bg-surface-3)', spin: true };
  if (info.active === true) return { label: '✅ Activa', color: '#1E9E3A', bg: 'rgba(30,158,58,0.1)' };
  if (info.active === false && info.status === 'pending-cancel') {
    const d = info.daysRemaining;
    const tail = d != null && d > 0 ? ` (${d} día${d === 1 ? '' : 's'})` : '';
    return { label: `⏳ Pendiente${tail}`, color: '#b45309', bg: 'rgba(255,196,0,0.15)' };
  }
  if (info.active === false) return { label: '⚠️ Inactiva', color: '#ea580c', bg: 'rgba(249,115,22,0.12)' };
  return { label: '❓ Sin verificar', color: 'var(--text-muted)', bg: 'var(--bg-surface-3)' };
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
  onSave: (s: Student, scheduleData?: { slots: Array<{day:string;hour:string}>; startDate: string }) => Promise<void>;
}) {
  const [form, setForm] = useState({ name: student.name, email: student.email, level: student.level, plan: student.plan ?? '' });
  const [slots, setSlots] = useState<Array<{day:string;hour:string}>>(assignment?.slots || []);
  const [startDate, setStartDate] = useState(assignment?.startDate || '');
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
      await onSave(studentRecord, { slots, startDate });
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

                {/* Start date */}
                <div>
                  <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Fecha de inicio
                  </label>
                  <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ width: '100%' }} />
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
  const [subFilter, setSubFilter] = useState<'all' | SubCategory>('all');
  const [subInfo, setSubInfo] = useState<Record<string, SubInfo>>({});
  const [verifyingSubs, setVerifyingSubs] = useState(false);
  const [subProgress, setSubProgress] = useState<{ done: number; total: number } | null>(null);
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set());

  // Merge students from both sources: students table + assignments
  const allStudents = useMemo<DisplayStudent[]>(() => {
    const map = new Map<string, DisplayStudent>();
    for (const s of students) {
      map.set(s.id, { id: s.id, name: s.name, email: s.email, level: s.level, plan: s.plan ?? '', phone: s.phone ?? '', inStudentsTable: true, createdAt: s.createdAt });
    }
    for (const a of assignments) {
      if (!map.has(a.studentId)) {
        map.set(a.studentId, { id: a.studentId, name: a.studentName, email: a.studentEmail, level: a.studentLevel, plan: a.plan ?? '', phone: '', inStudentsTable: false, createdAt: a.createdAt });
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [students, assignments]);

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

  function renderSubBadge(email?: string) {
    const e = email?.trim().toLowerCase();
    if (!e) return <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>—</span>;
    const isRefreshing = refreshing.has(e);
    const info = subInfo[e];
    // While refreshing, force the loading look.
    const b = subBadge(isRefreshing ? undefined : info);
    // Show a manual retry only on a real failed verification (not while loading).
    const showRetry = !isRefreshing && info != null && info.active === null;
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 12, background: b.bg, color: b.color }}>
          {b.spin && <span className="drc-spinner-xs" />}
          {b.label}
        </span>
        {showRetry && (
          <button onClick={() => refreshOne(e)} title="Reintentar verificación"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 2, color: 'var(--text-muted)', fontFamily: 'inherit' }}>
            🔄
          </button>
        )}
      </span>
    );
  }

  async function handleEditClick(s: DisplayStudent) {
    const asgn = assignments.find(a => a.studentId === s.id || a.studentName === s.name) ?? null;
    let tGrid: Grid = {};
    if (asgn) {
      tGrid = await getTeacherGrid(asgn.teacherId);
    }
    setEditingAssignment(asgn);
    setTeacherGridForEdit(tGrid);
    setEditingStudent(s);
  }

  async function handleSave(updated: Student, scheduleData?: { slots: Array<{day:string;hour:string}>; startDate: string }) {
    await updateStudent(updated);
    if (editingAssignment && scheduleData) {
      const { slots, startDate } = scheduleData;
      await updateAssignmentSlots(editingAssignment.id, slots, slots.length);
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

  const thStyle = (minWidth?: number) => ({
    padding: '10px 14px', textAlign: 'left' as const,
    fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
    textTransform: 'uppercase' as const, letterSpacing: '0.04em',
    whiteSpace: 'nowrap' as const,
    minWidth: minWidth ? `${minWidth}px` : undefined,
  });

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }}>
      <NavBar />
      <PullToRefresh onRefresh={reloadAll}>
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '32px 20px 48px' }}>
        <LastUpdated />
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 4px' }}>Alumnos</h1>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>Todos los alumnos registrados y asignados.</p>
        </div>

        {/* Search */}
        <div style={{ marginBottom: 12 }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por nombre o email..." style={{ maxWidth: 360 }} />
        </div>

        {/* Subscription filter */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
          {([
            { id: 'all',        label: 'Todos' },
            { id: 'active',     label: 'Activa' },
            { id: 'inactive',   label: 'Inactiva' },
            { id: 'pending',    label: 'Pendiente cancelar' },
            { id: 'unverified', label: 'Sin verificar' },
          ] as const).map(chip => (
            <button key={chip.id} onClick={() => setSubFilter(chip.id)}
              style={{ padding: '5px 14px', borderRadius: 20, border: `1.5px solid ${subFilter === chip.id ? '#1E9E3A' : 'var(--border)'}`, background: subFilter === chip.id ? 'rgba(30,158,58,0.1)' : 'transparent', color: subFilter === chip.id ? '#1E9E3A' : 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, fontWeight: subFilter === chip.id ? 700 : 500, fontFamily: 'inherit' }}>
              {chip.label}
            </button>
          ))}
          {verifyingSubs && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', marginLeft: 4 }}>
              <span className="drc-spinner-xs" /> Verificando suscripciones...{subProgress ? ` ${subProgress.done}/${subProgress.total}` : ''}
            </span>
          )}
        </div>

        {allStudents.length === 0 ? (
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
                {filtered.length === allStudents.length
                  ? `${allStudents.length} alumno${allStudents.length !== 1 ? 's' : ''}`
                  : `${filtered.length} de ${allStudents.length} alumnos`}
              </span>
            </div>

            {filtered.length === 0 ? (
              <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                Sin resultados para &quot;{search}&quot;
              </div>
            ) : (<>
              {/* Desktop: table */}
              <div className="desk-only" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 860 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-surface-2)' }}>
                      <th style={thStyle(160)}>Nombre</th>
                      <th style={thStyle(180)}>Email</th>
                      <th style={thStyle(70)}>Nivel</th>
                      <th style={thStyle(130)}>Plan</th>
                      <th style={thStyle(110)}>Profesor</th>
                      <th style={thStyle(150)}>Suscripción</th>
                      <th style={thStyle(160)}>Horarios</th>
                      <th style={{ ...thStyle(160), textAlign: 'right' }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(s => {
                      const studentAssignments = assignments.filter(a => a.studentId === s.id || a.studentName === s.name);
                      return (
                        <tr key={s.id} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td style={{ padding: '11px 14px', minWidth: 160 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                              <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'rgba(59,130,246,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: '#93c5fd', flexShrink: 0 }}>
                                {s.name.split(' ').map(p => p[0]).join('').toUpperCase().slice(0, 2)}
                              </div>
                              <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>{s.name}</span>
                            </div>
                          </td>
                          <td style={{ padding: '11px 14px', fontSize: 12, color: 'var(--text-secondary)', minWidth: 180 }}>{s.email}</td>
                          <td style={{ padding: '11px 14px', minWidth: 70 }}>
                            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 20, background: 'rgba(167,139,250,0.15)', color: '#a78bfa', fontWeight: 600 }}>{s.level || '—'}</span>
                          </td>
                          <td style={{ padding: '11px 14px', fontSize: 12, color: 'var(--text-secondary)', minWidth: 130 }}>
                            <span style={{ display: 'block', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.plan || '—'}</span>
                          </td>
                          <td style={{ padding: '11px 14px', minWidth: 110 }}>
                            {studentAssignments.length === 0 ? (
                              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>—</span>
                            ) : (
                              <div>{studentAssignments.map((a, i) => (
                                <div key={i} style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 1, whiteSpace: 'nowrap' }}>{a.teacherName}</div>
                              ))}</div>
                            )}
                          </td>
                          <td style={{ padding: '11px 14px', minWidth: 150 }}>
                            {renderSubBadge(s.email)}
                          </td>
                          <td style={{ padding: '11px 14px', minWidth: 160 }}>
                            {studentAssignments.length === 0 ? (
                              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>—</span>
                            ) : (
                              <div>{studentAssignments.map((a, i) => (
                                <div key={i} style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 1 }}>
                                  {a.slots.map(sl => `${sl.day} ${sl.hour}`).join(', ')}
                                </div>
                              ))}</div>
                            )}
                          </td>
                          <td style={{ padding: '11px 14px', minWidth: 160 }}>
                            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                              {s.inStudentsTable && (
                                <button onClick={() => handleEditClick(s)}
                                  style={{ padding: '8px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', fontFamily: 'inherit', minHeight: 40 }}>
                                  Editar
                                </button>
                              )}
                              <button onClick={() => setDeletingStudent(s)}
                                style={{ padding: '8px 12px', borderRadius: 7, border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.08)', color: '#ef4444', cursor: 'pointer', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', fontFamily: 'inherit', minHeight: 40 }}>
                                Eliminar
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile: cards */}
              <div className="mob-only" style={{ flexDirection: 'column', gap: 0 }}>
                {filtered.map(s => {
                  const studentAssignments = assignments.filter(a => a.studentId === s.id || a.studentName === s.name);
                  return (
                    <div key={s.id} style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
                      {/* Name + avatar */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                        <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'rgba(59,130,246,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: '#93c5fd', flexShrink: 0 }}>
                          {s.name.split(' ').map(p => p[0]).join('').toUpperCase().slice(0, 2)}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.email || '—'}</div>
                        </div>
                      </div>
                      {/* Badges */}
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                        <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 20, background: 'rgba(167,139,250,0.15)', color: '#a78bfa', fontWeight: 600 }}>{s.level || '—'}</span>
                        {s.plan && <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 20, background: 'var(--bg-surface-2)', color: 'var(--text-secondary)', fontWeight: 500 }}>{s.plan}</span>}
                      </div>
                      {/* Subscription badge */}
                      {s.email && <div style={{ marginBottom: 8 }}>{renderSubBadge(s.email)}</div>}
                      {/* Assignments */}
                      {studentAssignments.map((a, i) => (
                        <div key={i} style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 2 }}>
                          👨‍🏫 {a.teacherName}
                          {a.slots.length > 0 && <span style={{ color: 'var(--text-muted)' }}> · {a.slots.map(sl => `${sl.day} ${sl.hour}`).join(', ')}</span>}
                        </div>
                      ))}
                      {/* Actions */}
                      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        {s.inStudentsTable && (
                          <button onClick={() => handleEditClick(s)}
                            style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>
                            Editar
                          </button>
                        )}
                        <button onClick={() => setDeletingStudent(s)}
                          style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.08)', color: '#ef4444', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>
                          Eliminar
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>)}
          </div>
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
            await deleteStudent(deletingStudent.id, deletingStudent.name, user?.username);
            setDeletingStudent(null);
          }}
          onCancel={() => setDeletingStudent(null)}
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
