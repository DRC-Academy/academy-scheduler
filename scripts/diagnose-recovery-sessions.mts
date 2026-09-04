// Diagnóstico de las sesiones de 2h que mezclan clase normal + recuperación.
//   npx tsx scripts/diagnose-recovery-sessions.mts
//
// SOLO LEE. Busca en los calendarios reales los casos en los que una hora de
// recuperación quedó pegada a otra hora del MISMO alumno el MISMO día, y para
// cada caso pregunta a `calculateTeacherFinance` —la única fuente del pago— qué
// salió: cuántas horas cobra, cuántas de esas son recuperación y qué clase
// perdida saldan.
//
// También lista lo que NO se debe fundir (alumnos distintos u horas sueltas) para
// comprobar que sigue saliendo como clases separadas.

import { readFileSync } from 'node:fs';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}

const {
  dbGetTeachers, dbGetStudents, dbGetAssignments, dbGetScoringEvents,
  dbGetFinanceRates, dbGetFinancePayments, dbGetClassRecords, dbGetClassJoinLogs,
  dbGetManualApprovals, dbGetClassTranscripts,
} = await import('@/lib/db');
const { calculateTeacherFinance, rowHoursLabel } = await import('@/lib/finance');
const { gridOccupancyOfTeacher } = await import('@/lib/teacherClasses');

const nk = (s?: string | null): string => (s ?? '').trim().toLowerCase();
const hnum = (h?: string): number => parseInt((h ?? '').trim(), 10);

console.log('Leyendo la base…');
const [
  teachers, students, assignments, scoringEvents,
  rates, payments, classRecords, joinLogs, manualApprovals, classAnalyses,
] = await Promise.all([
  dbGetTeachers({ includeArchived: true }), dbGetStudents(), dbGetAssignments(), dbGetScoringEvents(),
  dbGetFinanceRates(), dbGetFinancePayments(), dbGetClassRecords(), dbGetClassJoinLogs(),
  dbGetManualApprovals(), dbGetClassTranscripts(),
]);

console.log(`  profesores ${teachers.length} · alumnos ${students.length} · assignments ${assignments.length}`);
console.log(`  class_records ${classRecords.length} · accesos ${joinLogs.length} · transcripts ${classAnalyses.length}`);

// ── 1. Candidatos en el CALENDARIO ───────────────────────────────────────────
type Caso = {
  teacherId: string; teacherName: string; student: string;
  date: string; recHour: string; recoveryFor?: string;
  vecino: 'normal recurrente' | 'otra recuperación'; vecinoHour: string;
};

const casos: Caso[] = [];
const recuperacionesTotales: Array<{ teacher: string; student: string; date: string; hour: string; recoveryFor?: string }> = [];

for (const t of teachers) {
  // Horas recurrentes por alumno+día (lo mismo que lee gridOccupancyOfTeacher).
  const recurrentes = new Map<string, number[]>();
  for (const c of t.upcomingClasses ?? []) {
    const h = hnum(c.time);
    if (!Number.isFinite(h)) continue;
    const k = `${nk(c.studentName)}|${c.day}`;
    const arr = recurrentes.get(k);
    if (arr) arr.push(h); else recurrentes.set(k, [h]);
  }
  const recuperaciones = t.recoveryCells ?? [];
  for (const r of recuperaciones) {
    recuperacionesTotales.push({ teacher: t.name, student: r.studentName, date: r.date, hour: r.hour, recoveryFor: r.recoveryFor });
  }

  for (const r of recuperaciones) {
    const h = hnum(r.hour);
    if (!Number.isFinite(h)) continue;
    const recur = recurrentes.get(`${nk(r.studentName)}|${r.day}`) ?? [];
    for (const vecina of [h - 1, h + 1]) {
      if (recur.includes(vecina)) {
        casos.push({
          teacherId: t.id, teacherName: t.name, student: r.studentName,
          date: r.date, recHour: r.hour, recoveryFor: r.recoveryFor,
          vecino: 'normal recurrente', vecinoHour: `${String(vecina).padStart(2, '0')}:00`,
        });
      }
      const otraRec = recuperaciones.find(o =>
        nk(o.studentName) === nk(r.studentName) && o.date === r.date && hnum(o.hour) === vecina);
      if (otraRec) {
        casos.push({
          teacherId: t.id, teacherName: t.name, student: r.studentName,
          date: r.date, recHour: r.hour, recoveryFor: r.recoveryFor,
          vecino: 'otra recuperación', vecinoHour: otraRec.hour,
        });
      }
    }
  }
}

