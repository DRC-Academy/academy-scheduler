// Lógica de cálculo de finanzas (liquidación de clases a profesores).
//
// Funciona sobre datos ya cargados en memoria (assignments, class_join_logs,
// class_records, finance_rates, scoring_events, students, manual_approvals) para
// poder correr tanto en el panel del profesor como en el del admin sin llamadas
// extra a la base.
//
// REGLA DE DOS NIVELES. Son dos preguntas distintas y en este orden:
//
//   NIVEL 1 — ¿la clase ENTRA a finanzas?  Lo decide el CLIC en "Unirse a clase".
//     · Con class_join_log (teacher + alumno + fecha) → entra.
//     · Sin él → NO EXISTE para el pago: no aparece en el listado del profesor ni
//       en el del admin, ni siquiera como pendiente. Un registro de "Añadir clase"
//       o un transcript sueltos NO crean una clase: solo se pegan a una que ya
//       entró por su ingreso.
//     · ÚNICA excepción: 'falta_sin_aviso' y 'cancelacion_hora'. El alumno no
//       vino, así que no puede haber ingreso que las respalde; su entrada es el
//       registro que el profesor crea a mano (Añadir clase / cancelar la clase).
//
//   NIVEL 2 — de las que entraron, ¿cuáles se PAGAN?  El transcript o la FALTA.
//     · Clic + transcript validado → 'pagable' ✅ suma al total.
//     · Clic + falta sin aviso del alumno → 'pagable' ✅ a tarifa normal. El
//       profesor entró y el alumno no se presentó: no hay clase que transcribir,
//       pero él cumplió. Máximo 2 por alumno y MES (ver ABSENCE_MONTHLY_CAP).
//     · Clic sin transcript válido → 'a_revisar' ⚠️ ("pendiente de transcript"):
//       visible y contabilizada como dada, pero NO suma al total. Al subir el
//       transcript pasa sola a 'pagable'.
//
//   Y encima de los dos niveles, lo de siempre:
//     · Aprobada manualmente por el admin → 'pagable' (override). Solo puede
//       aprobar lo que ENTRÓ: sin clic no hay fila que aprobar.
//     · Supera el límite mensual del plan → 'excede_limite' (salvo aprobación).
//     · Falta/cancelación más allá de las 2 cobrables de su tipo →
//       'excede_limite_tipo'.

import { Assignment, ClassJoinLog, ClassRecord, FinanceRate, ScoringEvent, FinancePayment, Student, ClassRecordType, FinanceManualApproval } from '@/types';
import { classifyPlan, classifyFor, planBadgeStyle, type PlanClassification } from '@/lib/productUtils';
import { contiguousRunLength, hourNum, hourText, nkName, runStartHour, sessionRangeLabel } from '@/lib/sessions';
// Qué estado de suscripción da acceso (y cómo se llama) es UNA sola decisión,
// compartida con el badge de los alumnos y con el popup de ingreso.
import { WOO_STATUS, isActiveWooStatus, wooStatusMeta } from '@/lib/subscriptionAccess';
// Solo el TIPO: teacherClasses importa a su vez el tipo ClassTranscriptRef de acá,
// y los `import type` se borran al compilar, así que no hay ciclo en runtime.
import type { GridOccupancy } from '@/lib/teacherClasses';
import { recoveryHoursOn, recoveryPartOfSession } from '@/lib/teacherClasses';

const DAY_NAMES_BY_JSDAY = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

const MONTHLY_LIMIT_BY_WEEKLY_HOURS: Record<number, number> = { 1: 5, 2: 9, 3: 14, 4: 18, 5: 25 };
function monthlyLimit(weeklyHours: number): number {
  return MONTHLY_LIMIT_BY_WEEKLY_HOURS[weeklyHours] ?? Math.max(5, weeklyHours * 5);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Falta sin aviso DEL ALUMNO ────────────────────────────────────────────────
//
// El profesor entró (hay ingreso) y el alumno no se presentó. No hay clase que
// transcribir, así que esta marca es la TERCERA vía —junto al transcript y a la
// aprobación manual— para que una clase que ya entró pase a pagable.
//
// OJO con el nombre: el scoring_event 'falta_sin_aviso_penalizacion' (-5 €) era
// el descuento que se le aplicaba al PROFESOR por este mismo registro. Estaba al
// revés (el que faltó fue el alumno) y ya no se emite; ver dbApplyFaltaSideEffects.
// Este tipo de clase SUMA dinero, nunca resta.

/** Máximo de faltas del alumno cobrables por alumno y MES. */
export const ABSENCE_MONTHLY_CAP = 2;

/** Registro mínimo de class_records que necesita el conteo de faltas. */
interface AbsenceRecordRef {
  id: string;
  teacherId: string;
  studentName: string;
  classDate: string;
  classType?: ClassRecordType;
  createdAt?: string;
}

/** ¿Es una falta del alumno vigente? Las revertidas por el admin no cuentan. */
export function isStudentAbsence(classType: ClassRecordType | undefined): boolean {
  return classType === 'falta_sin_aviso';
}

/** Filas crudas de falta del alumno en ese mes, de la más vieja a la más nueva. */
function absenceRowsInMonth<T extends AbsenceRecordRef>(
  records: T[], teacherId: string, studentName: string, monthYear: string,
): T[] {
  return records
    .filter(r =>
      r.teacherId === teacherId &&
      isStudentAbsence(r.classType) &&
      nkey(r.studentName) === nkey(studentName) &&
      (r.classDate ?? '').slice(0, 7) === monthYear)
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.classDate.localeCompare(b.classDate));
}

/**
 * Faltas del alumno en el mes AGRUPADAS POR FECHA, de la más vieja a la más
 * nueva. Cada grupo es UNA clase perdida, con todos los registros que la
 * describen.
 *
 * El tope de 2 cuenta CLASES, no filas. La misma clase puede tener varios
 * `class_records` de tipo 'falta_sin_aviso' —el profesor la marcó dos veces
 * porque la fila seguía diciendo "pendiente de transcript"— y contarlos por
 * separado le quemaba el cupo del mes: la auditoría de agosto de 2026 encontró 5
 * registros duplicados que dejaban a 3 alumnos falsamente en el tope, uno de
 * ellos con 3 marcas de una sola clase. Contar por fecha hace que esos
 * duplicados sean inofensivos sin tener que borrarlos: se conservan como
 * constancia de lo que pasó.
 */
export function studentAbsenceDatesInMonth<T extends AbsenceRecordRef>(
  records: T[], teacherId: string, studentName: string, monthYear: string,
): Array<{ date: string; records: T[] }> {
  const byDate = new Map<string, T[]>();
  for (const r of absenceRowsInMonth(records, teacherId, studentName, monthYear)) {
    const arr = byDate.get(r.classDate);
    if (arr) arr.push(r); else byDate.set(r.classDate, [r]);
  }
  // El Map conserva el orden de inserción, que es el de `absenceRowsInMonth`:
  // el primer grupo es el de la falta marcada antes.
  return [...byDate.entries()].map(([date, rows]) => ({ date, records: rows }));
}

/**
 * Faltas del alumno YA marcadas para ese alumno en ese mes: UNA por clase
 * perdida (la marca más antigua de cada fecha), de la más vieja a la más nueva.
 * FUENTE ÚNICA del tope: la usan el cálculo (para decidir cuáles son cobrables),
 * el botón del profesor, el aviso de "Añadir clase" y la pantalla de solicitudes
 * de revisión, de modo que lo que la pantalla promete y lo que el cálculo hace no
 * puedan discrepar.
 */
export function studentAbsencesInMonth<T extends AbsenceRecordRef>(
  records: T[], teacherId: string, studentName: string, monthYear: string,
): T[] {
  return studentAbsenceDatesInMonth(records, teacherId, studentName, monthYear).map(g => g.records[0]);
}

/**
 * ¿Puede el profesor marcar una falta más de ese alumno este mes? Devuelve
 * también el recuento para que el aviso diga el número exacto sin recontar.
 */
export function canMarkStudentAbsence<T extends AbsenceRecordRef>(
  records: T[], teacherId: string, studentName: string, monthYear: string,
): { allowed: boolean; count: number; remaining: number } {
  const count = studentAbsencesInMonth(records, teacherId, studentName, monthYear).length;
  return { allowed: count < ABSENCE_MONTHLY_CAP, count, remaining: Math.max(0, ABSENCE_MONTHLY_CAP - count) };
}

/** Aviso de tope alcanzado. Mismo texto en el botón del profesor y en el modal. */
export const ABSENCE_CAP_MESSAGE =
  `Este alumno ya tiene ${ABSENCE_MONTHLY_CAP} faltas sin aviso este mes. No se pueden cobrar más.`;

