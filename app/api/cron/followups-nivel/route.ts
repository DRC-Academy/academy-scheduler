// Cron DIARIO (vercel.json → "0 8 * * *" UTC = 10:00 en España en horario de
// verano, 09:00 en invierno; los crons de Vercel disparan "dentro de la hora"):
// follow-ups automáticos al alumno que todavía no ha completado su formulario
// inicial y su prueba de nivel.
//
// Sustituye al antiguo /api/cron/form-reminders (dos secuencias de 3 correos).
//
// LA REGLA (el criterio completo, con el porqué de cada filtro, vive en
// lib/formReminders):
//   · Un solo reloj por alumno: día 0 = created_at del enlace vigente. Para los
//     que nunca tuvieron enlace, el día en que este cron se lo genera.
//   · Cadencia: días 1, 2, 3 · 6, 9 · 16, 23, 30, 37, 44, 51, 58, 65. Trece
//     envíos como máximo.
//   · Se corta al completar la prueba, al darse de baja, al eliminar al alumno
//     (cascade) o con "No enviar más" (students.followup_opt_out).
//   · El texto depende de la etapa (recordatorio / espera / semanal) y de qué le
//     falta (formulario + prueba, o solo la prueba). Ver lib/studentFollowupEmails.
//
// IDEMPOTENTE: cada envío es una fila de level_test_followups con índice único
// (alumno, número de envío). Si el cron corre dos veces, la segunda no encuentra
// nada que mandar. El envío en sí (reservar → enlace → correo → registro →
// espejos) vive en lib/formReminderSend y lo comparte con el botón "Recordar".
//
// PASO PREVIO: alumnos vivos sin ningún enlace vigente (anteriores al
// 10/07/2026, o con el suyo caducado sin abrir). Se les genera uno y su primer
// correo sale en la misma corrida: ese email ES la entrega del enlace.
//
// SEGURIDAD: secreto en tiempo constante y cliente ADMIN de Supabase
// (lib/cronAuth); sin SUPABASE_SERVICE_ROLE_KEY responde 500.
//
// CÓMO PROBARLO (Authorization: Bearer <CRON_SECRET>, o ?secret=):
//   · GET o POST, da igual (Vercel llama con GET; Zapier suele mandar POST).
//   · ?dry=1          → lista a quién se le escribiría hoy y con qué texto, sin
//                       enviar nada y sin tocar la base.
//   · ?test=tu@email  → te manda los 6 correos de ejemplo (día 1, 2 y 3, etapa
//                       de espera, semanal y la variante veterano) a esa
//                       dirección, sin tocar la base.
//   · ?limit=N        → tope de envíos de esta corrida (por defecto 40).

import type { SupabaseClient } from '@supabase/supabase-js';
import { requireCronSecret, requireAdminClient } from '@/lib/cronAuth';
import { enviarRecordatorio, PAUSA_MS, sleep } from '@/lib/formReminderSend';
import {
  buildPendingList, summarize, studentsNeedingToken, stepLabel,
  type FormTokenRow, type StudentRow, type TestSessionRow, type DropoutRow,
  type AssignmentRow, type PendingEntry, type NeedsToken, type FollowupRow,
} from '@/lib/formReminders';
import { sendFollowupEmail, followupCopy } from '@/lib/studentFollowupEmails';
import { publicBase } from '@/lib/appUrl';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Tope de envíos por corrida. Existe por el arranque: el día que esto se
// enciende hay decenas de alumnos esperando desde hace semanas y salen todos a
// la vez. Resend admite 2 peticiones por segundo, así que 40 correos son unos
// 24 segundos y entran de sobra en los 60 de maxDuration. Lo que sobra se va
// mañana, y la respuesta dice cuántos quedaron.
const MAX_POR_CORRIDA = 40;

const TOKEN_COLS =
  'id, token, student_id, student_name, student_email, teacher_id, teacher_name, ' +
  'assignment_id, plan, level, status, created_at, completed_at, expires_at, ' +
  'form_reminder_count, form_reminder_last_sent, test_reminder_count, test_reminder_last_sent, ' +
  'reminder_variant';

const STUDENT_COLS = 'id, name, email, followup_opt_out';
const STUDENT_COLS_LEGACY = 'id, name, email';

