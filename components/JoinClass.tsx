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
//   5. Si el alumno está en riesgo de baja, ANTES de abrir el Meet se le enseña
//      al profesor el protocolo de esa clase (ver `riskFor`).
//
// El acceso se registra SIEMPRE con la fecha de HOY en España (`todayIso`), no
// con la fecha de la clase que se está mirando: el ingreso ocurre ahora y no se
// puede antedatar ni postdatar.

import { useState, type ReactNode } from 'react';
import { calcRegisteredClassNumber } from '@/lib/db';
import { isMilestone, getMilestoneSlides, getMilestoneCopy } from '@/lib/milestones';
import { checkSubscription, type SubscriptionInfo } from '@/lib/useSubscriptionStatus';
import { markInterventionShown } from '@/lib/interventionsClient';
import { AVOID_ITEMS, AVOID_TITLE, ESCALATION_BANNER, NATURAL_REMINDER, type RiskBriefing } from '@/lib/interventions';
import { RISK_CAUSE_META } from '@/lib/aiTypes';
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
  /**
   * Protocolo de intervención del alumno, si está en riesgo de baja. Devolver
   * null (o no pasar la función) deja el flujo exactamente como estaba.
   */
  riskFor?: (studentName: string) => RiskBriefing | null;
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
    logClassJoin, updateMeetLink, onToast, getCachedSub, onSubResolved, riskFor,
  } = args;

  const [joinedKeys, setJoined] = useState<Set<string>>(new Set());
  const [checkingKey, setCheckingKey] = useState<string | null>(null);
  const [milestoneModal, setMilestoneModal] = useState<{ c: JoinableClass; classNumber: number } | null>(null);
  const [subModal, setSubModal] = useState<{ c: JoinableClass; status: string; daysRemaining: number | null; endDate: string | null } | null>(null);
  // Protocolo pendiente de leer. El ingreso YA está registrado cuando esto se
  // abre: lo único que falta es abrir el Meet, y lo hace el botón del modal.
  const [riskModal, setRiskModal] = useState<{ c: JoinableClass; briefing: RiskBriefing } | null>(null);
  const [avoidOpen, setAvoidOpen] = useState(false);
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

  /**
   * Registra el ingreso y abre el Meet.
   *
   * Con un alumno en riesgo el orden se INVIERTE: primero se registra el acceso
   * y el Meet lo abre el botón del pop-up. El registro no se retrasa ni depende
   * de que el profesor lea nada (la clase entra a finanzas igual, aunque cierre
   * el aviso), y abrir el Meet desde el clic del botón lo mantiene como gesto de
   * usuario, que es lo que impide que el navegador bloquee la pestaña.
   */
  function doJoin(c: JoinableClass, subscriptionStatus: string, enteredWithoutActive: boolean, daysRemaining: number | null = null) {
    if (!c.meetLink || !teacher) return;
    const briefing = riskFor?.(c.studentName) ?? null;

    if (!briefing) {
      window.open(normalizeUrl(c.meetLink), '_blank', 'noopener,noreferrer');
      registrarIngreso(c, subscriptionStatus, enteredWithoutActive, daysRemaining);
      return;
    }

    registrarIngreso(c, subscriptionStatus, enteredWithoutActive, daysRemaining);
    setAvoidOpen(false);
    setRiskModal({ c, briefing });
    // Queda constancia de QUÉ vio y CUÁNDO: es contra eso, y solo si consta que
    // se le mostró, contra lo que se audita la clase siguiente.
    if (briefing.profileId && briefing.auditable) {
      markInterventionShown(briefing.profileId).catch(() => { /* best-effort */ });
    }
  }

  function registrarIngreso(c: JoinableClass, subscriptionStatus: string, enteredWithoutActive: boolean, daysRemaining: number | null) {
    if (!teacher) return;
    logClassJoin(teacher.id, teacher.name, c.studentName, todayIso, c.hour, subscriptionStatus, enteredWithoutActive, daysRemaining);
    setJoined(prev => new Set([...prev, c.key]));
  }

  /** Botón del pop-up: el ingreso ya está registrado, solo falta abrir el Meet. */
  function abrirMeetTrasProtocolo() {
    if (!riskModal) return;
    window.open(normalizeUrl(riskModal.c.meetLink!), '_blank', 'noopener,noreferrer');
    setRiskModal(null);
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
      // Se guarda el estado REAL, no un 'active' fijo. Antes se escribía siempre
      // 'active' y con eso se perdía en el join log —y por tanto en finanzas y en
      // asistencias— si el alumno entró en 'pendiente de cancelación', por
      // Oritalk o por activación manual. Todos dan acceso, pero no son lo mismo.
      doJoin(c, info.status, false, info.daysRemaining);
      if (info.status === 'pending-cancel') {
        // Aviso informativo: NO bloquea. El alumno pagó hasta el fin del periodo.
        const hasta = info.endDate ? new Date(info.endDate) : null;
        const fecha = hasta && !isNaN(hasta.getTime())
          ? ` el ${String(hasta.getDate()).padStart(2, '0')}/${String(hasta.getMonth() + 1).padStart(2, '0')}`
          : '';
        toast(`✅ Ingreso registrado · La suscripción se cancelará${fecha}, pero el alumno puede seguir tomando clases hasta entonces`, 6000);
      } else {
        toast('✅ Ingreso registrado');
      }
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
      {/* Protocolo de intervención del alumno en riesgo.
          NO se puede cerrar por el fondo: la única salida es el botón, que es el
          que abre el Meet. El ingreso ya quedó registrado antes de abrirse. */}
      {riskModal && (() => {
        const b = riskModal.briefing;
        const rojo = b.risk === 'rojo';
        return (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
            <div style={{ background: '#F7F7F5', border: `2px solid ${rojo ? '#dc2626' : '#FFC400'}`, borderRadius: 16, padding: 26, width: '100%', maxWidth: 480, maxHeight: '88vh', overflowY: 'auto' }}>

              <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 4 }}>
                <span style={{ fontSize: 20 }} aria-hidden>{rojo ? '🔴' : '⚠️'}</span>
                <span style={{ fontSize: 17, fontWeight: 800, color: '#1a1c1a', lineHeight: 1.3 }}>
                  {b.studentName} está en riesgo de baja
                </span>
              </div>
              <div style={{ fontSize: 12.5, color: '#8b8e88', marginBottom: 16 }}>
                El alumno no ve este aviso. Es solo para ti.
              </div>

              {/* CONTEXTO de la clase anterior. Va lo PRIMERO a propósito: una
                  lista de pasos sin el motivo detrás es una orden, y se ejecuta
                  peor. El profesor entra sabiendo qué pasó la última vez. */}
              {b.previousContext && (
                <div style={{ background: 'white', border: '1px solid #e4e5e1', borderRadius: 10, padding: '11px 14px', marginBottom: 12 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 800, color: '#8b8e88', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                    En la última clase
                  </div>
                  <div style={{ fontSize: 13.5, color: '#374151', lineHeight: 1.55 }}>{b.previousContext}</div>
                  {/* Por qué la alerta sigue abierta HOY. Solo aparece cuando la
                      alerta sobrevivió a alguna clase: es el motivo actualizado,
                      no el de la clase que la abrió. */}
                  {b.stillOpenReason && (
                    <div style={{ fontSize: 13, color: '#9a6516', lineHeight: 1.55, marginTop: 8, paddingTop: 8, borderTop: '1px dashed #e4e5e1' }}>
                      <b>Sigue abierta porque:</b> {b.stillOpenReason}
                    </div>
                  )}
                  {b.cause && b.cause !== 'no_aplica' && (
                    <div style={{ display: 'inline-block', marginTop: 8, fontSize: 11.5, fontWeight: 700, color: '#5f6360', background: '#f0f1ee', borderRadius: 20, padding: '3px 11px' }}
                      title={RISK_CAUSE_META[b.cause].hint}>
                      {RISK_CAUSE_META[b.cause].label}
                    </div>
                  )}
                </div>
              )}

              {/* Escalado a soporte. NO sustituye a los pasos: soporte se ocupa
                  de la retención y el profesor, de que esta clase salga bien.
                  Antes este banner era lo único accionable que aparecía. */}
              {b.escalateToSupport && (
                <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid #dc2626', borderRadius: 10, padding: '12px 14px', marginBottom: 16 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: '#b91c1c', marginBottom: 3 }}>
                    {ESCALATION_BANNER.title}
                  </div>
                  <div style={{ fontSize: 13, color: '#7f1d1d', lineHeight: 1.55 }}>
                    {ESCALATION_BANNER.body}
                  </div>
                </div>
              )}

              <div style={{ fontSize: 13.5, fontWeight: 700, color: '#1a1c1a', marginBottom: 8 }}>
                {b.escalateToSupport ? 'Tú, en esta clase:' : 'En esta clase, prueba:'}
              </div>

              {b.steps.length > 0 ? (
                <ol style={{ margin: '0 0 16px', paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {b.steps.map((s, i) => (
                    <li key={i} style={{ fontSize: 14, color: '#374151', lineHeight: 1.55 }}>{s}</li>
                  ))}
                </ol>
              ) : (
                // Alertas anteriores a los pasos, y el aviso genérico: el texto tal cual.
                <div style={{ fontSize: 14, color: '#374151', lineHeight: 1.6, marginBottom: 16 }}>{b.body}</div>
              )}

              {b.reconnectHook && (
                <div style={{ background: 'rgba(30,158,58,0.08)', border: '1px solid rgba(30,158,58,0.35)', borderRadius: 10, padding: '11px 14px', marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#1E9E3A', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>
                    Oportunidad
                  </div>
                  <div style={{ fontSize: 13.5, color: '#374151', lineHeight: 1.55 }}>{b.reconnectHook}</div>
                </div>
              )}

              {/* Qué evitar: plegado, mismos 4 puntos que la ficha y el aviso. */}
              <button
                onClick={() => setAvoidOpen(o => !o)}
                aria-expanded={avoidOpen}
                style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', background: 'none', border: 'none', padding: '8px 0', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 700, color: '#9a6516' }}
              >
                <span aria-hidden>{avoidOpen ? '▾' : '▸'}</span> {AVOID_TITLE}
              </button>
              {avoidOpen && (
                <ul style={{ margin: '0 0 12px', paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {AVOID_ITEMS.map((item, i) => (
                    <li key={i} style={{ fontSize: 13, color: '#5f6360', lineHeight: 1.5 }}>{item}</li>
                  ))}
                </ul>
              )}

              <div style={{ fontSize: 12.5, color: '#8b8e88', lineHeight: 1.55, marginBottom: 18, fontStyle: 'italic' }}>
                {NATURAL_REMINDER}
              </div>

              <button
                onClick={abrirMeetTrasProtocolo}
                autoFocus
                style={{ width: '100%', padding: '13px', borderRadius: 10, border: 'none', background: '#1E9E3A', color: 'white', cursor: 'pointer', fontSize: 14, fontWeight: 700, fontFamily: 'inherit' }}
              >
                Entendido, unirme a la clase
              </button>
              <div style={{ fontSize: 11.5, color: '#8b8e88', textAlign: 'center', marginTop: 9 }}>
                Tu acceso a esta clase ya ha quedado registrado.
              </div>
            </div>
          </div>
        );
      })()}

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
