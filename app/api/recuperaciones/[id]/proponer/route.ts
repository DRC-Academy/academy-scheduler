// Ronda 2: el profesor propone otras 2 fechas a un alumno que dijo "Ninguna me
// viene bien". Solo beta.
//   GET  ?teacherId=…               → días y horas libres para el selector.
//   POST { teacherId, proposals }   → vuelve a 'esperando_alumno' + email al alumno.

import { freeSlotsForRecovery, teacherProposeAgain } from '@/lib/classRecoveryStore';
import { isRecoveryBetaTeacher } from '@/lib/classRecoveries';
import { recoveryErrorResponse, readJson } from '@/lib/recoveryHttp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const teacherId = new URL(request.url).searchParams.get('teacherId') ?? '';
  if (!isRecoveryBetaTeacher(teacherId)) return Response.json({ error: 'no_beta', mensaje: 'No disponible.' }, { status: 403 });
  try {
    const { recovery, freeSlots } = await freeSlotsForRecovery(id, teacherId);
    return Response.json(
      { hours: recovery.hours, status: recovery.status, round: recovery.round, freeSlots },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    return recoveryErrorResponse(err, 'recuperaciones/proponer');
  }
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const body = await readJson<{ teacherId?: string; proposals?: Array<{ date?: string; hour?: string }> }>(request);
  if (!body?.teacherId || !Array.isArray(body.proposals)) {
    return Response.json({ error: 'datos_invalidos', mensaje: 'Faltan datos.' }, { status: 400 });
  }
  try {
    const proposals = body.proposals.map(p => ({ date: String(p?.date ?? ''), hour: String(p?.hour ?? '') }));
    const rec = await teacherProposeAgain(id, body.teacherId, proposals);
    return Response.json({ estado: rec.status, ronda: rec.round });
  } catch (err) {
    return recoveryErrorResponse(err, 'recuperaciones/proponer');
  }
}
