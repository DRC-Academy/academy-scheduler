// Genera la ficha del alumno + primera clase a partir de las respuestas del
// formulario, usando la API de Claude. La lógica vive en lib/analyzeForm.ts
// (así también la puede llamar /api/forms/submit sin un fetch a sí mismo).
//
// Se expone como endpoint para poder re-generar la ficha manualmente si hiciera
// falta (por ejemplo tras configurar la ANTHROPIC_API_KEY).

import { generateFicha } from '@/lib/analyzeForm';

interface Body {
  studentName?: string;
  teacherName?: string;
  plan?: string;
  level?: string;
  responsesText?: string;
}

export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'JSON inválido' }, { status: 400 });
  }

  if (!body.responsesText?.trim() || !body.studentName?.trim()) {
    return Response.json({ error: 'Faltan datos (studentName, responsesText).' }, { status: 400 });
  }

  const result = await generateFicha({
    studentName: body.studentName.trim(),
    teacherName: body.teacherName?.trim() || '',
    plan: body.plan,
    level: body.level,
    responsesText: body.responsesText,
  });

  return Response.json(result);
}
