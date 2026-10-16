// /api/admin/teacher-score-v2
//
// Pestaña "Scoring v2 (beta)" del admin (components/admin/ScoringV2Tab).
//   GET  → la última foto guardada en teacher_score_snapshots (una fila por profe).
//   POST → "Recalcular ahora": calcula con el motor (lib/teacherScore) y guarda la
//          foto de HOY (hora de España); recalcular el mismo día la pisa.
//
// La foto diaria la guarda además el cron check-ending-plans.
//
// SEGURIDAD: igual que el resto de /api/admin/*, hoy no pide sesión — la app
// todavía no tiene login de servidor (pendiente de la sesión de seguridad).
// Devuelve puntajes por profesor y nombres de alumnos en el detalle (bajas,
// clases fuera de plazo), lo mismo que ya ve el admin en otras pestañas.

import { guardarScoringV2, leerUltimoScoringV2 } from '@/lib/teacherScoreLoad';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(): Promise<Response> {
  try {
    return Response.json(await leerUltimoScoringV2(), { headers: NO_STORE });
  } catch (err) {
    console.error('[teacher-score-v2] No se pudo leer la última foto:', err);
    return Response.json({ error: 'No se pudo leer el scoring v2.' }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(): Promise<Response> {
  try {
    const { fecha, guardadas } = await guardarScoringV2();
    const ultimo = await leerUltimoScoringV2();
    return Response.json({ ...ultimo, recalculado: { fecha, guardadas } }, { headers: NO_STORE });
  } catch (err) {
    console.error('[teacher-score-v2] No se pudo recalcular:', err);
    return Response.json(
      { error: err instanceof Error ? err.message : 'No se pudo recalcular el scoring v2.' },
      { status: 500, headers: NO_STORE },
    );
  }
}
