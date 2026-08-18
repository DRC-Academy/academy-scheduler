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

export type Sequence = 'formulario' | 'test';

/** Un alumno pendiente, con el paso que le toca hoy (o null si todavía no). */
export interface PendingEntry {
  sequence: Sequence;
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
}): { step: 1 | 2 | 3 | null; days: number; skipReason?: PendingEntry['skipReason'] } {
  const days = daysSince(args.baseDate, args.now);
  const count = Math.max(0, args.count ?? 0);

  if (count >= MAX_REMINDERS) return { step: null, days, skipReason: 'tope_alcanzado' };

  const plan = REMINDER_PLAN[count];          // count 0 → paso 1, count 1 → paso 2…
  if (!plan) return { step: null, days, skipReason: 'tope_alcanzado' };

  if (days < plan.minDays) return { step: null, days, skipReason: 'esperando_dias' };

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

  const out: PendingEntry[] = [];

  for (const token of latestTokenPerStudent(tokens).values()) {
    const estado = tokenStateOf(token, now);
    if (estado === 'expired') continue;

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

    const { step, days, skipReason } = nextReminderStep({ count, lastSent, baseDate, now });
    out.push({ sequence, token, student, email, baseDate, days, count, lastSent, step, skipReason });
  }

  // Los que hoy reciben algo primero, y dentro de cada grupo el que lleva más
  // tiempo esperando: si una corrida se corta a la mitad, se atiende antes a
  // quien lleva más tiempo colgado.
  return out.sort((a, b) => {
    if (Boolean(a.step) !== Boolean(b.step)) return a.step ? -1 : 1;
    return b.days - a.days;
  });
}

/** Contadores para el panel admin. */
export interface FollowupSummary {
  pendientesFormulario: number;
  pendientesTest: number;
  sinRespuesta: number;      // agotaron los 3 recordatorios y siguen sin completar
  nuncaContactados: number;
  hoyTocan: number;
}

export function summarize(entries: PendingEntry[]): FollowupSummary {
  return {
    pendientesFormulario: entries.filter(e => e.sequence === 'formulario').length,
    pendientesTest:       entries.filter(e => e.sequence === 'test').length,
    sinRespuesta:         entries.filter(e => e.count >= MAX_REMINDERS).length,
    nuncaContactados:     entries.filter(e => e.count === 0).length,
    hoyTocan:             entries.filter(e => e.step !== null).length,
  };
}
