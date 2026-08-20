// Recálculo de la nota de LECTURA sobre los tests reales, antes/después de
// anclarla a MCER.
//   npm run recalc:reading
//
// Lee fixtures/level-tests-reales.json (generado por
// scripts/export-level-test-fixture.mjs, sin datos personales). No toca la base
// ni escribe nada: solo imprime la comparación.
//
// ⚠️ Sobre la columna de escritura: el writing_score de estos tests es el que se
// guardó en su momento. Los anteriores a ago/2026 salieron de la escala RELATIVA
// vieja, así que el "overall antes" arrastra ese sesgo. La comparación que vale
// es la de LECTURA; el overall se muestra para ver el efecto de arrastre.

import { readFileSync } from 'node:fs';
import {
  assessReading, legacyReadingScore, calculateOverall, scoreToCefr,
} from '@/lib/levelTest/scoring';
import type { LTAnswerLite } from '@/lib/levelTest/types';

interface FixtureTest {
  id: string;
  stored: { reading_score: number | null; writing_score: number | null; overall_score: number | null; cefr_level: string | null };
  answers: LTAnswerLite[];
}

const fixture = JSON.parse(readFileSync('fixtures/level-tests-reales.json', 'utf8')) as { tests: FixtureTest[] };

const pad = (s: unknown, n: number) => String(s ?? '—').padStart(n);
const padR = (s: unknown, n: number) => String(s ?? '—').padEnd(n);

console.log('\nRECÁLCULO DE LECTURA — antes (relativa) vs. después (anclada a MCER)\n');
console.log('        ┌── ventana (últimas 8) ──┐   ┌──── LECTURA ────┐   ┌──────── RESULTADO ────────┐');
console.log('test    media  banda  prec%  within   antes   después     antes         después      cambio');
console.log('─'.repeat(92));

const conteo = { subeBanda: 0, bajaBanda: 0, igual: 0 };
const distAntes: Record<string, number> = {};
const distDespues: Record<string, number> = {};

for (const t of fixture.tests) {
  const antesLectura = legacyReadingScore(t.answers);
  const ev = assessReading(t.answers);
  if (!ev) { console.log(`${padR(t.id, 8)}(sin respuestas de lectura)`); continue; }

  const writing = t.stored.writing_score;
  const overallAntes = calculateOverall(antesLectura, writing);
  const overallDespues = calculateOverall(ev.score, writing);
  const cefrAntes = scoreToCefr(overallAntes);
  const cefrDespues = scoreToCefr(overallDespues);

  distAntes[cefrAntes] = (distAntes[cefrAntes] ?? 0) + 1;
  distDespues[cefrDespues] = (distDespues[cefrDespues] ?? 0) + 1;

  const orden = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  const delta = orden.indexOf(cefrDespues) - orden.indexOf(cefrAntes);
  if (delta > 0) conteo.subeBanda++; else if (delta < 0) conteo.bajaBanda++; else conteo.igual++;
  const flecha = delta === 0 ? '=' : delta > 0 ? `+${delta}` : `${delta}`;

  console.log(
    `${padR(t.id, 7)} ${pad(ev.meanDifficulty.toFixed(2), 5)}  ${padR(ev.cefr_level, 5)}  ${pad(ev.accuracy, 5)}  ${padR(ev.within_level, 6)}  ` +
    `${pad(antesLectura.toFixed(2), 6)}  ${pad(ev.score.toFixed(2), 7)}     ` +
    `${padR(`${cefrAntes} (${overallAntes.toFixed(2)})`, 13)} ${padR(`${cefrDespues} (${overallDespues.toFixed(2)})`, 13)} ${flecha}`,
  );
}

console.log('─'.repeat(92));
const dist = (d: Record<string, number>) =>
  ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].filter(l => d[l]).map(l => `${l}:${d[l]}`).join('  ') || '—';
console.log(`\nDistribución ANTES:   ${dist(distAntes)}`);
console.log(`Distribución DESPUÉS: ${dist(distDespues)}`);
console.log(`\nSube de banda: ${conteo.subeBanda}   ·   Baja de banda: ${conteo.bajaBanda}   ·   Igual: ${conteo.igual}`);
console.log('\nRecordatorio: el writing de estos tests es el guardado, con la escala vieja en los');
console.log('anteriores a ago/2026. La comparación fiable es la de la columna LECTURA.\n');
