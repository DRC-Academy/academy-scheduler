// El profesor confirma o corrige el nivel CEFR del alumno tras las primeras
// clases. Respaldo humano a la prueba automática.
//
// NO pisa el nivel de la prueba: `level_test_cefr` queda como estaba. El del
// profesor va a columnas propias y manda a partir de ahí (ver lib/effectiveLevel).
// Guardar los dos por separado es lo que permite medir después cuánto acierta la
// prueba comparándola con el criterio de los profesores.
//
// Es un endpoint y no un update desde el navegador porque el alumno puede NO
// tener ficha todavía (la mayoría no completó el formulario): `ensureProfileId`
// la crea, y esa función es del servidor. Mismo patrón que generate-next-class.

import { ensureProfileId } from '@/lib/transcriptStore';
import { supabase } from '@/lib/supabase';

export const runtime = 'nodejs';

const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;
type Level = typeof LEVELS[number];

interface Body {
  profileId?: string | null;
  studentId?: string | null;
  studentName?: string;
  teacherId?: string | null;
  teacherName?: string;
  /** null = el profesor retira su confirmación y se vuelve al nivel de la prueba. */
  level?: string | null;
}

export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'JSON inválido' }, { status: 400 });
  }

  const studentName = body.studentName?.trim();
  if (!studentName) {
    return Response.json({ success: false, error: 'Falta el nombre del alumno.' }, { status: 400 });
  }

  const raw = typeof body.level === 'string' ? body.level.trim().toUpperCase() : null;
  if (raw !== null && !(LEVELS as readonly string[]).includes(raw)) {
    return Response.json(
      { success: false, error: `Nivel no válido. Valores admitidos: ${LEVELS.join(', ')}.` },
      { status: 400 },
    );
  }
  const level = raw as Level | null;

  const profileId = await ensureProfileId({
    profileId: body.profileId,
    studentId: body.studentId,
    studentName,
    teacherId: body.teacherId,
  });

  if (!profileId) {
    return Response.json(
      { success: false, error: 'No se pudo crear ni encontrar la ficha del alumno.' },
      { status: 500 },
    );
  }

  const now = new Date().toISOString();
  // Al retirar la confirmación se limpian los tres campos a la vez: dejar la
  // fecha y el autor de una confirmación que ya no existe haría que el admin
  // leyera "confirmado por Seba" junto a un nivel vacío.
  const { error } = await supabase.from('student_profiles').update({
    teacher_confirmed_level: level,
    teacher_confirmed_at:    level ? now : null,
    teacher_confirmed_by:    level ? (body.teacherName?.trim() || null) : null,
    updated_at:              now,
  }).eq('id', profileId);

  if (error) {
    console.error('[confirm-level] No se pudo guardar el nivel del profesor:', error);
    // 42703 / PGRST204 = supabase-teacher-level.sql todavía no se corrió. Se
    // distingue del resto para que el profesor lea algo accionable en vez de un
    // error de Postgres.
    const missing = error.code === '42703' || error.code === 'PGRST204';
    return Response.json({
      success: false,
      error: missing
        ? 'Falta correr supabase-teacher-level.sql en Supabase: la base todavía no tiene dónde guardar el nivel.'
        : `No se pudo guardar el nivel: ${error.message}`,
    }, { status: missing ? 503 : 500 });
  }

  return Response.json({
    success: true,
    profileId,
    level,
    confirmedAt: level ? now : null,
    confirmedBy: level ? (body.teacherName?.trim() || null) : null,
  });
}
