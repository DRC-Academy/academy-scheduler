// Tanda de testimonios desde local: lo MISMO que el botón "Analizar" de la
// pestaña Testimoniales (mismas funciones de lib/testimonialAnalysis, misma base),
// sin depender de una pestaña abierta ni del límite de tiempo de Vercel.
//
//   node --env-file=.env.local --conditions=react-server --import tsx scripts/_tanda-testimonios.mts [--cantidad 200] [--reanudar <batchId>]
//
// Necesita DEEPGRAM_API_KEY y ANTHROPIC_API_KEY en .env.local.
// Pausar: crear el archivo indicado en PARAR (o Ctrl+C); se reanuda con --reanudar.

import { existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { cleanOpciones, iniciarAnalisis, estadoTanda, escucharItem, planificarTanda, verificarItem, pausarTanda, cerrarTanda } from '@/lib/testimonialAnalysis';
import { cleanFilters } from '@/lib/testimonialPairPlan';
import { motivosFrase } from '@/lib/testimonialMeasures';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const PARAR = process.env.TANDA_PARAR ?? 'PARAR-TANDA';
const PARALELO = 3;

for (const k of ['DEEPGRAM_API_KEY', 'ANTHROPIC_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!process.env[k]?.trim()) { console.error(`Falta ${k} en .env.local. No se ha gastado nada.`); process.exit(1); }
}
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const hora = () => new Date().toLocaleTimeString('es-ES');
const log = (m: string) => console.log(`[${hora()}] ${m}`);
let pausar = false;
process.on('SIGINT', () => { log('Ctrl+C: pausando (acaban las que están en curso)…'); pausar = true; });
const debePausar = () => pausar || existsSync(PARAR);

let seguidos = 0;
const fallo = (e: unknown) => {
  log(`ERROR: ${e instanceof Error ? e.message : e}`);
  if (++seguidos >= 3) { log('3 fallos seguidos: se para la tanda (queda en pausa).'); pausar = true; }
};

let batchId = arg('--reanudar');
if (!batchId) {
  const cantidad = arg('--cantidad') === 'todas' ? null : Number(arg('--cantidad') ?? 200);
  const o = cleanOpciones({ cantidad, fuente: 'escucha', soloNuevas: true }, cleanFilters({}));
  const t = await iniciarAnalisis(admin, o);
  batchId = t.batchId;
  log(`Tanda nueva ${batchId}: escucha, ${cantidad ?? 'todas'} testimonios, sin filtros, solo lo nunca analizado.`);
} else {
  await pausarTanda(admin, batchId, false);
  log(`Reanudando ${batchId}.`);
}

let t = await estadoTanda(admin, batchId);
if (t.fase === 'escuchar') {
  const cola = [...t.escuchar.pendientes];
  let hechas = t.escuchar.hechas;
  log(`Escuchando ${cola.length} clases (${hechas} ya hechas de ${t.escuchar.total})…`);
  const trabajador = async () => {
    for (let i = cola.shift(); i != null; i = cola.shift()) {
      if (debePausar()) return;
      try { await escucharItem(admin, batchId!, i); seguidos = 0; } catch (e) { fallo(e); }
      hechas++;
      if (hechas % 10 === 0 || hechas === t.escuchar.total) log(`Escuchadas ${hechas} de ${t.escuchar.total}`);
    }
  };
  await Promise.all(Array.from({ length: PARALELO }, trabajador));
  if (debePausar()) { await pausarTanda(admin, batchId, true); log(`En pausa. Reanudar con: --reanudar ${batchId}`); process.exit(0); }
  t = await planificarTanda(admin, batchId);
  log(`Escucha terminada: ${t.parejas.total} testimonios posibles para ${t.parejas.pendientes.length} alumnos.`);
}

// Verificación: cada trabajador coge un alumno y prueba sus combinaciones en orden hasta su tope de testimonios.
const objetivo = t.objetivo;
const alumnos = [...t.parejas.pendientes];
let hechas = t.parejas.hechas, aprobadas = t.parejas.aprobadas, enCurso = 0, fin = false;
log(`Verificando: objetivo ${objetivo ?? 'todos'}, ${alumnos.length} alumnos en cola.`);
const trabajador = async () => {
  for (let al = alumnos.shift(); al; al = alumnos.shift()) {
    for (const i of al.idx) {
      if (fin || debePausar()) return;
      if (objetivo != null && hechas + enCurso >= objetivo) { fin = true; return; }
      enCurso++;
      let otro = false;
      try {
        const r = await verificarItem(admin, batchId!, i);
        if (r.status === 'hecha') hechas++;
        if (r.resultado?.status === 'aprobado') { aprobadas++; log(`✓ APROBADO (${aprobadas}) · alumno ${al.g}`); }
        otro = r.motivo === 'alumno_aprobado';
        if (r.fin) fin = true;
        seguidos = 0;
      } catch (e) { fallo(e); }
      enCurso--;
      if (hechas % 10 === 0) log(`Verificados ${hechas}${objetivo ? ` de ${objetivo}` : ''} · ${aprobadas} aprobados`);
      if (otro) break;
    }
  }
};
await Promise.all(Array.from({ length: PARALELO }, trabajador));
if (debePausar() && !fin && alumnos.length) { await pausarTanda(admin, batchId, true); log(`En pausa. Reanudar con: --reanudar ${batchId}`); process.exit(0); }

const res = await cerrarTanda(admin, batchId, false);
log(`TERMINADA ${batchId}: ${res.aprobados} aprobados de ${res.revisados} verificados`
  + `${Object.keys(res.porMotivo).length ? ` · descartes: ${motivosFrase(res.porMotivo)}` : ''}`
  + ` · gasto estimado ${(res.costeDeepgram + res.costeClaude).toFixed(2)} $ (Deepgram ${res.costeDeepgram.toFixed(2)} + Claude ${res.costeClaude.toFixed(2)}).`);
