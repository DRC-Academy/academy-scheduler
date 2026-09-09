// El aviso de "hay un nivel para validar", cuando no hay a quién avisar todavía.
//
// SOLO SERVIDOR: envía email (RESEND_API_KEY) y escribe en la base.
//
// EL PROBLEMA. Al terminar el test de nivel se avisa al profesor del alumno.
// Pero el test se ofrece al terminar el FORMULARIO, y la asignación de profesor
// suele llegar después: en ese momento no hay destinatario y el aviso se perdía.
// El profesor recibía al alumno sin saber que tenía un nivel esperando su visto
// bueno, y el nivel del test se quedaba sin validar para siempre.
//
// LA SOLUCIÓN son dos funciones y una marca en la ficha
// (`level_validation_pending`, ver supabase-level-validation-pending.sql):
//
//   · `markLevelValidationPending` — al cerrar el test sin profesor: deja el
//     aviso en espera.
//   · `deliverPendingLevelNotice` — al asignarle profesor: si había un aviso en
//     espera, lo entrega y apaga la marca.
//
// Es idempotente por construcción: la marca se apaga al entregar, así que una
// segunda asignación no vuelve a escribir.

import { supabase } from '@/lib/supabase';
import { fetchTeacher, sendLevelValidationRequest } from '@/lib/emailNotifications';

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/** Localiza la ficha por id y, si no, por nombre — el cruce tolerante de siempre. */
async function findProfile(studentId: string | null | undefined, studentName: string) {
  const COLS = 'id, student_id, student_name, level_test_cefr, level_validation_pending, teacher_confirmed_level';
  if (studentId) {
    const { data } = await supabase.from('student_profiles').select(COLS).eq('student_id', studentId).maybeSingle();
    if (data) return data as unknown as ProfileRow;
  }
  const { data } = await supabase.from('student_profiles').select(COLS)
    .ilike('student_name', studentName.trim()).limit(1).maybeSingle();
  return (data ?? null) as unknown as ProfileRow | null;
}

interface ProfileRow {
  id: string;
  student_id: string | null;
  student_name: string | null;
  level_test_cefr: string | null;
  level_validation_pending?: boolean | null;
  teacher_confirmed_level: string | null;
}

/** La columna llega con supabase-level-validation-pending.sql. */
const faltaColumna = (code?: string) => code === '42703' || code === 'PGRST204';

/**
 * Deja el aviso en espera: el alumno terminó el test y nadie tiene que validarlo
 * todavía porque no tiene profesor.
 *
 * Best-effort, como todo lo que cuelga del cierre del test: si falla, el test se
 * cierra igual. Perder el aviso es malo; perder el resultado del test, peor.
 */
export async function markLevelValidationPending(
  studentId: string | null | undefined,
  studentName: string,
): Promise<void> {
  try {
    const profile = await findProfile(studentId, studentName);
    if (!profile) {
      console.warn(`[level-validation] Sin ficha para "${studentName}": el aviso no queda en espera.`);
      return;
    }
    const { error } = await supabase.from('student_profiles')
      .update({ level_validation_pending: true }).eq('id', profile.id);
    if (error) {
      console.warn(faltaColumna(error.code)
        ? '[level-validation] Falta correr supabase-level-validation-pending.sql: el aviso no queda en espera.'
        : `[level-validation] No se pudo marcar el aviso en espera: ${error.message}`);
    }
  } catch (err) {
    console.warn('[level-validation] No se pudo marcar el aviso en espera:', err);
  }
}

export interface DeliverResult {
  /** true = había un aviso en espera y se entregó. */
  delivered: boolean;
  reason?: 'sin_marca' | 'sin_ficha' | 'sin_nivel' | 'sin_profesor' | 'sin_columna' | 'error';
}

/**
 * Entrega el aviso que estaba en espera, si lo había.
 *
 * Se llama al asignarle profesor a un alumno. La gran mayoría de las veces no
 * hay nada que entregar y sale por `sin_marca` sin escribir nada — por eso la
 * consulta va por el índice parcial de la marca.
 *
 * La marca se apaga ANTES de dar por bueno el envío pero DESPUÉS de mandarlo:
 * si el email falla, se deja puesta para que un reintento posterior lo pille.
 */
export async function deliverPendingLevelNotice(args: {
  studentId?: string | null;
  studentName: string;
  teacherId: string;
}): Promise<DeliverResult> {
  try {
    const profile = await findProfile(args.studentId, args.studentName);
    if (!profile) return { delivered: false, reason: 'sin_ficha' };

    // `undefined` = la columna no existe todavía. No es "no hay aviso": es que no
    // se puede saber, y se dice distinto para que el log sea accionable.
    if (profile.level_validation_pending === undefined) return { delivered: false, reason: 'sin_columna' };
    if (!profile.level_validation_pending) return { delivered: false, reason: 'sin_marca' };
    if (!profile.level_test_cefr) return { delivered: false, reason: 'sin_nivel' };

    const teacher = await fetchTeacher(args.teacherId);
    if (!teacher) return { delivered: false, reason: 'sin_profesor' };

    const studentName = profile.student_name || args.studentName;

    const ok = await sendLevelValidationRequest(teacher, {
      studentName,
      studentId: profile.student_id ?? args.studentId ?? null,
      level: profile.level_test_cefr,
    });

    // La notificación in-app, igual que la que pone el submit del test cuando sí
    // hay profesor: las dos vías, para que no dependa de que abra el correo.
    await supabase.from('notifications').insert({
      id:          `notif_levelval_${Date.now()}`,
      target_user: args.teacherId,
      target_role: null,
      title:       `📝 ${studentName} tiene un nivel para validar`,
      body:        `Hizo el test de nivel antes de tener profesor. Resultado: ${profile.level_test_cefr}. Valídalo o corrígelo desde su ficha.`,
      type:        'level_test_completed',
      read_by:     [],
      created_at:  new Date().toISOString(),
      created_by:  'test-nivel',
    });

    if (!ok) {
      // El correo no salió: la marca se queda puesta para reintentarlo.
      console.warn(`[level-validation] Aviso de ${studentName} no enviado; la marca queda en espera.`);
      return { delivered: false, reason: 'error' };
    }

    await supabase.from('student_profiles')
      .update({ level_validation_pending: false }).eq('id', profile.id);

    console.log(`[level-validation] Aviso de ${studentName} entregado a ${teacher.name}.`);
    return { delivered: true };
  } catch (err) {
    console.error('[level-validation] No se pudo entregar el aviso:', err);
    return { delivered: false, reason: 'error' };
  }
}

/** Alumnos del profesor con nivel de test y sin validar. Para la tarjeta del panel. */
export interface NivelSinValidar {
  studentId: string | null;
  studentName: string;
  level: string;
}

export { norm as normalizeStudentName };
