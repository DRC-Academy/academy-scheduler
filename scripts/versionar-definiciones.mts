// Convierte el CSV que devuelve supabase/versionado/_extraer-definiciones.sql en
// un archivo por objeto dentro de supabase/versionado/. NO toca la base: solo lee
// el CSV descargado del SQL Editor y escribe archivos locales.
//
//   node --import tsx scripts/versionar-definiciones.mts <ruta-al-csv> [--fecha 2026-10-07]
//
// --fecha es el día en que se corrió la consulta (por defecto, hoy en España).
// La definición se copia TAL CUAL; lo único que se añade es la cabecera.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'supabase', 'versionado');

const args = process.argv.slice(2);
const iFecha = args.indexOf('--fecha');
const csvPath = args.find((a, i) => !a.startsWith('--') && (iFecha < 0 || i !== iFecha + 1));
const fecha = iFecha >= 0
  ? args[iFecha + 1]
  : new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());

if (!csvPath || !/^\d{4}-\d{2}-\d{2}$/.test(fecha ?? '')) {
  console.error('Uso: node --import tsx scripts/versionar-definiciones.mts <csv> [--fecha AAAA-MM-DD]');
  process.exit(1);
}

/** CSV con comillas dobles, comillas escapadas ("") y saltos de línea dentro de campos. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c !== ''));
}

const [header, ...data] = parseCsv(readFileSync(resolve(csvPath), 'utf8').replace(/^﻿/, ''));
const col = (name: string) => {
  const i = header.indexOf(name);
  if (i < 0) { console.error(`Falta la columna "${name}" en el CSV (cabecera: ${header.join(', ')})`); process.exit(1); }
  return i;
};
const [iTipo, iNombre, iDef] = [col('tipo'), col('nombre'), col('definicion')];

mkdirSync(OUT, { recursive: true });
const usados = new Map<string, number>();

for (const r of data) {
  const tipo = r[iTipo];
  const nombre = r[iNombre];
  const base = `${tipo}-${nombre.replace(/\(.*$/, '').replace(/[^A-Za-z0-9_]+/g, '_')}`;
  // Funciones sobrecargadas: mismo nombre con otros argumentos → sufijo numérico.
  const n = (usados.get(base) ?? 0) + 1;
  usados.set(base, n);
  const file = `${base}${n > 1 ? `__${n}` : ''}.sql`;

  const cabecera = [
    '-- ===========================================================================',
    `-- VOLCADO de producción, NO es una migración. No ejecutar.`,
    `-- Objeto: ${tipo} ${nombre}`,
    `-- Extraído el ${fecha} con supabase/versionado/_extraer-definiciones.sql`,
    '-- (pg_get_functiondef / pg_get_viewdef / catálogo). Copiado tal cual.',
    '-- Sirve para saber qué hay en la base; los cambios van en supabase/migraciones/.',
    '-- ===========================================================================',
    '',
  ].join('\n');

  writeFileSync(resolve(OUT, file), cabecera + r[iDef].replace(/\r\n/g, '\n') + '\n');
  console.log(`  ${file}`);
}
console.log(`\n${data.length} objeto(s) escritos en supabase/versionado/`);