/**
 * Estado de la clase de cara al pago.
 *   'pagable'            → clic + transcript validado. Suma al total.
 *   'a_revisar'          → clic SIN transcript válido: "pendiente de transcript".
 *                          Visible y contada como dada, pero NO suma al total.
 *                          (La clave se llama así desde el principio y se guarda
 *                          en finance_manual_approvals.reason; se conserva para no
 *                          romper el histórico. La etiqueta que ve la gente sale
 *                          de `financeStatusBadge`.)
 *   'excede_limite'      → pasa el límite mensual del plan del alumno.
 *   'excede_limite_tipo' → falta/cancelación más allá de las 2 cobrables por tipo.
 * Las clases SIN clic no tienen estado: no llegan a existir (ver nivel 1).
 */
export type ClassFinanceStatus = 'pagable' | 'a_revisar' | 'excede_limite' | 'excede_limite_tipo' | 'no_cobrable';

export interface ClassFinanceRow {
  date: string;            // 'YYYY-MM-DD'
  hour: string;            // 'HH:MM'
  studentName: string;
  plan: string;            // plan resuelto (assignments → objetivo → students → 'Inglés general')
  // Categoría YA clasificada. La UI debe mostrar ESTO y no volver a clasificar:
  // antes la columna "Plan" de finanzas reclasificaba con menos campos que el
  // cálculo de la tarifa, así que la categoría en pantalla y el € de la fila de al
  // lado podían discrepar.
  planCategory: PlanClassification['type'];
  planLabel: string;       // displayName de la categoría ('Exámenes' / 'Intensivo' / …)
  weeklyHours: number;
  antiquityDays: number;
  rate: number;
  /**
   * Duración de la SESIÓN en horas: 2 si el alumno tiene dos celdas contiguas ese
   * día (17:00 + 18:00). Se deriva de la contigüidad, no hay columna que lo diga.
   */
  durationHours: number;
  /**
   * Lo que vale esta fila: `rate * billingUnits` y `billingUnits` unidades del
   * límite mensual. Una sesión de 2h es UN registro que vale 2, nunca dos filas
   * (ver el comentario de los candidatos, más abajo).
   */
  billingUnits: number;
  /**
   * Cuántas de las `billingUnits` son de RECUPERACIÓN (salen de las celdas
   * 'bloqueado' del calendario que caen dentro de la sesión).
   *
   * El profesor cobra las `billingUnits` completas —dio las horas—, pero el CUPO
   * MENSUAL del alumno solo consume `billingUnits - recoveryUnits`: la parte de
   * recuperación salda una clase que ya se había perdido, no gasta una del mes.
   * Un bloque de 2h "normal + recuperación" paga 2 y consume 1.
   */
  recoveryUnits: number;
  /** Fechas de las clases PERDIDAS que salda esta fila ('YYYY-MM-DD'). */
  recoveryForDates: string[];
  status: ClassFinanceStatus;
  classType: ClassRecordType;
  /**
   * id del class_record que ancló la fila, cuando lo hay. Lo necesita el admin
   * para revertir una falta del alumno marcada por error: sin él tendría que
   * volver a buscar la fila por alumno+fecha y podría deshacer la equivocada.
   */
  recordId?: string;
  hasJoinLog: boolean;
  // Segundo factor de verificación. Desde el cambio de sistema es el TRANSCRIPT
  // (class_analyses.transcript no vacío), no la captura de pantalla.
  hasTranscript: boolean;  // solo aplica a tipo normal/recuperacion
  /**
   * Estado real del transcript. `hasTranscript` es `transcriptState === 'ok'`;
   * la UI necesita los cuatro estados para no decirle al profesor que suba algo
   * que ya subió y está esperando validación.
   */
  transcriptState: TranscriptState;
  hasMeetLink: boolean;    // la assignment del alumno tiene meet_link definido
  punctuality?: 'on_time' | 'late' | 'very_late';
  manuallyApproved: boolean;
  subscriptionStatus?: string;  // efectivo: join log (momento de la clase) → record
  subAtJoin?: string;           // estado al ingresar (class_join_logs)
  subAtRecord?: string;         // estado al registrar la captura (class_records)
}

/**
 * Un estado de suscripción presente entre las clases pagables del mes, con
 * cuántas hubo. `countsAsActive` separa lo informativo (pending-cancel: el alumno
 * estaba al día) de lo que sí es una anomalía (on-hold, cancelled, expired).
 */
export interface SubStatusNote {
  status: string;
  label: string;
  count: number;
  countsAsActive: boolean;
}

export interface TeacherFinanceResult {
  teacherId: string;
  teacherName: string;
  monthYear: string;
  rows: ClassFinanceRow[];
  /** Cuentan CLASES (suma de billingUnits): una sesión de 2h suma 2. */
  totalPagable: number;
  /** Nº de filas/sesiones del mes. Difiere de los anteriores si hay clases de 2h. */
  totalSesiones: number;
  totalARevisar: number;
  totalExcedeLimite: number;
  totalExcedeLimiteTipo: number;
  totalNoCobrable: number;
  hasInactiveSubPayable: boolean; // alguna clase pagable tuvo suscripción SIN acceso
  /** Estados ≠ 'active' entre las clases pagables, con su recuento. Ver más abajo. */
  payableSubStatuses: SubStatusNote[];
  montoPagable: number;
  montoARevisar: number;
  montoRetenido: number;
  bonusFromScoring: number;
  penaltiesFromScoring: number;   // suma NEGATIVA de penalizaciones del mes (Bloque 4)
  totalAPagar: number;
  paymentStatus: 'pending' | 'paid';
  paidAt?: string;
  /** Cupo mensual por alumno, tal como quedó tras aplicarlo. Ver `StudentQuota`. */
  studentQuota: StudentQuota[];
}

/**
 * Cuántas clases del mes tiene el alumno y cuántas lleva gastadas.
 *
 * Los dos números YA existían dentro de `calculateTeacherFinance`: son los que
 * deciden qué fila pasa a 'excede_limite'. Se exponen —sin recalcular nada— para
 * que una pantalla pueda decir «3 de 9» en lugar de derivar el límite desde
 * `weeklyHours` por su cuenta, que es exactamente cómo dos vistas acaban
 * discrepando sobre el mismo alumno.
 *
 * `limit: null` = sin cupo. Es el caso del ex-alumno: ya no tiene assignment de
 * la que sacar las horas semanales, así que sus clases nunca exceden.
 *
 * `used` cuenta en UNIDADES y NO incluye las horas de recuperación (reponen una
 * clase perdida, no gastan una de este mes) ni las que quedaron fuera por
 * exceder. Puede superar a `limit` cuando el equipo aprobó clases a mano.
 */
export interface StudentQuota {
  /** Nombre normalizado (minúsculas, sin espacios sobrantes). Para buscar. */
  studentKey: string;
  /** Nombre tal como aparece en las clases. Para mostrar. */
  studentName: string;
  limit: number | null;
  used: number;
}

/**
 * El cupo de un alumno dentro de un mes ya calculado. La normalización del
 * nombre vive acá y no en cada pantalla: el emparejamiento tolerante es la clase
 * de detalle que, repetido en tres sitios, acaba dando tres respuestas.
 */
