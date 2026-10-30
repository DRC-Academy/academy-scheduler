// Verificador de testimoniales (Fase 1, rama testimoniales-verificador).
//
// GET ?accion=probar-deepgram[&id=<testimonial_candidates.id>]
//   Prueba de conexión con UN clip, SOLO LECTURA (no escribe nada en la base):
//   abre el enlace público de Fathom, baja solo el tramo del clip "antes", saca
//   audio + 3 fotogramas y llama a Deepgram de dos maneras para ver cuál sirve:
//     · multi:  language=multi (idioma por palabra, inglés y español mezclados);
//     · detect: detect_language=en,es (un idioma para todo el clip, con confianza).
//   Sin id, toma la primera pareja por revisar cuyo enlace abra (sin cuentas de prueba).
//
// POST { accion, ... } — la pestaña Testimoniales (lib/testimonialVerifier):
//   · 'estado'          tarjetas, tandas, alarma, umbrales, prueba (y limpia Storage)
//   · 'iniciar'         { tipo: 'busqueda' | 'prueba' } → { batchId, ids }
//   · 'verificar'       { batchId, id, tipo } → UNA pareja (el navegador las encadena)
//   · 'cerrar'          { batchId, cancelado }
//   · 'revisar'         { id, review: 'sirve' | 'no_sirve', motivo?, texto? }
//   · 'consentimiento'  { id, valor: 'sin_pedir' | 'pedido' | 'dado' }
//   · 'deshacer-umbral' { changeId }
//   · 'medios'          { ids } → enlaces firmados de sus audios y fotogramas
//
// SEGURIDAD: todo exige la sesión de admin (cookie httpOnly firmada,
// lib/adminSession): devuelve datos de alumnos y cada verificación gasta Deepgram
// y Claude.

import { requireAdminSession } from '@/lib/adminSession';
import { requireAdminClient } from '@/lib/cronAuth';
import { readFathomShare, cutClip, FathomCutError, type FathomSource } from '@/lib/fathomVideo';
import { transcribeAudio, DeepgramError, type DeepgramParams, type DeepgramTranscript } from '@/lib/deepgram';
import type { TestimonialClip, TestimonialClips } from '@/lib/testimonials';
import {
  startBatch, verifyCandidate, closeBatch, loadState, reviewVerification, setConsent, undoConfigChange,
  signPaths, mediaPaths, type BatchKind,
} from '@/lib/testimonialVerifier';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Una pareja tarda ~20-30 s (dos recortes, Deepgram y Claude); 'iniciar' puede
// rehacer parejas del buscador. Hobby con Fluid Compute admite 300 s.
export const maxDuration = 300;

const NO_STORE = { 'Cache-Control': 'no-store' };
const CLIP_SECONDS = 20;
const MAX_TRIES = 6;

const VARIANTES: Record<'multi' | 'detect', DeepgramParams> = {
  multi: { model: 'nova-3', language: 'multi', diarize_model: 'latest', filler_words: true, punctuate: true },
  detect: { model: 'nova-3', detect_language: ['en', 'es'], diarize_model: 'latest', filler_words: true, punctuate: true },
};

const FILLER = /^(u+m+|u+h+|m+|h+m+|e+r+m*|a+h+|e+h+|e+m+)$/i;

function resumen(t: DeepgramTranscript, ms: number) {
  const speakers = [...new Set(t.words.map(w => w.speaker).filter(s => s !== undefined))];
  const porIdioma: Record<string, number> = {};
  for (const w of t.words) if (w.language) porIdioma[w.language] = (porIdioma[w.language] ?? 0) + 1;
  return {
    ok: true, ms, requestId: t.requestId, modelos: t.models, duracionS: t.durationS,
    palabras: t.words.length,
    voces: speakers.length, vocesIds: speakers,
    idiomaDetectado: t.detectedLanguage, confianzaIdioma: t.languageConfidence,
    idiomasDelClip: t.languages, palabrasPorIdioma: Object.keys(porIdioma).length ? porIdioma : null,
    muletillas: t.words.filter(w => FILLER.test(w.word)).map(w => `${w.word}@${w.start.toFixed(1)}s`),
    texto: t.transcript.slice(0, 600),
    muestraPalabras: t.words.slice(0, 3),
  };
}

