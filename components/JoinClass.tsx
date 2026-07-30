'use client';
// ── "Ingresar a clase": flujo ÚNICO de acceso ─────────────────────────────────
//
// Registrar el acceso es lo que decide si una clase cuenta para el pago (primer
// factor; el segundo es el transcript), así que NO puede haber dos
// implementaciones. Este hook es la única, y la usan las dos pantallas del
// profesor que ofrecen el botón:
//   · el Calendario (/teacher → pestaña "Mis clases")
//   · la vista semanal (/clases)
//
// El flujo completo, en orden:
//   1. ¿Falta el enlace de Meet? → modal para definirlo (queda guardado en la
//      assignment, no hay que volver a ponerlo).
//   2. ¿La próxima clase es un hito (1/15/30/50)? → disclaimer con las
//      diapositivas antes de entrar.
//   3. Verificación de la suscripción del alumno (fuente única:
//      lib/useSubscriptionStatus). Si está inactiva, disclaimer con la opción de
//      entrar igual: el acceso queda marcado como `enteredWithoutActive`.
//   4. Se abre el Meet y se registra el ingreso en class_join_logs.
//
// El acceso se registra SIEMPRE con la fecha de HOY en España (`todayIso`), no
// con la fecha de la clase que se está mirando: el ingreso ocurre ahora y no se
// puede antedatar ni postdatar.

import { useState, type ReactNode } from 'react';
import { calcRegisteredClassNumber } from '@/lib/db';
import { isMilestone, getMilestoneSlides, getMilestoneCopy } from '@/lib/milestones';
import { checkSubscription, type SubscriptionInfo } from '@/lib/useSubscriptionStatus';
import type { Teacher, Student, Assignment, ClassRecord } from '@/types';

/** Lo mínimo que el flujo necesita de una clase. `TeacherClass` lo cumple. */
export interface JoinableClass {
  key: string;
  assignment: Assignment;
  studentName: string;
  hour: string;
  meetLink?: string;
}

export type LogClassJoinFn = (
  teacherId: string, teacherName: string, studentName: string,
  scheduledDate: string, scheduledTime: string,
  subscriptionStatus?: string, enteredWithoutActive?: boolean, subscriptionDaysRemaining?: number | null,
) => Promise<void>;

export interface UseClassJoinArgs {
  /** Puede venir sin resolver todavía: el flujo no hace nada hasta que llega. */
  teacher: Teacher | null | undefined;
  students: Student[];
  classRecords: ClassRecord[];
  /** Hoy en hora de España. Es la fecha con la que se registra el ingreso. */
  todayIso: string;
  logClassJoin: LogClassJoinFn;
  updateMeetLink: (assignmentId: string, link: string) => Promise<void>;
  /** Mensajes efímeros (toast del panel, aviso de la vista semanal). */
  onToast?: (msg: string, ms?: number) => void;
  /** Estado de suscripción ya verificado por la pantalla, para no repedirlo. */
  getCachedSub?: (email: string) => SubscriptionInfo | undefined;
  /** Se avisa cuando el flujo verifica un email, para que la pantalla lo cachee. */
  onSubResolved?: (email: string, info: SubscriptionInfo) => void;
}

export interface ClassJoinApi {
  /** Punto de entrada del botón "Ingresar a clase". */
  join: (c: JoinableClass) => void;
  /** Abre el modal de enlace de Meet (botón "Definir/Cambiar enlace"). */
  openLinkModal: (assignment: Assignment, value?: string) => void;
  /** Key de la clase cuya suscripción se está verificando (spinner del botón). */
  checkingKey: string | null;
  /** Clases a las que ya se ingresó en esta sesión. */
  joinedKeys: Set<string>;
  /** Email con el que se verifica la suscripción del alumno de una assignment. */
  emailFor: (a: Assignment) => string;
  /** Alumno de la tabla `students` que corresponde a una assignment. */
  studentFor: (a: Assignment) => Student | undefined;
  /** Diálogos del flujo. Montarlos UNA vez en la pantalla. */
  dialogs: ReactNode;
}

