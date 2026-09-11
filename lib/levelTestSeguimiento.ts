// Seguimiento del formulario inicial + prueba de nivel, alumno por alumno, para
// la pestaña "Tests de nivel" del admin.
//
// La unidad ya no es la sesión de test sino el ALUMNO: recibió el enlace tal
// día, hizo el formulario tal otro, completó la prueba tal otro. Cada fila
// junta el último form_token del alumno (enlace + formulario) con sus sesiones
// de test (prueba + nivel). Quién está pendiente y en qué secuencia lo decide
// la MISMA función que usa el cron de recordatorios (buildPendingList), así el
// panel nunca dice una cosa y el cron hace otra.
//
// Funciones puras sobre filas ya leídas; la pestaña solo pinta.

import {
  buildPendingList, latestTokenPerStudent, studentKeyOf, tokenStateOf, daysSince, norm,
  type FormTokenRow, type StudentRow, type TestSessionRow, type DropoutRow, type PendingEntry,
} from '@/lib/formReminders';
import { testStateOf, type LevelTestInfo } from '@/lib/levelTestClient';

/**
 * rojo     → pendiente y más de DIAS_PARADO días sin avanzar: hay que perseguirlo.
 * ambar    → pendiente, en marcha (hay que empujar, pero todavía no es alarma).
 * gris     → el enlace salió hoy; nada que reclamar aún.
 * ok       → prueba completada.
 * caducado → el enlace caducó sin que lo abriera; el cron le genera otro.
 * baja     → ya no es alumno (student_dropouts o borrado): no se persigue.
 */
export type Tono = 'rojo' | 'ambar' | 'gris' | 'ok' | 'caducado' | 'baja';

export type Filtro = 'parados' | 'enmarcha' | 'completadas' | 'todos';

/** Días sin avanzar a partir de los cuales el alumno cuenta como "parado". */
export const DIAS_PARADO = 7;

export interface Seguimiento {
  /** Clave estable del alumno (id o nombre) para seleccionar y abrir el detalle. */
  clave: string;
  nombre: string;
  email: string | null;
  studentId: string | null;
  profesor: string | null;
  /** El form_token de referencia (el mismo que mira el cron); null si solo hay test. */
  token: FormTokenRow | null;
  /** La sesión completada más reciente o, si no hay, la última creada. */
  sesion: LevelTestInfo | null;
  /** ISO: cuándo recibió el enlace (del formulario o, sin él, de la prueba). */
  enviado: string;
  /** ISO: cuándo completó el formulario. */
  formulario: string | null;
  /** ISO: cuándo completó la prueba. */
  prueba: string | null;
  cefr: string | null;
  overall: number | null;
  tono: Tono;
  /** Días desde el último hito (enlace o formulario). 0 si completó. */
  dias: number;
  /** Entrada del cron si está en una secuencia de recordatorios. */
  pendiente: PendingEntry | null;
  /** "Recordar" aplica: está en una secuencia y tiene enlace y email. */
  recordable: boolean;
}

export interface SeguimientoInput {
  tokens: FormTokenRow[];
  sessions: LevelTestInfo[];
  students: StudentRow[];
  dropouts: DropoutRow[];
  now: number;
}

const claveSesion = (s: LevelTestInfo) => s.student_id?.trim() || `n:${norm(s.student_name || s.candidate_name)}`;

const masReciente = (a: { created_at: string }, b: { created_at: string }) =>
  new Date(b.created_at).getTime() - new Date(a.created_at).getTime();

/** Mismo día de calendario (en la zona horaria de quien mira). */
const esHoy = (iso: string, now: number) => new Date(iso).toDateString() === new Date(now).toDateString();

/**
 * Tono de un alumno pendiente según los días que lleva sin avanzar. "Enviado
 * hoy" va por día de calendario, no por 24 h: un enlace de ayer a la tarde ya
 * es "Falta el formulario".
 */
function tonoPendiente(dias: number, enviado: string, formulario: string | null, now: number): Tono {
  if (dias > DIAS_PARADO) return 'rojo';
  if (!formulario && esHoy(enviado, now)) return 'gris';
  return 'ambar';
}

/**
 * Una fila por alumno, de la más reciente a la más antigua (por la fecha en
 * que recibió el enlace). Facundo quiere ver primero a los que acaban de
 * entrar; los trabados de hace meses ya los cuenta el filtro "Parados".
 */
