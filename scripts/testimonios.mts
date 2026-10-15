// Testimoniales a mano. Lo mismo que hace la pestaña del admin, sin el límite de 60 s.
//
// V6 (15/10/2026, SIN IA, lo que usa la pestaña):
//   npm run testimonios -- --v6-estado                 contadores
//   npm run testimonios -- --v6-procesar --apply       recortes de TODOS los pendientes, por tandas,
//                                                       y al final rehace todas las parejas
//   npm run testimonios -- --emparejar                  rehace todas las parejas (regla V6)
//   npm run testimonios -- --auditoria                  alumnos por resultado y motivo
//
// V5 (momentos con IA, ya no lo usa la pestaña; sus parejas se rehacen con la regla V6):
//   npm run testimonios -- --estado                    contadores
//   npm run testimonios -- --etiquetas                 válidos y excluidos por motivo (sin IA, no escribe)
//   npm run testimonios -- --id <id de class_analyses>  momentos de UNA clase, NO guarda
//   npm run testimonios -- --id <id> --apply            los guarda y rehace las parejas del alumno
//   npm run testimonios -- --procesar 100 --apply       analiza 100 pendientes (~1 cént. c/u)
//   npm run testimonios -- --procesar 100 --apply --fallidas   reintenta fallidos
//   npm run testimonios -- --emparejar                  rehace todas las parejas (sin IA)
//   npm run testimonios -- --reutilizar [--apply] [--rehacer]  momentos SIN IA a partir de las citas del
//                                                       análisis de fluidez anterior (transcript_fluency);
//                                                       lo que no tenga nada aprovechable queda pendiente;
//                                                       --rehacer vuelve a pasar lo ya reutilizado y lo excluido
//                                                       (tras cambiar una regla)
//
// Requiere ANTHROPIC_API_KEY en .env.local para todo lo que llama a la IA. El
// `--conditions=react-server` del npm script no es decorativo: lib/anthropic
// importa 'server-only', que fuera de esa condición lanza al importarse.

import { readFileSync, existsSync } from 'node:fs';

for (const line of existsSync('.env.local') ? readFileSync('.env.local', 'utf8').split('\n') : []) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}

const { supabase } = await import('@/lib/supabase');
const { parseTurns } = await import('@/lib/fluency');
const { resolveStudentLabel, EXCLUSION_LABEL } = await import('@/lib/testimonialSpeaker');
const { runMomentsFor, runMomentsBatch, momentsStatus, ensureMomentRows, syncPairs } = await import('@/lib/testimonialMomentsStore');
const V6 = await import('@/lib/testimonialSegmentsStore');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const valueOf = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };

function noKey(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return false;
  console.error('Falta ANTHROPIC_API_KEY en .env.local: sin ella la IA no se llama.');
  return true;
}

async function etiquetas() {
  const ids: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('class_analyses').select('id').eq('has_transcript', true).order('id').range(from, from + 999);
    if (error) throw new Error(error.message);
    ids.push(...(data ?? []).map(r => String(r.id)));
    if ((data ?? []).length < 1000) break;
  }
  const cuenta: Record<string, number> = {};
  let i = 0;
  for (const id of ids) {
    const { data: ca } = await supabase.from('class_analyses').select('transcript, student_name').eq('id', id).maybeSingle();
    const r = resolveStudentLabel(parseTurns(String(ca?.transcript ?? '')), (ca?.student_name as string | null) ?? null);
    const k = r.ok ? 'válido' : EXCLUSION_LABEL[r.reason];
    cuenta[k] = (cuenta[k] ?? 0) + 1;
    if (++i % 250 === 0) console.log(`  ${i} de ${ids.length}…`);
  }
  console.log(`Transcripts: ${ids.length}`);
  for (const [k, n] of Object.entries(cuenta).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
}

async function una(id: string) {
  if (noKey()) { process.exitCode = 1; return; }
  const r = await runMomentsFor(id, { dryRun: !APPLY });
  console.log(`${id}: ${r.status}${r.reason ? ` (${EXCLUSION_LABEL[r.reason]})` : ''}${r.error ? `: ${r.error}` : ''}`);
  for (const m of r.moments ?? []) console.log(`  ${m.kind} ${m.score}/10 [${m.start}–${m.end} s] "${m.excerpt}" · ${m.why}`);
  for (const x of r.rejected ?? []) console.log(`  rechazada: ${x}`);
  if (!APPLY) console.log('Modo prueba: no se guardó nada (añade --apply).');
}

