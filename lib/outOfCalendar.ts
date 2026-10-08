// ── Qué es una clase "fuera del calendario" ──────────────────────────────────
//
// El embudo tiene una rama para las clases que ocurrieron en un día que el
// calendario no tenía marcado para ese alumno. Durante un tiempo esa rama se
// dividía por ESTADO DE PAGO (pagables / pendientes), que es la pregunta que el
// profesor ya se hizo dos ramas más arriba y que no dice nada sobre qué son esas
// clases. Este módulo las divide por ORIGEN, que es lo que realmente se pregunta
// al verlas: «¿y esto de dónde salió?».
//
// LA CLASIFICACIÓN VIVE ACÁ Y EN NINGÚN OTRO SITIO. La consumen el embudo del
// profesor, el filtro de su lista de clases y la vista del admin. Si cada una
// decidiera por su cuenta volveríamos al problema de raíz: tres pantallas, tres
// números, ninguna forma de saber cuál mirar.
//
// LO QUE MIDIÓ EL DIAGNÓSTICO (agosto 2026, 194 filas / 202 clases):
//
//   · 106 recuperaciones. La señal fiable es `recoveryUnits > 0` —la celda
//     'bloqueado' del calendario—, NO `class_type`: clasificar solo por el tipo
//     perdía 16 de las 106. Se usan las DOS en unión, porque al revés también
//     hay 2 marcadas como recuperación sin celda bloqueada.
//   · 19 faltas y cancelaciones registradas sobre un día sin celda.
//   · 77 clases dadas fuera del horario del alumno. Este es el grupo que
//     interesa: son calendarios desincronizados, no operación normal.
//
// LO QUE NO HAY: clases "añadidas a mano" a propósito. No es un hueco de datos,
// es estructural — "Añadir clase" crea un class_record y un transcript, pero no
// crea `class_join_log`, y sin join log la fila no llega a finanzas (salvo falta
// sin aviso y cancelación a la hora). De las 194 filas de agosto, 186 tenían
// join log y las 186 eran `source='click'`; cero manuales. Por eso el desglose
// no tiene una línea "añadidas a mano": estaría siempre en cero.

import type { Assignment } from '@/types';
import type { ClassFinanceRow } from '@/lib/finance';
import { periodIndex, existsForStudent, type StudentDropout } from '@/lib/studentPeriod';

const nk = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();
const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

/** Fila mínima que hace falta para clasificar. Un subconjunto de ClassFinanceRow. */
export type OutOfCalendarRowRef =
  Pick<ClassFinanceRow, 'classType' | 'recoveryUnits' | 'recoveryForDates'>;

export type OutOfCalendarOrigin = 'recuperacion' | 'falta' | 'fuera_horario';

/**
 * Las tres líneas del desglose, con su texto de ayuda. El orden es el de
 * pantalla: primero lo más frecuente y menos alarmante.
 *
 * Los textos explican qué es cada cosa y por qué está fuera del calendario,
 * porque hoy el profesor no tiene forma de saberlo. Lo que NO hacen es pedirle
 * que avise a nadie: la desincronización del calendario la revisa el equipo en
 * su propia vista, no veinte profesores escribiendo por lo mismo.
 */
export const OUT_ORIGINS: Array<{ key: OutOfCalendarOrigin; branchKey: string; label: string; hint: string }> = [
  {
    key: 'recuperacion',
    branchKey: 'fuera_recuperacion',
    label: 'Recuperaciones',
    hint: 'Clases que diste para reponer una que se había perdido. Salen de una celda bloqueada del calendario, por eso no aparecen en tu horario habitual. Se cobran, y no consumen cupo del alumno.',
  },
  {
    key: 'falta',
    branchKey: 'fuera_falta',
    label: 'Faltas y cancelaciones',
    hint: 'El alumno no vino o canceló sobre la hora, en un día que no tenía clase agendada. Se cobran sin transcript.',
  },
  {
    key: 'fuera_horario',
    branchKey: 'fuera_horario',
    label: 'Dadas fuera de tu horario',
    hint: 'Diste la clase un día que el calendario no tiene marcado para ese alumno. Suele ser un cambio de horario que no se reflejó en la grilla. Se cobra igual.',
  },
];

const FALTAS = new Set(['falta_sin_aviso', 'cancelacion_hora', 'falta_con_aviso']);