export function construirSeguimiento(input: SeguimientoInput): Seguimiento[] {
  const { tokens, sessions, students, dropouts, now } = input;

  const stById = new Map(students.map(s => [s.id, s]));
  const stByName = new Map(students.map(s => [norm(s.name), s]));
  const bajaIds = new Set(dropouts.map(d => d.student_id).filter(Boolean) as string[]);
  const bajaNames = new Set(dropouts.map(d => norm(d.student_name)).filter(Boolean));

  // Las entradas del cron, por alumno. buildPendingList puede cambiar el token
  // de referencia (el último caducó pero uno anterior está completado), por eso
  // se indexa por la clave del alumno y no por el id del token.
  const pendientes = new Map<string, PendingEntry>();
  for (const e of buildPendingList({
    tokens, students, dropouts, now,
    sessions: sessions as unknown as TestSessionRow[],
  })) pendientes.set(studentKeyOf(e.token), e);

  // El último token completado de cada alumno (mismo criterio que el cron).
  const completadoPorAlumno = new Map<string, FormTokenRow>();
  for (const t of tokens) {
    if (t.status !== 'completed' || !t.completed_at) continue;
    const k = studentKeyOf(t);
    const previo = completadoPorAlumno.get(k);
    if (!previo || new Date(t.completed_at).getTime() > new Date(previo.completed_at!).getTime()) {
      completadoPorAlumno.set(k, t);
    }
  }

  // Sesiones de test agrupadas por alumno, con matching tolerante contra los
  // tokens (id → email → nombre): hay sesiones sin student_id.
  const ultimos = latestTokenPerStudent(tokens);
  const claveDeToken = new Map<string, string>();
  for (const t of ultimos.values()) {
    const k = studentKeyOf(t);
    if (t.student_id) claveDeToken.set(`id:${t.student_id}`, k);
    if (t.student_email) claveDeToken.set(`em:${norm(t.student_email)}`, k);
    if (t.student_name) claveDeToken.set(`nm:${norm(t.student_name)}`, k);
  }
  const sesionesPor = new Map<string, LevelTestInfo[]>();
  for (const s of sessions) {
    const k =
      (s.student_id ? claveDeToken.get(`id:${s.student_id}`) : undefined)
      ?? (s.candidate_email ? claveDeToken.get(`em:${norm(s.candidate_email)}`) : undefined)
      ?? claveDeToken.get(`nm:${norm(s.student_name || s.candidate_name)}`)
      ?? `s:${claveSesion(s)}`;
    const lista = sesionesPor.get(k);
    if (lista) lista.push(s); else sesionesPor.set(k, [s]);
  }
  for (const lista of sesionesPor.values()) lista.sort(masReciente);

  const out: Seguimiento[] = [];

  // ── Alumnos con enlace del formulario ──────────────────────────────────────
  for (const ultimo of ultimos.values()) {
    const clave = studentKeyOf(ultimo);
    const pendiente = pendientes.get(clave) ?? null;
    const completado = completadoPorAlumno.get(clave);

    // Token de referencia: el que mira el cron; si no está en ninguna secuencia,
    // el último salvo que haya caducado y un anterior esté completado.
    const ref = pendiente?.token
      ?? (tokenStateOf(ultimo, now) === 'expired' && completado ? completado : ultimo);

    const student =
      (ref.student_id ? stById.get(ref.student_id) : undefined) ?? stByName.get(norm(ref.student_name));
    const esBaja =
      (!!ref.student_id && bajaIds.has(ref.student_id)) || bajaNames.has(norm(ref.student_name))
      || (!!ref.student_id && !student);

    const sesiones = sesionesPor.get(clave) ?? [];
    const completada = sesiones.find(s => s.status === 'completed') ?? null;
    const sesion = completada ?? sesiones[0] ?? null;
    const formulario = ref.status === 'completed' ? ref.completed_at : null;

    let tono: Tono;
    let dias = 0;
    if (completada) {
      tono = 'ok';
    } else if (pendiente) {
      dias = Math.max(0, pendiente.days);
      tono = tonoPendiente(dias, ref.created_at, formulario, now);
    } else if (esBaja) {
      tono = 'baja';
      dias = Math.max(0, daysSince(formulario ?? ref.created_at, now));
    } else if (tokenStateOf(ref, now) === 'expired') {
      tono = 'caducado';
      dias = Math.max(0, daysSince(ref.created_at, now));
    } else {
      // Fuera del cron por otro motivo (sin email, formulario sin fecha…): se
      // clasifica por las fechas igual, pero sin botón de recordar.
      dias = Math.max(0, daysSince(formulario ?? ref.created_at, now));
      tono = tonoPendiente(dias, ref.created_at, formulario, now);
    }

    out.push({
      clave,
      nombre: ref.student_name || student?.name || sesion?.candidate_name || '—',
      email: ref.student_email?.trim() || student?.email?.trim() || sesion?.candidate_email || null,
      studentId: ref.student_id ?? student?.id ?? null,
      profesor: ref.teacher_name ?? null,
      token: ref,
      sesion,
      enviado: ref.created_at,
      formulario,
      prueba: completada?.completed_at ?? null,
      cefr: completada?.cefr_level ?? null,
      overall: completada?.overall_score ?? null,
      tono, dias, pendiente,
      recordable: !!pendiente,
    });
  }

  // ── Candidatos con prueba pero sin formulario (link manual) ────────────────
  for (const [k, sesiones] of sesionesPor) {
    if (!k.startsWith('s:')) continue;
    const completada = sesiones.find(s => s.status === 'completed') ?? null;
    const ref = completada ?? sesiones[0];
    const estado = testStateOf(ref);
    let tono: Tono;
    let dias = 0;
    if (completada) tono = 'ok';
    else if (estado === 'expired' || estado === 'abandoned') { tono = 'caducado'; dias = Math.max(0, daysSince(ref.created_at, now)); }
    else { dias = Math.max(0, daysSince(ref.created_at, now)); tono = tonoPendiente(dias, ref.created_at, null, now); }

    out.push({
      clave: k,
      nombre: ref.student_name || ref.candidate_name,
      email: ref.candidate_email || null,
      studentId: ref.student_id,
      profesor: null,
      token: null,
      sesion: ref,
      enviado: ref.created_at,
      formulario: null,
      prueba: completada?.completed_at ?? null,
      cefr: completada?.cefr_level ?? null,
      overall: completada?.overall_score ?? null,
      tono, dias,
      pendiente: null,
      recordable: false,
    });
  }

  return out.sort((a, b) => new Date(b.enviado).getTime() - new Date(a.enviado).getTime());
}