async function procesar(n: number) {
  if (!APPLY) { console.log('Añade --apply para analizar y guardar.'); return; }
  if (noKey()) { process.exitCode = 1; return; }
  await ensureMomentRows();
  let hechos = 0;
  while (hechos < n) {
    const r = await runMomentsBatch({ deadline: Date.now() + 55_000, retryFailed: args.includes('--fallidas') });
    if (!r.claimed) break;
    hechos += r.claimed;
    console.log(`  +${r.claimed} ${JSON.stringify(r.outcomes)} · quedan ${r.status.pending} · parejas ${r.status.pairs}`);
  }
}

async function reutilizar() {
  if (APPLY && args.includes('--rehacer')) {
    const { REUSED_MODEL } = await import('@/lib/testimonialMomentsStore');
    for (const f of [(q: any) => q.eq('status', 'ready').eq('model', REUSED_MODEL), (q: any) => q.eq('status', 'excluded')]) {   // eslint-disable-line @typescript-eslint/no-explicit-any
      const { error } = await f(supabase.from('testimonial_transcripts').update({ status: 'pending', updated_at: '2000-01-01T00:00:00Z' }));
      if (error) throw new Error(error.message);
    }
  }
  const ids: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('testimonial_transcripts').select('analysis_id').eq('status', 'pending').order('analysis_id').range(from, from + 999);
    if (error) throw new Error(error.message);
    ids.push(...(data ?? []).map(r => String(r.analysis_id)));
    if ((data ?? []).length < 1000) break;
  }
  const cuenta: Record<string, number> = {};
  const add = (k: string) => { cuenta[k] = (cuenta[k] ?? 0) + 1; };
  let i = 0;
  const cola = [...ids];
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (let id = cola.shift(); id; id = cola.shift()) {
      const r = await runMomentsFor(id, { reuseOnly: true, skipPairs: true, dryRun: !APPLY });
      if (r.status === 'excluded') add(`excluido: ${EXCLUSION_LABEL[r.reason!]}`);
      else if (r.status === 'pending') add('sin cita aprovechable → queda para la IA');
      else if (r.status === 'ready') {
        const kinds = new Set((r.moments ?? []).map(m => m.kind));
        add(kinds.size === 2 ? 'reutilizado: malo + bueno' : `reutilizado: solo ${[...kinds][0]}`);
      } else add(r.status);
      if (++i % 250 === 0) console.log(`  ${i} de ${ids.length}…`);
    }
  }));
  console.log(`Pendientes revisados: ${ids.length}`);
  for (const [k, n] of Object.entries(cuenta).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
  if (APPLY) console.log('Parejas:', await syncPairs(), await momentsStatus());
  else console.log('Modo prueba: no se guardó nada (añade --apply).');
}

/** V6: todos los pendientes por tandas (las mismas que la pestaña) y luego todas las parejas. */
async function v6Procesar() {
  if (!APPLY) { console.log('Escribe en la base: añade --apply.'); return; }
  console.log('Filas nuevas:', await V6.ensureTranscriptRows());
  const total: Record<string, number> = {};
  for (;;) {
    const r = await V6.runSegmentsBatch({ deadline: Date.now() + 55_000 });
    for (const [k, n] of Object.entries(r.outcomes)) total[k] = (total[k] ?? 0) + (n ?? 0);
    console.log(`  tanda de ${r.claimed} · quedan ${r.status.pending} · parejas ${r.status.pairs}`);
    if (!r.claimed) break;
  }
  console.log('Transcripts:', total);
  const s = await V6.syncSegmentPairs();
  console.log('Parejas:', { creadas: s.created, cambiadas: s.updated, borradas: s.deleted });
  console.log('Alumnos:', s.outcomes, '· sin pareja por motivo:', s.reasons);
  console.log(await V6.segmentsStatus());
}

async function auditoria() {
  const { data, error } = await supabase.from('testimonial_audit').select('outcome, reason');
  if (error) throw new Error(error.message);
  const c: Record<string, number> = {};
  for (const r of data ?? []) { const k = r.reason ? `${r.outcome}: ${r.reason}` : r.outcome; c[k] = (c[k] ?? 0) + 1; }
  console.log(c);
}

if (args.includes('--v6-estado')) console.log(await V6.segmentsStatus());
else if (args.includes('--v6-procesar')) await v6Procesar();
else if (args.includes('--auditoria')) await auditoria();
else if (args.includes('--estado')) console.log(await momentsStatus());
else if (args.includes('--etiquetas')) await etiquetas();
else if (valueOf('--id')) await una(valueOf('--id')!);
else if (args.includes('--procesar')) await procesar(Number(valueOf('--procesar')) || 50);
else if (args.includes('--reutilizar')) await reutilizar();
else if (args.includes('--emparejar')) console.log(await syncPairs());
else console.log('Uso: --v6-estado | --v6-procesar --apply | --auditoria | --estado | --etiquetas | --id <id> [--apply] | --procesar <N> --apply [--fallidas] | --emparejar | --reutilizar [--apply]');