async function variante(audio: Buffer, params: DeepgramParams) {
  const t0 = Date.now();
  try {
    return resumen(await transcribeAudio(audio, params), Date.now() - t0);
  } catch (err) {
    const e = err instanceof DeepgramError ? err : new DeepgramError(String(err), null);
    return { ok: false, ms: Date.now() - t0, status: e.status, error: e.message, cuerpo: e.body ?? null };
  }
}

type Row = Record<string, unknown>;

export async function GET(request: Request): Promise<Response> {
  const session = requireAdminSession(request);
  if (session.error) return session.error;
  const { admin, error } = requireAdminClient('testimonial-verify');
  if (error) return error;

  const q = new URL(request.url).searchParams;
  if (q.get('accion') !== 'probar-deepgram') {
    return Response.json({ error: 'Acción desconocida. Usa ?accion=probar-deepgram' }, { status: 400, headers: NO_STORE });
  }
  if (!process.env.DEEPGRAM_API_KEY?.trim()) {
    return Response.json({ ok: false, error: 'Falta DEEPGRAM_API_KEY en este entorno de Vercel.' }, { status: 500, headers: NO_STORE });
  }

  // Candidatos: el pedido, o las parejas por revisar (sin profes ni alumnos de prueba).
  const id = q.get('id');
  let query = admin.from('testimonial_candidates')
    .select('id, student_id, student_name, pair_teacher_id, before_teacher_id, clips, status')
    .not('clips', 'is', null);
  query = id ? query.eq('id', id) : query.eq('status', 'detectado').order('after_class_date', { ascending: false }).limit(40);
  const [{ data: cands, error: cErr }, { data: tTest }, { data: sTest }] = await Promise.all([
    query,
    admin.from('teachers').select('id').eq('is_test', true),
    admin.from('students').select('id').eq('is_test', true),
  ]);
  if (cErr) return Response.json({ ok: false, error: cErr.message }, { status: 500, headers: NO_STORE });
  const testT = new Set((tTest ?? []).map((r: Row) => String(r.id)));
  const testS = new Set((sTest ?? []).map((r: Row) => String(r.id)));

  const intentos: Array<{ candidato: string; causa: string; detalle: string }> = [];
  let elegido: { cand: Row; clip: TestimonialClip; source: FathomSource; fathomMs: number } | null = null;
  for (const cand of (cands ?? []) as Row[]) {
    if (intentos.length >= MAX_TRIES) break;
    const teacher = String(cand.pair_teacher_id ?? cand.before_teacher_id ?? '');
    if (!id && (testT.has(teacher) || testS.has(String(cand.student_id ?? '')))) continue;
    const clip = (cand.clips as TestimonialClips | null)?.malos?.[0];
    if (!clip) continue;
    const read = await readFathomShare(clip.fathomUrl);
    if (read.ok) { elegido = { cand, clip, source: read.source, fathomMs: read.ms }; break; }
    intentos.push({ candidato: String(cand.id), causa: read.cause, detalle: read.detail });
  }
  if (!elegido) {
    return Response.json({ ok: false, error: 'Ningún clip con enlace de Fathom legible.', intentos }, { status: 404, headers: NO_STORE });
  }

  const { cand, clip, source } = elegido;
  // El inicio de Fathom es una estimación (ver lib/testimonialScoring): 2 s de margen.
  const start = Math.max(0, clip.start - 2);
  let cut;
  try {
    cut = await cutClip(source, start, CLIP_SECONDS);
  } catch (err) {
    const e = err instanceof FathomCutError ? err : new FathomCutError(String(err), 'error');
    return Response.json({ ok: false, etapa: 'recorte', causa: e.failure, error: e.message, intentos }, { status: 502, headers: NO_STORE });
  }

  const [multi, detect] = await Promise.all([variante(cut.audio, VARIANTES.multi), variante(cut.audio, VARIANTES.detect)]);
  const ok = multi.ok || detect.ok;

  return Response.json({
    ok,
    veredicto: ok
      ? 'Deepgram respondió. Compara las dos variantes: voces, idioma y muletillas.'
      : 'Deepgram NO respondió bien en ninguna variante: mira status y cuerpo.',
    candidato: {
      id: cand.id, alumno: cand.student_name, profe: cand.pair_teacher_id ?? cand.before_teacher_id,
      clase: clip.classDate, textoFathom: clip.excerpt,
      fathom: `${source.shareUrl}?timestamp=${Math.round(start)}`,
    },
    fathom: {
      abrirPaginaMs: elegido.fathomMs, listaMs: cut.ms.playlist, descargaMs: cut.ms.download, ffmpegMs: cut.ms.ffmpeg,
      trozos: cut.chunks, mb: +(cut.bytes / 1e6).toFixed(2), audioKb: Math.round(cut.audio.length / 1024),
      fotogramas: cut.frames.length, duracionGrabacionS: source.durationS,
    },
    deepgram: { multi, detect },
    intentosFallidos: intentos,
  }, { headers: NO_STORE });
}

