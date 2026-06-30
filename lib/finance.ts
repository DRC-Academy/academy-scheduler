// Lógica de cálculo de finanzas (liquidación de clases a profesores).
//
// Funciona sobre datos ya cargados en memoria (assignments, class_join_logs,
// class_records, finance_rates, scoring_events) para poder correr tanto en el
// panel del profesor como en el del admin sin llamadas extra a la base.

import { Assignment, ClassJoinLog, ClassRecord, FinanceRate, ScoringEvent, FinancePayment } from '@/types';

// Nombres de día por getDay() (0=Domingo) — coinciden con los slots ('Lunes'...).
const DAY_NAMES_BY_JSDAY = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

// Límite de clases pagables por mes según horas semanales contratadas.
const MONTHLY_LIMIT_BY_WEEKLY_HOURS: Record<number, number> = {
  1: 5, 2: 9, 3: 14, 4: 18, 5: 25,
};
function monthlyLimit(weeklyHours: number): number {
  return MONTHLY_LIMIT_BY_WEEKLY_HOURS[weeklyHours] ?? Math.max(5, weeklyHours * 5);
}

const DAY_MS = 24 * 60 * 60 * 1000;

export type ClassFinanceStatus = 'pagable' | 'a_revisar' | 'excede_limite';

export interface ClassFinanceRow {
  date: string;            // 'YYYY-MM-DD'
  hour: string;            // 'HH:MM' del slot recurrente
  studentName: string;
  plan: string;
  weeklyHours: number;
  antiquityDays: number;
  rate: number;
  status: ClassFinanceStatus;
  hasJoinLog: boolean;
  hasScreenshot: boolean;
}

