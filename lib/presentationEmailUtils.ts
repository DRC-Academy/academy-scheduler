// ── Estado del email de presentación ─────────────────────────────────────────
// ÚNICA fuente de verdad del estado visual del seguimiento del email de bienvenida
// (el que el profesor debe enviar al alumno dentro de las primeras 24 h tras la
// asignación). La usan el panel del profesor (badge dinámico en Avisos y Próximas
// clases), el panel del admin (columna + resumen) y el cron de alertas, para
// garantizar consistencia visual y de umbrales.
//
// Branding DRC: verde #1E9E3A, amarillo #FFC400, naranja #f97316, rojo #ef4444.

const MS_PER_HOUR = 3_600_000;

// Umbrales (horas) desde la asignación.
export const PRESENTATION_WARNING_HOURS = 4;   // recordatorio directo al profe
export const PRESENTATION_AT_RISK_HOURS = 12;  // aviso al admin
export const PRESENTATION_DEADLINE_HOURS = 24; // fuera de tiempo → -5 puntos al enviar
export const PRESENTATION_LATE_PENALTY = -5;

export type PresentationEmailStatusKind = 'sent' | 'on_time' | 'warning' | 'at_risk' | 'overdue';

export interface PresentationEmailStatus {
  sent: boolean;
  sentAt: string | null;
  createdAt: string;
  hoursElapsed: number;    // horas completas transcurridas (enteras)
  minutesElapsed: number;  // minutos restantes de la hora en curso (0-59)
  status: PresentationEmailStatusKind;
  badgeColor: string;
  badgeText: string;
  subtextMessage: string;
  pulse: boolean;          // verde pulsante (on_time)
  blink: boolean;          // rojo parpadeante (overdue)
}

// Forma mínima que necesita el helper. Compatible con Assignment (@/types) y con
// cualquier objeto que exponga estos campos (p. ej. filas del cron ya mapeadas).
export interface PresentationEmailInput {
  presentationEmailSent?: boolean | null;
  presentationEmailSentAt?: string | null;
  createdAt: string;
}

// "3h 20min" / "5h" (omite los minutos cuando son 0).
export function formatTime(hours: number, minutes: number): string {
  const h = Math.max(0, Math.floor(hours));
  const m = Math.max(0, Math.floor(minutes));
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

// Divide un lapso en ms en horas enteras + minutos restantes.
function splitElapsed(ms: number): { hours: number; minutes: number; totalHours: number } {
  const safe = Math.max(0, ms);
  const totalMinutes = Math.floor(safe / 60_000);
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60, totalHours: safe / MS_PER_HOUR };
}

// `now` inyectable para tests y para que el badge se recalcule con un reloj propio.
export function getPresentationEmailStatus(
  assignment: PresentationEmailInput,
  now: number = Date.now(),
): PresentationEmailStatus {
  const createdAt = assignment.createdAt;
  const createdMs = new Date(createdAt).getTime();

  // ── Ya enviado ──────────────────────────────────────────────────────────────
  if (assignment.presentationEmailSent) {
    const sentAt = assignment.presentationEmailSentAt ?? null;
    const sinceSent = sentAt ? splitElapsed(now - new Date(sentAt).getTime()) : { hours: 0, minutes: 0, totalHours: 0 };
    return {
      sent: true,
      sentAt,
      createdAt,
      hoursElapsed: sinceSent.hours,
      minutesElapsed: sinceSent.minutes,
      status: 'sent',
      badgeColor: '#1E9E3A',
      badgeText: `✅ Email enviado hace ${formatTime(sinceSent.hours, sinceSent.minutes)}`,
      subtextMessage: '',
      pulse: false,
      blink: false,
    };
  }

  // ── Pendiente ────────────────────────────────────────────────────────────────
  const { hours, minutes, totalHours } = splitElapsed(now - createdMs);
  const base = { sent: false as const, sentAt: null, createdAt, hoursElapsed: hours, minutesElapsed: minutes };

  if (totalHours < PRESENTATION_WARNING_HOURS) {
    return {
      ...base,
      status: 'on_time',
      badgeColor: '#1E9E3A',
      badgeText: `📧 Email pendiente · Hace ${formatTime(hours, minutes)}`,
      subtextMessage: 'Envíalo cuanto antes para dar buena impresión',
      pulse: true,
      blink: false,
    };
  }

  if (totalHours < PRESENTATION_AT_RISK_HOURS) {
    return {
      ...base,
      status: 'warning',
      badgeColor: '#FFC400',
      badgeText: `⚠️ Email pendiente · Hace ${formatTime(hours, minutes)}`,
      subtextMessage: 'Los alumnos que reciben bienvenida pronto tienen mayor retención',
      pulse: false,
      blink: false,
    };
  }

  if (totalHours < PRESENTATION_DEADLINE_HOURS) {
    const remaining = Math.max(1, PRESENTATION_DEADLINE_HOURS - hours);
    return {
      ...base,
      status: 'at_risk',
      badgeColor: '#f97316',
      badgeText: `⏰ Email pendiente · Hace ${formatTime(hours, minutes)} — te queda poco tiempo`,
      subtextMessage: `Tienes menos de ${remaining}h para enviarlo a tiempo`,
      pulse: false,
      blink: false,
    };
  }

  return {
    ...base,
    status: 'overdue',
    badgeColor: '#ef4444',
    badgeText: `🔴 Email no enviado · Hace ${formatTime(hours, minutes)} — fuera de tiempo`,
    subtextMessage: 'Esto afecta a tu scoring (-5 puntos al enviarlo)',
    pulse: false,
    blink: true,
  };
}

// Horas (float) transcurridas desde la asignación. Útil para el API y el cron.
export function hoursSinceAssigned(createdAt: string, now: number = Date.now()): number {
  return Math.max(0, (now - new Date(createdAt).getTime()) / MS_PER_HOUR);
}
