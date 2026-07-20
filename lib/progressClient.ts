// Helpers del link público de progreso del alumno (/progreso/[token]).
// Espeja lib/formClient: el endpoint crea o reutiliza el token y devuelve la URL.

export interface ProgressTokenRow {
  id: string;
  token: string;
  student_id: string | null;
  teacher_id: string | null;
  student_name: string;
  expires_at: string | null;
}

export function isProgressTokenExpired(row: Pick<ProgressTokenRow, 'expires_at'>): boolean {
  return !!row.expires_at && new Date(row.expires_at).getTime() < Date.now();
}

/** Crea el link (o devuelve el vigente) para compartir con el alumno. */
export async function getProgressLink(payload: {
  studentId?: string | null;
  studentName: string;
  teacherId: string;
}): Promise<string> {
  const res = await fetch('/api/progress/generate-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      studentId: payload.studentId ?? undefined,
      studentName: payload.studentName,
      teacherId: payload.teacherId,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'No se pudo generar el link de progreso.');
  return data.progressUrl as string;
}
