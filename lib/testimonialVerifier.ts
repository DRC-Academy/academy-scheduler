// Testimoniales — VERIFICADOR: cada pareja que propone el buscador (V6) se mira
// con el video y el audio reales antes de enseñarse. SOLO SERVIDOR.
//
// UNA llamada al servidor = UNA pareja (límite de Vercel). El navegador del admin
// las encadena desde el panel de análisis (lib/testimonialAnalysis).
//
// FILTROS, de más barato a más caro (el primero que falla decide el motivo):
//   0. Gratis: 4+ semanas entre clases, mismo profe, orden normal → sin_contraste.
//   1. ENLACE: la página pública de Fathom → enlace_roto (privado / borrado). Un
//      fallo técnico ('error') NO descarta: queda 'error' y cuenta para la alarma.
//   2. RECORTE: solo el tramo de cada clip (audio + 3 fotogramas), a Storage.
//   3. AUDIO (Deepgram): espanol, habla_profe (otra voz), ejercicio_repeticion.
//      Hasta `voces_interjecciones_max` "yeah / ok / right…" de la otra voz no
//      cuentan. Con otra voz o español, antes de descartar: VOZ PARTIDA (los
//      fotogramas enseñan al alumno hablando todo el clip → una sola voz) y
//      RECORTE (el trozo más largo en que habla solo el alumno en inglés, si
//      llega al mínimo de cada lado). Ver resolveAudio.
//   4. FLUIDEZ MEDIDA: ANTES trabado de forma sostenida (si no, falso_bloqueo);
//      DESPUÉS fluido y CONTRASTE entre los dos (si no, sin_contraste).
//   5. IMAGEN + JUEZ (Claude con los 6 fotogramas y la foto del profe, una sola
//      llamada): habla_profe por el nombre del recuadro que habla, camara_apagada,
//      leyendo; y la nota 0-100 (por debajo del mínimo, nota_baja).
// Las medidas (4) van antes que la imagen (5) porque son gratis una vez se tiene
// el audio. Todos los umbrales salen de testimonial_config.
//
// VETOS (testimonial_vetos): un momento descartado por español, habla el profe,
// leyendo o cámara apagada no vuelve a usarse en ninguna pareja; un enlace
// privado o borrado inutiliza todos los momentos de esa grabación. El resto de
// motivos (falso bloqueo, sin contraste, nota baja…) tira la pareja, no sus
// momentos: cada uno puede salir con otra pareja.

import 'server-only';

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { askClaudeJson, ECONOMY_MODEL, type AiResult } from '@/lib/anthropic';
import { transcribeAudio, DeepgramError, type DeepgramTranscript } from '@/lib/deepgram';
import { readFathomShare, cutClip, cutFrame, classifyShareUrl, FathomCutError, type FathomSource, type CutResult } from '@/lib/fathomVideo';
import { parseTurns, toSeconds, withFathomTimestamp } from '@/lib/fluency';
import { nameMatchesStrict } from '@/lib/testimonialSpeaker';
import { loadConfig, logDeepgramUsage, deepgramSpend } from '@/lib/testimonialConfigStore';
import { momentKeyFromId, recordingKey, MOTIVOS_QUE_VETAN } from '@/lib/testimonialPairPlan';
import type { TestimonialClip, TestimonialClips } from '@/lib/testimonials';
import {
  MOTIVOS_ADMIN, cutWindow, measureClip, mainSpeakerText, checkAudio, checkAntes, checkDespues,
  checkContraste, checkVision, weeksBetween, shouldHarden, hardenedValue,
  longestStudentRun, subTranscript, mergeSpeakers,
  type VerifyConfig, type ClipMeasures, type Motivo, type VisionVerdict, type RuleResult,
} from '@/lib/testimonialMeasures';

type Row = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any
export type BatchKind = 'busqueda' | 'prueba';

export { loadConfig } from '@/lib/testimonialConfigStore';
export const BUCKET = 'testimonios';
const SIRVEN = ['listo', 'revisado', 'permiso_alumno'];

// ── Configuración ────────────────────────────────────────────────────────────

async function testAccounts(admin: SupabaseClient): Promise<{ teachers: Set<string>; students: Set<string> }> {
  const [{ data: t }, { data: s }] = await Promise.all([
    admin.from('teachers').select('id').eq('is_test', true),
    admin.from('students').select('id').eq('is_test', true),
  ]);
  return { teachers: new Set((t ?? []).map((r: Row) => String(r.id))), students: new Set((s ?? []).map((r: Row) => String(r.id))) };
}

const isTestPair = (c: Row, test: { teachers: Set<string>; students: Set<string> }) =>
  test.teachers.has(String(c.pair_teacher_id ?? c.before_teacher_id ?? '')) || test.students.has(String(c.student_id ?? ''));

const clipsOf = (c: Row): { malo: TestimonialClip | null; bueno: TestimonialClip | null } => {
  const k = c.clips as TestimonialClips | null;
  return { malo: k?.malos?.[0] ?? null, bueno: k?.buenos?.[0] ?? null };
};

const weeksOf = (c: Row) => {
  const { malo, bueno } = clipsOf(c);
  return malo && bueno ? weeksBetween(malo.classDate, bueno.classDate) : -1;
};

/// ── Tandas ───────────────────────────────────────────────────────────────────
// Las tandas de búsqueda (panel de análisis con filtros) viven en
// lib/testimonialAnalysis. Aquí queda la de PRUEBA y el cierre común.

export interface StartedBatch {
  batchId: string;
  /** Las parejas a verificar, en orden. */
  ids: string[];
  parejas: number;
}

