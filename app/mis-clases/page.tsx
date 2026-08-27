'use client';
import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { PullToRefresh } from '@/components/PullToRefresh';
import { LastUpdated } from '@/components/LastUpdated';
import { getSpainParts } from '@/components/VisualCalendar';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import { calculateTeacherFinance, ClassFinanceRow, ingresoBadge, classTypeBadge, subscriptionBadge, rowHoursLabel, durationBadge, sessionBreakdownLabel, transcriptStateBadge, transcriptNeedsTeacher, financeStatusBadge, canMarkStudentAbsence, absenceBreakdownLabel, mixedSessionBadge, recoveryCreditLabel, estimateClassAmount, ABSENCE_MONTHLY_CAP, ABSENCE_CAP_MESSAGE } from '@/lib/finance';
import { dbGetAssignmentsByTeacher, calcRegisteredClassNumber, getTeacherAssignments } from '@/lib/db';
import { buildClassFunnel } from '@/lib/classFunnel';
import { ClassFunnelCard } from '@/components/ClassFunnelCard';
import { dbGetReviewRequests } from '@/lib/reviewRequests';
import { dbGetStudentDropouts, type StudentDropout } from '@/lib/studentPeriod';
import { gridOccupancyOfTeacher } from '@/lib/teacherClasses';
import { maybeSendMilestoneEmail } from '@/lib/milestoneEmails';
import { AddClassModal, saveTeacherClass, ANALYSIS_FAILED_NOTICE } from '@/components/AddClassModal';
import { Teacher, Assignment, ClassRecordType, ClassReviewRequest } from '@/types';
import { HelpTooltip } from '@/components/ui';
import type { HelpTooltipKey } from '@/lib/help-tooltips';

