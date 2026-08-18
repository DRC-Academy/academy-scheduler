// Cron DIARIO (vercel.json → "0 13 * * *" = 10:00 en Argentina): recordatorios
// automáticos a los alumnos que recibieron su enlace y no lo completaron.
//
// QUÉ PERSIGUE — dos secuencias encadenadas, un alumno está como mucho en una
// (el criterio completo, con el porqué de cada filtro, vive en lib/formReminders):
//   · 'formulario' → su form_token sigue 'pending'. Reloj: created_at del token.
//   · 'test'       → completó el formulario pero no tiene ninguna prueba de nivel
//     terminada. Reloj: completed_at del token.
// Tres recordatorios por secuencia (días 2, 5 y 10) y después silencio. Si el
// alumno completa, desaparece de la lista solo en la corrida siguiente.
//
// PASO PREVIO — hay alumnos vivos que no pueden estar en ninguna secuencia
// porque no tienen enlace: los anteriores al 10/07/2026 (el formulario no
// existía cuando entraron) y aquellos a los que el suyo caducó sin abrirlo.
// Antes de nada se les genera uno y entran por la puerta normal. Su primer
// correo sale en la misma corrida, porque ese email ES la entrega del enlace, y
// los veteranos lo reciben con un texto propio.
//
// ANTI-DUPLICADO — "reservar y luego enviar", como el cron de transcripts. Antes
// de escribir un correo se incrementa el contador del token con un UPDATE
// condicionado al valor anterior (.eq(count, step - 1)). Ese update es atómico:
// si dos corridas se solapan, solo una encuentra el valor esperado y la otra se
// salta al alumno. Si el envío falla, el contador se devuelve a su sitio para
// que mañana se reintente.
//
// CÓMO PROBARLO (el secreto va en la cabecera Bearer o en ?secret=):
//   · ?dry=1          → lista a quién se le escribiría hoy y con qué texto, sin
//                       enviar nada y sin tocar la base.
//   · ?test=tu@email  → te manda los 6 correos de ejemplo (3 de cada secuencia)
//                       a esa dirección, sin tocar la base.
//   · ?limit=N        → tope de envíos de esta corrida (por defecto 40).

import { supabase } from '@/lib/supabase';
import { getOrCreateTestSession } from '@/lib/levelTest/createSession';
import {
  buildPendingList, summarize, studentsNeedingToken, STEP_LABEL,
  type FormTokenRow, type StudentRow, type TestSessionRow, type DropoutRow,
  type AssignmentRow, type PendingEntry, type NeedsToken,
} from '@/lib/formReminders';
import { sendFollowupEmail, followupCopy } from '@/lib/studentFollowupEmails';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Tope de envíos por corrida. Existe por el arranque: el día que esto se
// enciende hay decenas de alumnos esperando desde hace semanas y salen todos a
// la vez. Resend admite 2 peticiones por segundo, así que 40 correos son unos
// 24 segundos y entran de sobra en los 60 de maxDuration. Lo que sobra se va
// mañana, y la respuesta dice cuántos quedaron.
const MAX_POR_CORRIDA = 40;

// Espera entre envíos: Resend corta a 2 req/s y los que exceden vuelven con
// rate_limit_exceeded, es decir, alumnos que se quedan sin su correo.
const PAUSA_MS = 600;

/** Días de vida que le quedan al enlace por debajo de los cuales se renueva. */
const RENOVAR_SI_QUEDAN_MENOS_DE = 14;
const NUEVA_VIGENCIA_DIAS = 30;

const TOKEN_COLS =
  'id, token, student_id, student_name, student_email, teacher_id, teacher_name, ' +
  'assignment_id, plan, level, status, created_at, completed_at, expires_at, ' +
  'form_reminder_count, form_reminder_last_sent, test_reminder_count, test_reminder_last_sent, ' +
  'reminder_variant';

