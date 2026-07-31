'use client';
// ── Panel "Mis clases" del profesor ───────────────────────────────────────────
//
// ES LA MISMA agenda que hasta ahora vivía como pestaña dentro del Calendario
// (/teacher → "Mis clases"). Se movió a ruta propia (/clases) con su botón en el
// header, sin rehacer el diseño: son las mismas tarjetas, el mismo navegador de
// día y el mismo botón "Ingresar a clase".
//
// Lo que SÍ cambió, que es lo que no se podía hacer antes:
//   · Las clases YA DADAS se ven siempre, en su sitio y con su estado, en vez de
//     quedar plegadas detrás de un desplegable (y en los días anteriores a hoy
//     se pintaban como si estuvieran por darse).
//   · Cada clase ya dada tiene "Añadir transcript", que abre el mismo modal y el
//     mismo guardado que Finanzas (components/AddClassModal).

import { useState, useEffect, useMemo, type CSSProperties } from 'react';
import { cellKey, getSpainParts, spainWallClockToEpoch } from '@/components/VisualCalendar';
import { calcRegisteredClassNumber } from '@/lib/db';
import {
  classCategoryBadge, transcriptStateOf, transcriptStateBadge, transcriptNeedsTeacher,
  type ClassTranscriptRef,
} from '@/lib/finance';
import { planFieldsOf } from '@/lib/productUtils';
import { baseCellOf } from '@/lib/cells';
import { checkSubscription, subBadge, type SubscriptionInfo } from '@/lib/useSubscriptionStatus';
import { isMilestone, getMilestoneSlides, MILESTONES, MILESTONE_SLIDES, MILESTONE_TITLES } from '@/lib/milestones';
import {
  classesForDate, recoveriesForDate, addDaysIso, isoDateLocal, dayNameFromDate, mondayIsoOf,
  rescheduledTargetFor, cancellationFor, cancellationLabel, transcriptForClass, hourLabel,
  weekDaysOf, weekRangeLabel, dayHeadingLabel,
  groupContiguousClasses, sessionHoursLabel,
  // Todas las clases de esta vista son SESIONES ya agrupadas: dos celdas
  // contiguas del mismo alumno llegan acá como una sola clase de 2h.
  type TeacherSession as TodayClass,
} from '@/lib/teacherClasses';
import { durationBadgeLabel, hourNum } from '@/lib/sessions';
import { useClassJoin } from '@/components/JoinClass';
import { AddClassModal, saveTeacherClass, ANALYSIS_FAILED_NOTICE } from '@/components/AddClassModal';
import { PresentationModal } from '@/components/PresentationModal';
import FormStatusBadge from '@/components/FormStatusBadge';
import { lookupToken, formStateOf, type FormTokenInfo } from '@/lib/formClient';
import { fmtDateDMY, stripProtocol, usePresentationSent, PresentationEmailBadge } from '@/components/teacherPanelUi';
import type { Grid, Teacher, Assignment, Student, ClassRecord, ClassRecordType, ClassJoinLog } from '@/types';

export type FormIndex = { byId: Map<string, FormTokenInfo>; byName: Map<string, FormTokenInfo> };

/** Rango a la vista: un día o la semana entera (lunes → sábado). */
type RangeMode = 'day' | 'week';

/** Filtro de la lista. 'sin_transcript' es el que cierra el pago. */
type ClassFilter = 'todas' | 'pendientes' | 'dadas' | 'sin_transcript';

const RANGE_TABS: Array<{ id: RangeMode; label: string }> = [
  { id: 'day',  label: 'Día' },
  { id: 'week', label: 'Semana' },
];

const FILTER_TABS: Array<{ id: ClassFilter; label: string }> = [
  { id: 'todas',          label: 'Todas' },
  { id: 'pendientes',     label: 'Por dar' },
  { id: 'dadas',          label: 'Ya dadas' },
  { id: 'sin_transcript', label: 'Sin transcript' },
];

// El modal "Email de presentación" se importa desde components/PresentationModal.

