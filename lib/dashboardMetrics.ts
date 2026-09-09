// Los números del dashboard general, como funciones PURAS.
//
// Viven acá y no dentro del componente por dos razones. La primera es que se
// pueden probar: cada uno de estos números aparece en una tarjeta que alguien va
// a mirar para decidir a quién llamar, y un conteo mal hecho ahí no se nota
// nunca. La segunda es que casi todos son "filtrá esta lista y contá", que es
// justo el tipo de código que se copia mal.
//
// EGRESS: ninguna de estas funciones consulta nada. Trabajan sobre lo que el
// contexto `useTeachers` ya tiene cargado desde que arranca la app —profesores,
// alumnos, asignaciones, clases, ingresos, análisis, tarifas y eventos de
// scoring—, así que pintar el dashboard no cuesta una sola consulta nueva.

import type { Assignment, ClassJoinLog, ClassRecord, ScoringEvent, Teacher } from '@/types';
import type { ClassTranscriptRef } from '@/lib/finance';
// Qué clase perdida conserva el derecho a recuperarse NO se decide acá: es la
// regla de lib/recovery, la misma que aplica el profesor al registrar una
// recuperación. Una falta sin aviso o una cancelación sobre la hora se le
// cobraron al alumno, así que no están pendientes de nada.
import { RECUPERABLES } from '@/lib/recovery';

const norm = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

// ── Ventanas de tiempo ───────────────────────────────────────────────────────
//
// Las clases se dan en horario de Madrid (los profesores están en Argentina,
// pero la academia opera en España), así que la semana y el mes se cortan por el
// calendario español. Se trabaja con la fecha en texto 'YYYY-MM-DD', que es como
// la guarda `class_records`: comparar cadenas evita construir Dates con zona,
// que es de donde salen los errores de un día.

export function madridDateString(now: Date = new Date()): string {
  // 'en-CA' da 'YYYY-MM-DD', que es el formato en el que están guardadas las fechas.
  return now.toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
}

export interface DateRange { from: string; to: string }

/**
 * La semana en curso, de LUNES a DOMINGO en hora de Madrid, con los dos extremos
 * incluidos.
 *
 * Lunes y no domingo porque es como se lee una semana de trabajo: el lunes por la
 * mañana el contador tiene que estar a cero, no a mitad.
 */
export function weekRange(now: Date = new Date()): DateRange {
  const hoy = madridDateString(now);
  const d = new Date(`${hoy}T00:00:00Z`);
  // getUTCDay: 0 = domingo. Se convierte a "días desde el lunes".
  const desdeLunes = (d.getUTCDay() + 6) % 7;
  const lunes = new Date(d.getTime() - desdeLunes * 86_400_000);
  const domingo = new Date(lunes.getTime() + 6 * 86_400_000);
  return { from: lunes.toISOString().slice(0, 10), to: domingo.toISOString().slice(0, 10) };
}

export function monthKey(now: Date = new Date()): string {
  return madridDateString(now).slice(0, 7);
}

