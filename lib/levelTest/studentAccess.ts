// ¿Puede este alumno hacer su prueba de nivel? (servidor) — REGLA ÚNICA.
//
// La usan la apertura del enlace (GET /api/level-test/[token]?peek=1) y la
// pantalla final del formulario (lib/formFinalScreen), para que el formulario
// nunca ofrezca una prueba que el enlace vaya a rechazar. No hay otra copia.
//
// Desde el 28/09/2026 la prueba de un alumno no caduca por fecha; lo que se
// quiere cerrar es la de quien se ha DADO DE BAJA. Regla (Facundo, 29/09/2026):
// manda la ASIGNACIÓN, no Woo, porque Woo y Gestión no están sincronizados y las
// altas se hacen a mano.
//
//   · Tiene alguna asignación activa           → pasa, diga lo que diga Woo.
//   · Sin asignación activa:
//       - Woo cancelled / expired               → NO pasa (la baja de verdad).
//       - Woo not_found, o sin email            → NO pasa.
//       - cualquier otro estado (active,        → pasa. 'scheduled' es un alumno
//         scheduled, pago único, on-hold,          que empieza más adelante; un
//         pending…)                                pago único es un intensivo.
//   · Falla la base o Woo no contesta           → pasa (no se deja fuera a nadie
//                                                 por un fallo nuestro).
//
// El 29/09/2026 la regla anterior ("puede tomar clases hoy") dejaba fuera a 6
// alumnos reales: 2 con la suscripción programada y 4 intensivos.
//
// Solo se mira al ABRIR el enlace: una prueba empezada siempre se puede terminar.

import { supabase } from '@/lib/supabase';
import { GET as checkSubscription } from '@/app/api/check-subscription/route';

export type LevelTestAccessReason =
  // pasa
  | 'assignment_active'
  | 'woo_active'
  | 'woo_scheduled'
  | 'woo_one_time'
  | 'woo_on_hold'
  | 'woo_pending'
  | 'woo_other'
  | 'woo_unavailable'
  | 'db_error'
  // no pasa
  | 'woo_cancelled_no_assignment'
  | 'woo_expired_no_assignment'
  | 'woo_not_found_no_assignment'
  | 'no_email_no_assignment';

export interface LevelTestAccess {
  allowed: boolean;
  reason: LevelTestAccessReason;
  /** Estado que devolvió Woo, si se llegó a preguntar. Para el registro. */
  wooStatus: string | null;
}

/** Lo que la regla necesita de fuera. Inyectable para los tests. */
export interface AccessDeps {
  /** Email del alumno (null si no tiene). Lanza si la base falla. */
  loadEmail(studentId: string): Promise<string | null>;
  /** ¿Tiene alguna asignación activa? Lanza si la base falla. */
  hasActiveAssignment(studentId: string): Promise<boolean>;
  /** Respuesta de /api/check-subscription. Lanza si no contesta. */
  checkSubscription(email: string): Promise<{ active?: boolean | null; status?: string }>;
}

const defaultDeps: AccessDeps = {
  async loadEmail(studentId) {
    const { data, error } = await supabase
      .from('students').select('email').eq('id', studentId).maybeSingle();
    if (error) throw error;
    return (data?.email as string | null | undefined)?.trim().toLowerCase() || null;
  },
  async hasActiveAssignment(studentId) {
    const { data, error } = await supabase
      .from('assignments').select('status').eq('student_id', studentId);
    if (error) throw error;
    // Sin la columna status (migración antigua) toda asignación cuenta como activa.
    return (data ?? []).some(a => a.status == null || a.status === 'active');
  },
  async checkSubscription(email) {
    // La MISMA función que /api/check-subscription (su GET, en memoria, sin
    // salir a la red): una sola definición del estado de Woo.
    const res = await checkSubscription(
      new Request(`http://interno/api/check-subscription?email=${encodeURIComponent(email)}`),
    );
    return res.json();
  },
};

/** Motivo de un estado de Woo que deja pasar. */
function allowedWooReason(status: string | undefined): LevelTestAccessReason {
  switch (status) {
    case 'active':
    case 'pending-cancel':
    case 'manual_override':
    case 'manual_active':
    case 'oritalk':
      return 'woo_active';
    case 'scheduled': return 'woo_scheduled';
    case 'one_time_no_access': return 'woo_one_time';
    case 'on-hold': return 'woo_on_hold';
    case 'pending': return 'woo_pending';
    default: return 'woo_other';
  }
}

export async function canTakeLevelTest(
  studentId: string,
  deps: AccessDeps = defaultDeps,
): Promise<LevelTestAccess> {
  const allow = (reason: LevelTestAccessReason, wooStatus: string | null = null): LevelTestAccess =>
    ({ allowed: true, reason, wooStatus });
  const block = (reason: LevelTestAccessReason, wooStatus: string | null): LevelTestAccess => {
    // Registro para auditar cada bloqueo.
    console.warn('[studentAccess] Prueba de nivel bloqueada', { studentId, wooStatus, reason });
    return { allowed: false, reason, wooStatus };
  };

  // 1) La asignación manda. Se mira primero: si la tiene, ni se pregunta a Woo.
  try {
    if (await deps.hasActiveAssignment(studentId)) return allow('assignment_active');
  } catch (e) {
    console.error('[studentAccess] No se pudieron leer las asignaciones:', e);
    return allow('db_error');
  }

  // 2) Sin asignación activa: ¿qué dice Woo?
  let email: string | null;
  try {
    email = await deps.loadEmail(studentId);
  } catch (e) {
    console.error('[studentAccess] No se pudo leer el alumno:', e);
    return allow('db_error');
  }
  if (!email) return block('no_email_no_assignment', null);

  let woo: { active?: boolean | null; status?: string };
  try {
    woo = await deps.checkSubscription(email);
  } catch (e) {
    console.error('[studentAccess] Falló la comprobación de suscripción:', e);
    return allow('woo_unavailable');
  }

  const status = woo.status ?? null;
  // Woo no contestó (active null, status 'error'): no se castiga al alumno.
  if (woo.active == null) return allow('woo_unavailable', status);
  if (status === 'cancelled') return block('woo_cancelled_no_assignment', status);
  if (status === 'expired') return block('woo_expired_no_assignment', status);
  if (status === 'not_found') return block('woo_not_found_no_assignment', status);
  return allow(allowedWooReason(woo.status), status);
}
