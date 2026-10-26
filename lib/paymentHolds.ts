// ── Alumnos con PAGO PENDIENTE (suscripción de WooCommerce en on-hold) ─────────
//
// Reglas PURAS (sin red ni base). El servidor está en lib/paymentHoldStore.
//
// QUÉ ES UN EPISODIO. Cada vez que el estado resuelto de un alumno pasa a
// 'on-hold' se abre una fila en `student_payment_holds` (started_at) y se cierra
// cuando sale (ended_at). Guardamos episodios y no el estado actual porque las
// clases PASADAS tienen que poder preguntar "¿cuando tocaba esta clase, el alumno
// tenía el pago pendiente?", y el estado de hoy no responde a eso.
//
// QUÉ HACE UN EPISODIO. Una clase PROYECTADA del calendario cuyo inicio (hora de
// España) cae dentro de un episodio NO EXISTE: no es falta del profesor ni del
// alumno, no pide transcript, no consume cupo, no se puede reclamar y no se
// cobra. Se aplica a través del período del alumno (lib/studentPeriod), que es
// el filtro por el que pasan todas esas pantallas y relojes.
//
// LO QUE NO TOCA. Los HECHOS (un ingreso real o un registro) ganan siempre, como
// en el resto del período: una clase que sí se dio antes de existir este sistema
// sigue en finanzas. El ingreso nuevo dentro de un episodio lo rechaza
// /api/class-join.
//
// POR QUÉ HAY ESPERA ANTES DEL EMAIL. WooCommerce Subscriptions pone en on-hold
// CADA renovación automática mientras cobra, aunque el cobro entre a los pocos
// segundos. Sin espera, cada profesor recibiría "suspendido" y "reactivado" todos
// los meses. El bloqueo sí es inmediato; el email de "suspendido" solo sale si el
// episodio sigue abierto pasados SUSPENDED_EMAIL_GRACE_MIN minutos.

import { spainWallClockToEpoch } from '@/lib/spainTime';
import { esPerfilDePrueba } from '@/lib/perfilDePrueba';

/** Minutos que un episodio tiene que seguir abierto para avisar al profesor. */
export const SUSPENDED_EMAIL_GRACE_MIN = 30;

/** Reintentos de un email que falló (Resend caído, dirección mala…). */
export const NOTICE_MAX_ATTEMPTS = 3;

/** Días hacia atrás en los que se buscan episodios cerrados con reactivación por enviar. */
export const REACTIVATION_LOOKBACK_DAYS = 7;

/**
 * Inicio del sistema. Los episodios cuyo inicio REAL (el que dice WooCommerce) es
 * anterior se dan por "iniciales": bloquean igual, pero no generan emails. Así,
 * al publicar, los alumnos que ya estaban en on-hold no disparan avisos viejos.
 */
export const PAYMENT_HOLDS_LAUNCH_AT = '2026-10-27T00:00:00+01:00';

/** Un episodio tal como sale de la tabla. */
export interface PaymentHold {
  id: string;
  studentId: string;
  studentEmail: string;
  studentName: string;
  /** ISO. */
  startedAt: string;
  /** ISO, o null si sigue en on-hold. */
  endedAt: string | null;
  isInitial: boolean;
  endStatus?: string | null;
}

/** Tramo de un episodio en epoch ms. `toMs` null = abierto. */
export interface HoldSpan {
  fromMs: number;
  toMs: number | null;
}

export type NoticeKind = 'suspendido' | 'reactivado';

const nk = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

/** Fila de la tabla → PaymentHold. */
export function holdFromRow(r: Record<string, unknown>): PaymentHold {
  return {
    id: String(r.id ?? ''),
    studentId: String(r.student_id ?? ''),
    studentEmail: String(r.student_email ?? ''),
    studentName: String(r.student_name ?? ''),
    startedAt: String(r.started_at ?? ''),
    endedAt: r.ended_at ? String(r.ended_at) : null,
    isInitial: r.is_initial === true,
    endStatus: r.end_status ? String(r.end_status) : null,
  };
}

export function spanOf(h: Pick<PaymentHold, 'startedAt' | 'endedAt'>): HoldSpan | null {
  const fromMs = Date.parse(h.startedAt);
  if (!Number.isFinite(fromMs)) return null;
  const toMs = h.endedAt ? Date.parse(h.endedAt) : null;
  return { fromMs, toMs: toMs != null && Number.isFinite(toMs) ? toMs : null };
}

/** ¿El instante cae dentro de alguno de los tramos? Inicio incluido, fin excluido. */
export function isInHold(spans: readonly HoldSpan[] | undefined, epochMs: number): boolean {
  if (!spans?.length || !Number.isFinite(epochMs)) return false;
  return spans.some(s => epochMs >= s.fromMs && (s.toMs == null || epochMs < s.toMs));
}

