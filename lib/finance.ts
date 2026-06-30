// Lógica de cálculo de finanzas (liquidación de clases a profesores).
//
// Funciona sobre datos ya cargados en memoria (assignments, class_join_logs,
// class_records, finance_rates, scoring_events, students, manual_approvals) para
// poder correr tanto en el panel del profesor como en el del admin sin llamadas
// extra a la base.
//
// REGLA DEL DOBLE FACTOR (inclusión de una clase de tipo cobrable):
//   · Sin class_join_logs Y sin class_records → se IGNORA (no se cuenta).
//   · Con AL MENOS uno de los dos → se incluye.
//       - Ambos                → 'pagable' ✅
//       - Solo uno             → 'a_revisar' ⚠️
//   · Aprobada manualmente por el admin → 'pagable' (override).
//   · Supera el límite mensual del plan → 'excede_limite' (salvo aprobación).
//   · Tipo 'falta_sin_aviso' o 'cancelacion_hora' → 'no_cobrable' (constancia,
//     nunca suma al total, independientemente de logs/capturas).

import { Assignment, ClassJoinLog, ClassRecord, FinanceRate, ScoringEvent, FinancePayment, Student, ClassRecordType, FinanceManualApproval } from '@/types';

const DAY_NAMES_BY_JSDAY = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