async function run(request: Request): Promise<Response> {
  const denied = requireCronSecret(request, 'cron followups-nivel');
  if (denied) return denied;
  const { admin, error: sinAdmin } = requireAdminClient('cron followups-nivel');
  if (!admin) return sinAdmin;

  const url = new URL(request.url);
  const dry = url.searchParams.get('dry') === '1';
  const testTo = url.searchParams.get('test')?.trim();
  const limite = Math.max(1, parseInt(url.searchParams.get('limit') ?? '', 10) || MAX_POR_CORRIDA);
  const base = publicBase(request);

  // ── Modo prueba: los 6 correos a una dirección, sin tocar la base ──────────
  if (testTo) return enviarPrueba(testTo, base);

  // ── Datos ──────────────────────────────────────────────────────────────────
  // `students` con la columna del opt-out; si la migración no está corrida
  // (42703) se reintenta sin ella y nadie queda excluido.
  let st = await admin.from('students').select(STUDENT_COLS);
  if (st.error && (st.error.code === '42703' || st.error.code === 'PGRST204')) {
    console.warn('[cron followups-nivel] Falta students.followup_opt_out: corré supabase-plazo-24h-followups.sql.');
    st = await admin.from('students').select(STUDENT_COLS_LEGACY);
  }
  const [tk, ls, dr, ag, fu] = await Promise.all([
    admin.from('form_tokens').select(TOKEN_COLS),
    admin.from('level_test_sessions').select('student_id, student_name, candidate_name, status'),
    admin.from('student_dropouts').select('student_id, student_name'),
    admin.from('assignments').select('id, student_id, student_name, student_email, teacher_id, teacher_name, plan, student_level'),
    admin.from('level_test_followups').select('student_id, numero_envio, sent_at, status'),
  ]);

  if (tk.error) {
    console.error('[cron followups-nivel] Error al leer form_tokens:', tk.error);
    if (tk.error.message?.includes('form_reminder_count') || tk.error.message?.includes('reminder_variant')) {
      return Response.json(
        { error: 'Faltan las columnas del follow-up en form_tokens. Ejecutá supabase-plazo-24h-followups.sql en el SQL editor de Supabase.' },
        { status: 500 },
      );
    }
    return Response.json({ error: 'Error del servidor' }, { status: 500 });
  }
  if (st.error) {
    console.error('[cron followups-nivel] Error al leer students:', st.error);
    return Response.json({ error: 'Error del servidor' }, { status: 500 });
  }
  // Sin sesiones nadie tendría el test por hecho (se les escribiría de más):
  // ahí sí se corta. Sin el registro de envíos tampoco: sin él no hay
  // idempotencia y se mandaría el primer correo a todos otra vez.
  if (ls.error) {
    console.error('[cron followups-nivel] Error al leer level_test_sessions:', ls.error);
    return Response.json({ error: 'Error del servidor' }, { status: 500 });
  }
  if (fu.error) {
    console.error('[cron followups-nivel] Error al leer level_test_followups:', fu.error);
    return Response.json(
      { error: 'Falta la tabla level_test_followups. Ejecutá supabase-plazo-24h-followups.sql en el SQL editor de Supabase.' },
      { status: 500 },
    );
  }
  if (dr.error) console.error('[cron followups-nivel] Error al leer student_dropouts (se sigue sin ese filtro):', dr.error);
  if (ag.error) console.error('[cron followups-nivel] Error al leer assignments (no se generarán enlaces nuevos):', ag.error);

  const now = Date.now();
  const students = (st.data ?? []) as unknown as StudentRow[];
  const sessions = (ls.data ?? []) as unknown as TestSessionRow[];
  const dropouts = (dr.data ?? []) as unknown as DropoutRow[];
  const assignments = (ag.data ?? []) as unknown as AssignmentRow[];
  const followups = (fu.data ?? []) as unknown as FollowupRow[];
  let tokens = (tk.data ?? []) as unknown as FormTokenRow[];

  // ── Paso previo: enlaces para quien no tiene ninguno vigente ───────────────
  // Su día 0 es HOY (created_at del token nuevo), como pidió Facundo.
  const sinEnlace = studentsNeedingToken({ tokens, students, sessions, dropouts, assignments, now })
    // "No enviar más" también corta la generación de enlaces: sin enlace no hay
    // secuencia que empezar.
    .filter(n => !n.student.followup_opt_out);

  // En dry se simulan en memoria (misma forma de fila, sin insertar nada), para
  // que la previsualización incluya de verdad a quién le llegaría su enlace hoy.
  let generados: FormTokenRow[] = [];
  if (sinEnlace.length > 0) {
    generados = dry
      ? sinEnlace.map((n, i) => tokenSimulado(n, now, i))
      : await generarEnlaces(admin, sinEnlace);
    tokens = [...tokens, ...generados];
  }

  const pendientes = buildPendingList({
    tokens, students, sessions, dropouts, now, followups,
    assignments: assignments.map(a => ({ student_id: a.student_id, student_name: a.student_name, student_email: a.student_email })),
  });

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
          alumno: e.student.name, faltante: e.sequence, dias: e.days,
          enviosHechos: e.count, motivo: e.skipReason,
        })),
    });
  }

  // ── Envío ──────────────────────────────────────────────────────────────────
  const aEnviar = tocanHoy.slice(0, limite);
  const recortados = tocanHoy.length - aEnviar.length;
  if (recortados > 0) {
    console.warn(`[cron followups-nivel] ${recortados} alumno(s) quedan para la próxima corrida por el tope de ${limite}.`);
  }

  const enviados: Array<{ alumno: string; faltante: string; envio: string; email: string }> = [];
  const fallidos: Array<{ alumno: string; faltante: string; motivo: string }> = [];

  for (let i = 0; i < aEnviar.length; i++) {
    const e = aEnviar[i];
    const step = e.step as number;

    const r = await enviarRecordatorio(e, step, base, now, admin);
    if (r.ok) {
      enviados.push({ alumno: e.student.name, faltante: e.sequence, envio: stepLabel(step), email: e.email });
    } else if (r.motivo !== 'ya_tomado') {          // ya_tomado = lo tomó otra corrida
      fallidos.push({ alumno: e.student.name, faltante: e.sequence, motivo: r.motivo });
    }

    if (i < aEnviar.length - 1) await sleep(PAUSA_MS);
  }

  console.log(`[cron followups-nivel] ${enviados.length} enviado(s), ${fallidos.length} fallido(s), ${generados.length} enlace(s) nuevo(s).`);
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

