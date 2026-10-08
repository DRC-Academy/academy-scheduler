// LMS → Gestión: el alumno cambia su horario con su mismo profesor.
// POST { alumno_id, modo, sesion_origen, fecha_origen?, destino, idempotency_key? }
// Cabecera x-lms-secret. Contrato: docs/autoservicio-contrato.md
//
// Toda la validación y la escritura las hace el núcleo (lib/cambioHorario/core.ts):
// revalida el destino aunque venga de GET huecos. El cambio solo está hecho si la
// respuesta trae `ok: true`.

import { readJson } from '@/lib/recoveryHttp';
import { cambiarHorarioServidor } from '@/lib/cambioHorario/server';
import type { CambioHorarioResultado, DestinoDto, SesionDto } from '@/lib/cambioHorario/core';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { autorizarLms, respuestaCodigo, respuestaError, respuestaOk } from '@/lib/cambioHorario/respuestas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface Cuerpo {
  alumno_id?: unknown;
  modo?: unknown;
  sesion_origen?: { dia?: unknown; hora?: unknown; duracion?: unknown };
  fecha_origen?: unknown;
  destino?: { dia?: unknown; hora?: unknown; duracion?: unknown; fecha?: unknown };
  idempotency_key?: unknown;
}

const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Solo los campos del contrato; lo demás se ignora. Los tipos los valida el núcleo. */
function sesion(v: Cuerpo['sesion_origen']): SesionDto {
  return { dia: texto(v?.dia), hora: texto(v?.hora), duracion: Number(v?.duracion) };
}

function respuesta(r: CambioHorarioResultado) {
  const s = (x: SesionDto) => ({ dia: x.dia, hora: x.hora, duracion: x.duracion });
  return {
    modo: r.modo,
    profesor: { nombre: r.profesor.name },
    sesion_antes: s(r.sesionAntes),
    sesion_despues: s(r.sesionDespues),
    fecha_original: r.fechaOriginal,
    fecha_nueva: r.fechaNueva,
  };
}

export async function POST(request: Request): Promise<Response> {
  const denegada = autorizarLms(request);
  if (denegada) return denegada;
  const b = await readJson<Cuerpo>(request);
  const alumnoId = texto(b?.alumno_id);
  const modo = texto(b?.modo);
  if (!b || !alumnoId || (modo !== 'puntual' && modo !== 'fijo') || !b.sesion_origen || !b.destino) {
    return respuestaCodigo('DATOS_INVALIDOS');
  }
  if (!getSupabaseAdmin()) return respuestaCodigo('NO_CONFIGURADO');

  const destino: DestinoDto = { ...sesion(b.destino), ...(texto(b.destino.fecha) ? { fecha: texto(b.destino.fecha) } : {}) };
  const clave = texto(b.idempotency_key) || request.headers.get('idempotency-key')?.trim() || undefined;
  try {
    const r = await cambiarHorarioServidor({
      studentId: alumnoId,
      modo,
      sesionOrigen: sesion(b.sesion_origen),
      fechaOrigen: texto(b.fecha_origen) || undefined,
      destino,
      origen: 'lms',
      actor: `alumno:${alumnoId}`,
      idempotencyKey: clave,
    });
    return respuestaOk(respuesta(r));
  } catch (err) {
    return respuestaError(err, 'lms/autoservicio/cambiar-horario');
  }
}
