'use client';
import { useState, useEffect, useMemo } from 'react';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { PullToRefresh } from '@/components/PullToRefresh';
import { LastUpdated } from '@/components/LastUpdated';
import { getSpainParts } from '@/components/VisualCalendar';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import { calculateTeacherFinance, recordVerification, ClassFinanceRow, ingresoBadge, classTypeBadge, subscriptionBadge, rowHoursLabel, durationBadge, sessionBreakdownLabel, transcriptStateBadge, transcriptNeedsTeacher } from '@/lib/finance';
import { dbGetAssignmentsByTeacher, calcRegisteredClassNumber } from '@/lib/db';
import { gridOccupancyOfTeacher } from '@/lib/teacherClasses';
import { maybeSendMilestoneEmail } from '@/lib/milestoneEmails';
import { AddClassModal, saveTeacherClass, ANALYSIS_FAILED_NOTICE } from '@/components/AddClassModal';
import { Teacher, Assignment, ClassRecordType } from '@/types';
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


function MyClassesTab({ teacher, myAssignments }: { teacher: Teacher; myAssignments: Assignment[] }) {
  const {
    students, classRecords, classJoinLogs, classAnalyses, financeRates, financePayments, scoringEvents, manualApprovals,
    registerClassRecord, loadFinanceData,
  } = useTeachers();

  const [monthYear, setMonthYear] = useState(currentMonthYear());
  const [showAdd, setShowAdd] = useState(false);
  // Prefill de "Añadir clase" al abrirlo desde una clase a revisar: deja el
  // alumno/fecha/tipo ya puestos para que el profe solo pegue el transcript. El
  // registro se emparejará con esa clase (mismo alumno + fecha ±1 día) en finanzas.
  const [addPrefill, setAddPrefill] = useState<{ studentName: string; date: string; classType: ClassRecordType } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Aviso "pendiente de validación" (Bloque 1) tras guardar una clase que quedó en revisión.
  const [validationNotice, setValidationNotice] = useState<{ title: string; body: string } | null>(null);
  const [showPenalties, setShowPenalties] = useState(false);

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

  // Registros (capturas) del profesor para el mes seleccionado.
  const monthRecords = useMemo(
    () => classRecords.filter(r => r.teacherId === teacher.id && (r.classDate ?? '').slice(0, 7) === monthYear),
    [classRecords, teacher.id, monthYear],
  );

  const detectedCount = monthRecords.filter(r => recordVerification(r.studentName, r.classDate, classJoinLogs, teacher.id) === 'detected').length;
  const notDetectedCount = monthRecords.length - detectedCount;

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

  const todayIso = getSpainParts(new Date()).dateStr;

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

  // Alertas de clases a revisar: se indica exactamente qué falta y, sobre todo,
  // SI le toca hacer algo al profesor.
  //
  // Antes esto decía "falta subir transcript" en cuanto `hasTranscript` era false
  // — y ese campo también es false cuando el transcript está subido y esperando
  // validación. El profesor lo volvía a pegar, el detector de duplicados le decía
  // que era idéntico, se revalidaba igual y el mensaje no cambiaba: un bucle sin
  // salida sobre clases que ya estaban completas de su lado.
  const reviewAlerts = finance.rows.filter(r => r.status === 'a_revisar').map(r => ({
    studentName: r.studentName, date: r.date, hour: r.hour,
    transcriptState: r.transcriptState, classType: r.classType, hasJoinLog: r.hasJoinLog,
    // Solo se ofrece el botón de pegar cuando pegar sirve de algo.
    canPaste: transcriptNeedsTeacher(r.transcriptState),
    // Orden de prioridad: lo que el profesor puede hacer AHORA, primero.
    missing:
      r.transcriptState === 'rejected' ? 'el equipo rechazó el transcript: subí el correcto'
    : r.transcriptState === 'none'     ? 'subir transcript en Añadir clase'
    : !r.hasJoinLog                    ? 'ingresar con el botón Meet (no quedó registro de acceso)'
    :                                    'nada de tu parte: el equipo está validando el transcript',
  }));

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

      {/* Barra de mes */}
      <div className="mcf-card mcf-monthbar">
        <div className="mcf-month">
          <button className="mcf-icon-btn" aria-label="Mes anterior" onClick={() => setMonthYear(m => shiftMonth(m, -1))}>‹</button>
          <span className="mcf-month-label">{monthLabel(monthYear)}</span>
          <button className="mcf-icon-btn" aria-label="Mes siguiente" onClick={() => setMonthYear(m => shiftMonth(m, 1))}>›</button>
          <button className="mcf-btn mcf-btn-ghost mcf-btn-sm" onClick={() => setMonthYear(currentMonthYear())}>Hoy</button>
        </div>
        <button className="mcf-btn mcf-btn-primary" onClick={() => openAddClass()}>Añadir clase</button>
      </div>

      <div className="mcf-content">
        {/* KPIs */}
        <div className="mcf-kpis">
          {([
            { label: 'Clases registradas este mes', value: monthRecords.length, dot: null, color: undefined, help: undefined },
            { label: 'Con ingreso detectado', value: detectedCount, dot: '#16a34a', color: undefined, help: 'finanzas.ingresoDetectado' },
            { label: 'Sin ingreso detectado', value: notDetectedCount, dot: '#e0912f', color: notDetectedCount > 0 ? '#9a6516' : undefined, help: 'finanzas.sinIngreso' },
            { label: 'Alumnos con clases este mes', value: financeGroups.length, dot: null, color: undefined, help: undefined },
          ] as Array<{ label: string; value: number; dot: string | null; color: string | undefined; help?: HelpTooltipKey }>).map(k => (
            <div key={k.label} className="mcf-card mcf-kpi">
              <div className="mcf-kpi-value" style={k.color ? { color: k.color } : undefined}>
                {k.dot && <span className="mcf-dot" style={{ background: k.dot }} />}
                {k.value}
              </div>
              <div className="mcf-kpi-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                {k.label}
                {k.help && <HelpTooltip tooltipKey={k.help} />}
              </div>
            </div>
          ))}
        </div>

        <div className="mcf-body">
          {/* ── Izquierda: clases por alumno ── */}
          <div className="mcf-main">
            <div className="mcf-section-title">Clases por alumno</div>

            {financeGroups.length === 0 ? (
              <div className="mcf-card mcf-empty">
                No hay clases detectadas este mes. Registrá clases con <b>Añadir clase</b> o ingresá con el botón Meet.
              </div>
            ) : financeGroups.map(g => {
              const isOpen = expanded.has(g.name);
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

                    {g.hasReview && <span className="mcf-pill is-warn"><span className="mcf-dot" style={{ background: '#e0912f' }} />A revisar</span>}

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
                        <table className="mcf-table">
                          <thead>
                            <tr>
                              {([
                                { h: 'Fecha' }, { h: 'Hora' },
                                { h: 'Ingreso', help: 'finanzas.ingreso' },
                                { h: 'Transcript', help: 'finanzas.transcript' },
                                { h: 'Suscripción', help: 'finanzas.suscripcion' },
                                { h: 'Tarifa', help: 'finanzas.tarifa' },
                                { h: 'Acción' },
                              ] as Array<{ h: string; help?: HelpTooltipKey }>).map(col => (
                                <th key={col.h}>
                                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                    {col.h}
                                    {col.help && <HelpTooltip tooltipKey={col.help} />}
                                  </span>
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {g.rows.map((r, i) => {
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
                              return (
                                <tr key={i} className={r.status === 'a_revisar' ? 'is-review' : undefined}>
                                  {/* Fecha */}
                                  <td>
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                      {finShortDate(r.date)}
                                      {isExcede && (
                                        <span className="mcf-dot" style={{ background: '#e0912f' }}
                                          title={r.status === 'excede_limite_tipo' ? 'Supera las 2 cobrables de este tipo' : 'Excede el límite del plan'} />
                                      )}
                                      {r.manuallyApproved && (
                                        <span className="mcf-tag" style={{ background: '#eaf5ec', color: '#1f7a3d' }} title="Aprobada manualmente por el admin">admin</span>
                                      )}
                                      {rec?.comment && (
                                        <span className="mcf-tag" style={{ background: '#f0f1ee', color: '#5f6360', cursor: 'help' }} title={rec.comment}>nota</span>
                                      )}
                                    </span>
                                  </td>
                                  {/* Hora — rango completo si es una sesión de 2h */}
                                  <td style={{ color: '#1a1c1a', fontWeight: 600, whiteSpace: 'nowrap' }}>
                                    {r.hour ? rowHoursLabel(r) : '—'}
                                    {dur && <span className="mcf-tag" style={{ marginLeft: 5, background: dur.bg, color: dur.color }}>{dur.label}</span>}
                                  </td>
                                  {/* Ingreso (+ tipo de clase) */}
                                  <td>
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                      <span className="mcf-tag" style={{ background: ing.bg, color: ing.color }}>{plainLabel(ing.label)}</span>
                                      {ct && <span className="mcf-tag" style={{ background: ct.bg, color: ct.color }}>{plainLabel(ct.label)}</span>}
                                    </span>
                                  </td>
                                  {/* Transcript — segundo factor de verificación.
                                      Cuatro estados, no dos: "Sin subir" y "En
                                      revisión" no le piden lo mismo al profesor. */}
                                  <td>
                                    {isFalta
                                      ? <span style={{ color: '#a4a7a1' }}>—</span>
                                      : <span className="mcf-tag" style={{ background: ts.bg, color: ts.color }}>{ts.label}</span>}
                                  </td>
                                  {/* Suscripción */}
                                  <td>
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                      <span className="mcf-tag" style={{ background: sub.bg, color: sub.color }}>{plainLabel(sub.label)}</span>
                                      {subDiffer && (
                                        <span style={{ cursor: 'help', color: '#a4a7a1', fontSize: 12 }}
                                          title={`Al ingresar: ${plainLabel(subscriptionBadge(r.subAtJoin).label)} · Al registrar: ${plainLabel(subscriptionBadge(r.subAtRecord).label)}`}>
                                          ·
                                        </span>
                                      )}
                                    </span>
                                  </td>
                                  {/* Tarifa — tarifa × unidades (2× en una sesión de 2h) */}
                                  <td style={{ color: '#1a1c1a', fontWeight: 600, whiteSpace: 'nowrap' }}
                                    title={sessionNote ?? undefined}>
                                    €{(r.rate * r.billingUnits).toFixed(2)}
                                    {r.billingUnits > 1 && (
                                      <span style={{ display: 'block', fontSize: 10.5, fontWeight: 600, color: '#5f6360' }}>
                                        cuenta como {r.billingUnits}
                                      </span>
                                    )}
                                  </td>
                                  {/* Acción */}
                                  <td>
                                    {isFalta ? (
                                      r.status === 'excede_limite_tipo'
                                        ? <span className="mcf-tag" style={{ background: '#fdf3e7', color: '#9a6516' }}>Supera 2 · revisión admin</span>
                                        : <span style={{ color: '#1f7a3d', fontWeight: 600 }}>Cobrable</span>
                                    ) : transcriptNeedsTeacher(r.transcriptState) ? (
                                      <button
                                        onClick={() => openAddClass({ studentName: g.name, date: r.date, classType: r.classType })}
                                        title="Pegá el transcript de esta clase para verificarla"
                                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 9px', borderRadius: 7, border: '1px solid rgba(224,145,47,0.45)', background: '#fdf3e7', color: '#9a6516', cursor: 'pointer', fontSize: 12, fontWeight: 700, fontFamily: 'inherit' }}
                                      >
                                        {r.transcriptState === 'rejected' ? '+ Subir el correcto' : '+ Añadir transcript'}
                                      </button>
                                    ) : complete ? (
                                      <span style={{ color: '#1f7a3d', fontWeight: 600 }}>Completo</span>
                                    ) : !r.hasJoinLog ? (
                                      <span style={{ color: '#a4a7a1' }} title="No se puede falsear el ingreso">
                                        Recordá usar &apos;Ingresar a clase&apos;
                                      </span>
                                    ) : (
                                      // Transcript subido y esperando al equipo: no
                                      // hay nada que el profesor pueda hacer acá.
                                      <span style={{ color: '#3b5b9e', fontWeight: 600 }} title="El equipo está validando el transcript">
                                        En revisión
                                      </span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <div className="mcf-detail-foot">
                        <div>
                          Total {g.total} · Pagables <b style={{ color: '#1f7a3d' }}>{g.pagablesCount}</b> · A revisar{' '}
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

          {/* ── Derecha (sticky): total y clases a revisar ── */}
          <aside className="mcf-side">
            <div className="mcf-card mcf-card-pad mcf-total">
              <div className="mcf-card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                Total a cobrar · {monthLabel(monthYear)}
                <HelpTooltip tooltipKey="finanzas.totalCobrar" position="bottom" />
              </div>
              <div className="mcf-amount">€{finance.totalAPagar.toFixed(2)}</div>
              <span className={`mcf-pill ${finance.paymentStatus === 'paid' ? 'is-ok' : 'is-warn'}`}>
                <span className="mcf-dot" style={{ background: finance.paymentStatus === 'paid' ? '#16a34a' : '#e0912f' }} />
                {finance.paymentStatus === 'paid' ? 'Pagado' : 'Pendiente de pago'}
              </span>

              <div className="mcf-breakdown">
                <div className="mcf-brow">
                  <span className="mcf-brow-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    Clases pagables · {finance.totalPagable}
                    <HelpTooltip tooltipKey="finanzas.pagables" />
                  </span>
                  <span className="mcf-brow-value">€{finance.montoPagable.toFixed(2)}</span>
                </div>
                <div className="mcf-brow">
                  <span className="mcf-brow-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                    Clases a revisar · {finance.totalARevisar}
                    <span className="mcf-brow-note"> pendiente de verificación</span>
                    <HelpTooltip tooltipKey="finanzas.aRevisar" />
                  </span>
                  <span className="mcf-brow-value" style={{ color: '#8b8e88' }}>€{finance.montoARevisar.toFixed(2)}</span>
                </div>
                <div className="mcf-brow">
                  <span className="mcf-brow-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    Bonos scoring
                    <HelpTooltip tooltipKey="finanzas.bonosScoring" />
                  </span>
                  <span className="mcf-brow-value">€{finance.bonusFromScoring.toFixed(2)}</span>
                </div>
                {finance.penaltiesFromScoring < 0 && (
                  <div className="mcf-brow">
                    <span className="mcf-brow-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      Penalizaciones
                      <button onClick={() => setShowPenalties(s => !s)}
                        style={{ background: 'none', border: 'none', color: '#c0392b', cursor: 'pointer', fontSize: 11.5, fontWeight: 600, padding: 0, textDecoration: 'underline' }}>
                        {showPenalties ? 'ocultar' : 'ver detalle'}
                      </button>
                    </span>
                    <span className="mcf-brow-value" style={{ color: '#c0392b', fontWeight: 700 }}>−€{Math.abs(finance.penaltiesFromScoring).toFixed(2)}</span>
                  </div>
                )}
                {showPenalties && monthPenalties.length > 0 && (
                  <div style={{ marginTop: 6, paddingTop: 8, borderTop: '1px dashed var(--border)', display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {monthPenalties.map(p => (
                      <div key={p.id} style={{ fontSize: 12, color: p.reverted ? 'var(--text-muted)' : '#5f6360', display: 'flex', justifyContent: 'space-between', gap: 8, textDecoration: p.reverted ? 'line-through' : undefined }}>
                        <span>{p.note.replace('Falta sin aviso registrada — ', '').replace('alumno ', '').replace('fecha ', '')}</span>
                        <span style={{ whiteSpace: 'nowrap' }}>
                          {p.reverted ? <span style={{ textDecoration: 'none', color: '#1f7a3d', marginRight: 6 }}>Revertida por el equipo</span> : null}
                          −€{Math.abs(p.euros).toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {reviewAlerts.length > 0 && (
              <div className="mcf-card mcf-card-pad mcf-review">
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
                  <span className="mcf-card-title">Clases a revisar</span>
                  <span className="mcf-counter">{reviewAlerts.length}</span>
                </div>
                {reviewAlerts.map((a, i) => (
                  <div key={i} className="mcf-review-row">
                    <span className="mcf-dot" style={{ background: '#e0912f', marginTop: 5 }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="mcf-review-who">{a.studentName} · {finShortDate(a.date)}</div>
                      <div className="mcf-review-note">Falta: {a.missing}</div>
                    </div>
                    {/* El botón aparece SOLO si pegar cambia algo: falta el
                        transcript o el equipo lo rechazó. Si está en revisión, o si
                        lo que falta es el ingreso por Meet, no hay acción posible y
                        ofrecerla sería mandarlo a repetir trabajo en vano. */}
                    {a.canPaste && (
                      <button
                        onClick={() => openAddClass({ studentName: a.studentName, date: a.date, classType: a.classType })}
                        title="Pegá el transcript de esta clase para verificarla"
                        style={{ flexShrink: 0, padding: '6px 11px', borderRadius: 8, border: 'none', background: '#1E9E3A', color: 'white', cursor: 'pointer', fontSize: 12, fontWeight: 700, fontFamily: 'inherit', whiteSpace: 'nowrap' }}
                      >
                        Pegar transcript
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </aside>
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
