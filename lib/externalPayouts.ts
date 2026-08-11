// ── Gasto en profesores para el dashboard financiero externo ─────────────────
//
// Alimenta /api/external/payouts y /api/external/payouts/summary, que consume
// el proyecto drc-financial-dashboard.
//
// REGLA CENTRAL: el monto lo calcula `calculateTeacherFinance` (lib/finance.ts),
// la MISMA función que usan el panel de finanzas del admin y la vista del
// profesor. No se reimplementa nada acá. El motivo es el de siempre en este
// repo: dos definiciones de "cuánto se le debe" divergen, y la de afuera es la
// que nadie mira hasta que el número no cuadra. Por eso se descartó exponer una
// VIEW de Postgres — la liquidación cruza ocho tablas y aplica reglas (sesiones
// de 2h que valen una clase, tope de faltas cobrables, penalizaciones, mes
// congelado al pagarse) que no son expresables como una consulta.
//
// COSTE: el dataset se lee UNA vez por request (11 consultas) y sirve para
// todos los meses del rango. Calcular N meses no añade consultas, solo CPU: son
// 27 profesores × N meses de función pura. Por eso no hay cache persistente de
// meses cerrados — no habría nada que ahorrar salvo la lectura, que ya es única
// y está cacheada en memoria unos segundos (ver DATASET_TTL_MS).

import {
  dbGetTeachers, dbGetStudents, dbGetAssignments, dbGetScoringEvents,
  dbGetFinanceRates, dbGetFinancePayments, dbGetClassRecords, dbGetClassJoinLogs,
  dbGetManualApprovals, dbGetClassTranscripts, dbGetProductPrices,
} from '@/lib/db';
import { calculateTeacherFinance } from '@/lib/finance';
import { margenDe } from '@/lib/billing';
import { gridOccupancyOfTeacher } from '@/lib/teacherClasses';
import { madridToday } from '@/lib/subscriptionAccess';
import type {
  Teacher, Student, Assignment, ScoringEvent, FinanceRate, FinancePayment,
  ClassRecord, ClassJoinLog, FinanceManualApproval, ProductPrice,
} from '@/types';

// ── "Alumno activo" ──────────────────────────────────────────────────────────
//
// CRITERIO (validado con Facundo el 10/08/2026):
//
//   Un alumno cuenta como activo si
//     1. tiene un `assignment` con status = 'active' — es decir, sigue ocupando
//        al menos una celda en el calendario del profesor (ver
//        supabase-assignment-status.sql), y
//     2. existe en la tabla `students`, y
//     3. la base NO sabe que su acceso ya venció.
//
// El punto 3 merece explicación. La regla real de "activo" del sistema
// (lib/subscriptionAccess.accessOverrideOf) tiene tres orígenes: suscripción de
// WooCommerce vigente, activación manual vigente, u Oritalk vigente. Solo los
// dos últimos están en la base; el estado de la suscripción de Woo vive en la
// API de WooCommerce y habría que preguntarle alumno por alumno.
//
// Sobre los datos reales (10/08/2026): de 171 assignments activos, 129 dependen
// de Woo, 38 tienen activación manual vigente, 3 son de Oritalk vigente y 1 es
// de pago único sin activar. Así que se asume activo salvo prueba en contra, y
// la prueba en contra es lo único que la base puede acreditar sola: una fecha
// manual vencida, un Oritalk vencido o un pago único nunca activado.
//
// Margen de error medido: frente al criterio puramente estructural (sin el
// punto 3) la diferencia es de 1 alumno y CERO profesores — los dos criterios
// dan hoy 25 profesores activos de 27. Si algún día hace falta exactitud
// absoluta habría que consultar Woo por alumno, con el coste de latencia que
// eso implica; se decidió que no compensa para un gráfico de tendencia.
const VENCIDOS_CONOCIDOS = new Set(['manual_vencido', 'oritalk_vencido', 'one_time_sin_activar']);

