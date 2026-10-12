// ── Programas de la nueva oferta (oct/2026) ──────────────────────────────────
//
// FUENTE ÚNICA de qué es un programa, cuándo termina, si da acceso y si toca
// avisar de su renovación. Módulo PURO (sin red ni base) a propósito: lo usan
// el servidor (check-subscription, la sincronización con Woo, el cron de
// renovaciones) y el navegador (la línea del programa en las fichas), y todos
// tienen que responder lo mismo sobre la misma fila.
//
// QUÉ ES UN PROGRAMA: un pedido de uno de los 7 productos de PROGRAM_PRODUCTS,
// guardado en `student_programs` (supabase/migraciones/2026-10-12-student-programs.sql).
//
//   · PAGO ÚNICO (producto simple): pedido normal. Fin = fecha de pago + meses.
//   · FRACCIONADO (suscripción con cuota de alta, 3 meses de prueba y 3 cuotas):
//     la suscripción expira sola en el mes 6, así que su end_date ES el fin del
//     programa.

import { addCalendarMonths } from '@/lib/productUtils';
import { isActiveWooStatus } from '@/lib/subscriptionAccess';

export type ProgramKey = 'desbloqueo' | 'fluidez' | 'acelerado' | 'platino';
export type PaymentMode = 'unico' | 'fraccionado';

export interface ProgramProduct {
  program: ProgramKey;
  months: number;
  paymentMode: PaymentMode;
}

/** ID de producto de WooCommerce → programa. Dato de Facundo, 12/10/2026. */
export const PROGRAM_PRODUCTS: Readonly<Record<number, ProgramProduct>> = {
  35652: { program: 'desbloqueo', months: 6, paymentMode: 'unico' },
  35635: { program: 'desbloqueo', months: 6, paymentMode: 'fraccionado' },
  35653: { program: 'fluidez',    months: 6, paymentMode: 'unico' },
  35654: { program: 'fluidez',    months: 6, paymentMode: 'fraccionado' },
  35655: { program: 'acelerado',  months: 6, paymentMode: 'unico' },
  35656: { program: 'acelerado',  months: 6, paymentMode: 'fraccionado' },
  35658: { program: 'platino',    months: 9, paymentMode: 'unico' },
};

export const PROGRAM_PRODUCT_IDS: readonly number[] = Object.keys(PROGRAM_PRODUCTS).map(Number);

const PROGRAM_LABELS: Record<ProgramKey, string> = {
  desbloqueo: 'Programa Desbloqueo',
  fluidez:    'Programa Fluidez',
  acelerado:  'Programa Acelerado',
  platino:    'Plan Platino',
};

export function programLabel(p: ProgramKey | string): string {
  return PROGRAM_LABELS[p as ProgramKey] ?? p;
}

export function paymentModeLabel(m: PaymentMode | string): string {
  return m === 'fraccionado' ? 'fraccionado' : 'pago único';
}

/** "Programa Fluidez (fraccionado)" — como lo pide el aviso de Slack. */
export function programFullLabel(r: { program: string; payment_mode: string }): string {
  return `${programLabel(r.program)} (${paymentModeLabel(r.payment_mode)})`;
}

/** Programa de un line_item de Woo, mirando producto y variación. */
export function programOfProductId(productId: unknown, variationId?: unknown): ProgramProduct | null {
  return PROGRAM_PRODUCTS[Number(productId)] ?? PROGRAM_PRODUCTS[Number(variationId)] ?? null;
}

// ── Fechas ───────────────────────────────────────────────────────────────────

/**
 * Fecha de Woo → 'YYYY-MM-DD' en hora de Madrid.
 *
 * Los campos `*_gmt` de la API v3 vienen SIN zona ("2026-10-12T08:30:00") y son
 * UTC: se les pone la Z. Los que no son _gmt están en la hora de la tienda, que
 * es Madrid, así que su parte de fecha ya es la buena. Ver [[spain-timezone]].
 */
