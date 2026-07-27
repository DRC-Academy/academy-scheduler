// Limpieza masiva de guiones en los textos de IA YA guardados.
//
// La corrección de raíz está en los prompts (NO_DASH_RULES) y en cleanAiDeep,
// que limpian todo lo que se genere de ahora en adelante. Este endpoint arregla
// lo que ya estaba en la base.
//
// Es idempotente: pasarlo dos veces no cambia nada la segunda vez (solo escribe
// las filas cuyo texto cambia de verdad). Pensado para ejecutarse desde el botón
// "Limpiar guiones de textos de IA" del panel de admin.
//
//   · GET  → cuenta cuántas filas están afectadas, sin tocar nada.
//   · POST → aplica la limpieza y devuelve el recuento.

import { supabase } from '@/lib/supabase';
import { cleanAiText } from '@/lib/textCleanup';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Campos de texto generados por IA. `transcript` NO está: es el texto crudo de
// Fathom (prueba de que la clase existió), no un texto generado.
const PROFILE_FIELDS = [
  'initial_diagnosis', 'strong_points', 'weak_points', 'learning_style',
  'personal_objective', 'occupation', 'recommended_focus', 'risk_explanation',
  'current_block', 'grammar_focus', 'vocabulary_focus', 'ai_ficha',
] as const;

const ANALYSIS_FIELDS = [
  'class_title', 'class_summary', 'errors_detected', 'progress_notes',
  'topics_covered', 'risk_explanation',
] as const;

// Campos jsonb: se limpian todas sus cadenas, a cualquier profundidad.
const PROFILE_JSON_FIELDS = ['next_class_content'] as const;
const ANALYSIS_JSON_FIELDS = ['next_class_guide', 'next_class_content'] as const;

type Row = Record<string, unknown>;

/** Limpia las cadenas de un valor jsonb. Devuelve null si no cambió nada. */
function cleanJson(value: unknown): { changed: boolean; value: unknown } {
  if (typeof value === 'string') {
    const c = cleanAiText(value);
    return { changed: c !== value, value: c };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map(v => { const r = cleanJson(v); changed = changed || r.changed; return r.value; });
    return { changed, value: out };
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const out: Row = {};
    for (const [k, v] of Object.entries(value as Row)) {
      const r = cleanJson(v);
      changed = changed || r.changed;
      out[k] = r.value;
    }
    return { changed, value: out };
  }
  return { changed: false, value };
}

/** Calcula el parche de una fila. Devuelve {} si no hay nada que cambiar. */
function patchFor(row: Row, textFields: readonly string[], jsonFields: readonly string[]): Row {
  const patch: Row = {};
  for (const f of textFields) {
    const v = row[f];
    if (typeof v !== 'string' || !v) continue;
    const c = cleanAiText(v);
    if (c !== v) patch[f] = c;
  }
  for (const f of jsonFields) {
    if (row[f] == null) continue;
    const r = cleanJson(row[f]);
    if (r.changed) patch[f] = r.value;
  }
  return patch;
}

interface TableResult { scanned: number; affected: number; updated: number; errors: number }

async function processTable(
  table: 'student_profiles' | 'class_analyses',
  textFields: readonly string[],
  jsonFields: readonly string[],
  apply: boolean,
): Promise<TableResult> {
  const res: TableResult = { scanned: 0, affected: 0, updated: 0, errors: 0 };

  // Se piden solo las columnas necesarias, con reintento por si alguna no existe
  // en esta base (migraciones parciales).
  const cols = ['id', ...textFields, ...jsonFields].join(', ');
  let { data, error } = await supabase.from(table).select(cols);
  if (error && (error.code === '42703' || error.code === 'PGRST204')) {
    console.warn(`[clean-ai-dashes] ${table}: columnas ausentes, se lee la fila entera.`);
    ({ data, error } = await supabase.from(table).select('*'));
  }
  if (error || !data) {
    console.error(`[clean-ai-dashes] Error al leer ${table}:`, error);
    res.errors++;
    return res;
  }

  for (const raw of data as unknown as Row[]) {
    res.scanned++;
    const patch = patchFor(raw, textFields, jsonFields);
    if (Object.keys(patch).length === 0) continue;
    res.affected++;
    if (!apply) continue;

    const { error: updErr } = await supabase.from(table).update(patch).eq('id', raw.id as string);
    if (updErr) {
      console.error(`[clean-ai-dashes] Error al actualizar ${table} ${String(raw.id)}:`, updErr);
      res.errors++;
    } else {
      res.updated++;
    }
  }
  return res;
}

async function run(apply: boolean): Promise<Response> {
  const started = Date.now();
  const profiles = await processTable('student_profiles', PROFILE_FIELDS, PROFILE_JSON_FIELDS, apply);
  const analyses = await processTable('class_analyses', ANALYSIS_FIELDS, ANALYSIS_JSON_FIELDS, apply);

  const summary = {
    applied: apply,
    profiles,
    analyses,
    totalAffected: profiles.affected + analyses.affected,
    totalUpdated: profiles.updated + analyses.updated,
    ms: Date.now() - started,
  };
  console.log('[clean-ai-dashes]', JSON.stringify(summary));
  return Response.json(summary);
}

/** Vista previa: cuántas filas tienen guiones, sin tocar nada. */
export async function GET(): Promise<Response> {
  return run(false);
}

/** Aplica la limpieza. */
export async function POST(): Promise<Response> {
  return run(true);
}
