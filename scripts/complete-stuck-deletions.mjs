// Completa el borrado de los alumnos que quedaron A MEDIAS: tienen backup en
// deleted_students_backup pero siguen existiendo en `students` porque el DELETE
// reventaba con una foreign key en cadena (form_tokens.assignment_id primero,
// level_test_sessions.assignment_id detrás).
//
//   node scripts/complete-stuck-deletions.mjs           ← ENSAYO, no escribe nada
//   node scripts/complete-stuck-deletions.mjs --apply    ← borra de verdad
//   node scripts/complete-stuck-deletions.mjs --apply --solo "Dolores Cueto"
//
// Requiere la función delete_student_cascade (supabase-delete-student-cascade.sql).
// El backup NO se vuelve a guardar: estos alumnos ya lo tienen, y duplicarlo es
// justo lo que no queremos. El borrado va por RPC, o sea en una transacción: o
// se va la cadena entera o no se va nada.
//
// Además deduplica student_dropouts: cada intento fallido insertó otra fila de
// baja para el mismo alumno y profesor, y eso le hunde la retención al profesor
// (Virginia Alfonso Villal llegó a acumular 18 filas donde debía haber 3). Se
// conserva SIEMPRE la más antigua, que es la fecha real de la baja.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const SOLO = args.includes('--solo') ? args[args.indexOf('--solo') + 1] : null;

const env = Object.fromEntries(
  readFileSync(resolve(ROOT, '.env.local'), 'utf8')
    .split(/\r?\n/)
    .filter(l => l.includes('=') && !l.trimStart().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const URL_ = (env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
const KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!URL_ || !KEY) {
  console.error('Faltan NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY en .env.local');
  process.exit(1);
}

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
const enc = encodeURIComponent;

async function get(path) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, { headers: H });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}
async function del(path) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, { method: 'DELETE', headers: H });
  if (!res.ok) throw new Error(`DELETE ${path} → ${res.status}: ${await res.text()}`);
}
async function rpc(fn, body) {
  const res = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: H, body: JSON.stringify(body),
  });
  const txt = await res.text();
  if (!res.ok) {
    let msg = txt;
    try { const j = JSON.parse(txt); msg = j.message ?? j.hint ?? txt; } catch { /* texto plano */ }
    throw new Error(msg);
  }
  return JSON.parse(txt);
}

console.log(APPLY ? '=== APLICANDO (escribe en la base) ===' : '=== ENSAYO (no escribe nada) ===\n');

// ── 1. ¿Quiénes quedaron a medias? ──────────────────────────────────────────
const backups = await get('deleted_students_backup?select=id,original_student_id,student_name,restored&limit=500');
const vivos = await get('students?select=id,name,email&limit=2000');
const vivosById = new Map(vivos.map(s => [s.id, s]));

let aMedias = backups
  .filter(b => b.restored !== true && vivosById.has(b.original_student_id))
  .map(b => ({ ...vivosById.get(b.original_student_id), backup_id: b.id, backup_name: b.student_name }));

if (SOLO) aMedias = aMedias.filter(a => a.name.toLowerCase().includes(SOLO.toLowerCase()));

console.log(`Alumnos a medias (backup sin restaurar + siguen en students): ${aMedias.length}`);
for (const a of aMedias) console.log(`  · ${a.name} — ${a.id} — ${a.email ?? 'sin email'}`);
if (aMedias.length === 0) console.log('  (ninguno: nada que completar)');

// ── 2. Completar el borrado, uno por uno ────────────────────────────────────
const resultados = [];
for (const a of aMedias) {
  console.log(`\n── ${a.name} ──────────────────────────────────────────`);

  // SOLO la ficha que tiene backup. Las otras fichas con el mismo nombre NO se
  // tocan aunque parezcan duplicados: el backup no las contiene, y un homónimo
  // o una re-inscripción con otro plan es indistinguible de un alta duplicada
  // (Virginia Alfonso Villal tiene dos fichas con emails distintos). Se avisa y
  // decide el admin.
  const ids = [a.id];
  const homonimos = vivos.filter(s =>
    s.id !== a.id && s.name.trim().toLowerCase() === a.name.trim().toLowerCase());
  for (const h of homonimos) {
    console.log(`  ⚠ OTRA ficha con el mismo nombre, NO se toca: ${h.id} · ${h.email ?? 'sin email'}`);
  }

  try {
    const plan = await rpc('delete_student_cascade', {
      p_ids: ids, p_student_name: a.name, p_dry_run: true,
    });
    console.log(`  ensayo → assignments: ${plan.assignment_ids.length}` +
                ` · soltar: ${JSON.stringify(plan.cleared)}` +
                ` · borrar: ${JSON.stringify(plan.deleted)}`);
    console.log(`  se conservan (finanzas): ${JSON.stringify(plan.preserved)}`);
    if (plan.repaired.length) console.log(`  vínculos a reparar: ${JSON.stringify(plan.repaired)}`);

    if (!APPLY) { resultados.push({ name: a.name, estado: 'ensayo ok' }); continue; }

    const real = await rpc('delete_student_cascade', {
      p_ids: ids, p_student_name: a.name, p_dry_run: false,
    });
    console.log(`  ✅ BORRADO → ${JSON.stringify(real.deleted)}`);
    resultados.push({ name: a.name, estado: 'borrado', deleted: real.deleted, preserved: real.preserved });
  } catch (e) {
    console.error(`  ❌ ${e.message}`);
    resultados.push({ name: a.name, estado: 'ERROR', error: e.message });
  }
}

