// Cambio de PROFESOR pedido por el alumno desde el LMS (Fase 2).
//
// Valida lo que el núcleo de transferencia no mira y después le pasa el cambio
// tal cual (lib/transferencia/core.ts, motivo 'autoservicio', origen 'lms': sin
// scoring y con sus criterios estrictos: HORAS_NO_COINCIDEN, casillas con
// esHuecoLibreParaAlumno, archivados, perfil de prueba, recuperaciones). Los
// efectos (correo y campanita al profesor nuevo, bienvenida 'cambio', campanita
// al anterior, aviso student_transferred_admin) son los de ese núcleo.
//
// Lo que se valida aquí, con las funciones de siempre:
//   · elegibilidad y recuperaciones (Fase 1): cargarAlumnoWith;
//   · que los destinos cubran TODAS sus sesiones con las mismas duraciones;
//   · antelación de la clase ACTUAL (evaluarOrigen, FIJO): la próxima clase de
//     cada sesión tiene que empezar a más de 24 h; si no, ANTELACION_INSUFICIENTE
//     con disponible_desde = el final de esa clase;
//   · el profesor destino es candidato (mismas exclusiones que el listado);
//   · cada destino, con evaluarBloque en modo FIJO (primera clase a más de 24 h y
//     libre según esHuecoLibreParaAlumno), y sin solaparse entre ellos.
//
// Idempotencia: la de transfer_requests. Antes de validar se mira si la clave ya
// resolvió un cambio: un reintento de un cambio hecho devuelve lo guardado aunque
// el alumno ya no esté con el profesor de antes.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AssignedSlot } from '@/types';
import { clavesDeBloque, evaluarBloque } from '@/lib/huecos/huecos';
import { evaluarOrigen, type MomentoEspana } from '@/lib/cambioHorario/origen';
import { CambioHorarioError, type CodigoCambioHorario } from '@/lib/cambioHorario/errors';
import { TransferenciaError } from '@/lib/transferencia/errors';
import type { TransferenciaParams, TransferenciaResultado } from '@/lib/transferencia/core';
import { cargarAlumnoWith, candidatosWith, exigirCandidato, type ContextoAlumno } from '@/lib/cambioProfesor/huecos';

type Db = SupabaseClient;

const DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

export interface DestinoProfesorDto { dia: string; hora: string; duracion: number }