export function useClassJoin(args: UseClassJoinArgs): ClassJoinApi {
  const {
    teacher, students, classRecords, todayIso,
    logClassJoin, updateMeetLink, onToast, getCachedSub, onSubResolved,
  } = args;

  const [joinedKeys, setJoined] = useState<Set<string>>(new Set());
  const [checkingKey, setCheckingKey] = useState<string | null>(null);
  const [milestoneModal, setMilestoneModal] = useState<{ c: JoinableClass; classNumber: number } | null>(null);
  const [subModal, setSubModal] = useState<{ c: JoinableClass; status: string; daysRemaining: number | null; endDate: string | null } | null>(null);
  const [linkModal, setLinkModal] = useState<{ assignment: Assignment; value: string } | null>(null);
  const [savingLink, setSavingLink] = useState(false);

  const toast = (msg: string, ms?: number) => onToast?.(msg, ms);

  // Alumno de la tabla `students`: por email de la assignment y, si no, por nombre.
  const studentFor = (a: Assignment): Student | undefined => {
    const byEmail = a.studentEmail?.trim().toLowerCase();
    const byName = a.studentName.trim().toLowerCase();
    return (byEmail ? students.find(s => s.email?.trim().toLowerCase() === byEmail) : undefined)
        ?? students.find(s => s.name.trim().toLowerCase() === byName);
  };

  // Email para verificar la suscripción. CRÍTICO para la consistencia con el
  // panel "Alumnos": se prefiere SIEMPRE el de la tabla students (el que está en
  // WooCommerce); el de la assignment es solo el fallback.
  const emailFor = (a: Assignment): string =>
    studentFor(a)?.email?.trim().toLowerCase() || a.studentEmail?.trim().toLowerCase() || '';

  // Abre el Meet y registra el ingreso con el estado de suscripción verificado.
  function doJoin(c: JoinableClass, subscriptionStatus: string, enteredWithoutActive: boolean, daysRemaining: number | null = null) {
    if (!c.meetLink || !teacher) return;
    window.open(normalizeUrl(c.meetLink), '_blank', 'noopener,noreferrer');
    logClassJoin(teacher.id, teacher.name, c.studentName, todayIso, c.hour, subscriptionStatus, enteredWithoutActive, daysRemaining);
    setJoined(prev => new Set([...prev, c.key]));
  }

  // Si la clase a la que se va a ingresar es un hito (1/15/30/50), primero el
  // disclaimer; al confirmar sigue el flujo normal.
  function join(c: JoinableClass) {
    if (checkingKey || !teacher) return;
    if (!c.meetLink) { setLinkModal({ assignment: c.assignment, value: '' }); return; }
    const nextClass = calcRegisteredClassNumber(c.assignment, classRecords) + 1;
    if (isMilestone(nextClass)) {
      setMilestoneModal({ c, classNumber: nextClass });
      return;
    }
    proceedJoin(c);
  }

  async function proceedJoin(c: JoinableClass) {
    if (!c.meetLink || checkingKey) return;
    const email = emailFor(c.assignment);
    if (!email) {
      doJoin(c, 'not_verified', false);
      toast('No se pudo verificar la suscripción, ingreso permitido', 3000);
      return;
    }

    // El spinner solo aparece si la pantalla NO tenía ya el estado del alumno: la
    // ventana de frescura (5 min) la decide checkSubscription, que es quien posee
    // el cache. Duplicar el TTL acá era una segunda fuente de verdad de lo mismo.
    if (!getCachedSub?.(email)) setCheckingKey(c.key);
    const info = await checkSubscription(email);
    onSubResolved?.(email, info);
    setCheckingKey(null);

    if (info.active === true) {
      doJoin(c, 'active', false);
      toast('✅ Ingreso registrado');
    } else if (info.active === false) {
      setSubModal({ c, status: info.status, daysRemaining: info.daysRemaining, endDate: info.endDate });
    } else {
      doJoin(c, 'error', false);
      toast('No se pudo verificar la suscripción, ingreso permitido', 3000);
    }
  }

  // Ingreso confirmado desde el disclaimer de suscripción inactiva.
  function joinAnyway() {
    if (!subModal) return;
    doJoin(subModal.c, subModal.status, true, subModal.daysRemaining);
    setSubModal(null);
    toast('✅ Ingreso registrado');
  }

  async function saveLink() {
    if (!linkModal) return;
    setSavingLink(true);
    await updateMeetLink(linkModal.assignment.id, linkModal.value);
    setSavingLink(false);
    setLinkModal(null);
  }

  const dialogs = (
    <>
      {/* Enlace de Meet del alumno */}
      {linkModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget) setLinkModal(null); }}>
          <div style={{ background: 'var(--bg-surface)', border: '1px solid #35405a', borderRadius: 14, padding: 24, width: '100%', maxWidth: 420 }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 6 }}>
              {linkModal.assignment.meetLink ? 'Cambiar enlace' : 'Definir enlace'}
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.5 }}>
              Este enlace se usará siempre para <b style={{ color: 'var(--text-primary)' }}>{linkModal.assignment.studentName}</b>, no hace falta volver a definirlo.
            </div>
            <input
              value={linkModal.value}
              onChange={e => setLinkModal(prev => prev ? { ...prev, value: e.target.value } : null)}
              placeholder="https://meet.google.com/abc-xyz"
              autoFocus
              style={{ width: '100%', marginBottom: 16 }}
            />
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setLinkModal(null)} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
                Cancelar
              </button>
              <button onClick={saveLink} disabled={savingLink || !linkModal.value.trim()}
                style={{ flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: savingLink || !linkModal.value.trim() ? 'var(--bg-surface-3)' : '#1E9E3A', color: savingLink || !linkModal.value.trim() ? 'var(--text-muted)' : 'white', cursor: savingLink || !linkModal.value.trim() ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
                {savingLink ? 'Guardando...' : 'Guardar enlace'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Disclaimer de clase hito (1/15/30/50) */}
      {milestoneModal && (() => {
        const { c, classNumber } = milestoneModal;
        const slides = getMilestoneSlides(classNumber);
        const copy = getMilestoneCopy(classNumber, c.studentName) ?? '';
        return (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 85, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
            onClick={e => { if (e.target === e.currentTarget) setMilestoneModal(null); }}>
            <div style={{ background: '#F7F7F5', border: '2px solid #FFC400', borderRadius: 16, padding: 26, width: '100%', maxWidth: 440 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
                <span style={{ fontSize: 24, fontWeight: 800, color: '#1E9E3A' }}>🎯 Clase {classNumber}</span>
              </div>
              <div style={{ fontSize: 14, color: '#374151', fontWeight: 600, marginBottom: 14 }}>
                con {c.studentName}
              </div>
              <div style={{ fontSize: 14, color: '#374151', lineHeight: 1.6, marginBottom: 18 }}>
                {copy}
              </div>
              {slides && (
                <a href={slides} target="_blank" rel="noopener noreferrer"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '9px 16px', borderRadius: 8, border: '1.5px solid #1E9E3A', background: 'white', color: '#1E9E3A', cursor: 'pointer', fontSize: 13, fontWeight: 700, textDecoration: 'none', marginBottom: 20 }}>
                  📊 Ver diapositivas de clase {classNumber}
                </a>
              )}
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => setMilestoneModal(null)} style={{ flex: 1, padding: '11px', borderRadius: 8, border: '1px solid var(--border)', background: 'white', color: '#6b7280', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
                  Cancelar
                </button>
                <button onClick={() => { setMilestoneModal(null); proceedJoin(c); }}
                  style={{ flex: 2, padding: '11px', borderRadius: 8, border: 'none', background: '#1E9E3A', color: 'white', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
                  ✅ Entendido — Ingresar a clase
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Disclaimer de suscripción inactiva */}
      {subModal && (() => {
        const d = subDisclaimer(subModal.c.studentName, subModal.status, subModal.daysRemaining, subModal.endDate);
        return (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 85, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
            onClick={e => { if (e.target === e.currentTarget) setSubModal(null); }}>
            <div style={{ background: d.bg, border: `2px solid ${d.accent}`, borderRadius: 14, padding: 24, width: '100%', maxWidth: 420 }}>
              <div style={{ fontWeight: 700, fontSize: 17, color: d.accent, marginBottom: 12 }}>{d.title}</div>
              <div style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 18, lineHeight: 1.6 }}>
                {d.body}
              </div>
              <div style={{ fontSize: 14, color: 'var(--text-primary)', fontWeight: 600, marginBottom: 20 }}>
                ¿Seguro que deseas ingresar a la clase de todas formas?
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => setSubModal(null)} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
                  Cancelar
                </button>
                {/* "pending-cancel" sigue activo hasta la fecha → CTA con menor énfasis (outline) */}
                <button onClick={joinAnyway} style={{
                  flex: 2, padding: '10px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
                  border: d.soft ? `1.5px solid ${d.accent}` : 'none',
                  background: d.soft ? 'transparent' : d.accent,
                  color: d.soft ? d.accent : 'white',
                }}>
                  Ingresar de todas formas
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </>
  );

  return {
    join,
    openLinkModal: (assignment, value) => setLinkModal({ assignment, value: value ?? assignment.meetLink ?? '' }),
    checkingKey,
    joinedKeys,
    emailFor,
    studentFor,
    dialogs,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function normalizeUrl(url: string): string {
  const t = url.trim();
  if (!t) return t;
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

function fmtDateDMY(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

/** Copy + paleta del disclaimer de suscripción, según el estado de WooCommerce. */
export function subDisclaimer(name: string, status: string, daysRemaining: number | null, endDate: string | null):
  { title: string; body: string; accent: string; bg: string; soft: boolean } {
  switch (status) {
    case 'pending-cancel':
      if (daysRemaining != null && daysRemaining > 0) {
        return {
          title: '⏳ Suscripción pendiente de cancelar',
          body: `${name} tiene su suscripción en estado 'pendiente de cancelar'. Finaliza definitivamente en ${daysRemaining} día${daysRemaining === 1 ? '' : 's'} (el ${fmtDateDMY(endDate)}).`,
          accent: '#D97706', bg: '#FFFBEB', soft: true,
        };
      }
      return {
        title: '⏳ Suscripción pendiente de cancelar',
        body: `${name} tiene su suscripción pendiente de cancelar.`,
        accent: '#D97706', bg: '#FFFBEB', soft: true,
      };
    case 'on-hold':
      return {
        title: '⚠️ Pago pendiente',
        body: `${name} tiene un pago pendiente de procesar. Su suscripción está en espera.`,
        accent: '#ea580c', bg: 'rgba(249,115,22,0.06)', soft: false,
      };
    case 'cancelled':
      return {
        title: '❌ Suscripción cancelada',
        body: `${name} canceló su suscripción.`,
        accent: '#dc2626', bg: 'rgba(239,68,68,0.05)', soft: false,
      };
    case 'expired':
      return {
        title: '❌ Suscripción expirada',
        body: `${name} tiene su suscripción expirada.`,
        accent: '#dc2626', bg: 'rgba(239,68,68,0.05)', soft: false,
      };
    case 'not_found':
      return {
        title: '❓ Sin suscripción registrada',
        body: 'No se encontró ninguna suscripción asociada a este email en el sistema de pagos.',
        accent: '#6b7280', bg: 'rgba(107,114,128,0.06)', soft: false,
      };
    default:
      return {
        title: '⚠️ Suscripción inactiva',
        body: `${name} no cuenta con una suscripción activa en este momento.`,
        accent: '#D97706', bg: '#FFFBEB', soft: false,
      };
  }
}
