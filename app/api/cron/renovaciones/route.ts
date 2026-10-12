// Tarea de RENOVACIÓN DE PROGRAMAS lanzada A MANO (lib/renewalJob).
//
// NO está en vercel.json: la lanza cada día el cron followups-nivel. Esta ruta
// queda para la primera carga tras el deploy y para las pruebas, con el mismo
// secreto que los crons (Authorization: Bearer <CRON_SECRET> o ?secret=).
//
//   ?solo_sync=1   sincroniza y no avisa.
//   ?dry=1         sincroniza y devuelve a quién avisaría, sin enviar ni marcar.
//   (sin nada)     sincroniza y AVISA de verdad, igual que la corrida diaria.

import { requireCronSecret, requireAdminClient } from '@/lib/cronAuth';
import { runRenewalJob } from '@/lib/renewalJob';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(request: Request): Promise<Response> {
  const denied = requireCronSecret(request, 'renovaciones');
  if (denied) return denied;
  const { admin, error: sinAdmin } = requireAdminClient('renovaciones');
  if (!admin) return sinAdmin;

  const q = new URL(request.url).searchParams;
  const result = await runRenewalJob(admin, { soloSync: q.get('solo_sync') === '1', dry: q.get('dry') === '1' });
  const status = 'status' in result ? result.status : 200;
  return Response.json(result, { status, headers: NO_STORE });
}
