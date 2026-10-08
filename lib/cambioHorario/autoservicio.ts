// Lecturas del autoservicio del LMS: GET estado y GET huecos. Contrato:
// docs/autoservicio-contrato.md. Cliente de Supabase inyectado (las rutas pasan
// el de service key); NO escriben nada.
//
// No hay reglas propias: elegibilidad (elegibilidad.ts), origen (origen.ts),
// destino (evaluarBloque / calcularBloques de lib/huecos) y calendario sin
// actualizar (estadoCalendarioWith) son las mismas funciones que usa el núcleo
// antes de escribir. Así lo que se muestra es lo que el POST va a aceptar.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Grid } from '@/types';
import { readTeacherGridWith } from '@/lib/calendarStore';
import { liveReservationsWith, openRecoveriesOfStudentWith } from '@/lib/classRecoveryQueries';
import { getSpainParts, spainWallClockToEpoch } from '@/lib/spainTime';
import { addDaysIso, dayNameFromIso } from '@/lib/teacherClasses';
import { VENTANA_PUNTUAL_DIAS, calcularBloques, estadoCalendarioWith, type ModoCambio } from '@/lib/huecos/huecos';
import { cargarElegibilidadWith } from '@/lib/cambioHorario/elegibilidad';
import { sesionesDelAlumno, type Sesion } from '@/lib/cambioHorario/sesiones';
import { evaluarOrigen, type MomentoEspana } from '@/lib/cambioHorario/origen';
import { CambioHorarioError, type CodigoCambioHorario, type DetalleNoElegible } from '@/lib/cambioHorario/errors';
import { puedeCambiarProfesorWith, type PuedeCambiarProfesorDto } from '@/lib/cambioProfesor/core';

type Db = SupabaseClient;

// ── DTOs del contrato (snake_case) ────────────────────────────────────────────

export type MotivoNoElegible = Extract<CodigoCambioHorario, 'NO_ELEGIBLE' | 'RECUPERACION_PENDIENTE' | 'CALENDARIO_SIN_ACTUALIZAR'>;
export type MotivoNoMovible = Extract<CodigoCambioHorario, 'ANTELACION_INSUFICIENTE' | 'MARCA_PUNTUAL_EXISTENTE'>;

export interface MovibleDto {
  movible: boolean;
  motivo_no_movible: MotivoNoMovible | null;
  /** Cuándo deja de aplicar el motivo, en hora de España peninsular. null si no aplica. */
  disponible_desde: MomentoEspana | null;
}

export interface ClaseDto extends MovibleDto { fecha: string; hora: string; duracion: number }

export interface SesionEstadoDto {
  /** Lo que GET huecos espera en `sesion`: "<dia>_<HH:MM>". */
  id: string;
  dia: string;
  hora: string;
  duracion: number;
  /** "Desde ahora": cambiar el horario fijo. */
  fijo: MovibleDto;
  /** "Solo esta clase": las clases de esta sesión de las próximas 6 semanas que aún no empezaron. */
  proximas_clases: ClaseDto[];
}

export interface EstadoDto {
  ok: true;
  elegible: boolean;
  motivo_no_elegible: MotivoNoElegible | null;
  detalle_no_elegible: DetalleNoElegible | null;
  profesor: { nombre: string } | null;
  sesiones: SesionEstadoDto[];
  /** Fase 2: si puede pedir cambio de profesor ahora, y si no, por qué y desde cuándo. */
  puede_cambiar_profesor: PuedeCambiarProfesorDto;
}

export interface HuecoDto { dia: string; hora: string; duracion: number; fecha: string }

export interface HuecosDto {
  ok: true;
  modo: ModoCambio;
  sesion: { id: string; dia: string; hora: string; duracion: number };
  fecha_origen: string | null;
  huecos: HuecoDto[];
}

// ── Carga común ───────────────────────────────────────────────────────────────

interface Contexto {
  alumno: string;
  profe: { id: string; name: string; calendar_start_hour: number | null; calendar_end_hour: number | null };
  grid: Grid;
  sesiones: Sesion[];
}

type Carga =
  | { tipo: 'ok'; ctx: Contexto }
  | { tipo: 'bloqueado'; motivo: MotivoNoElegible; detalle: DetalleNoElegible | null; profesor: string | null };

