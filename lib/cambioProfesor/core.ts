// Cambio de PROFESOR pedido por el alumno desde el LMS (Fase 2, contrato v3).
//
// El alumno elige SOLO horarios (uno por sesión); Gestión elige el profesor en
// el momento y le pasa el cambio al núcleo de transferencia de siempre
// (lib/transferencia/core.ts, motivo 'autoservicio', origen 'lms': sin scoring y
// con sus criterios estrictos: HORAS_NO_COINCIDEN, casillas con
// esHuecoLibreParaAlumno, archivados, perfil de prueba, recuperaciones). Los
// efectos (correo con la ficha y campanita al profesor nuevo, bienvenida
// 'cambio', campanita al anterior, aviso student_transferred_admin) son los de
// ese núcleo.
//
// Lo que se valida aquí, con las funciones de siempre:
//   · elegibilidad y recuperaciones (Fase 1): cargarAlumnoWith;
//   · que los destinos cubran TODAS sus sesiones con las mismas duraciones, sin
//     solaparse ni ir seguidos entre ellos;
//   · antelación de la clase ACTUAL (evaluarOrigen, FIJO) y de la NUEVA (cada
//     destino empieza a más de 24 h);
//   · candidatos (mismas exclusiones que el listado) que tengan libres TODOS los
//     destinos (evaluarBloque en modo FIJO).
//
// Elección: elegirProfesor (lib/cambioProfesor/elegirProfesor.ts). Si al
// transferir alguien ocupó un hueco entre medias (HUECO_YA_OCUPADO o
// SLOT_NO_DISPONIBLE del núcleo, sin nada a medias), se prueba con el siguiente
// candidato que cubra todo, hasta MAX_INTENTOS; si no queda ninguno,
// HUECO_YA_OCUPADO.
//
// Idempotencia: la de transfer_requests, con una clave por profesor probado
// (`<clave>|<profesor>`), porque el núcleo no deja usar la misma clave con dos
// profesores. Antes de validar se mira si alguna de esas claves ya resolvió el
// cambio: un reintento de un cambio hecho devuelve lo guardado aunque el alumno
// ya no esté con el profesor de antes.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AssignedSlot } from '@/types';
import { ANTELACION_MINIMA_MS, proximaFechaDe } from '@/lib/huecos/huecos';
import { spainWallClockToEpoch } from '@/lib/spainTime';
import { evaluarOrigen, type MomentoEspana } from '@/lib/cambioHorario/origen';
import { CambioHorarioError, type CodigoCambioHorario } from '@/lib/cambioHorario/errors';
import { TransferenciaError } from '@/lib/transferencia/errors';
import type { TransferenciaParams, TransferenciaResultado } from '@/lib/transferencia/core';
import {
  cargarAlumnoWith, candidatosWith, clavesDeHorario, cubreTodos, validarHorarios,
  type ContextoAlumno, type Horario, type ProfesorCandidato,
} from '@/lib/cambioProfesor/huecos';
import { elegirProfesor } from '@/lib/cambioProfesor/elegirProfesor';

type Db = SupabaseClient;

export type DestinoProfesorDto = Horario;

/** Profesores que se prueban como mucho en un POST (el primero y dos más si alguien ocupa un hueco). */
export const MAX_INTENTOS = 3;

export interface CambioProfesorParams {
  /** students.id */
  studentId: string;
  /** Una por sesión del alumno, con las mismas duraciones. */
  destinos: DestinoProfesorDto[];
  idempotencyKey?: string;
}

/** Cómo se transfiere: transferirAlumnoServidor en producción, el núcleo con el cliente falso en los tests. */
export type Transferir = (p: TransferenciaParams) => Promise<TransferenciaResultado>;

const falla = (codigo: CodigoCambioHorario, mensaje: string, extra: { detalles?: string[]; disponibleDesde?: MomentoEspana | null } = {}): never => {
  throw new CambioHorarioError({ codigo, paso: 'cambio de profesor', mensaje, ...extra });
};

/** El más tardío de varios momentos de España (fecha + hora comparables como texto). */
const masTarde = (xs: MomentoEspana[]): MomentoEspana | null =>
  xs.reduce<MomentoEspana | null>((m, x) => (!m || `${x.fecha} ${x.hora}` > `${m.fecha} ${m.hora}` ? x : m), null);

/**
 * ¿Puede cambiar de profesor AHORA? null si sí; si no, el motivo y, con
 * antelación, desde cuándo. La usan el POST y GET estado (puede_cambiar_profesor).
 */
