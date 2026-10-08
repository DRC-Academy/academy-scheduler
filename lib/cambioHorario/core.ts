// NÚCLEO del cambio de horario con el MISMO profesor (Fase 1), pedido por el
// alumno desde el LMS. Misma arquitectura que lib/transferencia/core.ts: cliente
// de Supabase inyectado, correos inyectados (deps), errores tipados, auditoría e
// idempotencia en schedule_change_requests. NO importa lib/supabase.ts.
//
// Dos modos:
//   · FIJO ("desde ahora, todas mis clases"): UN patch condicional del calendario
//     que libera las casillas de la sesión (solo las del alumno por nombre exacto)
//     y ocupa las nuevas con withBaseState. assignments.slots NO se escribe a
//     mano: lo deriva syncSlotsFromGrid (reconcileAssignmentStatusWith). No se
//     tocan meet_link, created_at, teacher_since ni los avisos de presentación.
//   · PUNTUAL ("solo esta clase"): lo mismo que el "Reprogramar" del profesor, con
//     las mismas funciones: la constancia 'reprogramada' (addRescheduleRecordWith)
//     y las marcas del calendario (marcasDeReprogramacion). Orden: primero la
//     constancia y después el calendario; si el calendario falla, se borra la
//     constancia (unas marcas sin constancia dejarían la clase original
//     cobrándose como si se hubiera dado).
//
// Los patches son TODO O NADA (applyCalendarPatchAllOrNothing): cualquier
// conflicto deshace lo aplicado y se lanza HUECO_YA_OCUPADO. calendar_changes se
// escribe solo con el patch completo. No toca el scoring de ninguna forma.
//
// Reglas de negocio (cerradas): ver la cabecera de lib/huecos/huecos.ts y
// docs/autoservicio-contrato.md.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Grid } from '@/types';
import { withBaseState } from '@/lib/cells';
import { diffGrids, studentEvents } from '@/lib/gridPatch';
import {
  readTeacherGridWith, applyCalendarPatchAllOrNothing, logCalendarChangesWith, reconcileAssignmentStatusWith,
  type AppliedPatch, type CalendarActor,
} from '@/lib/calendarStore';
import { liveReservationsWith, openRecoveriesOfStudentWith } from '@/lib/classRecoveryQueries';
import { notifyAdminWith, notifyStudentScheduleChangedWith } from '@/lib/notificationStore';
import { addRescheduleRecordWith, deleteClassRecordsWith } from '@/lib/classRecordStore';
import { marcasDeReprogramacion } from '@/lib/reprogramacion';
import { estadoCalendarioWith, evaluarBloque } from '@/lib/huecos/huecos';
import { cargarElegibilidadWith } from '@/lib/cambioHorario/elegibilidad';
import { evaluarOrigen } from '@/lib/cambioHorario/origen';
import { sesionesDelAlumno } from '@/lib/cambioHorario/sesiones';
import { avisoProfesor, type DatosCambioTexto } from '@/lib/cambioHorario/textos';
import { abrirRegistroCambio, cerrarRegistroCambio } from '@/lib/cambioHorario/auditoria';
import { CambioHorarioError, type CodigoCambioHorario } from '@/lib/cambioHorario/errors';

export { CambioHorarioError } from '@/lib/cambioHorario/errors';
export type { CodigoCambioHorario, DetalleNoElegible } from '@/lib/cambioHorario/errors';

type Db = SupabaseClient;

// ── Tipos públicos ────────────────────────────────────────────────────────────

export type ModoCambioHorario = 'puntual' | 'fijo';
export type OrigenCambioHorario = 'lms' | 'admin' | 'script';

/** Sesión tal como la ve el LMS: día como en el calendario ('Miércoles'), hora 'HH:MM' de España, duración en horas. */
export interface SesionDto { dia: string; hora: string; duracion: number }
/** Hueco destino, tal como lo devuelve GET huecos. `fecha` manda en PUNTUAL; en FIJO es informativa. */
export interface DestinoDto extends SesionDto { fecha?: string }

export interface CambioHorarioParams {
  /** students.id del alumno (el endpoint lo resuelve por su email). */
  studentId: string;
  modo: ModoCambioHorario;
  sesionOrigen: SesionDto;
  /** PUNTUAL: fecha de la clase que se mueve (YYYY-MM-DD, España). */
  fechaOrigen?: string;
  destino: DestinoDto;
  origen: OrigenCambioHorario;
  /** Quién lo pide (p. ej. el email del alumno). Va a la auditoría y al historial. */
  actor: string;
  idempotencyKey?: string;
}

