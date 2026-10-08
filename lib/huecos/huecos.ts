// Huecos libres de un profesor para que el ALUMNO mueva una sesión (Fase 1:
// cambio de horario con el mismo profesor, pedido desde el LMS).
//
// NO hay criterio propio de "libre": cada casilla pasa por esHuecoLibreParaAlumno
// (lib/cells.ts), el único criterio para operaciones con origen 'lms'. Aquí solo
// se arman BLOQUES (N casillas contiguas del mismo día) y se aplican las reglas
// de fechas:
//   · PUNTUAL: un bloque en una fecha concreta, que empiece entre ahora + 24 h y
//     ahora + 6 semanas. Además, ninguna casilla del bloque puede tener ya una
//     marca puntual vigente (cada casilla admite UNA sola marca).
//   · FIJO: un bloque recurrente (día + hora) cuya PRÓXIMA ocurrencia empiece a
//     más de 24 h; se comprueba con alcance 'desde' esa fecha.
// Todas las horas son de España (lib/spainTime.ts).
//
// La parte pura (calcularBloques) no toca la base; huecosLibres carga calendario,
// rango y reservas con el cliente inyectado y frena si el calendario lleva más de
// 30 días sin que nadie lo revise.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Cell, Grid } from '@/types';
import { esHuecoLibreParaAlumno, isPuntualState, HORA_INICIO_POR_DEFECTO, HORA_FIN_POR_DEFECTO, type ContextoHuecoAlumno } from '@/lib/cells';
import { readTeacherGridWith } from '@/lib/calendarStore';
import { liveReservationsWith } from '@/lib/classRecoveryQueries';
import { getSpainParts, spainWallClockToEpoch } from '@/lib/spainTime';
import { addDaysIso, dayNameFromIso, mondayIsoOfIso } from '@/lib/teacherClasses';
import { hourText } from '@/lib/sessions';

type Db = SupabaseClient;

export type ModoCambio = 'puntual' | 'fijo';

/** Antelación mínima, en hora de España: la clase tiene que empezar a más de 24 h. */
export const ANTELACION_MINIMA_MS = 24 * 3_600_000;
/** Hasta dónde se ofrecen huecos puntuales. */
export const VENTANA_PUNTUAL_DIAS = 42;
/** Días sin revisión humana del calendario a partir de los que no se ofrecen huecos. */
export const DIAS_CALENDARIO_VIGENTE = 30;

const DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

export interface BloqueLibre {
  /** Día de la semana ('Martes'). */
  dia: string;
  /** Hora de inicio en España ('15:00'). */
  horaInicio: string;
  /** Hora de fin, exclusiva ('17:00' para un bloque de 15 a 17). */
  horaFin: string;
  duracionHoras: number;
  /** Claves del calendario ('Martes_15:00', 'Martes_16:00'). */
  claves: string[];
  /** PUNTUAL: la fecha del hueco. FIJO: la fecha de su próxima ocurrencia (primera clase con el horario nuevo). */
  fecha: string;
  /** Instante de inicio de esa fecha (epoch ms). */
  inicio: number;
}

/**
 * La sesión que se mueve.
 *   · FIJO: activa la excepción de esHuecoLibreParaAlumno para desplazamientos que
 *     solapan consigo misma (14-16 → 15-17).
 *   · PUNTUAL: NO hay excepción de solape. Una casilla que fuera a la vez origen
 *     (marca 'reprogramada') y destino (marca 'bloqueado') necesitaría dos marcas
 *     la misma semana, y cada casilla admite una sola: el bloque que solapa con la
 *     clase que se mueve sale como no libre. Aquí solo sirve para no ofrecer la
 *     misma clase como destino.
 * En los dos modos, mover la sesión exactamente al mismo sitio es MISMO_HORARIO.
 */
export interface SesionPropia {
  alumno: string;
  /** Claves de la sesión que se mueve ('Martes_14:00', 'Martes_15:00'). */
  claves: string[];
  /** PUNTUAL: fecha de la clase que se mueve. */
  fecha?: string;
}

export interface OpcionesBloques {
  modo: ModoCambio;
  duracionHoras: number;
  /** teachers.calendar_start_hour / calendar_end_hour (null → 9 / 22). */
  horaInicio?: number | null;
  horaFin?: number | null;
  reservas: ContextoHuecoAlumno['reservas'];
  sesionPropia?: SesionPropia;
  /** Reloj (epoch ms). */
  ahora: number;
  /** El inicio tiene que ser POSTERIOR a esto (por defecto ahora + 24 h). */
  desde?: number;
  /** PUNTUAL: inicio más tardío admitido (por defecto ahora + 6 semanas). */
  hasta?: number;
}

