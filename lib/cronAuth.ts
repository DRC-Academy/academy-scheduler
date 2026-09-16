// Guardián común de los endpoints de cron (/api/cron/*). SOLO SERVIDOR.
//
// Dos comprobaciones, siempre en este orden, y las dos cierran el endpoint en
// vez de abrirlo cuando falta algo:
//
//   1. El SECRETO. Vercel invoca los crons con `Authorization: Bearer <CRON_SECRET>`
//      (lo manda solo con que la variable exista en el proyecto). Zapier o una
//      prueba manual pueden mandar la misma cabecera, o `?secret=` en la URL.
//      La comparación es en tiempo constante (secretsMatch, lib/externalAuth):
//      un `===` filtra el secreto carácter a carácter.
//   2. El CLIENTE ADMIN de Supabase (service role). Los crons escriben en tablas
//      internas y no dependen de que la anon key siga teniendo permisos cuando
//      se active RLS. Sin SUPABASE_SERVICE_ROLE_KEY se responde 500 con el nombre
//      de la variable: no se cae al cliente anon en silencio.

import type { SupabaseClient } from '@supabase/supabase-js';
import { secretsMatch } from '@/lib/externalAuth';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** `null` si la petición trae el secreto correcto; si no, la Response de error. */
export function requireCronSecret(request: Request, label: string): Response | null {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error(`[${label}] Falta CRON_SECRET en el entorno: el endpoint queda cerrado.`);
    return Response.json({ error: 'CRON_SECRET no configurado' }, { status: 500, headers: NO_STORE });
  }

  const header = request.headers.get('authorization') ?? '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  let query = '';
  try { query = new URL(request.url).searchParams.get('secret')?.trim() ?? ''; } catch { /* URL rara: sin query */ }

  const got = bearer || query;
  if (!got || !secretsMatch(got, expected)) {
    return Response.json(
      { error: 'No autorizado', hint: 'Cabecera Authorization: Bearer <CRON_SECRET> (o ?secret=).' },
      { status: 401, headers: NO_STORE },
    );
  }
  return null;
}

/** El cliente admin, o la Response 500 que explica qué variable falta. */
export function requireAdminClient(label: string): { admin: SupabaseClient; error: null } | { admin: null; error: Response } {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error(`[${label}] Falta SUPABASE_SERVICE_ROLE_KEY: el cron no se ejecuta.`);
    return {
      admin: null,
      error: Response.json(
        { error: 'Falta SUPABASE_SERVICE_ROLE_KEY en el entorno (Vercel → Settings → Environment Variables).' },
        { status: 500, headers: NO_STORE },
      ),
    };
  }
  return { admin, error: null };
}
