// PILOTO de testimoniales (no se sube a git). Mismas funciones que el panel, alumno a alumno,
// con tope de gasto. Las reglas son las de testimonial_config.
//
//   Elegir (sin gastar):   node --env-file=.env.local --conditions=react-server --import tsx scripts/_piloto-testimonios.mts --simular
//   Lanzar (gasta):        ... scripts/_piloto-testimonios.mts --lanzar --tope 5
//
// Necesita DEEPGRAM_API_KEY y ANTHROPIC_API_KEY en .env.local para --lanzar.
import { createClient } from '@supabase/supabase-js';
import { loadConfig } from '@/lib/testimonialConfigStore';
import {
  cleanOpciones, contarAnalisis, simularPlanEscucha, iniciarAnalisis, estadoTanda, escucharItem, planificarTanda, verificarItem, cerrarTanda,
} from '@/lib/testimonialAnalysis';
import { cleanFilters } from '@/lib/testimonialPairPlan';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const TOPE = Number(arg('--tope') ?? 5);
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const log = (m: string) => console.log(`[${new Date().toLocaleTimeString('es-ES')}] ${m}`);
const { config: c } = await loadConfig(admin);
const opcionesDe = (alumno: string) => cleanOpciones({ cantidad: null, fuente: 'escucha', soloNuevas: false }, cleanFilters({ alumno }));

// 1. Candidatos: alumnos que YA tienen parejas con lo escuchado (reglas nuevas), de mejor a peor.
const todo = await simularPlanEscucha(admin, c, cleanOpciones({ cantidad: null, fuente: 'escucha', soloNuevas: false }, cleanFilters({})));
const orden: string[] = [];
const parejas = new Map<string, number>();
for (const i of todo.items) { if (!parejas.has(i.g)) orden.push(i.g); parejas.set(i.g, (parejas.get(i.g) ?? 0) + 1); }
const { data: st } = await admin.from('students').select('id, name').in('id', orden);
const nombre = new Map((st ?? []).map(s => [String(s.id), String(s.name)]));

// 2. Coste por alumno (escuchar lo que le falta + verificar sus parejas, como mucho).
const elegidos: Array<{ g: string; name: string; porEscuchar: number; parejas: number; coste: number }> = [];
let acumulado = 0;
for (const g of orden) {
  const r = await contarAnalisis(admin, opcionesDe(g));
  const coste = r.coste.escucha + Math.min(parejas.get(g)!, 4) * 0.04;   // se para al primer aprobado: ~4 parejas como mucho de media
  const x = { g, name: nombre.get(g) ?? g, porEscuchar: r.porEscuchar, parejas: parejas.get(g)!, coste: Math.round(coste * 100) / 100 };
  if (acumulado + x.coste > TOPE) continue;
  acumulado += x.coste; elegidos.push(x);
}
console.table(elegidos);
log(`${elegidos.length} alumnos, coste estimado ≈ ${acumulado.toFixed(2)} $ (tope ${TOPE} $).`);
if (!process.argv.includes('--lanzar')) process.exit(0);

for (const k of ['DEEPGRAM_API_KEY', 'ANTHROPIC_API_KEY']) if (!process.env[k]?.trim()) { console.error(`Falta ${k} en .env.local. No se ha gastado nada.`); process.exit(1); }

// 3. Una tanda por alumno: escuchar lo que falte, planificar y verificar hasta el primer aprobado.
let gastado = 0;
const resultados: Array<{ alumno: string; escuchadas: number; verificadas: number; aprobado: string; motivos: string }> = [];
for (const e of elegidos) {
  if (gastado >= TOPE) { log(`Tope de ${TOPE} $ alcanzado.`); break; }
  const t0 = await iniciarAnalisis(admin, opcionesDe(e.g));
  let t = t0;
  let escuchadas = 0;
  for (const i of t.escuchar.pendientes) {
    if (gastado >= TOPE) break;
    try { const r = await escucharItem(admin, t.batchId, i); gastado += r.result?.usd ?? 0; escuchadas++; } catch (err) { log(`  error escuchando: ${err instanceof Error ? err.message : err}`); }
  }
  t = await planificarTanda(admin, t.batchId);
  const motivos: string[] = [];
  let verificadas = 0, aprobado = '';
  for (const al of t.parejas.pendientes) for (const i of al.idx) {
    if (aprobado || gastado >= TOPE) break;
    try {
      const r = await verificarItem(admin, t.batchId, i);
      if (r.resultado) { verificadas++; gastado += r.resultado.coste; motivos.push(r.resultado.status === 'aprobado' ? `APROBADO (nota ${r.resultado.nota})` : `${r.resultado.motivo}`); }
      if (r.resultado?.status === 'aprobado') aprobado = `sí, nota ${r.resultado.nota}`;
    } catch (err) { log(`  error verificando: ${err instanceof Error ? err.message : err}`); }
  }
  await cerrarTanda(admin, t.batchId, false);
  resultados.push({ alumno: e.name, escuchadas, verificadas, aprobado: aprobado || 'no', motivos: motivos.join(', ') });
  log(`${e.name}: ${escuchadas} clases escuchadas, ${verificadas} verificadas → ${aprobado || 'ninguno'} · gastado ${gastado.toFixed(2)} $`);
}
console.table(resultados);
log(`FIN · gastado ≈ ${gastado.toFixed(2)} $`);