/**
 * ¿La casilla tiene una marca puntual VIGENTE (de la semana de `hoy` o
 * posterior)? Cada casilla admite una sola marca: escribir otra encima borraría
 * la que hay. Una marca sin semana (antigua) se trata como vigente.
 */
export function tieneMarcaPuntualVigente(cell: Cell | undefined, hoy: string): boolean {
  if (!cell || !isPuntualState(cell.state)) return false;
  if (!cell.weekDate) return true;
  return cell.weekDate >= mondayIsoOfIso(hoy);
}

/** Claves de un bloque de N horas que empieza en (día, hora). Null si se sale del día. */
export function clavesDeBloque(dia: string, h: number, n: number): string[] | null {
  if (h + n - 1 > 23) return null;
  return Array.from({ length: n }, (_, i) => `${dia}_${hourText(h + i)}`);
}

const mismasClaves = (a: string[], b: string[]): boolean => {
  const x = [...a].sort(); const y = [...b].sort();
  return x.length === y.length && x.every((k, i) => k === y[i]);
};

/** Por qué un bloque concreto no se puede usar. Mismos nombres que los códigos de error. */
export type MotivoBloque =
  | 'DATOS_INVALIDOS'           // día, hora, fecha o duración mal formados
  | 'MISMO_HORARIO'             // es la misma sesión (y fecha, si es puntual)
  | 'ANTELACION_INSUFICIENTE'   // empieza a 24 h o menos
  | 'FUERA_DE_VENTANA'          // PUNTUAL: más allá de 6 semanas
  | 'MARCA_PUNTUAL_EXISTENTE'   // PUNTUAL: alguna casilla ya tiene una marca vigente
  | 'SLOT_NO_DISPONIBLE';       // alguna casilla no es libre según esHuecoLibreParaAlumno

export type EvaluacionBloque =
  | { ok: true; bloque: BloqueLibre }
  | { ok: false; motivo: MotivoBloque; detalle?: string };

/**
 * Evalúa UN bloque (día + hora de inicio, y fecha si es puntual) con exactamente
 * las mismas reglas que el listado. calcularBloques la usa para cada candidato y
 * el núcleo de cambio de horario para validar el destino que pide el alumno.
 */
export function evaluarBloque(
  grid: Grid, b: { dia: string; hora: number; fecha?: string }, o: OpcionesBloques,
): EvaluacionBloque {
  const no = (motivo: MotivoBloque, detalle?: string): EvaluacionBloque => ({ ok: false, motivo, detalle });
  const n = Math.round(o.duracionHoras);
  if (!(n >= 1 && n <= 4) || !DIAS.includes(b.dia) || !(b.hora >= 0 && b.hora <= 23)) return no('DATOS_INVALIDOS');
  const claves = clavesDeBloque(b.dia, b.hora, n);
  if (!claves) return no('DATOS_INVALIDOS', 'el bloque pasa de las 23:00');

  const rangoIni = o.horaInicio ?? HORA_INICIO_POR_DEFECTO;
  const rangoFin = o.horaFin ?? HORA_FIN_POR_DEFECTO;
  const desde = o.desde ?? o.ahora + ANTELACION_MINIMA_MS;
  const propias = o.sesionPropia?.claves ?? [];
  const bloque = (fecha: string, inicio: number): BloqueLibre =>
    ({ dia: b.dia, horaInicio: hourText(b.hora), horaFin: hourText(b.hora + n), duracionHoras: n, claves, fecha, inicio });
  const noLibres = (ctx: ContextoHuecoAlumno): string[] => claves.flatMap(k => {
    const r = esHuecoLibreParaAlumno(grid, k, ctx);
    return r.libre ? [] : [`${k} (${r.motivo})`];
  });

  if (o.modo === 'puntual') {
    const fecha = b.fecha ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || dayNameFromIso(fecha) !== b.dia) return no('DATOS_INVALIDOS', 'la fecha no corresponde a ese día');
    if (o.sesionPropia?.fecha === fecha && mismasClaves(claves, propias)) return no('MISMO_HORARIO');
    const inicio = spainWallClockToEpoch(fecha, b.hora);
    if (!(inicio > desde)) return no('ANTELACION_INSUFICIENTE');                 // a MÁS de 24 h (estricto)
    const hasta = o.hasta ?? o.ahora + VENTANA_PUNTUAL_DIAS * 86_400_000;
    if (inicio > hasta) return no('FUERA_DE_VENTANA');
    // Límite técnico: una marca puntual por casilla.
    const hoy = getSpainParts(new Date(o.ahora)).dateStr;
    const conMarca = claves.filter(k => tieneMarcaPuntualVigente(grid[k], hoy));
    if (conMarca.length) return no('MARCA_PUNTUAL_EXISTENTE', conMarca.join(', '));
    const malas = noLibres({
      horaInicio: rangoIni, horaFin: rangoFin,
      alcance: { tipo: 'puntual', fecha }, reservas: o.reservas,
    });
    return malas.length ? no('SLOT_NO_DISPONIBLE', malas.join(', ')) : { ok: true, bloque: bloque(fecha, inicio) };
  }

  // FIJO: su próxima ocurrencia tiene que empezar a más de 24 h.
  if (mismasClaves(claves, propias)) return no('MISMO_HORARIO');
  const fecha = proximaFechaDe(b.dia, b.hora, o.ahora);
  const inicio = spainWallClockToEpoch(fecha, b.hora);
  if (!(inicio > desde)) return no('ANTELACION_INSUFICIENTE');
  const malas = noLibres({
    horaInicio: rangoIni, horaFin: rangoFin,
    alcance: { tipo: 'desde', fecha }, reservas: o.reservas,
    sesionPropia: o.sesionPropia ? { alumno: o.sesionPropia.alumno, claves: o.sesionPropia.claves } : undefined,
  });
  return malas.length ? no('SLOT_NO_DISPONIBLE', malas.join(', ')) : { ok: true, bloque: bloque(fecha, inicio) };
}

