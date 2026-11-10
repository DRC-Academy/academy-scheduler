// ── Aviso de renovación de PROGRAMAS de la oferta nueva: reglas puras ────────
//
// Qué programa es cada pedido, cuándo termina, si toca avisar y el texto del
// aviso en Slack. Módulo PURO (sin red ni base): lo usan la sincronización con
// Woo (lib/programSync), el aviso (lib/renewalNotice) y sus tests.
//
// NO DECIDE ACCESO. La regla de quién está activo sigue entera en
// check-subscription / lib/subscriptionAccess; esto solo lee fechas para avisar
// a ventas. (La rama programas-renovacion del 12/10 sí tocaba el acceso, y por
// eso no se mezcló el 28/10/2026.)
//
// CATÁLOGO: el de la oferta nueva, lib/productCatalog. Acá solo se elige QUÉ
// productos del catálogo son "programas" con aviso de renovación y a qué
// familia pertenecen; la duración y el tipo de pago salen del catálogo.

import { catalogProduct, type CatalogProduct } from '@/lib/productCatalog';
import { addCalendarMonths } from '@/lib/productUtils';

export type ProgramKey = 'desbloqueo' | 'fluidez' | 'acelerado' | 'platino';
export type PaymentMode = 'unico' | 'fraccionado';

/**
 * Productos del catálogo con aviso de renovación (Desbloqueo, Fluidez,
 * Acelerado y Plan Platino, en sus dos formas de pago). Los demás pagos únicos
 * de la oferta nueva (planes de 2 personas, Personalizado) y los mensuales no
 * entran: no son programas con renovación.
 */
export const RENEWAL_PROGRAMS: Readonly<Record<number, ProgramKey>> = {
  35652: 'desbloqueo', 35635: 'desbloqueo',
  35653: 'fluidez',    35654: 'fluidez',
  35655: 'acelerado',  35656: 'acelerado',
  35658: 'platino',    36385: 'platino',
};

export const RENEWAL_PRODUCT_IDS: readonly number[] = Object.keys(RENEWAL_PROGRAMS).map(Number);

export interface RenewalProgramProduct {
  productId: number;
  program: ProgramKey;
  paymentMode: PaymentMode;
  months: number;
  catalog: CatalogProduct;
}

/** Programa con aviso de un line_item de Woo (producto o variación). null si no lo es. */
export function renewalProgramOf(productId: unknown, variationId?: unknown): RenewalProgramProduct | null {
  const c = catalogProduct(productId, variationId);
  if (!c) return null;
  const program = RENEWAL_PROGRAMS[c.id];
  if (!program || !c.months || (c.kind !== 'pago_unico' && c.kind !== 'fraccionado')) return null;
  return { productId: c.id, program, paymentMode: c.kind === 'fraccionado' ? 'fraccionado' : 'unico', months: c.months, catalog: c };
}

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

// ── Fechas ───────────────────────────────────────────────────────────────────

/**
 * Fecha de Woo → 'YYYY-MM-DD' en hora de Madrid.
 *
 * Los `*_gmt` de la API v3 vienen SIN zona y son UTC: se les pone la Z y se
 * pasan a Madrid (un fin a las 23:30 UTC es el día siguiente en España). Los
 * que no son _gmt están en la hora de la tienda: su parte de fecha vale tal cual.
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

/** `<campo>_gmt` primero (lo único que trae la v3 en suscripciones) y el local de respaldo. */
export function firstWooDate(obj: Record<string, unknown> | null | undefined, field: string): string | null {
  if (!obj) return null;
  return wooDateToMadrid(obj[`${field}_gmt`], true) ?? wooDateToMadrid(obj[field], false);
}

const DAY_MS = 86_400_000;

/** Días de calendario entre dos fechas 'YYYY-MM-DD'. */
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

const isoDate = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(t) && !t.startsWith('0000') ? t : null;
};

/** Lo que Gestión ya sabe del alumno enlazado (columnas de `students`). */
export interface GestionPlan {
  woo_product_id: number | null;
  /** Inicio real del programa (lo pone la activación por pago o el setter al asignar). */
  company_plan_start: string | null;
  /** Hasta cuándo tiene acceso (pago + meses, o inicio real + meses; "nunca recorta"). */
  manual_active_until: string | null;
}

