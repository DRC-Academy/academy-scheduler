// GET /api/progreso/diploma?token=<progress_tokens.token>
//
// El diploma del LMS para la ficha PÚBLICA de progreso (/progreso/[token]). Esa
// página es un componente cliente, y el secreto con el que se habla con el LMS
// no puede viajar al navegador: el navegador manda el token de la ficha, esta
// ruta lo resuelve a un alumno y pregunta al LMS desde el servidor.
//
// EL TOKEN ES LA AUTORIZACIÓN. Quien tiene el enlace de la ficha ya ve el
// informe entero; el diploma no le añade nada que no pueda ver. Se comprueba lo
// mismo que la página: que exista y que no haya caducado.
//
// SIN DISTINGUIR FALLOS. Token inválido, caducado, sin `student_id` (los enlaces
// viejos solo guardaron el nombre) o LMS sin respuesta: en todos los casos
// `{ diploma: null }` con 200. La ficha reacciona igual —sin barra— y probar
// tokens al azar no cuenta cuáles existen. Solo falta el parámetro es un 400.

import { supabase } from '@/lib/supabase';
import { getLmsDiploma } from '@/lib/lmsDiploma';

// El LMS puede tardar 8 s en el peor caso; la función tiene que poder esperarlo.
export const maxDuration = 15;
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get('token')?.trim() ?? '';
  if (!token || token.length > 128) {
    return Response.json({ error: 'token_requerido' }, { status: 400, headers: NO_STORE });
  }

  const { data: rows } = await supabase
    .from('progress_tokens')
    .select('student_id, expires_at')
    .eq('token', token)
    .limit(1);
  const row = (rows?.[0] ?? null) as { student_id: string | null; expires_at: string | null } | null;

  const vigente = !!row && (!row.expires_at || new Date(row.expires_at).getTime() >= Date.now());
  if (!vigente || !row?.student_id) {
    return Response.json({ diploma: null }, { headers: NO_STORE });
  }

  const diploma = await getLmsDiploma(row.student_id);
  return Response.json({ diploma }, { headers: NO_STORE });
}