function publicBase(request: Request): string {
  const envUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '');
  if (envUrl) return envUrl;
  try { return new URL(request.url).origin; }
  catch { return 'https://academy-scheduler-aqpt.vercel.app'; }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // Sin CRON_SECRET no se ejecuta: mejor no hacer nada que dejar abierto un
  // endpoint que manda correos a los alumnos.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[cron form-reminders] Falta CRON_SECRET en el entorno.');
    return Response.json({ error: 'CRON_SECRET no configurado' }, { status: 500 });
  }
  const autorizado =
    request.headers.get('authorization') === `Bearer ${secret}` ||
    url.searchParams.get('secret') === secret;
  if (!autorizado) {
    return Response.json({ error: 'No autorizado' }, { status: 401 });
  }

  const dry = url.searchParams.get('dry') === '1';
  const testTo = url.searchParams.get('test')?.trim();
  const limite = Math.max(1, parseInt(url.searchParams.get('limit') ?? '', 10) || MAX_POR_CORRIDA);
  const base = publicBase(request);

  // ── Modo prueba: los 6 correos a una dirección, sin tocar la base ──────────
  if (testTo) return enviarPrueba(testTo, base);

  // ── Datos ──────────────────────────────────────────────────────────────────
  const [tk, st, ls, dr, ag] = await Promise.all([
    supabase.from('form_tokens').select(TOKEN_COLS),
    supabase.from('students').select('id, name, email'),
    supabase.from('level_test_sessions').select('student_id, student_name, candidate_name, status'),
    supabase.from('student_dropouts').select('student_id, student_name'),
    supabase.from('assignments').select('id, student_id, student_name, teacher_id, teacher_name, plan, student_level'),
  ]);

  if (tk.error) {
    console.error('[cron form-reminders] Error al leer form_tokens:', tk.error);
    if (tk.error.message?.includes('form_reminder_count')) {
      return Response.json(
        { error: 'Faltan las columnas de recordatorio. Ejecutá supabase-form-reminders.sql en el SQL editor de Supabase.' },
        { status: 500 },
      );
    }
    return Response.json({ error: 'Error del servidor' }, { status: 500 });
  }
  if (st.error) {
    console.error('[cron form-reminders] Error al leer students:', st.error);
    return Response.json({ error: 'Error del servidor' }, { status: 500 });
  }
  // Las dos tablas de apoyo son best-effort: si fallan, se sigue con la lista
  // vacía. Sin sesiones nadie tendría el test por hecho (se les escribiría de
  // más), así que ahí sí se corta.
  if (ls.error) {
    console.error('[cron form-reminders] Error al leer level_test_sessions:', ls.error);
    return Response.json({ error: 'Error del servidor' }, { status: 500 });
  }
  if (dr.error) console.error('[cron form-reminders] Error al leer student_dropouts (se sigue sin ese filtro):', dr.error);
  if (ag.error) console.error('[cron form-reminders] Error al leer assignments (no se generarán enlaces nuevos):', ag.error);

  const now = Date.now();
  const students = (st.data ?? []) as unknown as StudentRow[];
  const sessions = (ls.data ?? []) as unknown as TestSessionRow[];
  const dropouts = (dr.data ?? []) as unknown as DropoutRow[];
  let tokens = (tk.data ?? []) as unknown as FormTokenRow[];

  // ── Paso previo: enlaces para quien no tiene ninguno vigente ───────────────
  const sinEnlace = studentsNeedingToken({
    tokens, students, sessions, dropouts,
    assignments: (ag.data ?? []) as unknown as AssignmentRow[],
    now,
  });

  // En dry se simulan en memoria (misma forma de fila, sin insertar nada), para
  // que la previsualización incluya de verdad a quién le llegaría su enlace hoy.
  let generados: FormTokenRow[] = [];
  if (sinEnlace.length > 0) {
    generados = dry
      ? sinEnlace.map((n, i) => tokenSimulado(n, now, i))
      : await generarEnlaces(sinEnlace);
    tokens = [...tokens, ...generados];
  }

  const pendientes = buildPendingList({ tokens, students, sessions, dropouts, now });

  const tocanHoy = pendientes.filter(e => e.step !== null);
  const resumen = summarize(pendientes, sinEnlace.length);

  // ── Modo dry: quién recibiría qué, sin enviar ni escribir ──────────────────
  if (dry) {
    return Response.json({
      ok: true,
      dry: true,
      resumen,
      generariaEnlace: sinEnlace.map(n => ({
        alumno: n.student.name, email: n.email, profesor: n.teacherName, motivo: n.variant,
      })),
      enviaria: tocanHoy.slice(0, limite).map(e => detalle(e, base)),
      recortadosPorLimite: Math.max(0, tocanHoy.length - limite),
      esperando: pendientes
        .filter(e => e.step === null)
        .map(e => ({
          alumno: e.student.name, secuencia: e.sequence, dias: e.days,
          recordatoriosEnviados: e.count, motivo: e.skipReason,
        })),
    });
  }

  // ── Envío ──────────────────────────────────────────────────────────────────
  const aEnviar = tocanHoy.slice(0, limite);
  const recortados = tocanHoy.length - aEnviar.length;
  if (recortados > 0) {
    console.warn(`[cron form-reminders] ${recortados} alumno(s) quedan para la próxima corrida por el tope de ${limite}.`);
  }

  const enviados: Array<{ alumno: string; secuencia: string; paso: string }> = [];
  const fallidos: Array<{ alumno: string; secuencia: string; motivo: string }> = [];

  for (let i = 0; i < aEnviar.length; i++) {
    const e = aEnviar[i];
    const step = e.step as 1 | 2 | 3;
    const col = e.sequence === 'formulario' ? 'form_reminder' : 'test_reminder';

    // 1) Reservar el paso. Condicionado al contador anterior: si otra corrida se
    //    adelantó, este update no toca ninguna fila y nos saltamos al alumno.
    const { data: reservado, error: resErr } = await supabase
      .from('form_tokens')
      .update({ [`${col}_count`]: step, [`${col}_last_sent`]: new Date().toISOString() })
      .eq('id', e.token.id)
      .eq(`${col}_count`, step - 1)
      .select('id');

    if (resErr) {
      console.error('[cron form-reminders] Error al reservar el recordatorio:', resErr);
      fallidos.push({ alumno: e.student.name, secuencia: e.sequence, motivo: 'reserva' });
      continue;
    }
    if (!reservado || reservado.length === 0) continue;   // ya lo tomó otra corrida

    // 2) El enlace. Para el test puede haber que crear una sesión nueva (la
    //    anterior caduca a los 7 días y muchas ya están vencidas).
    let enlace: string | null = null;
    if (e.sequence === 'formulario') {
      enlace = `${base}/formulario/${e.token.token}`;
    } else {
      try {
        const { token: testToken, error: sesErr } = await getOrCreateTestSession({
          studentId:    e.token.student_id || undefined,
          studentName:  e.token.student_name,
          studentEmail: e.email,
          candidateEmail: e.email,
          teacherId:    e.token.teacher_id || undefined,
          teacherName:  e.token.teacher_name || undefined,
          assignmentId: e.token.assignment_id || undefined,
          plan:         e.token.plan || undefined,
          level:        e.token.level || undefined,
        });
        if (testToken) enlace = `${base}/test/${testToken}`;
        else console.error('[cron form-reminders] No se pudo preparar el test:', sesErr);
      } catch (err) {
        console.error('[cron form-reminders] Excepción al preparar el test:', err);
      }
    }

    if (!enlace) {
      await revertir(e, col, step);
      fallidos.push({ alumno: e.student.name, secuencia: e.sequence, motivo: 'sin enlace' });
      continue;
    }

    // 3) Enviar.
    const ok = await sendFollowupEmail(
      e.sequence, step,
      { studentName: e.token.student_name || e.student.name, teacherName: e.token.teacher_name, url: enlace },
      e.email,
      e.variant,
    );

    if (!ok) {
      await revertir(e, col, step);
      fallidos.push({ alumno: e.student.name, secuencia: e.sequence, motivo: 'envío' });
      continue;
    }

    enviados.push({ alumno: e.student.name, secuencia: e.sequence, paso: STEP_LABEL[step] });

    // 4) Espejo en students, para la columna "Último follow-up" del panel.
    const { error: espErr } = await supabase
      .from('students')
      .update({
        form_reminder_count:     step,
        form_reminder_last_sent: new Date().toISOString(),
        form_reminder_stage:     e.sequence,
      })
      .eq('id', e.student.id);
    if (espErr) console.error('[cron form-reminders] Error al actualizar el espejo en students:', espErr);

    // 5) Que el enlace siga vivo hasta el final de la secuencia. Los tokens
    //    caducan a los 30 días y hay alumnos a los que empezamos a perseguir en
    //    el día 25: sin esto les mandaríamos un enlace que muere antes del
    //    último recordatorio. Solo se renueva el de quien está recibiendo correo.
    if (e.sequence === 'formulario') await renovarVigencia(e, now);

    if (i < aEnviar.length - 1) await sleep(PAUSA_MS);
  }

  return Response.json({
    ok: true,
    resumen,
    enlacesGenerados: generados.length,
    tocabanHoy: tocanHoy.length,
    enviados: enviados.length,
    fallidos: fallidos.length,
    pendientesParaMañana: recortados,
    detalle: { enviados, fallidos },
  });
}

