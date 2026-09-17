// Follow-up del formulario inicial + prueba de nivel: QUIÉN está pendiente y QUÉ
// envío le toca hoy.
//
// Todo lo que hay acá son funciones puras sobre filas ya leídas. Las usan los dos
// lados por igual: el cron (app/api/cron/followups-nivel) para decidir a quién
// escribe, y el panel admin para mostrar los mismos números. Si el criterio
// cambia, cambia en un solo sitio y las dos vistas se mueven juntas.
//
// ── UN SOLO RELOJ, DOS ESTADOS ───────────────────────────────────────────────
// El alumno recibe UN enlace, el del formulario; la prueba de nivel se le ofrece
// al terminarlo (ver app/api/forms/submit). Desde septiembre de 2026 el reloj es
// ÚNICO: el día 0 es form_tokens.created_at del enlace vigente, y la secuencia
// sigue hasta que COMPLETA LA PRUEBA, haya hecho el formulario o no. Lo que sí
// cambia por el camino es el TEXTO, que depende de qué le falta:
//
//   · 'formulario' → su último form_token sigue 'pending' (le falta el
//     formulario y la prueba).
//   · 'test'       → completó el formulario pero no tiene ninguna sesión de test
//     terminada (solo le falta la prueba).
//
// (Antes eran dos secuencias con reloj propio, de 3 envíos cada una. El
// contador de cada una sigue en form_tokens como espejo, pero ya no decide.)
//
// Hay además alumnos vivos que NO tienen ningún enlace vigente y por tanto no
// pueden estar en ninguna secuencia: los que nunca recibieron uno (son
// anteriores al 10/07/2026, cuando se estrenó el formulario) y aquellos a los
// que el enlace les caducó sin abrirlo. Para esos, `studentsNeedingToken`
// devuelve a quién hay que generarle uno; el cron lo crea y a partir de ahí
// entran por la puerta normal.
//
// Por qué created_at del token y no la fecha de alta del alumno: el enlace lo
// genera el profesor cuando le manda el email de presentación, y entre el alta y
// ese email hay una mediana de 12 días (máximo medido: 53). Contar desde el alta
// haría nacer a casi todos "pasados de plazo" el primer día.
//
// ── LA CADENCIA (FOLLOWUP_DAYS) ──────────────────────────────────────────────
// Días 1, 2 y 3 (un correo por día) · 6 y 9 (cada tres días) · 16, 23, 30, 37,
// 44, 51, 58 y 65 (semanal). Trece envíos y se acabó. Se corta antes si completa
// la prueba, si se da de baja, si se elimina al alumno o si el equipo marca
// "No enviar más" (students.followup_opt_out).
//
// Los días se cuentan por FECHA DE CALENDARIO en hora de España, no por bloques
// de 24 h: el cron corre a las 10:00 y un correo del día 1 a las 10:05 no puede
// hacer que el del día 2 se retrase al día 3 por cinco minutos.
//
// Para un alumno que ya llevaba semanas esperando cuando se encendió esto, la
// secuencia NO se da por quemada: empieza por el primer correo y respeta el
// mismo espaciado entre envíos (1, 1, 3, 3, 7, 7…) contado desde el anterior.
// Recibe la misma serie, solo que desplazada.
//
// El REGISTRO de cada envío es la tabla level_test_followups (una fila por
// alumno y número de envío, con índice único): ahí se cuenta cuántos lleva y
// cuándo fue el último, y es lo que hace idempotente al cron.

import { getSpainParts } from '@/lib/spainTime';
import { resolveStudentEmails } from '@/lib/email';

// ── Tipos de fila (solo lo que se lee de cada tabla) ─────────────────────────
export interface FormTokenRow {
  id: string;
  token: string;
  student_id: string | null;
  student_name: string;
  student_email: string | null;
  teacher_id: string | null;
  teacher_name: string | null;
  assignment_id: string | null;
  plan: string | null;
  level: string | null;
  status: string | null;
  created_at: string;
  completed_at: string | null;
  expires_at: string | null;
  form_reminder_count: number | null;
  form_reminder_last_sent: string | null;
  test_reminder_count: number | null;
  test_reminder_last_sent: string | null;
  /** null = enlace del profesor · 'veterano' | 'reactivado' = lo creó el follow-up. */
  reminder_variant: string | null;
}