const MONTHLY_LIMIT_BY_WEEKLY_HOURS: Record<number, number> = { 1: 5, 2: 9, 3: 14, 4: 18, 5: 25 };
function monthlyLimit(weeklyHours: number): number {
  return MONTHLY_LIMIT_BY_WEEKLY_HOURS[weeklyHours] ?? Math.max(5, weeklyHours * 5);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// 'excede_limite_tipo' = falta/cancelación más allá de las 2 cobrables por tipo.
export type ClassFinanceStatus = 'pagable' | 'a_revisar' | 'excede_limite' | 'excede_limite_tipo' | 'no_cobrable';

export interface ClassFinanceRow {
  date: string;            // 'YYYY-MM-DD'
  hour: string;            // 'HH:MM'
  studentName: string;
  plan: string;            // plan resuelto (assignments → objetivo → students → 'Inglés general')
  weeklyHours: number;
  antiquityDays: number;
  rate: number;
  status: ClassFinanceStatus;
  classType: ClassRecordType;
  hasJoinLog: boolean;
  hasScreenshot: boolean;  // captura REAL (tipo normal/recuperacion con screenshot)
  hasMeetLink: boolean;    // la assignment del alumno tiene meet_link definido
  punctuality?: 'on_time' | 'late' | 'very_late';
  manuallyApproved: boolean;
  subscriptionStatus?: string;  // efectivo: join log (momento de la clase) → record
  subAtJoin?: string;           // estado al ingresar (class_join_logs)
  subAtRecord?: string;         // estado al registrar la captura (class_records)
}

export interface TeacherFinanceResult {
  teacherId: string;
  teacherName: string;
  monthYear: string;
  rows: ClassFinanceRow[];
  totalPagable: number;
  totalARevisar: number;
  totalExcedeLimite: number;
  totalExcedeLimiteTipo: number;
  totalNoCobrable: number;
  hasInactiveSubPayable: boolean; // alguna clase pagable tuvo suscripción ≠ active
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
function daysBetween(aIso: string, bIso: string): number {
  return Math.round((new Date(bIso + 'T00:00:00').getTime() - new Date(aIso + 'T00:00:00').getTime()) / DAY_MS);
}
function nkey(x: string): string { return (x ?? '').trim().toLowerCase(); }
function firstNonEmpty(...vals: Array<string | undefined>): string {
  for (const v of vals) { if (v && v.trim()) return v.trim(); }
  return '';
}

// 'examen' en plan u objetivo → 'examenes'; cualquier otro caso → 'general'.
export function resolvePlanType(plan: string, objetivo?: string): 'general' | 'examenes' {
  return `${plan ?? ''} ${objetivo ?? ''}`.toLowerCase().includes('examen') ? 'examenes' : 'general';
}

function findRate(rates: FinanceRate[], planType: 'general' | 'examenes', tier: 'nuevo' | 'antiguo'): number {
  return rates.find(r => r.planType === planType && r.tier === tier)?.rate ?? 0;
}

// Hora del slot recurrente del alumno que cae en el día de `dateIso` (si la hay).
function slotHourForDate(a: Assignment | undefined, dateIso: string): string {
  if (!a) return '';
  const dayName = DAY_NAMES_BY_JSDAY[new Date(dateIso + 'T00:00:00').getDay()];
  return (a.slots ?? []).find(s => s.day === dayName)?.hour ?? '';
}

export interface CalcInput {
  teacherId: string;
  teacherName: string;
  monthYear: string;                 // 'YYYY-MM'
  assignments: Assignment[];         // se filtran por teacher adentro
  joinLogs: ClassJoinLog[];
  classRecords: ClassRecord[];
  rates: FinanceRate[];
  scoringEvents: ScoringEvent[];
  students?: Student[];              // para el fallback de plan
  manualApprovals?: FinanceManualApproval[];
  payment?: FinancePayment | null;   // si existe y está 'paid' → congelado
}

// Calcula la liquidación de UN profesor para un mes.
export function calculateTeacherFinance(input: CalcInput): TeacherFinanceResult {
  const {
    teacherId, teacherName, monthYear, assignments, joinLogs, classRecords,
    rates, scoringEvents, students = [], manualApprovals = [], payment,
  } = input;

  const myAssignments = assignments.filter(a => a.teacherId === teacherId);
  const myLogs = joinLogs.filter(l => l.teacherId === teacherId);
  const myRecords = classRecords.filter(r => r.teacherId === teacherId);

  // Índices por nombre (normalizado).
  const asgnByName = new Map<string, Assignment>();
  for (const a of myAssignments) if (!asgnByName.has(nkey(a.studentName))) asgnByName.set(nkey(a.studentName), a);
  const studentByName = new Map<string, Student>();
  for (const s of students) studentByName.set(nkey(s.name), s);

  // Aprobaciones manuales: tabla finance_manual_approvals + legacy approved_overrides.
  const approvedSet = new Set<string>();
  for (const k of payment?.approvedOverrides ?? []) approvedSet.add(k);
  for (const m of manualApprovals) {
    if (m.teacherId !== teacherId) continue;
    approvedSet.add(`${m.studentName}__${m.classDate}`);
    approvedSet.add(`${nkey(m.studentName)}__${m.classDate}`);
  }
  const isApproved = (name: string, date: string) =>
    approvedSet.has(`${name}__${date}`) || approvedSet.has(`${nkey(name)}__${date}`);

  const inMonth = (d: string) => (d ?? '').slice(0, 7) === monthYear;

  // Primera fecha conocida por alumno (proxy de inicio para ex-alumnos).
  const firstDateByStudent = new Map<string, string>();
  const noteFirst = (name: string, date: string) => {
    const k = nkey(name); const cur = firstDateByStudent.get(k);
    if (!cur || date < cur) firstDateByStudent.set(k, date);
  };
  for (const l of myLogs) noteFirst(l.studentName, l.scheduledDate);
  for (const r of myRecords) noteFirst(r.studentName, r.classDate);

  // Faltas/cancelaciones cobrables: las primeras 2 de CADA tipo por alumno
  // (acumulativo de TODO el historial, ordenadas por fecha de creación).
  const cobrableTypeRecordIds = new Set<string>();
  const byStudentType = new Map<string, ClassRecord[]>();
  for (const r of myRecords) {
    if (r.classType !== 'falta_sin_aviso' && r.classType !== 'cancelacion_hora') continue;
    const k = `${nkey(r.studentName)}__${r.classType}`;
    const arr = byStudentType.get(k);
    if (arr) arr.push(r); else byStudentType.set(k, [r]);
  }
  for (const arr of byStudentType.values()) {
    arr.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.classDate.localeCompare(b.classDate));
    arr.slice(0, 2).forEach(r => cobrableTypeRecordIds.add(r.id));
  }

  // Candidatos (alumno + fecha) del mes: provienen de los logs y los records
  // (las únicas fuentes de "esta clase ocurrió"). Un record se fusiona con un
  // candidato del mismo alumno a ±1 día (tolerancia captura subida un día corrido).
  interface Cand { studentName: string; date: string; log?: ClassJoinLog; record?: ClassRecord; }
  const cands: Cand[] = [];
  const findCand = (student: string, date: string, tol: number) =>
    cands.find(c => nkey(c.studentName) === nkey(student) && Math.abs(daysBetween(c.date, date)) <= tol);

  for (const l of myLogs) {
    if (!inMonth(l.scheduledDate)) continue;
    let c = findCand(l.studentName, l.scheduledDate, 0);
    if (!c) { c = { studentName: l.studentName, date: l.scheduledDate }; cands.push(c); }
    c.log = l;
  }
  for (const r of myRecords) {
    if (!inMonth(r.classDate)) continue;
    let c = findCand(r.studentName, r.classDate, 1);
    if (!c) { c = { studentName: r.studentName, date: r.classDate }; cands.push(c); }
    if (!c.record) c.record = r;
  }

  // Construir las filas.
  const rows: ClassFinanceRow[] = [];
  for (const c of cands) {
    const a = asgnByName.get(nkey(c.studentName));
    const stu = studentByName.get(nkey(c.studentName));
    const record = c.record;
    const log = c.log;

    const classType: ClassRecordType = (record?.classType as ClassRecordType) ?? 'normal';
    const join = !!log;
    const punctuality = log?.punctuality;
    const isNormalType = classType === 'normal' || classType === 'recuperacion';
    const isFaltaType  = classType === 'falta_sin_aviso' || classType === 'cancelacion_hora';
    const isCapture = !!record && isNormalType && !!record.screenshotUrl;
    const hasMeetLink = !!(a?.meetLink && a.meetLink.trim());

    // Plan: productName de WooCommerce (principal) → assignments.plan → objetivo
    // → students.plan → 'Inglés general'.
    const plan = firstNonEmpty(stu?.productName, a?.plan, a?.objetivo, stu?.plan) || 'Inglés general';
    const planType: 'general' | 'examenes' =
      `${stu?.productName ?? ''} ${a?.plan ?? ''} ${a?.objetivo ?? ''} ${stu?.plan ?? ''}`.toLowerCase().includes('examen') ? 'examenes' : 'general';

    const start = a?.startDate ?? firstDateByStudent.get(nkey(c.studentName));
    const antiquityDays = start ? Math.max(0, daysBetween(start, c.date)) : 0;
    const tier: 'nuevo' | 'antiguo' = antiquityDays < 30 ? 'nuevo' : 'antiguo';
    const rate = findRate(rates, planType, tier);  // tarifa normal del alumno (también para faltas)
    const weeklyHours = a?.weeklyHours ?? 0;
    const hour = firstNonEmpty(log?.scheduledTime, record?.classTime, slotHourForDate(a, c.date));

    // Estado de suscripción: prioriza el del join log (momento real de la clase).
    const subAtJoin = log?.subscriptionStatus;
    const subAtRecord = record?.subscriptionStatus;
    const subscriptionStatus = subAtJoin ?? subAtRecord;

    const approved = isApproved(c.studentName, c.date);

    let status: ClassFinanceStatus;
    if (isFaltaType) {
      // Falta/cancelación: cobrable si es de las primeras 2 de ese tipo (o aprobada).
      const within2 = !!record && cobrableTypeRecordIds.has(record.id);
      status = (approved || within2) ? 'pagable' : 'excede_limite_tipo';
    } else if (approved) {
      status = 'pagable';
    } else {
      status = (join && isCapture) ? 'pagable' : 'a_revisar';
    }

    rows.push({
      date: c.date, hour, studentName: c.studentName, plan, weeklyHours, antiquityDays, rate, status,
      classType, hasJoinLog: join, hasScreenshot: isCapture, hasMeetLink, punctuality, manuallyApproved: approved,
      subscriptionStatus, subAtJoin, subAtRecord,
    });
  }

  // Límite mensual por alumno (solo clases cobrables normal/recuperacion). Las
  // aprobadas manualmente nunca pasan a 'excede_limite'.
  const limitByStudent = new Map<string, number>();
  for (const a of myAssignments) limitByStudent.set(nkey(a.studentName), monthlyLimit(a.weeklyHours ?? 0));

  // El límite mensual aplica solo a clases normales/recuperación (las faltas
  // tienen su propio límite de 2 por tipo).
  const countable = rows
    .filter(r => (r.status === 'pagable' || r.status === 'a_revisar') && (r.classType === 'normal' || r.classType === 'recuperacion'))
    .sort((x, y) => x.date.localeCompare(y.date) || x.studentName.localeCompare(y.studentName));
  const usedByStudent = new Map<string, number>();
  for (const row of countable) {
    const k = nkey(row.studentName);
    const limit = limitByStudent.has(k) ? limitByStudent.get(k)! : Infinity; // ex-alumnos: sin límite
    const used = usedByStudent.get(k) ?? 0;
    if (used + 1 > limit && !row.manuallyApproved) {
      row.status = 'excede_limite';
    } else {
      usedByStudent.set(k, used + 1);
    }
  }

  rows.sort((x, y) => x.date.localeCompare(y.date) || x.studentName.localeCompare(y.studentName));

  // Agregados (punto 6).
  const pagables   = rows.filter(r => r.status === 'pagable');      // normal/recuperacion + faltas cobrables
  const revisar    = rows.filter(r => r.status === 'a_revisar');
  const excede     = rows.filter(r => r.status === 'excede_limite');
  const excedeTipo = rows.filter(r => r.status === 'excede_limite_tipo');
  const noCobrable = rows.filter(r => r.status === 'no_cobrable');

  const montoPagable  = pagables.reduce((s, r) => s + r.rate, 0);
  const montoARevisar = revisar.reduce((s, r) => s + r.rate, 0);
  const montoRetenido = excede.reduce((s, r) => s + r.rate, 0) + excedeTipo.reduce((s, r) => s + r.rate, 0);

  // Alerta: ¿alguna clase pagable tuvo suscripción ≠ active al momento de darse?
  const hasInactiveSubPayable = pagables.some(r => r.subscriptionStatus && r.subscriptionStatus !== 'active');

  const bonusFromScoring = scoringEvents
    .filter(e => e.teacherId === teacherId && (e.euros ?? 0) > 0 && (e.createdAt ?? '').slice(0, 7) === monthYear)
    .reduce((s, e) => s + (e.euros ?? 0), 0);

  let totalAPagar = montoPagable + bonusFromScoring;

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
    totalExcedeLimiteTipo: excedeTipo.length,
    totalNoCobrable: noCobrable.length,
    hasInactiveSubPayable,
    montoPagable, montoARevisar, montoRetenido,
    bonusFromScoring, totalAPagar,
    paymentStatus, paidAt,
  };
}

