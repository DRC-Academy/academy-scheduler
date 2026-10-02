// Rescate de la bienvenida. SOLO SERVIDOR.
//
// POR QUÉ EXISTE — la bienvenida se dispara desde el NAVEGADOR (addAssignment en
// lib/TeachersContext). Entre el 28/09 y el 01/10/2026 once altas se quedaron sin
// ella porque las hizo un dispositivo con una versión de la app anterior al
// 25/09, que no tenía esa llamada: el envío ni se intentó y no quedó rastro. Este
// rescate busca en la BASE las altas recientes sin bienvenida y se la manda, así
// que ya no depende de qué código corra en el teléfono de quien da el alta.
//
// QUÉ CUENTA COMO "ALUMNO REALMENTE NUEVO" — la bienvenida es para alguien que
// acaba de llegar. Cualquier otra cosa (un alumno que ya existía, que cambia de
// profesor o al que una sincronización le reconstruye la asignación) NO debe
// recibirla desde aquí. Los criterios, todos obligatorios:
//
//   1. Asignación creada hace entre GRACIA_MIN minutos y 72 h (la misma ventana
//      que la ruta). Los minutos de gracia dejan que el navegador la envíe
//      primero; si se cruzaran, el reclamo atómico impide el duplicado.
//   2. welcome_email_sent_at y welcome_email_teacher vacíos: nunca se le envió.
//   3. Activa y con student_id (sin vínculo no estaría en la vista del LMS).
//   4. ALTA CONJUNTA: la ficha del alumno (students.created_at) se creó como
//      mucho MAX_SEPARACION_MIN minutos antes que la asignación. Es el criterio
//      que separa una alta de todo lo demás:
//        · el setter y el profesor crean la ficha y la asignación en la misma
//          acción, con milisegundos de diferencia;
//        · dbSyncAllCalendarsToAssignments SOLO crea asignaciones para alumnos
//          que ya estaban en students (los que no, van a pendingManual), así que
//          su ficha es anterior;
//        · un cambio de profesor reapunta la asignación existente: su created_at
//          es el original y cae fuera del criterio 1;
//        · un "Mover" o una reasignación crea otra asignación para una ficha que
//          ya existía.
//      Es fiable porque students.created_at lo pone la base (default now()) y
//      ningún flujo lo reescribe: ni dbUpsertStudent ni dbUpdateStudent lo tocan.
//   5. Ninguna OTRA asignación de ese alumno (ni activa ni inactiva).
//   6. Ninguna clase previa (class_records ni class_join_logs, por nombre: esas
//      tablas no tienen student_id) y sin baja ni backup de borrado anterior.
//   7. No es un profesor de prueba (lib/externalTeachers).
//
// El orden importa poco: cualquier criterio que falle descarta la fila, y el
// motivo queda en `excluded` para que el ensayo lo muestre.

import type { SupabaseClient } from '@supabase/supabase-js';
import { WELCOME_MAX_AGE_HOURS, welcomeStartEpoch } from '@/lib/welcomeEmail';
import { esProfesorDePrueba } from '@/lib/externalTeachers';
import { normEmail } from '@/lib/email';

/** Minutos que se le dejan al navegador antes de rescatar. */
export const GRACIA_MIN = 10;
/** Separación máxima entre la ficha y la asignación para considerarlas una sola alta. */
export const MAX_SEPARACION_MIN = 10;

export interface RescueAssignment {
  id: string;
  teacher_id: string;
  teacher_name: string;
  student_id: string | null;
  student_name: string;
  status: string | null;
  created_at: string;
  welcome_email_sent_at: string | null;
  welcome_email_teacher: string | null;
}

export interface RescueContext {
  /** students.created_at y email por id. */
  students: Map<string, { created_at: string; email: string | null }>;
  /** Cuántas asignaciones tiene cada student_id (incluida la propia). */
  assignmentsPerStudent: Map<string, number>;
  /** Nombres normalizados con alguna clase registrada o entrada a clase. */
  namesWithClasses: Set<string>;
  /** student_id con una baja o un backup de borrado anterior. */
  idsWithHistory: Set<string>;
  /** Emails normalizados con un backup de borrado anterior. */
  emailsWithHistory: Set<string>;
}

export type RescueVerdict = { ok: true } | { ok: false; reason: string };

