// Idempotencia y auditoría de las transferencias: tabla transfer_requests
// (supabase/migraciones/2026-10-07-transfer-requests.sql). Cliente inyectado.
//
// Si la tabla no existe todavía o el cliente no tiene permiso (la anon key del
// navegador, con RLS), la transferencia funciona igual sin registro: se avisa
// una vez en consola y se sigue. Nunca frena una transferencia por la auditoría,
// salvo los dos casos que son su razón de ser: la clave ya está 'en_curso'
// (EN_CURSO) o ya terminó bien (se devuelve lo guardado sin repetir nada).

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AssignedSlot } from '@/types';
import { TransferenciaError } from '@/lib/transferencia/errors';
import type { TransferenciaParams, TransferenciaResultado } from '@/lib/transferencia/core';

type Db = SupabaseClient;

interface FilaRegistro {
  id: string;
  assignment_id: string;
  to_teacher_id: string;
  estado: 'en_curso' | 'ok' | 'error' | 'compensada';
  resultado: TransferenciaResultado | null;
}

export type AperturaRegistro =
  | { tipo: 'nuevo'; id: string | null }                      // id null = sin tabla o sin permiso
  | { tipo: 'repetido'; resultado: TransferenciaResultado };  // misma clave, ya terminó bien

let avisadoSinRegistro = false;

/** ¿El error significa "no hay tabla" o "este cliente no puede usarla"? */
function noDisponible(error: { code?: string } | null): boolean {
  return !!error && ['42P01', 'PGRST205', '42501', 'PGRST301'].includes(error.code ?? '');
}

function avisarSinRegistro(error: { code?: string; message?: string }): void {
  if (avisadoSinRegistro) return;
  avisadoSinRegistro = true;
  console.warn(
    `[transferencia] Sin registro en transfer_requests (${error.code}: ${error.message}). `
    + 'La transferencia sigue sin idempotencia ni auditoría. ¿Falta correr supabase/migraciones/2026-10-07-transfer-requests.sql '
    + 'o es el cliente anon del navegador?',
  );
}

const enCurso = (key: string): TransferenciaError => new TransferenciaError({
  codigo: 'EN_CURSO', paso: 'idempotencia',
  mensaje: `ya hay una transferencia en curso con la clave ${key}`,
});

/** Decide qué hacer con una fila existente de la misma clave. */
async function resolverExistente(db: Db, fila: FilaRegistro, params: TransferenciaParams): Promise<AperturaRegistro> {
  if (fila.assignment_id !== params.assignmentId || fila.to_teacher_id !== params.toTeacherId) {
    throw new TransferenciaError({
      codigo: 'DATOS_INVALIDOS', paso: 'idempotencia',
      mensaje: `la clave ${params.idempotencyKey} ya se usó para otra transferencia`,
    });
  }
  if (fila.estado === 'ok') {
    if (fila.resultado) return { tipo: 'repetido', resultado: fila.resultado };
    throw new TransferenciaError({ codigo: 'DATOS_INVALIDOS', paso: 'idempotencia', mensaje: 'la transferencia ya se hizo pero no guardó su resultado' });
  }
  if (fila.estado === 'en_curso') throw enCurso(params.idempotencyKey!);

  // 'error' o 'compensada': se puede reintentar con la misma clave. El reclamo es
  // condicionado: si dos reintentos se cruzan, solo uno pasa a 'en_curso'.
  const { data, error } = await db.from('transfer_requests').update({
    estado: 'en_curso', error: null, finished_at: null, resultado: null,
    slots_despues: params.slots, motivo: params.motivo, origen: params.origen, actor: params.actor,
  }).eq('id', fila.id).in('estado', ['error', 'compensada']).select('id');
  if (error) throw new TransferenciaError({ codigo: 'ERROR_ESCRITURA', paso: 'idempotencia', mensaje: error.message });
  if (!data?.length) throw enCurso(params.idempotencyKey!);
  return { tipo: 'nuevo', id: fila.id };
}

/** Abre el registro de una transferencia (y aplica la idempotencia si hay clave). */
export async function abrirRegistro(db: Db, params: TransferenciaParams): Promise<AperturaRegistro> {
  const key = params.idempotencyKey?.trim() || null;
  const columnas = 'id, assignment_id, to_teacher_id, estado, resultado';

  if (key) {
    const { data, error } = await db.from('transfer_requests').select(columnas).eq('idempotency_key', key).maybeSingle();
    if (noDisponible(error)) { avisarSinRegistro(error!); return { tipo: 'nuevo', id: null }; }
    if (error) throw new TransferenciaError({ codigo: 'ERROR_ESCRITURA', paso: 'idempotencia', mensaje: error.message });
    if (data) return resolverExistente(db, data as FilaRegistro, params);
  }

  const { data, error } = await db.from('transfer_requests').insert({
    idempotency_key: key,
    assignment_id:   params.assignmentId,
    to_teacher_id:   params.toTeacherId,
    slots_despues:   params.slots,
    motivo:          params.motivo,
    origen:          params.origen,
    actor:           params.actor,
    estado:          'en_curso',
  }).select('id').single();

  if (noDisponible(error)) { avisarSinRegistro(error!); return { tipo: 'nuevo', id: null }; }
  if (error?.code === '23505' && key) {
    // Otra petición con la misma clave entró entre la lectura y el insert.
    const { data: otra } = await db.from('transfer_requests').select(columnas).eq('idempotency_key', key).maybeSingle();
    if (otra) return resolverExistente(db, otra as FilaRegistro, params);
    throw enCurso(key);
  }
  if (error) throw new TransferenciaError({ codigo: 'ERROR_ESCRITURA', paso: 'idempotencia', mensaje: error.message });
  return { tipo: 'nuevo', id: (data as { id: string }).id };
}

/** Lo que se sabe del origen de la transferencia en cuanto se lee la asignación. */
export interface ContextoRegistro {
  fromTeacherId?: string;
  slotsAntes?: AssignedSlot[];
}

/** Cierra el registro. Best-effort: un fallo aquí no cambia el resultado de la transferencia. */
export async function cerrarRegistro(
  db: Db, id: string | null, ctx: ContextoRegistro,
  fin: { estado: 'ok'; resultado: TransferenciaResultado } | { estado: 'error' | 'compensada'; error: string },
): Promise<void> {
  if (!id) return;
  const { error } = await db.from('transfer_requests').update({
    estado:          fin.estado,
    error:           fin.estado === 'ok' ? null : fin.error,
    resultado:       fin.estado === 'ok' ? fin.resultado : null,
    from_teacher_id: ctx.fromTeacherId ?? null,
    slots_antes:     ctx.slotsAntes ?? null,
    finished_at:     new Date().toISOString(),
  }).eq('id', id);
  if (error) console.error(`[transferencia] No se pudo cerrar el registro ${id} como '${fin.estado}':`, error);
}
