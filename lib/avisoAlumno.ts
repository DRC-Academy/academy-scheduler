// ── ¿Con cuánta antelación avisó el alumno? ───────────────────────────────────
//
// La garantía del plan (la calcula el LMS) cuenta como NO asistida la clase que
// el alumno cancela con menos de 24 h de antelación. Hasta ahora Gestión no
// guardaba cuándo avisó: `class_records.created_at` es cuándo el profesor sube
// la constancia —a menudo horas después de la clase— y la diferencia entre
// "avisó con anticipación" (→ 'reprogramada') y "avisó sobre la hora"
// (→ 'cancelacion_hora') la elegía el profesor a ojo, sin umbral.
//
// Ahora el profesor dice CUÁNDO le avisó (hora de España) y el tipo sale de acá.
// Puro: sin base, sin React, sin reloj propio (el "ahora" entra por parámetro).

import { getSpainParts, spainWallClockToEpoch } from './spainTime';
import type { CanceladoPor, ClassRecordType } from '@/types';

/** 24 h: por debajo, el aviso es "sobre la hora". Exactamente 24 h es a tiempo. */
export const ANTELACION_MINIMA_MIN = 24 * 60;

export interface AntelacionAviso {
  /** Minutos enteros entre el aviso y el inicio de la clase. Negativo = avisó con la clase ya empezada. */
  minutos: number;
  /** Menos de 24 h de antelación: cancelación sobre la hora. */
  tarde: boolean;
}

/** 'HH' | 'H:M' | 'HH:MM' → [hora, minuto]. NaN si no se entiende. */
function horaMinuto(hora: string): [number, number] {
  const [h, m = '0'] = String(hora ?? '').trim().split(':');
  return [parseInt(h, 10), parseInt(m, 10)];
}

/**
 * Antelación del aviso respecto de la clase.
 *
 * La clase es fecha 'YYYY-MM-DD' + hora 'HH:MM' en hora de pared ESPAÑOLA (la del
 * calendario); el aviso es un instante real. La conversión la hace
 * `spainWallClockToEpoch`, que resuelve el cambio de hora: la víspera del
 * 25/10/2026 tiene 25 h de reloj, y restar horas de pared daría una de menos.
 *
 * `tarde` se decide con los milisegundos, no con los minutos redondeados: 23 h
 * 59 min 30 s es tarde aunque se muestre como "23 h 59 min".
 *
 * null si la fecha, la hora o el aviso no son válidos.
 */
export function antelacionDelAviso(
  claseFecha: string, claseHora: string, avisadoEn: Date | string | number,
): AntelacionAviso | null {
  const [h, m] = horaMinuto(claseHora);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const clase = spainWallClockToEpoch(claseFecha, h, m);
  const aviso = new Date(avisadoEn).getTime();
  if (!Number.isFinite(clase) || !Number.isFinite(aviso)) return null;
  const diff = clase - aviso;
  return { minutos: Math.floor(diff / 60_000), tarde: diff < ANTELACION_MINIMA_MIN * 60_000 };
}

/** Tipo de la constancia según la antelación: el que antes elegía el profesor a ojo. */
export function tipoPorAntelacion(a: AntelacionAviso): 'reprogramada' | 'cancelacion_hora' {
  return a.tarde ? 'cancelacion_hora' : 'reprogramada';
}

/** "23 h 59 min", "25 h", "40 min". Con la clase ya empezada: "0 min". */
export function textoAntelacion(minutos: number): string {
  const total = Math.max(0, minutos);
  const h = Math.floor(total / 60);
  const min = total % 60;
  if (h === 0) return `${min} min`;
  return min === 0 ? `${h} h` : `${h} h ${min} min`;
}

/** "Avisó con 23 h 59 min de antelación" · "Avisó con la clase ya empezada". */
export function fraseAntelacion(a: AntelacionAviso): string {
  return a.minutos < 0 ? 'Avisó con la clase ya empezada' : `Avisó con ${textoAntelacion(a.minutos)} de antelación`;
}

// ── El campo "¿Cuándo te avisó?" ──────────────────────────────────────────────

/** Lo que tiene el formulario: fecha y hora de pared en España. */
export interface AvisoEnEspana { fecha: string; hora: string }

/** "Ahora" en hora de España: el valor por defecto del campo. */
export function avisoAhoraEnEspana(nowMs: number): AvisoEnEspana {
  const p = getSpainParts(new Date(nowMs));
  return { fecha: p.dateStr, hora: `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}` };
}

/** Fecha y hora de España del formulario → instante (epoch ms). NaN si está incompleto. */
export function instanteDelAviso(a: AvisoEnEspana): number {
  if (!a.fecha || !a.hora) return NaN;
  const [h, m] = horaMinuto(a.hora);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
  return spainWallClockToEpoch(a.fecha, h, m);
}

/**
 * Por qué el aviso no vale, o null si vale. El aviso es obligatorio y no puede
 * ser futuro; se tolera un minuto de margen porque el campo no lleva segundos.
 */
export function problemaDelAviso(a: AvisoEnEspana, nowMs: number): string | null {
  const t = instanteDelAviso(a);
  if (!Number.isFinite(t)) return 'Indica el día y la hora en que te avisó.';
  if (t > nowMs + 60_000) return 'El aviso no puede ser en el futuro.';
  return null;
}

// ── Quién canceló ─────────────────────────────────────────────────────────────

/**
 * Quién canceló, cuando el tipo de la constancia lo dice sin ambigüedad. La
 * 'reprogramada' no: la puede pedir el alumno o el profesor, así que la decide
 * quien la crea. Las clases dadas no tienen cancelación (undefined).
 */
export function canceladoPorDelTipo(tipo: ClassRecordType | undefined): CanceladoPor | undefined {
  switch (tipo) {
    case 'falta_sin_aviso':
    case 'falta_con_aviso':
    case 'cancelacion_hora':
      return 'alumno';
    case 'cancelada_por_profesor':
    case 'cancelada_con_preaviso':
      return 'profesor';
    default:
      return undefined;
  }
}
