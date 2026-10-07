// Testimoniales V5 a mano: quién es el alumno en cada transcript, momentos con IA
// y parejas. Lo mismo que hace la pestaña del admin, sin el límite de 60 s.
//
//   npm run testimonios -- --estado                    contadores
//   npm run testimonios -- --etiquetas                 válidos y excluidos por motivo (sin IA, no escribe)
//   npm run testimonios -- --id <id de class_analyses>  momentos de UNA clase, NO guarda
//   npm run testimonios -- --id <id> --apply            los guarda y rehace las parejas del alumno
//   npm run testimonios -- --procesar 100 --apply       analiza 100 pendientes (~1 cént. c/u)
//   npm run testimonios -- --procesar 100 --apply --fallidas   reintenta fallidos
//   npm run testimonios -- --emparejar                  rehace todas las parejas (sin IA)
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

if (args.includes('--estado')) console.log(await momentsStatus());
else if (args.includes('--etiquetas')) await etiquetas();
else if (valueOf('--id')) await una(valueOf('--id')!);
else if (args.includes('--procesar')) await procesar(Number(valueOf('--procesar')) || 50);
else if (args.includes('--emparejar')) console.log(await syncPairs());
else console.log('Uso: --estado | --etiquetas | --id <id> [--apply] | --procesar <N> --apply [--fallidas] | --emparejar');
