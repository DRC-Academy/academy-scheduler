// Testimoniales — lectura y cambios desde la pestaña del admin (navegador).
// Solo la tabla testimonial_candidates, que es ligera: nunca transcripts.

import { supabase } from '@/lib/supabase';
import type { TestimonialClips } from '@/lib/testimonials';

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
  /** Un clip malo y uno bueno (las parejas de antes del 07/10/2026, hasta 3). null = aún sin preparar. */
  clips: TestimonialClips | null;
  /** V5: el profe de la pareja (los dos clips son con él). null en las parejas antiguas. */
  pairTeacherId: string | null;
  /** V5: la etiqueta del alumno en Fathom. */
  studentLabel: string | null;
  /** V5: la clase del clip malo es posterior a la del bueno. */
  reverseOrder: boolean;
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
    pairTeacherId: r.pair_teacher_id ?? null,
    studentLabel: r.student_label ?? null,
    reverseOrder: r.reverse_order === true,
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

/** Cambio manual de estado y/o notas. "No sirve" (descartado por el admin) bloquea a ese alumno con ese profe (ver testimonialMomentsStore syncPairs). */
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
  if (error?.code === '23505') return { error: 'Este alumno ya tiene otra pareja activa con este profe. Descarta esa antes de reactivar esta.' };
  return error ? { error: error.message } : {};
}
