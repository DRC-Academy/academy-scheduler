// Genera (o regenera) la ficha inicial del alumno a partir de las respuestas del
// formulario, y la guarda en las columnas de student_profiles.
//
// Dos modos:
//   · { profileId }  → carga las respuestas ya guardadas y regenera la ficha.
//     Es el que usa el botón "🤖 Generar ficha" cuando la ficha está vacía.
//   · { studentName, formResponses | responsesText } → generación suelta, sin guardar.
//
// La lógica de la llamada vive en lib/analyzeForm.ts, así /api/forms/submit la
// usa directamente sin hacerse un fetch a sí mismo.

import { supabase } from '@/lib/supabase';
import { generateFicha } from '@/lib/analyzeForm';
import { fichaToColumns } from '@/lib/aiTypes';
import { formatResponsesForAI, type FormResponses } from '@/lib/formQuestions';

interface Body {
  profileId?: string;
  studentName?: string;
  teacherName?: string;
  plan?: string;
  level?: string;
  formResponses?: FormResponses;
  responsesText?: string;
}

export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'JSON inválido' }, { status: 400 });
  }

  // ── Modo regenerar: leemos las respuestas guardadas y persistimos la ficha ──
  if (body.profileId) {
    const { data: prof, error } = await supabase
      .from('student_profiles')
      .select('id, student_name, form_responses, form_token_id')
      .eq('id', body.profileId)
      .maybeSingle();

    if (error) {
      console.error('[analyze-form] Error al leer la ficha:', error);
      return Response.json({ error: 'No se pudo leer la ficha.' }, { status: 500 });
    }
    if (!prof) return Response.json({ error: 'Ficha no encontrada.' }, { status: 404 });

    const responses = typeof prof.form_responses === 'string'
      ? safeParse(prof.form_responses)
      : (prof.form_responses as FormResponses | null);

    if (!responses || Object.keys(responses).length === 0) {
      return Response.json(
        { error: 'Esta ficha no tiene respuestas del formulario guardadas, así que no hay nada que analizar.' },
        { status: 409 },
      );
    }

    // El nivel/plan/profe pueden venir del cliente; si no, los sacamos del token.
    let { plan, level, teacherName } = body;
    if (prof.form_token_id && (!plan || !level || !teacherName)) {
      const { data: tk } = await supabase.from('form_tokens')
        .select('plan, level, teacher_name').eq('id', prof.form_token_id).maybeSingle();
      plan ??= tk?.plan ?? undefined;
      level ??= tk?.level ?? undefined;
      teacherName ??= tk?.teacher_name ?? undefined;
    }

    const result = await generateFicha({
      studentName: prof.student_name ?? body.studentName ?? 'el alumno',
      teacherName: teacherName ?? '',
      plan, level,
      responsesText: formatResponsesForAI(responses),
    });

    if (result.status !== 'ready' || !result.data) {
      return Response.json(
        { error: result.error ?? 'No se pudo generar la ficha.', status: result.status },
        { status: 502 },
      );
    }

    const { error: updErr } = await supabase.from('student_profiles').update({
      ...fichaToColumns(result.data),
      ai_status:  'ready',
      updated_at: new Date().toISOString(),
    }).eq('id', prof.id);

    if (updErr) {
      console.error('[analyze-form] Error al guardar la ficha:', updErr);
      return Response.json({ error: `La ficha se generó pero no se pudo guardar: ${updErr.message}` }, { status: 500 });
    }

    return Response.json({ ficha: result.data, status: 'ready' });
  }

  // ── Modo suelto: generar sin guardar ──
  const responsesText = body.responsesText?.trim()
    || (body.formResponses ? formatResponsesForAI(body.formResponses) : '');

  if (!responsesText || !body.studentName?.trim()) {
    return Response.json(
      { error: 'Faltan datos (profileId, o bien studentName y formResponses/responsesText).' },
      { status: 400 },
    );
  }

  const result = await generateFicha({
    studentName: body.studentName.trim(),
    teacherName: body.teacherName?.trim() || '',
    plan: body.plan,
    level: body.level,
    responsesText,
  });

  if (result.status !== 'ready') {
    return Response.json({ error: result.error ?? 'No se pudo generar la ficha.', status: result.status }, { status: 502 });
  }
  return Response.json({ ficha: result.data, status: result.status });
}

function safeParse(s: string): FormResponses | null {
  try { return JSON.parse(s) as FormResponses; } catch { return null; }
}