// Verificación visible para el profesor (sección "Mis clases"): ¿hubo ingreso?
export function recordVerification(
  studentName: string, classDate: string, joinLogs: ClassJoinLog[], teacherId: string,
): 'detected' | 'not_detected' {
  const found = joinLogs.some(l =>
    l.teacherId === teacherId &&
    nkey(l.studentName) === nkey(studentName) &&
    Math.abs(daysBetween(l.scheduledDate, classDate)) <= 1
  );
  return found ? 'detected' : 'not_detected';
}

// Etiqueta de la columna "INGRESO" (punto 3) — estado + color por puntualidad.
export function ingresoBadge(row: { hasJoinLog: boolean; punctuality?: string; hasMeetLink: boolean }):
  { label: string; color: string; bg: string } {
  if (row.hasJoinLog) {
    if (row.punctuality === 'on_time')   return { label: '✅ A tiempo',  color: '#1E9E3A', bg: 'rgba(30,158,58,0.1)' };
    if (row.punctuality === 'late')      return { label: '⚠️ Tarde',     color: '#b45309', bg: 'rgba(255,196,0,0.18)' };
    if (row.punctuality === 'very_late') return { label: '🔴 Muy tarde', color: '#dc2626', bg: 'rgba(239,68,68,0.1)' };
    return { label: '✅ A tiempo', color: '#1E9E3A', bg: 'rgba(30,158,58,0.1)' };
  }
  // Sin registro de ingreso.
  if (!row.hasMeetLink) return { label: '🔗 Sin enlace', color: '#ea580c', bg: 'rgba(249,115,22,0.12)' };
  return { label: '❌ No utilizó', color: 'var(--text-muted)', bg: 'var(--bg-surface-3)' };
}

