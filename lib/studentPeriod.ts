// ── ¿Existe esta clase en esta fecha? ────────────────────────────────────────
//
// EL PROBLEMA. El calendario del profesor es un horario RECURRENTE sin fechas:
// "Martes 12:00" significa todos los martes, desde siempre y para siempre. Al
// asignar a un alumno que empieza el 5 de octubre, el sistema le pinta clases
// hacia atrás hasta el principio de los tiempos. En agosto de 2026 eso eran 132
// clases fantasma repartidas entre 14 profesores — el 7% de las asistencias—, y
// una profesora con la cartera recién abierta llegaba al 48%.
//
// El otro extremo ya estaba resuelto sin querer: al dar de baja a un alumno se
// liberan sus celdas del grid, y como la pertenencia la decide el grid, deja de
// generar clases el mismo día. Por eso solo había UNA clase posterior a una baja
// en todo agosto. La asimetría era esa: el final tenía mecanismo y el principio
// no tenía ninguno.
//
// ─────────────────────────────────────────────────────────────────────────────
// EL CONTRATO, y no depende de que nadie se acuerde:
//
//   EL PERÍODO FILTRA CLASES **PROYECTADAS**. NUNCA HECHOS OBSERVADOS.
//
// Una clase proyectada es una que existe solo porque el horario recurrente dice
// que tocaba. Un HECHO es un `class_join_log` (el profesor pulsó "Ingresar a
// clase") o un `class_record` (registró algo sobre esa clase): son prueba de que
// la clase ocurrió de verdad, y ganan siempre, caiga la fecha donde caiga.
//
// Por eso quedan FUERA de este filtro, a propósito:
//
//   · `calculateTeacherFinance` (lib/finance.ts) — no proyecta nada: construye
//     desde ingresos y registros. Aplicarle el período le borraría clases REALES
//     ya dadas y cobradas a cualquier alumno con la fecha de inicio mal cargada.
//     Es dinero de un profesor: no se toca con una fecha que puede estar mal.
//
//   · `buildPendingClasses` (lib/pendingClasses.ts) — igual, parte de ingresos.
//
// Y por eso mismo es seguro aplicarlo en `buildAttendanceRows`: los ingresos que
// el bucle de horarios no consume se reemiten al final como "leftovers", así que
// un acceso anterior a la fecha de inicio sigue apareciendo aunque su proyección
// esté tapada. El hecho se cuela solo.
// ─────────────────────────────────────────────────────────────────────────────

/** Período en el que un alumno tiene clases con un profesor. */
export interface StudentPeriod {
  /** 'YYYY-MM-DD'. Nunca null: sin piso volveríamos al bug de origen. */
  from: string;
  /** 'YYYY-MM-DD' de la baja, o null si sigue activo. */
  to: string | null;
}

/** Lo mínimo que hace falta de una asignación para saber cuándo empezó. */
interface PeriodSource {
  startDate?: string;
  createdAt?: string;
}

/** Baja registrada del alumno con ese profesor (`student_dropouts`). */
interface DropoutSource {
  droppedAt?: string;
}

