// ── Solicitudes de revisión: clases SIN ingreso registrado ───────────────────
//
// EL PROBLEMA. Una clase solo entra a finanzas si tiene `class_join_log` (el clic
// en "Ingresar a clase"). Cuando no lo hay —el profesor entró por el enlace
// directo de Meet, o el alumno no se presentó y la clase nunca llegó a abrirse—
// la clase NO EXISTE para el pago: no aparece ni siquiera como pendiente, y no
// había ninguna forma de reclamarla. La auditoría de agosto de 2026 encontró 75
// transcripts en esa situación (clases dadas, con texto subido, invisibles).
//
// LA VÍA. El profesor declara la clase y QUÉ pasó en ella. La solicitud queda
// 'pendiente' y NO paga sola: el ingreso lo crea la validación del admin, que es
// el único punto donde una clase sin clic pasa a contar (ver dbResolveReviewRequest
// en este mismo archivo).
//
// LA FUENTE ES EL CALENDARIO, NO LOS TRANSCRIPTS. Se listan todas las clases
// agendadas sin ingreso, tengan transcript o no: las faltas sin aviso nunca
// tienen transcript y son justamente las que hay que poder declarar.

import { supabase } from '@/lib/supabase';
import { buildAttendanceRows, type LogRow } from '@/lib/attendance';
import { cancellationFor, rescheduledTargetFor, type GridOccupancy } from '@/lib/teacherClasses';
// Módulo PURO (sin SDK de Anthropic): se puede importar desde el cliente.
import { contentFlags, SCORE_AUTO_APPROVE } from '@/lib/transcriptValidation';
import type {
  Assignment, ClassJoinLog, ClassRecord, ClassRecordType,
  ClassReviewRequest, ReviewRequestType, ReviewResolvedType,
} from '@/types';
import type { ClassTranscriptRef } from '@/lib/finance';
import { periodIndex, existsForStudent } from '@/lib/studentPeriod';

const nk = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

/** La señal que la propia aprobación de la solicitud resuelve. Ver más abajo. */
const ACCESS_FLAG = 'sin_acceso_registrado';

// ── Qué puede declarar el profesor ───────────────────────────────────────────

/**
 * Las TRES opciones, con su etiqueta y qué implican. Fuente única: la pantalla
 * del profesor las pinta desde acá y el panel del admin las nombra igual, para
 * que "lo que eligió el profesor" signifique lo mismo en las dos puntas.
 *
 * Deliberadamente NO se le ofrecen al profesor 'cancelada_por_profesor' (lleva
 * una penalización de -5 €, nadie la elegiría solo) ni 'cancelada_con_preaviso'
 * (es una regla de tiempo que calcula el sistema, no algo que se declare). El
 * admin sí puede reclasificar a ellas al validar.
 */
export const REVIEW_TYPE_OPTIONS: Array<{
  value: ReviewRequestType;
  label: string;
  help: string;
  needsTranscript: boolean;
  /** ¿Consume una de las 2 faltas sin aviso del alumno en el mes? */
  usesAbsenceCap: boolean;
}> = [
  {
    value: 'normal',
    label: 'Clase normal',
    help: 'Diste la clase. Hace falta el transcript para poder verificarla.',
    needsTranscript: true,
    usesAbsenceCap: false,
  },
  {
    value: 'falta_sin_aviso',
    label: 'Falta sin aviso del alumno',
    help: 'El alumno no se presentó y no avisó. Se cobra la clase completa a tarifa normal, sin transcript y sin penalización para vos. Consume una clase del cupo del alumno.',
    needsTranscript: false,
    usesAbsenceCap: true,
  },
  {
    value: 'falta_con_aviso',
    label: 'El alumno avisó / no se dio la clase',
    help: 'Queda la constancia de que la clase no se dio. No se paga y no te penaliza.',
    needsTranscript: false,
    usesAbsenceCap: false,
  },
];

export function reviewTypeLabel(t: ReviewRequestType | ReviewResolvedType | undefined): string {
  const found = REVIEW_TYPE_OPTIONS.find(o => o.value === t);
  if (found) return found.label;
  if (t === 'cancelacion_hora') return 'Cancelación sobre la hora';
  if (t === 'cancelada_por_profesor') return 'Cancelada por el profesor';
  return '—';
}

