import { readFileSync, writeFileSync } from 'node:fs';
for (const line of readFileSync('.env.local', 'utf8').split('\n')) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, ''); }
const APPLY = process.env.APPLY === '1';
const WHO = 'Administrador (corrección finanzas sep/2026)';
const db = await import('@/lib/db');
const { supabase } = await import('@/lib/supabase');
const { retentionDueIso } = await import('@/lib/retention');
const [teachers, students, assignments, joinLogs, classAnalyses, bonuses] = await Promise.all([db.dbGetTeachers({ includeArchived: true }), db.dbGetStudents(), db.dbGetAssignments(), db.dbGetClassJoinLogs(), db.dbGetClassTranscripts(), db.dbGetTeacherBonuses()]);
const tName = (id: string) => teachers.find(t => t.id === id)?.name ?? id;
const rq: any[] = []; for (let f = 0; ; f += 1000) { const { data } = await supabase.from('class_review_requests').select('*').eq('status', 'aprobada').range(f, f + 999); rq.push(...(data ?? [])); if (!data || data.length < 1000) break; }
const an = new Map((classAnalyses as any[]).map(a => [a.id, a]));
const logs = new Map(joinLogs.map(l => [l.id, l]));

// 1. Reclamos fantasma de septiembre
const phantom = rq.filter(q => {
  if (!q.class_date.startsWith('2026-09')) return false;
  const a: any = an.get(q.analysis_id); if (!a) return false;
  const otro = a.join_log_id ? logs.get(a.join_log_id) : undefined;
  const strict = !!(otro && a.join_log_id !== q.join_log_id && otro.scheduledDate !== q.class_date);
  const laura = q.teacher_id === 't30' && q.class_date === '2026-09-03' && q.analysis_id === 'ca_1789740176762_vlya3u';
  return strict || laura;
});
const legit = new Set(rq.filter(q => !phantom.includes(q)).map(q => q.join_log_id));
const linkedByTranscript = new Set((classAnalyses as any[]).map(a => a.join_log_id).filter(Boolean));
const dropLogIds = [...new Set(phantom.map(q => q.join_log_id as string))]
  .filter(id => id && id.startsWith('cjl_manual_') && !legit.has(id) && !linkedByTranscript.has(id));
// Solo se anulan los reclamos cuyo ingreso fue creado por ellos (y se borra).
for (let i = phantom.length - 1; i >= 0; i--) if (!dropLogIds.includes(phantom[i].join_log_id)) phantom.splice(i, 1);
console.log(`== 1. Reclamos fantasma: ${phantom.length} · ingresos a borrar: ${dropLogIds.length}`);
for (const q of [...phantom].sort((a, b) => (tName(a.teacher_id) + a.class_date).localeCompare(tName(b.teacher_id) + b.class_date)))
  console.log(`   ${tName(q.teacher_id).padEnd(10)} ${q.class_date} ${q.class_time} ${q.student_name} (${q.duration_hours}h) · transcript del ${an.get(q.analysis_id)?.class_date} · ${dropLogIds.includes(q.join_log_id) ? 'borra ingreso' : 'ingreso NO se borra'}`);

// 2. Transcripts a aprobar
const approve = ['ca_1788472041728_jk4kfz', 'ca_1790012734552_fxmdxx', 'ca_1790034719480_y6r33n'];
console.log('== 2. Transcripts a aprobar');
for (const id of approve) { const a: any = an.get(id); console.log(`   ${tName(a.teacher_id)} ${a.class_date} ${a.student_name} (${a.validation_status})`); }

// 3. Aprobación manual Laia 2/9
console.log('== 3. Pagar sin transcript: Wanda · Laia Pi · 2026-09-02');

// 4. Mohamed 2/9 → 2h
const moh = joinLogs.filter(l => l.teacherId === 't21' && l.studentName === 'Mohamed Al Hakeue' && l.scheduledDate === '2026-09-02');
console.log(`== 4. Duración 2h: Mohamed 2/9 (${moh.length} ingresos)`);

