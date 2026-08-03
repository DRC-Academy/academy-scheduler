// Diagnóstico del alumno que quedó a medias en el borrado (por defecto, "Diego
// Ruiz"). SOLO LEE: no borra, no actualiza, no inserta nada.
//
//   node scripts/diagnose-diego.mjs
//   node scripts/diagnose-diego.mjs "otro alumno"
//   node scripts/diagnose-diego.mjs --json > diego.json
//
// Responde a cuatro preguntas:
//   1. ¿Sigue la ficha en `students`? (el DELETE falló, así que debería seguir)
//   2. ¿Qué assignments quedan apuntando a su id, y cuáles tienen OTRO nombre?
//      Esas son las que disparan assignments_student_id_fkey.
//   3. ¿Cuántos backups tiene en deleted_students_backup? (>1 = duplicado)
//   4. ¿Qué se perdió ya y qué sobrevive de finanzas? class_records y
//      class_join_logs no tienen student_id: se cruzan por nombre y NO se tocan.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const NOMBRE = args.find(a => !a.startsWith('--')) ?? 'Diego Ruiz';

// ── credenciales ────────────────────────────────────────────────────────────
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

const nk = x => String(x ?? '').trim().toLowerCase();

async function q(tabla, params) {
  const url = `${URL_}/rest/v1/${tabla}?${params}`;
  const res = await fetch(url, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!res.ok) {
    // 404 = tabla inexistente (migración sin correr). No es fatal para el informe.
    if (res.status === 404) return { missing: true, rows: [] };
    throw new Error(`${tabla} → HTTP ${res.status}: ${await res.text()}`);
  }
  return { missing: false, rows: await res.json() };
}

const enc = encodeURIComponent;

// ── 1. ficha(s) en students ─────────────────────────────────────────────────
const fichas = (await q('students', `select=id,name,email,plan,level,created_at&name=ilike.*${enc(NOMBRE)}*`)).rows;
const ids = fichas.map(f => f.id);

// ── 2. assignments ──────────────────────────────────────────────────────────
const porId = ids.length
  ? (await q('assignments', `select=id,student_id,student_name,teacher_name,teacher_id&student_id=in.(${ids.map(enc).join(',')})`)).rows
  : [];
const porNombre = (await q('assignments', `select=id,student_id,student_name,teacher_name,teacher_id&student_name=ilike.*${enc(NOMBRE)}*`)).rows;

const todas = [...porId];
const vistas = new Set(todas.map(r => r.id));
for (const r of porNombre) if (!vistas.has(r.id)) { todas.push(r); vistas.add(r.id); }

// Las que bloquean el DELETE de students: apuntan a una de sus ids.
const bloqueantes = porId;

// ── 3. backups ──────────────────────────────────────────────────────────────
const backups = (await q('deleted_students_backup',
  `select=id,original_student_id,student_name,deleted_at,deleted_by,restored&student_name=ilike.*${enc(NOMBRE)}*&order=deleted_at.desc`)).rows;

// ── 4. rastro de finanzas e hijos ───────────────────────────────────────────
const analyses = (await q('class_analyses', `select=id,student_id,student_name,teacher_id,class_date&student_name=ilike.*${enc(NOMBRE)}*`));
const records  = (await q('class_records',  `select=id,student_name,teacher_name,class_date,class_type&student_name=ilike.*${enc(NOMBRE)}*`));
const joins    = (await q('class_join_logs',`select=id,student_name,teacher_name,scheduled_date&student_name=ilike.*${enc(NOMBRE)}*`));
const perfiles = ids.length
  ? (await q('student_profiles', `select=id,student_id&or=(id.in.(${ids.map(enc).join(',')}),student_id.in.(${ids.map(enc).join(',')}))`)).rows
  : [];
const dropouts = (await q('student_dropouts', `select=id,teacher_id,student_name,dropped_at,reason&student_name=ilike.*${enc(NOMBRE)}*`)).rows;

const informe = {
  alumno: NOMBRE,
  fichas,
  assignments: { bloqueantesPorId: bloqueantes, todas },
  backups,
  perfiles,
  dropouts,
  finanzas: {
    class_analyses:  analyses.missing ? 'tabla ausente' : analyses.rows,
    class_records:   records.missing  ? 'tabla ausente' : records.rows,
    class_join_logs: joins.missing    ? 'tabla ausente' : joins.rows,
  },
};

