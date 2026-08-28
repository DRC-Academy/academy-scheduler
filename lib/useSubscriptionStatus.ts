// ── Fuente ÚNICA de verdad para el estado de suscripción de un alumno ──────────
//
// Toda la app (panel "Alumnos", pestaña "Próximas clases" del profesor, y
// cualquier otro lugar) debe verificar suscripciones a través de este módulo.
// Así es IMPOSIBLE que dos pantallas muestren estados distintos para el mismo
// email: comparten el mismo endpoint, la misma interpretación de la respuesta
// (badge/categoría) y el mismo cache en memoria (5 min por email).
//
// Regla de oro del EMAIL: el identificador correcto es SIEMPRE el email del
// alumno en la tabla `students` (es el que está en WooCommerce). Cuando solo se
// dispone del email guardado en la assignment, se usa como último recurso.
// Ver resolveSubscriptionEmail().

'use client';

// El mapa de estados de WooCommerce (nombre, color y si dan acceso) es el mismo
// que usan el endpoint, finanzas y las asistencias. Ver lib/subscriptionAccess.
import { WOO_STATUS, isScheduledWooStatus } from '@/lib/subscriptionAccess';
import { addCalendarMonths } from '@/lib/productUtils';

export interface SubscriptionInfo {
  active: boolean | null;                            // true=activa · false=inactiva · null=sin verificar
  status: string;                                    // 'active'|'cancelled'|'on-hold'|'expired'|'pending-cancel'|'scheduled'|'not_found'|'error'|'manual_override'|'manual_active'|'one_time_no_access'|'oritalk'
  daysRemaining: number | null;
  endDate: string | null;
  productType: 'subscription' | 'one_time' | null;
  productName: string | null;
  manualActiveUntil: string | null;
  /** Fin del acceso Oritalk. Solo viene cuando el alumno es de Oritalk y vigente. */
  oritalkUntil: string | null;
  /**
   * Plan de EMPRESA detectado en WooCommerce: duración contratada y fecha del
   * pedido. El acceso sigue viajando en `manualActiveUntil` — estos dos campos
   * solo permiten al badge decir que la fecha la calculó el sistema y no una
   * persona. null = no es un plan de empresa con duración.
   */
  companyPlanMonths: number | null;
  companyPlanStart: string | null;
  /**
   * Inicio de la suscripción ('YYYY-MM-DD'). En una suscripción 'scheduled' es
   * una fecha FUTURA, y es el dato que responde a "¿desde cuándo puede venir?".
   * El endpoint ya lo devolvía; sin traerlo hasta acá el badge no podía decirlo.
   */
  subscriptionStartDate: string | null;
  fetchedAt: number;
}

/**
 * OJO CON 'pending': acá es la CATEGORÍA DE FILTRO de "Pendiente cancelar"
 * (chip de la lista de alumnos), y NO tiene nada que ver con el estado de
 * WooCommerce 'pending' = "Pendiente de pago", que existe desde la auditoría del
 * 28/08/2026 y cae en 'inactive' como corresponde (no da acceso). Son dos cosas
 * distintas que se llaman igual: no cablear una con la otra.
 */
export type SubCategory = 'active' | 'inactive' | 'pending' | 'scheduled' | 'unverified';

// Cache compartido entre TODOS los componentes (vive en el módulo). Si "Alumnos"
// ya verificó a María, "Próximas clases" reutiliza el mismo resultado.
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos
const subscriptionCache = new Map<string, SubscriptionInfo>();

function normEmail(email?: string | null): string {
  return email?.trim().toLowerCase() ?? '';
}

const NO_EMAIL: SubscriptionInfo = {
  active: null, status: 'no_email', daysRemaining: null, endDate: null,
  productType: null, productName: null, manualActiveUntil: null, oritalkUntil: null,
  companyPlanMonths: null, companyPlanStart: null,
  subscriptionStartDate: null, fetchedAt: 0,
};

