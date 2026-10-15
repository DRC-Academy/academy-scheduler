// Testimoniales V6 — recortes de cada transcript y UNA pareja por alumno, todo
// por código (sin IA). SOLO SERVIDOR.
//
// Tablas (supabase-testimoniales-v6.sql):
//   · testimonial_segments: los mejores recortes A y B de cada transcript;
//   · testimonial_transcripts.segments_at / segment_stats: transcript procesado y
//     lo que se descartó al extraer (+ palabras/segundos para la velocidad media);
//   · testimonial_audit: por qué cada alumno sale o no sale;
//   · testimonial_candidates: la pareja ('detectado') de cada alumno.
//
// FLUJO DE UN TRANSCRIPT (processTranscript): lib/testimonialSpeaker decide quién
// es el alumno (si no es seguro, 'excluded'); lib/testimonialScoring extrae sus
// recortes; se guardan. Después syncSegmentPairs rehace la pareja de ese alumno.
// Corre con cada transcript nuevo (after() en save-transcript y analyze-transcript)
// y, para el histórico, por tandas desde la pestaña o con `npm run testimonios`.
//
// REGLAS DE LAS PAREJAS (decisiones de Facundo, 15/10/2026):
//   · una sola por alumno; si ya tiene una "Sirve", no se le busca otra;
//   · "Sirve" y "No sirve" nunca se tocan;
//   · "No sirve" bloquea SOLO esos dos momentos: otros recortes del mismo alumno
//     con el mismo profe sí pueden salir.

import 'server-only';

import { supabase } from '@/lib/supabase';
import { parseTurns, extractFathomUrl, withFathomTimestamp } from '@/lib/fluency';
import { resolveStudentKey } from '@/lib/fluencyStore';
import { spainTodayIso } from '@/lib/retention';
import { resolveStudentLabel, type LabelExclusion } from '@/lib/testimonialSpeaker';
import {
  extractSegments, averageWpm, choosePair, linguisticBlock, segDuration,
  type Segment, type ExtractStats, type NoPairReason, type ScoredPair,
} from '@/lib/testimonialScoring';
import { FACTOR_VELOCIDAD_A } from '@/lib/testimonialConfig';
import type { TestimonialClip, TestimonialClips } from '@/lib/testimonials';

type Row = Record<string, unknown>;

/** Transcripts por tanda y cuántos a la vez dentro de la tanda (sin IA: ~0,5 s cada uno). */
export const BATCH_SIZE = 20;
const CONCURRENCY = 5;
const LEASE_MS = 2 * 60_000;
const NEVER = '2000-01-01T00:00:00.000Z';
/** Estados de una pareja que el admin ya marcó "Sirve". */
const SIRVEN = ['listo', 'revisado', 'permiso_alumno'];

export type AuditOutcome = 'pareja' | 'sin_pareja' | 'ya_sirve' | 'sin_clases_validas';

// ── Un transcript ────────────────────────────────────────────────────────────

export interface ProcessResult {
  analysisId: string;
  status: 'ready' | 'excluded' | 'missing';
  studentGroup?: string;
  reason?: LabelExclusion;
  segments?: number;
}

function classDayOf(ca: Row): string {
  if (ca.class_date) return String(ca.class_date).slice(0, 10);
  return ca.analyzed_at ? spainTodayIso(new Date(String(ca.analyzed_at))) : '';
}

const segmentRow = (s: Segment): Row => ({
  id: s.id, analysis_id: s.analysisId, student_group: s.studentGroup, teacher_id: s.teacherId,
  class_day: s.classDay || null, student_label: s.studentLabel, kind: s.kind, turn_index: s.turnIndex,
  start_s: s.start, end_s: s.end, text: s.text, words: s.words, fillers: s.fillers, repeats: s.repeats,
  searches: s.searches, spanish_words: s.spanishWords, turn_wpm: Math.round(s.turnWpm * 10) / 10,
  teacher_before: s.teacherBefore, fathom_url: s.fathomUrl,
});

