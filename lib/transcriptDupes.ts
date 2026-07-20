// Detección de transcripts duplicados antes de guardar una clase.
//
// Dos comprobaciones:
//   1. ¿Ya hay un transcript para ESTE alumno en ESTA fecha? → ofrecer reemplazar.
//   2. ¿El texto es idéntico a otro ya subido? → avisar (o bloquear si además es
//      la misma clase).

import { supabase } from '@/lib/supabase';

/**
 * Huella del transcript: base64 de los primeros 200 caracteres, saneado a 32.
 *
 * OJO — btoa() solo acepta Latin-1. Un transcript de Fathom con comillas
 * tipográficas (“ ”), guion largo (—) o puntos suspensivos (…) haría que
 * btoa lanzara InvalidCharacterError y el guardado fallara. Por eso el texto
 * se codifica a UTF-8 ANTES de pasarlo a base64.
 *
 * Es una huella DÉBIL a propósito: dos clases que empiecen igual ("Hola, ¿cómo
 * estás?…") colisionan. Sirve para AVISAR, nunca para descartar en silencio.
 */
export function transcriptHash(transcript: string): string {
  const head = transcript.trim().slice(0, 200);
  if (!head) return '';
  const bytes = new TextEncoder().encode(head);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
}

export interface DupeRow {
  id: string;
  student_name: string;
  class_date: string | null;
  analyzed_at: string | null;
}

export type DupeCheck =
  /** Nada que avisar: se puede guardar directamente. */
  | { kind: 'none' }
  /** Texto idéntico ya registrado para esta misma clase → no se puede guardar. */
  | { kind: 'blocked'; row: DupeRow }
  /** Texto idéntico pero de OTRO alumno u otra fecha → avisar y dejar confirmar. */
  | { kind: 'other-class'; row: DupeRow }
  /** Ya hay transcript para esta clase, pero con otro texto → ofrecer reemplazo. */
  | { kind: 'replace'; row: DupeRow };

const sameName = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Consulta las dos verificaciones. Precedencia: bloqueo > aviso > reemplazo.
 *
 * Nota: se usa select() y se mira el array, NO .single() — .single() lanza error
 * cuando hay 0 filas (o más de una), que es justo el caso normal.
 */
export async function checkTranscriptDuplicates(args: {
  teacherId: string;
  studentName: string;
  classDate: string;
  hash: string;
}): Promise<DupeCheck> {
  const cols = 'id, student_name, class_date, analyzed_at, transcript_hash';

  const [sameClassRes, sameHashRes] = await Promise.all([
    supabase.from('class_analyses').select(cols)
      .eq('teacher_id', args.teacherId)
      .eq('class_date', args.classDate)
      .order('analyzed_at', { ascending: false }),
    args.hash
      ? supabase.from('class_analyses').select(cols)
        .eq('teacher_id', args.teacherId)
        .eq('transcript_hash', args.hash)
        .order('analyzed_at', { ascending: false })
      : Promise.resolve({ data: [], error: null }),
  ]);

  // Si la columna transcript_hash aún no existe, la consulta falla: se degrada a
  // "sin duplicados" en vez de bloquear el guardado.
  if (sameClassRes.error) {
    console.error('[transcriptDupes] No se pudo verificar duplicados:', sameClassRes.error);
    return { kind: 'none' };
  }

  const sameClassRows = ((sameClassRes.data ?? []) as unknown as DupeRow[])
    .filter(r => sameName(r.student_name, args.studentName));
  const sameHashRows = ('error' in sameHashRes && sameHashRes.error)
    ? []
    : ((sameHashRes.data ?? []) as unknown as DupeRow[]);

  // 1) Mismo texto y misma clase → bloqueo.
  const blocked = sameHashRows.find(r =>
    sameName(r.student_name, args.studentName) && r.class_date === args.classDate);
  if (blocked) return { kind: 'blocked', row: blocked };

  // 2) Mismo texto pero otro alumno u otra fecha → aviso.
  const other = sameHashRows.find(r =>
    !sameName(r.student_name, args.studentName) || r.class_date !== args.classDate);
  if (other) return { kind: 'other-class', row: other };

  // 3) Ya hay transcript de esta clase con otro texto → ofrecer reemplazo.
  if (sameClassRows.length > 0) return { kind: 'replace', row: sameClassRows[0] };

  return { kind: 'none' };
}
