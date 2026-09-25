// Email de bienvenida automático al alumno (Fase 1 de 3).
//
// Cuando se asigna un alumno, la plataforma le escribe con las instrucciones
// para entrar al LMS y el enlace del formulario inicial. Sustituye al email de
// presentación que hoy copia y pega el profesor (eso cambia en la Fase 2).
//
// Este módulo es PURO y sirve en cliente y servidor: el interruptor, la ventana
// de fechas, la elección de la variante, la primera clase y el disparo
// best-effort. El envío vive en lib/welcomeEmailSend.ts (solo servidor).
//
// LAS DOS BARRERAS CONTRA EL ENVÍO MASIVO. Varias herramientas de reparación
// (Sincronizar todo, CrearVinculoModal…) insertan o tocan filas de alumnos
// antiguos con created_at = ahora. Ninguna llama a la bienvenida, pero por si
// algún día alguien la engancha donde no toca:
//   · nunca se envía a una asignación creada antes de WELCOME_EMAIL_START_DATE;
//   · nunca a una con más de WELCOME_MAX_AGE_HOURS desde su created_at.

import { getSpainParts, spainWallClockToEpoch } from '@/lib/spainTime';

/**
 * Interruptor general. Apagado: la ruta responde { skipped: 'disabled' }.
 * Encendido con la Fase 2 (sep/2026), cuando el profesor dejó de enviar el
 * email de presentación.
 */
export const WELCOME_EMAIL_ENABLED = true;

/** Fecha de corte (hora de España). Ninguna asignación anterior recibe el email. */
export const WELCOME_EMAIL_START_DATE = '2026-09-25';

/** Antigüedad máxima de la asignación (desde created_at) para enviarlo. */
export const WELCOME_MAX_AGE_HOURS = 72;

export type WelcomeVariant = 'bienvenida' | 'cambio' | 'adicional';

export const WELCOME_VARIANT_LABEL: Record<WelcomeVariant, string> = {
  bienvenida: 'Bienvenida (alumno nuevo)',
  cambio:     'Cambio de profesor',
  adicional:  'Profesor adicional',
};

/** Por qué se dispara: un alta normal o el asistente "Cambiar de profesor". */
export type WelcomeReason = 'alta' | 'cambio_profesor';

/** Medianoche de la fecha de corte en Madrid, como instante. */
export function welcomeStartEpoch(): number {
  return spainWallClockToEpoch(WELCOME_EMAIL_START_DATE, 0, 0);
}

/**
 * ¿La asignación está dentro de la ventana de envío? created_at desde la fecha
 * de corte y con menos de 72 h. Una fecha ilegible cuenta como fuera.
 */
export function isInWelcomeWindow(createdAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!createdAt) return false;
  const t = new Date(createdAt).getTime();
  if (isNaN(t)) return false;
  if (t < welcomeStartEpoch()) return false;
  return now - t <= WELCOME_MAX_AGE_HOURS * 3_600_000;
}

/**
 * Qué variante le toca, en este orden:
 *   1. tiene OTRA asignación activa con otro profesor → 'adicional';
 *   2. viene del cambio de profesor, ya tuvo clases o tuvo antes otra
 *      asignación con otro profesor → 'cambio' (cubre el "Mover", que borra la
 *      fila vieja y crea una nueva);
 *   3. si no → 'bienvenida'.
 */
export function pickWelcomeVariant(x: {
  reason: WelcomeReason;
  hasOtherActiveWithOtherTeacher: boolean;
  hasPreviousClasses: boolean;
  hasPreviousAssignmentWithOtherTeacher: boolean;
}): WelcomeVariant {
  if (x.hasOtherActiveWithOtherTeacher) return 'adicional';
  if (x.reason === 'cambio_profesor' || x.hasPreviousClasses || x.hasPreviousAssignmentWithOtherTeacher) return 'cambio';
  return 'bienvenida';
}

// ── Primera clase ────────────────────────────────────────────────────────────

const DIA_POR_NOMBRE: Record<string, number> = {
  domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6,
};

