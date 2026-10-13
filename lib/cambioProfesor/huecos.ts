// HORARIOS para que el alumno cambie de profesor desde el LMS (Fase 2, contrato
// v3). Solo lee.
//
// El alumno NO ve profesores: elige un horario para cada una de sus sesiones y
// Gestión le asigna después el profesor (lib/cambioProfesor/core.ts). Por eso
// nada de lo que sale de aquí hacia el LMS lleva id ni nombre de profesor.
//
// No hay criterios propios: los bloques salen de calcularBloques / evaluarBloque
// (lib/huecos, que a su vez usa esHuecoLibreParaAlumno) en modo FIJO, la
// elegibilidad es la de la Fase 1 (cargarElegibilidadWith) y "calendario sin
// actualizar" es la misma regla de 30 días (calendarioAlDia).
//
// Profesores candidatos: no archivados, ni el perfil de prueba (esPerfilDePrueba)
// ni el profesor actual del alumno, y con el calendario al día.
//
// Paso a paso: el LMS manda los horarios ya elegidos (`elegidos`, uno por cada
// sesión anterior, en el orden de `sesiones`) y recibe los horarios posibles
// para la SIGUIENTE sesión: los que tiene libres algún candidato que además
// tiene libres TODOS los elegidos, sin solaparse ni ir seguidos con ellos (dos
// bloques seguidos el mismo día serían una sola sesión en el calendario). Así,
// al terminar, siempre hay al menos un profesor que cubre todo.
//
// Consultas: profesores, calendarios, cambios humanos del calendario y reservas,
// UNA de cada para todos los profesores (más la carga del alumno).

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Grid } from '@/types';
import { readTeacherGridWith } from '@/lib/calendarStore';
import { liveReservationsOfTeachersWith, openRecoveriesOfStudentWith } from '@/lib/classRecoveryQueries';
import { esPerfilDePrueba } from '@/lib/perfilDePrueba';
import { DURACION_MAX_HORAS, calcularBloques, clavesDeBloque, evaluarBloque, estadoCalendariosWith, type BloqueLibre } from '@/lib/huecos/huecos';
import { cargarElegibilidadWith } from '@/lib/cambioHorario/elegibilidad';
import { sesionesDelAlumno, type Sesion } from '@/lib/cambioHorario/sesiones';
import { CambioHorarioError, type CodigoCambioHorario } from '@/lib/cambioHorario/errors';

type Db = SupabaseClient;

const DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

/**
 * Franjas por hora de INICIO, en España. Las MISMAS que el LMS:
 *   manana   06:00–11:59
 *   mediodia 12:00–14:59
 *   tarde    15:00–19:59
 *   noche    20:00–23:59 y la madrugada (00:00–05:59)
 */
export const FRANJAS = ['manana', 'mediodia', 'tarde', 'noche'] as const;
export type Franja = typeof FRANJAS[number];

export function franjaDeHora(h: number): Franja {
  if (h >= 6 && h < 12) return 'manana';
  if (h >= 12 && h < 15) return 'mediodia';
  if (h >= 15 && h < 20) return 'tarde';
  return 'noche';   // 20:00 en adelante y la madrugada
}

/** Uso interno: NUNCA sale hacia el LMS. */
export interface ProfesorCandidato {
  id: string;
  nombre: string;
  horaInicio: number | null;
  horaFin: number | null;
  /** teacher_calendars.updated_at (para elegirProfesor). */
  calendarioActualizadoEn: string | null;
}

/** Un horario elegido por el alumno, o pedido como destino. */
export interface Horario { dia: string; hora: string; duracion: number }

/** Un horario tal como lo devuelve GET huecos-profesores: sin datos del profesor. */
export interface HorarioDto extends Horario {
  /** Primera clase con este horario (España). */
  fecha_primera_clase: string;
}

const falla = (codigo: CodigoCambioHorario, mensaje: string, extra: Partial<ConstructorParameters<typeof CambioHorarioError>[0]> = {}): never => {
  throw new CambioHorarioError({ codigo, paso: 'cambio de profesor', mensaje, ...extra });
};
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ── Horarios ──────────────────────────────────────────────────────────────────

