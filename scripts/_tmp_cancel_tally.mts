import { createClient } from '@supabase/supabase-js';
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const desde = '2026-07-23', hoy = '2026-10-20';
const all = async (t: string, sel: string, f?: (q: any) => any) => { const out: any[] = []; for (let i = 0; ; i += 1000) { let q = db.from(t).select(sel).order('id').range(i, i + 999); if (f) q = f(q); const { data, error } = await q; if (error) throw new Error(t + error.message); out.push(...data!); if (data!.length < 1000) break; } return out; };
const norm = (s: string) => (s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
const tea = await all('teachers', 'id, name, is_test'); const nm = new Map(tea.map(t => [t.id, t.name]));
const test = new Set(tea.filter(t => t.is_test || t.id === 't1').map(t => t.id));
const cr = (await all('class_records', 'id, teacher_id, student_name, class_date, class_time, class_type', q => q.in('class_type', ['cancelada_por_profesor', 'cancelada_con_preaviso']).gte('class_date', desde).lte('class_date', hoy))).filter(r => !test.has(r.teacher_id));
const ev = await all('scoring_events', 'id, teacher_id, event_type, reverted, note', q => q.eq('event_type', 'falta_sin_aviso_penalizacion'));
const evBySlot = new Map<string, boolean[]>();
for (const e of ev) { const m = /alumno (.+), fecha (\d{4}-\d\d-\d\d)/.exec(e.note ?? ''); if (!m) continue; const k = `${e.teacher_id}|${norm(m[1])}|${m[2]}`; (evBySlot.get(k) ?? evBySlot.set(k, []).get(k)!).push(e.reverted === true); }
const rc = (await all('class_recoveries', 'id, group_id, teacher_id, student_name, original_date, original_hour, late, status, origin, cancel_record_id')).filter(r => !test.has(r.teacher_id) && r.original_date >= desde && r.status !== 'anulada');
const per = new Map<string, { tard: string[]; pre: string[]; rev: string[] }>();
const get = (t: string) => per.get(t) ?? per.set(t, { tard: [], pre: [], rev: [] }).get(t)!;
const seen = new Set<string>(); const crIds = new Set(rc.map(r => r.cancel_record_id).filter(Boolean));
for (const r of cr.sort((a, b) => a.class_date.localeCompare(b.class_date))) {
  const slot = `${r.teacher_id}|${norm(r.student_name)}|${r.class_date}|${(r.class_time ?? '').slice(0, 2)}`;
  if (seen.has(slot)) continue; seen.add(slot);
  const lab = `${r.class_date.slice(8)}/${r.class_date.slice(5, 7)} ${r.student_name}`;
  if (r.class_type === 'cancelada_por_profesor') {
    const evs = evBySlot.get(`${r.teacher_id}|${norm(r.student_name)}|${r.class_date}`);
    if (evs && evs.length && evs.every(x => x)) { get(r.teacher_id).rev.push(lab); continue; }
    get(r.teacher_id).tard.push(lab);
  } else get(r.teacher_id).pre.push(lab);
}
const grp = new Set<string>();
for (const r of rc) { if (r.origin === 'ausencia' || grp.has(r.group_id) || (r.cancel_record_id && cr.some(c => c.id === r.cancel_record_id))) continue; grp.add(r.group_id);
  const lab = `${r.original_date.slice(8)}/${r.original_date.slice(5, 7)} ${r.student_name} (recup ${r.origin})`; (r.late ? get(r.teacher_id).tard : get(r.teacher_id).pre).push(lab); }
for (const [t, v] of [...per].sort((a, b) => (b[1].tard.length * 12 + b[1].pre.length * 4) - (a[1].tard.length * 12 + a[1].pre.length * 4))) {
  const pts = v.tard.length * 12 + v.pre.length * 4; const tot = v.tard.length + v.pre.length;
  const nos = v.tard.length >= 2 || tot >= 4;
  console.log(`${(nm.get(t) ?? t).padEnd(12)} tardías=${v.tard.length} preaviso=${v.pre.length} −${pts} ${nos ? 'NO SUGERIBLE' : ''}\n   T: ${v.tard.join(' · ')}\n   P: ${v.pre.join(' · ')}${v.rev.length ? `\n   (revertidas, no cuentan: ${v.rev.join(' · ')})` : ''}`);
}
