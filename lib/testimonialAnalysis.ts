// Testimoniales — PANEL DE ANÁLISIS (servidor). Sustituye al botón único "Buscar
// y verificar": el admin elige qué se analiza y ve el volumen y el coste antes de
// gastar. SOLO SERVIDOR.
//
// FILTROS: fechas de las clases (desde/hasta), alumno, profe, cuántas parejas en
// la tanda (o todas), cuántas por alumno, fuente y "solo lo que nunca se analizó".
//
// FUENTES DE PAREJAS:
//   · 'texto'   — los recortes del texto de Fathom (testimonial_segments, V6),
//                 varias por alumno con lib/testimonialPairPlan;
//   · 'escucha' — tramos escuchados con Deepgram (lib/testimonialListen). Las
//                 clases que falten se escuchan primero, dentro de la tanda.
//
// LA TANDA vive en Supabase (testimonial_verify_batches + testimonial_batch_items):
// cada pareja (o clase por escuchar) es una fila con su estado. Pausar o cerrar la
// pestaña no pierde nada: "Reanudar" pide las pendientes y sigue; lo hecho nunca se
// repite ni se paga dos veces. El navegador lleva 3 alumnos a la vez y, dentro de
// cada alumno, sus parejas de una en una (una llamada al servidor por pareja): al
// aprobar una, pasa al siguiente alumno. No para a las 5 aprobadas: sigue hasta
// el número elegido.
//
// Siempre fuera: cuentas de prueba, alumnos con una "Sirve" o con una aprobada por
// revisar, momentos de un "No sirve" del admin, enlaces falsos y lo vetado
// (testimonial_vetos: momentos por español, habla el profe, leyendo o cámara
// apagada; grabaciones con el enlace privado o borrado).

import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { classifyShareUrl } from '@/lib/fathomVideo';
import { loadConfig } from '@/lib/testimonialConfigStore';
import { toSegment, pairColumns } from '@/lib/testimonialSegmentsStore';
import { averageWpm, blockingScore, fluencyScore, daysBetween, type ExtractStats, type Segment } from '@/lib/testimonialScoring';
import {
  planStudentPairs, comparePlanned, toPlanItem, isVetoed, momentKey, momentKeyFromId, recordingKey, pickDiverse, passesFilters,
  type PlanFiltros, type PlanItem, type PlannedPair, type Vetos,
} from '@/lib/testimonialPairPlan';
import { selectListenClasses, listenPairs, compareListenPairs, contrastScore, type ListenClass, type ListenPlanSegment, type ListenPlannedPair } from '@/lib/testimonialListenRank';
import { listenClass, listenColumns, toListenSegment, LISTEN_DONE, type ListenResult } from '@/lib/testimonialListen';
import { verifyCandidate, batchResumen, closeBatch, type VerifyOutcome } from '@/lib/testimonialVerifier';
import { weeksBetween, type VerifyConfig } from '@/lib/testimonialMeasures';
import type { TestimonialClips } from '@/lib/testimonials';

type Row = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any

export type Fuente = 'escucha' | 'texto';

export interface AnalisisOpciones {
  filtros: PlanFiltros;
  /** Parejas a verificar en la tanda; null = todas las que cumplan los filtros. */
  cantidad: number | null;
  porAlumno: number;
  fuente: Fuente;
  soloNuevas: boolean;
}

const SIRVEN = ['listo', 'revisado', 'permiso_alumno'];
const CANTIDADES = [50, 200, 500, 1000];
const POR_ALUMNO = [1, 5, 10, 20];

/** Lo que llega del navegador, a valores permitidos. */
export function cleanOpciones(raw: unknown, filtros: PlanFiltros): AnalisisOpciones {
  const o = (raw ?? {}) as Record<string, unknown>;
  const cantidad = CANTIDADES.includes(Number(o.cantidad)) ? Number(o.cantidad) : null;
  const porAlumno = POR_ALUMNO.includes(Number(o.porAlumno)) ? Number(o.porAlumno) : 10;
  return { filtros, cantidad, porAlumno, fuente: o.fuente === 'texto' ? 'texto' : 'escucha', soloNuevas: o.soloNuevas !== false };
}

// ── Lecturas comunes ─────────────────────────────────────────────────────────

/**
 * Todas las filas (Supabase devuelve 1.000 por consulta): la primera página trae
 * el total y el resto se pide en paralelo, de 8 en 8.
 */
async function paged(admin: SupabaseClient, table: string, cols: string, order: string, apply?: (q: any) => any): Promise<Row[]> {   // eslint-disable-line @typescript-eslint/no-explicit-any
  const page = async (from: number, count: boolean) => {
    let q = admin.from(table).select(cols, count ? { count: 'exact' } : undefined);
    if (apply) q = apply(q);
    const r = await q.order(order).range(from, from + 999);
    if (r.error) throw new Error(`${table}: ${r.error.message}`);
    return r;
  };
  const first = await page(0, true);
  const out: Row[] = [...((first.data ?? []) as unknown as Row[])];
  const total = first.count ?? out.length;
  const froms: number[] = [];
  for (let from = 1000; from < total; from += 1000) froms.push(from);
  for (let i = 0; i < froms.length; i += 8) {
    const pages = await Promise.all(froms.slice(i, i + 8).map(from => page(from, false)));
    for (const p of pages) out.push(...((p.data ?? []) as unknown as Row[]));
  }
  return out;
}

