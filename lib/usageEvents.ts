// ── Eventos de uso del profesor ───────────────────────────────────────────────
//
// Una fila por acción que el dashboard "Uso de la plataforma" necesita contar y
// que la base no guardaba (o guardaba pisándola). Tabla usage_events, ver
// supabase-usage-events.sql.
//
// BEST-EFFORT, SIEMPRE: registrar el uso nunca puede romper la acción que se
// está registrando. Sin la tabla (SQL sin correr) o sin red, se avisa en la
// consola y la pantalla sigue como si nada. Por eso la función no lanza.
//
// Sirve en el navegador y en el servidor: usa el mismo cliente anónimo que el
// resto de lib/db (RLS deshabilitado).

import { supabase } from '@/lib/supabase';

export type UsageEventType = 'risk_alert_opened' | 'level_confirmed' | 'transcript_first_upload';

export interface UsageEventInput {
  event: UsageEventType;
  teacherId?: string | null;
  teacherName?: string | null;
  studentId?: string | null;
  studentName?: string | null;
  /** Id de lo que se tocó (notificación, análisis...). */
  refId?: string | null;
  /** Detalle corto. Nunca textos largos: esto se lee entero en el dashboard. */
  meta?: Record<string, unknown> | null;
}

/** Para no escribir dos veces el mismo evento en la misma pestaña (doble clic, re-render). */
const yaRegistrados = new Set<string>();

export async function logUsageEvent(e: UsageEventInput, opts: { dedupeKey?: string } = {}): Promise<void> {
  if (opts.dedupeKey) {
    if (yaRegistrados.has(opts.dedupeKey)) return;
    yaRegistrados.add(opts.dedupeKey);
  }
  try {
    const { error } = await supabase.from('usage_events').insert({
      event:        e.event,
      teacher_id:   e.teacherId ?? null,
      teacher_name: e.teacherName ?? null,
      student_id:   e.studentId ?? null,
      student_name: e.studentName ?? null,
      ref_id:       e.refId ?? null,
      meta:         e.meta ?? null,
    });
    if (error) console.warn(`[usageEvents] No se registró ${e.event} (¿falta supabase-usage-events.sql?):`, error.message);
  } catch (err) {
    console.warn(`[usageEvents] No se registró ${e.event}:`, err);
  }
}
