// LMS → Gestión: el alumno elige una de las fechas propuestas.
// POST { alumno_id, indice }   Cabecera x-lms-secret. Contrato: docs/recuperaciones-contrato.md
//
// Crea la recuperación en el calendario del profesor (celda + constancia), libera
// la otra fecha y avisa a los dos. Idempotente: repetir la misma elección
// devuelve 200 con el mismo resultado.

import { requireLmsSecret } from '@/lib/lmsAuth';
import { getRecovery, belongsToStudent, confirmRecovery, expireIfDue } from '@/lib/classRecoveryStore';
import { recoveryErrorResponse, readJson } from '@/lib/recoveryHttp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = requireLmsSecret(request);
  if (denied) return denied;
  const { id } = await ctx.params;
  const body = await readJson<{ alumno_id?: string; indice?: number }>(request);
  const alumnoId = body?.alumno_id?.trim();
  const indice = Number(body?.indice);
  if (!alumnoId || !Number.isInteger(indice) || indice < 0) {
    return Response.json({ error: 'datos_invalidos', mensaje: 'Faltan alumno_id o indice.' }, { status: 422 });
  }
  try {
    const found = await getRecovery(id);
    if (!found || !(await belongsToStudent(found, alumnoId))) {
      return Response.json({ error: 'no_encontrada', mensaje: 'No encontramos esa recuperación.' }, { status: 404 });
    }
    const rec = await expireIfDue(found);
    if (rec.status === 'sin_acuerdo') {
      return Response.json({ error: 'estado_cambiado', mensaje: 'Las fechas propuestas ya pasaron.' }, { status: 409 });
    }
    const done = await confirmRecovery(id, { index: indice, by: 'alumno' });
    return Response.json({ estado: done.status, fecha: done.chosenDate, hora: done.chosenHour, horas: done.hours });
  } catch (err) {
    return recoveryErrorResponse(err, 'lms/recuperaciones/elegir');
  }
}
