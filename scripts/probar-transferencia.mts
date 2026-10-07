// ⚠ DESACTIVADO (07/10/2026). NO SE USA: sale nada más arrancar.
//
// Se escribió suponiendo que t1 y t2 eran profesores de prueba, y NO es así: t2
// (Mauricio) es un profesor REAL con alumnos reales. El único perfil de prueba es
// t1, "Sebastian (test)" (lib/perfilDePrueba.ts), y una transferencia necesita
// dos profesores, así que esta prueba de ida y vuelta no tiene con quién hacerse
// sin tocar a un profesor real. Las transferencias se prueban a mano en
// producción. Se deja el código por si algún día hay un segundo perfil de prueba:
// habría que cambiar PRUEBA y quitar la salida de abajo.
//
// Lo que hacía: IDA, repetición con la misma clave, RECHAZO con origen 'lms' y
// VUELTA de un alumno de prueba entre dos profesores, comprobando calendarios,
// asignación y transfer_requests.

import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { transferirAlumnoCore, type TransferenciaDeps, type TransferenciaParams, type TransferenciaResultado } from '@/lib/transferencia/core';
import { TransferenciaError } from '@/lib/transferencia/errors';
import { depsServidor } from '@/lib/transferencia/server';
import { esHuecoLibreParaAlumno, isAssignableCell, baseStudentOf } from '@/lib/cells';
import { liveReservationsWith } from '@/lib/classRecoveryQueries';
import { getSpainParts } from '@/lib/spainTime';
import type { AssignedSlot, Cell, Grid } from '@/types';

// OJO: t2 NO es de prueba (ver la cabecera). Por eso el script no corre.
const PRUEBA = ['t1', 't2'] as const;

// Candado: sin esta variable (que nadie debe poner mientras t2 sea real) sale.
if (process.env.PROBAR_TRANSFERENCIA_REACTIVADA !== 'si') {
  console.error('scripts/probar-transferencia.mts está DESACTIVADO: t2 es un profesor real y solo t1 es de prueba. Ver la cabecera.');
  process.exit(1);
}
const DAY_ORDER = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? (args[i + 1] ?? '') : ''; };
const ALUMNO = flag('--alumno').trim();
const APPLY = args.includes('--apply');
const CON_CORREOS = args.includes('--con-correos');

if (!ALUMNO) { console.error('Falta --alumno "<nombre EXACTO del alumno de prueba>".'); process.exit(1); }

const admin = getSupabaseAdmin();
if (!admin) { console.error('Falta SUPABASE_SERVICE_ROLE_KEY en .env.local.'); process.exit(1); }
const db = admin;

// ── Utilidades ────────────────────────────────────────────────────────────────

const key = (s: AssignedSlot) => `${s.day}_${s.hour}`;
const sortKeys = (ks: string[]) => [...ks].sort((a, b) => {
  const [da, ha] = a.split('_'); const [dbb, hb] = b.split('_');
  return DAY_ORDER.indexOf(da) - DAY_ORDER.indexOf(dbb) || ha.localeCompare(hb);
});
const toSlot = (k: string): AssignedSlot => { const [day, hour] = k.split('_'); return { day, hour }; };
const cellTxt = (c: Cell | undefined) => {
  if (!c) return '(sin pintar)';
  const base = baseStudentOf(c);
  const extra = c.weekDate ? ` [marca ${c.state} sem. ${c.weekDate}]` : '';
  return `${c.weekDate ? (c.baseState ?? 'libre') : c.state}${base ? ` · ${base}` : ''}${extra}`;
};

const checks: Array<{ ok: boolean; texto: string }> = [];
const check = (ok: boolean, texto: string) => { checks.push({ ok, texto }); console.log(`   ${ok ? '✅' : '❌'} ${texto}`); };

async function leerAsignacion(id: string) {
  const { data, error } = await db.from('assignments')
    .select('id, teacher_id, teacher_name, student_id, student_name, slots, weekly_hours, status, meet_link, created_at, teacher_since')
    .eq('id', id).single();
  if (error) throw new Error(`no se pudo leer la asignación: ${error.message}`);
  return data as { id: string; teacher_id: string; teacher_name: string; student_id: string | null; student_name: string; slots: AssignedSlot[]; weekly_hours: number; status: string; meet_link: string | null; created_at: string; teacher_since: string | null };
}

async function leerGrid(teacherId: string): Promise<Grid> {
  const { data, error } = await db.from('teacher_calendars').select('grid').eq('teacher_id', teacherId).maybeSingle();
  if (error) throw new Error(`no se pudo leer el calendario de ${teacherId}: ${error.message}`);
  return (data?.grid as Grid) ?? {};
}

