// "Reiniciar perfil de IA" de un alumno: borra la ficha y el contenido generado
// por IA para poder empezar de cero (formulario mal contestado, alumno que cambia
// de objetivo, ficha con datos de otra persona…).
//
// QUÉ SE BORRA Y QUÉ NO — decisión deliberada:
//
//   · student_profiles → SE BORRA la fila entera. Es la ficha: se regenera con el
//     formulario nuevo.
//   · class_analyses   → NO se borra la fila. El transcript es el SEGUNDO FACTOR
//     de verificación del cálculo de finanzas (lib/finance.ts: una clase cuenta si
//     hay ingreso + transcript). Borrarlo dejaría clases ya dadas sin pagar.
//     Se limpian SOLO los campos de análisis (resumen, errores, progreso, guía,
//     riesgo…) y se conservan transcript, class_date, teacher_id, student_name,
//     join_log_id y validation_status.
//
// Además se genera un formulario nuevo (el enlace anterior deja de funcionar).

import { supabase } from '@/lib/supabase';
import { publicBase } from '@/lib/appUrl';

export const runtime = 'nodejs';
export const maxDuration = 30;

interface Body {
  studentId?: string | null;
  studentName?: string;
  teacherId?: string;
  teacherName?: string;
  studentEmail?: string | null;
  assignmentId?: string | null;
  plan?: string | null;
  level?: string | null;
  /** false → solo limpia, sin crear un formulario nuevo. */
  newFormLink?: boolean;
}

// Campos del informe de IA. `transcript`, `class_date`, `teacher_id`,
// `student_name` y los de validación NO están acá a propósito (ver cabecera).
const AI_FIELDS: Record<string, unknown> = {
  class_title:        null,
  class_summary:      null,
  errors_detected:    null,
  progress_notes:     null,
  topics_covered:     null,
  next_class_guide:   null,
  next_class_content: null,
  risk_signal:        null,
  risk_explanation:   null,
};

const isMissingCol = (e: { code?: string } | null): boolean =>
  e?.code === 'PGRST204' || e?.code === '42703';

export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try {
    body = await request.json();
  } catch (err) {
    console.error('[reset-profile] JSON inválido:', err);
    return Response.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const studentName = body.studentName?.trim();
  const teacherId = body.teacherId?.trim();
  if (!studentName) return Response.json({ error: 'Falta studentName.' }, { status: 400 });

  const studentId = body.studentId?.trim() || null;

  // ── 1. Ficha del alumno ──
  let profilesDeleted = 0;
  {
    const del = async (col: 'student_id' | 'student_name', val: string) => {
      const q = supabase.from('student_profiles').delete();
      const { data, error } = col === 'student_id'
        ? await q.eq('student_id', val).select('id')
        : await q.ilike('student_name', val).select('id');
      if (error) {
        console.error(`[reset-profile] Error al borrar la ficha por ${col}:`, error);
        throw new Error(`No se pudo borrar la ficha: ${error.message}`);
      }
      profilesDeleted += data?.length ?? 0;
    };
    try {
      if (studentId) await del('student_id', studentId);
      await del('student_name', studentName);
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : 'No se pudo borrar la ficha.' },
        { status: 500 },
      );
    }
  }

  // ── 2. Análisis de clase: se limpia el informe, se conserva el transcript ──
  let analysesCleared = 0;
  {
    const clear = async (fields: Record<string, unknown>) => {
      const base = supabase.from('class_analyses').update(fields);
      const q = studentId ? base.eq('student_id', studentId) : base.ilike('student_name', studentName);
      return q.select('id');
    };
    // analysis_status 'pending' deja el botón "Reintentar análisis" a mano para
    // regenerar los informes cuando el alumno complete el formulario nuevo.
    let res = await clear({ ...AI_FIELDS, analysis_status: 'pending', analysis_error: null });
    if (res.error && isMissingCol(res.error)) res = await clear(AI_FIELDS);
    if (res.error) {
      console.error('[reset-profile] Error al limpiar class_analyses:', res.error);
      return Response.json(
        { error: `No se pudieron limpiar los análisis: ${res.error.message}` },
        { status: 500 },
      );
    }
    analysesCleared = res.data?.length ?? 0;

    // Si el alumno tiene student_id, sus clases antiguas pueden estar guardadas
    // solo por nombre: se limpian también.
    if (studentId) {
      let byName = await supabase.from('class_analyses')
        .update({ ...AI_FIELDS, analysis_status: 'pending', analysis_error: null })
        .is('student_id', null).ilike('student_name', studentName).select('id');
      if (byName.error && isMissingCol(byName.error)) {
        byName = await supabase.from('class_analyses').update(AI_FIELDS)
          .is('student_id', null).ilike('student_name', studentName).select('id');
      }
      if (byName.error) console.error('[reset-profile] Error al limpiar por nombre:', byName.error);
      else analysesCleared += byName.data?.length ?? 0;
    }
  }

  // ── 3. Formulario nuevo (el anterior deja de funcionar) ──
  let formUrl: string | null = null;
  if (body.newFormLink !== false && teacherId) {
    try {
      const patch = { status: 'expired' };
      if (studentId) await supabase.from('form_tokens').update(patch).eq('student_id', studentId).neq('status', 'expired');
      await supabase.from('form_tokens').update(patch).ilike('student_name', studentName).neq('status', 'expired');

      const token = crypto.randomUUID();
      const { error } = await supabase.from('form_tokens').insert({
        id:            `ft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        token,
        student_id:    studentId,
        student_name:  studentName,
        student_email: body.studentEmail?.trim() || null,
        teacher_id:    teacherId,
        teacher_name:  body.teacherName?.trim() || '',
        assignment_id: body.assignmentId?.trim() || null,
        plan:          body.plan?.trim() || null,
        level:         body.level?.trim() || null,
        status:        'pending',
      });
      if (error) console.error('[reset-profile] No se pudo crear el formulario nuevo:', error);
      else formUrl = `${publicBase(request)}/formulario/${token}`;
    } catch (err) {
      // El reinicio en sí ya salió bien: no se tumba por el link.
      console.error('[reset-profile] Error al generar el formulario nuevo:', err);
    }
  }

  console.log(`[reset-profile] ${studentName}: ${profilesDeleted} ficha(s) borrada(s), ${analysesCleared} análisis limpiados, link nuevo: ${!!formUrl}`);

  return Response.json({ ok: true, profilesDeleted, analysesCleared, formUrl });
}