/**
 * Lecturas grandes que no cambian mientras se mueven los filtros del panel
 * (recortes, transcripts): 3 minutos en memoria. Abrir una tanda lee siempre de nuevo.
 */
const CACHE_MS = 3 * 60_000;
const cache = new Map<string, { at: number; rows: Promise<Row[]> }>();
function cachedPaged(fresco: boolean, filtro: string, ...args: Parameters<typeof paged>): Promise<Row[]> {
  const [, table, cols, order] = args;
  const key = `${table}|${cols}|${order}|${filtro}`;
  const hit = cache.get(key);
  if (!fresco && hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
  const rows = paged(...args);
  cache.set(key, { at: Date.now(), rows });
  rows.catch(() => cache.delete(key));
  return rows;
}

async function inChunks(ids: string[], fn: (chunk: string[]) => Promise<Row[]>): Promise<Row[]> {
  const out: Row[] = [];
  for (let i = 0; i < ids.length; i += 100) out.push(...await fn(ids.slice(i, i + 100)));
  return out;
}

const enlaceBueno = (url: string | null | undefined) => {
  const c = classifyShareUrl(url);
  return !('cause' in c) && (c.shareUrl.split('/').pop() ?? '').length === 32;
};

export async function loadVetos(admin: SupabaseClient): Promise<Vetos> {
  const rows = await paged(admin, 'testimonial_vetos', 'clave', 'clave');
  const momentos = new Set<string>(), grabaciones = new Set<string>();
  for (const r of rows) {
    const k = String(r.clave);
    if (k.startsWith('m:')) momentos.add(k.slice(2));
    else if (k.startsWith('g:')) grabaciones.add(k.slice(2));
  }
  return { momentos, grabaciones };
}

interface Contexto {
  testTeachers: Set<string>;
  testStudents: Set<string>;
  vetos: Vetos;
  /** Combinaciones ya verificadas (momentKey|momentKey). */
  verificadas: Set<string>;
  /** Alumnos que no entran: con una "Sirve" o con una aprobada por revisar. */
  fuera: Set<string>;
  /** "No sirve" del admin por alumno: grabación y tramo. */
  noSirve: Map<string, Array<{ rec: string; start: number; end: number }>>;
}

async function contexto(admin: SupabaseClient): Promise<Contexto> {
  const [tT, tS, cands, vers, vetos] = await Promise.all([
    paged(admin, 'teachers', 'id', 'id', q => q.eq('is_test', true)),
    paged(admin, 'students', 'id', 'id', q => q.eq('is_test', true)),
    paged(admin, 'testimonial_candidates', 'id, student_group, status, discarded_by, clips', 'id'),
    paged(admin, 'testimonial_verifications', 'id, student_group, status, review, before_moment_id, after_moment_id, candidate_snapshot->clips', 'id', q => q.eq('kind', 'busqueda')),
    loadVetos(admin),
  ]);
  const verificadas = new Set(vers.filter(v => v.status === 'aprobado' || v.status === 'descartado').map(v => {
    const k = v.clips as TestimonialClips | null;
    return `${momentKeyFromId(v.before_moment_id, k?.malos?.[0]?.fathomUrl)}|${momentKeyFromId(v.after_moment_id, k?.buenos?.[0]?.fathomUrl)}`;
  }));
  const fuera = new Set([
    ...vers.filter(v => v.status === 'aprobado' && !v.review).map(v => String(v.student_group)),
    ...cands.filter(x => SIRVEN.includes(String(x.status))).map(x => String(x.student_group)),
  ]);
  const noSirve = new Map<string, Array<{ rec: string; start: number; end: number }>>();
  for (const x of cands) {
    if (x.status !== 'descartado' || x.discarded_by === 'ia') continue;
    const k = x.clips as TestimonialClips | null;
    if (!k || !Array.isArray(k.malos) || !Array.isArray(k.buenos)) continue;
    const g = String(x.student_group);
    noSirve.set(g, [...(noSirve.get(g) ?? []), ...[...k.malos, ...k.buenos].map(b => ({ rec: recordingKey(b.fathomUrl), start: b.start, end: b.end }))]);
  }
  return {
    testTeachers: new Set(tT.map(r => String(r.id))), testStudents: new Set(tS.map(r => String(r.id))),
    vetos, verificadas, fuera, noSirve,
  };
}

const tocaNoSirve = (ctx: Contexto, g: string, rec: string, start: number, end: number) =>
  (ctx.noSirve.get(g) ?? []).some(b => b.rec === rec && start < b.end && b.start < end);

// ── Plan: texto de Fathom ────────────────────────────────────────────────────

const SEG_COLS = 'id, analysis_id, student_group, teacher_id, class_day, student_label, kind, turn_index, start_s, end_s, text, words, fillers, repeats, searches, spanish_words, turn_wpm, teacher_before, fathom_url';

interface Plan {
  /** Pares en el orden en que se prueban: alumno a alumno (el de mejor pareja primero). */
  items: PlanItem[];
  alumnos: number;
  clases: number;
  /** Solo escucha: clases que hay que escuchar antes de tener todas las parejas. */
  porEscuchar: Array<{ g: string; analysisId: string }>;
  /** Solo escucha: alumnos que aún tienen clases sin escuchar. */
  alumnosPorEscuchar: number;
}

function studentWpm(txs: Row[]): number | null {
  const valid = txs.filter(t => t.segments_at && t.status === 'ready');
  return valid.length ? averageWpm(valid.map(t => (t.segment_stats ?? { palabras: 0, segundos: 0 }) as ExtractStats)) : null;
}

async function planTexto(admin: SupabaseClient, c: VerifyConfig, o: AnalisisOpciones, ctx: Contexto, fresco: boolean): Promise<Plan> {
  const f = o.filtros;
  const filtroAlumno = (q: any) => (f.alumno ? q.eq('student_group', f.alumno) : q);   // eslint-disable-line @typescript-eslint/no-explicit-any
  const [segRows, txRows] = await Promise.all([
    cachedPaged(fresco, f.alumno ?? '', admin, 'testimonial_segments', SEG_COLS, 'id', filtroAlumno),
    cachedPaged(fresco, f.alumno ?? '', admin, 'testimonial_transcripts', 'analysis_id, student_group, status, segments_at, segment_stats', 'analysis_id', filtroAlumno),
  ]);
  const bucket = (rows: Row[]) => {
    const m = new Map<string, Row[]>();
    for (const r of rows) { const g = String(r.student_group); m.set(g, [...(m.get(g) ?? []), r]); }
    return m;
  };
  const segsBy = bucket(segRows), txBy = bucket(txRows);
  const linkOk = new Map<string, boolean>();
  const bueno = (u: string) => { if (!linkOk.has(u)) linkOk.set(u, enlaceBueno(u)); return linkOk.get(u)!; };
  const clases = new Set<string>();

  const porAlumno: Array<{ g: string; pares: PlannedPair[] }> = [];
  for (const [g, rows] of segsBy) {
    if (ctx.testStudents.has(g) || ctx.fuera.has(g)) continue;
    const avg = studentWpm(txBy.get(g) ?? []);
    if (avg == null) continue;
    const segs = rows.map(toSegment);
    const entra = (s: Segment) => passesFilters(s.classDay, s.teacherId, f) && !!s.fathomUrl && bueno(s.fathomUrl)
      && !ctx.testTeachers.has(String(s.teacherId));
    for (const s of segs) if (entra(s)) clases.add(s.analysisId);
    const pares = planStudentPairs(segs, avg, {
      max: o.porAlumno, perMoment: c.momento_max_parejas, spanishMax: c.momento_espanol_max, minWeeks: c.semanas_min,
      blocked: s => !entra(s) || isVetoed(s, ctx.vetos) || tocaNoSirve(ctx, g, recordingKey(s.fathomUrl), s.start, s.end),
      skipPair: o.soloNuevas ? (a, b) => ctx.verificadas.has(`${momentKey(a)}|${momentKey(b)}`) : undefined,
    });
    if (pares.length) porAlumno.push({ g, pares });
  }
  porAlumno.sort((x, y) => comparePlanned(y.pares[0], x.pares[0]));
  return {
    items: porAlumno.flatMap(({ g, pares }) => pares.map(p => toPlanItem(g, p))),
    alumnos: porAlumno.length, clases: clases.size, porEscuchar: [], alumnosPorEscuchar: 0,
  };
}

// ── Plan: escucha ────────────────────────────────────────────────────────────

async function planEscucha(admin: SupabaseClient, c: VerifyConfig, o: AnalisisOpciones, ctx: Contexto, fresco: boolean): Promise<Plan> {
  const f = o.filtros;
  const [students, tts] = await Promise.all([
    cachedPaged(fresco, f.alumno ?? '', admin, 'students', 'id, name, is_test', 'id', q => (f.alumno ? q.eq('id', f.alumno) : q)),
    cachedPaged(fresco, f.alumno ?? '', admin, 'testimonial_transcripts', 'analysis_id, student_group, teacher_id, class_day, fathom_url, student_label', 'analysis_id',
      q => { const x = q.eq('status', 'ready'); return f.alumno ? x.eq('student_group', f.alumno) : x; }),
  ]);
  // Con ficha y no de prueba ("name:…" = sin ficha; un id que no está = ficha borrada).
  const ficha = new Map(students.filter(s => !s.is_test).map(s => [String(s.id), String(s.name ?? '')]));
  const urls = new Map<string, string>();
  const byStudent = new Map<string, ListenClass[]>();
  for (const t of tts) {
    const g = String(t.student_group);
    if (!ficha.has(g) || ctx.fuera.has(g) || !t.class_day || ctx.testTeachers.has(String(t.teacher_id)) || !enlaceBueno(t.fathom_url)) continue;
    if (ctx.vetos.grabaciones.has(recordingKey(t.fathom_url))) continue;
    const day = String(t.class_day).slice(0, 10);
    if (!passesFilters(day, t.teacher_id ?? null, f)) continue;
    urls.set(String(t.analysis_id), String(t.fathom_url));
    byStudent.set(g, [...(byStudent.get(g) ?? []), { analysisId: String(t.analysis_id), studentGroup: g, teacherId: t.teacher_id ?? null, classDay: day, fathomUrl: String(t.fathom_url) }]);
  }
  const groups = [...byStudent.keys()];
  const [listened, segRows] = await Promise.all([
    inChunks(groups, ch => paged(admin, 'testimonial_listen_classes', 'analysis_id, status', 'analysis_id', q => q.in('student_group', ch))),
    inChunks(groups, ch => paged(admin, 'testimonial_listen_segments', 'id, analysis_id, student_group, teacher_id, class_day, turn_index, start_s, dur_s, habla_start_s, habla_end_s, medidas, texto', 'id', q => q.in('student_group', ch))),
  ]);
  const hecha = new Set(listened.filter(r => LISTEN_DONE.includes(String(r.status))).map(r => String(r.analysis_id)));
  const segsBy = new Map<string, Row[]>();
  for (const r of segRows) segsBy.set(String(r.student_group), [...(segsBy.get(String(r.student_group)) ?? []), r]);

  const porEscuchar: Plan['porEscuchar'] = [];
  const clases = new Set<string>();
  const alumnosPend = new Set<string>();
  const porAlumno: Array<{ g: string; pares: ListenPlannedPair[] }> = [];
  for (const [g, classes] of byStudent) {
    const elegidas = selectListenClasses(classes, c);
    if (!elegidas.length) continue;
    for (const x of elegidas) {
      clases.add(x.analysisId);
      if (!hecha.has(x.analysisId)) { porEscuchar.push({ g, analysisId: x.analysisId }); alumnosPend.add(g); }
    }
    // Lo ya escuchado de este alumno dentro de los filtros (también de otras clases).
    const segs: ListenPlanSegment[] = (segsBy.get(g) ?? []).filter(r => urls.has(String(r.analysis_id))).map(r => {
      const s = toListenSegment(r);
      const rec = recordingKey(urls.get(s.analysisId));
      return { ...s, moment: `${rec}#${Number(r.turn_index)}`, recording: rec };
    });
    const todas = listenPairs(segs, c, {
      blocked: s => ctx.vetos.momentos.has(s.moment) || tocaNoSirve(ctx, g, s.recording, s.hablaStart, s.hablaEnd),
      skipPair: o.soloNuevas ? (a, b) => ctx.verificadas.has(`${a.moment}|${b.moment}`) : undefined,
    });
    const pares = pickDiverse(todas, p => p.a.moment, p => p.b.moment, o.porAlumno, c.momento_max_parejas);
    if (pares.length) porAlumno.push({ g, pares });
  }
  porAlumno.sort((x, y) => compareListenPairs(y.pares[0], x.pares[0]));
  const items = porAlumno.flatMap(({ g, pares }) => pares.map(p => ({
    g, a: p.a.id, b: p.b.id, ma: p.a.moment, mb: p.b.moment, ra: p.a.recording, rb: p.b.recording,
  })));
  const conPareja = new Set(porAlumno.map(x => x.g));
  return {
    items, alumnos: new Set([...conPareja, ...alumnosPend]).size, clases: clases.size,
    porEscuchar, alumnosPorEscuchar: alumnosPend.size,
  };
}

/** El plan con esas opciones. `fresco` = sin la caché (al abrir o planificar una tanda). */
const planFor = (admin: SupabaseClient, c: VerifyConfig, o: AnalisisOpciones, ctx: Contexto, fresco: boolean) =>
  (o.fuente === 'texto' ? planTexto(admin, c, o, ctx, fresco) : planEscucha(admin, c, o, ctx, fresco));

// ── Contador en vivo ─────────────────────────────────────────────────────────

export interface Recuento {
  clases: number;
  porEscuchar: number;
  alumnos: number;
  parejas: number;
  /** true = con la escucha aún saldrán más parejas (las de las clases por escuchar). */
  parejasMinimo: boolean;
  /** Parejas que se verificarían con la cantidad elegida. */
  aVerificar: number;
  coste: { escucha: number; verificacion: number; total: number; porPareja: number };
}

/** Coste medio real por pareja (últimas verificaciones), o el de testimonial_config. */
async function costePorPareja(admin: SupabaseClient, c: VerifyConfig): Promise<number> {
  const { data } = await admin.from('testimonial_verifications').select('coste_deepgram_usd, coste_claude_usd')
    .eq('kind', 'busqueda').in('status', ['aprobado', 'descartado']).order('updated_at', { ascending: false }).limit(300);
  const rows = (data ?? []) as Row[];
  const conGasto = rows.filter(r => Number(r.coste_deepgram_usd ?? 0) + Number(r.coste_claude_usd ?? 0) > 0);
  if (conGasto.length < 20) return c.coste_pareja_estimado_usd;
  return rows.reduce((a, r) => a + Number(r.coste_deepgram_usd ?? 0) + Number(r.coste_claude_usd ?? 0), 0) / rows.length;
}

async function segundosPorClase(admin: SupabaseClient, c: VerifyConfig): Promise<number> {
  const { data } = await admin.from('testimonial_listen_classes').select('segundos').eq('status', 'escuchada').limit(500);
  const rows = (data ?? []) as Row[];
  return rows.length >= 10 ? rows.reduce((a, r) => a + Number(r.segundos ?? 0), 0) / rows.length : c.escucha_seg_por_clase_estimado;
}

function recuento(plan: Plan, o: AnalisisOpciones, porPareja: number, segClase: number, c: VerifyConfig): Recuento {
  // Con clases por escuchar: como mucho `porAlumno` parejas más por cada alumno pendiente.
  const posibles = plan.items.length + plan.alumnosPorEscuchar * o.porAlumno;
  const aVerificar = Math.min(o.cantidad ?? posibles, posibles);
  const escucha = plan.porEscuchar.length * (segClase / 60) * c.deepgram_usd_min_multi;
  const verificacion = aVerificar * porPareja;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    clases: plan.clases, porEscuchar: plan.porEscuchar.length, alumnos: plan.alumnos,
    parejas: plan.items.length, parejasMinimo: plan.porEscuchar.length > 0, aVerificar,
    coste: { escucha: r2(escucha), verificacion: r2(verificacion), total: r2(escucha + verificacion), porPareja: Math.round(porPareja * 1000) / 1000 },
  };
}

