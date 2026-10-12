// Enlace MANUAL de un pedido de programa con un alumno de Gestión.
//
// Para los programas de menores: factura el padre, su email no es el del alumno
// y la sincronización no puede enlazarlos sola. Un enlace manual no lo pisa
// nunca la sincronización (lib/programSync.linkFor).
//
//   POST   { orderId, studentId, by }  → enlaza (trae el pedido de Woo si hace falta)
//   DELETE { orderId, by }             → quita el enlace manual; la próxima
//                                        sincronización vuelve a enlazar por email.

import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { wooCreds, linkProgramManually } from '@/lib/programSync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

async function handle(request: Request, unlink: boolean): Promise<Response> {
  const admin = getSupabaseAdmin();
  if (!admin) return Response.json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY' }, { status: 500 });

  let body: { orderId?: unknown; studentId?: unknown; by?: unknown };
  try { body = await request.json(); } catch { return Response.json({ error: 'Cuerpo JSON inválido' }, { status: 400 }); }

  // Admite "#35123" o "35123".
  const orderId = Number(String(body.orderId ?? '').replace(/[^\d]/g, ''));
  const studentId = typeof body.studentId === 'string' ? body.studentId.trim() : '';
  const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'admin';
  if (!orderId) return Response.json({ error: 'Falta el número de pedido' }, { status: 400 });
  if (!unlink && !studentId) return Response.json({ error: 'Falta el alumno' }, { status: 400 });

  try {
    const row = await linkProgramManually(admin, wooCreds(), orderId, unlink ? null : studentId, by);
    return Response.json({ ok: true, program: row });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export const POST = (request: Request) => handle(request, false);
export const DELETE = (request: Request) => handle(request, true);
