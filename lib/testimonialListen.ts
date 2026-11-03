// Testimoniales — ESCUCHA DIRIGIDA (servidor). Fuente "Escucha (audio)" del panel
// de análisis (lib/testimonialAnalysis). SOLO SERVIDOR.
//
//   listenClass       UNA clase por llamada: de sus intervenciones largas, Haiku
//                     separa en el texto de Fathom las lecturas del habla
//                     espontánea; las espontáneas más largas se
//                     bajan de Fathom, se escuchan con Deepgram (modo multi) y se
//                     guardan sus medidas en testimonial_listen_segments. Si en un
//                     tramo habla también el profe o hay español, se guardan las
//                     medidas del trozo más largo en que habla solo el alumno en
//                     inglés (mismo criterio que el verificador).
//   listenColumns     las columnas de testimonial_candidates de una pareja hecha
//                     con dos tramos escuchados (source 'escucha').
//
// Qué clases se escuchan y qué parejas salen: lib/testimonialListenRank (puro) y
// lib/testimonialAnalysis.

import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { readFathomShare, cutAudioWindows, FathomCutError } from '@/lib/fathomVideo';
import { transcribeAudio, DeepgramError, type DeepgramTranscript } from '@/lib/deepgram';
import { parseTurns, withFathomTimestamp, formatSeconds } from '@/lib/fluency';
import { loadConfig, logDeepgramUsage } from '@/lib/testimonialConfigStore';
import {
  measureClip, mainSpeakerText, mainSpeakerSpan, checkAudio, longestStudentRun, subTranscript, frasesRepetidasTexto,
  type ClipMeasures, type VerifyConfig,
} from '@/lib/testimonialMeasures';
import { pickTurns, turnCandidates, clipBounds, LISTEN_CRITERIO, type ListenSegment } from '@/lib/testimonialListenRank';
import { clasificarTurnosFathom } from '@/lib/testimonialReading';
import type { TestimonialClip, TestimonialClips } from '@/lib/testimonials';

type Row = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any

/** Estados de testimonial_listen_classes que ya no se vuelven a escuchar. */
export const LISTEN_DONE = ['escuchada', 'sin_tramos', 'enlace_roto'];

// ── Una clase ────────────────────────────────────────────────────────────────

export interface ListenResult {
  status: 'escuchada' | 'sin_tramos' | 'enlace_roto' | 'error'; tramos: number; segundos: number; detalle: string | null; ms: number;
  /** Gasto de ESTA llamada: Deepgram de lo escuchado ahora + Haiku. */
  usd: number;
}

const DG = { model: 'nova-3', language: 'multi', diarize_model: 'latest', filler_words: true, punctuate: true };

/**
 * Medidas del CLIP que verá el verificador (decisión de Facundo, 02/11/2026: el
 * buscador mide el mismo trozo que medirá el verificador). Si suena otra voz o
 * español, el trozo más largo en que habla solo el alumno en inglés (si llega al
 * mínimo del ANTES); después, como mucho `escucha_clip_max_s` desde que empieza a
 * hablar. Los segundos devueltos son relativos al audio.
 */
export function listenMeasures(t: DeepgramTranscript, c: VerifyConfig): { m: ClipMeasures | null; span: { start: number; end: number } | null; texto: string } {
  const m = measureClip(t, null, c);
  const full = { m, span: mainSpeakerSpan(t), texto: mainSpeakerText(t) };
  if (!m) return full;
  let sub = t, span = full.span;
  const r = checkAudio(m, 'ANTES', c);
  if (!r.ok && (r.motivo === 'habla_profe' || r.motivo === 'espanol')) {
    const run = longestStudentRun(t);
    if (run && run.end - run.start >= c.recorte_alumno_min_antes_s) { sub = subTranscript(t, run.start, run.end); span = run; }
  }
  if (span && span.end - span.start > c.escucha_clip_max_s) {
    sub = subTranscript(sub, span.start, span.start + c.escucha_clip_max_s);
    span = mainSpeakerSpan(sub) ?? span;
  }
  if (sub === t) return full;
  const m2 = measureClip(sub, null, c);
  return m2 && span ? { m: m2, span, texto: mainSpeakerText(sub) } : full;
}