const falla = (codigo: CodigoCambioHorario, mensaje: string, cause?: unknown): never => {
  throw new CambioHorarioError({ codigo, paso: 'lectura', mensaje, cause });
};
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Mismo orden que el núcleo: elegibilidad → recuperaciones → profesor → calendario al día. */
async function cargar(db: Db, studentId: string, ahora: number): Promise<Carga> {
  let carga: Awaited<ReturnType<typeof cargarElegibilidadWith>>;
  try {
    carga = await cargarElegibilidadWith(db, studentId);
  } catch (err) {
    return falla('ERROR_LECTURA', errMsg(err), err);
  }
  if (!carga) return falla('ALUMNO_NO_ENCONTRADO', 'el alumno no existe');
  if (!carga.resultado.elegible) {
    return { tipo: 'bloqueado', motivo: 'NO_ELEGIBLE', detalle: carga.resultado.detalle, profesor: carga.resultado.asignacion?.teacher_name ?? null };
  }
  const asg = carga.resultado.asignacion;

  let abiertas;
  try {
    abiertas = await openRecoveriesOfStudentWith(db, { assignmentId: asg.id, studentId: asg.student_id });
  } catch (err) {
    return falla('ERROR_LECTURA', errMsg(err), err);
  }
  if (abiertas.length) return { tipo: 'bloqueado', motivo: 'RECUPERACION_PENDIENTE', detalle: null, profesor: asg.teacher_name };

  const { data: t, error } = await db.from('teachers')
    .select('id, name, calendar_start_hour, calendar_end_hour').eq('id', asg.teacher_id).maybeSingle();
  if (error || !t) return falla('CALENDARIO_ILEGIBLE', error?.message ?? `el profesor ${asg.teacher_id} no existe`);
  const profe = t as Contexto['profe'];

  let grid: Grid;
  try {
    const estado = await estadoCalendarioWith(db, profe.id, ahora);
    if (!estado.actualizado) return { tipo: 'bloqueado', motivo: 'CALENDARIO_SIN_ACTUALIZAR', detalle: null, profesor: profe.name };
    grid = await readTeacherGridWith(db, profe.id);
  } catch (err) {
    return falla('CALENDARIO_ILEGIBLE', errMsg(err), err);
  }
  return { tipo: 'ok', ctx: { alumno: asg.student_name, profe, grid, sesiones: sesionesDelAlumno(grid, asg.student_name) } };
}

const idDeSesion = (s: Pick<Sesion, 'dia' | 'hora'>): string => `${s.dia}_${s.hora}`;

function movible(ev: ReturnType<typeof evaluarOrigen>): MovibleDto {
  if (ev.ok) return { movible: true, motivo_no_movible: null, disponible_desde: null };
  // evaluarOrigen solo devuelve estos dos motivos con fechas generadas aquí
  // (dentro de la ventana y del día correcto).
  const motivo = ev.codigo === 'MARCA_PUNTUAL_EXISTENTE' ? 'MARCA_PUNTUAL_EXISTENTE' : 'ANTELACION_INSUFICIENTE';
  return { movible: false, motivo_no_movible: motivo, disponible_desde: ev.disponibleDesde };
}

/** Fechas (España) de las clases de `s` que aún no empezaron, hasta 6 semanas. */
function proximasFechas(s: Sesion, ahora: number): string[] {
  const hasta = ahora + VENTANA_PUNTUAL_DIAS * 86_400_000;
  const h = Number(s.hora.slice(0, 2));
  const out: string[] = [];
  for (let f = getSpainParts(new Date(ahora)).dateStr; ; f = addDaysIso(f, 1)) {
    const inicio = spainWallClockToEpoch(f, h);
    if (inicio > hasta) break;
    if (dayNameFromIso(f) === s.dia && inicio > ahora) out.push(f);
  }
  return out;
}

// ── GET estado ────────────────────────────────────────────────────────────────

