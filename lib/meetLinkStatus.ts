// ── Estado del enlace de clase de una asignación ─────────────────────────────
// ÚNICA fuente del estado visual de "¿el profesor definió el enlace de Meet de
// este alumno?". La usan el panel del profesor (badge en Mis clases y Avisos,
// pop-up del NavBar) y el admin (pestaña Enlaces, columna de Profesores y el
// contador de la barra móvil).
//
// Desde la Fase 2 (sep/2026) el profesor ya no envía email de presentación: la
// plataforma le escribe al alumno sola (lib/welcomeEmailSend) y lo único que le
// toca al profesor es DEFINIR EL ENLACE. "Hecho" = meet_link_set_at no nulo,
// que solo escribe la ruta PUT /api/assignments/[assignmentId]/meet-link.
//
// Mismos plazos que tenía el email (4 / 12 / 24 h desde created_at). Los usan
// también el cron de recordatorios (lib/meetLinkReminders) y la penalización
// por enlace tardío (shouldPenalizeLateLink, más abajo).
//
// Branding DRC: verde #1E9E3A, amarillo #FFC400, naranja #f97316, rojo #ef4444.

import { WELCOME_EMAIL_START_DATE } from '@/lib/welcomeEmail';
import { spainWallClockToEpoch } from '@/lib/spainTime';

const MS_PER_HOUR = 3_600_000;

export const LINK_WARNING_HOURS = 4;
export const LINK_AT_RISK_HOURS = 12;
export const LINK_DEADLINE_HOURS = 24;

export type MeetLinkStatusKind = 'defined' | 'on_time' | 'warning' | 'at_risk' | 'overdue';

export interface MeetLinkStatus {
  defined: boolean;
  status: MeetLinkStatusKind;
  hoursElapsed: number;    // horas completas desde la asignación
  minutesElapsed: number;  // minutos de la hora en curso (0-59)
  badgeColor: string;
  badgeText: string;
  subtextMessage: string;
  pulse: boolean;          // verde pulsante (on_time)
  blink: boolean;          // rojo parpadeante (overdue)
}

/** Forma mínima que necesita el helper. Compatible con Assignment (@/types). */
export interface MeetLinkInput {
  meetLinkSetAt?: string | null;
  createdAt: string;
}

/** ¿El profesor ya definió el enlace? */
export function isMeetLinkDefined(a: { meetLinkSetAt?: string | null }): boolean {
  return Boolean(a.meetLinkSetAt);
}

/** "3h 20min" / "5h" (omite los minutos cuando son 0). */
export function formatElapsed(hours: number, minutes: number): string {
  const h = Math.max(0, Math.floor(hours));
  const m = Math.max(0, Math.floor(minutes));
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

/** Horas (con decimales) desde la asignación. */
export function hoursSinceAssignment(createdAt: string, now: number = Date.now()): number {
  return Math.max(0, (now - new Date(createdAt).getTime()) / MS_PER_HOUR);
}

/** `now` inyectable para tests y para que el badge se recalcule con un reloj propio. */
export function getMeetLinkStatus(a: MeetLinkInput, now: number = Date.now()): MeetLinkStatus {
  const totalMinutes = Math.floor(Math.max(0, now - new Date(a.createdAt).getTime()) / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const totalHours = totalMinutes / 60;
  const hace = formatElapsed(hours, minutes);
  const base = { hoursElapsed: hours, minutesElapsed: minutes, pulse: false, blink: false };

  if (isMeetLinkDefined(a)) {
    return { ...base, defined: true, status: 'defined', badgeColor: '#1E9E3A', badgeText: '✅ Enlace definido', subtextMessage: '' };
  }
  if (totalHours < LINK_WARNING_HOURS) {
    return {
      ...base, defined: false, status: 'on_time', badgeColor: '#1E9E3A', pulse: true,
      badgeText: `🔗 Enlace pendiente · Hace ${hace}`,
      subtextMessage: 'Defínelo cuanto antes: es el que usará el alumno para entrar a clase',
    };
  }
  if (totalHours < LINK_AT_RISK_HOURS) {
    return {
      ...base, defined: false, status: 'warning', badgeColor: '#FFC400',
      badgeText: `⚠️ Enlace pendiente · Hace ${hace}`,
      subtextMessage: 'Sin enlace, el alumno no tiene botón para unirse a la clase',
    };
  }
  if (totalHours < LINK_DEADLINE_HOURS) {
    const remaining = Math.max(1, LINK_DEADLINE_HOURS - hours);
    return {
      ...base, defined: false, status: 'at_risk', badgeColor: '#f97316',
      badgeText: `⏰ Enlace pendiente · Hace ${hace} — te queda poco tiempo`,
      subtextMessage: `Tienes menos de ${remaining}h para definirlo a tiempo`,
    };
  }
  return {
    ...base, defined: false, status: 'overdue', badgeColor: '#ef4444', blink: true,
    badgeText: `🔴 Enlace sin definir · Hace ${hace} — fuera de plazo`,
    subtextMessage: 'Defínelo ya: el alumno no puede unirse a la clase sin él',
  };
}

// ── Penalización por enlace tardío (scoring 'enlace_tardio', -5) ─────────────

/**
 * Corte de la penalización: solo asignaciones creadas desde esta fecha (hora de
 * España). Es la misma que la de la bienvenida automática: antes de ella el
 * profesor no tenía este flujo, y las asignaciones antiguas sin enlace (o con
 * el enlace vaciado a mano) nunca penalizan al definirse.
 */
export const MEET_LINK_PENALTY_START_DATE = WELCOME_EMAIL_START_DATE;

/**
 * ¿Definir AHORA el enlace penaliza? Solo si es la PRIMERA vez que se define
 * (antes no había meet_link_set_at), la asignación es del corte en adelante y
 * pasaron más de 24 h desde created_at. Cambiar un enlace ya definido nunca
 * penaliza. Exactamente 24 h todavía cuenta como a tiempo.
 */
export function shouldPenalizeLateLink(x: {
  createdAt: string;
  previousSetAt: string | null | undefined;
  now?: number;
}): boolean {
  if (x.previousSetAt) return false;
  const created = new Date(x.createdAt).getTime();
  if (isNaN(created)) return false;
  if (created < spainWallClockToEpoch(MEET_LINK_PENALTY_START_DATE, 0, 0)) return false;
  return hoursSinceAssignment(x.createdAt, x.now ?? Date.now()) > LINK_DEADLINE_HOURS;
}
