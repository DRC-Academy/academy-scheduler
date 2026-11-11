// Chequeo de POSIBLES AUSENCIAS del profesor (cada 5 minutos).
//
// Lo llama pg_cron de Supabase con pg_net (supabase-teacher-absences.sql), solo
// de lunes a sábado entre las 07:00 y las 23:30 de España. NO está en
// vercel.json: el plan de Vercel no admite un cron cada 5 minutos y así cada
// vuelta fuera de esa franja ni siquiera llega a Vercel.
//
// Qué hace y qué no: ver lib/teacherAbsenceStore (la base), lib/teacherAbsences
// (las reglas) y lib/notificaciones/ausencia (Slack + WhatsApp + email; hasta
// nov/2026 esto lo hacía un zap de Zapier).
//
// Modos (además del normal):
//   ?dryRun=1 (o ?ensayo=1) qué avisaría (texto de Slack, plantilla de WhatsApp,
//                           email) y qué marcaría, SIN enviar ni guardar nada.
//                           Con &ahora=2026-10-15T18:35 (hora de España) o un
//                           instante ISO con zona, simula esa hora.
//   ?prueba=1               UN aviso de ejemplo con datos inventados. No lee ni
//                           escribe la base. Slack se envía siempre (marcado
//                           [PRUEBA]); WhatsApp y email SOLO si se pasa a quién:
//                           &telefono=+34600111222 &email=tu@correo.com. Con
//                           &dryRun=1, solo muestra lo que mandaría.
//
// SEGURIDAD: Authorization: Bearer <CRON_AUSENCIAS_SECRET> (o ?secret=), en
// tiempo constante (lib/cronAuth). Escribe con el cliente admin.

import { requireCronSecret, requireAdminClient } from '@/lib/cronAuth';
import { runAbsenceCheck, isMissingAbsencesTable } from '@/lib/teacherAbsenceStore';
import { sweepPaymentHolds } from '@/lib/paymentHoldStore';
import { notificarAusencia } from '@/lib/notificaciones/ausencia';
import { sampleAbsencePayload, claseAusenciaDe, normalizePhone } from '@/lib/teacherAbsences';
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

  const dry = params.get('dryRun') === '1' || params.get('ensayo') === '1';

  if (params.get('prueba') === '1') {
    // Los destinatarios del ejemplo son inventados: sin &telefono / &email no se
    // manda WhatsApp ni email a nadie.
    const clase = {
      ...claseAusenciaDe(sampleAbsencePayload()),
      alumnoTelefono: normalizePhone(params.get('telefono')),
      profeEmail: (params.get('email') ?? '').trim(),
    };
    const aviso = await notificarAusencia(clase, { dryRun: dry });
    const ok = Object.values(aviso).every(r => r?.estado !== 'error' && r?.estado !== 'sin_config');
    return Response.json({ ok, prueba: true, dryRun: dry, clase, aviso }, { headers: NO_STORE });
  }

  const { admin, error } = requireAdminClient(LABEL);
  if (error) return error;

  const ahora = dry ? parseAhora(params.get('ahora')) : null;
  if (Number.isNaN(ahora)) {
    return Response.json({ error: 'ahora no válido. Usá 2026-10-15T18:35 (hora de España).' }, { status: 422, headers: NO_STORE });
  }

  // PAGO PENDIENTE (lib/paymentHoldStore): ANTES del chequeo, para que una clase
  // de un alumno que acaba de pasar a on-hold no salga como ausencia. Va colgado
  // de este reloj para no sumar un cron. Nunca lanza; en ensayo no se ejecuta.
  const pagoPendiente = dry ? null : await sweepPaymentHolds(admin, Date.now(), { budgetMs: 20_000 });

  try {
    const report = await runAbsenceCheck(admin, { dry, nowMs: ahora ?? undefined });
    console.log(`[${LABEL}]${dry ? ' (ensayo)' : ''} ${report.ahoraEspana}: ${report.clasesEnVentana} clase(s) en ventana, ` +
      `${report.nuevas.length} nueva(s), ${report.llegoTarde.length} llegó tarde, ${report.reintentos.length} reintento(s), ` +
      `${report.errores.length} error(es).`);
    return Response.json({ ok: report.errores.length === 0, ...report, pagoPendiente }, { headers: NO_STORE });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${LABEL}] Vuelta cortada, no se avisó nada:`, msg);
    return Response.json({ ok: false, error: msg }, { status: isMissingAbsencesTable(err) ? 503 : 500, headers: NO_STORE });
  }
}

// pg_net llama con GET; POST queda por si se dispara desde otro sitio.
export const GET = handle;
export const POST = handle;
