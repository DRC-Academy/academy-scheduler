// ── Pedidos y suscripciones de la OFERTA NUEVA → qué hacer con cada uno ──────
//
// Reglas PURAS (sin red ni base): reciben el pedido o la suscripción de Woo ya
// reducidos a lo que importa, el alumno con ese email y lo que ya se hizo antes
// con ese mismo pedido, y devuelven el evento a registrar y lo que hay que
// escribir en `students`. Las usan el webhook, el barrido diario del cron y la
// puesta al día (simular/aplicar), que no pueden discrepar.
//
//   · PAGO ÚNICO pagado (processing/completed) → activa al alumno con fecha de
//     fin = fecha de pago + meses del programa, con la regla "nunca recorta" de
//     los planes de empresa (lib/productUtils.resolveCompanyPlanUpdate).
//   · FRACCIONADO / MENSUAL → NO se toca el acceso (la suscripción manda, como
//     siempre): solo se apunta el producto en el alumno para que su cupo salga
//     de las horas del plan.
//   · SIN DATOS o producto nuevo fuera del catálogo → aviso para el admin.
//
// IDEMPOTENCIA por número de pedido: un pedido ya aplicado no se vuelve a
// aplicar aunque llegue mil veces. Así un webhook repetido no corre fechas, y si
// el admin cambia la fecha a mano después, nadie se la pisa.

import { catalogProduct, isUnknownNewProduct, type CatalogProduct, type CatalogKind } from '@/lib/productCatalog';
import { resolveCompanyPlanUpdate, addCalendarMonths } from '@/lib/productUtils';

export interface WooLineItemLite { productId: number; variationId: number; name: string }

export interface WooOrderLite {
  id: number;
  status: string;
  /** 'checkout' | 'admin' | 'subscription' (renovación) | … */
  createdVia: string | null;
  /** 'YYYY-MM-DD' (hora de la tienda = Madrid). */
  datePaid: string | null;
  dateCreated: string | null;
  email: string;
  billingName: string;
  lineItems: WooLineItemLite[];
}

export interface WooSubscriptionLite {
  id: number;
  status: string;
  parentId: number | null;
  email: string;
  billingName: string;
  lineItems: WooLineItemLite[];
  /** 'YYYY-MM-DD' — fin del programa (end_date_gmt). null en las mensuales. */
  endDate: string | null;
  startDate: string | null;
}

export interface StudentLite {
  id: string;
  name: string;
  email: string;
  manual_active_until: string | null;
  product_name: string | null;
  woo_product_id: number | null;
}

/** Lo que ya está en `woo_plan_events` para ese pedido/suscripción y producto. */
export interface ExistingEvent {
  result: PlanEventResult;
  applied_at: string | null;
}

export type PlanEventResult =
  | 'activado'        // pago único: no tenía fecha (o estaba vencida) → se le pone
  | 'ampliado'        // pago único: tenía una fecha más corta → se alarga
  | 'conserva_fecha'  // pago único: tenía una fecha más larga → se respeta la suya
  | 'sin_cambios'     // pago único: ya tenía exactamente esa fecha
  | 'vinculado'       // suscripción: se apunta el producto en el alumno (cupo)
  | 'sin_alumno'      // pagado, pero ningún alumno tiene ese email → aviso
  | 'sin_regla'       // producto sin datos o fuera del catálogo → aviso
  | 'ya_procesado'    // ya se aplicó antes: no se toca nada
  | 'reembolsado';    // se aplicó y después se canceló/reembolsó → aviso

export type SourceType = 'order' | 'subscription';