/**
 * Crea los form_tokens que faltan, en un solo insert.
 *
 * Van con `reminder_variant` para que el follow-up sepa después con qué texto
 * perseguirlos y que su primer correo sale ya. La vigencia (30 días) la pone el
 * default de la tabla, igual que en /api/forms/generate-token.
 */
async function generarEnlaces(faltantes: NeedsToken[]): Promise<FormTokenRow[]> {
  const filas = faltantes.map(n => ({
    id:            `ft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    token:         crypto.randomUUID(),
    student_id:    n.student.id,
    student_name:  n.student.name,
    student_email: n.email,
    teacher_id:    n.teacherId,
    teacher_name:  n.teacherName,
    assignment_id: n.assignmentId,
    plan:          n.plan,
    level:         n.level,
    status:        'pending',
    reminder_variant: n.variant,
  }));

  const { data, error } = await supabase.from('form_tokens').insert(filas).select(TOKEN_COLS);
  if (error) {
    console.error('[cron form-reminders] Error al generar los enlaces que faltaban:', error);
    return [];
  }
  console.log(`[cron form-reminders] ${data?.length ?? 0} enlace(s) generados para alumnos que no tenían.`);
  return (data ?? []) as unknown as FormTokenRow[];
}

/** Fila de mentira para el modo dry: misma forma, sin tocar la base. */
function tokenSimulado(n: NeedsToken, now: number, i: number): FormTokenRow {
  const iso = new Date(now).toISOString();
  return {
    id: `dry_${i}`, token: `dry-${i}`,
    student_id: n.student.id, student_name: n.student.name, student_email: n.email,
    teacher_id: n.teacherId, teacher_name: n.teacherName, assignment_id: n.assignmentId,
    plan: n.plan, level: n.level,
    status: 'pending', created_at: iso, completed_at: null,
    expires_at: new Date(now + 30 * 86_400_000).toISOString(),
    form_reminder_count: 0, form_reminder_last_sent: null,
    test_reminder_count: 0, test_reminder_last_sent: null,
    reminder_variant: n.variant,
  };
}

/** Devuelve el contador a su sitio cuando el correo no llegó a salir. */
async function revertir(e: PendingEntry, col: string, step: number): Promise<void> {
  const { error } = await supabase
    .from('form_tokens')
    .update({ [`${col}_count`]: step - 1, [`${col}_last_sent`]: e.lastSent })
    .eq('id', e.token.id);
  if (error) console.error('[cron form-reminders] Error al revertir la reserva:', error);
}

async function renovarVigencia(e: PendingEntry, now: number): Promise<void> {
  const vence = e.token.expires_at ? new Date(e.token.expires_at).getTime() : 0;
  const quedan = (vence - now) / 86_400_000;
  if (vence && quedan >= RENOVAR_SI_QUEDAN_MENOS_DE) return;

  const nuevo = new Date(now + NUEVA_VIGENCIA_DIAS * 86_400_000).toISOString();
  const { error } = await supabase.from('form_tokens').update({ expires_at: nuevo }).eq('id', e.token.id);
  if (error) console.error('[cron form-reminders] Error al renovar la vigencia del enlace:', error);
}

function detalle(e: PendingEntry, base: string) {
  const step = e.step as 1 | 2 | 3;
  const simulado = e.token.id.startsWith('dry_');
  const enlace = e.sequence !== 'formulario'
    ? '(se resuelve al enviar: reutiliza su prueba vigente o crea una nueva)'
    : simulado
      ? '(enlace nuevo: se genera en la corrida real)'
      : `${base}/formulario/${e.token.token}`;
  const { subject } = followupCopy(e.sequence, step, {
    studentName: e.token.student_name || e.student.name,
    teacherName: e.token.teacher_name,
    url: enlace,
  }, e.variant);
  return {
    alumno: e.student.name,
    email: e.email,
    profesor: e.token.teacher_name,
    secuencia: e.sequence,
    texto: e.variant,
    paso: STEP_LABEL[step],
    diasEsperando: e.days,
    recordatoriosPrevios: e.count,
    asunto: subject,
    enlace,
  };
}

/** Los 9 correos de ejemplo a una dirección. No toca la base. */
async function enviarPrueba(to: string, base: string): Promise<Response> {
  const ejemplo = {
    studentName: 'Ana García',
    teacherName: 'Sebastián',
    url: `${base}/formulario/00000000-0000-0000-0000-000000000000`,
  };
  const variantes = [
    { sequence: 'formulario' as const, variant: 'estandar' as const },
    { sequence: 'formulario' as const, variant: 'veterano' as const },
    { sequence: 'test' as const,       variant: 'estandar' as const },
  ];
  const enviados: string[] = [];
  for (const v of variantes) {
    for (const step of [1, 2, 3] as const) {
      const ok = await sendFollowupEmail(v.sequence, step, ejemplo, to, v.variant);
      if (ok) enviados.push(`${v.sequence}/${v.variant} ${STEP_LABEL[step]}`);
      await sleep(PAUSA_MS);
    }
  }
  return Response.json({ ok: true, test: true, to, enviados });
}
