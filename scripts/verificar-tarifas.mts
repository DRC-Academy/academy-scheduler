// Desglose del mes por BUCKET de tarifa (plan × antigüedad), que es como se
// liquida a mano. Mismas filas que finanzas: no se recalcula nada.
import { readFileSync } from 'node:fs';
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}
const { loadPayoutDataset } = await import('@/lib/externalPayouts');
const { calculateTeacherFinance } = await import('@/lib/finance');
const { gridOccupancyOfTeacher } = await import('@/lib/teacherClasses');

const MES = process.env.MES ?? '2026-08';
const T = process.env.TEACHER ?? 't30';
const ds = await loadPayoutDataset(true);
const teacher = ds.teachers.find(t => t.id === T)!;
const fin = calculateTeacherFinance({
  teacherId: teacher.id, teacherName: teacher.name, monthYear: MES,
  assignments: ds.assignments, joinLogs: ds.joinLogs, classRecords: ds.classRecords,
  classAnalyses: ds.classAnalyses, rates: ds.rates, scoringEvents: ds.scoringEvents,
  students: ds.students, manualApprovals: ds.manualApprovals,
  payment: ds.payments.find(p => p.teacherId === T && p.monthYear === MES) ?? null,
  gridOccupancy: gridOccupancyOfTeacher(teacher),
});

// El bucket se deduce de la tarifa aplicada + la categoría del plan, que es
// exactamente lo que decidió el importe de la fila.
const bucket = (r: { planCategory: string; antiquityDays: number }) =>
  `${r.planCategory === 'examenes' ? 'examenes' : 'normales'}|${r.antiquityDays < 30 ? 1 : 2}`;

for (const estado of ['pagable', 'a_revisar'] as const) {
  const rows = fin.rows.filter(r => r.status === estado);
  console.log(`\n════ ${estado.toUpperCase()} — ${rows.length} filas ════`);
  const g = new Map<string, { u: number; eur: number; rate: Set<number>; alumnos: Map<string, number> }>();
  for (const r of rows) {
    const k = bucket(r);
    const e = g.get(k) ?? { u: 0, eur: 0, rate: new Set<number>(), alumnos: new Map<string, number>() };
    e.u += r.billingUnits; e.eur += r.rate * r.billingUnits; e.rate.add(r.rate);
    e.alumnos.set(r.studentName, (e.alumnos.get(r.studentName) ?? 0) + r.billingUnits);
    g.set(k, e);
  }
  let tot = 0, totU = 0;
  for (const k of ['normales|1', 'normales|2', 'examenes|1', 'examenes|2']) {
    const e = g.get(k);
    if (!e) { console.log(`  Tarifa ${k.split('|')[1]} ${k.split('|')[0]}: 0 clases — 0,00 €`); continue; }
    tot += e.eur; totU += e.u;
    console.log(`  Tarifa ${k.split('|')[1]} ${k.split('|')[0]}: ${e.u} clases × ${[...e.rate].join('/')} € = ${e.eur.toFixed(2)} €`);
    for (const [a, n] of [...e.alumnos].sort((x, y) => y[1] - x[1])) console.log(`        ${a}: ${n}`);
  }
  console.log(`  TOTAL ${estado}: ${totU} clases — ${tot.toFixed(2)} €`);
}
console.log(`\nComprobación: montoPagable=${fin.montoPagable} € | montoARevisar=${fin.montoARevisar} € | TOTAL A PAGAR=${fin.totalAPagar} €`);