export async function GET(request: Request): Promise<Response> { return run(request); }
export async function POST(request: Request): Promise<Response> { return run(request); }

/**
 * Crea los form_tokens que faltan, en un solo insert.
 *
 * Van con `reminder_variant` para que el follow-up sepa después con qué texto
 * perseguirlos y que su primer correo sale ya. La vigencia (30 días) la pone el
 * default de la tabla, igual que en /api/forms/generate-token.
 */
async function generarEnlaces(admin: SupabaseClient, faltantes: NeedsToken[]): Promise<FormTokenRow[]> {
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

  const { data, error } = await admin.from('form_tokens').insert(filas).select(TOKEN_COLS);
  if (error) {
    console.error('[cron followups-nivel] Error al generar los enlaces que faltaban:', error);
    return [];
  }
  console.log(`[cron followups-nivel] ${data?.length ?? 0} enlace(s) generados para alumnos que no tenían.`);
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

function detalle(e: PendingEntry, base: string) {
  const step = e.step as number;
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
    emailAlternativo: e.emailAlt,
    profesor: e.token.teacher_name,
    faltante: e.sequence,
    texto: e.variant,
    envio: stepLabel(step),
    diasDesdeElEnlace: e.days,
    enviosPrevios: e.count,
    asunto: subject,
    enlace,
  };
}

/** Los 6 correos de ejemplo a una dirección. No toca la base. */
async function enviarPrueba(to: string, base: string): Promise<Response> {
  const ejemplo = {
    studentName: 'Ana García',
    teacherName: 'Sebastián',
    url: `${base}/test/00000000-0000-0000-0000-000000000000`,
  };
  const muestras: Array<{ sequence: 'formulario' | 'test'; variant: 'estandar' | 'veterano'; step: number; nombre: string }> = [
    { sequence: 'formulario', variant: 'estandar', step: 1,  nombre: 'día 1 (formulario + prueba)' },
    { sequence: 'formulario', variant: 'estandar', step: 2,  nombre: 'día 2' },
    { sequence: 'test',       variant: 'estandar', step: 3,  nombre: 'día 3 (solo prueba)' },
    { sequence: 'test',       variant: 'estandar', step: 4,  nombre: 'día 6 · te estamos esperando' },
    { sequence: 'test',       variant: 'estandar', step: 6,  nombre: 'día 16 · semanal' },
    { sequence: 'formulario', variant: 'veterano', step: 1,  nombre: 'día 1 · veterano' },
  ];
  const enviados: string[] = [];
  for (const m of muestras) {
    const r = await sendFollowupEmail(m.sequence, m.step, ejemplo, to, m.variant);
    if (r.ok) enviados.push(`${m.nombre} (${stepLabel(m.step)})`);
    await sleep(PAUSA_MS);
  }
  return Response.json({ ok: true, test: true, to, enviados });
}
