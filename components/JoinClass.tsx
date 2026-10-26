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
//   4. Se abre el Meet y se registra el ingreso en class_join_logs. Lo escribe
//      el SERVIDOR (logClassJoin → /api/class-join), que guarda además la IP y
//      el user agent. Si el guardado falla, el Meet ya está abierto y el
//      profesor ve un aviso con "Reintentar": sin ingreso la clase no cuenta
//      para el pago y el chequeo de ausencias (/api/cron/ausencias) la daría por
//      falta a los 30 minutos.
//   5. Si el alumno está en riesgo de baja, ANTES de abrir el Meet se le enseña
//      al profesor el protocolo de esa clase (ver `riskFor`).
//
// PAGO PENDIENTE (lib/paymentHolds) va POR DELANTE de todo lo anterior: si el
// alumno tiene la suscripción en on-hold, sale solo ese aviso, no se abre el
// Meet y no se registra nada. Se detecta en tres puntos, por si uno llega tarde:
// la pantalla ya lo sabe (`paymentHoldFor`), la verificación de la suscripción
// dice 'on-hold', o el servidor rechaza el ingreso (/api/class-join → 409).
//
// El acceso se registra con la fecha de la CLASE (`c.date`), no con la del clic.
// No se puede antedatar ni postdatar porque el botón solo existe mientras la
// clase está abierta: el día de la clase, desde 15 minutos antes hasta el final
// (components/MisClasesPanel, `joinWindowOf`). Casi siempre las dos fechas son
// la misma; la diferencia es la clase de las 00:00 a la que se entra a las 23:50,
// que antes quedaba con la fecha del día anterior.

import { useState, type ReactNode } from 'react';
import { calcRegisteredClassNumber } from '@/lib/db';
import { isMilestone, getMilestoneSlides, getMilestoneCopy } from '@/lib/milestones';
import { checkSubscription, type SubscriptionInfo } from '@/lib/useSubscriptionStatus';
import { isPausedStatus, isPaymentHoldStatus } from '@/lib/subscriptionAccess';
import { PAYMENT_HOLD_JOIN_TITLE, PAYMENT_HOLD_JOIN_BODY } from '@/lib/paymentHolds';
import { PaymentHoldJoinError } from '@/lib/db';
import { markInterventionShown } from '@/lib/interventionsClient';
import { AVOID_ITEMS, AVOID_TITLE, ESCALATED_GUARDRAIL, NATURAL_REMINDER, type RiskBriefing } from '@/lib/interventions';
import { RISK_CAUSE_META } from '@/lib/aiTypes';
import { fmtDateDMY } from '@/lib/teacherClasses';
import type { Teacher, Student, Assignment, ClassRecord } from '@/types';
import { DefineLinkModal } from '@/components/DefineLinkModal';

/** Lo mínimo que el flujo necesita de una clase. `TeacherClass` lo cumple. */
export interface JoinableClass {
  key: string;
  /** Fecha de la clase, 'YYYY-MM-DD' (hora de España). Es la que se guarda en el ingreso. */
  date: string;
  assignment: Assignment;
  studentName: string;
  hour: string;
  meetLink?: string;
  /** Horas de la sesión (2 en un bloque de dos celdas). Lo usa la guarda de doble clic del ingreso. */
  durationHours?: number;
}

export type LogClassJoinFn = (
  teacherId: string, teacherName: string, studentName: string,
  scheduledDate: string, scheduledTime: string,
  subscriptionStatus?: string, enteredWithoutActive?: boolean, subscriptionDaysRemaining?: number | null,
  durationHours?: number,
) => Promise<void>;

export interface UseClassJoinArgs {
  /** Puede venir sin resolver todavía: el flujo no hace nada hasta que llega. */
  teacher: Teacher | null | undefined;
  students: Student[];
  classRecords: ClassRecord[];
  logClassJoin: LogClassJoinFn;
  updateMeetLink: (assignmentId: string, link: string) => Promise<void>;
  /** Se avisa tras guardar un enlace (el tutorial lo cuenta como paso cumplido). */
  onLinkSaved?: () => void;
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
  /**
   * ¿La pantalla ya sabe que esta clase está bloqueada por pago pendiente? Si
   * dice que sí, el aviso sale sin verificar nada más (es el mismo dato con el
   * que la tarjeta pinta el candado).
   */
  paymentHoldFor?: (c: JoinableClass) => boolean;
}

