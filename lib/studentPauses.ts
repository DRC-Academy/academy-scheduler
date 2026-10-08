// ── Pausas de los alumnos: lectura y reglas puras ───────────────────────────
//
// La tabla `student_pauses` (supabase-student-pauses.sql) guarda CUÁNDO estuvo
// en pausa cada alumno. QUIÉN está en pausa lo decide WooCommerce
// (lib/subscriptions/pause.ts + resolveWooSubscriptions); esto es el registro de
// fechas que dejan /api/check-subscription y el cron sync-pausas
// (lib/studentPausesServer.ts).
//
// Una pausa cubre [from, to): el día de la reactivación ya tiene clases. `to`
// null = sigue en pausa.
//
// Si la tabla no existe todavía, todo devuelve vacío: sin fechas, el resto de la
// app se comporta como antes.

/** Una pausa de un alumno. Fechas 'YYYY-MM-DD' (hora de Madrid). */
export interface StudentPause {
  studentId: string;
  studentName: string;
  studentEmail: string;
  from: string;
  /** Día de la reactivación (ese día ya hay clase), o null si sigue en pausa. */
  to: string | null;
}

const nk = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

/** ¿Esta pausa cubre ese día? */
export function pauseCovers(p: { from: string; to: string | null }, dateIso: string): boolean {
  return dateIso >= p.from && (p.to === null || dateIso < p.to);
}

/**
 * Índice `alumno normalizado → sus pausas`, por nombre (como lib/studentPeriod)
 * y por id. El nombre es la clave que usan el grid y las asignaciones; el id
 * cubre los casos en que el nombre de la asignación difiere del de la ficha.
 */
export function pauseIndex(pauses: StudentPause[]): Map<string, StudentPause[]> {
  const out = new Map<string, StudentPause[]>();
  const add = (k: string, p: StudentPause) => { if (k) out.set(k, [...(out.get(k) ?? []), p]); };
  for (const p of pauses) {
    add(nk(p.studentName), p);
    add(`id:${p.studentId}`, p);
  }
  return out;
}

/** ¿El alumno estaba en pausa ese día? Por nombre y, si se conoce, por id. */
export function isPausedOn(
  index: Map<string, StudentPause[]>,
  student: { name?: string | null; id?: string | null },
  dateIso: string,
): boolean {
  const byName = index.get(nk(student.name)) ?? [];
  const byId = student.id ? index.get(`id:${student.id}`) ?? [] : [];
  return [...byName, ...byId].some(p => pauseCovers(p, dateIso));
}

/** La pausa abierta del alumno (sigue en pausa), si la hay. */
export function openPauseOf(
  index: Map<string, StudentPause[]>,
  student: { name?: string | null; id?: string | null },
): StudentPause | null {
  const byName = index.get(nk(student.name)) ?? [];
  const byId = student.id ? index.get(`id:${student.id}`) ?? [] : [];
  return [...byId, ...byName].find(p => p.to === null) ?? null;
}

/** Fila cruda de la tabla → StudentPause. */
export function pauseFromRow(r: Record<string, unknown>): StudentPause {
  return {
    studentId:    String(r.student_id ?? ''),
    studentName:  String(r.student_name ?? ''),
    studentEmail: String(r.student_email ?? ''),
    from:         String(r.started_on ?? '').slice(0, 10),
    to:           r.ended_on ? String(r.ended_on).slice(0, 10) : null,
  };
}

/** ¿El error es "la tabla no existe"? (SQL sin correr: PostgREST da PGRST205; Postgres, 42P01). */
export function esTablaAusente(error: { code?: string | null } | null | undefined): boolean {
  return error?.code === 'PGRST205' || error?.code === '42P01';
}

// Sin la tabla, se recuerda durante la sesión (o la vida del proceso): ninguna
// pantalla vuelve a pedirla ni a llenar la consola de avisos en cada carga.
let tablaAusente = false;

/**
 * Todas las pausas (cliente o servidor, con el cliente de siempre). Se pagina por
 * el techo de 1000 filas de PostgREST. Si la tabla no existe, vacío: las
 * pantallas funcionan igual que antes de "En pausa" (nadie en pausa).
 */
export async function dbGetStudentPauses(): Promise<StudentPause[]> {
  if (tablaAusente) return [];
  const { supabase } = await import('@/lib/supabase');
  const { fetchAllPages } = await import('@/lib/db');
  const { rows, error } = await fetchAllPages('student_pauses', (from, to) =>
    supabase.from('student_pauses')
      .select('student_id, student_name, student_email, started_on, ended_on')
      .order('started_on', { ascending: false }).order('id', { ascending: false })
      .range(from, to));
  if (error) {
    if (esTablaAusente(error)) {
      tablaAusente = true;
      console.info('[studentPauses] La tabla student_pauses no existe (supabase-student-pauses.sql sin correr): se sigue sin pausas.');
      return [];
    }
    console.warn('[studentPauses] No se pudieron leer las pausas:', error.message);
    return [];
  }
  return (rows as Array<Record<string, unknown>>).map(pauseFromRow);
}
