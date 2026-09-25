// POST: envía el email de bienvenida al alumno de una asignación.
//
// Lo disparan SOLO dos sitios, de forma explícita y best-effort
// (triggerWelcomeEmail en lib/welcomeEmail):
//   · addAssignment (lib/TeachersContext), tras un alta correcta;
//   · dbChangeStudentTeacher (lib/db), tras el cambio de profesor.
// Ninguna herramienta de reparación o sincronización lo llama.
//
// Toda la lógica (interruptor, ventana de fechas, reclamo atómico, comprobación
// en vista_perfil_alumno, variante, envío y marcha atrás) está en
// lib/welcomeEmailSend. Body opcional: { reason: 'alta' | 'cambio_profesor' }.

import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { publicBase } from '@/lib/appUrl';
import { sendWelcomeForAssignment } from '@/lib/welcomeEmailSend';
import { WELCOME_EMAIL_ENABLED, type WelcomeReason } from '@/lib/welcomeEmail';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ assignmentId: string }> },
): Promise<Response> {
  const { assignmentId } = await params;
  if (!assignmentId) return Response.json({ error: 'Falta el id de la asignación.' }, { status: 400 });

  // Apagado: no se toca la base ni se lee nada.
  if (!WELCOME_EMAIL_ENABLED) return Response.json({ skipped: 'disabled' });

  const body = await request.json().catch(() => ({})) as { reason?: string };
  const reason: WelcomeReason = body.reason === 'cambio_profesor' ? 'cambio_profesor' : 'alta';

  const admin = getSupabaseAdmin();
  if (!admin) return Response.json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY en el servidor.' }, { status: 500 });

  try {
    const result = await sendWelcomeForAssignment(admin, assignmentId, reason, publicBase(request));
    if ('error' in result) {
      console.error(`[welcome-email] ${assignmentId}:`, result.error);
      return Response.json(result, { status: 500 });
    }
    return Response.json(result);
  } catch (err) {
    console.error(`[welcome-email] ${assignmentId}: excepción:`, err);
    return Response.json({ error: err instanceof Error ? err.message : 'Error del servidor.' }, { status: 500 });
  }
}