/** Bloques libres. Función PURA: todo lo que necesita llega por parámetro. */
export function calcularBloques(grid: Grid, o: OpcionesBloques): BloqueLibre[] {
  const n = Math.round(o.duracionHoras);
  if (!(n >= 1 && n <= 4)) return [];
  const rangoIni = o.horaInicio ?? HORA_INICIO_POR_DEFECTO;
  const rangoFin = o.horaFin ?? HORA_FIN_POR_DEFECTO;
  const out: BloqueLibre[] = [];
  const probar = (dia: string, fecha?: string) => {
    for (let h = rangoIni; h <= rangoFin; h++) {
      const r = evaluarBloque(grid, { dia, hora: h, fecha }, o);
      if (r.ok) out.push(r.bloque);
    }
  };

  if (o.modo === 'puntual') {
    const desde = o.desde ?? o.ahora + ANTELACION_MINIMA_MS;
    const hasta = o.hasta ?? o.ahora + VENTANA_PUNTUAL_DIAS * 86_400_000;
    const ultimoDia = getSpainParts(new Date(hasta)).dateStr;
    for (let fecha = getSpainParts(new Date(desde)).dateStr; fecha <= ultimoDia; fecha = addDaysIso(fecha, 1)) {
      const dia = dayNameFromIso(fecha);
      if (DIAS.includes(dia)) probar(dia, fecha);
    }
    return out;
  }
  for (const dia of DIAS) probar(dia);
  return out.sort((a, b) => a.inicio - b.inicio);
}

/** Próxima fecha (España) con ese día de la semana cuya hora `h` todavía no empezó. */
export function proximaFechaDe(dia: string, h: number, ahora: number): string {
  let fecha = getSpainParts(new Date(ahora)).dateStr;
  for (let i = 0; i < 8; i++, fecha = addDaysIso(fecha, 1)) {
    if (dayNameFromIso(fecha) === dia && spainWallClockToEpoch(fecha, h) > ahora) return fecha;
  }
  return fecha;
}

// ── Servidor ──────────────────────────────────────────────────────────────────

export type CodigoHuecos = 'PROFESOR_NO_EXISTE' | 'CALENDARIO_ILEGIBLE' | 'CALENDARIO_SIN_ACTUALIZAR' | 'DATOS_INVALIDOS';

export class HuecosError extends Error {
  readonly codigo: CodigoHuecos;
  constructor(codigo: CodigoHuecos, mensaje: string) {
    super(`[${codigo}] ${mensaje}`);
    this.name = 'HuecosError';
    this.codigo = codigo;
  }
}

export interface EstadoCalendario {
  actualizado: boolean;
  /** Último cambio en calendar_changes hecho por alguien que no es el sistema (null si no hay en la ventana). */
  ultimoCambioHumano: string | null;
  updatedAt: string | null;
}

