// Cambio de profesor desde el SERVIDOR (service key). SOLO SERVIDOR.
//
// La validación de la Fase 2 (lib/cambioProfesor/core.ts) y, después, la
// transferencia de siempre con transferirAlumnoServidor (correos con Resend).

import 'server-only';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { transferirAlumnoServidor } from '@/lib/transferencia/server';
import type { TransferenciaResultado } from '@/lib/transferencia/core';
import { cambiarProfesorCore, type CambioProfesorParams } from '@/lib/cambioProfesor/core';

/** LANZA CambioHorarioError o TransferenciaError si no se hizo. */
export async function cambiarProfesorServidor(p: CambioProfesorParams): Promise<TransferenciaResultado> {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY: no se puede cambiar de profesor desde el servidor.');
  return cambiarProfesorCore(admin, p, transferirAlumnoServidor);
}