console.log(`\n── CELDAS DE RECUPERACIÓN EN LOS CALENDARIOS ─────────────────────`);
console.log(`  total: ${recuperacionesTotales.length}`);
console.log(`  con fecha de clase perdida (recovery_for): ${recuperacionesTotales.filter(r => r.recoveryFor).length}`);
console.log(`  pegadas a otra hora del mismo alumno: ${casos.length}`);

if (recuperacionesTotales.length) {
  console.log('\n  Últimas 12 recuperaciones por fecha:');
  for (const r of [...recuperacionesTotales].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12)) {
    console.log(`    ${r.date} ${r.hour}  ${r.student.padEnd(26)} ${r.teacher.padEnd(14)} recupera: ${r.recoveryFor ?? '—'}`);
  }
}

// ── 2. Qué dice FINANZAS de cada caso ────────────────────────────────────────
const cache = new Map<string, ReturnType<typeof calculateTeacherFinance>>();
function financeOf(teacherId: string, teacherName: string, monthYear: string) {
  const k = `${teacherId}|${monthYear}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const t = teachers.find(x => x.id === teacherId);
  const r = calculateTeacherFinance({
    teacherId, teacherName, monthYear,
    assignments, joinLogs, classRecords, classAnalyses, rates, scoringEvents,
    students, manualApprovals,
    payment: payments.find(p => p.teacherId === teacherId && p.monthYear === monthYear) ?? null,
    gridOccupancy: gridOccupancyOfTeacher(t),
  });
  cache.set(k, r);
  return r;
}

console.log(`\n── CASOS REALES: recuperación pegada a otra hora del mismo alumno ──`);
if (!casos.length) console.log('  (ninguno en los calendarios de hoy)');

// Un caso por (profesor, alumno, fecha): las dos direcciones detectan el mismo bloque.
const vistos = new Set<string>();
for (const c of casos.sort((a, b) => b.date.localeCompare(a.date))) {
  const k = `${c.teacherId}|${nk(c.student)}|${c.date}`;
  if (vistos.has(k)) continue;
  vistos.add(k);

  const mes = c.date.slice(0, 7);
  const fin = financeOf(c.teacherId, c.teacherName, mes);
  const filas = fin.rows.filter(r => r.date === c.date && nk(r.studentName) === nk(c.student));

  console.log(`\n  ▸ ${c.teacherName} · ${c.student} · ${c.date}`);
  console.log(`    calendario: ${c.vecinoHour} (${c.vecino}) + ${c.recHour} (recuperación de ${c.recoveryFor ?? '— sin fecha —'})`);
  if (!filas.length) {
    console.log(`    finanzas (${mes}): SIN FILA — no hubo acceso ni registro de clase ese día`);
    continue;
  }
  for (const f of filas) {
    console.log(`    finanzas (${mes}): ${rowHoursLabel(f)} · cobra ${f.billingUnits}h · de esas ${f.recoveryUnits}h son recuperación`);
    console.log(`      salda: ${f.recoveryForDates.length ? f.recoveryForDates.join(', ') : '—'}`);
    console.log(`      estado ${f.status} · transcript ${f.hasTranscript ? 'sí' : 'NO'} · tarifa ${f.rate} €/h → ${f.rate * f.billingUnits} € · duración desde ${f.durationSource}`);
  }
}

// ── 3. Contraprueba: TODAS las filas del mes con recuperación ────────────────
const meses = [...new Set(classRecords.map(r => r.classDate.slice(0, 7)))].sort().slice(-3);
console.log(`\n── CONTRAPRUEBA en ${meses.join(', ')} ─────────────────────────────`);
let mixtas = 0, purasRec = 0, normales2h = 0, sospechosas = 0;
for (const t of teachers) {
  for (const mes of meses) {
    const fin = financeOf(t.id, t.name, mes);
    for (const f of fin.rows) {
      if (f.recoveryUnits > 0 && f.recoveryUnits < f.billingUnits) {
        mixtas++;
        console.log(`  MIXTA   ${f.date} ${f.studentName.padEnd(24)} ${t.name.padEnd(12)} ${f.billingUnits}h cobra / ${f.recoveryUnits}h recupera → ${f.recoveryForDates.join(',') || '—'}`);
      } else if (f.recoveryUnits > 0 && f.recoveryUnits === f.billingUnits) {
        purasRec++;
      } else if (f.billingUnits > 1) {
        normales2h++;
      }
      if (f.recoveryUnits > f.billingUnits) { sospechosas++; console.log(`  ¡ERROR! ${f.date} ${f.studentName}: recoveryUnits ${f.recoveryUnits} > billingUnits ${f.billingUnits}`); }
    }
  }
}
console.log(`\n  sesiones mixtas (normal + recuperación): ${mixtas}`);
console.log(`  sesiones de pura recuperación:           ${purasRec}`);
console.log(`  sesiones normales de 2h o más:           ${normales2h}`);
console.log(`  filas con recoveryUnits > billingUnits:  ${sospechosas} (tiene que ser 0)`);

// ── 4. Recuperaciones de 2h: ¿existen hoy? ───────────────────────────────────
console.log(`\n── ¿HAY RECUPERACIONES DE 2 HORAS? ───────────────────────────────`);
const dobles = casos.filter(c => c.vecino === 'otra recuperación');
console.log(`  bloques de dos horas de recuperación seguidas: ${new Set(dobles.map(c => `${c.teacherId}|${nk(c.student)}|${c.date}`)).size}`);
const porClasePerdida = new Map<string, Array<{ date: string; hour: string; teacher: string }>>();
for (const r of recuperacionesTotales) {
  if (!r.recoveryFor) continue;
  const k = `${nk(r.student)}|${r.recoveryFor}`;
  const arr = porClasePerdida.get(k);
  if (arr) arr.push({ date: r.date, hour: r.hour, teacher: r.teacher });
  else porClasePerdida.set(k, [{ date: r.date, hour: r.hour, teacher: r.teacher }]);
}
const repetidas = [...porClasePerdida.entries()].filter(([, v]) => v.length > 1);
console.log(`  clases perdidas con MÁS DE UNA recuperación apuntándoles: ${repetidas.length}`);
for (const [k, v] of repetidas.slice(0, 10)) {
  const [alumno, perdida] = k.split('|');
  console.log(`    ${alumno} · perdió ${perdida} → recupera en ${v.map(x => `${x.date} ${x.hour}`).join(' + ')}`);
}

// ── 5. Saldo por horas: ¿qué clases perdidas quedan a medias? ────────────────
const { recoveryLedgerOf, lostClassHours } = await import('@/lib/recoveryLedger');
const { existingRecoveriesOf } = await import('@/lib/recovery');

console.log(`\n── SALDO DE LAS CLASES PERDIDAS (regla nueva, por horas) ─────────`);
let de1h = 0, de2h = 0, aMedias = 0;
const medias: string[] = [];
for (const t of teachers) {
  const occ = gridOccupancyOfTeacher(t);
  const celdas = (t.recoveryCells ?? []).map(c => ({
    studentName: c.studentName, date: c.date, hour: c.hour, recoveryFor: c.recoveryFor,
  }));
  // Una entrada por clase perdida, no por celda.
  const perdidas = new Set(celdas.filter(c => c.recoveryFor).map(c => `${c.studentName}|${c.recoveryFor}`));
  for (const k of perdidas) {
    const sep = k.lastIndexOf('|');
    const studentName = k.slice(0, sep), lostDate = k.slice(sep + 1);
    const horas = lostClassHours({ studentName, lostDate, classRecords, occupancy: occ });
    if (horas > 1) de2h++; else de1h++;
    const l = recoveryLedgerOf({
      studentName, lostDate, classRecords,
      existing: existingRecoveriesOf({ studentName, classRecords, recoveryCells: celdas }),
      occupancy: occ,
    });
    if (l.pendingHours > 0) {
      aMedias++;
      if (medias.length < 10) medias.push(`    ${t.name.padEnd(12)} ${studentName.padEnd(26)} perdió ${lostDate} (${l.lostHours}h) · repuestas ${l.recoveredHours}h · faltan ${l.pendingHours}h`);
    }
  }
}
console.log(`  clases perdidas con recuperación marcada: ${de1h + de2h}`);
console.log(`    de 1 hora:  ${de1h}`);
console.log(`    de 2 h o más: ${de2h}`);
console.log(`  a medias (les falta alguna hora): ${aMedias}`);
for (const m of medias) console.log(m);