/**
 * ¿El calendario está al día? NO lo está si en los últimos 30 días nadie que no
 * sea el sistema lo tocó (calendar_changes con origin ≠ 'sistema') Y ADEMÁS
 * teacher_calendars.updated_at tiene más de 30 días.
 *
 * calendar_changes existe desde el 29/09/2026: hasta el 29/10/2026 su ventana de
 * 30 días no cubre un mes completo, y un calendario revisado antes de esa fecha
 * no deja rastro ahí. Por eso la regla exige LAS DOS condiciones: mientras tanto
 * manda updated_at. Sin la tabla, también manda updated_at.
 */
export async function estadoCalendarioWith(db: Db, teacherId: string, ahora: number): Promise<EstadoCalendario> {
  const limite = new Date(ahora - DIAS_CALENDARIO_VIGENTE * 86_400_000).toISOString();
  const [cambios, cal] = await Promise.all([
    db.from('calendar_changes').select('created_at')
      .eq('teacher_id', teacherId).neq('origin', 'sistema').gte('created_at', limite)
      .order('created_at', { ascending: false }).limit(1),
    db.from('teacher_calendars').select('updated_at').eq('teacher_id', teacherId).maybeSingle(),
  ]);
  if (cal.error) throw new HuecosError('CALENDARIO_ILEGIBLE', cal.error.message);
  const ultimoCambioHumano = cambios.error ? null : ((cambios.data ?? [])[0] as { created_at?: string } | undefined)?.created_at ?? null;
  const updatedAt = (cal.data as { updated_at?: string | null } | null)?.updated_at ?? null;
  const updatedViejo = !updatedAt || Date.parse(updatedAt) < Date.parse(limite);
  return { actualizado: !(ultimoCambioHumano === null && updatedViejo), ultimoCambioHumano, updatedAt };
}

export interface HuecosParams {
  client: Db;
  teacherId: string;
  duracionHoras: number;
  modo: ModoCambio;
  sesionPropia?: SesionPropia;
  /** Reloj (epoch ms), por defecto Date.now(). */
  ahora?: number;
  /** Inicio más temprano admitido (epoch ms). Por defecto ahora + 24 h. */
  desde?: number;
  /** PUNTUAL: inicio más tardío (epoch ms). Por defecto ahora + 6 semanas. */
  hasta?: number;
}

/**
 * Bloques libres del profesor para mover una sesión de `duracionHoras`. LANZA
 * HuecosError CALENDARIO_SIN_ACTUALIZAR si el calendario lleva más de 30 días
 * sin revisar (ver estadoCalendarioWith): con datos viejos no se ofrece nada.
 */
export async function huecosLibres(p: HuecosParams): Promise<BloqueLibre[]> {
  const ahora = p.ahora ?? Date.now();
  if (!(p.duracionHoras >= 1 && p.duracionHoras <= 4)) throw new HuecosError('DATOS_INVALIDOS', 'la duración tiene que ser de 1 a 4 horas');

  const { data: t, error } = await p.client.from('teachers')
    .select('id, calendar_start_hour, calendar_end_hour').eq('id', p.teacherId).maybeSingle();
  if (error) throw new HuecosError('CALENDARIO_ILEGIBLE', error.message);
  if (!t) throw new HuecosError('PROFESOR_NO_EXISTE', `el profesor ${p.teacherId} no existe`);

  const estado = await estadoCalendarioWith(p.client, p.teacherId, ahora);
  if (!estado.actualizado) {
    throw new HuecosError('CALENDARIO_SIN_ACTUALIZAR', `el calendario del profesor no se revisa desde ${estado.updatedAt?.slice(0, 10) ?? 'nunca'}`);
  }

  let grid: Grid;
  try {
    grid = await readTeacherGridWith(p.client, p.teacherId);
  } catch (err) {
    throw new HuecosError('CALENDARIO_ILEGIBLE', err instanceof Error ? err.message : String(err));
  }
  const reservas = await liveReservationsWith(p.client, p.teacherId, ahora);
  const row = t as { calendar_start_hour?: number | null; calendar_end_hour?: number | null };

  return calcularBloques(grid, {
    modo: p.modo, duracionHoras: p.duracionHoras,
    horaInicio: row.calendar_start_hour ?? null, horaFin: row.calendar_end_hour ?? null,
    reservas, sesionPropia: p.sesionPropia, ahora, desde: p.desde, hasta: p.hasta,
  });
}