export function bloqueoPorAntelacion(alumno: ContextoAlumno, ahora: number): { codigo: 'ANTELACION_INSUFICIENTE'; mensaje: string; disponibleDesde: MomentoEspana | null } | null {
  const fallos = alumno.sesiones
    .map(s => ({ s, ev: evaluarOrigen(alumno.grid, s, 'fijo', ahora) }))
    .filter(x => !x.ev.ok);
  if (fallos.length === 0) return null;
  const desde = masTarde(fallos.flatMap(x => (!x.ev.ok && x.ev.disponibleDesde ? [x.ev.disponibleDesde] : [])));
  return {
    codigo: 'ANTELACION_INSUFICIENTE',
    mensaje: `la próxima clase de ${fallos.map(x => `${x.s.dia} ${x.s.hora}`).join(' y ')} empieza en menos de 24 h`,
    disponibleDesde: desde,
  };
}

/** Clave de idempotencia del intento con un profesor. */
export const claveDeIntento = (key: string, profesorId: string) => `${key}|${profesorId}`;

/** Si la clave ya resolvió un cambio (con cualquier profesor): su resultado, EN_CURSO, o null (seguir). */
async function porClave(db: Db, key: string | undefined, studentId: string): Promise<TransferenciaResultado | null> {
  if (!key) return null;
  const { data, error } = await db.from('transfer_requests').select('estado, resultado, assignment_id')
    .like('idempotency_key', claveDeIntento(key, '%'));
  if (error || !data?.length) return null;   // sin la tabla, el núcleo sigue sin registro, como siempre
  const filas = data as Array<{ estado: string; resultado: TransferenciaResultado | null; assignment_id: string }>;
  const hecha = filas.find(f => f.estado === 'ok' && f.resultado);
  if (hecha) {
    const { data: asg } = await db.from('assignments').select('student_id').eq('id', hecha.assignment_id).maybeSingle();
    const dueño = (asg as { student_id?: string | null } | null)?.student_id;
    if (dueño && dueño !== studentId) falla('DATOS_INVALIDOS', `la clave ${key} ya se usó para el cambio de otro alumno`);
    return hecha.resultado;
  }
  if (filas.some(f => f.estado === 'en_curso')) {
    throw new TransferenciaError({ codigo: 'EN_CURSO', paso: 'idempotencia', mensaje: `ya hay un cambio de profesor en curso con la clave ${key}` });
  }
  return null;   // 'error' o 'compensada': se puede reintentar con la misma clave
}

/** Asignaciones activas por profesor (status null cuenta como activa). Si no se pueden leer, todos a 0. */
async function asignacionesActivasWith(db: Db, ids: string[]): Promise<Map<string, number>> {
  const n = new Map(ids.map(id => [id, 0]));
  if (!ids.length) return n;
  const PAGINA = 1000;
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error } = await db.from('assignments').select('teacher_id, status')
      .in('teacher_id', ids).or('status.is.null,status.eq.active').order('id').range(desde, desde + PAGINA - 1);
    if (error) {
      console.error('[cambio de profesor] no se pudieron contar las asignaciones activas; se elige solo por calendario e id:', error.message);
      return new Map(ids.map(id => [id, 0]));
    }
    const filas = (data ?? []) as Array<{ teacher_id: string }>;
    for (const f of filas) n.set(f.teacher_id, (n.get(f.teacher_id) ?? 0) + 1);
    if (filas.length < PAGINA) return n;
  }
}

/** ¿El núcleo falló porque alguien ocupó un hueco, sin dejar nada a medias? Entonces se prueba con otro profesor. */
const huecoPerdido = (err: unknown): boolean =>
  err instanceof TransferenciaError && (err.codigo === 'HUECO_YA_OCUPADO' || err.codigo === 'SLOT_NO_DISPONIBLE') && err.compensada !== false;

/**
 * Cambia de profesor al alumno con todas sus sesiones; el profesor lo elige
 * Gestión. LANZA CambioHorarioError (validación de esta capa) o
 * TransferenciaError (núcleo de transferencia).
 */