/**
 * De dónde salió esta clase fuera del calendario.
 *
 * El orden importa: una recuperación puede además tener un class_type raro, y lo
 * que manda es haber repuesto una clase perdida. `fuera_horario` es el resto por
 * definición, así que las tres líneas siempre suman el total de la rama sin que
 * haya que comprobarlo.
 *
 * Nota sobre las sesiones de 2h mixtas (normal + recuperación): no llegan acá.
 * Una celda bloqueada implica que el alumno tiene slot ese día, y con slot ese
 * día la clase está agendada y cae en «Con registro de clase».
 */
export function originOf(r: OutOfCalendarRowRef): OutOfCalendarOrigin {
  // La UNIÓN de las tres señales, no una sola. `recoveryUnits` —la celda
  // bloqueada del calendario— es la fiable y caza 104 de las 106 de agosto,
  // incluidas 16 que el tipo no marcaba; las 2 que le faltan sí declaran qué
  // clase reponen. Quedarse con una sola señal manda esas clases a "dadas fuera
  // de tu horario", que es donde vive lo que está mal: mejor pecar de incluir
  // una recuperación de más que de inflar el grupo de los problemas.
  if ((r.recoveryUnits ?? 0) > 0
    || r.classType === 'recuperacion'
    || (r.recoveryForDates ?? []).length > 0) return 'recuperacion';
  if (FALTAS.has(r.classType)) return 'falta';
  return 'fuera_horario';
}

// ── Qué días tenía clase el alumno ───────────────────────────────────────────

export interface ScheduledIndex {
  /** ¿El calendario decía que este alumno tenía clase ese día? */
  has(studentName: string, date: string): boolean;
  /** Días de la semana con celda viva ('Lunes', …). Vacío si no tiene ninguna. */
  daysOf(studentName: string): string[];
}

/**
 * Las celdas del mes, por alumno y fecha. Es la partición del embudo: lo que
 * cae acá dentro es «con registro de clase» y lo que queda afuera, «fuera del
 * calendario».
 *
 * Se mira por FECHA, no por hora: un alumno que se movió de las 17:00 a las
 * 18:00 el mismo día sigue teniendo su clase agendada, y tratarlo como una
 * anomalía sería ruido. Lo que detectamos es el cambio de DÍA.
 */
export function scheduledIndex(opts: {
  assignments: Assignment[];
  dropouts: StudentDropout[];
  teacherId: string;
  monthYear: string;
}): ScheduledIndex {
  const { assignments, dropouts, teacherId, monthYear } = opts;
  const [y, m] = monthYear.split('-').map(Number);
  const ultimo = new Date(y, m, 0).getDate();
  const periodos = periodIndex(assignments, dropouts, teacherId);

  const celdas = new Set<string>();
  const dias = new Map<string, Set<string>>();
  for (const a of assignments) {
    if (a.teacherId !== teacherId) continue;
    const suyos = new Set((a.slots ?? []).map(s => s.day));
    if (suyos.size === 0) continue;
    dias.set(nk(a.studentName), suyos);
    for (let d = 1; d <= ultimo; d++) {
      const iso = `${monthYear}-${String(d).padStart(2, '0')}`;
      if (!suyos.has(DIAS[new Date(iso + 'T00:00:00').getDay()])) continue;
      // El período del alumno (alta → baja) recorta la proyección; los HECHOS
      // no se filtran nunca (ver el contrato de lib/studentPeriod).
      if (!existsForStudent(periodos, a.studentName, iso)) continue;
      celdas.add(`${nk(a.studentName)}|${iso}`);
    }
  }

  return {
    has: (studentName, date) => celdas.has(`${nk(studentName)}|${date}`),
    daysOf: studentName => [...(dias.get(nk(studentName)) ?? [])],
  };
}

// ── Para el admin: por qué esa clase quedó fuera de horario ──────────────────

export type DriftKind = 'sin_celda_activo' | 'dia_ajeno' | 'baja';

/**
 * Los tres motivos por los que una clase se dio fuera del horario del alumno.
 * Solo el primero es un problema; los otros dos son operación normal que hay que
 * poder descartar de un vistazo.
 */
export const DRIFT_KINDS: Array<{ key: DriftKind; label: string; hint: string }> = [
  {
    key: 'sin_celda_activo',
    label: 'Sin celda y sin baja',
    hint: 'El alumno no tiene ninguna celda en el calendario del profesor y tampoco está dado de baja. El calendario y la ficha están desincronizados: hay que devolverle sus horas o darlo de baja.',
  },
  {
    key: 'dia_ajeno',
    label: 'Día que no es suyo',
    hint: 'El alumno sí tiene celdas, pero la clase se dio otro día. Suele ser un cambio de horario que nadie reflejó en la grilla.',
  },
  {
    key: 'baja',
    label: 'Dado de baja',
    hint: 'El alumno está dado de baja y aun así hubo clase ese día. Es normal en el mes de la baja: las últimas clases se dan después de registrarla.',
  },
];