/** 'YYYY-MM-DD' de una fecha que puede venir como ISO completo o ya recortada. */
function toIsoDate(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const d = raw.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

/**
 * Período de un alumno con un profesor.
 *
 * `from` = la fecha de inicio de clases si está cargada; si no, el alta de la
 * asignación. NUNCA se devuelve "sin límite": eso es exactamente el bug que esto
 * arregla. El alta es un piso seguro — nadie da una clase antes de estar cargado
 * en el sistema — y se comprobó contra los datos: de las 36 asignaciones cuyo
 * `startDate` se rellenó automáticamente con el día del alta, NINGUNA tiene
 * hechos anteriores a esa fecha.
 *
 * `to` = el día de la baja, si la hubo. Sin baja, abierto.
 */
export function periodOf(assignment: PeriodSource, dropout?: DropoutSource | null): StudentPeriod {
  const from = toIsoDate(assignment.startDate) ?? toIsoDate(assignment.createdAt) ?? '0000-01-01';
  return { from, to: toIsoDate(dropout?.droppedAt) };
}

/**
 * ¿Toca esta clase en esta fecha? Extremos incluidos: el día de inicio hay clase,
 * y el día de la baja también (el alumno se dio de baja después de esa clase, o
 * ese mismo día pero la clase ya había ocurrido).
 */
export function classExistsOn(period: StudentPeriod, dateIso: string): boolean {
  if (dateIso < period.from) return false;
  if (period.to && dateIso > period.to) return false;
  return true;
}

/**
 * Índice `alumno normalizado → período`, listo para consultar dentro de un bucle.
 *
 * Se arma por PROFESOR: el mismo alumno puede haber empezado en fechas distintas
 * con dos profesores (una transferencia), y usar el período del otro le borraría
 * clases buenas. Con varias asignaciones del mismo alumno gana la más antigua,
 * que es la que no recorta nada.
 */
export function periodIndex(
  assignments: Array<PeriodSource & { teacherId: string; studentName: string }>,
  dropouts: Array<{ teacherId: string; studentName: string; droppedAt?: string }>,
  teacherId: string,
): Map<string, StudentPeriod> {
  const nk = (s: string) => (s ?? '').trim().toLowerCase();

  const bajaPor = new Map<string, string>();
  for (const d of dropouts) {
    if (d.teacherId !== teacherId) continue;
    const iso = toIsoDate(d.droppedAt);
    if (!iso) continue;
    const k = nk(d.studentName);
    const prev = bajaPor.get(k);
    // La baja MÁS RECIENTE: un alumno que volvió y se fue otra vez tiene dos.
    if (!prev || iso > prev) bajaPor.set(k, iso);
  }

  const out = new Map<string, StudentPeriod>();
  for (const a of assignments) {
    if (a.teacherId !== teacherId) continue;
    const k = nk(a.studentName);
    const p = periodOf(a, { droppedAt: bajaPor.get(k) });
    const prev = out.get(k);
    if (!prev || p.from < prev.from) out.set(k, p);
  }
  return out;
}

/**
 * ¿Existe la clase de ese alumno en esa fecha, según el índice?
 *
 * Un alumno SIN período en el índice pasa: puede ser una celda del grid sin
 * assignment (existen), y en ese caso no sabemos cuándo empezó. Ante la duda no
 * se esconde nada — esconder una clase real le cuesta dinero a un profesor;
 * mostrar una de más solo le cuesta una fila.
 */
export function existsForStudent(
  index: Map<string, StudentPeriod>, studentName: string, dateIso: string,
): boolean {
  const p = index.get((studentName ?? '').trim().toLowerCase());
  return p ? classExistsOn(p, dateIso) : true;
}

// ── Lectura de las bajas ─────────────────────────────────────────────────────

/** Una baja registrada, con lo justo para cerrar un período. */
export interface StudentDropout {
  teacherId: string;
  studentName: string;
  droppedAt?: string;
}

/**
 * Bajas de `student_dropouts`. Se lee entera (62 filas hoy) y se pagina por si
 * acaso: la tabla crece con cada baja y ya nos mordió el techo de 1000 filas de
 * PostgREST en otras tres tablas.
 *
 * Si la tabla no existe todavía se devuelve vacío en vez de romper: sin bajas el
 * período queda abierto por la derecha, que es el comportamiento de siempre.
 */
export async function dbGetStudentDropouts(): Promise<StudentDropout[]> {
  const { supabase } = await import('@/lib/supabase');
  const { fetchAllPages } = await import('@/lib/db');
  const { rows, error } = await fetchAllPages('student_dropouts', (from, to) =>
    supabase.from('student_dropouts')
      .select('teacher_id, student_name, dropped_at')
      .order('dropped_at', { ascending: false }).order('id', { ascending: false })
      .range(from, to));
  if (error) {
    console.warn('[studentPeriod] No se pudieron leer las bajas:', error.message);
    return [];
  }
  return (rows as Array<Record<string, unknown>>).map(r => ({
    teacherId:   r.teacher_id as string,
    studentName: r.student_name as string,
    droppedAt:   (r.dropped_at as string) ?? undefined,
  }));
}

// ── Fechas de inicio que no cuadran con los hechos ───────────────────────────

/** Un alumno con clases REALES anteriores a su fecha de inicio declarada. */
export interface StartDateMismatch {
  teacherId: string;
  teacherName: string;
  studentName: string;
  /** Fecha de inicio declarada en la ficha. */
  declared: string;
  /** Fecha del hecho más antiguo encontrado. */
  firstFact: string;
  /** De dónde salió ese hecho. */
  source: 'ingreso' | 'registro' | 'transcript';
  daysBefore: number;
}

/**
 * Alumnos cuya fecha de inicio es POSTERIOR a su primera clase real.
 *
 * O empezaron antes de lo previsto, o la fecha se cargó mal. No se corrige sola:
 * solo el profesor sabe si aquello fue una clase de prueba o el inicio de verdad,
 * y cambiar una fecha de inicio mueve qué clases existen. Esto solo las saca a la
 * luz para que alguien pregunte — sin esta lista, los tres casos que encontró la
 * auditoría de agosto de 2026 (Samantha Reyes, Carla Seco y Ainhoa Martín, las
 * tres de Florencia) se habrían perdido en un comentario.
 *
 * El período NO las esconde: los hechos siempre ganan (ver el contrato de
 * arriba), así que esas clases se siguen viendo y cobrando. Esto es una
 * discrepancia de datos, no un problema de pago.
 */
export function findStartDateMismatches(args: {
  assignments: Array<{ teacherId: string; teacherName: string; studentName: string; startDate?: string }>;
  joinLogs: Array<{ teacherId: string; studentName: string; scheduledDate: string }>;
  classRecords: Array<{ teacherId: string; studentName: string; classDate: string }>;
  analyses: Array<{ teacher_id?: string | null; student_name: string; class_date?: string | null; analyzed_at?: string | null }>;
}): StartDateMismatch[] {
  const nk = (s: string) => (s ?? '').trim().toLowerCase();
  const primero = new Map<string, { date: string; source: StartDateMismatch['source'] }>();
  const anota = (teacherId: string, student: string, date: string | null | undefined, source: StartDateMismatch['source']) => {
    const iso = toIsoDate(date);
    if (!iso || !teacherId) return;
    const k = `${teacherId}|${nk(student)}`;
    const cur = primero.get(k);
    if (!cur || iso < cur.date) primero.set(k, { date: iso, source });
  };

  for (const l of args.joinLogs) anota(l.teacherId, l.studentName, l.scheduledDate, 'ingreso');
  for (const r of args.classRecords) anota(r.teacherId, r.studentName, r.classDate, 'registro');
  for (const a of args.analyses) {
    anota(a.teacher_id ?? '', a.student_name, a.class_date || (a.analyzed_at ?? '').slice(0, 10), 'transcript');
  }

  const out: StartDateMismatch[] = [];
  const vistos = new Set<string>();
  for (const a of args.assignments) {
    const declared = toIsoDate(a.startDate);
    if (!declared) continue;
    const k = `${a.teacherId}|${nk(a.studentName)}`;
    if (vistos.has(k)) continue;
    const hecho = primero.get(k);
    if (!hecho || hecho.date >= declared) continue;
    vistos.add(k);
    out.push({
      teacherId: a.teacherId, teacherName: a.teacherName, studentName: a.studentName,
      declared, firstFact: hecho.date, source: hecho.source,
      daysBefore: Math.round(
        (new Date(declared + 'T00:00:00').getTime() - new Date(hecho.date + 'T00:00:00').getTime()) / 86_400_000),
    });
  }
  return out.sort((x, y) => y.daysBefore - x.daysBefore);
}
