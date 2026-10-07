// Cambio de profesor de un alumno desde la terminal, con la MISMA lógica que el
// wizard "Cambiar de profesor" del panel: el núcleo de lib/transferencia/core.ts,
// aquí con la service key (transferirAlumnoServidor). Valida antes de escribir,
// ocupa el calendario nuevo, reapunta la assignment, libera el viejo (o lo
// deshace todo si algo falla) y deja avisos, scoring y correos. Queda registrado
// en transfer_requests con origen 'script'. Duplicar esos pasos a mano es justo
// lo que dejó a Izaro Gaztañaga a medio camino en julio de 2026.
//
// --conditions=react-server es OBLIGATORIO: lib/transferencia/server.ts es
// 'server-only' y sin esa condición lanza al importarlo.
//
//   node --env-file=.env.local --conditions=react-server --import tsx scripts/cambiar-profesor.mts --alumno "Beñat"
//       ← lista los profesores libres en TODOS los horarios del alumno
//   ... --alumno "Beñat" --a "Chiara"
//       ← ENSAYO del cambio: no escribe nada
//   ... --a "Chiara" --apply            ← lo aplica de verdad
//   ... --a "Chiara" --apply --motivo alumno
//
// Los horarios NO se tocan: el alumno se lleva los mismos día+hora, que es lo que
// significa "un profesor con su misma disponibilidad". Para moverlo a otra franja
// está el wizard del panel, que deja elegir celda por celda.
//
// El motivo por defecto es 'reorg' (sin penalización). 'alumno' resta 10 puntos al
// profesor anterior y 'profesor' resta 20, igual que en el wizard.
//
// El correo al profesor nuevo y la bienvenida del alumno salen directamente con
// Resend (antes, desde aquí, el del profesor se perdía).

import { dbGetTeachers, dbGetAssignments } from '@/lib/db';
import { transferirAlumnoServidor } from '@/lib/transferencia/server';
import { TransferenciaError } from '@/lib/transferencia/errors';
import { esProfesorDePrueba } from '@/lib/externalTeachers';
import type { AssignedSlot } from '@/types';

const DAY_ORDER = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] ?? '' : '';
};
const ALUMNO = flag('--alumno');
const DESTINO = flag('--a');
const MOTIVO = (flag('--motivo') || 'reorg') as 'alumno' | 'profesor' | 'reorg';
const APPLY = args.includes('--apply');

if (!ALUMNO) {
  console.error('Falta --alumno "<nombre o parte del nombre>".');
  process.exit(1);
}
if (!['alumno', 'profesor', 'reorg'].includes(MOTIVO)) {
  console.error(`--motivo tiene que ser alumno | profesor | reorg (llegó "${MOTIVO}").`);
  process.exit(1);
}

/** Comparación tolerante: sin tildes, sin mayúsculas, sin espacios de más. */
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function sortSlots(slots: AssignedSlot[]): AssignedSlot[] {
  return [...slots].sort((a, b) => {
    const d = DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day);
    return d !== 0 ? d : a.hour.localeCompare(b.hour);
  });
}
const label = (slots: AssignedSlot[]) => sortSlots(slots).map(s => `${s.day} ${s.hour}`).join(', ');

const [teachers, assignments] = await Promise.all([dbGetTeachers(), dbGetAssignments()]);

// ── El alumno ────────────────────────────────────────────────────────────────
const matches = assignments.filter(a => a.status !== 'inactive' && norm(a.studentName).includes(norm(ALUMNO)));
if (matches.length === 0) {
  console.error(`Ningún alumno activo coincide con "${ALUMNO}".`);
  process.exit(1);
}
if (matches.length > 1) {
  console.error(`"${ALUMNO}" coincide con varios alumnos; afiná el nombre:`);
  for (const a of matches) console.error(`  · ${a.studentName} (con ${a.teacherName})`);
  process.exit(1);
}
const asg = matches[0];
const from = teachers.find(t => t.id === asg.teacherId);
if (!from) {
  console.error(`El profesor actual (${asg.teacherName}, ${asg.teacherId}) no está entre los activos: revisalo a mano.`);
  process.exit(1);
}
const slots = sortSlots(asg.slots);
const keys = slots.map(s => `${s.day}_${s.hour}`);