type AccesoConocido =
  | 'oritalk_vigente' | 'oritalk_vencido'
  | 'manual_vigente'  | 'manual_vencido'
  | 'one_time_sin_activar' | 'depende_de_woo';

/** Lo que la BASE puede afirmar sobre el acceso de un alumno, sin llamar a Woo. */
export function accesoConocidoDe(s: Student, hoy: string): AccesoConocido {
  const vigente = (d?: string | null) => !!d && String(d).slice(0, 10) >= hoy;
  if (s.isOritalk) return vigente(s.oritalkUntil) ? 'oritalk_vigente' : 'oritalk_vencido';
  if (s.manualActiveUntil) return vigente(s.manualActiveUntil) ? 'manual_vigente' : 'manual_vencido';
  if (s.productType === 'one_time') return 'one_time_sin_activar';
  return 'depende_de_woo';
}

const nk = (s?: string | null): string => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// ── Dataset ──────────────────────────────────────────────────────────────────

export interface PayoutDataset {
  teachers: Teacher[];
  students: Student[];
  assignments: Assignment[];
  scoringEvents: ScoringEvent[];
  rates: FinanceRate[];
  payments: FinancePayment[];
  classRecords: ClassRecord[];
  joinLogs: ClassJoinLog[];
  manualApprovals: FinanceManualApproval[];
  classAnalyses: Awaited<ReturnType<typeof dbGetClassTranscripts>>;
  /** Profesores con ≥1 alumno activo AHORA (ver criterio arriba). */
  activeTeacherIds: Set<string>;
  /** Precios cargados a mano. [] si la tabla aún no existe: el gasto no depende de ellos. */
  productPrices: ProductPrice[];
  /** Alumnos activos de cada profesor, para la facturación. teacherId → alumnos. */
  rosterByTeacher: Map<string, Student[]>;
  loadedAt: number;
}

// Cache en memoria por instancia serverless. Corto a propósito: el mes en curso
// tiene que reflejar la clase que el profesor acaba de registrar, y 30 s no
// cambian eso para un dashboard, pero sí evitan releer 11 tablas cuando el
// gráfico pide varios rangos seguidos.
const DATASET_TTL_MS = 30_000;
let cached: PayoutDataset | null = null;

export async function loadPayoutDataset(force = false): Promise<PayoutDataset> {
  if (!force && cached && Date.now() - cached.loadedAt < DATASET_TTL_MS) return cached;

  const [
    teachers, students, assignments, scoringEvents,
    rates, payments, classRecords, joinLogs, manualApprovals, classAnalyses,
    productPrices,
  ] = await Promise.all([
    dbGetTeachers(), dbGetStudents(), dbGetAssignments(), dbGetScoringEvents(),
    dbGetFinanceRates(), dbGetFinancePayments(), dbGetClassRecords(), dbGetClassJoinLogs(),
    dbGetManualApprovals(), dbGetClassTranscripts(), dbGetProductPrices(),
  ]);

  const hoy = madridToday();

  // Índice de alumnos con el MISMO matching tolerante que usa el resto del
  // sistema (id → email → nombre): la mitad de los vínculos viejos no tienen
  // student_id, y emparejar solo por id daría profesores activos de menos.
  const byId = new Map(students.map(s => [s.id, s]));
  const byEmail = new Map(students.filter(s => s.email).map(s => [nk(s.email), s]));
  const byName = new Map(students.map(s => [nk(s.name), s]));

  const activeTeacherIds = new Set<string>();
  // Alumnos de cada profesor para la FACTURACIÓN. Se construye en el mismo
  // recorrido que `activeTeacherIds` y con el mismo emparejado tolerante: si se
  // armara aparte, "de quién es este alumno" tendría dos respuestas posibles y
  // acabarían discrepando, que es el problema que este repo ya tuvo con los
  // vínculos alumno→profesor.
  //
  // Se DEDUPLICA por id: un alumno con dos slots con el mismo profesor tiene dos
  // assignments, y contarlo dos veces duplicaría su cuota en la facturación.
  const rosterByTeacher = new Map<string, Student[]>();
  const seenPorProfesor = new Map<string, Set<string>>();

  for (const a of assignments) {
    if ((a.status ?? 'active') !== 'active') continue;
    const s = byId.get(a.studentId) ?? byEmail.get(nk(a.studentEmail)) ?? byName.get(nk(a.studentName));
    if (!s) continue;
    if (VENCIDOS_CONOCIDOS.has(accesoConocidoDe(s, hoy))) continue;
    activeTeacherIds.add(a.teacherId);

    const vistos = seenPorProfesor.get(a.teacherId) ?? new Set<string>();
    if (vistos.has(s.id)) continue;
    vistos.add(s.id);
    seenPorProfesor.set(a.teacherId, vistos);

    const arr = rosterByTeacher.get(a.teacherId) ?? [];
    arr.push(s);
    rosterByTeacher.set(a.teacherId, arr);
  }

  cached = {
    teachers, students, assignments, scoringEvents, rates, payments,
    classRecords, joinLogs, manualApprovals, classAnalyses,
    activeTeacherIds, productPrices, rosterByTeacher, loadedAt: Date.now(),
  };
  return cached;
}

