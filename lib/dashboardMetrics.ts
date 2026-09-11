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
// Para los tres números que solo ve el teléfono (al final del archivo): el
// origen del acceso y los planes que terminan, con las mismas reglas que el
// resto de la app.
import { accessOverrideOf } from '@/lib/subscriptionAccess';
import { buildEndingPlans, ENDING_NOTICE_DAYS, type EndingStudentRow } from '@/lib/endingPlans';

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
 * LAS REGLAS SON LAS DE `lib/pendingClasses`, que es donde vive este cruce desde
 * antes y lo que ve el profesor en su ficha. Un ingreso está cubierto si:
 *
 *   1. algún análisis lo referencia por `join_log_id` — el vínculo explícito, y
 *      hoy lo tienen 1.148 de 1.460 análisis;
 *   2. o hay un transcript del mismo alumno a ±1 día, que se CONSUME. Es el
 *      respaldo para las clases anteriores al vínculo. Sin consumirlo, un
 *      transcript del lunes taparía también la clase del martes.
 *
 * ACOTADO A UNA VENTANA, y esto es lo que lo hace un número accionable. Sin
 * ventana cuenta todo el histórico, y el histórico arrastra: en septiembre de
 * 2026 había 424 ingresos con 46 sin transcript, pero julio (318 ingresos, 114
 * análisis) y agosto (1.514 y 1.035) sumaban 900 "pendientes" de meses ya
 * liquidados. Un profesor aparecía con 99 clases sin subir y ninguna era de este
 * mes.
 *
 * `desdeDias` es el margen antes de llamarlo retraso: una clase de las 20:00
 * subida a la mañana siguiente no es un problema.
 */
