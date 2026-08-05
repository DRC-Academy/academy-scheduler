// Verificación de la bandeja de riesgo contra la base REAL.
// Replica la derivación de AiRiskTab y comprueba los criterios de aceptación
// que dependen de los datos (no del pintado).
//   node scripts/check-risk-inbox.mjs

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

const norm = s => (s ?? '').trim().toLowerCase();
const isRisk = v => v === 'verde' || v === 'amarillo' || v === 'rojo';
const SEV_OF = { rojo: 'riesgo', amarillo: 'atencion', verde: 'buen' };

const [{ data: profiles }, { data: analyses }, audits, { data: teachers }, { data: assignments }] = await Promise.all([
  sb.from('student_profiles').select('id, student_id, student_name, teacher_id, risk_signal, risk_explanation, risk_updated_at, last_class_analyzed_at, active_intervention, unattended_alerts').order('updated_at', { ascending: false }),
  sb.from('class_analyses').select('id, student_id, teacher_id, student_name, class_number, risk_signal, risk_explanation, analyzed_at, class_date').order('analyzed_at', { ascending: false }).limit(500),
  sb.from('intervention_audits').select('*').order('created_at', { ascending: false }).limit(300).then(r => r.data ?? []),
  sb.from('teachers').select('id, name'),
  sb.from('assignments').select('student_name, teacher_id'),
]);

const latest = new Map();
for (const a of analyses) for (const k of [a.student_id, `name:${norm(a.student_name)}`]) if (k && !latest.has(k)) latest.set(k, a);
const teacherOf = new Map(assignments.map(a => [norm(a.student_name), a.teacher_id]));
const nameOfTeacher = id => teachers.find(t => t.id === id)?.name ?? '—';
const auditsOf = (sid, name) => audits.filter(a => (sid && a.student_id === sid) || (a.student_name && norm(a.student_name) === norm(name)));

const rows = [];
const seen = new Set();
for (const p of profiles) {
  if (!p.student_name) continue;
  const last = (p.student_id && latest.get(p.student_id)) || latest.get(`name:${norm(p.student_name)}`);
  const tid = last?.teacher_id || p.teacher_id || teacherOf.get(norm(p.student_name)) || null;
  const fichaRisk = isRisk(p.risk_signal) ? p.risk_signal : 'verde';
  const claseRisk = isRisk(last?.risk_signal) ? last.risk_signal : null;
  const usar = !!claseRisk && (!p.risk_updated_at || (!!last?.analyzed_at && last.analyzed_at > p.risk_updated_at));
  const mine = auditsOf(p.student_id, p.student_name);
  rows.push({
    id: p.id, name: p.student_name, teacherId: tid, teacherName: nameOfTeacher(tid),
    risk: usar ? claseRisk : fichaRisk, sev: SEV_OF[usar ? claseRisk : fichaRisk],
    evidence: (usar ? last?.risk_explanation : p.risk_explanation) ?? '',
    unattended: Number(p.unattended_alerts ?? 0) || 0,
    active: !!p.active_intervention, audits: mine, confidence: mine[0]?.confidence ?? null,
    hasProfile: true,
  });
  for (const k of [p.student_id, `name:${norm(p.student_name)}`]) if (k) seen.add(k);
}
for (const a of analyses) {
  if (!a.student_name) continue;
  const alias = [a.student_id, `name:${norm(a.student_name)}`].filter(Boolean);
  if (alias.some(k => seen.has(k))) continue;
  for (const k of alias) seen.add(k);
  const tid = a.teacher_id || teacherOf.get(norm(a.student_name)) || null;
  const risk = isRisk(a.risk_signal) ? a.risk_signal : 'verde';
  const mine = auditsOf(a.student_id, a.student_name);
  rows.push({
    id: `analysis:${a.id}`, name: a.student_name, teacherId: tid, teacherName: nameOfTeacher(tid),
    risk, sev: SEV_OF[risk], evidence: a.risk_explanation ?? '',
    unattended: 0, active: false, audits: mine, confidence: mine[0]?.confidence ?? null,
    hasProfile: false,
  });
}

const c = s => rows.filter(r => r.sev === s).length;
const cola  = rows.filter(r => r.sev === 'riesgo' || r.sev === 'atencion');
const verif = rows.filter(r => r.unattended > 0 || r.active || r.audits.length > 0);

console.log(`Alumnos totales: ${rows.length}`);
console.log(`  Tarjetas → En buen camino ${c('buen')} · Atención ${c('atencion')} · Riesgo ${c('riesgo')}`);
console.log(`  Suma = total: ${c('buen') + c('atencion') + c('riesgo') === rows.length ? 'SÍ' : 'NO'}`);
console.log(`Pestañas → Cola ${cola.length} · Verificar ${verif.length}`);

// Sin duplicados dentro de una misma pestaña.
const dup = l => l.length - new Set(l.map(r => r.id)).size;
console.log(`Duplicados en Cola: ${dup(cola)} · en Verificar: ${dup(verif)}`);

// Alumnos que aparecen en las dos pestañas (esperado: son vistas distintas).
const both = cola.filter(r => verif.some(v => v.id === r.id));
console.log(`En ambas pestañas (esperado, son vistas distintas): ${both.length}`);

// Cobertura de los campos que el diseño pide.
const pct = n => `${Math.round((n / Math.max(1, cola.length)) * 100)}%`;
console.log(`\nCobertura en la Cola (${cola.length} filas):`);
console.log(`  con evidencia de la IA : ${cola.filter(r => r.evidence.trim()).length} (${pct(cola.filter(r => r.evidence.trim()).length)})`);
console.log(`  con confianza IA       : ${cola.filter(r => r.confidence).length} (${pct(cola.filter(r => r.confidence).length)})`);
console.log(`  con profesor resuelto  : ${cola.filter(r => r.teacherId).length} (${pct(cola.filter(r => r.teacherId).length)})`);
console.log(`  cerrables (con ficha)  : ${cola.filter(r => r.hasProfile).length} (${pct(cola.filter(r => r.hasProfile).length)})`);

// Longitud de la evidencia: confirma que truncar a 130 hace falta de verdad.
const lens = cola.map(r => r.evidence.length).filter(Boolean).sort((a, b) => a - b);
if (lens.length) {
  console.log(`\nEvidencia: min ${lens[0]} · mediana ${lens[Math.floor(lens.length / 2)]} · max ${lens[lens.length - 1]} caracteres`);
  console.log(`  filas que se truncan a 130: ${lens.filter(l => l > 130).length} de ${lens.length}`);
}

// El select de profesores solo debe listar a los que tienen filas.
const withRows = new Set([...cola, ...verif].map(r => r.teacherId).filter(Boolean));
console.log(`\nProfesores en el select: ${withRows.size} de ${teachers.length} totales`);

// Filas con nombre largo: son las que más riesgo tienen de romper la rejilla.
const longest = [...cola].sort((a, b) => b.name.length - a.name.length).slice(0, 3);
console.log(`Nombres más largos: ${longest.map(r => `"${r.name}" (${r.name.length})`).join(', ')}`);
