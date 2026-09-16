// Avisos de campanita del PLAZO DE 24 H del transcript, como endpoint suelto.
//
// NO está en vercel.json a propósito: el plan Hobby solo permite crons diarios y
// esta rutina ya corre dentro del cron de fin de día
// (app/api/cron/daily-transcript-reminder). Este endpoint existe para poder
// dispararla con más frecuencia desde fuera —Zapier cada hora, o una prueba a
// mano— sin sumar un cron:
//
//   GET  /api/cron/transcripts-vencidos            (Vercel, curl)
//   POST /api/cron/transcripts-vencidos            (Zapier: "Webhooks by Zapier → POST")
//   cabecera: Authorization: Bearer <CRON_SECRET>   (o ?secret=<CRON_SECRET>)
//   ?dry=1 → lista lo que avisaría sin crear nada.
//
// Qué hace: por cada clase con estado 'pendiente' a menos de 6 h del plazo, o
// recién 'vencida' (lib/transcriptDeadline), deja una notificación in-app al
// profesor. Idempotente: id determinista por clase y tipo, así que se puede
// llamar cada hora sin repetir avisos. No manda emails.

import { requireCronSecret, requireAdminClient } from '@/lib/cronAuth';
import { notifyTranscriptDeadlines } from '@/lib/transcriptDeadlineNotifications';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function run(request: Request): Promise<Response> {
  const denied = requireCronSecret(request, 'transcripts-vencidos');
  if (denied) return denied;
  const { admin, error } = requireAdminClient('transcripts-vencidos');
  if (!admin) return error;

  const dry = new URL(request.url).searchParams.get('dry') === '1';
  try {
    const r = await notifyTranscriptDeadlines({ admin, dry });
    console.log(`[transcripts-vencidos] ${r.candidates.length} clase(s), ${r.created} aviso(s) nuevo(s), ${r.skipped} ya avisada(s)${dry ? ' (dry)' : ''}.`);
    return Response.json({
      ok: true, dry,
      candidates: r.candidates.map(c => ({
        teacher: c.teacherName, student: c.studentName, date: c.date, hours: c.hours, kind: c.kind, id: c.id,
      })),
      created: r.created, skipped: r.skipped,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('[transcripts-vencidos] Error:', err);
    return Response.json({ error: 'Error del servidor' }, { status: 500 });
  }
}

export async function GET(request: Request): Promise<Response> { return run(request); }
export async function POST(request: Request): Promise<Response> { return run(request); }
