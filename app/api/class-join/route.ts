// POST: registra el ingreso a clase del profesor (botón "Ingresar a clase").
//
// Antes lo insertaba el navegador con la anon key. Ahora lo escribe el servidor
// con la service role, y así puede añadir lo que el navegador no sabe de sí
// mismo: la IP y el user agent (prueba de servicio ante disputas de pago). La
// fila es la de siempre (lib/classJoinStore), con la guarda de doble clic.
//
// Hasta que haya login real, el teacherId llega del navegador, igual que antes
// con la inserción directa; ver la sesión de seguridad pendiente.
//
// Body: { teacherId, teacherName, studentName, scheduledDate, scheduledTime,
//         subscriptionStatus?, enteredWithoutActive?, subscriptionDaysRemaining?, durationHours? }
// Respuestas: 200 ClassJoinLog · 400 { error } · 409 { error: 'pago_pendiente' } · 500 { error }.
//
// PAGO PENDIENTE: si la clase empieza dentro de un episodio de on-hold del alumno
// (lib/paymentHolds), el ingreso NO se registra, aunque se llame a la API a mano
// o la página lleve abierta desde antes. Esa clase no existe a ningún efecto.

import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { logClassJoinWith, requestOriginOf, type ClassJoinInput } from '@/lib/classJoinStore';
import { classJoinBlockedByHold } from '@/lib/paymentHoldStore';
import { PAYMENT_HOLD_ERROR, PAYMENT_HOLD_JOIN_BODY } from '@/lib/paymentHolds';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

function readBody(raw: unknown): ClassJoinInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  const teacherId = text(b.teacherId), teacherName = text(b.teacherName), studentName = text(b.studentName);
  const scheduledDate = text(b.scheduledDate), scheduledTime = text(b.scheduledTime);
  if (!teacherId || !teacherName || !studentName || !scheduledDate || !scheduledTime) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) return null;
  return {
    teacherId, teacherName, studentName, scheduledDate, scheduledTime,
    subscriptionStatus: typeof b.subscriptionStatus === 'string' ? b.subscriptionStatus : undefined,
    enteredWithoutActive: b.enteredWithoutActive === true,
    subscriptionDaysRemaining: typeof b.subscriptionDaysRemaining === 'number' ? b.subscriptionDaysRemaining : null,
    durationHours: typeof b.durationHours === 'number' ? b.durationHours : 1,
  };
}

export async function POST(request: Request): Promise<Response> {
  const input = readBody(await request.json().catch(() => null));
  if (!input) return Response.json({ error: 'Faltan datos del ingreso.' }, { status: 400, headers: NO_STORE });

  const admin = getSupabaseAdmin();
  if (!admin) return Response.json({ error: 'No se pudo registrar el ingreso (falta configuración del servidor).' }, { status: 500, headers: NO_STORE });

  if (await classJoinBlockedByHold(admin, input)) {
    return Response.json({ error: PAYMENT_HOLD_ERROR, message: PAYMENT_HOLD_JOIN_BODY }, { status: 409, headers: NO_STORE });
  }

  try {
    const log = await logClassJoinWith(admin, input, requestOriginOf(request.headers));
    return Response.json(log, { headers: NO_STORE });
  } catch (err) {
    console.error('[class-join POST]', err);
    return Response.json({ error: err instanceof Error ? err.message : 'No se pudo registrar el ingreso.' }, { status: 500, headers: NO_STORE });
  }
}