export interface PlanEvent {
  sourceType: SourceType;
  sourceId: number;
  productId: number;
  productName: string;
  kind: CatalogKind | 'desconocido';
  wooStatus: string;
  email: string;
  billingName: string;
  studentId: string | null;
  studentName: string | null;
  /** Pago único: fecha de pago (inicio del programa). */
  start: string | null;
  /** Pago único: inicio + meses. Fraccionado: end_date de la suscripción. */
  computedUntil: string | null;
  previousUntil: string | null;
  finalUntil: string | null;
  result: PlanEventResult;
  /** ¿Va a la lista de avisos del admin? */
  needsAdmin: boolean;
  note: string;
  /** Columnas de `students` a escribir. null = no se escribe nada. */
  studentWrite: Record<string, unknown> | null;
  /** ¿Cuenta como aplicado (no se repite)? */
  applies: boolean;
}

const PAID = new Set(['processing', 'completed']);
const REVERSED = new Set(['refunded', 'cancelled']);
/** Estados de suscripción en los que el alumno tiene (o va a tener) ese plan. */
const LIVE_SUB = new Set(['active', 'pending-cancel', 'on-hold', 'scheduled', 'paused']);

const dateOnly = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(t) && !t.startsWith('0000') ? t : null;
};

function base(
  sourceType: SourceType, sourceId: number, li: WooLineItemLite, c: CatalogProduct | null,
  wooStatus: string, email: string, billingName: string, student: StudentLite | null,
): PlanEvent {
  return {
    sourceType, sourceId, productId: li.productId,
    productName: li.name || c?.name || String(li.productId),
    kind: c?.kind ?? 'desconocido', wooStatus, email, billingName,
    studentId: student?.id ?? null, studentName: student?.name ?? null,
    start: null, computedUntil: null, previousUntil: student?.manual_active_until ?? null, finalUntil: student?.manual_active_until ?? null,
    result: 'sin_cambios', needsAdmin: false, note: '', studentWrite: null, applies: false,
  };
}

function sinRegla(e: PlanEvent): PlanEvent {
  return { ...e, result: 'sin_regla', needsAdmin: true, applies: true, note: `Producto sin regla: ${e.productName} — ${e.productId}` };
}

function sinAlumno(e: PlanEvent, what: string): PlanEvent {
  return {
    ...e, result: 'sin_alumno', needsAdmin: true, applies: false,
    note: `${what} de ${e.billingName || 'sin nombre'} (${e.email || 'sin email'}): ningún alumno tiene ese email`,
  };
}

/** Solo el producto del alumno, para el cupo. Nunca toca el acceso. */
function link(e: PlanEvent, student: StudentLite, productId: number): PlanEvent {
  const same = Number(student.woo_product_id ?? 0) === productId;
  return {
    ...e, result: 'vinculado', applies: true,
    note: same ? 'ya tenía este plan apuntado' : 'cupo según las horas del plan',
    studentWrite: same ? null : { woo_product_id: productId },
  };
}

/**
 * Eventos de un PEDIDO. Uno por línea relevante (del catálogo o producto nuevo
 * sin regla); las líneas de la oferta anterior no generan nada.
 *
 * Las renovaciones de suscripción (`created_via = subscription`) no generan
 * nada: de las suscripciones se ocupa planSubscriptionEvents.
 */
