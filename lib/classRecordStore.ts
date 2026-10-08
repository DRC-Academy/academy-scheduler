// Constancias de clase (class_records) con el cliente de Supabase INYECTADO.
//
// Es el código de las reprogramaciones que vivía en lib/db.ts, movido aquí para
// que lo use también el servidor (cambio de horario pedido desde el LMS). lib/db.ts
// delega en estas funciones con la anon key, así que el "Reprogramar" del
// profesor hace exactamente lo mismo que antes. NO importa lib/supabase.ts.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ClassRecord } from '@/types';

type Db = SupabaseClient;

/**
 * Inserta constancias de clase. Si la columna lost_hours no existe (SQL sin
 * correr), reintenta sin ella: mejor la constancia sin el crédito sellado que
 * ninguna. LANZA si no se pudo guardar.
 */
export async function insertClassRecordsWith(db: Db, rows: Array<Record<string, unknown>>): Promise<void> {
  const { error } = await db.from('class_records').insert(rows);
  if (!error) return;
  if (!String(error.message ?? '').includes('lost_hours')) {
    throw new Error(`No se pudo guardar la constancia de clase: ${error.message}`);
  }
  console.warn('[class_records] La columna class_records.lost_hours no existe: se guarda sin sellar el crédito. Correr supabase-reschedule-split.sql.');
  const sinLostHours = rows.map(row => {
    const copia = { ...row };
    delete copia.lost_hours;
    return copia;
  });
  const retry = await db.from('class_records').insert(sinLostHours);
  if (retry.error) throw new Error(`No se pudo guardar la constancia de clase: ${retry.error.message}`);
}

/** Borra constancias por id. LANZA si falla. */
export async function deleteClassRecordsWith(db: Db, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await db.from('class_records').delete().in('id', ids);
  if (error) throw new Error(`No se pudieron borrar las constancias ${ids.join(', ')}: ${error.message}`);
}

export interface RescheduleRecordInput {
  teacherId: string; teacherName: string; studentName: string;
  originalDate: string; originalTime?: string;
  newDate: string; newTime?: string;
  classType: 'reprogramada' | 'cancelacion_hora';
  comment: string;
  /** Horas que valía la clase al perderse: el crédito que abre. Ver lib/rescheduleSplit. */
  lostHours?: number;
}

/** Constancia de una clase reprogramada (o cancelada sobre la hora). LANZA si no se guarda. */
export async function addRescheduleRecordWith(db: Db, p: RescheduleRecordInput): Promise<ClassRecord> {
  const id        = `cr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const createdAt = new Date().toISOString();
  await insertClassRecordsWith(db, [{
    id, teacher_id: p.teacherId, teacher_name: p.teacherName, student_name: p.studentName,
    class_date: p.originalDate, class_time: p.originalTime ?? null,
    screenshot_url: '', class_type: p.classType, comment: p.comment, created_at: createdAt,
    original_date: p.originalDate, rescheduled_to: p.newDate,
    lost_hours: p.lostHours ?? null,
  }]);
  return {
    id, teacherId: p.teacherId, teacherName: p.teacherName, studentName: p.studentName,
    classDate: p.originalDate, classTime: p.originalTime, screenshotUrl: '', classType: p.classType,
    comment: p.comment, originalDate: p.originalDate, rescheduledTo: p.newDate, createdAt,
  };
}
