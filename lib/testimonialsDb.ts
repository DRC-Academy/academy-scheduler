// Testimoniales — lectura y cambios desde la pestaña del admin (navegador).
// Solo la tabla testimonial_candidates, que es ligera: nunca transcripts.

import { supabase } from '@/lib/supabase';
import { studentTrend, type FluencyClass, type StudentTrend, type TestimonialClips } from '@/lib/testimonials';

export const TESTIMONIAL_STATUSES = ['detectado', 'revisado', 'permiso_alumno', 'listo', 'descartado'] as const;
export type TestimonialStatus = typeof TESTIMONIAL_STATUSES[number];

export const STATUS_LABEL: Record<TestimonialStatus, string> = {
  detectado: 'Detectado',
  revisado: 'Revisado',
  permiso_alumno: 'Permiso del alumno',
  listo: 'Listo',
  descartado: 'Descartado',
};

export interface TestimonialSide {
  analysisId: string;
  teacherId: string | null;
  classNumber: number | null;
  classDate: string | null;
  score: number | null;
  excerpt: string | null;
  excerptAt: string | null;
  fathomUrl: string | null;
}

export interface TestimonialCandidate {
  id: string;
  studentGroup: string;
  studentId: string | null;
  studentName: string | null;
  before: TestimonialSide;
  after: TestimonialSide;
  improvement: number;
  aiReviewStatus: 'pending' | 'ready' | 'failed';
  aiIsReal: boolean | null;
  aiReason: string | null;
  aiSummary: string | null;
  aiError: string | null;
  status: TestimonialStatus;
  discardedBy: 'ia' | 'admin' | null;
  statusChangedAt: string;
  adminNotes: string | null;
  /** Hasta 3 clips malos y 3 buenos. null = aún sin preparar (o pareja de antes de oct/2026). */
  clips: TestimonialClips | null;
}

type Row = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any

const side = (r: Row, p: 'before' | 'after'): TestimonialSide => ({
  analysisId:  r[`${p}_analysis_id`],
  teacherId:   r[`${p}_teacher_id`] ?? null,
  classNumber: r[`${p}_class_number`] ?? null,
  classDate:   r[`${p}_class_date`] ?? null,
  score:       r[`${p}_score`] ?? null,
  excerpt:     r[`${p}_excerpt`] ?? null,
  excerptAt:   r[`${p}_excerpt_at`] ?? null,
  fathomUrl:   r[`${p}_fathom_url`] ?? null,
});

function map(r: Row): TestimonialCandidate {
  return {
    id: r.id, studentGroup: r.student_group, studentId: r.student_id ?? null, studentName: r.student_name ?? null,
    before: side(r, 'before'), after: side(r, 'after'), improvement: r.improvement,
    aiReviewStatus: r.ai_review_status, aiIsReal: r.ai_is_real ?? null, aiReason: r.ai_reason ?? null,
    aiSummary: r.ai_summary ?? null, aiError: r.ai_error ?? null,
    status: r.status, discardedBy: r.discarded_by ?? null, statusChangedAt: r.status_changed_at,
    adminNotes: r.admin_notes ?? null,
    clips: r.clips && Array.isArray(r.clips.malos) && Array.isArray(r.clips.buenos) ? r.clips : null,
  };
}

/** Todas las parejas, las más recientes primero. null = falta la tabla (SQL sin correr). */
export async function dbGetTestimonialCandidates(): Promise<TestimonialCandidate[] | null> {
  const out: TestimonialCandidate[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('testimonial_candidates')
      .select('*').order('after_class_date', { ascending: false }).order('id').range(from, from + 999);
    if (error) {
      if (error.code === '42P01' || error.code === 'PGRST205') return null;
      throw new Error(error.message);
    }
    out.push(...(data ?? []).map(map));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

/**
 * Media de las primeras y las últimas clases de cada alumno (para "Media de 5,0
 * → 7,0"). Solo notas y fechas de la vista: nunca transcripts.
 */
export async function dbGetStudentTrends(groups: string[]): Promise<Map<string, StudentTrend>> {
  const byGroup = new Map<string, FluencyClass[]>();
  for (let i = 0; i < groups.length; i += 100) {
    const lote = groups.slice(i, i + 100);
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from('transcript_fluency_numbered')
        .select('student_group, analysis_id, class_day, fluency_score')
        .in('student_group', lote).eq('status', 'ready').not('fluency_score', 'is', null)
        .order('analysis_id').range(from, from + 999);
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as Row[]) {
        const list = byGroup.get(r.student_group) ?? [];
        list.push({ analysisId: r.analysis_id, classNumber: null, classDay: String(r.class_day ?? ''), teacherId: null, score: Number(r.fluency_score), fathomUrl: null });
        byGroup.set(r.student_group, list);
      }
      if ((data ?? []).length < 1000) break;
    }
  }
  const out = new Map<string, StudentTrend>();
  for (const [g, classes] of byGroup) {
    const t = studentTrend(classes);
    if (t) out.set(g, t);
  }
  return out;
}

/** Cambio manual de estado y/o notas. "No sirve" (descartado por el admin) bloquea al alumno (ver testimonialStore). */
export async function dbUpdateTestimonialCandidate(
  id: string, patch: { status?: TestimonialStatus; adminNotes?: string },
): Promise<{ error?: string }> {
  const now = new Date().toISOString();
  const row: Row = { updated_at: now };
  if (patch.adminNotes !== undefined) row.admin_notes = patch.adminNotes.trim() || null;
  if (patch.status) {
    row.status = patch.status;
    row.status_changed_at = now;
    row.discarded_by = patch.status === 'descartado' ? 'admin' : null;
  }
  const { error } = await supabase.from('testimonial_candidates').update(row).eq('id', id);
  if (error?.code === '23505') return { error: 'Este alumno ya tiene otra pareja activa. Descarta esa antes de reactivar esta.' };
  return error ? { error: error.message } : {};
}
