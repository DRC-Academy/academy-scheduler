// Testimoniales — análisis de fluidez del alumno a mano: prueba, relleno de lo
// antiguo y reintento de los fallidos.
//
//   npm run fluidez -- --id <id de class_analyses>             prueba UNA clase, NO guarda
//   npm run fluidez -- --id <id> --apply                       la analiza y guarda
//   npm run fluidez -- --registrar                             cuántas clases no tienen fila
//   npm run fluidez -- --registrar --apply                     les crea la fila 'pending' (sin IA)
//   npm run fluidez -- --procesar 50                           qué 50 pendientes/fallidas haría
//   npm run fluidez -- --procesar 50 --apply                   las analiza y guarda (~1 cént. c/u)
//
// Desde la V5 de testimoniales (07/10/2026) la nota de fluidez ya no corre sola al
// subir un transcript ni alimenta los testimoniales (ver `npm run testimonios`).
//
// Requiere ANTHROPIC_API_KEY en .env.local para todo lo que llama a la IA. El
// `--conditions=react-server` del npm script no es decorativo: lib/anthropic
// importa 'server-only', que fuera de esa condición lanza al importarse.

import { readFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

for (const line of existsSync('.env.local') ? readFileSync('.env.local', 'utf8').split('\n') : []) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}

const { supabase } = await import('@/lib/supabase');
const { runFluencyFor, resolveStudentKey } = await import('@/lib/fluencyStore');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const valueOf = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };

/** Máximo de intentos de IA por clase en --procesar: lo que falla 3 veces se mira a mano. */
const MAX_ATTEMPTS = 3;
const PARALLEL = 3;

async function allRows<T>(table: string, cols: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(cols).order(table === 'class_analyses' ? 'id' : 'analysis_id').range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data as T[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

function noKey(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return false;
  console.error('Falta ANTHROPIC_API_KEY en .env.local: sin ella la IA no se llama.');
  return true;
}

// ── --id: una clase ──────────────────────────────────────────────────────────
async function una(id: string) {
  if (noKey()) process.exitCode = 1;
  const r = await runFluencyFor(id, { dryRun: !APPLY });
  const p = r.prep;
  console.log(`\nClase ${id}: ${r.status}${r.error ? ` (${r.error})` : ''}`);
  if (p) {
    console.log(`  Hablantes (${p.speakers.length}): ${p.speakers.join(' | ')}`);
    console.log(`  Profe: ${p.teacherSpeaker ?? '(sin identificar)'}   Alumno: ${p.studentSpeaker ?? '(sin identificar)'}`);
    console.log(`  Palabras: ${p.wordCount}   % del alumno según Fathom: ${p.labelShare ?? '-'}`);
    console.log(`  Grabación: ${p.fathomUrl ?? '(sin enlace)'}`);
    if (p.skip) console.log(`  DESCARTADO: ${p.skip}`);
  }
  if (r.row && r.status === 'ready') {
    const w = r.row;
    console.log(`  Agrupación del alumno: ${w.student_key}`);
    console.log(`  Fluidez: ${w.fluency_score ?? `no evaluable (${w.unscorable_reason})`}`);
    console.log(`  Habla el alumno: ${w.student_talk_share}%   Dudas: ${w.hesitation_level}   Español: ${w.spanish_usage}`);
    console.log(`  Por qué: ${w.fluency_evidence}`);
    console.log(`  Mejor  [${w.best_excerpt_at}] ${w.best_excerpt_found ? '✓' : '✗ NO ENCONTRADA'} "${w.best_excerpt}"`);
    console.log(`  Peor   [${w.worst_excerpt_at}] ${w.worst_excerpt_found ? '✓' : '✗ NO ENCONTRADA'} "${w.worst_excerpt}"`);
  }
  console.log(APPLY ? '\nGuardado.' : '\nModo prueba: no se guardó nada (añade --apply para guardar).');
}

// ── --registrar: crea las filas que faltan (sin IA, sin leer transcripts) ────
async function registrar() {
  const clases = await allRows<{ id: string; student_id: string | null; student_name: string | null }>(
    'class_analyses', 'id, student_id, student_name');
  const hechas = new Set((await allRows<{ analysis_id: string }>('transcript_fluency', 'analysis_id')).map(r => r.analysis_id));
  const faltan = clases.filter(c => !hechas.has(c.id));
  console.log(`Clases: ${clases.length}. Con fila: ${hechas.size}. Sin fila: ${faltan.length}.`);
  if (!APPLY || faltan.length === 0) {
    if (!APPLY) console.log('Modo prueba: no se creó nada (añade --apply).');
    return;
  }
  const filas = [];
  for (const c of faltan) {
    filas.push({ analysis_id: c.id, student_key: await resolveStudentKey(c.student_id, c.student_name), status: 'pending' });
  }
  for (let i = 0; i < filas.length; i += 500) {
    const { error } = await supabase.from('transcript_fluency').upsert(filas.slice(i, i + 500), { onConflict: 'analysis_id', ignoreDuplicates: true });
    if (error) throw new Error(`Insertando filas: ${error.message}`);
  }
  console.log(`Creadas ${filas.length} filas 'pending'. Siguiente paso: --procesar 50 --apply`);
}

// ── --procesar N: pendientes y fallidas, en tandas ──────────────────────────
async function procesar(n: number) {
  const { data, error } = await supabase
    .from('transcript_fluency')
    .select('analysis_id, status, attempts')
    .in('status', ['pending', 'failed'])
    .lt('attempts', MAX_ATTEMPTS)
    .order('status', { ascending: false })   // 'pending' antes que 'failed'
    .limit(n);
  if (error) throw new Error(error.message);
  const cola = data ?? [];
  console.log(`A procesar: ${cola.length} (${cola.filter(r => r.status === 'failed').length} reintentos).`);
  if (!APPLY) { console.log('Modo prueba: no se llamó a la IA (añade --apply).'); return; }
  if (noKey()) { process.exitCode = 1; return; }

  const cuenta: Record<string, number> = {};
  for (let i = 0; i < cola.length; i += PARALLEL) {
    const tanda = cola.slice(i, i + PARALLEL);
    const res = await Promise.all(tanda.map(r => runFluencyFor(r.analysis_id)));
    for (const r of res) {
      cuenta[r.status] = (cuenta[r.status] ?? 0) + 1;
      const det = r.status === 'skipped' ? r.row?.skip_reason
                : r.status === 'ready'   ? `nota ${r.row?.fluency_score ?? 'no evaluable'}`
                : r.error;
      console.log(`  ${r.analysisId}: ${r.status}${det ? ` (${det})` : ''}`);
    }
    await sleep(500);
  }
  console.log('Resumen:', cuenta);
}

const id = valueOf('--id');
const n = Number(valueOf('--procesar'));
if (id) await una(id);
else if (args.includes('--registrar')) await registrar();
else if (args.includes('--procesar') && n > 0) await procesar(n);
else console.log('Uso: --id <id> | --registrar | --procesar <N>   (+ --apply para guardar)');
