// Genera la siguiente clase del alumno (o la primera, si no hay historial).
// Si se pasa `persist`, la guarda en student_profiles.next_class_content.

import { supabase } from '@/lib/supabase';
import { generateNextClass } from '@/lib/nextClass';
import type { FichaIA, TranscriptIA } from '@/lib/aiTypes';

interface Body {
  studentProfile?: FichaIA | Record<string, unknown>;
  lastAnalysis?: TranscriptIA | Record<string, unknown> | null;
  classHistory?: unknown[] | null;
  classNumber?: number;
  studentName?: string;
  teacherName?: string;
  plan?: string;
  level?: string;
  persist?: boolean;
  profileId?: string | null;
}

export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'JSON inválido' }, { status: 400 });
  }

  if (!body.studentName?.trim() || !body.studentProfile || typeof body.studentProfile !== 'object') {
    return Response.json({ error: 'Faltan datos (studentName, studentProfile).' }, { status: 400 });
  }

  const result = await generateNextClass({
    studentName: body.studentName.trim(),
    teacherName: body.teacherName?.trim() || '',
    plan: body.plan,
    level: body.level,
    classNumber: body.classNumber && body.classNumber > 0 ? body.classNumber : 1,
    studentProfile: body.studentProfile,
    lastAnalysis: body.lastAnalysis,
    classHistory: body.classHistory,
  });

  if (result.status !== 'ready' || !result.data) {
    return Response.json(
      { error: result.error ?? 'No se pudo generar la clase.', status: result.status },
      { status: 502 },
    );
  }

  if (body.persist && body.profileId) {
    const { error } = await supabase.from('student_profiles').update({
      next_class_content:      result.data,
      next_class_generated_at: new Date().toISOString(),
      updated_at:              new Date().toISOString(),
    }).eq('id', body.profileId);
    if (error) console.error('[generate-next-class] No se pudo guardar next_class_content:', error);
  }

  return Response.json({ nextClass: result.data, status: result.status });
}
