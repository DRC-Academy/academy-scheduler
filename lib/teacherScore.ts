// ── SCORING v2 de profesores: el MOTOR ───────────────────────────────────────
//
// Única fuente del puntaje v2. Funciones PURAS sobre filas ya leídas: la lectura
// vive en lib/teacherScoreLoad (servidor), y todo lo que muestra el v2 (pestaña
// "Scoring v2 (beta)", foto diaria, script de vista previa) sale de acá. Los
// números de la fórmula están en lib/teacherScoreConfig.
//
// Convive con el scoring viejo (lib/scoringStore, pestaña Scoring, Mi Scoring):
// no lo lee ni lo modifica.
//
// REGLAS COMUNES
//   · Ventana: los últimos VENTANA_DIAS días en hora de ESPAÑA, hoy incluido.
//     Las fechas de clase ya son españolas; los instantes (dropped_at,
//     created_at) se pasan a fecha española con spainDateOf.
//   · Las cuentas de prueba llegan ya filtradas (lib/teacherScoreLoad).
//   · "Sin dato" NO es cero: una métrica sin datos suficientes es null y su peso
//     se reparte entre las que sí tienen.
//   · Cada métrica explica su porqué (resumen, números y eventos) para el detalle
//     de la pantalla y la columna details de teacher_score_snapshots.
//
// LOS PILARES
//   1) Retención     bajas por alumno-mes frente a la tasa de la academia, con
//                    suavizado hacia el promedio cuando hay poca exposición.
//   2) Cumplimiento  puntualidad, transcripts a tiempo, cancelaciones tardías y
//                    enlaces de clase a tiempo.
//   3) Riesgo        % de auditorías de protocolo en las que el profe intervino,
//                    suavizado hacia el % de la academia con pocas auditorías.
//   4) Calidad       % de clases en verde y % de habla del alumno.
//   5) Crecimiento   preparado, devuelve null (peso 0).

import type { ClassJoinLog, ClassRecord } from '@/types';
import type { ClassTranscriptRef } from '@/lib/transcriptDeadline';
import { juzgarTranscriptsDeClases, spainDateOf } from '@/lib/teacherUsage';
import { addDaysIso } from '@/lib/teacherClasses';
import { hourNum, nkName } from '@/lib/sessions';
import { normName } from '@/lib/retention';
import { MEET_LINK_PENALTY_START_DATE } from '@/lib/meetLinkStatus';
import {
  AJUSTES_MANUALES, CALIDAD, CONFIANZA, CUMPLIMIENTO, FORMULA_VERSION, MAX_EVENTOS_DETALLE,
  NIVELES, PESOS, RETENCION, RIESGO, VENTANA_DIAS,
} from '@/lib/teacherScoreConfig';

// ── Entrada ───────────────────────────────────────────────────────────────────

export interface ProfesorScore {
  id: string;
  name: string;
  createdAt?: string | null;
  /** Celdas ocupadas del calendario (= horas semanales). */
  weeklyLoad: number;
  /** Celdas libres del calendario. */
  freeSpots: number;
}

export interface AsignacionScore {
  id: string;
  teacherId: string;
  studentId: string | null;
  studentName: string;
  status: string | null;
  teacherSince: string | null;
  startDate: string | null;
  createdAt: string | null;
  calendarRemovedAt: string | null;
}

export interface BajaScore {
  id: string;
  teacherId: string;
  studentId: string | null;
  studentName: string;
  startDate: string | null;
  droppedAt: string;
}

export interface TransferenciaScore {
  assignmentId: string;
  fromTeacherId: string;
  createdAt: string;
}

export interface RecuperacionScore {
  id: string;
  teacherId: string;
  studentName: string;
  originalDate: string | null;
  late: boolean;
  status: string | null;
  cancelRecordId: string | null;
}

export interface EventoScore {
  id: string;
  teacherId: string;
  eventType: string;
  createdAt: string;
  reverted: boolean;
}

export interface AuditoriaScore {
  id: string;
  teacherId: string;
  studentName: string;
  signsOfIntervention: boolean | null;
  createdAt: string;
}

export interface AnalisisScore {
  id: string;
  teacherId: string;
  studentName: string;
  classDate: string | null;
  riskSignal: string | null;
  analysisStatus: string | null;
}

export interface EntradaScore {
  /** Hoy en España, 'YYYY-MM-DD'. */
  hoy: string;
  now: number;
  /** Profes que reciben puntaje (sin cuentas de prueba ni archivados). */
  profesores: ProfesorScore[];
  // Todas las filas llegan SIN cuentas de prueba, pero CON los profes archivados:
  // su historia cuenta para los promedios de la academia.
  asignaciones: AsignacionScore[];
  bajas: BajaScore[];
  transferencias: TransferenciaScore[];
  /** Ingresos a clase. Basta desde el inicio de la ventana, pero puede venir todo. */
  ingresos: ClassJoinLog[];
  /** Constancias de clase (con revertedAt). */
  records: ClassRecord[];
  /** class_analyses con las columnas del plazo del transcript (sin el texto). */
  transcripts: ClassTranscriptRef[];
  /** analysisId → ISO de la primera subida (usage_events). */
  primeraSubida: Map<string, string>;
  recuperaciones: RecuperacionScore[];
  eventos: EventoScore[];
  auditorias: AuditoriaScore[];
  /** class_analyses de la ventana (señal de riesgo). */
  analisis: AnalisisScore[];
  /** analysisId → % del tiempo que habla el alumno (0–100), transcript_fluency. */
  habla: Map<string, number>;
  /**
   * teacherId → fecha de la primera clase registrada (ingreso o constancia). El
   * motor la compara con el alta del profe y se queda con la más antigua.
   */
  primeraClase: Map<string, string>;
}

// ── Salida ────────────────────────────────────────────────────────────────────

export type NivelV2 = 'En evaluación' | 'Estándar' | 'Destacado' | 'Top' | 'En revisión';
export type ConfianzaV2 = 'alta' | 'media' | 'baja';
export type PilarId = 'retencion' | 'cumplimiento' | 'riesgo' | 'calidad' | 'crecimiento';