/** Los cinco tipos con los que el ADMIN puede resolver (incluye los dos suyos). */
export const RESOLVE_TYPE_OPTIONS: Array<{ value: ReviewResolvedType; label: string; note: string }> = [
  { value: 'normal',                 label: 'Clase normal',                 note: 'Crea el ingreso. Se paga con su transcript.' },
  { value: 'falta_sin_aviso',        label: 'Falta sin aviso del alumno',   note: 'Crea el ingreso y la constancia. Se paga sin transcript.' },
  { value: 'falta_con_aviso',        label: 'El alumno avisó',              note: 'Solo constancia. No se paga.' },
  { value: 'cancelacion_hora',       label: 'Cancelación sobre la hora',    note: 'Solo constancia. Cobrable hasta 2 por alumno.' },
  { value: 'cancelada_por_profesor', label: 'Cancelada por el profesor',    note: 'Solo constancia. Aplica la penalización de -5 €.' },
];

/** ¿Este tipo crea un ingreso al aprobarse? Es lo que decide si la clase se paga. */
export function resolvedTypeCreatesJoinLog(t: ReviewResolvedType): boolean {
  return t === 'normal' || t === 'falta_sin_aviso';
}

// ── La señal que la propia aprobación resuelve ───────────────────────────────

/**
 * `sin_acceso_registrado` sobre un transcript subido desde /revisiones es una
 * señal contradictoria consigo misma: se dispara porque no hay `class_join_log`,
 * que es EXACTAMENTE lo que el profesor está declarando y lo que la aprobación
 * acaba de crear. Dejarla puesta significaría retener la clase en la cola de
 * validación por un hecho que ya se resolvió.
 *
 * Lo que NO es: un pase libre. Solo se descarta ESA señal. Si el transcript
 * además trae `demasiado_corto`, `sin_timestamps`, `prosa_demasiado_limpia` o
 * cualquier otra, se queda en la cola y lo mira una persona.
 *
 * Devuelve el estado que le corresponde al transcript una vez quitada la señal,
 * o `null` si no hay que tocar nada.
 */
export function statusAfterAccessResolved(row: {
  validationStatus?: string | null;
  score?: number | null;
  flags?: string[] | null;
}): { nextStatus: 'auto_approved'; removedFlag: string } | null {
  // Solo aplica a lo que está retenido. Lo ya aprobado no se toca.
  if (row.validationStatus !== 'review') return null;

  const flags = row.flags ?? [];
  if (!flags.includes(ACCESS_FLAG)) return null;

  // ¿Queda alguna otra señal que pese? `contentFlags` deja fuera las informativas
  // y las de registro; acá además se quita la de acceso, ya resuelta.
  const restantes = flags.filter(f => f !== ACCESS_FLAG);
  if (contentFlags(restantes).length > 0) return null;
  // `registro_tardio` tampoco retiene por sí sola, pero sí lo hace un score bajo:
  // una transcripción por debajo del umbral de auto-aprobación no se aprueba sola
  // solo porque le quitamos la señal del acceso.
  if ((row.score ?? 0) < SCORE_AUTO_APPROVE) return null;

  return { nextStatus: 'auto_approved', removedFlag: ACCESS_FLAG };
}

// ── La lista del profesor ────────────────────────────────────────────────────

/** Una clase agendada del calendario que no tiene ingreso registrado. */
export interface MissingJoinClass {
  /** Estable: alumno + fecha + hora. Es la clave de la solicitud. */
  key: string;
  date: string;           // 'YYYY-MM-DD'
  hour: string;           // 'HH:MM' — hora de INICIO
  /** 2 en una sesión de celdas contiguas: la clase vale dos. */
  durationHours: number;
  hoursLabel: string;     // '17:00 - 19:00' en una sesión de 2h
  studentName: string;
  /** Solicitud ya enviada para esta clase, si la hay. */
  request?: ClassReviewRequest;
  /**
   * Indicio de que la clase EXISTIÓ: hay transcript, o hay un registro que el
   * profesor creó sobre ella. `null` = el calendario dice que tocaba, pero no
   * quedó ni un rastro de que ocurriera.
   */
  signal: ClassSignal | null;
  /**
   * Fila de class_analyses con el transcript de ESTA clase, cuando ya existe.
   *
   * Es lo que evita pedirle al profesor un texto que ya subió: con esto la
   * solicitud se engancha al análisis existente y no hay que abrir el modal (que
   * además dispararía el detector de duplicados contra su propio transcript).
   * También es lo que permite el envío en bloque.
   */
  analysisId?: string;
}