// ── Cálculo por mes ──────────────────────────────────────────────────────────

export type PayoutStatus = 'paid' | 'pending' | 'en_curso';

/** Fila por profesor. Solo id y nombre: nada de email, usuario ni contraseña. */
export interface TeacherPayout {
  teacher_id: string;
  teacher_name: string;
  month_year: string;
  total_amount: number;
  classes_payable: number;
  status: PayoutStatus;
  is_active: boolean;

  // ── Facturación y margen (añadido 11/08/2026) ──────────────────────────────
  //
  // Dependen de `product_prices`, que se carga A MANO. Mientras esté vacía —o no
  // exista— todo esto sale en 0/null y `total_amount` sigue funcionando igual:
  // el gasto en profesores no depende de los precios.

  /** Suma de lo que facturan sus alumnos ese mes. 0 si no hay ningún precio. */
  facturacion: number;
  /** facturacion − total_amount. null si NINGÚN alumno tiene precio resuelto. */
  margen: number | null;
  alumnos_con_precio: number;
  alumnos_totales: number;
  /**
   * true = falta el precio de al menos un alumno, así que `facturacion` es un
   * PISO y `margen` está inflado. El dashboard tiene que avisarlo de forma
   * visible: un margen parcial presentado como definitivo es peor que no darlo.
   */
  facturacion_parcial: boolean;
}

export interface MonthPayouts {
  month_year: string;
  is_current_month: boolean;
  total_amount: number;
  /** Profesores que facturaron algo ESE mes. Es el número histórico real. */
  teachers_with_amount: number;
  /**
   * Profesores con ≥1 alumno activo AHORA MISMO. Es una foto del presente, no
   * del mes: en una serie histórica sale igual en todos los puntos. El nombre
   * lleva `_now` para que nadie lo grafique creyendo que es evolución — para eso
   * está `teachers_with_amount`.
   */
  active_teachers_now: number;

  /** Facturación del mes = suma de la de todos los profesores. */
  facturacion_total: number;
  /** facturacion_total − total_amount. null si ningún profesor tiene facturación. */
  margen_total: number | null;
  /** true si a CUALQUIER profesor le falta el precio de algún alumno. */
  facturacion_parcial: boolean;

  teachers: TeacherPayout[];
}