async function leerRegistros(assignmentId: string) {
  const { data, error } = await db.from('transfer_requests')
    .select('idempotency_key, from_teacher_id, to_teacher_id, origen, motivo, estado, error, created_at')
    .eq('assignment_id', assignmentId).order('created_at', { ascending: true });
  if (error) { console.log(`   (transfer_requests no se pudo leer: ${error.message})`); return []; }
  return (data ?? []) as Array<{ idempotency_key: string | null; from_teacher_id: string | null; to_teacher_id: string; origen: string; motivo: string; estado: string; error: string | null; created_at: string }>;
}

interface Foto { asg: Awaited<ReturnType<typeof leerAsignacion>>; grids: Record<string, Grid> }

async function foto(id: string): Promise<Foto> {
  const [asg, g1, g2] = await Promise.all([leerAsignacion(id), leerGrid('t1'), leerGrid('t2')]);
  return { asg, grids: { t1: g1, t2: g2 } };
}

/** Lo que se compara entre fotos: profesor, horarios, estado y las casillas implicadas. */
function huella(f: Foto, claves: Record<string, string[]>) {
  return JSON.stringify({
    teacher: f.asg.teacher_id, slots: sortKeys(f.asg.slots.map(key)), horas: f.asg.weekly_hours, status: f.asg.status,
    celdas: Object.fromEntries(Object.entries(claves).map(([t, ks]) => [t, Object.fromEntries(ks.map(k => [k, f.grids[t][k] ?? null]))])),
  });
}

function mostrar(titulo: string, f: Foto, claves: Record<string, string[]>) {
  console.log(`\n── ${titulo} ${'─'.repeat(Math.max(0, 60 - titulo.length))}`);
  console.log(`   Asignación ${f.asg.id}: ${f.asg.student_name} con ${f.asg.teacher_name} (${f.asg.teacher_id}), ${f.asg.status}`);
  console.log(`     horarios: ${sortKeys(f.asg.slots.map(key)).join(', ')} · ${f.asg.weekly_hours} h/sem`);
  console.log(`     meet_link: ${f.asg.meet_link ?? '—'} · created_at: ${f.asg.created_at} · teacher_since: ${f.asg.teacher_since ?? '—'}`);
  for (const [t, ks] of Object.entries(claves)) {
    console.log(`   Calendario ${t}:`);
    for (const k of sortKeys(ks)) console.log(`     ${k.padEnd(16)} ${cellTxt(f.grids[t][k])}`);
  }
}

// ── Correos ───────────────────────────────────────────────────────────────────

const depsSinCorreos: TransferenciaDeps = {
  async enviarEmailProfeNuevo(d) { console.log(`   ✉ (simulado) correo "Nuevo alumno asignado" a ${d.teacherName} (${d.teacherId})`); return true; },
  async enviarBienvenidaAlumno(id) { console.log(`   ✉ (simulado) bienvenida al alumno de la asignación ${id}`); },
};
const deps = CON_CORREOS ? depsServidor(db) : depsSinCorreos;

async function transferir(p: TransferenciaParams): Promise<TransferenciaResultado> {
  return transferirAlumnoCore(db, p, deps);
}

// ── El alumno de prueba ───────────────────────────────────────────────────────

const { data: candidatas, error: candErr } = await db.from('assignments')
  .select('id, teacher_id, student_id, student_name, status').eq('status', 'active');
if (candErr) { console.error(candErr.message); process.exit(1); }
const mias = (candidatas ?? []).filter(a => (a.student_name ?? '').trim() === ALUMNO);
if (mias.length !== 1) {
  console.error(mias.length === 0
    ? `No hay ninguna asignación ACTIVA de "${ALUMNO}" (nombre exacto).`
    : `"${ALUMNO}" tiene ${mias.length} asignaciones activas; tiene que tener exactamente una.`);
  process.exit(1);
}
const asg0 = mias[0];
if (!PRUEBA.includes(asg0.teacher_id)) {
  console.error(`"${ALUMNO}" está con ${asg0.teacher_id}, no con t1 ni t2. Esta prueba solo toca a los profesores de prueba.`);
  process.exit(1);
}
if (asg0.student_id) {
  const { data: otras } = await db.from('assignments').select('id, teacher_id').eq('student_id', asg0.student_id).neq('id', asg0.id);
  if ((otras ?? []).length) {
    console.error(`El alumno tiene otras asignaciones (${(otras ?? []).map(o => `${o.id}@${o.teacher_id}`).join(', ')}). Usa un alumno de prueba limpio.`);
    process.exit(1);
  }
}