/** Claves del calendario de un horario. LANZA DATOS_INVALIDOS si está mal formado. */
export function clavesDeHorario(x: Horario): string[] {
  const ok = !!x && DIAS.includes(x.dia) && /^\d{2}:00$/.test(x.hora ?? '')
    && Number.isInteger(x.duracion) && x.duracion >= 1 && x.duracion <= DURACION_MAX_HORAS;
  const claves = ok ? clavesDeBloque(x.dia, Number(x.hora.slice(0, 2)), x.duracion) : null;
  if (!claves) return falla('DATOS_INVALIDOS', `horario mal formado: ${JSON.stringify(x)}`);
  return claves;
}

/**
 * ¿Dos horarios se solapan o van seguidos el mismo día? Seguidos también cuenta:
 * en el calendario quedarían como UNA sesión más larga (celdas contiguas = una
 * sesión) y el alumno dejaría de tener las sesiones que tiene.
 */
export function chocan(a: Horario, b: Horario): boolean {
  if (a.dia !== b.dia) return false;
  const ia = Number(a.hora.slice(0, 2)); const ib = Number(b.hora.slice(0, 2));
  return ia <= ib + b.duracion && ib <= ia + a.duracion;
}

/** Comprueba la forma de una lista de horarios y que no choquen entre ellos. LANZA DATOS_INVALIDOS. */
export function validarHorarios(xs: Horario[], que: string): void {
  xs.forEach(clavesDeHorario);
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) {
      if (chocan(xs[i], xs[j])) {
        falla('DATOS_INVALIDOS', `${que}: ${xs[i].dia} ${xs[i].hora} y ${xs[j].dia} ${xs[j].hora} se solapan o van seguidos (serían una sola clase)`);
      }
    }
  }
}

// ── Carga del alumno ──────────────────────────────────────────────────────────

export interface ContextoAlumno {
  studentId: string;
  assignmentId: string;
  alumno: string;
  profesorActual: string;
  /** Calendario del profesor actual (para sus sesiones y la antelación de la clase actual). */
  grid: Grid;
  sesiones: Sesion[];
}

/**
 * Elegibilidad (la de la Fase 1), recuperaciones y sesiones actuales. LANZA
 * CambioHorarioError con el mismo código que el cambio de horario. El calendario
 * del profesor ACTUAL sin actualizar no frena: el alumno se va de ese profesor.
 */
export async function cargarAlumnoWith(db: Db, studentId: string): Promise<ContextoAlumno> {
  let carga: Awaited<ReturnType<typeof cargarElegibilidadWith>>;
  try {
    carga = await cargarElegibilidadWith(db, studentId);
  } catch (err) {
    return falla('ERROR_LECTURA', errMsg(err), { cause: err });
  }
  if (!carga) return falla('ALUMNO_NO_ENCONTRADO', 'el alumno no existe');
  if (!carga.resultado.elegible) {
    return falla('NO_ELEGIBLE', `el alumno no puede cambiar de profesor por su cuenta (${carga.resultado.detalle})`,
      { detalleNoElegible: carga.resultado.detalle });
  }
  const asg = carga.resultado.asignacion;
  let abiertas;
  try {
    abiertas = await openRecoveriesOfStudentWith(db, { assignmentId: asg.id, studentId: asg.student_id });
  } catch (err) {
    return falla('ERROR_LECTURA', errMsg(err), { cause: err });
  }
  if (abiertas.length) return falla('RECUPERACION_PENDIENTE', `tiene ${abiertas.length} recuperación(es) abierta(s)`);

  let grid: Grid;
  try {
    grid = await readTeacherGridWith(db, asg.teacher_id);
  } catch (err) {
    return falla('CALENDARIO_ILEGIBLE', errMsg(err), { cause: err });
  }
  const sesiones = sesionesDelAlumno(grid, asg.student_name);
  if (sesiones.length === 0) return falla('SESION_NO_ENCONTRADA', `${asg.student_name} no tiene sesiones en el calendario de su profesor`);
  return { studentId, assignmentId: asg.id, alumno: asg.student_name, profesorActual: asg.teacher_id, grid, sesiones };
}

// ── Candidatos ────────────────────────────────────────────────────────────────

/** Por qué un profesor no es candidato. Mismos códigos que el núcleo de transferencia. */
export type MotivoDescarte = 'PROFESOR_ARCHIVADO' | 'PROFESOR_DE_PRUEBA' | 'MISMO_PROFESOR' | 'CALENDARIO_SIN_ACTUALIZAR';