export function studentQuotaOf(
  result: Pick<TeacherFinanceResult, 'studentQuota'>,
  studentName: string,
): StudentQuota | null {
  const k = nkey(studentName);
  return result.studentQuota.find(q => q.studentKey === k) ?? null;
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysBetween(aIso: string, bIso: string): number {
  return Math.round((new Date(bIso + 'T00:00:00').getTime() - new Date(aIso + 'T00:00:00').getTime()) / DAY_MS);
}
function nkey(x: string): string { return (x ?? '').trim().toLowerCase(); }
function firstNonEmpty(...vals: Array<string | undefined>): string {
  for (const v of vals) { if (v && v.trim()) return v.trim(); }
  return '';
}

// Tipo de plan para finanzas. Delega en classifyPlan (ÚNICA fuente de verdad)
// para no duplicar la lógica de detección de exámenes.
export function resolvePlanType(plan: string, objetivo?: string): 'general' | 'examenes' {
  return classifyPlan({ assignmentPlan: plan, assignmentObjetivo: objetivo }).financeType;
}

function findRate(rates: FinanceRate[], planType: 'general' | 'examenes', tier: 'nuevo' | 'antiguo'): number {
  return rates.find(r => r.planType === planType && r.tier === tier)?.rate ?? 0;
}

// Hora del slot recurrente del alumno que cae en el día de `dateIso` (si la hay).
function slotHourForDate(a: Assignment | undefined, dateIso: string): string {
  if (!a) return '';
  const dayName = DAY_NAMES_BY_JSDAY[new Date(dateIso + 'T00:00:00').getDay()];
  return (a.slots ?? []).find(s => s.day === dayName)?.hour ?? '';
}

// Horas del horario recurrente de la FICHA para ese día de la semana. Ya NO
// decide la duración (eso lo hace el calendario): solo se usa como último
// horario conocido de un alumno que ya no está en el calendario, para que su
// historial no se recalcule a la baja.
function slotHoursForDate(a: Assignment | undefined, dateIso: string): number[] {
  if (!a) return [];
  const dayName = DAY_NAMES_BY_JSDAY[new Date(dateIso + 'T00:00:00').getDay()];
  return (a.slots ?? []).filter(s => s.day === dayName).map(s => hourNum(s.hour)).filter(Number.isFinite);
}

/**
 * Duración y hora de INICIO de la clase de ese alumno ese día. Tres fuentes, y se
 * toma la MAYOR porque cada una cubre un caso que la otra no ve:
 *   · el horario recurrente (assignment.slots) → la sesión fija de 2h del alumno,
 *     aunque ese día el profesor solo haya registrado un ingreso;
 *   · las celdas de RECUPERACIÓN de esa fecha (occupancy.recoveries) → la hora
 *     que el alumno recupera pegada a su clase normal. Son marcas puntuales de
 *     una semana y por eso no están en la ocupación recurrente: sin ellas un
 *     bloque de 2h "normal + recuperación" se pagaba como UNA sola hora;
 *   · las horas realmente observadas (ingresos + registros de esa fecha) → las
 *     clases fuera de horario, que no están en los slots.
 * Ambas exigen contigüidad REAL: dos clases sueltas el mismo día (14:00 y 18:00)
 * siguen valiendo 1, porque un único acceso no puede dar fe de las dos.
 *
 * El inicio se recalcula a partir de la racha y NO se hereda del dato que ancló la
 * fila: con dos ingresos (14:00 y 15:00) el que queda guardado es el último, y la
 * sesión se habría mostrado como "15:00 - 17:00" en vez de "14:00 - 16:00".
 */
function sessionSpanFor(
  a: Assignment | undefined, dateIso: string, anchorHour: string, observed: Set<number>,
  occupancy: GridOccupancy,
): { durationHours: number; startHour: string } {
  const anchor = hourNum(anchorHour);
  if (!Number.isFinite(anchor)) return { durationHours: 1, startHour: anchorHour };

  // Horas de RECUPERACIÓN de ese alumno en esa FECHA. También son calendario
  // (celdas 'bloqueado' que puso el profesor), solo que puntuales de esa semana,
  // así que se suman a la ocupación recurrente en todas las ramas de abajo. Es lo
  // que permite ver el bloque "normal 17:00 + recuperación 18:00" como una sesión
  // de 2h en vez de como una clase de 1h con una hora regalada.
  const recHours = recoveryHoursOn(occupancy, a?.studentName ?? '', dateIso).map(r => r.hour);

  // 1) EL CALENDARIO MANDA. Si el alumno tiene horario en el grid ese día, su
  //    palabra es definitiva: la ficha puede haberse quedado vieja (el profesor
  //    acordó otro horario y se cambió el calendario), y pagar 2 horas que el
  //    calendario no tiene ocupadas es cobrar de más.
  const day = DAY_NAMES_BY_JSDAY[new Date(dateIso + 'T00:00:00').getDay()];
  const gridHours = occupancy.hours.get(`${nkName(a?.studentName ?? '')}|${day}`);
  if ((gridHours && gridHours.length > 0) || recHours.length > 0) {
    const calendarHours = [...(gridHours ?? []), ...recHours];
    const len = contiguousRunLength(calendarHours, anchor);
    // Si la hora no está en el calendario (len 0) la clase existió igual — hay
    // ingreso o registro — pero como sesión de una hora: el grid no la respalda.
    if (len > 0) return { durationHours: len, startHour: hourText(runStartHour(calendarHours, anchor)) };
    return { durationHours: 1, startHour: hourText(anchor) };
  }

  // 2) El alumno SÍ está en el calendario, pero no ese día: es una clase fuera de
  //    su horario. Manda lo observado (ingresos y registros).
  const sigueEnElGrid = [...occupancy.hours.keys()].some(k => k.startsWith(`${nkName(a?.studentName ?? '')}|`));
  if (sigueEnElGrid) {
    const len = contiguousRunLength([...observed], anchor);
    return len > 1
      ? { durationHours: len, startHour: hourText(runStartHour([...observed], anchor)) }
      : { durationHours: 1, startHour: hourText(anchor) };
  }

  // 3) El alumno YA NO ESTÁ en el calendario (lo sacaron, se dio de baja). El grid
  //    no puede describir un pasado que ya no contiene, así que para el HISTÓRICO
  //    vale su último horario conocido: la ficha.
  //
  //    Sin esto, sacar a alguien del calendario le recortaba al profesor lo ya
  //    ganado: sus sesiones de 2h pasaban a valer 1 retroactivamente. Y lo
  //    observado no lo salva, porque una sesión de 2h deja UN solo acceso — que es
  //    justamente el diseño.
  const historico = [slotHoursForDate(a, dateIso), [...observed]];
  let durationHours = 1;
  let start = anchor;
  for (const hours of historico) {
    const len = contiguousRunLength(hours, anchor);
    if (len > durationHours) { durationHours = len; start = runStartHour(hours, anchor); }
  }
  return { durationHours, startHour: hourText(start) };
}

/**
 * Fila de class_analyses tal como llega de Supabase (snake_case). Se declara
 * acá con los campos MÍNIMOS que usa el cálculo para no acoplar finance.ts al
 * módulo de IA: cualquier ClassAnalysisRow encaja estructuralmente.
 */
export interface ClassTranscriptRef {
  /**
   * id de la fila. El cálculo no lo usa, pero sí la pantalla de solicitudes de
   * revisión: cuando una clase ya tiene transcript, la solicitud se engancha a
   * ESE análisis en vez de pedirle al profesor que lo vuelva a pegar.
   */
  id?: string | null;
  teacher_id?: string | null;
  student_name: string;
  class_date?: string | null;
  analyzed_at?: string | null;
  /**
   * ¿Hay transcripción? Columna GENERADA por Postgres desde el texto
   * (supabase-has-transcript.sql). Es lo que piden los listados: el cálculo solo
   * necesita saber si existe, y el texto pesa 30 KB de media por fila.
   * `undefined` = la migración no se corrió y la consulta cayó al texto.
   */
  has_transcript?: boolean | null;
  /**
   * El TEXTO. Solo lo trae la lectura explícita del admin en Validación. En los
   * listados llega siempre `undefined`: ver hasText().
   */
  transcript?: string | null;
  /** Ingreso al que pertenece este transcript. Cuando viene, manda sobre la fecha. */
  join_log_id?: string | null;
  /** Validación (Bloque 1): 'review'/'rejected' NO valen como segundo factor. */
  validation_status?: string | null;
}

/**
 * Estado de la transcripción de una clase. FUENTE ÚNICA: todo lo que quiera
 * hablar del transcript (finanzas, "Mis clases", los avisos al profesor) tiene
 * que preguntarle a esta función.
 *
 * Existe porque había DOS respuestas para la misma clase: la agenda miraba solo
 * si había texto y decía "Transcript subido" en verde, mientras finanzas exigía
 * además la validación y decía "Sin subir". El profesor veía las dos pantallas
 * contradecirse en 24 clases y, peor, el panel le pedía subir un transcript que
 * ya estaba guardado — con un botón que al pulsarlo no cambiaba nada.
 *
 *   'none'     → no hay texto: el profesor tiene que subirlo.
 *   'review'   → subido y guardado, esperando al equipo. NO es acción suya.
 *   'rejected' → el equipo lo rechazó: hay que subir el correcto.
 *   'ok'       → verifica la clase (segundo factor). Legacy sin columna → 'ok'.
 */
export type TranscriptState = 'none' | 'review' | 'rejected' | 'ok';

export function transcriptStateOf(t: ClassTranscriptRef | undefined | null): TranscriptState {
  if (!t || !hasText(t)) return 'none';
  if (t.validation_status === 'rejected') return 'rejected';
  if (t.validation_status === 'review') return 'review';
  return 'ok';
}

/** ¿El profesor tiene algo que hacer con este transcript? */
export function transcriptNeedsTeacher(state: TranscriptState): boolean {
  return state === 'none' || state === 'rejected';
}

/** Etiqueta y color del estado. Misma fuente para las dos pantallas. */
export function transcriptStateBadge(state: TranscriptState):
  { label: string; color: string; bg: string; dot: string } {
  switch (state) {
    case 'ok':       return { label: 'Transcript subido', color: '#1f7a3d', bg: '#eaf5ec', dot: '#16a34a' };
    case 'review':   return { label: 'En revisión del equipo', color: '#3b5b9e', bg: '#eef1f8', dot: '#2563eb' };
    case 'rejected': return { label: 'Transcript rechazado', color: '#b91c1c', bg: 'rgba(239,68,68,0.10)', dot: '#dc2626' };
    default:         return { label: 'Falta el transcript', color: '#9a6516', bg: '#fdf3e7', dot: '#e0912f' };
  }
}

// Un transcript verifica la clase (segundo factor) SOLO si está validado.
function transcriptCounts(t: ClassTranscriptRef | undefined): boolean {
  return transcriptStateOf(t) === 'ok';
}

/** Fecha efectiva de un análisis: class_date y, si falta, el día de analyzed_at. */
function analysisDate(t: ClassTranscriptRef): string {
  return (t.class_date || (t.analyzed_at ?? '').slice(0, 10) || '');
}

/**
 * ¿Esta clase tiene transcripción?
 *
 * Prefiere `has_transcript` (la columna generada) y solo mira el texto si esa
 * columna no vino — que es el caso mientras la migración no esté corrida. El
 * orden importa: `has_transcript` es la verdad calculada por Postgres desde el
 * propio texto, así que cuando está presente no hace falta nada más.
 */
function hasText(t: ClassTranscriptRef): boolean {
  if (typeof t.has_transcript === 'boolean') return t.has_transcript;
  return !!t.transcript && t.transcript.trim().length > 0;
}

export interface CalcInput {
  teacherId: string;
  teacherName: string;
  monthYear: string;                 // 'YYYY-MM'
  assignments: Assignment[];         // se filtran por teacher adentro
  /**
   * Ingresos ("Unirse a clase"). NIVEL 1: es lo que hace que una clase ENTRE a
   * finanzas. Sin el ingreso, la clase no existe para el pago (única excepción:
   * faltas y cancelaciones sobre la hora, que entran por su propio registro).
   */
  joinLogs: ClassJoinLog[];
  classRecords: ClassRecord[];
  /**
   * Transcripciones: SEGUNDO FACTOR de verificación (reemplaza a la captura).
   *
   * OBLIGATORIO, y no por gusto: mientras fue opcional con default `[]`, el panel
   * del admin no lo pasaba y calculaba TODAS las clases como 'a_revisar' — el
   * profesor veía 16 clases pagables y el admin, cero, sin ningún error a la
   * vista. Un dato que cambia el resultado no puede omitirse en silencio: si
   * falta, tiene que romper la compilación, no devolver un número plausible.
   * Pasá `[]` solo si de verdad no hay transcripciones que considerar.
   */
  classAnalyses: ClassTranscriptRef[];
  rates: FinanceRate[];
  scoringEvents: ScoringEvent[];
  /** Fallback de plan → determina la TARIFA. Obligatorio por el mismo motivo. */
  students: Student[];
  /** Aprobaciones del admin: fuerzan a 'pagable'. Obligatorio por el mismo motivo. */
  manualApprovals: FinanceManualApproval[];
  /** Pago del mes; `null` si no existe. Si está 'paid', el mes queda congelado. */
  payment: FinancePayment | null;
  /**
   * Ocupación del CALENDARIO del profesor (`gridOccupancyOfTeacher`). Es lo que
   * decide si dos horas seguidas son UNA clase de 2h: el calendario es la prueba
   * real del horario y la ficha puede estar desactualizada. Obligatorio — sin él
   * se volvería a pagar por lo que dice una ficha vieja.
   */
  gridOccupancy: GridOccupancy;
}

// Calcula la liquidación de UN profesor para un mes.
export function calculateTeacherFinance(input: CalcInput): TeacherFinanceResult {
  const {
    teacherId, teacherName, monthYear, assignments, joinLogs, classRecords,
    classAnalyses, rates, scoringEvents, students, manualApprovals, payment, gridOccupancy,
  } = input;

  const myAssignments = assignments.filter(a => a.teacherId === teacherId);
  const myLogs = joinLogs.filter(l => l.teacherId === teacherId);
  const myRecords = classRecords.filter(r => r.teacherId === teacherId);
  // Solo análisis CON texto: una fila sin transcript no verifica nada.
  const myAnalyses = classAnalyses.filter(t =>
    t.teacher_id === teacherId && hasText(t) && analysisDate(t));

  // Índices por nombre (normalizado).
  const asgnByName = new Map<string, Assignment>();
  for (const a of myAssignments) if (!asgnByName.has(nkey(a.studentName))) asgnByName.set(nkey(a.studentName), a);
  const studentByName = new Map<string, Student>();
  for (const s of students) studentByName.set(nkey(s.name), s);

  // Aprobaciones manuales: tabla finance_manual_approvals + legacy approved_overrides.
  const approvedSet = new Set<string>();
  for (const k of payment?.approvedOverrides ?? []) approvedSet.add(k);
  for (const m of manualApprovals) {
    if (m.teacherId !== teacherId) continue;
    approvedSet.add(`${m.studentName}__${m.classDate}`);
    approvedSet.add(`${nkey(m.studentName)}__${m.classDate}`);
  }
  const isApproved = (name: string, date: string) =>
    approvedSet.has(`${name}__${date}`) || approvedSet.has(`${nkey(name)}__${date}`);

  const inMonth = (d: string) => (d ?? '').slice(0, 7) === monthYear;

  // Primera fecha conocida por alumno (proxy de inicio para ex-alumnos).
  const firstDateByStudent = new Map<string, string>();
  const noteFirst = (name: string, date: string) => {
    const k = nkey(name); const cur = firstDateByStudent.get(k);
    if (!cur || date < cur) firstDateByStudent.set(k, date);
  };
  for (const l of myLogs) noteFirst(l.studentName, l.scheduledDate);
  for (const r of myRecords) noteFirst(r.studentName, r.classDate);
  for (const t of myAnalyses) noteFirst(t.student_name, analysisDate(t));

  // Faltas y cancelaciones cobrables. Son DOS topes distintos, a propósito:
  //
  //   · Falta del alumno ('falta_sin_aviso') → 2 por alumno y MES. Es una clase
  //     que el alumno perdió, y lo que se limita es cuántas de ellas puede
  //     cobrar el profesor cada mes; un tope de por vida haría que un alumno de
  //     dos años no pudiera faltar nunca más. Se cuenta con la MISMA función que
  //     usa el botón del profesor (studentAbsenceDatesInMonth), para que el tope
  //     que se anuncia en pantalla y el que decide el pago no puedan separarse.
  //
  //   · Cancelación sobre la hora ('cancelacion_hora') → sigue como estaba: las
  //     2 primeras de TODO el historial por alumno.
  //
  // LOS DOS TOPES CUENTAN CLASES (fecha), NO FILAS. Una misma clase puede tener
  // varias constancias del mismo tipo, y contarlas por separado gastaba el cupo
  // con duplicados: la tercera falta REAL del mes caía en 'excede_limite_tipo' y
  // no se pagaba. Además se marcan cobrables TODOS los registros de esas fechas,
  // no solo el primero: cuál de ellos acaba anclando la fila lo decide el cruce
  // de candidatos, y si marcáramos solo uno podría quedar cobrable el que no es.
  const cobrableTypeRecordIds = new Set<string>();

  const absenceMonths = new Set<string>();
  for (const r of myRecords) {
    if (isStudentAbsence(r.classType)) absenceMonths.add(`${nkey(r.studentName)}__${(r.classDate ?? '').slice(0, 7)}`);
  }
  for (const k of absenceMonths) {
    const [student, month] = k.split('__');
    studentAbsenceDatesInMonth(myRecords, teacherId, student, month)
      .slice(0, ABSENCE_MONTHLY_CAP)
      .forEach(g => g.records.forEach(r => cobrableTypeRecordIds.add(r.id)));
  }

  const byStudentCancel = new Map<string, ClassRecord[]>();
  for (const r of myRecords) {
    if (r.classType !== 'cancelacion_hora') continue;
    const k = nkey(r.studentName);
    const arr = byStudentCancel.get(k);
    if (arr) arr.push(r); else byStudentCancel.set(k, [r]);
  }
  for (const arr of byStudentCancel.values()) {
    arr.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.classDate.localeCompare(b.classDate));
    // Mismo criterio que la falta: 2 CLASES distintas, con todas sus constancias.
    const byDate = new Map<string, ClassRecord[]>();
    for (const r of arr) {
      const g = byDate.get(r.classDate);
      if (g) g.push(r); else byDate.set(r.classDate, [r]);
    }
    [...byDate.values()].slice(0, 2).forEach(g => g.forEach(r => cobrableTypeRecordIds.add(r.id)));
  }

  // Candidatos (alumno + fecha) del mes. NIVEL 1: la única fuente que CREA una
  // clase es el ingreso (class_join_logs); las faltas/cancelaciones, su registro.
  // Los records normales y los transcripts solo se PEGAN a un candidato que ya
  // existe, con tolerancia de ±1 día (se suben un día corrido).
  //
  // OJO con el doble conteo: un candidato es UNA clase (alumno + fecha), y una
  // sesión de 2h produce UN candidato aunque haya dos ingresos y dos registros
  // (el segundo de cada tipo se descarta más abajo). Por eso la sesión de 2h se
  // cobra multiplicando la fila por `billingUnits` y NO añadiendo una segunda
  // fila: si se hicieran las dos cosas, se pagaría 4× una clase de 2h.
  interface Cand {
    studentName: string; date: string;
    log?: ClassJoinLog; record?: ClassRecord; transcript?: ClassTranscriptRef;
    /** Horas OBSERVADAS ese día (de los ingresos y registros de esa MISMA fecha). */
    hours: Set<number>;
  }
  const cands: Cand[] = [];
  const newCand = (studentName: string, date: string): Cand =>
    ({ studentName, date, hours: new Set<number>() });

  const sameStudent = (c: Cand, student: string) => nkey(c.studentName) === nkey(student);

  /**
   * Empareja un dato (record o transcript) con la clase a la que pertenece.
   *
   * Primero busca la fecha EXACTA; solo si no la hay, el candidato LIBRE más
   * cercano dentro de la tolerancia. El orden importa: buscar directamente "el
   * primero dentro de ±1 día" hacía que, con clases en días consecutivos, el
   * dato del martes se intentara pegar al lunes, viera el hueco ocupado y se
   * descartara — la clase del martes se quedaba sin transcript para siempre.
   */
  const matchCand = (student: string, date: string, tol: number, isTaken: (c: Cand) => boolean) => {
    const exact = cands.find(c => sameStudent(c, student) && c.date === date);
    if (exact) return exact;
    let best: Cand | undefined;
    let bestDist = Infinity;
    for (const c of cands) {
      if (!sameStudent(c, student) || isTaken(c)) continue;
      const d = Math.abs(daysBetween(c.date, date));
      if (d <= tol && d < bestDist) { best = c; bestDist = d; }
    }
    return best;
  };

  for (const l of myLogs) {
    if (!inMonth(l.scheduledDate)) continue;
    let c = cands.find(x => sameStudent(x, l.studentName) && x.date === l.scheduledDate);
    if (!c) { c = newCand(l.studentName, l.scheduledDate); cands.push(c); }
    // El segundo ingreso del día PISA al primero (una sesión = un acceso), pero su
    // hora queda registrada: es una de las pruebas de que la sesión duró 2 horas.
    c.log = l;
    const h = hourNum(l.scheduledTime);
    if (Number.isFinite(h)) c.hours.add(h);
  }
  for (const r of myRecords) {
    // Constancias que NO cuentan para el pago (clase no dada): 'reprogramada'
    // (movida), 'cancelada_con_preaviso' (cancelada >24h) y 'falta_con_aviso'
    // (falta avisada). Se ignoran en el conteo.
    //
    // 'cancelada_por_profesor' (canceló él con menos de 24 h) tampoco: la clase
    // no se dio por decisión suya, así que no se cobra — y encima lleva su
    // penalización de -5 €. Es el reverso exacto de la falta del alumno.
    //
    // 'falta_sin_aviso_revertida' se ignora igual, y por eso la reversión del
    // admin funciona sin borrar nada: al desaparecer el registro del cálculo, la
    // clase vuelve sola a 'a_revisar' (sigue teniendo su ingreso) y deja de
    // contar para el pago, para el tope del mes y para el cupo del alumno.
    if (r.classType === 'reprogramada' || r.classType === 'cancelada_con_preaviso'
      || r.classType === 'falta_con_aviso' || r.classType === 'falta_sin_aviso_revertida'
      || r.classType === 'cancelada_por_profesor') continue;
    if (!inMonth(r.classDate)) continue;
    let c = matchCand(r.studentName, r.classDate, 1, x => !!x.record);
    if (!c) {
      // NIVEL 1: ningún registro CREA una clase. Si no hay ingreso al que pegarse,
      // la clase no entró a finanzas y el registro no la resucita.
      //
      // Salvo la falta y la cancelación sobre la hora: ahí el alumno no vino, no
      // puede existir un ingreso que las respalde, y su entrada es justamente el
      // registro que el profesor crea a mano.
      const traeSuPropiaEntrada = r.classType === 'falta_sin_aviso' || r.classType === 'cancelacion_hora';
      if (!traeSuPropiaEntrada) continue;
      c = newCand(r.studentName, r.classDate);
      cands.push(c);
    }
    if (!c.record) c.record = r;
    // Solo si el registro es de ESE día: los que se emparejan con tolerancia de
    // ±1 día pertenecen a otra fecha y su hora no describe esta sesión.
    if (c.date === r.classDate) {
      const h = hourNum(r.classTime ?? '');
      if (Number.isFinite(h)) c.hours.add(h);
    }
  }
  // El transcript NO crea clases: es el segundo nivel (decide si la que ya entró
  // se paga), no el primero. Un transcript sin ingreso al que pegarse se descarta
  // — antes creaba una fila 'a_revisar' y así una clase sin clic entraba igual al
  // listado. Misma tolerancia de ±1 día que los records.
  //
  // Los que traen vínculo explícito (join_log_id) se procesan PRIMERO: su clase
  // está dicha, no adivinada. Sin este orden, un transcript suelto —el de una
  // clase que no entró— podía ocupar por proximidad de fecha el hueco de la clase
  // vecina y dejarla como pendiente aunque tuviera el suyo propio subido.
  const analysesPorPrioridad = [...myAnalyses]
    .sort((a, b) => Number(!!b.join_log_id) - Number(!!a.join_log_id));

  for (const t of analysesPorPrioridad) {
    const d = analysisDate(t);

    // 1) Vínculo EXPLÍCITO: el transcript dice a qué ingreso pertenece. No se
    //    adivina nada, y da igual con cuántos días de retraso se haya subido.
    if (t.join_log_id) {
      const linked = cands.find(c => c.log?.id === t.join_log_id);
      if (linked) { if (!linked.transcript) linked.transcript = t; continue; }
      // El ingreso vinculado es de otro mes: el transcript se cuenta con su
      // clase, no acá. Evita crear una fila suelta duplicada.
      if (!inMonth(d)) continue;
    }

    // 2) Respaldo por fecha, solo para lo añadido a mano (sin vínculo).
    if (!inMonth(d)) continue;
    const c = matchCand(t.student_name, d, 1, x => !!x.transcript);
    if (!c) continue;   // NIVEL 1: sin ingreso al que pegarse, no hay clase.
    if (!c.transcript) c.transcript = t;
  }

  // Construir las filas.
  const rows: ClassFinanceRow[] = [];
  for (const c of cands) {
    const a = asgnByName.get(nkey(c.studentName));
    const stu = studentByName.get(nkey(c.studentName));
    const record = c.record;
    const log = c.log;

    const classType: ClassRecordType = (record?.classType as ClassRecordType) ?? 'normal';
    const join = !!log;
    const punctuality = log?.punctuality;
    const isNormalType = classType === 'normal' || classType === 'recuperacion';
    const isFaltaType  = classType === 'falta_sin_aviso' || classType === 'cancelacion_hora';
    // Segundo factor: transcript con texto Y validado (no en revisión/rechazado).
    // Las faltas/cancelaciones tienen sus propias reglas y no lo requieren.
    const transcriptState = transcriptStateOf(c.transcript);
    const isTranscript = transcriptCounts(c.transcript) && isNormalType;
    const hasMeetLink = !!(a?.meetLink && a.meetLink.trim());

    // Plan: productName de WooCommerce (principal) → assignments.plan → objetivo
    // → students.plan → 'Inglés general'. La tarifa (planType) usa classifyPlan.
    const plan = firstNonEmpty(stu?.productName, a?.plan, a?.objetivo, stu?.plan) || 'Inglés general';
    // classifyFor arma SIEMPRE los 4 campos: es la única clasificación de la fila,
    // y de ella salen tanto la tarifa como la etiqueta que ve el admin.
    const planClass = classifyFor(a, stu);
    const planType = planClass.financeType;

    const start = a?.startDate ?? firstDateByStudent.get(nkey(c.studentName));
    const antiquityDays = start ? Math.max(0, daysBetween(start, c.date)) : 0;
    const tier: 'nuevo' | 'antiguo' = antiquityDays < 30 ? 'nuevo' : 'antiguo';
    const rate = findRate(rates, planType, tier);  // tarifa normal del alumno (también para faltas)
    const weeklyHours = a?.weeklyHours ?? 0;
    const anchorHour = firstNonEmpty(log?.scheduledTime, record?.classTime, slotHourForDate(a, c.date));
    // Sesión de 2h (celdas contiguas) → la fila vale 2. Aplica también a faltas y
    // cancelaciones: si la clase perdida era de 2 horas, la constancia vale 2.
    const { durationHours, startHour: hour } = sessionSpanFor(a, c.date, anchorHour, c.hours, gridOccupancy);

    // Parte de RECUPERACIÓN de la sesión: cuántas de sus horas salen de una celda
    // 'bloqueado' del calendario, y qué clases perdidas saldan. Se deriva del
    // grid igual que la duración —no hay columna que lo diga— para que profesor y
    // admin lean lo mismo sin depender de qué registro llegó primero.
    const startNum = hourNum(hour);
    const fromGrid = Number.isFinite(startNum)
      ? recoveryPartOfSession(gridOccupancy, c.studentName, c.date, startNum, startNum + durationHours)
      : { units: 0, dates: [] as string[] };
    let recoveryUnits = fromGrid.units;
    let recoveryForDates = fromGrid.dates;
    // Respaldo: recuperación registrada SIN celda en el calendario (el selector
    // "Clase de recuperación" de Añadir clase). Ahí la fila entera es recuperación.
    if (recoveryUnits === 0 && classType === 'recuperacion') {
      recoveryUnits = durationHours;
      if (record?.recoveryForDate) recoveryForDates = [record.recoveryForDate];
    } else if (record?.recoveryForDate && !recoveryForDates.includes(record.recoveryForDate)) {
      recoveryForDates = [...recoveryForDates, record.recoveryForDate].sort();
    }
    // Nunca más horas de recuperación que horas cobradas.
    recoveryUnits = Math.min(recoveryUnits, durationHours);

    // Estado de suscripción: prioriza el del join log (momento real de la clase).
    const subAtJoin = log?.subscriptionStatus;
    const subAtRecord = record?.subscriptionStatus;
    const subscriptionStatus = subAtJoin ?? subAtRecord;

    const approved = isApproved(c.studentName, c.date);

    let status: ClassFinanceStatus;
    if (isFaltaType) {
      // Falta del alumno / cancelación: cobrable a TARIFA NORMAL si está dentro
      // de su tope (2 del mes para la falta, 2 del historial para la cancelación)
      // o si el admin la aprobó. No requiere transcript: no hubo clase que grabar.
      const withinCap = !!record && cobrableTypeRecordIds.has(record.id);
      status = (approved || withinCap) ? 'pagable' : 'excede_limite_tipo';
    } else if (approved) {
      status = 'pagable';
    } else {
      // NIVEL 2. Acá `join` ya es siempre true (sin ingreso la clase no habría
      // llegado a ser candidata), así que lo único que se decide es el transcript:
      // con transcript validado se cobra, sin él queda pendiente de subirlo.
      status = (join && isTranscript) ? 'pagable' : 'a_revisar';
    }

    rows.push({
      date: c.date, hour, studentName: c.studentName, plan,
      planCategory: planClass.type, planLabel: planClass.displayName,
      weeklyHours, antiquityDays, rate, durationHours, billingUnits: durationHours,
      recoveryUnits, recoveryForDates, status,
      classType, recordId: record?.id,
      hasJoinLog: join, hasTranscript: isTranscript, transcriptState, hasMeetLink, punctuality, manuallyApproved: approved,
      subscriptionStatus, subAtJoin, subAtRecord,
    });
  }

  // Límite mensual por alumno (solo clases cobrables normal/recuperacion). Las
  // aprobadas manualmente nunca pasan a 'excede_limite'.
  const limitByStudent = new Map<string, number>();
  for (const a of myAssignments) limitByStudent.set(nkey(a.studentName), monthlyLimit(a.weeklyHours ?? 0));

  // El límite mensual del plan lo consumen las clases normales, las de
  // recuperación y las FALTAS DEL ALUMNO: si el alumno no viene, esa clase se
  // perdió y no se recupera, así que gasta una de las de su mes igual que si la
  // hubiera dado (4 clases al mes, 1 falta → le quedan 3). La cancelación sobre
  // la hora sigue fuera del cupo: se rige solo por su tope de 2 del historial.
  const countable = rows
    .filter(r => (r.status === 'pagable' || r.status === 'a_revisar')
      && (r.classType === 'normal' || r.classType === 'recuperacion' || isStudentAbsence(r.classType)))
    .sort((x, y) => x.date.localeCompare(y.date) || x.studentName.localeCompare(y.studentName));
  // El límite se descuenta en UNIDADES, no en filas: una sesión de 2h consume 2
  // de las 9 del plan de 2h/semana. Las dos magnitudes están en horas
  // (monthlyLimit sale de weeklyHours, que es slots.length), así que la unidad
  // coincide. Una sesión que no entra entera queda 'excede_limite' completa: no
  // se parte en "una hora sí y otra no".
  //
  // LA RECUPERACIÓN NO GASTA CUPO DEL MES. Una hora de recuperación repone una
  // clase que el alumno ya había perdido: salda una deuda vieja, no consume una
  // de las de este mes. Por eso el cupo se descuenta con `billingUnits -
  // recoveryUnits`:
  //   · sesión normal de 1h      → consume 1 (2h → 2), como siempre;
  //   · sesión mixta de 2h       → PAGA 2 y consume 1 (la hora normal);
  //   · recuperación pura de 1h  → PAGA 1 y consume 0.
  // Antes una clase perdida en julio y recuperada en agosto se comía una de las 5
  // de agosto y la fila caía en 'excede_limite' — o sea, no se pagaba.
  const usedByStudent = new Map<string, number>();
  for (const row of countable) {
    const k = nkey(row.studentName);
    const limit = limitByStudent.has(k) ? limitByStudent.get(k)! : Infinity; // ex-alumnos: sin límite
    const used = usedByStudent.get(k) ?? 0;
    // REGLA: la falta del alumno consume su cupo ENTERO, aunque cayera sobre una
    // hora de recuperación. El descuento de `recoveryUnits` existe porque una
    // recuperación repone una clase ya perdida y no gasta una del mes — pero si
    // el alumno tampoco viene a la recuperación, la clase se perdió otra vez y el
    // crédito se consumió: no puede salirle gratis faltar dos veces seguidas.
    //
    // El caso: Cristian Díaz (Johny) faltó sin avisar el 17/08 a la recuperación
    // de su clase del 12, y esa falta no le gastaba ninguna clase del mes.
    const cupoUnits = isStudentAbsence(row.classType)
      ? row.billingUnits
      : Math.max(0, row.billingUnits - row.recoveryUnits);
    // La falta del alumno CONSUME cupo pero nunca es la que se retiene: el
    // profesor estuvo ahí y el alumno no vino, así que se le paga igual. Dejarla
    // caer por el tope hacía que la regla se contradijera sola — "se cobra
    // entera" y "no se cobra" a la vez— y pasaba justo cuando la falta era lo
    // último que entraba en el mes (Ester Domènech, 15/08, 4 de 5 usadas).
    //
    // No abre la puerta a abusos: las faltas ya tienen su propio tope de 2 al mes
    // por tipo ('excede_limite_tipo'), que se aplica antes que esto.
    const puedeRetenerse = !row.manuallyApproved && !isStudentAbsence(row.classType);
    if (used + cupoUnits > limit && puedeRetenerse) {
      row.status = 'excede_limite';
    } else {
      usedByStudent.set(k, used + cupoUnits);
    }
  }

  // El cupo, tal como quedó. NO es un cálculo nuevo: son los dos números que el
  // bucle de arriba ya usó para decidir qué fila pasaba a 'excede_limite', y se
  // exponen para que una pantalla pueda decir "3 de 9" sin volver a derivar el
  // límite desde weeklyHours por su cuenta (que es cómo dos vistas acaban
  // discrepando sobre el mismo alumno).
  const quota: StudentQuota[] = [...new Set(rows.map(r => nkey(r.studentName)))].map(k => ({
    studentKey: k,
    studentName: rows.find(r => nkey(r.studentName) === k)!.studentName,
    limit: limitByStudent.has(k) ? limitByStudent.get(k)! : null,   // ex-alumnos: sin límite
    used: usedByStudent.get(k) ?? 0,
  }));

  rows.sort((x, y) => x.date.localeCompare(y.date) || x.studentName.localeCompare(y.studentName));

  // Agregados (punto 6).
  const pagables   = rows.filter(r => r.status === 'pagable');      // normal/recuperacion + faltas cobrables
  const revisar    = rows.filter(r => r.status === 'a_revisar');
  const excede     = rows.filter(r => r.status === 'excede_limite');
  const excedeTipo = rows.filter(r => r.status === 'excede_limite_tipo');
  const noCobrable = rows.filter(r => r.status === 'no_cobrable');

  // Importe de una fila = tarifa × unidades. Una sesión de 2h cobra 2× la tarifa
  // de esa clase (respetando la tarifa por antigüedad y tipo de plan ya resuelta).
  const amount = (r: ClassFinanceRow) => r.rate * r.billingUnits;
  const units  = (rs: ClassFinanceRow[]) => rs.reduce((s, r) => s + r.billingUnits, 0);

  const montoPagable  = pagables.reduce((s, r) => s + amount(r), 0);
  const montoARevisar = revisar.reduce((s, r) => s + amount(r), 0);
  const montoRetenido = excede.reduce((s, r) => s + amount(r), 0) + excedeTipo.reduce((s, r) => s + amount(r), 0);

  // Estado de suscripción de las clases PAGABLES, al momento de darse.
  //
  // No es un booleano "activa / no activa": el admin necesita distinguir una
  // clase de un alumno en 'pending-cancel' —que estaba al día y podía venir— de
  // una en 'on-hold', que no. Antes las dos caían en el mismo aviso de "no tenía
  // suscripción activa" porque la condición era `!== 'active'` a secas.
  //
  // Nada de esto cambia el importe: lo que decide que una clase se pague sigue
  // siendo el clic en "Unirse" + el transcript (ver la regla de dos niveles).
  const payableSubStatuses: SubStatusNote[] = (() => {
    const counts = new Map<string, number>();
    for (const r of pagables) {
      const s = r.subscriptionStatus;
      if (!s || s === 'active') continue;   // 'active' es lo normal: no se anota
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([status, count]) => ({
        status, count,
        label: subscriptionBadge(status).label.replace(/^\S+\s/, ''),
        countsAsActive: isActiveWooStatus(status) || status === 'oritalk'
          || status === 'manual_override' || status === 'manual_active',
      }))
      // Primero lo que de verdad es un problema.
      .sort((a, b) => Number(a.countsAsActive) - Number(b.countsAsActive) || b.count - a.count);
  })();

  // Se conserva para quien solo quiera el booleano, pero ahora 'pending-cancel'
  // NO lo dispara: esa clase se dio con la suscripción vigente.
  const hasInactiveSubPayable = payableSubStatuses.some(s => !s.countsAsActive);

  // Eventos de scoring de ESTE mes que afectan al balance. Se excluyen las
  // penalizaciones revertidas (quedan solo como constancia tachada) y sus eventos
  // compensatorios (audit-only), para que una reversión sea neutra en el total.
  const scoringThisMonth = scoringEvents.filter(e =>
    e.teacherId === teacherId &&
    (e.createdAt ?? '').slice(0, 7) === monthYear &&
    !e.reverted &&
    e.eventType !== 'penalizacion_revertida');

  const bonusFromScoring = scoringThisMonth
    .filter(e => (e.euros ?? 0) > 0)
    .reduce((s, e) => s + (e.euros ?? 0), 0);
  // Suma NEGATIVA (penalizaciones: falta sin aviso, etc.). FIX del bug histórico:
  // antes solo se sumaban los euros > 0, así que las penalizaciones no restaban.
  const penaltiesFromScoring = scoringThisMonth
    .filter(e => (e.euros ?? 0) < 0)
    .reduce((s, e) => s + (e.euros ?? 0), 0);

  let totalAPagar = montoPagable + bonusFromScoring + penaltiesFromScoring;

  let paymentStatus: 'pending' | 'paid' = 'pending';
  let paidAt: string | undefined;
  if (payment?.status === 'paid') {
    paymentStatus = 'paid';
    paidAt = payment.paidAt;
    totalAPagar = payment.totalAmount;
  }

  return {
    teacherId, teacherName, monthYear, rows,
    // Los totales cuentan CLASES, no filas: una sesión de 2h son 2 clases
    // pagables (una sola fila con billingUnits = 2).
    totalPagable: units(pagables),
    totalARevisar: units(revisar),
    totalExcedeLimite: units(excede),
    totalExcedeLimiteTipo: units(excedeTipo),
    totalNoCobrable: units(noCobrable),
    totalSesiones: rows.length,
    hasInactiveSubPayable,
    payableSubStatuses,
    montoPagable, montoARevisar, montoRetenido,
    bonusFromScoring, penaltiesFromScoring, totalAPagar,
    paymentStatus, paidAt,
    studentQuota: quota,
  };
}

