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

/** FUENTE 1: slots recurrentes que caen en la fecha, ordenados por hora. */
export function classesForDate(assignments: Assignment[], dateIso: string): TeacherClass[] {
  const dayName = dayNameFromIso(dateIso);
  const list: TeacherClass[] = [];
  for (const a of assignments) {
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

/** Horas ocupadas en el CALENDARIO, por alumno y día. */
export interface GridOccupancy {
  /** `${alumno normalizado}|${día}` → horas ocupadas. */
  hours: Map<string, number[]>;
}

export function gridOccupancyOfTeacher(
  teacher: { upcomingClasses?: Array<{ studentName: string; day: string; time: string }> } | null | undefined,
): GridOccupancy {
  const hours = new Map<string, number[]>();
  for (const c of teacher?.upcomingClasses ?? []) {
    const h = hourNum(c.time);
    if (!Number.isFinite(h)) continue;
    const k = `${nkName(c.studentName)}|${c.day}`;
    const arr = hours.get(k);
    if (arr) arr.push(h); else hours.set(k, [h]);
  }
  return { hours };
}

/** Ocupación vacía: para los llamadores que aún no tienen el calendario a mano. */
export const EMPTY_GRID_OCCUPANCY: GridOccupancy = { hours: new Map() };

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
  /** Lo que vale la sesión para el pago y para el límite mensual. = durationHours. */
  billingUnits: number;
  /** Horas que la componen, en orden: ['17:00', '18:00']. */
  hours: string[];
  /** Las clases de 1h originales, por si alguna vista necesita el detalle. */
  parts: TeacherClass[];
}

/**
 * ¿Estas dos clases de 1h pertenecen a la misma sesión? (la contigüidad horaria
 * la comprueba `groupByContiguousHour` aparte).
 *
 * NO se fusiona una clase recurrente con una recuperación aunque estén pegadas:
 * la recuperación tiene identidad propia (`recoveryFor`: qué clase repone) y su
 * propio tipo en class_records. Fundirlas perdería ese vínculo y registraría como
 * 'normal' una hora que es de recuperación. Dos recuperaciones contiguas del
 * mismo alumno SÍ son una sesión de 2h (es el caso real de Cristina Montoro el
 * 29/07: dos registros de recuperación a las 14:00 y 15:00).
 */
function sameSessionClass(a: TeacherClass, b: TeacherClass): boolean {
  return a.date === b.date
    && nkName(a.studentName) === nkName(b.studentName)
    && !!a.isRecovery === !!b.isRecovery;
}

/** Convierte una racha de clases contiguas en la sesión que representan. */
function toSession(run: TeacherClass[], teacherId: string): TeacherSession {
  const first = run[0];
  const start = hourNum(first.hour);
  const duration = run.length;
  return {
    // Se conserva la `key` de la primera hora: es única y ya la usan las vistas
    // como identidad de fila (spinner de "Ingresar a clase", "próxima clase"…).
    ...first,
    sessionId:    sessionIdOf(teacherId, first.studentName, first.date, start),
    startHourNum: start,
    endHourNum:   start + duration,
    durationHours: duration,
    billingUnits: duration,
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
        if (a.isRecovery) return true;

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
    !!t.transcript && t.transcript.trim().length > 0,
  );
}