/** Datos de los dos correos. */
export interface DatosAvisoCambio extends DatosCambioTexto {
  teacherId: string;
  studentId: string;
  /** students.email (el del LMS). */
  studentEmail: string | null;
  /** assignments.student_email si es distinto (a veces es el de un padre o una madre). */
  ccEmail: string | null;
}

export interface CambioHorarioDeps {
  /** Correo al profesor. true si salió; false o excepción = fallo (aviso al admin). */
  enviarEmailProfesor(d: DatosAvisoCambio): Promise<boolean>;
  /** Correo de confirmación al alumno. true si salió; false o excepción = fallo. */
  enviarEmailAlumno(d: DatosAvisoCambio): Promise<boolean>;
  /** Reloj inyectable (tests). Por defecto Date.now. */
  ahora?: () => number;
}

export interface CambioHorarioResultado {
  modo: ModoCambioHorario;
  assignmentId: string;
  alumno: string;
  profesor: { id: string; name: string };
  sesionAntes: SesionDto;
  sesionDespues: SesionDto;
  /** PUNTUAL: la clase que se movió. */
  fechaOriginal: string | null;
  /** PUNTUAL: su fecha nueva. FIJO: la primera clase con el horario nuevo. */
  fechaNueva: string | null;
  avisos: string[];
  /** Efectos que fallaron (el cambio está hecho; el admin ya recibió un aviso por cada uno). */
  efectosFallidos: string[];
}

// ── Utilidades ────────────────────────────────────────────────────────────────

const HORA_RE = /^\d{2}:00$/;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const horaNum = (h: string): number => Number(h.slice(0, 2));
const normEmail = (e: string | null | undefined): string => (e ?? '').trim().toLowerCase();

function validarDatos(p: CambioHorarioParams): void {
  const mal = (mensaje: string): never => { throw new CambioHorarioError({ codigo: 'DATOS_INVALIDOS', paso: 'validación', mensaje }); };
  if (p.modo !== 'puntual' && p.modo !== 'fijo') mal(`modo desconocido: ${String(p.modo)}`);
  for (const [n, s] of [['sesion_origen', p.sesionOrigen], ['destino', p.destino]] as const) {
    if (!s || typeof s.dia !== 'string' || typeof s.hora !== 'string') mal(`falta ${n}`);
    if (!HORA_RE.test(s.hora)) mal(`${n}.hora tiene que ser "HH:00" (llegó "${s.hora}")`);
    if (!Number.isInteger(s.duracion) || s.duracion < 1 || s.duracion > 4) mal(`${n}.duracion tiene que ser un entero de 1 a 4`);
  }
  if (p.destino.duracion !== p.sesionOrigen.duracion) mal('el destino tiene que durar lo mismo que la sesión que se mueve');
  if (p.modo === 'puntual') {
    if (!FECHA_RE.test(p.fechaOrigen ?? '')) mal('en modo puntual falta fecha_origen (YYYY-MM-DD)');
    if (!FECHA_RE.test(p.destino.fecha ?? '')) mal('en modo puntual el destino necesita su fecha');
  }
}

// ── Núcleo ────────────────────────────────────────────────────────────────────

/**
 * Cambia el horario de un alumno con su mismo profesor. Con `idempotencyKey`, una
 * repetición de un cambio que ya terminó bien devuelve lo guardado sin repetir
 * nada; una que sigue en curso responde EN_CURSO. LANZA CambioHorarioError.
 */