// ── Estados en pantalla ───────────────────────────────────────────────────────

/**
 * Etiqueta y colores DRC de cada estado. FUENTE ÚNICA para el panel del profesor
 * y el del admin: antes cada pantalla tenía su propio diccionario y la misma
 * clase se llamaba distinto en cada una.
 *
 * Verde #1E9E3A = entra al total. Amarillo #FFC400 = está, pero todavía no se
 * cobra. Naranja = retenida por un límite.
 */
export function financeStatusBadge(status: ClassFinanceStatus):
  { label: string; short: string; color: string; bg: string; dot: string } {
  switch (status) {
    case 'pagable':
      return { label: 'Pagable', short: 'Pagable', color: '#1E9E3A', bg: 'rgba(30,158,58,0.12)', dot: '#1E9E3A' };
    case 'a_revisar':
      return { label: 'Pendiente de transcript', short: 'Pendiente', color: '#9a6516', bg: 'rgba(255,196,0,0.18)', dot: '#FFC400' };
    case 'excede_limite':
      return { label: 'Excede el límite del plan', short: 'Excede límite', color: '#ea580c', bg: 'rgba(249,115,22,0.12)', dot: '#ea580c' };
    case 'excede_limite_tipo':
      return { label: 'Supera 2 de este tipo', short: 'Supera 2/tipo', color: '#ea580c', bg: 'rgba(249,115,22,0.12)', dot: '#ea580c' };
    default:
      return { label: 'No cobrable', short: 'No cobrable', color: 'var(--text-muted)', bg: 'var(--bg-surface-3)', dot: 'var(--text-muted)' };
  }
}