// ── 3. Deduplicar student_dropouts ──────────────────────────────────────────
// Solo de los alumnos que estamos borrando. Otros alumnos con bajas duplicadas
// se listan como aviso pero NO se tocan: si el alumno sigue ACTIVO, sus filas de
// baja son un problema distinto (no un reintento) y lo decide el admin.
console.log('\n=== BAJAS DUPLICADAS (student_dropouts) ===');
const enAlcance = new Set(aMedias.map(a => a.id));
const drops = await get('student_dropouts?select=id,student_id,student_name,teacher_id,dropped_at&limit=2000');
const grupos = new Map();
for (const d of drops) {
  if (!d.student_id) continue;                       // sin id no se puede agrupar con certeza
  const k = `${d.student_id}|${d.teacher_id}`;
  if (!grupos.has(k)) grupos.set(k, []);
  grupos.get(k).push(d);
}

const sobran = [];
const fueraDeAlcance = [];
for (const [clave, filas] of grupos) {
  if (filas.length < 2) continue;
  // La más antigua es la fecha real de la baja; las demás son reintentos.
  filas.sort((x, y) => String(x.dropped_at ?? '').localeCompare(String(y.dropped_at ?? '')));
  const [queda, ...resto] = filas;
  const dentro = enAlcance.has(clave.split('|')[0]);
  console.log(`  ${dentro ? '·' : '⚠'} ${queda.student_name} · ${queda.teacher_id}: ${filas.length} filas → ` +
              `se conserva ${queda.dropped_at?.slice(0, 16)}, sobran ${resto.length}` +
              (dentro ? '' : '  (FUERA DE ALCANCE: no se toca)'));
  if (dentro) sobran.push(...resto); else fueraDeAlcance.push(...resto);
}
console.log(`Filas sobrantes a limpiar: ${sobran.length}` +
            (fueraDeAlcance.length ? ` · sin tocar (otros alumnos): ${fueraDeAlcance.length}` : ''));

if (sobran.length > 0) {
  if (!APPLY) {
    console.log('(ensayo: no se borra ninguna)');
  } else {
    for (let i = 0; i < sobran.length; i += 50) {
      const lote = sobran.slice(i, i + 50).map(r => enc(r.id));
      await del(`student_dropouts?id=in.(${lote.join(',')})`);
    }
    console.log(`✅ ${sobran.length} fila(s) de baja duplicadas eliminadas.`);
  }
}

// ── 4. Verificación final ───────────────────────────────────────────────────
if (APPLY) {
  console.log('\n=== VERIFICACIÓN ===');
  for (const a of aMedias) {
    const sigue = await get(`students?select=id&id=eq.${enc(a.id)}`);
    const asg = await get(`assignments?select=id&student_id=eq.${enc(a.id)}`);
    const rec = await get(`class_records?select=id&student_name=ilike.${enc('*' + a.name + '*')}`);
    const logs = await get(`class_join_logs?select=id&student_name=ilike.${enc('*' + a.name + '*')}`);
    const bak = await get(`deleted_students_backup?select=id&original_student_id=eq.${enc(a.id)}`);
    console.log(`  ${a.name}: en students=${sigue.length} (debe ser 0) · assignments=${asg.length} (0) · ` +
                `class_records=${rec.length} (intactos) · class_join_logs=${logs.length} (intactos) · backups=${bak.length} (1)`);
  }
}

console.log('\n=== RESUMEN ===');
console.table(resultados);
