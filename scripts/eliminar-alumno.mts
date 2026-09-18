// Eliminación TOTAL de un alumno desde la terminal, con la MISMA lógica que el
// botón "Eliminar" del panel de admin: llama a dbDeleteStudent, así que hace el
// pre-flight en ensayo, guarda el backup (idempotente), corre la cadena entera en
// UNA transacción (delete_student_cascade), registra la baja, avisa por la
// campanita y libera el grid de cada profesor. Duplicar esos pasos a mano es
// justo lo que dejó alumnos a medias en agosto de 2026.
//
// Existe porque el 18/09/2026 el panel no podía eliminar a NADIE: la tabla
// level_test_followups (creada el 17/09) apunta a students con una columna NOT
// NULL y la cadena la bloqueaba con nombre. Una vez pegado el .sql corregido en
// Supabase, este script completa los borrados que quedaron pendientes sin tener
// que ir alumno por alumno en el navegador.
//
//   node --env-file=.env.local --import tsx scripts/eliminar-alumno.mts --alumno "Barrés"
//       ← ENSAYO: resuelve la ficha y muestra lo que la cadena borraría, soltaría
//         y conservaría. No escribe nada.
//   node --env-file=.env.local --import tsx scripts/eliminar-alumno.mts --alumno "Barrés" --apply
//       ← lo elimina de verdad (backup + transacción + baja + avisos + grid).
//   ... --alumno "Barrés" --alumno "Otro Alumno" --apply     ← varios de una vez
//   ... --id s_1786100283945 --apply                          ← por id, si el nombre es ambiguo
//   ... --por facundo                                         ← quién elimina (por defecto 'admin')
//
// Lo que NO hace igual que el panel:
//   · La foto de churn (/api/churn/capture) no se puede tomar desde acá: el
//     endpoint solo existe con la app levantada. dbDeleteStudent lo trata como
//     best-effort y sigue, igual que en el navegador cuando falla.
//   · El correo de Resend al profesor sí sale, pero pegándole al endpoint público
//     de producción (PUBLIC_APP_URL/api/send-cancellation-email), que es lo mismo
//     que hace app/students/page.tsx. Si falla, se avisa y la baja queda hecha.

import { supabase } from '@/lib/supabase';
import { dbDeleteStudent } from '@/lib/db';
import { PUBLIC_APP_URL } from '@/lib/appUrl';

const args = process.argv.slice(2);
const values = (name: string): string[] =>
  args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
const flag = (name: string) => values(name)[0] ?? '';

const ALUMNOS = values('--alumno');
const IDS = values('--id');
const POR = flag('--por') || 'admin';
const APPLY = args.includes('--apply');

if (ALUMNOS.length === 0 && IDS.length === 0) {
  console.error('Falta --alumno "<nombre o parte del nombre>" (repetible) o --id <students.id>.');
  process.exit(1);
}

/** Comparación tolerante: sin tildes, sin mayúsculas, sin espacios de más. */
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

interface Ficha { id: string; name: string; email: string | null }

const { data: vivos, error: errVivos } = await supabase
  .from('students').select('id, name, email').limit(5000);
if (errVivos) {
  console.error(`No se pudo leer students: ${errVivos.message}`);
  process.exit(1);
}
const fichas = (vivos ?? []) as Ficha[];

// ── Resolver cada pedido a UNA ficha ─────────────────────────────────────────
// Un nombre que coincide con varias fichas NO se adivina: los homónimos y las
// altas duplicadas son indistinguibles desde acá (ver complete-stuck-deletions).
// Se listan y se pide el --id.
const objetivo: Ficha[] = [];
let hayError = false;

for (const id of IDS) {
  const f = fichas.find(s => s.id === id);
  if (!f) { console.error(`❌ No hay ninguna ficha con id ${id}.`); hayError = true; continue; }
  objetivo.push(f);
}
for (const nombre of ALUMNOS) {
  const exactas = fichas.filter(s => norm(s.name) === norm(nombre));
  const parciales = exactas.length ? exactas : fichas.filter(s => norm(s.name).includes(norm(nombre)));
  if (parciales.length === 0) {
    console.error(`❌ Ningún alumno coincide con "${nombre}".`);
    hayError = true;
  } else if (parciales.length > 1) {
    console.error(`❌ "${nombre}" coincide con varias fichas; usá --id con la que corresponde:`);
    for (const s of parciales) console.error(`     · ${s.name} — ${s.id} — ${s.email ?? 'sin email'}`);
    hayError = true;
  } else if (!objetivo.some(o => o.id === parciales[0].id)) {
    objetivo.push(parciales[0]);
  }
}
if (hayError) process.exit(1);