export interface StudentRow {
  id: string;
  name: string;
  email: string | null;
  /** "No enviar más" marcado por el equipo (students.followup_opt_out). */
  followup_opt_out?: boolean | null;
}

/** Un envío registrado en level_test_followups. */
export interface FollowupRow {
  student_id: string;
  numero_envio: number;
  sent_at: string;
  status?: string | null;
}

export interface TestSessionRow {
  student_id: string | null;
  student_name: string | null;
  candidate_name: string | null;
  status: string | null;
}

export interface DropoutRow {
  student_id: string | null;
  student_name: string | null;
}

export interface AssignmentRow {
  student_id: string | null;
  student_name: string | null;
  teacher_id: string | null;
  teacher_name: string | null;
  id?: string | null;
  plan?: string | null;
  student_level?: string | null;
  /** Para el email alternativo del follow-up (ver lib/email). */
  student_email?: string | null;
}

export type Sequence = 'formulario' | 'test';

/**
 * Qué texto le toca. 'veterano' es para el alumno que lleva semanas de clase y
 * nunca recibió el formulario: escribirle "hemos visto que empezaste tu
 * registro" sonaría a que no sabemos quién es.
 */
export type CopyVariant = 'estandar' | 'veterano';

export function variantOf(token: Pick<FormTokenRow, 'reminder_variant'>): CopyVariant {
  return token.reminder_variant === 'veterano' ? 'veterano' : 'estandar';
}

/**
 * Los enlaces que crea el propio follow-up el alumno no los ha visto nunca, así
 * que su primer correo sale en la misma corrida: ese email ES la entrega del
 * enlace, no el recordatorio de algo que ya tenía.
 */
export function primerAvisoInmediato(token: Pick<FormTokenRow, 'reminder_variant'>): boolean {
  return token.reminder_variant === 'veterano' || token.reminder_variant === 'reactivado';
}

/** Un alumno pendiente, con el envío que le toca hoy (o null si todavía no). */
export interface PendingEntry {
  /** Qué le falta: formulario + prueba, o solo la prueba. Decide el texto. */
  sequence: Sequence;
  variant: CopyVariant;
  token: FormTokenRow;
  student: StudentRow;
  /** A dónde se escribe (students.email normalizado; ver lib/email). */
  email: string;
  /** assignments.student_email si es distinto del principal. Se registra, no se usa. */
  emailAlt: string | null;
  /** Día 0: created_at del enlace vigente (ISO). */
  baseDate: string;
  /** Días de calendario (hora de España) transcurridos desde baseDate. */
  days: number;
  /** Envíos ya hechos (level_test_followups). */
  count: number;
  lastSent: string | null;
  /** Número del envío que toca hoy (1..13); null si todavía no, o si ya se agotaron. */
  step: number | null;
  /** Por qué no le toca hoy (para el modo dry y el panel). */
  skipReason?: 'tope_alcanzado' | 'esperando_dias' | 'esperando_espaciado' | 'no_enviar';
}

// ── La cadencia ──────────────────────────────────────────────────────────────

/** Día (desde el día 0) en que sale cada envío. El índice + 1 es el número de envío. */
export const FOLLOWUP_DAYS: readonly number[] = [1, 2, 3, 6, 9, 16, 23, 30, 37, 44, 51, 58, 65];
/** Tope de envíos automáticos. */
export const MAX_FOLLOWUPS = FOLLOWUP_DAYS.length;
/** Alias del nombre anterior, por los sitios que todavía lo importan. */
export const MAX_REMINDERS = MAX_FOLLOWUPS;

/** Etapa del texto: recordatorio amable (días 1-3), "te estamos esperando" (6-9), semanal (16+). */
export type Etapa = 'recordatorio' | 'espera' | 'semanal';

export function etapaDe(step: number): Etapa {
  if (step <= 3) return 'recordatorio';
  if (step <= 5) return 'espera';
  return 'semanal';
}

/** Día de la cadencia de un envío (65 a partir del 13º, si se manda a mano). */
export function diaRelativoDe(step: number): number {
  return FOLLOWUP_DAYS[Math.min(Math.max(1, step), MAX_FOLLOWUPS) - 1];
}

