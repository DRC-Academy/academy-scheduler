// Test de regresión de la evaluación de ESCRITURA contra textos de nivel MCER
// conocido y externo.
//   npm run calibrate:writing
//
// Corre los textos de fixtures/writing-calibration/ contra el evaluador REAL
// (lib/evaluateWriting, Haiku) y compara el nivel devuelto con el oficial.
//
// CRITERIO (asimétrico a propósito): acertar la banda o fallar UNA hacia abajo
// pasa; fallar hacia arriba, o por dos o más, no pasa. Mandar a un alumno a un
// nivel que no puede seguir es el fallo caro.
//
// Sale con código 1 si algún texto no cumple, si no hay textos, o si falta la
// clave de la API. No cambia nada: solo mide.
//
// El `--conditions=react-server` del npm script no es decorativo: lib/anthropic
// importa 'server-only', que fuera de esa condición lanza al importarse.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateWriting } from '@/lib/evaluateWriting';
import type { Cefr } from '@/lib/levelTest/types';

for (const line of existsSync('.env.local') ? readFileSync('.env.local', 'utf8').split('\n') : []) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}

const DIR = 'fixtures/writing-calibration';
const ESCALA: Cefr[] = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const PROMPT_GENERICO =
  'Write a short text about yourself, your work or studies, and your plans for the future.';

interface Texto {
  file: string;
  cefr: Cefr;
  source: string;
  prompt: string;
  body: string;
}

// Front-matter mínimo: `clave: valor` por línea entre dos ---. No hace falta una
// dependencia de YAML para esto, y es una menos que mantener.
function parse(file: string): Texto {
  const raw = readFileSync(join(DIR, file), 'utf8').replace(/^﻿/, '');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) throw new Error(`${file}: falta el front-matter entre --- y ---`);

  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }

  const cefr = (meta.cefr || '').toUpperCase() as Cefr;
  if (!ESCALA.includes(cefr)) throw new Error(`${file}: "cefr" ausente o inválido (${meta.cefr || '—'})`);
  if (!meta.source || meta.source.startsWith('RELLENAR')) {
    throw new Error(`${file}: "source" es obligatorio. Un set de calibración sin procedencia externa no valida nada.`);
  }
  const body = m[2].trim();
  if (body.length < 40) throw new Error(`${file}: el texto está vacío o es demasiado corto`);

  return { file, cefr, source: meta.source, prompt: meta.prompt || PROMPT_GENERICO, body };
}

interface Fila {
  file: string; oficial: Cefr; devuelto: string; within: string;
  desviacion: number | null; pasa: boolean; evidence: string;
}

async function main(): Promise<number> {
  if (!existsSync(DIR)) {
    console.error(`\nNo existe ${DIR}. Ver el README de esa carpeta.\n`);
    return 1;
  }

  const files = readdirSync(DIR)
    .filter(f => f.endsWith('.md') && !f.startsWith('_') && f !== 'README.md');

  if (files.length === 0) {
    console.error(`\nNo hay textos en ${DIR}.\n`);
    console.error('El set está montado pero vacío: faltan las redacciones con su nivel oficial.');
    console.error('Copiá _PLANTILLA.md a <nivel>-<n>.md por cada texto. Ver el README.\n');
    console.error('No se marca como "pasa": no haber medido nada no es haber medido bien.\n');
    return 1;
  }

  let textos: Texto[];
  try {
    textos = files.map(parse);
  } catch (err) {
    console.error(`\n${(err as Error).message}\n`);
    return 1;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('\nFalta ANTHROPIC_API_KEY en .env.local. El comando llama al evaluador real.\n');
    return 1;
  }

  console.log(`\nCALIBRACIÓN DE ESCRITURA — ${textos.length} textos contra el evaluador real\n`);

  const filas: Fila[] = [];
  for (const t of textos) {
    const res = await evaluateWriting({
      cefrLevel: t.cefr,          // solo contexto de task_completion; no debe mover el nivel
      writingPrompt: t.prompt,
      writtenResponse: t.body,
    });

    if (!res.data) {
      filas.push({
        file: t.file, oficial: t.cefr, devuelto: `(${res.status})`, within: '—',
        desviacion: null, pasa: false, evidence: 'La IA no devolvió evaluación.',
      });
      continue;
    }

    const devuelto = res.data.cefr_level;
    const desviacion = ESCALA.indexOf(devuelto) - ESCALA.indexOf(t.cefr);
    filas.push({
      file: t.file, oficial: t.cefr, devuelto, within: res.data.within_level,
      desviacion,
      pasa: desviacion === 0 || desviacion === -1,
      evidence: (res.data.evidence || '').replace(/\s+/g, ' ').trim(),
    });
  }

  const p = (s: unknown, n: number) => String(s ?? '—').padEnd(n);
  console.log(`${p('TEXTO', 14)}${p('OFICIAL', 9)}${p('DEVUELTO', 10)}${p('WITHIN', 8)}${p('DESV.', 7)}RESULTADO`);
  console.log('─'.repeat(64));
  for (const f of filas) {
    const d = f.desviacion == null ? '—' : f.desviacion > 0 ? `+${f.desviacion}` : `${f.desviacion}`;
    console.log(`${p(f.file, 14)}${p(f.oficial, 9)}${p(f.devuelto, 10)}${p(f.within, 8)}${p(d, 7)}${f.pasa ? 'pasa' : 'NO PASA'}`);
  }
  console.log('─'.repeat(64));

  console.log('\nEVIDENCIA (lo que el evaluador dice que vio):\n');
  for (const f of filas) {
    console.log(`  ${f.file} [${f.oficial} → ${f.devuelto}]`);
    console.log(`      ${f.evidence || '—'}\n`);
  }

  const sinCubrir = ESCALA.filter(l => !filas.some(f => f.oficial === l));
  if (sinCubrir.length) {
    console.log(`Aviso: sin textos para ${sinCubrir.join(', ')}. La señal es más débil, no inválida.\n`);
  }

  const fallan = filas.filter(f => !f.pasa);
  console.log(`Pasan ${filas.length - fallan.length} de ${filas.length}.`);
  if (fallan.length === 0) {
    console.log('\n✔ El evaluador está calibrado según el criterio.\n');
    return 0;
  }

  const arriba = fallan.filter(f => (f.desviacion ?? 0) > 0);
  const abajo2 = fallan.filter(f => (f.desviacion ?? 0) <= -2);
  const sinDato = fallan.filter(f => f.desviacion == null);
  if (arriba.length) console.log(`  · ${arriba.length} SOBREESTIMAN el nivel (el fallo caro): ${arriba.map(f => f.file).join(', ')}`);
  if (abajo2.length) console.log(`  · ${abajo2.length} se quedan dos bandas o más por debajo: ${abajo2.map(f => f.file).join(', ')}`);
  if (sinDato.length) console.log(`  · ${sinDato.length} sin respuesta de la IA: ${sinDato.map(f => f.file).join(', ')}`);
  console.log('\n✘ No pasa.\n');
  return 1;
}

process.exitCode = await main();
