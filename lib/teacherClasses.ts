// ── Clases del profesor: horario recurrente → clases con FECHA ────────────────
//
// Fuente ÚNICA que expande el horario de un profesor a las clases reales de una
// fecha, más las constancias que la apagan (cancelada / reprogramada) y el
// transcript que la cierra. Vivía como código privado dentro del panel del
// profesor; se sacó acá para que la agenda (/clases) y la cabecera del
// Calendario ("Próxima clase") no puedan calcular clases distintas.
//
// Dos fuentes:
//   1. Slots recurrentes del alumno (grid → assignment.slots) en su día de la semana.
//   2. Celdas de recuperación del grid ('bloqueado' con alumno + weekDate) cuya
//      fecha real cae en el día pedido.
//
// Las fechas se manejan como cadena 'YYYY-MM-DD' con aritmética en UTC:
// `new Date(y, m, d)` depende de la zona del NAVEGADOR y la academia tiene
// profesores en España y en Argentina (ver lib/spainTime.ts). Lo mismo vale para
// "¿esta clase ya pasó?": se decide con la hora de España que pase el llamador.

import type { Assignment, AssignedSlot, ClassRecord, ClassRecordType, Grid } from '@/types';
import type { ClassTranscriptRef } from '@/lib/finance';
import { baseStateOf, baseStudentOf } from '@/lib/cells';
import { existsForStudent, type StudentPeriod } from '@/lib/studentPeriod';
import {
  contiguousRunLength, groupByContiguousHour, hourNum, hourText, nkName,
  sessionIdOf, sessionRangeLabel,
} from '@/lib/sessions';

export const DAY_NAMES_BY_JSDAY = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

// Días que existen en el grid del calendario. Espeja `DAYS` de VisualCalendar,
// que no se puede importar acá (es un componente cliente y arrastraría todo el
// calendario a cualquier módulo que use estas funciones).
const GRID_DAY_ORDER = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

const nk = (s: string) => (s ?? '').trim().toLowerCase();

// ── Helpers de fecha ──────────────────────────────────────────────────────────