const normName = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Decide si una asignación es una alta nueva a la que rescatar. Pura: no lee la base. */
export function classifyForRescue(a: RescueAssignment, ctx: RescueContext, now: number = Date.now()): RescueVerdict {
  const created = new Date(a.created_at).getTime();
  const desde = Math.max(welcomeStartEpoch(), now - WELCOME_MAX_AGE_HOURS * 3_600_000);
  if (!(created >= desde)) return { ok: false, reason: 'fuera de la ventana de 72 h' };
  if (created > now - GRACIA_MIN * 60_000) return { ok: false, reason: `creada hace menos de ${GRACIA_MIN} min (espera al navegador)` };
  // Un envío posterior a `now` solo existe al simular una corrida pasada: en esa
  // corrida todavía no se había enviado.
  const enviadaAntes = a.welcome_email_sent_at ? new Date(a.welcome_email_sent_at).getTime() <= now : Boolean(a.welcome_email_teacher);
  if (enviadaAntes) return { ok: false, reason: 'ya enviada' };
  if (a.status !== 'active') return { ok: false, reason: `asignación ${a.status ?? 'sin estado'}` };
  if (!a.student_id) return { ok: false, reason: 'sin student_id' };
  if (esProfesorDePrueba(a.teacher_id)) return { ok: false, reason: 'profesor de prueba' };

  const st = ctx.students.get(a.student_id);
  if (!st) return { ok: false, reason: 'la ficha del alumno no existe' };
  const separacion = created - new Date(st.created_at).getTime();
  if (separacion > MAX_SEPARACION_MIN * 60_000) return { ok: false, reason: 'alumno que ya existía (ficha anterior a la asignación)' };
  if (separacion < -MAX_SEPARACION_MIN * 60_000) return { ok: false, reason: 'ficha posterior a la asignación (flujo raro)' };

  if ((ctx.assignmentsPerStudent.get(a.student_id) ?? 0) > 1) return { ok: false, reason: 'tiene otras asignaciones' };
  if (ctx.namesWithClasses.has(normName(a.student_name))) return { ok: false, reason: 'ya tuvo clases' };
  if (ctx.idsWithHistory.has(a.student_id)) return { ok: false, reason: 'tiene una baja o un borrado anterior' };
  const email = normEmail(st.email);
  if (email && ctx.emailsWithHistory.has(email)) return { ok: false, reason: 'su email tiene un borrado anterior' };
  return { ok: true };
}

export interface RescueScan {
  candidates: RescueAssignment[];
  excluded: Array<{ a: RescueAssignment; reason: string }>;
}

/** Lee la base y clasifica las asignaciones de la ventana. No escribe nada. */
export async function scanWelcomeRescue(admin: SupabaseClient, now: number = Date.now()): Promise<RescueScan> {
  const desde = new Date(Math.max(welcomeStartEpoch(), now - WELCOME_MAX_AGE_HOURS * 3_600_000)).toISOString();
  const { data: recientes, error } = await admin.from('assignments')
    .select('id, teacher_id, teacher_name, student_id, student_name, status, created_at, welcome_email_sent_at, welcome_email_teacher')
    .gte('created_at', desde).lte('created_at', new Date(now).toISOString()).order('created_at');
  if (error) throw new Error(`No se pudieron leer las asignaciones: ${error.message}`);
  const rows = (recientes ?? []) as RescueAssignment[];
  if (rows.length === 0) return { candidates: [], excluded: [] };

  const ids = [...new Set(rows.map(r => r.student_id).filter((x): x is string => Boolean(x)))];
  const names = [...new Set(rows.map(r => r.student_name.trim()).filter(Boolean))];

  const [stu, asg, recs, joins, drops, baks] = await Promise.all([
    admin.from('students').select('id, created_at, email').in('id', ids),
    admin.from('assignments').select('student_id').in('student_id', ids),
    admin.from('class_records').select('student_name').in('student_name', names),
    admin.from('class_join_logs').select('student_name').in('student_name', names),
    admin.from('student_dropouts').select('student_id').in('student_id', ids),
    admin.from('deleted_students_backup').select('original_student_id, student_email'),
  ]);
  for (const r of [stu, asg, recs, joins, drops, baks]) {
    if (r.error) throw new Error(`No se pudo leer el contexto del rescate: ${r.error.message}`);
  }

  const ctx: RescueContext = {
    students: new Map((stu.data ?? []).map(s => [s.id as string, { created_at: s.created_at as string, email: s.email as string | null }])),
    assignmentsPerStudent: new Map(),
    namesWithClasses: new Set([...(recs.data ?? []), ...(joins.data ?? [])].map(r => normName(String(r.student_name ?? '')))),
    idsWithHistory: new Set([
      ...(drops.data ?? []).map(d => String(d.student_id)),
      ...(baks.data ?? []).map(b => String(b.original_student_id)),
    ]),
    emailsWithHistory: new Set((baks.data ?? []).map(b => normEmail(b.student_email as string | null)).filter(Boolean)),
  };
  for (const r of asg.data ?? []) {
    const k = String(r.student_id);
    ctx.assignmentsPerStudent.set(k, (ctx.assignmentsPerStudent.get(k) ?? 0) + 1);
  }

  const out: RescueScan = { candidates: [], excluded: [] };
  for (const a of rows) {
    const v = classifyForRescue(a, ctx, now);
    if (v.ok) out.candidates.push(a);
    else out.excluded.push({ a, reason: v.reason });
  }
  return out;
}
