// Lectura de los PROGRAMAS de alumnos (student_programs) para el panel.
//
// La tabla tiene RLS sin políticas (solo service role), así que el navegador la
// lee por acá:
//   GET /api/programas                       → todas las filas (panel de alumnos)
//   GET /api/programas?student=<id>&email=<e> → las de un alumno (ficha del profe)
//
// Sin la tabla (migración sin correr) responde una lista vacía con `missing`:
// las fichas simplemente no muestran la línea del programa.

import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import type { StudentProgramRow } from '@/lib/programs';

export const dynamic = 'force-dynamic';

const COLS =
  'order_id, email, billing_name, student_id, link_source, linked_by, linked_at, product_id, program, payment_mode, ' +
  'months, start_date, end_date, end_date_source, order_status, subscription_id, subscription_status, ' +
  'renewal_notified_at, renewal_notified_for, synced_at';

export async function GET(request: Request): Promise<Response> {
  const admin = getSupabaseAdmin();
  if (!admin) return Response.json({ programs: [], error: 'Falta SUPABASE_SERVICE_ROLE_KEY' }, { status: 500 });

  const q = new URL(request.url).searchParams;
  const student = q.get('student')?.trim() ?? '';
  const email = q.get('email')?.trim().toLowerCase() ?? '';

  let query = admin.from('student_programs').select(COLS).order('start_date', { ascending: false });
  if (student || email) {
    // Valores entre comillas: ids y emails llevan puntos, que el filtro `or` de
    // PostgREST usa como separador. Por email solo las filas sin enlazar: una fila
    // enlazada a mano a OTRO alumno no es de este aunque compartan email.
    const parts: string[] = [];
    if (student) parts.push(`student_id.eq."${student.replace(/"/g, '')}"`);
    if (email) parts.push(`and(email.eq."${email.replace(/"/g, '')}",student_id.is.null)`);
    query = query.or(parts.join(','));
  }

  const { data, error } = await query;
  if (error) {
    // 42P01 / PGRST205: la tabla no existe todavía.
    const missing = error.code === '42P01' || error.code === 'PGRST205';
    return Response.json({ programs: [], missing, error: missing ? undefined : error.message }, { status: missing ? 200 : 500 });
  }
  return Response.json({ programs: (data ?? []) as unknown as StudentProgramRow[] }, { headers: { 'Cache-Control': 'no-store' } });
}