// 5. Cupo: fichas inactivas con horas por debajo del plan Woo
const RX = /(\d+)\s*(?:h|horas?|clases?)\s*(?:\/\s*)?seman/i;
const nk = (s: string) => (s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLowerCase();
const stuOf = (a: any) => students.find(s => s.id === a.studentId)
  ?? students.find(s => a.studentEmail && nk(s.email) === nk(a.studentEmail))
  ?? students.find(s => nk(s.name) === nk(a.studentName));
const cupo = assignments.filter(a => a.status === 'inactive' && !/mercedez morilla/i.test(a.studentName)).map(a => {
  const s = stuOf(a); const p = (s?.productName ?? '').trim(); if (!p) return null;
  const m = p.split('—')[0].match(RX) ?? p.split('—').slice(1).join('—').match(RX);
  const h = m ? +m[1] : null;
  return h && h > a.weeklyHours ? { a, h, p } : null;
}).filter(Boolean) as Array<{ a: any; h: number; p: string }>;
console.log(`== 5. Fichas a corregir (${cupo.length})`);
for (const c of cupo) console.log(`   ${tName(c.a.teacherId).padEnd(10)} ${c.a.studentName}: ${c.a.weeklyHours}h → ${c.h}h  [${c.p.split('—')[0].trim()}]`);

// 6. Bonos
const bon = ['00416aa6-14cb-4609-bfd1-55b3ee2eb939', 'd2248bfe-2205-4dff-a055-9b4fa5fdd073'].map(id => assignments.find(a => a.id === id)!);
console.log('== 6. Bonos a marcar pagados (30 € c/u, liquidación 2026-10)');
for (const a of bon) console.log(`   ${tName(a.teacherId)} · ${a.studentName} · cumplió ${retentionDueIso(a as any)} · ya tiene bono: ${bonuses.some(b => b.teacherId === a.teacherId && nk(b.studentName) === nk(a.studentName) && b.status !== 'rechazado')}`);

writeFileSync(process.env.BACKUP!, JSON.stringify({
  at: new Date().toISOString(), requests: phantom, logs: dropLogIds.map(id => logs.get(id)), mohamedLogs: moh,
  analyses: approve.map(id => an.get(id)), assignments: cupo.map(c => ({ id: c.a.id, student: c.a.studentName, weekly_hours: c.a.weeklyHours })),
}, null, 1));
if (!APPLY) { console.log('\n(prueba: no se escribió nada)'); process.exit(0); }

console.log('\n== APLICANDO');
const now = new Date().toISOString();
for (const q of phantom) {
  const { error } = await supabase.from('class_review_requests').update({
    status: 'rechazada', resolved_type: null, reviewed_by: WHO, reviewed_at: now, join_log_id: null,
    review_note: 'Anulada: reutilizaba el transcript de otra clase ya registrada (corrección 05/10/2026).',
  }).eq('id', q.id);
  if (error) throw new Error('req ' + q.id + ': ' + error.message);
}
console.log('   reclamos rechazados', phantom.length);
if (dropLogIds.length) { const { error } = await supabase.from('class_join_logs').delete().in('id', dropLogIds); if (error) throw new Error('logs: ' + error.message); }
console.log('   ingresos borrados', dropLogIds.length);
{ const { error } = await supabase.from('class_analyses').update({ validation_status: 'approved', validation_reviewed_by: WHO, validation_reviewed_at: now }).in('id', approve); if (error) throw new Error(error.message); }
console.log('   transcripts aprobados', approve.length);
await db.dbAddManualApproval('t21', 'Laia Pi', '2026-09-02', WHO, 'a_revisar_aprobado');
console.log('   aprobación manual Laia 2/9');
await db.dbSetJoinLogDuration('t21', 'Mohamed Al Hakeue', '2026-09-02', 2, 'admin');
console.log('   Mohamed 2/9 → 2h');
for (const c of cupo) { const { error } = await supabase.from('assignments').update({ weekly_hours: c.h }).eq('id', c.a.id); if (error) throw new Error(error.message); }
console.log('   fichas corregidas', cupo.length);
for (const a of bon) await db.dbMarkBonusPaid({ existingId: null, teacherId: a.teacherId, assignmentId: a.id, studentName: a.studentName, bonusType: 'retencion_6m', euros: 30, dueDate: retentionDueIso(a as any), paidMonth: '2026-10', paidBy: WHO });
console.log('   bonos pagados', bon.length);
