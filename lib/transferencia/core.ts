// NÚCLEO ÚNICO de la transferencia de alumno (cambio de profesor).
//
// Toda la lógica del cambio de profesor vive aquí: la usan el modal del panel
// (admin, setter, Alumnos), el script de la terminal y, más adelante, el servidor
// para las peticiones del LMS. Quien llama solo elige el cliente de Supabase y
// cómo se mandan los dos correos (deps).
//
// NO importa lib/supabase.ts ni lib/db.ts: el cliente llega por parámetro (anon
// en el navegador, service key en el servidor).
//
// ── ORDEN ─────────────────────────────────────────────────────────────────────
//   1. Validar TODO leyendo de la base, sin escribir nada.
//   2. Ocupar las casillas del profesor NUEVO          (patch todo o nada)
//   3. Reapuntar la asignación                        ← confirma el cambio
//   4. Liberar las casillas del profesor ANTERIOR     (patch todo o nada)
//   5. Efectos (historial, fichas, scoring, avisos, correos): cada uno por su
//      cuenta; si uno falla se avisa al admin y se sigue con el siguiente.
//
// ── apply_calendar_patch NO es todo o nada ────────────────────────────────────
// Aplica las casillas que siguen valiendo lo esperado y devuelve las demás como
// conflicto, guardando igualmente las aplicadas. Aquí cualquier conflicto es un
// fallo completo: se deshace en el acto lo aplicado con un patch inverso
// (expected = lo que acabamos de poner, next = lo que había según `before`) y se
// lanza HUECO_YA_OCUPADO. Ver aplicarParcheTodoONada.
//
// ── calendar_changes ──────────────────────────────────────────────────────────
// La función no escribe historial ni hay triggers que lo hagan. Las filas se
// escriben al final, cuando los dos patches se aplicaron completos (un cambio
// deshecho no deja rastro, porque el calendario quedó como estaba). La tabla es
// de SOLO AÑADIR: si el insert falla se avisa al admin y no se revierte nada.
//
// ── COMPENSACIÓN Y ESTADOS INTERMEDIOS ───────────────────────────────────────
// Si falla el paso 3 se deshace el paso 2. Si falla el paso 4 se deshacen el 3 y
// el 2 (devolver la asignación sin devolver las casillas dejaría al alumno
// asignado a un profesor en cuyo calendario no está: una asignación huérfana).
// La compensación también es un patch condicionado: si entre medias alguien
// tocó esas casillas, NO se pisan. Estados que pueden quedar si la compensación
// falla, y cómo verlos:
//   a) Casillas de más en el profesor nuevo, asignación con el viejo. El alumno
//      aparece en dos calendarios; "Auditoría de vínculos" / sincronización
//      calendario ↔ asignaciones lo lista como alumno en un grid sin asignación.
//   b) Asignación con el profesor nuevo, casillas todavía en el viejo. El viejo
//      ve al alumno en su calendario sin asignación (mismo listado) y el nuevo
//      lo tiene "fuera de calendario" (pestaña admin Fuera de calendario).
// En los dos casos el admin recibe un aviso 'transfer_compensation_failed' con
// lo que quedó hecho, y el error lanzado lleva compensada=false.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AssignedSlot, Grid } from '@/types';
import { baseStudentOf, cellIsStudentLoose, esHuecoLibreParaAlumno, isAssignableCell, withBaseState } from '@/lib/cells';
import { diffGrids, studentEvents, type GridChanges } from '@/lib/gridPatch';
import {
  readTeacherGridWith, logCalendarChangesWith, reconcileAssignmentStatusWith, sortSlots,
  applyCalendarPatchAllOrNothing, undoPatch,
  type CalendarActor, type AppliedPatch, type StrictPatchOutcome,
} from '@/lib/calendarStore';
import { addScoringEventWith, recalculateTeacherScoreWith } from '@/lib/scoringStore';
import { liveReservationsWith, openRecoveriesOfStudentWith } from '@/lib/classRecoveryQueries';
import { notifyAdminWith, notifyNewAssignmentWith, notifyStudentTransferredWith } from '@/lib/notificationStore';
import { esPerfilDePrueba } from '@/lib/perfilDePrueba';
import { EVENT_POINTS } from '@/lib/scoringConstants';
import { getSpainParts } from '@/lib/spainTime';
import { TransferenciaError, type CodigoTransferencia } from '@/lib/transferencia/errors';
import { abrirRegistro, cerrarRegistro, type ContextoRegistro } from '@/lib/transferencia/auditoria';

