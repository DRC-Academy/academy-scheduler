// "Se guardó un transcript": aviso dentro del navegador para que TODA la app lo
// vea al instante, sin esperar a la próxima recarga de datos.
//
// Por qué hace falta: los transcripts del contexto (TeachersContext.classAnalyses)
// solo se recargaban si la pantalla que guardaba llamaba a loadFinanceData. La
// ficha del alumno no lo hacía, y la recarga completa tarda unos 5 s: mientras
// tanto el pop-up, el banner y las tarjetas seguían diciendo "falta el
// transcript" de una clase que ya lo tenía.
//
// Lo emite lib/aiClient en cuanto el servidor confirma el guardado (es el único
// camino del navegador hacia class_analyses) y lo escucha TeachersContext.
//
// Sin dependencias: lo importan el cliente de IA y el contexto.

import type { ClassTranscriptRef } from '@/lib/transcriptDeadline';

/** La fila tal como quedó guardada (lo mínimo que mira la regla del transcript). */
export type SavedTranscriptRow = ClassTranscriptRef & { id: string };

type Listener = (row: SavedTranscriptRow) => void;
const listeners = new Set<Listener>();

export function onTranscriptSaved(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function emitTranscriptSaved(row: SavedTranscriptRow): void {
  for (const fn of listeners) {
    try { fn(row); } catch (err) { console.error('[transcriptSaved] Fallo de un oyente:', err); }
  }
}

/**
 * Fila que se añade al estado local tras guardar. `validation_status` sale de la
 * decisión de la validación: 'ok' cuenta como subido y validado; cualquier otra
 * cosa queda 'review' (subido, en revisión), igual que statusForDecision.
 */
export function savedTranscriptRow(args: {
  id: string;
  teacherId?: string | null;
  studentName: string;
  classDate?: string | null;
  joinLogId?: string | null;
  decision?: string | null;
  now?: number;
}): SavedTranscriptRow {
  return {
    id: args.id,
    teacher_id: args.teacherId ?? null,
    student_name: args.studentName,
    class_date: args.classDate ?? null,
    analyzed_at: new Date(args.now ?? Date.now()).toISOString(),
    has_transcript: true,
    join_log_id: args.joinLogId ?? null,
    validation_status: args.decision === 'ok' ? 'ok' : 'review',
  };
}

/** Guardado local pendiente de que una carga desde la base lo traiga. */
export interface LocalTranscript { row: SavedTranscriptRow; at: number }

/**
 * Mezcla lo recién cargado con lo guardado en local.
 *
 *   · Guardado ANTES de que empezara la carga → la base ya lo trae: se suelta.
 *   · Guardado DESPUÉS (la carga salió antes de guardar) → la base todavía no lo
 *     tiene, o lo tiene con los datos viejos (un reemplazo): manda el local.
 *
 * Modifica `local` (suelta lo que ya llegó). Devuelve el array a usar.
 */
export function mergeLocalTranscripts<T extends ClassTranscriptRef>(
  fetched: T[], local: Map<string, LocalTranscript>, fetchStartedAt: number,
): T[] {
  if (local.size === 0) return fetched;
  const pending = new Map<string, SavedTranscriptRow>();
  for (const [id, l] of local) {
    if (l.at < fetchStartedAt) local.delete(id);
    else pending.set(id, l.row);
  }
  if (pending.size === 0) return fetched;
  const out = fetched.map(r => {
    const p = r.id ? pending.get(r.id) : undefined;
    if (!p) return r;
    pending.delete(r.id!);
    return replaced(r, p);
  });
  return [...[...pending.values()] as unknown as T[], ...out];
}

/** Añade o reemplaza (por id) una fila guardada en la lista de transcripts. */
export function upsertTranscript<T extends ClassTranscriptRef>(list: T[], row: SavedTranscriptRow): T[] {
  const i = list.findIndex(r => r.id === row.id);
  if (i < 0) return [row as unknown as T, ...list];
  const next = list.slice();
  next[i] = replaced(list[i], row);
  return next;
}

/**
 * Un REEMPLAZO de transcript (replaceId) reescribe el texto, la validación y el
 * vínculo, pero no el alumno ni la fecha de la fila (persistTranscript no los
 * toca): se conservan los de la fila que ya estaba.
 */
function replaced<T extends ClassTranscriptRef>(old: T, row: SavedTranscriptRow): T {
  return { ...old, ...row, student_name: old.student_name, class_date: old.class_date } as T;
}