// Las etiquetas de ingresoBadge / classTypeBadge / subscriptionBadge vienen con
// emoji desde lib/finance (fuente compartida con el panel de admin). Acá solo se
// muestran sin él: se recorta el prefijo no alfanumérico, sin tocar la fuente.
function plainLabel(label: string): string {
  return label.replace(/^[^\p{L}\p{N}€]+/u, '').trim();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const FIN_MONTHS = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

function currentMonthYear(): string {
  const { dateStr } = getSpainParts(new Date());
  return dateStr.slice(0, 7); // 'YYYY-MM'
}
function shiftMonth(monthYear: string, delta: number): string {
  const [y, m] = monthYear.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function monthLabel(monthYear: string): string {
  const [y, m] = monthYear.split('-').map(Number);
  return `${FIN_MONTHS[(m ?? 1) - 1]} ${y}`;
}
function finShortDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  return `${String(d.getDate()).padStart(2, '0')} ${FIN_MONTHS[d.getMonth()].slice(0, 3)}`;
}
function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysDiff(aIso: string, bIso: string): number {
  return Math.round((new Date(bIso + 'T00:00:00').getTime() - new Date(aIso + 'T00:00:00').getTime()) / 86400000);
}

// Las etiquetas y colores de estado salen de lib/finance (financeStatusBadge):
// una sola fuente para esta pantalla y la del admin.

/**
 * Filtro de la lista de clases. Dos formas, porque hay dos preguntas distintas:
 *
 *   · por ESTADO — las tres de siempre, que salen de `r.status`.
 *   · por ORIGEN — al pulsar una línea del embudo ("Recuperaciones", "Dadas
 *     fuera de tu horario"): no es un estado, es un conjunto concreto de clases.
 *
 * El filtro por origen guarda las FILAS que el embudo ya clasificó, no un
 * criterio para volver a clasificarlas. Reproducir acá el "¿esto es una
 * recuperación?" sería tener la regla en dos sitios, que es justo lo que hacía
 * que dos pantallas dieran números distintos sobre las mismas clases.
 */
type ListFilter =
  | { kind: 'todas' | 'pagables' | 'pendientes' }
  | { kind: 'origen'; key: string; label: string; rows: Set<ClassFinanceRow> };

const TODAS: ListFilter = { kind: 'todas' };

/**
 * ¿Entra esta clase en el filtro? Para los de estado se lee `r.status`, que ya
 * viene calculado por lib/finance; para los de origen, la pertenencia al
 * conjunto que armó el embudo. En ningún caso se clasifica de nuevo.
 */
function matchesFilter(r: ClassFinanceRow, f: ListFilter): boolean {
  switch (f.kind) {
    case 'todas':      return true;
    case 'pagables':   return r.status === 'pagable';
    case 'pendientes': return r.status !== 'pagable';
    case 'origen':     return f.rows.has(r);
  }
}

/** El día en que se liquida el mes: el último. Se dice, en vez de suponerlo. */
function settlementLabel(monthYear: string): string {
  const [y, m] = monthYear.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return `Se liquida el ${last} de ${FIN_MONTHS[(m ?? 1) - 1]}`;
}

/**
 * Por qué una clase quedó pendiente, en el orden de prioridad que le sirve al
 * profesor: primero lo que puede resolver AHORA. Lo usan la lista de avisos y el
 * detalle desplegado de cada clase, que tienen que decir lo mismo.
 *
 * Con la regla de dos niveles, una clase pendiente SIEMPRE tiene ingreso (sin él
 * no habría entrado a finanzas), así que lo único que puede faltar es el
 * transcript. La rama del ingreso queda como red de seguridad.
 */
function missingReason(r: ClassFinanceRow): string {
  return r.transcriptState === 'rejected' ? 'el equipo rechazó el transcript: subí el correcto'
    : r.transcriptState === 'none'        ? 'subir transcript en Añadir clase, o marcar la falta si el alumno no vino'
    : !r.hasJoinLog                       ? 'ingresar con el botón Meet (no quedó registro de acceso)'
    :                                       'nada de tu parte: el equipo está validando el transcript';
}

/**
 * Confirmación de "falta sin aviso del alumno". Es una acción que mueve dinero
 * (la clase pasa a cobrarse) y consume cupo del alumno, así que se dice las dos
 * cosas antes de confirmar, no después.
 */
function AbsenceModal({ studentName, dateLabel, remaining, saving, error, onCancel, onConfirm }: {
  studentName: string;
  dateLabel: string;
  remaining: number;
  saving: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget && !saving) onCancel(); }}
    >
      <div style={{ background: '#F7F7F5', border: '1px solid #e4e5e1', borderRadius: 14, padding: 24, width: '100%', maxWidth: 440, fontFamily: 'var(--font-app)' }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: '#1a1c1a', marginBottom: 10 }}>
          Marcar falta sin aviso — {studentName}, {dateLabel}
        </div>
        <p style={{ fontSize: 13.5, color: '#5f6360', lineHeight: 1.65, margin: '0 0 14px' }}>
          El alumno no se presentó a esta clase. Al marcarla, se te pagará la clase a tarifa
          normal, sin necesidad de transcript. Puedes marcar un máximo de {ABSENCE_MONTHLY_CAP} faltas
          sin aviso por alumno al mes. Esta clase contará dentro del cupo mensual del alumno.
        </p>
        <div style={{ fontSize: 12.5, color: '#9a6516', background: '#fdf3e7', border: '1px solid #f2e2c9', borderRadius: 10, padding: '10px 13px', lineHeight: 1.55, marginBottom: 16 }}>
          Te {remaining === 1 ? 'queda 1 falta' : `quedan ${remaining} faltas`} de este alumno este mes
          (incluida esta).
        </div>
        {error && (
          <div style={{ fontSize: 12.5, color: '#c0392b', background: 'rgba(239,68,68,0.08)', borderRadius: 8, padding: '9px 12px', marginBottom: 12 }}>
            {error}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onCancel} disabled={saving}
            style={{ flex: 1, padding: '11px', borderRadius: 8, border: '1px solid #e4e5e1', background: 'transparent', color: '#6b7280', cursor: saving ? 'not-allowed' : 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
            Cancelar
          </button>
          <button onClick={onConfirm} disabled={saving}
            style={{ flex: 2, padding: '11px', borderRadius: 8, border: 'none', background: saving ? '#d1d5db' : '#1E9E3A', color: 'white', cursor: saving ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
            {saving ? 'Marcando…' : 'Confirmar falta sin aviso'}
          </button>
        </div>
      </div>
    </div>
  );
}

function MyClassesTab({ teacher, myAssignments }: { teacher: Teacher; myAssignments: Assignment[] }) {
  const {
    students, classRecords, classJoinLogs, classAnalyses, financeRates, financePayments, scoringEvents, manualApprovals,
    registerClassRecord, loadFinanceData, markStudentAbsence,
  } = useTeachers();

  const router = useRouter();
  const [monthYear, setMonthYear] = useState(currentMonthYear());
  const [showAdd, setShowAdd] = useState(false);
  // Prefill de "Añadir clase" al abrirlo desde una clase a revisar: deja el
  // alumno/fecha/tipo ya puestos para que el profe solo pegue el transcript. El
  // registro se emparejará con esa clase (mismo alumno + fecha ±1 día) en finanzas.
  const [addPrefill, setAddPrefill] = useState<{ studentName: string; date: string; classType: ClassRecordType } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Acordeón de CADA clase, dentro del acordeón del alumno.
  const [expandedClass, setExpandedClass] = useState<Set<string>>(new Set());
  // Aviso "pendiente de validación" (Bloque 1) tras guardar una clase que quedó en revisión.
  const [validationNotice, setValidationNotice] = useState<{ title: string; body: string } | null>(null);
  const [showPenalties, setShowPenalties] = useState(false);
  // Falta sin aviso del alumno: clase a confirmar, guardado y error del guardado.
  // Filtro de la lista de clases. Es también el destino de los clics del embudo:
  // pulsar "Pendientes de cobro" arriba deja la lista mostrando esas y solo esas,
  // que es lo que convierte al embudo en una explicación navegable y no en un
  // cartel. Un solo estado para las dos entradas, así no pueden discrepar.
  const [listFilter, setListFilter] = useState<ListFilter>(TODAS);
  const [absence, setAbsence] = useState<{ studentName: string; date: string; time?: string; remaining: number } | null>(null);
  const [absenceSaving, setAbsenceSaving] = useState(false);
  const [absenceError, setAbsenceError] = useState('');

  // ── Fuentes del EMBUDO ──────────────────────────────────────────────────────
  //
  // OJO con `myAssignments`: esas son las de la FICHA y se le pasan a
  // `calculateTeacherFinance` a propósito (es el último horario conocido de un
  // alumno que ya no está en el calendario). El embudo necesita las del
  // CALENDARIO, que es lo que /revisiones usa para saber qué clases tocaban.
  // Mezclarlas era justo lo que hacía que la tarjeta y /revisiones dieran
  // números distintos.
  const [gridAssignments, setGridAssignments] = useState<Assignment[]>([]);
  const [reviewRequests, setReviewRequests] = useState<ClassReviewRequest[]>([]);
  const [dropouts, setDropouts] = useState<StudentDropout[]>([]);
  useEffect(() => {
    let cancelled = false;
    Promise.all([getTeacherAssignments(teacher), dbGetReviewRequests(teacher.id), dbGetStudentDropouts()])
      .then(([asgs, reqs, bajas]) => {
        if (cancelled) return;
        setGridAssignments(asgs); setReviewRequests(reqs); setDropouts(bajas);
      })
      .catch(err => console.error('[finanzas] No se pudo armar el embudo:', err));
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teacher.id]);

  async function confirmAbsence() {
    if (!absence) return;
    setAbsenceSaving(true); setAbsenceError('');
    try {
      await markStudentAbsence(teacher.id, absence.studentName, absence.date, absence.time,
        'Falta sin aviso del alumno marcada desde Finanzas: el alumno no se presentó.');
      setAbsence(null);
      // El cálculo vive de classRecords/joinLogs, así que se recarga finanzas para
      // que la fila pase a pagable y el total del mes se actualice al instante.
      await loadFinanceData();
    } catch (e) {
      setAbsenceError(e instanceof Error ? e.message : 'No se pudo marcar la falta.');
    } finally {
      setAbsenceSaving(false);
    }
  }

  const openAddClass = (prefill?: { studentName: string; date: string; classType: ClassRecordType }) => {
    setAddPrefill(prefill ?? null);
    setShowAdd(true);
  };

  // Detección de hitos (clase 15/30/50) según las clases registradas. Se dispara
  // al cargar Finanzas y cada vez que cambian los class_records (p. ej. tras
  // "Añadir clase"), recontando con calcRegisteredClassNumber. maybeSendMilestoneEmail
  // ignora los no-hito y deduplica en assignments.milestone_emails_sent, así que
  // barrer todos los alumnos es seguro. Es el reemplazo del disparo que vivía en
  // el borrado /conteo-automatico.
  useEffect(() => {
    if (!teacher || myAssignments.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const a of myAssignments) {
        if (cancelled) return;
        try {
          await maybeSendMilestoneEmail({
            assignmentId: a.id,
            teacherId: teacher.id,
            studentName: a.studentName,
            classNumber: calcRegisteredClassNumber(a, classRecords),
          });
        } catch { /* best-effort */ }
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teacher?.id, myAssignments.length, classRecords.length]);

  // Resumen de pago (cálculo de finanzas).
  const payment = financePayments.find(p => p.teacherId === teacher.id && p.monthYear === monthYear) ?? null;
  // classAnalyses es el SEGUNDO FACTOR de verificación (el transcript). Sin él,
  // este cálculo daba `hasTranscript: false` en todas las filas y el profesor veía
  // "a revisar" y €0 pagables aunque hubiera subido todos los transcripts — el
  // panel del admin, que sí los pasa, decía otra cosa sobre las mismas clases.
  const finance = useMemo(() => calculateTeacherFinance({
    teacherId: teacher.id, teacherName: teacher.name, monthYear,
    assignments: myAssignments, joinLogs: classJoinLogs, classRecords, classAnalyses, rates: financeRates,
    scoringEvents, students, manualApprovals, payment,
    // El calendario decide qué es una clase de 2h (ver lib/finance.sessionSpanFor).
    gridOccupancy: gridOccupancyOfTeacher(teacher),
  }), [teacher, monthYear, myAssignments, classJoinLogs, classRecords, classAnalyses, financeRates, scoringEvents, students, manualApprovals, payment]);

  const spainNow = getSpainParts(new Date());
  const todayIso = spainNow.dateStr;

  // El EMBUDO: una clase, un lugar, y el total es la suma de las ramas. Sale de
  // las mismas fuentes que /revisiones para que los dos números no puedan
  // separarse (ver lib/classFunnel).
  const funnel = useMemo(() => buildClassFunnel({
    monthYear, teacherId: teacher.id,
    assignments: gridAssignments,
    joinLogs: classJoinLogs, classRecords, analyses: classAnalyses,
    requests: reviewRequests, dropouts,
    gridOccupancy: gridOccupancyOfTeacher(teacher),
    finance,
    todayIso, nowMinutes: spainNow.hour * 60 + spainNow.minute,
  }), [monthYear, teacher, gridAssignments, classJoinLogs, classRecords, classAnalyses, reviewRequests, dropouts, finance, todayIso, spainNow.hour, spainNow.minute]);

  /** Lo que el profesor deja de cobrar si no reclama. Tarifa real de cada alumno. */
  const claimAmount = useMemo(() => funnel.missing
    .filter(c => c.signal !== null)
    .reduce((s, c) => s + estimateClassAmount({
      assignment: myAssignments.find(a => a.studentName.trim().toLowerCase() === c.studentName.trim().toLowerCase()),
      student: students.find(x => x.name.trim().toLowerCase() === c.studentName.trim().toLowerCase()),
      rates: financeRates, date: c.date, durationHours: c.durationHours,
    }), 0), [funnel, myAssignments, students, financeRates]);

  /** Cuántas clases puede reclamar hoy. Sale del embudo, no de un recuento aparte. */
  const reclamables = funnel.branches
    .find(b => b.key === 'sin_ingreso')?.children
    ?.find(c => c.key === 'reclamables')?.count ?? 0;

  // Los contadores de los filtros, en CLASES (unidades): una sesión de 2h es una
  // fila que vale 2. Mismo criterio que el embudo, para que un profesor que
  // compara los dos números no encuentre dos verdades.
  const filterCounts = useMemo(() => {
    const units = (f: ListFilter) => finance.rows
      .filter(r => matchesFilter(r, f))
      .reduce((s, r) => s + r.billingUnits, 0);
    return {
      todas: units({ kind: 'todas' }),
      pagables: units({ kind: 'pagables' }),
      pendientes: units({ kind: 'pendientes' }),
    };
  }, [finance.rows]);

  /** Todas las líneas del embudo, planas, para poder buscarlas por clave. */
  const funnelLines = useMemo(
    () => funnel.branches.flatMap(b => [b, ...(b.children ?? [])]),
    [funnel],
  );

  /**
   * Clic en una línea del embudo. Cada línea deja la lista mostrando SUS clases
   * y baja hasta ella.
   *
   * Las de origen ("Recuperaciones", "Dadas fuera de tu horario") filtran por
   * las filas que el embudo ya clasificó, no por estado de pago: si hago clic en
   * las 11 dadas fuera de horario quiero ver esas 11, no las pagables del mes.
   * Las de estado siguen filtrando por estado, que es lo que dicen que son.
   *
   * "Reclamables" no vive acá sino en /revisiones, así que ahí se lleva al
   * profesor a donde sí puede actuar.
   */
  function pickFunnelBranch(key: string) {
    if (key === 'reclamables') { router.push('/revisiones'); return; }
    if (key === 'pagables')   setListFilter({ kind: 'pagables' });
    else if (key === 'pendientes') setListFilter({ kind: 'pendientes' });
    else {
      const line = funnelLines.find(l => l.key === key);
      // Sin filas propias (p. ej. la rama padre) no hay nada que acotar: se
      // muestra todo antes que mentir con una lista vacía.
      setListFilter(line?.rows?.length
        ? { kind: 'origen', key, label: line.label, rows: new Set(line.rows) }
        : TODAS);
    }
    document.getElementById('fin-lista')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Agrupar las clases detectadas (finance.rows) por alumno, con su desglose.
  const financeGroups = useMemo(() => {
    const map = new Map<string, ClassFinanceRow[]>();
    for (const r of finance.rows) {
      if (!map.has(r.studentName)) map.set(r.studentName, []);
      map.get(r.studentName)!.push(r);
    }
    const groups = [...map.entries()].map(([name, unsorted]) => {
      const rows = [...unsorted].sort((a, b) => a.date.localeCompare(b.date));
      const asgn = myAssignments.find(a => a.studentName.trim().toLowerCase() === name.trim().toLowerCase());
      // Ex-alumno: aparece en el historial de clases pero ya no tiene assignment.
      const isExStudent = !asgn;
      const plan = asgn?.plan || rows[0]?.plan || '';
      const level = asgn?.studentLevel ?? '';
      const startDate = asgn?.startDate;
      // Sale del cálculo de finanzas (misma clasificación que la tarifa cobrada).
      const planTypeLabel = rows[0]?.planLabel ?? '';

      const nuevoRows = rows.filter(r => r.antiquityDays < 30);
      const antiguoRows = rows.filter(r => r.antiquityDays >= 30);
      const oldRate = nuevoRows[0]?.rate ?? 0;
      const newRate = antiguoRows[0]?.rate ?? oldRate;
      const rateChanged = nuevoRows.length > 0 && antiguoRows.length > 0 && oldRate !== newRate;
      const currentRate = rows[rows.length - 1]?.rate ?? 0;
      const antiquityToday = startDate ? Math.max(0, daysDiff(startDate, todayIso)) : 0;

      // Fecha del cruce de umbral (30 días) cuando cambió la tarifa.
      let changeIso = ''; let prevDayLabel = '';
      if (rateChanged && startDate) {
        const t = new Date(startDate + 'T00:00:00'); t.setDate(t.getDate() + 30);
        changeIso = isoOf(t);
        const prev = new Date(t); prev.setDate(prev.getDate() - 1);
        prevDayLabel = String(prev.getDate());
      }

      const pagables = rows.filter(r => r.status === 'pagable');
      const aRevisar = rows.filter(r => r.status === 'a_revisar');
      // Todo en CLASES (unidades), no en filas: una sesión de 2h es una fila que
      // vale 2 clases y 2× la tarifa.
      const unitsOf = (rs: ClassFinanceRow[]) => rs.reduce((s, r) => s + r.billingUnits, 0);
      const subtotal = pagables.reduce((s, r) => s + r.rate * r.billingUnits, 0);

      return {
        name, rows, plan, planTypeLabel, level, startDate, antiquityToday, isExStudent,
        oldRate, newRate, currentRate, rateChanged, changeIso, prevDayLabel,
        subtotal, total: unitsOf(rows), pagablesCount: unitsOf(pagables), aRevisarCount: unitsOf(aRevisar),
        hasReview: aRevisar.length > 0,
      };
    });
    // Orden: primero los que tienen clases a revisar, luego alfabético.
    groups.sort((a, b) => (Number(b.hasReview) - Number(a.hasReview)) || a.name.localeCompare(b.name));
    return groups;
  }, [finance, myAssignments, todayIso]);

  /** Los alumnos que tienen alguna clase dentro del filtro. */
  const visibleGroups = useMemo(
    () => financeGroups.filter(g => g.rows.some(r => matchesFilter(r, listFilter))),
    [financeGroups, listFilter],
  );

  /** Clases que deja ver el filtro activo, para el contador del chip. */
  const filterUnits = useMemo(
    () => finance.rows.filter(r => matchesFilter(r, listFilter)).reduce((s, r) => s + r.billingUnits, 0),
    [finance.rows, listFilter],
  );

  function toggleClass(key: string) {
    setExpandedClass(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  }

  function toggle(name: string) {
    setExpanded(prev => { const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n; });
  }

  /**
   * Guardar una clase desde "Añadir clase". Toda la escritura vive en
   * saveTeacherClass (components/AddClassModal), compartida con la vista semanal
   * /clases: guarda el transcript primero y analiza después, para que un fallo o
   * una demora de la IA no le haga perder la clase al profesor.
   */
  async function handleAddClass(
    studentName: string, date: string, time: string | undefined,
    transcript: string, classType: ClassRecordType, comment: string,
    transcriptHashValue: string, replaceId: string | null,
  ) {
    const result = await saveTeacherClass({
      teacher, myAssignments, studentName, date, time, transcript, classType, comment,
      transcriptHash: transcriptHashValue, replaceId, registerClassRecord,
    });
    if (result.notice) setValidationNotice(result.notice);
    // Solo se vuelve a avisar si el informe falla: si sale bien, no hay nada que
    // contarle al profesor que no vea ya en la ficha del alumno.
    result.analysis?.then(({ analyzed }) => {
      if (!analyzed) setValidationNotice(ANALYSIS_FAILED_NOTICE);
    });
    await loadFinanceData();
    // La detección de hitos ocurre en el barrido de MyClassesTab (useEffect), que
    // recuenta al cambiar class_records tras loadFinanceData().
  }

  // Registro (captura) asociado a una clase (alumno + fecha ±1 día), si existe.
  function recordFor(name: string, date: string) {
    return classRecords.find(r =>
      r.teacherId === teacher.id && r.studentName === name && Math.abs(daysDiff(r.classDate, date)) <= 1
    ) ?? null;
  }

  // La lista de "clases pendientes de transcript" que vivía acá desapareció: era
  // un tercer recuento de lo mismo, con su propia idea de qué está pendiente. Lo
  // que decía lo dicen ahora la rama del embudo (cuántas y cuánto) y el filtro
  // "Pendientes" de la lista (cuáles, con el motivo y el botón de subir).

  // Penalizaciones del mes: CUALQUIER evento con euros negativos (falta sin aviso
  // registrada en el calendario, falta injustificada cargada por el admin, etc.).
  // Antes se filtraba por un único event_type y las demás penalizaciones restaban
  // del total sin aparecer en el desglose, que es lo peor de los dos mundos.
  // Las revertidas se muestran tachadas y no restan (ver lib/finance.ts).
  const monthPenalties = scoringEvents
    .filter(e => e.teacherId === teacher.id && (e.euros ?? 0) < 0 && (e.createdAt ?? '').slice(0, 7) === monthYear)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

  return (
    <>
      {/* Aviso de validación pendiente (Bloque 1) */}
      {validationNotice && (
        <div className="mcf-card" style={{ borderLeft: '4px solid #FFC400', background: '#fffdf5', padding: '14px 18px', marginBottom: 12, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <span style={{ fontSize: 18, lineHeight: 1 }}>⏳</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: '#1a1c1a', marginBottom: 3 }}>{validationNotice.title}</div>
            <div style={{ fontSize: 13, color: '#5f6360', lineHeight: 1.5 }}>{validationNotice.body}</div>
          </div>
          <button onClick={() => setValidationNotice(null)} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#9ca3af', lineHeight: 1 }}>✕</button>
        </div>
      )}

      {/* ── 1. CABECERA: mes, total, estado y acción, en UNA card ──────────────
          Antes eran dos bloques separados: una barra de mes, y más abajo una
          tarjeta de "Total a cobrar" con el desglose plegado. Había que leer las
          dos para responder "¿cuánto cobro y por qué?", y el desglose que más se
          discute (bonos y penalizaciones) estaba detrás de un clic.

          `data-onboarding`: último paso del tutorial guiado, que trae acá al
          profesor para enseñarle que la clase cerrada ya suma a su pago. */}
      <div className="fin-head" data-onboarding="payment-summary">
        <div className="fin-bar">
          <div className="fin-nav">
            <button className="fin-nav-btn" aria-label="Mes anterior" onClick={() => setMonthYear(m => shiftMonth(m, -1))}>‹</button>
            <span className="fin-month">{monthLabel(monthYear)}</span>
            <button className="fin-nav-btn" aria-label="Mes siguiente" onClick={() => setMonthYear(m => shiftMonth(m, 1))}>›</button>
          </div>
          <button className="fin-ghost-btn" onClick={() => setMonthYear(currentMonthYear())}>Hoy</button>
          <span className="fin-spacer" />
          <button className="fin-primary-btn" onClick={() => openAddClass()}>Añadir clase</button>
        </div>

        <div className="fin-main">
          <div>
            <div className="fin-eyebrow">
              Total a cobrar
              <HelpTooltip tooltipKey="finanzas.totalCobrar" position="bottom" />
            </div>
            {/* Verde solo cuando de verdad hay algo que cobrar. Un saldo en cero
                va apagado y uno negativo, en rojo: hay profesores a los que las
                penalizaciones les dejan el mes bajo cero y pintarlo de verde
                sería la peor mentira de la pantalla. */}
            <div className={`fin-amount${finance.totalAPagar < 0 ? ' is-neg' : finance.totalAPagar === 0 ? ' is-zero' : ''}`}>
              {finance.totalAPagar < 0 ? '−' : ''}€{Math.abs(finance.totalAPagar).toFixed(2)}
            </div>
          </div>

          <div className="fin-state">
            <span className={`fin-pill${finance.paymentStatus === 'paid' ? ' is-paid' : ''}`}>
              <span className="fin-pill-dot" />
              {finance.paymentStatus === 'paid' ? 'Pagado' : 'Pendiente de pago'}
            </span>
            <span className="fin-settle">{settlementLabel(monthYear)}</span>
          </div>

          <span className="fin-spacer" />

          {/* Cómo se llega al total, sin desplegar nada. Los bonos y las
              penalizaciones son justo lo que el profesor discute cuando el
              número no le cuadra: esconderlos era esconder la respuesta. */}
          <div className="fin-chips">
            <span className="fin-chip">Clases €{finance.montoPagable.toFixed(2)}</span>
            <span className="fin-chip-sep">·</span>
            <span className={`fin-chip${finance.bonusFromScoring > 0 ? '' : ' is-muted'}`}>
              Bonos €{finance.bonusFromScoring.toFixed(2)}
            </span>
            <span className="fin-chip-sep">·</span>
            <span className={`fin-chip${finance.penaltiesFromScoring < 0 ? ' is-bad' : ' is-muted'}`}>
              Penalizaciones −€{Math.abs(finance.penaltiesFromScoring).toFixed(2)}
            </span>
            {finance.penaltiesFromScoring < 0 && (
              <button className="fin-chip-btn" onClick={() => setShowPenalties(s => !s)}>
                {showPenalties ? 'ocultar' : 'ver detalle'}
              </button>
            )}
          </div>
        </div>

        {/* Las revertidas se muestran tachadas y no restan (ver lib/finance.ts). */}
        {showPenalties && monthPenalties.length > 0 && (
          <div className="fin-pen">
            {monthPenalties.map(p => (
              <div key={p.id} className={`fin-pen-row${p.reverted ? ' is-reverted' : ''}`}>
                <span>{p.note.replace(/^(Falta sin aviso registrada|Cancelación sin antelación) — /, '').replace('alumno ', '').replace('fecha ', '')}</span>
                <span style={{ whiteSpace: 'nowrap' }}>
                  {p.reverted && <span className="fin-pen-back">Revertida por el equipo</span>}
                  −€{Math.abs(p.euros).toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mcf-content">
        {/* ── 2. LA ACCIÓN, ANTES DEL DETALLE ──
            Responde "¿hay algo que dependa de mí para cobrar más?" sin obligar
            al profesor a leer el embudo entero. Solo aparece cuando de verdad
            hay algo que reclamar: una banda que no lleva a ninguna parte es
            peor que no tenerla. */}
        {reclamables > 0 && (
          <Link href="/revisiones" className="fin-claim">
            <div className="fin-claim-in">
              <div className="fin-claim-body">
                <div className="fin-claim-title">
                  {reclamables === 1 ? 'Tenés 1 clase reclamable' : `Tenés ${reclamables} clases reclamables`}
                </div>
                <div className="fin-claim-sub">
                  Ya tienen el transcript subido: son <b className="fin-claim-eur">≈ €{claimAmount.toFixed(2)}</b> que
                  podés cobrar si las reclamás antes del cierre del mes.
                </div>
              </div>
              <span className="fin-claim-btn">Reclamar en Revisiones →</span>
            </div>
          </Link>
        )}

        {/* ── 3. EL EMBUDO: por qué el total es ese ──
            Reemplaza a las cuatro tarjetas sueltas. Las viejas contaban cada una
            por su cuenta: "Sin ingreso detectado" solo miraba los registros que
            el profesor había cargado a mano, así que decía 2 donde había 80.
            Acá cada clase está en una rama, el total es la suma, y cada línea
            baja a la lista mostrando exactamente esas clases. */}
        <ClassFunnelCard
          funnel={funnel}
          claimAmount={claimAmount}
          showActions
          onPick={pickFunnelBranch}
        />
        <div className="mcf-body">
          {/* ── 4. EL DETALLE, filtrable ──
              La tarjeta suelta de "Pendientes de transcript" que vivía acá decía
              lo mismo que la rama del embudo y con otro recuento; ahora el
              embudo es el índice y esto, el detalle al que lleva. */}
          <div className="mcf-main">
            <div className="fin-list-head" id="fin-lista">
              <span className="fin-list-title">Clases por alumno</span>
              <div className="fin-filters">
                {([
                  { k: 'todas', label: 'Todas' },
                  { k: 'pagables', label: 'Pagables' },
                  { k: 'pendientes', label: 'Pendientes' },
                ] as Array<{ k: 'todas' | 'pagables' | 'pendientes'; label: string }>).map(f => (
                  <button
                    key={f.k}
                    className={`fin-filter${listFilter.kind === f.k ? ' is-on' : ''}`}
                    onClick={() => setListFilter({ kind: f.k })}
                  >
                    {f.label} {filterCounts[f.k]}
                  </button>
                ))}
                {/* El cuarto filtro: aparece al pulsar una línea de origen del
                    embudo y se quita con la ✕. No es un estado más, así que no
                    ocupa sitio cuando no está en uso. */}
                {listFilter.kind === 'origen' && (
                  <button
                    className="fin-filter is-on is-pick"
                    onClick={() => setListFilter(TODAS)}
                    title="Quitar este filtro"
                  >
                    {listFilter.label} {filterUnits}
                    <span className="fin-filter-x" aria-hidden>✕</span>
                  </button>
                )}
              </div>
            </div>
            {visibleGroups.length === 0 ? (
              <div className="mcf-card mcf-empty">
                {financeGroups.length === 0
                  ? <>No hay clases detectadas este mes. Registrá clases con <b>Añadir clase</b> o ingresá con el botón Meet.</>
                  : listFilter.kind === 'pendientes'
                    ? <>No te queda ninguna clase pendiente de cobro este mes.</>
                    : listFilter.kind === 'origen'
                      ? <>Ninguna clase de este mes entra en «{listFilter.label}».</>
                      : <>Ninguna clase de este mes está en ese estado.</>}
              </div>
            ) : visibleGroups.map(g => {
              // Con un filtro puesto la lista se abre sola: si hay que pulsar
              // cada alumno para ver las 3 pendientes, el filtro no sirve.
              const isOpen = expanded.has(g.name) || listFilter.kind !== 'todas';
              return (
                <div key={g.name} className="mcf-card">
                  <div className="mcf-student-head" onClick={() => toggle(g.name)}>
                    <div className="mcf-avatar">
                      {g.name.split(' ').map(p => p[0]).join('').toUpperCase().slice(0, 2)}
                    </div>

                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span className="mcf-student-name">{g.name}</span>
                        {g.isExStudent && (
                          <span className="mcf-badge-ex" title="Este alumno ya no está activo, pero sus clases del mes siguen contando para el pago">
                            ex-alumno
                          </span>
                        )}
                      </div>
                      <div className="mcf-meta" style={{ marginTop: 4 }}>
                        {g.startDate ? <>Desde {finShortDate(g.startDate)} · {g.antiquityToday} días{g.level ? ' · ' : ''}</> : null}
                        {g.level ? <>Nivel {g.level}</> : null}
                      </div>
                    </div>

                    {g.hasReview && (
                      <span className="mcf-pill is-warn" title="Clases dadas que aún no se pagan porque falta el transcript">
                        <span className="mcf-dot" style={{ background: '#FFC400' }} />Pendiente de transcript
                      </span>
                    )}

                    <div className="mcf-cols">
                      <div>
                        <div className="mcf-col-label">Plan</div>
                        <div className="mcf-col-value">{g.planTypeLabel}</div>
                      </div>
                      <div>
                        <div className="mcf-col-label">Tarifa · clases</div>
                        <div className="mcf-col-value">€{g.currentRate.toFixed(2)} · {g.total} clase{g.total !== 1 ? 's' : ''}</div>
                      </div>
                      <div>
                        <div className="mcf-col-label">Subtotal del mes</div>
                        <div className="mcf-col-value is-amount">€{g.subtotal.toFixed(2)}</div>
                      </div>
                    </div>

                    {g.rateChanged && (
                      <div className="mcf-note-inline" style={{ gridColumn: '1 / -1' }}>
                        Cambió de tarifa el {finShortDate(g.changeIso)}: €{g.oldRate.toFixed(2)} hasta el {g.prevDayLabel}, luego €{g.newRate.toFixed(2)}
                      </div>
                    )}

                    <button className="mcf-link" onClick={e => { e.stopPropagation(); toggle(g.name); }}>
                      {isOpen ? 'Ocultar detalle de clases' : 'Ver detalle de clases'}
                    </button>
                  </div>

                  {/* Detalle expandible */}
                  {isOpen && (
                    <div>
                      <div className="mcf-detail">
                        {/* Las ayudas vivían en las cabeceras de la tabla. Sin
                            tabla, se conservan acá como leyenda del bloque. */}
                        <div className="mcf-legend">
                          {([
                            { h: 'Ingreso', help: 'finanzas.ingreso' },
                            { h: 'Transcript', help: 'finanzas.transcript' },
                            { h: 'Suscripción', help: 'finanzas.suscripcion' },
                            { h: 'Tarifa', help: 'finanzas.tarifa' },
                          ] as Array<{ h: string; help: HelpTooltipKey }>).map(col => (
                            <span key={col.h}>{col.h}<HelpTooltip tooltipKey={col.help} /></span>
                          ))}
                        </div>
                        {g.rows.filter(r => matchesFilter(r, listFilter)).map((r, i) => {
                          const rec = recordFor(g.name, r.date);
                          const ing = ingresoBadge(r);
                          const ct = classTypeBadge(r.classType);
                          const isFalta = r.classType === 'falta_sin_aviso' || r.classType === 'cancelacion_hora';
                          const isExcede = r.status === 'excede_limite' || r.status === 'excede_limite_tipo';
                          const complete = r.hasJoinLog && r.hasTranscript;
                          const sub = subscriptionBadge(r.subscriptionStatus);
                          const subDiffer = r.subAtJoin && r.subAtRecord && r.subAtJoin !== r.subAtRecord;
                          // Sesión de 2h: UNA fila que vale 2 clases (2× tarifa).
                          const dur = durationBadge(r.durationHours);
                          const sessionNote = sessionBreakdownLabel(r);
                          // Estado del transcript (fuente única, lib/finance).
                          const ts = transcriptStateBadge(r.transcriptState);
                          // Estado de pago: misma fuente que el panel del admin.
                          const st = financeStatusBadge(r.status);
                          const clsKey = `${g.name}|${r.date}|${r.hour ?? ''}`;
                          const clsOpen = expandedClass.has(clsKey);
                          const canPaste = !isFalta && transcriptNeedsTeacher(r.transcriptState);
                          // Falta sin aviso del alumno. Solo se ofrece donde tiene
                          // sentido: clase pendiente, con ingreso y SIN nada subido.
                          // Con un transcript en revisión o rechazado la clase sí se
                          // dio, así que ahí marcar una falta sería mentir.
                          const canMarkAbsence = r.status === 'a_revisar' && r.hasJoinLog
                            && r.transcriptState === 'none' && !isFalta
                            && finance.paymentStatus !== 'paid';
                          const absenceCap = canMarkAbsence
                            ? canMarkStudentAbsence(classRecords, teacher.id, g.name, r.date.slice(0, 7))
                            : null;
                          const absenceNote = absenceBreakdownLabel(r);
                          // Bloque de 2h "normal + recuperación": el badge explica por qué
                          // paga doble y la nota, qué clase perdida salda.
                          const mixed = mixedSessionBadge(r);
                          const recNote = recoveryCreditLabel(r);
                          return (
                            <div key={i} className={`mcf-cls${r.status === 'a_revisar' ? ' is-review' : ''}`}
                              onClick={() => toggleClass(clsKey)} aria-expanded={clsOpen}>

                              {/* ── Fila compacta: cuándo · estado · importe ── */}
                              <div className="mcf-cls-when">
                                <span className="mcf-cls-caret" aria-hidden>{clsOpen ? '▾' : '▸'}</span>
                                {finShortDate(r.date)}
                                {r.hour && <span className="mcf-cls-time">{rowHoursLabel(r)}</span>}
                                <span className="mcf-pill" style={{ background: st.bg, color: st.color }}>
                                  <span className="mcf-dot" style={{ background: st.dot }} />
                                  {st.short}
                                </span>
                              </div>

                              {/* Importe = tarifa × unidades (2× en una sesión de 2h) */}
                              <div className="mcf-cls-amount" title={sessionNote ?? undefined}>
                                €{(r.rate * r.billingUnits).toFixed(2)}
                                {r.billingUnits > 1 && <div className="mcf-cls-note">cuenta como {r.billingUnits}</div>}
                              </div>

                              {/* ── Detalle: se despliega hacia abajo y empuja lo que sigue ── */}
                              {clsOpen && (
                                <div className="mcf-cls-detail">
                                  <div>
                                    <div className="mcf-fld-label">Tipo de clase</div>
                                    <div className="mcf-fld-value">
                                      {ct
                                        ? <span className="mcf-tag" style={{ background: ct.bg, color: ct.color }}>{plainLabel(ct.label)}</span>
                                        : 'Normal'}
                                      {dur && <span className="mcf-tag" style={{ background: dur.bg, color: dur.color }}>{dur.label}</span>}
                                      {mixed && <span className="mcf-tag" style={{ background: mixed.bg, color: mixed.color }}>{plainLabel(mixed.label)}</span>}
                                    </div>
                                    {recNote && <div className="mcf-cls-note" style={{ color: '#8a6d00', marginTop: 4 }}>{recNote}</div>}
                                  </div>

                                  <div>
                                    <div className="mcf-fld-label">Tarifa aplicada</div>
                                    <div className="mcf-fld-value">
                                      €{r.rate.toFixed(2)}
                                      {r.billingUnits > 1 && <span className="mcf-cls-note">× {r.billingUnits} (sesión de {r.durationHours}h)</span>}
                                    </div>
                                  </div>

                                  <div>
                                    <div className="mcf-fld-label">Antigüedad</div>
                                    <div className="mcf-fld-value">{r.antiquityDays} días</div>
                                  </div>

                                  {/* Los DOS factores que hacen pagable una clase. */}
                                  <div>
                                    <div className="mcf-fld-label">Ingreso</div>
                                    <div className="mcf-fld-value">
                                      <span className="mcf-tag" style={{ background: ing.bg, color: ing.color }}>{plainLabel(ing.label)}</span>
                                    </div>
                                  </div>

                                  <div>
                                    <div className="mcf-fld-label">Transcript</div>
                                    <div className="mcf-fld-value">
                                      {isFalta
                                        ? <span style={{ color: '#a4a7a1' }}>No aplica en una falta</span>
                                        : <span className="mcf-tag" style={{ background: ts.bg, color: ts.color }}>{ts.label}</span>}
                                    </div>
                                  </div>

                                  <div>
                                    <div className="mcf-fld-label">Suscripción</div>
                                    <div className="mcf-fld-value">
                                      <span className="mcf-tag" style={{ background: sub.bg, color: sub.color }}>{plainLabel(sub.label)}</span>
                                      {subDiffer && (
                                        <span style={{ cursor: 'help', color: '#a4a7a1', fontSize: 12 }}
                                          title={`Al ingresar: ${plainLabel(subscriptionBadge(r.subAtJoin).label)} · Al registrar: ${plainLabel(subscriptionBadge(r.subAtRecord).label)}`}>
                                          ·
                                        </span>
                                      )}
                                    </div>
                                  </div>

                                  {(r.manuallyApproved || rec?.comment) && (
                                    <div>
                                      <div className="mcf-fld-label">Marcas</div>
                                      <div className="mcf-fld-value">
                                        {r.manuallyApproved && (
                                          <span className="mcf-tag" style={{ background: '#eaf5ec', color: '#1f7a3d' }}>Aprobada por el equipo</span>
                                        )}
                                        {rec?.comment && (
                                          <span className="mcf-tag" style={{ background: '#f0f1ee', color: '#5f6360', cursor: 'help' }} title={rec.comment}>nota</span>
                                        )}
                                      </div>
                                    </div>
                                  )}

                                  {/* Cobrada por falta del alumno: se dice con todas
                                      las letras, con la misma frase que ve el admin. */}
                                  {absenceNote && (
                                    <div className="mcf-cls-reason" style={{ color: '#b45309' }}>{absenceNote}</div>
                                  )}

                                  {/* Por qué no cuenta todavía. */}
                                  {r.status === 'a_revisar' && (
                                    <div className="mcf-cls-reason">Falta: {missingReason(r)}</div>
                                  )}
                                  {isExcede && (
                                    <div className="mcf-cls-reason">
                                      {r.status === 'excede_limite_tipo'
                                        ? 'Supera las 2 cobrables de este tipo en el mes: la revisa el equipo.'
                                        : 'Excede el límite de clases del plan del alumno: la revisa el equipo.'}
                                    </div>
                                  )}

                                  <div className="mcf-cls-cta">
                                    {/* Tercera vía a pagable: el alumno no vino. Va
                                        JUNTO a "Añadir transcript", no en su lugar:
                                        son las dos salidas de una clase pendiente y
                                        el profesor elige según lo que pasó. */}
                                    {canMarkAbsence && absenceCap && (
                                      absenceCap.allowed ? (
                                        <button
                                          onClick={e => {
                                            e.stopPropagation();
                                            setAbsenceError('');
                                            setAbsence({ studentName: g.name, date: r.date, time: r.hour || undefined, remaining: absenceCap.remaining });
                                          }}
                                          title="El alumno no se presentó: cobrá la clase a tarifa normal"
                                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '7px 13px', borderRadius: 8, border: '1px solid rgba(180,83,9,0.35)', background: 'rgba(255,196,0,0.20)', color: '#b45309', cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit' }}
                                        >
                                          Marcar falta sin aviso del alumno
                                        </button>
                                      ) : (
                                        <span style={{ color: '#9a6516', fontSize: 12 }} title={ABSENCE_CAP_MESSAGE}>
                                          {ABSENCE_CAP_MESSAGE}
                                        </span>
                                      )
                                    )}
                                    {isFalta ? (
                                      <span style={{ color: '#1f7a3d', fontWeight: 600, fontSize: 12.5 }}>
                                        Cobrable sin transcript
                                      </span>
                                    ) : canPaste ? (
                                      <button
                                        onClick={e => { e.stopPropagation(); openAddClass({ studentName: g.name, date: r.date, classType: r.classType }); }}
                                        title="Pegá el transcript de esta clase para verificarla"
                                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '7px 13px', borderRadius: 8, border: '1px solid rgba(224,145,47,0.45)', background: '#fdf3e7', color: '#9a6516', cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit' }}
                                      >
                                        {r.transcriptState === 'rejected' ? '+ Subir el correcto' : '+ Añadir transcript'}
                                      </button>
                                    ) : complete ? (
                                      <span style={{ color: '#1f7a3d', fontWeight: 600, fontSize: 12.5 }}>
                                        Completo: acceso y transcript verificados
                                      </span>
                                    ) : !r.hasJoinLog ? (
                                      <span style={{ color: '#a4a7a1', fontSize: 12.5 }} title="No se puede falsear el ingreso">
                                        Recordá usar &apos;Ingresar a clase&apos;
                                      </span>
                                    ) : (
                                      // Transcript subido y esperando al equipo: no
                                      // hay nada que el profesor pueda hacer acá.
                                      <span style={{ color: '#3b5b9e', fontWeight: 600, fontSize: 12.5 }} title="El equipo está validando el transcript">
                                        En revisión por el equipo
                                      </span>
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      <div className="mcf-detail-foot">
                        <div>
                          Total {g.total} · Pagables <b style={{ color: '#1f7a3d' }}>{g.pagablesCount}</b> · Pendientes de transcript{' '}
                          <b style={{ color: g.aRevisarCount > 0 ? '#9a6516' : '#1a1c1a' }}>{g.aRevisarCount}</b>
                        </div>
                        <div style={{ fontWeight: 600, color: '#1f7a3d' }}>Subtotal €{g.subtotal.toFixed(2)}</div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {showAdd && (
        <AddClassModal
          teacher={teacher}
          myAssignments={myAssignments}
          classRecords={classRecords}
          initial={addPrefill}
          onClose={() => { setShowAdd(false); setAddPrefill(null); }}
          onSaved={handleAddClass}
        />
      )}

      {absence && (
        <AbsenceModal
          studentName={absence.studentName}
          dateLabel={finShortDate(absence.date)}
          remaining={absence.remaining}
          saving={absenceSaving}
          error={absenceError}
          onCancel={() => { if (!absenceSaving) { setAbsence(null); setAbsenceError(''); } }}
          onConfirm={confirmAbsence}
        />
      )}

    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
function MisClasesContent() {
  const { user } = useAuth();
  const { teachers, assignments, reloadAll, loadFinanceData } = useTeachers();

  const teacher = teachers.find(t => t.id === user?.teacherId) ?? teachers[0];

  // Las assignments del profesor se traen con query DIRECTA por teacher_id, sin
  // depender del estado del contexto (que puede estar vacío momentáneamente y
  // hacía que "Añadir clase" dijera "no hay alumnos asignados"). Se usa el
  // contexto solo como fallback inicial.
  const [directAssignments, setDirectAssignments] = useState<Assignment[]>([]);
  useEffect(() => {
    loadFinanceData();
    if (teacher) dbGetAssignmentsByTeacher(teacher.id).then(setDirectAssignments);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teacher?.id]);

  const contextAssignments = teacher ? assignments.filter(a => a.teacherId === teacher.id) : [];
  // Assignments SIN tocar: esta pantalla es el resumen de PAGO, y finanzas no
  // saca las clases de los slots (salen de ingresos y registros). El horario de
  // la ficha se conserva a propósito: es el último horario conocido de un alumno
  // que ya no está en el calendario, y sin él sus sesiones de 2h ya dadas
  // pasarían a valer 1 (ver lib/finance.sessionSpanFor).
  const myAssignments = directAssignments.length > 0 ? directAssignments : contextAssignments;

  return (
    <div style={{ minHeight: '100vh', background: '#f4f5f2' }}>
      <NavBar />
      <PullToRefresh onRefresh={reloadAll}>
        <div className="mcf">
          <header className="mcf-head">
            <div>
              <h1 className="mcf-title">Finanzas</h1>
              <p className="mcf-sub">Registro de clases y resumen de pago</p>
            </div>
            <div className="mcf-updated">
              <span className="mcf-dot" style={{ background: '#16a34a' }} />
              <LastUpdated />
            </div>
          </header>
          {teacher
            ? <MyClassesTab teacher={teacher} myAssignments={myAssignments} />
            : <div className="mcf-empty">Cargando...</div>}
        </div>
      </PullToRefresh>
    </div>
  );
}

export default function MisClasesPage() {
  return (
    <AuthGuard allowedRoles={['teacher']}>
      <MisClasesContent />
    </AuthGuard>
  );
}
