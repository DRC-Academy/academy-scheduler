// Revisa un fichero de seed de preguntas ANTES de correrlo contra Supabase.
//   npm run check:seed                       (por defecto supabase-level-test-seed-v2.sql)
//   npm run check:seed -- otro-fichero.sql
//
// Comprueba lo que se puede comprobar sin criterio humano:
//   · estructura: 4 opciones, correct_answer entre 0 y 3, opciones no repetidas
//   · duplicados dentro del fichero y contra el banco que ya está en la base
//   · reparto de la respuesta correcta (si casi todas son la B, el alumno lo nota)
//   · proyección: si corrés esto, ¿queda `npm run check:bank` en verde?
//
// Lo que NO puede comprobar: si la respuesta marcada es la correcta. Eso necesita
// que alguien lea las preguntas. Una clave mal puesta no da error en ninguna
// parte: simplemente le baja el nivel a todo el que acierte de verdad.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { SECTION_ORDER, SECTION_COUNT, SECTION_LABEL } from '@/lib/levelTest/constants';
import type { LTSection } from '@/lib/levelTest/types';

const FICHERO = process.argv[2] || 'supabase-level-test-seed-v2.sql';

for (const line of existsSync('.env.local') ? readFileSync('.env.local', 'utf8').split('\n') : []) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}

interface Fila {
  section: string; cefr_level: string; difficulty: number;
  prompt_text: string; question_text: string; options: string[]; correct_answer: number;
  linea: number;
}

/**
 * Parte el SQL en filas. No es un parser de SQL: recorre el texto respetando el
 * dollar-quoting ($t$…$t$), que es justo lo que hace que las comillas y los
 * apóstrofos de dentro de las preguntas no rompan nada.
 */
function parsear(sql: string): Fila[] {
  const filas: Fila[] = [];
  const bloques = [...sql.matchAll(/from \(values([\s\S]*?)\) as v\(([^)]*)\)/g)];

  for (const bloque of bloques) {
    const cuerpo = bloque[1];
    const columnas = bloque[2].split(',').map(c => c.trim());
    const base = sql.slice(0, bloque.index).split('\n').length;

    // Trocear en filas de primer nivel.
    const crudas: Array<{ txt: string; off: number }> = [];
    let prof = 0, ini = -1, i = 0;
    while (i < cuerpo.length) {
      if (cuerpo.startsWith('$t$', i)) {
        const fin = cuerpo.indexOf('$t$', i + 3);
        i = fin === -1 ? cuerpo.length : fin + 3;
        continue;
      }
      const c = cuerpo[i];
      if (c === '(') { if (prof === 0) ini = i + 1; prof++; }
      else if (c === ')') { prof--; if (prof === 0 && ini >= 0) crudas.push({ txt: cuerpo.slice(ini, i), off: ini }); }
      i++;
    }

    for (const cruda of crudas) {
      // Trocear en campos por las comas de primer nivel.
      const campos: string[] = [];
      let act = '', p = 0, j = 0;
      while (j < cruda.txt.length) {
        if (cruda.txt.startsWith('$t$', j)) {
          const fin = cruda.txt.indexOf('$t$', j + 3);
          const hasta = fin === -1 ? cruda.txt.length : fin + 3;
          act += cruda.txt.slice(j, hasta);
          j = hasta;
          continue;
        }
        const c = cruda.txt[j];
        if (c === '(') p++;
        if (c === ')') p--;
        if (c === ',' && p === 0) { campos.push(act); act = ''; j++; continue; }
        act += c;
        j++;
      }
      campos.push(act);

      const valor = (nombre: string): string => {
        const idx = columnas.indexOf(nombre);
        if (idx === -1 || idx >= campos.length) return '';
        const bruto = campos[idx].trim().replace(/::jsonb$/, '').trim();
        const m = bruto.match(/^\$t\$([\s\S]*)\$t\$$/);
        return m ? m[1] : bruto;
      };

      let options: string[] = [];
      try { options = JSON.parse(valor('options')); } catch { options = []; }

      filas.push({
        section: valor('section'),
        cefr_level: valor('cefr_level'),
        difficulty: Number(valor('difficulty')),
        prompt_text: valor('prompt_text'),
        question_text: valor('question_text'),
        options,
        correct_answer: Number(valor('correct_answer')),
        linea: base + cuerpo.slice(0, cruda.off).split('\n').length - 1,
      });
    }
  }
  return filas;
}