/**
 * Lo que le falta cobrar al profesor por no haber subido transcripts. Se muestra
 * SIEMPRE aparte del total: son clases que ya dio y que pasan a pagables solas en
 * cuanto suba el texto.
 */
export function pendingTranscriptSummary(result: Pick<TeacherFinanceResult, 'totalARevisar' | 'montoARevisar'>):
  { classes: number; amount: number; label: string } | null {
  if (result.totalARevisar <= 0) return null;
  const clases = `${result.totalARevisar} clase${result.totalARevisar === 1 ? '' : 's'}`;
  return {
    classes: result.totalARevisar,
    amount: result.montoARevisar,
    label: `Pendiente de transcript: €${result.montoARevisar.toFixed(2)} en ${clases}`,
  };
}

// ── Sesiones de 2h en el desglose ─────────────────────────────────────────────

/** Rango horario de la fila: "17:00 - 19:00" si es una sesión de 2h, "17:00" si no. */
export function rowHoursLabel(row: { hour: string; durationHours?: number }): string {
  return sessionRangeLabel(row.hour, row.durationHours ?? 1);
}

/**
 * Explicación de por qué esa fila vale más de una clase, para que el profesor no
 * tenga que deducirlo del importe. null cuando la clase dura una hora.
 */
export function sessionBreakdownLabel(row: ClassFinanceRow): string | null {
  if ((row.billingUnits ?? 1) <= 1) return null;
  const total = (row.rate * row.billingUnits).toFixed(2);
  const base = `Sesión de ${row.durationHours}h con ${row.studentName} — cuenta como ${row.billingUnits} (€${total})`;
  const rec = row.recoveryUnits ?? 0;
  if (rec <= 0 || rec >= row.billingUnits) return base;
  const normales = row.billingUnits - rec;
  return `${base} · ${normales}h normal${normales !== 1 ? 'es' : ''} + ${rec}h de recuperación`;
}