export async function POST(request: Request): Promise<Response> {
  const session = requireAdminSession(request);
  if (session.error) return session.error;
  const { admin, error } = requireAdminClient('testimonial-verify');
  if (error) return error;

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : null);
  const tipo: BatchKind = str('tipo') === 'prueba' ? 'prueba' : 'busqueda';
  try {
    switch (body.accion) {
      case 'estado':
        return Response.json(await loadState(admin), { headers: NO_STORE });
      case 'iniciar':
        return Response.json(await startBatch(admin, tipo), { headers: NO_STORE });
      case 'verificar': {
        const id = str('id'), batchId = str('batchId');
        if (!id || !batchId) return Response.json({ error: 'Faltan id o batchId.' }, { status: 400, headers: NO_STORE });
        return Response.json(await verifyCandidate(admin, id, batchId, tipo), { headers: NO_STORE });
      }
      case 'cerrar': {
        const batchId = str('batchId');
        if (batchId) await closeBatch(admin, batchId, body.cancelado === true);
        return Response.json({ ok: true }, { headers: NO_STORE });
      }
      case 'revisar': {
        const id = str('id'), review = str('review');
        if (!id || (review !== 'sirve' && review !== 'no_sirve')) return Response.json({ error: 'Revisión no válida.' }, { status: 400, headers: NO_STORE });
        return Response.json(await reviewVerification(admin, id, review, str('motivo'), str('texto')), { headers: NO_STORE });
      }
      case 'consentimiento': {
        const id = str('id'), valor = str('valor');
        if (!id || !valor) return Response.json({ error: 'Faltan datos.' }, { status: 400, headers: NO_STORE });
        await setConsent(admin, id, valor);
        return Response.json({ ok: true }, { headers: NO_STORE });
      }
      case 'deshacer-umbral': {
        const changeId = Number(body.changeId);
        if (!Number.isFinite(changeId)) return Response.json({ error: 'Falta changeId.' }, { status: 400, headers: NO_STORE });
        await undoConfigChange(admin, changeId);
        return Response.json({ ok: true }, { headers: NO_STORE });
      }
      case 'medios': {
        const ids = Array.isArray(body.ids) ? (body.ids as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 60) : [];
        if (!ids.length) return Response.json({ media: {} }, { headers: NO_STORE });
        const { data, error: e } = await admin.from('testimonial_verifications').select('id, antes, despues').in('id', ids);
        if (e) throw new Error(e.message);
        return Response.json({ media: await signPaths(admin, (data ?? []).flatMap(mediaPaths)) }, { headers: NO_STORE });
      }
      default:
        return Response.json({ error: 'Acción desconocida.' }, { status: 400, headers: NO_STORE });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[testimonial-verify]', body.accion, msg);
    const sinSql = /testimonial_(config|verif|examples)|bucket/i.test(msg) && /exist|schema cache|not found/i.test(msg);
    return Response.json({ error: sinSql ? 'Falta correr supabase-testimoniales-verificador.sql en Supabase.' : msg }, { status: 500, headers: NO_STORE });
  }
}
