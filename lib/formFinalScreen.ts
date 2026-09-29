// Qué muestra la pantalla final del formulario inicial. La usan el envío
// (/api/forms/submit) y la reapertura de un enlace ya completado
// (/api/forms/status), para que las dos digan exactamente lo mismo:
//
//   · 'start'     → "Vamos ahora con tu prueba de nivel" + Empezar test de nivel
//   · 'continue'  → lo mismo + Continuar test de nivel (retoma donde lo dejó)
//   · 'completed' → "Ya lo tienes todo listo…", sin botón
//   · null        → no se pudo preparar la prueba (raro): solo el agradecimiento
//
// El enlace sale SIEMPRE de lib/appUrl (URL pública), nunca del deployment.

import { publicBase } from '@/lib/appUrl';
import { resolveStudentTest } from '@/lib/levelTest/studentTest';

export type FinalTestState = 'start' | 'continue' | 'completed';

export interface FinalTest {
  state: FinalTestState;
  url: string | null;   // null solo en 'completed'
}

/** Campos de form_tokens que hacen falta para buscar o crear la prueba. */
export interface FormTokenForTest {
  student_id?: string | null;
  student_name: string;
  student_email?: string | null;
  teacher_id?: string | null;
  teacher_name?: string | null;
  assignment_id?: string | null;
  plan?: string | null;
  level?: string | null;
}

export async function finalTestFor(tk: FormTokenForTest, request: Request): Promise<FinalTest | null> {
  try {
    const t = await resolveStudentTest({
      studentId:    tk.student_id || undefined,
      studentName:  tk.student_name,
      studentEmail: tk.student_email || undefined,
      teacherId:    tk.teacher_id || undefined,
      teacherName:  tk.teacher_name || undefined,
      assignmentId: tk.assignment_id || undefined,
      plan:         tk.plan || undefined,
      level:        tk.level || undefined,
    });
    if (t.kind === 'completed') return { state: 'completed', url: null };
    return {
      state: t.started ? 'continue' : 'start',
      url: `${publicBase(request)}/test/${t.token}`,
    };
  } catch (e) {
    console.error('[formFinalScreen] No se pudo preparar la prueba de nivel:', e);
    return null;
  }
}
