// LMS → Gestión: el alumno cambia de profesor con TODAS sus sesiones (Fase 2).
// POST { alumno_id, profesor_id, destinos: [{ dia, hora, duracion }], idempotency_key? }
// Cabecera x-lms-secret. Contrato: docs/autoservicio-contrato.md
//
// Valida (lib/cambioProfesor/core.ts) y transfiere con el núcleo de siempre
// (transferirAlumnoServidor, motivo 'autoservicio', origen 'lms'). El cambio solo
// está hecho si la respuesta trae `ok: true`.

import { readJson } from '@/lib/recoveryHttp';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { groupByContiguousHour, hourNum, hourText } from '@/lib/sessions';
import { cambiarProfesorServidor } from '@/lib/cambioProfesor/server';
import type { DestinoProfesorDto } from '@/lib/cambioProfesor/core';
import type { AssignedSlot } from '@/types';
import { autorizarLms, respuestaCodigo, respuestaError, respuestaOk } from '@/lib/cambioHorario/respuestas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface Cuerpo {
  alumno_id?: unknown;
  profesor_id?: unknown;
  destinos?: Array<{ dia?: unknown; hora?: unknown; duracion?: unknown }>;
  idempotency_key?: unknown;
}

const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Horarios por hora → sesiones (horas seguidas del mismo día), como las ve el LMS. */
function sesiones(slots: AssignedSlot[]) {
  const porDia = new Map<string, number[]>();
  for (const s of slots) (porDia.get(s.day) ?? porDia.set(s.day, []).get(s.day)!).push(hourNum(s.hour));
  return [...porDia].flatMap(([dia, horas]) => groupByContiguousHour(horas, h => h, () => true)
    .map(run => ({ dia, hora: hourText(run[0]), duracion: run.length })));
}

export async function POST(request: Request): Promise<Response> {
  const denegada = autorizarLms(request);
  if (denegada) return denegada;
  const b = await readJson<Cuerpo>(request);
  const alumnoId = texto(b?.alumno_id);
  const profesorId = texto(b?.profesor_id);
  if (!b || !alumnoId || !profesorId || !Array.isArray(b.destinos)) return respuestaCodigo('DATOS_INVALIDOS');
  if (!getSupabaseAdmin()) return respuestaCodigo('NO_CONFIGURADO');

  // Solo los campos del contrato; los tipos los valida el núcleo.
  const destinos: DestinoProfesorDto[] = b.destinos.map(d => ({ dia: texto(d?.dia), hora: texto(d?.hora), duracion: Number(d?.duracion) }));
  const clave = texto(b.idempotency_key) || request.headers.get('idempotency-key')?.trim() || undefined;
  try {
    const r = await cambiarProfesorServidor({ studentId: alumnoId, profesorId, destinos, idempotencyKey: clave });
    return respuestaOk({
      profesor_anterior: { nombre: r.de.name },
      profesor_nuevo: { id: r.a.id, nombre: r.a.name },
      sesiones_antes: sesiones(r.slotsAntes),
      sesiones_despues: sesiones(r.slotsDespues),
    });
  } catch (err) {
    return respuestaError(err, 'lms/autoservicio/cambiar-profesor');
  }
}
