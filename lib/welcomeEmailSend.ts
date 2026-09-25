// Envío del email de bienvenida al alumno. SOLO SERVIDOR (service role + Resend).
//
// Lo usa la ruta POST /api/assignments/[assignmentId]/welcome-email, con todas
// las barreras (interruptor, ventana, reclamo atómico, vista del LMS).
//
// EL EMAIL DEL ALUMNO ES EL DEL LMS. vista_perfil_alumno expone
// lower(trim(students.email)) y el LMS busca al alumno por ese email para
// mandarle el enlace de acceso. Así que:
//   · destinatario principal = normEmail(students.email), SIN respaldo: si no
//     hay, el alumno no podría entrar y no se envía;
//   · en copia, assignments.student_email si existe y es distinto (a veces es
//     el de un padre o una madre);
//   · antes de enviar se comprueba que el alumno aparece en la vista con ese
//     email (solo aparece con una asignación activa vinculada por student_id).
//
// ANTI-DUPLICADO. welcome_email_teacher guarda el profesor para el que se envió.
// El reclamo es un UPDATE condicionado ("solo si welcome_email_teacher es null o
// es otro profesor, y la fila está en la ventana"): si dos llamadas se cruzan,
// solo una afecta a la fila. Un cambio de profesor vuelve a habilitar el envío
// porque cambia el profesor. Si Resend falla, la fila vuelve a como estaba.

import type { SupabaseClient } from '@supabase/supabase-js';
import { resend, hasResendKey } from '@/lib/resend';
import { normEmail } from '@/lib/email';
import { FROM, REPLY_TO } from '@/lib/studentFollowupEmails';
import { lmsAccesoUrl } from '@/lib/lmsUrl';
import { buildWelcomeEmail } from '@/lib/welcomeEmailCopy';
import {
  WELCOME_EMAIL_ENABLED, WELCOME_MAX_AGE_HOURS, welcomeStartEpoch, isInWelcomeWindow,
  pickWelcomeVariant, firstClassFromSlots,
  type WelcomeReason, type WelcomeVariant,
} from '@/lib/welcomeEmail';
import { createFormToken, findLatestFormToken, formTokenState, hasCompletedFormToken } from '@/lib/formTokenServer';
import { getOrCreateTestSession } from '@/lib/levelTest/createSession';

// ── Datos ────────────────────────────────────────────────────────────────────

export interface AssignmentForWelcome {
  id: string;
  teacher_id: string;
  teacher_name: string;
  student_id: string | null;
  student_name: string;
  student_email: string | null;
  student_level: string | null;
  plan: string | null;
  slots: Array<{ day: string; hour: string }> | null;
  start_date: string | null;
  created_at: string;
  status: string | null;
  welcome_email_sent_at: string | null;
  welcome_email_teacher: string | null;
  welcome_email_to: string | null;
}

const ASSIGNMENT_COLS =
  'id, teacher_id, teacher_name, student_id, student_name, student_email, student_level, plan, slots, start_date, created_at, status, welcome_email_sent_at, welcome_email_teacher, welcome_email_to';

export async function loadAssignmentForWelcome(admin: SupabaseClient, id: string): Promise<AssignmentForWelcome | null> {
  const { data, error } = await admin.from('assignments').select(ASSIGNMENT_COLS).eq('id', id).maybeSingle();
  if (error) throw new Error(`No se pudo leer la asignación: ${error.message}`);
  return (data as AssignmentForWelcome | null) ?? null;
}

/** students.email del alumno vinculado, normalizado ('' si no hay alumno o email). */
async function studentEmailOf(admin: SupabaseClient, studentId: string | null): Promise<string> {
  if (!studentId) return '';
  const { data } = await admin.from('students').select('email').eq('id', studentId).maybeSingle();
  return normEmail((data as { email?: string | null } | null)?.email);
}

/** Destinatario (el email del LMS) y copia (el de la asignación si es otro). */
export async function resolveWelcomeRecipients(admin: SupabaseClient, a: AssignmentForWelcome): Promise<{ to: string; cc: string | null }> {
  const to = await studentEmailOf(admin, a.student_id);
  const asgEmail = normEmail(a.student_email);
  return { to, cc: asgEmail && asgEmail !== to ? asgEmail : null };
}

/** ¿El alumno aparece en vista_perfil_alumno con ese email? Es lo que mira el LMS al dar acceso. */
export async function isInLmsView(admin: SupabaseClient, studentId: string | null, email: string): Promise<boolean> {
  if (!studentId || !email) return false;
  const { data, error } = await admin.from('vista_perfil_alumno')
    .select('alumno_id').eq('alumno_id', studentId).eq('email', email).limit(1);
  if (error) {
    console.error('[bienvenida] No se pudo consultar vista_perfil_alumno:', error.message);
    return false;
  }
  return Boolean(data?.length);
}