/** De dónde sale el indicio de que la clase ocurrió. */
export type ClassSignal = 'transcript' | 'registro';

export function signalLabel(s: ClassSignal | null): string {
  return s === 'transcript' ? 'Transcript subido'
    : s === 'registro' ? 'Registro del profesor'
      : 'Sin rastro';
}

/**
 * Clases agendadas del rango que NO tienen ingreso, para que el profesor pueda
 * declararlas. Se apoya en `buildAttendanceRows`, que es la fuente única que
 * expande el calendario a clases con fecha y ya agrupa las celdas contiguas en
 * una sola sesión de 2h (un ingreso esperado, no dos).
 *
 * Se descartan:
 *   · las clases que YA tienen constancia de cancelación o reprogramación: esas
 *     no se dieron y el profesor ya dijo lo que pasó con ellas;
 *   · las anteriores al alta del alumno, que el calendario proyecta hacia atrás
 *     porque los slots son recurrentes y no saben desde cuándo existen;
 *   · las de hoy que todavía no empezaron (`buildAttendanceRows` las da como
 *     'pending', no 'missed').
 *
 * Las que ya tienen solicitud SÍ se devuelven, con `request` cargada: el profesor
 * tiene que ver en qué quedó lo que mandó, no que la fila desaparezca.
 *
 * `onlyWithSignal` (por defecto true) deja fuera las clases de las que no quedó
 * NINGÚN rastro. El calendario proyecta el horario recurrente sobre todo el mes,
 * así que sin ese filtro la lista incluye cada vacación, cada semana que el
 * alumno no vino y cada hueco: 555 filas en agosto de 2026 para 22 profesores,
 * con 53 para uno solo. Preguntarle al profesor por una clase de la que no hay
 * ni transcript ni registro es pedirle que recuerde qué pasó un martes de hace
 * tres semanas. El panel del admin sí puede verlas todas (`onlyWithSignal: false`).
 */
