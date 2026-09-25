// Guardia contra `maxItems` / `minItems` en los esquemas de IA.
//
// Los structured outputs de la API de Claude rechazan esos parámetros con un 400
// ("For 'array' type, property 'maxItems' is not supported") y la función de IA
// que los lleve falla el 100% de las veces. Pasó del 04/08 al 17/08/2026: 346
// análisis de transcripts perdidos. `sanitizeSchemaForApi` (lib/anthropic.ts) los
// quita como red de seguridad, pero la regla es no escribirlos: los topes van en
// la `description` del campo, en prosa.
//
// Este test lee el CÓDIGO FUENTE (no importa los módulos), así que también
// vigila los archivos que se creen en el futuro sin tener que registrarlos aquí.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { sanitizeSchemaForApi } from '@/lib/anthropic';

const ROOT = join(__dirname, '..');
const DIRS = ['lib', 'app', 'components', 'scripts'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(full);
  }
  return out;
}

/** Quita comentarios de línea y de bloque: la palabra puede salir en la documentación. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
}

// Uso como CLAVE de un objeto: `maxItems: 4`, `'maxItems': 4`, `"minItems": 1`.
// La lista de lib/anthropic.ts los tiene como valores ('maxItems',) y no cuenta.
const KEY_USE = /(?:\b|['"])(minItems|maxItems)['"]?\s*:/;

describe('esquemas de IA', () => {
  it('ningún archivo usa maxItems ni minItems como clave', () => {
    const culpables: string[] = [];
    for (const d of DIRS) {
      let files: string[] = [];
      try { files = sourceFiles(join(ROOT, d)); } catch { continue; }
      for (const f of files) {
        const code = stripComments(readFileSync(f, 'utf8'));
        code.split('\n').forEach((line, i) => {
          if (KEY_USE.test(line)) culpables.push(`${relative(ROOT, f)}:${i + 1}  ${line.trim()}`);
        });
      }
    }
    expect(
      culpables,
      'La API de Claude rechaza maxItems/minItems: pide el tope en la "description" del campo y recorta en el código.',
    ).toEqual([]);
  });

  it('la red central los quita aunque alguien los cuele', () => {
    const clean = sanitizeSchemaForApi({
      type: 'object',
      properties: {
        items: { type: 'array', maxItems: 4, minItems: 1, items: { type: 'string' } },
        // Un CAMPO que se llame como una palabra de JSON Schema se respeta.
        maxItems: { type: 'integer' },
      },
    }, 'test');
    const json = JSON.stringify(clean);
    expect(json).not.toMatch(/"maxItems":4|"minItems":1/);
    expect((clean.properties as Record<string, unknown>).maxItems).toEqual({ type: 'integer' });
  });
});
