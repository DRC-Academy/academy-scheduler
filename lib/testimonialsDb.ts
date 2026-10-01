// Testimoniales — lectura y cambios desde la pestaña del admin (navegador).
// Solo la tabla testimonial_candidates, que es ligera: nunca transcripts.

import { supabase } from '@/lib/supabase';

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

/** Cambio manual de estado y/o notas. Un descarte del admin bloquea al alumno (ver testimonialStore). */
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

// ── Avisos al profesor para subir la grabación (supabase-testimoniales-avisos.sql) ──

export interface RecordingRequest {
  id: string;
  candidateId: string;
  teacherId: string;
  sides: Array<'antes' | 'despues'>;
  notifiedAt: string;
  emailSent: boolean;
  timesNotified: number;
  uploadedAt: string | null;
}

const mapRequest = (r: Row): RecordingRequest => ({
  id: r.id, candidateId: r.candidate_id, teacherId: r.teacher_id, sides: r.sides ?? [],
  notifiedAt: r.notified_at, emailSent: !!r.email_sent, timesNotified: r.times_notified ?? 1,
  uploadedAt: r.uploaded_at ?? null,
});

/** Todos los avisos enviados (para el admin). null = falta la tabla. */
export async function dbGetRecordingRequests(): Promise<RecordingRequest[] | null> {
  const out: RecordingRequest[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('testimonial_recording_requests')
      .select('id, candidate_id, teacher_id, sides, notified_at, email_sent, times_notified, uploaded_at')
      .order('id').range(from, from + 999);
    if (error) {
      if (error.code === '42P01' || error.code === 'PGRST205') return null;
      throw new Error(error.message);
    }
    out.push(...(data ?? []).map(mapRequest));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

/** "Enviar al profesor": campanita + email, en el servidor (la clave de Resend vive allí). */
export async function sendTestimonialToTeachers(candidateId: string): Promise<{
  results?: Array<{ teacherId: string; outcome: 'enviado' | 'reenviado' | 'ya_subida' | 'error'; emailSent?: boolean; error?: string }>;
  error?: string;
}> {
  try {
    const res = await fetch('/api/admin/testimonial-notify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidateId }),
    });
    const data = await res.json().catch(() => ({ error: `Error ${res.status} del servidor.` }));
    return res.ok ? data : { error: data.error ?? `Error ${res.status} del servidor.` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Lado del profesor ────────────────────────────────────────────────────────

export interface TeacherRecordingRequest extends RecordingRequest {
  studentName: string;
  before: TestimonialSide;
  after: TestimonialSide;
}

/**
 * Grabaciones que se le han pedido a un profesor: las pendientes y las subidas
 * en los últimos 30 días (para que vea el "Subida ✓"). [] si falta la tabla.
 */
export async function dbGetTeacherRecordingRequests(teacherId: string): Promise<TeacherRecordingRequest[]> {
  const desde = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data, error } = await supabase.from('testimonial_recording_requests')
    .select('id, candidate_id, teacher_id, sides, notified_at, email_sent, times_notified, uploaded_at, testimonial_candidates(*)')
    .eq('teacher_id', teacherId)
    .or(`uploaded_at.is.null,uploaded_at.gte.${desde}`)
    .order('notified_at', { ascending: false });
  if (error) return [];
  return (data ?? [])
    .filter((r: Row) => r.testimonial_candidates && r.testimonial_candidates.status !== 'descartado')
    .map((r: Row) => ({
      ...mapRequest(r),
      studentName: r.testimonial_candidates.student_name ?? 'Alumno',
      before: side(r.testimonial_candidates, 'before'),
      after: side(r.testimonial_candidates, 'after'),
    }));
}

/** El profesor pulsa "Grabación subida". Solo puede marcar las suyas. */
export async function dbMarkRecordingUploaded(requestId: string, teacherId: string): Promise<{ error?: string }> {
  const now = new Date().toISOString();
  const { error } = await supabase.from('testimonial_recording_requests')
    .update({ uploaded_at: now, updated_at: now }).eq('id', requestId).eq('teacher_id', teacherId);
  return error ? { error: error.message } : {};
}