export { TransferenciaError } from '@/lib/transferencia/errors';
export type { CodigoTransferencia } from '@/lib/transferencia/errors';

type Db = SupabaseClient;

// ── Tipos públicos ────────────────────────────────────────────────────────────

/** Por qué se cambia. 'autoservicio' = lo pidió el alumno desde el LMS: no toca el scoring. */
export type MotivoTransferencia = 'alumno' | 'profesor' | 'reorg' | 'autoservicio';

/** Desde dónde se pide. Con 'lms' se aplican los criterios estrictos. */
export type OrigenTransferencia = 'admin' | 'setter' | 'script' | 'lms';

export interface TransferenciaParams {
  assignmentId: string;
  toTeacherId: string;
  /** Horarios con el profesor nuevo, en hora de España ('Martes', '15:00'). */
  slots: AssignedSlot[];
  motivo: MotivoTransferencia;
  origen: OrigenTransferencia;
  /** Quién lo pide (nombre del admin/setter, id del alumno en el LMS…). Va al historial. */
  actor: string;
  /** Clave de idempotencia (tabla transfer_requests). La misma clave nunca transfiere dos veces. */
  idempotencyKey?: string;
}

/** Datos del correo "Nuevo alumno asignado" al profesor nuevo. */
export interface DatosEmailProfeNuevo {
  teacherId: string;
  teacherName: string;
  teacherEmail: string;
  studentName: string;
  studentEmail: string;
  plan: string | null;
  level: string | null;
  slots: AssignedSlot[];
  startDate: string | null;
}

export interface TransferenciaDeps {
  /** Correo al profesor nuevo. Devuelve true si salió; false o una excepción = fallo. */
  enviarEmailProfeNuevo(datos: DatosEmailProfeNuevo): Promise<boolean>;
  /** Bienvenida al alumno con su profesor nuevo. Que la omita (fuera de ventana…) no es fallo; lanzar sí. */
  enviarBienvenidaAlumno(assignmentId: string): Promise<void>;
  /** Reloj inyectable para los tests. Por defecto Date.now. */
  ahora?: () => number;
}

export interface TransferenciaResultado {
  assignmentId: string;
  alumno: string;
  de: { id: string; name: string };
  a: { id: string; name: string };
  slotsAntes: AssignedSlot[];
  slotsDespues: AssignedSlot[];
  /** Cosas que no frenan el cambio pero hay que mirar (p. ej. recuperación abierta con origen admin). */
  avisos: string[];
  /** Efectos del paso 5 que fallaron (el cambio está hecho; el admin ya recibió un aviso por cada uno). */
  efectosFallidos: string[];
}

// ── Filas que se leen ─────────────────────────────────────────────────────────

interface AssignmentRow {
  id: string;
  teacher_id: string;
  teacher_name: string;
  teacher_email: string;
  student_id: string | null;
  student_name: string;
  student_email: string | null;
  student_level: string | null;
  plan: string | null;
  start_date: string | null;
  weekly_hours: number | null;
  slots: AssignedSlot[] | null;
  status: string | null;
  [col: string]: unknown;
}

interface TeacherRow {
  id: string;
  name: string;
  email: string;
  archived_at?: string | null;
  calendar_start_hour?: number | null;
  calendar_end_hour?: number | null;
}

/** Columnas que el paso 3 reescribe: se guardan para poder devolverlas tal cual. */
const COLUMNAS_REAPUNTADAS = [
  'teacher_id', 'teacher_name', 'teacher_email', 'slots', 'weekly_hours', 'availability',
  'presentation_email_sent', 'presentation_email_sent_at',
  'presentation_reminder_4h_sent', 'presentation_reminder_12h_sent', 'presentation_reminder_24h_sent',
  'created_at', 'meet_link', 'meet_link_set_at', 'teacher_since',
] as const;