export async function listenClass(admin: SupabaseClient, analysisId: string): Promise<ListenResult> {
  const t0 = Date.now();
  let usd = 0;
  const [{ config: c }, { data: tt }, { data: ca }, { data: prev }] = await Promise.all([
    loadConfig(admin),
    admin.from('testimonial_transcripts').select('student_group, teacher_id, class_day, fathom_url, student_label').eq('analysis_id', analysisId).maybeSingle(),
    admin.from('class_analyses').select('transcript').eq('id', analysisId).maybeSingle(),
    admin.from('testimonial_listen_segments').select('turn_index, audio_s').eq('analysis_id', analysisId),
  ]);
  if (!tt || !ca?.transcript) throw new Error('La clase ya no existe o no tiene transcript.');

  const mark = async (status: ListenResult['status'], detalle: string | null, tramos: number, segundos: number): Promise<ListenResult> => {
    const row: Row = {
      analysis_id: analysisId, student_group: tt.student_group, teacher_id: tt.teacher_id ?? null, class_day: tt.class_day ?? null,
      status, detalle, tramos, segundos: Math.round(segundos * 10) / 10, updated_at: new Date().toISOString(), criterio: LISTEN_CRITERIO,
    };
    let { error } = await admin.from('testimonial_listen_classes').upsert(row, { onConflict: 'analysis_id' });
    if (error && /criterio/i.test(error.message)) {
      console.warn('[testimoniales] Falta supabase-testimoniales-espontaneo.sql: la clase se guarda sin criterio.');
      delete row.criterio;
      ({ error } = await admin.from('testimonial_listen_classes').upsert(row, { onConflict: 'analysis_id' }));
    }
    if (error) throw new Error(`testimonial_listen_classes: ${error.message}`);
    return { status, tramos, segundos, detalle, ms: Date.now() - t0, usd: Math.round(usd * 10000) / 10000 };
  };

  // Antes de pagar Deepgram: de las intervenciones largas, solo las que Haiku ve
  // como habla espontánea en el texto de Fathom (las lecturas no son testimonio).
  const turns = parseTurns(String(ca.transcript));
  const label = String(tt.student_label ?? '');
  const cands = turnCandidates(turns, label, c);
  if (!cands.length) return mark('sin_tramos', 'Ninguna intervención larga del alumno.', 0, 0);
  let veredictos: Awaited<ReturnType<typeof clasificarTurnosFathom>>['porTurno'];
  try {
    const r = await clasificarTurnosFathom(turns, cands.map(x => x.turnIndex), label);
    veredictos = r.porTurno; usd += r.usd;
  } catch (err) {
    return mark('error', err instanceof Error ? err.message : String(err), 0, 0);
  }
  const espontaneos = new Set([...veredictos].filter(([, v]) => v.tipo === 'espontaneo').map(([k]) => k));
  const picks = pickTurns(turns, label, c, espontaneos);
  if (!picks.length) return mark('sin_tramos', 'Las intervenciones largas del alumno son lecturas.', 0, 0);

  // Lo ya escuchado de esta clase (un reintento tras un error) no se vuelve a pagar.
  const ya = new Map(((prev ?? []) as Row[]).map(r => [Number(r.turn_index), Number(r.audio_s ?? 0)]));
  const faltan = picks.filter(p => !ya.has(p.turnIndex));
  const yaSeg = [...ya.values()].reduce((a, b) => a + b, 0);
  if (!faltan.length) return mark('escuchada', null, ya.size, yaSeg);

  const share = await readFathomShare(tt.fathom_url);
  if (!share.ok) return mark(share.cause === 'error' ? 'error' : 'enlace_roto', share.detail, 0, 0);
  let audios;
  try {
    audios = await cutAudioWindows(share.source, faltan.map(p => ({ start: p.start, dur: p.dur })));
  } catch (err) {
    const e = err instanceof FathomCutError ? err : new FathomCutError(String(err), 'error');
    return mark(e.failure === 'error' ? 'error' : 'enlace_roto', e.message, 0, 0);
  }

  const rows: Row[] = [];
  const fallos: string[] = [];
  await Promise.all(faltan.map(async (p, i) => {
    const w = audios.find(a => a.start === p.start) ?? audios[i];
    if (!w) return;
    let t: DeepgramTranscript;
    try {
      t = await transcribeAudio(w.audio, DG);
    } catch (err) {
      fallos.push(err instanceof DeepgramError ? `Deepgram: ${err.message} ${err.body?.slice(0, 150) ?? ''}` : String(err));
      return;
    }
    await logDeepgramUsage(admin, 'escucha', 'multi', t, w.dur);
    usd += ((t.durationS ?? w.dur) / 60) * c.deepgram_usd_min_multi;
    const { m, span, texto } = listenMeasures(t, c);
    rows.push({
      id: `escucha:${analysisId}:${p.turnIndex}`, analysis_id: analysisId, student_group: tt.student_group,
      teacher_id: tt.teacher_id ?? null, class_day: tt.class_day ?? null, turn_index: p.turnIndex,
      start_s: p.start, dur_s: w.dur, audio_s: t.durationS ?? w.dur,
      habla_start_s: span ? Math.round((p.start + span.start) * 10) / 10 : null,
      habla_end_s: span ? Math.round((p.start + span.end) * 10) / 10 : null,
      medidas: m, ppm: m?.ppm ?? null, pausas_min: m?.pausas_min ?? null, muletillas: m?.muletillas ?? null,
      espanol_pct: m?.espanol_pct ?? null, texto: texto.slice(0, 2000), request_id: t.requestId,
      lectura: 'espontaneo', lectura_motivo: `Fathom: ${veredictos.get(p.turnIndex)?.motivo ?? ''}`.slice(0, 300),
    });
  }));
  if (rows.length) {
    const { error } = await admin.from('testimonial_listen_segments').upsert(rows, { onConflict: 'id' });
    if (error) throw new Error(`testimonial_listen_segments: ${error.message}`);
  }
  const segundos = yaSeg + rows.reduce((a, r) => a + Number(r.audio_s), 0);
  return fallos.length ? mark('error', fallos[0], ya.size + rows.length, segundos) : mark('escuchada', null, ya.size + rows.length, segundos);
}

