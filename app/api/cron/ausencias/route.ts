// Chequeo de POSIBLES AUSENCIAS del profesor (cada 5 minutos).
//
// Lo llama pg_cron de Supabase con pg_net (supabase-teacher-absences.sql), solo
// de lunes a sábado entre las 07:00 y las 23:30 de España. NO está en
// vercel.json: el plan de Vercel no admite un cron cada 5 minutos y así cada
// vuelta fuera de esa franja ni siquiera llega a Vercel.
//
// Qué hace y qué no: ver lib/teacherAbsenceStore (la base) y lib/teacherAbsences
// (las reglas).
//
// Modos (además del normal):
//   ?ensayo=1               qué enviaría a Zapier y qué marcaría, SIN enviar ni
//                           guardar nada. Con &ahora=2026-10-15T18:35 (hora de
//                           España) o un instante ISO con zona, simula esa hora.
//   ?prueba=1               manda a Zapier UN ejemplo con datos inventados, para
//                           configurar el Zap. No lee ni escribe la base.
//
// SEGURIDAD: Authorization: Bearer <CRON_AUSENCIAS_SECRET> (o ?secret=), en
// tiempo constante (lib/cronAuth). Escribe con el cliente admin.

import { requireCronSecret, requireAdminClient } from '@/lib/cronAuth';
import { runAbsenceCheck, isMissingAbsencesTable } from '@/lib/teacherAbsenceStore';
import { sendAbsenceToZapier, absenceWebhookUrl } from '@/lib/absenceWebhook';
import { sampleAbsencePayload } from '@/lib/teacherAbsences';
import { spainWallClockToEpoch } from '@/lib/spainTime';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const LABEL = 'cron ausencias';
const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * `ahora` del ensayo. 'YYYY-MM-DDTHH:MM' sin zona = hora de pared de ESPAÑA
 * (la de las clases); con zona (Z o ±hh:mm) = ese instante.
 */
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

  const params = new URL(request.url).searchParams;

  if (params.get('prueba') === '1') {
    if (!absenceWebhookUrl()) {
      return Response.json({ ok: false, error: 'Falta ZAPIER_AUSENCIAS_WEBHOOK_URL en Vercel.' }, { status: 400, headers: NO_STORE });
    }
    const payload = sampleAbsencePayload();
    const r = await sendAbsenceToZapier(payload);
    return Response.json({ ok: r.status === 'sent', prueba: true, resultado: r, payload }, { headers: NO_STORE });
  }

  const { admin, error } = requireAdminClient(LABEL);
  if (error) return error;

  const dry = params.get('ensayo') === '1';
  const ahora = dry ? parseAhora(params.get('ahora')) : null;
  if (Number.isNaN(ahora)) {
    return Response.json({ error: 'ahora no válido. Usá 2026-10-15T18:35 (hora de España).' }, { status: 422, headers: NO_STORE });
  }

  try {
    const report = await runAbsenceCheck(admin, { dry, nowMs: ahora ?? undefined });
    console.log(`[${LABEL}]${dry ? ' (ensayo)' : ''} ${report.ahoraEspana}: ${report.clasesEnVentana} clase(s) en ventana, ` +
      `${report.nuevas.length} nueva(s), ${report.llegoTarde.length} llegó tarde, ${report.reintentos.length} reintento(s), ` +
      `${report.errores.length} error(es).`);
    return Response.json({ ok: report.errores.length === 0, ...report }, { headers: NO_STORE });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${LABEL}] Vuelta cortada, no se avisó nada:`, msg);
    return Response.json({ ok: false, error: msg }, { status: isMissingAbsencesTable(err) ? 503 : 500, headers: NO_STORE });
  }
}

// pg_net llama con GET; POST queda por si se dispara desde otro sitio.
export const GET = handle;
export const POST = handle;