async function main(): Promise<number> {
  if (!existsSync(FICHERO)) {
    console.error(`\nNo existe ${FICHERO}.\n`);
    return 1;
  }

  const filas = parsear(readFileSync(FICHERO, 'utf8'));
  if (filas.length === 0) {
    console.error(`\nNo se ha podido extraer ninguna fila de ${FICHERO}. ¿Tiene el formato "from (values … ) as v(…)"?\n`);
    return 1;
  }

  console.log(`\nREVISIÓN DE ${FICHERO} — ${filas.length} preguntas\n`);
  const problemas: string[] = [];

  // ── Estructura ─────────────────────────────────────────────────────────────
  for (const f of filas) {
    const ref = `línea ~${f.linea} (${f.section} d${f.difficulty})`;
    if (!SECTION_ORDER.includes(f.section as LTSection)) problemas.push(`${ref}: sección desconocida "${f.section}"`);
    if (!Number.isInteger(f.difficulty) || f.difficulty < 1 || f.difficulty > 6) problemas.push(`${ref}: dificultad fuera de 1-6`);
    if (f.options.length !== 4) problemas.push(`${ref}: tiene ${f.options.length} opciones, no 4`);
    if (!Number.isInteger(f.correct_answer) || f.correct_answer < 0 || f.correct_answer > 3) {
      problemas.push(`${ref}: correct_answer fuera de 0-3 (${f.correct_answer})`);
    }
    const norm = f.options.map(o => o.trim().toLowerCase());
    if (new Set(norm).size !== norm.length) problemas.push(`${ref}: tiene opciones repetidas`);
    if (!f.question_text.trim()) problemas.push(`${ref}: sin question_text`);
    // El nivel MCER y la dificultad numérica tienen que decir lo mismo.
    const esperado = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'][f.difficulty - 1];
    if (f.cefr_level !== esperado) problemas.push(`${ref}: dificultad ${f.difficulty} debería ser ${esperado}, dice ${f.cefr_level}`);
  }

  // ── Duplicados dentro del fichero ──────────────────────────────────────────
  const clave = (f: { prompt_text: string; question_text: string }) =>
    `${f.prompt_text.trim()}||${f.question_text.trim()}`;
  const vistas = new Map<string, number>();
  for (const f of filas) {
    const k = clave(f);
    if (vistas.has(k)) problemas.push(`línea ~${f.linea}: repetida dentro del fichero (ya en la ~${vistas.get(k)})`);
    else vistas.set(k, f.linea);
  }

  // ── Contra el banco que ya está en la base ─────────────────────────────────
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  const { data, error } = await sb
    .from('level_test_questions')
    .select('section, difficulty, is_active, prompt_text, question_text');

  let yaEnBase = 0;
  const actuales = new Map<string, number>();
  if (error) {
    console.log(`No se ha podido leer el banco actual (${error.message}).`);
    console.log('Se comprueba solo la estructura del fichero, sin proyección.\n');
  } else {
    const existentes = new Set(
      (data ?? []).map(q => {
        const r = q as { prompt_text: string | null; question_text: string | null };
        return `${(r.prompt_text ?? '').trim()}||${(r.question_text ?? '').trim()}`;
      }),
    );
    for (const f of filas) if (existentes.has(clave(f))) yaEnBase++;
    for (const q of data ?? []) {
      const r = q as { section: string; difficulty: number; is_active: boolean | null };
      if (r.is_active === false) continue;
      const k = `${r.section}|${r.difficulty}`;
      actuales.set(k, (actuales.get(k) ?? 0) + 1);
    }
  }

  // ── Reparto de la respuesta correcta ───────────────────────────────────────
  const reparto = [0, 0, 0, 0];
  for (const f of filas) if (f.correct_answer >= 0 && f.correct_answer <= 3) reparto[f.correct_answer]++;
  const esperadoPorOpcion = filas.length / 4;
  const desvio = Math.max(...reparto.map(n => Math.abs(n - esperadoPorOpcion)));

  console.log('Respuesta correcta, por posición:');
  console.log(`  A ${reparto[0]}   B ${reparto[1]}   C ${reparto[2]}   D ${reparto[3]}   (lo parejo sería ${esperadoPorOpcion} cada una)`);
  if (desvio > filas.length * 0.15) {
    console.log('  ⚠ Muy desigual: un alumno espabilado puede acertar por posición.\n');
  } else {
    console.log('  Reparto razonable.\n');
  }

  // ── Proyección sobre el banco ──────────────────────────────────────────────
  if (!error) {
    const nuevas = new Map<string, number>();
    for (const f of filas) {
      const k = `${f.section}|${f.difficulty}`;
      nuevas.set(k, (nuevas.get(k) ?? 0) + 1);
    }

    console.log('Si corrés este fichero, el banco queda así:\n');
    console.log(`${'SECCIÓN'.padEnd(24)}${'MÍN'.padStart(5)}   ${[1, 2, 3, 4, 5, 6].map(d => `d${d}`.padStart(6)).join('')}`);
    console.log('─'.repeat(67));

    let cortos = 0;
    for (const sec of SECTION_ORDER) {
      const min = SECTION_COUNT[sec as LTSection];
      let fila = `${SECTION_LABEL[sec as LTSection].padEnd(24)}${String(min).padStart(5)}   `;
      for (let d = 1; d <= 6; d++) {
        const hay = actuales.get(`${sec}|${d}`) ?? 0;
        const suma = nuevas.get(`${sec}|${d}`) ?? 0;
        const total = hay + suma;
        if (total < min) cortos++;
        fila += (total < min ? `${total}!` : `${total}`).padStart(6);
      }
      console.log(fila);
    }
    console.log('─'.repeat(67));
    if (yaEnBase > 0) console.log(`\n${yaEnBase} de las ${filas.length} ya están en la base: no se insertarán otra vez.`);

    if (cortos > 0) {
      problemas.push(`${cortos} combinaciones seguirían por debajo del mínimo aun corriendo este fichero`);
    } else {
      console.log('\n✔ Con este fichero, `npm run check:bank` queda en verde.');
    }
  }

  // ── Veredicto ──────────────────────────────────────────────────────────────
  if (problemas.length > 0) {
    console.log(`\n✘ ${problemas.length} problemas:\n`);
    for (const p of problemas) console.log(`  · ${p}`);
    console.log('');
    return 1;
  }

  console.log('\n✔ Estructura correcta y sin duplicados.');
  console.log('\n  Queda lo que ninguna máquina puede comprobar: que la respuesta marcada');
  console.log('  sea de verdad la correcta. Repasá sobre todo las de B2, C1 y C2.\n');
  return 0;
}

process.exitCode = await main();