// ── Pareja ───────────────────────────────────────────────────────────────────

/** Medidas anteriores al 03/11/2026: les falta frases_repetidas, que sale del texto del mismo trozo. */
const conFrases = (m: ClipMeasures | null, texto: string): ClipMeasures | null =>
  (m && m.frases_repetidas == null ? { ...m, frases_repetidas: frasesRepetidasTexto(texto) } : m);

/** Tramo escuchado desde su fila de testimonial_listen_segments. */
export const toListenSegment = (r: Row): ListenSegment => ({
  id: String(r.id), analysisId: String(r.analysis_id), teacherId: r.teacher_id ?? null, classDay: String(r.class_day ?? '').slice(0, 10),
  hablaStart: Number(r.habla_start_s ?? r.start_s), hablaEnd: Number(r.habla_end_s ?? Number(r.start_s) + Number(r.dur_s)),
  medidas: conFrases(r.medidas as ClipMeasures | null, String(r.texto ?? '')), texto: String(r.texto ?? ''),
  lectura: r.lectura === 'lectura' || r.lectura === 'espontaneo' ? r.lectura : null,
});

export interface ListenPairInput {
  group: string;
  name: string;
  a: ListenSegment;
  b: ListenSegment;
  teacherId: string;
  semanas: number;
  score: number;
}

/** Columnas de testimonial_candidates para una pareja de dos tramos escuchados. */
export function listenColumns(p: ListenPairInput, urls: Map<string, string>, labels: Map<string, string>): Row {
  const ma = p.a.medidas!, mb = p.b.medidas!;
  const clip = (s: ListenSegment, why: string): TestimonialClip => {
    const b = clipBounds(s);
    return {
      analysisId: s.analysisId, classDate: s.classDay, teacherId: s.teacherId, start: b.start, end: b.end,
      excerpt: s.texto.slice(0, 400), why, fathomUrl: withFathomTimestamp(urls.get(s.analysisId), b.start),
      speakerLabel: labels.get(s.analysisId),
    };
  };
  const a = clip(p.a, `Escucha: ${ma.ppm} pal/min, ${ma.pausas} pausas, ${ma.muletillas} muletillas.`);
  const b = clip(p.b, `Escucha: ${mb.ppm} pal/min, ${mb.pausas} pausas, ${mb.muletillas} muletillas.`);
  const clips: TestimonialClips = { malos: [a], buenos: [b] };
  const side = (pre: 'before' | 'after', k: TestimonialClip, m: ClipMeasures, id: string) => ({
    [`${pre}_analysis_id`]: k.analysisId, [`${pre}_teacher_id`]: k.teacherId, [`${pre}_class_number`]: null,
    [`${pre}_class_date`]: k.classDate, [`${pre}_score`]: Math.min(32767, Math.round(m.ppm)), [`${pre}_excerpt`]: k.excerpt,
    [`${pre}_excerpt_at`]: formatSeconds(Math.round(k.start)), [`${pre}_fathom_url`]: k.fathomUrl, [`${pre}_moment_id`]: id,
  });
  return {
    student_group: p.group, student_id: p.group, student_name: p.name, pair_teacher_id: p.teacherId,
    student_label: labels.get(p.b.analysisId) ?? null, reverse_order: false,
    ...side('before', a, ma, p.a.id), ...side('after', b, mb, p.b.id),
    clips, improvement: Math.max(-32768, Math.min(32767, Math.round(p.score * 10))),
    ai_review_status: 'ready', ai_is_real: true, ai_error: null, ai_summary: null,
    ai_reason: `Escucha: ${p.semanas} semanas · antes ${ma.ppm} pal/min y ${ma.pausas_min} pausas/min · después ${mb.ppm} pal/min y ${mb.pausas_min} pausas/min.`,
    source: 'escucha',
  };
}
