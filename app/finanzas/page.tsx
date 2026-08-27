'use client';
import { useState, useEffect, useMemo, useRef } from 'react';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { PullToRefresh } from '@/components/PullToRefresh';
import { LastUpdated } from '@/components/LastUpdated';
import { getSpainParts } from '@/components/VisualCalendar';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import { calculateTeacherFinance, estimateClassAmount, TeacherFinanceResult, ClassFinanceRow, classTypeBadge, subscriptionBadge, rowHoursLabel, financeStatusBadge, transcriptStateBadge, absenceBreakdownLabel, isStudentAbsence, recoveryCreditLabel, studentQuotaOf, SUBSCRIPTION_STATUS_OPTIONS } from '@/lib/finance';
import { isActiveWooStatus } from '@/lib/subscriptionAccess';
import { gridOccupancyOfTeacher } from '@/lib/teacherClasses';
import { dbRevertPenalty, dbGetAllTeacherAssignments } from '@/lib/db';
import { buildClassFunnel } from '@/lib/classFunnel';
import { ClassFunnelCard } from '@/components/ClassFunnelCard';
import { dbGetReviewRequests } from '@/lib/reviewRequests';
import { dbGetStudentDropouts, type StudentDropout } from '@/lib/studentPeriod';
import ReviewRequestsTab from '@/components/admin/ReviewRequestsTab';
import OutOfScheduleTab from '@/components/admin/OutOfScheduleTab';
import { Assignment, ScoringEvent, FinanceManualApproval, Teacher, ClassReviewRequest } from '@/types';

// ─── Finance helpers ──────────────────────────────────────────────────────────
const FIN_MONTHS_ADMIN = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
function finMonthLabel(monthYear: string): string {
  const [y, m] = monthYear.split('-').map(Number);
  return `${FIN_MONTHS_ADMIN[(m ?? 1) - 1]} ${y}`;
}
function finDateShort(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  return `${String(d.getDate()).padStart(2, '0')} ${FIN_MONTHS_ADMIN[d.getMonth()].slice(0, 3)}`;
}

// Las etiquetas y colores de estado salen de lib/finance (financeStatusBadge):
// una sola fuente para esta pantalla y la del profesor.

const PILL_OK   = { background: 'var(--ok-soft)',   color: 'var(--ok)' };

/**
 * Quién aprobó a mano esa clase y cuándo. Pagar una clase sin transcript es la
 * única forma de saltarse el nivel 2, así que la fila tiene que poder responder
 * quién lo decidió sin ir a buscarlo a la base.
 */
const nkStudent = (s: string) => (s ?? '').trim().toLowerCase();
function findApproval(approvals: FinanceManualApproval[], teacherId: string, studentName: string, date: string) {
  return approvals.find(a =>
    a.teacherId === teacherId && nkStudent(a.studentName) === nkStudent(studentName) && a.classDate === date);
}
function approvalBy(approvals: FinanceManualApproval[], teacherId: string, studentName: string, date: string): string {
  const a = findApproval(approvals, teacherId, studentName, date);
  return a?.approvedBy ? ` · ${a.approvedBy}` : '';
}
function approvalTrace(approvals: FinanceManualApproval[], teacherId: string, studentName: string, date: string): string {
  const a = findApproval(approvals, teacherId, studentName, date);
  if (!a) return 'Aprobada manualmente por el equipo';
  const cuando = (a.approvedAt ?? '').replace('T', ' ').slice(0, 16);
  const motivo = a.reason === 'excede_limite_aprobado' ? 'incluida pese a exceder el límite' : 'pagada sin transcript';
  return `${motivo} — ${a.approvedBy || 'sin registrar'}${cuando ? ` el ${cuando}` : ''}`;
}
const PILL_WARN = { background: 'var(--warn-soft)', color: 'var(--warn)' };

/**
 * Color del texto de un estado, accesible sobre fondo blanco.
 *
 * `financeStatusBadge` decide CUÁL es el estado y da su color de marca, pensado
 * para una pill con fondo tintado. Acá el estado va como texto sobre blanco, y el
 * verde de marca (#1E9E3A, 3.5:1) no llega a AA a este tamaño. La clasificación
 * sigue viniendo de finanzas; esto solo elige con qué tinta pintarla.
 */
function statusText(status: ClassFinanceRow['status']): string {
  if (status === 'pagable') return 'var(--accent)';
  if (status === 'a_revisar') return 'var(--warn)';
  if (status === 'excede_limite' || status === 'excede_limite_tipo') return '#C2410C';
  return 'var(--text-muted)';
}

/**
 * Las etiquetas de lib/finance vienen con emoji (fuente compartida con otras
 * pantallas). Acá se muestran sin él, igual que en la vista del profesor: se
 * recorta el prefijo no alfanumérico, sin tocar la fuente.
 */
function plainPill(label: string): string {
  return label.replace(/^[^\p{L}\p{N}€]+/u, '').trim();
}

/**
 * El plan contratado de una fila, partido en producto y variante.
 *
 * `row.plan` es la cadena de WooCommerce entera: el nombre del producto, ` — `, y
 * los atributos de la variación («5h semanales · B2 · 11:00 - 12:00 · Lunes a
 * viernes»). Son cien caracteres en los que lo que se busca —qué compró— está al
 * principio, así que se pintan con distinto peso en vez de como un solo bloque.
 *
 * Devuelve null cuando el plan no dice más que la categoría de tarifa que ya está
 * en la línea de arriba: repetir «Inglés general» debajo de «Inglés general» es
 * exactamente el ruido que este rediseño vino a quitar.
 */
function planContratado(row: ClassFinanceRow | undefined): { producto: string; variante: string } | null {
  const plan = (row?.plan ?? '').trim();
  if (!plan || plan === (row?.planLabel ?? '').trim()) return null;
  const i = plan.indexOf(' — ');
  return i < 0
    ? { producto: plan, variante: '' }
    : { producto: plan.slice(0, i).trim(), variante: plan.slice(i + 3).trim() };
}

