// Disparo de emails desde el cliente, vía /api/emails.
// Best-effort: nunca lanza — si el email falla, el flujo sigue igual.

interface EmailPayload {
  type: 'new_student' | 'milestone' | 'circular' | 'bonus';
  /** Obligatorio salvo en la circular a todo el equipo. */
  teacherId?: string;
  /** Circular a todos los profesores (el fan-out lo hace el servidor). */
  allTeachers?: boolean;
  /** Con `allTeachers`: ids que quedan fuera del envío ("todos excepto"). */
  excludeTeacherIds?: string[];
  studentName?: string;
  studentEmail?: string | null;
  plan?: string | null;
  level?: string | null;
  slots?: Array<{ day: string; hour: string }> | null;
  startDate?: string | null;
  milestone?: number;
  title?: string;
  body?: string;
}

export async function triggerEmail(payload: EmailPayload): Promise<boolean> {
  try {
    const res = await fetch('/api/emails', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    return Boolean(data?.sent);
  } catch (err) {
    console.error('[triggerEmail] No se pudo disparar el email:', err);
    return false;
  }
}
