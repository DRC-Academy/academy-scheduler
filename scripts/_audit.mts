import { readFileSync, existsSync, writeFileSync } from 'node:fs';
for (const line of existsSync('.env.local') ? readFileSync('.env.local', 'utf8').split('\n') : []) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}
const { supabase } = await import('@/lib/supabase');
const { parseTurns, locateExcerpt } = await import('@/lib/fluency');
const { speakerMatchesName } = await import('@/lib/testimonials');
const { data: cands } = await supabase.from('testimonial_candidates').select('id, student_group, student_id, student_name, status, discarded_by, ai_review_status, clips, ai_reason').order('student_name');
const c: Record<string, number> = {};
for (const r of cands ?? []) { const k = `${r.status}/${r.discarded_by ?? '-'}/${r.ai_review_status}`; c[k] = (c[k] ?? 0) + 1; }
console.log('estado', c);
const tn = new Map<string, string>();
const out: any[] = [];
for (const r of (cands ?? []).filter(r => r.clips && r.status !== 'descartado')) {
  const row: any = { id: r.id, alumno: r.student_name, sid: r.student_id, status: r.status };
  for (const [k, clip] of [['malo', r.clips.malos[0]], ['bueno', r.clips.buenos[0]]] as const) {
    const { data: ca } = await supabase.from('class_analyses').select('transcript, teacher_id, student_id, student_name').eq('id', clip.analysisId).maybeSingle();
    if (!tn.has(ca!.teacher_id)) { const { data: t } = await supabase.from('teachers').select('name').eq('id', ca!.teacher_id).maybeSingle(); tn.set(ca!.teacher_id, t?.name); }
    const turns = parseTurns(ca!.transcript ?? '');
    const loc = locateExcerpt(turns, clip.excerpt);
    const speakers = [...new Set(turns.map(t => t.speaker))];
    row[k] = { fecha: clip.classDate, profe: tn.get(ca!.teacher_id), caAlumno: ca!.student_name, caSid: ca!.student_id, hablante: loc ? turns[loc.turnIndex].speaker : '(cita no encontrada)', hablantes: speakers, cita: clip.excerpt.slice(0, 70) };
  }
  out.push(row);
}
writeFileSync(process.env.TEMP + '/audit.json', JSON.stringify(out, null, 1));
for (const r of out) {
  const ok = (s: any) => !/@/.test(s.hablante) && speakerMatchesName(s.hablante, r.alumno);
  console.log([r.alumno, r.malo.profe, r.bueno.profe, r.malo.hablante, r.bueno.hablante, ok(r.malo) && ok(r.bueno) ? 'SI' : 'NO', r.malo.caAlumno === r.alumno && r.bueno.caAlumno === r.alumno ? '' : `ca:${r.malo.caAlumno}/${r.bueno.caAlumno}`, r.malo.hablantes.length + '/' + r.bueno.hablantes.length].join(' | '));
}