/** El mes anterior a `key` ('2026-09' → '2026-08'). */
export function previousMonth(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

const inRange = (date: string, r: DateRange) => date >= r.from && date <= r.to;

// ── Clases ───────────────────────────────────────────────────────────────────

/**
 * Tipos de registro que son UNA CLASE DADA.
 *
 * `recuperacion` cuenta: es una clase que se dio, aunque salde otra anterior. Las
 * faltas, cancelaciones y reprogramaciones NO: son registros de una clase que no
 * ocurrió. La lista es explícita a propósito — con un `!== 'falta_sin_aviso'`,
 * cada tipo nuevo entraría solo en el conteo de clases dadas.
 */
const CLASES_DADAS: ReadonlySet<string> = new Set(['normal', 'recuperacion']);

export function esClaseDada(r: Pick<ClassRecord, 'classType'>): boolean {
  return CLASES_DADAS.has(r.classType ?? 'normal');
}

export interface OperacionMes {
  /** Clases efectivamente dadas en el mes. */
  dadas: number;
  /** Faltas del alumno sin aviso, descontando las que el admin revirtió. */
  faltasSinAviso: number;
  /** Todo lo que no se dio: faltas, cancelaciones y reprogramaciones. */
  noDadas: number;
  /** Clases marcadas como recuperación de otra anterior. */
  recuperaciones: number;
  /**
   * Clases perdidas que CONSERVAN el derecho a recuperarse y todavía no tienen
   * una recuperación que las salde. Solo cuentan las de `RECUPERABLES`: una falta
   * sin aviso no está "pendiente", está cobrada.
   */
  recuperacionesPendientes: number;
}

/**
 * El pulso del mes en una pasada.
 *
 * `recuperacionesPendientes` cruza las clases perdidas con las recuperaciones que
 * las saldan: `recoveryForDate` apunta a la fecha de la clase original, así que
 * una perdida está pendiente mientras nadie la señale.
 */
export function operacionDelMes(records: readonly ClassRecord[], mes: string): OperacionMes {
  const delMes = records.filter(r => (r.classDate ?? '').slice(0, 7) === mes);

  const saldadas = new Set<string>();
  for (const r of records) {
    if (r.classType === 'recuperacion' && r.recoveryForDate) {
      saldadas.add(`${norm(r.studentName)}|${r.recoveryForDate}`);
    }
  }

  let dadas = 0, faltasSinAviso = 0, noDadas = 0, recuperaciones = 0, pendientes = 0;
  for (const r of delMes) {
    const tipo = r.classType ?? 'normal';
    if (esClaseDada(r)) dadas += 1;
    if (tipo === 'recuperacion') recuperaciones += 1;
    if (tipo === 'falta_sin_aviso') faltasSinAviso += 1;

    // La marca de una falta revertida no es una clase: la fila se conserva solo
    // para dejar rastro de quién la deshizo.
    if (!esClaseDada(r) && tipo !== 'falta_sin_aviso_revertida') noDadas += 1;

    if (RECUPERABLES.has(tipo) && !saldadas.has(`${norm(r.studentName)}|${r.classDate}`)) {
      pendientes += 1;
    }
  }
  return { dadas, faltasSinAviso, noDadas, recuperaciones, recuperacionesPendientes: pendientes };
}

/** Clases dadas dentro de un rango de fechas (para "esta semana"). */
export function clasesEnRango(records: readonly ClassRecord[], r: DateRange): number {
  return records.filter(x => esClaseDada(x) && inRange(x.classDate ?? '', r)).length;
}

/**
 * Clases que el calendario dice que TOCAN en una semana.
 *
 * Sale de los horarios de las asignaciones (`slots`), no de los registros: es lo
 * que estaba previsto, contra lo que se compara lo que efectivamente se dio.
 */
export function clasesProgramadasSemana(assignments: readonly Assignment[]): number {
  return assignments.reduce((s, a) => s + (a.slots?.length ?? 0), 0);
}

// ── Transcripts pendientes ───────────────────────────────────────────────────

export interface TranscriptPendiente {
  teacherId: string;
  teacherName: string;
  studentName: string;
  fecha: string;
  dias: number;
}

/**
 * Clases a las que el profesor ENTRÓ y que siguen sin transcript.
 *
 * Se cruzan los ingresos con los análisis por alumno y fecha, que es el mismo
 * emparejamiento tolerante que usa el resto del sistema. `desdeDias` es el margen
 * antes de considerarlo un retraso: una clase de las 20:00 subida a la mañana
 * siguiente no es un problema.
 */
export function transcriptsPendientes(
  joinLogs: readonly ClassJoinLog[],
  analyses: readonly ClassTranscriptRef[],
  opts: { hoy?: string; desdeDias?: number } = {},
): TranscriptPendiente[] {
  const hoy = opts.hoy ?? madridDateString();
  const margen = opts.desdeDias ?? 1;

  const conTranscript = new Set<string>();
  for (const a of analyses) {
    if (a.has_transcript === false) continue;
    conTranscript.add(`${norm(a.student_name)}|${a.class_date ?? ''}`);
  }

  const vistos = new Set<string>();
  const out: TranscriptPendiente[] = [];
  for (const log of joinLogs) {
    const clave = `${norm(log.studentName)}|${log.scheduledDate}`;
    if (conTranscript.has(clave) || vistos.has(clave)) continue;
    const dias = diasEntre(log.scheduledDate, hoy);
    if (dias < margen) continue;          // todavía está en plazo
    vistos.add(clave);
    out.push({
      teacherId: log.teacherId, teacherName: log.teacherName,
      studentName: log.studentName, fecha: log.scheduledDate, dias,
    });
  }
  return out.sort((a, b) => b.dias - a.dias);
}

export function diasEntre(desde: string, hasta: string): number {
  const a = new Date(`${desde}T00:00:00Z`).getTime();
  const b = new Date(`${hasta}T00:00:00Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

// ── Ocupación ────────────────────────────────────────────────────────────────

export interface Ocupacion { ocupados: number; total: number; pct: number }

/**
 * Cuánto del calendario está vendido.
 *
 * `totalSpots` son las horas que el profesor tiene abiertas y `freeSpots` las que
 * le quedan libres, los dos ya calculados en el contexto. Un profesor sin
 * calendario abierto no entra: contarlo con cero cupos hundiría el porcentaje sin
 * que signifique nada.
 */
export function ocupacionDe(teachers: readonly Teacher[]): Ocupacion {
  const conCalendario = teachers.filter(t => (t.totalSpots ?? 0) > 0);
  const total = conCalendario.reduce((s, t) => s + t.totalSpots, 0);
  const libres = conCalendario.reduce((s, t) => s + t.freeSpots, 0);
  const ocupados = total - libres;
  return { ocupados, total, pct: total > 0 ? Math.round((ocupados / total) * 100) : 0 };
}

/**
 * Umbrales del semáforo de ocupación.
 *
 * PENDIENTE DE DECISIÓN: 75/60 son una propuesta, no una política acordada. Están
 * acá, con nombre, para que cambiarlos sea editar dos números y no buscar
 * comparaciones sueltas por el componente.
 */
export const OCUPACION_OK = 75;
export const OCUPACION_AVISO = 60;

export function tonoOcupacion(pct: number): 'ok' | 'aviso' | 'alerta' {
  if (pct >= OCUPACION_OK) return 'ok';
  if (pct >= OCUPACION_AVISO) return 'aviso';
  return 'alerta';
}

// ── Profesores ───────────────────────────────────────────────────────────────

export interface FilaProfesor {
  teacherId: string;
  teacherName: string;
  clases: number;
  cuposLibres: number;
  transcriptsPendientes: number;
  usaIA: boolean;
}

/**
 * Una fila por profesor con lo que se mira de un vistazo: cuánto trabajó,
 * cuánto le queda libre, qué arrastra y si usa la herramienta de IA.
 *
 * Ordenada por clases, de más a menos. Se devuelven TODOS: quién no aparece en el
 * ranking es tan informativo como quién encabeza, y recortar la lista es decisión
 * de la pantalla.
 */
export function filasProfesores(args: {
  teachers: readonly Teacher[];
  records: readonly ClassRecord[];
  mes: string;
  pendientes: readonly TranscriptPendiente[];
  teacherIdsConIA: ReadonlySet<string>;
}): FilaProfesor[] {
  const clasesPorProfe = new Map<string, number>();
  for (const r of args.records) {
    if (!esClaseDada(r) || (r.classDate ?? '').slice(0, 7) !== args.mes) continue;
    clasesPorProfe.set(r.teacherId, (clasesPorProfe.get(r.teacherId) ?? 0) + 1);
  }

  const pendPorProfe = new Map<string, number>();
  for (const p of args.pendientes) {
    pendPorProfe.set(p.teacherId, (pendPorProfe.get(p.teacherId) ?? 0) + 1);
  }

  return args.teachers
    .map(t => ({
      teacherId: t.id,
      teacherName: t.name,
      clases: clasesPorProfe.get(t.id) ?? 0,
      cuposLibres: t.freeSpots ?? 0,
      transcriptsPendientes: pendPorProfe.get(t.id) ?? 0,
      usaIA: args.teacherIdsConIA.has(t.id),
    }))
    .sort((a, b) => b.clases - a.clases || a.teacherName.localeCompare(b.teacherName, 'es'));
}

// ── Faltas del profesor ──────────────────────────────────────────────────────

/**
 * Penalizaciones del mes por cancelar con menos de 24 h, sin las revertidas.
 * Son eventos de scoring, no registros de clase: la falta del ALUMNO se cuenta
 * en `operacionDelMes`.
 */
export function faltasProfesorDelMes(events: readonly ScoringEvent[], mes: string): number {
  return events.filter(e =>
    e.eventType === 'falta_sin_aviso_penalizacion' &&
    (e.createdAt ?? '').slice(0, 7) === mes &&
    !e.reverted,
  ).length;
}

// ── Alumnos ──────────────────────────────────────────────────────────────────

export interface AlumnosResumen { conClase: number; total: number; sinProfesor: number }

/**
 * Alumnos que hoy tienen clase con alguien.
 *
 * NO es "alumnos activos" en el sentido de la suscripción: eso lo decide
 * `lib/subscriptionAccess` y necesita WooCommerce. Esto es lo que la base sabe
 * por sí sola —cuántos tienen una asignación— y se etiqueta como tal en pantalla
 * para que nadie lo lea como el otro número.
 */
export function alumnosResumen(
  students: readonly { id: string; name: string }[],
  assignments: readonly Assignment[],
): AlumnosResumen {
  const conAsignacion = new Set<string>();
  for (const a of assignments) {
    conAsignacion.add(a.studentId || norm(a.studentName));
  }
  const sinProfesor = students.filter(s =>
    !conAsignacion.has(s.id) && !conAsignacion.has(norm(s.name)),
  ).length;
  return { conClase: conAsignacion.size, total: students.length, sinProfesor };
}
