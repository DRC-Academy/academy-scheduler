// "Reiniciar perfil de IA" de un alumno: rehace SOLO la parte de la IA (la
// ficha de la IA y los informes de las clases). No le pide nada al alumno.
//
// QUÉ SE LIMPIA Y QUÉ NO — decisión deliberada (Facundo, 30/09/2026):
//
//   · student_profiles → NO se borra la fila. Se vacían solo los campos que
//     escribe la IA (ficha, foco recomendado, riesgo, progreso, próxima clase) y
//     se CONSERVAN las respuestas del formulario, el nivel de la prueba, la
//     confirmación del profe y el resto. Hasta el 30/09/2026 se borraba la fila
//     entera y con ella el nivel: eso ahora es cosa de "Regenerar todo"
//     (app/api/students/regenerate-all), que es otro botón con otro uso.
//   · class_analyses   → NO se borra la fila. El transcript es el SEGUNDO FACTOR
//     de verificación del cálculo de finanzas (lib/finance.ts: una clase cuenta si
//     hay ingreso + transcript). Borrarlo dejaría clases ya dadas sin pagar.
//     Se limpian SOLO los campos de análisis (resumen, errores, progreso, guía,
//     riesgo…) y se conservan transcript, class_date, teacher_id, student_name,
//     join_log_id y validation_status.
//   · La ficha de la IA se vuelve a generar sola, después de responder, con las
//     respuestas del formulario YA GUARDADAS. Sin respuestas, se queda vacía
//     hasta que el alumno rellene el formulario.
//   · NO se crea formulario nuevo.

import { after } from 'next/server';
import { supabase } from '@/lib/supabase';
import { generateFicha } from '@/lib/analyzeForm';
import { fichaToColumns } from '@/lib/aiTypes';
import { formatResponsesForAI, type FormResponses } from '@/lib/formQuestions';

export const runtime = 'nodejs';
// La ficha se regenera en after(), dentro de este límite (generateFicha: 45 s).
export const maxDuration = 60;

interface Body {
  studentId?: string | null;
  studentName?: string;
  teacherId?: string;
  teacherName?: string;
  studentEmail?: string | null;
  assignmentId?: string | null;
  plan?: string | null;
  level?: string | null;
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

// Campos de la ficha que escribe la IA. Todo lo demás de la fila se conserva:
// respuestas del formulario, nivel de la prueba, confirmación del profe…
const PROFILE_AI_FIELDS: Record<string, unknown> = {
  initial_diagnosis:       null,
  strong_points:           null,
  weak_points:             null,
  learning_style:          null,
  personal_objective:      null,
  occupation:              null,
  recommended_focus:       null,
  ai_ficha:                null,
  risk_signal:             null,
  risk_explanation:        null,
  risk_updated_at:         null,
  progress_score:          null,
  total_classes_analyzed:  0,
  last_class_analyzed_at:  null,
  next_class_content:      null,
  next_class_generated_at: null,
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
  if (!studentName) return Response.json({ error: 'Falta studentName.' }, { status: 400 });

  const studentId = body.studentId?.trim() || null;

  // ── 1. Ficha del alumno: se vacía la parte de la IA, la fila se queda ──
  type ProfRow = { id: string; student_name: string | null; form_responses: unknown; form_token_id: string | null };
  const perfiles = new Map<string, ProfRow>();
  {
    const cols = 'id, student_name, form_responses, form_token_id';
    const reads = [
      studentId ? supabase.from('student_profiles').select(cols).eq('student_id', studentId) : null,
      supabase.from('student_profiles').select(cols).ilike('student_name', studentName),
    ];
    for (const r of reads) {
      if (!r) continue;
      const { data, error } = await r;
      if (error) {
        console.error('[reset-profile] Error al leer la ficha:', error);
        return Response.json({ error: `No se pudo leer la ficha: ${error.message}` }, { status: 500 });
      }
      for (const p of (data ?? []) as ProfRow[]) perfiles.set(p.id, p);
    }
    for (const p of perfiles.values()) {
      const { error } = await supabase.from('student_profiles')
        .update({ ...PROFILE_AI_FIELDS, ai_status: p.form_responses ? 'pending' : null, updated_at: new Date().toISOString() })
        .eq('id', p.id);
      if (error) {
        console.error('[reset-profile] Error al limpiar la ficha:', error);
        return Response.json({ error: `No se pudo limpiar la ficha: ${error.message}` }, { status: 500 });
      }
    }
  }
  const profilesCleared = perfiles.size;

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

  // ── 3. La ficha de la IA, otra vez, con las respuestas guardadas ──
  const conRespuestas = [...perfiles.values()].filter(p => p.form_responses);
  if (conRespuestas.length) {
    after(async () => {
      for (const p of conRespuestas) {
        const responses = (typeof p.form_responses === 'string'
          ? safeParse(p.form_responses) : p.form_responses) as FormResponses | null;
        if (!responses || Object.keys(responses).length === 0) continue;
        let plan = body.plan ?? undefined, level = body.level ?? undefined;
        let teacherName = body.teacherName ?? undefined;
        if (p.form_token_id) {
          const { data: tk } = await supabase.from('form_tokens')
            .select('plan, level, teacher_name').eq('id', p.form_token_id).maybeSingle();
          plan ??= tk?.plan ?? undefined; level ??= tk?.level ?? undefined; teacherName ??= tk?.teacher_name ?? undefined;
        }
        const ficha = await generateFicha({
          studentName: p.student_name ?? studentName, teacherName: teacherName ?? '',
          plan, level, responsesText: formatResponsesForAI(responses),
        });
        const { error } = await supabase.from('student_profiles').update({
          ai_status: ficha.status,
          ...(ficha.data ? fichaToColumns(ficha.data) : {}),
          updated_at: new Date().toISOString(),
        }).eq('id', p.id);
        if (error) console.error('[reset-profile] Error al guardar la ficha nueva:', error);
        else if (ficha.status !== 'ready') console.error(`[reset-profile] Ficha de ${studentName} sin generar (${ficha.status}); se puede regenerar desde la ficha.`);
      }
    });
  }

  console.log(`[reset-profile] ${studentName}: ${profilesCleared} ficha(s) limpiada(s), ${analysesCleared} análisis limpiados, ficha IA rehaciéndose: ${conRespuestas.length > 0}`);

  return Response.json({ ok: true, profilesCleared, analysesCleared, fichaRegenerating: conRespuestas.length > 0 });
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