/** Hora de clase "HH:MM" (o número) → hora entera. */
function hourOf(hour: string | number): number {
  return typeof hour === 'number' ? hour : parseInt(String(hour), 10);
}

/**
 * ¿La clase de ese día y esa hora (hora de pared de ESPAÑA) cae dentro de un
 * episodio? Se mira el INICIO de la clase: es cuando el profesor tendría que
 * haber entrado.
 */
export function isClassOnHold(spans: readonly HoldSpan[] | undefined, dateIso: string, hour: string | number): boolean {
  if (!spans?.length) return false;
  const h = hourOf(hour);
  if (!Number.isFinite(h)) return false;
  return isInHold(spans, spainWallClockToEpoch(dateIso, h));
}

/** Lo que identifica a un alumno para emparejarlo con sus episodios. */
export interface HoldStudentRef {
  studentId?: string | null;
  studentEmail?: string | null;
  studentName?: string | null;
}

/**
 * Tramos de los episodios de UN alumno. Se empareja por id, por email y por
 * nombre (cualquiera vale): las asignaciones viejas no siempre traen el id, y el
 * calendario guarda el nombre tal como lo escribió el profesor.
 */
export function holdSpansFor(holds: readonly PaymentHold[] | undefined, ref: HoldStudentRef): HoldSpan[] {
  if (!holds?.length) return [];
  const id = ref.studentId?.trim() || '';
  const email = nk(ref.studentEmail);
  const name = nk(ref.studentName);
  const out: HoldSpan[] = [];
  for (const h of holds) {
    const match = (id && h.studentId === id) || (email && nk(h.studentEmail) === email) || (name && nk(h.studentName) === name);
    if (!match) continue;
    const s = spanOf(h);
    if (s) out.push(s);
  }
  return out;
}

/** Episodio abierto de un alumno (como mucho uno: lo garantiza un índice único). */
export function openHoldFor(holds: readonly PaymentHold[] | undefined, ref: HoldStudentRef): PaymentHold | null {
  if (!holds?.length) return null;
  const id = ref.studentId?.trim() || '';
  const email = nk(ref.studentEmail);
  const name = nk(ref.studentName);
  return holds.find(h => !h.endedAt
    && ((id && h.studentId === id) || (email && nk(h.studentEmail) === email) || (name && nk(h.studentName) === name))) ?? null;
}

// ── Transiciones ──────────────────────────────────────────────────────────────

export type HoldAction = 'abrir' | 'cerrar' | 'nada';

/**
 * Qué hacer con el episodio a la vista del estado RESUELTO del alumno.
 *
 *   on-hold sin episodio abierto      → abrir
 *   otro estado con episodio abierto  → cerrar (reactivado si da acceso; si se
 *                                       canceló o venció, se cierra sin aviso)
 *   Woo no contestó (active null)     → nada: ante la duda no se toca
 */
export function holdActionFor(input: { status: string; active: boolean | null; hasOpenHold: boolean }): HoldAction {
  if (input.active === null || input.status === 'error') return 'nada';
  const onHold = input.status === 'on-hold';
  if (onHold && !input.hasOpenHold) return 'abrir';
  if (!onHold && input.hasOpenHold) return 'cerrar';
  return 'nada';
}

/** ¿El episodio es anterior al inicio del sistema? (sin emails). */
export function isInitialHold(startedAtMs: number): boolean {
  return startedAtMs < Date.parse(PAYMENT_HOLDS_LAUNCH_AT);
}

/**
 * ¿Ya toca el email de "suspendido"? Abierto, no inicial y con la espera cumplida
 * desde el inicio REAL. Quien llama tiene que haber vuelto a comprobar el estado
 * en Woo justo antes (el barrido lo hace): "abierto" tiene que ser verdad ahora.
 */
export function suspendedNoticeDue(h: Pick<PaymentHold, 'endedAt' | 'isInitial' | 'startedAt'>, nowMs: number): boolean {
  if (h.endedAt || h.isInitial) return false;
  const start = Date.parse(h.startedAt);
  return Number.isFinite(start) && nowMs - start >= SUSPENDED_EMAIL_GRACE_MIN * 60_000;
}

/** Id del episodio: estable por alumno e instante de inicio. */
export function holdIdOf(studentId: string, startedAtMs: number): string {
  return `hold_${studentId}_${startedAtMs}`;
}

/** Id del aviso: UNO por episodio, profesor y tipo. Es el anti-duplicado. */
export function noticeIdOf(holdId: string, teacherId: string, kind: NoticeKind): string {
  return `${holdId}|${teacherId}|${kind}`;
}

