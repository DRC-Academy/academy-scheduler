// ── Uso de la plataforma por profesor, SEMANA A SEMANA ────────────────────────
//
// Las seis métricas del dashboard de la pestaña Profesores del admin. Funciones
// PURAS sobre filas ya leídas: la lectura vive en lib/teacherUsageLoad (servidor)
// y la pantalla solo pinta lo que devuelve /api/admin/teacher-usage. Así el
// navegador recibe totales, nunca filas crudas.
//
// SEMANA = lunes a domingo en hora de ESPAÑA. Las fechas de clase ya son
// españolas ('YYYY-MM-DD'); los instantes (created_at, completed_at...) se pasan
// a fecha española con getSpainParts antes de asignarlos a una semana.
//
// Cada celda es { num, den }: el porcentaje lo saca quien pinta, y den = 0 se
// lee "sin nada que medir". `null` es otra cosa: "esa semana todavía no se
// registraba" (p. ej. la generación de clases antes del 08/09/2026). Las dos se
// pintan distinto porque no significan lo mismo.
//
// Las seis:
//   prueba      alumnos a los que se les ENVIÓ el enlace esa semana → cuántos
//               completaron la prueba de nivel (hasta hoy). Cuenta alumnos, no
//               reenvíos (lib/levelTestSeguimiento).
//   validacion  pruebas COMPLETADAS esa semana → cuántas tienen ya el nivel
//               confirmado o corregido por el profesor.
//   ia          profesores activos esa semana (con algún ingreso a clase) → cuántos
//               generaron alguna clase con IA (las dos formas cuentan).
//   transcript  clases con plazo de 24 h ya juzgable → cuántas se subieron dentro
//               del plazo (lib/transcriptDeadline, la regla única).
//   ingreso     clases programadas ya terminadas → cuántas tienen el clic del
//               profesor en "Ingresar a clase" (los ingresos que crea el admin a
//               mano NO cuentan: no entró con el link).
//   riesgo      profesores que recibieron alguna alerta de riesgo esa semana →
//               cuántos la abrieron (campanita o ficha, lib/usageEvents).

import type { ClassJoinLog, ClassRecord } from '@/types';
import { getSpainParts, spainWallClockToEpoch } from '@/lib/spainTime';
import { contiguousRunLength, groupByContiguousHour, hourNum, nkName } from '@/lib/sessions';
import { isStudentLostClass } from '@/lib/classTypes';
import {
  TRANSCRIPT_DEADLINE_START_DATE, findTranscriptFor, getTranscriptStatus, reopenedDeadlineFor,
  type ClassTranscriptRef, type TranscriptExclusions,
} from '@/lib/transcriptDeadline';
import { cancellationFor, rescheduledTargetFor, addDaysIso, dayNameFromIso } from '@/lib/teacherClasses';
import { existsForStudent, type StudentPeriod } from '@/lib/studentPeriod';

// ── Tipos ─────────────────────────────────────────────────────────────────────

export const METRICAS = ['prueba', 'validacion', 'ia', 'transcript', 'ingreso', 'riesgo'] as const;
export type Metrica = typeof METRICAS[number];

/** Una medición. `null` = esa semana no se registraba todavía. */
export type Celda = { num: number; den: number } | null;

export interface SemanaUso {
  /** Lunes, 'YYYY-MM-DD'. */
  start: string;
  /** Domingo, 'YYYY-MM-DD'. */
  end: string;
  /** La semana de hoy: sus números todavía se mueven. */
  enCurso: boolean;
}

export interface FilaProfesorUso {
  id: string;
  name: string;
  /** Una celda por semana, en el mismo orden que `semanas`. */
  celdas: Record<Metrica, Celda[]>;
}

