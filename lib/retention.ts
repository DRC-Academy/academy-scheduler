// Retención / bono de 6 meses: FUENTE ÚNICA de verdad.
// Antes había tres cálculos distintos (pestaña Scoring, aviso de Avisos y banner
// del panel) con reglas que no coincidían: algunos exigían `startDate` y
// descartaban en silencio las asignaciones sin fecha, por lo que el bono nunca
// se detectaba para asignaciones nuevas. Estas funciones unifican la lógica.

import type { Assignment, ScoringEvent } from '@/types';

// Días de continuidad necesarios para el bono de retención (6 meses).
export const RETENTION_BONUS_DAYS = 180;

// Normaliza un nombre para comparaciones tolerantes (trim + lower + sin acentos).
export function normName(x: unknown): string {
  return String(x ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Fecha de inicio EFECTIVA de la continuidad: `startDate` si existe, si no
// `createdAt`. Nunca devuelve null, así el reloj de retención SIEMPRE arranca
// (esa era la causa de que el bono no se aplicara en asignaciones sin fecha).
export function retentionStartDate(a: { startDate?: string; createdAt?: string }): Date {
  const raw = a.startDate || a.createdAt;
  if (!raw) return new Date();
  // 'YYYY-MM-DD' se interpreta como local; un ISO completo se usa tal cual.
  const d = new Date(raw.length <= 10 ? `${raw}T00:00:00` : raw);
  return isNaN(d.getTime()) ? new Date() : d;
}

// Días de continuidad a una fecha de referencia (por defecto, hoy).
export function retentionDaysActive(a: { startDate?: string; createdAt?: string }, now: Date = new Date()): number {
  const start = retentionStartDate(a);
  return Math.floor((now.getTime() - start.getTime()) / 86400000);
}

// Fecha en la que el alumno cumple los 6 meses.
export function retentionBonusDate(a: { startDate?: string; createdAt?: string }): Date {
  return new Date(retentionStartDate(a).getTime() + RETENTION_BONUS_DAYS * 86400000);
}

// ¿Ya se otorgó el bono de retención a este alumno? Match tolerante por nombre
// (antes comparaba con === exacto y fallaba por mayúsculas/acentos/espacios).
export function hasRetentionBonus(events: ScoringEvent[], studentName: string): boolean {
  const target = normName(studentName);
  return events.some(e => e.eventType === 'bonus_retencion' && normName(e.studentRef) === target);
}

// ¿Corresponde el bono? (≥180 días de continuidad y todavía no otorgado).
export function isRetentionBonusDue(a: Assignment, events: ScoringEvent[], now: Date = new Date()): boolean {
  return retentionDaysActive(a, now) >= RETENTION_BONUS_DAYS && !hasRetentionBonus(events, a.studentName);
}
