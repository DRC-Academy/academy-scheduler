// GET /api/admin/registros?desde=&hasta=&alumno=&profe=&estado=
//
// "Registro para disputas": todas las clases del rango con su estado (reglas en
// lib/classRegister, lecturas en lib/classRegisterStore). SOLO LECTURA.
//
// SEGURIDAD: exige la sesión de admin (cookie httpOnly firmada, lib/adminSession).
// Sin ella, 401. Devuelve nombres de alumnos y profesores.

import { requireAdminSession } from '@/lib/adminSession';
import { requireAdminClient } from '@/lib/cronAuth';
import { loadRegister, normalizeFilter, RegisterRangeError } from '@/lib/classRegisterStore';
import { getSpainParts } from '@/lib/spainTime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const NO_STORE = { 'Cache-Control': 'no-store' };
const MAX_JSON_BYTES = 4 * 1024 * 1024;

export async function GET(request: Request): Promise<Response> {
  const session = requireAdminSession(request);
  if (session.error) return session.error;
  const { admin, error } = requireAdminClient('registros');
  if (error) return error;

  const q = new URL(request.url).searchParams;
  try {
    const filtro = normalizeFilter({
      desde: q.get('desde'), hasta: q.get('hasta'), alumno: q.get('alumno'), profe: q.get('profe'), estado: q.get('estado'),
    }, getSpainParts(new Date()).dateStr);
    // Tope de una respuesta de Vercel (4,5 MB): todos los profes de varios meses
    // pueden pasarlo. Mejor un aviso claro que una respuesta cortada.
    const body = JSON.stringify(await loadRegister(admin, filtro));
    if (Buffer.byteLength(body) > MAX_JSON_BYTES) {
      return Response.json({ error: 'Demasiadas clases para mostrarlas a la vez: acota el rango o filtra por profe o alumno.' }, { status: 413, headers: NO_STORE });
    }
    return new Response(body, { headers: { ...NO_STORE, 'Content-Type': 'application/json' } });
  } catch (err) {
    if (err instanceof RegisterRangeError) return Response.json({ error: err.message }, { status: 400, headers: NO_STORE });
    console.error('[admin/registros]', err);
    return Response.json({ error: 'No se pudo cargar el registro.' }, { status: 500, headers: NO_STORE });
  }
}