// ── Sesión MIXTA: normal + recuperación en el mismo bloque ────────────────────
//
// Un bloque de 2 horas seguidas donde una hora es la clase normal del alumno y la
// otra recupera una clase que había perdido. Se paga entero (2 × tarifa, un solo
// transcript) pero solo consume UNA clase del cupo del mes. Estas dos funciones
// son la fuente única del texto: si el profesor y el admin leyeran frases
// distintas sobre por qué esa clase paga doble, volveríamos a las consultas de
// "¿por qué me pagaste 2 horas de una clase de 1?".

/** Badge "Normal + recuperación". null si la sesión no es mixta. */
export function mixedSessionBadge(
  row: Pick<ClassFinanceRow, 'billingUnits' | 'recoveryUnits'>,
): { label: string; color: string; bg: string } | null {
  const rec = row.recoveryUnits ?? 0;
  if (rec <= 0 || rec >= (row.billingUnits ?? 1)) return null;
  return { label: '🔁 Normal + recuperación', color: '#8a6d00', bg: 'rgba(255,196,0,0.20)' };
}

/**
 * Qué clase perdida salda esta fila y qué efecto tiene en el cupo del alumno.
 * null cuando la fila no recupera nada.
 */
export function recoveryCreditLabel(
  row: Pick<ClassFinanceRow, 'billingUnits' | 'recoveryUnits' | 'recoveryForDates' | 'classType'>,
): string | null {
  const rec = row.recoveryUnits ?? 0;
  if (rec <= 0) return null;
  const fechas = (row.recoveryForDates ?? []).map(fmtDMY);
  // El alumno tampoco vino a la recuperación: no saldó nada, pero el crédito se
  // gastó igual — la clase perdida ya no se vuelve a recuperar. Decir "salda la
  // clase perdida del X" en una fila donde el alumno faltó era la contradicción
  // más visible de esta pantalla.
  if (isStudentAbsence(row.classType)) {
    const cual = fechas.length ? `del ${fechas.join(' y ')}` : 'que recuperaba';
    return `Era la recuperación de la clase ${cual} y el alumno tampoco vino: el crédito se consumió y esa clase ya no se repone.`;
  }
  const qué = fechas.length
    ? `salda la clase perdida del ${fechas.join(' y ')}`
    : 'salda una clase perdida';
  const cupo = rec >= (row.billingUnits ?? 1)
    ? 'no consume ninguna clase del mes'
    : `consume ${(row.billingUnits ?? 1) - rec} clase${(row.billingUnits ?? 1) - rec !== 1 ? 's' : ''} del mes en vez de ${row.billingUnits}`;
  return `${rec}h de recuperación — ${qué}: ${cupo}.`;
}

