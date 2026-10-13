// Constancias de clase (class_records) con el cliente de Supabase INYECTADO.
//
// Es el código de las reprogramaciones que vivía en lib/db.ts, movido aquí para
// que lo use también el servidor (cambio de horario pedido desde el LMS). lib/db.ts
// delega en estas funciones con la anon key, así que el "Reprogramar" del
// profesor hace exactamente lo mismo que antes. NO importa lib/supabase.ts.

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import type { AvisoConstancia, ClassRecord } from '@/types';

type Db = SupabaseClient;

/**
 * Columnas de class_records que pueden no existir todavía en la base, cada una
 * con el SQL que la crea. Son MEJORAS de la constancia, no su vínculo: sin ellas
 * la fila sigue diciendo qué pasó con la clase, así que se guarda sin ellas antes
 * que perderla. Lo que NO está acá (rescheduled_to, recovery_for_date…) no se
 * descarta nunca: ahí está el vínculo.
 */
const COLUMNAS_OPCIONALES: Record<string, string> = {
  lost_hours:    'supabase-reschedule-split.sql',
  avisado_en:    'supabase-avisado-en.sql',
  cancelado_por: 'supabase-avisado-en.sql',
};

/**
 * Inserta constancias reintentando sin las columnas opcionales que la base no
 * tenga. PostgREST nombra UNA columna desconocida por error, así que se repite
 * hasta que no quede ninguna que quitar. Devuelve el error final (o null) sin
 * lanzar: quien llama decide, por ejemplo mirando el 23505.
 */
export async function insertClassRecordsTolerante(
  db: Db, rows: Array<Record<string, unknown>>,
): Promise<{ error: PostgrestError | null }> {
  let filas = rows;
  for (let intento = 0; intento <= Object.keys(COLUMNAS_OPCIONALES).length; intento++) {
    const { error } = await db.from('class_records').insert(filas);
    if (!error) return { error: null };
    const mensaje = String(error.message ?? '');
    const faltan = Object.keys(COLUMNAS_OPCIONALES).filter(c => mensaje.includes(c) && filas.some(f => c in f));
    if (faltan.length === 0) return { error };
    for (const c of faltan) {
      console.warn(`[class_records] La columna class_records.${c} no existe: se guarda sin ella. Correr ${COLUMNAS_OPCIONALES[c]}.`);
    }
    filas = filas.map(fila => {
      const copia = { ...fila };
      for (const c of faltan) delete copia[c];
      return copia;
    });
  }
  return { error: null };
}

/**
 * Inserta constancias de clase. Si falta alguna columna opcional (lost_hours,
 * avisado_en, cancelado_por: SQL sin correr), reintenta sin ella: mejor la
 * constancia sin ese dato que ninguna. LANZA si no se pudo guardar.
 */
export async function insertClassRecordsWith(db: Db, rows: Array<Record<string, unknown>>): Promise<void> {
  const { error } = await insertClassRecordsTolerante(db, rows);
  if (error) throw new Error(`No se pudo guardar la constancia de clase: ${error.message}`);
}

/**
 * Las columnas del aviso, SOLO las que tienen valor. Mandar `null` de más haría
 * que, mientras la base no tenga la columna, cada inserción fallara una vez antes
 * del reintento.
 */
export function avisoColumnas(a: AvisoConstancia | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (a?.avisadoEn) out.avisado_en = a.avisadoEn;
  if (a?.canceladoPor) out.cancelado_por = a.canceladoPor;
  return out;
}

/** Borra constancias por id. LANZA si falla. */
export async function deleteClassRecordsWith(db: Db, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await db.from('class_records').delete().in('id', ids);
  if (error) throw new Error(`No se pudieron borrar las constancias ${ids.join(', ')}: ${error.message}`);
}

/** `avisadoEn`/`canceladoPor`: cuándo avisó quien la canceló. Ver lib/avisoAlumno. */
export interface RescheduleRecordInput extends AvisoConstancia {
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
    ...avisoColumnas(p),
  }]);
  return {
    id, teacherId: p.teacherId, teacherName: p.teacherName, studentName: p.studentName,
    classDate: p.originalDate, classTime: p.originalTime, screenshotUrl: '', classType: p.classType,
    comment: p.comment, originalDate: p.originalDate, rescheduledTo: p.newDate,
    avisadoEn: p.avisadoEn, canceladoPor: p.canceladoPor, createdAt,
  };
}