/** 'YYYY-MM' del mes en curso en hora de España (las clases son en Madrid). */
export function currentMonthYear(): string {
  return madridToday().slice(0, 7);
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Liquidación de TODOS los profesores para un mes. Función pura sobre el dataset. */
export function computeMonth(ds: PayoutDataset, monthYear: string): MonthPayouts {
  const isCurrent = monthYear === currentMonthYear();

  const teachers: TeacherPayout[] = ds.teachers.map(t => {
    const payment = ds.payments.find(p => p.teacherId === t.id && p.monthYear === monthYear) ?? null;

    // MISMAS entradas que app/finanzas y que la vista del profesor. Si esta
    // llamada recibiera menos, el dashboard mostraría un número que no coincide
    // con el que el admin tiene delante.
    const r = calculateTeacherFinance({
      teacherId: t.id, teacherName: t.name, monthYear,
      assignments: ds.assignments,
      joinLogs: ds.joinLogs,
      classRecords: ds.classRecords,
      classAnalyses: ds.classAnalyses,
      rates: ds.rates,
      scoringEvents: ds.scoringEvents,
      students: ds.students,
      manualApprovals: ds.manualApprovals,
      payment,
      gridOccupancy: gridOccupancyOfTeacher(t),
    });

    const status: PayoutStatus =
      r.paymentStatus === 'paid' ? 'paid' : isCurrent ? 'en_curso' : 'pending';

    const totalAmount = round2(r.totalAPagar);

    // Alumnos que ya existían en el mes que se pide. Sin este filtro, un alumno
    // dado de alta en agosto facturaría también en los meses de junio y julio de
    // una serie histórica, y el margen de meses ya cerrados cambiaría solo porque
    // el profesor sumó alumnos después.
    const roster = (ds.rosterByTeacher.get(t.id) ?? [])
      .filter(s => !s.createdAt || s.createdAt.slice(0, 7) <= monthYear);

    const m = margenDe({
      students: roster,
      monthYear,
      prices: ds.productPrices,
      totalAPagar: totalAmount,
    });

    return {
      teacher_id: t.id,
      teacher_name: t.name,
      month_year: monthYear,
      total_amount: totalAmount,
      classes_payable: r.totalPagable,
      status,
      is_active: ds.activeTeacherIds.has(t.id),
      facturacion: m.facturacion,
      margen: m.margen,
      alumnos_con_precio: m.alumnosConPrecio,
      alumnos_totales: m.alumnosTotales,
      facturacion_parcial: m.facturacionParcial,
    };
  });

  const totalAmount = round2(teachers.reduce((s, t) => s + t.total_amount, 0));
  const facturacionTotal = round2(teachers.reduce((s, t) => s + t.facturacion, 0));
  // Ningún profesor con precio resuelto → no hay margen que dar. Es el caso de
  // `product_prices` vacía: sin esto, el mes entero saldría con un margen
  // negativo igual al gasto, como si la academia no facturara nada.
  const algunPrecio = teachers.some(t => t.alumnos_con_precio > 0);

  return {
    month_year: monthYear,
    is_current_month: isCurrent,
    total_amount: totalAmount,
    teachers_with_amount: teachers.filter(t => t.total_amount !== 0).length,
    active_teachers_now: teachers.filter(t => t.is_active).length,
    facturacion_total: facturacionTotal,
    margen_total: algunPrecio ? round2(facturacionTotal - totalAmount) : null,
    facturacion_parcial: teachers.some(t => t.facturacion_parcial),
    teachers: teachers.sort((a, b) => b.total_amount - a.total_amount || a.teacher_name.localeCompare(b.teacher_name, 'es')),
  };
}

// ── Utilidades de mes ────────────────────────────────────────────────────────

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isValidMonth(m: string | null | undefined): m is string {
  return !!m && MONTH_RE.test(m);
}

/** Lista inclusiva de meses entre `from` y `to`. Devuelve [] si el rango se invierte. */
export function monthRange(from: string, to: string): string[] {
  if (from > to) return [];
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  for (let guard = 0; guard < 600; guard++) {   // tope duro: 50 años
    const cur = `${y}-${String(m).padStart(2, '0')}`;
    out.push(cur);
    if (cur === to) break;
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}
