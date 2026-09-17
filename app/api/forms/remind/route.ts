// Follow-up A MANO del formulario inicial / prueba de nivel: el botón
// "Recordar" de la pestaña Tests de nivel del admin (uno o varios alumnos).
//
// Mismo criterio que el cron diario (lib/formReminders.buildPendingList) para
// saber qué le falta a cada alumno y con qué texto le toca, y el mismo envío
// (lib/formReminderSend). Lo único que se salta es la CADENCIA: el cron espera
// los días 1, 2, 3, 6, 9, 16…; aquí sale ya. Dos reglas propias:
//   · el número de envío es el siguiente al último registrado, sin tope: si ya
//     agotó los 13 automáticos, el 14º va con el texto semanal;
//   · como mucho uno por día de calendario y alumno, para que un doble clic no
//     mande dos.
// "No enviar más" (students.followup_opt_out) también corta el envío manual:
// si el equipo quiere escribirle igual, primero quita la marca.
//
// Lo llama el admin ya logueado (auth client-side, igual que el resto de rutas
// del panel). Body: { tokenIds: string[] } con los ids de form_tokens.

import { supabase } from '@/lib/supabase';
import { enviarRecordatorio, PAUSA_MS, sleep } from '@/lib/formReminderSend';
import {
  buildPendingList, calendarDaysSince, stepLabel,
  type FormTokenRow, type StudentRow, type TestSessionRow, type DropoutRow, type FollowupRow,
} from '@/lib/formReminders';
import { publicBase } from '@/lib/appUrl';
import type { ResultadoManual } from '@/lib/levelTestSeguimiento';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Tope de alumnos por petición: 20 envíos son unos 12 s con la pausa de Resend. */
const MAX_POR_PETICION = 20;

const TOKEN_COLS =
  'id, token, student_id, student_name, student_email, teacher_id, teacher_name, ' +
  'assignment_id, plan, level, status, created_at, completed_at, expires_at, ' +
  'form_reminder_count, form_reminder_last_sent, test_reminder_count, test_reminder_last_sent, ' +
  'reminder_variant';

export async function POST(request: Request): Promise<Response> {
  let body: { tokenIds?: unknown };
  try { body = await request.json(); }
  catch { return Response.json({ error: 'JSON inválido' }, { status: 400 }); }

  const ids = Array.isArray(body.tokenIds)
    ? [...new Set(body.tokenIds.filter((x): x is string => typeof x === 'string' && x.trim() !== ''))]
    : [];
  if (ids.length === 0) return Response.json({ error: 'Faltan los ids (tokenIds).' }, { status: 400 });
  if (ids.length > MAX_POR_PETICION) {
    return Response.json({ error: `Como mucho ${MAX_POR_PETICION} alumnos por envío.` }, { status: 400 });
  }

  // students con el opt-out; sin la columna (migración sin correr) se reintenta sin ella.
  let st = await supabase.from('students').select('id, name, email, followup_opt_out');
  if (st.error && (st.error.code === '42703' || st.error.code === 'PGRST204')) {
    st = await supabase.from('students').select('id, name, email');
  }
  const [tk, ls, dr, ag, fu] = await Promise.all([
    supabase.from('form_tokens').select(TOKEN_COLS),
    supabase.from('level_test_sessions').select('student_id, student_name, candidate_name, status'),
    supabase.from('student_dropouts').select('student_id, student_name'),
    supabase.from('assignments').select('student_id, student_name, student_email'),
    supabase.from('level_test_followups').select('student_id, numero_envio, sent_at, status'),
  ]);
  if (tk.error || st.error || ls.error) {
    console.error('[forms/remind] Error al leer:', tk.error ?? st.error ?? ls.error);
    return Response.json({ error: 'Error del servidor' }, { status: 500 });
  }
  if (fu.error) {
    console.error('[forms/remind] Error al leer level_test_followups:', fu.error);
    return Response.json(
      { error: 'Falta la tabla level_test_followups. Ejecutá supabase-plazo-24h-followups.sql en Supabase.' },
      { status: 500 },
    );
  }
  if (dr.error) console.error('[forms/remind] Error al leer student_dropouts (se sigue sin ese filtro):', dr.error);
  if (ag.error) console.error('[forms/remind] Error al leer assignments (sin email alternativo):', ag.error);

  const now = Date.now();
  const base = publicBase(request);
  const pendientes = buildPendingList({
    tokens:      (tk.data ?? []) as unknown as FormTokenRow[],
    students:    (st.data ?? []) as unknown as StudentRow[],
    sessions:    (ls.data ?? []) as unknown as TestSessionRow[],
    dropouts:    (dr.data ?? []) as unknown as DropoutRow[],
    followups:   (fu.data ?? []) as unknown as FollowupRow[],
    assignments: (ag.data ?? []) as unknown as Array<{ student_id: string | null; student_name: string | null; student_email: string | null }>,
    now,
  });
  const porToken = new Map(pendientes.map(e => [e.token.id, e]));
  const nombreDe = new Map(((tk.data ?? []) as unknown as FormTokenRow[]).map(t => [t.id, t.student_name]));

  const resultados: ResultadoManual[] = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const e = porToken.get(id);
    // Completó, el enlace caducó, es baja o no tiene email: no hay a quién ni
    // qué recordar. El panel no ofrece el botón en esos casos; esto es la red.
    if (!e) { resultados.push({ tokenId: id, alumno: nombreDe.get(id) ?? null, ok: false, motivo: 'no_pendiente' }); continue; }
    if (e.skipReason === 'no_enviar') {
      resultados.push({ tokenId: id, alumno: e.student.name, ok: false, motivo: 'no_enviar' });
      continue;
    }
    if (e.lastSent && calendarDaysSince(e.lastSent, now) < 1) {
      resultados.push({ tokenId: id, alumno: e.student.name, ok: false, motivo: 'ya_hoy' });
      continue;
    }

    const step = e.count + 1;
    const r = await enviarRecordatorio(e, step, base, now);
    resultados.push(r.ok
      ? { tokenId: id, alumno: e.student.name, ok: true, paso: stepLabel(step) }
      : { tokenId: id, alumno: e.student.name, ok: false, motivo: r.motivo });

    if (i < ids.length - 1) await sleep(PAUSA_MS);
  }

  return Response.json({
    ok: true,
    enviados: resultados.filter(r => r.ok).length,
    resultados,
  });
}