// ── Filtros y etiquetas ──────────────────────────────────────────────────────
export function filtroDe(tono: Tono): Exclude<Filtro, 'todos'> | null {
  if (tono === 'rojo' || tono === 'caducado') return 'parados';
  if (tono === 'ambar' || tono === 'gris') return 'enmarcha';
  if (tono === 'ok') return 'completadas';
  return null;                                     // baja: solo en "Todos"
}

export function pasaFiltro(e: Seguimiento, filtro: Filtro): boolean {
  return filtro === 'todos' || filtroDe(e.tono) === filtro;
}

/** Texto de la única etiqueta de estado de cada alumno. */
export function etiquetaDe(e: Seguimiento): string {
  switch (e.tono) {
    case 'rojo':     return `Parado ${e.dias} d`;
    case 'ambar':    return e.formulario ? 'Falta la prueba' : 'Falta el formulario';
    case 'gris':     return 'Enviado hoy';
    case 'ok':       return 'Completada';
    case 'caducado': return 'Caducado';
    case 'baja':     return 'Baja';
  }
}

export function buscaEn(e: Seguimiento, q: string): boolean {
  const t = q.trim().toLowerCase();
  if (!t) return true;
  return e.nombre.toLowerCase().includes(t) || (e.email ?? '').toLowerCase().includes(t);
}

// ── Cifras de arriba (escritorio) ────────────────────────────────────────────
export interface ResumenSeguimiento {
  /** Enlaces enviados en los últimos 30 días y cuántos de esos avanzaron. */
  enviadas30: number;
  formulario30: number;
  prueba30: number;
  /** Parados más de DIAS_PARADO días (o con el enlace caducado), de todos los tiempos. */
  parados: number;
}

export function resumenSeguimiento(filas: Seguimiento[], now: number): ResumenSeguimiento {
  const recientes = filas.filter(e => e.tono !== 'baja' && daysSince(e.enviado, now) <= 30);
  return {
    enviadas30:   recientes.length,
    formulario30: recientes.filter(e => !!e.formulario).length,
    prueba30:     recientes.filter(e => !!e.prueba).length,
    parados:      filas.filter(e => filtroDe(e.tono) === 'parados').length,
  };
}

// ── Respuesta de /api/forms/remind ───────────────────────────────────────────
export type MotivoManual = 'no_pendiente' | 'ya_hoy' | 'reserva' | 'ya_tomado' | 'sin enlace' | 'envío';

export interface ResultadoManual {
  tokenId: string;
  alumno: string | null;
  ok: boolean;
  /** Qué recordatorio salió ("2º recordatorio"), si salió. */
  paso?: string;
  motivo?: MotivoManual;
}

export const MOTIVO_MANUAL: Record<MotivoManual, string> = {
  no_pendiente: 'ya no está pendiente',
  ya_hoy:       'ya recibió uno en las últimas 24 h',
  reserva:      'no se pudo reservar el envío',
  ya_tomado:    'otro envío se adelantó',
  'sin enlace': 'no se pudo preparar el enlace',
  'envío':      'el correo no salió',
};