const ORIGEN = asg0.teacher_id as 't1' | 't2';
const DESTINO = ORIGEN === 't1' ? 't2' : 't1';
const antes = await foto(asg0.id);
const clavesOriginales = sortKeys(antes.asg.slots.map(key));
const N = clavesOriginales.length;
if (N === 0 || N !== antes.asg.weekly_hours) {
  console.error(`La asignación tiene ${N} horario(s) y weekly_hours=${antes.asg.weekly_hours}: tienen que coincidir y ser al menos 1.`);
  process.exit(1);
}
const enCalendario = clavesOriginales.filter(k => (baseStudentOf(antes.grids[ORIGEN][k] ?? { state: 'no_work' }) ?? '').trim() === ALUMNO);
if (enCalendario.length !== N) {
  console.error(`En el calendario de ${ORIGEN} solo ${enCalendario.length} de ${N} casillas llevan el nombre exacto "${ALUMNO}". Revisa el alta.`);
  process.exit(1);
}

// Casillas destino de la IDA: las primeras N libres (criterio de admin/script).
const libresDestino = sortKeys(Object.keys(antes.grids[DESTINO]).filter(k => isAssignableCell(antes.grids[DESTINO][k])));
if (libresDestino.length < N) { console.error(`${DESTINO} solo tiene ${libresDestino.length} casilla(s) libres; hacen falta ${N}.`); process.exit(1); }
const clavesIda = libresDestino.slice(0, N);

// Casilla NO libre para el alumno en el calendario de ORIGEN (para el rechazo 'lms'):
// dentro del rango del profesor, que no sea de sus horarios originales.
const { data: tOrigen } = await db.from('teachers').select('calendar_start_hour, calendar_end_hour').eq('id', ORIGEN).single();
const ctxLms = {
  horaInicio: tOrigen?.calendar_start_hour ?? null, horaFin: tOrigen?.calendar_end_hour ?? null,
  alcance: { tipo: 'desde' as const, fecha: getSpainParts(new Date()).dateStr },
  reservas: await liveReservationsWith(db, ORIGEN),
};
const desde = ctxLms.horaInicio ?? 9; const hasta = ctxLms.horaFin ?? 22;
const candidatasNoLibres = DAY_ORDER.flatMap(d => Array.from({ length: hasta - desde + 1 }, (_, i) => `${d}_${String(desde + i).padStart(2, '0')}:00`))
  .filter(k => !clavesOriginales.includes(k))
  .filter(k => !esHuecoLibreParaAlumno(antes.grids[ORIGEN], k, ctxLms).libre);
const claveNoLibre = candidatasNoLibres[0];
if (!claveNoLibre) { console.error(`No encontré ninguna casilla no libre en ${ORIGEN} para el caso de rechazo.`); process.exit(1); }
const motivoNoLibre = esHuecoLibreParaAlumno(antes.grids[ORIGEN], claveNoLibre, ctxLms);
const clavesRechazo = [claveNoLibre, ...clavesOriginales.slice(1)];  // N casillas: la no libre + (N-1) que sí lo estarán

const claves: Record<string, string[]> = {
  [ORIGEN]: [...new Set([...clavesOriginales, claveNoLibre])],
  [DESTINO]: clavesIda,
};

console.log(`\n🧪 Prueba de transferencia · ${ALUMNO} · ${ORIGEN} → ${DESTINO} → ${ORIGEN}`);
console.log(`   Correos: ${CON_CORREOS ? 'DE VERDAD (Resend)' : 'simulados'}`);
console.log(`   IDA a ${DESTINO}: ${clavesIda.join(', ')}`);
console.log(`   RECHAZO lms a ${ORIGEN}: ${clavesRechazo.join(', ')} (${claveNoLibre} no es libre: ${motivoNoLibre.libre ? '?' : motivoNoLibre.motivo})`);
console.log(`   VUELTA a ${ORIGEN}: ${clavesOriginales.join(', ')}`);
mostrar('ANTES', antes, claves);
const regAntes = await leerRegistros(asg0.id);
console.log(`   transfer_requests de esta asignación: ${regAntes.length}`);

if (!APPLY) {
  console.log('\n🧪 ENSAYO: no se escribió nada. Repite con --apply para ejecutar la prueba.\n');
  process.exit(0);
}

const run = `prueba-${Date.now()}`;
const base = { assignmentId: asg0.id, actor: 'scripts/probar-transferencia' };

