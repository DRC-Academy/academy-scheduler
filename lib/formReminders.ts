// Follow-up del formulario inicial + prueba de nivel: QUIÉN está pendiente y QUÉ
// recordatorio le toca hoy.
//
// Todo lo que hay acá son funciones puras sobre filas ya leídas. Las usan los dos
// lados por igual: el cron (app/api/cron/form-reminders) para decidir a quién
// escribe, y el panel admin para mostrar los mismos números. Si el criterio
// cambia, cambia en un solo sitio y las dos vistas se mueven juntas.
//
// ── LAS DOS SECUENCIAS ───────────────────────────────────────────────────────
// El alumno recibe UN enlace, el del formulario; la prueba de nivel se le ofrece
// al terminarlo (ver app/api/forms/submit). Pero por debajo son dos tokens, así
// que hay dos secuencias encadenadas y un alumno está como mucho en una:
//
//   · 'formulario' → su último form_token sigue 'pending'.
//     Reloj: form_tokens.created_at, la fecha en que RECIBIÓ el enlace.
//   · 'test'       → completó el formulario pero no tiene ninguna sesión de test
//     terminada. Reloj: form_tokens.completed_at.
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
// ── LA CADENCIA ──────────────────────────────────────────────────────────────
// Tres recordatorios y se acabó. Para un alumno nuevo caen exactamente en los
// días 2, 5 y 10. Para uno que ya llevaba semanas esperando cuando encendimos
// esto, la secuencia NO se da por quemada: empieza hoy por el primero y respeta
// el mismo espaciado (3 y 5 días). Recibe los tres repartidos en 8 días en vez
// de un único email de despedida.

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

/** Un alumno pendiente, con el paso que le toca hoy (o null si todavía no). */
export interface PendingEntry {
  sequence: Sequence;
  variant: CopyVariant;
  token: FormTokenRow;
  student: StudentRow;
  email: string;
  /** Fecha desde la que se cuentan los días (ISO). */
  baseDate: string;
  /** Días enteros transcurridos desde baseDate. */
  days: number;
  /** Recordatorios ya enviados en esta secuencia (0 – 3). */
  count: number;
  lastSent: string | null;
  /** 1, 2 o 3 si hoy le toca uno; null si todavía no, o si ya se agotaron. */
  step: 1 | 2 | 3 | null;
  /** Por qué no le toca hoy (para el modo dry y el panel). */
  skipReason?: 'tope_alcanzado' | 'esperando_dias' | 'esperando_espaciado';
}

// ── La cadencia ──────────────────────────────────────────────────────────────
export const MAX_REMINDERS = 3;

/**
 * `minDays`   → días mínimos desde la fecha base para mandar este recordatorio.
 * `minGapDays`→ días mínimos desde el recordatorio anterior. Es lo que evita que
 *               un alumno rezagado reciba los tres seguidos: aunque lleve 25
 *               días esperando, el 2º no sale hasta 3 días después del 1º.
 */
export const REMINDER_PLAN = [
  { step: 1 as const, minDays: 2,  minGapDays: 0 },
  { step: 2 as const, minDays: 5,  minGapDays: 3 },
  { step: 3 as const, minDays: 10, minGapDays: 5 },
];

export const STEP_LABEL: Record<number, string> = {
  1: '1º recordatorio',
  2: '2º recordatorio',
  3: '3º (último)',
};

// ── Utilidades ───────────────────────────────────────────────────────────────
export const norm = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

/** Días enteros entre dos instantes. Devuelve -1 si la fecha no es válida. */
export function daysSince(iso: string | null | undefined, now: number): number {
  if (!iso) return -1;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return -1;
  return Math.floor((now - t) / 86_400_000);
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
 * Qué recordatorio toca hoy. Devuelve el paso o el motivo por el que no toca.
 *
 * El siguiente paso es siempre `count + 1`: nunca se saltan pasos, ni siquiera
 * para un alumno que lleva 30 días esperando. Así el primero que recibe es
 * siempre el amable, no el de urgencia.
 */
export function nextReminderStep(args: {
  count: number;
  lastSent: string | null;
  baseDate: string;
  now: number;
  /** El enlace lo creó el follow-up: el primer correo sale ya, sin esperar 2 días. */
  primeroInmediato?: boolean;
}): { step: 1 | 2 | 3 | null; days: number; skipReason?: PendingEntry['skipReason'] } {
  const days = daysSince(args.baseDate, args.now);
  const count = Math.max(0, args.count ?? 0);

  if (count >= MAX_REMINDERS) return { step: null, days, skipReason: 'tope_alcanzado' };

  const plan = REMINDER_PLAN[count];          // count 0 → paso 1, count 1 → paso 2…
  if (!plan) return { step: null, days, skipReason: 'tope_alcanzado' };

  const minDays = count === 0 && args.primeroInmediato ? 0 : plan.minDays;
  if (days < minDays) return { step: null, days, skipReason: 'esperando_dias' };

  if (count > 0) {
    const gap = daysSince(args.lastSent, args.now);
    // Sin fecha del último envío (dato viejo o corrupto) se espera un día antes
    // de seguir, en vez de disparar el siguiente de inmediato.
    if (gap < plan.minGapDays) return { step: null, days, skipReason: 'esperando_espaciado' };
  }

  return { step: plan.step, days };
}

// ── Quién está pendiente ─────────────────────────────────────────────────────
export interface BuildPendingInput {
  tokens: FormTokenRow[];
  students: StudentRow[];
  sessions: TestSessionRow[];
  dropouts: DropoutRow[];
  now: number;
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
  const { tokens, students, sessions, dropouts, now } = input;

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

    const email = (token.student_email?.trim() || student.email?.trim() || '');
    if (!email) continue;

    let sequence: Sequence;
    let baseDate: string;
    let count: number;
    let lastSent: string | null;

    if (estado === 'pending') {
      sequence = 'formulario';
      baseDate = token.created_at;
      count = token.form_reminder_count ?? 0;
      lastSent = token.form_reminder_last_sent;
    } else {
      // Formulario completado → solo sigue pendiente si le falta la prueba.
      const hecho =
        (token.student_id && testHechoIds.has(token.student_id)) ||
        testHechoNames.has(norm(token.student_name)) ||
        testHechoNames.has(norm(student.name));
      if (hecho) continue;
      if (!token.completed_at) continue;                      // sin reloj fiable
      sequence = 'test';
      baseDate = token.completed_at;
      count = token.test_reminder_count ?? 0;
      lastSent = token.test_reminder_last_sent;
    }

    const { step, days, skipReason } = nextReminderStep({
      count, lastSent, baseDate, now,
      // Solo la secuencia del formulario entrega el enlace por correo; la del
      // test siempre parte de un formulario que el alumno ya rellenó.
      primeroInmediato: sequence === 'formulario' && primerAvisoInmediato(token),
    });
    out.push({
      sequence, variant: variantOf(token), token, student, email,
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
  sinRespuesta: number;      // agotaron los 3 recordatorios y siguen sin completar
  nuncaContactados: number;
  hoyTocan: number;
}

export function summarize(entries: PendingEntry[], sinEnlace = 0): FollowupSummary {
  return {
    pendientesFormulario: entries.filter(e => e.sequence === 'formulario').length,
    pendientesTest:       entries.filter(e => e.sequence === 'test').length,
    sinEnlace,
    sinRespuesta:         entries.filter(e => e.count >= MAX_REMINDERS).length,
    nuncaContactados:     entries.filter(e => e.count === 0).length,
    hoyTocan:             entries.filter(e => e.step !== null).length,
  };
}
