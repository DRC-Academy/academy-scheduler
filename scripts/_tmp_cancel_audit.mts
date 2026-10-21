import { createClient } from '@supabase/supabase-js';
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const desde = '2026-07-23';
const all = async (t: string, sel: string, f?: (q: any) => any) => {
  const out: any[] = []; for (let i = 0; ; i += 1000) { let q = db.from(t).select(sel).order('id').range(i, i + 999); if (f) q = f(q); const { data, error } = await q; if (error) throw new Error(t + ': ' + error.message); out.push(...data!); if (data!.length < 1000) break; } return out; };
const tea = await all('teachers', 'id, name, is_test');
const nm = new Map(tea.map(t => [t.id, t.name]));
const abs = await all('teacher_absence_alerts', 'id, teacher_id, student_name, class_date, class_hour, status, status_reason, annulled_at, recovery_id, is_recovery, detected_at');
console.log('\n== teacher_absence_alerts (todas) por status:');
const by = (xs: any[], k: (x: any) => string) => { const m = new Map<string, number>(); for (const x of xs) m.set(k(x), (m.get(k(x)) ?? 0) + 1); return Object.fromEntries(m); };
console.log(by(abs, a => a.status), 'rango', abs.map(a => a.class_date).sort()[0], '→', abs.map(a => a.class_date).sort().at(-1));
for (const a of abs.filter(a => a.status === 'posible_ausencia' || a.status === 'anulada' || a.status === 'llego_tarde').sort((a, b) => a.class_date.localeCompare(b.class_date)))
  console.log(`  ${a.status.padEnd(16)} ${a.class_date} ${a.class_hour} ${(nm.get(a.teacher_id) ?? a.teacher_id).padEnd(14)} ${a.student_name} ${a.recovery_id ? 'rec=' + a.recovery_id : ''} ${a.status_reason ?? ''}`);
const cr = await all('class_records', 'id, teacher_id, student_name, class_date, class_time, class_type, comment, reverted_at, created_at', q => q.in('class_type', ['cancelada_por_profesor', 'cancelada_con_preaviso']).gte('class_date', desde));
console.log('\n== class_records cancelaciones del profe desde', desde);
for (const r of cr.sort((a, b) => a.class_date.localeCompare(b.class_date)))
  console.log(`  ${r.class_type.padEnd(22)} ${r.class_date} ${r.class_time ?? '--'} ${(nm.get(r.teacher_id) ?? r.teacher_id).padEnd(14)} ${r.student_name.padEnd(24)} rev=${r.reverted_at ? 'SI' : 'no'} id=${r.id} · ${(r.comment ?? '').slice(0, 60)}`);
const rc = await all('class_recoveries', 'id, group_id, part, parts, teacher_id, student_name, original_date, original_hour, late, status, origin, cancel_record_id, notice_minutes, cancelled_at');
console.log('\n== class_recoveries (todas)');
for (const r of rc.sort((a, b) => a.original_date.localeCompare(b.original_date)))
  console.log(`  ${r.origin.padEnd(22)} late=${r.late ? 'T' : 'F'} ${r.status.padEnd(16)} ${r.original_date} ${r.original_hour} ${(nm.get(r.teacher_id) ?? r.teacher_id).padEnd(14)} ${r.student_name.padEnd(24)} grp=${r.group_id} p${r.part}/${r.parts} cr=${r.cancel_record_id ?? '-'} aviso=${r.notice_minutes}min`);
const se = await all('scoring_events', 'id, teacher_id, event_type, created_at, reverted, note', q => q.in('event_type', ['falta_sin_aviso_penalizacion', 'cancelacion_profesor_penalizacion']).gte('created_at', desde));
console.log('\n== scoring_events multas');
for (const e of se) console.log(`  ${e.event_type} ${e.created_at.slice(0, 10)} ${nm.get(e.teacher_id)} rev=${e.reverted} · ${(e.note ?? '').slice(0, 90)}`);