// Categoría simplificada para el profesor según el producto (productName) o el
// plan/objetivo del alumno: Exámenes / Intensivo / Inglés general.
export function classCategoryBadge(productName?: string | null):
  { label: string; color: string; bg: string } {
  const n = (productName ?? '').toLowerCase();
  if (n.includes('examen') || n.includes('fce') || n.includes('pet') || n.includes('cae') || n.includes('preparacion de examenes')) {
    return { label: '📝 Exámenes', color: '#2563eb', bg: 'rgba(37,99,235,0.1)' };
  }
  if (n.includes('intensivo')) {
    return { label: '⚡ Intensivo', color: '#ea580c', bg: 'rgba(249,115,22,0.12)' };
  }
  return { label: '💬 Inglés general', color: '#1E9E3A', bg: 'rgba(30,158,58,0.1)' };
}

// Badge del tipo de clase — null para 'normal'. Faltas/cancelaciones son cobrables.
export function classTypeBadge(t: ClassRecordType | undefined):
  { label: string; color: string; bg: string } | null {
  switch (t) {
    case 'falta_sin_aviso':  return { label: '🚫 Falta sin aviso (cobrable)', color: '#ea580c', bg: 'rgba(249,115,22,0.12)' };
    case 'cancelacion_hora': return { label: '⏰ Cancelación (cobrable)',     color: '#dc2626', bg: 'rgba(239,68,68,0.1)' };
    case 'recuperacion':     return { label: '📋 Recuperación',               color: '#2563eb', bg: 'rgba(37,99,235,0.1)' };
    default:                 return null;
  }
}