export function transcriptsPendientes(
  joinLogs: readonly ClassJoinLog[],
  analyses: readonly ClassTranscriptRef[],
  opts: { hoy?: string; desdeDias?: number; desde?: string } = {},
): TranscriptPendiente[] {
  const hoy = opts.hoy ?? madridDateString();
  const margen = opts.desdeDias ?? 1;
  const desde = opts.desde ?? `${hoy.slice(0, 7)}-01`;   // por defecto, el mes en curso

  const tieneTexto = (a: ClassTranscriptRef): boolean =>
    typeof a.has_transcript === 'boolean' ? a.has_transcript : !!(a.transcript ?? '').trim();

  // 1. Vínculos explícitos.
  const vinculados = new Set<string>();
  for (const a of analyses) {
    const id = a.join_log_id;
    if (id) vinculados.add(id);
  }

  // 2. Transcripts sin vínculo, por alumno, para consumir por cercanía de fecha.
  const libresPorAlumno = new Map<string, string[]>();
  for (const a of analyses) {
    if (!tieneTexto(a) || a.join_log_id) continue;
    const fecha = a.class_date || (a.analyzed_at ?? '').slice(0, 10);
    if (!fecha) continue;
    const k = norm(a.student_name);
    const l = libresPorAlumno.get(k);
    if (l) l.push(fecha); else libresPorAlumno.set(k, [fecha]);
  }

  // AGRUPADO por profesor, alumno y fecha: eso es UNA clase, por muchos ingresos
  // que tenga. El botón "Ingresar a clase" se puede pulsar dos veces y se pulsa:
  // en la base hay 509 ingresos de más por duplicado, 93 solo en septiembre de
  // 2026 sobre 424. Contando ingresos sueltos, uno de cada cinco pendientes era
  // el mismo clic repetido.
  const grupos = new Map<string, ClassJoinLog[]>();
  for (const l of joinLogs) {
    if (l.scheduledDate < desde || l.scheduledDate > hoy) continue;
    const k = `${l.teacherId}|${norm(l.studentName)}|${l.scheduledDate}`;
    const g = grupos.get(k);
    if (g) g.push(l); else grupos.set(k, [l]);
  }

  // Del más antiguo al más nuevo: el respaldo por cercanía se consume en orden, o
  // el transcript de una clase taparía el de otra arbitrariamente.
  const enOrden = [...grupos.values()]
    .sort((a, b) => a[0].scheduledDate.localeCompare(b[0].scheduledDate));

  const out: TranscriptPendiente[] = [];
  for (const grupo of enOrden) {
    // Basta con que UNO de los ingresos del grupo tenga transcript vinculado.
    if (grupo.some(l => vinculados.has(l.id))) continue;

    const log = grupo[0];
    const libres = libresPorAlumno.get(norm(log.studentName)) ?? [];
    let i = libres.findIndex(d => d === log.scheduledDate);
    if (i < 0) i = libres.findIndex(d => Math.abs(diasEntre(d, log.scheduledDate)) <= 1);
    if (i >= 0) { libres.splice(i, 1); continue; }

    const dias = diasEntre(log.scheduledDate, hoy);
    if (dias < margen) continue;          // todavía está en plazo
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

// ── Lo que ve el teléfono ────────────────────────────────────────────────────
//
// Tres números que el escritorio no muestra y la vista móvil sí. Los tres salen
// de REGLAS PROVISIONALES, marcadas en docs/dashboard-propuesta.md como
// [DECISIÓN] pendiente. Están acá, puras y con test, para que cambiar la regla
// sea cambiar una función y no rebuscar en la pantalla.

/**
 * Alumnos con clase, repartidos por el origen de su acceso — SIN preguntarle a
 * WooCommerce. La regla es la misma precedencia que usa lib/subscriptionAccess
 * (Oritalk vigente → override manual vigente → lo demás), con una salvedad:
 * a quien no tiene override se lo cuenta como "suscripción" sin verificarla,
 * porque verificarla es una llamada de red por alumno.
 *
 * PROVISIONAL: "suscripción" acá significa "no es Oritalk ni manual", no
 * "Woo dice que está activo".
 */
export interface OrigenActivos { suscripcion: number; manual: number; oritalk: number }

export function origenDeActivos(
  students: readonly { id: string; name: string; manualActiveUntil?: string | null; isOritalk?: boolean | null; oritalkUntil?: string | null }[],
  assignments: readonly Assignment[],
  today: string,
): OrigenActivos {
  const conAsignacion = new Set<string>();
  for (const a of assignments) conAsignacion.add(a.studentId || norm(a.studentName));

  const out: OrigenActivos = { suscripcion: 0, manual: 0, oritalk: 0 };
  for (const s of students) {
    if (!conAsignacion.has(s.id) && !conAsignacion.has(norm(s.name))) continue;
    const override = accessOverrideOf({
      manual_active_until: s.manualActiveUntil ?? null,
      is_oritalk: s.isOritalk ?? null,
      oritalk_until: s.oritalkUntil ?? null,
    }, today);
    if (override?.kind === 'oritalk') out.oritalk += 1;
    else if (override?.kind === 'manual') out.manual += 1;
    else out.suscripcion += 1;
  }
  return out;
}

/**
 * Altas y bajas de los últimos `meses` meses (el último es `mes`), para la mini
 * tendencia del teléfono.
 *
 * PROVISIONAL — qué es un alta: el mes en que se creó la PRIMERA asignación del
 * alumno. Se mira la primera y no cada una porque un cambio de profesor crea
 * otra asignación y no es un alumno nuevo. La alternativa (la primera clase
 * registrada) suele caer una o dos semanas después.
 *
 * Las bajas se cuentan como en `bajasDelMes` (filas de student_dropouts), para
 * que el mes en curso dé el mismo número que la tarjeta del escritorio.
 */
export interface MovimientoMes { mes: string; altas: number; bajas: number }

export function movimientoMensual(
  assignments: readonly Assignment[],
  dropouts: readonly { droppedAt?: string }[],
  mes: string,
  meses = 6,
): MovimientoMes[] {
  const claves: string[] = [mes];
  while (claves.length < meses) claves.unshift(previousMonth(claves[0]));

  // Primera asignación de cada alumno → su mes de alta.
  const primera = new Map<string, string>();
  for (const a of assignments) {
    const k = a.studentId || norm(a.studentName);
    const m = (a.createdAt ?? '').slice(0, 7);
    if (!m) continue;
    const prev = primera.get(k);
    if (!prev || m < prev) primera.set(k, m);
  }
  const altasPorMes = new Map<string, number>();
  for (const m of primera.values()) altasPorMes.set(m, (altasPorMes.get(m) ?? 0) + 1);

  const bajasPorMes = new Map<string, number>();
  for (const d of dropouts) {
    const m = (d.droppedAt ?? '').slice(0, 7);
    if (m) bajasPorMes.set(m, (bajasPorMes.get(m) ?? 0) + 1);
  }

  return claves.map(k => ({ mes: k, altas: altasPorMes.get(k) ?? 0, bajas: bajasPorMes.get(k) ?? 0 }));
}

/**
 * Alumnos cuyo plan termina en `ventanaDias` días y todavía no tienen contacto
 * manual de ventas en este ciclo.
 *
 * PROVISIONAL — "sin contactar" = sin marca de ventas (`salesContactForCycle`).
 * El aviso automático del sistema NO cuenta como contacto: lo manda un cron y
 * no quita a nadie de la lista de llamadas.
 */
export function proximosSinContactar(
  students: readonly EndingStudentRow[],
  today: string,
  ventanaDias = ENDING_NOTICE_DAYS,
): number {
  return buildEndingPlans({ students: [...students], today, windowDays: ventanaDias })
    .filter(p => !p.salesContact).length;
}
