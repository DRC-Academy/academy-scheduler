// Prueba del email de bienvenida desde el admin (pestaña Emails).
//
//   GET  ?assignmentId=X → { warnings, suggestedVariant }: lo que haría fallar el
//        envío real (sin email en la ficha, fuera de vista_perfil_alumno…).
//   POST { assignmentId, variant, to } → envía el email de ESA asignación SOLO a
//        `to`, con "[PRUEBA]" en el asunto.
//
// No escribe NADA en la base (ni welcome_email_*, ni tokens nuevos) y funciona
// con el interruptor apagado.
//
// TOPE ANTI-ABUSO. Como el resto de /api/admin, la ruta no tiene autenticación
// de servidor. Para que no sirva de relé de spam: solo destinos @drcacademy.com
// o de la lista WELCOME_TEST_EMAILS (separados por comas), y un envío cada 30 s.
// El reloj vive en memoria de la instancia: suficiente contra un clic repetido,
// no contra un ataque distribuido (que además solo podría escribir a esas
// direcciones).

import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { publicBase } from '@/lib/appUrl';
import { normEmail } from '@/lib/email';
import {
  decideWelcomeVariant, loadAssignmentForWelcome, sendWelcomeTest, welcomeTestWarnings,
} from '@/lib/welcomeEmailSend';
import type { WelcomeVariant } from '@/lib/welcomeEmail';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const PAUSA_MS = 30_000;
let ultimoEnvio = 0;

const VARIANTES: WelcomeVariant[] = ['bienvenida', 'cambio', 'adicional'];

function destinoPermitido(email: string): boolean {
  if (email.endsWith('@drcacademy.com')) return true;
  const lista = (process.env.WELCOME_TEST_EMAILS ?? '').split(',').map(e => normEmail(e)).filter(Boolean);
  return lista.includes(email);
}

export async function GET(request: Request): Promise<Response> {
  const assignmentId = new URL(request.url).searchParams.get('assignmentId')?.trim();
  if (!assignmentId) return Response.json({ error: 'Falta assignmentId.' }, { status: 400 });
  const admin = getSupabaseAdmin();
  if (!admin) return Response.json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY en el servidor.' }, { status: 500 });

  const a = await loadAssignmentForWelcome(admin, assignmentId);
  if (!a) return Response.json({ error: 'No se encontró la asignación.' }, { status: 404 });
  const [warnings, suggestedVariant] = await Promise.all([
    welcomeTestWarnings(admin, a),
    decideWelcomeVariant(admin, a, 'alta'),
  ]);
  return Response.json({ warnings, suggestedVariant });
}

export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null) as { assignmentId?: string; variant?: string; to?: string } | null;
  const assignmentId = body?.assignmentId?.trim();
  const variant = VARIANTES.find(v => v === body?.variant);
  const to = normEmail(body?.to);

  if (!assignmentId || !variant) return Response.json({ error: 'Falta la asignación o la variante.' }, { status: 400 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return Response.json({ error: 'El email de destino no es válido.' }, { status: 400 });
  if (!destinoPermitido(to)) {
    return Response.json({ error: 'Solo se puede enviar la prueba a direcciones @drcacademy.com o de la lista WELCOME_TEST_EMAILS.' }, { status: 403 });
  }
  const espera = ultimoEnvio + PAUSA_MS - Date.now();
  if (espera > 0) {
    return Response.json({ error: `Espera ${Math.ceil(espera / 1000)} s antes de mandar otra prueba.` }, { status: 429 });
  }

  const admin = getSupabaseAdmin();
  if (!admin) return Response.json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY en el servidor.' }, { status: 500 });
  const a = await loadAssignmentForWelcome(admin, assignmentId);
  if (!a) return Response.json({ error: 'No se encontró la asignación.' }, { status: 404 });

  ultimoEnvio = Date.now();
  try {
    const [res, warnings] = await Promise.all([
      sendWelcomeTest(admin, a, variant, to, publicBase(request)),
      welcomeTestWarnings(admin, a),
    ]);
    if (!res.ok) return Response.json({ error: `No se pudo enviar: ${res.error}`, warnings }, { status: 500 });
    return Response.json({ ok: true, resendId: res.resendId, warnings });
  } catch (err) {
    console.error('[welcome-email-test]', err);
    return Response.json({ error: err instanceof Error ? err.message : 'Error del servidor.' }, { status: 500 });
  }
}
