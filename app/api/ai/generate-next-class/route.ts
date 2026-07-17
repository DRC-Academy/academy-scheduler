// Genera la siguiente clase del alumno (o la primera, si no hay historial).
//
// La clase se PERSISTE siempre que se pueda identificar la ficha: se guarda en
// cuanto se genera, sin esperar a que el profesor pulse nada. Si no, cerrar la
// pestaña tiraba a la basura una generación que ya se pagó.
// Si no le gusta, regenera — se sobrescribe.

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
  profileId?: string | null;
  studentId?: string | null;
}

export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'JSON inválido' }, { status: 400 });
  }

  const studentName = body.studentName?.trim();
  if (!studentName || !body.studentProfile || typeof body.studentProfile !== 'object') {
    return Response.json(
      { success: false, error: 'Faltan datos (studentName, studentProfile).' },
      { status: 400 },
    );
  }

  const result = await generateNextClass({
    studentName,
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
      { success: false, error: result.error ?? 'No se pudo generar la clase.', status: result.status },
      { status: 502 },
    );
  }

  // Persistencia inmediata. Si falla, devolvemos la clase igual (el profesor la
  // tiene delante y puede copiarla) pero avisamos de que no quedó guardada.
  let saved = false;
  let saveError: string | undefined;
  const profileId = await resolveProfileId(body, studentName);

  if (profileId) {
    const now = new Date().toISOString();
    const { error } = await supabase.from('student_profiles').update({
      next_class_content:      result.data,
      next_class_generated_at: now,
      updated_at:              now,
    }).eq('id', profileId);

    if (error) {
      console.error('[generate-next-class] No se pudo guardar next_class_content:', error);
      saveError = error.message;
    } else {
      saved = true;
    }
  } else {
    saveError = 'No se encontró la ficha del alumno para guardar la clase.';
    console.error(`[generate-next-class] Sin ficha para "${studentName}": la clase no se persiste.`);
  }

  return Response.json({
    success: true,
    classContent: result.data,
    nextClass: result.data,   // alias, por compatibilidad
    saved,
    saveError,
  });
}

async function resolveProfileId(body: Body, studentName: string): Promise<string | null> {
  if (body.profileId) return body.profileId;
  if (body.studentId) {
    const { data } = await supabase.from('student_profiles').select('id')
      .eq('student_id', body.studentId).maybeSingle();
    if (data) return data.id;
  }
  const { data } = await supabase.from('student_profiles').select('id')
    .ilike('student_name', studentName).maybeSingle();
  return data?.id ?? null;
}
