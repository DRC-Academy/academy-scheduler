// Cron de rescate de la bienvenida: altas nuevas de las últimas 72 h que se
// quedaron sin email porque el navegador que dio el alta no lo disparó (versión
// vieja de la app, pestaña cerrada a tiempo...). El criterio de "alta nueva" y su
// porqué viven en lib/welcomeRescue.
//
// APAGADO hasta que se active a mano: con RESCUE_ENABLED = false responde
// siempre como ensayo, aunque no se pida ?dry=1.
//
// Lo llama GitHub Actions (el plan Hobby de Vercel solo permite crons diarios),
// igual que check-presentation-emails.
//
// CÓMO PROBARLO (Authorization: Bearer <CRON_SECRET>, o ?secret=):
//   · ?dry=1  → lista a quién se le enviaría y por qué se descarta al resto.
//
// El envío es sendWelcomeForAssignment, el mismo de la ruta: ventana, reclamo
// atómico (si el navegador la manda a la vez, solo sale una), vista del LMS,
// aviso en la campanita si falta el email o el vínculo.

import { requireCronSecret, requireAdminClient } from '@/lib/cronAuth';
import { scanWelcomeRescue } from '@/lib/welcomeRescue';
import { sendWelcomeForAssignment } from '@/lib/welcomeEmailSend';
import { WELCOME_EMAIL_ENABLED } from '@/lib/welcomeEmail';
import { publicBase } from '@/lib/appUrl';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Interruptor del rescate. Mientras sea false, solo ensaya. */
const RESCUE_ENABLED = false;
/** Tope de envíos por corrida (Resend admite 2/s; esto entra de sobra en 60 s). */
const MAX_POR_CORRIDA = 20;

const NO_STORE = { 'Cache-Control': 'no-store' };

async function handle(request: Request): Promise<Response> {
  const denied = requireCronSecret(request, 'rescate-bienvenidas');
  if (denied) return denied;
  const { admin, error } = requireAdminClient('rescate-bienvenidas');
  if (error) return error;

  const dry = !RESCUE_ENABLED || !WELCOME_EMAIL_ENABLED || new URL(request.url).searchParams.get('dry') === '1';

  let scan;
  try {
    scan = await scanWelcomeRescue(admin);
  } catch (err) {
    console.error('[rescate-bienvenidas] No se pudo escanear:', err);
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500, headers: NO_STORE });
  }

  const candidatos = scan.candidates.map(a => ({ id: a.id, alumno: a.student_name, profesor: a.teacher_name, alta: a.created_at }));
  const descartados = scan.excluded.map(({ a, reason }) => ({ id: a.id, alumno: a.student_name, motivo: reason }));

  if (dry) {
    return Response.json({ dry: true, enabled: RESCUE_ENABLED, candidatos, descartados }, { headers: NO_STORE });
  }

  const base = publicBase(request);
  const resultados: Array<{ id: string; alumno: string; resultado: unknown }> = [];
  for (const a of scan.candidates.slice(0, MAX_POR_CORRIDA)) {
    try {
      const res = await sendWelcomeForAssignment(admin, a.id, 'alta', base);
      console.log(`[rescate-bienvenidas] ${a.id} (${a.student_name}):`, res);
      resultados.push({ id: a.id, alumno: a.student_name, resultado: res });
    } catch (err) {
      console.error(`[rescate-bienvenidas] ${a.id}: excepción:`, err);
      resultados.push({ id: a.id, alumno: a.student_name, resultado: { error: err instanceof Error ? err.message : String(err) } });
    }
  }
  return Response.json({
    dry: false, enviados: resultados, pendientes: Math.max(0, scan.candidates.length - MAX_POR_CORRIDA), descartados,
  }, { headers: NO_STORE });
}

export const GET = handle;
export const POST = handle;