export interface InformeUso {
  hoy: string;
  semanas: SemanaUso[];
  global: Record<Metrica, Celda[]>;
  /** Generaciones de la semana por origen (el gráfico de IA las distingue). */
  iaOrigen: Array<{ transcript: number; directa: number }>;
  /** Profesores con TODAS sus clases juzgables subidas a tiempo, sobre los que tuvieron alguna. */
  transcriptProfes: Celda[];
  /** De dónde salen las clases programadas de cada semana. */
  ingresoFuente: Array<'foto' | 'proyeccion' | 'mixta'>;
  profesores: FilaProfesorUso[];
  /** Desde cuándo se puede medir cada una (fecha española). */
  desde: Record<Metrica, string | null>;
}

// ── Semanas ───────────────────────────────────────────────────────────────────

/** Lunes de la semana de una fecha 'YYYY-MM-DD'. Aritmética de fechas pura, sin zona. */
export function mondayOf(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;   // lunes = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/** Fecha española de un instante ISO. '' si no se puede leer. */
export function spainDateOf(ts: string | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? getSpainParts(d).dateStr : '';
}

/** Las `n` semanas que terminan en la de hoy, de la más vieja a la actual. */
export function buildWeeks(todayIso: string, n: number): SemanaUso[] {
  const thisMonday = mondayOf(todayIso);
  const out: SemanaUso[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const start = addDaysIso(thisMonday, -7 * i);
    out.push({ start, end: addDaysIso(start, 6), enCurso: i === 0 });
  }
  return out;
}

// ── Entradas ──────────────────────────────────────────────────────────────────

export interface ProfesorBasico {
  id: string;
  name: string;
  /** Horario RECURRENTE del calendario (dbGetTeachers → upcomingClasses). */
  upcomingClasses?: Array<{ studentName: string; day: string; time: string }>;
  /** Celdas de recuperación con fecha (dbGetTeachers → recoveryCells). */
  recoveryCells?: Array<{ studentName: string; hour: string; date: string }>;
}

/** Un alumno de la pestaña Tests de nivel, reducido a lo que se mide. */
export interface EnvioPrueba {
  studentId: string | null;
  nombre: string;
  /** ISO: cuándo recibió el enlace. */
  enviado: string;
  /** ISO: cuándo completó la prueba, o null. */
  completada: string | null;
  /** Profesor que mandó el enlace (form_tokens.teacher_id), si se sabe. */
  teacherIdEnvio: string | null;
}

export interface GeneracionIA { teacher_id: string | null; teacher_name: string | null; origin: string; created_at: string }
export interface AlertaRiesgo { target_user: string | null; created_at: string }
export interface EventoUso { event: string; teacher_id: string | null; ref_id: string | null; created_at: string }

/** Clase programada: sale de la foto diaria del calendario o de proyectarlo. */
export interface ClaseProgramada {
  teacherId: string;
  teacherName: string;
  studentName: string;
  date: string;
  startHour: number;
  durationHours: number;
  isRecovery: boolean;
}

export interface EntradaUso {
  hoy: string;
  /** Instante actual (epoch ms): decide qué clases ya terminaron y qué plazos vencieron. */
  now: number;
  semanas: SemanaUso[];
  /** Profesores que salen en la tabla (sin cuentas de prueba ni archivados). */
  profesores: ProfesorBasico[];
  /** Ids a ignorar en TODO (cuentas de prueba). */
  ignorar: ReadonlySet<string>;
  /** studentId → teacherId de su asignación actual. */
  profesorActualPorAlumno: Map<string, string>;
  /** Mismo mapa por nombre normalizado, para las filas sin id. */
  profesorActualPorNombre: Map<string, string>;

  envios: EnvioPrueba[];
  /** Alumnos con nivel confirmado por el profesor: ids y nombres normalizados. */
  validados: { ids: Set<string>; nombres: Set<string> };
  generaciones: GeneracionIA[];
  joinLogs: ClassJoinLog[];
  records: ClassRecord[];
  analyses: ClassTranscriptRef[];
  /** analysisId → ISO de la primera subida (usage_events). */
  primeraSubida: Map<string, string>;
  programadas: ClaseProgramada[];
  /** Fechas con foto del calendario (el resto de `programadas` es proyección). */
  fechasConFoto: Set<string>;
  alertas: AlertaRiesgo[];
  eventos: EventoUso[];
}

/** Desde cuándo existe el registro de la generación de clases (supabase-ai-usage.sql). */
export const IA_DESDE = '2026-09-08';

// ── Utilidades internas ───────────────────────────────────────────────────────

const vacias = (n: number): Celda[] => Array.from({ length: n }, () => ({ num: 0, den: 0 }));

function sumar(c: Celda, num: number, den: number): void {
  if (!c) return;
  c.num += num;
  c.den += den;
}

/** Índice de semana de una fecha española, o -1 si cae fuera. */
function indiceSemana(semanas: SemanaUso[], dateIso: string): number {
  if (!dateIso) return -1;
  const lunes = mondayOf(dateIso);
  return semanas.findIndex(s => s.start === lunes);
}

/** Registros de un profesor y una fecha, indexados para no recorrer 3.000 filas por clase. */
function indexarRecords(records: ClassRecord[]): Map<string, ClassRecord[]> {
  const m = new Map<string, ClassRecord[]>();
  for (const r of records) {
    const k = `${r.teacherId}|${r.classDate}`;
    const arr = m.get(k);
    if (arr) arr.push(r); else m.set(k, [r]);
  }
  return m;
}

// ── Proyección del calendario ─────────────────────────────────────────────────

/**
 * Clases programadas de cada fecha según el calendario ACTUAL: el horario
 * recurrente del día de la semana + las recuperaciones con esa fecha. Dos horas
 * seguidas del mismo alumno son UNA sesión (lib/sessions).
 *
 * Es lo que guarda cada noche la foto del calendario, y lo que se usa para las
 * fechas SIN foto (proyectar hacia atrás: aproximado si el horario cambió).
 * `periodos` descarta las clases fuera del período del alumno (antes de empezar
 * o después de la baja).
 */
export function proyectarCalendario(
  profesores: ProfesorBasico[], fechas: string[],
  periodos: Map<string, Map<string, StudentPeriod>>,
): ClaseProgramada[] {
  const out: ClaseProgramada[] = [];
  for (const t of profesores) {
    const periodosDelProfe = periodos.get(t.id);
    for (const date of fechas) {
      const dia = dayNameFromIso(date);
      const horas = new Map<string, { nombre: string; horas: Array<{ h: number; rec: boolean }> }>();
      const add = (nombre: string, h: number, rec: boolean) => {
        if (!Number.isFinite(h)) return;
        const k = nkName(nombre);
        const e = horas.get(k) ?? { nombre, horas: [] };
        if (!e.horas.some(x => x.h === h)) e.horas.push({ h, rec });
        horas.set(k, e);
      };
      for (const c of t.upcomingClasses ?? []) {
        if (c.day !== dia) continue;
        if (periodosDelProfe && !existsForStudent(periodosDelProfe, c.studentName, date)) continue;
        add(c.studentName, hourNum(c.time), false);
      }
      for (const r of t.recoveryCells ?? []) {
        if (r.date === date) add(r.studentName, hourNum(r.hour), true);
      }
      for (const { nombre, horas: hs } of horas.values()) {
        for (const run of groupByContiguousHour(hs, x => x.h, () => true)) {
          out.push({
            teacherId: t.id, teacherName: t.name, studentName: nombre, date,
            startHour: run[0].h, durationHours: run.length, isRecovery: run.some(x => x.rec),
          });
        }
      }
    }
  }
  return out;
}

// ── El informe ────────────────────────────────────────────────────────────────

export function construirInformeUso(input: EntradaUso): InformeUso {
  const { semanas, ignorar, now, hoy } = input;
  const n = semanas.length;
  const profesIds = new Set(input.profesores.map(p => p.id));

  const global: Record<Metrica, Celda[]> = {
    prueba: vacias(n), validacion: vacias(n), ia: vacias(n),
    transcript: vacias(n), ingreso: vacias(n), riesgo: vacias(n),
  };
  const porProfe = new Map<string, Record<Metrica, Celda[]>>();
  for (const p of input.profesores) {
    porProfe.set(p.id, {
      prueba: vacias(n), validacion: vacias(n), ia: vacias(n),
      transcript: vacias(n), ingreso: vacias(n), riesgo: vacias(n),
    });
  }
  const celdaProfe = (teacherId: string | null | undefined, m: Metrica, w: number): Celda =>
    (teacherId ? porProfe.get(teacherId)?.[m][w] : null) ?? null;

  // Desde cuándo se puede medir cada cosa. Las semanas enteras ANTERIORES quedan
  // en null ("no se registraba"), no en cero.
  const primerEvento = input.eventos.reduce<string | null>((min, e) => {
    const d = spainDateOf(e.created_at);
    return d && (!min || d < min) ? d : min;
  }, null);
  const desde: Record<Metrica, string | null> = {
    prueba: null, validacion: null, ia: IA_DESDE,
    transcript: TRANSCRIPT_DEADLINE_START_DATE, ingreso: null,
    // Sin ningún evento todavía (SQL sin correr o recién desplegado): no hay
    // desde, y todas las semanas quedan en "sin registrar".
    riesgo: primerEvento,
  };
  const anulaAntesDe = (m: Metrica, fecha: string | null) => {
    semanas.forEach((s, w) => {
      if (fecha === null || s.end < fecha) {
        global[m][w] = null;
        for (const c of porProfe.values()) c[m][w] = null;
      }
    });
  };
  anulaAntesDe('ia', IA_DESDE);
  anulaAntesDe('transcript', TRANSCRIPT_DEADLINE_START_DATE);
  anulaAntesDe('riesgo', primerEvento);

  const profeActual = (studentId: string | null, nombre: string): string | null =>
    (studentId ? input.profesorActualPorAlumno.get(studentId) : undefined)
    ?? input.profesorActualPorNombre.get(nkName(nombre)) ?? null;

  // ── prueba y validacion ────────────────────────────────────────────────────
  for (const e of input.envios) {
    const wEnvio = indiceSemana(semanas, spainDateOf(e.enviado));
    if (wEnvio >= 0) {
      const hecha = e.completada ? 1 : 0;
      const profe = e.teacherIdEnvio ?? profeActual(e.studentId, e.nombre);
      if (!profe || !ignorar.has(profe)) {
        sumar(global.prueba[wEnvio], hecha, 1);
        sumar(celdaProfe(profe, 'prueba', wEnvio), hecha, 1);
      }
    }
    if (e.completada) {
      const wHecha = indiceSemana(semanas, spainDateOf(e.completada));
      if (wHecha < 0) continue;
      const validada = (e.studentId && input.validados.ids.has(e.studentId))
        || input.validados.nombres.has(nkName(e.nombre)) ? 1 : 0;
      // Quien tiene que validarla es el profesor ACTUAL del alumno.
      const profe = profeActual(e.studentId, e.nombre) ?? e.teacherIdEnvio;
      if (profe && ignorar.has(profe)) continue;
      sumar(global.validacion[wHecha], validada, 1);
      sumar(celdaProfe(profe, 'validacion', wHecha), validada, 1);
    }
  }

  // ── Ingresos: clases dadas por profesor y semana (base de "ia" e "ingreso") ─
  const logsVentana = input.joinLogs.filter(l =>
    !ignorar.has(l.teacherId) && indiceSemana(semanas, l.scheduledDate) >= 0);
  const activosPorSemana: Array<Set<string>> = semanas.map(() => new Set());
  const sesionesPorProfeSemana = new Map<string, Set<string>>();
  for (const l of logsVentana) {
    const w = indiceSemana(semanas, l.scheduledDate);
    activosPorSemana[w].add(l.teacherId);
    const k = `${l.teacherId}|${w}`;
    const set = sesionesPorProfeSemana.get(k) ?? new Set<string>();
    set.add(`${nkName(l.studentName)}|${l.scheduledDate}`);
    sesionesPorProfeSemana.set(k, set);
  }

  // ── ia ─────────────────────────────────────────────────────────────────────
  const iaOrigen = semanas.map(() => ({ transcript: 0, directa: 0 }));
  const idPorNombre = new Map(input.profesores.map(p => [nkName(p.name), p.id]));
  const generaronPorSemana: Array<Set<string>> = semanas.map(() => new Set());
  for (const g of input.generaciones) {
    const w = indiceSemana(semanas, spainDateOf(g.created_at));
    if (w < 0 || global.ia[w] === null) continue;
    const tid = g.teacher_id || (g.teacher_name ? idPorNombre.get(nkName(g.teacher_name)) : undefined);
    if (!tid || ignorar.has(tid)) continue;
    generaronPorSemana[w].add(tid);
    if (g.origin === 'transcript') iaOrigen[w].transcript++; else iaOrigen[w].directa++;
    sumar(celdaProfe(tid, 'ia', w), 1, 0);
  }
  semanas.forEach((_, w) => {
    if (global.ia[w] === null) return;
    // Activo = con algún ingreso esa semana, o que generó (generar ya es trabajar).
    const activos = new Set([...activosPorSemana[w], ...generaronPorSemana[w]]);
    global.ia[w] = { num: generaronPorSemana[w].size, den: activos.size };
    // Por profesor: generaciones (num) sobre clases dadas esa semana (den).
    for (const [tid, celdas] of porProfe) {
      const c = celdas.ia[w];
      if (c) c.den = sesionesPorProfeSemana.get(`${tid}|${w}`)?.size ?? 0;
    }
  });

  // ── transcript ─────────────────────────────────────────────────────────────
  const recordsPorClave = indexarRecords(input.records);
  const transcriptProfesSemana = semanas.map(() => new Map<string, { ok: number; total: number }>());
  {
    // Una clase = profesor + alumno + fecha (una sesión de 2 h tiene dos ingresos).
    const clases = new Map<string, ClassJoinLog[]>();
    for (const l of logsVentana) {
      if (l.scheduledDate < TRANSCRIPT_DEADLINE_START_DATE || l.scheduledDate > hoy) continue;
      const k = `${l.teacherId}|${nkName(l.studentName)}|${l.scheduledDate}`;
      const arr = clases.get(k);
      if (arr) arr.push(l); else clases.set(k, [l]);
    }
    const exclusiones = new Map<string, TranscriptExclusions>();
    const ordenadas = [...clases.entries()].sort((a, b) => a[1][0].scheduledDate.localeCompare(b[1][0].scheduledDate));
    for (const [, logs] of ordenadas) {
      const first = logs[0];
      const w = indiceSemana(semanas, first.scheduledDate);
      if (w < 0 || global.transcript[w] === null) continue;

      // La falta y la cancelación sobre la hora no llevan transcript; la clase
      // que canceló el propio profesor tampoco se dio.
      const recs = (recordsPorClave.get(`${first.teacherId}|${first.scheduledDate}`) ?? [])
        .filter(r => nkName(r.studentName) === nkName(first.studentName));
      if (recs.some(r => isStudentLostClass(r.classType) || r.classType === 'cancelada_por_profesor')) continue;

      const horas = [...new Set(logs.map(l => hourNum(l.scheduledTime)).filter(Number.isFinite))].sort((a, b) => a - b);
      const start = horas[0];
      const duracion = Math.max(
        Number.isFinite(start) ? contiguousRunLength(horas, start) : 1,
        ...logs.map(l => l.durationHours ?? 1),
      );

      const exKey = `${first.teacherId}|${nkName(first.studentName)}`;
      const exclude = exclusiones.get(exKey) ?? new Set();
      exclusiones.set(exKey, exclude);
      const t = findTranscriptFor(input.analyses, {
        teacherId: first.teacherId, studentName: first.studentName, dateIso: first.scheduledDate,
        joinLogIds: logs.map(l => l.id), exclude,
      });
      // La hora de la PRIMERA subida manda sobre analyzed_at, que se reescribe al
      // reemplazar el transcript.
      const primera = t?.id ? input.primeraSubida.get(t.id) : undefined;
      const tr = t && primera && (!t.analyzed_at || primera < t.analyzed_at) ? { ...t, analyzed_at: primera } : t;

      const st = getTranscriptStatus({
        date: first.scheduledDate, startHour: Number.isFinite(start) ? start : null, durationHours: duracion,
        classType: 'normal', transcript: tr, reopenedDeadlineAt: reopenedDeadlineFor(logs), now,
      });
      let ok: number;
      if (st.status === 'vencido') ok = 0;
      else if (st.status === 'subido' && st.uploadedWithinDeadline !== null) ok = st.uploadedWithinDeadline ? 1 : 0;
      else continue;   // todavía dentro del plazo, o sin forma de juzgarla

      sumar(global.transcript[w], ok, 1);
      sumar(celdaProfe(first.teacherId, 'transcript', w), ok, 1);
      const acc = transcriptProfesSemana[w].get(first.teacherId) ?? { ok: 0, total: 0 };
      acc.ok += ok; acc.total += 1;
      transcriptProfesSemana[w].set(first.teacherId, acc);
    }
  }
  const transcriptProfes: Celda[] = semanas.map((_, w) => {
    if (global.transcript[w] === null) return null;
    const vals = [...transcriptProfesSemana[w].values()];
    return { num: vals.filter(v => v.ok === v.total).length, den: vals.length };
  });

  // ── ingreso ────────────────────────────────────────────────────────────────
  // Solo los clics del profesor: el ingreso que crea el admin a mano (solicitud
  // de revisión) prueba que la clase se dio, no que entró con el link.
  const clics = logsVentana.filter(l => l.source !== 'manual');
  const clicsPorClave = new Map<string, ClassJoinLog[]>();
  for (const l of clics) {
    const k = `${l.teacherId}|${nkName(l.studentName)}|${l.scheduledDate}`;
    const arr = clicsPorClave.get(k);
    if (arr) arr.push(l); else clicsPorClave.set(k, [l]);
  }
  const usados = new Set<string>();
  for (const c of input.programadas) {
    if (ignorar.has(c.teacherId)) continue;
    const w = indiceSemana(semanas, c.date);
    if (w < 0 || c.date > hoy) continue;
    // Solo las que ya terminaron: la de dentro de una hora no se puede reclamar.
    const fin = spainWallClockToEpoch(c.date, c.startHour, 0) + c.durationHours * 3_600_000;
    if (!Number.isFinite(fin) || fin > now) continue;

    const delDia = (clicsPorClave.get(`${c.teacherId}|${nkName(c.studentName)}|${c.date}`) ?? [])
      .filter(l => !usados.has(l.id));
    // Primero los clics dentro del tramo; si no hay, cualquiera de ese alumno ese
    // día (la clase se dio a otra hora): contarla como "sin clic" y además sumar
    // el clic suelto abajo sería contar dos clases donde hubo una.
    const enTramo = delDia.filter(l => { const h = hourNum(l.scheduledTime); return h >= c.startHour && h < c.startHour + c.durationHours; });
    const suyos = enTramo.length > 0 ? enTramo : delDia;
    if (suyos.length > 0) {
      suyos.forEach(l => usados.add(l.id));
      sumar(global.ingreso[w], 1, 1);
      sumar(celdaProfe(c.teacherId, 'ingreso', w), 1, 1);
      continue;
    }
    // Sin clic: si la clase se canceló o se movió, no había a qué entrar.
    const span = { start: c.startHour, end: c.startHour + c.durationHours };
    const recs = recordsPorClave.get(`${c.teacherId}|${c.date}`) ?? [];
    const movida = !c.isRecovery && !!rescheduledTargetFor(recs, c.teacherId, c.studentName, c.date, span);
    const cancelada = !!cancellationFor(recs, c.teacherId, c.studentName, c.date, span);
    if (movida || cancelada) continue;
    sumar(global.ingreso[w], 0, 1);
    sumar(celdaProfe(c.teacherId, 'ingreso', w), 0, 1);
  }
  // Clics sin clase programada (horario cambiado, clase fuera del calendario):
  // la clase existió y se entró con el link. Uno por alumno y día.
  const sueltos = new Set<string>();
  for (const l of clics) {
    if (usados.has(l.id)) continue;
    const k = `${l.teacherId}|${nkName(l.studentName)}|${l.scheduledDate}`;
    if (sueltos.has(k)) continue;
    sueltos.add(k);
    const w = indiceSemana(semanas, l.scheduledDate);
    sumar(global.ingreso[w], 1, 1);
    sumar(celdaProfe(l.teacherId, 'ingreso', w), 1, 1);
  }
  const ingresoFuente = semanas.map(s => {
    const fechas: string[] = [];
    for (let d = s.start; d <= s.end && d <= hoy; d = addDaysIso(d, 1)) fechas.push(d);
    const conFoto = fechas.filter(d => input.fechasConFoto.has(d)).length;
    return conFoto === 0 ? 'proyeccion' as const : conFoto === fechas.length ? 'foto' as const : 'mixta' as const;
  });

  // ── riesgo ─────────────────────────────────────────────────────────────────
  const aperturas = new Map<string, number[]>();
  for (const e of input.eventos) {
    if (e.event !== 'risk_alert_opened' || !e.teacher_id) continue;
    const t = new Date(e.created_at).getTime();
    if (!Number.isFinite(t)) continue;
    const arr = aperturas.get(e.teacher_id) ?? [];
    arr.push(t);
    aperturas.set(e.teacher_id, arr);
  }
  const primeraAlerta = semanas.map(() => new Map<string, number>());
  for (const a of input.alertas) {
    if (!a.target_user || ignorar.has(a.target_user)) continue;
    const w = indiceSemana(semanas, spainDateOf(a.created_at));
    if (w < 0 || global.riesgo[w] === null) continue;
    const t = new Date(a.created_at).getTime();
    const prev = primeraAlerta[w].get(a.target_user);
    if (prev === undefined || t < prev) primeraAlerta[w].set(a.target_user, t);
  }
  semanas.forEach((s, w) => {
    if (global.riesgo[w] === null) return;
    // Se le da una semana de margen después del domingo: la alerta del domingo
    // por la noche se abre el lunes.
    const limite = spainWallClockToEpoch(addDaysIso(s.end, 8), 0, 0);
    for (const [tid, desdeMs] of primeraAlerta[w]) {
      const abrio = (aperturas.get(tid) ?? []).some(t => t >= desdeMs && t < limite) ? 1 : 0;
      sumar(global.riesgo[w], abrio, 1);
      sumar(celdaProfe(tid, 'riesgo', w), abrio, 1);
    }
  });

  return {
    hoy, semanas, global, iaOrigen, transcriptProfes, ingresoFuente, desde,
    profesores: input.profesores
      .filter(p => profesIds.has(p.id) && !ignorar.has(p.id))
      .map(p => ({ id: p.id, name: p.name, celdas: porProfe.get(p.id)! }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es')),
  };
}