try {
  // 2) IDA
  console.log(`\n▶ IDA ${ORIGEN} → ${DESTINO}`);
  const ida = await transferir({ ...base, toTeacherId: DESTINO, slots: clavesIda.map(toSlot), motivo: 'reorg', origen: 'script', idempotencyKey: `${run}-ida` });
  const trasIda = await foto(asg0.id);
  mostrar('DESPUÉS DE LA IDA', trasIda, claves);
  check(trasIda.asg.teacher_id === DESTINO, `la asignación es de ${DESTINO}`);
  check(JSON.stringify(sortKeys(trasIda.asg.slots.map(key))) === JSON.stringify(clavesIda), 'sus horarios son los de la ida');
  check(clavesIda.every(k => (baseStudentOf(trasIda.grids[DESTINO][k] ?? { state: 'no_work' }) ?? '').trim() === ALUMNO), `ocupa las casillas en ${DESTINO}`);
  check(clavesOriginales.every(k => !baseStudentOf(trasIda.grids[ORIGEN][k] ?? { state: 'no_work' })), `liberó sus casillas en ${ORIGEN}`);
  check(trasIda.asg.meet_link === null, 'el enlace de la clase se borró (es la sala del profesor anterior)');
  check(ida.efectosFallidos.length === 0, `sin efectos fallidos (${ida.efectosFallidos.join(', ') || 'ninguno'})`);

  // 3) REPETICIÓN con la misma clave
  console.log('\n▶ REPETICIÓN de la ida con la misma clave');
  const idaBis = await transferir({ ...base, toTeacherId: DESTINO, slots: clavesIda.map(toSlot), motivo: 'reorg', origen: 'script', idempotencyKey: `${run}-ida` });
  const trasBis = await foto(asg0.id);
  check(JSON.stringify(idaBis) === JSON.stringify(ida), 'devuelve el mismo resultado');
  check(huella(trasBis, claves) === huella(trasIda, claves), 'no cambió nada');

  // 4) RECHAZO lms
  console.log(`\n▶ RECHAZO lms ${DESTINO} → ${ORIGEN} con ${claveNoLibre}`);
  let codigo = 'sin error';
  try {
    await transferir({ ...base, toTeacherId: ORIGEN, slots: clavesRechazo.map(toSlot), motivo: 'autoservicio', origen: 'lms', idempotencyKey: `${run}-lms` });
  } catch (err) {
    codigo = err instanceof TransferenciaError ? err.codigo : String(err);
    console.log(`   respuesta: ${err instanceof TransferenciaError ? err.message : String(err)}`);
  }
  const trasRechazo = await foto(asg0.id);
  check(codigo === 'SLOT_NO_DISPONIBLE', `rechazado con SLOT_NO_DISPONIBLE (llegó: ${codigo})`);
  check(huella(trasRechazo, claves) === huella(trasIda, claves), 'el rechazo no cambió nada');

  // 5) VUELTA
  console.log(`\n▶ VUELTA ${DESTINO} → ${ORIGEN}`);
  const vuelta = await transferir({ ...base, toTeacherId: ORIGEN, slots: clavesOriginales.map(toSlot), motivo: 'reorg', origen: 'script', idempotencyKey: `${run}-vuelta` });
  const despues = await foto(asg0.id);
  mostrar('DESPUÉS DE LA VUELTA', despues, claves);
  check(huella(despues, claves) === huella(antes, claves), 'asignación y casillas iguales que ANTES');
  check(vuelta.efectosFallidos.length === 0, `sin efectos fallidos (${vuelta.efectosFallidos.join(', ') || 'ninguno'})`);
  console.log('   (Cambian a propósito: created_at, teacher_since, meet_link y los avisos de presentación, que se reinician en cada cambio.)');

  // 6) transfer_requests
  const regs = (await leerRegistros(asg0.id)).filter(r => r.idempotency_key?.startsWith(run));
  console.log('\n── transfer_requests de esta prueba');
  for (const r of regs) console.log(`   ${r.idempotency_key} · ${r.from_teacher_id} → ${r.to_teacher_id} · ${r.origen}/${r.motivo} · ${r.estado}${r.error ? ` · ${r.error.slice(0, 90)}` : ''}`);
  const porClave = (suf: string) => regs.find(r => r.idempotency_key === `${run}-${suf}`);
  check(regs.length === 3, `3 filas (ida, rechazo, vuelta); la repetición no añade (hay ${regs.length})`);
  check(porClave('ida')?.estado === 'ok', 'ida: ok');
  check(porClave('lms')?.estado === 'error' && (porClave('lms')?.error ?? '').startsWith('SLOT_NO_DISPONIBLE'), 'rechazo: error SLOT_NO_DISPONIBLE');
  check(porClave('vuelta')?.estado === 'ok', 'vuelta: ok');
} catch (err) {
  console.error(`\n❌ La prueba se cortó: ${err instanceof TransferenciaError ? `[${err.codigo}] ${err.userMessage}` : String(err)}`);
  mostrar('ESTADO AL CORTARSE', await foto(asg0.id), claves);
  console.error('\nNo se intentó arreglar nada automáticamente. Revisa el estado de arriba (y la campanita del admin) antes de repetir.');
  process.exit(1);
}

const fallos = checks.filter(c => !c.ok);
console.log(`\n${fallos.length ? `❌ ${fallos.length} comprobación(es) fallida(s) de ${checks.length}` : `✅ Las ${checks.length} comprobaciones pasaron`}\n`);
process.exit(fallos.length ? 1 : 0);