/** Abre una tanda de PRUEBA: las "No sirve" del admin aún no pasadas por el verificador. */
export async function startBatch(admin: SupabaseClient, kind: BatchKind): Promise<StartedBatch> {
  if (kind !== 'prueba') throw new Error('Las tandas de búsqueda se abren desde el panel de análisis.');
  const test = await testAccounts(admin);
  const batchId = `tb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const { data: cands, error } = await admin.from('testimonial_candidates')
    .select('id, student_id, pair_teacher_id, before_teacher_id, before_moment_id, after_moment_id, clips, improvement')
    .not('clips', 'is', null).limit(2000)
    .eq('status', 'descartado').eq('discarded_by', 'admin');
  if (error) throw new Error(`testimonial_candidates: ${error.message}`);

  // Ya verificadas (por id exacto: Supabase no devuelve más de 1.000 filas por consulta).
  const posibles = ((cands ?? []) as Row[]).filter(c => !isTestPair(c, test));
  const vids = posibles.map(c => verificationId(kind, c));
  const yaHechas = new Set<string>();
  for (let i = 0; i < vids.length; i += 200) {
    const { data: hechas, error: hErr } = await admin.from('testimonial_verifications')
      .select('id').in('id', vids.slice(i, i + 200)).in('status', ['aprobado', 'descartado']);
    if (hErr) throw new Error(`testimonial_verifications: ${hErr.message}`);
    for (const r of (hechas ?? []) as Row[]) yaHechas.add(String(r.id));
  }

  const ids = posibles
    .filter(c => !yaHechas.has(verificationId(kind, c)))
    .sort((a, b) => weeksOf(b) - weeksOf(a) || Number(b.improvement ?? 0) - Number(a.improvement ?? 0))
    .map(c => String(c.id));

  const { error: bErr } = await admin.from('testimonial_verify_batches').insert({ id: batchId, kind, planned: ids.length });
  if (bErr) throw new Error(`testimonial_verify_batches: ${bErr.message}`);
  return { batchId, ids, parejas: ids.length };
}

/** Cierra la tanda y devuelve su resumen (con el gasto estimado). */
export async function closeBatch(admin: SupabaseClient, batchId: string, cancelled: boolean) {
  await admin.from('testimonial_verify_batches').update({ finished_at: new Date().toISOString(), cancelled }).eq('id', batchId);
  return batchResumen(admin, batchId);
}

/** Resumen de una tanda (aprobadas, motivos, gasto) sin cerrarla. */
export async function batchResumen(admin: SupabaseClient, batchId: string) {
  const { data } = await admin.from('testimonial_verifications')
    .select('status, motivo, fathom_causa, antes, review, coste_deepgram_usd, coste_claude_usd').eq('batch_id', batchId);
  return batchSummary((data ?? []) as Row[]);
}

/** Id estable de la verificación de una pareja: la misma pareja no se verifica dos veces. */
function verificationId(kind: BatchKind, c: Row): string {
  if (kind === 'prueba') return `tvp_${c.id}`;
  const h = createHash('sha1').update(`${c.before_moment_id ?? ''}|${c.after_moment_id ?? ''}`).digest('hex').slice(0, 12);
  return `tv_${c.id}_${h}`;
}

// ── Una pareja ───────────────────────────────────────────────────────────────

export interface SideResult {
  fecha: string;
  inicio: number;
  dur: number;
  fathom: string | null;
  audio: string | null;
  frames: string[];
  texto: string | null;
  textoFathom: string;
  medidas: ClipMeasures | null;
  vision?: VisionVerdict['antes'];
}

export interface VerifyOutcome {
  id: string;
  status: 'aprobado' | 'descartado' | 'error';
  motivo: Motivo | null;
  detalle: string | null;
  fathomCausa: string | null;
  nota: number | null;
  ms: number;
}

/** Verifica UNA pareja y guarda el resultado. Nunca deja la fila en 'verificando'. */
export async function verifyCandidate(admin: SupabaseClient, candidateId: string, batchId: string, kind: BatchKind): Promise<VerifyOutcome> {
  const t0 = Date.now();
  const [{ config: c }, { data: cand }] = await Promise.all([
    loadConfig(admin),
    admin.from('testimonial_candidates').select('*').eq('id', candidateId).maybeSingle(),
  ]);
  if (!cand) throw new Error('La pareja ya no existe (el buscador la rehízo). Pasa a la siguiente.');
  const id = verificationId(kind, cand);
  const { malo, bueno } = clipsOf(cand);
  const semanas = malo && bueno ? weeksBetween(malo.classDate, bueno.classDate) : null;
  const teacherId = (cand.pair_teacher_id ?? cand.before_teacher_id ?? null) as string | null;

  const base: Row = {
    id, batch_id: batchId, kind, candidate_id: cand.id, student_group: cand.student_group, student_id: cand.student_id ?? null,
    student_name: cand.student_name ?? null, teacher_id: teacherId,
    before_moment_id: cand.before_moment_id ?? null, after_moment_id: cand.after_moment_id ?? null,
    candidate_snapshot: cand, status: 'verificando', motivo: null, motivo_detalle: null, fathom_causa: null,
    antes: null, despues: null, semanas, juez_nota: null, juez_explicacion: null, ms: null,
    updated_at: new Date().toISOString(),
  };
  const { error: upErr } = await admin.from('testimonial_verifications').upsert(base, { onConflict: 'id' });
  if (upErr) throw new Error(`testimonial_verifications: ${upErr.message}`);

  const sides: { antes: SideResult | null; despues: SideResult | null } = { antes: null, despues: null };
  const coste = { deepgram: 0, claude: 0 };
  type Lado = 'ANTES' | 'DESPUÉS';
  const finish = async (status: VerifyOutcome['status'], motivo: Motivo | null, detalle: string | null,
    extra: Row = {}, lado: Lado | null = null): Promise<VerifyOutcome> => {
    const ms = Date.now() - t0;
    const r4 = (x: number) => Math.round(x * 10000) / 10000;
    const { error: fErr } = await admin.from('testimonial_verifications').update({
      status, motivo, motivo_detalle: detalle, antes: sides.antes, despues: sides.despues, ms,
      coste_deepgram_usd: r4(coste.deepgram), coste_claude_usd: r4(coste.claude),
      updated_at: new Date().toISOString(), ...extra,
    }).eq('id', id);
    if (fErr) throw new Error(`testimonial_verifications: ${fErr.message}`);
    // Descarte del verificador: la pareja sale de "Por revisar" y, según el
    // motivo, el momento o la clase quedan vetados (saveVeto).
    if (kind === 'busqueda' && status === 'descartado') {
      await admin.from('testimonial_candidates').update({
        status: 'descartado', discarded_by: 'ia', status_changed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq('id', cand.id).eq('status', 'detectado');
      await saveVeto(admin, id, motivo, lado, (extra.fathom_causa as string | undefined) ?? null, cand, malo, bueno);
    }
    return { id, status, motivo, detalle, fathomCausa: (extra.fathom_causa as string | undefined) ?? null, nota: (extra.juez_nota as number | undefined) ?? null, ms };
  };
  const discard = (r: Extract<RuleResult, { ok: false }>, extra: Row = {}, lado: Lado | null = null) => finish('descartado', r.motivo, r.detalle, extra, lado);

  // 0. Gratis
  if (!malo || !bueno) return finish('descartado', 'otro', 'La pareja no tiene los dos clips.');
  if (cand.reverse_order) return finish('descartado', 'sin_contraste', 'El "antes" es de una clase posterior al "después".');
  if ((semanas ?? 0) < c.semanas_min) return finish('descartado', 'sin_contraste', `Solo ${semanas} semanas entre clases (mínimo ${c.semanas_min}).`);
  if (malo.teacherId && bueno.teacherId && malo.teacherId !== bueno.teacherId) return finish('descartado', 'sin_contraste', 'Los dos clips son con profes distintos.');

  // 1. Enlace
  const [ra, rb] = await Promise.all([readFathomShare(malo.fathomUrl), readFathomShare(bueno.fathomUrl)]);
  for (const [lado, r] of [['ANTES', ra], ['DESPUÉS', rb]] as const) {
    if (r.ok) continue;
    const detalle = `${lado}: ${r.detail}`;
    return r.cause === 'error'
      ? finish('error', 'enlace_roto', detalle, { fathom_causa: 'error' })
      : finish('descartado', 'enlace_roto', detalle, { fathom_causa: r.cause }, lado);
  }
  if (!ra.ok || !rb.ok) throw new Error('inalcanzable');

  // 2. Recorte (+ foto del profe de respaldo, en paralelo)
  const wa = cutWindow(malo.start, malo.end, c), wb = cutWindow(bueno.start, bueno.end, c);
  const ref = teacherReferenceFrame(admin, malo.analysisId, ra.source, malo.start).catch(() => null);
  let ca: CutResult, cb: CutResult;
  try {
    [ca, cb] = await Promise.all([cutClip(ra.source, wa.start, wa.dur), cutClip(rb.source, wb.start, wb.dur)]);
  } catch (err) {
    const e = err instanceof FathomCutError ? err : new FathomCutError(String(err), 'error');
    return e.failure === 'error'
      ? finish('error', 'enlace_roto', e.message, { fathom_causa: 'error' })
      : finish('descartado', 'enlace_roto', e.message, { fathom_causa: e.failure });
  }
  const [mediaA, mediaB] = await Promise.all([uploadMedia(admin, id, 'antes', ca), uploadMedia(admin, id, 'despues', cb)]);
  const side = (k: TestimonialClip, src: FathomSource, cut: CutResult, media: { audio: string | null; frames: string[] }): SideResult => ({
    fecha: k.classDate, inicio: cut.startS, dur: cut.durS, fathom: withFathomTimestamp(src.shareUrl, cut.startS),
    audio: media.audio, frames: media.frames, texto: null, textoFathom: k.excerpt, medidas: null,
  });
  sides.antes = side(malo, ra.source, ca, mediaA);
  sides.despues = side(bueno, rb.source, cb, mediaB);

  // 3-4. Audio y medidas
  let ta: Audio, tb: Audio;
  try {
    [ta, tb] = await Promise.all([transcribeBoth(admin, ca.audio, ca.durS, c), transcribeBoth(admin, cb.audio, cb.durS, c)]);
    coste.deepgram = deepgramUsd(ta, ca.durS, c) + deepgramUsd(tb, cb.durS, c);
  } catch (err) {
    const e = err instanceof DeepgramError ? err : new DeepgramError(String(err), null);
    return finish('error', null, `Deepgram: ${e.message}${e.body ? ` ${e.body.slice(0, 200)}` : ''}`);
  }
  const names = await pairNames(admin, cand, malo, teacherId);
  const isStudent = (n: string) => names.student.some(s => nameMatchesStrict(n, s) || nameMatchesStrict(s, n));
  const isTeacher = (n: string) => names.teacher.some(s => nameMatchesStrict(n, s) || nameMatchesStrict(s, n));

  // Otra voz o español: antes de descartar, voz partida y recorte (resolveAudio).
  const ajustes: Record<string, string> = {};
  const resolver = async (lado: Lado, t: Audio, cut: CutResult, src: FathomSource, key: 'antes' | 'despues') => {
    const r = await resolveAudio({ lado, t, cut, src, c, names, isStudent, isTeacher });
    coste.claude += r.claudeUsd;
    if (r.ajuste) ajustes[key] = r.ajuste;
    if (r.ok && r.cut !== cut) {
      const media = await uploadMedia(admin, id, key, r.cut);
      const s = sides[key]!;
      Object.assign(s, { inicio: r.cut.startS, dur: r.cut.durS, fathom: withFathomTimestamp(src.shareUrl, r.cut.startS), audio: media.audio, frames: media.frames });
    }
    return r;
  };
  const xa = await resolver('ANTES', ta, ca, ra.source, 'antes');
  const xb = await resolver('DESPUÉS', tb, cb, rb.source, 'despues');
  const extraAjustes = Object.keys(ajustes).length ? { ajustes } : {};
  sides.antes.texto = mainSpeakerText((xa.ok ? xa.t : ta).multi); sides.antes.medidas = xa.m;
  sides.despues.texto = mainSpeakerText((xb.ok ? xb.t : tb).multi); sides.despues.medidas = xb.m;
  if (!xa.m) return finish('descartado', 'sin_voz', 'ANTES: Deepgram no oye a nadie en el tramo.', extraAjustes);
  if (!xb.m) return finish('descartado', 'sin_voz', 'DESPUÉS: Deepgram no oye a nadie en el tramo.', extraAjustes);
  if (!xa.ok) return discard(xa.r, extraAjustes, 'ANTES');
  if (!xb.ok) return discard(xb.r, extraAjustes, 'DESPUÉS');
  ca = xa.cut; cb = xb.cut;
  const ma = xa.m, mb = xb.m;
  const reglasAudio: Array<[RuleResult, Lado | null]> = [
    [checkAntes(ma, c), 'ANTES'], [checkDespues(mb, c), 'DESPUÉS'], [checkContraste(ma, mb, c), null],
  ];
  for (const [r, lado] of reglasAudio) if (!r.ok) return discard(r, extraAjustes, lado);

  // 5. Imagen + juez
  const refFrame = await ref;
  const verdict = await askJudge(admin, { cand, sides: { antes: sides.antes, despues: sides.despues }, ca, cb, refFrame, semanas: semanas ?? 0, names });
  coste.claude += claudeUsd(verdict.usage, c);
  if (!verdict.ok) return finish('error', null, `Claude: ${verdict.error}`, extraAjustes);
  const v = verdict.data;
  sides.antes.vision = v.antes; sides.despues.vision = v.despues;
  const juez = { juez_nota: Math.round(v.nota), juez_explicacion: v.explicacion, ...extraAjustes };
  const reglasImagen: Array<[RuleResult, Lado]> = [
    [checkVision(v.antes, 'ANTES', c, isStudent, isTeacher), 'ANTES'], [checkVision(v.despues, 'DESPUÉS', c, isStudent, isTeacher), 'DESPUÉS'],
  ];
  for (const [r, lado] of reglasImagen) if (!r.ok) return discard(r, juez, lado);
  if (v.nota < c.juez_nota_min) return finish('descartado', 'nota_baja', `Nota ${Math.round(v.nota)} (mínimo ${c.juez_nota_min}): ${v.explicacion}`, juez);
  return finish('aprobado', null, null, juez);
}

type Audio = { multi: DeepgramTranscript; detect: DeepgramTranscript | null };

type AudioResuelto =
  | { ok: true; m: ClipMeasures; t: Audio; cut: CutResult; ajuste: string | null; claudeUsd: number }
  | { ok: false; m: ClipMeasures | null; r: Extract<RuleResult, { ok: false }>; ajuste: string | null; claudeUsd: number };

/**
 * Reglas del audio de UN lado, sin descartar a la primera (decisiones de Facundo,
 * 30/10/2026). Si salta "otra voz" o "español":
 *   1. VOZ PARTIDA (solo con "otra voz"): si en los 3 fotogramas el recuadro que
 *      habla es el del alumno, Deepgram partió en dos a la misma persona → una voz.
 *   2. RECORTE: el trozo continuo más largo en que habla solo el alumno en inglés;
 *      si dura `recorte_alumno_min_antes_s` / `_despues_s`, se vuelve a recortar de
 *      Fathom (audio y fotogramas nuevos) y se sigue con ese trozo. Deepgram no se
 *      vuelve a pagar: se miden sus palabras de ese trozo.
 * Si nada lo salva, el motivo de siempre (y el momento queda vetado).
 */
async function resolveAudio(x: {
  lado: 'ANTES' | 'DESPUÉS'; t: Audio; cut: CutResult; src: FathomSource; c: VerifyConfig;
  names: { student: string[]; teacher: string[] }; isStudent: (n: string) => boolean; isTeacher: (n: string) => boolean;
}): Promise<AudioResuelto> {
  const { lado, cut, src, c } = x;
  let t = x.t;
  let ajuste: string | null = null, gasto = 0;
  let m = measureClip(t.multi, t.detect, c);
  const sinVoz: Extract<RuleResult, { ok: false }> = { ok: false, motivo: 'sin_voz', detalle: `${lado}: Deepgram no oye a nadie en el tramo.` };
  if (!m) return { ok: false, m: null, r: sinVoz, ajuste, claudeUsd: gasto };
  let r = checkAudio(m, lado, c);
  if (r.ok) return { ok: true, m, t, cut, ajuste, claudeUsd: gasto };

  if (r.motivo === 'habla_profe' && cut.frames.length) {
    const quien = await framesSpeaker(cut.frames, x.names);
    gasto += claudeUsd(quien.usage, c);
    const nombres = quien.nombres.map(n => n.trim());
    if (nombres.length === cut.frames.length && nombres.every(n => n && x.isStudent(n) && !x.isTeacher(n))) {
      const unida: Audio = { multi: mergeSpeakers(t.multi), detect: t.detect ? mergeSpeakers(t.detect) : null };
      const m2 = measureClip(unida.multi, unida.detect, c);
      if (m2) {
        ajuste = `Voz partida: en los ${nombres.length} fotogramas habla "${nombres[0]}" (una sola voz).`;
        t = unida; m = m2; r = checkAudio(m2, lado, c);
        if (r.ok) return { ok: true, m, t, cut, ajuste, claudeUsd: gasto };
      }
    }
  }

  if (r.motivo === 'habla_profe' || r.motivo === 'espanol') {
    const run = longestStudentRun(t.multi);
    const min = lado === 'ANTES' ? c.recorte_alumno_min_antes_s : c.recorte_alumno_min_despues_s;
    const largo = run ? Math.round((run.end - run.start) * 10) / 10 : 0;
    if (run && largo >= min) {
      const sub: Audio = { multi: subTranscript(t.multi, run.start, run.end), detect: t.detect ? subTranscript(t.detect, run.start, run.end) : null };
      const m3 = measureClip(sub.multi, sub.detect, c);
      const r3 = m3 ? checkAudio(m3, lado, c) : r;
      if (m3 && r3.ok) {
        const pad = 0.3;
        const start = Math.round((cut.startS + Math.max(0, run.start - pad)) * 10) / 10;
        const dur = Math.round((largo + 2 * pad) * 10) / 10;
        const nuevo = await cutClip(src, start, dur).catch(() => null);
        const quitado = r.detalle.replace(/^(ANTES|DESPUÉS): /, '');
        ajuste = `${ajuste ? `${ajuste} ` : ''}Recortado a ${largo} s donde habla solo el alumno en inglés (${quitado}).`;
        // Sin el recorte nuevo se sigue con los fotogramas del clip entero.
        return { ok: true, m: m3, t: sub, cut: nuevo ?? cut, ajuste, claudeUsd: gasto };
      }
    }
    r = { ...r, detalle: `${r.detalle} El trozo más largo del alumno solo en inglés dura ${largo} s (mínimo ${min} s).` };
  }
  return { ok: false, m, r, ajuste, claudeUsd: gasto };
}

const FRAMES_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['nombres'],
  properties: {
    nombres: {
      type: 'array', items: { type: 'string' },
      description: 'Un nombre por fotograma, en orden: el del recuadro con el indicador de voz activo, copiado tal cual. Cadena vacía si no hay indicador o no se lee.',
    },
  },
};

/** Quién habla en cada fotograma (para la voz partida). Llamada corta: solo las imágenes. */
async function framesSpeaker(frames: Buffer[], names: { student: string[]; teacher: string[] }) {
  const r = await askClaudeJson<{ nombres: string[] }>({
    system: 'Lees fotogramas de grabaciones de Google Meet. Cada recuadro lleva el nombre de la persona abajo a la izquierda; quien habla tiene un icono de ondas arriba a la derecha y el borde resaltado. "X\'s Fathom Notetaker" es el grabador, nunca quien habla.',
    prompt: `Alumno: ${names.student.join(' / ') || 'sin nombre'}. Profe: ${names.teacher.join(' / ') || 'sin nombre'}.\nPara cada uno de los ${frames.length} fotogramas, el nombre del recuadro que está hablando.`,
    images: frames.map((f, i) => ({ label: `Fotograma ${i + 1}:`, mediaType: 'image/jpeg' as const, base64: f.toString('base64') })),
    schema: FRAMES_SCHEMA, maxTokens: 300, model: ECONOMY_MODEL, thinking: 'off',
    timeoutMs: 60_000, maxRetries: 1, label: 'testimonial-verify-voces', skipCleanKeys: ['nombres'],
  });
  return { nombres: r.status === 'ready' && Array.isArray(r.data?.nombres) ? r.data.nombres.map(String) : [], usage: r.usage };
}

/** Gasto estimado de Deepgram de un clip: segundos cobrados × precio de cada modo. */
function deepgramUsd(t: { multi: DeepgramTranscript; detect: DeepgramTranscript | null }, durS: number, c: VerifyConfig): number {
  const min = (x: DeepgramTranscript | null) => (x ? (x.durationS ?? durS) / 60 : 0);
  return min(t.multi) * c.deepgram_usd_min_multi + min(t.detect) * c.deepgram_usd_min_detect;
}

/** Gasto estimado de Claude por los tokens que devolvió la API (caché: lectura ×0,1, escritura ×1,25). */
function claudeUsd(u: AiResult<unknown>['usage'], c: VerifyConfig): number {
  if (!u) return 0;
  const entrada = u.input + u.cacheRead * 0.1 + u.cacheWrite * 1.25;
  return (entrada * c.claude_usd_mtok_entrada + u.output * c.claude_usd_mtok_salida) / 1_000_000;
}

/**
 * Veto tras un descarte del verificador: el MOMENTO por español, habla el profe,
 * leyendo o cámara apagada; la GRABACIÓN entera por enlace privado o borrado.
 * Momento = intervención en una grabación (momentKey): vale también para las
 * copias del mismo transcript en otra clase.
 * Best-effort: un fallo aquí no tumba la verificación.
 */
async function saveVeto(admin: SupabaseClient, verificationId: string, motivo: Motivo | null, lado: 'ANTES' | 'DESPUÉS' | null,
  fathomCausa: string | null, cand: Row, malo: TestimonialClip | null, bueno: TestimonialClip | null): Promise<void> {
  if (!motivo || !lado) return;
  const antes = lado === 'ANTES';
  const url = (antes ? malo : bueno)?.fathomUrl ?? null;
  let clave: string | null = null;
  if ((MOTIVOS_QUE_VETAN as readonly string[]).includes(motivo)) {
    const momento = momentKeyFromId((antes ? cand.before_moment_id : cand.after_moment_id) as string | null, url);
    if (momento) clave = `m:${momento}`;
  } else if (motivo === 'enlace_roto' && (fathomCausa === 'privado' || fathomCausa === 'borrado')) {
    if (url) clave = `g:${recordingKey(url)}`;
  }
  if (!clave) return;
  const { error } = await admin.from('testimonial_vetos').upsert(
    { clave, motivo, lado, verification_id: verificationId }, { onConflict: 'clave', ignoreDuplicates: true });
  if (error) console.error('[testimonial-verify] Veto sin guardar:', clave, error.message);
}

async function transcribeBoth(admin: SupabaseClient, audio: Buffer, seconds: number, c: VerifyConfig): Promise<Audio> {
  const common = { model: 'nova-3', diarize_model: 'latest', filler_words: true, punctuate: true };
  const [multi, detect] = await Promise.all([
    transcribeAudio(audio, { ...common, language: 'multi' }),
    c.deepgram_ambas ? transcribeAudio(audio, { ...common, detect_language: ['en', 'es'] }) : Promise.resolve(null),
  ]);
  await Promise.all([
    logDeepgramUsage(admin, 'verificador', 'multi', multi, seconds),
    logDeepgramUsage(admin, 'verificador', 'detect', detect, seconds),
  ]);
  return { multi, detect };
}

async function uploadMedia(admin: SupabaseClient, id: string, lado: 'antes' | 'despues', cut: CutResult): Promise<{ audio: string | null; frames: string[] }> {
  const put = async (path: string, body: Buffer, contentType: string) => {
    const { error } = await admin.storage.from(BUCKET).upload(path, body, { contentType, upsert: true });
    if (error) { console.error(`[testimonial-verify] Storage ${path}: ${error.message}`); return null; }
    return path;
  };
  const [audio, ...frames] = await Promise.all([
    put(`${id}/${lado}/audio.mp3`, cut.audio, 'audio/mpeg'),
    ...cut.frames.map((f, i) => put(`${id}/${lado}/f${i}.jpg`, f, 'image/jpeg')),
  ]);
  return { audio, frames: frames.filter((f): f is string => !!f) };
}

/** Fotograma de un momento de la MISMA clase en que habla el profe (≥ 12 palabras). */
async function teacherReferenceFrame(admin: SupabaseClient, analysisId: string, source: FathomSource, clipStart: number): Promise<Buffer | null> {
  const [{ data: ca }, { data: tt }] = await Promise.all([
    admin.from('class_analyses').select('transcript').eq('id', analysisId).maybeSingle(),
    admin.from('testimonial_transcripts').select('teacher_label').eq('analysis_id', analysisId).maybeSingle(),
  ]);
  const teacherLabel = tt?.teacher_label as string | undefined;
  if (!ca?.transcript || !teacherLabel) return null;
  const turnos = parseTurns(String(ca.transcript))
    .filter(t => t.speaker === teacherLabel && t.text.split(/\s+/).length >= 12)
    .map(t => toSeconds(t.at))
    .filter((s): s is number => s != null && Math.abs(s - clipStart) > 60);
  if (!turnos.length) return null;
  const at = turnos.sort((a, b) => Math.abs(a - clipStart) - Math.abs(b - clipStart))[0] + 3;
  return cutFrame(source, at);
}

/** Nombres con que puede salir cada uno en los recuadros de Meet. */
async function pairNames(admin: SupabaseClient, cand: Row, malo: TestimonialClip, teacherId: string | null) {
  const [{ data: t }, { data: tt }] = await Promise.all([
    teacherId ? admin.from('teachers').select('name').eq('id', teacherId).maybeSingle() : Promise.resolve({ data: null }),
    admin.from('testimonial_transcripts').select('teacher_label, student_label').eq('analysis_id', malo.analysisId).maybeSingle(),
  ]);
  const clean = (s: unknown) => String(s ?? '').replace(/\([^()]*\)/g, ' ').trim();
  const student = [cand.student_name, cand.student_label, malo.speakerLabel, tt?.student_label].map(clean).filter(Boolean);
  const teacher = [t?.name, tt?.teacher_label].map(clean).filter(Boolean);
  return { student: [...new Set(student)], teacher: [...new Set(teacher)] };
}

// ── Claude: imagen + juez ────────────────────────────────────────────────────

const SIDE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['camara_alumno', 'camara_conf', 'pantalla_compartida', 'recuadros_pequenos', 'leyendo', 'leyendo_conf', 'nombre_que_habla', 'quien_habla_por_cara'],
  properties: {
    camara_alumno: { type: 'string', enum: ['encendida', 'apagada', 'no_se_ve'], description: 'Cámara del ALUMNO en los 3 fotogramas.' },
    camara_conf: { type: 'number', description: 'Confianza de 0 a 1 en camara_alumno.' },
    pantalla_compartida: { type: 'boolean', description: 'Alguien comparte pantalla (documento, PDF, web) ocupando casi todo.' },
    recuadros_pequenos: { type: 'boolean', description: 'Las caras salen en miniaturas pequeñas al lado de la pantalla compartida.' },
    leyendo: { type: 'boolean', description: 'El alumno mira hacia abajo o a un texto y parece leer en voz alta.' },
    leyendo_conf: { type: 'number', description: 'Confianza de 0 a 1 en leyendo.' },
    nombre_que_habla: { type: 'string', description: 'Nombre escrito en el recuadro que tiene el indicador de voz activo (icono de ondas o borde resaltado), copiado tal cual. Cadena vacía si no se lee o no hay indicador.' },
    quien_habla_por_cara: { type: 'string', enum: ['alumno', 'profe', 'no_se_sabe'], description: 'Solo si no se lee el nombre: comparando con la FOTO DEL PROFE, ¿la persona que habla es el profe? Si hay nombre legible, no_se_sabe.' },
  },
};

const JUDGE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['antes', 'despues', 'nota', 'explicacion'],
  properties: {
    antes: SIDE_SCHEMA,
    despues: SIDE_SCHEMA,
    nota: { type: 'integer', description: 'De 0 a 100: qué tan convincente es la pareja como anuncio antes/después.' },
    explicacion: { type: 'string', description: 'Una sola línea, en español, con el motivo principal de la nota.' },
  },
};

const JUDGE_SYSTEM = `Eres el verificador de testimoniales de DRC Academy, una academia de inglés online para hispanohablantes. Buscamos parejas ANTES/DESPUÉS del MISMO alumno con el MISMO profe para un anuncio: en el ANTES el alumno se traba hablando inglés de verdad; en el DESPUÉS, semanas más tarde, habla con soltura.

Recibes de cada clip 3 fotogramas de la grabación de Google Meet (inicio, mitad y final), el texto transcrito por Deepgram (solo la voz principal) y medidas de fluidez ya calculadas. A veces recibes también una FOTO DEL PROFE de otro momento de la clase.

CÓMO LEER LOS FOTOGRAMAS
- En Meet cada recuadro lleva el nombre de la persona abajo a la izquierda. Quien habla tiene un icono de ondas (barras) arriba a la derecha y el borde resaltado. Copia ese nombre tal cual en nombre_que_habla.
- "X's Fathom Notetaker" es el grabador, no una persona: nunca es quien habla.
- Un recuadro con un círculo de color y una inicial, sin vídeo, es una cámara apagada.
- Si alguien comparte pantalla (PDF, ejercicio, web) y las caras quedan en miniaturas, márcalo: suele ser lectura o ejercicio.
- Usa la FOTO DEL PROFE solo cuando no se lea ningún nombre en el recuadro que habla.

LA NOTA (0-100)
- Alta (80+): el ANTES muestra a alguien buscando palabras de forma natural en una conversación y el DESPUÉS a la misma persona contando algo propio con fluidez; contraste evidente para cualquiera.
- Media (50-79): contraste real pero poco vistoso, clips cortos o algo dudosos.
- Baja (<50): parece lectura, ejercicio, frases sueltas, el profe hablando, mala imagen, o el contraste no se nota.
- Usa los ejemplos del banco (si los hay) para calibrar: los aprobados son lo que buscamos; los rechazados, con su motivo, lo que no.`;

async function examplesBank(admin: SupabaseClient): Promise<string> {
  const { data } = await admin.from('testimonial_examples').select('tipo, motivo, texto, resumen').order('created_at', { ascending: false }).limit(60);
  const rows = (data ?? []) as Row[];
  const buenos = rows.filter(r => r.tipo === 'aprobado').slice(0, 6);
  const calidad = rows.filter(r => r.tipo === 'calidad').slice(0, 3);
  const malos = rows.filter(r => r.tipo === 'rechazado').slice(0, 10);
  if (!buenos.length && !calidad.length && !malos.length) return '';
  const l = (r: Row) => `- ${String(r.resumen).slice(0, 400)}`;
  return [
    '\n\nBANCO DE EJEMPLOS',
    buenos.length ? `Aprobados por el admin:\n${buenos.map(l).join('\n')}` : '',
    calidad.length ? `Buena calidad de clip (solo como referencia de calidad, NO de separación entre clases):\n${calidad.map(l).join('\n')}` : '',
    malos.length ? `Rechazados por el admin, con su motivo:\n${malos.map(r => `- [${r.motivo}${r.texto ? `: ${r.texto}` : ''}] ${String(r.resumen).slice(0, 300)}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

const medidasTexto = (m: ClipMeasures | null) => m
  ? `${m.ppm} palabras/min, ${m.pausas} pausas (${m.pausas_min}/min, la más larga ${m.pausa_max_s} s), ${m.muletillas} muletillas, ${m.habla_s} s de habla`
  : 'sin medidas';

async function askJudge(admin: SupabaseClient, args: {
  cand: Row; sides: { antes: SideResult; despues: SideResult }; ca: CutResult; cb: CutResult;
  refFrame: Buffer | null; semanas: number; names: { student: string[]; teacher: string[] };
}): Promise<({ ok: true; data: VisionVerdict } | { ok: false; error: string }) & { usage: AiResult<unknown>['usage'] }> {
  const { sides, ca, cb, refFrame, names } = args;
  const img = (label: string, b: Buffer) => ({ label, mediaType: 'image/jpeg' as const, base64: b.toString('base64') });
  const momentos = ['inicio', 'mitad', 'final'];
  const images = [
    ...ca.frames.map((f, i) => img(`ANTES, fotograma ${i + 1} (${momentos[i]}):`, f)),
    ...cb.frames.map((f, i) => img(`DESPUÉS, fotograma ${i + 1} (${momentos[i]}):`, f)),
    ...(refFrame ? [img('FOTO DEL PROFE (otro momento de la clase del ANTES, hablando el profe):', refFrame)] : []),
  ];
  const prompt = [
    `Alumno: ${names.student.join(' / ') || 'sin nombre'}. Profe: ${names.teacher.join(' / ') || 'sin nombre'}.`,
    `Semanas entre las dos clases: ${args.semanas}.`,
    `ANTES (${sides.antes.fecha}): "${sides.antes.texto ?? ''}"\nMedidas: ${medidasTexto(sides.antes.medidas)}.`,
    `DESPUÉS (${sides.despues.fecha}): "${sides.despues.texto ?? ''}"\nMedidas: ${medidasTexto(sides.despues.medidas)}.`,
    'Rellena lo que ves en cada lado y pon la nota.',
  ].join('\n\n');
  const r = await askClaudeJson<VisionVerdict>({
    system: JUDGE_SYSTEM + await examplesBank(admin),
    prompt, images, schema: JUDGE_SCHEMA, maxTokens: 1500, model: ECONOMY_MODEL, thinking: 'off',
    timeoutMs: 90_000, maxRetries: 1, label: 'testimonial-verify',
    skipCleanKeys: ['camara_alumno', 'quien_habla_por_cara', 'nombre_que_habla'],
  });
  return r.status === 'ready' && r.data ? { ok: true, data: r.data, usage: r.usage } : { ok: false, error: r.error ?? 'sin respuesta', usage: r.usage };
}

// ── Revisión del admin ───────────────────────────────────────────────────────

export interface ReviewResult { endurecido: { key: string; antes: number; despues: number } | null }

/** Vuelve a dejar la pareja tal como se verificó, con el estado nuevo. */
async function writeBackCandidate(admin: SupabaseClient, v: Row, status: string, discardedBy: 'admin' | null): Promise<void> {
  const now = new Date().toISOString();
  const patch = { status, discarded_by: discardedBy, status_changed_at: now, updated_at: now };
  const snap = (v.candidate_snapshot ?? {}) as Row;
  let q = admin.from('testimonial_candidates').update(patch).eq('id', v.candidate_id);
  q = v.before_moment_id ? q.eq('before_moment_id', v.before_moment_id) : q;
  q = v.after_moment_id ? q.eq('after_moment_id', v.after_moment_id) : q;
  const { data, error } = await q.select('id');
  if (error) throw new Error(`Guardando la pareja: ${error.message}`);
  if ((data ?? []).length) return;
  // El buscador la cambió o la borró después de verificarla: se repone la verificada.
  if (status !== 'descartado') {
    await admin.from('testimonial_candidates').delete()
      .eq('student_group', snap.student_group).eq('pair_teacher_id', snap.pair_teacher_id).eq('status', 'detectado').neq('id', v.candidate_id);
  }
  const { error: e2 } = await admin.from('testimonial_candidates').upsert({ ...snap, ...patch }, { onConflict: 'id' });
  if (e2) throw new Error(`Reponiendo la pareja: ${e2.message}`);
}

const resumenEjemplo = (v: Row) => {
  const s = (x: SideResult | null) => x ? `"${(x.texto ?? x.textoFathom).slice(0, 160)}" (${medidasTexto(x.medidas)})` : '?';
  return `ANTES: ${s(v.antes)} · DESPUÉS: ${s(v.despues)}${v.juez_nota != null ? ` · nota del juez ${v.juez_nota}` : ''}`;
};

export async function reviewVerification(admin: SupabaseClient, id: string, review: 'sirve' | 'no_sirve',
  motivo: string | null, texto: string | null): Promise<ReviewResult> {
  if (review === 'no_sirve' && (!motivo || !MOTIVOS_ADMIN.includes(motivo as Motivo))) throw new Error('Elige un motivo.');
  if (review === 'no_sirve' && motivo === 'otro' && !texto?.trim()) throw new Error('Con "Otro", escribe el motivo.');
  const { data: v } = await admin.from('testimonial_verifications').select('*').eq('id', id).maybeSingle();
  if (!v) throw new Error('No existe esa verificación.');
  if (v.kind !== 'busqueda') throw new Error('Las verificaciones de prueba no se revisan.');
  const now = new Date().toISOString();

  await writeBackCandidate(admin, v, review === 'sirve' ? 'listo' : 'descartado', review === 'sirve' ? null : 'admin');
  const { error } = await admin.from('testimonial_verifications').update({
    review, review_motivo: review === 'no_sirve' ? motivo : null, review_texto: texto?.trim() || null, reviewed_at: now, updated_at: now,
  }).eq('id', id);
  if (error) throw new Error(error.message);
  await admin.from('testimonial_examples').upsert({
    id: `ex_${id}`, verification_id: id, candidate_id: v.candidate_id, tipo: review === 'sirve' ? 'aprobado' : 'rechazado',
    motivo: review === 'no_sirve' ? motivo : null, texto: texto?.trim() || null, resumen: resumenEjemplo(v), created_at: now,
  }, { onConflict: 'id' });

  return { endurecido: review === 'no_sirve' && motivo ? await maybeHarden(admin, motivo) : null };
}

/** Si el motivo se repite lo bastante, endurece su umbral un paso y lo registra. */
async function maybeHarden(admin: SupabaseClient, motivo: string): Promise<ReviewResult['endurecido']> {
  const { config, rows } = await loadConfig(admin);
  const row = rows.find(r => r.motivo === motivo && r.paso != null);
  if (!row) return null;
  const [{ data: reviews }, { data: last }] = await Promise.all([
    admin.from('testimonial_verifications').select('review_motivo, reviewed_at').not('reviewed_at', 'is', null)
      .order('reviewed_at', { ascending: false }).limit(config.endurecer_ventana),
    admin.from('testimonial_config_changes').select('created_at').eq('key', row.key).is('reverted_at', null)
      .order('created_at', { ascending: false }).limit(1),
  ]);
  const list = ((reviews ?? []) as Row[]).map(r => ({ motivo: r.review_motivo as string | null, at: String(r.reviewed_at) }));
  const lastAt = (last?.[0]?.created_at as string | undefined) ?? null;
  if (!shouldHarden(list, motivo, lastAt, config.endurecer_ventana, config.endurecer_veces)) return null;
  const next = hardenedValue(row.value, row.paso!, row.limite);
  if (next == null) return null;
  const n = list.filter(r => r.motivo === motivo && (!lastAt || r.at > lastAt)).length;
  await admin.from('testimonial_config').update({ value: next, updated_at: new Date().toISOString() }).eq('key', row.key);
  await admin.from('testimonial_config_changes').insert({
    key: row.key, antes: row.value, despues: next, motivo, detalle: `"${motivo}" en ${n} de las últimas ${list.length} revisiones.`,
  });
  return { key: row.key, antes: row.value, despues: next };
}

export async function undoConfigChange(admin: SupabaseClient, changeId: number): Promise<void> {
  const { data: ch } = await admin.from('testimonial_config_changes').select('*').eq('id', changeId).maybeSingle();
  if (!ch || ch.reverted_at) return;
  await admin.from('testimonial_config').update({ value: ch.antes, updated_at: new Date().toISOString() }).eq('key', ch.key);
  await admin.from('testimonial_config_changes').update({ reverted_at: new Date().toISOString() }).eq('id', changeId);
}

export async function setConsent(admin: SupabaseClient, id: string, valor: string): Promise<void> {
  if (!['sin_pedir', 'pedido', 'dado'].includes(valor)) throw new Error('Valor de consentimiento no válido.');
  const { error } = await admin.from('testimonial_verifications').update({ consentimiento: valor, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw new Error(error.message);
}

// ── Medios y limpieza ────────────────────────────────────────────────────────

export const mediaPaths = (v: Row): string[] =>
  (['antes', 'despues'] as const).flatMap(l => {
    const s = v[l] as SideResult | null;
    return s ? [s.audio, ...(s.frames ?? [])].filter((p): p is string => !!p) : [];
  });

/** Enlaces firmados (1 h) de una lista de rutas del bucket. */
export async function signPaths(admin: SupabaseClient, paths: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (let i = 0; i < paths.length; i += 100) {
    const { data } = await admin.storage.from(BUCKET).createSignedUrls(paths.slice(i, i + 100), 3600);
    for (const d of data ?? []) if (d.path && d.signedUrl) out[d.path] = d.signedUrl;
  }
  return out;
}

/** Borra audios y fotogramas de lo descartado pasados `retencion_dias`. "Sirve" nunca. Best-effort. */
export async function cleanupStorage(admin: SupabaseClient, c: VerifyConfig): Promise<number> {
  const limite = new Date(Date.now() - c.retencion_dias * 86_400_000).toISOString();
  const { data } = await admin.from('testimonial_verifications').select('id, antes, despues, review, status')
    .is('files_deleted_at', null).lt('updated_at', limite).or('status.eq.descartado,status.eq.error,review.eq.no_sirve').limit(25);
  const rows = ((data ?? []) as Row[]).filter(r => r.review !== 'sirve');
  if (!rows.length) return 0;
  const paths = rows.flatMap(mediaPaths);
  if (paths.length) {
    const { error } = await admin.storage.from(BUCKET).remove(paths);
    if (error) { console.error('[testimonial-verify] Limpieza:', error.message); return 0; }
  }
  await admin.from('testimonial_verifications').update({ files_deleted_at: new Date().toISOString() }).in('id', rows.map(r => r.id));
  return rows.length;
}

// ── Lo que enseña la pestaña ─────────────────────────────────────────────────

/** Aprobadas por revisar que se enseñan (las demás, con "Ver más") y cuántas con sus medios ya firmados. */
const TARJETAS_MAX = 300;
export const TARJETAS_CON_MEDIOS = 20;

const enlaceFalso = (url: string | null | undefined) => {
  const c = classifyShareUrl(url);
  return 'cause' in c || (c.shareUrl.split('/').pop() ?? '').length !== 32;
};

function batchSummary(rows: Row[]) {
  const porMotivo: Record<string, number> = {};
  let aprobados = 0, errores = 0, fuenteError = 0, enlacesProbados = 0, sirven = 0, revisadas = 0, costeDeepgram = 0, costeClaude = 0;
  for (const r of rows) {
    costeDeepgram += Number(r.coste_deepgram_usd ?? 0);
    costeClaude += Number(r.coste_claude_usd ?? 0);
    if (r.status === 'aprobado') aprobados++;
    if (r.status === 'error') errores++;
    if (r.status === 'descartado' && r.motivo) porMotivo[r.motivo] = (porMotivo[r.motivo] ?? 0) + 1;
    if (r.fathom_causa || r.antes) enlacesProbados++;
    if (r.fathom_causa === 'error') fuenteError++;
    if (r.review) { revisadas++; if (r.review === 'sirve') sirven++; }
  }
  const revisados = rows.filter(r => r.status !== 'verificando').length;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return { revisados, aprobados, errores, porMotivo, fuenteError, enlacesProbados, sirven, revisadas, costeDeepgram: r2(costeDeepgram), costeClaude: r2(costeClaude) };
}

export async function loadState(admin: SupabaseClient) {
  const { config, rows: configRows } = await loadConfig(admin);
  const limpiados = await cleanupStorage(admin, config).catch(() => 0);
  const LIGHT = 'id, batch_id, kind, candidate_id, student_name, teacher_id, status, motivo, motivo_detalle, fathom_causa, antes, despues, semanas, juez_nota, juez_explicacion, consentimiento, review, review_motivo, review_texto, reviewed_at, created_at, updated_at, files_deleted_at, ajustes';

  const [aprob, sirv, desc, batches, revs, cambios, prueba, teachers, gasto] = await Promise.all([
    admin.from('testimonial_verifications').select(LIGHT).eq('kind', 'busqueda').eq('status', 'aprobado').is('review', null)
      .order('juez_nota', { ascending: false }).limit(TARJETAS_MAX),
    admin.from('testimonial_verifications').select(LIGHT).eq('review', 'sirve').order('reviewed_at', { ascending: false }).limit(100),
    admin.from('testimonial_verifications').select(LIGHT).eq('kind', 'busqueda').eq('status', 'descartado')
      .order('updated_at', { ascending: false }).limit(60),
    admin.from('testimonial_verify_batches').select('id, started_at, finished_at, cancelled, planned, alumnos').eq('kind', 'busqueda').order('started_at', { ascending: false }).limit(8),
    admin.from('testimonial_verifications').select('review, review_motivo, reviewed_at').not('reviewed_at', 'is', null)
      .order('reviewed_at', { ascending: false }).limit(config.endurecer_ventana),
    admin.from('testimonial_config_changes').select('*').order('created_at', { ascending: false }).limit(10),
    admin.from('testimonial_verifications').select('id, status, motivo, fathom_causa, candidate_snapshot->clips').eq('kind', 'prueba').limit(2000),
    admin.from('teachers').select('id, name'),
    deepgramSpend(admin, config).catch(() => null),
  ]);
  const err = [aprob, sirv, desc, batches, revs, cambios, prueba].find(r => r.error)?.error;
  if (err) throw new Error(err.message);

  const batchIds = ((batches.data ?? []) as Row[]).map(b => String(b.id));
  const { data: inBatches } = batchIds.length
    ? await admin.from('testimonial_verifications').select('batch_id, status, motivo, fathom_causa, antes, review, coste_deepgram_usd, coste_claude_usd').in('batch_id', batchIds)
    : { data: [] as Row[] };
  const tandas = ((batches.data ?? []) as Row[]).map(b => ({
    id: b.id, startedAt: b.started_at, finishedAt: b.finished_at, cancelled: b.cancelled, planned: b.planned, alumnos: b.alumnos ?? null,
    ...batchSummary(((inBatches ?? []) as Row[]).filter(r => r.batch_id === b.id)),
  }));
  const ultima = tandas.find(t => t.revisados > 0) ?? null;
  const alarma = ultima && ultima.enlacesProbados >= 3 && ultima.fuenteError / ultima.enlacesProbados > config.alarma_fuente_pct
    ? { fallos: ultima.fuenteError, probados: ultima.enlacesProbados } : null;

  const motivosRechazo: Record<string, number> = {};
  for (const r of (revs.data ?? []) as Row[]) if (r.review === 'no_sirve' && r.review_motivo) motivosRechazo[r.review_motivo] = (motivosRechazo[r.review_motivo] ?? 0) + 1;

  // Prueba con los "No sirve" (paso 3): reparto con y sin enlaces falsos.
  const pr = (prueba.data ?? []) as Row[];
  const conFalso = (r: Row) => {
    const k = r.clips as TestimonialClips | null;
    return enlaceFalso(k?.malos?.[0]?.fathomUrl) || enlaceFalso(k?.buenos?.[0]?.fathomUrl);
  };
  const resumenPrueba = (rows: Row[]) => {
    const porMotivo: Record<string, number> = {};
    for (const r of rows) if (r.status === 'descartado') porMotivo[r.motivo ?? 'otro'] = (porMotivo[r.motivo ?? 'otro'] ?? 0) + 1;
    return {
      total: rows.length, descartados: rows.filter(r => r.status === 'descartado').length,
      aprobados: rows.filter(r => r.status === 'aprobado').length, errores: rows.filter(r => r.status === 'error').length, porMotivo,
    };
  };
  const { count: pruebaObjetivo } = await admin.from('testimonial_candidates').select('id', { count: 'exact', head: true })
    .eq('status', 'descartado').eq('discarded_by', 'admin');

  const nombreProfe = new Map(((teachers.data ?? []) as Row[]).map(t => [String(t.id), String(t.name)]));
  // Todas las aprobadas por revisar, de mejor a peor nota; los medios, de las primeras.
  const tarjetas = (aprob.data ?? []) as Row[];
  const media = await signPaths(admin, tarjetas.slice(0, TARJETAS_CON_MEDIOS).flatMap(mediaPaths));
  const conProfe = (r: Row) => ({ ...r, teacher_name: nombreProfe.get(String(r.teacher_id)) ?? null });

  return {
    tarjetas: tarjetas.map(conProfe), media, aprobadasPendientes: (aprob.data ?? []).length,
    sirven: ((sirv.data ?? []) as Row[]).map(conProfe),
    descartados: ((desc.data ?? []) as Row[]).map(conProfe),
    tandas, alarma, motivosRechazo, revisionesMiradas: (revs.data ?? []).length,
    cambios: cambios.data ?? [],
    umbrales: configRows,
    prueba: {
      objetivo: pruebaObjetivo ?? 0,
      todas: resumenPrueba(pr),
      sinEnlaceFalso: resumenPrueba(pr.filter(r => !conFalso(r))),
      conEnlaceFalso: pr.filter(conFalso).length,
    },
    limpiados,
    gasto,
    sirvenEstados: SIRVEN,
  };
}
