// El admin aprobó una revisión como "cancelada por el profesor": en el sistema
// único de penalizaciones es una FALTA (−10 €, mes de la clase). Esta ruta hace
// todo en el servidor: constancia, recuperación del alumno y multa
// (reclassifyAsTeacherFalta). POST { teacherId, studentName, classDate, classTime, by, comment }.
//
// Si falla, la revisión NO se cierra (lib/reviewRequests lanza) y se puede
// reintentar: todo es idempotente. Ya no hay vuelta al −5 € de siempre.

import { reclassifyAsTeacherFalta } from '@/lib/classRecoveryStore';
import { recoveryErrorResponse, readJson } from '@/lib/recoveryHttp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  teacherId?: string; studentName?: string; classDate?: string; classTime?: string | null;
  by?: string; comment?: string | null;
}

export async function POST(request: Request): Promise<Response> {
  const body = await readJson<Body>(request);
  if (!body?.teacherId || !body.studentName || !body.classDate) {
    return Response.json({ error: 'datos_invalidos', mensaje: 'Faltan datos.' }, { status: 400 });
  }
  try {
    return Response.json(await reclassifyAsTeacherFalta({
      teacherId: body.teacherId, studentName: body.studentName, classDate: body.classDate,
      classTime: body.classTime ?? null, by: body.by?.trim() || 'admin', comment: body.comment ?? null,
    }));
  } catch (err) {
    return recoveryErrorResponse(err, 'recuperaciones/reclasificar');
  }
}
