// Scoring y retención de profesores con el cliente de Supabase INYECTADO.
//
// Es el código que vivía en lib/db.ts (dbAddScoringEvent, dbRecalculateTeacherScore,
// la retención y las pausas), movido aquí para que el servidor lo use con la
// service key. lib/db.ts delega en estas funciones con su cliente de siempre.
//
// NO importa lib/supabase.ts.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Grid, ScoringEvent } from '@/types';

type Db = SupabaseClient;

// Ventana (en días) sobre la que se cuentan las bajas para la retención. Una
// baja fuera de esta ventana ya no penaliza (la retención mira el pasado reciente).
export const RETENTION_WINDOW_DAYS = 90;

// Fórmula única de retención (churn-aware). `retained` = alumnos activos hoy;
// `dropouts` = bajas dentro de la ventana. Sin datos (0 y 0) devuelve 100 para
// no penalizar a un profesor nuevo o sin actividad reciente.
//   retención = retained / (retained + dropouts) × 100
export function retentionRateFromCounts(retained: number, dropouts: number): number {
  const denom = retained + dropouts;
  if (denom === 0) return 100;
  return (retained / denom) * 100;
}

/** Regla única de "profesor bloqueado": tiene alumnos y su retención baja del 65 %. */
export function isBlockedFrom(activeStudents: number, retention: number): boolean {
  return activeStudents > 0 && retention < 65;
}