export async function cambiarHorarioCore(
  db: Db, params: CambioHorarioParams, deps: CambioHorarioDeps,
): Promise<CambioHorarioResultado> {
  validarDatos(params);

  // Elegibilidad: también resuelve la assignment, que la auditoría necesita.
  let carga: Awaited<ReturnType<typeof cargarElegibilidadWith>>;
  try {
    carga = await cargarElegibilidadWith(db, params.studentId);
  } catch (err) {
    throw new CambioHorarioError({ codigo: 'ERROR_LECTURA', paso: 'elegibilidad', mensaje: errMsg(err), cause: err });
  }
  if (!carga) throw new CambioHorarioError({ codigo: 'ALUMNO_NO_ENCONTRADO', paso: 'elegibilidad', mensaje: 'el alumno no existe' });
  if (!carga.resultado.elegible) {
    throw new CambioHorarioError({
      codigo: 'NO_ELEGIBLE', paso: 'elegibilidad', detalleNoElegible: carga.resultado.detalle,
      mensaje: `el alumno no puede cambiar su horario por su cuenta (${carga.resultado.detalle})`,
    });
  }
  const asg = carga.resultado.asignacion;

  const apertura = await abrirRegistroCambio(db, {
    idempotencyKey: params.idempotencyKey, assignmentId: asg.id, teacherId: asg.teacher_id, modo: params.modo,
    sesionAntes: params.sesionOrigen,
    sesionDespues: { dia: params.destino.dia, hora: params.destino.hora, duracion: params.destino.duracion },
    fechaOriginal: params.modo === 'puntual' ? params.fechaOrigen ?? null : null,
    fechaNueva: params.destino.fecha ?? null,
    origen: params.origen, actor: params.actor,
  });
  if (apertura.tipo === 'repetido') return apertura.resultado;

  try {
    const r = await ejecutarCambio(db, params, deps, carga.alumno, asg);
    await cerrarRegistroCambio(db, apertura.id, { estado: 'ok', resultado: r });
    return r;
  } catch (err) {
    const e = err instanceof CambioHorarioError ? err : null;
    await cerrarRegistroCambio(db, apertura.id, {
      estado: e?.compensada === true ? 'compensada' : 'error',
      error: e ? `${e.codigo}${e.compensada === false ? ' (A MEDIAS)' : ''}: ${e.mensaje}${e.completado.length ? ` | ${e.completado.join('; ')}` : ''}` : errMsg(err),
    });
    throw err;
  }
}

type Alumno = NonNullable<Awaited<ReturnType<typeof cargarElegibilidadWith>>>['alumno'];
type Asignacion = Extract<NonNullable<Awaited<ReturnType<typeof cargarElegibilidadWith>>>['resultado'], { elegible: true }>['asignacion'];