const sinTildes = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Día de la semana (0 = domingo) de una fecha de calendario YYYY-MM-DD. */
function diaSemana(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function sumarDias(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** "martes 30 de septiembre" a partir de YYYY-MM-DD, sin depender de la zona del servidor. */
export function fechaLarga(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const fecha = new Date(Date.UTC(y, m - 1, d, 12));
  const fmt = (o: Intl.DateTimeFormatOptions) => fecha.toLocaleDateString('es-ES', { ...o, timeZone: 'UTC' });
  return `${fmt({ weekday: 'long' })} ${d} de ${fmt({ month: 'long' })}`;
}

/**
 * La próxima clase según el horario recurrente, en hora de España. Empieza a
 * contar desde hoy (Madrid) o desde start_date si es posterior. Una clase de hoy
 * cuya hora ya pasó no cuenta. Devuelve null si no hay horario legible.
 *
 * Todo se hace con fechas de calendario y la hora de pared: nunca
 * `new Date(y, m, d, h)`, que depende de la zona del que ejecuta.
 */
export function firstClassFromSlots(
  slots: Array<{ day: string; hour: string }> | null | undefined,
  startDate: string | null | undefined,
  now: Date = new Date(),
): { dateIso: string; hour: string; label: string } | null {
  if (!slots?.length) return null;
  const hoy = getSpainParts(now);
  const desde = startDate && /^\d{4}-\d{2}-\d{2}/.test(startDate) && startDate.slice(0, 10) > hoy.dateStr
    ? startDate.slice(0, 10)
    : hoy.dateStr;

  let mejor: { dateIso: string; hour: string; minutos: number } | null = null;
  for (const s of slots) {
    const dow = DIA_POR_NOMBRE[sinTildes(s.day ?? '')];
    const hm = /^(\d{1,2}):(\d{2})/.exec((s.hour ?? '').trim());
    if (dow === undefined || !hm) continue;
    const minutos = Number(hm[1]) * 60 + Number(hm[2]);
    let fecha = sumarDias(desde, (dow - diaSemana(desde) + 7) % 7);
    if (fecha === hoy.dateStr && minutos <= hoy.hour * 60 + hoy.minute) fecha = sumarDias(fecha, 7);
    const hour = `${hm[1].padStart(2, '0')}:${hm[2]}`;
    if (!mejor || fecha < mejor.dateIso || (fecha === mejor.dateIso && minutos < mejor.minutos)) {
      mejor = { dateIso: fecha, hour, minutos };
    }
  }
  if (!mejor) return null;
  return { dateIso: mejor.dateIso, hour: mejor.hour, label: fechaLarga(mejor.dateIso) };
}

// ── Disparo best-effort ──────────────────────────────────────────────────────

const TRIGGER_TIMEOUT_MS = 10_000;

/**
 * Pide a la ruta que envíe la bienvenida de una asignación. NUNCA lanza ni
 * bloquea a quien llama: el alta o el cambio de profesor ya están hechos y no
 * pueden depender de un email.
 *
 * En el navegador usa la ruta relativa. Fuera de él (el script
 * scripts/cambiar-profesor.mts) necesita NEXT_PUBLIC_APP_URL; si no está, lo
 * omite y lo avisa en consola. Con tope de 10 s para no dejar el script colgado.
 */
export async function triggerWelcomeEmail(assignmentId: string, reason: WelcomeReason): Promise<void> {
  let base = '';
  if (typeof window === 'undefined') {
    const raw = (process.env.NEXT_PUBLIC_APP_URL ?? '').trim().replace(/\/+$/, '');
    if (!raw) {
      console.warn(`[bienvenida] Sin NEXT_PUBLIC_APP_URL fuera del navegador: se omite la bienvenida de ${assignmentId}.`);
      return;
    }
    base = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRIGGER_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/assignments/${encodeURIComponent(assignmentId)}/welcome-email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) console.warn(`[bienvenida] ${assignmentId}: la ruta respondió ${res.status}`, data);
    else console.log(`[bienvenida] ${assignmentId}:`, data);
  } catch (err) {
    console.warn(`[bienvenida] ${assignmentId}: no se pudo llamar a la ruta:`, err);
  } finally {
    clearTimeout(timer);
  }
}
