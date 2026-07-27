// Captura la "foto" de señales de churn de UN alumno.
//
// Existe porque la captura tiene que correr en el servidor (lee varias tablas y
// llama a la IA) pero la BAJA se hace desde el navegador, en el panel de admin.
// `dbDeleteStudent` (lib/db.ts) llama aquí justo antes de borrar al alumno.
//
// En DRC las bajas son SIEMPRE manuales: el admin ve el estado "cancelado" en
// WooSubscriptions y elimina al alumno del software. Sin este endpoint, esa vía
// no dejaba ningún ejemplo etiquetado y el dataset de predicción se quedaba
// vacío (el webhook de WooCommerce nunca se llegó a disparar).
//
// Es BEST-EFFORT: si algo falla, se devuelve 200 con captured:false. La baja del
// alumno no se puede quedar bloqueada por esto.

import { captureChurnSnapshot } from '@/lib/churnSnapshot';

export const runtime = 'nodejs';
export const maxDuration = 60;

interface Body {
  studentId?: string | null;
  studentName?: string;
  teacherId?: string | null;
  /** 'manual_dropout' (baja a mano), 'cancellation' (webhook), 'manual' (a demanda). */
  trigger?: 'cancellation' | 'manual_dropout' | 'manual';
  label?: 'churned' | 'active';
  /** Fecha real de la baja, si no es ahora (backfill). */
  asOfIso?: string;
}

export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try {
    body = await request.json();
  } catch (err) {
    console.error('[churn/capture] JSON inválido:', err);
    return Response.json({ captured: false, error: 'JSON inválido' }, { status: 400 });
  }

  const studentName = body.studentName?.trim();
  if (!studentName) {
    return Response.json({ captured: false, error: 'Falta studentName.' }, { status: 400 });
  }

  try {
    const snap = await captureChurnSnapshot({
      studentId:   body.studentId ?? null,
      studentName,
      teacherId:   body.teacherId ?? null,
      trigger:     body.trigger ?? 'manual_dropout',
      label:       body.label ?? 'churned',
      asOfIso:     body.asOfIso,
    });

    if (!snap) {
      console.warn(`[churn/capture] Sin foto para ${studentName} (¿falta correr supabase-churn.sql?).`);
      return Response.json({ captured: false, reason: 'sin_tabla_o_sin_datos' });
    }

    console.log(`[churn/capture] ${studentName}: riesgo ${snap.combinedRisk}/100 (determinista ${snap.signals.deterministicRisk}, ${snap.signals.classesAnalyzed} clases).`);
    return Response.json({
      captured: true,
      id: snap.id,
      combinedRisk: snap.combinedRisk,
      classesAnalyzed: snap.signals.classesAnalyzed,
    });
  } catch (err) {
    // Nunca se devuelve 500: quien llama está borrando un alumno y no debe fallar.
    console.error('[churn/capture] Error al capturar la foto:', err);
    return Response.json({ captured: false, error: 'Error al capturar la foto de churn.' });
  }
}
