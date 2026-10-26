// ── Hora de España (Europe/Madrid) ────────────────────────────────────────────
//
// El calendario, los horarios de clase y todo lo que diga "las 15:00" se refieren
// SIEMPRE a la hora de pared española, sin importar dónde esté el navegador que
// mira. Los alumnos están en España y los profesores en Argentina (5 h de
// diferencia en el verano español, 4 h en el invierno), así que cualquier cálculo
// que use `new Date(y, m, d, h)` —que construye en la zona del navegador— da
// resultados distintos según quién lo abra.
//
// Estas dos funciones son la conversión en ambos sentidos y son la ÚNICA forma
// correcta de cruzar horas de clase con instantes reales.

/** Instante → hora de pared en España (hora, minuto y fecha YYYY-MM-DD). */
export function getSpainParts(now: Date): { hour: number; minute: number; dateStr: string } {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00';
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0; // some runtimes emit '24' for midnight
  return {
    hour,
    minute: parseInt(get('minute'), 10),
    dateStr: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

/**
 * Hora de pared española → instante absoluto (epoch ms). El inverso de
 * getSpainParts: "2026-07-24 15:00 en España" → el momento real en que ocurre.
 *
 * El offset de Madrid cambia con el horario de verano, así que no se puede
 * hardcodear: se interpreta la hora como si fuera UTC, se mira qué hora española
 * corresponde a ese instante y se corrige por la diferencia observada.
 */
export function spainWallClockToEpoch(dateIso: string, hour: number, minute = 0): number {
  const [y, m, d] = dateIso.split('-').map(Number);
  if (!y || !m || !d || isNaN(hour)) return NaN;
  const asUtc = Date.UTC(y, m - 1, d, hour, minute, 0, 0);
  const parts = getSpainParts(new Date(asUtc));
  const [py, pm, pd] = parts.dateStr.split('-').map(Number);
  const spainAsUtc = Date.UTC(py, pm - 1, pd, parts.hour, parts.minute, 0, 0);
  return asUtc - (spainAsUtc - asUtc);
}

/**
 * Hora de pared española de un día concreto → hora de pared en Argentina (0–23).
 * La diferencia NO es fija: Argentina no cambia de hora y España sí, así que son
 * 5 h en el verano español y 4 h en el invierno. Por eso hace falta la fecha.
 */
export function spainHourToArgentinaHour(dateIso: string, hour: number): number {
  const epoch = spainWallClockToEpoch(dateIso, hour);
  if (isNaN(epoch)) return NaN;
  const h = parseInt(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', hour12: false,
  }).format(new Date(epoch)), 10);
  return h === 24 ? 0 : h;
}

/**
 * Minutos de retraso entre una clase programada (fecha + "HH:00" en hora española)
 * y el momento del clic. Negativo = se adelantó. NaN si la fecha no es válida.
 */
export function minutesLateSpain(scheduledDate: string, scheduledTime: string, clickedAt: Date | string | number): number {
  const hour = parseInt(scheduledTime);
  const scheduled = spainWallClockToEpoch(scheduledDate, isNaN(hour) ? 0 : hour);
  if (isNaN(scheduled)) return NaN;
  return (new Date(clickedAt).getTime() - scheduled) / 60000;
}
