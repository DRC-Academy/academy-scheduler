// Baja o borrado de un alumno desde el panel (el navegador no puede usar el
// store, que es solo de servidor): anula sus recuperaciones vivas ANTES de
// borrar. POST { studentIds?, studentEmail?, studentName?, teacherId?, by, reason }.
// Best-effort para quien llama: si falla, el chequeo nocturno las recoge.

import { annulStudentRecoveries } from '@/lib/classRecoveryStore';
import { recoveryErrorResponse, readJson } from '@/lib/recoveryHttp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface Body {
  studentIds?: string[]; studentEmail?: string | null; studentName?: string | null; teacherId?: string | null;
  by?: string; reason?: string;
}

export async function POST(request: Request): Promise<Response> {
  const body = await readJson<Body>(request);
  if (!body || (!body.studentIds?.length && !body.studentEmail && !(body.teacherId && body.studentName))) {
    return Response.json({ error: 'datos_invalidos', mensaje: 'Faltan datos del alumno.' }, { status: 400 });
  }
  try {
    const anuladas = await annulStudentRecoveries(
      { studentIds: body.studentIds, studentEmail: body.studentEmail, studentName: body.studentName, teacherId: body.teacherId },
      { by: body.by?.trim() || 'admin', reason: body.reason?.trim() || 'Baja del alumno' },
    );
    return Response.json({ anuladas });
  } catch (err) {
    return recoveryErrorResponse(err, 'recuperaciones/baja');
  }
}