export function buildMissingJoinClasses(opts: {
  assignments: Assignment[];
  joinLogs: ClassJoinLog[];
  classRecords: ClassRecord[];
  requests: ClassReviewRequest[];
  /** Transcripts guardados: uno de ellos es el indicio más fuerte de que la clase existió. */
  analyses?: ClassTranscriptRef[];
  /** Bajas registradas: cierran el período del alumno (ver lib/studentPeriod). */
  dropouts?: Array<{ teacherId: string; studentName: string; droppedAt?: string }>;
  teacherId: string;
  fromDate: string;
  toDate: string;
  todayIso: string;
  nowMinutes: number;
  gridOccupancy: GridOccupancy;
  /** false → también las clases sin ningún rastro (solo el panel del admin). */
  onlyWithSignal?: boolean;
}): MissingJoinClass[] {
  const { assignments, joinLogs, classRecords, requests, teacherId, dropouts } = opts;
  const analyses = opts.analyses ?? [];
  const onlyWithSignal = opts.onlyWithSignal ?? true;

  const rows: LogRow[] = buildAttendanceRows({
    assignments, joinLogs, teacherId,
    fromDate: opts.fromDate, toDate: opts.toDate,
    todayIso: opts.todayIso, nowMinutes: opts.nowMinutes,
    includeFuture: false,
    gridOccupancyByTeacher: { [teacherId]: opts.gridOccupancy },
  });

  // Período del alumno (inicio y baja). Reemplaza al filtro propio que solo
  // miraba `startDate`: ahora es la misma regla que usan asistencias y la agenda,
  // y de paso cubre el lado de la baja. Ver el contrato en lib/studentPeriod.ts.
  const periodos = periodIndex(assignments, dropouts ?? [], teacherId);

  // Por alumno + fecha + HORA, que es la clave del índice único de la tabla: un
  // alumno puede tener dos clases sueltas el mismo día (14:00 y 18:00) y son dos
  // solicitudes distintas. El índice por fecha a secas queda como respaldo para
  // las solicitudes que se guardaron sin hora.
  const requestByKey = new Map<string, ClassReviewRequest>();
  const requestByDate = new Map<string, ClassReviewRequest>();
  for (const r of requests) {
    if (r.teacherId !== teacherId) continue;
    requestByKey.set(`${nk(r.studentName)}|${r.classDate}|${r.classTime ?? ''}`, r);
    if (!r.classTime) requestByDate.set(`${nk(r.studentName)}|${r.classDate}`, r);
  }

  // Índices de rastro por alumno+fecha. Se admite ±1 día a propósito: un
  // transcript o un registro guardados con un día de corrimiento siguen siendo
  // prueba de que esa clase existió, y el error caro acá es OCULTARLE al profesor
  // una clase que sí puede reclamar. Al revés solo sobra una fila.
  const fechasConTranscript = new Map<string, Array<{ date: string; id?: string }>>();
  for (const t of analyses) {
    if (t.teacher_id && t.teacher_id !== teacherId) continue;
    const tieneTexto = typeof t.has_transcript === 'boolean'
      ? t.has_transcript
      : !!t.transcript && t.transcript.trim().length > 0;
    if (!tieneTexto) continue;
    const d = t.class_date || (t.analyzed_at ?? '').slice(0, 10);
    if (!d) continue;
    const k = nk(t.student_name);
    const arr = fechasConTranscript.get(k);
    if (arr) arr.push({ date: d, id: t.id ?? undefined });
    else fechasConTranscript.set(k, [{ date: d, id: t.id ?? undefined }]);
  }
  const fechasConRegistro = new Map<string, string[]>();
  for (const r of classRecords) {
    if (r.teacherId !== teacherId || !r.classDate) continue;
    const k = nk(r.studentName);
    const arr = fechasConRegistro.get(k);
    if (arr) arr.push(r.classDate); else fechasConRegistro.set(k, [r.classDate]);
  }
  const dist = (a: string, b: string) => Math.abs(
    (new Date(a + 'T00:00:00').getTime() - new Date(b + 'T00:00:00').getTime()) / 86_400_000);
  const cerca = (fechas: string[] | undefined, date: string) =>
    (fechas ?? []).some(d => dist(d, date) <= 1);
  /** El transcript de esa clase: fecha exacta primero, después el vecino. */
  const transcriptDe = (alumno: string, date: string) => {
    const arr = fechasConTranscript.get(alumno) ?? [];
    return arr.find(t => t.date === date) ?? arr.find(t => dist(t.date, date) <= 1);
  };

  // Ingresos por alumno+FECHA, sin mirar la hora.
  //
  // `buildAttendanceRows` decide "no ingresó" por hora exacta: si el profesor
  // pulsó el botón a las 14:00 y el calendario dice 15:00, esa clase sale
  // 'missed'. Pero FINANZAS empareja por alumno + fecha (el candidato no tiene
  // hora), así que esa clase YA está cobrada. Sin esta comprobación la pantalla
  // le ofrecería reclamar clases que ya le están pagando, y cada solicitud
  // aprobada crearía un segundo ingreso del mismo día.
  const ingresoEseDia = new Set<string>();
  for (const l of joinLogs) {
    if (l.teacherId !== teacherId) continue;
    ingresoEseDia.add(`${nk(l.studentName)}|${l.scheduledDate}`);
  }

  const out: MissingJoinClass[] = [];
  for (const row of rows) {
    if (row.status !== 'missed') continue;
    if (ingresoEseDia.has(`${nk(row.studentName)}|${row.date}`)) continue;

    if (!existsForStudent(periodos, row.studentName, row.date)) continue;

    // Ya dijo qué pasó con esta clase: cancelada, con aviso, reprogramada…
    if (cancellationFor(classRecords, teacherId, row.studentName, row.date)) continue;
    if (rescheduledTargetFor(classRecords, teacherId, row.studentName, row.date)) continue;

    const alumno = nk(row.studentName);
    const tx = transcriptDe(alumno, row.date);
    const signal: ClassSignal | null =
      tx ? 'transcript'
        : cerca(fechasConRegistro.get(alumno), row.date) ? 'registro'
          : null;

    const request = requestByKey.get(`${alumno}|${row.date}|${row.hour}`)
      ?? requestByDate.get(`${alumno}|${row.date}`);

    // Una solicitud ya enviada se muestra SIEMPRE: el profesor tiene que poder
    // ver en qué quedó, tenga rastro o no.
    if (onlyWithSignal && !signal && !request) continue;

    out.push({
      key: `${alumno}|${row.date}|${row.hour}`,
      date: row.date,
      hour: row.hour,
      durationHours: row.durationHours,
      hoursLabel: row.hoursLabel,
      studentName: row.studentName,
      request,
      signal,
      analysisId: tx?.id,
    });
  }

  // Más reciente primero: es la que el profesor tiene fresca.
  return out.sort((a, b) => b.date.localeCompare(a.date) || a.hour.localeCompare(b.hour));
}

