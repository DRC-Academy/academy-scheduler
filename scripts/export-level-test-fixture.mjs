// Exporta los tests de nivel COMPLETADOS de producción a un fixture local, para
// poder recalcular puntajes sin volver a tocar la base.
//   node scripts/export-level-test-fixture.mjs
//
// SOLO LECTURA. Y deliberadamente SIN DATOS PERSONALES: no se piden nombre,
// email, teléfono ni `written_response`. Para recalcular la nota de lectura hace
// falta la dificultad y el acierto de cada respuesta, nada más. El fixture se
// versiona en el repo, así que no puede llevar nada de un alumno real.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

const { data: sessions, error: se } = await sb
  .from('level_test_sessions')
  .select('id, status, reading_score, writing_score, overall_score, cefr_level, current_difficulty, completed_at')
  .eq('status', 'completed')
  .order('completed_at', { ascending: true });
if (se) { console.error('Error al leer las sesiones:', se.message); process.exit(1); }

const { data: answers, error: ae } = await sb
  .from('level_test_answers')
  .select('session_id, section, difficulty, is_correct, ai_score, answered_at')
  .order('answered_at', { ascending: true });
if (ae) { console.error('Error al leer las respuestas:', ae.message); process.exit(1); }

const porSesion = new Map();
for (const a of answers ?? []) {
  if (!porSesion.has(a.session_id)) porSesion.set(a.session_id, []);
  porSesion.get(a.session_id).push({
    section: a.section,
    difficulty: a.difficulty,
    is_correct: a.is_correct,
    ai_score: a.ai_score,
  });
}

// Los ids reales tampoco hacen falta: se sustituyen por t01, t02… El orden es el
// de finalización, así que el fixture es estable entre exportaciones.
const tests = (sessions ?? []).map((s, i) => ({
  id: `t${String(i + 1).padStart(2, '0')}`,
  stored: {
    reading_score: s.reading_score,
    writing_score: s.writing_score,
    overall_score: s.overall_score,
    cefr_level: s.cefr_level,
  },
  final_difficulty: s.current_difficulty,
  answers: porSesion.get(s.id) ?? [],
}));

mkdirSync('fixtures', { recursive: true });
const out = {
  _comment: 'Generado por scripts/export-level-test-fixture.mjs. SIN datos personales: solo dificultades, aciertos y puntajes. No editar a mano.',
  exported_count: tests.length,
  tests,
};
writeFileSync('fixtures/level-tests-reales.json', JSON.stringify(out, null, 2) + '\n');

console.log(`Exportados ${tests.length} tests completados a fixtures/level-tests-reales.json`);
for (const t of tests) {
  const lectura = t.answers.filter(a => a.section !== 'writing').length;
  console.log(`  ${t.id}: ${t.answers.length} respuestas (${lectura} de lectura) · guardado ${t.stored.cefr_level ?? '—'} (${t.stored.overall_score ?? '—'})`);
}
