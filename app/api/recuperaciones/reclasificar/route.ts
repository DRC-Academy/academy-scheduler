// El admin aprobó una revisión como "cancelada por el profesor" y el profesor es
// beta: se registra en class_recoveries ('sin_acuerdo', multa fija, mes de la
// clase). POST { teacherId, studentName, classDate, classTime, cancelRecordId }.
// Con 503 'no_configurado' (falta el SQL del bloque B) el panel aplica la
// multa de siempre.

import { reclassifyAsTeacherCancellation } from '@/lib/classRecoveryStore';
import { recoveryErrorResponse, readJson } from '@/lib/recoveryHttp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body { teacherId?: string; studentName?: string; classDate?: string; classTime?: string | null; cancelRecordId?: string | null }

export async function POST(request: Request): Promise<Response> {
  const body = await readJson<Body>(request);
  if (!body?.teacherId || !body.studentName || !body.classDate) {
    return Response.json({ error: 'datos_invalidos', mensaje: 'Faltan datos.' }, { status: 400 });
  }
  try {
    return Response.json(await reclassifyAsTeacherCancellation({
      teacherId: body.teacherId, studentName: body.studentName, classDate: body.classDate,
      classTime: body.classTime ?? null, cancelRecordId: body.cancelRecordId ?? null,
    }));
  } catch (err) {
    return recoveryErrorResponse(err, 'recuperaciones/reclasificar');
  }
}