// Verifica la suscripción de un email. Usa cache (5 min) salvo `force`.
// El endpoint /api/check-subscription ya resuelve la activación manual leyendo
// students.manual_active_until en Supabase, así que no hace falta pasarla aquí:
// eso garantiza que el override manual sea idéntico en toda la app.
export async function checkSubscription(email?: string | null, force = false): Promise<SubscriptionInfo> {
  const e = normEmail(email);
  if (!e) return NO_EMAIL;

  if (!force) {
    const cached = subscriptionCache.get(e);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;
  }

  try {
    const res = await fetch(`/api/check-subscription?email=${encodeURIComponent(e)}`);
    const data = await res.json();
    const info: SubscriptionInfo = {
      active:            data.active ?? null,
      status:            data.status ?? 'error',
      daysRemaining:     data.daysRemaining ?? null,
      endDate:           data.endDate ?? null,
      productType:       data.productType ?? null,
      productName:       data.productName ?? null,
      manualActiveUntil: data.manualActiveUntil ?? null,
      oritalkUntil:      data.oritalkUntil ?? null,
      companyPlanMonths: data.companyPlanMonths ?? null,
      companyPlanStart:  data.companyPlanStart ?? null,
      subscriptionStartDate: data.subscriptionStartDate ?? null,
      fetchedAt:         Date.now(),
    };
    subscriptionCache.set(e, info);
    return info;
  } catch {
    return { active: null, status: 'error', daysRemaining: null, endDate: null, productType: null, productName: null, manualActiveUntil: null, oritalkUntil: null, companyPlanMonths: null, companyPlanStart: null, subscriptionStartDate: null, fetchedAt: Date.now() };
  }
}

// Limpia el cache: un email concreto, o todo. Llamar cuando cambia el estado
// real (baja de alumno, activación manual, webhook de WooCommerce).
export function clearSubscriptionCache(email?: string | null): void {
  if (email) subscriptionCache.delete(normEmail(email));
  else subscriptionCache.clear();
}

// Email a usar para consultar la suscripción. SIEMPRE se prefiere el de la tabla
// students (fuente de verdad en WooCommerce); la assignment es el fallback.
export function resolveSubscriptionEmail(studentEmail?: string | null, assignmentEmail?: string | null): string {
  return normEmail(studentEmail) || normEmail(assignmentEmail);
}

/**
 * Categoría para los FILTROS de la lista, no para decidir accesos.
 *
 * OJO: 'pending' es una categoría propia porque el admin quiere poder filtrarla,
 * pero esos alumnos SÍ pueden tomar clases. Para saber si alguien tiene acceso se
 * mira `info.active`, nunca esto.
 */
export function subCategory(info: SubscriptionInfo | undefined): SubCategory {
  if (!info) return 'unverified';
  // 'pending-cancel' va ANTES del check de `active`: desde que cuenta como activa
  // (que es lo correcto: el alumno pagó hasta el fin del periodo) caería en
  // 'active' y el chip "Pendiente cancelar" de la lista quedaría siempre vacío.
  if (info.status === 'pending-cancel') return 'pending';
  // 'scheduled' tiene categoría propia y NO cae en 'inactive': un alumno cuyo
  // plan todavía no empezó no es lo mismo que uno cancelado o vencido. Lo que
  // hay que hacer con él es esperar, no recuperarlo, y mezclarlos en el mismo
  // filtro obliga al admin a distinguirlos a ojo fila por fila.
  if (isScheduledWooStatus(info.status)) return 'scheduled';
  if (info.active === true) return 'active';                                    // active / manual_active / manual_override / oritalk
  if (info.active === null || info.status === 'error' || info.status === 'not_found' || info.status === 'no_email') return 'unverified';
  return 'inactive';   // cancelled, expired, on-hold, one_time_no_access (expirado o sin activar)
}

// Formatea 'YYYY-MM-DD' (o ISO) como 'DD/MM'.
function shortDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso);
  if (isNaN(d.getTime())) return '';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Badge visual del estado de suscripción. `undefined` → aún verificando (spinner).
