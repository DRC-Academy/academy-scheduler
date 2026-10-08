// Cron diario: pone al día `student_pauses` con TODAS las suscripciones de Woo.
//
// /api/check-subscription ya abre y cierra pausas cada vez que se verifica a un
// alumno, pero solo de los alumnos que alguien mira. Esto cubre al resto: un
// alumno que se pausa (o reactiva) y nadie abre su ficha queda registrado igual
// esa noche, con su fecha, para las métricas, los payouts y las asistencias.
//
// La regla es la misma de siempre (lib/wooPausedEmails.fetchPausedEmails →
// resolveWooSubscriptions + overrides de Oritalk/manual). Si WooCommerce no
// contesta NO se toca nada: cerrar pausas porque Woo está caído reactivaría a
// todos de golpe.
//
// ?dry=1 → dice qué haría sin escribir.

import { requireCronSecret, requireAdminClient } from '@/lib/cronAuth';
import { fetchPausedEmails } from '@/lib/wooPausedEmails';
import { recordPauseState } from '@/lib/studentPausesServer';
import { madridToday } from '@/lib/subscriptionAccess';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const NO_STORE = { 'Cache-Control': 'no-store' };
const nk = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');

export async function GET(request: Request): Promise<Response> {
  const denied = requireCronSecret(request, 'cron sync-pausas');
  if (denied) return denied;
  const { admin, error: sinAdmin } = requireAdminClient('cron sync-pausas');
  if (sinAdmin) return sinAdmin;
  const dry = new URL(request.url).searchParams.get('dry') === '1';

  let paused: Set<string>;
  try {
    paused = await fetchPausedEmails();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron sync-pausas] WooCommerce no contestó; no se toca nada:', msg);
    return Response.json({ ok: false, error: `WooCommerce: ${msg}` }, { status: 502, headers: NO_STORE });
  }

  const students: Array<{ id: string; name: string; email: string }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from('students').select('id, name, email').order('id').range(from, from + 999);
    if (error) return Response.json({ ok: false, error: `students: ${error.message}` }, { status: 500, headers: NO_STORE });
    for (const s of data ?? []) if (nk(s.email)) students.push({ id: s.id, name: s.name ?? '', email: nk(s.email) });
    if ((data ?? []).length < 1000) break;
  }

  const { data: openRows, error: openErr } = await admin.from('student_pauses')
    .select('student_id').is('ended_on', null);
  if (openErr) return Response.json({ ok: false, error: `student_pauses: ${openErr.message}` }, { status: 500, headers: NO_STORE });
  const open = new Set((openRows ?? []).map(r => String(r.student_id)));

  const today = madridToday();
  const opened: string[] = [];
  const closed: string[] = [];
  for (const s of students) {
    const isPaused = paused.has(s.email);
    if (isPaused === open.has(s.id)) continue;
    (isPaused ? opened : closed).push(s.name);
    if (!dry) await recordPauseState(admin, { studentId: s.id, studentName: s.name, email: s.email }, isPaused, today);
  }

  console.log(`[cron sync-pausas] en pausa: ${paused.size} · abiertas: ${opened.length} · cerradas: ${closed.length}${dry ? ' (ensayo)' : ''}`);
  return Response.json({ ok: true, dry, today, en_pausa: paused.size, abiertas: opened, cerradas: closed }, { headers: NO_STORE });
}
