// Huecos ENTRE PROFESORES para que el alumno cambie de profesor desde el LMS
// (Fase 2). Solo lee.
//
// No hay criterios propios: los bloques salen de calcularBloques / evaluarBloque
// (lib/huecos, que a su vez usa esHuecoLibreParaAlumno) en modo FIJO, la
// elegibilidad es la de la Fase 1 (cargarElegibilidadWith) y "calendario sin
// actualizar" es la misma regla de 30 días (calendarioAlDia).
//
// Profesores candidatos: no archivados, ni el perfil de prueba (esPerfilDePrueba)
// ni el profesor actual del alumno, y con el calendario al día. Sin scoring.
// Orden: aleatorio pero ESTABLE para el mismo alumno durante el día (semilla =
// alumno + fecha de España), para que la lista no baile entre recargas.
//
// Consultas: profesores, calendarios, cambios humanos del calendario y reservas,
// UNA de cada para todos los profesores (más la carga del alumno).

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Grid } from '@/types';
import { readTeacherGridWith } from '@/lib/calendarStore';
import { liveReservationsOfTeachersWith, openRecoveriesOfStudentWith } from '@/lib/classRecoveryQueries';
import { esPerfilDePrueba } from '@/lib/perfilDePrueba';
import { getSpainParts } from '@/lib/spainTime';
import { calcularBloques, estadoCalendariosWith, type BloqueLibre } from '@/lib/huecos/huecos';
import { cargarElegibilidadWith } from '@/lib/cambioHorario/elegibilidad';
import { sesionesDelAlumno, type Sesion } from '@/lib/cambioHorario/sesiones';
import { CambioHorarioError, type CodigoCambioHorario } from '@/lib/cambioHorario/errors';
import { TransferenciaError } from '@/lib/transferencia/errors';

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

export interface ProfesorCandidato {
  id: string;
  nombre: string;
  horaInicio: number | null;
  horaFin: number | null;
}

/** Un hueco con un profesor, tal como lo devuelve GET huecos-profesores. */
export interface HuecoProfesorDto {
  profesor: { id: string; nombre: string };
  dia: string;
  hora: string;
  duracion: number;
  /** Primera clase con este horario (España). */
  fecha_primera_clase: string;
}

// ── Orden estable ─────────────────────────────────────────────────────────────

/** Hash de 32 bits (FNV-1a) de un texto. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** Generador pseudoaleatorio con semilla (mulberry32). */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Baraja estable: el mismo alumno el mismo día (España) ve el mismo orden; otro
 * alumno u otro día, otro. Se ordena por id antes de barajar para no depender del
 * orden en que la base devuelve las filas.
 */
