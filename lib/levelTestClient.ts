// Helpers de cliente para el Test de Nivel (espejo de lib/formClient.ts):
// consultar el estado del test de cada alumno, generar un link nuevo y reutilizar
// uno vigente. La generación va por /api/level-test/generate; el índice se lee con
// la clave anónima (RLS deshabilitado, igual que form_tokens).

import { supabase } from '@/lib/supabase';
import { publicBaseClient } from '@/lib/appUrl';
import { isStudentSession } from '@/lib/levelTest/canonical';

// 'abandoned' = se empezó y el enlace caducó a medias. Sin nivel y sin vuelta
// atrás; distinto de 'expired', que es el enlace que caducó sin abrirse nunca.
export type LTStatus = 'pending' | 'in_progress' | 'completed' | 'expired' | 'abandoned';
export type LTState = 'none' | 'pending' | 'in_progress' | 'completed' | 'expired' | 'abandoned';

export interface LevelTestInfo {
  id: string;
  token: string;
  status: LTStatus;
  expires_at: string | null;
  completed_at: string | null;
  student_id: string | null;
  // Con profe = prueba de un alumno, aunque no tenga student_id (no caduca).
  teacher_id?: string | null;
  // Historial de un "Regenerar todo" (lib/levelTest/canonical): no cuenta.
  superseded_at?: string | null;
  student_name: string | null;
  candidate_name: string;
  candidate_email: string;
  cefr_level: string | null;
  overall_score: number | null;
  created_at: string;
  // Llega con supabase-level-test-v2.sql; puede venir undefined si no se corrió.
  answered_count?: number | null;
}

export function testStateOf(info: LevelTestInfo | undefined | null): LTState {
  if (!info) return 'none';
  if (info.status === 'completed') return 'completed';
  // La prueba de un ALUMNO no caduca por fecha desde el 28/09/2026 (la regla está
  // en lib/levelTest/canonical): sus marcas 'expired'/'abandoned' de la regla
  // vieja se reabren al abrir el enlace, así que aquí nunca se ven caducadas.
  if (isStudentSession(info)) {
    return info.status === 'in_progress' || (info.answered_count ?? 0) > 0 ? 'in_progress' : 'pending';
  }
  if (info.status === 'abandoned') return 'abandoned';
  const expired = info.expires_at && new Date(info.expires_at).getTime() < Date.now();
  if (info.status === 'expired' || expired) {
    // La marca 'abandoned' en la base es PEREZOSA: se escribe la próxima vez que
    // alguien abre el enlace, y un enlace abandonado normalmente no se vuelve a
    // abrir. Por eso el listado lo deduce en vez de fiarse del estado guardado.
    const respondidas = info.answered_count ?? 0;
    return respondidas > 0 && !info.cefr_level ? 'abandoned' : 'expired';
  }
  if (info.status === 'in_progress') return 'in_progress';
  return 'pending';
}

const norm = (s: string) => (s ?? '').trim().toLowerCase();

// Todas las sesiones (la tabla es chica), indexadas por student_id y por nombre,
// quedándose con la PRINCIPAL de cada alumno (misma regla que
// lib/levelTest/canonical): la terminada; si no, la de más respuestas; si no, la
// más reciente. Para listados y badges.
export async function fetchLevelTestIndex(): Promise<{
  all: LevelTestInfo[];
  byId: Map<string, LevelTestInfo>;
  byName: Map<string, LevelTestInfo>;
}> {
  const byId = new Map<string, LevelTestInfo>();
  const byName = new Map<string, LevelTestInfo>();

  const COLS = 'id, token, status, expires_at, completed_at, student_id, teacher_id, student_name, candidate_name, candidate_email, cefr_level, overall_score, created_at, superseded_at';
  const read = (cols: string) => supabase
    .from('level_test_sessions').select(cols).order('created_at', { ascending: false });

  // answered_count llega con supabase-level-test-v2.sql. Si todavía no existe,
  // pedirla haría fallar la consulta entera (42703) y el listado saldría vacío.
  let { data, error } = await read(`${COLS}, answered_count`);
  if (error?.code === '42703') ({ data, error } = await read(COLS));
  if (error || !data) return { all: [], byId, byName };

  // Doble cast: al pasar las columnas como variable, PostgREST pierde el tipo.
  const all = data as unknown as LevelTestInfo[];
  // Rango: terminada > más respuestas. Como `all` viene de la más reciente a la
  // más vieja, solo se reemplaza si la nueva es ESTRICTAMENTE mejor.
  const rango = (r: LevelTestInfo) => (r.status === 'completed' ? 1e6 : 0) + (r.answered_count ?? 0);
  const quedarse = (m: Map<string, LevelTestInfo>, k: string, row: LevelTestInfo) => {
    const prev = m.get(k);
    if (!prev || rango(row) > rango(prev)) m.set(k, row);
  };
  for (const row of all) {
    if (row.superseded_at) continue;   // historial de un "Regenerar todo"
    if (row.student_id) quedarse(byId, row.student_id, row);
    const key = norm(row.student_name || row.candidate_name);
    if (key) quedarse(byName, key, row);
  }
  return { all, byId, byName };
}

export function lookupTest(
  index: { byId: Map<string, LevelTestInfo>; byName: Map<string, LevelTestInfo> },
  student: { id?: string | null; name: string },
): LevelTestInfo | undefined {
  if (student.id && index.byId.has(student.id)) return index.byId.get(student.id);
  return index.byName.get(norm(student.name));
}

export function buildTestUrl(token: string): string {
  return `${publicBaseClient()}/test/${token}`;
}

export interface GenerateTestPayload {
  candidateName?: string;
  candidateEmail?: string;
  candidatePhone?: string;
  studentId?: string;
  studentName: string;
  studentEmail?: string;
  teacherId?: string;
  teacherName?: string;
  assignmentId?: string;
  plan?: string;
  level?: string;
  expiresInDays?: number;
}

export async function generateTestLink(payload: GenerateTestPayload): Promise<{ token: string; url: string }> {
  const res = await fetch('/api/level-test/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'No se pudo generar el link del test.');
  return { token: data.token, url: data.url };
}

// Link del test para un alumno: reutiliza una sesión vigente (pending/in_progress/
// completed, no expirada → mismo link) y solo genera una nueva si no hay o expiró.
// Pensado para incrustar el link en el correo de presentación del profesor.
export async function getOrCreateTestLink(payload: GenerateTestPayload): Promise<string> {
  const index = await fetchLevelTestIndex();
  const existing = lookupTest(index, { id: payload.studentId, name: payload.studentName });
  // Un test abandonado ya no se puede retomar: hace falta enlace nuevo, igual que
  // con uno expirado.
  const agotado = existing && ['expired', 'abandoned'].includes(testStateOf(existing));
  if (existing && !agotado) {
    return buildTestUrl(existing.token);
  }
  const { url } = await generateTestLink(payload);
  return url;
}