export async function cambiarProfesorCore(
  db: Db, p: CambioProfesorParams, transferir: Transferir, ahora: number = Date.now(),
): Promise<TransferenciaResultado> {
  // ── Datos ─────────────────────────────────────────────────────────────────
  if (!Array.isArray(p.destinos)) falla('DATOS_INVALIDOS', 'faltan los destinos');
  const key = p.idempotencyKey?.trim() || undefined;
  if (key && !/^[\w.:-]{1,128}$/.test(key)) falla('DATOS_INVALIDOS', 'idempotency_key: hasta 128 letras, números, guiones, puntos o dos puntos');
  validarHorarios(p.destinos, 'destinos');

  const repetido = await porClave(db, key, p.studentId);
  if (repetido) return repetido;

  // ── Alumno: elegibilidad, recuperaciones y sesiones actuales ───────────────
  const alumno = await cargarAlumnoWith(db, p.studentId);

  // Todas sus sesiones, con las mismas duraciones (y por tanto las mismas horas):
  // si falta una, sobra una o una duración no coincide, SESIONES_NO_COINCIDEN.
  const actuales = alumno.sesiones.map(s => s.duracion).sort((a, b) => a - b);
  const pedidas = p.destinos.map(d => d.duracion).sort((a, b) => a - b);
  if (actuales.join() !== pedidas.join()) {
    const que = pedidas.length < actuales.length ? 'falta alguna sesión'
      : pedidas.length > actuales.length ? 'sobra alguna sesión' : 'alguna duración no coincide';
    falla('SESIONES_NO_COINCIDEN', `${que}: tiene ${actuales.length} sesión(es) de ${actuales.join(', ')} h y llegaron ${pedidas.join(', ') || 'ninguna'} h`);
  }

  // Antelación de la clase ACTUAL.
  const bloqueo = bloqueoPorAntelacion(alumno, ahora);
  if (bloqueo) falla(bloqueo.codigo, bloqueo.mensaje, { disponibleDesde: bloqueo.disponibleDesde });

  // Antelación de la clase NUEVA: no depende del profesor.
  for (const d of p.destinos) {
    const h = Number(d.hora.slice(0, 2));
    if (!(spainWallClockToEpoch(proximaFechaDe(d.dia, h, ahora), h) > ahora + ANTELACION_MINIMA_MS)) {
      falla('ANTELACION_INSUFICIENTE', `la primera clase de ${d.dia} ${d.hora} empezaría en menos de 24 h`);
    }
  }

  // ── Profesores que cubren TODOS los destinos ───────────────────────────────
  const c = await candidatosWith(db, { profesorActual: alumno.profesorActual, ahora });
  const cubren = c.profesores.filter(prof => cubreTodos(c, prof, p.destinos, ahora));
  if (!cubren.length) {
    falla('SLOT_NO_DISPONIBLE', `ningún profesor tiene libres a la vez ${p.destinos.map(d => `${d.dia} ${d.hora} (${d.duracion} h)`).join(', ')}`);
  }
  const activas = await asignacionesActivasWith(db, cubren.map(x => x.id));
  const aElegir = cubren.map(x => ({ ...x, asignacionesActivas: activas.get(x.id) ?? 0 }));

  const slots: AssignedSlot[] = p.destinos.flatMap(d =>
    clavesDeHorario(d).map(k => ({ day: d.dia, hour: k.slice(k.lastIndexOf('_') + 1) })));

  // ── Transferencia: el núcleo de siempre, con reintento en otro profesor ────
  const probados: ProfesorCandidato[] = [];
  for (let intento = 0; intento < MAX_INTENTOS; intento++) {
    const prof = elegirProfesor(aElegir.filter(x => !probados.some(y => y.id === x.id)));
    if (!prof) break;
    probados.push(prof);
    try {
      return await transferir({
        assignmentId: alumno.assignmentId,
        toTeacherId: prof.id,
        slots,
        motivo: 'autoservicio',
        origen: 'lms',
        actor: `alumno:${p.studentId}`,
        idempotencyKey: key ? claveDeIntento(key, prof.id) : undefined,
      });
    } catch (err) {
      if (!huecoPerdido(err)) throw err;
      console.warn(`[cambio de profesor] ${alumno.alumno}: ${prof.id} ya no tiene libre todo (${(err as Error).message}); se prueba con otro.`);
    }
  }
  return falla('HUECO_YA_OCUPADO', `se probó con ${probados.length} profesor(es) y en todos alguien ocupó antes alguno de esos horarios`);
}

// ── GET estado ────────────────────────────────────────────────────────────────

export interface PuedeCambiarProfesorDto {
  puede: boolean;
  /** Código del motivo si no puede (NO_ELEGIBLE, RECUPERACION_PENDIENTE, ANTELACION_INSUFICIENTE…). */
  motivo: string | null;
  detalle_no_elegible: string | null;
  /** Con ANTELACION_INSUFICIENTE: el final de la clase que lo impide (España). */
  disponible_desde: MomentoEspana | null;
}

/**
 * puede_cambiar_profesor de GET estado, con las MISMAS comprobaciones que el
 * POST antes de elegir profesor (cargarAlumnoWith + bloqueoPorAntelacion). El
 * calendario sin actualizar del profesor actual no cuenta: se va de él.
 */
export async function puedeCambiarProfesorWith(db: Db, studentId: string, ahora: number = Date.now()): Promise<PuedeCambiarProfesorDto> {
  let alumno: ContextoAlumno;
  try {
    alumno = await cargarAlumnoWith(db, studentId);
  } catch (err) {
    if (err instanceof CambioHorarioError) {
      return { puede: false, motivo: err.codigo, detalle_no_elegible: err.detalleNoElegible, disponible_desde: null };
    }
    throw err;
  }
  const bloqueo = bloqueoPorAntelacion(alumno, ahora);
  return bloqueo
    ? { puede: false, motivo: bloqueo.codigo, detalle_no_elegible: null, disponible_desde: bloqueo.disponibleDesde }
    : { puede: true, motivo: null, detalle_no_elegible: null, disponible_desde: null };
}