/**
 * Lo que necesita el embudo de CUALQUIER profesor, cargado una sola vez.
 *
 * El embudo pedía sus datos por profesor y al desplegar uno se disparaban cinco
 * consultas, dos de ellas leyendo tablas enteras: `getTeacherAssignments` llama
 * por dentro a `dbGetStudents()` —la tabla de alumnos completa, que el contexto
 * ya tiene— y las bajas se volvían a pedir cada vez. Cerrar un profesor y abrir
 * otro pagaba las cinco otra vez.
 *
 * Ahora se cargan a la primera apertura, valen para todos y van EN PARALELO, y
 * se le pasan a `dbGetAllTeacherAssignments` los alumnos y las assignments que
 * el contexto ya tiene: tres consultas simultáneas la primera vez y NINGUNA a
 * partir de la segunda, en lugar de cinco por profesor.
 *
 * Las solicitudes de revisión se traen todas de golpe —son ocho filas en toda la
 * base— en vez de una consulta por profesor. Pedirlas por separado dejaba el
 * primer despliegue esperando dos viajes seguidos: primero los calendarios y
 * luego, con ellos ya en pantalla, las suyas.
 *
 * Es perezoso a propósito: quien entra a Finanzas y no despliega a nadie no paga
 * nada de esto.
 */