export interface CambioProfesorParams {
  /** students.id */
  studentId: string;
  profesorId: string;
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

/** Si la clave ya resolvió un cambio: su resultado ('ok'), EN_CURSO, o null (seguir). */
async function porClave(db: Db, key: string | undefined, profesorId: string): Promise<TransferenciaResultado | null> {
  if (!key) return null;
  const { data, error } = await db.from('transfer_requests').select('estado, resultado, to_teacher_id').eq('idempotency_key', key).maybeSingle();
  if (error || !data) return null;   // sin la tabla, el núcleo sigue sin registro, como siempre
  const fila = data as { estado: string; resultado: TransferenciaResultado | null; to_teacher_id: string };
  if (fila.to_teacher_id !== profesorId) falla('DATOS_INVALIDOS', `la clave ${key} ya se usó para otro cambio`);
  if (fila.estado === 'ok' && fila.resultado) return fila.resultado;
  if (fila.estado === 'en_curso') {
    throw new TransferenciaError({ codigo: 'EN_CURSO', paso: 'idempotencia', mensaje: `ya hay un cambio de profesor en curso con la clave ${key}` });
  }
  return null;   // 'error' o 'compensada': se puede reintentar con la misma clave
}

/**
 * Cambia de profesor al alumno con todas sus sesiones. LANZA CambioHorarioError
 * (validación de esta capa) o TransferenciaError (núcleo de transferencia).
 */
export async function cambiarProfesorCore(
  db: Db, p: CambioProfesorParams, transferir: Transferir, ahora: number = Date.now(),
): Promise<TransferenciaResultado> {
  // ── Datos ─────────────────────────────────────────────────────────────────
  const profesorId = (p.profesorId ?? '').trim();
  if (!profesorId) falla('DATOS_INVALIDOS', 'falta profesor_id');
  if (!Array.isArray(p.destinos) || p.destinos.length === 0) falla('DATOS_INVALIDOS', 'faltan los destinos');
  for (const d of p.destinos) {
    if (!d || !DIAS.includes(d.dia) || !/^\d{2}:00$/.test(d.hora ?? '') || !Number.isInteger(d.duracion) || d.duracion < 1 || d.duracion > 4) {
      falla('DATOS_INVALIDOS', `destino mal formado: ${JSON.stringify(d)}`);
    }
  }

  const repetido = await porClave(db, p.idempotencyKey, profesorId);
  if (repetido) return repetido;

  // ── Alumno: elegibilidad, recuperaciones y sesiones actuales ───────────────
  const alumno = await cargarAlumnoWith(db, p.studentId);

  // Todas sus sesiones, con las mismas duraciones (y por tanto las mismas horas).
  const actuales = alumno.sesiones.map(s => s.duracion).sort();
  const pedidas = p.destinos.map(d => d.duracion).sort();
  if (actuales.join() !== pedidas.join()) {
    falla('DATOS_INVALIDOS', `los destinos tienen que cubrir sus ${actuales.length} sesión(es) con las mismas duraciones (${actuales.join(', ')} h); llegaron ${pedidas.join(', ') || 'ninguna'} h`);
  }

  // Antelación de la clase ACTUAL.
  const bloqueo = bloqueoPorAntelacion(alumno, ahora);
  if (bloqueo) falla(bloqueo.codigo, bloqueo.mensaje, { disponibleDesde: bloqueo.disponibleDesde });

  // ── Profesor destino y destinos ───────────────────────────────────────────
  const c = await candidatosWith(db, { profesorActual: alumno.profesorActual, ahora, soloId: profesorId });
  const prof = exigirCandidato(c, profesorId);
  const grid = c.grids.get(prof.id) ?? {};

  const usadas = new Set<string>();
  const slots: AssignedSlot[] = [];
  for (const d of p.destinos) {
    const claves = clavesDeBloque(d.dia, Number(d.hora.slice(0, 2)), d.duracion);
    if (!claves) falla('DATOS_INVALIDOS', `el bloque ${d.dia} ${d.hora} de ${d.duracion} h pasa de las 23:00`);
    const solapadas = claves!.filter(k => usadas.has(k));
    if (solapadas.length) falla('DATOS_INVALIDOS', `dos destinos se solapan en ${solapadas.join(', ')}`, { detalles: solapadas });
    claves!.forEach(k => usadas.add(k));

    const ev = evaluarBloque(grid, { dia: d.dia, hora: Number(d.hora.slice(0, 2)) }, {
      modo: 'fijo', duracionHoras: d.duracion, horaInicio: prof.horaInicio, horaFin: prof.horaFin,
      reservas: c.reservas.get(prof.id) ?? [], ahora,
    });
    if (!ev.ok) falla(ev.motivo, `${prof.nombre}: el hueco ${d.dia} ${d.hora} no se puede usar${ev.detalle ? ` (${ev.detalle})` : ''}`, { detalles: ev.detalle ? [ev.detalle] : [] });
    for (const k of claves!) slots.push({ day: d.dia, hour: k.slice(k.lastIndexOf('_') + 1) });
  }

  // ── Transferencia: el núcleo de siempre ───────────────────────────────────
  return transferir({
    assignmentId: alumno.assignmentId,
    toTeacherId: prof.id,
    slots,
    motivo: 'autoservicio',
    origen: 'lms',
    actor: `alumno:${p.studentId}`,
    idempotencyKey: p.idempotencyKey,
  });
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
