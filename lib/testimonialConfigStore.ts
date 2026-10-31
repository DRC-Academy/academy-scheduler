// Testimoniales — umbrales (testimonial_config) y gasto de Deepgram. SOLO SERVIDOR.
// Lo comparten el verificador (lib/testimonialVerifier) y la escucha dirigida
// (lib/testimonialListen).

import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { DeepgramTranscript } from '@/lib/deepgram';
import { CONFIG_POR_DEFECTO, type VerifyConfig } from '@/lib/testimonialMeasures';

type Row = Record<string, unknown>;

export interface ConfigRow { key: string; value: number; description: string; motivo: string | null; paso: number | null; limite: number | null }

/** Umbrales de la tabla; lo que falte (SQL sin correr), los valores por defecto. */
export async function loadConfig(admin: SupabaseClient): Promise<{ config: VerifyConfig; rows: ConfigRow[] }> {
  const { data, error } = await admin.from('testimonial_config').select('key, value, description, motivo, paso, limite').order('key');
  if (error) throw new Error(`testimonial_config: ${error.message}`);
  const rows = ((data ?? []) as Row[]).map(r => ({
    key: String(r.key), value: Number(r.value), description: String(r.description ?? ''),
    motivo: (r.motivo as string | null) ?? null, paso: r.paso == null ? null : Number(r.paso), limite: r.limite == null ? null : Number(r.limite),
  }));
  const config = { ...CONFIG_POR_DEFECTO };
  for (const r of rows) if (r.key in config && Number.isFinite(r.value)) (config as unknown as Record<string, number>)[r.key] = r.value;
  return { config, rows };
}

/** Apunta los segundos que Deepgram cobró (metadata.duration). Best-effort: nunca lanza. */
export async function logDeepgramUsage(admin: SupabaseClient, origen: 'escucha' | 'verificador', modo: 'multi' | 'detect',
  t: DeepgramTranscript | null, fallbackSeconds: number): Promise<void> {
  if (!t) return;
  const { error } = await admin.from('testimonial_deepgram_usage').insert({
    origen, modo, segundos: Math.round((t.durationS ?? fallbackSeconds) * 100) / 100, request_id: t.requestId,
  });
  if (error) console.error('[testimonios] Gasto de Deepgram sin apuntar:', error.message);
}

export interface DeepgramSpend {
  minutos: { escucha: number; verificador: number };
  usd: number;
  credito: number;
  queda: number;
}

/** Gasto estimado: segundos apuntados × precio por minuto de cada modo (de testimonial_config). */
export async function deepgramSpend(admin: SupabaseClient, c: VerifyConfig): Promise<DeepgramSpend | null> {
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from('testimonial_deepgram_usage').select('origen, modo, segundos').range(from, from + 999);
    if (error) return null;
    rows.push(...((data ?? []) as Row[]));
    if ((data ?? []).length < 1000) break;
  }
  const min = { escucha: 0, verificador: 0 };
  let usd = 0;
  for (const r of rows) {
    const m = Number(r.segundos) / 60;
    min[r.origen === 'escucha' ? 'escucha' : 'verificador'] += m;
    usd += m * (r.modo === 'detect' ? c.deepgram_usd_min_detect : c.deepgram_usd_min_multi);
  }
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    minutos: { escucha: Math.round(min.escucha), verificador: Math.round(min.verificador) },
    usd: r2(usd), credito: c.deepgram_credito_usd, queda: r2(c.deepgram_credito_usd - usd),
  };
}