export type EndDateOrigin = 'woo' | 'pago_mas_meses' | 'inicio_gestion_mas_meses' | 'acceso_gestion';

export interface ProgramDates {
  start: string | null;
  end: string | null;
  /** Lo que se guarda en student_programs.end_date_source (su CHECK solo admite estas dos). */
  source: 'woo' | 'calculada';
  origin: EndDateOrigin | null;
}

/**
 * Fechas de un PAGO ÚNICO: fin = inicio + meses del programa.
 *
 * El inicio es la fecha de pago, SALVO que Gestión tenga el inicio real del
 * mismo producto (`company_plan_start`, el que fija el setter al asignar
 * profesor; puede ser semanas después del pago). Y si Gestión le dio acceso
 * hasta más tarde (`manual_active_until`: alargado a mano o "nunca recorta"), el
 * aviso usa esa fecha: es cuando el alumno deja de tener clase, y la misma que
 * mira el aviso de 7 días. Comprobado el 10/11/2026: en 7 de los 20 pagos
 * únicos reales, pago + meses daba un fin ANTERIOR al real.
 *
 * `gestion` solo cuenta si el alumno tiene apuntado ESTE producto y este
 * pedido es su último pedido de ese producto (si no, sus fechas son de otro).
 */
export function oneTimeProgramDates(paidDate: string | null, months: number, gestion: GestionPlan | null): ProgramDates {
  const paid = isoDate(paidDate);
  const gStart = isoDate(gestion?.company_plan_start);
  const start = gStart && paid && gStart >= paid ? gStart : paid;
  const computed = start ? addCalendarMonths(start, months) : null;
  const access = isoDate(gestion?.manual_active_until);
  if (access && (!computed || access > computed)) {
    return { start, end: access, source: 'calculada', origin: 'acceso_gestion' };
  }
  if (!computed) return { start, end: null, source: 'calculada', origin: null };
  return { start, end: computed, source: 'calculada', origin: start === paid ? 'pago_mas_meses' : 'inicio_gestion_mas_meses' };
}

/**
 * Fechas de un FRACCIONADO: el fin es el de la suscripción de Woo
 * (`end_date_gmt`; la suscripción expira sola al acabar el programa). Si Woo no
 * lo da, inicio + meses como respaldo.
 *
 * Comprobado el 10/11/2026 con la única real (35902, Fluidez fraccionado):
 * start_date_gmt 2026-10-20, trial hasta 2027-01-20, end_date_gmt 2027-04-20 =
 * inicio + 6 meses.
 */
export function splitProgramDates(
  paidDate: string | null, months: number, sub: Record<string, unknown> | null,
): ProgramDates {
  const start = firstWooDate(sub, 'start_date') ?? isoDate(paidDate);
  const subEnd = firstWooDate(sub, 'end_date');
  if (subEnd) return { start, end: subEnd, source: 'woo', origin: 'woo' };
  const computed = start ? addCalendarMonths(start, months) : null;
  return { start, end: computed, source: 'calculada', origin: computed ? 'pago_mas_meses' : null };
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

/** Estados de pedido que cuentan como pagado. Cancelado, reembolsado, fallido o borrado no. */
export const PAID_ORDER_STATUSES: readonly string[] = ['processing', 'completed'];

export function isOrderPaid(status: string | null | undefined): boolean {
  return !!status && PAID_ORDER_STATUSES.includes(status);
}

const SUB_GONE = new Set(['cancelled', 'expired']);

// ── ¿Toca avisar? ────────────────────────────────────────────────────────────

/** Se avisa cuando faltan estos días o menos (4 semanas). */
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
  pedido_no_pagado:      'el pedido no está pagado (cancelado, reembolsado, fallido o borrado)',
  suscripcion_cancelada: 'la suscripción está cancelada o vencida',
  sin_fecha_fin:         'el programa no tiene fecha de fin',
  ya_terminado:          'el programa ya terminó',
  fuera_de_ventana:      `faltan más de ${RENEWAL_NOTICE_DAYS} días`,
  ya_avisado:            'ya se avisó por esta fecha de fin',
  ya_renovado:           'ya tiene otro programa pagado que termina después',
};

