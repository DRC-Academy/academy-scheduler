// Testimoniales — ESCUCHA DIRIGIDA (servidor). Sustituye al buscador por texto
// (V6, apagado con testimonial_config.buscador_v6_activo = 0) como fuente de
// parejas para el verificador. SOLO SERVIDOR.
//
//   listenQueue        clases por escuchar: 3 primeras + 3 últimas GRABADAS de
//                      cada alumno con 2+ meses (las ya escuchadas no se repiten).
//   listenClass        UNA clase por llamada: sus tramos largos (sin lecturas) se
//                      bajan de Fathom, se escuchan con Deepgram (modo multi) y se
//                      guardan sus medidas en testimonial_listen_segments.
//   pairFromListening  por alumno, peor tramo del principio y mejor del final con
//                      el mismo profe (lib/testimonialListenRank) → pareja
//                      'detectado' con source 'escucha', que coge el verificador.
//
// Fuera: cuentas de prueba (is_test), alumnos sin ficha ("name:…") o con la ficha
// borrada. Reglas puras y números en lib/testimonialListenRank + testimonial_config.

import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { readFathomShare, cutAudioWindows, classifyShareUrl, FathomCutError } from '@/lib/fathomVideo';
import { transcribeAudio, DeepgramError, type DeepgramTranscript } from '@/lib/deepgram';
import { parseTurns, withFathomTimestamp, formatSeconds } from '@/lib/fluency';
import { loadConfig, logDeepgramUsage, deepgramSpend } from '@/lib/testimonialConfigStore';
import { measureClip, mainSpeakerText, mainSpeakerSpan, type ClipMeasures, type VerifyConfig } from '@/lib/testimonialMeasures';
import {
  selectClasses, commonTeachers, pickTurns, rankPair, clipBounds, NO_LISTEN_PAIR_LABEL,
  type ListenClass, type ListenSegment, type ClassSelection, type NoListenPair,
} from '@/lib/testimonialListenRank';
import { spainTodayIso } from '@/lib/retention';
import type { TestimonialClip, TestimonialClips } from '@/lib/testimonials';

type Row = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any

const SIRVEN = ['listo', 'revisado', 'permiso_alumno'];
const HECHAS = ['escuchada', 'sin_tramos', 'enlace_roto'];

