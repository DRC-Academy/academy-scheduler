// Cron horario (vercel.json → "0 * * * *"): alerta a admin y profe sobre emails
// de presentación pendientes. No penaliza scoring aquí (eso ocurre al enviarlo,
// en /api/assignments/[id]/presentation-sent); solo avisa.
//
// Umbrales (desde la asignación):
//   ·  4 h → recordatorio directo al PROFE.
//   · 12 h → aviso al ADMIN.
//   · 24 h → aviso urgente al ADMIN + aviso al PROFE.
//
// Anti-duplicados: cada alerta usa un id determinista por assignment; se consulta
// qué ids ya existen antes de insertar (y el upsert con ignoreDuplicates cierra la
// carrera), así una misma alerta no se repite en cada corrida.

import { supabase } from '@/lib/supabase';
import {
  hoursSinceAssigned,
  PRESENTATION_WARNING_HOURS,
  PRESENTATION_AT_RISK_HOURS,
  PRESENTATION_DEADLINE_HOURS,
} from '@/lib/presentationEmailUtils';

export const dynamic = 'force-dynamic';

interface AsgnRow {
  id: string;
  teacher_id: string;
  teacher_name: string;
  student_name: string;
  created_at: string;
  presentation_email_sent: boolean | null;
}

function fmtAssignedAt(createdAt: string): { fecha: string; hora: string } {
  const d = new Date(createdAt);
  if (isNaN(d.getTime())) return { fecha: '—', hora: '—' };
  return {
    fecha: d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }),
    hora:  d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }),
  };
}

export async function GET(request: Request): Promise<Response> {
  // Autorización opcional: si hay CRON_SECRET configurado, exigir el bearer que
  // envía Vercel Cron. Sin CRON_SECRET, el endpoint queda abierto (dev/manual).
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return Response.json({ error: 'No autorizado' }, { status: 401 });
    }
  }

  // Asignaciones con el email de presentación pendiente.
  const { data, error } = await supabase
    .from('assignments')
    .select('id, teacher_id, teacher_name, student_name, created_at, presentation_email_sent')
    .or('presentation_email_sent.eq.false,presentation_email_sent.is.null');

  if (error) {
    console.error('[cron presentation-emails] Error al leer asignaciones:', error);
    return Response.json({ error: 'Error del servidor' }, { status: 500 });
  }

  const pending = (data ?? []) as AsgnRow[];
  const now = Date.now();
  const createdAtIso = new Date(now).toISOString();

  // Construir las alertas candidatas (con id determinista por assignment + etapa).
  interface Candidate {
    id: string;
    target_user: string | null;
    target_role: string | null;
    title: string;
    body: string;
    type: string;
  }
  const candidates: Candidate[] = [];

  for (const a of pending) {
    const h = hoursSinceAssigned(a.created_at, now);
    const { fecha, hora } = fmtAssignedAt(a.created_at);

    // 4 h → recordatorio al profe.
    if (h >= PRESENTATION_WARNING_HOURS) {
      candidates.push({
        id: `presalert_reminder_${a.id}`,
        target_user: a.teacher_id,
        target_role: null,
        title: `📧 Recordatorio — Email de ${a.student_name}`,
        body: `Llevas 4h sin enviar el email de presentación a ${a.student_name}. ¡Los alumnos que reciben bienvenida pronto tienen mayor retención!`,
        type: 'presentation_email_reminder',
      });
    }

    // 12 h → aviso al admin.
    if (h >= PRESENTATION_AT_RISK_HOURS) {
      candidates.push({
        id: `presalert_warning_${a.id}`,
        target_user: null,
        target_role: 'admin',
        title: `⚠️ Email pendiente — ${a.teacher_name}`,
        body: `${a.teacher_name} lleva 12h sin enviar el email de presentación a ${a.student_name}. Asignado el ${fecha} a las ${hora}.`,
        type: 'presentation_email_warning',
      });
    }

    // 24 h → aviso urgente al admin + aviso al profe.
    if (h >= PRESENTATION_DEADLINE_HOURS) {
      candidates.push({
        id: `presalert_overdue_admin_${a.id}`,
        target_user: null,
        target_role: 'admin',
        title: `🔴 Email fuera de tiempo — ${a.teacher_name}`,
        body: `${a.teacher_name} no envió el email de presentación a ${a.student_name} en 24 horas. Se registrará -5 puntos en su scoring al enviarlo.`,
        type: 'presentation_email_overdue',
      });
      candidates.push({
        id: `presalert_overdue_teacher_${a.id}`,
        target_user: a.teacher_id,
        target_role: null,
        title: '🔴 Email de presentación fuera de tiempo',
        body: `No enviaste el email de presentación a ${a.student_name} en las primeras 24 horas. Cuando lo envíes se descontarán -5 puntos de tu scoring.`,
        type: 'presentation_email_overdue_teacher',
      });
    }
  }

  if (candidates.length === 0) {
    return Response.json({ ok: true, pending: pending.length, inserted: 0 });
  }

  // Anti-duplicados: descartar las alertas ya emitidas.
  const ids = candidates.map(c => c.id);
  const { data: existing } = await supabase.from('notifications').select('id').in('id', ids);
  const already = new Set((existing ?? []).map((r: { id: string }) => r.id));
  const toInsert = candidates.filter(c => !already.has(c.id));

  if (toInsert.length === 0) {
    return Response.json({ ok: true, pending: pending.length, inserted: 0 });
  }

  const rows = toInsert.map(c => ({
    id:          c.id,
    target_user: c.target_user,
    target_role: c.target_role,
    title:       c.title,
    body:        c.body,
    type:        c.type,
    read_by:     [],
    created_at:  createdAtIso,
    created_by:  'sistema',
  }));

  // ignoreDuplicates cierra la carrera si otra corrida insertó el mismo id.
  const { error: insErr } = await supabase
    .from('notifications')
    .upsert(rows, { onConflict: 'id', ignoreDuplicates: true });

  if (insErr) {
    console.error('[cron presentation-emails] Error al insertar notificaciones:', insErr);
    return Response.json({ error: 'Error al insertar notificaciones' }, { status: 500 });
  }

  return Response.json({ ok: true, pending: pending.length, inserted: rows.length });
}
