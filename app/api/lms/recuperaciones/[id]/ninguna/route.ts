// LMS → Gestión: "Ninguna me viene bien". El alumno propone de 1 a 3 horarios
// (dentro de los 7 días siguientes) y una nota opcional.
// POST { alumno_id, horarios: [{fecha, hora}], nota? }   Cabecera x-lms-secret.
// Contrato: docs/recuperaciones-contrato.md
//
// Ronda 1 → 'alumno_propuso' (le toca al profesor). Ronda 2 → 'sin_acuerdo'.
// Ronda 1 avisa al profesor (campanita + email); ronda 2 avisa al profe y al admin.

import { requireLmsSecret } from '@/lib/lmsAuth';
import { getRecovery, belongsToStudent, studentProposesOther, expireIfDue } from '@/lib/classRecoveryStore';
import { validateStudentProposals } from '@/lib/classRecoveries';
import { recoveryErrorResponse, readJson } from '@/lib/recoveryHttp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body { alumno_id?: string; horarios?: Array<{ fecha?: string; hora?: string }>; nota?: string | null }

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = requireLmsSecret(request);
  if (denied) return denied;
  const { id } = await ctx.params;
  const body = await readJson<Body>(request);
  const alumnoId = body?.alumno_id?.trim();
  if (!alumnoId) return Response.json({ error: 'datos_invalidos', mensaje: 'Falta alumno_id.' }, { status: 422 });

  const horarios = (body?.horarios ?? []).map(h => ({ date: String(h?.fecha ?? ''), hour: String(h?.hora ?? '') }));
  const problems = validateStudentProposals(horarios, body?.nota ?? null, Date.now());
  if (problems.length) return Response.json({ error: 'datos_invalidos', mensaje: problems[0], problemas: problems }, { status: 422 });

  try {
    const found = await getRecovery(id);
    if (!found || !(await belongsToStudent(found, alumnoId))) {
      return Response.json({ error: 'no_encontrada', mensaje: 'No encontramos esa recuperación.' }, { status: 404 });
    }
    const rec = await expireIfDue(found);
    if (rec.status !== 'esperando_alumno') {
      return Response.json({ error: 'estado_cambiado', mensaje: 'Esta recuperación ya no admite proponer horarios.' }, { status: 409 });
    }
    const done = await studentProposesOther(id, horarios, body?.nota ?? null);
    return Response.json({ estado: done.status, ronda: done.round });
  } catch (err) {
    return recoveryErrorResponse(err, 'lms/recuperaciones/ninguna');
  }
}