async function paged(admin: SupabaseClient, table: string, cols: string, apply?: (q: any) => any): Promise<Row[]> {   // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    let q = admin.from(table).select(cols);
    if (apply) q = apply(q);
    const { data, error } = await q.range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as unknown as Row[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

/** Trocea una lista para filtros .in() (la URL no admite miles de ids). */
async function inChunks(ids: string[], fn: (chunk: string[]) => Promise<Row[]>): Promise<Row[]> {
  const out: Row[] = [];
  for (let i = 0; i < ids.length; i += 100) out.push(...await fn(ids.slice(i, i + 100)));
  return out;
}

const validShare = (url: string | null | undefined) => {
  const c = classifyShareUrl(url);
  return !('cause' in c) && (c.shareUrl.split('/').pop() ?? '').length === 32;
};

// ── Alumnos que entran ───────────────────────────────────────────────────────

interface Eligible {
  group: string;
  name: string;
  sel: ClassSelection;
}

async function eligibleStudents(admin: SupabaseClient, c: VerifyConfig): Promise<{ students: Eligible[]; labels: Map<string, string> }> {
  const [students, testTeachers, tts] = await Promise.all([
    paged(admin, 'students', 'id, name, is_test'),
    paged(admin, 'teachers', 'id', q => q.eq('is_test', true)),
    paged(admin, 'testimonial_transcripts', 'analysis_id, student_group, teacher_id, class_day, fathom_url, student_label', q => q.eq('status', 'ready')),
  ]);
  // Con ficha y no de prueba ("name:…" = sin ficha; un id que no está = ficha borrada).
  const ficha = new Map(students.filter(s => !s.is_test).map(s => [String(s.id), String(s.name ?? '')]));
  const profeTest = new Set(testTeachers.map(t => String(t.id)));
  const labels = new Map<string, string>();
  const byStudent = new Map<string, ListenClass[]>();
  for (const t of tts) {
    const g = String(t.student_group);
    if (!ficha.has(g) || !t.class_day || profeTest.has(String(t.teacher_id)) || !validShare(t.fathom_url)) continue;
    labels.set(String(t.analysis_id), String(t.student_label ?? ''));
    const list = byStudent.get(g) ?? [];
    list.push({ analysisId: String(t.analysis_id), studentGroup: g, teacherId: t.teacher_id ?? null, classDay: String(t.class_day).slice(0, 10), fathomUrl: String(t.fathom_url) });
    byStudent.set(g, list);
  }
  const today = spainTodayIso(new Date());
  const out = [...byStudent].map(([group, classes]) => ({ group, name: ficha.get(group) ?? '', sel: selectClasses(classes, c, today) }));
  return { students: out.sort((a, b) => a.group.localeCompare(b.group)), labels };
}

const classesOf = (e: Eligible): ListenClass[] => (e.sel.ok ? [...e.sel.first, ...e.sel.last] : []);

// ── Cola ─────────────────────────────────────────────────────────────────────

export interface ListenQueue { ids: string[]; alumnos: number; clases: number; yaEscuchadas: number }

/**
 * Clases por escuchar. Con `alumnos`, solo los N primeros alumnos con algún profe
 * en común (la prueba): repetirla no vuelve a pagar lo ya escuchado.
 */
export async function listenQueue(admin: SupabaseClient, opts: { alumnos?: number } = {}): Promise<ListenQueue> {
  const { config: c } = await loadConfig(admin);
  const { students } = await eligibleStudents(admin, c);
  let elegidos = students.filter(s => s.sel.ok);
  if (opts.alumnos) elegidos = elegidos.filter(s => s.sel.ok && commonTeachers(s.sel).length > 0).slice(0, opts.alumnos);
  const clases = elegidos.flatMap(classesOf);
  const hechas = await inChunks(clases.map(x => x.analysisId), chunk => paged(admin, 'testimonial_listen_classes', 'analysis_id, status',
    q => q.in('analysis_id', chunk).in('status', HECHAS)));
  const ya = new Set(hechas.map(r => String(r.analysis_id)));
  return { ids: clases.map(x => x.analysisId).filter(id => !ya.has(id)), alumnos: elegidos.length, clases: clases.length, yaEscuchadas: ya.size };
}

// ── Una clase ────────────────────────────────────────────────────────────────

export interface ListenResult { status: 'escuchada' | 'sin_tramos' | 'enlace_roto' | 'error'; tramos: number; segundos: number; detalle: string | null; ms: number }

const DG = { model: 'nova-3', language: 'multi', diarize_model: 'latest', filler_words: true, punctuate: true };

export async function listenClass(admin: SupabaseClient, analysisId: string): Promise<ListenResult> {
  const t0 = Date.now();
  const [{ config: c }, { data: tt }, { data: ca }, { data: prev }] = await Promise.all([
    loadConfig(admin),
    admin.from('testimonial_transcripts').select('student_group, teacher_id, class_day, fathom_url, student_label').eq('analysis_id', analysisId).maybeSingle(),
    admin.from('class_analyses').select('transcript').eq('id', analysisId).maybeSingle(),
    admin.from('testimonial_listen_segments').select('turn_index, audio_s').eq('analysis_id', analysisId),
  ]);
  if (!tt || !ca?.transcript) throw new Error('La clase ya no existe o no tiene transcript.');

  const mark = async (status: ListenResult['status'], detalle: string | null, tramos: number, segundos: number): Promise<ListenResult> => {
    const { error } = await admin.from('testimonial_listen_classes').upsert({
      analysis_id: analysisId, student_group: tt.student_group, teacher_id: tt.teacher_id ?? null, class_day: tt.class_day ?? null,
      status, detalle, tramos, segundos: Math.round(segundos * 10) / 10, updated_at: new Date().toISOString(),
    }, { onConflict: 'analysis_id' });
    if (error) throw new Error(`testimonial_listen_classes: ${error.message}`);
    return { status, tramos, segundos, detalle, ms: Date.now() - t0 };
  };

  const turns = parseTurns(String(ca.transcript));
  const picks = pickTurns(turns, String(tt.student_label ?? ''), c);
  if (!picks.length) return mark('sin_tramos', 'Ninguna intervención larga del alumno que no sea lectura.', 0, 0);

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
    const m: ClipMeasures | null = measureClip(t, null, c);
    const span = mainSpeakerSpan(t);
    rows.push({
      id: `escucha:${analysisId}:${p.turnIndex}`, analysis_id: analysisId, student_group: tt.student_group,
      teacher_id: tt.teacher_id ?? null, class_day: tt.class_day ?? null, turn_index: p.turnIndex,
      start_s: p.start, dur_s: w.dur, audio_s: t.durationS ?? w.dur,
      habla_start_s: span ? Math.round((p.start + span.start) * 10) / 10 : null,
      habla_end_s: span ? Math.round((p.start + span.end) * 10) / 10 : null,
      medidas: m, ppm: m?.ppm ?? null, pausas_min: m?.pausas_min ?? null, muletillas: m?.muletillas ?? null,
      espanol_pct: m?.espanol_pct ?? null, texto: mainSpeakerText(t).slice(0, 2000), request_id: t.requestId,
    });
  }));
  if (rows.length) {
    const { error } = await admin.from('testimonial_listen_segments').upsert(rows, { onConflict: 'id' });
    if (error) throw new Error(`testimonial_listen_segments: ${error.message}`);
  }
  const segundos = yaSeg + rows.reduce((a, r) => a + Number(r.audio_s), 0);
  return fallos.length ? mark('error', fallos[0], ya.size + rows.length, segundos) : mark('escuchada', null, ya.size + rows.length, segundos);
}