export async function contarAnalisis(admin: SupabaseClient, o: AnalisisOpciones): Promise<Recuento> {
  const { config: c } = await loadConfig(admin);
  const ctx = await contexto(admin);
  const [plan, porPareja, segClase] = await Promise.all([planFor(admin, c, o, ctx, false), costePorPareja(admin, c), segundosPorClase(admin, c)]);
  return recuento(plan, o, porPareja, segClase, c);
}

/** Alumnos y profes para el buscador del panel (solo los que tienen clases grabadas). */
export async function opcionesAnalisis(admin: SupabaseClient) {
  const [tts, teachers, students] = await Promise.all([
    paged(admin, 'testimonial_transcripts', 'student_group, student_name, teacher_id', 'analysis_id', q => q.eq('status', 'ready')),
    paged(admin, 'teachers', 'id, name, is_test', 'id'),
    paged(admin, 'students', 'id, name, is_test', 'id'),
  ]);
  const testS = new Set(students.filter(s => s.is_test).map(s => String(s.id)));
  const nombre = new Map(students.map(s => [String(s.id), String(s.name ?? '')]));
  const alumnos = new Map<string, string>(), profes = new Set<string>();
  for (const t of tts) {
    const g = String(t.student_group);
    if (!testS.has(g)) alumnos.set(g, nombre.get(g) || String(t.student_name ?? '') || g);
    if (t.teacher_id) profes.add(String(t.teacher_id));
  }
  return {
    alumnos: [...alumnos].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'es')),
    profes: teachers.filter(t => !t.is_test && profes.has(String(t.id))).map(t => ({ id: String(t.id), name: String(t.name ?? '') }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es')),
  };
}

