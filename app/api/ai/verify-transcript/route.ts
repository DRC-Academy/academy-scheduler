// Endpoint de verificación de autenticidad de un transcript (Bloque 1, Capa 3 +
// orquestación de las 3 capas). Reutilizable de forma independiente: recibe el
// texto y devuelve el veredicto completo. El guardado real (analyze-transcript)
// usa la MISMA función `computeTranscriptVerdict`, así que este endpoint sirve
// para diagnóstico / previsualización sin persistir nada.

import { computeTranscriptVerdict } from '@/lib/transcriptVerdict';
import { flagLabel } from '@/lib/transcriptValidation';

interface Body {
  transcript?: string;
  teacherId?: string;
  teacherName?: string;
  studentName?: string;
  classDate?: string;
  level?: string | null;
  durationMinutes?: number;
  excludeId?: string | null;
}

export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try { body = await request.json(); }
  catch { return Response.json({ error: 'JSON inválido' }, { status: 400 }); }

  const transcript = body.transcript?.trim();
  if (!transcript) return Response.json({ error: 'Falta la transcripción.' }, { status: 400 });

  const verdict = await computeTranscriptVerdict({
    teacherId:       body.teacherId || '',
    teacherName:     body.teacherName?.trim() || '',
    studentName:     body.studentName?.trim() || '',
    classDate:       body.classDate || new Date().toISOString().slice(0, 10),
    transcript,
    level:           body.level,
    durationMinutes: body.durationMinutes,
    excludeId:       body.excludeId,
  });

  return Response.json({
    decision:      verdict.decision,
    score:         verdict.structure.score,
    valid:         verdict.structure.valid,
    flags:         verdict.flags,
    flagLabels:    verdict.flags.map(flagLabel),
    structure:     verdict.structure,
    cross:         verdict.cross,
    ai:            verdict.ai,
    aiRan:         verdict.aiRan,
    teacherTitle:  verdict.teacherTitle,
    teacherBody:   verdict.teacherBody,
  });
}
