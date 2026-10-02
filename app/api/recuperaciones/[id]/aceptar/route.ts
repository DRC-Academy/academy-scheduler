// El profesor acepta uno de los horarios que propuso el alumno ("Ninguna me
// viene bien"). POST { teacherId, index }. Queda confirmada en un solo paso
// (celda + constancia), comprobando que el hueco sigue libre. Solo beta.

import { acceptStudentProposal } from '@/lib/classRecoveryStore';
import { recoveryErrorResponse, readJson } from '@/lib/recoveryHttp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const body = await readJson<{ teacherId?: string; index?: number }>(request);
  if (!body?.teacherId || !Number.isInteger(body.index)) {
    return Response.json({ error: 'datos_invalidos', mensaje: 'Faltan datos.' }, { status: 400 });
  }
  try {
    const rec = await acceptStudentProposal(id, body.teacherId, body.index as number);
    return Response.json({ estado: rec.status, fecha: rec.chosenDate, hora: rec.chosenHour });
  } catch (err) {
    return recoveryErrorResponse(err, 'recuperaciones/aceptar');
  }
}