export async function decideWelcomeVariant(
  admin: SupabaseClient, a: AssignmentForWelcome, reason: WelcomeReason,
): Promise<WelcomeVariant> {
  let hasPreviousAssignmentWithOtherTeacher = false;
  if (a.student_id) {
    const { data } = await admin.from('assignments').select('id')
      .eq('student_id', a.student_id).neq('id', a.id).neq('teacher_id', a.teacher_id).limit(1);
    hasPreviousAssignmentWithOtherTeacher = Boolean(data?.length);
  }
  const { data: logs } = await admin.from('class_join_logs').select('id')
    .ilike('student_name', a.student_name.trim()).limit(1);
  return pickWelcomeVariant({
    reason,
    hasPreviousClasses: Boolean(logs?.length),
    hasPreviousAssignmentWithOtherTeacher,
  });
}

async function levelTestDone(admin: SupabaseClient, a: AssignmentForWelcome): Promise<boolean> {
  if (a.student_id) {
    const { data } = await admin.from('level_test_sessions').select('id')
      .eq('student_id', a.student_id).eq('status', 'completed').limit(1);
    if (data?.length) return true;
  }
  const name = a.student_name.trim();
  const { data } = await admin.from('level_test_sessions').select('id')
    .or(`student_name.ilike."${name.replace(/"/g, '')}",candidate_name.ilike."${name.replace(/"/g, '')}"`)
    .eq('status', 'completed').limit(1);
  return Boolean(data?.length);
}

/**
 * Qué le falta de la prueba de nivel y con qué enlace. Reutiliza el token
 * vigente del formulario o crea uno (lib/formTokenServer, el mismo INSERT que
 * /api/forms/generate-token); si solo falta la prueba, prepara la sesión como
 * los follow-ups.
 */
export async function resolvePending(
  admin: SupabaseClient, a: AssignmentForWelcome, base: string, lmsEmail: string,
): Promise<{ kind: 'formulario' | 'prueba'; url: string } | null> {
  const student = { id: a.student_id, name: a.student_name };
  const [formDone, testDone] = await Promise.all([
    hasCompletedFormToken(admin, student),
    levelTestDone(admin, a),
  ]);
  if (formDone && testDone) return null;

  if (!formDone) {
    const latest = await findLatestFormToken(admin, student);
    if (latest && formTokenState(latest) === 'pending') {
      return { kind: 'formulario', url: `${base}/formulario/${latest.token}` };
    }
    const created = await createFormToken(admin, {
      studentId: a.student_id, studentName: a.student_name, studentEmail: lmsEmail || a.student_email,
      teacherId: a.teacher_id, teacherName: a.teacher_name, assignmentId: a.id,
      plan: a.plan, level: a.student_level,
    });
    if (!created.ok) throw new Error(`No se pudo crear el enlace del formulario: ${created.error}`);
    return { kind: 'formulario', url: `${base}/formulario/${created.token}` };
  }

  // Formulario hecho, falta la prueba.
  const { token, error } = await getOrCreateTestSession({
    studentId: a.student_id || undefined, studentName: a.student_name,
    studentEmail: lmsEmail || undefined, candidateEmail: lmsEmail || undefined,
    teacherId: a.teacher_id, teacherName: a.teacher_name, assignmentId: a.id,
    plan: a.plan || undefined, level: a.student_level || undefined,
  });
  if (!token) throw new Error(`No se pudo preparar la prueba de nivel: ${error ?? 'sin token'}`);
  return { kind: 'prueba', url: `${base}/test/${token}` };
}

// ── Campanita del admin ──────────────────────────────────────────────────────

/** Aviso al admin con id fijo: si ya existe, no se duplica. */
async function notifyAdminOnce(admin: SupabaseClient, id: string, body: string): Promise<void> {
  const { error } = await admin.from('notifications').upsert({
    id,
    target_user: null,
    target_role: 'admin',
    title:       '⚠️ Bienvenida sin enviar',
    body,
    type:        'welcome_email_failed',
    read_by:     [],
    created_at:  new Date().toISOString(),
    created_by:  'sistema',
  }, { onConflict: 'id', ignoreDuplicates: true });
  if (error) console.error('[bienvenida] No se pudo crear el aviso al admin:', error.message);
}

// ── Envío ────────────────────────────────────────────────────────────────────