function useFunnelData(enabled: boolean) {
  const { teachers, students, assignments } = useTeachers();
  const [data, setData] = useState<{
    grids: Map<string, Assignment[]>;
    dropouts: StudentDropout[];
    requests: ClassReviewRequest[];
  } | null>(null);
  const pedido = useRef(false);

  useEffect(() => {
    if (!enabled || pedido.current) return;
    pedido.current = true;
    let cancelled = false;
    Promise.all([
      dbGetAllTeacherAssignments({ teachers, students, assignments }),
      dbGetStudentDropouts(),
      dbGetReviewRequests(),
    ])
      .then(([grids, dropouts, requests]) => { if (!cancelled) setData({ grids, dropouts, requests }); })
      .catch(err => {
        console.error('[finanzas] No se pudieron cargar los datos del embudo:', err);
        pedido.current = false;   // que un fallo de red no lo deje muerto
      });
    return () => { cancelled = true; };
  // Se pide UNA vez: `pedido` corta las repeticiones y los datos del contexto no
  // cambian mientras el admin tiene un profesor abierto.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return data;
}

/**
 * El embudo del profesor dentro del detalle del admin. Es el MISMO componente y
 * la misma función de cálculo que ve el profesor: si los dos leyeran fuentes
 * distintas volveríamos al problema de raíz (dos pantallas, dos números, ninguna
 * forma de saber cuál mirar).
 */
function TeacherFunnel({ teacher, monthYear, finance, asgs, dropouts, requests }: {
  teacher: Teacher; monthYear: string; finance: TeacherFinanceResult;
  /** Todo ya cargado para el conjunto de profesores; ver `useFunnelData`. */
  asgs: Assignment[];
  dropouts: StudentDropout[];
  requests: ClassReviewRequest[];
}) {
  const { classJoinLogs, classRecords, classAnalyses, students, financeRates } = useTeachers();

  const spain = getSpainParts(new Date());
  const funnel = useMemo(() => buildClassFunnel({
    monthYear, teacherId: teacher.id, assignments: asgs,
    joinLogs: classJoinLogs, classRecords, analyses: classAnalyses,
    requests, dropouts, gridOccupancy: gridOccupancyOfTeacher(teacher), finance,
    todayIso: spain.dateStr, nowMinutes: spain.hour * 60 + spain.minute,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [monthYear, teacher, asgs, classJoinLogs, classRecords, classAnalyses, requests, dropouts, finance]);

  /**
   * Cuánto vale lo que el profesor todavía puede reclamar. El admin lo necesita
   * para saber si vale la pena avisarle antes del cierre, y sale de la misma
   * estimación que ve él: mismo alumno, misma tarifa, misma duración.
   */
  const claimAmount = useMemo(() => funnel.missing
    .filter(c => c.signal !== null)
    .reduce((s, c) => s + estimateClassAmount({
      assignment: asgs.find(a => a.studentName.trim().toLowerCase() === c.studentName.trim().toLowerCase()),
      student: students.find(x => x.name.trim().toLowerCase() === c.studentName.trim().toLowerCase()),
      rates: financeRates, date: c.date, durationHours: c.durationHours,
    }), 0), [funnel, asgs, students, financeRates]);

  if (asgs.length === 0) return null;
  // Sin `showActions`: reclamar y subir transcripts es cosa del profesor, y un
  // botón que el admin no puede pulsar en su nombre solo sirve para confundir.
  return <ClassFunnelCard funnel={funnel} claimAmount={claimAmount} />;
}

/**
 * La foto del mes de un profesor en una barra, para la fila plegada.
 *
 * Se arma SOLO con `finance`, que ya está calculado para los 22 profesores: el
 * embudo completo necesita assignments, solicitudes y bajas por profesor, y
 * cargarlos al abrir la pantalla serían 66 consultas para pintar 22 barras.
 * Por eso son las tres categorías que el admin ya tiene en las columnas de
 * abajo, no las tres ramas del embudo — y el azul del embudo ("fuera del
 * calendario") no aparece acá, para que un mismo color no signifique dos cosas.
 */
function FinanceBar({ r }: { r: TeacherFinanceResult }) {
  const retenidas = r.totalExcedeLimite + r.totalExcedeLimiteTipo;
  const total = r.totalPagable + r.totalARevisar + retenidas;
  if (total === 0) return null;
  return (
    <div className="afd-bar" title={`${r.totalPagable} pagables · ${r.totalARevisar} pendientes de transcript · ${retenidas} retenidas por límite`}>
      {r.totalPagable > 0 && <div className="fnl-seg is-con"   style={{ flexGrow: r.totalPagable }} />}
      {r.totalARevisar > 0 && <div className="fnl-seg is-sin"  style={{ flexGrow: r.totalARevisar }} />}
      {retenidas > 0       && <div className="fnl-seg is-hold" style={{ flexGrow: retenidas }} />}
    </div>
  );
}

/**
 * Estado de la suscripción de las clases PAGABLES, al momento de darse.
 *
 * Es lo único que vivía en la caja "Total a cobrar" y no está en la fila
 * plegada: allí solo hay un ⚠️ con los estados SIN acceso escondidos en un
 * tooltip. Las líneas informativas —el alumno sí podía tomar clase, pero su
 * acceso no venía de una suscripción viva de WooCommerce— no estaban en
 * ningún otro sitio.
 *
 * Ninguna de las dos cambia el importe: lo que decide que una clase se pague
 * sigue siendo el clic en "Unirse" más el transcript.
 */
function SubStatusNotes({ result }: { result: TeacherFinanceResult }) {
  if (result.payableSubStatuses.length === 0) return null;
  return (
    <div className="afd-subnotes">
      {result.payableSubStatuses.map(s => (
        <div key={s.status} className={s.countsAsActive ? undefined : 'is-warn'}>
          {s.count === 1 ? '1 clase pagable' : `${s.count} clases pagables`}
          {' '}con la suscripción en «{s.label}»
          {s.countsAsActive ? ' (vigente: el alumno podía tomar clases).' : ' (sin acceso al momento de darse).'}
        </div>
      ))}
    </div>
  );
}

/**
 * Las clases de un alumno: UNA LÍNEA cada una.
 *
 * Antes era una tarjeta con hasta seis pills. En una clase normal y pagable, tres
 * de ellas decían lo mismo con distintas palabras: «Pagable» ya significa que
 * hubo ingreso Y transcript validado, así que repetir «✅ A tiempo» y «Transcript
 * subido» al lado no añadía nada. Ahora el estado es la conclusión y solo se
 * pinta lo que NO se deduce de él: el tipo cuando no es una clase normal, y el
 * estado del transcript cuando no es el esperado.
 *
 * La suscripción salió de acá: era el estado de WooCommerce del momento de esa
 * clase, repetido en cada fila del alumno. Vive una vez arriba, en la cabecera.
 */
function ClassRows({ result, studentName, approvals, onApproveReview, onApproveExceed, onRevertAbsence }: {
  result: TeacherFinanceResult;
  studentName: string;
  approvals: FinanceManualApproval[];
  onApproveReview: (date: string) => void;
  onApproveExceed: (date: string) => void;
  onRevertAbsence: (row: ClassFinanceRow) => void;
}) {
  const rows = result.rows.filter(r => nkStudent(r.studentName) === nkStudent(studentName));
  if (rows.length === 0) return <div className="afd-empty">Sin clases registradas este mes.</div>;

  return (
    <div className="fch-list">
      {rows.map((r, i) => {
        const st = financeStatusBadge(r.status);
        const ct = classTypeBadge(r.classType);
        const isFalta = r.classType === 'falta_sin_aviso' || r.classType === 'cancelacion_hora';
        const editable = result.paymentStatus !== 'paid' && !r.manuallyApproved;
        // Detalle del transcript SOLO cuando cambia lo que hay que hacer: subido y
        // validado ya lo dice el estado; en revisión o rechazado, no.
        const txNote = !isFalta && (r.transcriptState === 'review' || r.transcriptState === 'rejected')
          ? transcriptStateBadge(r.transcriptState).label
          : null;
        const notas = [absenceBreakdownLabel(r), recoveryCreditLabel(r)].filter(Boolean);
        return (
          <div className={`fch-cls${r.status !== 'pagable' ? ' is-flag' : ''}`} key={i}>
            <span className="fch-cls-when">
              {finDateShort(r.date)}
              {r.hour && <span className="fch-cls-h">{r.hour}</span>}
            </span>
            <span className="fch-cls-state" style={{ color: statusText(r.status) }}>
              <span className="fch-dot" style={{ background: st.dot }} />
              {st.short}
            </span>
            <span className="fch-cls-type">
              {[ct && plainPill(ct.label), txNote, r.billingUnits > 1 ? `${r.durationHours}h` : null]
                .filter(Boolean).join(' · ')}
            </span>
            <span className="fch-cls-eur">€{(r.rate * r.billingUnits).toFixed(2)}</span>
            <span>
              {/* Revertir una falta marcada por error: la clase vuelve a pendiente
                  y deja de contar para el pago, el tope del mes y el cupo. */}
              {isStudentAbsence(r.classType) && r.recordId && result.paymentStatus !== 'paid' && (
                <button className="fch-cls-btn" onClick={() => onRevertAbsence(r)}>Revertir falta</button>
              )}
              {editable && r.status === 'a_revisar' && (
                <button className="fch-cls-btn" onClick={() => onApproveReview(r.date)}>Pagar sin transcript</button>
              )}
              {editable && (r.status === 'excede_limite' || r.status === 'excede_limite_tipo') && (
                <button className="fch-cls-btn" onClick={() => onApproveExceed(r.date)}>Incluir igual</button>
              )}
            </span>
            {/* Pagar sin transcript es la única forma de saltarse el nivel 2, así
                que la fila dice quién lo decidió y cuándo. */}
            {r.manuallyApproved && (
              <span className="fch-cls-note is-ok" title={approvalTrace(approvals, result.teacherId, r.studentName, r.date)}>
                Aprobada por el equipo{approvalBy(approvals, result.teacherId, r.studentName, r.date)}
              </span>
            )}
            {notas.map((n, k) => <span className="fch-cls-note" key={k}>{n}</span>)}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Alumnos del profesor. La fila plegada compara; al abrir, la ficha responde tres
 * preguntas en este orden: quién es y si está al día, qué pide acción, y el
 * detalle clase a clase.
 *
 * Lo que se fue de la versión anterior: la grilla de seis campos etiqueta/valor
 * —tres de los cuales repetían la cabecera que tenían justo encima— y otros dos
 * (antigüedad y tarifa) que salían de `rows[0]`, o sea de la PRIMERA clase del
 * mes: a un alumno que cruzaba los 30 días a mitad de mes le mostraban la
 * antigüedad y la tarifa viejas sin decirlo.
 */
function StudentDetailList({ result, assignments, approvals, onApproveReview, onApproveExceed, onRevertAbsence }: {
  result: TeacherFinanceResult;
  assignments: Assignment[];
  approvals: FinanceManualApproval[];
  onApproveReview: (studentName: string, date: string) => void;
  onApproveExceed: (studentName: string, date: string) => void;
  onRevertAbsence: (row: ClassFinanceRow) => void;
}) {
  const [openStudent, setOpenStudent] = useState<string | null>(null);

  // Agrupar filas por alumno.
  const byStudent = new Map<string, ClassFinanceRow[]>();
  for (const r of result.rows) {
    if (!byStudent.has(r.studentName)) byStudent.set(r.studentName, []);
    byStudent.get(r.studentName)!.push(r);
  }
  const students = [...byStudent.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  if (students.length === 0) return <div className="afd-empty">Sin clases registradas este mes.</div>;

  return (
    <div>
      <div className="afd-section-title">Alumnos ({students.length})</div>
      <div>
        {students.map(([name, rows]) => {
          // Emparejamiento TOLERANTE, como en el resto del código. Con `===` un
          // alumno escrito distinto en `assignments` mostraba «Inicio —» sin más.
          const asgn = assignments.find(a =>
            a.teacherId === result.teacherId && nkStudent(a.studentName) === nkStudent(name));
          const units = (rs: ClassFinanceRow[]) => rs.reduce((s, r) => s + r.billingUnits, 0);
          const euros = (rs: ClassFinanceRow[]) => rs.reduce((s, r) => s + r.rate * r.billingUnits, 0);
          const pagables = rows.filter(r => r.status === 'pagable');
          const revisar  = rows.filter(r => r.status === 'a_revisar');
          const excede   = rows.filter(r => r.status === 'excede_limite');
          const excTipo  = rows.filter(r => r.status === 'excede_limite_tipo');
          const isOpen = openStudent === name;
          // El cupo sale de finanzas, que ya lo calculó para decidir qué clase
          // quedaba fuera. La pantalla no lo deriva de weeklyHours por su cuenta.
          const quota = studentQuotaOf(result, name);
          const lleno = quota?.limit != null && quota.used >= quota.limit;
          // Estado de la suscripción en su ÚLTIMA clase. No es una comprobación de
          // hoy —eso solo lo sabe WooCommerce— sino el último dato verificado que
          // hay en local, y por eso se dice con su fecha.
          const ultimaSub = [...rows].reverse().find(r => r.subscriptionStatus);
          const subOk = isActiveWooStatus(ultimaSub?.subscriptionStatus);
          const plan = planContratado(rows[0]);

          // Lo que pide una decisión del admin, con su dinero. Cuenta las retenidas
          // por el cupo, no solo los transcripts: la pill verde «OK» de antes solo
          // miraba `a_revisar`, así que un alumno con clases fuera del cupo salía
          // en verde. En agosto le pasaba a 4 de los 5 que tenían clases retenidas.
          const problemas: Array<{ n: number; amount: number; txt: string; det: string }> = [];
          if (revisar.length > 0) problemas.push({
            n: units(revisar), amount: euros(revisar),
            txt: 'clases sin transcript',
            det: 'El profesor las dio y todavía no subió el texto. Pasan a pagables solas en cuanto lo suba.',
          });
          if (excede.length > 0) problemas.push({
            n: units(excede), amount: euros(excede),
            txt: 'clases fuera del cupo del mes',
            det: `Superan las ${quota?.limit ?? '—'} que incluye su plan. Cada una se puede incluir igual desde la lista.`,
          });
          if (excTipo.length > 0) problemas.push({
            n: units(excTipo), amount: euros(excTipo),
            txt: 'faltas o cancelaciones de más',
            det: 'Superan las 2 cobrables de ese tipo en el mes. Cada una se puede incluir igual desde la lista.',
          });

          return (
            <div key={name} className={`fch${isOpen ? ' is-open' : ''}`}>
              <button className="fch-head" aria-expanded={isOpen}
                onClick={() => setOpenStudent(isOpen ? null : name)}>
                <span className="fch-name">
                  <span className="fch-caret" aria-hidden>{isOpen ? '▾' : '▸'}</span>
                  <span style={{ overflowWrap: 'anywhere' }}>{name}</span>
                </span>
                <span className="fch-head-right">
                  {problemas.length === 0
                    ? <span className="fch-flag is-ok">Al día</span>
                    : <>
                        {revisar.length > 0 && <span className="fch-flag is-rev">{units(revisar)} sin transcript</span>}
                        {(excede.length > 0 || excTipo.length > 0) && (
                          <span className="fch-flag is-exc">{units(excede) + units(excTipo)} fuera del cupo</span>
                        )}
                      </>}
                  <span className="fch-count">{units(pagables)} {units(pagables) === 1 ? 'clase' : 'clases'}</span>
                  <span className="fch-total">€{euros(pagables).toFixed(2)}</span>
                </span>
              </button>

              {isOpen && (
                <div className="fch-body">
                  {/* Contexto en UNA línea: lo justo para situar al alumno. */}
                  <div className="fch-ctx">
                    <span>{rows[0]?.planLabel ?? '—'}</span>
                    <span className="fch-sep">·</span>
                    <span>{asgn?.startDate ? `desde el ${finDateShort(asgn.startDate)}` : 'sin asignación activa'}</span>
                    {!asgn && <span className="fch-ex" title="Ya no tiene plan con este profesor, pero sus clases del mes siguen contando para el pago">ex-alumno</span>}
                    <span className="fch-spacer" />
                    {ultimaSub && (
                      <span className={`fch-sub${subOk ? '' : ' is-bad'}`}
                        title="Estado de WooCommerce registrado en su última clase. No es una comprobación de hoy.">
                        Suscripción: {plainPill(subscriptionBadge(ultimaSub.subscriptionStatus).label)}
                        <span className="fch-sub-when"> · visto el {finDateShort(ultimaSub.date)}</span>
                      </span>
                    )}
                  </div>

                  {/* El plan CONTRATADO, debajo de la suscripción: el producto de
                      WooCommerce tal cual, que es distinto de la categoría de
                      tarifa de la línea de arriba («Exámenes» decide cuánto se le
                      paga al profesor; esto es lo que compró el alumno).

                      Solo cuando dice algo más que la categoría: un alumno cuyo
                      plan es literalmente «Inglés general» ya lo tiene escrito
                      dos centímetros más arriba. */}
                  {plan && (
                    <div className="fch-plan">
                      <span className="fch-plan-label">Plan</span>
                      <span className="fch-plan-value">
                        {plan.producto}
                        {plan.variante && <span className="fch-plan-var">{plan.variante}</span>}
                      </span>
                    </div>
                  )}

                  {/* El cupo del mes: el número que antes había que deducir contando filas. */}
                  <div className="fch-quota">
                    <span className="fch-quota-label">Clases del mes</span>
                    {quota?.limit == null ? (
                      <span className="fch-quota-none">Sin cupo — ya no tiene plan con este profesor</span>
                    ) : (
                      <>
                        <span className="fch-quota-bar">
                          <span className={`fch-quota-fill${lleno ? ' is-full' : ''}`}
                            style={{ width: `${Math.min(100, Math.round((quota.used / quota.limit) * 100))}%` }} />
                        </span>
                        <span className={`fch-quota-n${lleno ? ' is-full' : ''}`}>{quota.used} de {quota.limit}</span>
                      </>
                    )}
                  </div>

                  {/* Lo que pide acción, ANTES del detalle. */}
                  {problemas.length > 0 && (
                    <div className="fch-act">
                      {problemas.map((p, k) => (
                        <div className="fch-act-row" key={k}>
                          <span className="fch-act-n">{p.n}</span>
                          <span className="fch-act-body">
                            <span className="fch-act-top">
                              {p.txt}<b className="fch-act-eur">€{p.amount.toFixed(2)} sin pagar</b>
                            </span>
                            <span className="fch-act-sub">{p.det}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  <ClassRows
                    result={result} studentName={name} approvals={approvals}
                    onApproveReview={date => onApproveReview(name, date)}
                    onApproveExceed={date => onApproveExceed(name, date)}
                    onRevertAbsence={onRevertAbsence}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
function FinanceTab() {
  const { user } = useAuth();
  const {
    teachers, students, assignments, classJoinLogs, classRecords, classAnalyses, financeRates, financePayments,
    scoringEvents, manualApprovals,
    loadFinanceData, markPaymentAsPaid, approveReviewClass, approveExceedLimitClass, revertStudentAbsence,
  } = useTeachers();
  const approvedBy = user?.displayName || user?.username || 'admin';

  const nowSpain = getSpainParts(new Date());
  const [monthYear, setMonthYear] = useState(nowSpain.dateStr.slice(0, 7));
  const [teacherFilter, setTeacherFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'paid' | 'pending'>('all');
  const [subFilter, setSubFilter] = useState('all'); // estado de suscripción
  const [expandedTeacher, setExpandedTeacher] = useState<string | null>(null);
  // Calendarios y bajas: se piden al desplegar al primer profesor y sirven para
  // todos. Ver `useFunnelData`.
  const funnelData = useFunnelData(expandedTeacher !== null);
  const [paying, setPaying] = useState<string | null>(null);
  // Reversión de penalización (Bloque 4.5).
  const [revertModal, setRevertModal] = useState<ScoringEvent | null>(null);
  const [revertReason, setRevertReason] = useState('');
  const [reverting, setReverting] = useState(false);
  // Reversión de una falta sin aviso del ALUMNO (otra cosa que la penalización).
  const [absenceModal, setAbsenceModal] = useState<{ row: ClassFinanceRow; teacherName: string } | null>(null);
  const [absenceError, setAbsenceError] = useState('');
  const [revertingAbsence, setRevertingAbsence] = useState(false);

  async function handleRevertAbsence() {
    if (!absenceModal?.row.recordId) return;
    setRevertingAbsence(true); setAbsenceError('');
    try {
      await revertStudentAbsence(absenceModal.row.recordId, approvedBy);
      setAbsenceModal(null);
      await loadFinanceData();
    } catch (e) {
      setAbsenceError((e as Error).message || 'No se pudo revertir la falta.');
    } finally {
      setRevertingAbsence(false);
    }
  }

  async function handleRevert() {
    if (!revertModal || !revertReason.trim()) return;
    setReverting(true);
    try {
      await dbRevertPenalty({
        penaltyId: revertModal.id, teacherId: revertModal.teacherId, teacherName: revertModal.teacherName,
        originalDate: (revertModal.createdAt ?? '').slice(0, 10), studentName: revertModal.studentRef,
        reason: revertReason.trim(), adminName: approvedBy,
        amount: Math.abs(revertModal.euros ?? 5),   // devuelve lo que se descontó
      });
      setRevertModal(null); setRevertReason('');
      await loadFinanceData();
    } catch (e) {
      alert(`No se pudo revertir: ${(e as Error).message}`);
    } finally {
      setReverting(false);
    }
  }

  // Toda penalización del mes = cualquier evento con euros negativos, sea del tipo
  // que sea (falta sin aviso del calendario, falta injustificada del admin…). Si se
  // filtrara por un event_type concreto, una penalización de otro tipo restaría del
  // total sin salir en la lista ni poder revertirse.
  const penaltiesOf = (teacherId: string): ScoringEvent[] => scoringEvents.filter(e =>
    e.teacherId === teacherId && (e.euros ?? 0) < 0 &&
    (e.createdAt ?? '').slice(0, 7) === monthYear);

  useEffect(() => { loadFinanceData(); /* eslint-disable-next-line */ }, []);

  // Calcular finanzas por profesor (filtrados).
  const results = useMemo<TeacherFinanceResult[]>(() => {
    return teachers
      .filter(t => !teacherFilter || t.id === teacherFilter)
      .map(t => {
        const payment = financePayments.find(p => p.teacherId === t.id && p.monthYear === monthYear) ?? null;
        // MISMAS entradas que la vista del profesor (app/mis-clases) y que la
        // liquidación (TeachersContext.markPaymentAsPaid). Si esta llamada y esa
        // no reciben lo mismo, el admin y el profesor ven finanzas distintas del
        // mismo mes — que es exactamente lo que pasaba sin `classAnalyses`.
        const occ = gridOccupancyOfTeacher(t);
        return calculateTeacherFinance({
          teacherId: t.id, teacherName: t.name, monthYear,
          // Assignments SIN tocar: finanzas no saca clases de los slots (salen de
          // ingresos y registros), y necesita el horario de la ficha como último
          // horario conocido de los alumnos que ya no están en el calendario. Si
          // se los vaciáramos, sus sesiones de 2h pasadas valdrían 1.
          assignments,
          joinLogs: classJoinLogs, classRecords, classAnalyses, rates: financeRates,
          scoringEvents, students, manualApprovals, payment,
          // El calendario de ESE profesor decide qué es una clase de 2h.
          gridOccupancy: occ,
        });
      })
      .filter(r => {
        if (statusFilter === 'paid') return r.paymentStatus === 'paid';
        if (statusFilter === 'pending') return r.paymentStatus !== 'paid';
        return true;
      });
  }, [teachers, students, teacherFilter, statusFilter, monthYear, assignments, classJoinLogs, classRecords, classAnalyses, financeRates, scoringEvents, manualApprovals, financePayments]);

  // Solo mostrar profesores con actividad en el mes (o el filtrado explícito).
  let visible = results.filter(r => teacherFilter || r.rows.length > 0 || r.bonusFromScoring > 0 || r.penaltiesFromScoring < 0 || r.paymentStatus === 'paid');
  // Filtro por estado de suscripción: profesores con alguna clase de ese estado.
  if (subFilter !== 'all') {
    visible = visible.filter(r => r.rows.some(row => (row.subscriptionStatus ?? 'error') === subFilter));
  }

  // Cards de resumen.
  const sumTotal     = visible.reduce((s, r) => s + r.totalAPagar, 0);
  const sumPagables  = visible.reduce((s, r) => s + r.totalPagable, 0);
  const sumARevisar  = visible.reduce((s, r) => s + r.totalARevisar, 0);
  const sumPendiente = visible.reduce((s, r) => s + r.montoARevisar, 0);
  const sumRetenido  = visible.reduce((s, r) => s + r.montoRetenido, 0);

  const cards = [
    { label: 'Total a pagar', value: `€${sumTotal.toFixed(2)}`, color: '#1E9E3A', hint: 'Solo clases pagables (ingreso + transcript) más bonos y penalizaciones' },
    { label: 'Clases pagables', value: sumPagables, color: 'var(--text-primary)', hint: 'Con ingreso registrado y transcript validado' },
    { label: 'Pendiente de transcript', value: `€${sumPendiente.toFixed(2)}`, color: sumARevisar > 0 ? '#9a6516' : '#1E9E3A', hint: `${sumARevisar} clases dadas con ingreso pero sin transcript: NO suman al total` },
    { label: 'Monto retenido', value: `€${sumRetenido.toFixed(2)}`, color: sumRetenido > 0 ? '#ea580c' : '#1E9E3A', hint: 'Clases que superan el límite mensual del plan o las 2 por tipo' },
  ];

  function exportCsv() {
    // Horas/Cuenta como: una sesión de 2h es una fila que vale 2 clases, así que
    // el importe de la fila es tarifa × unidades y el CSV tiene que decirlo.
    const lines = ['Profesor,Alumno,Fecha,Hora,Horas,Cuenta como,Tarifa,Importe,Estado,Total profesor'];
    for (const r of visible) {
      for (const row of r.rows) {
        lines.push([
          `"${r.teacherName}"`, `"${row.studentName}"`, row.date,
          `"${rowHoursLabel(row)}"`, row.durationHours, row.billingUnits,
          row.rate.toFixed(2), (row.rate * row.billingUnits).toFixed(2),
          row.status, r.totalAPagar.toFixed(2),
        ].join(','));
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `finanzas_${monthYear}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  async function handlePay(teacherId: string) {
    setPaying(teacherId);
    await markPaymentAsPaid(teacherId, monthYear);
    setPaying(null);
  }

  const inputStyle = { padding: '8px 12px', borderRadius: 8, border: '1.5px solid var(--border)', fontSize: 13, background: 'var(--bg-surface)', color: 'var(--text-primary)', fontFamily: 'inherit' };

  return (
    <div>
      {/* Cards de resumen */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 14, marginBottom: 18 }}>
        {cards.map(c => (
          <div key={c.label} title={c.hint} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px' }}>
            <div style={{ fontSize: 26, fontWeight: 700, color: c.color }}>{c.value}</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginTop: 3 }}>{c.label}</div>
          </div>
        ))}
      </div>

      {/* Filtros */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px', marginBottom: 18, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 5 }}>Profesor</label>
          <select value={teacherFilter} onChange={e => setTeacherFilter(e.target.value)} style={{ ...inputStyle, minWidth: 180 }}>
            <option value="">Todos</option>
            {teachers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 5 }}>Mes</label>
          <input type="month" value={monthYear} onChange={e => setMonthYear(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 5 }}>Estado</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {([['all','Todos'],['paid','Pagado'],['pending','Pendiente']] as const).map(([id, label]) => (
              <button key={id} onClick={() => setStatusFilter(id)} style={{ padding: '7px 14px', borderRadius: 20, border: `1.5px solid ${statusFilter === id ? '#1E9E3A' : 'var(--border)'}`, background: statusFilter === id ? 'rgba(30,158,58,0.1)' : 'transparent', color: statusFilter === id ? '#1E9E3A' : 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, fontWeight: statusFilter === id ? 700 : 500, fontFamily: 'inherit' }}>{label}</button>
            ))}
          </div>
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 5 }}>Suscripción</label>
          <select value={subFilter} onChange={e => setSubFilter(e.target.value)} style={inputStyle}>
            <option value="all">Todas</option>
            {SUBSCRIPTION_STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <button onClick={exportCsv} style={{ marginLeft: 'auto', padding: '9px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-surface-2)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>
          ⬇ Exportar CSV
        </button>
      </div>

      {/* Profesores del mes */}
      {visible.length === 0 ? (
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: 14 }}>
          Sin datos de finanzas para {finMonthLabel(monthYear)}.
        </div>
      ) : (
        <div className="afd-list">
          {visible.map(r => {
          const isOpen = expandedTeacher === r.teacherId;
          return (
            <div key={r.teacherId} className={`afd-teacher${isOpen ? ' is-open' : ''}`}>
              <div className="afd-teacher-head">
                <div className="afd-teacher-name">{r.teacherName}</div>
                <div className="afd-teacher-right">
                  <span className="afd-pill" style={r.paymentStatus === 'paid' ? PILL_OK : PILL_WARN}>
                    {r.paymentStatus === 'paid' ? '✅ Pagado' : '⏳ Pendiente'}
                  </span>
                  <span className="afd-teacher-amount">
                    €{r.totalAPagar.toFixed(2)}
                    {/* Solo el icono: el aviso completo está en la cabecera del detalle. */}
                    {r.hasInactiveSubPayable && (
                      <span style={{ marginLeft: 5, cursor: 'help' }}
                        title={`Clases pagables sin suscripción con acceso: ${
                          r.payableSubStatuses.filter(s => !s.countsAsActive).map(s => `${s.count} en «${s.label}»`).join(', ')
                        }`}>
                        ⚠️
                      </span>
                    )}
                  </span>
                </div>
              </div>

              {/* Cómo se reparte el mes, de un vistazo y sin abrir el detalle:
                  con 22 profesores en la lista, comparar cuatro cifras por fila
                  es justo lo que nadie hace. */}
              <FinanceBar r={r} />

              <div className="afd-stats">
                <div>
                  <div className="afd-brow-label">Pagables</div>
                  <div className="afd-brow-value">{r.totalPagable} · €{r.montoPagable.toFixed(2)}</div>
                </div>
                <div>
                  <div className="afd-brow-label">Pendiente de transcript</div>
                  <div className={`afd-brow-value${r.totalARevisar > 0 ? ' is-warn' : ''}`}>
                    {r.totalARevisar} · €{r.montoARevisar.toFixed(2)}
                  </div>
                </div>
                <div>
                  <div className="afd-brow-label">Excede límite</div>
                  <div className={`afd-brow-value${r.totalExcedeLimite > 0 ? ' is-warn' : ''}`}>
                    {r.totalExcedeLimite} · €{r.montoRetenido.toFixed(2)}
                  </div>
                </div>
                <div>
                  <div className="afd-brow-label">Bonos</div>
                  <div className="afd-brow-value">€{r.bonusFromScoring.toFixed(2)}</div>
                </div>
              </div>

              <div className="afd-actions">
                <button className="afd-btn-ghost" onClick={() => setExpandedTeacher(isOpen ? null : r.teacherId)} aria-expanded={isOpen}>
                  {isOpen ? 'Ocultar detalle' : 'Ver detalle'}
                </button>
                {r.paymentStatus !== 'paid' && (
                  <button className="afd-btn-pay" onClick={() => handlePay(r.teacherId)} disabled={paying === r.teacherId}>
                    {paying === r.teacherId ? '…' : 'Marcar pagado'}
                  </button>
                )}
              </div>

              {isOpen && (
                  <div className="afd-panel">
                    <div className="afd">
                      <SubStatusNotes result={r} />
                      {/* El mismo embudo que ve el profesor, con la misma
                          función de cálculo: dos números iguales o ninguno. */}
                      {(() => {
                        const t = teachers.find(x => x.id === r.teacherId);
                        if (!t) return null;
                        if (!funnelData) return <div className="afd-empty">Cargando el detalle…</div>;
                        return (
                          <TeacherFunnel
                            teacher={t} monthYear={monthYear} finance={r}
                            asgs={funnelData.grids.get(t.id) ?? []}
                            dropouts={funnelData.dropouts}
                            requests={funnelData.requests.filter(q => q.teacherId === t.id)}
                          />
                        );
                      })()}
                      <StudentDetailList
                        result={r} assignments={assignments} approvals={manualApprovals}
                        onApproveReview={(student, date) => approveReviewClass(r.teacherId, student, date, approvedBy)}
                        onApproveExceed={(student, date) => approveExceedLimitClass(r.teacherId, student, date, approvedBy)}
                        onRevertAbsence={row => { setAbsenceModal({ row, teacherName: r.teacherName }); setAbsenceError(''); }}
                      />
                      {penaltiesOf(r.teacherId).length > 0 && (
                        <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', background: 'var(--bg-surface)' }}>
                          {/* El total va acá, junto a la lista que lo compone. Es
                              el único número de la caja borrada que la fila
                              plegada no muestra: allí solo están los bonos. */}
                          <div style={{ fontSize: 12.5, fontWeight: 700, color: '#c0392b', marginBottom: 8 }}>
                            Penalizaciones del mes · −€{Math.abs(r.penaltiesFromScoring).toFixed(2)}
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {penaltiesOf(r.teacherId).map(p => (
                              <div key={p.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, fontSize: 12.5, flexWrap: 'wrap' }}>
                                <span style={{ color: p.reverted ? 'var(--text-muted)' : 'var(--text-secondary)', textDecoration: p.reverted ? 'line-through' : undefined }}>
                                  {p.note.replace(/^(Falta sin aviso registrada|Cancelación sin antelación) — /, '')} · −€{Math.abs(p.euros).toFixed(2)}
                                </span>
                                {p.reverted ? (
                                  <span style={{ fontSize: 11.5, color: '#1f7a3d', fontWeight: 700, whiteSpace: 'nowrap' }}>Revertida{p.revertedBy ? ` · ${p.revertedBy}` : ''}</span>
                                ) : (
                                  <button onClick={() => { setRevertModal(p); setRevertReason(''); }}
                                    style={{ padding: '4px 11px', borderRadius: 7, border: '1px solid #f0c4bd', background: 'white', color: '#c0392b', cursor: 'pointer', fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                                    Revertir
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
              )}
            </div>
          );
          })}
        </div>
      )}

      {/* Modal de reversión de una FALTA SIN AVISO DEL ALUMNO.
          No confundir con el de abajo: aquel devuelve euros de una penalización al
          profesor; este QUITA una clase que se le estaba pagando. */}
      {absenceModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget && !revertingAbsence) setAbsenceModal(null); }}>
          <div style={{ background: '#F7F7F5', border: '1px solid var(--border)', borderRadius: 14, padding: 24, width: '100%', maxWidth: 460 }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: '#111827', marginBottom: 8 }}>Revertir falta sin aviso</div>
            <div style={{ fontSize: 13, color: '#5f6360', lineHeight: 1.6, marginBottom: 16 }}>
              Se quitará la marca de falta de la clase de <b>{absenceModal.row.studentName}</b> del{' '}
              <b>{absenceModal.row.date}</b> ({absenceModal.teacherName}). La clase vuelve a
              <b> pendiente de transcript</b>: deja de sumar los{' '}
              <b>€{(absenceModal.row.rate * absenceModal.row.billingUnits).toFixed(2)}</b> al pago, libera el
              cupo mensual del alumno y el hueco del tope de faltas del mes. Queda el registro de que
              la falta existió y de quién la revirtió.
            </div>
            {absenceError && (
              <div style={{ fontSize: 12.5, color: '#c0392b', background: 'rgba(239,68,68,0.08)', borderRadius: 8, padding: '9px 12px', marginBottom: 12 }}>
                {absenceError}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setAbsenceModal(null)} disabled={revertingAbsence}
                style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: '#6b7280', cursor: revertingAbsence ? 'not-allowed' : 'pointer', fontSize: 13, fontFamily: 'inherit' }}>Cancelar</button>
              <button onClick={handleRevertAbsence} disabled={revertingAbsence}
                style={{ flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: revertingAbsence ? '#d1d5db' : '#1E9E3A', color: 'white', cursor: revertingAbsence ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
                {revertingAbsence ? 'Revirtiendo…' : 'Confirmar reversión'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de reversión de penalización (Bloque 4.5) */}
      {revertModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget && !reverting) setRevertModal(null); }}>
          <div style={{ background: '#F7F7F5', border: '1px solid var(--border)', borderRadius: 14, padding: 24, width: '100%', maxWidth: 440 }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: '#111827', marginBottom: 8 }}>Revertir penalización</div>
            <div style={{ fontSize: 13, color: '#5f6360', lineHeight: 1.6, marginBottom: 16 }}>
              Se devolverán <b>5,00 €</b> al balance de <b>{revertModal.teacherName}</b> por la falta registrada
              el {(revertModal.createdAt ?? '').slice(0, 10)}{revertModal.studentRef ? ` con ${revertModal.studentRef}` : ''}.
            </div>
            <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Motivo de la reversión</label>
            <textarea value={revertReason} onChange={e => setRevertReason(e.target.value)} rows={3} autoFocus
              placeholder="Ej: el alumno confirmó que avisó por WhatsApp"
              style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1.5px solid var(--border)', fontSize: 13, background: 'white', color: '#111827', fontFamily: 'inherit', boxSizing: 'border-box', resize: 'vertical' }} />
            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <button onClick={() => setRevertModal(null)} disabled={reverting} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: '#6b7280', cursor: reverting ? 'not-allowed' : 'pointer', fontSize: 13, fontFamily: 'inherit' }}>Cancelar</button>
              <button onClick={handleRevert} disabled={reverting || !revertReason.trim()}
                style={{ flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: reverting || !revertReason.trim() ? '#d1d5db' : '#1E9E3A', color: 'white', cursor: reverting || !revertReason.trim() ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
                {reverting ? 'Revirtiendo…' : 'Confirmar reversión'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* La contrapartida de «Dadas fuera de tu horario» del embudo del profesor:
          allí solo se le dice que se cobran igual, y el arreglo se hace acá. Se
          carga al pedirlo, no al abrir Finanzas. */}
      <OutOfScheduleTab monthYear={monthYear} monthLabel={finMonthLabel(monthYear)} />
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
// Explica la regla de DOS NIVELES (entrada y pago). Solo informativo.
function HowItWorksModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: '#F7F7F5', borderRadius: 16, width: '100%', maxWidth: 520, maxHeight: '88vh', overflowY: 'auto', padding: 26, fontFamily: 'var(--font-app)' }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#1a1c1a', marginBottom: 6 }}>
          Cómo entra y cómo se paga una clase
        </div>
        <p style={{ fontSize: 13.5, color: '#5f6360', lineHeight: 1.65, margin: '0 0 18px' }}>
          Son <b>dos preguntas distintas</b>, y en este orden:
        </p>

        <ol style={{ margin: '0 0 18px', paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <li>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#1a1c1a' }}>
              ¿Entra a finanzas? — lo decide el clic en &laquo;Unirse a clase&raquo;
            </div>
            <div style={{ fontSize: 13.5, color: '#5f6360', lineHeight: 1.6, marginTop: 3 }}>
              El acceso queda registrado con la hora exacta y es lo que hace que la clase exista para
              el pago. <b>Si el profesor no pulsó el botón, la clase no aparece acá</b>: no se cuenta
              ni siquiera como pendiente, y subir el transcript después no la trae de vuelta.
            </div>
          </li>
          <li>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#1a1c1a' }}>
              ¿Se cobra? — lo decide el transcript
            </div>
            <div style={{ fontSize: 13.5, color: '#5f6360', lineHeight: 1.6, marginTop: 3 }}>
              De las clases que entraron, se pagan las que tienen el transcript subido y validado
              (&laquo;Mis clases&raquo; → &laquo;Añadir clase&raquo;, el texto que genera Fathom).
              Las demás quedan pendientes y pasan a pagables solas en cuanto se sube.
            </div>
          </li>
        </ol>

        <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#8b8e88', marginBottom: 8 }}>
          Estados posibles
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
          {[
            { dot: '#1E9E3A', label: 'Pagable', desc: 'clic + transcript validado — suma al total a cobrar' },
            { dot: '#FFC400', label: 'Pendiente de transcript', desc: 'clic sin transcript: la clase se dio y se ve, pero NO suma al total' },
            { dot: '#a4a7a1', label: 'No aparece', desc: 'sin clic en «Unirse a clase» la clase no entró a finanzas' },
          ].map(s => (
            <div key={s.label} style={{ display: 'grid', gridTemplateColumns: '9px 1fr', gap: 10, alignItems: 'start' }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: s.dot, marginTop: 6 }} />
              <span style={{ fontSize: 13.5, color: '#5f6360', lineHeight: 1.55 }}>
                <b style={{ color: '#1a1c1a' }}>{s.label}</b> — {s.desc}
              </span>
            </div>
          ))}
        </div>

        <div style={{ fontSize: 12.5, color: '#9a6516', background: '#fdf3e7', border: '1px solid #f2e2c9', borderRadius: 10, padding: '10px 13px', lineHeight: 1.6, marginBottom: 18 }}>
          Única excepción al clic: <b>falta sin aviso</b> y <b>cancelación sobre la hora</b>. El alumno
          no vino, así que no puede haber ingreso: entran por el registro que crea el profesor y se
          cobran las 2 primeras de cada tipo por alumno, sin transcript.
        </div>

        <button
          onClick={onClose}
          style={{ width: '100%', padding: '11px', borderRadius: 10, border: 'none', background: '#1E9E3A', color: '#fff', fontFamily: 'inherit', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
        >
          Entendido
        </button>
      </div>
    </div>
  );
}

function FinanzasContent() {
  const { reloadAll } = useTeachers();
  const [howOpen, setHowOpen] = useState(false);
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }}>
      <NavBar />
      <PullToRefresh onRefresh={reloadAll}>
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '32px 20px 48px' }}>
          <LastUpdated />
          <div style={{ marginBottom: 24, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 4px' }}>Finanzas</h1>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>Gestión de pagos a profesores</p>
            </div>
            <button
              onClick={() => setHowOpen(true)}
              style={{ border: '1px solid var(--border)', background: 'var(--bg-surface)', borderRadius: 9, padding: '8px 14px', fontFamily: 'inherit', fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', cursor: 'pointer', minHeight: 40 }}
            >
              ¿Cómo entra y se paga una clase?
            </button>
          </div>
          <FinanceTab />
          {/* Solicitudes de revisión: clases que esperan a que alguien las
              habilite para el pago. Viven acá y no en una pestaña propia del
              panel porque son exactamente eso — clases esperando cobro— y
              separarlas del resto de finanzas era pedir que se olvidaran. */}
          <ReviewRequestsTab />
        </div>
      </PullToRefresh>
      {howOpen && <HowItWorksModal onClose={() => setHowOpen(false)} />}
    </div>
  );
}

export default function FinanzasPage() {
  return (
    <AuthGuard allowedRoles={['admin']}>
      <FinanzasContent />
    </AuthGuard>
  );
}