/** Prefijo de las casillas que un patch parcial no pudo devolver (ver aplicarParcheTodoONada). */
const SIN_DESHACER = 'casillas sin deshacer en';

const spainDate = (ms: number): string => getSpainParts(new Date(ms)).dateStr;
const claveDe = (s: AssignedSlot): string => `${s.day}_${s.hour}`;
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ── Patch todo o nada ─────────────────────────────────────────────────────────

type ParcheAplicado = AppliedPatch;

/**
 * Aplica un patch y exige que entre ENTERO (applyCalendarPatchAllOrNothing). Con
 * cualquier conflicto lo aplicado ya se deshizo y se lanza HUECO_YA_OCUPADO; si
 * deshacerlo también chocó, compensada=false y el detalle de lo que quedó.
 */
async function aplicarParcheTodoONada(
  db: Db, teacherId: string, changes: GridChanges, paso: string, completado: string[],
): Promise<ParcheAplicado> {
  let r: StrictPatchOutcome;
  try {
    r = await applyCalendarPatchAllOrNothing(db, teacherId, changes);
  } catch (err) {
    throw new TransferenciaError({ codigo: 'ERROR_ESCRITURA', paso, mensaje: errMsg(err), completado, compensada: completado.length ? false : null, cause: err });
  }
  if (r.ok) return r.patch;
  throw new TransferenciaError({
    codigo: 'HUECO_YA_OCUPADO', paso,
    mensaje: `otra persona cambió ${r.conflicts.join(', ')} mientras tanto`,
    detalles: r.conflicts,
    // `completado` lleva lo de los pasos anteriores (los deshace quien llama) y,
    // si este mismo patch no se pudo deshacer entero, las casillas que quedaron.
    completado: r.leftover.length ? [...completado, `${SIN_DESHACER} ${teacherId}: ${r.leftover.join(', ')}`] : completado,
    compensada: r.leftover.length ? false : null,
  });
}

const deshacerParche = undoPatch;

// ── Núcleo ────────────────────────────────────────────────────────────────────

/**
 * Transfiere un alumno de profesor. Con `idempotencyKey`, una repetición de una
 * transferencia que ya terminó bien devuelve el resultado guardado sin volver a
 * hacer nada, y una que sigue en curso responde EN_CURSO. Con o sin clave, cada
 * intento queda en transfer_requests (si la tabla existe y el cliente puede
 * escribirla; si no, se avisa en consola y se sigue sin registro).
 */
export async function transferirAlumnoCore(
  db: Db, params: TransferenciaParams, deps: TransferenciaDeps,
): Promise<TransferenciaResultado> {
  const apertura = await abrirRegistro(db, params);
  if (apertura.tipo === 'repetido') {
    console.log(`[transferencia] clave ${params.idempotencyKey} ya resuelta: se devuelve el resultado guardado.`);
    return apertura.resultado;
  }
  const ctx: ContextoRegistro = {};
  try {
    const resultado = await ejecutarTransferencia(db, params, deps, ctx);
    await cerrarRegistro(db, apertura.id, ctx, { estado: 'ok', resultado });
    return resultado;
  } catch (err) {
    const e = err instanceof TransferenciaError ? err : null;
    await cerrarRegistro(db, apertura.id, ctx, {
      estado: e?.compensada === true ? 'compensada' : 'error',
      error: e
        ? `${e.codigo}${e.compensada === false ? ' (A MEDIAS)' : ''}: ${e.message}${e.completado.length ? ` | ${e.completado.join('; ')}` : ''}`
        : errMsg(err),
    });
    throw err;
  }
}