async function ejecutarCambio(
  db: Db, params: CambioHorarioParams, deps: CambioHorarioDeps, alumnoRow: Alumno, asg: Asignacion,
): Promise<CambioHorarioResultado> {
  const ahora = (deps.ahora ?? Date.now)();
  const alumno = asg.student_name;
  const falla = (codigo: CodigoCambioHorario, mensaje: string, detalles: string[] = []): never => {
    throw new CambioHorarioError({ codigo, paso: 'validación', mensaje, detalles });
  };

  // ── 1) VALIDAR, sin escribir nada ──────────────────────────────────────────
  let abiertas;
  try {
    abiertas = await openRecoveriesOfStudentWith(db, { assignmentId: asg.id, studentId: asg.student_id });
  } catch (err) {
    throw new CambioHorarioError({ codigo: 'ERROR_LECTURA', paso: 'validación', mensaje: errMsg(err), cause: err });
  }
  if (abiertas.length) {
    falla('RECUPERACION_PENDIENTE', `tiene ${abiertas.length} recuperación(es) abierta(s)`,
      abiertas.map(r => `${r.originalDate} ${r.originalHour}: ${r.status}`));
  }

  const { data: t, error: tErr } = await db.from('teachers')
    .select('id, name, calendar_start_hour, calendar_end_hour').eq('id', asg.teacher_id).maybeSingle();
  if (tErr || !t) falla('CALENDARIO_ILEGIBLE', tErr?.message ?? `el profesor ${asg.teacher_id} no existe`);
  const profe = t as { id: string; name: string; calendar_start_hour: number | null; calendar_end_hour: number | null };

  let estado;
  let grid: Grid;
  try {
    estado = await estadoCalendarioWith(db, profe.id, ahora);
    grid = await readTeacherGridWith(db, profe.id);
  } catch (err) {
    throw new CambioHorarioError({ codigo: 'CALENDARIO_ILEGIBLE', paso: 'validación', mensaje: errMsg(err), cause: err });
  }
  if (!estado.actualizado) falla('CALENDARIO_SIN_ACTUALIZAR', `el calendario de ${profe.name} no se revisa desde ${estado.updatedAt?.slice(0, 10) ?? 'nunca'}`);

  const o = params.sesionOrigen;
  const sesion = sesionesDelAlumno(grid, alumno).find(s => s.dia === o.dia && s.hora === o.hora && s.duracion === o.duracion);
  if (!sesion) falla('SESION_NO_ENCONTRADA', `${alumno} no tiene una sesión ${o.dia} ${o.hora} de ${o.duracion} h en el calendario de ${profe.name}`);
  const s = sesion!;

  // Origen: la misma función que usa GET estado (lib/cambioHorario/origen.ts).
  const origen = evaluarOrigen(grid, s, params.modo, ahora, params.fechaOrigen);
  if (!origen.ok) falla(origen.codigo, origen.mensaje, origen.detalles);

  // Destino: exactamente las mismas reglas que el listado de huecos.
  const reservas = await liveReservationsWith(db, profe.id, ahora);
  const ev = evaluarBloque(grid, { dia: params.destino.dia, hora: horaNum(params.destino.hora), fecha: params.destino.fecha }, {
    modo: params.modo, duracionHoras: s.duracion,
    horaInicio: profe.calendar_start_hour, horaFin: profe.calendar_end_hour,
    reservas, ahora,
    sesionPropia: { alumno, claves: s.claves, fecha: params.modo === 'puntual' ? params.fechaOrigen : undefined },
  });
  if (!ev.ok) falla(ev.motivo, `el hueco ${params.destino.dia} ${params.destino.hora} no se puede usar${ev.detalle ? `: ${ev.detalle}` : ''}`, ev.detalle ? [ev.detalle] : []);
  const bloque = (ev as Extract<typeof ev, { ok: true }>).bloque;

  const actor: CalendarActor = { role: params.origen, name: params.actor || params.origen, origin: 'sistema' };
  const log = (msg: string) => console.log(`[cambio-horario ${alumno}] ${msg}`);
  log(`validaciones OK (${params.modo})`);

  const avisarAMedias = (paso: string, pendiente: string) => notifyAdminWith(db, {
    type: 'schedule_change_compensation_failed',
    title: 'Cambio de horario a medias',
    body: `El cambio de horario de ${alumno} con ${profe.name} (${params.modo}) falló en "${paso}" y no se pudo deshacer todo: ${pendiente}.`,
  }).catch(e => console.error('[cambio-horario] Tampoco se pudo avisar al admin:', e));

  /** Aplica el patch entero o nada; si choca, lanza (antes de lanzar ejecuta `deshacerPrevio`). */
  const aplicar = async (nuevo: Grid, paso: string, deshacerPrevio?: () => Promise<string | null>): Promise<AppliedPatch> => {
    let codigo: CodigoCambioHorario = 'ERROR_ESCRITURA';
    let mensaje = '';
    let restos: string[] = [];
    try {
      const r = await applyCalendarPatchAllOrNothing(db, profe.id, diffGrids(grid, nuevo));
      if (r.ok) return r.patch;
      codigo = 'HUECO_YA_OCUPADO';
      mensaje = `otra persona cambió ${r.conflicts.join(', ')} mientras tanto`;
      restos = r.leftover.length ? [`casillas sin deshacer: ${r.leftover.join(', ')}`] : [];
    } catch (err) {
      mensaje = errMsg(err);
    }
    const previo = deshacerPrevio ? await deshacerPrevio().catch(e => errMsg(e)) : null;
    if (previo) restos.push(previo);
    if (restos.length) await avisarAMedias(paso, restos.join('; '));
    throw new CambioHorarioError({
      codigo, paso, mensaje, completado: restos,
      // null: no había nada escrito antes · true: lo previo se deshizo · false: quedó algo.
      compensada: restos.length ? false : (deshacerPrevio ? true : null),
    });
  };

  // ── 2) ESCRIBIR ───────────────────────────────────────────────────────────
  let patch: AppliedPatch;
  if (params.modo === 'fijo') {
    const nuevo: Grid = { ...grid };
    for (const k of s.claves) if (!bloque.claves.includes(k)) nuevo[k] = withBaseState(grid[k], 'libre');
    for (const k of bloque.claves) if (!s.claves.includes(k)) nuevo[k] = withBaseState(grid[k], 'ocupado', alumno);
    patch = await aplicar(nuevo, `cambiar el horario fijo en el calendario de ${profe.name}`);
  } else {
    let recordId: string;
    try {
      const rec = await addRescheduleRecordWith(db, {
        teacherId: profe.id, teacherName: profe.name, studentName: alumno,
        originalDate: params.fechaOrigen!, originalTime: s.hora,
        newDate: bloque.fecha, newTime: bloque.horaInicio,
        classType: 'reprogramada',
        comment: `Reprogramada para ${bloque.fecha} ${bloque.horaInicio} — Motivo: el alumno la movió desde la plataforma (autoservicio)`,
        lostHours: s.duracion,
      });
      recordId = rec.id;
    } catch (err) {
      throw new CambioHorarioError({ codigo: 'ERROR_ESCRITURA', paso: 'guardar la constancia de la clase movida', mensaje: errMsg(err), cause: err });
    }
    const marcas = marcasDeReprogramacion(grid, {
      studentName: alumno, originalDate: params.fechaOrigen!, originalHour: s.hora, durationHours: s.duracion,
      newDate: bloque.fecha, newHour: bloque.horaInicio,
    });
    patch = await aplicar(marcas, `marcar la clase movida en el calendario de ${profe.name}`, async () => {
      try { await deleteClassRecordsWith(db, [recordId]); return null; } catch (e) { return `la constancia ${recordId} no se pudo borrar: ${errMsg(e)}`; }
    });
  }
  log('calendario actualizado');

  // ── 3) EFECTOS: cada uno por su cuenta ─────────────────────────────────────
  const efectosFallidos: string[] = [];
  const efecto = async (paso: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      efectosFallidos.push(paso);
      console.error(`[cambio-horario ${alumno}] falló "${paso}":`, err);
      await notifyAdminWith(db, {
        type: 'schedule_change_side_effect_failed',
        title: 'Cambio de horario: falló un paso secundario',
        body: `${alumno} ya cambió su horario con ${profe.name} (${params.modo}), pero falló "${paso}": ${errMsg(err)}`,
      }).catch(e => console.error('[cambio-horario] Tampoco se pudo avisar al admin:', e));
    }
  };

  if (params.modo === 'fijo') {
    // Historial (solo con el patch completo) y fichas: syncSlotsFromGrid deriva assignments.slots.
    await efecto('historial del calendario', () => logCalendarChangesWith(
      db, profe.id, studentEvents(patch.result.before, patch.result.after, patch.result.applied), actor, { assignmentId: asg.id }));
    await efecto('horario de la ficha (assignments.slots)', () => reconcileAssignmentStatusWith(db, profe.id, patch.result.before, patch.result.after, actor));
  }

  const studentEmail = normEmail(alumnoRow.email) || null;
  const asgEmail = normEmail(asg.student_email) || null;
  const datos: DatosAvisoCambio = {
    alumno, profesor: profe.name, modo: params.modo,
    antes: { dia: s.dia, hora: s.hora, duracion: s.duracion },
    despues: { dia: bloque.dia, hora: bloque.horaInicio, duracion: s.duracion },
    fechaOriginal: params.modo === 'puntual' ? params.fechaOrigen! : null,
    fechaNueva: bloque.fecha,
    teacherId: profe.id, studentId: alumnoRow.id,
    studentEmail, ccEmail: asgEmail && asgEmail !== studentEmail ? asgEmail : null,
  };
  const aviso = avisoProfesor(datos);
  await efecto(`aviso a ${profe.name}`, () => notifyStudentScheduleChangedWith(db, profe.id, aviso.title, aviso.body));
  await efecto(`correo a ${profe.name}`, async () => { if (!(await deps.enviarEmailProfesor(datos))) throw new Error('el envío no se confirmó'); });
  await efecto('correo al alumno', async () => { if (!(await deps.enviarEmailAlumno(datos))) throw new Error('el envío no se confirmó'); });

  log(efectosFallidos.length ? `hecho, con ${efectosFallidos.length} efecto(s) fallido(s)` : 'hecho');
  return {
    modo: params.modo,
    assignmentId: asg.id,
    alumno,
    profesor: { id: profe.id, name: profe.name },
    sesionAntes: { dia: s.dia, hora: s.hora, duracion: s.duracion },
    sesionDespues: { dia: bloque.dia, hora: bloque.horaInicio, duracion: s.duracion },
    fechaOriginal: datos.fechaOriginal,
    fechaNueva: bloque.fecha,
    avisos: [],
    efectosFallidos,
  };
}
