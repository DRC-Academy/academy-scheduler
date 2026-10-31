/// Verificador de testimoniales y panel de análisis.
//
// GET ?accion=probar-deepgram[&id=<testimonial_candidates.id>]
//   Prueba de conexión con UN clip, SOLO LECTURA (no escribe nada en la base):
//   abre el enlace público de Fathom, baja solo el tramo del clip "antes", saca
//   audio + 3 fotogramas y llama a Deepgram de dos maneras para ver cuál sirve:
//     · multi:  language=multi (idioma por palabra, inglés y español mezclados);
//     · detect: detect_language=en,es (un idioma para todo el clip, con confianza).
//   Sin id, toma la primera pareja por revisar cuyo enlace abra (sin cuentas de prueba).
//
// POST { accion, ... } — la pestaña Testimoniales:
//   · 'estado'          tarjetas, tandas, tanda abierta, alarma, umbrales, prueba (y limpia Storage)
//   Panel de análisis (lib/testimonialAnalysis), una llamada por paso:
//   · 'analisis-opciones'               alumnos y profes para el buscador
//   · 'analisis-contar'     { opciones } clases, alumnos, parejas y coste con esos filtros
//   · 'analisis-iniciar'    { opciones } abre la tanda y guarda sus filas
//   · 'analisis-estado'     { batchId } lo que falta (para seguir o reanudar)
//   · 'analisis-escuchar'   { batchId, idx } escucha UNA clase de la tanda
//   · 'analisis-planificar' { batchId } escucha terminada → parejas de la tanda
//   · 'analisis-verificar'  { batchId, idx } verifica UNA pareja de la tanda
//   · 'analisis-pausar'     { batchId, pausada }
//   Prueba con los "No sirve" (lib/testimonialVerifier):
//   · 'iniciar'         { tipo: 'prueba' } → { batchId, ids }
//   · 'verificar'       { batchId, id, tipo } → UNA pareja (el navegador las encadena)
//   Comunes:
//   · 'cerrar'          { batchId, cancelado } → resumen de la tanda (con el gasto estimado)
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
  signPaths, mediaPaths,
} from '@/lib/testimonialVerifier';
import {
  cleanOpciones, contarAnalisis, opcionesAnalisis, iniciarAnalisis, estadoTanda, escucharItem, planificarTanda,
  verificarItem, pausarTanda, tandaAbierta,
} from '@/lib/testimonialAnalysis';
import { cleanFilters } from '@/lib/testimonialPairPlan';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Una pareja tarda ~20-40 s (dos recortes, Deepgram, Claude y a veces un recorte
// más); contar o abrir una tanda lee toda la base. Hobby con Fluid Compute admite 300 s.
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
  const ok = (data: unknown) => Response.json(data, { headers: NO_STORE });
  const falta = (msg: string) => Response.json({ error: msg }, { status: 400, headers: NO_STORE });
  const opciones = () => {
    const raw = (body.opciones ?? {}) as Record<string, unknown>;
    return cleanOpciones(raw, cleanFilters(raw.filtros));
  };
  const tanda = () => str('batchId');
  const idx = () => (Number.isInteger(body.idx) ? Number(body.idx) : null);
  try {
    switch (body.accion) {
      case 'estado': {
        const [v, abierta] = await Promise.all([loadState(admin), tandaAbierta(admin).catch(() => null)]);
        return ok({ ...v, abierta });
      }
      case 'analisis-opciones':
        return ok(await opcionesAnalisis(admin));
      case 'analisis-contar':
        return ok(await contarAnalisis(admin, opciones()));
      case 'analisis-iniciar':
        return ok(await iniciarAnalisis(admin, opciones()));
      case 'analisis-estado': {
        const batchId = tanda();
        return batchId ? ok(await estadoTanda(admin, batchId)) : falta('Falta batchId.');
      }
      case 'analisis-escuchar': {
        const batchId = tanda(), i = idx();
        return batchId && i != null ? ok(await escucharItem(admin, batchId, i)) : falta('Faltan batchId o idx.');
      }
      case 'analisis-planificar': {
        const batchId = tanda();
        return batchId ? ok(await planificarTanda(admin, batchId)) : falta('Falta batchId.');
      }
      case 'analisis-verificar': {
        const batchId = tanda(), i = idx();
        return batchId && i != null ? ok(await verificarItem(admin, batchId, i)) : falta('Faltan batchId o idx.');
      }
      case 'analisis-pausar': {
        const batchId = tanda();
        if (!batchId) return falta('Falta batchId.');
        await pausarTanda(admin, batchId, body.pausada !== false);
        return ok({ ok: true });
      }
      case 'iniciar':
        return ok(await startBatch(admin, 'prueba'));
      case 'verificar': {
        const id = str('id'), batchId = str('batchId');
        if (!id || !batchId) return falta('Faltan id o batchId.');
        return ok(await verifyCandidate(admin, id, batchId, 'prueba'));
      }
      case 'cerrar': {
        const batchId = tanda();
        if (!batchId) return ok({ ok: true });
        return ok({ ok: true, resumen: await closeBatch(admin, batchId, body.cancelado === true) });
      }
      case 'revisar': {
        const id = str('id'), review = str('review');
        if (!id || (review !== 'sirve' && review !== 'no_sirve')) return falta('Revisión no válida.');
        return ok(await reviewVerification(admin, id, review, str('motivo'), str('texto')));
      }
      case 'consentimiento': {
        const id = str('id'), valor = str('valor');
        if (!id || !valor) return falta('Faltan datos.');
        await setConsent(admin, id, valor);
        return ok({ ok: true });
      }
      case 'deshacer-umbral': {
        const changeId = Number(body.changeId);
        if (!Number.isFinite(changeId)) return falta('Falta changeId.');
        await undoConfigChange(admin, changeId);
        return ok({ ok: true });
      }
      case 'medios': {
        const ids = Array.isArray(body.ids) ? (body.ids as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 60) : [];
        if (!ids.length) return ok({ media: {} });
        const { data, error: e } = await admin.from('testimonial_verifications').select('id, antes, despues').in('id', ids);
        if (e) throw new Error(e.message);
        return ok({ media: await signPaths(admin, (data ?? []).flatMap(mediaPaths)) });
      }
      default:
        return falta('Acción desconocida.');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[testimonial-verify]', body.accion, msg);
    const sinSql = /testimonial_(config|verif|examples)|bucket/i.test(msg) && /exist|schema cache|not found/i.test(msg);
    // Tablas y columnas de la v3 (escucha, panel, vetos, gasto).
    const sinSqlV3 = /testimonial_(batch_items|vetos|listen|deepgram)|fuente|filtros|objetivo|por_alumno|solo_nuevas|fase|paused_at|ajustes|source|plan|cursor|alumnos|coste_(deepgram|claude)_usd/i.test(msg)
      && /exist|schema cache|not found|could not find/i.test(msg);
    const error = sinSqlV3 ? 'Falta correr supabase-testimoniales-v3.sql en Supabase.'
      : sinSql ? 'Falta correr supabase-testimoniales-verificador.sql en Supabase.' : msg;
    return Response.json({ error }, { status: 500, headers: NO_STORE });
  }
}
