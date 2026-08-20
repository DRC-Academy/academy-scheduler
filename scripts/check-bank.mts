// Verificación del banco de preguntas del Test de Nivel.
//   npm run check:bank
//
// Cuenta las preguntas ACTIVAS por (sección, dificultad) y avisa si alguna
// combinación queda por debajo del mínimo que exige su bloque. Sale con código 1
// si falta alguna, para poder encadenarlo después de cargar un seed nuevo.
//
// ── Por qué el mínimo es el BLOQUE ENTERO y no la mitad ──────────────────────
// El escalón mueve la dificultad ±1 en cada respuesta, así que en el medio de la
// escala un alumno oscila entre dos niveles y consume ~la mitad del bloque en
// cada uno. Pero en los topes el clamp lo deja clavado: en dificultad 6, acertar
// lo deja en 6. Un C2 puede consumir el bloque ENTERO en dificultad 6, y un A1
// entero en dificultad 1. Si el banco no tiene tantas como el bloque, se le sirve
// la dificultad de al lado y la medición del nivel sale sesgada hacia dentro:
// assessReading mide la dificultad a la que converge, así que un C2 sale C1.
//
// Como la dificultad se ARRASTRA entre bloques, el alumno puede entrar a textos
// ya clavado en 6: por eso el mínimo se exige en las seis dificultades, no solo
// en la de arranque.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { SECTION_ORDER, SECTION_COUNT, SECTION_LABEL } from '@/lib/levelTest/constants';
import type { LTSection } from '@/lib/levelTest/types';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

const { data, error } = await sb
  .from('level_test_questions')
  .select('section, difficulty, is_active');

if (error) {
  console.error('No se pudo leer level_test_questions:', error.message);
  // exitCode en vez de process.exit(): con el cliente de Supabase todavía abierto,
  // un exit abrupto revienta libuv en Windows y devuelve 127 en vez del código.
  process.exitCode = 1;
  throw new Error('lectura fallida');
}

const conteo = new Map<string, number>();
for (const q of data ?? []) {
  const row = q as { section: string; difficulty: number; is_active: boolean | null };
  if (row.is_active === false) continue;
  const k = `${row.section}|${row.difficulty}`;
  conteo.set(k, (conteo.get(k) ?? 0) + 1);
}

const DIFICULTADES = [1, 2, 3, 4, 5, 6];
const faltantes: Array<{ section: string; difficulty: number; have: number; need: number }> = [];

console.log('\nBANCO DE PREGUNTAS — activas por sección y dificultad\n');
console.log(`${'SECCIÓN'.padEnd(24)}${'BLOQUE'.padStart(7)}   ${DIFICULTADES.map(d => `d${d}`.padStart(5)).join('')}`);
console.log('─'.repeat(64));

for (const sec of SECTION_ORDER) {
  const need = SECTION_COUNT[sec as LTSection];
  let fila = `${SECTION_LABEL[sec as LTSection].padEnd(24)}${String(need).padStart(7)}   `;
  for (const d of DIFICULTADES) {
    const have = conteo.get(`${sec}|${d}`) ?? 0;
    if (have < need) faltantes.push({ section: sec, difficulty: d, have, need });
    fila += (have < need ? `${have}!` : `${have}`).padStart(5);
  }
  console.log(fila);
}

console.log('─'.repeat(64));
console.log('El número de BLOQUE es el mínimo exigido en CADA dificultad. "!" = por debajo.\n');

if (faltantes.length === 0) {
  console.log(`✔ El banco cubre el peor caso en las ${SECTION_ORDER.length * DIFICULTADES.length} combinaciones.\n`);
} else {
  console.log(`✘ ${faltantes.length} combinaciones por debajo del mínimo:\n`);
  const porSeccion = new Map<string, typeof faltantes>();
  for (const f of faltantes) {
    if (!porSeccion.has(f.section)) porSeccion.set(f.section, []);
    porSeccion.get(f.section)!.push(f);
  }
  let totalPreguntas = 0;
  for (const [sec, fs] of porSeccion) {
    const need = fs[0].need;
    const suman = fs.reduce((s, f) => s + (f.need - f.have), 0);
    totalPreguntas += suman;
    console.log(`  ${SECTION_LABEL[sec as LTSection]} (bloque de ${need}): faltan ${suman} preguntas`);
    for (const f of fs) console.log(`      dificultad ${f.difficulty}: hay ${f.have}, hacen falta ${f.need}`);
  }
  console.log(`\n  TOTAL a añadir: ${totalPreguntas} preguntas.\n`);
  console.log('  Mientras falten, el fallback sirve la dificultad más cercana (ver');
  console.log('  lib/levelTest/adaptive.ts) y el nivel medido queda sesgado hacia el centro.\n');
  process.exitCode = 1;
}