const toSegment = (r: Row): Segment => ({
  id: String(r.id), kind: r.kind as Segment['kind'], analysisId: String(r.analysis_id),
  studentGroup: String(r.student_group), teacherId: (r.teacher_id as string | null) ?? null,
  classDay: String(r.class_day ?? ''), studentLabel: String(r.student_label ?? ''),
  fathomUrl: (r.fathom_url as string | null) ?? null, turnIndex: Number(r.turn_index),
  start: Number(r.start_s), end: Number(r.end_s), text: String(r.text ?? ''), words: Number(r.words),
  fillers: Number(r.fillers), repeats: Number(r.repeats), searches: Number(r.searches),
  spanishWords: Number(r.spanish_words), turnWpm: Number(r.turn_wpm), teacherBefore: r.teacher_before === true,
});

/** Extrae y guarda los recortes de UN transcript. Con `dryRun` no escribe. */
export async function processTranscript(analysisId: string, opts: { dryRun?: boolean } = {}): Promise<ProcessResult> {
  // Lectura de UNA fila con su transcript: nunca en listados (ver has_transcript).
  const { data: ca } = await supabase.from('class_analyses')
    .select('id, transcript, student_id, student_name, teacher_id, class_date, analyzed_at')
    .eq('id', analysisId).maybeSingle();
  if (!ca) {
    if (!opts.dryRun) await supabase.from('testimonial_transcripts').update({ segments_at: new Date().toISOString() }).eq('analysis_id', analysisId);
    return { analysisId, status: 'missing' };
  }
  const { data: prev } = await supabase.from('testimonial_transcripts')
    .select('student_group').eq('analysis_id', analysisId).maybeSingle();

  const transcript = String(ca.transcript ?? '');
  const studentName = (ca.student_name as string | null) ?? null;
  const studentGroup = (ca.student_id as string | null)
    ?? (prev?.student_group as string | null)
    ?? await resolveStudentKey(null, studentName);
  const teacherId = (ca.teacher_id as string | null) ?? null;
  const classDay = classDayOf(ca);
  const fathomUrl = extractFathomUrl(transcript);
  const now = new Date().toISOString();
  const base: Row = {
    analysis_id: analysisId, student_group: studentGroup, student_name: studentName,
    teacher_id: teacherId, class_day: classDay || null, fathom_url: fathomUrl, updated_at: now, segments_at: now,
  };

  const save = async (row: Row, segments: Segment[]) => {
    if (opts.dryRun) return;
    // Los recortes de una clase se rehacen enteros.
    const { error: delErr } = await supabase.from('testimonial_segments').delete().eq('analysis_id', analysisId);
    if (delErr) throw new Error(`Borrando recortes: ${delErr.message}`);
    if (segments.length) {
      const { error } = await supabase.from('testimonial_segments').insert(segments.map(segmentRow));
      if (error) throw new Error(`Guardando recortes: ${error.message}`);
    }
    const { error } = await supabase.from('testimonial_transcripts').upsert({ ...base, ...row }, { onConflict: 'analysis_id' });
    if (error) throw new Error(`Guardando el transcript: ${error.message}`);
  };

  const turns = parseTurns(transcript);
  const label = resolveStudentLabel(turns, studentName);
  if (!label.ok) {
    await save({ status: 'excluded', exclusion_reason: label.reason, student_label: null, teacher_label: null, segment_stats: null }, []);
    return { analysisId, status: 'excluded', studentGroup, reason: label.reason };
  }
  const { segments, stats } = extractSegments({
    analysisId, studentGroup, teacherId, classDay, studentLabel: label.studentLabel, fathomUrl, turns,
  });
  await save({
    status: 'ready', exclusion_reason: null, student_label: label.studentLabel, teacher_label: label.teacherLabel,
    segment_stats: stats, last_error: null,
  }, segments);
  return { analysisId, status: 'ready', studentGroup, segments: segments.length };
}