export function planOrderEvents(
  order: WooOrderLite,
  student: StudentLite | null,
  existing: (productId: number) => ExistingEvent | null,
  today: string,
): PlanEvent[] {
  if (order.createdVia === 'subscription') return [];
  const out: PlanEvent[] = [];

  for (const li of order.lineItems) {
    const c = catalogProduct(li.productId, li.variationId);
    if (!c && !isUnknownNewProduct(li.productId)) continue;   // oferta anterior: nada
    const productId = c?.id ?? li.productId;
    const prev = existing(productId);
    const e = base('order', order.id, { ...li, productId }, c, order.status, order.email, order.billingName, student);

    // Aplicado y después revertido: se avisa, pero NO se quita el acceso (eso
    // lo decide una persona). Una sola vez.
    if (prev?.applied_at && REVERSED.has(order.status)) {
      if (prev.result !== 'reembolsado' && c?.kind === 'pago_unico') {
        out.push({ ...e, result: 'reembolsado', needsAdmin: true, applies: true,
          note: `El pedido ${order.id} se activó y ahora está "${order.status}": revisar si hay que quitar el acceso` });
      }
      continue;
    }
    if (!PAID.has(order.status)) continue;                     // fallido, pendiente, cancelado sin aplicar
    if (prev?.applied_at) { out.push({ ...e, result: 'ya_procesado', note: 'ya se procesó este pedido' }); continue; }

    // Fraccionado y mensual: el pedido es solo el primer cobro de la suscripción,
    // y de la suscripción se ocupa planSubscriptionEvents. Si el pedido también
    // generara evento, cada aviso ("sin alumno") saldría dos veces.
    if (c?.kind === 'fraccionado' || c?.kind === 'mensual') continue;
    if (!c || c.kind === 'sin_datos') { out.push(sinRegla(e)); continue; }
    if (!student) { out.push(sinAlumno(e, `Pedido ${order.id}`)); continue; }

    // ── PAGO ÚNICO ──
    const start = dateOnly(order.datePaid) ?? dateOnly(order.dateCreated);
    const until = start && c.months ? addCalendarMonths(start, c.months) : null;
    if (!start || !until) {
      out.push({ ...e, result: 'sin_regla', needsAdmin: true, applies: false, note: `Pedido ${order.id} sin fecha de pago legible` });
      continue;
    }
    const d = resolveCompanyPlanUpdate(until, student.manual_active_until, today);
    const result: PlanEventResult =
      d.action === 'extend' ? 'ampliado'
      : d.action === 'keep_manual' ? 'conserva_fecha'
      : d.action === 'unchanged' ? 'sin_cambios'
      : 'activado';

    const write: Record<string, unknown> = { product_type: 'one_time', woo_product_id: c.id, company_plan_start: start };
    if (d.writes) write.manual_active_until = d.until;
    // El texto del plan solo se completa si no había ninguno: el LMS elige el
    // curso con ese texto y no hay por qué cambiárselo a quien ya lo tiene.
    if (!(student.product_name ?? '').trim()) { write.product_name = li.name; write.plan = li.name; }

    out.push({
      ...e, start, computedUntil: until, finalUntil: d.until, result, applies: true, studentWrite: write,
      needsAdmin: c.persons === 2,
      note: c.persons === 2 ? `Plan de 2 personas: activado ${student.name}; falta vincular a la segunda persona` : d.reason,
    });
  }
  return out;
}

/**
 * Eventos de una SUSCRIPCIÓN. El acceso NO se toca: la suscripción se resuelve
 * con la regla de siempre (lib/subscriptionAccess). Solo se apunta el producto
 * para el cupo, se registra el fin del programa fraccionado y se avisa de lo que
 * no tiene regla o no tiene alumno.
 */
export function planSubscriptionEvents(
  sub: WooSubscriptionLite,
  student: StudentLite | null,
  existing: (productId: number) => ExistingEvent | null,
): PlanEvent[] {
  if (!LIVE_SUB.has(sub.status)) return [];
  const out: PlanEvent[] = [];
  for (const li of sub.lineItems) {
    const c = catalogProduct(li.productId, li.variationId);
    if (!c && !isUnknownNewProduct(li.productId)) continue;
    const productId = c?.id ?? li.productId;
    const prev = existing(productId);
    const e = { ...base('subscription', sub.id, { ...li, productId }, c, sub.status, sub.email, sub.billingName, student),
      start: dateOnly(sub.startDate), computedUntil: c?.kind === 'fraccionado' ? dateOnly(sub.endDate) : null };
    if (prev?.applied_at) { out.push({ ...e, result: 'ya_procesado', note: 'ya se procesó esta suscripción' }); continue; }
    if (!c || c.kind === 'sin_datos') { out.push(sinRegla(e)); continue; }
    if (c.kind === 'pago_unico') continue;                    // no debería existir como suscripción
    if (!student) { out.push(sinAlumno(e, `Suscripción ${sub.id}`)); continue; }
    out.push(link(e, student, c.id));
  }
  return out;
}

