'use client';
import { useCallback, useRef } from 'react';
import type { Grid } from '@/types';
import { useTeachers } from '@/lib/TeachersContext';
import type { CalendarOrigin, GridSaveResult } from '@/lib/db';
import { splitCellKey } from '@/lib/gridPatch';

export interface GridSaveOutcome extends GridSaveResult {
  /**
   * true = no queda ningún otro guardado de esta pantalla en camino. Solo
   * entonces la pantalla debe adoptar `grid` (el calendario real): si adoptara
   * antes, "desharía" en pantalla un clic que todavía se está guardando.
   */
  idle: boolean;
}

/**
 * Guardado del calendario por casillas para una pantalla. Los guardados de la
 * misma pantalla van EN FILA: cada uno compara contra lo que dejó el anterior,
 * así dos clics rápidos no se toman por un choque con otra persona.
 */
export function useGridSaver(origin: CalendarOrigin) {
  const { saveTeacherGridChanges } = useTeachers();
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);

  return useCallback(async (teacherId: string, prev: Grid, next: Grid): Promise<GridSaveOutcome> => {
    pending.current++;
    const run = chain.current.then(() => saveTeacherGridChanges(teacherId, prev, next, origin));
    chain.current = run.catch(() => undefined);
    try {
      const r = await run;
      return { ...r, idle: pending.current === 1 };
    } finally {
      pending.current--;
    }
  }, [saveTeacherGridChanges, origin]);
}

/** Texto para el aviso de casillas que no se pisaron. */
export function conflictMessage(conflicts: string[]): string {
  const lista = conflicts
    .map(k => { const p = splitCellKey(k); return p ? `${p.day} ${p.hour}` : k; })
    .join(', ');
  return conflicts.length === 1
    ? `La casilla ${lista} la cambió otra persona mientras tanto. No se pisó: el calendario se actualizó con lo último.`
    : `Estas ${conflicts.length} casillas las cambió otra persona mientras tanto: ${lista}. No se pisaron: el calendario se actualizó con lo último.`;
}

/** Texto para el error de lectura/guardado que bloquea la edición. */
export function calendarErrorMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `No se pudo acceder al calendario (${detail}). Para no perder datos, no se puede editar hasta que se vuelva a cargar.`;
}
