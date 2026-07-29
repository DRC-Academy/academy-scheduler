// Diagnóstico: assignments HUÉRFANOS (sin ninguna celda en el grid del profesor).
//
// Regla de pertenencia (fuente única de verdad): un alumno pertenece a un
// profesor si y solo si tiene al menos una celda 'ocupado' RECURRENTE en el grid
// de teacher_calendars de ese profesor. Este script no borra ni modifica nada:
// solo lista lo que está descolgado para poder revisarlo a mano.
//
//   node scripts/diagnose-orphan-assignments.mjs
//   node scripts/diagnose-orphan-assignments.mjs --json > huerfanos.json
//
// OJO: el grid identifica al alumno por NOMBRE, no por id (Cell.student es un
// string). Por eso el cruce es por nombre normalizado, igual que hace lib/db.ts.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const asJson = process.argv.includes('--json');

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

async function q(path) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ── misma semántica que lib/cells.ts (baseStateOf / baseStudentOf) ──────────
// 'bloqueado' y 'reprogramada' son marcas de UNA semana: el horario recurrente
// real está en baseState/baseStudent. Sin esto, una recuperación puntual haría
// desaparecer al alumno fijo de ese horario.
const isPuntual = s => s === 'bloqueado' || s === 'reprogramada';

function baseStudentOf(cell) {
  if (!cell) return undefined;
  const state = isPuntual(cell.state) && cell.weekDate ? (cell.baseState ?? 'libre') : cell.state;
  if (state !== 'ocupado') return undefined;
  return isPuntual(cell.state) && cell.weekDate ? (cell.baseStudent ?? cell.student) : cell.student;
}

const normKey = x => String(x ?? '').trim().toLowerCase();

// ── datos ───────────────────────────────────────────────────────────────────
const [teachers, assignments, calendars] = await Promise.all([
  q('teachers?select=id,name,email'),
  q('assignments?select=id,teacher_id,teacher_name,student_id,student_name,student_email,slots,weekly_hours,start_date,created_at,meet_link&order=created_at.desc'),
  q('teacher_calendars?select=teacher_id,grid'),
]);

const teacherById = new Map(teachers.map(t => [t.id, t]));

// teacher_id -> Set(nombre normalizado) presente en su grid
const gridNames = new Map();
const gridSlotCount = new Map();
for (const cal of calendars) {
  const set = new Set();
  const counts = new Map();
  for (const cell of Object.values(cal.grid ?? {})) {
    const name = baseStudentOf(cell)?.trim();
    if (!name) continue;
    const k = normKey(name);
    set.add(k);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  gridNames.set(cal.teacher_id, set);
  gridSlotCount.set(cal.teacher_id, counts);
}

// ── clasificación ───────────────────────────────────────────────────────────
const orphans = [];
const linked = [];
for (const a of assignments) {
  const names = gridNames.get(a.teacher_id) ?? new Set();
  const k = normKey(a.student_name);
  const cells = (gridSlotCount.get(a.teacher_id) ?? new Map()).get(k) ?? 0;
  const row = {
    assignmentId: a.id,
    studentName: a.student_name,
    studentId: a.student_id,
    studentEmail: a.student_email,
    teacherId: a.teacher_id,
    teacherName: teacherById.get(a.teacher_id)?.name ?? a.teacher_name ?? '(profesor inexistente)',
    teacherExists: teacherById.has(a.teacher_id),
    hasCalendar: gridNames.has(a.teacher_id),
    cellsInGrid: cells,
    slotsInAssignment: Array.isArray(a.slots) ? a.slots.length : 0,
    slots: a.slots ?? [],
    weeklyHours: a.weekly_hours,
    startDate: a.start_date,
    createdAt: a.created_at,
    hasMeetLink: !!a.meet_link,
  };
  (names.has(k) ? linked : orphans).push(row);
}

// Al revés: alumnos que SÍ están en el grid pero no tienen assignment.
const missingAssignment = [];
for (const [teacherId, names] of gridNames) {
  const t = teacherById.get(teacherId);
  if (!t) continue;
  const asgNames = new Set(
    assignments.filter(a => a.teacher_id === teacherId).map(a => normKey(a.student_name)),
  );
  for (const k of names) {
    if (!asgNames.has(k)) {
      missingAssignment.push({
        teacherId, teacherName: t.name, studentNameInGrid: k,
        cellsInGrid: (gridSlotCount.get(teacherId) ?? new Map()).get(k) ?? 0,
      });
    }
  }
}

if (asJson) {
  console.log(JSON.stringify({ orphans, missingAssignment, totals: {
    assignments: assignments.length, linked: linked.length, orphans: orphans.length,
    missingAssignment: missingAssignment.length,
  } }, null, 2));
  process.exit(0);
}

// ── informe ─────────────────────────────────────────────────────────────────
const line = '─'.repeat(96);
console.log(`\n${line}\nASSIGNMENTS HUÉRFANOS — sin ninguna celda en el grid de su profesor\n${line}`);
console.log(`assignments totales: ${assignments.length}   con celdas: ${linked.length}   HUÉRFANOS: ${orphans.length}\n`);

if (orphans.length === 0) {
  console.log('  No hay assignments huérfanos.\n');
} else {
  const byTeacher = new Map();
  for (const o of orphans) {
    if (!byTeacher.has(o.teacherName)) byTeacher.set(o.teacherName, []);
    byTeacher.get(o.teacherName).push(o);
  }
  for (const [teacher, list] of [...byTeacher.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const sinCal = list[0] && !list[0].hasCalendar ? '  [el profesor NO tiene grid]' : '';
    console.log(`\n  ${teacher} (${list.length})${sinCal}`);
    for (const o of list.sort((a, b) => a.studentName.localeCompare(b.studentName))) {
      const slots = o.slots.map(s => `${s.day} ${s.hour}`).join(', ') || 'sin slots';
      const flags = [
        !o.teacherExists ? 'PROFE INEXISTENTE' : null,
        o.slotsInAssignment > 0 ? `${o.slotsInAssignment} slot(s) en assignment` : 'sin slots',
        o.hasMeetLink ? 'con meet' : null,
        o.startDate ? `desde ${o.startDate}` : null,
      ].filter(Boolean).join(' · ');
      console.log(`     - ${o.studentName.padEnd(30)} ${flags}`);
      if (o.slotsInAssignment > 0) console.log(`       horario que muestra hoy: ${slots}`);
    }
  }
  console.log(`\n  Estos ${orphans.length} aparecen HOY en Asistencias / Próximas clases / Mis alumnos`);
  console.log('  y dejarán de aparecer con la regla nueva. No se borra nada.');
}

console.log(`\n${line}\nEL CASO INVERSO — en el grid pero sin assignment (no pierden nada, ya se veían)\n${line}`);
if (missingAssignment.length === 0) {
  console.log('  Ninguno.\n');
} else {
  for (const m of missingAssignment.sort((a, b) => a.teacherName.localeCompare(b.teacherName))) {
    console.log(`  ${m.teacherName.padEnd(22)} ${m.studentNameInGrid.padEnd(30)} ${m.cellsInGrid} celda(s)`);
  }
  console.log(`\n  ${missingAssignment.length} alumno(s) en un grid sin assignment: les faltan los metadatos`);
  console.log('  (start_date, meet_link, contador). Revisar en el Setter o con "Crear vínculo".\n');
}
