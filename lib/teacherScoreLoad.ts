// ── SCORING v2: lectura y guardado (SOLO SERVIDOR) ────────────────────────────
//
// Lee de la base lo que necesita el motor (lib/teacherScore), le pasa las filas
// y, si se pide, guarda la foto del día en teacher_score_snapshots. El cálculo
// NO vive acá: este archivo solo trae filas y las adapta.
//
//   · Todas las consultas van paginadas de a 1000 (fetchAllPages): Supabase corta
//     en 1000 filas y sin paginar el puntaje saldría con datos de menos.
//   · De class_analyses se pide `has_transcript`, jamás el texto (egress).
//   · Cuentas de prueba: teachers.is_test (y t1, por las dudas) y students.is_test
//     quedan fuera de TODO, también de los promedios de la academia.
//   · Los profes archivados no reciben puntaje, pero su historia sí cuenta para
//     los promedios.
//
// Lo usan: /api/admin/teacher-score-v2 (pestaña "Scoring v2 (beta)" y el botón
// "Recalcular ahora"), el cron check-ending-plans (foto diaria) y
// scripts/score-v2-preview.mts (vista previa sin guardar).

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { dbGetTeachers, fetchAllPages } from '@/lib/db';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { getSpainParts } from '@/lib/spainTime';
import { addDaysIso } from '@/lib/teacherClasses';
import { buildTestAccountFilter } from '@/lib/testAccounts';
import { AJUSTES_MANUALES, FORMULA_VERSION, VENTANA_DIAS } from '@/lib/teacherScoreConfig';
import {
  calcularScoringV2, filaSnapshot,
  type AnalisisScore, type AsignacionScore, type AuditoriaScore, type BajaScore, type EntradaScore,
  type EventoScore, type FilaSnapshot, type RecuperacionScore, type ResultadoScore, type TransferenciaScore,
} from '@/lib/teacherScore';
import type { ClassTranscriptRef } from '@/lib/transcriptDeadline';
import type { ClassJoinLog, ClassRecord } from '@/types';

type Fila = Record<string, unknown>;
type Res = PromiseLike<{ data: Fila[] | null; error: { message: string; code?: string } | null }>;

const TABLA = 'teacher_score_snapshots';
/** El perfil de prueba histórico: se excluye aunque alguien le quite la marca. */
const PRUEBA_FIJA = 't1';

const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const sn = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function clienteAdmin(): SupabaseClient {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY: el scoring v2 no puede leer ni guardar.');
  return admin;
}

/** Lectura paginada. Una tabla obligatoria que falla corta el cálculo (no se guarda nada a medias). */
async function leer(label: string, run: (from: number, to: number) => Res, errores: string[], opcional = false): Promise<Fila[]> {
  const { rows, error } = await fetchAllPages<Fila>(label, run);
  if (error) {
    console.warn(`[scoring-v2] ${label}:`, error.message);
    if (!opcional) errores.push(`${label}: ${error.message}`);
  }
  return rows;
}