/** "4º envío". */
export function stepLabel(step: number): string {
  return `${step}º envío`;
}

/**
 * `minDays`   → días mínimos desde la fecha base para mandar este recordatorio.
 * `minGapDays`→ días mínimos desde el recordatorio anterior. Es lo que evita que
 *               un alumno rezagado reciba los tres seguidos: aunque lleve 25
 *               días esperando, el 2º no sale hasta 3 días después del 1º.
 */
/** Etiqueta por número de envío. Fuera del tope sigue diciendo "14º envío". */
export const STEP_LABEL: Record<number, string> = new Proxy({} as Record<number, string>, {
  get: (_t, k) => stepLabel(Number(k)),
});

// ── Utilidades ───────────────────────────────────────────────────────────────
export const norm = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

/** Días enteros (bloques de 24 h) entre dos instantes. Devuelve -1 si la fecha no es válida. */
export function daysSince(iso: string | null | undefined, now: number): number {
  if (!iso) return -1;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return -1;
  return Math.floor((now - t) / 86_400_000);
}

/**
 * Días de CALENDARIO en hora de España entre un instante y ahora (0 = mismo
 * día). Es la cuenta de la cadencia: "día 1" es el día siguiente al del
 * enlace, salga el cron a la hora que salga. -1 si la fecha no es válida.
 */
export function calendarDaysSince(iso: string | null | undefined, now: number): number {
  if (!iso) return -1;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return -1;
  const a = getSpainParts(new Date(t)).dateStr;
  const b = getSpainParts(new Date(now)).dateStr;
  return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86_400_000);
}

/** Clave con la que se agrupa a un alumno: id si lo hay, si no el nombre. */
export function studentKeyOf(row: { student_id?: string | null; student_name?: string | null }): string {
  return row.student_id?.trim() || `n:${norm(row.student_name)}`;
}

export type TokenState = 'pending' | 'completed' | 'expired';

export function tokenStateOf(t: FormTokenRow, now: number): TokenState {
  if (t.status === 'completed') return 'completed';
  const caducado = t.expires_at ? new Date(t.expires_at).getTime() < now : false;
  if (t.status === 'expired' || caducado) return 'expired';
  return 'pending';
}

/**
 * El token MÁS RECIENTE de cada alumno. Hay alumnos con varios (el profesor
 * regeneró el enlace), y solo el último cuenta: el viejo ya no abre.
 */
export function latestTokenPerStudent(tokens: FormTokenRow[]): Map<string, FormTokenRow> {
  const out = new Map<string, FormTokenRow>();
  const orden = [...tokens].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  for (const t of orden) {
    const k = studentKeyOf(t);
    if (!out.has(k)) out.set(k, t);
  }
  return out;
}

// ── El cálculo del paso ──────────────────────────────────────────────────────
/**
 * Qué envío toca hoy. Devuelve el número o el motivo por el que no toca.
 *
 * El siguiente es siempre `count + 1`: nunca se saltan pasos, ni siquiera para
 * un alumno que lleva 30 días esperando. Así el primero que recibe es siempre
 * el amable, no el de urgencia. Dos condiciones, las dos en días de calendario
 * (hora de España):
 *   · han pasado al menos FOLLOWUP_DAYS[count] días desde el día 0;
 *   · desde el envío anterior ha pasado al menos el hueco que la cadencia deja
 *     entre ese envío y éste (1, 1, 3, 3, 7…). Es lo que reparte la serie a un
 *     alumno rezagado en vez de mandarle trece correos en trece días seguidos.
 */
export function nextReminderStep(args: {
  count: number;
  lastSent: string | null;
  baseDate: string;
  now: number;
  /** El enlace lo creó el follow-up: el primer correo sale ya, sin esperar al día 1. */
  primeroInmediato?: boolean;
  /** "No enviar más" del equipo. */
  optOut?: boolean | null;
}): { step: number | null; days: number; skipReason?: PendingEntry['skipReason'] } {
  const days = calendarDaysSince(args.baseDate, args.now);
  const count = Math.max(0, args.count ?? 0);

  if (args.optOut) return { step: null, days, skipReason: 'no_enviar' };
  if (count >= MAX_FOLLOWUPS) return { step: null, days, skipReason: 'tope_alcanzado' };

  const minDays = count === 0 && args.primeroInmediato ? 0 : FOLLOWUP_DAYS[count];
  if (days < minDays) return { step: null, days, skipReason: 'esperando_dias' };

  if (count > 0) {
    const gap = calendarDaysSince(args.lastSent, args.now);
    // Sin fecha del último envío (dato viejo o corrupto) se espera un día antes
    // de seguir, en vez de disparar el siguiente de inmediato.
    const minGap = Math.max(1, FOLLOWUP_DAYS[count] - FOLLOWUP_DAYS[count - 1]);
    if (gap < minGap) return { step: null, days, skipReason: 'esperando_espaciado' };
  }

  return { step: count + 1, days };
}