/** Una métrica (pilar o parte de un pilar) con su porqué. */
export interface Metrica {
  /** 0–100, o null si no hay datos suficientes. */
  score: number | null;
  /** Una línea legible: "9 de 11 alumnos siguen · 2 bajas en 14,2 alumnos-mes". */
  resumen: string;
  /** Si score es null, por qué. */
  motivoNull?: string;
  /** Los números que se usaron. */
  numeros: Record<string, number | string | null>;
  /** Eventos concretos ("Baja: Ana P. el 03/10"), con tope MAX_EVENTOS_DETALLE. */
  eventos: string[];
}

export interface Pilar extends Metrica {
  /** Peso de la configuración. */
  peso: number;
  /** Peso que terminó teniendo tras repartir los pilares en null (suma 100). */
  pesoEfectivo: number;
  /** Partes del pilar (cumplimiento y calidad). */
  partes?: Record<string, Metrica & { subpeso: number }>;
}

export interface ResultadoProfe {
  teacherId: string;
  teacherName: string;
  /** Puntaje final 0–100 (pilares + ajustes), o null si ningún pilar tiene datos. */
  score: number | null;
  /** Puntaje de los pilares, antes de los ajustes manuales. */
  scorePilares: number | null;
  level: NivelV2;
  /** Por qué ese nivel ("Confianza baja", "Menos de 90 días dando clases"...). */
  levelMotivo: string;
  confidence: ConfianzaV2;
  pilares: Record<PilarId, Pilar>;
  ajustes: { total: number; eventos: string[] };
  exposicion: { alumnosMes: number; clases: number; alumnos: number; bajas: number };
  experiencia: {
    alumnosActivos: number;
    horasSemanales: number;
    pctCalendarioOcupado: number | null;
    primeraClase: string | null;
    diasDandoClases: number | null;
    mesesEnAcademia: number | null;
  };
}

export interface ResultadoAcademia {
  formulaVersion: string;
  ventana: { desde: string; hasta: string };
  /** Bajas por alumno-mes de toda la academia (incluidos los profes archivados). */
  tasaBajas: number | null;
  bajas: number;
  alumnosMes: number;
  /** Filas de student_dropouts de la ventana que eran repetidas (mismo profe y alumno). */
  bajasDuplicadasDescartadas: number;
  /** Detalle de los duplicados descartados: "Virginia Alfonso (Wanda) ×6". */
  duplicados: string[];
  medianaHabla: number | null;
  /** Avisos de calidad de datos (fechas ilegibles, asignaciones sin fecha de fin...). */
  avisos: string[];
}

export interface ResultadoScore {
  academia: ResultadoAcademia;
  profesores: ResultadoProfe[];
}

// ── Utilidades ────────────────────────────────────────────────────────────────

const ISO = /^20\d\d-\d\d-\d\d$/;
/** Fecha 'YYYY-MM-DD' válida (descarta años como "0026" que hay en la base). */
const fechaValida = (d: string | null | undefined): string | null => {
  const s = (d ?? '').slice(0, 10);
  return ISO.test(s) ? s : null;
};
/** Fecha española de un instante, o de una fecha suelta. */
const fechaDe = (v: string | null | undefined): string | null => {
  if (!v) return null;
  if (v.length <= 10) return fechaValida(v);
  return fechaValida(spainDateOf(v));
};
const diasEntre = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
/** 'YYYY-MM-DD' → 'DD/MM'. */
const ddmm = (d: string): string => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const r1 = (n: number): number => Math.round(n * 10) / 10;
const fmt = (n: number): string => r1(n).toLocaleString('es-ES');
const pct = (num: number, den: number): number => (den > 0 ? (num / den) * 100 : 0);
const clamp = (n: number, lo = 0, hi = 100): number => Math.min(hi, Math.max(lo, n));

