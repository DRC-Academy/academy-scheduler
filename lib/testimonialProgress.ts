// Testimoniales — PROGRESO MEDIO de cada alumno (servidor). SOLO SERVIDOR.
//
// Lee lo ya escuchado (no gasta nada) y calcula la velocidad media de sus primeras
// clases frente a las últimas (lib/testimonialListenRank.progresoMedio). Sirve para
// ordenar "Por revisar" y enseñar, junto a la mejora del clip, la del alumno.

import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { progresoMedio, type ProgresoMedio, type ProgresoSegment } from '@/lib/testimonialListenRank';
import { recordingKey } from '@/lib/testimonialPairPlan';
import type { ClipMeasures, VerifyConfig } from '@/lib/testimonialMeasures';

type Row = Record<string, unknown>;

const TROZO = 100;

async function filas(admin: SupabaseClient, table: string, cols: string, grupos: string[]): Promise<Row[]> {
  const out: Row[] = [];
  for (let i = 0; i < grupos.length; i += TROZO) {
    const ch = grupos.slice(i, i + TROZO);
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin.from(table).select(cols).in('student_group', ch).order('analysis_id').range(from, from + 999);
      if (error) throw new Error(`${table}: ${error.message}`);
      const page = (data ?? []) as unknown as Row[];
      out.push(...page);
      if (page.length < 1000) break;
    }
  }
  return out;
}

/** Progreso medio de esos alumnos; null para quien no tiene datos suficientes. */
export async function progresoPorAlumno(admin: SupabaseClient, grupos: string[], c: VerifyConfig): Promise<Map<string, ProgresoMedio | null>> {
  const unicos = [...new Set(grupos)];
  const [segs, tts] = await Promise.all([
    filas(admin, 'testimonial_listen_segments', 'student_group, analysis_id, teacher_id, class_day, medidas, lectura', unicos),
    filas(admin, 'testimonial_transcripts', 'student_group, analysis_id, fathom_url', unicos),
  ]);
  const grabacion = new Map(tts.map(t => [String(t.analysis_id), recordingKey(t.fathom_url as string | null)]));
  const porAlumno = new Map<string, ProgresoSegment[]>();
  for (const s of segs) {
    const g = String(s.student_group), id = String(s.analysis_id);
    const l = porAlumno.get(g) ?? [];
    l.push({
      recording: grabacion.get(id) || id, teacherId: (s.teacher_id as string | null) ?? null, classDay: String(s.class_day ?? '').slice(0, 10),
      medidas: (s.medidas as ClipMeasures | null) ?? null, lectura: s.lectura === 'lectura' || s.lectura === 'espontaneo' ? s.lectura : null,
    });
    porAlumno.set(g, l);
  }
  return new Map(unicos.map(g => [g, progresoMedio(porAlumno.get(g) ?? [], c)]));
}
