// Entrega el aviso de "hay un nivel para validar" que quedó en espera.
//
// Lo llama el navegador al asignarle profesor a un alumno (ver `addAssignment`
// en lib/TeachersContext). Existe como endpoint por la razón de siempre: manda
// un email, y RESEND_API_KEY es server-only. Mismo patrón que /api/emails.
//
// Siempre responde 200. Que un aviso no salga no puede romper una asignación de
// alumno, que es lo que de verdad importaba de esa acción.
//
// La mayoría de las llamadas no hacen nada: solo entrega si el alumno tiene la
// marca `level_validation_pending` puesta, o sea si hizo el test ANTES de tener
// profesor. Ver lib/levelValidationPending.

import { deliverPendingLevelNotice } from '@/lib/levelValidationPending';

export const runtime = 'nodejs';

interface Body {
  studentId?: string | null;
  studentName?: string;
  teacherId?: string;
}

export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ delivered: false, error: 'JSON inválido' }, { status: 400 });
  }

  const studentName = body.studentName?.trim();
  const teacherId = body.teacherId?.trim();
  if (!studentName || !teacherId) {
    return Response.json({ delivered: false, reason: 'faltan_datos' });
  }

  const res = await deliverPendingLevelNotice({
    studentId: body.studentId, studentName, teacherId,
  });
  return Response.json(res);
}
