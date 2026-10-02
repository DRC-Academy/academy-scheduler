// "No puedo dar esta clase" — vista previa para el modal del profesor: antelación,
// comodines, si lleva multa y si las fechas que está eligiendo valen. Lo calcula
// el SERVIDOR; el navegador solo lo muestra. Solo profesores beta.

import { previewCancellation, type CancelInput } from '@/lib/classRecoveryStore';
import { recoveryErrorResponse, readJson } from '@/lib/recoveryHttp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const body = await readJson<CancelInput>(request);
  if (!body?.teacherId || !body.assignmentId) return Response.json({ error: 'datos_invalidos', mensaje: 'Faltan datos.' }, { status: 400 });
  try {
    return Response.json(await previewCancellation(body), { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return recoveryErrorResponse(err, 'recuperaciones/preview');
  }
}