// ── Parejas ──────────────────────────────────────────────────────────────────

export type ListenOutcome = 'pareja' | 'sin_profe_en_comun' | 'sin_pareja' | 'pendiente' | 'ya_sirve';

export interface ListenPairSummary {
  outcomes: Partial<Record<ListenOutcome, number>>;
  motivos: Partial<Record<NoListenPair, number>>;
  creadas: number;
  actualizadas: number;
}

const toSegment = (r: Row): ListenSegment => ({
  id: String(r.id), analysisId: String(r.analysis_id), teacherId: r.teacher_id ?? null, classDay: String(r.class_day ?? '').slice(0, 10),
  hablaStart: Number(r.habla_start_s ?? r.start_s), hablaEnd: Number(r.habla_end_s ?? Number(r.start_s) + Number(r.dur_s)),
  medidas: (r.medidas as ClipMeasures | null) ?? null, texto: String(r.texto ?? ''),
});

/**
 * Rehace la pareja de la escucha de unos alumnos (o de todos). Nunca toca lo
 * marcado "Sirve" ni "No sirve", ni una pareja que el verificador aprobó y espera
 * revisión. Lo descartado (por el admin o el verificador) bloquea esos momentos.
 */
export async function pairFromListening(admin: SupabaseClient, groups?: string[]): Promise<ListenPairSummary> {
  const res: ListenPairSummary = { outcomes: {}, motivos: {}, creadas: 0, actualizadas: 0 };
  const { config: c } = await loadConfig(admin);
  const { students, labels } = await eligibleStudents(admin, c);
  const lista = students.filter(s => s.sel.ok && (!groups || groups.includes(s.group)));
  if (!lista.length) return res;
  const gids = lista.map(s => s.group);

  const [clases, segs, cands] = await Promise.all([
    inChunks(gids, ch => paged(admin, 'testimonial_listen_classes', 'analysis_id, status', q => q.in('student_group', ch))),
    inChunks(gids, ch => paged(admin, 'testimonial_listen_segments', 'id, analysis_id, teacher_id, class_day, start_s, dur_s, habla_start_s, habla_end_s, medidas, texto', q => q.in('student_group', ch))),
    inChunks(gids, ch => paged(admin, 'testimonial_candidates', 'id, student_group, status, pair_teacher_id, source, before_moment_id, after_moment_id', q => q.in('student_group', ch))),
  ]);
  const abiertas = cands.filter(x => x.status === 'detectado');
  const aprobadas = await inChunks(abiertas.map(x => String(x.id)), ch => paged(admin, 'testimonial_verifications', 'candidate_id',
    q => q.in('candidate_id', ch).eq('status', 'aprobado').is('review', null)));
  const protegidas = new Set(aprobadas.map(r => String(r.candidate_id)));
  const estado = new Map(clases.map(r => [String(r.analysis_id), String(r.status)]));
  const now = new Date().toISOString();
  const outcomes: Row[] = [];

  for (const st of lista) {
    if (!st.sel.ok) continue;
    const note = (outcome: ListenOutcome, detalle: string | null) => {
      res.outcomes[outcome] = (res.outcomes[outcome] ?? 0) + 1;
      outcomes.push({ student_group: st.group, student_name: st.name, outcome, detalle, updated_at: now });
    };
    const suyas = cands.filter(x => x.student_group === st.group);
    if (suyas.some(x => SIRVEN.includes(String(x.status)))) { note('ya_sirve', null); continue; }
    const pendientes = classesOf(st).filter(x => !HECHAS.includes(estado.get(x.analysisId) ?? ''));
    if (pendientes.length) { note('pendiente', `${pendientes.length} clases sin escuchar`); continue; }
    const teachers = commonTeachers(st.sel);
    if (!teachers.length) { note('sin_profe_en_comun', null); continue; }

    const bloqueados = new Set(suyas.filter(x => x.status === 'descartado').flatMap(x => [x.before_moment_id, x.after_moment_id]).filter(Boolean));
    const ids = (xs: ListenClass[]) => new Set(xs.map(x => x.analysisId));
    const primeras = ids(st.sel.first), ultimas = ids(st.sel.last);
    const mios = segs.filter(s => !bloqueados.has(s.id)).map(toSegment);
    const r = rankPair(mios.filter(s => primeras.has(s.analysisId)), mios.filter(s => ultimas.has(s.analysisId)), teachers, c);
    if (!r.ok) {
      res.motivos[r.reason] = (res.motivos[r.reason] ?? 0) + 1;
      note(r.reason === 'sin_profe_en_comun' ? 'sin_profe_en_comun' : 'sin_pareja', NO_LISTEN_PAIR_LABEL[r.reason]);
      continue;
    }
    const abiertasSuyas = suyas.filter(x => x.status === 'detectado');
    if (abiertasSuyas.some(x => protegidas.has(String(x.id)))) { note('pareja', 'Ya tiene una pareja aprobada por revisar'); continue; }

    const urls = new Map(classesOf(st).map(x => [x.analysisId, x.fathomUrl]));
    const misma = abiertasSuyas.find(x => x.pair_teacher_id === r.teacherId);
    note('pareja', `${r.semanas} semanas · contraste ${r.score}`);
    if (misma && misma.before_moment_id === r.a.id && misma.after_moment_id === r.b.id) continue;
    const cols = candidateColumns(st, r, urls, labels, c);
    if (misma) {
      const { error } = await admin.from('testimonial_candidates').update({ ...cols, updated_at: now }).eq('id', misma.id).eq('status', 'detectado');
      if (error) throw new Error(`Actualizando pareja: ${error.message}`);
      res.actualizadas++;
    } else {
      const { error } = await admin.from('testimonial_candidates').insert({
        id: `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, ...cols,
        status: 'detectado', status_changed_at: now, updated_at: now,
      });
      if (error && error.code !== '23505') throw new Error(`Creando pareja: ${error.message}`);
      if (!error) res.creadas++;
    }
    // Una pareja de la escucha por alumno: fuera las suyas abiertas con otro profe.
    const otras = abiertasSuyas.filter(x => x.source === 'escucha' && x.pair_teacher_id !== r.teacherId).map(x => String(x.id));
    if (otras.length) await admin.from('testimonial_candidates').delete().in('id', otras).eq('status', 'detectado');
  }

  for (let i = 0; i < outcomes.length; i += 500) {
    const { error } = await admin.from('testimonial_listen_students').upsert(outcomes.slice(i, i + 500), { onConflict: 'student_group' });
    if (error) throw new Error(`testimonial_listen_students: ${error.message}`);
  }
  return res;
}

function candidateColumns(st: Eligible, r: Extract<ReturnType<typeof rankPair>, { ok: true }>,
  urls: Map<string, string>, labels: Map<string, string>, c: VerifyConfig): Row {
  const ma = r.a.medidas!, mb = r.b.medidas!;
  const clip = (s: ListenSegment, why: string): TestimonialClip => {
    const b = clipBounds(s, c);
    return {
      analysisId: s.analysisId, classDate: s.classDay, teacherId: s.teacherId, start: b.start, end: b.end,
      excerpt: s.texto.slice(0, 400), why, fathomUrl: withFathomTimestamp(urls.get(s.analysisId), b.start),
      speakerLabel: labels.get(s.analysisId),
    };
  };
  const a = clip(r.a, `Escucha: ${ma.ppm} pal/min, ${ma.pausas} pausas, ${ma.muletillas} muletillas.`);
  const b = clip(r.b, `Escucha: ${mb.ppm} pal/min, ${mb.pausas} pausas, ${mb.muletillas} muletillas.`);
  const clips: TestimonialClips = { malos: [a], buenos: [b] };
  const side = (pre: 'before' | 'after', k: TestimonialClip, m: ClipMeasures, id: string) => ({
    [`${pre}_analysis_id`]: k.analysisId, [`${pre}_teacher_id`]: k.teacherId, [`${pre}_class_number`]: null,
    [`${pre}_class_date`]: k.classDate, [`${pre}_score`]: Math.min(32767, Math.round(m.ppm)), [`${pre}_excerpt`]: k.excerpt,
    [`${pre}_excerpt_at`]: formatSeconds(Math.round(k.start)), [`${pre}_fathom_url`]: k.fathomUrl, [`${pre}_moment_id`]: id,
  });
  return {
    student_group: st.group, student_id: st.group, student_name: st.name, pair_teacher_id: r.teacherId,
    student_label: labels.get(r.b.analysisId) ?? null, reverse_order: false,
    ...side('before', a, ma, r.a.id), ...side('after', b, mb, r.b.id),
    clips, improvement: Math.max(-32768, Math.min(32767, Math.round(r.score * 10))),
    ai_review_status: 'ready', ai_is_real: true, ai_error: null, ai_summary: null,
    ai_reason: `Escucha: ${r.semanas} semanas · antes ${ma.ppm} pal/min y ${ma.pausas_min} pausas/min · después ${mb.ppm} pal/min y ${mb.pausas_min} pausas/min.`,
    source: 'escucha',
  };
}

// ── Lo que enseña la pestaña ─────────────────────────────────────────────────

export async function listenState(admin: SupabaseClient) {
  const { config: c } = await loadConfig(admin);
  const [{ students }, clases, outcomes, gasto] = await Promise.all([
    eligibleStudents(admin, c),
    paged(admin, 'testimonial_listen_classes', 'status, segundos'),
    paged(admin, 'testimonial_listen_students', 'student_name, outcome, detalle'),
    deepgramSpend(admin, c),
  ]);
  const elegibles = students.filter(s => s.sel.ok);
  const fuera: Record<string, number> = {};
  for (const s of students) if (!s.sel.ok) fuera[s.sel.reason] = (fuera[s.sel.reason] ?? 0) + 1;
  const porEstado: Record<string, number> = {};
  for (const r of clases) porEstado[String(r.status)] = (porEstado[String(r.status)] ?? 0) + 1;
  const porOutcome: Record<string, number> = {};
  const sinPareja: Record<string, number> = {};
  for (const o of outcomes) {
    porOutcome[String(o.outcome)] = (porOutcome[String(o.outcome)] ?? 0) + 1;
    if (o.outcome === 'sin_pareja' && o.detalle) sinPareja[String(o.detalle)] = (sinPareja[String(o.detalle)] ?? 0) + 1;
  }
  return {
    activa: c.buscador_v6_activo === 0,
    alumnos: elegibles.length, fuera,
    clasesObjetivo: elegibles.reduce((a, s) => a + classesOf(s).length, 0),
    clases: porEstado,
    minutos: Math.round(clases.reduce((a, r) => a + Number(r.segundos ?? 0), 0) / 60),
    porOutcome, sinPareja,
    sinProfeEnComun: outcomes.filter(o => o.outcome === 'sin_profe_en_comun').map(o => String(o.student_name ?? '')).sort(),
    gasto,
  };
}
