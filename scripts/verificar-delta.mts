// Por qué el conteo de una planilla no coincide con el de finanzas: se listan
// los registros CRUDOS de agosto (join logs, class_records, transcripts) por
// alumno, para ver cuál de las tres vías falta en cada clase.
import { readFileSync } from 'node:fs';
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}
const { loadPayoutDataset } = await import('@/lib/externalPayouts');
const MES = '2026-08';
const T = process.env.TEACHER ?? 't30';
const norm = (s: string) => (s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim().replace(/\s+/g, ' ');

const ds = await loadPayoutDataset(true);
const enMes = (d?: string | null) => !!d && String(d).slice(0, 7) === MES;

const logs = ds.joinLogs.filter(l => l.teacherId === T && enMes(l.scheduledDate));
const recs = ds.classRecords.filter(r => r.teacherId === T && enMes(r.classDate));
const anas = (ds.classAnalyses as any[]).filter(a => a.teacher_id === T && enMes(a.class_date));

console.log(`AGOSTO t30 — joinLogs=${logs.length}  classRecords=${recs.length}  transcripts=${anas.length}`);

const claves = new Set<string>();
const k = (n: string, d: string) => `${norm(n)}§${String(d).slice(0, 10)}`;
for (const l of logs) claves.add(k(l.studentName, l.scheduledDate));
for (const r of recs) claves.add(k(r.studentName, r.classDate));
for (const a of anas) claves.add(k(a.student_name, a.class_date));

const porAlumno = new Map<string, string[]>();
for (const c of [...claves].sort()) {
  const [n, d] = c.split("§");
  porAlumno.set(n, [...(porAlumno.get(n) ?? []), d]);
}

let totalCombinado = 0, totalSoloRegistro = 0;
for (const [n, fechas] of [...porAlumno.entries()].sort()) {
  const filas = fechas.sort().map(d => {
    const l  = logs.filter(x => k(x.studentName, x.scheduledDate) === `${n}§${d}`);
    const r  = recs.filter(x => k(x.studentName, x.classDate) === `${n}§${d}`);
    const a  = anas.filter(x => k(x.student_name, x.class_date) === `${n}§${d}`);
    const falta = l.length === 0 ? '  ⚠️ SIN INGRESO (no entra a finanzas)' : '';
    if (l.length === 0) totalSoloRegistro++;
    totalCombinado++;
    return `     ${d}  ingreso=${l.length}  registro=${r.length}${r.length ? '(' + r.map(x => x.classType).join(',') + ')' : ''}  transcript=${a.length}${a.length ? '(' + a.map(x => (x.has_transcript ? 'txt' : 'vacío') + ':' + (x.validation_status ?? '-')).join(',') + ')' : ''}${falta}`;
  });
  console.log(`\n■ ${n}  → ${fechas.length} fechas distintas con algún registro`);
  console.log(filas.join('\n'));
}
console.log(`\nTOTAL fechas alumno×día con algún registro: ${totalCombinado}  (de ellas SIN ingreso: ${totalSoloRegistro})`);
