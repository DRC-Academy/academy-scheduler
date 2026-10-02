// Ensayo local del cron de rescate de la bienvenida: lista a quién se la
// enviaría y por qué descarta al resto. NO envía nada ni escribe en la base.
//
//   node --env-file=.env.local --import tsx scripts/rescate-bienvenidas.mts
//   ... --ahora 2026-10-01T15:00:00Z   ← como si corriera en ese instante
//
// El criterio vive en lib/welcomeRescue; el envío real lo hace la ruta
// /api/cron/rescate-bienvenidas cuando se active.

import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { scanWelcomeRescue } from '@/lib/welcomeRescue';

const args = process.argv.slice(2);
const i = args.indexOf('--ahora');
const now = i >= 0 ? new Date(args[i + 1]).getTime() : Date.now();
if (Number.isNaN(now)) { console.error('Fecha de --ahora inválida.'); process.exit(1); }

const admin = getSupabaseAdmin();
if (!admin) { console.error('Falta SUPABASE_SERVICE_ROLE_KEY.'); process.exit(1); }

const fmt = (iso: string) => new Date(iso).toISOString().slice(5, 16).replace('T', ' ');
const scan = await scanWelcomeRescue(admin, now);
console.log(`Corrida simulada: ${new Date(now).toISOString()}\n`);
console.log(`ENVIARÍA (${scan.candidates.length}):`);
for (const a of scan.candidates) console.log(`  ✉  ${a.student_name} · ${a.teacher_name} · alta ${fmt(a.created_at)} UTC · ${a.id}`);
console.log(`\nDESCARTA (${scan.excluded.length}):`);
for (const { a, reason } of scan.excluded) console.log(`  –  ${a.student_name} · ${a.teacher_name} · alta ${fmt(a.created_at)} UTC → ${reason}`);
