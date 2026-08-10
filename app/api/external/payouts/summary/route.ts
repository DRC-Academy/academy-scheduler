// GET /api/external/payouts/summary?from=YYYY-MM&to=YYYY-MM
//
// Serie mensual del gasto en profesores, para el gráfico de tendencia del
// dashboard. Un punto por mes: total y nº de profesores activos. Sin detalle por
// profesor — para eso está /api/external/payouts?month=.
//
// Sin parámetros devuelve los últimos 12 meses terminando en el actual.
//
// COSTE: el dataset se lee UNA sola vez para todo el rango (11 consultas), así
// que pedir 12 meses cuesta lo mismo en base que pedir uno; lo que escala es el
// cálculo puro (27 profesores × N meses). Por eso no hace falta cachear los
// meses cerrados en una tabla: no habría nada que ahorrar.

import { requireDashboardSecret } from '@/lib/externalAuth';
import {
  loadPayoutDataset, computeMonth, currentMonthYear, isValidMonth, monthRange,
} from '@/lib/externalPayouts';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/** Tope de meses por petición. Evita que un `from=1970-01` cuelgue la función. */
const MAX_MONTHS = 60;

/** Resta `n` meses a un 'YYYY-MM'. */
function minusMonths(monthYear: string, n: number): string {
  const [y, m] = monthYear.split('-').map(Number);
  const total = y * 12 + (m - 1) - n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

export async function GET(request: Request): Promise<Response> {
  const denied = requireDashboardSecret(request);
  if (denied) return denied;

  const sp = new URL(request.url).searchParams;
  const current = currentMonthYear();
  const to = sp.get('to') ?? current;
  const from = sp.get('from') ?? minusMonths(to, 11);

  for (const [name, value] of [['from', from], ['to', to]] as const) {
    if (!isValidMonth(value)) {
      return Response.json(
        { error: 'mes_invalido', hint: 'Formato esperado: YYYY-MM (ej. 2026-08).', param: name, got: value },
        { status: 400, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  }

  const months = monthRange(from, to);
  if (months.length === 0) {
    return Response.json(
      { error: 'rango_invalido', hint: '`from` no puede ser posterior a `to`.', from, to },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (months.length > MAX_MONTHS) {
    return Response.json(
      { error: 'rango_demasiado_largo', hint: `Máximo ${MAX_MONTHS} meses por petición.`, months: months.length },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const ds = await loadPayoutDataset();
    const serie = months.map(m => {
      const r = computeMonth(ds, m);
      return {
        month_year: r.month_year,
        is_current_month: r.is_current_month,
        total_amount: r.total_amount,
        // El que varía mes a mes. Es el que hay que graficar junto al importe.
        teachers_with_amount: r.teachers_with_amount,
        // Foto de HOY, idéntica en todos los puntos de la serie. Ver MonthPayouts.
        active_teachers_now: r.active_teachers_now,
      };
    });

    return Response.json(
      {
        generated_at: new Date().toISOString(),
        currency: 'EUR',
        from, to,
        months: serie.length,
        // Total del rango. El mes en curso entra con lo acumulado hasta ahora,
        // así que este número sube durante el mes: no es un cierre.
        total_amount: Math.round(serie.reduce((s, r) => s + r.total_amount, 0) * 100) / 100,
        includes_current_month: serie.some(r => r.is_current_month),
        series: serie,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    console.error('[external/payouts/summary] fallo al calcular:', e);
    return Response.json(
      { error: 'error_interno' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