// ── Quién está pendiente ─────────────────────────────────────────────────────
export interface BuildPendingInput {
  tokens: FormTokenRow[];
  students: StudentRow[];
  sessions: TestSessionRow[];
  dropouts: DropoutRow[];
  now: number;
  /**
   * Envíos registrados (level_test_followups). Si no viene —llamadores antiguos
   * o base sin la tabla— se cuenta con los contadores espejo de form_tokens.
   */
  followups?: FollowupRow[];
  /** Para el email alternativo (assignments.student_email). Opcional. */
  assignments?: Array<{ student_id?: string | null; student_name?: string | null; student_email?: string | null }>;
}

/**
 * La lista completa de alumnos pendientes, con el paso que le toca a cada uno.
 *
 * Quedan fuera, y es a propósito:
 *   · Los alumnos que ya no están en `students` o figuran en `student_dropouts`.
 *     Son bajas: perseguirlos por email es lo peor que podríamos hacer.
 *   · Los tokens caducados (el enlace ya no abre, mandarlo sería mandar un 404).
 *   · Los alumnos sin ninguna dirección de correo a la que escribir.
 */
export function buildPendingList(input: BuildPendingInput): PendingEntry[] {
  const { tokens, students, sessions, dropouts, now, followups, assignments } = input;

  // Envíos hechos por alumno (level_test_followups): cuántos y el último.
  const enviadosPor = new Map<string, { count: number; lastSent: string | null }>();
  for (const f of followups ?? []) {
    if (!f.student_id || f.status === 'failed') continue;
    const cur = enviadosPor.get(f.student_id) ?? { count: 0, lastSent: null };
    cur.count = Math.max(cur.count, f.numero_envio);
    if (!cur.lastSent || new Date(f.sent_at).getTime() > new Date(cur.lastSent).getTime()) cur.lastSent = f.sent_at;
    enviadosPor.set(f.student_id, cur);
  }
  const asgEmailById = new Map<string, string>();
  const asgEmailByName = new Map<string, string>();
  for (const a of assignments ?? []) {
    if (!a.student_email) continue;
    if (a.student_id && !asgEmailById.has(a.student_id)) asgEmailById.set(a.student_id, a.student_email);
    const n = norm(a.student_name);
    if (n && !asgEmailByName.has(n)) asgEmailByName.set(n, a.student_email);
  }

  const stById = new Map(students.map(s => [s.id, s]));
  const stByName = new Map(students.map(s => [norm(s.name), s]));
  const bajaIds = new Set(dropouts.map(d => d.student_id).filter(Boolean) as string[]);
  const bajaNames = new Set(dropouts.map(d => norm(d.student_name)).filter(Boolean));

  // Un alumno "ya hizo el test" si tiene CUALQUIER sesión completada, no solo la
  // última: si la repitió y la segunda quedó a medias, sigue estando hecho.
  const testHechoIds = new Set<string>();
  const testHechoNames = new Set<string>();
  for (const s of sessions) {
    if (s.status !== 'completed') continue;
    if (s.student_id) testHechoIds.add(s.student_id);
    const n = norm(s.student_name || s.candidate_name);
    if (n) testHechoNames.add(n);
  }

  // El último token completado de cada alumno. Hace falta para el caso raro en
  // que el profesor regeneró el enlace DESPUÉS de que el alumno rellenara el
  // formulario: el último token está caducado, pero el formulario está hecho y
  // lo que le falta es la prueba.
  const completadoPorAlumno = new Map<string, FormTokenRow>();
  for (const t of tokens) {
    if (t.status !== 'completed' || !t.completed_at) continue;
    const k = studentKeyOf(t);
    const previo = completadoPorAlumno.get(k);
    if (!previo || new Date(t.completed_at).getTime() > new Date(previo.completed_at!).getTime()) {
      completadoPorAlumno.set(k, t);
    }
  }

  const out: PendingEntry[] = [];

  for (const ultimo of latestTokenPerStudent(tokens).values()) {
    let token = ultimo;
    let estado = tokenStateOf(token, now);

    if (estado === 'expired') {
      // Caducado sin completar → no hay nada que perseguir hasta que se le
      // genere un enlace nuevo (de eso se encarga studentsNeedingToken).
      const completado = completadoPorAlumno.get(studentKeyOf(token));
      if (!completado) continue;
      token = completado;
      estado = 'completed';
    }

    const student =
      (token.student_id ? stById.get(token.student_id) : undefined) ??
      stByName.get(norm(token.student_name));
    if (!student) continue;                                   // ya no es alumno

    const esBaja =
      (token.student_id && bajaIds.has(token.student_id)) || bajaNames.has(norm(token.student_name));
    if (esBaja) continue;

    // A dónde se escribe: students.email manda; el de la assignment queda como
    // alternativo si es distinto (se registra con el envío). Ver lib/email.
    const { to: email, alt: emailAlt } = resolveStudentEmails({
      studentEmail: student.email,
      assignmentEmail: asgEmailById.get(student.id) ?? asgEmailByName.get(norm(student.name)) ?? null,
      tokenEmail: token.student_email,
    });
    if (!email) continue;

    // La secuencia termina cuando COMPLETA LA PRUEBA, haya hecho el formulario
    // o no (hay alumnos que la hacen por un enlace directo del admin).
    const hecho =
      (token.student_id && testHechoIds.has(token.student_id)) ||
      testHechoNames.has(norm(token.student_name)) ||
      testHechoNames.has(norm(student.name));
    if (hecho) continue;

    // Qué le falta (decide el texto). Un solo reloj para las dos situaciones.
    const sequence: Sequence = estado === 'pending' ? 'formulario' : 'test';
    const baseDate = token.created_at;

    // Envíos hechos: la tabla de registro manda; sin ella, los contadores espejo
    // del token (suma de las dos secuencias antiguas).
    const registrado = enviadosPor.get(student.id);
    const count = followups
      ? (registrado?.count ?? 0)
      : (token.form_reminder_count ?? 0) + (token.test_reminder_count ?? 0);
    const lastSent = followups
      ? (registrado?.lastSent ?? null)
      : [token.form_reminder_last_sent, token.test_reminder_last_sent].filter(Boolean).sort().pop() ?? null;

    const { step, days, skipReason } = nextReminderStep({
      count, lastSent, baseDate, now,
      // El enlace lo creó el propio follow-up: ese correo ES la entrega del
      // enlace y sale en la misma corrida, sin esperar al día 1.
      primeroInmediato: sequence === 'formulario' && primerAvisoInmediato(token),
      optOut: student.followup_opt_out,
    });
    out.push({
      sequence, variant: variantOf(token), token, student, email, emailAlt,
      baseDate, days, count, lastSent, step, skipReason,
    });
  }

  // Los que hoy reciben algo primero, y dentro de cada grupo el que lleva más
  // tiempo esperando: si una corrida se corta a la mitad, se atiende antes a
  // quien lleva más tiempo colgado.
  return out.sort((a, b) => {
    if (Boolean(a.step) !== Boolean(b.step)) return a.step ? -1 : 1;
    return b.days - a.days;
  });
}

