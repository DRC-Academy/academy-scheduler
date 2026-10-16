// Datos de pago de UN profesor (IBAN + titular), para su Finanzas (/mis-clases).
//   GET ?teacherId=…                         → { details: {...} | null }
//   PUT { teacherId, iban, recipientName }   → { details } | 400 { error, fieldErrors }
//
// La tabla tiene RLS sin políticas: se lee y escribe con la service role. Hasta
// que haya login real, el teacherId llega del navegador (como en el resto de
// rutas del profesor); ver la sesión de seguridad pendiente.

import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { getPaymentDetails, savePaymentDetails, readPaymentBody, MissingPaymentTableError } from '@/lib/paymentDetailsStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
const SIN_CLAVE = { error: 'Falta SUPABASE_SERVICE_ROLE_KEY en el entorno.' };

export async function GET(request: Request): Promise<Response> {
  const teacherId = (new URL(request.url).searchParams.get('teacherId') ?? '').trim();
  if (!teacherId) return Response.json({ error: 'Falta teacherId.' }, { status: 400, headers: NO_STORE });
  const admin = getSupabaseAdmin();
  if (!admin) return Response.json(SIN_CLAVE, { status: 500, headers: NO_STORE });
  try {
    return Response.json({ details: await getPaymentDetails(admin, teacherId) }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof MissingPaymentTableError) return Response.json({ details: null, noConfigurado: true }, { headers: NO_STORE });
    console.error('[payment-details GET]', err);
    return Response.json({ error: 'No se pudieron cargar tus datos de pago.' }, { status: 500, headers: NO_STORE });
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
    if (err instanceof MissingPaymentTableError) return Response.json({ error: 'Esta sección todavía no está disponible.', noConfigurado: true }, { status: 503, headers: NO_STORE });
    console.error('[payment-details PUT]', err);
    return Response.json({ error: 'No se pudieron guardar tus datos. Inténtalo de nuevo.' }, { status: 500, headers: NO_STORE });
  }
}