export function subBadge(info: SubscriptionInfo | undefined): { label: string; color: string; bg: string; spin?: boolean } {
  if (!info) return { label: '...', color: 'var(--text-muted)', bg: 'var(--bg-surface-3)', spin: true };
  const green = { color: '#1E9E3A', bg: 'rgba(30,158,58,0.1)' };
  const red   = { color: '#dc2626', bg: 'rgba(239,68,68,0.1)' };
  const gray  = { color: 'var(--text-muted)', bg: 'var(--bg-surface-3)' };
  // Azul: es el único estado activo que NO viene de una compra. El mismo azul que
  // ya usa el panel de alumnos para el acceso de pago único.
  const blue  = { color: '#2563eb', bg: 'rgba(37,99,235,0.10)' };

  // ORITALK — gana sobre todo lo demás, incluso sobre una suscripción activa: es
  // una marca explícita del admin y tiene que verse a simple vista.
  if (info.status === 'oritalk') {
    const tail = info.oritalkUntil ? ` hasta ${shortDate(info.oritalkUntil)}` : '';
    return { label: `🔵 Oritalk${tail}`, ...blue };
  }

  // PAGO ÚNICO
  if (info.productType === 'one_time') {
    // PLAN DE EMPRESA: la fecha no la puso una persona, la calculó el sistema
    // desde la variación ("6 Meses") y la fecha del pedido. Distinguirlo importa
    // porque cambia quién responde si está mal: una fecha automática se arregla
    // sincronizando, una manual se arregla hablando con quien la puso.
    const m = info.companyPlanMonths;
    const planEnd = (m != null && info.companyPlanStart) ? addCalendarMonths(info.companyPlanStart, m) : null;

    if (info.status === 'manual_active' && info.manualActiveUntil) {
      const hasta = shortDate(info.manualActiveUntil);
      if (planEnd) {
        // El admin alargó por encima del plan: se respeta (criterio "nunca
        // recorta") y se dice, para que no parezca que el cálculo falló.
        return info.manualActiveUntil > planEnd
          ? { label: `🏢 Activa (plan ${m}m +margen) hasta ${hasta}`, ...green }
          : { label: `🏢 Activa (plan ${m}m) hasta ${hasta}`, ...green };
      }
      return { label: `🎯 Activo hasta ${hasta}`, ...green };
    }
    // Tenía fecha y ya pasó.
    if (info.manualActiveUntil) {
      return planEnd
        ? { label: `❌ Plan ${m}m vencido ${shortDate(info.manualActiveUntil)}`, ...red }
        : { label: '❌ Expirado', ...red };
    }
    return { label: '⚪ Sin activar', ...gray };
  }

  // SUSCRIPCIÓN (y desconocido)
  if (info.status === 'manual_override') {
    const tail = info.manualActiveUntil ? ` hasta ${shortDate(info.manualActiveUntil)}` : (info.endDate ? ` hasta ${shortDate(info.endDate)}` : '');
    return { label: `✅ Activa (manual${tail})`, ...green };
  }
  // Estados de WooCommerce: nombre, icono, color y si dan acceso salen TODOS del
  // mapa único (lib/subscriptionAccess). Acá solo se decide la coletilla, que es
  // lo único que depende de datos de este alumno y no del estado en abstracto.
  const woo = WOO_STATUS[info.status];
  if (woo) {
    // La coletilla es la FECHA que le importa a quien mira, y cambia según el
    // estado: en 'pending-cancel', hasta cuándo conserva el acceso; en
    // 'scheduled', desde cuándo lo va a tener. En el resto no hay ninguna fecha
    // que aporte algo, así que no se pone.
    const d = info.daysRemaining;
    const desde = isScheduledWooStatus(info.status) ? shortDate(info.subscriptionStartDate) : '';
    const tail = desde ? ` (empieza el ${desde})`
      : info.status === 'pending-cancel' && d != null && d > 0 ? ` (${d} día${d === 1 ? '' : 's'})`
      : '';
    return { label: `${woo.icon} ${woo.label}${tail}`, color: woo.color, bg: woo.bg };
  }
  return { label: '❓ Sin verificar', ...gray }; // error / not_found / no_email
}
