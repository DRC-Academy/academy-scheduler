// LMS → Gestión: recuperaciones del alumno. Contrato: docs/recuperaciones-contrato.md
// GET ?alumno_id=<students.id>   Cabecera x-lms-secret (LMS_GESTION_SECRET).
//
// Devuelve las activas (esperando_alumno, alumno_propuso, confirmada con fecha
// futura) y las de los últimos 30 días. Las que vencieron sin respuesta pasan
// aquí mismo a 'sin_acuerdo'.

import { requireLmsSecret } from '@/lib/lmsAuth';
import { recoveriesOfStudent } from '@/lib/classRecoveryStore';
import { toLmsRecovery } from '@/lib/lmsRecoveryView';
import { recoveryErrorResponse } from '@/lib/recoveryHttp';
import { spainDateOf } from '@/lib/classRecoveries';
import { addDaysIso } from '@/lib/teacherClasses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const denied = requireLmsSecret(request);
  if (denied) return denied;
  const alumnoId = new URL(request.url).searchParams.get('alumno_id')?.trim();
  if (!alumnoId) return Response.json({ error: 'datos_invalidos', mensaje: 'Falta alumno_id.' }, { status: 422 });

  try {
    const hoy = spainDateOf(Date.now());
    const desde = addDaysIso(hoy, -30);
    const rows = (await recoveriesOfStudent(alumnoId)).filter(r =>
      r.status === 'esperando_alumno' || r.status === 'alumno_propuso'
      || (r.status === 'confirmada' && (r.chosenDate ?? '') >= hoy)
      || (r.statusChangedAt ?? '').slice(0, 10) >= desde || r.originalDate >= desde);
    return Response.json({ recuperaciones: rows.map(toLmsRecovery) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return recoveryErrorResponse(err, 'lms/recuperaciones');
  }
}
