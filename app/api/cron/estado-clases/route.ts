// Clases SIN ESTADO (cada hora).
//
// Lo llama pg_cron de Supabase con pg_net (supabase-class-status-cron.sql). NO
// está en vercel.json: el plan de Vercel solo admite crons diarios.
//
// A las 24 h del final de una clase sin estado avisa al profesor (campanita +
// email); a las 48 h, al admin. Qué cuenta como estado: lib/classStatus. La
// base y los avisos: lib/classStatusStore.
//
// Modos:
//   ?ensayo=1   qué avisaría, SIN crear notificaciones ni mandar emails. Con
//               &ahora=2026-10-28T19:00 (hora de España) o un instante ISO con
//               zona, simula esa hora.
//
// SEGURIDAD: Authorization: Bearer <CRON_AUSENCIAS_SECRET> (o ?secret=), el
// mismo secreto que el reloj de ausencias (lib/cronAuth).

import { requireCronSecret, requireAdminClient } from '@/lib/cronAuth';
import { runClassStatusCheck } from '@/lib/classStatusStore';
import { spainWallClockToEpoch } from '@/lib/spainTime';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const LABEL = 'cron estado-clases';
const NO_STORE = { 'Cache-Control': 'no-store' };

/** 'YYYY-MM-DDTHH:MM' sin zona = hora de pared de ESPAÑA; con zona = ese instante. */
function parseAhora(raw: string | null): number | null {
  if (!raw) return null;
  const local = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(raw.trim());
  if (local) return spainWallClockToEpoch(local[1], Number(local[2]), Number(local[3]));
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : NaN;
}

async function handle(request: Request): Promise<Response> {
  const denied = requireCronSecret(request, LABEL, 'CRON_AUSENCIAS_SECRET');
  if (denied) return denied;

  const { admin, error } = requireAdminClient(LABEL);
  if (error) return error;

  const params = new URL(request.url).searchParams;
  const dry = params.get('ensayo') === '1';
  const ahora = dry ? parseAhora(params.get('ahora')) : null;
  if (Number.isNaN(ahora)) {
    return Response.json({ error: 'ahora no válido. Usá 2026-10-28T19:00 (hora de España).' }, { status: 422, headers: NO_STORE });
  }

  try {
    const report = await runClassStatusCheck(admin, { dry, nowMs: ahora ?? undefined });
    console.log(`[${LABEL}]${dry ? ' (ensayo)' : ''} ${report.ahoraEspana}: ${report.sinEstado24h} sin estado (24 h), ` +
      `${report.sinEstado48h} (48 h); avisos nuevos: ${report.avisosProfesor.length} profesor, ${report.avisosAdmin.length} admin; ` +
      `${report.errores.length} error(es).`);
    return Response.json({ ok: report.errores.length === 0, ensayo: dry, ...report }, { headers: NO_STORE });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${LABEL}] Vuelta cortada, no se avisó nada:`, msg);
    return Response.json({ ok: false, error: msg }, { status: 500, headers: NO_STORE });
  }
}

// pg_net llama con GET; POST queda por si se dispara desde otro sitio.
export const GET = handle;
export const POST = handle;
