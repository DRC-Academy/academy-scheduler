// Idempotencia y auditoría de los cambios de horario: tabla schedule_change_requests
// (supabase/migraciones/2026-10-07-schedule-change-requests.sql). Cliente inyectado.
//
// Mismo comportamiento que lib/transferencia/auditoria.ts (transfer_requests):
// sin tabla o sin permiso se avisa una vez y el cambio sigue sin registro; la
// misma clave 'ok' devuelve lo guardado, 'en_curso' responde EN_CURSO, y
// 'error'/'compensada' se pueden reintentar.

import type { SupabaseClient } from '@supabase/supabase-js';
import { CambioHorarioError } from '@/lib/cambioHorario/errors';
import type { CambioHorarioResultado, ModoCambioHorario, OrigenCambioHorario, SesionDto } from '@/lib/cambioHorario/core';

type Db = SupabaseClient;

export interface DatosRegistro {
  idempotencyKey?: string;
  assignmentId: string;
  teacherId: string;
  modo: ModoCambioHorario;
  sesionAntes: SesionDto;
  sesionDespues: SesionDto;
  fechaOriginal: string | null;
  fechaNueva: string | null;
  origen: OrigenCambioHorario;
  actor: string;
}

interface FilaRegistro {
  id: string;
  assignment_id: string;
  modo: string;
  estado: 'en_curso' | 'ok' | 'error' | 'compensada';
  resultado: CambioHorarioResultado | null;
}

export type AperturaRegistro =
  | { tipo: 'nuevo'; id: string | null }
  | { tipo: 'repetido'; resultado: CambioHorarioResultado };

let avisadoSinRegistro = false;

function noDisponible(error: { code?: string } | null): boolean {
  return !!error && ['42P01', 'PGRST205', '42501', 'PGRST301'].includes(error.code ?? '');
}

function avisarSinRegistro(error: { code?: string; message?: string }): void {
  if (avisadoSinRegistro) return;
  avisadoSinRegistro = true;
  console.warn(
    `[cambio-horario] Sin registro en schedule_change_requests (${error.code}: ${error.message}). `
    + 'El cambio sigue sin idempotencia ni auditoría. ¿Falta correr supabase/migraciones/2026-10-07-schedule-change-requests.sql?',
  );
}

const enCurso = (key: string) => new CambioHorarioError({
  codigo: 'EN_CURSO', paso: 'idempotencia', mensaje: `ya hay un cambio de horario en curso con la clave ${key}`,
});
const fallo = (mensaje: string) => new CambioHorarioError({ codigo: 'ERROR_ESCRITURA', paso: 'idempotencia', mensaje });

const columnasDe = (d: DatosRegistro) => ({
  assignment_id:  d.assignmentId,
  teacher_id:     d.teacherId,
  modo:           d.modo,
  sesion_antes:   d.sesionAntes,
  sesion_despues: d.sesionDespues,
  fecha_original: d.fechaOriginal,
  fecha_nueva:    d.fechaNueva,
  origen:         d.origen,
  actor:          d.actor,
});

async function resolverExistente(db: Db, fila: FilaRegistro, d: DatosRegistro): Promise<AperturaRegistro> {
  if (fila.assignment_id !== d.assignmentId || fila.modo !== d.modo) {
    throw new CambioHorarioError({ codigo: 'DATOS_INVALIDOS', paso: 'idempotencia', mensaje: `la clave ${d.idempotencyKey} ya se usó para otro cambio` });
  }
  if (fila.estado === 'ok') {
    if (fila.resultado) return { tipo: 'repetido', resultado: fila.resultado };
    throw new CambioHorarioError({ codigo: 'DATOS_INVALIDOS', paso: 'idempotencia', mensaje: 'el cambio ya se hizo pero no guardó su resultado' });
  }
  if (fila.estado === 'en_curso') throw enCurso(d.idempotencyKey!);
  const { data, error } = await db.from('schedule_change_requests').update({
    ...columnasDe(d), estado: 'en_curso', error: null, finished_at: null, resultado: null,
  }).eq('id', fila.id).in('estado', ['error', 'compensada']).select('id');
  if (error) throw fallo(error.message);
  if (!data?.length) throw enCurso(d.idempotencyKey!);
  return { tipo: 'nuevo', id: fila.id };
}

/** Abre el registro de un cambio (y aplica la idempotencia si hay clave). */
export async function abrirRegistroCambio(db: Db, d: DatosRegistro): Promise<AperturaRegistro> {
  const key = d.idempotencyKey?.trim() || null;
  const columnas = 'id, assignment_id, modo, estado, resultado';

  if (key) {
    const { data, error } = await db.from('schedule_change_requests').select(columnas).eq('idempotency_key', key).maybeSingle();
    if (noDisponible(error)) { avisarSinRegistro(error!); return { tipo: 'nuevo', id: null }; }
    if (error) throw fallo(error.message);
    if (data) return resolverExistente(db, data as FilaRegistro, d);
  }

  const { data, error } = await db.from('schedule_change_requests')
    .insert({ idempotency_key: key, ...columnasDe(d), estado: 'en_curso' }).select('id').single();
  if (noDisponible(error)) { avisarSinRegistro(error!); return { tipo: 'nuevo', id: null }; }
  if (error?.code === '23505' && key) {
    const { data: otra } = await db.from('schedule_change_requests').select(columnas).eq('idempotency_key', key).maybeSingle();
    if (otra) return resolverExistente(db, otra as FilaRegistro, d);
    throw enCurso(key);
  }
  if (error) throw fallo(error.message);
  return { tipo: 'nuevo', id: (data as { id: string }).id };
}

/** Cierra el registro. Best-effort. */
export async function cerrarRegistroCambio(
  db: Db, id: string | null,
  fin: { estado: 'ok'; resultado: CambioHorarioResultado } | { estado: 'error' | 'compensada'; error: string },
): Promise<void> {
  if (!id) return;
  const { error } = await db.from('schedule_change_requests').update({
    estado:      fin.estado,
    error:       fin.estado === 'ok' ? null : fin.error,
    resultado:   fin.estado === 'ok' ? fin.resultado : null,
    finished_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) console.error(`[cambio-horario] No se pudo cerrar el registro ${id} como '${fin.estado}':`, error);
}