export interface Candidatos {
  profesores: ProfesorCandidato[];
  grids: Map<string, Grid>;
  reservas: Awaited<ReturnType<typeof liveReservationsOfTeachersWith>>;
  /** Los profesores leídos que NO son candidatos, con el motivo. */
  descartes: Map<string, MotivoDescarte>;
}

/** Profesores a los que el alumno puede pasarse, ya con calendario y reservas. Ordenados por id. */
export async function candidatosWith(db: Db, opts: { profesorActual: string; ahora: number }): Promise<Candidatos> {
  const { data: ts, error } = await db.from('teachers').select('id, name, archived_at, calendar_start_hour, calendar_end_hour');
  if (error) return falla('ERROR_LECTURA', `no se pudieron leer los profesores: ${error.message}`);
  const descartes = new Map<string, MotivoDescarte>();
  const vivos = ((ts ?? []) as Array<{ id: string; name: string; archived_at?: string | null; calendar_start_hour?: number | null; calendar_end_hour?: number | null }>)
    .filter(t => {
      const motivo: MotivoDescarte | null = t.archived_at ? 'PROFESOR_ARCHIVADO'
        : esPerfilDePrueba(t.id) ? 'PROFESOR_DE_PRUEBA'
          : t.id === opts.profesorActual ? 'MISMO_PROFESOR' : null;
      if (motivo) descartes.set(t.id, motivo);
      return !motivo;
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (vivos.length === 0) return { profesores: [], grids: new Map(), reservas: new Map(), descartes };

  const ids = vivos.map(t => t.id);
  const { data: cals, error: cErr } = await db.from('teacher_calendars').select('teacher_id, grid, updated_at').in('teacher_id', ids);
  if (cErr) return falla('CALENDARIO_ILEGIBLE', cErr.message);
  const filas = (cals ?? []) as Array<{ teacher_id: string; grid: Grid | null; updated_at: string | null }>;
  const estado = await estadoCalendariosWith(db, new Map(filas.map(f => [f.teacher_id, f.updated_at])), opts.ahora);

  // Sin fila de calendario no hay huecos; con el calendario sin actualizar, fuera.
  const conCalendario = vivos.filter(t => {
    const ok = !!estado.get(t.id)?.actualizado;
    if (!ok) descartes.set(t.id, 'CALENDARIO_SIN_ACTUALIZAR');
    return ok;
  });
  const fila = new Map(filas.map(f => [f.teacher_id, f]));
  const grids = new Map(conCalendario.map(t => [t.id, (fila.get(t.id)?.grid ?? {}) as Grid]));
  const reservas = await liveReservationsOfTeachersWith(db, conCalendario.map(t => t.id), opts.ahora);
  return {
    profesores: conCalendario.map(t => ({
      id: t.id, nombre: t.name, horaInicio: t.calendar_start_hour ?? null, horaFin: t.calendar_end_hour ?? null,
      calendarioActualizadoEn: fila.get(t.id)?.updated_at ?? null,
    })),
    grids, reservas, descartes,
  };
}

// ── Huecos ────────────────────────────────────────────────────────────────────

const enFranja = (b: BloqueLibre, f?: Franja | null) => !f || franjaDeHora(Number(b.horaInicio.slice(0, 2))) === f;

/** Bloques FIJOS libres de un profesor candidato para una duración. */
export function bloquesDeProfesor(c: Candidatos, p: ProfesorCandidato, duracion: number, ahora: number): BloqueLibre[] {
  return calcularBloques(c.grids.get(p.id) ?? {}, {
    modo: 'fijo', duracionHoras: duracion, horaInicio: p.horaInicio, horaFin: p.horaFin,
    reservas: c.reservas.get(p.id) ?? [], ahora,
  });
}

/**
 * ¿El profesor tiene libres TODOS esos horarios? Cada uno con evaluarBloque en
 * modo FIJO: primera clase a más de 24 h y libre según esHuecoLibreParaAlumno.
 */
export function cubreTodos(c: Candidatos, p: ProfesorCandidato, horarios: Horario[], ahora: number): boolean {
  const grid = c.grids.get(p.id) ?? {};
  return horarios.every(h => evaluarBloque(grid, { dia: h.dia, hora: Number(h.hora.slice(0, 2)) }, {
    modo: 'fijo', duracionHoras: h.duracion, horaInicio: p.horaInicio, horaFin: p.horaFin,
    reservas: c.reservas.get(p.id) ?? [], ahora,
  }).ok);
}

export interface HuecosEntreProfesoresParams {
  client: Db;
  /** students.id */
  alumno: string;
  dia?: string | null;
  franja?: string | null;
  /** Horarios ya elegidos para las primeras sesiones, en el orden de `sesiones`. */
  elegidos?: Horario[] | null;
  ahora?: number;
}

export interface HuecosEntreProfesores {
  /** Sesiones actuales del alumno, en orden: elegidos[i] es el horario nuevo de sesiones[i]. */
  sesiones: Horario[];
  /** La sesión para la que son los horarios (la de índice elegidos.length), o null si ya están todas elegidas. */
  siguiente: { indice: number; duracion: number } | null;
  /** false si ningún profesor candidato tiene ya libres todos los elegidos: hay que volver a empezar. */
  elegidos_disponibles: boolean;
  /** Horarios posibles para `siguiente`, sin repetir, por día y hora. Sin datos del profesor. */
  horarios: HorarioDto[];
}

const ordenHorario = (a: Horario, b: Horario) =>
  DIAS.indexOf(a.dia) - DIAS.indexOf(b.dia) || a.hora.localeCompare(b.hora) || a.duracion - b.duracion;

/**
 * Horarios para la siguiente sesión del alumno (ver la cabecera). LANZA
 * CambioHorarioError: DATOS_INVALIDOS (filtros o elegidos mal formados o que
 * chocan entre sí), SESIONES_NO_COINCIDEN (más elegidos que sesiones, o uno con
 * otra duración que su sesión) y los de la carga del alumno.
 */
export async function huecosEntreProfesores(p: HuecosEntreProfesoresParams): Promise<HuecosEntreProfesores> {
  const ahora = p.ahora ?? Date.now();
  if (p.dia && !DIAS.includes(p.dia)) falla('DATOS_INVALIDOS', `día desconocido: ${p.dia}`);
  if (p.franja && !(FRANJAS as readonly string[]).includes(p.franja)) falla('DATOS_INVALIDOS', `franja desconocida: ${p.franja} (${FRANJAS.join(', ')})`);
  const franja = (p.franja || null) as Franja | null;
  const elegidos = p.elegidos ?? [];
  if (!Array.isArray(elegidos)) falla('DATOS_INVALIDOS', 'elegidos tiene que ser una lista');
  validarHorarios(elegidos, 'elegidos');

  const alumno = await cargarAlumnoWith(p.client, p.alumno);
  const sesiones = alumno.sesiones.map(s => ({ dia: s.dia, hora: s.hora, duracion: s.duracion }));
  if (elegidos.length > sesiones.length) {
    falla('SESIONES_NO_COINCIDEN', `llegaron ${elegidos.length} horarios elegidos y tiene ${sesiones.length} sesión(es)`);
  }
  elegidos.forEach((e, i) => {
    if (e.duracion !== sesiones[i].duracion) {
      falla('SESIONES_NO_COINCIDEN', `el horario elegido ${i + 1} dura ${e.duracion} h y su sesión ${i + 1} dura ${sesiones[i].duracion} h`);
    }
  });

  const c = await candidatosWith(p.client, { profesorActual: alumno.profesorActual, ahora });
  const validos = c.profesores.filter(prof => cubreTodos(c, prof, elegidos, ahora));
  const siguiente = elegidos.length < sesiones.length ? { indice: elegidos.length, duracion: sesiones[elegidos.length].duracion } : null;
  if (!siguiente) return { sesiones, siguiente, elegidos_disponibles: validos.length > 0, horarios: [] };

  const vistos = new Map<string, HorarioDto>();
  for (const prof of validos) {
    for (const b of bloquesDeProfesor(c, prof, siguiente.duracion, ahora)) {
      const h: HorarioDto = { dia: b.dia, hora: b.horaInicio, duracion: b.duracionHoras, fecha_primera_clase: b.fecha };
      if ((p.dia && b.dia !== p.dia) || !enFranja(b, franja) || elegidos.some(e => chocan(e, h))) continue;
      const k = `${h.dia}|${h.hora}|${h.duracion}`;
      if (!vistos.has(k)) vistos.set(k, h);
    }
  }
  return { sesiones, siguiente, elegidos_disponibles: validos.length > 0, horarios: [...vistos.values()].sort(ordenHorario) };
}
