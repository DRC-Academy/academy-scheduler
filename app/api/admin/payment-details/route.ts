// Datos de pago de TODOS los profesores, para /finanzas → "Datos de pago".
//   GET                                      → { teachers: [{ teacherId, teacherName, details | null }] }
//   PUT { teacherId, iban, recipientName }   → { details } | 400 { error, fieldErrors }
//
// RLS sin políticas: solo la service role. Misma validación que la ruta del
// profesor (lib/iban.ts, dentro de savePaymentDetails).

import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { listPaymentDetailsForAdmin, savePaymentDetails, readPaymentBody, MissingPaymentTableError } from '@/lib/paymentDetailsStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
const SIN_CLAVE = { error: 'Falta SUPABASE_SERVICE_ROLE_KEY en el entorno.' };

export async function GET(): Promise<Response> {
  const admin = getSupabaseAdmin();
  if (!admin) return Response.json(SIN_CLAVE, { status: 500, headers: NO_STORE });
  try {
    return Response.json({ teachers: await listPaymentDetailsForAdmin(admin) }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof MissingPaymentTableError) return Response.json({ teachers: [], noConfigurado: true }, { headers: NO_STORE });
    console.error('[admin/payment-details GET]', err);
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500, headers: NO_STORE });
  }
}

export async function PUT(request: Request): Promise<Response> {
  const body = await readPaymentBody(request);
  if (!body?.teacherId) return Response.json({ error: 'Falta teacherId.' }, { status: 400, headers: NO_STORE });
  const admin = getSupabaseAdmin();
  if (!admin) return Response.json(SIN_CLAVE, { status: 500, headers: NO_STORE });
  try {
    const r = await savePaymentDetails(admin, body.teacherId, body);
    if (!r.ok) return Response.json({ error: r.error, fieldErrors: r.fieldErrors }, { status: r.status, headers: NO_STORE });
    return Response.json({ details: r.details }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof MissingPaymentTableError) return Response.json({ error: 'Falta correr supabase-teacher-payment-details.sql.', noConfigurado: true }, { status: 503, headers: NO_STORE });
    console.error('[admin/payment-details PUT]', err);
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500, headers: NO_STORE });
  }
}