async function ejecutarTransferencia(
  db: Db, params: TransferenciaParams, deps: TransferenciaDeps, ctx: ContextoRegistro,
): Promise<TransferenciaResultado> {
  const ahora = deps.ahora ?? Date.now;
  const avisos: string[] = [];
  const falla = (codigo: CodigoTransferencia, mensaje: string, detalles: string[] = []): never => {
    throw new TransferenciaError({ codigo, paso: 'validación', mensaje, detalles });
  };

  // ── 1) VALIDAR, sin escribir nada ──────────────────────────────────────────
  const slotsNuevos = sortSlots((params.slots ?? []).map(s => ({ day: String(s?.day ?? '').trim(), hour: String(s?.hour ?? '').trim() })));
  if (slotsNuevos.length === 0) falla('DATOS_INVALIDOS', 'no se indicó ningún horario para el profesor nuevo');
  const claves = slotsNuevos.map(claveDe);
  if (new Set(claves).size !== claves.length) falla('DATOS_INVALIDOS', 'hay horarios repetidos', claves);

  const { data: asgData, error: asgErr } = await db.from('assignments').select('*').eq('id', params.assignmentId).maybeSingle();
  if (asgErr) falla('ERROR_ESCRITURA', `no se pudo leer la asignación: ${asgErr.message}`);
  if (!asgData) falla('ASIGNACION_NO_EXISTE', `la asignación ${params.assignmentId} no existe`);
  const asg = asgData as AssignmentRow;
  ctx.fromTeacherId = asg.teacher_id;
  ctx.slotsAntes = sortSlots(asg.slots ?? []);
  if ((asg.status ?? 'active') !== 'active') falla('ASIGNACION_INACTIVA', `la asignación de ${asg.student_name} no está activa`);
  if (asg.teacher_id === params.toTeacherId) falla('MISMO_PROFESOR', 'el profesor de origen y el de destino son el mismo');

  const alumno = asg.student_name;
  const { data: tData, error: tErr } = await db.from('teachers').select('*').in('id', [asg.teacher_id, params.toTeacherId]);
  if (tErr) falla('ERROR_ESCRITURA', `no se pudieron leer los profesores: ${tErr.message}`);
  const teachers = (tData ?? []) as TeacherRow[];
  const to = teachers.find(t => t.id === params.toTeacherId);
  if (!to) falla('PROFESOR_NO_EXISTE', `el profesor ${params.toTeacherId} no existe`);
  const destino = to as TeacherRow;
  const from: TeacherRow = teachers.find(t => t.id === asg.teacher_id)
    ?? { id: asg.teacher_id, name: asg.teacher_name, email: asg.teacher_email };

  const estricto = params.origen === 'lms';
  // Con 'lms' el alumno no cambia de plan: tantos horarios como horas tiene.
  // Admin, setter y script eligen de 1 a 5 horas en el modal y weekly_hours
  // pasa a ser la cantidad de horarios nuevos.
  if (estricto) {
    const horasPlan = asg.weekly_hours ?? (asg.slots ?? []).length;
    if (slotsNuevos.length !== horasPlan) {
      falla('HORAS_NO_COINCIDEN', `se indicaron ${slotsNuevos.length} horario(s) y el plan de ${alumno} tiene ${horasPlan} hora(s) por semana`);
    }
  }

  // Lectura estricta: con un calendario ilegible NO se transfiere.
  let gridNuevo: Grid;
  let gridViejo: Grid;
  try {
    [gridNuevo, gridViejo] = await Promise.all([readTeacherGridWith(db, destino.id), readTeacherGridWith(db, from.id)]);
  } catch (err) {
    throw new TransferenciaError({ codigo: 'CALENDARIO_ILEGIBLE', paso: 'validación', mensaje: errMsg(err), cause: err });
  }

  // Casillas destino. Con 'lms', el criterio estricto y único (esHuecoLibreParaAlumno);
  // con el resto, el de siempre (isAssignableCell), ahora comprobado aquí y no solo en la pantalla.
  const noLibres: string[] = [];
  if (estricto) {
    const reservas = await liveReservationsWith(db, destino.id, ahora());
    const ctx = {
      horaInicio: destino.calendar_start_hour ?? null,
      horaFin: destino.calendar_end_hour ?? null,
      alcance: { tipo: 'desde' as const, fecha: spainDate(ahora()) },
      reservas,
    };
    for (const k of claves) {
      const r = esHuecoLibreParaAlumno(gridNuevo, k, ctx);
      if (!r.libre) noLibres.push(`${k} (${r.motivo})`);
    }
  } else {
    for (const k of claves) {
      if (!isAssignableCell(gridNuevo[k])) {
        const quien = baseStudentOf(gridNuevo[k] ?? { state: 'no_work' });
        noLibres.push(`${k} (${quien ? `ocupado por ${quien}` : (gridNuevo[k]?.state ?? 'sin pintar')})`);
      }
    }
  }
  if (noLibres.length) falla('SLOT_NO_DISPONIBLE', `${destino.name} no tiene libre: ${noLibres.join(', ')}`, noLibres);

  // Archivados y el perfil de prueba (SOLO t1, "Sebastian (test)": ver
  // lib/perfilDePrueba.ts; t2 es un profesor real): fuera para 'lms' y 'setter'.
  // El admin y los scripts pueden usarlos a propósito (probar con t1, devolver un
  // alumno a un profesor que ya se fue…). Va después de las casillas: las dos
  // comprobaciones son antes de escribir nada, solo cambia qué error sale primero.
  // No hay control de "profesor bloqueado": teachers no tiene is_blocked (ver
  // TODO(scoring) en lib/scoringStore.ts) y la regla de retención bloquearía hoy
  // a 10 de 27 profesores.
  if (params.origen === 'lms' || params.origen === 'setter') {
    if (destino.archived_at) falla('PROFESOR_ARCHIVADO', `${destino.name} ya no está en la academia`);
    if (esPerfilDePrueba(destino.id)) falla('PROFESOR_DE_PRUEBA', `${destino.name} es el perfil de prueba`);
  }


  // Recuperaciones abiertas del alumno: con 'lms' frenan; con el resto, aviso.
  let abiertas;
  try {
    abiertas = await openRecoveriesOfStudentWith(db, { assignmentId: asg.id, studentId: asg.student_id });
  } catch (err) {
    throw new TransferenciaError({ codigo: 'ERROR_ESCRITURA', paso: 'validación', mensaje: errMsg(err), cause: err });
  }
  if (abiertas.length) {
    const texto = `${alumno} tiene ${abiertas.length} recuperación(es) abierta(s) (${abiertas.map(r => `${r.originalDate} ${r.originalHour}: ${r.status}`).join('; ')})`;
    if (estricto) falla('RECUPERACION_PENDIENTE', texto);
    avisos.push(texto);
    console.warn(`[transferencia ${alumno}] ${texto}`);
  }

  const slotsAntes = sortSlots(asg.slots ?? []);
  const actor: CalendarActor = { role: params.origen, name: params.actor || params.origen, origin: 'sistema' };
  const log = (msg: string) => console.log(`[transferencia ${alumno}] ${msg}`);
  log('validaciones OK');

  const completado: string[] = [];
  const avisarCompensacionFallida = (paso: string, pendientes: string[]) => notifyAdminWith(db, {
    type: 'transfer_compensation_failed',
    title: 'Cambio de profesor a medias',
    body: `El cambio de ${alumno} (${from.name} → ${destino.name}, origen ${params.origen}) falló en "${paso}" y no se pudo deshacer todo. `
        + `Hecho: ${completado.join('; ') || 'nada'}. Sin deshacer: ${pendientes.join('; ')}.`,
  }).catch(e => console.error('[transferencia] Tampoco se pudo avisar al admin:', e));

  // ── 2) Ocupar las casillas del profesor NUEVO ──────────────────────────────
  const nuevoDespues: Grid = { ...gridNuevo };
  for (const k of claves) nuevoDespues[k] = withBaseState(gridNuevo[k], 'ocupado', alumno);
  let parcheNuevo: ParcheAplicado;
  try {
    parcheNuevo = await aplicarParcheTodoONada(
      db, destino.id, diffGrids(gridNuevo, nuevoDespues), `ocupar el calendario de ${destino.name}`, completado,
    );
  } catch (err) {
    if (err instanceof TransferenciaError && err.compensada === false) {
      await avisarCompensacionFallida(`ocupar el calendario de ${destino.name}`, err.completado);
    }
    throw err;
  }
  completado.push(`se ocuparon ${claves.join(', ')} en el calendario de ${destino.name}`);
  log(`calendario de ${destino.name} ocupado`);

  // Deshace los pasos ya hechos, del último al primero, y lanza.
  const compensarYLanzar = async (
    codigo: CodigoTransferencia, paso: string, mensaje: string,
    deshacer: Array<{ que: string; fn: () => Promise<string | null> }>, cause?: unknown, yaPendientes: string[] = [],
  ): Promise<never> => {
    const pendientes: string[] = [...yaPendientes];
    for (const d of deshacer) {
      const problema = await d.fn().catch(e => errMsg(e));
      if (problema) pendientes.push(`${d.que}: ${problema}`);
    }
    if (pendientes.length) await avisarCompensacionFallida(paso, pendientes);
    throw new TransferenciaError({
      codigo, paso, mensaje, cause,
      completado: pendientes.length ? [...completado, ...pendientes.map(p => `SIN DESHACER → ${p}`)] : [],
      compensada: pendientes.length === 0,
    });
  };

  const deshacerNuevo = {
    que: `devolver el calendario de ${destino.name}`,
    fn: async () => { const q = await deshacerParche(db, parcheNuevo); return q.length ? `casillas cambiadas por otra persona: ${q.join(', ')}` : null; },
  };

  // ── 3) Reapuntar la asignación — ESTE es el paso que confirma el cambio ────
  //    Se reinicia el plazo del enlace de clase: created_at = ahora (el contador
  //    de 24 h se ancla en created_at, ver lib/meetLinkStatus), el enlace del
  //    anterior se borra y los recordatorios vuelven a cero. Así el NUEVO
  //    profesor tiene sus 24 h completas, sus recordatorios, y la penalización
  //    'enlace_tardio' se evalúa para él al definir su enlace por primera vez.
  //    Condicionado a que siga con el profesor de origen y activa: si otro la
  //    movió entre medias, 0 filas → ASIGNACION_CAMBIADA y se deshace el paso 2.
  const anteriores: Record<string, unknown> = {};
  for (const c of COLUMNAS_REAPUNTADAS) if (c in asg) anteriores[c] = asg[c];
  const { data: upd, error: updErr } = await db.from('assignments').update({
    teacher_id:    destino.id,
    teacher_name:  destino.name,
    teacher_email: destino.email,
    slots:         slotsNuevos,
    weekly_hours:  slotsNuevos.length,
    availability:  slotsNuevos.map(s => `${s.day} ${s.hour}`).join(', '),
    presentation_email_sent:    false,
    presentation_email_sent_at: null,
    // Recordatorios del enlace (cron check-presentation-emails): el profesor
    // nuevo tiene los suyos.
    presentation_reminder_4h_sent:  false,
    presentation_reminder_12h_sent: false,
    presentation_reminder_24h_sent: false,
    created_at:       new Date(ahora()).toISOString(),
    // El enlace de la clase es la sala del profesor ANTERIOR: se borra para que
    // el nuevo defina la suya (y el alumno no entre a la sala equivocada).
    meet_link:        null,
    meet_link_set_at: null,
    // Reloj del bono de retención: seis meses CON EL PROFESOR ACTUAL. start_date
    // no se toca (es la fecha de alta del alumno en la academia).
    teacher_since:    spainDate(ahora()),
  }).eq('id', asg.id).eq('teacher_id', from.id)
    // status null (filas anteriores a la columna) cuenta como activa.
    .or(asg.status == null ? 'status.is.null' : `status.eq.${asg.status}`)
    .select('id');
  if (updErr || !upd?.length) {
    await compensarYLanzar(
      updErr ? 'ERROR_ESCRITURA' : 'ASIGNACION_CAMBIADA', 'reapuntar la asignación al profesor nuevo',
      updErr ? updErr.message : 'la asignación cambió de profesor o de estado mientras tanto',
      [deshacerNuevo], updErr ?? undefined,
    );
  }
  completado.push(`${alumno} quedó asignado a ${destino.name}`);
  log(`asignación reapuntada a ${destino.name}`);

  const deshacerAsignacion = {
    que: 'devolver la asignación al profesor anterior',
    fn: async () => {
      const { data, error } = await db.from('assignments').update(anteriores).eq('id', asg.id).eq('teacher_id', destino.id).select('id');
      if (error) return error.message;
      return data?.length ? null : 'la asignación ya no estaba con el profesor nuevo';
    },
  };

  // ── 4) Liberar las casillas del profesor ANTERIOR ──────────────────────────
  //    Se mira el alumno RECURRENTE: una casilla con una recuperación encima
  //    sigue siendo el horario fijo del alumno que se va, y hay que liberarla.
  //    SOLO se libera una casilla cuyo alumno recurrente se llama EXACTAMENTE
  //    como el de la asignación (sin espacios al principio y al final). Nada de
  //    nombre de pila: "Ana López" no puede liberar las casillas de "Ana María".
  //    Las que el criterio tolerante de antes habría liberado (las de su ficha y
  //    las de nombre parecido) se dejan como están y se avisa al admin al final.
  const clavesViejas = new Set(slotsAntes.map(claveDe));
  const nombreExacto = alumno.trim();
  const viejoDespues: Grid = { ...gridViejo };
  const pendientesViejo: string[] = [];
  for (const [k, cell] of Object.entries(gridViejo)) {
    const recurrente = baseStudentOf(cell);
    if (!recurrente) continue;
    if (recurrente.trim() === nombreExacto) viejoDespues[k] = withBaseState(cell, 'libre');
    else if (clavesViejas.has(k) || cellIsStudentLoose(recurrente, alumno)) pendientesViejo.push(`${k} (${recurrente})`);
  }
  const cambiosViejo = diffGrids(gridViejo, viejoDespues);
  let parcheViejo: ParcheAplicado | null = null;
  if (Object.keys(cambiosViejo).length > 0) {
    try {
      parcheViejo = await aplicarParcheTodoONada(db, from.id, cambiosViejo, `liberar el calendario de ${from.name}`, completado);
    } catch (err) {
      const e = err instanceof TransferenciaError ? err : null;
      // Casillas del calendario viejo que su propio patch parcial no pudo devolver.
      const restosViejo = e?.compensada === false ? e.completado.filter(c => c.startsWith(SIN_DESHACER)) : [];
      await compensarYLanzar(
        e?.codigo ?? 'ERROR_ESCRITURA', `liberar el calendario de ${from.name}`, errMsg(err),
        [deshacerAsignacion, deshacerNuevo], err, restosViejo,
      );
    }
    completado.push(`se liberaron ${Object.keys(cambiosViejo).length} casilla(s) de ${from.name}`);
    log(`calendario de ${from.name} liberado`);
  }

  // ── 5) EFECTOS: cada uno por su cuenta ─────────────────────────────────────
  //    El cambio ya está hecho y es coherente. Un fallo aquí no lo deshace: se
  //    registra, se avisa al admin y se sigue con el siguiente.
  const efectosFallidos: string[] = [];
  const efecto = async (paso: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      efectosFallidos.push(paso);
      console.error(`[transferencia ${alumno}] falló "${paso}":`, err);
      await notifyAdminWith(db, {
        type: 'transfer_side_effect_failed',
        title: 'Cambio de profesor: falló un paso secundario',
        body: `${alumno} ya pasó de ${from.name} a ${destino.name} (origen: ${params.origen}), pero falló "${paso}": ${errMsg(err)}`,
      }).catch(e => console.error('[transferencia] Tampoco se pudo avisar al admin:', e));
    }
  };

  // Historial: solo ahora, con los dos patches completos.
  await efecto(`historial del calendario de ${destino.name}`, () => logCalendarChangesWith(
    db, destino.id, studentEvents(parcheNuevo.result.before, parcheNuevo.result.after, parcheNuevo.result.applied), actor, { assignmentId: asg.id }));
  if (parcheViejo) {
    const pv = parcheViejo;
    await efecto(`historial del calendario de ${from.name}`, () => logCalendarChangesWith(
      db, from.id, studentEvents(pv.result.before, pv.result.after, pv.result.applied), actor, { assignmentId: asg.id }));
  }

  // Fichas al día con los calendarios (horarios y alta/baja), como tras cualquier guardado.
  await efecto(`fichas de ${destino.name}`, () => reconcileAssignmentStatusWith(db, destino.id, parcheNuevo.result.before, parcheNuevo.result.after, actor));
  if (parcheViejo) {
    const pv = parcheViejo;
    await efecto(`fichas de ${from.name}`, () => reconcileAssignmentStatusWith(db, from.id, pv.result.before, pv.result.after, actor));
  }

  // Casillas del profesor viejo que parecen del alumno pero no llevan su nombre exacto.
  if (pendientesViejo.length) {
    await efecto('aviso de casillas pendientes', () => notifyAdminWith(db, {
      type: 'transfer_casillas_pendientes',
      title: 'Cambio de profesor: casillas para revisar',
      body: `${alumno} pasó de ${from.name} a ${destino.name}, pero en el calendario de ${from.name} quedan casillas `
          + `que podrían ser suyas y no se liberaron porque el nombre no coincide exactamente: ${pendientesViejo.join(', ')}. Revísalas a mano.`,
    }));
  }

  // Scoring: 'autoservicio' no lo toca de ninguna forma; 'reorg' no penaliza pero
  // recalcula, como siempre.
  if (params.motivo === 'alumno' || params.motivo === 'profesor') {
    const eventType = params.motivo === 'alumno' ? 'cambio_por_alumno' : 'cambio_por_profesor';
    await efecto('evento de scoring', () => addScoringEventWith(db, {
      teacherId:   from.id,
      teacherName: from.name,
      eventType,
      points:      EVENT_POINTS[eventType],
      euros:       0,
      note:        `Cambio de profesor — ${alumno} transferido a ${destino.name}`,
      createdBy:   'sistema',
      studentRef:  alumno,
    }));
  }

  // Profesor NUEVO: aviso y correo (mismo contenido que una asignación nueva).
  await efecto(`aviso a ${destino.name}`, () => notifyNewAssignmentWith(db, destino.id, alumno, asg.student_email ?? ''));
  await efecto(`correo a ${destino.name}`, async () => {
    const ok = await deps.enviarEmailProfeNuevo({
      teacherId: destino.id, teacherName: destino.name, teacherEmail: destino.email,
      studentName: alumno, studentEmail: asg.student_email ?? '',
      plan: asg.plan ?? null, level: asg.student_level ?? null, slots: slotsNuevos, startDate: asg.start_date ?? null,
    });
    if (!ok) throw new Error('el envío no se confirmó');
  });

  // Profesor ANTERIOR.
  await efecto(`aviso a ${from.name}`, () => notifyStudentTransferredWith(db, from.id, alumno));

  // Recalcular el score de los dos (salvo autoservicio).
  if (params.motivo !== 'autoservicio') {
    await efecto('recálculo del score', () => Promise.all([recalculateTeacherScoreWith(db, from.id), recalculateTeacherScoreWith(db, destino.id)]));
  }

  // Aviso al admin de CADA cambio hecho.
  await efecto('aviso al admin', () => notifyAdminWith(db, {
    type: 'student_transferred_admin',
    title: 'Cambio de profesor',
    body: `${alumno} ha pasado de ${from.name} a ${destino.name} (origen: ${params.origen})`,
  }));

  // Bienvenida al alumno con su profesor nuevo.
  await efecto('bienvenida al alumno', () => deps.enviarBienvenidaAlumno(asg.id));

  log(efectosFallidos.length ? `hecho, con ${efectosFallidos.length} efecto(s) fallido(s)` : 'hecho');
  return {
    assignmentId: asg.id,
    alumno,
    de: { id: from.id, name: from.name },
    a: { id: destino.id, name: destino.name },
    slotsAntes,
    slotsDespues: slotsNuevos,
    avisos,
    efectosFallidos,
  };
}
