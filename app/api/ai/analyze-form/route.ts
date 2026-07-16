// Genera la ficha inicial del alumno a partir de las respuestas del formulario.
// La lógica vive en lib/analyzeForm.ts (así también la puede llamar
// /api/forms/submit sin hacerse un fetch a sí mismo).
//
// Se expone como endpoint para poder re-generar la ficha manualmente si hiciera
// falta (por ejemplo tras configurar la ANTHROPIC_API_KEY).

import { generateFicha } from '@/lib/analyzeForm';
import { formatResponsesForAI, type FormResponses } from '@/lib/formQuestions';

interface Body {
  studentName?: string;
  teacherName?: string;
  plan?: string;
  level?: string;
  /** Respuestas crudas del formulario. Alternativa a responsesText. */
  formResponses?: FormResponses;
  /** Respuestas ya formateadas como texto. */
  responsesText?: string;
}

export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'JSON inválido' }, { status: 400 });
  }

  // Aceptamos las respuestas crudas (formResponses) o ya formateadas
  // (responsesText, que es lo que usa /api/forms/submit).
  const responsesText = body.responsesText?.trim()
    || (body.formResponses ? formatResponsesForAI(body.formResponses) : '');

  if (!responsesText || !body.studentName?.trim()) {
    return Response.json(
      { error: 'Faltan datos (studentName y formResponses o responsesText).' },
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
