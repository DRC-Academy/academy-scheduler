// Helpers de cliente para el formulario inicial del alumno: consultar el estado
// del token de cada alumno, generar un token nuevo y armar el link/email.

import { supabase } from '@/lib/supabase';

export interface FormTokenInfo {
  id: string;
  token: string;
  status: string;               // 'pending' | 'completed' | 'expired'
  expires_at: string | null;
  completed_at: string | null;
  student_id: string | null;
  student_name: string;
}

export type FormState = 'none' | 'pending' | 'completed' | 'expired';

export function formStateOf(info: FormTokenInfo | undefined | null): FormState {
  if (!info) return 'none';
  if (info.status === 'completed') return 'completed';
  const expired = info.expires_at && new Date(info.expires_at).getTime() < Date.now();
  if (info.status === 'expired' || expired) return 'expired';
  return 'pending';
}

const norm = (s: string) => s.trim().toLowerCase();

// Trae TODOS los tokens (la tabla es chica) y los indexa por student_id y por
// nombre normalizado, quedándose con el más reciente de cada alumno.
export async function fetchFormTokensIndex(): Promise<{
  byId: Map<string, FormTokenInfo>;
  byName: Map<string, FormTokenInfo>;
}> {
  const byId = new Map<string, FormTokenInfo>();
  const byName = new Map<string, FormTokenInfo>();
  const { data, error } = await supabase
    .from('form_tokens')
    .select('id, token, status, expires_at, completed_at, student_id, student_name')
    .order('created_at', { ascending: false });   // el primero de cada alumno es el más reciente
  if (error || !data) return { byId, byName };

  for (const row of data as FormTokenInfo[]) {
    if (row.student_id && !byId.has(row.student_id)) byId.set(row.student_id, row);
    const key = norm(row.student_name);
    if (key && !byName.has(key)) byName.set(key, row);
  }
  return { byId, byName };
}

// Busca el token más relevante para un alumno (por id, luego por nombre).
export function lookupToken(
  index: { byId: Map<string, FormTokenInfo>; byName: Map<string, FormTokenInfo> },
  student: { id?: string | null; name: string },
): FormTokenInfo | undefined {
  if (student.id && index.byId.has(student.id)) return index.byId.get(student.id);
  return index.byName.get(norm(student.name));
}

export function buildFormUrl(token: string): string {
  const base = (typeof window !== 'undefined' && window.location.origin)
    || 'https://academy-scheduler-aqpt.vercel.app';
  return `${base}/formulario/${token}`;
}

export interface GenerateTokenPayload {
  studentId?: string;
  studentName: string;
  studentEmail?: string;
  teacherId: string;
  teacherName: string;
  assignmentId?: string;
  plan?: string;
  level?: string;
}

// Genera un token nuevo vía el endpoint. Devuelve { token, formUrl }.
export async function generateFormToken(payload: GenerateTokenPayload): Promise<{ token: string; formUrl: string }> {
  const res = await fetch('/api/forms/generate-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'No se pudo generar el link.');
  return { token: data.token, formUrl: data.formUrl };
}

// Devuelve el link del formulario para un alumno: reutiliza un token vigente
// (pendiente o ya completado → mismo link) y solo genera uno nuevo si no hay
// ninguno o el anterior expiró. Pensado para incrustar el link en el correo de
// presentación del profesor.
export async function getOrCreateFormLink(payload: GenerateTokenPayload): Promise<string> {
  const index = await fetchFormTokensIndex();
  const existing = lookupToken(index, { id: payload.studentId, name: payload.studentName });
  if (existing && formStateOf(existing) !== 'expired') {
    return buildFormUrl(existing.token);
  }
  const { formUrl } = await generateFormToken(payload);
  return formUrl;
}

// Email pre-armado para enviarle el formulario al alumno.
export function buildFormEmail(studentName: string, teacherName: string, url: string): { subject: string; body: string } {
  const subject = 'Antes de tu primera clase — DRC Academy 🎓';
  const body =
`¡Hola ${studentName}! 👋

Antes de nuestra primera clase, me gustaría conocerte un poco mejor para preparar algo que realmente sea tuyo.

Te dejo este formulario de 10 minutos:

${url}

Ya sé tu nivel y tu horario — estas preguntas son para entender cómo aprendés y qué necesitás, así la primera clase arranca desde el minuto uno.

¡Nos vemos pronto! 😊
${teacherName}`;
  return { subject, body };
}