/** 'YYYY-MM-DD' → '12/07/2026'. */
function fmtDMY(iso: string): string {
  const [y, m, d] = (iso ?? '').split('-');
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

/** Badge discreto "2h"/"3h" en verde DRC. null si la clase dura una hora. */
export function durationBadge(durationHours?: number):
  { label: string; color: string; bg: string } | null {
  if (!durationHours || durationHours <= 1) return null;
  return { label: `${durationHours}h`, color: '#1E9E3A', bg: 'rgba(30,158,58,0.12)' };
}

// Verificación visible para el profesor (sección "Mis clases"): ¿hubo ingreso?
export function recordVerification(
  studentName: string, classDate: string, joinLogs: ClassJoinLog[], teacherId: string,
): 'detected' | 'not_detected' {
  const found = joinLogs.some(l =>
    l.teacherId === teacherId &&
    nkey(l.studentName) === nkey(studentName) &&
    Math.abs(daysBetween(l.scheduledDate, classDate)) <= 1
  );
  return found ? 'detected' : 'not_detected';
}

// Etiqueta de la columna "INGRESO" (punto 3) — estado + color por puntualidad.
export function ingresoBadge(row: { hasJoinLog: boolean; punctuality?: string; hasMeetLink: boolean }):
  { label: string; color: string; bg: string } {
  if (row.hasJoinLog) {
    if (row.punctuality === 'on_time')   return { label: '✅ A tiempo',  color: '#1E9E3A', bg: 'rgba(30,158,58,0.1)' };
    if (row.punctuality === 'late')      return { label: '⚠️ Tarde',     color: '#b45309', bg: 'rgba(255,196,0,0.18)' };
    if (row.punctuality === 'very_late') return { label: '🔴 Muy tarde', color: '#dc2626', bg: 'rgba(239,68,68,0.1)' };
    return { label: '✅ A tiempo', color: '#1E9E3A', bg: 'rgba(30,158,58,0.1)' };
  }
  // Sin registro de ingreso.
  if (!row.hasMeetLink) return { label: '🔗 Sin enlace', color: '#ea580c', bg: 'rgba(249,115,22,0.12)' };
  return { label: '❌ No utilizó', color: 'var(--text-muted)', bg: 'var(--bg-surface-3)' };
}

// Categoría simplificada para el profesor. Wrapper de classifyPlan (ÚNICA fuente
// de verdad). Acepta los campos completos (plan + objetivo + plan/producto del
// alumno) o, por compatibilidad, un único texto libre.
/**
 * Lo que valdría UNA clase de ese alumno en esa fecha: tarifa × horas.
 *
 * Misma cadena que usa `calculateTeacherFinance` para decidir el importe de una
 * fila (clasificación del plan → tipo → antigüedad → tramo → tarifa), expuesta
 * aparte para que el resumen de "validar en bloque" del admin diga un número que
 * no pueda discrepar del que va a acabar cobrando el profesor.
 *
 * Es una ESTIMACIÓN: el cupo mensual del alumno puede retener alguna de las
 * clases una vez aplicado (`excede_limite`), y eso solo se sabe calculando el mes
 * entero. Quien muestre esto tiene que decir que es aproximado.
 */
export function estimateClassAmount(args: {
  assignment?: Assignment;
  student?: Student;
  rates: FinanceRate[];
  date: string;
  durationHours?: number;
}): number {
  const planClass = classifyFor(args.assignment, args.student);
  const start = args.assignment?.startDate;
  const antiquityDays = start ? Math.max(0, daysBetween(start, args.date)) : 0;
  const tier: 'nuevo' | 'antiguo' = antiquityDays < 30 ? 'nuevo' : 'antiguo';
  return findRate(args.rates, planClass.financeType, tier) * (args.durationHours ?? 1);
}

export function classCategoryBadge(
  input?: {
    assignmentPlan?: string | null;
    assignmentObjetivo?: string | null;
    studentPlan?: string | null;
    productName?: string | null;
  } | string | null,
): { label: string; color: string; bg: string } {
  const fields = (typeof input === 'string' || input == null) ? { productName: input } : input;
  const c = classifyPlan(fields);
  return { label: c.badge, ...planBadgeStyle(c.type) };
}

// Badge del tipo de clase — null para 'normal'. Faltas/cancelaciones son cobrables.
//
// La falta del alumno va en ÁMBAR (familia del amarillo DRC) y no en el naranja
// de antes: el naranja #ea580c ya es el de 'excede límite', y el rojo es el de
// las penalizaciones. Los tres significan cosas distintas y tenían dos colores
// entre ellos.
export function classTypeBadge(t: ClassRecordType | undefined):
  { label: string; color: string; bg: string } | null {
  switch (t) {
    case 'falta_sin_aviso':  return { label: '🚫 Falta sin aviso',            color: '#b45309', bg: 'rgba(255,196,0,0.20)' };
    case 'falta_sin_aviso_revertida':
      return { label: '↩️ Falta revertida', color: 'var(--text-muted)', bg: 'var(--bg-surface-3)' };
    case 'cancelacion_hora': return { label: '⏰ Cancelación (cobrable)',     color: '#dc2626', bg: 'rgba(239,68,68,0.1)' };
    case 'recuperacion':     return { label: '📋 Recuperación',               color: '#2563eb', bg: 'rgba(37,99,235,0.1)' };
    default:                 return null;
  }
}

/**
 * Línea de desglose de una falta del alumno, para que admin y profesor lean la
 * misma frase: qué se cobró y por qué, sin tener que deducirlo del badge.
 * null cuando la fila no es una falta del alumno.
 */
export function absenceBreakdownLabel(
  row: Pick<ClassFinanceRow, 'classType' | 'studentName' | 'date' | 'rate' | 'billingUnits' | 'status'>,
): string | null {
  if (!isStudentAbsence(row.classType)) return null;
  const importe = (row.rate * (row.billingUnits ?? 1)).toFixed(2);
  const cobro = row.status === 'pagable'
    ? `${importe} €`
    : `${importe} € retenidos (supera las ${ABSENCE_MONTHLY_CAP} del mes)`;
  return `Falta sin aviso — ${row.studentName}, ${row.date} — ${cobro} (el alumno no se presentó)`;
}

// Estados de suscripción posibles (para filtros y leyendas).
// Los estados de Woo salen del mapa único (mismo orden y mismos nombres que los
// badges); Oritalk y el acceso manual se añaden porque también quedan guardados
// en el join log y el admin filtra por ellos.
export const SUBSCRIPTION_STATUS_OPTIONS = [
  ...Object.entries(WOO_STATUS).map(([value, m]) => ({ value, label: m.label })),
  { value: 'oritalk',         label: 'Oritalk' },
  { value: 'manual_override', label: 'Activa (manual)' },
  { value: 'not_found',       label: 'No encontrada' },
  { value: 'error',           label: 'No verificado' },
];

// Badge de la columna "SUSCRIPCIÓN" según el estado guardado.
export function subscriptionBadge(status?: string):
  { label: string; color: string; bg: string } {
  // Oritalk no es un estado de WooCommerce: es un acceso propio de la academia,
  // pero llega hasta acá porque el join log guarda el `status` que devolvió la
  // verificación al momento de la clase.
  if (status === 'oritalk') return { label: '🔵 Oritalk', color: '#2563eb', bg: 'rgba(37,99,235,0.10)' };
  if (status === 'manual_override' || status === 'manual_active') {
    return { label: '✅ Activa (manual)', color: '#1E9E3A', bg: 'rgba(30,158,58,0.1)' };
  }
  const m = wooStatusMeta(status);
  const known = status && (status in WOO_STATUS || status === 'not_found');
  // El icono sale del mapa (lib/subscriptionAccess), igual que el nombre y el
  // color. Antes se reconstruía acá con un ternario propio que solo conocía los
  // cinco estados de entonces, así que uno nuevo salía siempre con "❓" aunque
  // estuviera dado de alta en el mapa.
  return { label: `${m.icon} ${known ? m.label : 'No verificado'}`, color: m.color, bg: m.bg };
}