// ── La tanda ─────────────────────────────────────────────────────────────────

const ITEMS = 'testimonial_batch_items';

async function insertItems(admin: SupabaseClient, rows: Row[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from(ITEMS).upsert(rows.slice(i, i + 500), { onConflict: 'batch_id,idx', ignoreDuplicates: true });
    if (error) throw new Error(`${ITEMS}: ${error.message}`);
  }
}

const pairRows = (batchId: string, items: PlanItem[], from: number) => items.map((p, i) => ({
  batch_id: batchId, idx: from + i, tipo: 'pareja', student_group: p.g, a: p.a, b: p.b, ma: p.ma, mb: p.mb, ra: p.ra, rb: p.rb, status: 'pendiente',
}));

/** Abre una tanda con las opciones del panel y deja guardadas todas sus filas. */
export async function iniciarAnalisis(admin: SupabaseClient, o: AnalisisOpciones): Promise<TandaEstado> {
  const { config: c } = await loadConfig(admin);
  const plan = await planFor(admin, c, o, await contexto(admin), true);
  const batchId = `tb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const fase = plan.porEscuchar.length ? 'escuchar' : 'verificar';
  const { error } = await admin.from('testimonial_verify_batches').insert({
    id: batchId, kind: 'busqueda', planned: plan.items.length, alumnos: plan.alumnos,
    fuente: o.fuente, filtros: o.filtros, objetivo: o.cantidad, por_alumno: o.porAlumno, solo_nuevas: o.soloNuevas, fase,
  });
  if (error) throw new Error(`testimonial_verify_batches: ${error.message}`);
  if (fase === 'escuchar') {
    await insertItems(admin, plan.porEscuchar.map((x, i) => ({ batch_id: batchId, idx: i, tipo: 'escuchar', student_group: x.g, a: x.analysisId, status: 'pendiente' })));
  } else {
    await insertItems(admin, pairRows(batchId, plan.items, 0));
  }
  return estadoTanda(admin, batchId);
}

export interface TandaEstado {
  batchId: string;
  fuente: Fuente;
  fase: 'escuchar' | 'verificar';
  objetivo: number | null;
  porAlumno: number;
  filtros: PlanFiltros;
  pausada: boolean;
  terminada: boolean;
  escuchar: { total: number; hechas: number; pendientes: number[] };
  parejas: {
    total: number; hechas: number; aprobadas: number; saltadas: number; errores: number;
    /** Por alumno, en orden, las filas que faltan (sin los alumnos que ya tienen una aprobada). */
    pendientes: Array<{ g: string; idx: number[] }>;
  };
  resumen: Awaited<ReturnType<typeof batchResumen>>;
}

/** Dónde va la tanda y qué falta: lo que pide "Reanudar". */
export async function estadoTanda(admin: SupabaseClient, batchId: string): Promise<TandaEstado> {
  const [{ data: b, error }, items, resumen] = await Promise.all([
    admin.from('testimonial_verify_batches').select('id, fuente, fase, objetivo, por_alumno, filtros, paused_at, finished_at').eq('id', batchId).maybeSingle(),
    paged(admin, ITEMS, 'idx, tipo, student_group, status, resultado', 'idx', q => q.eq('batch_id', batchId)),
    batchResumen(admin, batchId),
  ]);
  if (error) throw new Error(`testimonial_verify_batches: ${error.message}`);
  if (!b) throw new Error('No existe esa tanda.');
  const esc = items.filter(i => i.tipo === 'escuchar'), par = items.filter(i => i.tipo === 'pareja');
  const aprobados = new Set(par.filter(i => i.resultado === 'aprobado').map(i => String(i.student_group)));
  const pend = new Map<string, number[]>();
  for (const i of par) {
    if ((i.status !== 'pendiente' && i.status !== 'en_curso') || aprobados.has(String(i.student_group))) continue;
    const g = String(i.student_group);
    pend.set(g, [...(pend.get(g) ?? []), Number(i.idx)]);
  }
  return {
    batchId, fuente: b.fuente === 'texto' ? 'texto' : 'escucha', fase: b.fase === 'escuchar' ? 'escuchar' : 'verificar',
    objetivo: b.objetivo ?? null, porAlumno: Number(b.por_alumno ?? 10), filtros: (b.filtros ?? {}) as PlanFiltros,
    pausada: !!b.paused_at, terminada: !!b.finished_at,
    escuchar: {
      total: esc.length, hechas: esc.filter(i => i.status !== 'pendiente' && i.status !== 'en_curso').length,
      pendientes: esc.filter(i => i.status === 'pendiente' || i.status === 'en_curso').map(i => Number(i.idx)),
    },
    parejas: {
      total: par.length, hechas: par.filter(i => i.status === 'hecha').length, aprobadas: aprobados.size,
      saltadas: par.filter(i => i.status === 'saltada').length, errores: par.filter(i => i.status === 'error').length,
      pendientes: [...pend].map(([g, idx]) => ({ g, idx })),
    },
    resumen,
  };
}

async function setItem(admin: SupabaseClient, batchId: string, idx: number, patch: Row): Promise<void> {
  const { error } = await admin.from(ITEMS).update({ ...patch, updated_at: new Date().toISOString() }).eq('batch_id', batchId).eq('idx', idx);
  if (error) throw new Error(`${ITEMS}: ${error.message}`);
}

async function loadItem(admin: SupabaseClient, batchId: string, idx: number): Promise<Row> {
  const { data, error } = await admin.from(ITEMS).select('*').eq('batch_id', batchId).eq('idx', idx).maybeSingle();
  if (error) throw new Error(`${ITEMS}: ${error.message}`);
  if (!data) throw new Error('Esa fila de la tanda no existe.');
  return data as Row;
}

/** Escucha UNA clase de la tanda. Si ya se escuchó (otra tanda, un reintento), no se paga. */
export async function escucharItem(admin: SupabaseClient, batchId: string, idx: number): Promise<{ status: string; ya: boolean; result: ListenResult | null }> {
  const item = await loadItem(admin, batchId, idx);
  if (item.tipo !== 'escuchar') throw new Error('Esa fila no es una clase por escuchar.');
  if (item.status !== 'pendiente' && item.status !== 'en_curso') return { status: String(item.status), ya: true, result: null };
  const { data: prev } = await admin.from('testimonial_listen_classes').select('status').eq('analysis_id', item.a).maybeSingle();
  if (prev && LISTEN_DONE.includes(String(prev.status))) {
    await setItem(admin, batchId, idx, { status: 'hecha', resultado: prev.status });
    return { status: 'hecha', ya: true, result: null };
  }
  await setItem(admin, batchId, idx, { status: 'en_curso' });
  try {
    const result = await listenClass(admin, String(item.a));
    await setItem(admin, batchId, idx, { status: result.status === 'error' ? 'error' : 'hecha', resultado: result.status, detalle: result.detalle });
    return { status: result.status, ya: false, result };
  } catch (err) {
    await setItem(admin, batchId, idx, { status: 'error', detalle: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/**
 * Escucha terminada: con lo escuchado salen las parejas de la tanda (mismas
 * opciones con que se abrió). Si ya se hizo, no hace nada.
 */
export async function planificarTanda(admin: SupabaseClient, batchId: string): Promise<TandaEstado> {
  const { data: b } = await admin.from('testimonial_verify_batches').select('fuente, fase, filtros, objetivo, por_alumno, solo_nuevas').eq('id', batchId).maybeSingle();
  if (!b) throw new Error('No existe esa tanda.');
  if (b.fase === 'escuchar') {
    const { config: c } = await loadConfig(admin);
    const o: AnalisisOpciones = {
      filtros: (b.filtros ?? {}) as PlanFiltros, cantidad: b.objetivo ?? null, porAlumno: Number(b.por_alumno ?? 10),
      fuente: b.fuente === 'texto' ? 'texto' : 'escucha', soloNuevas: b.solo_nuevas !== false,
    };
    const plan = await planFor(admin, c, o, await contexto(admin), true);
    const { data: last } = await admin.from(ITEMS).select('idx').eq('batch_id', batchId).order('idx', { ascending: false }).limit(1);
    const from = Number(last?.[0]?.idx ?? -1) + 1;
    await insertItems(admin, pairRows(batchId, plan.items, from));
    await admin.from('testimonial_verify_batches').update({ fase: 'verificar', planned: plan.items.length, alumnos: plan.alumnos }).eq('id', batchId);
  }
  return estadoTanda(admin, batchId);
}

export interface ItemResultado {
  status: 'hecha' | 'saltada' | 'error';
  motivo: string | null;
  resultado: VerifyOutcome | null;
  /** La tanda llegó al número de parejas elegido. */
  fin: boolean;
}

/** Verifica UNA pareja de la tanda (una llamada al servidor). Nunca la repite. */
export async function verificarItem(admin: SupabaseClient, batchId: string, idx: number): Promise<ItemResultado> {
  const [{ data: b }, item] = await Promise.all([
    admin.from('testimonial_verify_batches').select('fuente, objetivo, finished_at').eq('id', batchId).maybeSingle(),
    loadItem(admin, batchId, idx),
  ]);
  if (!b) throw new Error('No existe esa tanda.');
  if (b.finished_at) return { status: 'saltada', motivo: 'tanda_cerrada', resultado: null, fin: true };
  if (item.tipo !== 'pareja') throw new Error('Esa fila no es una pareja.');
  if (item.status === 'hecha' || item.status === 'saltada' || item.status === 'error') {
    return { status: item.status, motivo: item.motivo ?? null, resultado: null, fin: false };
  }
  const { count: hechas } = await admin.from(ITEMS).select('idx', { count: 'exact', head: true }).eq('batch_id', batchId).eq('tipo', 'pareja').eq('status', 'hecha');
  if (b.objetivo != null && (hechas ?? 0) >= b.objetivo) return { status: 'saltada', motivo: 'objetivo', resultado: null, fin: true };

  const saltar = async (motivo: string): Promise<ItemResultado> => {
    await setItem(admin, batchId, idx, { status: 'saltada', motivo });
    return { status: 'saltada', motivo, resultado: null, fin: false };
  };
  const { count: aprobada } = await admin.from(ITEMS).select('idx', { count: 'exact', head: true })
    .eq('batch_id', batchId).eq('student_group', item.student_group).eq('resultado', 'aprobado');
  if (aprobada) return saltar('alumno_aprobado');
  const vetos = await loadVetos(admin);
  if (vetos.momentos.has(item.ma) || vetos.momentos.has(item.mb) || vetos.grabaciones.has(item.ra) || vetos.grabaciones.has(item.rb)) return saltar('vetado');

  await setItem(admin, batchId, idx, { status: 'en_curso' });
  let candId: string;
  try {
    candId = b.fuente === 'texto' ? await materializeTexto(admin, item) : await materializeEscucha(admin, item);
  } catch (err) {
    return saltar(err instanceof Error ? err.message.slice(0, 200) : String(err));
  }
  try {
    const r = await verifyCandidate(admin, candId, batchId, 'busqueda');
    await setItem(admin, batchId, idx, { status: r.status === 'error' ? 'error' : 'hecha', resultado: r.status, motivo: r.motivo, verification_id: r.id });
    const fin = b.objetivo != null && (hechas ?? 0) + 1 >= b.objetivo;
    return { status: r.status === 'error' ? 'error' : 'hecha', motivo: r.motivo, resultado: r, fin };
  } catch (err) {
    await setItem(admin, batchId, idx, { status: 'error', motivo: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    throw err;
  }
}

export async function pausarTanda(admin: SupabaseClient, batchId: string, pausada: boolean): Promise<void> {
  const { error } = await admin.from('testimonial_verify_batches').update({ paused_at: pausada ? new Date().toISOString() : null }).eq('id', batchId);
  if (error) throw new Error(error.message);
}

export async function cerrarTanda(admin: SupabaseClient, batchId: string, cancelada: boolean) {
  return closeBatch(admin, batchId, cancelada);
}

/** La última tanda de búsqueda sin cerrar (para "Reanudar"), o null. */
export async function tandaAbierta(admin: SupabaseClient): Promise<TandaEstado | null> {
  const { data } = await admin.from('testimonial_verify_batches').select('id').eq('kind', 'busqueda').is('finished_at', null)
    .not('fuente', 'is', null).order('started_at', { ascending: false }).limit(1);
  const id = data?.[0]?.id as string | undefined;
  return id ? estadoTanda(admin, id) : null;
}

// ── Crear la pareja a verificar ──────────────────────────────────────────────

/**
 * Solo una pareja abierta por alumno y profe (índice único): la que dejó el buscador
 * sin verificar deja sitio. Una aprobada por revisar, nunca.
 */
async function insertCandidate(admin: SupabaseClient, g: string, teacherId: string | null, cols: Row): Promise<string> {
  const { data: abiertas } = await admin.from('testimonial_candidates').select('id')
    .eq('student_group', g).eq('pair_teacher_id', teacherId).neq('status', 'descartado');
  const ids = ((abiertas ?? []) as Row[]).map(x => String(x.id));
  if (ids.length) {
    const { data: aprobadas } = await admin.from('testimonial_verifications').select('id')
      .in('candidate_id', ids).eq('status', 'aprobado').is('review', null).limit(1);
    if ((aprobadas ?? []).length) throw new Error('Este alumno ya tiene una pareja aprobada por revisar.');
    const { error: dErr } = await admin.from('testimonial_candidates').delete().in('id', ids).eq('status', 'detectado');
    if (dErr) throw new Error(`Dejando sitio a la pareja: ${dErr.message}`);
  }
  const id = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const { error } = await admin.from('testimonial_candidates').insert({ id, ...cols, status: 'detectado', status_changed_at: now, updated_at: now });
  if (error) throw new Error(`Creando la pareja: ${error.message}`);
  return id;
}

async function materializeTexto(admin: SupabaseClient, item: Row): Promise<string> {
  const [{ data: segs, error }, { data: txs }] = await Promise.all([
    admin.from('testimonial_segments').select(SEG_COLS).in('id', [item.a, item.b]),
    admin.from('testimonial_transcripts').select('student_name, status, segments_at, segment_stats').eq('student_group', item.student_group),
  ]);
  if (error) throw new Error(`testimonial_segments: ${error.message}`);
  const ra = ((segs ?? []) as Row[]).find(x => x.id === item.a), rb = ((segs ?? []) as Row[]).find(x => x.id === item.b);
  if (!ra || !rb) throw new Error('Los momentos de esta pareja ya no existen (se reprocesó el transcript).');
  const a = toSegment(ra), b = toSegment(rb);
  const avg = studentWpm((txs ?? []) as Row[]);
  const name = (((txs ?? []) as Row[]).find(t => t.student_name)?.student_name as string | undefined) ?? null;
  const cols = pairColumns({ a, b, aScore: blockingScore(a, avg), bScore: fluencyScore(b, avg), gapDays: daysBetween(a.classDay, b.classDay) }, name, avg);
  return insertCandidate(admin, String(item.student_group), a.teacherId, { ...cols, ai_reason: `${cols.ai_reason} Pareja del panel de análisis (texto de Fathom).` });
}

async function materializeEscucha(admin: SupabaseClient, item: Row): Promise<string> {
  const [{ data: segs, error }, { data: st }] = await Promise.all([
    admin.from('testimonial_listen_segments').select('id, analysis_id, teacher_id, class_day, start_s, dur_s, habla_start_s, habla_end_s, medidas, texto').in('id', [item.a, item.b]),
    admin.from('students').select('name').eq('id', item.student_group).maybeSingle(),
  ]);
  if (error) throw new Error(`testimonial_listen_segments: ${error.message}`);
  const ra = ((segs ?? []) as Row[]).find(x => x.id === item.a), rb = ((segs ?? []) as Row[]).find(x => x.id === item.b);
  if (!ra || !rb) throw new Error('Los tramos escuchados de esta pareja ya no existen.');
  const a = toListenSegment(ra), b = toListenSegment(rb);
  if (!a.medidas || !b.medidas || !a.teacherId) throw new Error('Tramo escuchado sin medidas.');
  const { data: tts } = await admin.from('testimonial_transcripts').select('analysis_id, fathom_url, student_label').in('analysis_id', [a.analysisId, b.analysisId]);
  const urls = new Map(((tts ?? []) as Row[]).map(t => [String(t.analysis_id), String(t.fathom_url ?? '')]));
  const labels = new Map(((tts ?? []) as Row[]).map(t => [String(t.analysis_id), String(t.student_label ?? '')]));
  const { config: c } = await loadConfig(admin);
  const cols = listenColumns({
    group: String(item.student_group), name: String(st?.name ?? ''), a, b, teacherId: a.teacherId,
    semanas: weeksBetween(a.classDay, b.classDay), score: contrastScore(a.medidas, b.medidas),
  }, urls, labels, c);
  return insertCandidate(admin, String(item.student_group), a.teacherId, cols);
}