// ── Alumnos sin ningún enlace vigente ────────────────────────────────────────
export interface NeedsToken {
  student: StudentRow;
  email: string;
  teacherId: string;
  teacherName: string;
  assignmentId: string | null;
  plan: string | null;
  level: string | null;
  /** 'veterano' = nunca tuvo enlace · 'reactivado' = el suyo caducó sin abrirlo. */
  variant: 'veterano' | 'reactivado';
}

/**
 * Alumnos vivos a los que hay que generarles un form_token para poder
 * perseguirlos. Dos orígenes:
 *
 *   · nunca tuvieron enlace. Son casi todos anteriores al 10/07/2026, la fecha
 *     del primer form_token: no es que su profesor se olvidara, es que la
 *     función no existía cuando entraron.
 *   · el enlace les caducó (30 días) sin que lo abrieran ni completaran nada.
 *
 * Se exige assignment porque el correo nombra al profesor y porque un alumno sin
 * profesor asignado no está en clase: perseguirlo con el formulario sobra.
 */
export function studentsNeedingToken(input: {
  tokens: FormTokenRow[];
  students: StudentRow[];
  sessions: TestSessionRow[];
  dropouts: DropoutRow[];
  assignments: AssignmentRow[];
  now: number;
}): NeedsToken[] {
  const { tokens, students, sessions, dropouts, assignments, now } = input;

  const bajaIds = new Set(dropouts.map(d => d.student_id).filter(Boolean) as string[]);
  const bajaNames = new Set(dropouts.map(d => norm(d.student_name)).filter(Boolean));

  // Estado del alumno según SUS tokens: si tiene alguno vigente o completado, no
  // necesita uno nuevo.
  const tieneVigente = new Set<string>();
  const tieneCaducado = new Set<string>();
  for (const t of tokens) {
    const claves = [studentKeyOf(t), `n:${norm(t.student_name)}`];
    const estado = tokenStateOf(t, now);
    for (const k of claves) {
      if (estado === 'expired') tieneCaducado.add(k);
      else tieneVigente.add(k);        // pending o completed
    }
  }

  // Un alumno que ya hizo la prueba de nivel por otra vía tampoco necesita nada.
  const testHecho = new Set<string>();
  for (const s of sessions) {
    if (s.status !== 'completed') continue;
    if (s.student_id) testHecho.add(s.student_id);
    const n = norm(s.student_name || s.candidate_name);
    if (n) testHecho.add(`n:${n}`);
  }

  const asgById = new Map<string, AssignmentRow>();
  const asgByName = new Map<string, AssignmentRow>();
  for (const a of assignments) {
    if (a.student_id && !asgById.has(a.student_id)) asgById.set(a.student_id, a);
    const n = norm(a.student_name);
    if (n && !asgByName.has(n)) asgByName.set(n, a);
  }

  const out: NeedsToken[] = [];

  for (const student of students) {
    const claveId = student.id;
    const claveNombre = `n:${norm(student.name)}`;
    if (tieneVigente.has(claveId) || tieneVigente.has(claveNombre)) continue;
    if (bajaIds.has(student.id) || bajaNames.has(norm(student.name))) continue;
    if (testHecho.has(claveId) || testHecho.has(claveNombre)) continue;

    const email = student.email?.trim();
    if (!email) continue;

    const asg = asgById.get(student.id) ?? asgByName.get(norm(student.name));
    if (!asg?.teacher_id || !asg.teacher_name) continue;

    out.push({
      student,
      email,
      teacherId: asg.teacher_id,
      teacherName: asg.teacher_name,
      assignmentId: asg.id ?? null,
      plan: asg.plan ?? null,
      level: asg.student_level ?? null,
      variant: (tieneCaducado.has(claveId) || tieneCaducado.has(claveNombre)) ? 'reactivado' : 'veterano',
    });
  }

  return out;
}

/** Contadores para el panel admin. */
export interface FollowupSummary {
  pendientesFormulario: number;
  pendientesTest: number;
  sinEnlace: number;         // alumnos vivos a los que hay que generarles el link
  sinRespuesta: number;      // agotaron los 13 envíos y siguen sin completar
  nuncaContactados: number;
  hoyTocan: number;
  noEnviar: number;          // "No enviar más" marcado por el equipo
}

export function summarize(entries: PendingEntry[], sinEnlace = 0): FollowupSummary {
  return {
    pendientesFormulario: entries.filter(e => e.sequence === 'formulario').length,
    pendientesTest:       entries.filter(e => e.sequence === 'test').length,
    sinEnlace,
    sinRespuesta:         entries.filter(e => e.count >= MAX_FOLLOWUPS).length,
    nuncaContactados:     entries.filter(e => e.count === 0).length,
    hoyTocan:             entries.filter(e => e.step !== null).length,
    noEnviar:             entries.filter(e => e.skipReason === 'no_enviar').length,
  };
}