// Estados de suscripción posibles (para filtros y leyendas).
export const SUBSCRIPTION_STATUS_OPTIONS = [
  { value: 'active',         label: 'Activa' },
  { value: 'pending-cancel', label: 'Pendiente cancelar' },
  { value: 'on-hold',        label: 'En espera' },
  { value: 'cancelled',      label: 'Cancelada' },
  { value: 'expired',        label: 'Expirada' },
  { value: 'not_found',      label: 'No encontrada' },
  { value: 'error',          label: 'No verificado' },
] as const;

// Badge de la columna "SUSCRIPCIÓN" según el estado guardado.
export function subscriptionBadge(status?: string):
  { label: string; color: string; bg: string } {
  switch (status) {
    case 'active':         return { label: '✅ Activa',              color: '#1E9E3A', bg: 'rgba(30,158,58,0.1)' };
    case 'pending-cancel': return { label: '⏳ Pendiente cancelar',  color: '#b45309', bg: 'rgba(255,196,0,0.18)' };
    case 'on-hold':        return { label: '⚠️ En espera',           color: '#ea580c', bg: 'rgba(249,115,22,0.12)' };
    case 'cancelled':      return { label: '❌ Cancelada',           color: '#dc2626', bg: 'rgba(239,68,68,0.1)' };
    case 'expired':        return { label: '❌ Expirada',            color: '#dc2626', bg: 'rgba(239,68,68,0.1)' };
    case 'not_found':      return { label: '❓ No encontrada',       color: 'var(--text-muted)', bg: 'var(--bg-surface-3)' };
    default:               return { label: '❓ No verificado',       color: 'var(--text-muted)', bg: 'var(--bg-surface-3)' };
  }
}