/** ¿Se avisó ya por la fecha de fin VIGENTE? Si la fecha cambia, vuelve a avisarse. */
export function renewalNoticeSent(r: StudentProgramRow): boolean {
  return !!r.renewal_notified_at && !!r.end_date && (r.renewal_notified_for ?? '').slice(0, 10) === r.end_date;
}

/**
 * Por qué NO se avisaría de esta fila, o null si toca avisar. `siblings` son
 * los demás programas del mismo alumno (o del mismo email si no está enlazado):
 * si ya compró otro que termina después, ya renovó.
 */
export function renewalSkipReason(
  r: StudentProgramRow, siblings: StudentProgramRow[], today: string,
  opts: { ignoreWindow?: boolean; ignoreNotified?: boolean } = {},
): RenewalSkipReason | null {
  if (!isOrderPaid(r.order_status)) return 'pedido_no_pagado';
  if (r.payment_mode === 'fraccionado' && SUB_GONE.has(r.subscription_status ?? '')) return 'suscripcion_cancelada';
  if (!r.end_date) return 'sin_fecha_fin';
  const days = daysBetween(today, r.end_date);
  if (days < 0) return 'ya_terminado';
  if (!opts.ignoreWindow && days > RENEWAL_NOTICE_DAYS) return 'fuera_de_ventana';
  if (!opts.ignoreNotified && renewalNoticeSent(r)) return 'ya_avisado';
  const renewed = siblings.some(o =>
    o.order_id !== r.order_id && isOrderPaid(o.order_status) && !!o.end_date && o.end_date > r.end_date!
    && !(o.payment_mode === 'fraccionado' && SUB_GONE.has(o.subscription_status ?? '')),
  );
  return renewed ? 'ya_renovado' : null;
}

/** Línea de "Pagos" según la forma de pago y el estado de la suscripción. */
export function paymentsLabel(r: Pick<StudentProgramRow, 'payment_mode' | 'subscription_status'>): string {
  if (r.payment_mode === 'unico') return 'Pagado (pago único)';
  switch (r.subscription_status) {
    case 'on-hold':
    case 'pending':
      return 'Cuota pendiente';
    case 'pending-cancel':
      return 'Al día (canceló las cuotas que quedaban)';
    case null:
    case undefined:
    case '':
      return 'Sin datos de la suscripción';
    default:
      return 'Al día';
  }
}

// ── El mensaje ───────────────────────────────────────────────────────────────

export interface RenewalMessageData {
  studentName: string;
  program: ProgramKey | string;
  paymentMode: PaymentMode | string;
  teacherName: string | null;
  endDate: string;
  daysLeft: number;
  phone: string;
  email: string;
  payments: string;
  linked: boolean;
}

function headline(days: number): string {
  if (days <= 0) return '🔔 *Renovación hoy*';
  return `🔔 *Renovación en ${days} ${days === 1 ? 'día' : 'días'}*`;
}

/** Slack pinta *así* en negrita: un asterisco en el nombre rompería el formato. */
const plain = (s: string) => s.replace(/[*_~`]/g, '').trim();

/** El mensaje de Slack tal cual lo pidió Facundo (10/11/2026). */
export function buildRenewalText(d: RenewalMessageData): string {
  const teacher = d.linked ? plain(d.teacherName ?? '') || 'sin asignar' : 'sin asignar';
  const lines = [
    headline(d.daysLeft),
    `*${plain(d.studentName)}* termina su *${programLabel(d.program)}* (${paymentModeLabel(d.paymentMode)}) el *${formatDateEs(d.endDate)}*.`,
    `👩‍🏫 *Profe:* ${teacher}`,
    `📱 *Teléfono:* ${d.phone.trim() || '—'}`,
    `✉️ *Email:* ${d.email.trim() || '—'}`,
    `💳 *Pagos:* ${d.payments}`,
  ];
  if (!d.linked) lines.push('⚠️ No está enlazado con ningún alumno de Gestión');
  return lines.join('\n');
}
