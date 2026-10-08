// ¿Se puede mover ESTA sesión (o esta clase concreta) ahora? Módulo PURO.
//
// Una sola función para el núcleo (que la usa antes de escribir) y para GET
// estado (que la usa para decirle al LMS qué se puede mover y desde cuándo). Así
// el estado nunca promete algo que el POST vaya a rechazar.
//
// Reglas (cerradas, ver docs/autoservicio-contrato.md):
//   · FIJO: la PRÓXIMA clase con el horario actual tiene que empezar a más de 24 h.
//     Si no, ANTELACION_INSUFICIENTE y disponible_desde = el final de esa clase.
//   · PUNTUAL: la clase tiene que empezar a más de 24 h y como mucho a 6 semanas, y
//     ninguna casilla de la sesión puede tener una marca puntual vigente (de esta
//     semana o posterior): cada casilla admite UNA sola marca.

import type { Grid } from '@/types';
import { getSpainParts, spainWallClockToEpoch } from '@/lib/spainTime';
import { addDaysIso, dayNameFromIso, mondayIsoOfIso } from '@/lib/teacherClasses';
import { hourText } from '@/lib/sessions';
import { isPuntualState } from '@/lib/cells';
import { ANTELACION_MINIMA_MS, VENTANA_PUNTUAL_DIAS, proximaFechaDe, tieneMarcaPuntualVigente } from '@/lib/huecos/huecos';
import type { Sesion } from '@/lib/cambioHorario/sesiones';
import type { CodigoCambioHorario } from '@/lib/cambioHorario/errors';

const DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

/** Un instante en hora de España peninsular. */
export interface MomentoEspana { fecha: string; hora: string }

export type EvaluacionOrigen =
  | { ok: true }
  | {
      ok: false;
      codigo: Extract<CodigoCambioHorario, 'DATOS_INVALIDOS' | 'ANTELACION_INSUFICIENTE' | 'FUERA_DE_VENTANA' | 'MARCA_PUNTUAL_EXISTENTE'>;
      mensaje: string;
      detalles: string[];
      /** Cuándo dejará de aplicar el bloqueo (null si no aplica o no se puede saber). */
      disponibleDesde: MomentoEspana | null;
    };

const horaNum = (h: string): number => Number(h.slice(0, 2));

/** Final de la clase de `s` en `fecha` (hora de inicio + duración), en hora de España. */
export function finDeClase(s: Pick<Sesion, 'hora' | 'duracion'>, fecha: string): MomentoEspana {
  const fin = horaNum(s.hora) + s.duracion;
  // Una sesión que acaba a medianoche termina a las 00:00 del día siguiente.
  return fin >= 24 ? { fecha: addDaysIso(fecha, 1), hora: hourText(fin - 24) } : { fecha, hora: hourText(fin) };
}

/** Fecha de la casilla `clave` ('Martes_15:00') en la semana que empieza el lunes `lunes`. */
function fechaEnSemana(clave: string, lunes: string): string | null {
  const i = DIAS.indexOf(clave.slice(0, clave.lastIndexOf('_')));
  return i < 0 ? null : addDaysIso(lunes, i);
}

/**
 * Las marcas puntuales vigentes en las casillas de la sesión y la clase de cada
 * una: { clave, fecha } con la fecha de esa sesión en la semana de la marca. Una
 * marca sin semana (antigua) devuelve fecha null.
 */
export function marcasVigentesDeSesion(grid: Grid, s: Pick<Sesion, 'claves'>, hoy: string): Array<{ clave: string; fecha: string | null }> {
  return s.claves
    .filter(k => tieneMarcaPuntualVigente(grid[k], hoy))
    .map(k => {
      const c = grid[k];
      return { clave: k, fecha: c && isPuntualState(c.state) && c.weekDate ? fechaEnSemana(k, mondayIsoOfIso(c.weekDate)) : null };
    });
}

/**
 * Evalúa si la sesión `s` se puede mover en `modo` (y, en PUNTUAL, la clase de
 * `fecha`). No toca la base.
 */
export function evaluarOrigen(
  grid: Grid, s: Sesion, modo: 'puntual' | 'fijo', ahora: number, fecha?: string,
): EvaluacionOrigen {
  const limite24h = ahora + ANTELACION_MINIMA_MS;

  if (modo === 'fijo') {
    const proxima = proximaFechaDe(s.dia, horaNum(s.hora), ahora);
    if (spainWallClockToEpoch(proxima, horaNum(s.hora)) > limite24h) return { ok: true };
    return {
      ok: false, codigo: 'ANTELACION_INSUFICIENTE',
      mensaje: `la próxima clase con el horario actual (${proxima} ${s.hora}) empieza en menos de 24 h`,
      detalles: [], disponibleDesde: finDeClase(s, proxima),
    };
  }

  const fo = fecha ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fo) || dayNameFromIso(fo) !== s.dia) {
    return { ok: false, codigo: 'DATOS_INVALIDOS', mensaje: `el ${fo || '(sin fecha)'} no es ${s.dia}`, detalles: [], disponibleDesde: null };
  }
  const inicio = spainWallClockToEpoch(fo, horaNum(s.hora));
  if (!(inicio > limite24h)) {
    return { ok: false, codigo: 'ANTELACION_INSUFICIENTE', mensaje: `la clase del ${fo} a las ${s.hora} empieza en menos de 24 h`, detalles: [], disponibleDesde: null };
  }
  if (inicio > ahora + VENTANA_PUNTUAL_DIAS * 86_400_000) {
    return { ok: false, codigo: 'FUERA_DE_VENTANA', mensaje: `la clase del ${fo} está a más de ${VENTANA_PUNTUAL_DIAS / 7} semanas`, detalles: [], disponibleDesde: null };
  }
  const hoy = getSpainParts(new Date(ahora)).dateStr;
  const marcas = marcasVigentesDeSesion(grid, s, hoy);
  if (marcas.length) {
    // Deja de bloquear cuando la marca deja de estar vigente: al terminar la
    // SEMANA de la marca (lunes siguiente, 00:00), que es lo que mira
    // tieneMarcaPuntualVigente. Con varias, la más tardía. Sin semana: null.
    const fechas = marcas.map(m => m.fecha);
    const disponibleDesde = fechas.some(f => f === null)
      ? null
      : { fecha: addDaysIso(mondayIsoOfIso(fechas.sort().at(-1)!), 7), hora: '00:00' };
    return {
      ok: false, codigo: 'MARCA_PUNTUAL_EXISTENTE',
      mensaje: `la sesión ya tiene una clase movida o marcada (${marcas.map(m => m.clave).join(', ')})`,
      detalles: marcas.map(m => m.clave), disponibleDesde,
    };
  }
  return { ok: true };
}