// ─── Materiales de clase (diapositivas por hito) ──────────────────────────────
// Desplegable discreto dentro de "Próximas clases". Cerrado por defecto; su
// estado se recuerda en localStorage. Pensado para tener los materiales a mano
// sin ocupar espacio ni distraer del flujo de clases.
function ClassMaterialsSection() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);

  useEffect(() => {
    try { if (localStorage.getItem('materials_section_open') === '1') setOpen(true); }
    catch {}
  }, []);

  function toggle() {
    setOpen(prev => {
      const next = !prev;
      try { localStorage.setItem('materials_section_open', next ? '1' : '0'); } catch {}
      return next;
    });
  }

  async function copyLink(m: number) {
    const url = MILESTONE_SLIDES[m];
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch {}
      document.body.removeChild(ta);
    }
    setCopied(m);
    setTimeout(() => setCopied(c => (c === m ? null : c)), 2000);
  }

  return (
    <div className="cm">
      <button className="cm-head" onClick={toggle} aria-expanded={open} aria-controls="cm-panel">
        <span style={{ flex: 1, minWidth: 0 }}>
          <span className="cm-title" style={{ display: 'block' }}>Materiales de clase</span>
          <span className="cm-sub">Presentaciones organizadas por hito de la trayectoria del alumno</span>
        </span>
        <span className="cm-chip">{MILESTONES.length} hitos</span>
        <span aria-hidden className={`cm-caret${open ? ' is-open' : ''}`}>▼</span>
      </button>

      {/* Contenido colapsable */}
      <div id="cm-panel" className="cm-panel" style={{ maxHeight: open ? 1600 : 0 }}>
        <ol className="cm-list">
          {MILESTONES.map((m, i) => {
            const info = MILESTONE_TITLES[m];
            const c = MILESTONE_COLORS[i % MILESTONE_COLORS.length];
            const vars = {
              '--cm-base': c.base, '--cm-soft': c.soft,
              '--cm-border': c.border, '--cm-text': c.text,
            } as CSSProperties;
            return (
              <li key={m} className="cm-item" style={vars}>
                <div className="cm-badge">
                  <span className="cm-badge-label">CLASE</span>
                  <span className="cm-badge-num">{m}</span>
                </div>
                <div className="cm-body">
                  <span className="cm-tag">{info.title}</span>
                  <span className="cm-desc">{info.description}</span>
                  <div className="cm-actions">
                    <button className="cm-btn cm-btn-primary"
                      onClick={() => window.open(MILESTONE_SLIDES[m], '_blank', 'noopener,noreferrer')}>
                      Abrir presentación
                    </button>
                    <button className={`cm-btn cm-btn-ghost${copied === m ? ' is-copied' : ''}`}
                      onClick={() => copyLink(m)}>
                      {copied === m ? 'Copiado' : 'Copiar enlace'}
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

// Un tono por hito, misma saturación/luminosidad. Se indexa por POSICIÓN en
// MILESTONES (hito 1..4), no por número de clase.
const MILESTONE_COLORS = [
  { base: '#16a34a', soft: '#eef6ef', border: '#dcecde', text: '#2f7a42' },
  { base: '#0f766e', soft: '#eaf4f2', border: '#d3e8e4', text: '#0f766e' },
  { base: '#2563eb', soft: '#eef2fb', border: '#d6e0f6', text: '#3b5b9e' },
  { base: '#7c3aed', soft: '#f2edfb', border: '#e2d6f6', text: '#6d34c9' },
] as const;

// ─── Modal "Reprogramar clase" (punto 2) ──────────────────────────────────────
const RESCHEDULE_REASONS = [
  { id: 'alumno_antic', label: 'El alumno avisó con anticipación' },
  { id: 'alumno_hora',  label: 'El alumno avisó sobre la hora' },
  { id: 'profesor',     label: 'Yo (el profesor) necesito cambiarla' },
] as const;
type RescheduleReason = typeof RESCHEDULE_REASONS[number]['id'];

function RescheduleModal({ studentName, currentDate, currentHour, saving, onConfirm, onClose }: {
  studentName: string; currentDate: string; currentHour: string; saving: boolean;
  onConfirm: (data: { reason: RescheduleReason; reasonLabel: string; newDate: string; newTime: string }) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<RescheduleReason>('alumno_antic');
  const [newDate, setNewDate] = useState('');
  const [newTime, setNewTime] = useState(currentHour || '');
  const canConfirm = !!newDate && !!newTime && !saving;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 85, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 24, width: '100%', maxWidth: 420 }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 4 }}>📅 Reprogramar clase</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 16 }}>{studentName} — {fmtDateDMY(currentDate)} {currentHour}</div>

        <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', display: 'block', marginBottom: 8 }}>¿Qué pasó con esta clase?</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 16 }}>
          {RESCHEDULE_REASONS.map(r => (
            <button key={r.id} onClick={() => setReason(r.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 12px', borderRadius: 9, textAlign: 'left', fontFamily: 'inherit', cursor: 'pointer',
                border: `1.5px solid ${reason === r.id ? '#1E9E3A' : 'var(--border)'}`,
                background: reason === r.id ? 'rgba(30,158,58,0.08)' : 'var(--bg-surface-2)',
                color: 'var(--text-primary)', fontSize: 13 }}>
              <span>{reason === r.id ? '🔘' : '⚪'}</span>{r.label}
            </button>
          ))}
        </div>
        {reason === 'alumno_hora' && (
          <div style={{ fontSize: 11.5, color: '#b45309', background: 'rgba(255,196,0,0.12)', border: '1px solid rgba(255,196,0,0.4)', borderRadius: 8, padding: '8px 12px', marginBottom: 14, lineHeight: 1.5 }}>
            ⏰ Se registrará como cancelación sobre la hora (cobrable, hasta 2 por alumno).
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 18 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Nueva fecha</label>
            <input type="date" value={newDate} onChange={e => setNewDate(e.target.value)} style={{ width: '100%' }} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Nueva hora 🇪🇸</label>
            <input type="time" value={newTime} onChange={e => setNewTime(e.target.value)} style={{ width: '100%' }} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose} disabled={saving} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: saving ? 'not-allowed' : 'pointer', fontSize: 13, fontFamily: 'inherit' }}>Cancelar</button>
          <button onClick={() => canConfirm && onConfirm({ reason, reasonLabel: RESCHEDULE_REASONS.find(r => r.id === reason)!.label, newDate, newTime })} disabled={!canConfirm}
            style={{ flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: canConfirm ? '#1E9E3A' : 'var(--bg-surface-3)', color: canConfirm ? 'white' : 'var(--text-muted)', cursor: canConfirm ? 'pointer' : 'not-allowed', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
            {saving ? 'Guardando...' : 'Reprogramar ✓'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Modal "Cancelar clase" (Bloque 4.4) ──────────────────────────────────────
function CancelClassModal({ studentName, currentDate, currentHour, saving, onConfirm, onClose }: {
  studentName: string; currentDate: string; currentHour: string; saving: boolean;
  onConfirm: (reason: string, withNotice: boolean, hoursNotice: number) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  // Horas de antelación entre AHORA y la clase. La hora de la clase es hora de
  // PARED ESPAÑOLA: con `new Date("2026-07-29T16:00:00")` se interpretaba en la
  // zona del navegador y un profesor en Argentina veía 5 horas de más, con lo que
  // se libraba de la penalización de 5 € en una franja de 5 horas.
  const classEpoch = spainWallClockToEpoch(currentDate, parseInt(currentHour || '0', 10) || 0);
  const hoursNotice = isNaN(classEpoch) ? 0 : Math.max(0, (classEpoch - Date.now()) / 3_600_000);
  const withNotice = hoursNotice > 24;
  const hoursLabel = Math.round(hoursNotice);
  const canConfirm = !!reason.trim() && !saving;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 85, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 24, width: '100%', maxWidth: 420 }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 4 }}>Cancelar clase</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 16 }}>{studentName} — {fmtDateDMY(currentDate)} {currentHour}</div>

        {withNotice ? (
          <div style={{ fontSize: 12.5, color: '#1f7a3d', background: 'rgba(30,158,58,0.08)', border: '1px solid rgba(30,158,58,0.3)', borderRadius: 8, padding: '10px 12px', marginBottom: 16, lineHeight: 1.5 }}>
            <b>Cancelación con antelación suficiente</b><br />
            Faltan {hoursLabel} horas para la clase. Esta cancelación no genera penalización.
          </div>
        ) : (
          <div style={{ fontSize: 12.5, color: '#b45309', background: 'rgba(255,196,0,0.14)', border: '1px solid rgba(255,196,0,0.5)', borderRadius: 8, padding: '10px 12px', marginBottom: 16, lineHeight: 1.5 }}>
            <b>Cancelación sin antelación suficiente</b><br />
            Faltan solo {hoursLabel} horas para la clase. Esta cancelación se registrará como falta y puede afectar a tu balance.
          </div>
        )}

        <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Motivo</label>
        <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} autoFocus
          placeholder="Explica brevemente el motivo…"
          style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1.5px solid var(--border)', background: 'var(--bg-surface-2)', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', resize: 'vertical', marginBottom: 18 }} />

        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose} disabled={saving} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: saving ? 'not-allowed' : 'pointer', fontSize: 13, fontFamily: 'inherit' }}>Cerrar</button>
          <button onClick={() => canConfirm && onConfirm(reason.trim(), withNotice, hoursNotice)} disabled={!canConfirm}
            style={{ flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: !canConfirm ? 'var(--bg-surface-3)' : withNotice ? '#1E9E3A' : '#ea580c', color: !canConfirm ? 'var(--text-muted)' : 'white', cursor: canConfirm ? 'pointer' : 'not-allowed', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
            {saving ? 'Cancelando…' : 'Confirmar cancelación'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Teacher Upcoming Classes Tab ─────────────────────────────────────────────
export function MisClasesPanel({ teacher, myAssignments, students, classRecords, classAnalyses, classJoinLogs, grid, onGridChange, updateMeetLink, logClassJoin, addRescheduleRecord, registerClassRecord, onDataChanged, formIndex, refreshFormIndex }: {
  teacher: Teacher;
  myAssignments: Assignment[];
  students: Student[];
  classRecords: ClassRecord[];
  /** Transcripts ya guardados, para saber qué clase dada sigue sin cerrar. */
  classAnalyses: ClassTranscriptRef[];
  /** Ingresos registrados, para vincular cada transcript con SU clase. */
  classJoinLogs: ClassJoinLog[];
  /** Se llama tras guardar un transcript, para refrescar los datos de la pantalla. */
  onDataChanged: () => Promise<void> | void;
  grid: Grid;
  onGridChange: (g: Grid) => Promise<void>;
  updateMeetLink: (assignmentId: string, link: string) => Promise<void>;
  logClassJoin: (teacherId: string, teacherName: string, studentName: string, scheduledDate: string, scheduledTime: string, subscriptionStatus?: string, enteredWithoutActive?: boolean, subscriptionDaysRemaining?: number | null) => Promise<void>;
  addRescheduleRecord: (p: { teacherId: string; teacherName: string; studentName: string; originalDate: string; originalTime?: string; newDate: string; newTime?: string; classType: 'reprogramada' | 'cancelacion_hora'; comment: string }) => Promise<void>;
  registerClassRecord: (teacherId: string, studentName: string, date: string, time: string | undefined, screenshotFile: File | null, classType?: import('@/types').ClassRecordType, comment?: string) => Promise<void>;
  formIndex: FormIndex;
  refreshFormIndex: () => void;
}) {
  const [rescheduleModal, setRescheduleModal] = useState<{ c: TodayClass; date: string } | null>(null);
  const [savingReschedule, setSavingReschedule] = useState(false);
  const [cancelModal, setCancelModal] = useState<{ c: TodayClass; date: string } | null>(null);
  const [savingCancel, setSavingCancel] = useState(false);
  const [presentationModal, setPresentationModal] = useState<Assignment | null>(null);
  const { isSent, markSent } = usePresentationSent(teacher.id);
  const [toast, setToast] = useState<string | null>(null);
  // Navegador de fechas: desplazamiento en días respecto de hoy (0 = hoy). En
  // modo semana las flechas lo mueven de 7 en 7, así que la fecha ancla siempre
  // cae dentro de la semana que se está mirando.
  const [dayOffset, setDayOffset] = useState(0);
  const [range, setRange] = useState<RangeMode>('day');
  const [filter, setFilter] = useState<ClassFilter>('todas');
  // Fila cuyo menú "⋯" está abierto (una sola a la vez).
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [subInfo, setSubInfo] = useState<Record<string, SubscriptionInfo>>({});
  // Clase para la que se está subiendo el transcript (abre el modal de Finanzas).
  const [transcriptFor, setTranscriptFor] = useState<{ c: TodayClass; date: string } | null>(null);
  const [saveNotice, setSaveNotice] = useState<{ title: string; body: string } | null>(null);

  // Lookup de alumnos por email/nombre para clasificar el plan con TODOS los campos
  // (plan + objetivo de la assignment + plan/producto del alumno).
  const studentByEmail = useMemo(() => {
    const m = new Map<string, Student>();
    for (const s of students) {
      if (s.email) m.set(s.email.trim().toLowerCase(), s);
      m.set(`name:${s.name.trim().toLowerCase()}`, s);
    }
    return m;
  }, [students]);
  const studentForAssignment = (a: Assignment): Student | undefined =>
    (a.studentEmail && studentByEmail.get(a.studentEmail.trim().toLowerCase())) ||
    studentByEmail.get(`name:${a.studentName.trim().toLowerCase()}`);

  // Live "now" — set on mount (avoids SSR hydration mismatch) and refreshed every
  // minute so each class's state (pasada / en curso / próxima) updates on its own.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(id);
  }, []);

  // Cierra el menú "⋯" al hacer clic fuera o pulsar Escape.
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-mc-menu]')) setOpenMenu(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenMenu(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [openMenu]);

  const refDate = now ?? new Date();

  // Current time in Spain (Europe/Madrid) — the calendar's reference timezone.
  const spain = now ? getSpainParts(now) : null;
  const currentDecimal = spain ? spain.hour + spain.minute / 60 : -1;

  // HOY es hoy EN ESPAÑA, no en la zona del navegador. Antes se mezclaban las dos
  // y un profesor fuera de España veía el día equivocado (ver dayNameFromIso).
  const todayIso = spain ? spain.dateStr : isoDateLocal(refDate);

  // Fecha visible = hoy + dayOffset, sobre la cadena para no reintroducir la zona local.
  const viewIso  = addDaysIso(todayIso, dayOffset);
  const isToday  = dayOffset === 0;

  // Flujo "Ingresar a clase" (fuente única, compartida con /clases): enlace de
  // Meet → disclaimer de hito → verificación de suscripción → registro del acceso.
  // Se le pasa el cache de suscripciones que este tab ya precargó para los badges,
  // así el botón no vuelve a pedir lo que acaba de verificar.
  const join = useClassJoin({
    teacher, students, classRecords, todayIso, logClassJoin, updateMeetLink,
    onToast: (msg, ms) => showToast(msg, ms),
    getCachedSub: email => subInfo[email],
    onSubResolved: (email, info) => setSubInfo(prev => ({ ...prev, [email]: info })),
  });
  const subEmailForAssignment = join.emailFor;

  // Días a la vista: uno en modo "Día", los seis de la semana (lun→sáb) en modo
  // "Semana". El grid del calendario no tiene domingo, así que un séptimo día
  // solo podría salir vacío.
  const visibleDays = range === 'week' ? weekDaysOf(viewIso) : [viewIso];

  type ClassStatus = 'passed' | 'inprogress' | 'next' | 'future';
  function statusOf(c: TodayClass, dateIso: string): ClassStatus {
    if (currentDecimal < 0) return 'future';        // aún sin reloj (antes de montar)
    // Un día ANTERIOR a hoy está dado entero, y uno posterior está entero por dar.
    // Antes esto devolvía 'future' para todo lo que no fuera hoy, así que las
    // clases de ayer se pintaban como si estuvieran por darse.
    if (dateIso < todayIso) return 'passed';
    if (dateIso > todayIso) return 'future';
    // Una sesión de 2h está EN CURSO durante todo su rango (17:00–19:00), no solo
    // la primera hora: `endHourNum` ya es inicio + duración.
    if (c.startHourNum <= currentDecimal && c.endHourNum > currentDecimal) return 'inprogress';
    if (c.endHourNum <= currentDecimal) return 'passed';
    return 'future';
  }

  // Reprogramación / cancelación de una clase puntual. Las dos preguntas se
  // resuelven en lib/teacherClasses: una reprogramación deja `rescheduledTo` en
  // el class_record y una cancelación no, así que hacen falta las dos consultas
  // para no dejar una clase cancelada pintada como normal, con su botón de
  // "Ingresar a clase" incluido. Son declaraciones (no const) porque el resumen
  // del día de más arriba ya las usa.
  function rescheduledFor(studentName: string, date: string) {
    return rescheduledTargetFor(classRecords, teacher.id, studentName, date);
  }
  function cancelledFor(studentName: string, date: string) {
    return cancellationFor(classRecords, teacher.id, studentName, date);
  }

  /** Transcript ya guardado de esa clase (mismo alumno, misma fecha). */
  function transcriptOf(c: TodayClass, date: string) {
    return transcriptForClass(classAnalyses, teacher.id, c.studentName, date);
  }

  /**
   * ¿Esta clase espera algo del PROFESOR respecto al transcript? Solo si falta o
   * se lo rechazaron. Una clase con el transcript en revisión ya está hecha de su
   * lado y no puede seguir contándose entre "las que le faltan": eso es lo que le
   * hacía repegar transcripts que ya estaban guardados.
   */
  function needsTranscriptFor(c: TodayClass, date: string) {
    return transcriptNeedsTeacher(transcriptStateOf(transcriptOf(c, date)));
  }

  /**
   * Ingreso ("Ingresar a clase") de esa clase concreta. Es lo que vincula el
   * transcript con la clase de forma EXPLÍCITA: al guardarlo se manda su id y
   * finanzas empareja por id en vez de adivinar por proximidad de fechas.
   */
  function joinLogOf(c: TodayClass, date: string) {
    const name = c.studentName.trim().toLowerCase();
    const mine = classJoinLogs.filter(l =>
      l.teacherId === teacher.id && l.studentName.trim().toLowerCase() === name && l.scheduledDate === date,
    );
    // Con varios ingresos el mismo día gana el que cae DENTRO de la sesión: en una
    // clase de 2h el acceso puede estar registrado a cualquiera de sus dos horas.
    return mine.find(l => {
      const h = hourNum(l.scheduledTime);
      return h >= c.startHourNum && h < c.endHourNum;
    }) ?? mine[0];
  }

  /** ¿Esta clase se dio de verdad? (no reprogramada ni cancelada) */
  function isRealClass(c: TodayClass, date: string) {
    return !rescheduledFor(c.studentName, date) && !cancelledFor(c.studentName, date);
  }

  // ── Días con sus clases, ya filtrados ────────────────────────────────────────
  // Sin useMemo a propósito: son unos pocos filtros sobre decenas de elementos.
  const dayGroups = visibleDays.map(iso => {
    // Las dos fuentes (slots recurrentes + celdas de recuperación del grid) pasan
    // por la MISMA agrupación: dos celdas contiguas del mismo alumno salen como
    // una sola card de 2h, con un botón de transcript y un solo "Ingresar".
    const all = groupContiguousClasses([
      ...classesForDate(myAssignments, iso),
      ...recoveriesForDate(grid, iso, myAssignments),
    ], teacher.id);

    const shown = all.filter(c => {
      if (filter === 'todas') return true;
      const passed = statusOf(c, iso) === 'passed';
      if (filter === 'pendientes') return !passed && isRealClass(c, iso);
      if (filter === 'dadas')      return passed && isRealClass(c, iso);
      // 'sin_transcript': lo que le falta al profesor para cobrar esas clases.
      // Las que están en revisión NO entran: ya hizo su parte.
      return passed && isRealClass(c, iso) && needsTranscriptFor(c, iso);
    });

    return { iso, all, shown };
  });

  const allVisible = dayGroups.flatMap(g => g.all.map(c => ({ c, iso: g.iso })));
  const shownCount = dayGroups.reduce((n, g) => n + g.shown.length, 0);

  // "Próxima" = la primera clase de HOY que aún no empezó, esté donde esté.
  const nextKey = (() => {
    const today = dayGroups.find(g => g.iso === todayIso);
    return today?.all.find(c => parseInt(c.hour) > currentDecimal)?.key ?? null;
  })();

  // Resumen del rango a la vista. Las clases YA DADAS no se esconden: van en la
  // lista, en su hora, con su estado.
  const passedCount  = allVisible.filter(x => statusOf(x.c, x.iso) === 'passed').length;
  const pendingCount = allVisible.length - passedCount;

  // Clases dadas que siguen sin transcript: es lo que le falta al profesor para
  // que cuenten en su pago, así que se avisa arriba del todo.
  const missingTranscripts = allVisible.filter(
    x => statusOf(x.c, x.iso) === 'passed' && isRealClass(x.c, x.iso) && needsTranscriptFor(x.c, x.iso),
  );

  // Emails de todos los alumnos a la vista (los días que se están mostrando, más
  // hoy y los dos siguientes). Si no se cubriera el rango visible, al navegar
  // lejos el badge de suscripción se quedaría cargando para siempre.
  const visibleDaysKey = visibleDays.join('|');
  const visibleEmails = useMemo(() => {
    const set = new Set<string>();
    const isos = new Set([...visibleDays, todayIso, addDaysIso(todayIso, 1), addDaysIso(todayIso, 2)]);
    for (const iso of isos) {
      for (const c of [...classesForDate(myAssignments, iso), ...recoveriesForDate(grid, iso, myAssignments)]) {
        const e = subEmailForAssignment(c.assignment);
        if (e) set.add(e);
      }
    }
    return [...set].sort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myAssignments, students, grid, visibleDaysKey, todayIso]);
  const emailsKey = visibleEmails.join('|');

  // Fetch all subscription states once when the tab opens (parallel, in-memory).
  useEffect(() => {
    if (visibleEmails.length === 0) return;
    let cancelled = false;
    Promise.all(visibleEmails.map(async e => [e, await checkSubscription(e)] as const)).then(results => {
      if (cancelled) return;
      setSubInfo(prev => {
        const next = { ...prev };
        for (const [e, info] of results) next[e] = info;
        return next;
      });
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emailsKey]);

  // Badge del estado de suscripción. Delega en la fuente única (subBadge) para
  // garantizar el MISMO texto/color que el panel "Alumnos". `undefined` → spinner.
  function subBadgeFor(email?: string): { label: string; color: string; bg: string; spin?: boolean } | null {
    const e = email?.trim().toLowerCase();
    if (!e) return null;
    return subBadge(subInfo[e]);
  }

  // Alumnos a la vista sin enlace de Meet definido (uno por assignment). Solo
  // tiene sentido avisarlo de las clases que aún se van a dar.
  const missingSeen = new Set<string>();
  const missingLinks: TodayClass[] = [];
  for (const { c, iso } of allVisible) {
    if (!c.meetLink && statusOf(c, iso) !== 'passed' && !missingSeen.has(c.assignment.id)) {
      missingSeen.add(c.assignment.id);
      missingLinks.push(c);
    }
  }
  const missingNames = missingLinks.map(c => c.studentName.split(' ')[0]);

  // Etiqueta del navegador: "Martes, 21 jul" en modo día, "27 jul — 1 ago" en
  // modo semana (con "Hoy"/"Mañana" cuando aplica).
  const dateLabel = range === 'week'
    ? weekRangeLabel(viewIso)
    : new Date(viewIso + 'T12:00:00Z').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' })
        .replace(/\.$/, '')
        .replace(/^(\w)/, m => m.toUpperCase());
  const relLabel = range === 'week'
    ? (visibleDays.includes(todayIso) ? 'Esta semana' : null)
    : dayOffset === 0 ? 'Hoy' : dayOffset === 1 ? 'Mañana' : dayOffset === -1 ? 'Ayer' : null;
  // En modo semana el botón "Hoy" ya está en la semana actual si hoy es visible.
  const atToday = range === 'week' ? visibleDays.includes(todayIso) : isToday;
  const step = range === 'week' ? 7 : 1;

  async function handleRescheduleConfirm(data: { reason: RescheduleReason; reasonLabel: string; newDate: string; newTime: string }) {
    if (!rescheduleModal) return;
    const { c, date } = rescheduleModal;
    setSavingReschedule(true);
    try {
      const classType = data.reason === 'alumno_hora' ? 'cancelacion_hora' : 'reprogramada';
      const comment = `Reprogramada para ${data.newDate}${data.newTime ? ` ${data.newTime}` : ''} — Motivo: ${data.reasonLabel}`;
      await addRescheduleRecord({
        teacherId: teacher.id, teacherName: teacher.name, studentName: c.studentName,
        originalDate: date, originalTime: c.hour,
        newDate: data.newDate, newTime: data.newTime || undefined,
        classType, comment,
      });

      // Reflejar el movimiento en el grid (best-effort, no bloquea la constancia):
      //  · celda ORIGINAL → 'reprogramada' (tachada, gris) esa semana.
      //  · celda de la NUEVA fecha/hora → 'bloqueado' (recuperación) → aparece en
      //    Próximas clases el día correcto y cuenta al darse (finanzas).
      try {
        const origDate = new Date(date + 'T00:00:00');
        const newDate  = new Date(data.newDate + 'T00:00:00');
        const newHour  = `${(data.newTime || c.hour).slice(0, 2)}:00`;
        if (!isNaN(origDate.getTime()) && !isNaN(newDate.getTime())) {
          const origKey = cellKey(dayNameFromDate(origDate), c.hour);
          const newKey  = cellKey(dayNameFromDate(newDate), newHour);
          const next: Grid = { ...grid };
          // baseCellOf: el fondo de la celda (nunca otra marca puntual), con su
          // alumno recurrente, que puede no ser el de la clase que se mueve.
          const baseOrig = grid[origKey] ? baseCellOf(grid[origKey]) : null;
          next[origKey] = {
            state: 'reprogramada', student: c.studentName,
            weekDate: mondayIsoOf(origDate),
            baseState: baseOrig ? baseOrig.state : 'ocupado',
            baseStudent: baseOrig ? baseOrig.student : c.studentName,
            rescheduledTo: data.newDate,
          };
          const baseNew = grid[newKey] ? baseCellOf(grid[newKey]) : null;
          // No pisar una clase recurrente real en la nueva celda.
          if (!baseNew || baseNew.state !== 'ocupado') {
            next[newKey] = {
              state: 'bloqueado', student: c.studentName,
              weekDate: mondayIsoOf(newDate),
              baseState: baseNew ? baseNew.state : 'libre',
              recoveryFor: date,
            };
          }
          await onGridChange(next);
        }
      } catch { /* el grid es secundario; la constancia ya quedó registrada */ }

      setRescheduleModal(null);
      showToast(`📅 Clase reprogramada para ${fmtDateDMY(data.newDate)}`);
    } finally {
      setSavingReschedule(false);
    }
  }

  async function handleCancelConfirm(reason: string, withNotice: boolean, hoursNotice: number) {
    if (!cancelModal) return;
    const { c, date } = cancelModal;
    setSavingCancel(true);
    try {
      // >24h → constancia sin penalización; <24h → falta sin aviso (penaliza -5 €).
      const classType = withNotice ? 'cancelada_con_preaviso' : 'falta_sin_aviso';
      await registerClassRecord(teacher.id, c.studentName, date, c.hour, null, classType, reason);
      // Email al alumno + aviso al admin (best-effort).
      fetch('/api/classes/cancel', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          studentEmail: subEmailForAssignment(c.assignment),
          studentName: c.studentName, teacherName: teacher.name, teacherId: teacher.id,
          dateLabel: fmtDateDMY(date), timeLabel: c.hour, hoursNotice, reason, withNotice,
        }),
      }).catch(() => {});
      setCancelModal(null);
      showToast(withNotice ? '✅ Clase cancelada — avisamos al alumno' : '⚠️ Registrada como falta — avisamos al alumno');
    } finally {
      setSavingCancel(false);
    }
  }

  function showToast(msg: string, ms = 2500) {
    setToast(msg);
    setTimeout(() => setToast(null), ms);
  }

  // Guardado del transcript de una clase ya dada. Delega en saveTeacherClass
  // (components/AddClassModal), la MISMA función que usa Finanzas: guarda el
  // transcript primero y lanza el análisis después, así una IA lenta o caída no
  // le hace perder la clase al profesor.
  async function handleSaveTranscript(
    studentName: string, date: string, time: string | undefined, transcript: string,
    classType: ClassRecordType, comment: string, hash: string, replaceId: string | null,
  ) {
    const result = await saveTeacherClass({
      teacher, myAssignments, studentName, date, time, transcript, classType, comment,
      transcriptHash: hash, replaceId, registerClassRecord,
      // Vínculo EXPLÍCITO con el ingreso de esa clase: con él, finanzas empareja
      // transcript e ingreso por id en vez de por proximidad de fechas, así que
      // la clase queda verificada por sus dos factores sin ambigüedad.
      joinLogId: transcriptFor ? joinLogOf(transcriptFor.c, transcriptFor.date)?.id ?? null : null,
      // Un solo transcript cubre TODA la sesión: la validación tiene que saber
      // que son 2 horas y no juzgarlo como si fuera una clase de 60 minutos.
      durationHours: transcriptFor?.c.durationHours ?? 1,
    });
    if (result.notice) setSaveNotice(result.notice);
    // Solo se vuelve a avisar si el informe de IA falla: la clase ya está guardada.
    result.analysis?.then(({ analyzed }) => {
      if (!analyzed) setSaveNotice(ANALYSIS_FAILED_NOTICE);
    });
    await onDataChanged();
  }

  function ClassRow({ c, status, date }: { c: TodayClass; status: ClassStatus; date: string }) {
    const passed     = status === 'passed';
    const inProgress = status === 'inprogress';
    const isNext     = status === 'next';
    // Una clase RECURRENTE se considera reprogramada si hay constancia; una fila de
    // recuperación (destino del movimiento) nunca se pinta como reprogramada.
    const rescheduledTo = c.isRecovery ? null : rescheduledFor(c.studentName, date);
    const rescheduled   = !!rescheduledTo;
    // Cancelada: constancia sin `rescheduledTo`. Se pinta igual que una
    // reprogramada (apagada y sin botón de ingreso), con su propia etiqueta.
    const cancelledType = c.isRecovery ? null : cancelledFor(c.studentName, date);
    const cancelled     = !!cancelledType;
    const cancelLabel   = cancellationLabel(cancelledType);
    // Estado inactivo = la clase no se va a dar. Agrupa reprogramada y cancelada.
    const inactive = rescheduled || cancelled;

    const hasLink = !!c.meetLink;
    // Estado REAL del transcript (fuente única, lib/finance). Antes acá bastaba
    // con que existiera texto y se pintaba "Transcript subido" en verde, mientras
    // finanzas —que además exige la validación— decía "Sin subir" de la MISMA
    // clase. El profesor veía las dos pantallas contradecirse.
    const tState = transcriptStateOf(transcriptOf(c, date));
    const tBadge = transcriptStateBadge(tState);
    // Solo es tarea suya si falta o se lo rechazaron: "en revisión" no lo es.
    const needsTranscript = transcriptNeedsTeacher(tState);
    const hoursBadge = durationBadgeLabel(c.durationHours);
    const menuId  = `${c.key}_${date}`;
    const menuOpen = openMenu === menuId;
    const sent    = isSent(c.studentName);

    // Tag de tipo de clase: la etiqueta la sigue decidiendo classCategoryBadge
    // (fuente única); acá solo se le aplica la paleta sobria de esta vista.
    const stu = studentForAssignment(c.assignment);
    const cat = classCategoryBadge(planFieldsOf(c.assignment, stu));
    const tagPalette = /ex[aá]men/i.test(cat.label)
      ? { background: '#eef1f8', color: '#3b5b9e' }
      : { background: '#eef4ef', color: '#2f6b3f' };

    const sb = subBadgeFor(subEmailForAssignment(c.assignment));
    const formInfo = lookupToken(formIndex, { id: c.assignment.studentId, name: c.studentName });
    const hasForm  = formStateOf(formInfo) !== 'none';
    const presentationSent = !!c.assignment.presentationEmailSent;
    // Botón "Enviar presentación": solo para clases normales sin presentación enviada.
    const showPresentationBtn = !passed && !inactive && !c.isRecovery && !presentationSent;
    const showPresentationSent = !passed && !inactive && !c.isRecovery && presentationSent;

    const nextClassNum = calcRegisteredClassNumber(c.assignment, classRecords) + 1;
    const slides = !passed && isMilestone(nextClassNum) ? getMilestoneSlides(nextClassNum) : null;

    const desde = (() => {
      if (!c.assignment.startDate) return null;
      const sd = new Date(c.assignment.startDate + 'T00:00:00');
      if (isNaN(sd.getTime())) return null;
      const dias = Math.max(0, Math.floor((Date.now() - sd.getTime()) / 86_400_000));
      return `Desde ${sd.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })} · ${dias} día${dias !== 1 ? 's' : ''}`;
    })();

    // Estado visual de la tarjeta. Una clase ya dada se apaga para que se vea de
    // un vistazo que pasó, y se distingue si todavía debe el transcript (entonces
    // el botón queda encendido como única acción viva) o si ya está cerrada.
    const cardClass = [
      'mc-card',
      passed && ' is-passed',
      inactive && ' is-inactive',
      passed && !inactive && (needsTranscript ? ' needs-transcript' : ' is-done'),
    ].filter(Boolean).join('');

    return (
      <div className={cardClass}>
        <div className="mc-row">
          <div className="mc-left">
            {/* Rango completo de la sesión: "17:00 - 19:00" en una clase de 2h. */}
            <div className="mc-hour">{sessionHoursLabel(c)}</div>
            <div className={`mc-accent${inProgress ? ' is-live' : isNext ? ' is-next' : ''}`} />
            <div className="mc-avatar">{c.studentName.charAt(0).toUpperCase()}</div>
          </div>

          <div className="mc-main">
            <div className="mc-nameline">
              <span className={`mc-name${inactive ? ' is-struck' : ''}`}>{c.studentName}</span>
              {/* Sesión de varias horas: una sola clase que cuenta como N. */}
              {hoursBadge && <span className="mc-badge-hours" title={`Sesión de ${c.durationHours} horas seguidas · cuenta como ${c.billingUnits} clases`}>{hoursBadge}</span>}
              {c.isRecovery && <span className="mc-badge-recovery">Recuperación</span>}
              {rescheduled && <span className="mc-badge-resched">Reprogramada → {fmtDateDMY(rescheduledTo)}</span>}
              {cancelled && <span className="mc-badge-resched">{cancelLabel}</span>}
              <span className="mc-tag" style={tagPalette}>{cat.label}</span>
              {inProgress && !inactive && (
                <span className="mc-live">
                  <span className="mc-dot" style={{ background: '#16a34a' }} />En curso
                </span>
              )}
            </div>
            <div className="mc-course">{c.plan || 'Clase'}{c.level ? ` · ${c.level}` : ''}</div>
            {c.isRecovery && c.recoveryFor && <div className="mc-meta">Recupera clase del {fmtDateDMY(c.recoveryFor)}</div>}
            {desde && !c.isRecovery && <div className="mc-meta">{desde}</div>}
          </div>

          {/* Estado del enlace primero: es la información clave para el profesor. */}
          <div className="mc-right">
            {/* Una clase apagada (reprogramada o cancelada) no se dio: no se le
                pide transcript. En las demás el estado dice lo único que importa:
                antes de la clase, si el enlace está listo; después, si falta el
                transcript — en ámbar, porque es una acción pendiente. */}
            {inactive ? (
              <span className="mc-status is-muted">
                <span className="mc-dot" style={{ background: '#a4a7a1' }} />
                {rescheduled ? 'Reprogramada' : cancelLabel}
              </span>
            ) : passed ? (
              // Cuatro estados: subido / en revisión / rechazado / falta.
              <span className="mc-status" style={{ background: tBadge.bg, color: tBadge.color }}>
                <span className="mc-dot" style={{ background: tBadge.dot }} />
                {tBadge.label}
              </span>
            ) : (
              <span className={`mc-status ${hasLink ? 'is-ready' : 'is-missing'}`}>
                <span className="mc-dot" style={{ background: hasLink ? '#16a34a' : '#e0912f' }} />
                {hasLink ? 'Enlace listo' : 'Sin enlace'}
              </span>
            )}

            <div className="mc-actions">
              {rescheduled ? (
                <button className="mc-btn mc-btn-ghost" disabled>Reprogramada</button>
              ) : cancelled ? (
                <button className="mc-btn mc-btn-ghost" disabled>{cancelLabel}</button>
              ) : passed ? (
                // La clase ya se dio. Si falta el transcript (o se lo rechazaron),
                // subirlo es LA acción de la fila. Si ya está subido —esperando
                // validación o validado— el botón baja a secundario: sirve para
                // corregirlo, no para "completarlo".
                <button
                  className={`mc-btn ${needsTranscript ? 'mc-btn-primary' : 'mc-btn-ghost'}`}
                  onClick={() => setTranscriptFor({ c, date })}>
                  {tState === 'none' ? '📝 Añadir transcript'
                    : tState === 'rejected' ? '📝 Subir el correcto'
                    : 'Reemplazar transcript'}
                </button>
              ) : hasLink ? (
                <button className="mc-btn mc-btn-primary" onClick={() => join.join(c)} disabled={join.checkingKey === c.key}>
                  {join.checkingKey === c.key
                    ? <><span className="drc-spinner" />Verificando…</>
                    : 'Ingresar a clase'}
                </button>
              ) : (
                <button className="mc-btn mc-btn-primary" onClick={() => join.openLinkModal(c.assignment, '')}>
                  Definir enlace
                </button>
              )}

              <div className="mc-menu-wrap" data-mc-menu>
                <button className="mc-more" aria-haspopup="menu" aria-expanded={menuOpen} aria-label={`Más acciones para ${c.studentName}`}
                  onClick={() => setOpenMenu(menuOpen ? null : menuId)}>
                  ⋯
                </button>
                {menuOpen && (
                  <div className="mc-menu" role="menu">
                    <button className="mc-menu-item" role="menuitem"
                      onClick={() => { setOpenMenu(null); setRescheduleModal({ c, date }); }}>
                      Reprogramar clase
                    </button>
                    {!passed && !rescheduled && (
                      <button className="mc-menu-item" role="menuitem"
                        onClick={() => { setOpenMenu(null); setCancelModal({ c, date }); }}>
                        Cancelar clase
                      </button>
                    )}
                    <button className="mc-menu-item" role="menuitem"
                      onClick={() => { setOpenMenu(null); join.openLinkModal(c.assignment); }}>
                      {hasLink ? 'Cambiar enlace' : 'Definir enlace'}
                    </button>
                    <button className="mc-menu-item" role="menuitem"
                      onClick={() => { setOpenMenu(null); setPresentationModal(c.assignment); }}>
                      {sent ? 'Reenviar presentación' : 'Enviar presentación'}
                    </button>
                    {slides && (
                      <button className="mc-menu-item" role="menuitem"
                        onClick={() => { setOpenMenu(null); window.open(slides, '_blank', 'noopener,noreferrer'); }}>
                        Diapositivas · clase {nextClassNum}
                      </button>
                    )}
                    {hasLink && (
                      <>
                        <div className="mc-menu-sep" />
                        <div className="mc-menu-extra mc-meta" style={{ wordBreak: 'break-all' }}>
                          {stripProtocol(c.meetLink!)}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Acción secundaria: enviar la presentación si aún no se envió. */}
            {showPresentationBtn && (
              <button className="mc-pres-btn" onClick={() => setPresentationModal(c.assignment)}>
                ✉️ Enviar presentación
              </button>
            )}
            {showPresentationSent && (
              <span className="mc-pres-sent">Presentación enviada ✓</span>
            )}
          </div>
        </div>

        {/* Zona secundaria: avisos que no compiten con la acción principal. */}
        {(sb || hasForm || (showPresentationBtn)) && (
          <div className="mc-foot">
            {sb && (
              <span className="mc-status" style={{ background: sb.bg, color: sb.color }}>
                {sb.spin && <span className="drc-spinner-xs" />}
                {sb.label}
              </span>
            )}
            <FormStatusBadge
              student={{ id: c.assignment.studentId, name: c.studentName, email: c.assignment.studentEmail }}
              teacher={{ id: teacher.id, name: teacher.name }}
              assignment={{ id: c.assignment.id, plan: c.assignment.plan, level: c.assignment.studentLevel }}
              info={formInfo}
              onRefresh={refreshFormIndex}
              compact
            />
            {showPresentationBtn && <PresentationEmailBadge assignment={c.assignment} />}
          </div>
        )}
      </div>
    );
  }

  // Estado visual de la fila: promociona a "próxima" la primera de hoy sin empezar.
  function rowStatus(c: TodayClass, dateIso: string): ClassStatus {
    const s = statusOf(c, dateIso);
    if (s === 'future' && c.key === nextKey) return 'next';
    return s;
  }

  return (
    <div className="mc">
      <div className="mc-head">
        <div>
          <div className="mc-title">Mis clases</div>
          {/* Resumen del día: cuántas quedan y cuántas ya diste. Antes solo decía
              el total, que no distingue "me faltan 4" de "ya terminé". */}
          <div className="mc-count">
            {allVisible.length === 0 ? 'Sin clases' : (
              <span className="mc-summary">
                {pendingCount > 0 && (
                  <span><b>{pendingCount}</b> por dar</span>
                )}
                {passedCount > 0 && (
                  <span><b>{passedCount}</b> ya dada{passedCount === 1 ? '' : 's'}</span>
                )}
                {relLabel && <span>{relLabel}</span>}
              </span>
            )}
          </div>
        </div>

        {/* Navegador: día a día o semana a semana según el modo. */}
        <div className="mc-nav">
          <button className="mc-nav-btn" aria-label={range === 'week' ? 'Semana anterior' : 'Día anterior'}
            onClick={() => setDayOffset(o => o - step)}>‹</button>
          <span className="mc-nav-label">{dateLabel}</span>
          <button className="mc-nav-btn" aria-label={range === 'week' ? 'Semana siguiente' : 'Día siguiente'}
            onClick={() => setDayOffset(o => o + step)}>›</button>
          <button className="mc-today-btn" onClick={() => setDayOffset(0)} disabled={atToday}>Hoy</button>
        </div>
      </div>

      {/* Rango (día / semana) y filtro. La semana es lunes → sábado: el grid del
          calendario no tiene domingo, así que un séptimo día saldría vacío. */}
      <div className="mc-controls">
        <div className="mc-segment" role="tablist" aria-label="Rango">
          {RANGE_TABS.map(t => (
            <button key={t.id} role="tab" aria-selected={range === t.id}
              className={`mc-segment-btn${range === t.id ? ' is-active' : ''}`}
              onClick={() => setRange(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="mc-chips">
          {FILTER_TABS.map(f => {
            // El contador del filtro que cierra el pago se muestra siempre: es el
            // que le dice al profesor cuánto le queda por hacer.
            const badge = f.id === 'sin_transcript' && missingTranscripts.length > 0
              ? missingTranscripts.length : null;
            return (
              <button key={f.id}
                className={`mc-chip${filter === f.id ? ' is-active' : ''}${badge ? ' is-warn' : ''}`}
                onClick={() => setFilter(f.id)}>
                {f.label}{badge ? ` · ${badge}` : ''}
              </button>
            );
          })}
        </div>
      </div>

      {/* Aviso tras guardar un transcript */}
      {saveNotice && (
        <div className="mc-banner" style={{ background: '#fffdf5', borderColor: 'rgba(255,196,0,0.55)' }}>
          <div style={{ flex: 1, color: '#5f6360' }}>
            <b style={{ color: '#1a1c1a' }}>{saveNotice.title}</b> · {saveNotice.body}
          </div>
          <button className="mc-btn mc-btn-ghost" onClick={() => setSaveNotice(null)}>Cerrar</button>
        </div>
      )}

      {/* Transcripts pendientes del rango a la vista: es lo que le falta al
          profesor para que esas clases cuenten en su pago. Va arriba, no
          escondido, y el botón lleva al filtro que las aísla. */}
      {missingTranscripts.length > 0 && filter !== 'sin_transcript' && (
        <div className="mc-banner">
          <div style={{ flex: 1 }}>
            {missingTranscripts.length} clase{missingTranscripts.length !== 1 ? 's' : ''} sin transcript{' '}
            {range === 'week' ? 'esta semana' : 'este día'}:{' '}
            {[...new Set(missingTranscripts.map(x => x.c.studentName.split(' ')[0]))].join(', ')}
          </div>
          <button className="mc-btn mc-btn-ghost" onClick={() => setFilter('sin_transcript')}>
            Ver solo esas
          </button>
        </div>
      )}

      {/* Materiales de clase (diapositivas por hito) — desplegable discreto */}
      <ClassMaterialsSection />

      {/* Aviso de alumnos sin enlace definido */}
      {missingLinks.length > 0 && (
        <div className="mc-banner">
          <div style={{ flex: 1 }}>
            {missingLinks.length} alumno{missingLinks.length !== 1 ? 's' : ''} sin enlace definido: {missingNames.join(', ')}
          </div>
          <button className="mc-btn mc-btn-ghost" onClick={() => join.openLinkModal(missingLinks[0].assignment, '')}>
            Definir enlaces
          </button>
        </div>
      )}

      {/* Clases del rango. UNA sola lista por hora, con las clases dadas en su
          sitio: antes iban plegadas detrás de un desplegable y en los días
          anteriores ni siquiera existían como "dadas", así que el profesor no
          tenía dónde verlas ni dónde cerrarlas con el transcript. */}
      {allVisible.length === 0 ? (
        <div className="mc-empty">
          {range === 'week'
            ? 'No tienes clases esta semana.'
            : isToday ? 'No tienes clases hoy.' : 'No tienes clases este día.'}
        </div>
      ) : shownCount === 0 ? (
        <div className="mc-empty">
          Ninguna clase {range === 'week' ? 'de la semana' : 'del día'} coincide con este filtro.
          <div style={{ marginTop: 12 }}>
            <button className="mc-btn mc-btn-ghost" onClick={() => setFilter('todas')}>Ver todas</button>
          </div>
        </div>
      ) : range === 'day' ? (
        <div className="mc-list">
          {dayGroups[0].shown.map(c => (
            <ClassRow key={c.key} c={c} status={rowStatus(c, dayGroups[0].iso)} date={dayGroups[0].iso} />
          ))}
        </div>
      ) : (
        // Semana: las mismas tarjetas, agrupadas bajo la cabecera de cada día.
        <div className="mc-week">
          {dayGroups.filter(g => g.shown.length > 0).map(g => (
            <div key={g.iso}>
              <div className={`mc-daystrip${g.iso === todayIso ? ' is-today' : ''}`}>
                <span className="mc-daystrip-name">{dayHeadingLabel(g.iso)}</span>
                {g.iso === todayIso && <span className="mc-daystrip-hoy">Hoy</span>}
                <span className="mc-daystrip-count">
                  {g.shown.length} clase{g.shown.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="mc-list">
                {g.shown.map(c => (
                  <ClassRow key={c.key} c={c} status={rowStatus(c, g.iso)} date={g.iso} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Diálogos del flujo "Ingresar a clase": enlace de Meet, disclaimer de
          hito y disclaimer de suscripción inactiva (components/JoinClass). */}
      {join.dialogs}

      {/* Transcript de una clase ya dada. MISMO modal y mismo guardado que
          Finanzas: guarda el transcript primero y analiza después. El alumno y la
          fecha vienen bloqueados por la clase desde la que se abrió. */}
      {transcriptFor && (
        <AddClassModal
          teacher={teacher}
          myAssignments={myAssignments}
          classRecords={classRecords}
          title="Añadir transcript"
          lockClass
          initial={{
            studentName: transcriptFor.c.studentName,
            date: transcriptFor.date,
            classType: transcriptFor.c.isRecovery ? 'recuperacion' : 'normal',
            time: hourLabel(transcriptFor.c.hour),
          }}
          contextNote={
            transcriptFor.c.durationHours > 1 ? (
              // Sesión de 2h: UN transcript cubre las dos horas y cierra la clase
              // entera. No hay que subirlo dos veces.
              <>Sesión de <b>{transcriptFor.c.durationHours}h</b> con <b>{transcriptFor.c.studentName}</b> del{' '}
              <b>{fmtDateDMY(transcriptFor.date)}</b>, de <b>{sessionHoursLabel(transcriptFor.c)}</b>. Pegá
              el transcript completo: uno solo cierra toda la sesión y cuenta
              como <b>{transcriptFor.c.billingUnits} clases</b>.</>
            ) : (
              <>Clase de <b>{transcriptFor.c.studentName}</b> del <b>{fmtDateDMY(transcriptFor.date)}</b> a
              las <b>{hourLabel(transcriptFor.c.hour)}</b>. Pegá el transcript de Fathom para cerrarla.</>
            )
          }
          durationHours={transcriptFor.c.durationHours}
          onClose={() => setTranscriptFor(null)}
          onSaved={handleSaveTranscript}
        />
      )}

      {/* Presentation email modal */}
      {presentationModal && (
        <PresentationModal
          assignment={presentationModal}
          teacher={teacher}
          students={students}
          updateMeetLink={updateMeetLink}
          onClose={() => setPresentationModal(null)}
          onSent={markSent}
          onFormTokenReady={refreshFormIndex}
        />
      )}

      {/* Reschedule modal (punto 2) */}
      {rescheduleModal && (
        <RescheduleModal
          studentName={rescheduleModal.c.studentName}
          currentDate={rescheduleModal.date}
          currentHour={rescheduleModal.c.hour}
          saving={savingReschedule}
          onConfirm={handleRescheduleConfirm}
          onClose={() => setRescheduleModal(null)}
        />
      )}

      {/* Cancel modal (Bloque 4.4) */}
      {cancelModal && (
        <CancelClassModal
          studentName={cancelModal.c.studentName}
          currentDate={cancelModal.date}
          currentHour={cancelModal.c.hour}
          saving={savingCancel}
          onConfirm={handleCancelConfirm}
          onClose={() => setCancelModal(null)}
        />
      )}

      {/* Toast */}
      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: '#1E9E3A', color: 'white', padding: '10px 22px', borderRadius: 24, fontSize: 14, fontWeight: 700, zIndex: 90, boxShadow: '0 4px 16px rgba(0,0,0,0.25)' }}>
          {toast}
        </div>
      )}
    </div>
  );
}
