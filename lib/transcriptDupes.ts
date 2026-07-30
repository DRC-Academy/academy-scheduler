// Detección de transcripts duplicados antes de guardar una clase.
//
// REGLA ÚNICA: un transcript es duplicado si su texto es EXACTAMENTE IGUAL al de
// otro ya guardado del MISMO alumno. Nada de similitud, nada de fragmentos, nada
// de umbrales. Si no es idéntico, es otra clase y no se dice nada.
//
// Por qué se reescribió (julio 2026): la versión anterior no calculaba un hash
// del transcript, sino base64 de sus primeros 200 caracteres. Como los
// transcripts de Fathom empiezan todos con la misma cabecera ("Impromptu
// Meeting…"), colisionaban en masa. En los datos reales daba 5 grupos de
// "duplicados" con 28 filas y CERO duplicados verdaderos: 16 alumnos distintos
// compartían huella, y las cuatro clases de un mismo alumno en cuatro días
// distintos salían todas como la misma.

import { supabase } from '@/lib/supabase';

/**
 * Normalización MÍNIMA y solo cosmética: que un espacio de más no cuente como
 * texto distinto. No se quita puntuación ni palabras, y no se recorta nada — el
 * hash se calcula sobre el transcript COMPLETO.
 */
function normalizeForHash(transcript: string): string {
  return transcript.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Hash hexadecimal de 32 bits (FNV-1a). Solo se usa si falta WebCrypto. */
function fnv1aHex(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv1a_${h.toString(16).padStart(8, '0')}_${text.length}`;
}

/**
 * SHA-256 del transcript COMPLETO (normalizado). Async porque WebCrypto lo es.
 *
 * El respaldo FNV-1a cubre el caso de que `crypto.subtle` no exista (contexto no
 * seguro). Es mucho más débil, pero incluye la longitud del texto y sigue siendo
 * una comparación de igualdad sobre el texto entero: nunca puede dar el falso
 * positivo masivo del prefijo. Antes que lanzar y romper el guardado, degrada.
 */
export async function transcriptHash(transcript: string): Promise<string> {
  const text = normalizeForHash(transcript);
  if (!text) return '';

  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    console.warn('[transcriptDupes] WebCrypto no disponible: se usa el hash de respaldo.');
    return fnv1aHex(text);
  }
  try {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (e) {
    console.error('[transcriptDupes] Falló SHA-256, se usa el respaldo:', e);
    return fnv1aHex(text);
  }
}

export interface DupeRow {
  id: string;
  student_name: string;
  class_date: string | null;
  analyzed_at: string | null;
}

export type DupeCheck =
  /** Nada que avisar: se guarda directamente. */
  | { kind: 'none' }
  /** Texto IDÉNTICO a otro de este mismo alumno → avisar y dejar continuar. */
  | { kind: 'duplicate'; row: DupeRow }
  /** Ya hay transcript de esta clase, pero con otro texto → ofrecer reemplazo. */
  | { kind: 'replace'; row: DupeRow };

const sameName = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Comprueba duplicados. Precedencia: duplicado exacto > reemplazo.
 *
 * ALCANCE: solo los transcripts del MISMO alumno (de este profesor). Comparar
 * entre alumnos distintos no tiene sentido — subir dos veces la misma clase es lo
 * único que hay que evitar — y era la otra mitad de los falsos positivos.
 *
 * NUNCA devuelve un estado que impida guardar: si el profesor dice que es
 * correcto, se sube. Ver DupeCheck.
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
  const { data, error } = await supabase
    .from('class_analyses')
    .select('id, student_name, class_date, analyzed_at, transcript_hash')
    .eq('teacher_id', args.teacherId)
    .order('analyzed_at', { ascending: false });

  // Si la consulta falla (p. ej. falta la columna transcript_hash), se degrada a
  // "sin duplicados": la verificación nunca debe impedir guardar una clase.
  if (error) {
    console.error('[transcriptDupes] No se pudo verificar duplicados:', error);
    return { kind: 'none' };
  }

  const rows = (data ?? []) as unknown as Array<DupeRow & { transcript_hash: string | null }>;
  const delAlumno = rows.filter(r => sameName(r.student_name, args.studentName));

  // 1) Texto exactamente igual a otro de este alumno.
  if (args.hash) {
    const exacto = delAlumno.find(r => r.transcript_hash === args.hash);
    if (exacto) return { kind: 'duplicate', row: exacto };
  }

  // 2) Ya hay transcript de esta misma clase con otro texto → ofrecer reemplazo.
  const mismaClase = delAlumno.find(r => r.class_date === args.classDate);
  if (mismaClase) return { kind: 'replace', row: mismaClase };

  return { kind: 'none' };
}