if (asJson) {
  console.log(JSON.stringify(informe, null, 2));
  process.exit(0);
}

// ── informe legible ─────────────────────────────────────────────────────────
const li = (s) => console.log(`   · ${s}`);
console.log(`\n═══ Estado de "${NOMBRE}" ═══\n`);

console.log(`1) FICHAS en students: ${fichas.length}`);
if (fichas.length === 0) {
  li('Ninguna. El borrado SÍ llegó a completarse (o nunca existió con ese nombre).');
} else {
  for (const f of fichas) li(`${f.id} — ${f.name} <${f.email ?? 'sin email'}> · plan: ${f.plan ?? '—'}`);
  li('Sigue viva: el DELETE de students falló, como esperábamos.');
}

console.log(`\n2) ASSIGNMENTS que apuntan a su id: ${bloqueantes.length}  ← lo que dispara la FK`);
if (bloqueantes.length === 0) {
  li('Ninguna. Nada bloquea el borrado por este lado.');
} else {
  for (const a of bloqueantes) {
    const mismo = nk(a.student_name) === nk(NOMBRE);
    li(`${a.id} — "${a.student_name}" · ${a.teacher_name} ${mismo ? '(mismo nombre)' : '⚠ NOMBRE AJENO → el guard la saltaba'}`);
  }
  const ajenasReales = bloqueantes.filter(a => nk(a.student_name) !== nk(NOMBRE));
  if (ajenasReales.length > 0) {
    console.log(`\n   ⚠ ${ajenasReales.length} fila(s) de nombre ajeno: ESTA es la causa del error.`);
    console.log('     El pre-flight nuevo intentará re-apuntarlas a su ficha real.');
    console.log('     Comprobá que estos alumnos existan en students con ese nombre exacto:');
    for (const n of [...new Set(ajenasReales.map(a => a.student_name))]) console.log(`       → "${n}"`);
  }
}
console.log(`   (total incluyendo las localizadas por nombre: ${todas.length})`);

console.log(`\n3) BACKUPS en deleted_students_backup: ${backups.length}`);
for (const b of backups) li(`${b.id} — ${b.deleted_at} por ${b.deleted_by ?? '—'} ${b.restored ? '(restaurado)' : ''}`);
if (backups.length > 1) {
  const sinRestaurar = backups.filter(b => !b.restored);
  console.log(`\n   ⚠ DUPLICADO: hay ${backups.length} copias (${sinRestaurar.length} sin restaurar).`);
  console.log('     Conservá la más reciente y borrá las demás a mano:');
  for (const b of backups.slice(1)) console.log(`       delete from deleted_students_backup where id = '${b.id}';`);
} else if (backups.length === 1) {
  li('Una sola copia. Correcto — el reintento ya no duplicará (backup idempotente).');
} else {
  li('Sin copia. Ojo: el borrado ni siquiera llegó al backup.');
}

console.log(`\n4) FINANZAS (esto NO se toca al borrar — se cruza por nombre, no por id)`);
const n = (x) => (x.missing ? 'tabla ausente' : x.rows.length);
li(`class_analyses:  ${n(analyses)} ${!analyses.missing && analyses.rows.length ? `(${analyses.rows.filter(r => r.student_id === null).length} ya desvinculados)` : ''}`);
li(`class_records:   ${n(records)}`);
li(`class_join_logs: ${n(joins)}`);
li('Estas clases seguirán contando para el pago del profesor pase lo que pase.');

console.log(`\n5) RESTO`);
li(`student_profiles: ${perfiles.length}`);
li(`student_dropouts: ${dropouts.length} ${dropouts.length ? '(la baja ya quedó registrada)' : ''}`);

console.log(`\n═══ Qué hacer ═══`);
if (fichas.length > 0) {
  const ajenasReales = bloqueantes.filter(a => nk(a.student_name) !== nk(NOMBRE));
  if (ajenasReales.length > 0) {
    console.log('Hay vínculos corruptos. Volvé a eliminarlo desde el panel: el pre-flight');
    console.log('los repara solo si el otro alumno existe, o aborta diciéndote cuál revisar.');
  } else {
    console.log('No hay vínculos corruptos. Volvé a eliminarlo desde el panel: debería');
    console.log('completarse sin error y sin duplicar el backup.');
  }
} else {
  console.log('Nada que reparar en students.');
  if (backups.length > 1) console.log('Pero limpiá los backups duplicados con el SQL de arriba.');
}
console.log('');
