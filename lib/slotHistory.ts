// ── Horario de un alumno en una fecha PASADA ─────────────────────────────────
//
// El horario recurrente (`assignments.slots`, espejo del calendario) no tiene
// fechas: es el de HOY. Proyectarlo hacia atrás está bien mientras no cambie,
// pero tras un cambio de horario fijo (lo haga el profesor en su calendario o el
// alumno desde el LMS) los martes pasados desaparecían y los jueves pasados
// salían como "🔴 No ingresó", aunque esos jueves todavía no tuviera clase.
//
// calendar_changes guarda cada alta ('agregado') y baja ('quitado') de una
// casilla recurrente con su instante. Partiendo del horario de hoy y deshaciendo
// los cambios POSTERIORES a una fecha, sale el horario que tenía ese día.
//
// Límites, a propósito:
//   · calendar_changes existe desde el 29/09/2026 y TeachersContext solo carga
//     los últimos días (SLOT_CHANGES_DIAS): antes de eso se proyecta el horario
//     de hoy, como siempre.
//   · Granularidad de DÍA: vale el horario que tenía a las 00:00 (España) de esa
//     fecha. Un cambio a media mañana cuenta desde el día siguiente. El
//     autoservicio exige más de 24 h para la primera clase nueva y para la
//     última vieja, así que ahí no cambia nada.
//   · 'renombrado' no cambia horas: se ignora.
//
// Módulo PURO.

import type { AssignedSlot, SlotChange } from '@/types';
import { spainWallClockToEpoch } from '@/lib/spainTime';
import { hourNum, hourText, nkName } from '@/lib/sessions';

/** Días de historial que carga TeachersContext. */
export const SLOT_CHANGES_DIAS = 100;
/** Tiempo máximo de la carga del historial: pasado esto se sigue sin él. */
export const SLOT_CHANGES_TIMEOUT_MS = 8_000;
/** Cada cuánto se vuelve a cargar como mucho (cambia poco). */
export const SLOT_CHANGES_REFRESCO_MS = 10 * 60_000;

/**
 * Corre `carga` sin que pueda colgar ni romper a quien la llama: si lanza o si
 * tarda más de `ms`, devuelve null. El historial es un EXTRA: sin él cada vista
 * proyecta el horario de hoy, que es lo que hacía antes de existir.
 */
export async function cargarSinBloquear<T>(carga: () => Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      carga(),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ms); }),
    ]);
  } catch (err) {
    console.warn('[slotHistory] No se pudo cargar el historial de horarios; se sigue sin él:', err);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const clave = (day: string, hour: string | number) => `${day}|${hourNum(hour)}`;

/** Los cambios de UN alumno (por nombre normalizado), del más nuevo al más viejo. */
export function changesOfStudent(changes: readonly SlotChange[] | undefined, studentName: string): SlotChange[] {
  const n = nkName(studentName);
  return (changes ?? [])
    .filter(c => (c.action === 'agregado' || c.action === 'quitado') && nkName(c.studentName) === n)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/**
 * Horario que tenía el alumno el `dateIso` (a las 00:00 de España), o `null` si
 * no cambió nada desde entonces (vale el de hoy). `changes` son los de ESE
 * alumno con ESE profesor, del más nuevo al más viejo (changesOfStudent).
 */
export function slotsOnDate(current: readonly AssignedSlot[], changes: readonly SlotChange[], dateIso: string): AssignedSlot[] | null {
  const desde = spainWallClockToEpoch(dateIso, 0);
  const posteriores = changes.filter(c => Date.parse(c.createdAt) > desde);
  if (posteriores.length === 0) return null;

  const set = new Map<string, AssignedSlot>();
  for (const s of current) set.set(clave(s.day, s.hour), s);
  // Deshacer del más nuevo al más viejo: un alta posterior no existía; una baja
  // posterior sí existía.
  for (const c of posteriores) {
    const h = hourNum(c.hour);
    if (!Number.isFinite(h)) continue;
    const k = clave(c.day, h);
    if (c.action === 'agregado') set.delete(k);
    else set.set(k, { day: c.day, hour: hourText(h) });
  }
  const out = [...set.values()];
  const igual = out.length === current.length && current.every(s => set.has(clave(s.day, s.hour)));
  return igual ? null : out;
}

// ── Carga del historial en TeachersContext (testeable sin React) ─────────────

export interface RefrescoHistorialDeps {
  /** Lee calendar_changes desde `sinceIso` (dbGetSlotChanges). */
  leer: (sinceIso: string, signal: AbortSignal) => Promise<Record<string, SlotChange[]>>;
  /** Guarda el resultado (setSlotChangesByTeacher). */
  guardar: (r: Record<string, SlotChange[]>) => void;
  ahora?: () => number;
  timeoutMs?: number;
  refrescoMs?: number;
}

/**
 * La función refrescarHistorial del contexto. Pide el historial SIN que nadie
 * lo espere (devuelve void a propósito): como mucho cada `refrescoMs`, con
 * tiempo máximo y la petición cortada si se agota. Con error o sin respuesta
 * no guarda nada (cada vista proyecta el horario de hoy, como antes) y el
 * siguiente intento será en la próxima carga.
 */
export function crearRefrescoHistorial(d: RefrescoHistorialDeps): () => void {
  const ahora = d.ahora ?? Date.now;
  let ultimo = 0;
  return () => {
    if (ahora() - ultimo < (d.refrescoMs ?? SLOT_CHANGES_REFRESCO_MS)) return;
    ultimo = ahora();
    const since = new Date(ahora() - SLOT_CHANGES_DIAS * 86_400_000).toISOString();
    const corte = new AbortController();
    void cargarSinBloquear(() => d.leer(since, corte.signal), d.timeoutMs ?? SLOT_CHANGES_TIMEOUT_MS).then(r => {
      if (r === null) {
        corte.abort();
        ultimo = 0;   // reintentar en la próxima carga
        return;
      }
      d.guardar(r);
    });
  };
}

/**
 * El contrato de las cargas del contexto (ingresos, finanzas): lanzan el
 * refresco del historial y hacen SU carga sin esperarlo. Antes del arreglo
 * hacían Promise.all([carga, historial]) y, con el historial colgado,
 * /asistencias se quedaba cargando para siempre.
 */
export function cargarSinEsperarHistorial<T>(refrescarHistorial: () => void, carga: () => Promise<T>): Promise<T> {
  refrescarHistorial();
  return carga();
}