/** Día de la semana ("Lunes"…) de una fecha 'YYYY-MM-DD'. */
export function dayNameFromIso(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return '';
  return DAY_NAMES_BY_JSDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** Día de la semana de un Date, en la zona del navegador (para escribir el grid). */
export function dayNameFromDate(d: Date): string {
  return DAY_NAMES_BY_JSDAY[d.getDay()];
}

/** Date → 'YYYY-MM-DD' en la zona del navegador. */
export function isoDateLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Suma días a una fecha 'YYYY-MM-DD' sin pasar por la zona local. */
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Lunes (ISO) de la semana que contiene el Date dado. */
export function mondayIsoOf(d: Date): string {
  const dow = d.getDay();                    // 0=Dom … 6=Sáb
  const diff = dow === 0 ? -6 : 1 - dow;     // retroceder hasta el lunes
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  return isoDateLocal(monday);
}

/** Hora de la clase normalizada a 'HH:00'. */
export function hourLabel(hour: string): string {
  const h = parseInt(hour, 10);
  return isNaN(h) ? hour : `${String(h).padStart(2, '0')}:00`;
}

/** Lunes (ISO) de la semana que contiene una fecha 'YYYY-MM-DD'. */
export function mondayIsoOfIso(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDaysIso(iso, dow === 0 ? -6 : 1 - dow);
}

/** Fecha corta para la UI: '2026-07-28' → '28 jul'. */
export function shortDateLabel(iso: string): string {
  const d = new Date(iso + 'T12:00:00Z');
  if (isNaN(d.getTime())) return iso;
  const month = d.toLocaleDateString('es-ES', { month: 'short', timeZone: 'UTC' }).replace('.', '');
  return `${d.getUTCDate()} ${month}`;
}

/** Cabecera de un día en la vista semanal: 'Lunes 27'. */
export function dayHeadingLabel(iso: string): string {
  const d = new Date(iso + 'T12:00:00Z');
  if (isNaN(d.getTime())) return iso;
  const day = d.toLocaleDateString('es-ES', { weekday: 'long', timeZone: 'UTC' });
  return `${day.charAt(0).toUpperCase()}${day.slice(1)} ${d.getUTCDate()}`;
}

/**
 * Días de la semana (lunes → sábado) que contiene la fecha dada. Son SEIS y no
 * siete porque el grid del calendario no tiene domingo: un séptimo día solo
 * podría salir vacío.
 */
export function weekDaysOf(iso: string): string[] {
  const monday = mondayIsoOfIso(iso);
  return Array.from({ length: 6 }, (_, i) => addDaysIso(monday, i));
}

/** Rango legible de una semana: "27 jul — 1 ago". */
export function weekRangeLabel(iso: string): string {
  const days = weekDaysOf(iso);
  return `${shortDateLabel(days[0])} — ${shortDateLabel(days[days.length - 1])}`;
}

// ── Clases de una fecha ───────────────────────────────────────────────────────

export interface TeacherClass {
  key: string;
  /** Fecha real de la clase, 'YYYY-MM-DD'. */
  date: string;
  assignment: Assignment;
  studentName: string;
  hour: string;           // 'HH' o 'HH:00', tal como está en el grid
  level: string;
  plan: string;
  meetLink?: string;
  isRecovery?: boolean;   // clase puntual de recuperación (celda 'bloqueado')
  recoveryFor?: string;   // 'YYYY-MM-DD' de la clase original que se recupera
}

/**
 * FUENTE 1: slots recurrentes que caen en la fecha, ordenados por hora.
 *
 * `periods` (lib/studentPeriod) descarta las clases fuera del período del alumno:
 * el horario recurrente no tiene fechas, así que sin esto un alumno que empieza
 * el mes que viene ya aparece en la agenda de hoy. Es OPCIONAL para no romper a
 * los llamadores que todavía no lo pasan; cuando falta, se proyecta todo como
 * antes.
 */
export function classesForDate(
  assignments: Assignment[], dateIso: string, periods?: Map<string, StudentPeriod>,
): TeacherClass[] {
  const dayName = dayNameFromIso(dateIso);
  const list: TeacherClass[] = [];
  for (const a of assignments) {
    if (periods && !existsForStudent(periods, a.studentName, dateIso)) continue;
    for (const slot of a.slots ?? []) {
      if (slot.day !== dayName) continue;
      list.push({
        key:         `${a.id}_${dateIso}_${slot.hour}`,
        date:        dateIso,
        assignment:  a,
        studentName: a.studentName,
        hour:        slot.hour,
        level:       a.studentLevel,
        plan:        a.plan || a.objetivo || '',
        meetLink:    a.meetLink,
      });
    }
  }
  return list.sort((x, y) => parseInt(x.hour) - parseInt(y.hour));
}

/** Match tolerante de una celda de recuperación a una assignment por nombre. */
export function findAssignmentForName(assignments: Assignment[], name: string): Assignment | undefined {
  const full = nk(name);
  const first = nk(name.split(' ')[0]);
  return assignments.find(a => nk(a.studentName) === full)
      ?? assignments.find(a => { const c = nk(a.studentName); return c === first || c.startsWith(first) || full.startsWith(c); });
}

/**
 * FUENTE 2: celdas de recuperación del grid ('bloqueado' con alumno + weekDate)
 * cuya fecha real (lunes de weekDate + día de la celda) cae en la fecha pedida.
 * Se vinculan a la assignment del alumno para heredar enlace de Meet, plan,
 * nivel y email. Las que no matchean ninguna assignment se omiten (siguen
 * visibles en el calendario).
 */
export function recoveriesForDate(grid: Grid, dateIso: string, assignments: Assignment[]): TeacherClass[] {
  const list: TeacherClass[] = [];
  for (const [key, cell] of Object.entries(grid)) {
    if (cell.state !== 'bloqueado' || !cell.student || !cell.weekDate) continue;
    const usc = key.lastIndexOf('_');
    if (usc < 0) continue;
    const day = key.slice(0, usc);
    const hour = key.slice(usc + 1);
    const dayIdx = GRID_DAY_ORDER.indexOf(day);
    if (dayIdx < 0) continue;
    // Fecha real de la celda = lunes(weekDate) + índice de día, sobre la cadena.
    if (addDaysIso(cell.weekDate, dayIdx) !== dateIso) continue;

    const a = findAssignmentForName(assignments, cell.student);
    if (!a) continue;
    list.push({
      key:         `rec_${key}_${dateIso}`,
      date:        dateIso,
      assignment:  a,
      studentName: cell.student,
      hour,
      level:       a.studentLevel,
      plan:        a.plan || a.objetivo || '',
      meetLink:    a.meetLink,
      isRecovery:  true,
      recoveryFor: cell.recoveryFor,
    });
  }
  return list;
}

// ── SESIONES: celdas contiguas del mismo alumno = UNA clase larga ─────────────
//
// Fuente ÚNICA de la agrupación. La usan TODAS las vistas que listan clases del
// profesor (Calendario, Mis clases, Próxima clase, Asistencias) para que ninguna
// siga viendo dos clases sueltas de 1h donde hay una sesión de 2h.
//
// La regla de contigüidad vive en lib/sessions (primitivas puras compartidas).
// Acá se le suma lo que sabe este módulo: qué dos clases son "el mismo alumno el
// mismo día" y qué NO se puede fusionar.

// ── EL CALENDARIO MANDA: ocupación recurrente del grid ───────────────────────
//
// Una clase es de 2h SOLO si el CALENDARIO tiene dos horas seguidas ocupadas por
// el mismo alumno. La ficha (`assignments.slots`) es un espejo del calendario y
// se sincroniza al guardarlo, pero puede estar vieja hasta que se repare; en ese
// hueco no se puede pedir un solo acceso y un solo transcript para dos horas que
// el calendario no respalda.
//
// La ocupación sale de `teacher.upcomingClasses`, que `dbGetTeachers` ya arma
// leyendo TODOS los calendarios con `baseStudentOf` (el alumno recurrente, no el
// que recupera). O sea: dato del grid, sin una consulta extra.

/** Una hora de recuperación del calendario, con la clase perdida que salda. */
export interface RecoveryHour {
  hour: number;
  /** Fecha 'YYYY-MM-DD' de la clase original que esta hora recupera. */
  recoveryFor?: string;
}

/** Horas ocupadas en el CALENDARIO, por alumno y día. */
export interface GridOccupancy {
  /** `${alumno normalizado}|${día}` → horas ocupadas RECURRENTES. */
  hours: Map<string, number[]>;
  /**
   * `${alumno normalizado}|${fecha ISO}` → horas de RECUPERACIÓN de ese día.
   *
   * Van aparte de `hours` y con FECHA en vez de día de la semana porque son
   * marcas puntuales de UNA semana: el martes 15/07 a las 18:00 hay recuperación,
   * el resto de los martes no. Meterlas en `hours` habría hecho que esa hora
   * contara como sesión de 2h todas las semanas del año.
   */
  recoveries: Map<string, RecoveryHour[]>;
}

export function gridOccupancyOfTeacher(
  teacher: {
    upcomingClasses?: Array<{ studentName: string; day: string; time: string }>;
    recoveryCells?: Array<{ studentName: string; hour: string; date: string; recoveryFor?: string }>;
  } | null | undefined,
): GridOccupancy {
  const hours = new Map<string, number[]>();
  for (const c of teacher?.upcomingClasses ?? []) {
    const h = hourNum(c.time);
    if (!Number.isFinite(h)) continue;
    const k = `${nkName(c.studentName)}|${c.day}`;
    const arr = hours.get(k);
    if (arr) arr.push(h); else hours.set(k, [h]);
  }
  const recoveries = new Map<string, RecoveryHour[]>();
  for (const r of teacher?.recoveryCells ?? []) {
    const h = hourNum(r.hour);
    if (!Number.isFinite(h) || !r.date) continue;
    const k = `${nkName(r.studentName)}|${r.date}`;
    const arr = recoveries.get(k);
    if (arr) arr.push({ hour: h, recoveryFor: r.recoveryFor });
    else recoveries.set(k, [{ hour: h, recoveryFor: r.recoveryFor }]);
  }
  return { hours, recoveries };
}

/** Ocupación vacía: para los llamadores que aún no tienen el calendario a mano. */
export const EMPTY_GRID_OCCUPANCY: GridOccupancy = { hours: new Map(), recoveries: new Map() };

/** Horas de recuperación de ese alumno en esa FECHA concreta. Vacío si no hay. */
export function recoveryHoursOn(
  occ: GridOccupancy | undefined, studentName: string, dateIso: string,
): RecoveryHour[] {
  return occ?.recoveries.get(`${nkName(studentName)}|${dateIso}`) ?? [];
}

/**
 * Parte de RECUPERACIÓN que cae dentro de una sesión: las horas de recuperación
 * del alumno ese día que están en el tramo [startHour, endHour).
 *
 * Es lo que convierte "una sesión de 2h" en "1h normal + 1h de recuperación":
 * `units` es cuántas de las horas cobradas son recuperación (y por tanto NO
 * consumen cupo del mes) y `dates` las clases perdidas que saldan.
 */
export function recoveryPartOfSession(
  occ: GridOccupancy | undefined, studentName: string, dateIso: string,
  startHour: number, endHour: number,
): { units: number; dates: string[] } {
  const inside = recoveryHoursOn(occ, studentName, dateIso)
    .filter(r => r.hour >= startHour && r.hour < endHour);
  const dates = [...new Set(inside.map(r => r.recoveryFor).filter((d): d is string => !!d))].sort();
  return { units: inside.length, dates };
}

/**
 * Longitud de la racha contigua del CALENDARIO que contiene esa hora.
 * Devuelve null si el alumno no tiene NINGUNA hora ese día en el calendario: ahí
 * el grid no puede opinar (clases de recuperación, clases fuera de horario) y el
 * llamador decide con lo que tenga.
 */
export function gridRunLength(
  occ: GridOccupancy | undefined, studentName: string, day: string, hour: string | number,
): number | null {
  const list = occ?.hours.get(`${nkName(studentName)}|${day}`);
  if (!list || list.length === 0) return null;
  return contiguousRunLength(list, hour);
}

/** Horario que el CALENDARIO le da a un alumno. Vacío = no tiene clases ahora. */
export function gridSlotsFor(occ: GridOccupancy, studentName: string): AssignedSlot[] {
  const out: AssignedSlot[] = [];
  const name = nkName(studentName);
  for (const [k, horas] of occ.hours) {
    const sep = k.lastIndexOf('|');
    if (k.slice(0, sep) !== name) continue;
    const day = k.slice(sep + 1);
    for (const h of [...new Set(horas)].sort((a, b) => a - b)) out.push({ day, hour: hourText(h) });
  }
  return out.sort((a, b) =>
    GRID_DAY_ORDER.indexOf(a.day) - GRID_DAY_ORDER.indexOf(b.day) ||
    hourNum(a.hour) - hourNum(b.hour));
}

/**
 * Reescribe los `slots` de cada assignment con lo que dice el CALENDARIO de su
 * profesor. Un alumno al que sacaron del calendario queda con `slots: []`, así
 * que deja de generar clases, filas de asistencia y horarios — sigue asignado,
 * pero "actualmente sin tomar clases".
 *
 * Existe para las pantallas que trabajan con la tabla `assignments` en crudo (el
 * panel de admin, el resumen de pago del profesor). Las que ya usan
 * `getTeacherAssignments` reciben los slots del grid de fábrica y no la necesitan.
 * No hace ninguna consulta: la ocupación sale de `teacher.upcomingClasses`.
 */
export function applyGridSlots(
  assignments: Assignment[], occupancyByTeacher: Record<string, GridOccupancy>,
): Assignment[] {
  return assignments.map(a => {
    const occ = occupancyByTeacher[a.teacherId];
    if (!occ) return a;             // sin calendario cargado: no se toca nada
    return { ...a, slots: gridSlotsFor(occ, a.studentName) };
  });
}

/** Clase del profesor ya agrupada: una sesión de 1, 2 o más horas seguidas. */
export interface TeacherSession extends TeacherClass {
  /** `${teacherId}|${alumno}|${fecha}|${horaInicio}`. Derivado, nunca persistido. */
  sessionId: string;
  /** Hora de inicio como número (17 para 17:00). */
  startHourNum: number;
  /** Hora de fin, EXCLUSIVA: una sesión 17–19 tiene endHourNum 19. */
  endHourNum: number;
  /** Nº de celdas contiguas: 2 para 17:00+18:00. */
  durationHours: number;
  /** Lo que vale la sesión para el pago. = durationHours. */
  billingUnits: number;
  /**
   * Cuántas de las `billingUnits` son de RECUPERACIÓN. 0 en una sesión normal,
   * `billingUnits` en una sesión que es toda recuperación, y 1 en el caso mixto
   * (1h normal + 1h de recuperación seguidas).
   *
   * El profesor cobra las `billingUnits` completas —dio las dos horas—, pero el
   * cupo mensual del alumno solo consume `billingUnits - recoveryUnits`: la parte
   * de recuperación salda una clase que ya se había perdido.
   */
  recoveryUnits: number;
  /** Fechas de las clases PERDIDAS que salda esta sesión ('YYYY-MM-DD'). */
  recoveryDates: string[];
  /** Sesión MIXTA: parte normal + parte de recuperación en el mismo bloque. */
  mixedRecovery: boolean;
  /** Horas que la componen, en orden: ['17:00', '18:00']. */
  hours: string[];
  /** Las clases de 1h originales, por si alguna vista necesita el detalle. */
  parts: TeacherClass[];
}

/**
 * ¿Estas dos clases de 1h pertenecen a la misma sesión? (la contigüidad horaria
 * la comprueba `groupByContiguousHour` aparte).
 *
 * Una clase normal y una recuperación pegadas del MISMO alumno SÍ se fusionan:
 * son un bloque de 2 horas seguidas con un solo acceso y un solo transcript, y
 * antes se pagaba una sola de las dos horas.
 *
 * Antes estaba prohibido por miedo a perder el vínculo de la recuperación con la
 * clase que repone. Ya no se pierde: `toSession` guarda `recoveryDates` (las
 * clases perdidas que salda) y marca la sesión con `mixedRecovery`, así que el
 * bloque sigue sabiendo exactamente qué hora es normal y qué hora recupera qué.
 *
 * Lo que esta función NO deja pasar sigue igual de firme: distinta fecha o
 * distinto alumno nunca son la misma sesión. (La contigüidad horaria y el
 * respaldo del calendario los comprueban `groupByContiguousHour` y `chain`.)
 */
function sameSessionClass(a: TeacherClass, b: TeacherClass): boolean {
  return a.date === b.date
    && nkName(a.studentName) === nkName(b.studentName);
}

/** Convierte una racha de clases contiguas en la sesión que representan. */
function toSession(run: TeacherClass[], teacherId: string): TeacherSession {
  const first = run[0];
  const start = hourNum(first.hour);
  const duration = run.length;

  // El vínculo de la recuperación NO se pierde al fundir: se recoge de TODAS las
  // partes del bloque, no solo de la primera. `...first` solo aporta los datos
  // que son iguales en todas (alumno, fecha, assignment, enlace de Meet).
  const recoveryParts = run.filter(c => c.isRecovery);
  const recoveryDates = [...new Set(recoveryParts.map(c => c.recoveryFor).filter((d): d is string => !!d))].sort();
  const allRecovery = recoveryParts.length === run.length;

  return {
    // Se conserva la `key` de la primera hora: es única y ya la usan las vistas
    // como identidad de fila (spinner de "Ingresar a clase", "próxima clase"…).
    ...first,
    // `isRecovery` describe la sesión ENTERA, no su primera hora: solo es una
    // recuperación si TODAS sus horas lo son. Sin esto, un bloque que empieza con
    // la hora de recuperación y sigue con la normal se habría etiquetado entero
    // como "Recuperación" (y se habría registrado con ese tipo de clase).
    isRecovery:   allRecovery,
    recoveryFor:  allRecovery ? first.recoveryFor : recoveryDates[0],
    sessionId:    sessionIdOf(teacherId, first.studentName, first.date, start),
    startHourNum: start,
    endHourNum:   start + duration,
    durationHours: duration,
    billingUnits: duration,
    recoveryUnits: recoveryParts.length,
    recoveryDates,
    mixedRecovery: recoveryParts.length > 0 && !allRecovery,
    hours:        run.map(c => hourText(hourNum(c.hour))),
    parts:        run,
  };
}

/**
 * Agrupa las clases de un profesor en sesiones. Dos (o más) celdas contiguas del
 * mismo alumno el mismo día salen como UNA sesión con su duración; el resto salen
 * como sesiones de 1 hora, así el llamador trabaja siempre con el mismo tipo.
 *
 * Acepta las clases de CUALQUIERA de las dos fuentes (slots recurrentes y celdas
 * de recuperación del grid) y las agrupa con la misma regla, que es lo que evita
 * que cada pantalla invente su propia definición de "clase de 2h".
 */
export function groupContiguousClasses(
  classes: TeacherClass[],
  teacherId: string,
  /**
   * Ocupación del CALENDARIO. Dos clases solo se funden en una sesión si el grid
   * las tiene contiguas para ese alumno. Sin ella (o si el alumno no aparece ese
   * día en el grid, p. ej. una recuperación) se agrupa por contigüidad a secas.
   */
  occupancy?: GridOccupancy,
): TeacherSession[] {
  // Por fecha: dos clases de días distintos nunca son la misma sesión, y
  // groupByContiguousHour solo mira la hora.
  const byDate = new Map<string, TeacherClass[]>();
  for (const c of classes) {
    const arr = byDate.get(c.date);
    if (arr) arr.push(c); else byDate.set(c.date, [c]);
  }

  const sessions: TeacherSession[] = [];
  for (const [, sameDay] of byDate) {
    // Y por alumno: el orden por hora de dos alumnos intercalados (A 17:00,
    // B 18:00) no puede encadenarse, y separarlos antes lo hace evidente.
    const byStudent = new Map<string, TeacherClass[]>();
    for (const c of sameDay) {
      const k = nkName(c.studentName);
      const arr = byStudent.get(k);
      if (arr) arr.push(c); else byStudent.set(k, [c]);
    }
    for (const [, ofStudent] of byStudent) {
      // El calendario tiene la última palabra sobre si dos horas son UNA clase.
      const chain = (a: TeacherClass, b: TeacherClass) => {
        if (!sameSessionClass(a, b)) return false;
        // Sin calendario a mano (llamador antiguo) se agrupa por contigüidad.
        if (!occupancy) return true;
        // Las recuperaciones son celdas PUNTUALES del grid: no están en la
        // ocupación recurrente, así que se agrupan por su propia contigüidad —
        // que también sale del calendario, solo que de otra parte.
        //
        // Basta con que UNA de las dos horas lo sea: en el bloque mixto (normal
        // 17:00 + recuperación 18:00) la prueba de que las dos horas van juntas
        // es la celda de recuperación, que el profesor puso pegada a la clase
        // normal. Preguntarle a la ocupación RECURRENTE por la hora de la
        // recuperación siempre diría que no: ahí esa hora figura libre.
        if (a.isRecovery || b.isRecovery) return true;

        const day = dayNameFromIso(a.date);
        const run = gridRunLength(occupancy, a.studentName, day, a.hour);
        // El calendario no tiene a este alumno ese día: la ficha se quedó vieja
        // (o la asignación ya no está activa). No se inventa una sesión de 2h
        // sobre horas que el calendario no respalda.
        if (run == null) return false;
        // Solo se funden si el calendario tiene las DOS horas seguidas ocupadas.
        return run > 1 && gridRunLength(occupancy, b.studentName, day, b.hour) === run;
      };
      for (const run of groupByContiguousHour(ofStudent, c => c.hour, chain)) {
        sessions.push(toSession(run, teacherId));
      }
    }
  }

  return sessions.sort((x, y) => x.date.localeCompare(y.date) || x.startHourNum - y.startHourNum);
}

/** "17:00 - 19:00" (2h) o "17:00" (1h). Fuente única del rango que se muestra. */
export function sessionHoursLabel(s: { hour: string; durationHours: number }): string {
  return sessionRangeLabel(s.hour, s.durationHours);
}

// ── Inconsistencias de contigüidad entre el grid y las assignments ────────────

/**
 * Un alumno cuyas horas contiguas NO coinciden entre las dos fuentes: el grid
 * del profesor (lo que se ve en el calendario) y `assignments.slots` (de donde
 * salen las clases de la agenda). Se INFORMA, nunca se corrige sola: inventar la
 * contigüidad en la fuente que no la tiene es exactamente lo que haría que un
 * profesor cobre 2 por una clase de 1 hora.
 */
export interface ContiguityMismatch {
  teacherId: string;
  teacherName: string;
  studentName: string;
  day: string;
  gridHours: string[];
  slotHours: string[];
  /** Duración máxima contigua según cada fuente (2 = sesión de 2h). */
  gridDuration: number;
  slotDuration: number;
}

/** Horas de la racha contigua más larga de una lista de horas. */
function maxRun(hours: number[]): number {
  let best = 0;
  for (const h of hours) best = Math.max(best, contiguousRunLength(hours, h));
  return best;
}

/**
 * Compara, alumno por alumno y día por día, la contigüidad que ve el grid con la
 * que ven los slots de la assignment. Solo mira el estado RECURRENTE del grid
 * (`baseStateOf`/`baseStudentOf`): una recuperación puntual de esta semana no es
 * un horario fijo y no debe contar como sesión de 2h del alumno de fondo.
 */
export function findContiguityMismatches(
  grid: Grid,
  assignments: Assignment[],
  teacher: { id: string; name: string },
): ContiguityMismatch[] {
  // Grid → alumno|día → horas recurrentes ocupadas.
  const gridHours = new Map<string, number[]>();
  for (const [key, cell] of Object.entries(grid ?? {})) {
    if (baseStateOf(cell) !== 'ocupado') continue;
    const student = baseStudentOf(cell);
    if (!student) continue;
    const usc = key.lastIndexOf('_');
    if (usc < 0) continue;
    const day = key.slice(0, usc);
    const h = hourNum(key.slice(usc + 1));
    if (!GRID_DAY_ORDER.includes(day) || !Number.isFinite(h)) continue;
    const k = `${nkName(student)}|${day}`;
    const arr = gridHours.get(k);
    if (arr) arr.push(h); else gridHours.set(k, [h]);
  }

  // Slots → alumno|día → horas.
  const slotHours = new Map<string, number[]>();
  const nameOf = new Map<string, string>();
  for (const a of assignments) {
    if (a.teacherId !== teacher.id) continue;
    for (const s of a.slots ?? []) {
      const h = hourNum(s.hour);
      if (!Number.isFinite(h)) continue;
      const k = `${nkName(a.studentName)}|${s.day}`;
      nameOf.set(k, a.studentName);
      const arr = slotHours.get(k);
      if (arr) arr.push(h); else slotHours.set(k, [h]);
    }
  }

  const out: ContiguityMismatch[] = [];
  // Solo los alumnos presentes en LAS DOS fuentes: que un alumno falte entero de
  // una de ellas es otro problema (huérfanos / transferencias a medias), y ya
  // tiene su propia sección en la auditoría.
  for (const [k, slotsOf] of slotHours) {
    const gridOf = gridHours.get(k);
    if (!gridOf) continue;
    const gridDuration = maxRun(gridOf);
    const slotDuration = maxRun(slotsOf);
    if (gridDuration === slotDuration) continue;
    const [, day] = k.split('|');
    out.push({
      teacherId: teacher.id,
      teacherName: teacher.name,
      studentName: nameOf.get(k) ?? k.split('|')[0],
      day,
      gridHours: [...gridOf].sort((a, b) => a - b).map(hourText),
      slotHours: [...slotsOf].sort((a, b) => a - b).map(hourText),
      gridDuration,
      slotDuration,
    });
  }
  return out;
}

// ── Constancias que apagan una clase (cancelada / reprogramada) ───────────────

const CANCEL_TYPES = new Set<string>([
  'cancelada_con_preaviso', 'falta_sin_aviso', 'cancelacion_hora', 'falta_con_aviso',
  'cancelada_por_profesor',
]);

/** Si esa clase (alumno + fecha) se reprogramó, la fecha destino. */
export function rescheduledTargetFor(
  records: ClassRecord[], teacherId: string, studentName: string, dateIso: string,
): string | null {
  const rec = records.find(r =>
    r.teacherId === teacherId && !!r.rescheduledTo &&
    nk(r.studentName) === nk(studentName) && r.classDate === dateIso,
  );
  return rec?.rescheduledTo ?? null;
}

/**
 * Si esa clase se canceló, el tipo de la constancia. `rescheduledTargetFor` solo
 * mira los registros con `rescheduledTo`, que pone únicamente el flujo de
 * reprogramación: una cancelación crea un class_record SIN ese campo.
 */
export function cancellationFor(
  records: ClassRecord[], teacherId: string, studentName: string, dateIso: string,
): ClassRecordType | null {
  const rec = records.find(r =>
    r.teacherId === teacherId && !r.rescheduledTo &&
    CANCEL_TYPES.has(r.classType ?? '') &&
    nk(r.studentName) === nk(studentName) && r.classDate === dateIso,
  );
  return (rec?.classType as ClassRecordType) ?? null;
}

/** Etiqueta corta de una cancelación, para el badge de la clase. */
export function cancellationLabel(type: ClassRecordType | null): string {
  switch (type) {
    case 'falta_sin_aviso':  return 'Falta sin aviso';
    case 'cancelacion_hora': return 'Cancelada sobre la hora';
    case 'falta_con_aviso':  return 'Falta con aviso';
    case 'cancelada_por_profesor': return 'Cancelada sin antelación';
    default:                 return 'Cancelada';
  }
}

// ── Transcript de una clase ───────────────────────────────────────────────────

/**
 * Transcript ya guardado para esa clase concreta (mismo profesor, mismo alumno,
 * MISMA fecha). Se exige la fecha exacta a propósito: todos los flujos de subida
 * guardan `class_date` con la fecha de la clase, y una tolerancia de ±1 día
 * marcaría como "ya subido" al vecino de un alumno con clases en días seguidos
 * — el peor error posible acá, porque el profesor dejaría de subirlo y la clase
 * no le contaría para el pago.
 */
export function transcriptForClass(
  analyses: ClassTranscriptRef[], teacherId: string, studentName: string, dateIso: string,
): ClassTranscriptRef | undefined {
  const name = nk(studentName);
  return analyses.find(t =>
    (!t.teacher_id || t.teacher_id === teacherId) &&
    nk(t.student_name) === name &&
    (t.class_date || (t.analyzed_at ?? '').slice(0, 10)) === dateIso &&
    // `has_transcript` (columna generada) cuando viene; el texto solo como
    // respaldo para bases sin supabase-has-transcript.sql.
    (typeof t.has_transcript === 'boolean' ? t.has_transcript : !!t.transcript && t.transcript.trim().length > 0),
  );
}