/** Las que todavía no se declararon. Es el número que duele y el que se destaca. */
export function pendingToDeclare(list: MissingJoinClass[]): MissingJoinClass[] {
  return list.filter(c => !c.request);
}

// ── Persistencia ─────────────────────────────────────────────────────────────

function mapRequest(row: Record<string, unknown>): ClassReviewRequest {
  return {
    id:            row.id as string,
    teacherId:     row.teacher_id as string,
    teacherName:   row.teacher_name as string,
    studentName:   row.student_name as string,
    classDate:     row.class_date as string,
    classTime:     (row.class_time as string) ?? undefined,
    durationHours: (row.duration_hours as number) ?? 1,
    // Sin migrar → undefined. `durationHours` sigue siendo el automático.
    durationHoursAuto: typeof row.duration_hours_auto === 'number' ? row.duration_hours_auto : undefined,
    durationSource: row.duration_source === 'admin' ? 'admin' : 'calendario',
    requestedType: row.requested_type as ReviewRequestType,
    analysisId:    (row.analysis_id as string) ?? undefined,
    comment:       (row.comment as string) ?? undefined,
    status:        (row.status as ClassReviewRequest['status']) ?? 'pendiente',
    resolvedType:  (row.resolved_type as ReviewResolvedType) ?? undefined,
    reviewNote:    (row.review_note as string) ?? undefined,
    reviewedBy:    (row.reviewed_by as string) ?? undefined,
    reviewedAt:    (row.reviewed_at as string) ?? undefined,
    joinLogId:     (row.join_log_id as string) ?? undefined,
    createdAt:     row.created_at as string,
  };
}

/**
 * Solicitudes. Sin `teacherId` trae las de todos (panel del admin).
 *
 * Pagina de 1000 en 1000: PostgREST corta cualquier select en 1000 filas sin
 * avisar, que es exactamente lo que dejó a finanzas sin ver julio entero.
 */
export async function dbGetReviewRequests(teacherId?: string): Promise<ClassReviewRequest[]> {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from('class_review_requests').select('*')
      .order('class_date', { ascending: false }).range(from, from + 999);
    if (teacherId) q = q.eq('teacher_id', teacherId);
    const { data, error } = await q;
    if (error) {
      if (error.code === '42P01') {
        console.warn('[reviewRequests] Falta la tabla class_review_requests. Corré supabase-class-review-requests.sql.');
        return [];
      }
      console.error('[reviewRequests] No se pudieron leer las solicitudes:', error);
      break;
    }
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out.map(mapRequest);
}

/** Cuántas esperan al admin, para el badge de la pestaña. */
export async function dbCountPendingReviewRequests(): Promise<number> {
  const { count, error } = await supabase.from('class_review_requests')
    .select('id', { count: 'exact', head: true }).eq('status', 'pendiente');
  return error ? 0 : (count ?? 0);
}

/**
 * Crea la solicitud. NO crea ingreso ni constancia: eso es cosa de la validación.
 *
 * Lo único que puede haberse escrito antes es el TRANSCRIPT de las de tipo
 * 'normal', y va por la vía de siempre (class_analyses, con su validación y su
 * análisis). Sin ingreso no cobra, así que guardarlo ya no adelanta ningún pago
 * y evita tener el texto duplicado en dos tablas.
 */