function mediana(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Recorta una lista de eventos al tope del detalle. */
function topeEventos(xs: string[]): string[] {
  if (xs.length <= MAX_EVENTOS_DETALLE) return xs;
  return [...xs.slice(0, MAX_EVENTOS_DETALLE), `… y ${xs.length - MAX_EVENTOS_DETALLE} más`];
}

/** Promedio ponderado de las partes con dato; null si ninguna tiene. */
function ponderar(partes: Array<{ score: number | null; peso: number }>): number | null {
  const con = partes.filter(p => p.score !== null && p.peso > 0);
  const suma = con.reduce((s, p) => s + p.peso, 0);
  if (suma === 0) return null;
  return con.reduce((s, p) => s + (p.score as number) * p.peso, 0) / suma;
}

const nula = (resumen: string, motivoNull: string, numeros: Metrica['numeros'] = {}): Metrica =>
  ({ score: null, resumen, motivoNull, numeros, eventos: [] });

/** Clave de un alumno dentro de un profe: el nombre normalizado (sin acentos). */
const claveAlumno = (teacherId: string, studentName: string): string => `${teacherId}|${normName(studentName)}`;

// ── 1) Retención: exposición y bajas ──────────────────────────────────────────

interface Tramo { teacherId: string; studentName: string; desde: string; hasta: string; origen: string }

export interface ExposicionAcademia {
  /** Tramos de cada par alumno+profe (sin recortar a la ventana). */
  tramos: Tramo[];
  /** Bajas deduplicadas DENTRO de la ventana, por profe. */
  bajasPorProfe: Map<string, Array<{ studentName: string; fecha: string }>>;
  /** Pares con filas repetidas en la ventana: cuántas filas había y cuántas se descartaron. */
  duplicados: Map<string, { studentName: string; teacherId: string; filas: number; descartadas: number }>;
  avisos: string[];
}

/**
 * Arma los tramos alumno+profe y las bajas deduplicadas.
 *
 * Tramos:
 *   · assignments: desde teacher_since (o start_date, o created_at). Una fecha
 *     futura no cuenta. Termina en la baja de ese par si la hay; si no, hoy para
 *     las activas y calendar_removed_at para las inactivas (sin esa fecha, no se
 *     sabe cuándo se fue y no cuenta).
 *   · Bajas cuyo alumno ya no tiene asignación (al dar de baja se borra): desde
 *     student_dropouts.start_date hasta la baja.
 *   · Cambios de profe (transfer_requests): el profe anterior suma su tramo
 *     desde el inicio del alumno hasta el cambio.
 *
 * Bajas: una por profe + alumno (por nombre normalizado), la primera fecha.
 */
export function construirExposicion(input: Pick<EntradaScore, 'hoy' | 'asignaciones' | 'bajas' | 'transferencias'>): ExposicionAcademia {
  const { hoy } = input;
  const desde = addDaysIso(hoy, -(VENTANA_DIAS - 1));
  const avisos: string[] = [];

  // Bajas: primera fecha por par, y conteo de filas repetidas.
  const primeraBaja = new Map<string, BajaScore & { fecha: string }>();
  const filasPorPar = new Map<string, number>();
  let sinFecha = 0;
  for (const b of input.bajas) {
    const fecha = fechaDe(b.droppedAt);
    if (!fecha) { sinFecha++; continue; }
    const k = claveAlumno(b.teacherId, b.studentName);
    filasPorPar.set(k, (filasPorPar.get(k) ?? 0) + 1);
    const prev = primeraBaja.get(k);
    if (!prev || fecha < prev.fecha) primeraBaja.set(k, { ...b, fecha });
  }
  if (sinFecha) avisos.push(`${sinFecha} baja(s) sin fecha legible: no se cuentan.`);

  const bajasPorProfe = new Map<string, Array<{ studentName: string; fecha: string }>>();
  const duplicados: ExposicionAcademia['duplicados'] = new Map();
  for (const b of primeraBaja.values()) {
    if (b.fecha < desde || b.fecha > hoy) continue;
    const arr = bajasPorProfe.get(b.teacherId) ?? [];
    arr.push({ studentName: b.studentName, fecha: b.fecha });
    bajasPorProfe.set(b.teacherId, arr);
  }
  // Duplicados: filas de la ventana que repiten un par ya contado.
  const filasEnVentana = new Map<string, number>();
  for (const b of input.bajas) {
    const fecha = fechaDe(b.droppedAt);
    if (!fecha || fecha < desde || fecha > hoy) continue;
    const k = claveAlumno(b.teacherId, b.studentName);
    filasEnVentana.set(k, (filasEnVentana.get(k) ?? 0) + 1);
  }
  for (const [k, n] of filasEnVentana) {
    const b = primeraBaja.get(k);
    if (!b) continue;
    // Si la primera baja del par es anterior a la ventana, TODAS las filas de la
    // ventana repiten esa baja; si no, todas menos la primera.
    const descartadas = b.fecha >= desde ? n - 1 : n;
    if (descartadas > 0) duplicados.set(k, { studentName: b.studentName, teacherId: b.teacherId, filas: n, descartadas });
  }

  const tramos: Tramo[] = [];
  const paresConAsignacion = new Set<string>();
  let futuras = 0, inactivasSinFin = 0, sinInicio = 0;

  for (const a of input.asignaciones) {
    const k = claveAlumno(a.teacherId, a.studentName);
    paresConAsignacion.add(k);
    const inicio = fechaValida(a.teacherSince) ?? fechaValida(a.startDate) ?? fechaDe(a.createdAt);
    if (!inicio) { sinInicio++; continue; }
    const baja = primeraBaja.get(k);
    if (inicio > hoy) { futuras++; }
    else if (baja && baja.fecha >= inicio) {
      tramos.push({ teacherId: a.teacherId, studentName: a.studentName, desde: inicio, hasta: baja.fecha, origen: 'asignación hasta la baja' });
      continue;
    } else if (a.status === 'active') {
      tramos.push({ teacherId: a.teacherId, studentName: a.studentName, desde: inicio, hasta: hoy, origen: 'asignación activa' });
    } else {
      const fin = fechaDe(a.calendarRemovedAt);
      if (fin && fin >= inicio) tramos.push({ teacherId: a.teacherId, studentName: a.studentName, desde: inicio, hasta: fin, origen: 'asignación inactiva hasta que se quitó del calendario' });
      else inactivasSinFin++;
    }
    // Volvió después de una baja: el tramo anterior a la baja también cuenta.
    if (baja && baja.fecha < inicio) {
      const ini = fechaValida(baja.startDate) ?? baja.fecha;
      tramos.push({ teacherId: a.teacherId, studentName: a.studentName, desde: ini <= baja.fecha ? ini : baja.fecha, hasta: baja.fecha, origen: 'tramo anterior a la baja' });
    }
  }

  // Bajas sin asignación: el tramo sale de la propia baja.
  for (const [k, b] of primeraBaja) {
    if (paresConAsignacion.has(k)) continue;
    const ini = fechaValida(b.startDate) ?? b.fecha;
    tramos.push({ teacherId: b.teacherId, studentName: b.studentName, desde: ini <= b.fecha ? ini : b.fecha, hasta: b.fecha, origen: 'baja (la asignación ya no existe)' });
  }

  // Cambios de profe: el tramo del profe anterior.
  const asignacionPorId = new Map(input.asignaciones.map(a => [a.id, a]));
  for (const t of input.transferencias) {
    const a = asignacionPorId.get(t.assignmentId);
    const fin = fechaDe(t.createdAt);
    if (!a || !fin || !t.fromTeacherId || t.fromTeacherId === a.teacherId) continue;
    const ini = fechaValida(a.startDate) ?? fechaDe(a.createdAt);
    if (!ini || ini > fin) continue;
    tramos.push({ teacherId: t.fromTeacherId, studentName: a.studentName, desde: ini, hasta: fin, origen: 'antes del cambio de profe' });
  }

  if (futuras) avisos.push(`${futuras} asignación(es) con inicio futuro: no suman exposición todavía.`);
  if (inactivasSinFin) avisos.push(`${inactivasSinFin} asignación(es) inactivas sin baja ni fecha de salida del calendario: no suman exposición.`);
  if (sinInicio) avisos.push(`${sinInicio} asignación(es) sin ninguna fecha de inicio legible: no suman exposición.`);
  return { tramos, bajasPorProfe, duplicados, avisos };
}

/** Días de un tramo dentro de la ventana (inclusive), 0 si cae fuera. */
function diasEnVentana(t: Tramo, desde: string, hoy: string): number {
  const a = t.desde > desde ? t.desde : desde;
  const b = t.hasta < hoy ? t.hasta : hoy;
  return b < a ? 0 : diasEntre(a, b) + 1;
}

/** Puntos de una tasa de bajas frente a la de la academia (lineal por tramos). */
export function puntosPorTasa(tasa: number, tasaAcademia: number): number {
  const { puntosSinBajas, puntosEnPromedio, multiploParaCero } = RETENCION;
  if (tasaAcademia <= 0) return tasa <= 0 ? puntosSinBajas : puntosEnPromedio;
  const x = tasa / tasaAcademia;
  if (x <= 1) return puntosSinBajas - (puntosSinBajas - puntosEnPromedio) * x;
  if (x >= multiploParaCero) return 0;
  return puntosEnPromedio * (1 - (x - 1) / (multiploParaCero - 1));
}

/** Tasa suavizada: como si el profe tuviera K alumnos-mes extra con la tasa de la academia. */
export function tasaSuavizada(bajas: number, alumnosMes: number, tasaAcademia: number): number {
  return (bajas + RETENCION.K * tasaAcademia) / (alumnosMes + RETENCION.K);
}

function pilarRetencion(
  teacherId: string, exp: ExposicionAcademia, tasaAcademia: number | null, desde: string, hoy: string,
): Metrica & { alumnosMes: number; alumnos: number; bajas: number } {
  const tramos = exp.tramos.filter(t => t.teacherId === teacherId);
  // Días por alumno (un alumno puede tener dos tramos: antes y después de volver).
  const diasPorAlumno = new Map<string, { nombre: string; dias: number }>();
  for (const t of tramos) {
    const d = diasEnVentana(t, desde, hoy);
    if (d <= 0) continue;
    const k = normName(t.studentName);
    const e = diasPorAlumno.get(k) ?? { nombre: t.studentName, dias: 0 };
    e.dias += d;
    diasPorAlumno.set(k, e);
  }
  const dias = [...diasPorAlumno.values()].reduce((s, e) => s + e.dias, 0);
  const alumnosMes = dias / RETENCION.diasPorAlumnoMes;
  const bajas = [...(exp.bajasPorProfe.get(teacherId) ?? [])].sort((a, b) => a.fecha.localeCompare(b.fecha));
  const alumnos = diasPorAlumno.size;
  const eventos = topeEventos(bajas.map(b => `Baja: ${b.studentName} el ${ddmm(b.fecha)}`));
  const base = { alumnosMes, alumnos, bajas: bajas.length, eventos };

  if (alumnosMes <= 0 || tasaAcademia === null) {
    return {
      ...base, score: null,
      resumen: 'Sin alumnos dentro de la ventana',
      motivoNull: 'No tuvo ningún alumno en los últimos 90 días.',
      numeros: { alumnosMes: 0, bajas: bajas.length },
    };
  }
  const tasa = bajas.length / alumnosMes;
  const suave = tasaSuavizada(bajas.length, alumnosMes, tasaAcademia);
  const score = r1(puntosPorTasa(suave, tasaAcademia));
  const siguen = Math.max(0, alumnos - bajas.length);
  return {
    ...base, score,
    resumen: `${siguen} de ${alumnos} alumnos siguen · ${bajas.length} baja(s) en ${fmt(alumnosMes)} alumnos-mes`
      + ` · tasa ${fmt(tasa * 100)} cada 100 alumnos-mes (academia ${fmt(tasaAcademia * 100)})`,
    numeros: {
      alumnos, bajas: bajas.length, alumnosMes: r1(alumnosMes),
      tasa: r1(tasa * 1000) / 1000, tasaAcademia: r1(tasaAcademia * 1000) / 1000,
      tasaSuavizada: r1(suave * 1000) / 1000, K: RETENCION.K,
      puntajeSinSuavizar: r1(puntosPorTasa(tasa, tasaAcademia)),
    },
  };
}

// ── 2) Cumplimiento ───────────────────────────────────────────────────────────

/** Clases (sesiones) del profe en la ventana: profe + alumno + fecha. */
function sesionesDe(ingresos: ClassJoinLog[]): Map<string, ClassJoinLog[]> {
  const m = new Map<string, ClassJoinLog[]>();
  for (const l of ingresos) {
    const k = `${nkName(l.studentName)}|${l.scheduledDate}`;
    const arr = m.get(k);
    if (arr) arr.push(l); else m.set(k, [l]);
  }
  return m;
}

function metricaPuntualidad(ingresosVentana: ClassJoinLog[]): Metrica {
  const desdeP = CUMPLIMIENTO.puntualidadDesde;
  const clics = ingresosVentana.filter(l => l.source !== 'manual' && l.scheduledDate >= desdeP);
  const sesiones = sesionesDe(clics);
  let suma = 0, aTiempo = 0, tarde = 0, muyTarde = 0;
  const eventos: Array<{ d: string; s: string }> = [];
  for (const logs of sesiones.values()) {
    // El ingreso de la PRIMERA hora de la sesión.
    const l = [...logs].sort((a, b) => (hourNum(a.scheduledTime) || 0) - (hourNum(b.scheduledTime) || 0))[0];
    suma += CUMPLIMIENTO.valorPuntualidad[l.punctuality] ?? 0;
    if (l.punctuality === 'on_time') aTiempo++;
    else if (l.punctuality === 'late') { tarde++; eventos.push({ d: l.scheduledDate, s: `Tarde: ${l.studentName} el ${ddmm(l.scheduledDate)} (${l.scheduledTime})` }); }
    else { muyTarde++; eventos.push({ d: l.scheduledDate, s: `Muy tarde: ${l.studentName} el ${ddmm(l.scheduledDate)} (${l.scheduledTime})` }); }
  }
  const n = sesiones.size;
  const numeros = { clases: n, aTiempo, tarde, muyTarde };
  if (n < CUMPLIMIENTO.minClasesPuntualidad) {
    return nula(`${n} clase(s) con ingreso`, `Menos de ${CUMPLIMIENTO.minClasesPuntualidad} clases con ingreso para medir la puntualidad.`, numeros);
  }
  return {
    score: r1((suma / n) * 100),
    resumen: `${aTiempo} a tiempo, ${tarde} tarde y ${muyTarde} muy tarde, de ${n} clases`,
    numeros,
    eventos: topeEventos(eventos.sort((a, b) => b.d.localeCompare(a.d)).map(e => e.s)),
  };
}

function metricaTranscripts(
  teacherId: string, ingresosVentana: ClassJoinLog[], input: EntradaScore,
): Metrica {
  const juzgadas = juzgarTranscriptsDeClases({
    joinLogs: ingresosVentana, records: input.records.filter(r => r.teacherId === teacherId),
    analyses: input.transcripts.filter(t => !t.teacher_id || t.teacher_id === teacherId),
    primeraSubida: input.primeraSubida, hoy: input.hoy, now: input.now,
  });
  const ok = juzgadas.filter(c => c.aTiempo).length;
  const n = juzgadas.length;
  const numeros = { clases: n, aTiempo: ok, fueraDePlazo: n - ok };
  if (n < CUMPLIMIENTO.minClasesTranscripts) {
    return nula(`${n} clase(s) con plazo ya juzgado`, `Menos de ${CUMPLIMIENTO.minClasesTranscripts} clases con plazo de 24 h ya cumplido (desde el 22/09).`, numeros);
  }
  return {
    score: r1(pct(ok, n)),
    resumen: `${ok} de ${n} transcripts subidos dentro de las 24 h`,
    numeros,
    eventos: topeEventos(juzgadas.filter(c => !c.aTiempo).reverse()
      .map(c => `Fuera de plazo: ${c.studentName} el ${ddmm(c.date)}`)),
  };
}

function metricaCancelaciones(
  teacherId: string, clasesDadas: number, input: EntradaScore, desde: string,
): Metrica {
  const { hoy } = input;
  const enVentana = (d: string | null | undefined) => !!d && d >= desde && d <= hoy;
  const recs = input.records.filter(r =>
    r.teacherId === teacherId && r.classType === 'cancelada_por_profesor' && !r.revertedAt && enVentana(fechaValida(r.classDate)));
  const idsRecs = new Set(recs.map(r => r.id));
  const recups = input.recuperaciones.filter(c =>
    c.teacherId === teacherId && c.late && c.status !== 'anulada' && enVentana(fechaValida(c.originalDate))
    && !(c.cancelRecordId && idsRecs.has(c.cancelRecordId)));
  const lista = [
    ...recs.map(r => ({ d: r.classDate, s: `Cancelación tardía: ${r.studentName} el ${ddmm(r.classDate)}` })),
    ...recups.map(c => ({ d: c.originalDate as string, s: `No puede dar la clase (aviso tardío): ${c.studentName} el ${ddmm(c.originalDate as string)}` })),
  ].sort((a, b) => b.d.localeCompare(a.d));
  const n = lista.length;
  const numeros = { cancelacionesTardias: n, clasesDadas };
  if (clasesDadas < CUMPLIMIENTO.minClasesCancelaciones) {
    return nula(`${n} cancelación(es) en ${clasesDadas} clases`, `Menos de ${CUMPLIMIENTO.minClasesCancelaciones} clases dadas para medir las cancelaciones.`, numeros);
  }
  const cada100 = (n / clasesDadas) * 100;
  return {
    score: r1(clamp(100 - cada100 * CUMPLIMIENTO.puntosPorCancelacionCada100)),
    resumen: n === 0
      ? `Ninguna cancelación tardía en ${clasesDadas} clases`
      : `${n} cancelación(es) tardía(s) en ${clasesDadas} clases (${fmt(cada100)} cada 100)`,
    numeros: { ...numeros, cada100: r1(cada100) },
    eventos: topeEventos(lista.map(e => e.s)),
  };
}

function metricaEnlaces(
  teacherId: string, input: EntradaScore, exp: ExposicionAcademia, desde: string,
): Metrica {
  const { hoy } = input;
  // Solo las asignaciones con plazo de enlace: creadas desde que existe la regla.
  const corte = MEET_LINK_PENALTY_START_DATE > desde ? MEET_LINK_PENALTY_START_DATE : desde;
  const nuevos = new Set<string>();
  for (const a of input.asignaciones) {
    if (a.teacherId !== teacherId) continue;
    const c = fechaDe(a.createdAt);
    if (c && c >= corte && c <= hoy) nuevos.add(normName(a.studentName));
  }
  // Los dados de baja ya no tienen asignación: cuenta su inicio.
  for (const t of exp.tramos) {
    if (t.teacherId !== teacherId || t.origen !== 'baja (la asignación ya no existe)') continue;
    if (t.desde >= corte && t.desde <= hoy) nuevos.add(normName(t.studentName));
  }
  const tardios = input.eventos.filter(e => {
    const d = fechaDe(e.createdAt);
    return e.teacherId === teacherId && e.eventType === 'enlace_tardio' && !e.reverted && !!d && d >= desde && d <= hoy;
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const n = nuevos.size;
  const t = Math.min(tardios.length, n);
  const numeros = { alumnosNuevos: n, enlacesTardios: tardios.length };
  if (n < CUMPLIMIENTO.minAlumnosNuevosEnlaces) {
    return nula('Sin alumnos nuevos con plazo de enlace', `No recibió alumnos nuevos desde el ${ddmm(corte)} (el plazo del enlace rige desde el 25/09).`, numeros);
  }
  return {
    score: r1(clamp(100 * (1 - t / n))),
    resumen: `${n - t} de ${n} alumnos nuevos con el enlace definido a tiempo`,
    numeros,
    eventos: topeEventos(tardios.map(e => `Enlace tardío el ${ddmm(fechaDe(e.createdAt) as string)}`)),
  };
}

// ── 3) Gestión del riesgo ─────────────────────────────────────────────────────

/** % de intervención suavizado: como si el profe tuviera K_RIESGO auditorías extra con el % de la academia. */
export function intervencionSuavizada(conIntervencion: number, auditorias: number, tasaAcademia: number): number {
  return (conIntervencion + RIESGO.K_RIESGO * tasaAcademia) / (auditorias + RIESGO.K_RIESGO);
}

function pilarRiesgo(teacherId: string, auditoriasVentana: AuditoriaScore[], tasaAcademia: number | null): Metrica {
  const auds = auditoriasVentana.filter(a => a.teacherId === teacherId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const si = auds.filter(a => a.signsOfIntervention === true).length;
  const n = auds.length;
  const numeros: Metrica['numeros'] = { auditorias: n, conIntervencion: si, sinIntervencion: n - si };
  if (n < RIESGO.minAuditorias || tasaAcademia === null) {
    return nula(`${n} auditoría(s) de protocolo`, `Menos de ${RIESGO.minAuditorias} auditorías de protocolo en la ventana.`, numeros);
  }
  const suave = intervencionSuavizada(si, n, tasaAcademia);
  return {
    score: r1(suave * 100),
    resumen: `Intervino en ${si} de ${n} alertas auditadas (${fmt(pct(si, n))}%; academia ${fmt(tasaAcademia * 100)}%)`,
    numeros: { ...numeros, pctSinSuavizar: r1(pct(si, n)), pctAcademia: r1(tasaAcademia * 100), K: RIESGO.K_RIESGO },
    eventos: topeEventos(auds.filter(a => a.signsOfIntervention !== true)
      .map(a => `Sin intervención: ${a.studentName} (${ddmm(fechaDe(a.createdAt) as string)})`)),
  };
}

// ── 4) Calidad ────────────────────────────────────────────────────────────────

const SENALES = new Set(['verde', 'amarillo', 'rojo']);

function metricaSenal(analisis: AnalisisScore[]): Metrica {
  const conSenal = analisis.filter(a => a.analysisStatus === 'ready' && !!a.riskSignal && SENALES.has(a.riskSignal));
  const verdes = conSenal.filter(a => a.riskSignal === 'verde').length;
  const rojos = conSenal.filter(a => a.riskSignal === 'rojo').length;
  const n = conSenal.length;
  const numeros = { clases: n, verde: verdes, rojo: rojos, amarillo: n - verdes - rojos };
  if (n < CALIDAD.minClasesSenal) {
    return nula(`${n} clase(s) con señal`, `Menos de ${CALIDAD.minClasesSenal} clases con señal de riesgo en la ventana.`, numeros);
  }
  return {
    score: r1(pct(verdes, n)),
    resumen: `${verdes} de ${n} clases en verde`,
    numeros,
    eventos: topeEventos(conSenal.filter(a => a.riskSignal !== 'verde')
      .sort((a, b) => (b.classDate ?? '').localeCompare(a.classDate ?? ''))
      .map(a => `${a.riskSignal === 'rojo' ? 'Rojo' : 'Amarillo'}: ${a.studentName}${a.classDate ? ` el ${ddmm(a.classDate)}` : ''}`)),
  };
}

/** Puntos del % de habla frente a la mediana de la academia. */
export function puntosHabla(medianaProfe: number, medianaAcademia: number): number {
  const d = medianaProfe - medianaAcademia;
  const base = CALIDAD.hablaPuntosEnMediana;
  if (d >= 0) return clamp(base + (100 - base) * Math.min(1, d / CALIDAD.hablaPpParaCien));
  return clamp(base - base * Math.min(1, -d / CALIDAD.hablaPpParaCero));
}

function metricaHabla(analisis: AnalisisScore[], habla: Map<string, number>, medianaAcademia: number | null): Metrica {
  const valores = analisis.map(a => habla.get(a.id)).filter((x): x is number => typeof x === 'number');
  const n = valores.length;
  const med = mediana(valores);
  const numeros = { clases: n, medianaProfe: med, medianaAcademia };
  if (n < CALIDAD.minClasesHabla || med === null || medianaAcademia === null) {
    return nula(`${n} clase(s) con % de habla`, `Menos de ${CALIDAD.minClasesHabla} clases con el % de habla del alumno.`, numeros);
  }
  return {
    score: r1(puntosHabla(med, medianaAcademia)),
    resumen: `El alumno habla una mediana de ${fmt(med)}% (academia ${fmt(medianaAcademia)}%), en ${n} clases`,
    numeros,
    eventos: [],
  };
}

// ── Ajustes, confianza y nivel ────────────────────────────────────────────────

function ajustesDe(teacherId: string, input: EntradaScore, desde: string): { total: number; eventos: string[] } {
  const evs = input.eventos.filter(e => {
    const d = fechaDe(e.createdAt);
    return e.teacherId === teacherId && !e.reverted && !!AJUSTES_MANUALES[e.eventType] && !!d && d >= desde && d <= input.hoy;
  }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const usados = new Map<string, number>();
  let total = 0;
  const eventos: string[] = [];
  for (const e of evs) {
    const cfg = AJUSTES_MANUALES[e.eventType];
    const n = usados.get(e.eventType) ?? 0;
    const fecha = ddmm(fechaDe(e.createdAt) as string);
    if (cfg.maxPorVentana !== null && n >= cfg.maxPorVentana) {
      eventos.push(`${cfg.etiqueta} del ${fecha}: no suma (máximo ${cfg.maxPorVentana} cada ${VENTANA_DIAS} días)`);
      continue;
    }
    usados.set(e.eventType, n + 1);
    total += cfg.puntos;
    eventos.push(`${cfg.etiqueta} del ${fecha}: ${cfg.puntos > 0 ? '+' : ''}${cfg.puntos}`);
  }
  return { total, eventos };
}

export function confianzaDe(alumnosMes: number, clases: number): ConfianzaV2 {
  if (alumnosMes >= CONFIANZA.alta.alumnosMes && clases >= CONFIANZA.alta.clases) return 'alta';
  if (alumnosMes >= CONFIANZA.media.alumnosMes) return 'media';
  return 'baja';
}

export function nivelDe(score: number | null, confianza: ConfianzaV2, diasDandoClases: number | null):
  { level: NivelV2; motivo: string } {
  if (score === null) return { level: 'En evaluación', motivo: 'Sin datos suficientes en ningún pilar' };
  if (confianza === 'baja') return { level: 'En evaluación', motivo: 'Confianza baja: todavía hay pocos datos' };
  if (diasDandoClases === null || diasDandoClases < NIVELES.diasMinimos) {
    return { level: 'En evaluación', motivo: `Menos de ${NIVELES.diasMinimos} días dando clases` };
  }
  if (score >= NIVELES.top) {
    if (confianza === 'alta') return { level: 'Top', motivo: `Puntaje ${fmt(score)} (Top desde ${NIVELES.top}, con confianza alta)` };
    return { level: 'Destacado', motivo: `Puntaje ${fmt(score)} de Top, pero Top pide confianza alta y es ${confianza}` };
  }
  if (score >= NIVELES.destacado) return { level: 'Destacado', motivo: `Puntaje ${fmt(score)} (Destacado desde ${NIVELES.destacado})` };
  if (score >= NIVELES.estandar) return { level: 'Estándar', motivo: `Puntaje ${fmt(score)} (Estándar desde ${NIVELES.estandar})` };
  return { level: 'En revisión', motivo: `Puntaje ${fmt(score)}, por debajo de ${NIVELES.estandar}. Es solo una marca: no bloquea nada` };
}

// ── 5) Crecimiento (preparado) ────────────────────────────────────────────────

/** Upsells, renovaciones... Todavía no se mide: devuelve null y pesa 0. */
export function pilarCrecimiento(): Metrica {
  return nula('Todavía no se mide', 'Pilar preparado para más adelante (peso 0).');
}

// ── El cálculo completo ───────────────────────────────────────────────────────

function armarPilar(m: Metrica, peso: number, partes?: Pilar['partes']): Pilar {
  return { ...m, peso, pesoEfectivo: 0, ...(partes ? { partes } : {}) };
}

/** Pilar compuesto por partes ponderadas (cumplimiento, calidad). */
function compuesto(
  partes: Record<string, Metrica>, subpesos: Record<string, number>, nombre: string,
): { metrica: Metrica; partes: NonNullable<Pilar['partes']> } {
  const conPeso = Object.fromEntries(Object.entries(partes).map(([k, m]) => [k, { ...m, subpeso: subpesos[k] ?? 0 }]));
  const score = ponderar(Object.values(conPeso).map(p => ({ score: p.score, peso: p.subpeso })));
  const conDato = Object.entries(conPeso).filter(([, p]) => p.score !== null).map(([k]) => k);
  return {
    partes: conPeso,
    metrica: score === null
      ? nula('Sin datos suficientes', `Ninguna parte de ${nombre} tiene datos suficientes.`)
      : {
        score: r1(score),
        resumen: conDato.length === Object.keys(partes).length
          ? 'Todas las partes con dato'
          : `Con dato: ${conDato.join(', ')}. El resto queda fuera y su peso se reparte.`,
        numeros: {}, eventos: [],
      },
  };
}

export function calcularScoringV2(input: EntradaScore): ResultadoScore {
  const { hoy } = input;
  const desde = addDaysIso(hoy, -(VENTANA_DIAS - 1));
  const exp = construirExposicion(input);

  // Tasa de bajas de la academia: todas las bajas sobre toda la exposición.
  let diasAcademia = 0;
  for (const t of exp.tramos) diasAcademia += diasEnVentana(t, desde, hoy);
  const alumnosMesAcademia = diasAcademia / RETENCION.diasPorAlumnoMes;
  const bajasAcademia = [...exp.bajasPorProfe.values()].reduce((s, b) => s + b.length, 0);
  const tasaAcademia = alumnosMesAcademia > 0 ? bajasAcademia / alumnosMesAcademia : null;

  const enVentana = (d: string | null | undefined) => !!d && d >= desde && d <= hoy;
  const ingresosVentana = input.ingresos.filter(l => enVentana(fechaValida(l.scheduledDate)));
  const analisisVentana = input.analisis.filter(a => enVentana(fechaValida(a.classDate)));
  const medianaHabla = mediana(analisisVentana.map(a => input.habla.get(a.id)).filter((x): x is number => typeof x === 'number'));
  // % de intervención de la academia: todas las auditorías de la ventana.
  const auditoriasVentana = input.auditorias.filter(a => enVentana(fechaDe(a.createdAt)));
  const intervencionAcademia = auditoriasVentana.length > 0
    ? auditoriasVentana.filter(a => a.signsOfIntervention === true).length / auditoriasVentana.length
    : null;

  const nombres = new Map(input.profesores.map(p => [p.id, p.name]));
  const duplicados = [...exp.duplicados.values()]
    .sort((a, b) => b.filas - a.filas)
    .map(d => `${d.studentName} (${nombres.get(d.teacherId) ?? d.teacherId}): ${d.filas} filas, ${d.descartadas} descartada(s)`);
  const descartadas = [...exp.duplicados.values()].reduce((s, d) => s + d.descartadas, 0);

  const profesores = input.profesores.map((p): ResultadoProfe => {
    const ingresos = ingresosVentana.filter(l => l.teacherId === p.id);
    const clases = sesionesDe(ingresos).size;

    const ret = pilarRetencion(p.id, exp, tasaAcademia, desde, hoy);
    const cumpl = compuesto({
      puntualidad: metricaPuntualidad(ingresos),
      transcripts: metricaTranscripts(p.id, ingresos, input),
      cancelaciones: metricaCancelaciones(p.id, clases, input, desde),
      enlaces: metricaEnlaces(p.id, input, exp, desde),
    }, CUMPLIMIENTO.subpesos, 'cumplimiento');
    const analisisProfe = analisisVentana.filter(a => a.teacherId === p.id);
    const cal = compuesto({
      senal: metricaSenal(analisisProfe),
      habla: metricaHabla(analisisProfe, input.habla, medianaHabla),
    }, CALIDAD.subpesos, 'calidad');

    const pilares: Record<PilarId, Pilar> = {
      retencion: armarPilar(ret, PESOS.retencion),
      cumplimiento: armarPilar(cumpl.metrica, PESOS.cumplimiento, cumpl.partes),
      riesgo: armarPilar(pilarRiesgo(p.id, auditoriasVentana, intervencionAcademia), PESOS.riesgo),
      calidad: armarPilar(cal.metrica, PESOS.calidad, cal.partes),
      crecimiento: armarPilar(pilarCrecimiento(), PESOS.crecimiento),
    };
    const lista = Object.values(pilares);
    const pesoConDato = lista.filter(x => x.score !== null && x.peso > 0).reduce((s, x) => s + x.peso, 0);
    for (const x of lista) x.pesoEfectivo = x.score !== null && pesoConDato > 0 ? r1((x.peso / pesoConDato) * 100) : 0;

    const scorePilares = ponderar(lista.map(x => ({ score: x.score, peso: x.peso })));
    const ajustes = ajustesDe(p.id, input, desde);
    const score = scorePilares === null ? null : r1(clamp(scorePilares + ajustes.total));

    // Desde cuándo está en la academia: lo más antiguo entre su alta y su primera
    // clase registrada. La plataforma registra clases recién desde fines de junio,
    // y los profes de siempre se dieron de alta todos juntos el 03/06/2026: sin el
    // alta, un profe veterano saldría "con menos de 90 días".
    const alta = fechaDe(p.createdAt);
    const clase = input.primeraClase.get(p.id) ?? null;
    const primera = alta && clase ? (alta < clase ? alta : clase) : (alta ?? clase);
    const diasDandoClases = primera ? diasEntre(primera, hoy) : null;
    const confidence = confianzaDe(ret.alumnosMes, clases);
    const { level, motivo } = nivelDe(score, confidence, diasDandoClases);

    const alumnosActivos = new Set(input.asignaciones
      .filter(a => a.teacherId === p.id && a.status === 'active')
      .filter(a => { const i = fechaValida(a.teacherSince) ?? fechaValida(a.startDate); return !i || i <= hoy; })
      .map(a => normName(a.studentName))).size;
    const totalCeldas = p.weeklyLoad + p.freeSpots;

    return {
      teacherId: p.id, teacherName: p.name,
      score, scorePilares: scorePilares === null ? null : r1(scorePilares),
      level, levelMotivo: motivo, confidence, pilares, ajustes,
      exposicion: { alumnosMes: r1(ret.alumnosMes), clases, alumnos: ret.alumnos, bajas: ret.bajas },
      experiencia: {
        alumnosActivos,
        horasSemanales: p.weeklyLoad,
        pctCalendarioOcupado: totalCeldas > 0 ? r1(pct(p.weeklyLoad, totalCeldas)) : null,
        primeraClase: primera ?? null,
        diasDandoClases,
        mesesEnAcademia: diasDandoClases === null ? null : Math.floor(diasDandoClases / 30),
      },
    };
  });

  return {
    academia: {
      formulaVersion: FORMULA_VERSION,
      ventana: { desde, hasta: hoy },
      tasaBajas: tasaAcademia === null ? null : r1(tasaAcademia * 1000) / 1000,
      bajas: bajasAcademia,
      alumnosMes: r1(alumnosMesAcademia),
      bajasDuplicadasDescartadas: descartadas,
      duplicados,
      medianaHabla,
      avisos: exp.avisos,
    },
    profesores,
  };
}

// ── La fila de teacher_score_snapshots ────────────────────────────────────────

export interface FilaSnapshot {
  teacher_id: string;
  snapshot_date: string;
  formula_version: string;
  score: number | null;
  level: NivelV2;
  confidence: ConfianzaV2;
  retention_score: number | null;
  compliance_score: number | null;
  risk_score: number | null;
  quality_score: number | null;
  growth_score: number | null;
  details: Record<string, unknown>;
}

/** Convierte un resultado en la fila que se guarda (details = todo el porqué). */
export function filaSnapshot(r: ResultadoProfe, academia: ResultadoAcademia, fecha: string): FilaSnapshot {
  return {
    teacher_id: r.teacherId,
    snapshot_date: fecha,
    formula_version: academia.formulaVersion,
    score: r.score,
    level: r.level,
    confidence: r.confidence,
    retention_score: r.pilares.retencion.score,
    compliance_score: r.pilares.cumplimiento.score,
    risk_score: r.pilares.riesgo.score,
    quality_score: r.pilares.calidad.score,
    growth_score: r.pilares.crecimiento.score,
    details: {
      teacherName: r.teacherName,
      scorePilares: r.scorePilares,
      levelMotivo: r.levelMotivo,
      pilares: r.pilares,
      ajustes: r.ajustes,
      exposicion: r.exposicion,
      experiencia: r.experiencia,
      academia: {
        ventana: academia.ventana, tasaBajas: academia.tasaBajas, bajas: academia.bajas,
        alumnosMes: academia.alumnosMes, medianaHabla: academia.medianaHabla,
        bajasDuplicadasDescartadas: academia.bajasDuplicadasDescartadas,
      },
    },
  };
}
