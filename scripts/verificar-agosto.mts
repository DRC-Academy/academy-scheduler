// Verificación puntual: tarifas, cupo y suscripción de un grupo de alumnos en un
// mes. Reusa el MISMO cálculo que finanzas (calculateTeacherFinance) vía el
// dataset de payouts, para no reimplementar ninguna regla.
//   npx tsx scripts/verificar-agosto.mts
import { readFileSync } from 'node:fs';
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}

const { loadPayoutDataset } = await import('@/lib/externalPayouts');
const { calculateTeacherFinance, studentQuotaOf } = await import('@/lib/finance');
const { gridOccupancyOfTeacher } = await import('@/lib/teacherClasses');
const { accesoConocidoDe } = await import('@/lib/externalPayouts');

const MES = process.env.MES ?? '2026-08';
const NOMBRES = [
  'Lucia Granado', 'Ingrid Lopez', 'Junior Pilligua Anchundia', 'Matilde Maria García',
  'Armando Álvarez González', 'Laura Catena Liebanas', 'Carmen Gonzalez Fernandez',
  'David Bolivar Perez', 'Luis Gonzaga Garcia', 'Pedro Montenegro Rubio',
];
const norm = (s: string) => (s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim().replace(/\s+/g, ' ');

const ds = await loadPayoutDataset(true);
console.log(`dataset: ${ds.teachers.length} profes, ${ds.assignments.length} assignments, ${ds.joinLogs.length} joinLogs, ${ds.classRecords.length} records`);

// ¿De qué profesor son? Se busca por assignment (cualquier status).
const votos = new Map<string, number>();
const encontrados = new Map<string, string[]>();
for (const n of NOMBRES) {
  const as = ds.assignments.filter(a => norm(a.studentName).includes(norm(n)) || norm(n).includes(norm(a.studentName)));
  encontrados.set(n, as.map(a => `${a.studentName} | ${a.teacherName} | status=${a.status ?? 'active'} | ${a.weeklyHours}h | plan=${a.plan} | obj=${a.objetivo} | slots=${(a.slots ?? []).map(s => s.day + ' ' + s.hour).join(', ')}`));
  for (const a of as) votos.set(a.teacherId, (votos.get(a.teacherId) ?? 0) + 1);
}
console.log('\n── Assignments encontrados ──');
for (const [n, v] of encontrados) console.log(`  ${n}: ${v.length ? v.join('\n      ') : '❌ SIN ASSIGNMENT'}`);

const [teacherId] = [...votos.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
const teacher = ds.teachers.find(t => t.id === teacherId);
console.log(`\nProfesor dominante: ${teacher?.name} (${teacherId}) — ${votos.get(teacherId!)}/${NOMBRES.length} coincidencias`);
console.log('Reparto de votos:', [...votos.entries()].map(([id, n]) => `${ds.teachers.find(t => t.id === id)?.name ?? id}=${n}`).join(', '));

console.log('\n── TARIFAS (finance_rates) ──');
for (const r of ds.rates) console.log(`  ${r.planType} / ${r.tier}: ${r.rate} €`);

if (!teacher) { console.log('sin profesor'); process.exitCode = 1; }
else {
  const payment = ds.payments.find(p => p.teacherId === teacher.id && p.monthYear === MES) ?? null;
  const fin = calculateTeacherFinance({
    teacherId: teacher.id, teacherName: teacher.name, monthYear: MES,
    assignments: ds.assignments, joinLogs: ds.joinLogs, classRecords: ds.classRecords,
    classAnalyses: ds.classAnalyses, rates: ds.rates, scoringEvents: ds.scoringEvents,
    students: ds.students, manualApprovals: ds.manualApprovals, payment,
    gridOccupancy: gridOccupancyOfTeacher(teacher),
  });

  console.log(`\n════ ${teacher.name} — ${MES} ════`);
  console.log(`pagable=${fin.totalPagable} u | sesiones=${fin.totalSesiones} | a_revisar=${fin.totalARevisar} | excede_limite=${fin.totalExcedeLimite} | excede_tipo=${fin.totalExcedeLimiteTipo} | no_cobrable=${fin.totalNoCobrable}`);
  console.log(`montoPagable=${fin.montoPagable} € | montoARevisar=${fin.montoARevisar} € | retenido=${fin.montoRetenido} € | bonus=${fin.bonusFromScoring} | penal=${fin.penaltiesFromScoring} | TOTAL A PAGAR=${fin.totalAPagar} €`);
  console.log(`estado pago: ${fin.paymentStatus}${fin.paidAt ? ' @ ' + fin.paidAt : ''}`);
  console.log(`subs no-active entre pagables: ${JSON.stringify(fin.payableSubStatuses)} | hasInactiveSubPayable=${fin.hasInactiveSubPayable}`);

  // Agrupado por alumno
  const porAlumno = new Map<string, typeof fin.rows>();
  for (const r of fin.rows) {
    const k = norm(r.studentName);
    porAlumno.set(k, [...(porAlumno.get(k) ?? []), r]);
  }
  console.log('\n── DETALLE POR ALUMNO (todas las filas del mes de este profe) ──');
  for (const [k, rows] of [...porAlumno.entries()].sort()) {
    const q = studentQuotaOf(fin, rows[0].studentName);
    const st = ds.students.find(s => norm(s.name) === k);
    const sum = (f: (r: typeof rows[number]) => number) => rows.reduce((a, r) => a + f(r), 0);
    const pag = rows.filter(r => r.status === 'pagable');
    const monto = pag.reduce((a, r) => a + r.rate * r.billingUnits, 0);
    console.log(`\n■ ${rows[0].studentName}`);
    console.log(`   plan="${rows[0].plan}" | cat=${rows[0].planLabel} | ${rows[0].weeklyHours}h/sem | tarifa=${[...new Set(rows.map(r => r.rate))].join('/')} € | antig=${[...new Set(rows.map(r => r.antiquityDays))].sort((a,b)=>a-b).slice(0,1)}→${[...new Set(rows.map(r => r.antiquityDays))].sort((a,b)=>b-a).slice(0,1)} d`);
    console.log(`   CUPO: ${q?.used} de ${q?.limit ?? 'sin límite'}   | filas=${rows.length} | unidades=${sum(r => r.billingUnits)} | recuperación=${sum(r => r.recoveryUnits)}`);
    const porEstado = rows.reduce<Record<string, number>>((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + r.billingUnits; return acc; }, {});
    console.log(`   estados (unidades): ${JSON.stringify(porEstado)}  → PAGA ${monto.toFixed(2)} €`);
    const subs = rows.reduce<Record<string, number>>((acc, r) => { const s = r.subscriptionStatus ?? '(sin dato)'; acc[s] = (acc[s] ?? 0) + 1; return acc; }, {});
    console.log(`   suscripción en las clases: ${JSON.stringify(subs)}`);
    if (st) console.log(`   ficha: acceso=${accesoConocidoDe(st, MES + '-31')} | manual_until=${st.manualActiveUntil ?? '-'} | oritalk=${st.isOritalk ?? false}/${st.oritalkUntil ?? '-'} | productType=${st.productType ?? '-'} | plan ficha="${st.plan}"`);
    for (const r of rows.sort((a, b) => a.date.localeCompare(b.date))) {
      console.log(`     ${r.date} ${r.hour} ${r.classType.padEnd(16)} ${r.status.padEnd(19)} u=${r.billingUnits} rec=${r.recoveryUnits} €${(r.rate * r.billingUnits).toFixed(2)} tx=${r.transcriptState} sub=${r.subscriptionStatus ?? '-'} ${r.manuallyApproved ? 'APROBADA-MANUAL' : ''}`);
    }
  }
}