export async function dbCreateReviewRequest(p: {
  teacherId: string; teacherName: string; studentName: string;
  classDate: string; classTime?: string; durationHours?: number;
  requestedType: ReviewRequestType;
  analysisId?: string | null;
  comment?: string;
}): Promise<ClassReviewRequest> {
  const row = {
    id:             `crr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    teacher_id:     p.teacherId,
    teacher_name:   p.teacherName,
    student_name:   p.studentName,
    class_date:     p.classDate,
    class_time:     p.classTime ?? null,
    duration_hours: p.durationHours ?? 1,
    // El automático se guarda POR DUPLICADO desde el minuto cero. Copiarlo solo
    // cuando el admin corrige dejaría a las solicitudes sin corregir sin forma de
    // decir "este número lo puso el calendario" salvo por ausencia, y una
    // columna que a veces significa una cosa y a veces otra es la que acaba
    // interpretándose mal. Acá `duration_hours_auto` siempre es el automático.
    duration_hours_auto: p.durationHours ?? 1,
    duration_source: 'calendario',
    requested_type: p.requestedType,
    analysis_id:    p.analysisId || null,
    comment:        p.comment || null,
    status:         'pendiente',
    created_at:     new Date().toISOString(),
  };
  let { error } = await supabase.from('class_review_requests').insert(row);
  // Sin la migración de duración: se envía igual, sin el rastro del automático.
  if (error && (error.code === 'PGRST204' || error.code === '42703')) {
    console.warn('[reviewRequests] class_review_requests sin duration_hours_auto/duration_source. Corré supabase-review-duration.sql.');
    const { duration_hours_auto, duration_source, ...sinAuditoria } = row;
    void duration_hours_auto; void duration_source;
    ({ error } = await supabase.from('class_review_requests').insert(sinAuditoria));
  }
  if (error) {
    if (error.code === '23505') throw new Error('Esta clase ya tiene una solicitud enviada.');
    if (error.code === '42P01') throw new Error('Falta correr supabase-class-review-requests.sql en la base.');
    throw new Error(`No se pudo enviar la solicitud: ${error.message}`);
  }
  return mapRequest(row);
}

/**
 * Quita del transcript la señal de "sin acceso registrado" ahora que el ingreso
 * existe, y reevalúa si con eso queda aprobado.
 *
 * Best-effort a propósito: si algo de esto falla, la solicitud YA está aprobada y
 * el ingreso creado. Como mucho el transcript se queda esperando en la cola de
 * validación, que es exactamente donde estaba antes.
 */
async function clearAccessFlag(analysisId: string, requestId: string, reviewerName: string): Promise<void> {
  try {
    const { data, error } = await supabase.from('class_analyses')
      .select('validation_status, transcript_validation_score, transcript_validation_flags')
      .eq('id', analysisId).maybeSingle();
    if (error || !data) return;

    const flags = (data.transcript_validation_flags as string[] | null) ?? [];
    const veredicto = statusAfterAccessResolved({
      validationStatus: data.validation_status as string | null,
      score: data.transcript_validation_score as number | null,
      flags,
    });

    const restantes = flags.filter(f => f !== ACCESS_FLAG);

    if (!veredicto) {
      // Se quita igual la señal (ya no es cierta), pero el estado no cambia: hay
      // otra razón para retenerlo, o el score no alcanza para aprobarse solo.
      if (flags.includes(ACCESS_FLAG)) {
        await supabase.from('class_analyses')
          .update({ transcript_validation_flags: restantes }).eq('id', analysisId);
        console.log(
          `[reviewRequests] ${analysisId}: se quita '${ACCESS_FLAG}' (solicitud ${requestId} aprobada), ` +
          `pero sigue en '${data.validation_status}' por [${restantes.join(', ') || 'score insuficiente'}].`,
        );
      }
      return;
    }

    await supabase.from('class_analyses').update({
      transcript_validation_flags: restantes,
      validation_status:           veredicto.nextStatus,
      validation_reviewed_by:      reviewerName,
      validation_reviewed_at:      new Date().toISOString(),
    }).eq('id', analysisId);

    console.log(
      `[reviewRequests] ${analysisId}: se quita '${veredicto.removedFlag}' porque la solicitud ${requestId} ` +
      `creó el ingreso; era la única señal que lo retenía → '${veredicto.nextStatus}'. Aprobó ${reviewerName}.`,
    );
  } catch (err) {
    console.error(`[reviewRequests] No se pudo reevaluar el transcript ${analysisId}:`, err);
  }
}

/**
 * El admin resuelve una solicitud. Es el ÚNICO punto donde una clase sin clic
 * pasa a existir para el pago, y por eso los efectos viven acá y no en la
 * pantalla: quien apruebe, desde donde sea, produce exactamente lo mismo.
 *
 *   · 'normal'          → ingreso manual. El transcript ya está guardado, así que
 *                         la clase queda pagable por el camino de siempre.
 *   · 'falta_sin_aviso' → ingreso manual + constancia. Cobra a tarifa normal, sin
 *                         transcript, y consume cupo del alumno.
 *   · cancelaciones     → SOLO constancia. Sin ingreso: la clase no se dio y no se
 *                         paga. 'cancelada_por_profesor' arrastra su -5 € por la
 *                         misma función que usa el resto del sistema.
 *
 * El orden importa: primero los efectos, después cerrar la solicitud. Si algo
 * falla, queda 'pendiente' y se reintenta; al revés quedaría aprobada sin que la
 * clase existiera.
 */
export async function dbResolveReviewRequest(p: {
  request: ClassReviewRequest;
  decision: 'aprobada' | 'rechazada';
  resolvedType?: ReviewResolvedType;
  /**
   * Horas con las que el admin resuelve la clase. Ausente = las que traía la
   * solicitud. Si difieren, el automático se conserva en `duration_hours_auto` y
   * la clase pasa a contar como corregida a mano — que es lo que le permite a
   * `sessionSpanFor` respetarla también cuando BAJA de 2 h.
   */
  durationHours?: number;
  reviewerName: string;
  note?: string;
}): Promise<{ joinLogId?: string }> {
  // Import perezoso: db.ts es enorme y arrastra medio sistema. Acá solo hacen
  // falta cuatro funciones, y solo al resolver.
  const {
    dbCreateManualJoinLog, dbAddClassRecord, dbApplyFaltaSideEffects,
    dbFindJoinLog, dbSetJoinLogDuration,
  } = await import('@/lib/db');

  const { request: r, decision, reviewerName } = p;
  const tipo: ReviewResolvedType = p.resolvedType ?? r.requestedType;
  let joinLogId: string | undefined;

  // ── Horas con las que se resuelve ──────────────────────────────────────────
  const horas = Math.max(1, Math.round(p.durationHours ?? r.durationHours ?? 1));
  const corregidoAhora = horas !== Math.round(r.durationHours ?? 1);
  const origen: 'solicitud' | 'admin' =
    (corregidoAhora || r.durationSource === 'admin') ? 'admin' : 'solicitud';

  if (decision === 'aprobada') {
    if (resolvedTypeCreatesJoinLog(tipo)) {
      // IDEMPOTENTE. Si esa clase YA tiene ingreso, no se crea otro.
      //
      // /revisiones no ofrece clases que ya tengan ingreso ese día, pero entre
      // que el profesor manda la solicitud y el admin la aprueba pueden pasar
      // días: el profesor puede haber pulsado el botón mientras tanto, o dos
      // admins pueden aprobar la misma solicitud a la vez. Un segundo ingreso no
      // duplicaría el pago (finanzas empareja por alumno+fecha y el segundo log
      // pisa al primero), pero ensucia el historial de accesos y la puntualidad.
      const yaHay = await dbFindJoinLog(r.teacherId, r.studentName, r.classDate);
      joinLogId = yaHay ?? await dbCreateManualJoinLog({
        teacherId:     r.teacherId,
        teacherName:   r.teacherName,
        studentName:   r.studentName,
        scheduledDate: r.classDate,
        scheduledTime: r.classTime ?? '',
        createdBy:     reviewerName,
        durationHours: horas,
        durationSource: origen,
      });
      if (yaHay) {
        // El ingreso reutilizado TAMBIÉN recibe las horas declaradas. Sin esto,
        // la única clase que la guarda de idempotencia protege sería la única
        // que se seguiría pagando por el calendario de hoy.
        await dbSetJoinLogDuration(r.teacherId, r.studentName, r.classDate, horas, origen);
        console.log(`[reviewRequests] ${r.id}: la clase ya tenía ingreso (${yaHay}); no se crea otro (duración ${horas} h · ${origen}).`);
      }
      // El ingreso acaba de existir: la señal `sin_acceso_registrado` del
      // transcript ya no describe nada real. Si era la ÚNICA que lo retenía, la
      // clase se aprueba sola; si había otra, se queda en la cola.
      if (r.analysisId) await clearAccessFlag(r.analysisId, r.id, reviewerName);
    }
    // Las de tipo 'normal' no llevan constancia: el transcript ya la describe, y
    // un class_record de más solo puede ganarle el cruce a otro (ver el bug de
    // las faltas descartadas por colisión, lib/finance.ts).
    if (tipo !== 'normal') {
      await dbAddClassRecord(
        r.teacherId, r.teacherName, r.studentName, r.classDate, r.classTime, '',
        tipo as ClassRecordType,
        `Solicitud de revisión aprobada por ${reviewerName}${r.comment ? ` — ${r.comment}` : ''}`,
      );
      // MISMA condición que TeachersContext.registerClassRecord, a propósito: la
      // falta DEL ALUMNO no dispara ningún efecto (no penaliza y no es asunto del
      // profesor); las cancelaciones sí, y 'cancelada_por_profesor' es la que
      // lleva los -5 €. Enumerarlas acá en vez de llamar siempre evita que un
      // cambio futuro en esa función acabe penalizando una falta del alumno.
      if (tipo === 'cancelada_por_profesor' || tipo === 'cancelacion_hora' || tipo === 'falta_con_aviso') {
        await dbApplyFaltaSideEffects({
          teacherId:   r.teacherId,
          teacherName: r.teacherName,
          studentName: r.studentName,
          classDate:   r.classDate,
          classType:   tipo,
        });
      }
    }
  }

  const cierre = {
    status:        decision,
    resolved_type: decision === 'aprobada' ? tipo : null,
    review_note:   p.note || null,
    reviewed_by:   reviewerName,
    reviewed_at:   new Date().toISOString(),
    join_log_id:   joinLogId ?? null,
  };
  // La corrección del admin solo se escribe si de verdad cambió algo. El
  // automático se preserva: si la solicitud es anterior a la migración no lo
  // tiene, y entonces el que se guarda es el valor PREVIO a esta corrección —
  // que es exactamente el que puso el calendario.
  const duracion = corregidoAhora ? {
    duration_hours:      horas,
    duration_hours_auto: r.durationHoursAuto ?? Math.round(r.durationHours ?? 1),
    duration_source:     'admin',
  } : {};

  let { error } = await supabase.from('class_review_requests').update({ ...cierre, ...duracion }).eq('id', r.id);
  if (error && (error.code === 'PGRST204' || error.code === '42703') && corregidoAhora) {
    console.warn('[reviewRequests] class_review_requests sin las columnas de duración. Corré supabase-review-duration.sql; la solicitud se cierra sin el rastro de la corrección.');
    ({ error } = await supabase.from('class_review_requests').update(cierre).eq('id', r.id));
  }
  if (error) throw new Error(`La clase se registró, pero no se pudo cerrar la solicitud: ${error.message}`);

  if (decision === 'rechazada') {
    await supabase.from('notifications').insert({
      id:          `notif_crr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      target_user: r.teacherId,
      target_role: null,
      title:       'Solicitud de revisión rechazada',
      body:        `La clase de ${r.studentName} del ${r.classDate} no se pudo validar${p.note ? `: ${p.note}` : '.'}`,
      type:        'review_request_rejected',
      read_by:     [],
      created_at:  new Date().toISOString(),
      created_by:  'sistema',
    });
  }

  return { joinLogId };
}