console.log(APPLY ? '\n=== APLICANDO (escribe en la base) ===' : '\n=== ENSAYO (no escribe nada) ===');

interface Resultado { alumno: string; estado: string; detalle?: string }
const resultados: Resultado[] = [];

for (const f of objetivo) {
  console.log(`\n── ${f.name} (${f.id}) ─────────────────────────────────`);

  const homonimos = fichas.filter(s => s.id !== f.id && norm(s.name) === norm(f.name));
  for (const h of homonimos) {
    console.log(`  ⚠ OTRA ficha con el mismo nombre, NO se toca: ${h.id} · ${h.email ?? 'sin email'}`);
  }

  // Pre-flight por su cuenta, para poder mostrarlo en el ensayo. dbDeleteStudent
  // lo repite antes de escribir: es la misma RPC en modo dry-run.
  const { data: plan, error: errPlan } = await supabase.rpc('delete_student_cascade', {
    p_ids: [f.id], p_student_name: f.name, p_dry_run: true,
  });
  if (errPlan) {
    console.error(`  ❌ Pre-flight: ${errPlan.message}`);
    resultados.push({ alumno: f.name, estado: 'BLOQUEADO', detalle: errPlan.message.split('\n')[1] ?? errPlan.message });
    continue;
  }
  console.log(`  ensayo → assignments: ${plan.assignment_ids.length}` +
              ` · soltar: ${JSON.stringify(plan.cleared)}` +
              ` · borrar: ${JSON.stringify(plan.deleted)}`);
  console.log(`  se conservan (finanzas): ${JSON.stringify(plan.preserved)}`);
  if (plan.repaired?.length) console.log(`  vínculos a reparar: ${JSON.stringify(plan.repaired)}`);

  if (!APPLY) { resultados.push({ alumno: f.name, estado: 'ensayo ok' }); continue; }

  try {
    const afectados = await dbDeleteStudent(f.id, f.name, POR);
    console.log(`  ✅ ELIMINADO. Calendarios liberados: ${afectados.length} profesor(es).`);

    // El mismo aviso por email que manda el panel (app/students/page.tsx).
    const recipients = afectados
      .map(t => ({ email: t.notificationEmail || t.email, name: t.name }))
      .filter(r => r.email);
    if (recipients.length > 0) {
      try {
        const res = await fetch(`${PUBLIC_APP_URL}/api/send-cancellation-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ studentName: f.name, recipients }),
        });
        const j = await res.json().catch(() => ({}));
        console.log(`  ✉  Aviso a profesores: ${j.sent ?? 0}/${recipients.length} enviado(s).`);
      } catch (e) {
        console.warn(`  ⚠ No se pudo mandar el aviso por email (la baja ya está hecha): ${String(e)}`);
      }
    }
    resultados.push({ alumno: f.name, estado: 'eliminado', detalle: `${afectados.length} profesor(es)` });
  } catch (e) {
    console.error(`  ❌ ${(e as Error).message}`);
    resultados.push({ alumno: f.name, estado: 'ERROR', detalle: (e as Error).message.split('\n')[0] });
  }
}

// ── Verificación ─────────────────────────────────────────────────────────────
// Lo que debe quedar en 0, lo que debe quedar en 1 y lo que no se debe haber
// tocado (finanzas cruza por nombre, no por id).
if (APPLY) {
  console.log('\n=== VERIFICACIÓN ===');
  for (const f of objetivo) {
    const [st, asg, bak, rec, ana] = await Promise.all([
      supabase.from('students').select('id').eq('id', f.id),
      supabase.from('assignments').select('id').eq('student_id', f.id),
      supabase.from('deleted_students_backup').select('id').eq('original_student_id', f.id),
      supabase.from('class_records').select('id').ilike('student_name', f.name),
      supabase.from('class_analyses').select('id').ilike('student_name', f.name),
    ]);
    console.log(`  ${f.name}: students=${st.data?.length ?? '?'} (debe ser 0) · assignments=${asg.data?.length ?? '?'} (0) · ` +
                `backups=${bak.data?.length ?? '?'} (1) · class_records=${rec.data?.length ?? '?'} (intactos) · ` +
                `class_analyses=${ana.data?.length ?? '?'} (intactos)`);
  }
}

console.log('\n=== RESUMEN ===');
console.table(resultados);