export function ordenEstable<T extends { id: string }>(items: T[], alumnoId: string, fecha: string): T[] {
  const out = [...items].sort((a, b) => a.id.localeCompare(b.id));
  const r = rng(hash32(`${alumnoId}|${fecha}`));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
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

const falla = (codigo: CodigoCambioHorario, mensaje: string, extra: Partial<ConstructorParameters<typeof CambioHorarioError>[0]> = {}): never => {
  throw new CambioHorarioError({ codigo, paso: 'cambio de profesor', mensaje, ...extra });
};
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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
export type MotivoDescarte = 'PROFESOR_NO_EXISTE' | 'PROFESOR_ARCHIVADO' | 'PROFESOR_DE_PRUEBA' | 'MISMO_PROFESOR' | 'CALENDARIO_SIN_ACTUALIZAR';

export interface Candidatos {
  profesores: ProfesorCandidato[];
  grids: Map<string, Grid>;
  reservas: Awaited<ReturnType<typeof liveReservationsOfTeachersWith>>;
  /** Los profesores leídos que NO son candidatos, con el motivo. */
  descartes: Map<string, MotivoDescarte>;
}

/**
 * El candidato `id`, o LANZA con el motivo exacto por el que no lo es (el mismo
 * error que daría el núcleo de transferencia, o CALENDARIO_SIN_ACTUALIZAR).
 */
export function exigirCandidato(c: Candidatos, id: string): ProfesorCandidato {
  const p = c.profesores.find(x => x.id === id);
  if (p) return p;
  const motivo = c.descartes.get(id) ?? 'PROFESOR_NO_EXISTE';
  if (motivo === 'CALENDARIO_SIN_ACTUALIZAR') {
    return falla('CALENDARIO_SIN_ACTUALIZAR', `el calendario del profesor ${id} lleva más de 30 días sin revisar`);
  }
  throw new TransferenciaError({ codigo: motivo, paso: 'cambio de profesor', mensaje: `el profesor ${id} no es candidato (${motivo})` });
}

/**
 * Profesores a los que el alumno puede pasarse, ya con calendario y reservas.
 * Sin orden (lo pone quien llama). `soloId`: limita a ese profesor (POST y
 * profesor fijado), con las mismas exclusiones.
 */
export async function candidatosWith(
  db: Db, opts: { profesorActual: string; ahora: number; soloId?: string },
): Promise<Candidatos> {
  let q = db.from('teachers').select('id, name, archived_at, calendar_start_hour, calendar_end_hour');
  if (opts.soloId) q = q.eq('id', opts.soloId);
  const { data: ts, error } = await q;
  if (error) return falla('ERROR_LECTURA', `no se pudieron leer los profesores: ${error.message}`);
  const descartes = new Map<string, MotivoDescarte>();
  if (opts.soloId && !(ts ?? []).length) descartes.set(opts.soloId, 'PROFESOR_NO_EXISTE');
  const vivos = ((ts ?? []) as Array<{ id: string; name: string; archived_at?: string | null; calendar_start_hour?: number | null; calendar_end_hour?: number | null }>)
    .filter(t => {
      const motivo: MotivoDescarte | null = t.archived_at ? 'PROFESOR_ARCHIVADO'
        : esPerfilDePrueba(t.id) ? 'PROFESOR_DE_PRUEBA'
          : t.id === opts.profesorActual ? 'MISMO_PROFESOR' : null;
      if (motivo) descartes.set(t.id, motivo);
      return !motivo;
    });
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
  const grids = new Map(filas.filter(f => conCalendario.some(t => t.id === f.teacher_id)).map(f => [f.teacher_id, (f.grid ?? {}) as Grid]));
  const reservas = await liveReservationsOfTeachersWith(db, conCalendario.map(t => t.id), opts.ahora);
  return {
    profesores: conCalendario.map(t => ({ id: t.id, nombre: t.name, horaInicio: t.calendar_start_hour ?? null, horaFin: t.calendar_end_hour ?? null })),
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

const dto = (p: ProfesorCandidato, b: BloqueLibre): HuecoProfesorDto =>
  ({ profesor: { id: p.id, nombre: p.nombre }, dia: b.dia, hora: b.horaInicio, duracion: b.duracionHoras, fecha_primera_clase: b.fecha });

export interface HuecosEntreProfesoresParams {
  client: Db;
  /** students.id */
  alumno: string;
  dia?: string | null;
  franja?: string | null;
  /** Con él: los huecos de ESE profesor para cada sesión del alumno. */
  profesorFijado?: string | null;
  ahora?: number;
}

export type HuecosEntreProfesores =
  | { tipo: 'lista'; sesiones: Array<{ dia: string; hora: string; duracion: number }>; huecos: HuecoProfesorDto[] }
  | { tipo: 'profesor'; profesor: { id: string; nombre: string }; sesiones: Array<{ indice: number; dia: string; hora: string; duracion: number; huecos: HuecoProfesorDto[] }> };

/**
 * Sin profesorFijado: para cada candidato (en orden estable), sus bloques FIJOS
 * libres para la duración de la PRIMERA sesión del alumno, filtrados por día y
 * franja. Con profesorFijado: los bloques de ese profesor para CADA sesión del
 * alumno (la primera incluida, por si quiere cambiarla), en el orden de sus
 * sesiones. LANZA CambioHorarioError.
 */
export async function huecosEntreProfesores(p: HuecosEntreProfesoresParams): Promise<HuecosEntreProfesores> {
  const ahora = p.ahora ?? Date.now();
  if (p.dia && !DIAS.includes(p.dia)) falla('DATOS_INVALIDOS', `día desconocido: ${p.dia}`);
  if (p.franja && !(FRANJAS as readonly string[]).includes(p.franja)) falla('DATOS_INVALIDOS', `franja desconocida: ${p.franja} (${FRANJAS.join(', ')})`);
  const franja = (p.franja || null) as Franja | null;
  const filtra = (bs: BloqueLibre[]) => bs.filter(b => (!p.dia || b.dia === p.dia) && enFranja(b, franja));

  const alumno = await cargarAlumnoWith(p.client, p.alumno);
  const fijado = p.profesorFijado?.trim() || null;
  const c = await candidatosWith(p.client, { profesorActual: alumno.profesorActual, ahora, soloId: fijado ?? undefined });

  if (fijado) {
    // Mismo motivo que daría el POST: no existe, archivado, prueba, el actual o sin actualizar.
    const prof = exigirCandidato(c, fijado);
    return {
      tipo: 'profesor', profesor: { id: prof.id, nombre: prof.nombre },
      sesiones: alumno.sesiones.map((s, indice) => ({
        indice, dia: s.dia, hora: s.hora, duracion: s.duracion,
        huecos: filtra(bloquesDeProfesor(c, prof, s.duracion, ahora)).map(b => dto(prof, b)),
      })),
    };
  }

  const fecha = getSpainParts(new Date(ahora)).dateStr;
  const duracion = alumno.sesiones[0].duracion;
  const huecos = ordenEstable(c.profesores, p.alumno, fecha)
    .flatMap(prof => filtra(bloquesDeProfesor(c, prof, duracion, ahora)).map(b => dto(prof, b)));
  return { tipo: 'lista', sesiones: alumno.sesiones.map(s => ({ dia: s.dia, hora: s.hora, duracion: s.duracion })), huecos };
}