export interface TeacherFinanceResult {
  teacherId: string;
  teacherName: string;
  monthYear: string;
  rows: ClassFinanceRow[];
  totalPagable: number;
  totalARevisar: number;
  totalExcedeLimite: number;
  montoPagable: number;
  montoARevisar: number;
  montoRetenido: number;
  bonusFromScoring: number;
  totalAPagar: number;
  paymentStatus: 'pending' | 'paid';
  paidAt?: string;
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Diferencia en días naturales entre dos fechas 'YYYY-MM-DD' (b - a).
function daysBetween(aIso: string, bIso: string): number {
  const a = new Date(aIso + 'T00:00:00');
  const b = new Date(bIso + 'T00:00:00');
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

// Normaliza un nombre para comparar (trim + lower).
function nkey(x: string): string { return (x ?? '').trim().toLowerCase(); }

// 'examen' en plan u objetivo → 'examenes'; cualquier otro caso → 'general'.
export function resolvePlanType(plan: string, objetivo?: string): 'general' | 'examenes' {
  const haystack = `${plan ?? ''} ${objetivo ?? ''}`.toLowerCase();
  return haystack.includes('examen') ? 'examenes' : 'general';
}

function findRate(rates: FinanceRate[], planType: 'general' | 'examenes', tier: 'nuevo' | 'antiguo'): number {
  return rates.find(r => r.planType === planType && r.tier === tier)?.rate ?? 0;
}

// Expande los slots recurrentes de una assignment a fechas concretas dentro del
// mes 'YYYY-MM'. Solo incluye fechas iguales o posteriores a su start_date.
function expandAssignmentDates(a: Assignment, monthYear: string): Array<{ date: string; hour: string }> {
  const [y, m] = monthYear.split('-').map(Number);
  if (!y || !m) return [];
  const out: Array<{ date: string; hour: string }> = [];
  const daysInMonth = new Date(y, m, 0).getDate();
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(y, m - 1, day);
    const dateIso = isoDate(d);
    if (a.startDate && dateIso < a.startDate) continue;
    const dayName = DAY_NAMES_BY_JSDAY[d.getDay()];
    for (const slot of a.slots ?? []) {
      if (slot.day === dayName) out.push({ date: dateIso, hour: slot.hour });
    }
  }
  return out;
}

export interface CalcInput {
  teacherId: string;
  teacherName: string;
  monthYear: string;                 // 'YYYY-MM'
  assignments: Assignment[];         // todas (se filtran por teacher adentro)
  joinLogs: ClassJoinLog[];
  classRecords: ClassRecord[];
  rates: FinanceRate[];
  scoringEvents: ScoringEvent[];
  payment?: FinancePayment | null;   // si existe y está 'paid' → congelado
}

// Calcula la liquidación de UN profesor para un mes.
export function calculateTeacherFinance(input: CalcInput): TeacherFinanceResult {
  const { teacherId, teacherName, monthYear, assignments, joinLogs, classRecords, rates, scoringEvents, payment } = input;

  const overrides = new Set(payment?.approvedOverrides ?? []);
  const myAssignments = assignments.filter(a => a.teacherId === teacherId);

  // Pre-indexar logs y records de este profesor para matching rápido.
  const myLogs = joinLogs.filter(l => l.teacherId === teacherId);
  const myRecords = classRecords.filter(r => r.teacherId === teacherId);

  function hasJoinLog(student: string, dateIso: string): boolean {
    return myLogs.some(l => l.studentName === student && l.scheduledDate === dateIso);
  }
  function hasScreenshot(student: string, dateIso: string): boolean {
    // tolerancia ±1 día
    return myRecords.some(r =>
      r.studentName === student && Math.abs(daysBetween(r.classDate, dateIso)) <= 1
    );
  }

  // 1) Generar todas las filas candidatas (que pasan el paso 1).
  interface Draft extends ClassFinanceRow { overrideKey: string; }
  const drafts: Draft[] = [];

  for (const a of myAssignments) {
    const planType = resolvePlanType(a.plan, a.objetivo);
    for (const { date, hour } of expandAssignmentDates(a, monthYear)) {
      const join = hasJoinLog(a.studentName, date);
      const shot = hasScreenshot(a.studentName, date);
      if (!join && !shot) continue; // ninguno de los dos → se ignora por completo

      const antiquityDays = a.startDate ? Math.max(0, daysBetween(a.startDate, date)) : 0;
      const tier: 'nuevo' | 'antiguo' = antiquityDays < 30 ? 'nuevo' : 'antiguo';
      const rate = findRate(rates, planType, tier);
      const status: ClassFinanceStatus = (join && shot) ? 'pagable' : 'a_revisar';

      drafts.push({
        date, hour, studentName: a.studentName, plan: a.plan ?? '',
        weeklyHours: a.weeklyHours ?? 0, antiquityDays, rate, status,
        hasJoinLog: join, hasScreenshot: shot,
        overrideKey: `${a.studentName}__${date}`,
      });
    }
  }

  // 2) Aplicar límite mensual por alumno (sobre clases pagable/a_revisar, en orden de fecha).
  const limitByStudent = new Map<string, number>();
  for (const a of myAssignments) limitByStudent.set(a.studentName, monthlyLimit(a.weeklyHours ?? 0));

  drafts.sort((x, y) => x.date.localeCompare(y.date) || x.studentName.localeCompare(y.studentName));

  const countByStudent = new Map<string, number>();
  for (const row of drafts) {
    const limit = limitByStudent.get(row.studentName) ?? 5;
    const used = countByStudent.get(row.studentName) ?? 0;
    if (used + 1 > limit) {
      row.status = 'excede_limite';
    } else {
      countByStudent.set(row.studentName, used + 1);
    }
  }

  // 3) Aplicar aprobaciones manuales del admin (fuerzan a pagable / inclusión).
  for (const row of drafts) {
    if (overrides.has(row.overrideKey)) row.status = 'pagable';
  }

  const rows: ClassFinanceRow[] = drafts.map(({ overrideKey, ...r }) => r);

  // 3b) HISTORIAL DE EX-ALUMNOS — clases con ingreso y/o captura de alumnos que
  //     ya NO tienen assignment activa con este profesor (fueron eliminados).
  //     Sus clases ya dadas deben seguir contando para el pago. Como no hay
  //     assignment, la antigüedad se aproxima con la primera clase conocida del
  //     alumno y el plan se asume 'general'. Las clases POSTERIORES a la baja no
  //     existen (sin log ni captura) → no se incluyen, automáticamente.
  const activeNames = new Set(myAssignments.map(a => nkey(a.studentName)));
  const inMonth = (d: string) => (d ?? '').slice(0, 7) === monthYear;

  // Primera fecha conocida por alumno (proxy de inicio), sobre logs + records.
  const firstDateByStudent = new Map<string, string>();
  const noteFirst = (name: string, date: string) => {
    const k = nkey(name);
    const cur = firstDateByStudent.get(k);
    if (!cur || date < cur) firstDateByStudent.set(k, date);
  };
  for (const l of myLogs) noteFirst(l.studentName, l.scheduledDate);
  for (const r of myRecords) noteFirst(r.studentName, r.classDate);

  // Candidatos (alumno+fecha) del mes que NO pertenecen a un alumno activo.
  const orphanCandidates = new Map<string, { studentName: string; date: string; hour: string }>();
  const addOrphan = (studentName: string, date: string, hour: string) => {
    if (!inMonth(date) || activeNames.has(nkey(studentName))) return;
    const key = `${nkey(studentName)}__${date}`;
    if (!orphanCandidates.has(key)) orphanCandidates.set(key, { studentName, date, hour });
  };
  for (const l of myLogs) addOrphan(l.studentName, l.scheduledDate, l.scheduledTime ?? '');
  for (const r of myRecords) addOrphan(r.studentName, r.classDate, r.classTime ?? '');

  for (const { studentName, date, hour } of orphanCandidates.values()) {
    const join = hasJoinLog(studentName, date);
    const shot = hasScreenshot(studentName, date);
    if (!join && !shot) continue;
    const proxyStart = firstDateByStudent.get(nkey(studentName));
    const antiquityDays = proxyStart ? Math.max(0, daysBetween(proxyStart, date)) : 0;
    const tier: 'nuevo' | 'antiguo' = antiquityDays < 30 ? 'nuevo' : 'antiguo';
    const rate = findRate(rates, 'general', tier);
    const status: ClassFinanceStatus =
      overrides.has(`${studentName}__${date}`) ? 'pagable' : (join && shot) ? 'pagable' : 'a_revisar';
    rows.push({ date, hour, studentName, plan: '', weeklyHours: 0, antiquityDays, rate, status, hasJoinLog: join, hasScreenshot: shot });
  }

  // 4) Agregados.
  const pagables = rows.filter(r => r.status === 'pagable');
  const revisar  = rows.filter(r => r.status === 'a_revisar');
  const excede   = rows.filter(r => r.status === 'excede_limite');

  const montoPagable  = pagables.reduce((s, r) => s + r.rate, 0);
  const montoARevisar = revisar.reduce((s, r) => s + r.rate, 0);
  const montoRetenido = excede.reduce((s, r) => s + r.rate, 0);

  const bonusFromScoring = scoringEvents
    .filter(e => e.teacherId === teacherId && (e.euros ?? 0) > 0 && (e.createdAt ?? '').slice(0, 7) === monthYear)
    .reduce((s, e) => s + (e.euros ?? 0), 0);

  let totalAPagar = montoPagable + bonusFromScoring;

  // Si el mes ya fue pagado, congelamos los totales guardados.
  let paymentStatus: 'pending' | 'paid' = 'pending';
  let paidAt: string | undefined;
  if (payment?.status === 'paid') {
    paymentStatus = 'paid';
    paidAt = payment.paidAt;
    totalAPagar = payment.totalAmount;
  }

  return {
    teacherId, teacherName, monthYear, rows,
    totalPagable: pagables.length,
    totalARevisar: revisar.length,
    totalExcedeLimite: excede.length,
    montoPagable, montoARevisar, montoRetenido,
    bonusFromScoring, totalAPagar,
    paymentStatus, paidAt,
  };
}

// Verificación visible para el profesor (sección "Mis clases").
export function recordVerification(
  studentName: string, classDate: string, joinLogs: ClassJoinLog[], teacherId: string,
): 'detected' | 'not_detected' {
  const found = joinLogs.some(l =>
    l.teacherId === teacherId &&
    l.studentName === studentName &&
    Math.abs(daysBetween(l.scheduledDate, classDate)) <= 1
  );
  return found ? 'detected' : 'not_detected';
}