/** Para `after()` al subir un transcript: extrae y rehace la pareja del alumno. Nunca lanza. */
export async function runSegmentsInBackground(analysisId: string): Promise<void> {
  try {
    const r = await processTranscript(analysisId);
    if (r.studentGroup) await syncSegmentPairs([r.studentGroup]);
    console.log(`[testimonios] ${analysisId}: ${r.status}${r.reason ? ` (${r.reason})` : ''}${r.segments != null ? ` · ${r.segments} recortes` : ''}`);
  } catch (err) {
    console.error(`[testimonios] Error inesperado con ${analysisId}:`, err);
  }
}

// ── Parejas (una por alumno) ─────────────────────────────────────────────────

async function pagedRows(table: string, cols: string, order: string, apply?: (q: any) => any): Promise<Row[]> {   // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from(table).select(cols);
    if (apply) q = apply(q);
    const { data, error } = await q.order(order).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as unknown as Row[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

const pct = (x: number) => `${Math.round(x * 100)} %`;
const num = (x: number) => x.toLocaleString('es-ES', { maximumFractionDigits: 1 });
const plural = (n: number, s: string, p: string) => `${num(n)} ${n === 1 ? s : p}`;

/** Lo que el código vio en el recorte, en una frase para la tarjeta. */
function explain(s: Segment, score: number, avgWpm: number | null): string {
  const parts: string[] = [];
  if (s.fillers) parts.push(plural(s.fillers, 'muletilla', 'muletillas'));
  if (s.repeats) parts.push(plural(s.repeats, 'repetición', 'repeticiones'));
  if (s.searches) parts.push(s.searches === 1 ? 'busca una palabra' : `busca palabras (${s.searches})`);
  if (s.spanishWords) parts.push(plural(s.spanishWords, 'palabra en español', 'palabras en español'));
  if (avgWpm) parts.push(`va al ${pct(s.turnWpm / avgWpm)} de su velocidad media`);
  if (s.kind === 'B' && !s.fillers && !s.repeats && !s.spanishWords) parts.push('sin dudas');
  const titulo = s.kind === 'A' ? 'Bloqueo' : 'Fluidez';
  return `${titulo} ${num(score)}: ${parts.join(' · ') || 'sin señales'}.`;
}

function toClip(s: Segment, why: string): TestimonialClip {
  return {
    analysisId: s.analysisId, classDate: s.classDay, teacherId: s.teacherId, start: s.start, end: s.end,
    excerpt: s.text, why, fathomUrl: withFathomTimestamp(s.fathomUrl, s.start), speakerLabel: s.studentLabel,
  };
}

function pairColumns(p: ScoredPair, studentName: string | null, avgWpm: number | null): Row {
  const whyA = explain(p.a, p.aScore, avgWpm), whyB = explain(p.b, p.bScore, avgWpm);
  const clips: TestimonialClips = { malos: [toClip(p.a, whyA)], buenos: [toClip(p.b, whyB)] };
  const side = (pre: 'before' | 'after', s: Segment, score: number) => ({
    [`${pre}_analysis_id`]: s.analysisId, [`${pre}_teacher_id`]: s.teacherId, [`${pre}_class_number`]: null,
    [`${pre}_class_date`]: s.classDay || null, [`${pre}_score`]: Math.round(score), [`${pre}_excerpt`]: s.text,
    [`${pre}_excerpt_at`]: `${Math.floor(s.start / 60)}:${String(s.start % 60).padStart(2, '0')}`,
    [`${pre}_fathom_url`]: withFathomTimestamp(s.fathomUrl, s.start), [`${pre}_moment_id`]: s.id,
  });
  return {
    student_group: p.a.studentGroup,
    student_id: p.a.studentGroup.startsWith('name:') ? null : p.a.studentGroup,
    student_name: studentName,
    pair_teacher_id: p.a.teacherId,
    student_label: p.b.studentLabel,
    reverse_order: false,
    ...side('before', p.a, p.aScore),
    ...side('after', p.b, p.bScore),
    clips,
    improvement: Math.round(p.aScore + p.bScore),
    ai_review_status: 'ready', ai_is_real: true, ai_error: null, ai_summary: null,
    ai_reason: `V6 por código · ${Math.floor(p.gapDays / 7)} semanas entre clases · A ${num(segDuration(p.a))} s, B ${num(segDuration(p.b))} s.`,
  };
}

export interface SyncResult {
  created: number;
  updated: number;
  deleted: number;
  /** Alumnos por resultado y, los sin pareja, por motivo. */
  outcomes: Partial<Record<AuditOutcome, number>>;
  reasons: Partial<Record<NoPairReason, number>>;
}

/**
 * Rehace la pareja de unos alumnos (o de todos sin `groups`) y su auditoría.
 * Nunca toca lo marcado "Sirve" ni "No sirve"; solo crea, cambia o borra las
 * parejas 'detectado' ("Por revisar").
 */
export async function syncSegmentPairs(groups?: string[]): Promise<SyncResult> {
  const res: SyncResult = { created: 0, updated: 0, deleted: 0, outcomes: {}, reasons: {} };
  if (groups && groups.length === 0) return res;
  const filter = (q: any) => (groups ? q.in('student_group', groups) : q);   // eslint-disable-line @typescript-eslint/no-explicit-any
  const [segRows, txRows, candRows] = await Promise.all([
    pagedRows('testimonial_segments', 'id, analysis_id, student_group, teacher_id, class_day, student_label, kind, turn_index, start_s, end_s, text, words, fillers, repeats, searches, spanish_words, turn_wpm, teacher_before, fathom_url', 'id', filter),
    pagedRows('testimonial_transcripts', 'analysis_id, student_group, student_name, status, exclusion_reason, segments_at, segment_stats', 'analysis_id', filter),
    pagedRows('testimonial_candidates', 'id, student_group, student_name, status, pair_teacher_id, clips, before_moment_id, after_moment_id', 'id', filter),
  ]);
  const bucket = <T extends Row>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) { const g = String(r.student_group); m.set(g, [...(m.get(g) ?? []), r]); }
    return m;
  };
  const segsBy = bucket(segRows), txBy = bucket(txRows), candBy = bucket(candRows);
  const all = new Set([...(groups ?? []), ...txBy.keys(), ...candBy.keys()]);
  const now = new Date().toISOString();
  const audit: Row[] = [];

  const deleteOpen = async (rows: Row[]) => {
    for (const r of rows) {
      const { error } = await supabase.from('testimonial_candidates').delete().eq('id', r.id).eq('status', 'detectado');
      if (error) throw new Error(`Borrando pareja: ${error.message}`);
      res.deleted++;
    }
  };

  for (const g of all) {
    const txs = txBy.get(g) ?? [], cands = candBy.get(g) ?? [];
    const name = (txs.find(t => t.student_name)?.student_name ?? cands.find(c => c.student_name)?.student_name ?? null) as string | null;
    const open = cands.filter(c => c.status === 'detectado');
    const processed = txs.filter(t => t.segments_at);
    // Sin ningún transcript procesado con la V6 todavía: no se decide nada.
    if (txs.length && !processed.length) continue;
    const note = (outcome: AuditOutcome, reason: string | null, details: Row) => {
      res.outcomes[outcome] = (res.outcomes[outcome] ?? 0) + 1;
      audit.push({ student_group: g, student_name: name, outcome, reason, details, updated_at: now });
    };

    const valid = processed.filter(t => t.status === 'ready');
    const excluded: Record<string, number> = {};
    for (const t of processed) if (t.status === 'excluded') excluded[String(t.exclusion_reason)] = (excluded[String(t.exclusion_reason)] ?? 0) + 1;

    if (cands.some(c => SIRVEN.includes(String(c.status)))) {
      // Ya tiene su pareja buena: no se le busca otra (una por alumno).
      await deleteOpen(open);
      note('ya_sirve', null, { clases: valid.length });
      continue;
    }
    if (!valid.length) {
      await deleteOpen(open);
      if (txs.length) note('sin_clases_validas', null, { excluidas: excluded });
      continue;
    }

    const avg = averageWpm(valid.map(t => (t.segment_stats ?? { palabras: 0, segundos: 0 }) as ExtractStats));
    // "No sirve" bloquea SOLO esos momentos: fuera los recortes que se pisan con ellos.
    const banned = cands.filter(c => c.status === 'descartado').flatMap(c => {
      const k = c.clips as TestimonialClips | null;
      return k && Array.isArray(k.malos) && Array.isArray(k.buenos) ? [...k.malos, ...k.buenos] : [];
    });
    const segments = (segsBy.get(g) ?? []).map(toSegment)
      .filter(s => !banned.some(b => b.analysisId === s.analysisId && s.start < b.end && b.start < s.end));
    const choice = choosePair(segments, avg);
    const details: Row = {
      clases: valid.length, excluidas: excluded, recortesA: choice.candidatesA, recortesB: choice.candidatesB,
      momentosDescartados: banned.length, promedioPpm: avg ? Math.round(avg) : null,
      factorVelocidadA: FACTOR_VELOCIDAD_A,
    };

    if (!choice.ok) {
      await deleteOpen(open);
      res.reasons[choice.reason] = (res.reasons[choice.reason] ?? 0) + 1;
      note('sin_pareja', choice.reason, { ...details, rechazadas: choice.rejected });
      continue;
    }

    const p = choice.pair;
    const cols = pairColumns(p, name, avg);
    note('pareja', null, {
      ...details, semanas: Math.floor(p.gapDays / 7), bloqueoA: Math.round(p.aScore * 10) / 10,
      fluidezB: Math.round(p.bScore * 10) / 10, bloqueoAudibleA: linguisticBlock(p.a),
    });
    const [keep, ...rest] = open;
    await deleteOpen(rest);
    if (keep) {
      if (keep.before_moment_id === p.a.id && keep.after_moment_id === p.b.id) continue;
      const { error } = await supabase.from('testimonial_candidates').update({ ...cols, updated_at: now }).eq('id', keep.id).eq('status', 'detectado');
      if (error) throw new Error(`Actualizando pareja: ${error.message}`);
      res.updated++;
    } else {
      const { error } = await supabase.from('testimonial_candidates').insert({
        id: `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, ...cols,
        status: 'detectado', status_changed_at: now, updated_at: now,
      });
      // 23505: otra ejecución la creó a la vez (índice único alumno + profe). La suya vale.
      if (error && error.code !== '23505') throw new Error(`Creando pareja: ${error.message}`);
      if (!error) res.created++;
    }
  }

  for (let i = 0; i < audit.length; i += 500) {
    const { error } = await supabase.from('testimonial_audit').upsert(audit.slice(i, i + 500), { onConflict: 'student_group' });
    if (error) throw new Error(`Guardando la auditoría: ${error.message}`);
  }
  return res;
}

// ── Tandas (el histórico) ────────────────────────────────────────────────────

async function count(table: string, filter?: (q: any) => any): Promise<number> {   // eslint-disable-line @typescript-eslint/no-explicit-any
  // Sin `head: true`: una tabla que no existe devolvería 0 en vez de error.
  let q = supabase.from(table).select('*', { count: 'exact' });
  if (filter) q = filter(q);
  const { count: n, error } = await q.range(0, 0);
  if (error) throw new Error(`${table}: ${error.message}`);
  return n ?? 0;
}

export interface SegmentsStatus {
  total: number;
  /** Falta procesarlos con la V6. */
  pending: number;
  ready: number;
  excluded: number;
  /** Parejas "Por revisar". */
  pairs: number;
  /** Alumnos sin pareja (ver testimonial_audit). */
  withoutPair: number;
}

export async function segmentsStatus(): Promise<SegmentsStatus> {
  const [total, pending, ready, excluded, pairs, withoutPair] = await Promise.all([
    count('testimonial_transcripts'),
    count('testimonial_transcripts', q => q.is('segments_at', null)),
    count('testimonial_transcripts', q => q.not('segments_at', 'is', null).eq('status', 'ready')),
    count('testimonial_transcripts', q => q.not('segments_at', 'is', null).eq('status', 'excluded')),
    count('testimonial_candidates', q => q.eq('status', 'detectado').not('pair_teacher_id', 'is', null)),
    count('testimonial_audit', q => q.eq('outcome', 'sin_pareja')),
  ]);
  return { total, pending, ready, excluded, pairs, withoutPair };
}

/** Crea la fila (pendiente) de los transcripts que no la tengan. Sin IA. */
export async function ensureTranscriptRows(): Promise<number> {
  const clases = await pagedRows('class_analyses', 'id', 'id', q => q.eq('has_transcript', true));
  const hechas = new Set((await pagedRows('testimonial_transcripts', 'analysis_id', 'analysis_id')).map(r => String(r.analysis_id)));
  const faltan = clases.map(r => String(r.id)).filter(id => !hechas.has(id));
  for (let i = 0; i < faltan.length; i += 500) {
    const { error } = await supabase.from('testimonial_transcripts').upsert(
      faltan.slice(i, i + 500).map(id => ({ analysis_id: id, status: 'pending', updated_at: NEVER })),
      { onConflict: 'analysis_id', ignoreDuplicates: true });
    if (error) throw new Error(`Preparando filas: ${error.message}`);
  }
  return faltan.length;
}

export interface SegmentsBatchResult {
  /** Transcripts que cogió esta tanda. 0 = no queda nada libre. */
  claimed: number;
  outcomes: Partial<Record<ProcessResult['status'] | 'error', number>>;
  status: SegmentsStatus;
}

/**
 * Una tanda: hasta BATCH_SIZE transcripts pendientes (CONCURRENCY a la vez) y
 * luego las parejas de sus alumnos. Se para antes de `deadline` (límite de
 * Vercel); lo que no le dé tiempo queda para la siguiente.
 */
export async function runSegmentsBatch(opts: { deadline: number }): Promise<SegmentsBatchResult> {
  const cutoff = new Date(Date.now() - LEASE_MS).toISOString();
  const { data: libres, error } = await supabase.from('testimonial_transcripts').select('analysis_id')
    .is('segments_at', null).lt('updated_at', cutoff).order('analysis_id').limit(BATCH_SIZE * 3);
  if (error) throw new Error(`Buscando pendientes: ${error.message}`);
  // Varias tandas a la vez (la pestaña lanza 3): cada una prueba con un trozo distinto.
  const ids = ((libres ?? []) as Row[]).map(r => String(r.analysis_id)).sort(() => Math.random() - 0.5).slice(0, BATCH_SIZE);
  const outcomes: SegmentsBatchResult['outcomes'] = {};
  if (ids.length === 0) return { claimed: 0, outcomes, status: await segmentsStatus() };

  const { data: mias } = await supabase.from('testimonial_transcripts')
    .update({ updated_at: new Date().toISOString() })
    .in('analysis_id', ids).is('segments_at', null).lt('updated_at', cutoff).select('analysis_id');
  const cola = ((mias ?? []) as Row[]).map(r => String(r.analysis_id));
  const groups = new Set<string>();
  const trabajador = async () => {
    for (let id = cola.shift(); id; id = cola.shift()) {
      if (Date.now() > opts.deadline - 15_000) return;   // margen para las parejas
      try {
        const r = await processTranscript(id);
        outcomes[r.status] = (outcomes[r.status] ?? 0) + 1;
        if (r.studentGroup) groups.add(r.studentGroup);
      } catch (err) {
        outcomes.error = (outcomes.error ?? 0) + 1;
        console.error(`[testimonios] ${id}:`, err instanceof Error ? err.message : err);
      }
    }
  };
  const claimed = cola.length;
  await Promise.all(Array.from({ length: CONCURRENCY }, trabajador));
  if (groups.size) await syncSegmentPairs([...groups]);
  return { claimed, outcomes, status: await segmentsStatus() };
}
