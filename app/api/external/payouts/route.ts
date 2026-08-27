// GET /api/external/payouts?month=YYYY-MM
//
// Gasto en profesores de UN mes: total del mes + detalle por profesor.
// Consumidor: drc-financial-dashboard (servidor a servidor).
//
// El array `teachers` trae SIEMPRE la plantilla entera del mes pedido (menos las
// cuentas de prueba, ver lib/externalTeachers): nunca se recorta por importe ni
// por actividad. Los tres contadores del mes miden cosas distintas —
// `teachers_total` la plantilla, `teachers_with_amount` los que facturaron ese
// mes, `active_teachers_now` los que tienen alumno hoy— y que no coincidan es lo
// esperado, no un profesor perdido.
//
// Si el mes es el ACTUAL, el importe es el cálculo en curso — lo que cada
// profesor lleva ganado hasta ahora según lo que ya trabajó. Si es un mes
// cerrado, es la liquidación de ese mes (congelada si se marcó como pagada).
// En los dos casos el número lo produce `calculateTeacherFinance`, la misma
// función que el panel del admin: ver lib/externalPayouts.

import { requireDashboardSecret } from '@/lib/externalAuth';
import {
  loadPayoutDataset, computeMonth, currentMonthYear, isValidMonth,
} from '@/lib/externalPayouts';

export const maxDuration = 60;
// El mes en curso cambia con cada clase registrada: no se cachea la respuesta.
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const denied = requireDashboardSecret(request);
  if (denied) return denied;

  const month = new URL(request.url).searchParams.get('month') ?? currentMonthYear();
  if (!isValidMonth(month)) {
    return Response.json(
      { error: 'mes_invalido', hint: 'Formato esperado: YYYY-MM (ej. 2026-08).', got: month },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const ds = await loadPayoutDataset();
    const result = computeMonth(ds, month);

    return Response.json(
      { generated_at: new Date().toISOString(), currency: 'EUR', ...result },
      {
        headers: {
          // Un mes cerrado ya no cambia salvo que el admin lo liquide: se deja
          // cachear un rato. El mes en curso, nunca.
          'Cache-Control': result.is_current_month ? 'no-store' : 'private, max-age=300',
        },
      },
    );
  } catch (e) {
    console.error('[external/payouts] fallo al calcular:', e);
    return Response.json(
      { error: 'error_interno' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
