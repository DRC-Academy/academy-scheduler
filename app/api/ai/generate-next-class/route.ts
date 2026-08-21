// Genera la siguiente clase del alumno (o la primera, si no hay historial).
//
// La clase se PERSISTE siempre: se guarda en cuanto se genera, sin esperar a que
// el profesor pulse nada. Si no, cerrar la pestaña tiraba a la basura una
// generación que ya se pagó. Si no le gusta, regenera — se sobrescribe.
// Si el alumno no tiene ficha, se le crea una mínima donde colgarla (la misma
// que crea el análisis de transcripciones: ver ensureProfileId).
//
// Dos modos:
//   · Con ficha    → `studentProfile` manda.
//   · Clase genérica → `generic` presente y sin ficha: el profesor eligió nivel,
//     dominio y tipo de clase, y como mucho añadió tema y contexto.

import { generateNextClass } from '@/lib/nextClass';
import { ensureProfileId } from '@/lib/transcriptStore';
import { supabase } from '@/lib/supabase';
export const runtime = 'nodejs';
// Llamada a la IA: sin esto la plataforma corta la función a los pocos segundos.
export const maxDuration = 60;
import type {
  AvatarDomain, ClassType, FichaIA, GenericClassBrief, TranscriptIA,
} from '@/lib/aiTypes';

interface Body {
  studentProfile?: FichaIA | Record<string, unknown> | null;
  /** Clase genérica (alumno sin ficha). Su presencia activa el modo. */
  generic?: GenericClassBrief | null;
  lastAnalysis?: TranscriptIA | Record<string, unknown> | null;
  classHistory?: unknown[] | null;
  classNumber?: number;
  studentName?: string;
  teacherName?: string;
  plan?: string;
  level?: string;
  domain?: AvatarDomain | null;
  classType?: ClassType | null;
  profileId?: string | null;
  studentId?: string | null;
  teacherId?: string | null;
}

const str = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s.slice(0, 1000) : null;
};

export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'JSON inválido' }, { status: 400 });
  }

  const studentName = body.studentName?.trim();
  const hasProfile = !!body.studentProfile && typeof body.studentProfile === 'object';
  // La clase genérica es la salida para el alumno sin ficha: no exige perfil,
  // pero tampoco lo simula (ver lib/nextClass).
  const generic: GenericClassBrief | null = body.generic && typeof body.generic === 'object'
    ? { focus: str(body.generic.focus), context: str(body.generic.context) }
    : null;

  if (!studentName || (!hasProfile && !generic)) {
    return Response.json(
      { success: false, error: 'Faltan datos (studentName y, o bien studentProfile, o bien generic).' },
      { status: 400 },
    );
  }

  const result = await generateNextClass({
    studentName,
    teacherName: body.teacherName?.trim() || '',
    plan: body.plan,
    level: body.level,
    classNumber: body.classNumber && body.classNumber > 0 ? body.classNumber : 1,
    // Con `generic` la ficha se ignora aunque venga: los dos bloques a la vez le
    // darían al modelo un perfil y la orden de no usarlo.
    studentProfile: generic ? null : body.studentProfile,
    generic,
    lastAnalysis: body.lastAnalysis,
    classHistory: body.classHistory,
    domain: body.domain,
    classType: body.classType,
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
  // `ensureProfileId` la crea si no existe (ficha mínima, ai_status 'auto'). Sin
  // esto, a un alumno sin ficha la clase genérica se le generaba y se perdía al
  // recargar: no había fila donde guardarla.
  const profileId = await ensureProfileId({
    profileId:   body.profileId,
    studentId:   body.studentId,
    studentName,
    teacherId:   body.teacherId,
  });

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
    saveError = 'No se pudo crear ni encontrar la ficha del alumno para guardar la clase.';
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