// Cuenta las bajas de un profesor dentro de la ventana de retención.
export async function getDropoutCountWith(db: Db, teacherId: string): Promise<number> {
  const since = new Date(Date.now() - RETENTION_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { count } = await db
    .from('student_dropouts')
    .select('id', { count: 'exact', head: true })
    .eq('teacher_id', teacherId)
    .gte('dropped_at', since);
  return count ?? 0;
}

// Alumnos EN PAUSA ahora (pausas abiertas de student_pauses), por id y por
// nombre normalizado. No son activos (no suman a la retención ni al puntaje) ni
// bajas (pausar no escribe en student_dropouts). Sin la tabla, vacío: nadie en
// pausa, como antes.
export async function getOpenPauseKeysWith(db: Db): Promise<Set<string>> {
  const { data, error } = await db.from('student_pauses').select('student_id, student_name').is('ended_on', null);
  const out = new Set<string>();
  if (error) return out;
  for (const r of (data ?? []) as Array<{ student_id?: string | null; student_name?: string | null }>) {
    if (r.student_id) out.add(r.student_id);
    const n = (r.student_name ?? '').trim().toLowerCase();
    if (n) out.add(n);
  }
  return out;
}

function enPausa(paused: Set<string>, studentId?: string | null, studentName?: string | null): boolean {
  if (paused.size === 0) return false;
  return (!!studentId && paused.has(studentId)) || paused.has((studentName ?? '').trim().toLowerCase());
}

type AsgRow = { student_id?: string | null; student_name?: string | null };

/** Alumnos que cuentan para la retención de un profesor (sin los EN PAUSA). */
function countActive(rows: AsgRow[], paused: Set<string>): number {
  return rows.filter(a => !enPausa(paused, a.student_id, a.student_name)).length;
}

/** Retención y bloqueo de un profesor, con la misma regla que el recálculo del score. */
export async function teacherRetentionWith(db: Db, teacherId: string): Promise<{ activeStudents: number; retention: number; isBlocked: boolean }> {
  const [{ data }, dropouts, paused] = await Promise.all([
    db.from('assignments').select('id, student_id, student_name').eq('teacher_id', teacherId),
    getDropoutCountWith(db, teacherId),
    getOpenPauseKeysWith(db),
  ]);
  const activeStudents = countActive((data ?? []) as AsgRow[], paused);
  const retention = retentionRateFromCounts(activeStudents, dropouts);
  return { activeStudents, retention, isBlocked: isBlockedFrom(activeStudents, retention) };
}

// ── SCORE RECALCULATION ───────────────────────────────────────────────────────

export async function recalculateTeacherScoreWith(db: Db, teacherId: string): Promise<void> {
  const [evRes, asRes, calRes, dropouts, paused] = await Promise.all([
    db.from('scoring_events').select('points, euros').eq('teacher_id', teacherId),
    db.from('assignments').select('id, student_id, student_name').eq('teacher_id', teacherId),
    db.from('teacher_calendars').select('grid').eq('teacher_id', teacherId).single(),
    getDropoutCountWith(db, teacherId),
    getOpenPauseKeysWith(db),
  ]);

  const evs = (evRes.data ?? []) as Array<{ points?: number | null; euros?: number | null }>;
  const manualPoints = evs.reduce((s, e) => s + (e.points ?? 0), 0);
  const manualEuros  = evs.reduce((s, e) => s + (e.euros ?? 0), 0);

  // Los EN PAUSA no cuentan: ni como alumno activo ni sus celdas como horas.
  const activeStudents = countActive((asRes.data ?? []) as AsgRow[], paused);
  const grid = ((calRes.data?.grid ?? {}) as Grid);
  const ocupado = Object.values(grid)
    .filter(c => c.state === 'ocupado' && !enPausa(paused, null, c.student)).length;
  const monthlyHours = ocupado * 4;

  // Retención churn-aware: activos vs. bajas de la ventana (ver retentionRateFromCounts).
  const ret = retentionRateFromCounts(activeStudents, dropouts);

  let auto = activeStudents * 10 + monthlyHours * 2;
  if (ret >= 85)                              auto += 50;
  else if (ret >= 80)                         auto += 25;
  else if (ret < 65 && activeStudents > 0)    auto -= 30;

  const totalScore   = Math.max(0, manualPoints + auto);
  const totalEuros   = Math.max(0, manualEuros);
  const currentLevel = totalScore >= 300 ? 3 : totalScore >= 150 ? 2 : 1;
  const isBlocked    = isBlockedFrom(activeStudents, ret);

  // TODO(scoring): este UPDATE FALLA SIEMPRE (42703) porque teachers no tiene
  // las columnas is_blocked, retention_rate ni score (comprobado el 07/10/2026).
  // PostgREST rechaza el UPDATE entero, así que tampoco se guardan total_score,
  // total_euros ni current_level: por eso total_score vale 0 en todos los
  // profesores y ninguna pantalla ve a nadie bloqueado. El error no se comprueba
  // a propósito para no cambiar el comportamiento; arreglar el scoring es una
  // tarea aparte (decidir las columnas y qué es "bloqueado").
  await db.from('teachers')
    .update({
      total_score:    totalScore,
      total_euros:    totalEuros,
      current_level:  currentLevel,
      is_blocked:     isBlocked,
      retention_rate: Math.round(ret),
    })
    .eq('id', teacherId);
}

/**
 * Guarda un evento de scoring y recalcula el score del profesor.
 *
 * LANZA si el INSERT falla. Antes se ignoraba el error y se devolvía el objeto
 * como si estuviera guardado: el contexto lo metía en el estado local y en
 * pantalla parecía aplicado hasta recargar. Con las columnas `student_ref` y
 * `quantity` sin migrar, PostgREST rechazaba TODOS los inserts (PGRST204) y no
 * se guardó ni un solo evento durante semanas sin que nadie lo notara.
 *
 * `opts.id` fija el id del evento. Lo usa la penalización por enlace tardío
 * (se_enlace_tardio_<asignación>_<profe>) para que la clave primaria impida
 * aplicarla dos veces: un duplicado lanza con el código 23505 de Postgres.
 */
export async function addScoringEventWith(
  db: Db, event: Omit<ScoringEvent, 'id' | 'createdAt'>, opts: { id?: string } = {},
): Promise<ScoringEvent> {
  const id        = opts.id ?? `se_${Date.now()}`;
  const createdAt = new Date().toISOString();

  const row = {
    id,
    teacher_id:   event.teacherId,
    teacher_name: event.teacherName,
    event_type:   event.eventType,
    points:       event.points,
    euros:        event.euros,
    note:         event.note,
    created_by:   event.createdBy,
    student_ref:  event.studentRef ?? null,
    quantity:     event.quantity ?? null,
    created_at:   createdAt,
  };

  let { error } = await db.from('scoring_events').insert(row);

  // Si faltan las columnas opcionales (migración sin correr), se reintenta sin
  // ellas para no perder el evento: mejor guardarlo sin el alumno que no
  // guardarlo. Se avisa por consola para que se corra supabase-scoring-columns.sql.
  if (error && (error.code === 'PGRST204' || error.code === '42703')) {
    console.warn('[scoring] Faltan columnas en scoring_events (student_ref/quantity). Corré supabase-scoring-columns.sql. Se guarda sin ellas.');
    const { student_ref, quantity, ...base } = row;
    void student_ref; void quantity;
    ({ error } = await db.from('scoring_events').insert(base));
  }

  if (error) {
    console.error('[scoring] No se pudo guardar el evento:', error);
    throw Object.assign(new Error(`No se pudo guardar el evento de scoring: ${error.message}`), { code: error.code });
  }

  await recalculateTeacherScoreWith(db, event.teacherId);
  return { ...event, id, createdAt };
}
