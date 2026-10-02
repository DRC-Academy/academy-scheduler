// "No puedo dar esta clase" — cancelar y proponer fechas (o confirmar la acordada).
// Ver lib/classRecoveryStore.cancelClass. Solo profesores beta: lo comprueba el
// servidor, no solo la pantalla.

import { cancelClass, type CancelInput } from '@/lib/classRecoveryStore';
import { recoveryErrorResponse, readJson } from '@/lib/recoveryHttp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  const body = await readJson<CancelInput>(request);
  if (!body?.teacherId || !body.assignmentId) return Response.json({ error: 'datos_invalidos', mensaje: 'Faltan datos.' }, { status: 400 });
  try {
    return Response.json(await cancelClass(body));
  } catch (err) {
    return recoveryErrorResponse(err, 'recuperaciones/cancelar');
  }
}
