// Genera la primera clase completa a partir de la ficha del alumno.
// La lógica vive en lib/firstClass.ts.

import { generateFirstClass } from '@/lib/firstClass';
import type { FichaIA } from '@/lib/analyzeForm';

interface Body {
  studentProfile?: FichaIA | Record<string, unknown>;
  plan?: string;
  level?: string;
  studentName?: string;
  teacherName?: string;
}

export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'JSON inválido' }, { status: 400 });
  }

  if (!body.studentName?.trim() || !body.studentProfile || typeof body.studentProfile !== 'object') {
    return Response.json(
      { error: 'Faltan datos (studentName, studentProfile).' },
      { status: 400 },
    );
  }

  const result = await generateFirstClass({
    studentName: body.studentName.trim(),
    teacherName: body.teacherName?.trim() || '',
    plan: body.plan,
    level: body.level,
    studentProfile: body.studentProfile,
  });

  if (result.status !== 'ready') {
    return Response.json(
      { error: result.error ?? 'No se pudo generar la primera clase.', status: result.status },
      { status: 502 },
    );
  }
  return Response.json({ firstClass: result.data, status: result.status });
}
