// Todas las recuperaciones, para la pestaña "Recuperaciones" del admin y para
// los contadores de faltas (admin y dashboard). GET.

import { listRecoveriesForAdmin } from '@/lib/classRecoveryStore';
import { recoveryErrorResponse } from '@/lib/recoveryHttp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    return Response.json({ recoveries: await listRecoveriesForAdmin() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return recoveryErrorResponse(err, 'recuperaciones/admin');
  }
}