/** Nombres (normalizados) de los alumnos con baja registrada. */
export function dropoutNames(dropouts: StudentDropout[], teacherId?: string): Set<string> {
  const out = new Set<string>();
  for (const d of dropouts) {
    if (teacherId && d.teacherId && d.teacherId !== teacherId) continue;
    out.add(nk(d.studentName));
  }
  return out;
}

export function driftKindOf(opts: {
  studentName: string;
  date: string;
  sched: ScheduledIndex;
  bajas: Set<string>;
}): DriftKind {
  const dias = opts.sched.daysOf(opts.studentName);
  if (dias.length === 0) return opts.bajas.has(nk(opts.studentName)) ? 'baja' : 'sin_celda_activo';
  // Tiene celdas pero no ese día. (Si el día FUERA suyo y aun así la clase quedó
  // fuera, es porque el período del alumno no cubre esa fecha: cuenta como baja.)
  const dayName = DIAS[new Date(opts.date + 'T00:00:00').getDay()];
  return dias.includes(dayName) ? 'baja' : 'dia_ajeno';
}

// ── El informe del admin ─────────────────────────────────────────────────────

export interface DriftClass {
  teacherId: string;
  teacherName: string;
  studentName: string;
  date: string;
  hour: string;
  units: number;
  amount: number;
  status: ClassFinanceRow['status'];
  /** Días que el alumno SÍ tiene en la grilla. Vacío = no tiene ninguno. */
  scheduledDays: string[];
}

export interface DriftStudent {
  studentName: string;
  teacherId: string;
  teacherName: string;
  kind: DriftKind;
  classes: DriftClass[];
  units: number;
  amount: number;
  scheduledDays: string[];
}

/**
 * Las clases dadas fuera de horario del mes, agrupadas por alumno y separadas
 * por motivo. Es la vista que el equipo necesita para arreglar los calendarios
 * desincronizados: la alternativa era avisarle al profesor en su pantalla, que
 * es pedirle que reporte un problema que no puede resolver.
 */
export function buildDriftReport(opts: {
  monthYear: string;
  dropouts: StudentDropout[];
  teachers: Array<{
    teacherId: string;
    teacherName: string;
    /** Las del CALENDARIO, las mismas que consume el embudo. */
    assignments: Assignment[];
    rows: ClassFinanceRow[];
  }>;
}): DriftStudent[] {
  const bajas = dropoutNames(opts.dropouts);
  const porAlumno = new Map<string, DriftStudent>();

  for (const t of opts.teachers) {
    const sched = scheduledIndex({
      assignments: t.assignments, dropouts: opts.dropouts,
      teacherId: t.teacherId, monthYear: opts.monthYear,
    });
    for (const r of t.rows) {
      if ((r.date ?? '').slice(0, 7) !== opts.monthYear) continue;
      if (sched.has(r.studentName, r.date)) continue;          // está agendada
      if (originOf(r) !== 'fuera_horario') continue;           // recuperación o falta

      const kind = driftKindOf({ studentName: r.studentName, date: r.date, sched, bajas });
      const dias = sched.daysOf(r.studentName);
      const clave = `${t.teacherId}|${nk(r.studentName)}`;
      if (!porAlumno.has(clave)) {
        porAlumno.set(clave, {
          studentName: r.studentName, teacherId: t.teacherId, teacherName: t.teacherName,
          kind, classes: [], units: 0, amount: 0, scheduledDays: dias,
        });
      }
      const g = porAlumno.get(clave)!;
      const units = r.billingUnits || 1;
      g.classes.push({
        teacherId: t.teacherId, teacherName: t.teacherName,
        studentName: r.studentName, date: r.date, hour: r.hour,
        units, amount: r.rate * units, status: r.status, scheduledDays: dias,
      });
      g.units += units;
      g.amount += r.rate * units;
    }
  }

  const orden: Record<DriftKind, number> = { sin_celda_activo: 0, dia_ajeno: 1, baja: 2 };
  return [...porAlumno.values()]
    .map(g => ({ ...g, classes: g.classes.sort((a, b) => a.date.localeCompare(b.date)) }))
    .sort((a, b) =>
      orden[a.kind] - orden[b.kind] ||
      b.units - a.units ||
      a.teacherName.localeCompare(b.teacherName, 'es') ||
      a.studentName.localeCompare(b.studentName, 'es'));
}
