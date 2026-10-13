// LMS → Gestión: el alumno cambia de profesor con TODAS sus sesiones (Fase 2,
// contrato v3). POST { alumno_id, destinos: [{ dia, hora, duracion }], idempotency_key? }
// Cabecera x-lms-secret. Contrato: docs/autoservicio-contrato.md
//
// El alumno elige solo horarios: el profesor lo elige Gestión en el momento
// (lib/cambioProfesor/core.ts) y transfiere con el núcleo de siempre
// (transferirAlumnoServidor, motivo 'autoservicio', origen 'lms'). Un
// `profesor_id` en el cuerpo se ignora. El cambio solo está hecho si la
// respuesta trae `ok: true`; del profesor nuevo solo sale el nombre.

import { readJson } from '@/lib/recoveryHttp';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { sesionesDeSlots } from '@/lib/cambioHorario/sesiones';
import { cambiarProfesorServidor } from '@/lib/cambioProfesor/server';
import type { DestinoProfesorDto } from '@/lib/cambioProfesor/core';
import { autorizarLms, respuestaCodigo, respuestaError, respuestaOk } from '@/lib/cambioHorario/respuestas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface Cuerpo {
  alumno_id?: unknown;
  destinos?: Array<{ dia?: unknown; hora?: unknown; duracion?: unknown }>;
  idempotency_key?: unknown;
}

const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export async function POST(request: Request): Promise<Response> {
  const denegada = autorizarLms(request);
  if (denegada) return denegada;
  const b = await readJson<Cuerpo>(request);
  const alumnoId = texto(b?.alumno_id);
  if (!b || !alumnoId || !Array.isArray(b.destinos)) return respuestaCodigo('DATOS_INVALIDOS');
  if (!getSupabaseAdmin()) return respuestaCodigo('NO_CONFIGURADO');

  // Solo los campos del contrato; los tipos los valida el núcleo.
  const destinos: DestinoProfesorDto[] = b.destinos.map(d => ({ dia: texto(d?.dia), hora: texto(d?.hora), duracion: Number(d?.duracion) }));
  const clave = texto(b.idempotency_key) || request.headers.get('idempotency-key')?.trim() || undefined;
  try {
    const r = await cambiarProfesorServidor({ studentId: alumnoId, destinos, idempotencyKey: clave });
    return respuestaOk({
      profesor: { nombre: r.a.name },
      sesiones_antes: sesionesDeSlots(r.slotsAntes),
      sesiones_despues: sesionesDeSlots(r.slotsDespues),
    });
  } catch (err) {
    return respuestaError(err, 'lms/autoservicio/cambiar-profesor');
  }
}