async function sendViaResend(args: {
  to: string; cc: string | null; subject: string; html: string; label: string;
}): Promise<{ ok: true; id: string | null } | { ok: false; error: string }> {
  if (!hasResendKey()) return { ok: false, error: 'Falta RESEND_API_KEY' };
  try {
    const { data, error } = await resend.emails.send({
      from: FROM, to: args.to, cc: args.cc ? [args.cc] : undefined,
      replyTo: REPLY_TO, subject: args.subject, html: args.html,
    });
    if (error) {
      console.error(`[EMAIL] ${args.label}: Resend devolvió error:`, { name: error.name, message: error.message, to: args.to });
      return { ok: false, error: error.message };
    }
    console.log(`[EMAIL] ${args.label} enviado:`, { id: data?.id, to: args.to, cc: args.cc });
    return { ok: true, id: data?.id ?? null };
  } catch (err) {
    console.error(`[EMAIL] ${args.label}: excepción al enviar:`, err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type WelcomeResult =
  | { sent: true; variant: WelcomeVariant; to: string; cc: string | null; resendId: string | null }
  | { skipped: 'disabled' | 'fuera_de_ventana' | 'ya_enviado' | 'sin_email' | 'fuera_de_la_vista' | 'no_existe' }
  | { error: string };

/** El envío real, con todas las barreras. */
export async function sendWelcomeForAssignment(
  admin: SupabaseClient, assignmentId: string, reason: WelcomeReason, base: string,
): Promise<WelcomeResult> {
  if (!WELCOME_EMAIL_ENABLED) return { skipped: 'disabled' };

  const a = await loadAssignmentForWelcome(admin, assignmentId);
  if (!a) return { skipped: 'no_existe' };
  if (!isInWelcomeWindow(a.created_at)) return { skipped: 'fuera_de_ventana' };
  if (a.welcome_email_teacher === a.teacher_id) return { skipped: 'ya_enviado' };

  const { to, cc } = await resolveWelcomeRecipients(admin, a);
  if (!to) {
    // Sin email en la ficha el alumno no podría entrar al LMS: no se envía.
    // Si la asignación no está vinculada a un alumno, el problema es el vínculo.
    if (!a.student_id) {
      await notifyAdminOnce(admin, `welcome_noview_${a.id}`,
        `No se pudo enviar la bienvenida a ${a.student_name}: no aparece en la plataforma de alumnos (revisa el vínculo alumno–asignación).`);
      return { skipped: 'fuera_de_la_vista' };
    }
    await notifyAdminOnce(admin, `welcome_noemail_${a.id}`,
      `No se pudo enviar la bienvenida a ${a.student_name}: no tiene email en su ficha (students.email). Cárgalo para que pueda entrar a la plataforma.`);
    return { skipped: 'sin_email' };
  }

  // Reclamo atómico. Mismas condiciones de ventana que arriba, pero dentro del
  // UPDATE: lo que decide es la base, no lo que se leyó hace un momento.
  const nowIso = new Date().toISOString();
  const minCreated = new Date(Math.max(welcomeStartEpoch(), Date.now() - WELCOME_MAX_AGE_HOURS * 3_600_000)).toISOString();
  const teacher = a.teacher_id.replace(/"/g, '');
  const { data: claimed, error: claimErr } = await admin.from('assignments')
    .update({ welcome_email_sent_at: nowIso, welcome_email_teacher: a.teacher_id, welcome_email_to: to })
    .eq('id', a.id)
    .eq('teacher_id', a.teacher_id)
    .gte('created_at', minCreated)
    .or(`welcome_email_teacher.is.null,welcome_email_teacher.neq."${teacher}"`)
    .select('id');
  if (claimErr) return { error: `No se pudo reclamar el envío: ${claimErr.message}` };
  if (!claimed?.length) return { skipped: 'ya_enviado' };

  // Deshace SOLO nuestro reclamo (si otro proceso escribió después, no se toca).
  const release = async (motivo: string) => {
    const { error } = await admin.from('assignments')
      .update({
        welcome_email_sent_at: a.welcome_email_sent_at,
        welcome_email_teacher: a.welcome_email_teacher,
        welcome_email_to:      a.welcome_email_to,
      })
      .eq('id', a.id).eq('welcome_email_sent_at', nowIso).eq('welcome_email_teacher', a.teacher_id);
    if (error) console.error(`[bienvenida] ${a.id}: no se pudo deshacer el reclamo (${motivo}):`, error.message);
    else console.warn(`[bienvenida] ${a.id}: reclamo deshecho (${motivo}).`);
  };

  if (!(await isInLmsView(admin, a.student_id, to))) {
    await release('no aparece en vista_perfil_alumno');
    await notifyAdminOnce(admin, `welcome_noview_${a.id}`,
      `No se pudo enviar la bienvenida a ${a.student_name}: no aparece en la plataforma de alumnos (revisa el vínculo alumno–asignación).`);
    return { skipped: 'fuera_de_la_vista' };
  }

  try {
    const variant = await decideWelcomeVariant(admin, a, reason);
    const pending = await resolvePending(admin, a, base, to);
    const { subject, html } = buildWelcomeEmail({
      variant, studentName: a.student_name, teacherName: a.teacher_name,
      lmsEmail: to, lmsUrl: lmsAccesoUrl(), pending,
      firstClass: firstClassFromSlots(a.slots, a.start_date),
    });
    const res = await sendViaResend({ to, cc, subject, html, label: `bienvenida_${variant}_${a.id}` });
    if (!res.ok) {
      await release(`Resend: ${res.error}`);
      return { error: `No se pudo enviar: ${res.error}` };
    }
    return { sent: true, variant, to, cc, resendId: res.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[bienvenida] ${a.id}: error preparando el email:`, err);
    await release(msg);
    return { error: msg };
  }
}
