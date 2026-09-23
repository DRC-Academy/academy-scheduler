// GET /api/admin/teacher-usage?semanas=12
//
// Dashboard "Uso de la plataforma" de la pestaña Profesores del admin: las seis
// métricas semana a semana (lunes a domingo, hora de España), globales y por
// profesor. Todo el cálculo pasa acá, en el servidor (lib/teacherUsageLoad): al
// navegador solo le llegan totales, nunca filas ni transcripts.
//
// SEGURIDAD: igual que el resto de /api/admin/*, hoy no pide sesión — la app
// todavía no tiene login de servidor (pendiente de la sesión de seguridad). Lo
// que devuelve son números agregados y nombres de profesores, nada de alumnos.

import { cargarInformeUso } from '@/lib/teacherUsageLoad';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pedidas = parseInt(url.searchParams.get('semanas') ?? '12', 10);
  const semanas = Number.isFinite(pedidas) ? Math.min(26, Math.max(4, pedidas)) : 12;
  try {
    const informe = await cargarInformeUso({ semanas });
    return Response.json(informe, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('[teacher-usage] No se pudo armar el informe:', err);
    return Response.json({ error: 'No se pudo calcular el uso de la plataforma.' }, { status: 500 });
  }
}
