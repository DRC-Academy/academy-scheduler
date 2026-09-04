// Alumnos de un profesor en un mes: los que tienen alguna clase en finanzas y,
// aparte, los que solo tienen registros sin ingreso (que no entran al pago).
import { readFileSync } from 'node:fs';
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}
const { loadPayoutDataset } = await import('@/lib/externalPayouts');
const { calculateTeacherFinance, studentQuotaOf } = await import('@/lib/finance');
const { gridOccupancyOfTeacher } = await import('@/lib/teacherClasses');

const MES = process.env.MES ?? '2026-08';
const BUSCA = (process.env.PROF ?? 'jimena').toLowerCase();
const norm = (s: string) => (s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim().replace(/\s+/g, ' ');

const ds = await loadPayoutDataset(true);
const cands = ds.teachers.filter(t => norm(t.name).includes(BUSCA));
console.log('Profesores que coinciden:', cands.map(t => `${t.name} (${t.id})${t.archivedAt ? ' [ARCHIVADO]' : ''}`).join(' | ') || 'ninguno');

for (const teacher of cands) {
  const fin = calculateTeacherFinance({
    teacherId: teacher.id, teacherName: teacher.name, monthYear: MES,
    assignments: ds.assignments, joinLogs: ds.joinLogs, classRecords: ds.classRecords,
    classAnalyses: ds.classAnalyses, rates: ds.rates, scoringEvents: ds.scoringEvents,
    students: ds.students, manualApprovals: ds.manualApprovals,
    payment: ds.payments.find(p => p.teacherId === teacher.id && p.monthYear === MES) ?? null,
    gridOccupancy: gridOccupancyOfTeacher(teacher),
  });
  console.log(`\n════ ${teacher.name} (${teacher.id}) — ${MES} ════`);
  console.log(`pagable=${fin.totalPagable} u | sesiones=${fin.totalSesiones} | a_revisar=${fin.totalARevisar} | excede=${fin.totalExcedeLimite} | TOTAL=${fin.totalAPagar} € | pago=${fin.paymentStatus}`);

  const porAlumno = new Map<string, typeof fin.rows>();
  for (const r of fin.rows) porAlumno.set(norm(r.studentName), [...(porAlumno.get(norm(r.studentName)) ?? []), r]);

  console.log(`\nAlumnos con clases en finanzas: ${porAlumno.size}`);
  console.log('nº | alumno | plan | cat | h/sem | tarifa | clases(u) | pagables | pend.transcript | cupo | susc | €');
  let i = 0;
  for (const [k, rows] of [...porAlumno.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const q = studentQuotaOf(fin, rows[0].studentName);
    const u = rows.reduce((s, r) => s + r.billingUnits, 0);
    const pag = rows.filter(r => r.status === 'pagable');
    const rev = rows.filter(r => r.status === 'a_revisar').reduce((s, r) => s + r.billingUnits, 0);
    const eur = pag.reduce((s, r) => s + r.rate * r.billingUnits, 0);
    const subs = [...new Set(rows.map(r => r.subscriptionStatus ?? 'sin dato'))].join(',');
    console.log(`${String(++i).padStart(2)} | ${rows[0].studentName} | ${rows[0].plan.slice(0, 45)} | ${rows[0].planLabel} | ${rows[0].weeklyHours}h | ${[...new Set(rows.map(r => r.rate))].join('/')}€ | ${u} | ${pag.reduce((s, r) => s + r.billingUnits, 0)} | ${rev} | ${q?.used}/${q?.limit ?? '∞'} | ${subs} | ${eur.toFixed(2)}€`);
  }

  // Alumnos con registros del mes que NO llegaron a finanzas (sin ingreso).
  const enMes = (d?: string | null) => !!d && String(d).slice(0, 7) === MES;
  const conRegistro = new Set(ds.classRecords.filter(r => r.teacherId === teacher.id && enMes(r.classDate)).map(r => norm(r.studentName)));
  const soloRegistro = [...conRegistro].filter(n => !porAlumno.has(n));
  if (soloRegistro.length) console.log(`\n⚠️ Con registros pero SIN ninguna clase en finanzas: ${soloRegistro.join(' · ')}`);

  // Alumnos vinculados hoy que no dieron ninguna clase en el mes.
  const asig = ds.assignments.filter(a => a.teacherId === teacher.id && (a.status ?? 'active') === 'active');
  const sinClase = [...new Set(asig.map(a => a.studentName))].filter(n => !porAlumno.has(norm(n)));
  console.log(`\nAlumnos vinculados hoy: ${[...new Set(asig.map(a => a.studentName))].length}` + (sinClase.length ? ` — SIN clases en ${MES}: ${sinClase.join(' · ')}` : ''));
}