console.log(`\n👤 ${asg.studentName} — ${asg.studentLevel} · ${asg.weeklyHours || slots.length}h/sem`);
console.log(`   Profesor actual: ${from.name} (${from.id})`);
console.log(`   Horarios:        ${label(slots) || '—'}`);
console.log(`   Plan:            ${asg.plan || '—'}`);

// ── Profesores con esa MISMA disponibilidad ──────────────────────────────────
// `libreCells` ya viene resuelto al estado recurrente (una recuperación puntual
// encima no descalifica la celda), así que es la única fuente que hay que mirar.
const candidatos = teachers
  .filter(t => t.id !== from.id && !esProfesorDePrueba(t.id))
  .filter(t => keys.every(k => (t.libreCells ?? []).includes(k)));

if (!DESTINO) {
  console.log(`\n🔎 Profesores libres en los ${keys.length} horarios (${label(slots)}):`);
  if (candidatos.length === 0) {
    console.log('   Ninguno. Habría que mover al alumno de franja o liberar horarios.');
  }
  for (const t of candidatos) {
    const alumnos = assignments.filter(a => a.teacherId === t.id && a.status !== 'inactive').length;
    const puntuales = keys.filter(k => t.puntualCells?.[k]).map(k => `${k} (recuperación el ${t.puntualCells![k]})`);
    console.log(`   ✅ ${t.name} (${t.id}) — ${alumnos} alumno(s) · ${t.freeSpots} cupo(s) libre(s) · ${(t.specialties ?? []).join(', ')}`);
    if (puntuales.length) console.log(`      ⚠ ${puntuales.join('; ')}`);
  }
  console.log(`\nPara ensayar el cambio: --alumno "${ALUMNO}" --a "<profesor>"\n`);
  process.exit(0);
}

// ── Destino elegido ──────────────────────────────────────────────────────────
const destinos = teachers.filter(t => norm(t.name).includes(norm(DESTINO)));
if (destinos.length !== 1) {
  console.error(destinos.length === 0
    ? `Ningún profesor activo coincide con "${DESTINO}".`
    : `"${DESTINO}" coincide con varios profesores: ${destinos.map(t => t.name).join(', ')}.`);
  process.exit(1);
}
const to = destinos[0];
if (to.id === from.id) {
  console.error('El profesor de destino es el mismo que el actual.');
  process.exit(1);
}
const ocupados = keys.filter(k => !(to.libreCells ?? []).includes(k));
if (ocupados.length) {
  console.error(`\n❌ ${to.name} no tiene libre: ${ocupados.join(', ')}. El cambio le pisaría el horario a otro alumno.`);
  process.exit(1);
}

console.log(`\n➡️  Destino: ${to.name} (${to.id}) — ${(to.specialties ?? []).join(', ')}`);
console.log(`   Mismos horarios: ${label(slots)}`);
console.log(`   Motivo: ${MOTIVO}${MOTIVO === 'reorg' ? ' (sin penalización)' : ` (penaliza a ${from.name})`}`);

if (!APPLY) {
  console.log('\n🧪 ENSAYO: no se escribió nada. Repetí el comando con --apply para aplicarlo.\n');
  process.exit(0);
}

try {
  const r = await transferirAlumnoServidor({
    assignmentId: asg.id,
    toTeacherId:  to.id,
    slots,
    motivo:       MOTIVO,
    origen:       'script',
    actor:        `script cambiar-profesor (${process.env.USERNAME ?? process.env.USER ?? 'terminal'})`,
  });
  console.log(`\n✅ ${asg.studentName} quedó asignado a ${to.name} en ${label(slots)}.`);
  for (const a of r.avisos) console.log(`   ⚠ ${a}`);
  if (r.efectosFallidos.length) console.log(`   ⚠ Fallaron (el admin ya tiene un aviso por cada uno): ${r.efectosFallidos.join(', ')}`);
  console.log('');
} catch (err) {
  console.error(`\n❌ ${err instanceof TransferenciaError ? `[${err.codigo}] ${err.userMessage}` : String(err)}\n`);
  process.exit(1);
}