export function wooDateToMadrid(raw: unknown, isGmt: boolean): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t || t.startsWith('0000')) return null;
  if (!isGmt) return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null;
  const iso = t.replace(' ', 'T');
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
  if (isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/** Primera fecha válida de varias candidatas (gmt primero, local de respaldo). */
export function firstWooDate(obj: Record<string, unknown> | null | undefined, field: string): string | null {
  if (!obj) return null;
  return wooDateToMadrid(obj[`${field}_gmt`], true) ?? wooDateToMadrid(obj[field], false);
}

/** Fin de un programa de pago único (o el calculado si Woo no da la fecha). */
export function computedEndDate(start: string | null, months: number): string | null {
  return start ? addCalendarMonths(start, months) : null;
}

const DAY_MS = 86_400_000;

/** Días de calendario entre hoy y el fin (fechas de Madrid, comparadas a mediodía). */
export function daysBetween(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso}T12:00:00Z`).getTime();
  const b = new Date(`${toIso}T12:00:00Z`).getTime();
  return Math.round((b - a) / DAY_MS);
}

/** 'YYYY-MM-DD' → 'dd/mm/aaaa'. */
export function formatDateEs(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '—';
}

// ── La fila ──────────────────────────────────────────────────────────────────

export interface StudentProgramRow {
  id: string;
  order_id: number;
  customer_id: number | null;
  email: string | null;
  billing_name: string | null;
  billing_phone: string | null;
  student_id: string | null;
  link_source: 'email' | 'manual' | null;
  linked_by?: string | null;
  linked_at?: string | null;
  product_id: number;
  program: ProgramKey;
  payment_mode: PaymentMode;
  months: number;
  start_date: string | null;
  end_date: string | null;
  end_date_source: 'woo' | 'calculada' | null;
  order_status: string | null;
  subscription_id: number | null;
  subscription_status: string | null;
  renewal_notified_at: string | null;
  renewal_notified_for: string | null;
  synced_at?: string | null;
}

/** Estados de pedido que cuentan como pagado. Cancelado/reembolsado/fallido no. */
export const PAID_ORDER_STATUSES: readonly string[] = ['processing', 'completed'];

export function isOrderPaid(status: string | null | undefined): boolean {
  return !!status && PAID_ORDER_STATUSES.includes(status);
}

// ── Acceso ───────────────────────────────────────────────────────────────────
//
// Regla de Facundo (12/10/2026):
//   · Pago único: acceso desde start_date hasta end_date (incluido).
//   · Fraccionado: acceso solo mientras la suscripción da acceso (el periodo de
//     prueba es 'active' en Woo). 'on-hold' por cobro fallido = SIN acceso
//     hasta que pague, aunque no haya llegado el fin. Al expirar, sin acceso.
//   · Pedido cancelado o reembolsado: sin acceso.
//
// 'pending-cancel' sigue la regla única de la app (lib/subscriptionAccess): da
// acceso porque está pagado hasta el fin del periodo en curso.

/** Estados propios de programa que viajan como `status` de check-subscription. */
export const PROGRAM_ACTIVE_STATUS = 'program_active';
export const PROGRAM_ENDED_STATUS = 'program_ended';
export const PROGRAM_CANCELLED_STATUS = 'program_cancelled';

export interface ProgramAccess {
  active: boolean;
  /** program_active / program_ended / program_cancelled, o el estado REAL de la
   *  suscripción en un fraccionado (active, on-hold, expired…), para que el
   *  badge diga lo que de verdad le pasa. */
  status: string;
  /** 'YYYY-MM-DD' — fin del programa. */
  endDate: string | null;
}

/**
 * Acceso que da UNA fila. `liveSubStatus` es el estado de la suscripción leído
 * en el momento (si se pudo); si no, vale el guardado en la última sincronización.
 */
export function programAccessOf(r: StudentProgramRow, today: string, liveSubStatus?: string | null): ProgramAccess {
  const endDate = r.end_date;
  if (!isOrderPaid(r.order_status)) return { active: false, status: PROGRAM_CANCELLED_STATUS, endDate };
  const ended = !!endDate && endDate < today;

  if (r.payment_mode === 'unico') {
    if (ended) return { active: false, status: PROGRAM_ENDED_STATUS, endDate };
    if (r.start_date && r.start_date > today) return { active: false, status: 'scheduled', endDate };
    return { active: true, status: PROGRAM_ACTIVE_STATUS, endDate };
  }

  const sub = liveSubStatus ?? r.subscription_status;
  if (!sub) return { active: false, status: 'not_found', endDate };
  if (ended && isActiveWooStatus(sub)) return { active: false, status: PROGRAM_ENDED_STATUS, endDate };
  return { active: isActiveWooStatus(sub), status: sub, endDate };
}

const byStartDesc = (a: StudentProgramRow, b: StudentProgramRow) =>
  (b.start_date ?? '').localeCompare(a.start_date ?? '') || b.order_id - a.order_id;

/**
 * El programa que MANDA para un alumno: el que da acceso hoy; si ninguno, el
 * pagado más reciente; si todos están cancelados, el más reciente. null = el
 * alumno no tiene programas.
 */
export function currentProgram(rows: StudentProgramRow[], today: string): StudentProgramRow | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort(byStartDesc);
  return sorted.find(r => programAccessOf(r, today).active)
    ?? sorted.find(r => isOrderPaid(r.order_status))
    ?? sorted[0];
}

/** ¿Este programa está vigente (pagado, sin terminar y sin la suscripción
 *  cancelada)? Un on-hold sigue vigente: el alumno debe una cuota, no se fue. */
export function isProgramCurrent(r: StudentProgramRow, today: string): boolean {
  return isOrderPaid(r.order_status)
    && (!r.end_date || r.end_date >= today)
    && !(r.payment_mode === 'fraccionado' && (r.subscription_status === 'cancelled' || r.subscription_status === 'expired'));
}

/**
 * Claves (student_id y email en minúsculas) de los alumnos con un programa
 * vigente. Sirven para EXCLUIRLOS de "Próximos a cancelar" (lib/endingPlans):
 * ese aviso es de otro tipo de plan, y el fin de un programa ya lo avisa el cron
 * de renovaciones. Sin esto, una activación manual puesta a un alumno de
 * programa dispararía los dos avisos sobre la misma persona.
 */
export function currentProgramKeys(rows: StudentProgramRow[], today: string): Set<string> {
  const keys = new Set<string>();
  for (const r of rows) {
    if (!isProgramCurrent(r, today)) continue;
    if (r.student_id) keys.add(r.student_id);
    if (r.email) keys.add(r.email.trim().toLowerCase());
  }
  return keys;
}

/** ¿Este alumno está en las claves de currentProgramKeys? */
export function hasProgramKey(keys: Set<string>, s: { id: string; email?: string | null }): boolean {
  return keys.has(s.id) || (!!s.email && keys.has(s.email.trim().toLowerCase()));
}

// ── Aviso de renovación ──────────────────────────────────────────────────────

/** Se avisa cuando faltan estos días o menos. */
export const RENEWAL_NOTICE_DAYS = 28;

export type RenewalSkipReason =
  | 'pedido_no_pagado'
  | 'suscripcion_cancelada'
  | 'sin_fecha_fin'
  | 'ya_terminado'
  | 'fuera_de_ventana'
  | 'ya_avisado'
  | 'ya_renovado';

export const RENEWAL_SKIP_TEXT: Record<RenewalSkipReason, string> = {
  pedido_no_pagado:      'el pedido no está pagado (cancelado, reembolsado o fallido)',
  suscripcion_cancelada: 'la suscripción está cancelada o vencida',
  sin_fecha_fin:         'el programa no tiene fecha de fin',
  ya_terminado:          'el programa ya terminó',
  fuera_de_ventana:      `faltan más de ${RENEWAL_NOTICE_DAYS} días`,
  ya_avisado:            'ya se avisó por esta fecha de fin',
  ya_renovado:           'ya tiene otro programa pagado que termina después',
};

/** ¿Se avisó ya por la fecha de fin VIGENTE? Si Woo corrige la fecha, vuelve a avisarse. */
export function renewalNoticeSent(r: StudentProgramRow): boolean {
  return !!r.renewal_notified_at && !!r.end_date && (r.renewal_notified_for ?? '').slice(0, 10) === r.end_date;
}

/**
 * Por qué NO se avisaría de esta fila, o null si toca avisar. `siblings` son
 * los demás programas del mismo alumno (o del mismo email si no está enlazado):
 * si ya compró otro que termina después, ya renovó y no hay nada que ofrecer.
 */
export function renewalSkipReason(
  r: StudentProgramRow, siblings: StudentProgramRow[], today: string,
  opts: { ignoreWindow?: boolean; ignoreNotified?: boolean } = {},
): RenewalSkipReason | null {
  if (!isOrderPaid(r.order_status)) return 'pedido_no_pagado';
  if (r.payment_mode === 'fraccionado' && (r.subscription_status === 'cancelled' || r.subscription_status === 'expired')) {
    return 'suscripcion_cancelada';
  }
  if (!r.end_date) return 'sin_fecha_fin';
  const days = daysBetween(today, r.end_date);
  if (days < 0) return 'ya_terminado';
  if (!opts.ignoreWindow && days > RENEWAL_NOTICE_DAYS) return 'fuera_de_ventana';
  if (!opts.ignoreNotified && renewalNoticeSent(r)) return 'ya_avisado';
  const renewed = siblings.some(o =>
    o.order_id !== r.order_id && isOrderPaid(o.order_status) && !!o.end_date && o.end_date > r.end_date!
    && !(o.payment_mode === 'fraccionado' && o.subscription_status === 'cancelled'),
  );
  if (renewed) return 'ya_renovado';
  return null;
}

/** "Al día" / "Cuota pendiente" según el estado de la suscripción. */
export function paymentsLabel(r: StudentProgramRow): string {
  if (r.payment_mode === 'unico') return 'Al día';
  switch (r.subscription_status) {
    case 'on-hold':
    case 'pending':
      return 'Cuota pendiente';
    case 'pending-cancel':
      return 'Al día (canceló las cuotas que quedaban)';
    default:
      return 'Al día';
  }
}

export interface RenewalMessageData {
  studentName: string;
  programLabel: string;
  teacherName: string | null;
  endDate: string;
  daysLeft: number;
  phone: string;
  email: string;
  payments: string;
  linked: boolean;
}

function daysLeftText(n: number): string {
  if (n <= 0) return 'termina hoy';
  return n === 1 ? 'falta 1 día' : `faltan ${n} días`;
}

/** El mensaje tal cual lo pidió Facundo (12/10/2026). */
export function buildRenewalText(d: RenewalMessageData): string {
  const lines = [
    '🔔 Renovación en 4 semanas',
    `Alumno: ${d.studentName}`,
    `Programa: ${d.programLabel}`,
    `Profe: ${d.teacherName?.trim() || 'sin asignar'}`,
    `Fecha de fin: ${formatDateEs(d.endDate)} (${daysLeftText(d.daysLeft)})`,
    `Teléfono: ${d.phone || '—'}`,
    `Email: ${d.email || '—'}`,
    `Pagos: ${d.payments}`,
  ];
  if (!d.linked) lines.push('⚠️ No está enlazado con ningún alumno de Gestión');
  return lines.join('\n');
}