export interface ClassJoinApi {
  /** Punto de entrada del botón "Ingresar a clase". */
  join: (c: JoinableClass) => void;
  /** Abre el modal de enlace de Meet (botón "Definir/Cambiar enlace"). */
  openLinkModal: (assignment: Assignment) => void;
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
    teacher, students, classRecords,
    logClassJoin, updateMeetLink, onLinkSaved, onToast, getCachedSub, onSubResolved, riskFor, paymentHoldFor,
  } = args;

  const [joinedKeys, setJoined] = useState<Set<string>>(new Set());
  const [checkingKey, setCheckingKey] = useState<string | null>(null);
  const [milestoneModal, setMilestoneModal] = useState<{ c: JoinableClass; classNumber: number } | null>(null);
  const [subModal, setSubModal] = useState<{ c: JoinableClass; status: string; daysRemaining: number | null; endDate: string | null; startDate: string | null } | null>(null);
  // Protocolo pendiente de leer. El ingreso YA está registrado cuando esto se
  // abre: lo único que falta es abrir el Meet, y lo hace el botón del modal.
  const [riskModal, setRiskModal] = useState<{ c: JoinableClass; briefing: RiskBriefing } | null>(null);
  const [avoidOpen, setAvoidOpen] = useState(false);
  // Modal "Definir enlace" (components/DefineLinkModal, el mismo de Mis clases).
  const [linkModal, setLinkModal] = useState<Assignment | null>(null);
  // El ingreso no se pudo guardar: aviso con "Reintentar" (el Meet ya se abrió).
  const [saveError, setSaveError] = useState<PendingJoin | null>(null);
  // Pago pendiente: el aviso que sustituye a todos los demás.
  const [holdModal, setHoldModal] = useState<JoinableClass | null>(null);
  const [retrying, setRetrying] = useState(false);

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
  function doJoin(c: JoinableClass, subscriptionStatus: string, enteredWithoutActive: boolean, daysRemaining: number | null = null, ok?: OkToast) {
    if (!c.meetLink || !teacher) return;
    const briefing = riskFor?.(c.studentName) ?? null;
    const pending: PendingJoin = { c, subscriptionStatus, enteredWithoutActive, daysRemaining, ok };

    if (!briefing) {
      // El Meet PRIMERO y sin esperar a nada: el registro va a la red y, si el
      // window.open quedara detrás de un await, el bloqueador de pop-ups lo
      // cortaría. El registro sigue en segundo plano.
      window.open(normalizeUrl(c.meetLink), '_blank', 'noopener,noreferrer');
      void registrarIngreso(pending);
      return;
    }

    void registrarIngreso(pending);
    setAvoidOpen(false);
    setRiskModal({ c, briefing });
    // Queda constancia de QUÉ vio y CUÁNDO: es contra eso, y solo si consta que
    // se le mostró, contra lo que se audita la clase siguiente.
    if (briefing.profileId && briefing.auditable) {
      markInterventionShown(briefing.profileId).catch(() => { /* best-effort */ });
    }
  }

  /**
   * Guarda el ingreso. Solo con el guardado CONFIRMADO se da la clase por
   * ingresada y se muestra el "✅": antes el aviso salía aunque la base hubiera
   * rechazado la fila, y la clase quedaba como "no ingresó" sin que nadie lo
   * supiera. Si falla, abre el aviso con "Reintentar".
   */
  async function registrarIngreso(p: PendingJoin): Promise<boolean> {
    if (!teacher) return false;
    const { c } = p;
    try {
      // La guarda de doble clic vive en dbLogClassJoin: un segundo clic sobre la
      // misma clase (misma fecha, hora dentro del tramo) no crea otro ingreso.
      await logClassJoin(teacher.id, teacher.name, c.studentName, c.date, c.hour, p.subscriptionStatus, p.enteredWithoutActive, p.daysRemaining, c.durationHours ?? 1);
    } catch (err) {
      // El servidor lo rechazó por pago pendiente: no es un fallo que reintentar.
      // Sustituye también al protocolo de riesgo, si se había abierto.
      if (err instanceof PaymentHoldJoinError) {
        setRiskModal(null);
        setHoldModal(c);
        return false;
      }
      console.error('[ingreso] No se pudo registrar:', err);
      setSaveError(p);
      return false;
    }
    setJoined(prev => new Set([...prev, c.key]));
    if (p.ok) toast(p.ok.msg, p.ok.ms);
    return true;
  }

  async function reintentarIngreso() {
    if (!saveError || retrying) return;
    setRetrying(true);
    const p = saveError;
    setSaveError(null);
    const ok = await registrarIngreso(p);
    setRetrying(false);
    if (ok && !p.ok) toast('✅ Ingreso registrado');
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
    // Pago pendiente: antes que el enlace, el hito o cualquier otra cosa.
    if (paymentHoldFor?.(c)) { setHoldModal(c); return; }
    if (!c.meetLink) { setLinkModal(c.assignment); return; }
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
      doJoin(c, 'not_verified', false, null, { msg: 'No se pudo verificar la suscripción, ingreso permitido', ms: 3000 });
      return;
    }

    // El spinner solo aparece si la pantalla NO tenía ya el estado del alumno: la
    // ventana de frescura (5 min) la decide checkSubscription, que es quien posee
    // el cache. Duplicar el TTL acá era una segunda fuente de verdad de lo mismo.
    if (!getCachedSub?.(email)) setCheckingKey(c.key);
    const info = await checkSubscription(email);
    onSubResolved?.(email, info);
    setCheckingKey(null);

    // Pago pendiente: ni "Ingresar de todas formas" ni registro. El estado ya
    // viene resuelto (Oritalk, manual u otra suscripción activa nunca dan on-hold).
    if (isPaymentHoldStatus(info.status)) { setHoldModal(c); return; }

    if (info.active === true) {
      // Se guarda el estado REAL, no un 'active' fijo. Antes se escribía siempre
      // 'active' y con eso se perdía en el join log —y por tanto en finanzas y en
      // asistencias— si el alumno entró en 'pendiente de cancelación', por
      // Oritalk o por activación manual. Todos dan acceso, pero no son lo mismo.
      if (info.status === 'pending-cancel') {
        // Aviso informativo: NO bloquea. El alumno pagó hasta el fin del periodo.
        const hasta = info.endDate ? new Date(info.endDate) : null;
        const fecha = hasta && !isNaN(hasta.getTime())
          ? ` el ${String(hasta.getDate()).padStart(2, '0')}/${String(hasta.getMonth() + 1).padStart(2, '0')}`
          : '';
        doJoin(c, info.status, false, info.daysRemaining,
          { msg: `✅ Ingreso registrado · La suscripción se cancelará${fecha}, pero el alumno puede seguir tomando clases hasta entonces`, ms: 6000 });
      } else {
        doJoin(c, info.status, false, info.daysRemaining, { msg: '✅ Ingreso registrado' });
      }
    } else if (info.active === false) {
      setSubModal({ c, status: info.status, daysRemaining: info.daysRemaining, endDate: info.endDate, startDate: info.subscriptionStartDate });
    } else {
      doJoin(c, 'error', false, null, { msg: 'No se pudo verificar la suscripción, ingreso permitido', ms: 3000 });
    }
  }

  // Ingreso confirmado desde el disclaimer de suscripción inactiva.
  function joinAnyway() {
    if (!subModal) return;
    doJoin(subModal.c, subModal.status, true, subModal.daysRemaining, { msg: '✅ Ingreso registrado' });
    setSubModal(null);
  }

  const dialogs = (
    <>
      {/* Pago pendiente: por encima de todo y sin otra salida que "Entendido". */}
      {holdModal && (
        <div role="alertdialog" aria-labelledby="pago-pendiente-title" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 96, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget) setHoldModal(null); }}>
          <div style={{ background: 'rgba(255,247,237,1)', border: '2px solid #92400e', borderRadius: 14, padding: 24, width: '100%', maxWidth: 420 }}>
            <div id="pago-pendiente-title" style={{ fontWeight: 700, fontSize: 17, color: '#92400e', marginBottom: 6 }}>
              {PAYMENT_HOLD_JOIN_TITLE}
            </div>
            <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>{holdModal.studentName} · {holdModal.hour}</div>
            <div style={{ fontSize: 14, color: '#374151', marginBottom: 20, lineHeight: 1.6 }}>
              {PAYMENT_HOLD_JOIN_BODY}
            </div>
            <button onClick={() => setHoldModal(null)} autoFocus style={{ width: '100%', padding: '11px', borderRadius: 8, border: 'none', background: '#92400e', color: 'white', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
              Entendido
            </button>
          </div>
        </div>
      )}

      {/* El ingreso no se guardó. Va por encima de todo (también del protocolo
          de riesgo): sin esto el profesor cree que entró y la clase no cuenta. */}
      {saveError && (
        <div role="alertdialog" aria-labelledby="ingreso-error-title" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 95, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#FFFBEB', border: '2px solid #D97706', borderRadius: 14, padding: 24, width: '100%', maxWidth: 420 }}>
            <div id="ingreso-error-title" style={{ fontWeight: 700, fontSize: 17, color: '#9a3412', marginBottom: 12 }}>
              ⚠️ No se pudo registrar tu ingreso
            </div>
            <div style={{ fontSize: 14, color: '#374151', marginBottom: 20, lineHeight: 1.6 }}>
              El Meet ya se abrió, pero tu ingreso a la clase de las {saveError.c.hour} con {saveError.c.studentName} no quedó guardado.
              Sin él la clase no cuenta para el pago y puede figurar como ausencia. Revisa tu conexión y toca <b>Reintentar</b>.
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setSaveError(null)} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'white', color: '#6b7280', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
                Cerrar
              </button>
              <button onClick={reintentarIngreso} disabled={retrying} autoFocus style={{ flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: '#D97706', color: 'white', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
                {retrying ? 'Guardando…' : 'Reintentar'}
              </button>
            </div>
          </div>
        </div>
      )}

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
                El alumno no ve este aviso. Es solo para ti, y son sugerencias: tú decides.
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

              {/* EL PROTOCOLO, siempre y lo primero después del contexto.
                  Ya no hay banner de "soporte se encarga": ocupaba este sitio y
                  dejaba al profesor una hora de clase por delante sin nada que
                  hacer. Lo que no hay que forzar va abajo, como guardarraíl. */}
              <div style={{ fontSize: 13.5, fontWeight: 700, color: '#1a1c1a', marginBottom: 8 }}>
                Ideas para esta clase
              </div>

              {/* La acción concreta, cuando dice algo ejecutable. */}
              {b.body && b.steps.length > 0 && (
                <div style={{ fontSize: 13.5, color: '#5f6360', lineHeight: 1.55, marginBottom: 10 }}>{b.body}</div>
              )}

              <ol style={{ margin: '0 0 16px', paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 9 }}>
                {b.steps.map((s, i) => (
                  <li key={i} style={{ fontSize: 14, color: '#374151', lineHeight: 1.55 }}>{s}</li>
                ))}
              </ol>

              {/* Caso escalado: la ÚNICA advertencia, y va después del protocolo.
                  El profesor sabe qué no forzar, pero ya sabe qué hacer. */}
              {b.escalateToSupport && (
                <div style={{ background: 'rgba(255,196,0,0.14)', border: '1px solid rgba(255,196,0,0.55)', borderRadius: 10, padding: '11px 14px', marginBottom: 16 }}>
                  <div style={{ fontSize: 13, color: '#7a5412', lineHeight: 1.55 }}>{ESCALATED_GUARDRAIL}</div>
                </div>
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

      {/* Enlace de Meet del alumno: se abre al pulsar "Ingresar a clase" sin enlace. */}
      {linkModal && (
        <DefineLinkModal
          assignment={linkModal}
          updateMeetLink={updateMeetLink}
          onClose={() => setLinkModal(null)}
          onSaved={onLinkSaved}
        />
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
        const d = subDisclaimer(subModal.c.studentName, subModal.status, subModal.daysRemaining, subModal.endDate, subModal.startDate);
        // EN PAUSA: solo el aviso, sin "Ingresar de todas formas". Sin ingreso no
        // hay join log, y sin join log la clase no existe en finanzas.
        const pausa = isPausedStatus(subModal.status);
        return (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 85, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
            onClick={e => { if (e.target === e.currentTarget) setSubModal(null); }}>
            <div style={{ background: d.bg, border: `2px solid ${d.accent}`, borderRadius: 14, padding: 24, width: '100%', maxWidth: 420 }}>
              <div style={{ fontWeight: 700, fontSize: 17, color: d.accent, marginBottom: 12 }}>{d.title}</div>
              <div style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 18, lineHeight: 1.6 }}>
                {d.body}
              </div>
              {!pausa && (
                <div style={{ fontSize: 14, color: 'var(--text-primary)', fontWeight: 600, marginBottom: 20 }}>
                  ¿Seguro que deseas ingresar a la clase de todas formas?
                </div>
              )}
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => setSubModal(null)} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
                  {pausa ? 'Entendido' : 'Cancelar'}
                </button>
                {/* "pending-cancel" sigue activo hasta la fecha → CTA con menor énfasis (outline) */}
                {!pausa && (
                <button onClick={joinAnyway} style={{
                  flex: 2, padding: '10px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
                  border: d.soft ? `1.5px solid ${d.accent}` : 'none',
                  background: d.soft ? 'transparent' : d.accent,
                  color: d.soft ? d.accent : 'white',
                }}>
                  Ingresar de todas formas
                </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </>
  );

  return {
    join,
    openLinkModal: (assignment) => setLinkModal(assignment),
    checkingKey,
    joinedKeys,
    emailFor,
    studentFor,
    dialogs,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Mensaje que se muestra cuando el ingreso quedó guardado. */
interface OkToast { msg: string; ms?: number }

/** Un ingreso a guardar (o a reintentar). */
interface PendingJoin {
  c: JoinableClass;
  subscriptionStatus: string;
  enteredWithoutActive: boolean;
  daysRemaining: number | null;
  ok?: OkToast;
}

export function normalizeUrl(url: string): string {
  const t = url.trim();
  if (!t) return t;
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

/** Copy + paleta del disclaimer de suscripción, según el estado de WooCommerce. */
export function subDisclaimer(name: string, status: string, daysRemaining: number | null, endDate: string | null, startDate?: string | null):
  { title: string; body: string; accent: string; bg: string; soft: boolean } {
  switch (status) {
    // EN PAUSA (variación "Pausa" de Woo): no se puede ingresar (el modal no
    // ofrece "Ingresar de todas formas"). Texto acordado con coordinación.
    case 'paused':
      return {
        title: '⏸️ Alumno en pausa',
        body: 'Este alumno está en pausa. Si crees que es un error, consulta con coordinación.',
        accent: '#3d2e00', bg: 'rgba(255,196,0,0.14)', soft: false,
      };
    // Suscripción PROGRAMADA: pagada, pero empieza en el futuro. No es un
    // problema de cobro ni una baja, así que no se pinta en rojo ni en ámbar: es
    // el mismo azul informativo del badge. Aun así NO da acceso, y por eso pasa
    // por este modal — lo que cambia es que la salida no es "recuperarlo", sino
    // esperar a la fecha.
    case 'scheduled': {
      const desde = fmtDateDMY(startDate);
      return {
        title: '🗓️ Suscripción programada',
        body: desde
          ? `La suscripción de ${name} todavía no empezó: arranca el ${desde}. Hasta esa fecha no puede tomar clases.`
          : `La suscripción de ${name} está programada y todavía no empezó. Hasta su fecha de inicio no puede tomar clases.`,
        accent: '#2563eb', bg: 'rgba(37,99,235,0.06)', soft: true,
      };
    }
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
