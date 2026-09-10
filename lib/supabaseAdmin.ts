// ── Cliente de Supabase para el SERVIDOR (service role) ───────────────────────
//
// El cliente de lib/supabase.ts usa la anon key y está pensado para el navegador:
// la clave viaja en el bundle y es pública. Sirve mientras la base no tenga RLS,
// pero no es lo que quiero para una ruta que decide QUÉ ALUMNO puede ver una ficha
// a partir de una firma. Esa consulta la hace el servidor con la service role key,
// que nunca sale de él.
//
// SIN LA CLAVE, NULL. No cae a la anon key en silencio: quien lo use tiene que
// decidir qué hacer sin ella, y en /progreso-cuenta eso es cerrar la puerta. Un
// respaldo silencioso a una clave pública es exactamente el tipo de detalle que
// nadie vuelve a mirar.
//
// El nombre de la variable es SUPABASE_SERVICE_ROLE_KEY, sin NEXT_PUBLIC_: ese
// prefijo la publicaría en el navegador, que es justo lo contrario de esto.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null | undefined;

/**
 * El cliente con service role, o `null` si falta la configuración.
 *
 * Se crea una sola vez por proceso. No guarda sesión ni la refresca: cada petición
 * es de servidor y no hay usuario que persistir.
 */
export function getSupabaseAdmin(): SupabaseClient | null {
  if (cached !== undefined) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('[supabaseAdmin] Falta SUPABASE_SERVICE_ROLE_KEY (o la URL): las rutas que dependen de él quedan cerradas.');
    cached = null;
    return null;
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