/** Id de la campanita (notifications.id), derivado del aviso. */
export function bellIdOf(holdId: string, teacherId: string, kind: NoticeKind): string {
  return `pago_${kind}_${teacherId}_${holdId}`;
}

/**
 * ¿Se avisa a este profesor de este alumno? Las cuentas de prueba (profesor o
 * alumno con is_test) quedan fuera, SALVO el perfil de prueba de Sebastian (t1),
 * que es por donde se prueba el sistema. El bloqueo no depende de esto.
 */
export function shouldNotifyTeacher(input: { teacherId: string; teacherIsTest?: boolean | null; studentIsTest?: boolean | null }): boolean {
  if (esPerfilDePrueba(input.teacherId)) return true;
  return !input.teacherIsTest && !input.studentIsTest;
}

// ── Textos (email y campanita) ────────────────────────────────────────────────
// Español de España, tuteo. Sin importes ni detalles del pago, a propósito.

export function suspendedCopy(studentName: string): { title: string; body: string; subject: string } {
  return {
    subject: `Pago pendiente: clases de ${studentName} suspendidas`,
    title: `🔒 Pago pendiente: ${studentName}`,
    body: `${studentName} tiene el pago pendiente. Sus clases quedan suspendidas hasta que regularice el pago. No hace falta que te conectes.`,
  };
}

export function reactivatedCopy(studentName: string): { title: string; body: string; subject: string } {
  return {
    subject: `${studentName} ya ha regularizado el pago`,
    title: `✅ ${studentName} ya ha regularizado el pago`,
    body: `${studentName} ya ha regularizado el pago, puedes retomar las clases con normalidad.`,
  };
}

/** Texto del aviso al pulsar "Ingresar a clase". */
export const PAYMENT_HOLD_JOIN_TITLE = '🔒 Pago pendiente';
export const PAYMENT_HOLD_JOIN_BODY =
  'Este alumno tiene el pago pendiente. Sus clases quedan suspendidas hasta que regularice el pago. No hace falta que te conectes.';

/** Código de error con el que /api/class-join rechaza un ingreso. */
export const PAYMENT_HOLD_ERROR = 'pago_pendiente';

// ── Inicio real del episodio en WooCommerce ──────────────────────────────────

/** Nota de una suscripción de Woo (lo que se usa). */
export interface WooNote { note?: unknown; date_created_gmt?: unknown; date_created?: unknown }
/** Pedido relacionado de una suscripción (lo que se usa). */
export interface WooRelatedOrder { status?: unknown; date_created_gmt?: unknown; date_created?: unknown }

/** Fecha de Woo → epoch. Las *_gmt vienen sin zona y son UTC. */
function wooEpoch(gmt: unknown, local: unknown): number {
  if (typeof gmt === 'string' && gmt.trim() && !gmt.startsWith('0000')) {
    const t = Date.parse(gmt.trim().replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(gmt) ? '' : 'Z'));
    if (Number.isFinite(t)) return t;
  }
  if (typeof local === 'string' && local.trim() && !local.startsWith('0000')) {
    const t = Date.parse(local.trim().replace(' ', 'T'));
    if (Number.isFinite(t)) return t;
  }
  return NaN;
}

const plain = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** ¿La nota es el cambio de estado A on-hold? ("Status changed from Active to On hold." / "…a En espera."). */
export function isOnHoldStatusNote(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const t = plain(text.replace(/<[^>]*>/g, ' '));
  if (!/(status|estado)/.test(t)) return false;
  const tail = t.split(/\b(to|a)\b/).pop() ?? '';
  return /(on.?hold|en espera)/.test(tail);
}

/**
 * Inicio real del episodio según WooCommerce, en epoch ms, o null si no se sabe:
 *   1. la nota más reciente "estado cambiado a En espera";
 *   2. si no, el pedido de renovación fallido o pendiente más reciente.
 * Nunca en el futuro respecto de `nowMs`.
 */
export function holdStartFromWoo(input: { notes?: WooNote[]; orders?: WooRelatedOrder[]; nowMs: number }): { ms: number; source: 'nota' | 'pedido' } | null {
  const notas = (input.notes ?? [])
    .filter(n => isOnHoldStatusNote(n.note))
    .map(n => wooEpoch(n.date_created_gmt, n.date_created))
    .filter(t => Number.isFinite(t) && t <= input.nowMs);
  if (notas.length) return { ms: Math.max(...notas), source: 'nota' };
  const pedidos = (input.orders ?? [])
    .filter(o => ['failed', 'pending', 'on-hold'].includes(String(o.status ?? '')))
    .map(o => wooEpoch(o.date_created_gmt, o.date_created))
    .filter(t => Number.isFinite(t) && t <= input.nowMs);
  if (pedidos.length) return { ms: Math.max(...pedidos), source: 'pedido' };
  return null;
}