/** Clave de un evento en `woo_plan_events` (y en el mapa de existentes). */
export function eventKey(sourceType: SourceType, sourceId: number, productId: number): string {
  return `${sourceType}:${sourceId}:${productId}`;
}

/** Desde qué día procesan solos el webhook y el barrido diario (ver buildPlanEvents). */
export const AUTO_SINCE = '2026-10-29';

/**
 * Todos los eventos de una tanda de pedidos y suscripciones.
 *
 * Se procesan por FECHA, y lo que cada evento escribe se aplica al alumno en
 * memoria antes del siguiente: un alumno con dos pedidos en la misma tanda ve el
 * segundo contra la fecha que le dejó el primero, igual que si hubieran llegado
 * por separado.
 *
 * `autoOnly` (webhook y barrido diario): solo lo pagado/empezado desde
 * AUTO_SINCE, más lo que ya tenga fila (p. ej. un pedido de antes que quedó
 * "sin alumno" y ahora sí lo tiene). Lo anterior entra SOLO por la puesta al
 * día manual (simular/aplicar), que es la que se revisa antes de escribir.
 */
export function buildPlanEvents(args: {
  orders: WooOrderLite[];
  subscriptions: WooSubscriptionLite[];
  studentsByEmail: Map<string, StudentLite>;
  existing: Map<string, ExistingEvent>;
  today: string;
  autoOnly?: boolean;
}): PlanEvent[] {
  const { studentsByEmail, existing, today } = args;
  const hasRow = (t: SourceType, id: number) => [...existing.keys()].some(k => k.startsWith(`${t}:${id}:`));
  // El pedido inicial de una suscripción de la tanda no genera nada: lo cubre la
  // propia suscripción (mismo producto, mismo alumno). Sin esto, un producto sin
  // regla vendido como suscripción avisaba dos veces.
  const parentsOfSubs = new Set(args.subscriptions.map(s => s.parentId).filter((x): x is number => x != null));
  const src = [
    ...args.orders.filter(o => !parentsOfSubs.has(o.id))
      .map(o => ({ t: 'order' as const, date: dateOnly(o.datePaid) ?? dateOnly(o.dateCreated) ?? '', o })),
    ...args.subscriptions.map(s => ({ t: 'subscription' as const, date: dateOnly(s.startDate) ?? '', s })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  const out: PlanEvent[] = [];
  for (const x of src) {
    const id = x.t === 'order' ? x.o.id : x.s.id;
    if (args.autoOnly && x.date < AUTO_SINCE && !hasRow(x.t, id)) continue;
    const email = (x.t === 'order' ? x.o.email : x.s.email).trim().toLowerCase();
    const student = studentsByEmail.get(email) ?? null;
    const ex = (pid: number) => existing.get(eventKey(x.t, id, pid)) ?? null;
    const evs = x.t === 'order' ? planOrderEvents(x.o, student, ex, today) : planSubscriptionEvents(x.s, student, ex);
    for (const e of evs) {
      out.push(e);
      const cur = studentsByEmail.get(email);
      if (cur && e.studentWrite) {
        const w = e.studentWrite;
        studentsByEmail.set(email, {
          ...cur,
          manual_active_until: (w.manual_active_until as string | undefined) ?? cur.manual_active_until,
          product_name: (w.product_name as string | undefined) ?? cur.product_name,
          woo_product_id: (w.woo_product_id as number | undefined) ?? cur.woo_product_id,
        });
      }
    }
  }
  return out;
}

/** Cómo se lee cada resultado en la tabla (simular/aplicar). */
export const RESULT_LABEL: Record<PlanEventResult, string> = {
  activado: 'Activado',
  ampliado: 'Ampliado',
  conserva_fecha: 'Conserva su fecha',
  sin_cambios: 'Ya estaba bien',
  vinculado: 'Plan apuntado (cupo)',
  sin_alumno: 'Sin alumno (aviso)',
  sin_regla: 'Sin regla (aviso)',
  ya_procesado: 'Ya procesado',
  reembolsado: 'Reembolsado (aviso)',
};