/** Calcula el scoring v2 de todos los profes, sin guardar nada. */
export async function calcularScoringV2Ahora(opts: { now?: number } = {}): Promise<ResultadoScore & { hoy: string }> {
  const now = opts.now ?? Date.now();
  const hoy = getSpainParts(new Date(now)).dateStr;
  const desde = addDaysIso(hoy, -(VENTANA_DIAS - 1));
  // Instantes: un día de margen por la diferencia entre UTC y la hora española.
  const desdeTs = `${addDaysIso(desde, -1)}T00:00:00Z`;
  const db = clienteAdmin();
  const errores: string[] = [];

  const [
    teachers, teachersRaw, studentsPrueba, asignaciones, bajas, transferencias, ingresosRaw, recordsRaw,
    analysesRaw, primerasRaw, recuperaciones, eventosRaw, auditorias, hablaRaw,
  ] = await Promise.all([
    dbGetTeachers(),
    leer('teachers', (f, t) => db.from('teachers').select('id, name, is_test').order('id').range(f, t), errores),
    leer('students', (f, t) => db.from('students').select('id, name, email, is_test').eq('is_test', true).order('id').range(f, t), errores),
    leer('assignments', (f, t) => db.from('assignments')
      .select('id, teacher_id, student_id, student_name, status, teacher_since, start_date, created_at, calendar_removed_at')
      .order('id').range(f, t), errores),
    leer('student_dropouts', (f, t) => db.from('student_dropouts')
      .select('id, teacher_id, student_id, student_name, start_date, dropped_at').order('id').range(f, t), errores),
    leer('transfer_requests', (f, t) => db.from('transfer_requests')
      .select('id, assignment_id, from_teacher_id, created_at').eq('estado', 'ok').order('id').range(f, t), errores),
    // Todos los ingresos (pocas columnas): la ventana la recorta el motor, y la
    // fecha de la primera clase necesita la historia entera.
    leer('class_join_logs', (f, t) => db.from('class_join_logs')
      .select('id, teacher_id, teacher_name, student_name, scheduled_date, scheduled_time, clicked_at, punctuality, source, duration_hours, transcript_deadline_at')
      .order('id').range(f, t), errores),
    leer('class_records', (f, t) => db.from('class_records')
      .select('id, teacher_id, student_name, class_date, class_time, class_type, rescheduled_to, reverted_at')
      .order('id').range(f, t), errores),
    // Sirve para el plazo del transcript y para la señal de riesgo. Nunca el texto.
    leer('class_analyses', (f, t) => db.from('class_analyses')
      .select('id, teacher_id, student_name, class_date, analyzed_at, has_transcript, join_log_id, validation_status, risk_signal, analysis_status')
      .gte('class_date', addDaysIso(desde, -1)).order('id').range(f, t), errores),
    // Opcional: sin la tabla, la hora de subida sale de analyzed_at.
    leer('usage_events', (f, t) => db.from('usage_events')
      .select('id, ref_id, created_at').eq('event', 'transcript_first_upload').gte('created_at', desdeTs)
      .order('id').range(f, t), errores, true),
    leer('class_recoveries', (f, t) => db.from('class_recoveries')
      .select('id, teacher_id, student_name, original_date, late, status, cancel_record_id').order('id').range(f, t), errores),
    leer('scoring_events', (f, t) => db.from('scoring_events')
      .select('id, teacher_id, event_type, created_at, reverted')
      .in('event_type', ['enlace_tardio', ...Object.keys(AJUSTES_MANUALES)]).gte('created_at', desdeTs)
      .order('id').range(f, t), errores),
    leer('intervention_audits', (f, t) => db.from('intervention_audits')
      .select('id, teacher_id, student_name, signs_of_intervention, created_at').gte('created_at', desdeTs)
      .order('id').range(f, t), errores),
    leer('transcript_fluency', (f, t) => db.from('transcript_fluency')
      .select('analysis_id, student_talk_share').eq('status', 'ready').not('student_talk_share', 'is', null)
      .order('analysis_id').range(f, t), errores),
  ]);

  if (errores.length) throw new Error(`No se pudieron leer: ${errores.join(' · ')}`);

  // ── Cuentas de prueba ──────────────────────────────────────────────────────
  const filtro = buildTestAccountFilter(
    teachersRaw.map(t => ({ id: s(t.id), name: s(t.name), isTest: t.is_test === true || t.id === PRUEBA_FIJA })),
    studentsPrueba.map(x => ({ id: s(x.id), name: s(x.name), email: s(x.email), isTest: true })),
  );
  const esPrueba = (r: Fila, nombre = 'student_name', id = 'student_id') =>
    filtro.isTestRow({ teacherId: sn(r.teacher_id), studentId: sn(r[id]), studentName: sn(r[nombre]) });
  const fuera = <T extends Fila>(rows: T[], nombre?: string, id?: string) => rows.filter(r => !esPrueba(r, nombre, id));

  // ── Adaptar filas ──────────────────────────────────────────────────────────
  const entrada: EntradaScore = {
    hoy, now,
    profesores: teachers
      .filter(t => !filtro.isTestTeacher(t.id))
      .map(t => ({ id: t.id, name: t.name, createdAt: t.createdAt ?? null, weeklyLoad: t.weeklyLoad ?? 0, freeSpots: t.freeSpots ?? 0 })),
    asignaciones: fuera(asignaciones).map((a): AsignacionScore => ({
      id: s(a.id), teacherId: s(a.teacher_id), studentId: sn(a.student_id), studentName: s(a.student_name),
      status: sn(a.status), teacherSince: sn(a.teacher_since), startDate: sn(a.start_date),
      createdAt: sn(a.created_at), calendarRemovedAt: sn(a.calendar_removed_at),
    })),
    bajas: fuera(bajas).map((b): BajaScore => ({
      id: s(b.id), teacherId: s(b.teacher_id), studentId: sn(b.student_id), studentName: s(b.student_name),
      startDate: sn(b.start_date), droppedAt: s(b.dropped_at),
    })),
    transferencias: transferencias
      .filter(t => !filtro.isTestTeacher(sn(t.from_teacher_id)))
      .map((t): TransferenciaScore => ({ assignmentId: s(t.assignment_id), fromTeacherId: s(t.from_teacher_id), createdAt: s(t.created_at) })),
    ingresos: fuera(ingresosRaw, 'student_name', '_').map(r => ({
      id: s(r.id), teacherId: s(r.teacher_id), teacherName: s(r.teacher_name), studentName: s(r.student_name),
      scheduledDate: s(r.scheduled_date), scheduledTime: s(r.scheduled_time), clickedAt: s(r.clicked_at),
      punctuality: s(r.punctuality), source: r.source === 'manual' ? 'manual' : 'click',
      durationHours: typeof r.duration_hours === 'number' ? r.duration_hours : undefined,
      transcriptDeadlineAt: sn(r.transcript_deadline_at) ?? undefined,
    })) as unknown as ClassJoinLog[],
    records: fuera(recordsRaw, 'student_name', '_').map(r => ({
      id: s(r.id), teacherId: s(r.teacher_id), studentName: s(r.student_name), classDate: s(r.class_date),
      classTime: sn(r.class_time) ?? undefined, classType: s(r.class_type) || 'normal',
      rescheduledTo: sn(r.rescheduled_to) ?? undefined, revertedAt: sn(r.reverted_at) ?? undefined,
    })) as unknown as ClassRecord[],
    transcripts: fuera(analysesRaw) as unknown as ClassTranscriptRef[],
    primeraSubida: (() => {
      const m = new Map<string, string>();
      for (const e of primerasRaw) {
        const ref = sn(e.ref_id), at = s(e.created_at);
        if (!ref || !at) continue;
        const prev = m.get(ref);
        if (!prev || at < prev) m.set(ref, at);
      }
      return m;
    })(),
    recuperaciones: fuera(recuperaciones).map((c): RecuperacionScore => ({
      id: s(c.id), teacherId: s(c.teacher_id), studentName: s(c.student_name), originalDate: sn(c.original_date),
      late: c.late === true, status: sn(c.status), cancelRecordId: sn(c.cancel_record_id),
    })),
    eventos: eventosRaw.filter(e => !filtro.isTestTeacher(sn(e.teacher_id))).map((e): EventoScore => ({
      id: s(e.id), teacherId: s(e.teacher_id), eventType: s(e.event_type), createdAt: s(e.created_at), reverted: e.reverted === true,
    })),
    auditorias: fuera(auditorias).map((a): AuditoriaScore => ({
      id: s(a.id), teacherId: s(a.teacher_id), studentName: s(a.student_name),
      signsOfIntervention: typeof a.signs_of_intervention === 'boolean' ? a.signs_of_intervention : null,
      createdAt: s(a.created_at),
    })),
    analisis: fuera(analysesRaw).map((a): AnalisisScore => ({
      id: s(a.id), teacherId: s(a.teacher_id), studentName: s(a.student_name), classDate: sn(a.class_date),
      riskSignal: sn(a.risk_signal), analysisStatus: sn(a.analysis_status),
    })),
    habla: new Map(hablaRaw
      .filter(h => typeof h.student_talk_share === 'number')
      .map(h => [s(h.analysis_id), h.student_talk_share as number])),
    primeraClase: (() => {
      const m = new Map<string, string>();
      const anotar = (tid: string, d: string) => {
        // Hay fechas mal cargadas (año "0026", una de 2006): antes de 2026 no había clases en la plataforma.
        if (!tid || !/^20\d\d-\d\d-\d\d$/.test(d) || d < '2026-01-01') return;
        const prev = m.get(tid);
        if (!prev || d < prev) m.set(tid, d);
      };
      for (const l of ingresosRaw) anotar(s(l.teacher_id), s(l.scheduled_date).slice(0, 10));
      for (const r of recordsRaw) anotar(s(r.teacher_id), s(r.class_date).slice(0, 10));
      return m;
    })(),
  };

  return { ...calcularScoringV2(entrada), hoy };
}