export async function estadoAutoservicioWith(db: Db, studentId: string, ahora: number = Date.now()): Promise<EstadoDto> {
  const c = await cargar(db, studentId, ahora);
  const puede_cambiar_profesor = await puedeCambiarProfesorWith(db, studentId, ahora);
  if (c.tipo === 'bloqueado') {
    return {
      ok: true, elegible: false, motivo_no_elegible: c.motivo, detalle_no_elegible: c.detalle,
      profesor: c.profesor ? { nombre: c.profesor } : null, sesiones: [], puede_cambiar_profesor,
    };
  }
  const { ctx } = c;
  return {
    ok: true, elegible: true, motivo_no_elegible: null, detalle_no_elegible: null, puede_cambiar_profesor,
    profesor: { nombre: ctx.profe.name },
    sesiones: ctx.sesiones.map(s => ({
      id: idDeSesion(s), dia: s.dia, hora: s.hora, duracion: s.duracion,
      fijo: movible(evaluarOrigen(ctx.grid, s, 'fijo', ahora)),
      proximas_clases: proximasFechas(s, ahora).map(fecha => ({
        fecha, hora: s.hora, duracion: s.duracion,
        ...movible(evaluarOrigen(ctx.grid, s, 'puntual', ahora, fecha)),
      })),
    })),
  };
}

// ── GET huecos ────────────────────────────────────────────────────────────────

export interface HuecosAutoservicioParams {
  modo: string | null | undefined;
  /** "<dia>_<HH:MM>", como `id` en GET estado. */
  sesion: string | null | undefined;
  /** PUNTUAL: la clase que se quiere mover (YYYY-MM-DD). Opcional: sin ella se listan los huecos de las 6 semanas. */
  fecha?: string | null;
}

/**
 * Huecos a los que se puede mover la sesión. LANZA CambioHorarioError si el
 * alumno no puede usar el autoservicio o si esa sesión (o esa clase) no se puede
 * mover ahora: el mismo código que daría el POST.
 */
export async function huecosAutoservicioWith(
  db: Db, studentId: string, p: HuecosAutoservicioParams, ahora: number = Date.now(),
): Promise<HuecosDto> {
  const modo = p.modo;
  if (modo !== 'puntual' && modo !== 'fijo') return falla('DATOS_INVALIDOS', 'modo tiene que ser "puntual" o "fijo"');
  const m = /^(.+)_(\d{2}:00)$/.exec(p.sesion ?? '');
  if (!m) return falla('DATOS_INVALIDOS', 'sesion tiene que ser "<dia>_<HH:00>", como el id de GET estado');
  const fecha = p.fecha?.trim() || null;
  if (fecha && (modo !== 'puntual' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha))) return falla('DATOS_INVALIDOS', 'fecha solo vale en modo puntual y con formato YYYY-MM-DD');

  const c = await cargar(db, studentId, ahora);
  if (c.tipo === 'bloqueado') {
    throw new CambioHorarioError({ codigo: c.motivo, paso: 'lectura', mensaje: 'el alumno no puede cambiar su horario ahora', detalleNoElegible: c.detalle });
  }
  const { ctx } = c;
  const s = ctx.sesiones.find(x => x.dia === m[1] && x.hora === m[2]);
  if (!s) return falla('SESION_NO_ENCONTRADA', `${ctx.alumno} no tiene una sesión ${m[1]} ${m[2]} en el calendario de ${ctx.profe.name}`);

  if (modo === 'fijo' || fecha) {
    const ev = evaluarOrigen(ctx.grid, s, modo, ahora, fecha ?? undefined);
    if (!ev.ok) throw new CambioHorarioError({ codigo: ev.codigo, paso: 'lectura', mensaje: ev.mensaje, detalles: ev.detalles });
  }

  const reservas = await liveReservationsWith(db, ctx.profe.id, ahora);
  const bloques = calcularBloques(ctx.grid, {
    modo, duracionHoras: s.duracion,
    horaInicio: ctx.profe.calendar_start_hour, horaFin: ctx.profe.calendar_end_hour,
    reservas, ahora,
    sesionPropia: { alumno: ctx.alumno, claves: s.claves, fecha: fecha ?? undefined },
  });
  return {
    ok: true, modo,
    sesion: { id: idDeSesion(s), dia: s.dia, hora: s.hora, duracion: s.duracion },
    fecha_origen: fecha,
    huecos: bloques.map(b => ({ dia: b.dia, hora: b.horaInicio, duracion: b.duracionHoras, fecha: b.fecha })),
  };
}