/** Calcula y guarda la foto de HOY (hora de España). Recalcular el mismo día la pisa. */
export async function guardarScoringV2(opts: { now?: number } = {}): Promise<{ fecha: string; guardadas: number; resultado: ResultadoScore }> {
  const resultado = await calcularScoringV2Ahora(opts);
  const filas: FilaSnapshot[] = resultado.profesores.map(r => filaSnapshot(r, resultado.academia, resultado.hoy));
  if (filas.length) {
    const { error } = await clienteAdmin().from(TABLA)
      .upsert(filas, { onConflict: 'teacher_id,snapshot_date,formula_version' });
    if (error) throw new Error(`No se pudo guardar ${TABLA}: ${error.message}`);
  }
  console.log(`[scoring-v2] Foto del ${resultado.hoy}: ${filas.length} profesor(es).`);
  return { fecha: resultado.hoy, guardadas: filas.length, resultado };
}

/** La última foto guardada de la versión actual: fecha y una fila por profe. */
export async function leerUltimoScoringV2(): Promise<{ fecha: string | null; filas: FilaSnapshot[] }> {
  const db = clienteAdmin();
  const ultima = await db.from(TABLA).select('snapshot_date')
    .eq('formula_version', FORMULA_VERSION).order('snapshot_date', { ascending: false }).limit(1);
  if (ultima.error) throw new Error(ultima.error.message);
  const fecha = (ultima.data?.[0] as { snapshot_date?: string } | undefined)?.snapshot_date ?? null;
  if (!fecha) return { fecha: null, filas: [] };
  const { rows, error } = await fetchAllPages<Fila>(TABLA, (f, t) => db.from(TABLA)
    .select('teacher_id, snapshot_date, formula_version, score, level, confidence, retention_score, compliance_score, risk_score, quality_score, growth_score, details')
    .eq('formula_version', FORMULA_VERSION).eq('snapshot_date', fecha).order('teacher_id').range(f, t) as unknown as Res);
  if (error) throw new Error(error.message);
  // numeric llega como número desde PostgREST; se fuerza por si llega como texto.
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    fecha,
    filas: rows.map(r => ({
      ...(r as unknown as FilaSnapshot),
      score: num(r.score), retention_score: num(r.retention_score), compliance_score: num(r.compliance_score),
      risk_score: num(r.risk_score), quality_score: num(r.quality_score), growth_score: num(r.growth_score),
    })),
  };
}
