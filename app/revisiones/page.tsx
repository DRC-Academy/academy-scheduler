'use client';
// ── "Sin ingreso detectado" (/revisiones) ─────────────────────────────────────
//
// Las clases que el calendario dice que existieron pero que NO tienen ingreso
// registrado. Para finanzas esas clases NO EXISTEN —ni como pendientes— porque el
// nivel 1 lo decide el clic en "Ingresar a clase", así que hasta ahora el
// profesor no tenía ninguna forma de reclamarlas.
//
// Acá declara QUÉ pasó en cada una. La solicitud queda pendiente y NO paga sola:
// el ingreso lo crea la validación del admin (ver lib/reviewRequests).
//
// La fuente es el CALENDARIO, no los transcripts: una falta sin aviso nunca tiene
// transcript y es justamente la que hay que poder declarar.
import { useState, useEffect, useMemo, useCallback } from 'react';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { PullToRefresh } from '@/components/PullToRefresh';
import { LastUpdated } from '@/components/LastUpdated';
import { getSpainParts } from '@/components/VisualCalendar';
import { AddClassModal } from '@/components/AddClassModal';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import { getTeacherAssignments } from '@/lib/db';
import { gridOccupancyOfTeacher } from '@/lib/teacherClasses';
import { registerClassWithTranscript } from '@/lib/aiClient';
import { canMarkStudentAbsence, ABSENCE_MONTHLY_CAP, durationBadge } from '@/lib/finance';
import {
  buildMissingJoinClasses, pendingToDeclare, dbGetReviewRequests, dbCreateReviewRequest, signalLabel,
  REVIEW_TYPE_OPTIONS, reviewTypeLabel, type MissingJoinClass,
} from '@/lib/reviewRequests';
import type { Assignment, ClassReviewRequest, ReviewRequestType } from '@/types';

/** Filas por tanda. Con 44 clases en un mes, la lista entera no se lee. */
const PAGINA = 20;

/** Hasta dónde puede mirar hacia atrás el desplegable de meses. */
const MESES_ATRAS = 12;

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function monthLabel(monthYear: string): string {
  const [y, m] = monthYear.split('-').map(Number);
  return `${MESES[(m ?? 1) - 1]} ${y}`;
}
function monthRange(monthYear: string): { from: string; to: string } {
  const [y, m] = monthYear.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return { from: `${monthYear}-01`, to: `${monthYear}-${String(last).padStart(2, '0')}` };
}
/** 'YYYY-MM' corrido `delta` meses. En UTC: un mes no tiene huso horario. */
function shiftMonth(monthYear: string, delta: number): string {
  const [y, m] = monthYear.split('-').map(Number);
  const d = new Date(Date.UTC(y, (m - 1) + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function fmtDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  return `${String(d.getDate()).padStart(2, '0')} ${MESES_CORTOS[d.getMonth()]}`;
}
function fmtDayName(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  const n = d.toLocaleDateString('es-ES', { weekday: 'long' });
  return n.charAt(0).toUpperCase() + n.slice(1);
}

// ── Estado de una solicitud ya enviada ────────────────────────────────────────
function RequestPill({ r }: { r: ClassReviewRequest }) {
  const style = r.status === 'aprobada'
    ? { bg: '#ecfdf3', color: '#067647', border: '#a6f4c5', dot: '#12b76a', label: 'Aprobada' }
    : r.status === 'rechazada'
      ? { bg: '#fef3f2', color: '#b42318', border: '#fecdca', dot: '#f04438', label: 'Rechazada' }
      : { bg: '#eff4ff', color: '#175cd3', border: '#b2ccff', dot: '#2e90fa', label: 'En revisión' };
  return (
    <span
      title={`${reviewTypeLabel(r.resolvedType ?? r.requestedType)}${r.reviewNote ? ` — ${r.reviewNote}` : ''}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 11px', borderRadius: 999, background: style.bg, border: `1px solid ${style.border}`, color: style.color, fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap' }}
    >
      <span style={{ width: 7, height: 7, borderRadius: 999, background: style.dot }} />
      {style.label}
    </span>
  );
}

// ── Selector "¿qué pasó en esta clase?" ───────────────────────────────────────
function TypeChooser({ clase, absenceCount, saving, error, onCancel, onConfirm }: {
  clase: MissingJoinClass;
  /** Faltas sin aviso que YA tiene el alumno este mes (fuente única, lib/finance). */
  absenceCount: number;
  saving: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: (tipo: ReviewRequestType, comment: string) => void;
}) {
  const [tipo, setTipo] = useState<ReviewRequestType | null>(null);
  const [comment, setComment] = useState('');

  const capReached = absenceCount >= ABSENCE_MONTHLY_CAP;
  const opcion = REVIEW_TYPE_OPTIONS.find(o => o.value === tipo);
  // Las que no llevan transcript piden motivo, igual que en "Añadir clase".
  const needsComment = !!opcion && !opcion.needsTranscript;
  const canConfirm = !!tipo && !saving && (!needsComment || !!comment.trim());

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget && !saving) onCancel(); }}
      role="dialog" aria-modal="true"
    >
      <div style={{ background: '#F7F7F5', border: '1px solid #e4e5e1', borderRadius: 16, padding: 24, width: '100%', maxWidth: 480, maxHeight: '92vh', overflowY: 'auto' }}>
        <div style={{ fontWeight: 700, fontSize: 16.5, color: '#1a1c1a', marginBottom: 4 }}>¿Qué pasó en esta clase?</div>
        <div style={{ fontSize: 13, color: '#5f6360', marginBottom: 16 }}>
          {clase.studentName} · {fmtDayName(clase.date)} {fmtDate(clase.date)} · {clase.hoursLabel}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginBottom: 16 }}>
          {REVIEW_TYPE_OPTIONS.map(o => {
            const bloqueada = o.usesAbsenceCap && capReached;
            const activa = tipo === o.value;
            return (
              <button
                key={o.value}
                onClick={() => !bloqueada && setTipo(o.value)}
                disabled={bloqueada || saving}
                style={{
                  textAlign: 'left', padding: '12px 14px', borderRadius: 11, fontFamily: 'inherit',
                  border: `1.5px solid ${activa ? '#1E9E3A' : '#e4e5e1'}`,
                  background: bloqueada ? '#f0f1ee' : activa ? 'rgba(30,158,58,0.07)' : '#fff',
                  cursor: bloqueada ? 'not-allowed' : 'pointer',
                  opacity: bloqueada ? 0.75 : 1,
                }}
              >
                <div style={{ fontSize: 13.5, fontWeight: 700, color: bloqueada ? '#8b8e88' : '#1a1c1a', marginBottom: 3 }}>
                  {o.label}
                </div>
                <div style={{ fontSize: 12, color: bloqueada ? '#9ca3af' : '#5f6360', lineHeight: 1.5 }}>
                  {bloqueada
                    ? `Este alumno ya tiene ${ABSENCE_MONTHLY_CAP} faltas sin aviso este mes.`
                    : o.help}
                </div>
                {o.usesAbsenceCap && !bloqueada && (
                  <div style={{ fontSize: 11.5, color: '#9a6516', marginTop: 4 }}>
                    Lleva {absenceCount} de {ABSENCE_MONTHLY_CAP} este mes.
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {needsComment && (
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
              Motivo <span style={{ color: '#ef4444' }}>*</span>
            </label>
            <textarea
              value={comment} onChange={e => setComment(e.target.value)} rows={3}
              placeholder="Contá brevemente qué pasó. Lo lee el equipo al validar."
              style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1.5px solid #e4e5e1', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', resize: 'vertical', background: '#fff', color: '#111827' }}
            />
          </div>
        )}

        {opcion?.needsTranscript && (
          <div style={{ fontSize: 12.5, color: '#1f7a3d', background: 'rgba(30,158,58,0.08)', border: '1px solid rgba(30,158,58,0.28)', borderRadius: 9, padding: '10px 12px', marginBottom: 14, lineHeight: 1.55 }}>
            En el siguiente paso te pedimos el transcript de la clase. Sin él no se puede verificar.
          </div>
        )}

        <div style={{ fontSize: 12, color: '#5f6360', background: '#f0f1ee', borderRadius: 9, padding: '10px 12px', marginBottom: 16, lineHeight: 1.55 }}>
          La solicitud queda <b>pendiente</b> hasta que el equipo la valide. No se paga sola.
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
          <button onClick={() => canConfirm && onConfirm(tipo!, comment.trim())} disabled={!canConfirm}
            style={{ flex: 2, padding: '11px', borderRadius: 8, border: 'none', background: canConfirm ? '#1E9E3A' : '#d1d5db', color: 'white', cursor: canConfirm ? 'pointer' : 'not-allowed', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
            {saving ? 'Enviando…' : opcion?.needsTranscript ? 'Continuar' : 'Enviar solicitud'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Pantalla ──────────────────────────────────────────────────────────────────
function RevisionesContent() {
  const { user } = useAuth();
  const {
    teachers, classJoinLogs, classRecords, classAnalyses, financePayments, loadFinanceData, reloadAll,
  } = useTeachers();

  const teacher = teachers.find(t => t.id === user?.teacherId) ?? teachers[0];

  const spain = getSpainParts(new Date());
  const todayIso = spain.dateStr;
  const nowMinutes = spain.hour * 60 + spain.minute;

  // Mes a revisar. Arranca en el actual y el desplegable deja ir hacia atrás.
  //
  // Antes estaba clavado en el mes en curso porque los meses cerrados se habían
  // recuperado con la paginación de class_join_logs (julio de 2026 volvió de 0 a
  // 103 clases y 460,50 €) y abrir el histórico solo ponía 1.117 filas de julio
  // delante del profesor. Eso último ya no pasa: `onlyWithSignal` recorta la
  // lista a las clases de las que quedó rastro (492 → 146 en agosto), y una
  // recuperación masiva no es lo mismo que las que se escapan de a una.
  //
  // Los meses se ofrecen desde los DATOS, no desde el calendario: solo aquellos
  // en los que el profesor tiene algún rastro propio, que son los únicos donde
  // esta pantalla puede mostrar algo. Un desplegable con doce meses vacíos es
  // peor que no tenerlo.
  const mesActual = todayIso.slice(0, 7);
  const [monthYear, setMonthYear] = useState(mesActual);
  const [myAssignments, setMyAssignments] = useState<Assignment[]>([]);
  const [requests, setRequests] = useState<ClassReviewRequest[]>([]);
  const [loading, setLoading] = useState(true);

  // Flujo en dos pasos: primero el tipo, después (solo en 'normal') el transcript.
  const [chooser, setChooser] = useState<MissingJoinClass | null>(null);
  const [transcriptFor, setTranscriptFor] = useState<MissingJoinClass | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  // Selección múltiple + paginado de 20 en 20 (Agustin tiene 44 clases en agosto).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [verHasta, setVerHasta] = useState(PAGINA);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [confirmBulk, setConfirmBulk] = useState(false);

  const refreshRequests = useCallback(async () => {
    if (!teacher) return;
    try { setRequests(await dbGetReviewRequests(teacher.id)); }
    catch (e) { console.error('[revisiones] No se pudieron leer las solicitudes:', e); }
  }, [teacher?.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!teacher) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    Promise.all([getTeacherAssignments(teacher), dbGetReviewRequests(teacher.id)])
      .then(([asgs, reqs]) => {
        if (cancelled) return;
        setMyAssignments(asgs);
        setRequests(reqs);
      })
      .catch(err => console.error('[revisiones] No se pudieron cargar las clases:', err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  // Por ID, no por el objeto: la lista de profesores se recarga cada 60 s.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teacher?.id]);

  useEffect(() => { loadFinanceData(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Meses que ofrece el desplegable, del más nuevo al más viejo: aquellos en los
   * que este profesor tiene algún rastro propio (transcript, registro o una
   * solicitud ya enviada), más el mes en curso, que está siempre.
   *
   * NO se miran los `class_join_logs`: un ingreso registrado es justo lo que hace
   * que una clase NO sea reclamable, así que un mes en el que todo tiene su clic
   * no aporta nada a esta pantalla.
   */
  const mesesDisponibles = useMemo(() => {
    const tope = shiftMonth(mesActual, -MESES_ATRAS);
    const meses = new Set<string>([mesActual]);
    const add = (d: string | null | undefined) => {
      const m = (d ?? '').slice(0, 7);
      if (m && m >= tope && m <= mesActual) meses.add(m);
    };
    if (teacher) {
      for (const r of classRecords) if (r.teacherId === teacher.id) add(r.classDate);
      for (const t of classAnalyses) if (!t.teacher_id || t.teacher_id === teacher.id) add(t.class_date ?? t.analyzed_at);
      for (const r of requests) add(r.classDate);
    }
    return [...meses].sort().reverse();
  }, [teacher?.id, classRecords, classAnalyses, requests, mesActual]);   // eslint-disable-line react-hooks/exhaustive-deps

  /** ¿El mes elegido ya está pagado? Cambia lo que el profesor puede esperar. */
  const mesPagado = useMemo(
    () => !!teacher && financePayments.some(
      p => p.teacherId === teacher.id && p.monthYear === monthYear && p.status === 'paid'),
    [teacher?.id, financePayments, monthYear],   // eslint-disable-line react-hooks/exhaustive-deps
  );

  /** Cambiar de mes descarta lo elegido y vuelve a la primera tanda. */
  function cambiarMes(m: string) {
    setMonthYear(m);
    setSelected(new Set());
    setVerHasta(PAGINA);
  }

  const clases = useMemo<MissingJoinClass[]>(() => {
    if (!teacher) return [];
    const { from, to } = monthRange(monthYear);
    return buildMissingJoinClasses({
      assignments: myAssignments,
      joinLogs: classJoinLogs,
      classRecords,
      requests,
      analyses: classAnalyses,
      teacherId: teacher.id,
      fromDate: from,
      toDate: to,
      todayIso,
      nowMinutes,
      gridOccupancy: gridOccupancyOfTeacher(teacher),
      // Solo las clases de las que quedó ALGÚN rastro (transcript o registro).
      // Sin esto la lista trae cada hueco del horario recurrente: 492 filas en
      // agosto de 2026 contra 146 con el filtro, y a nadie le sirve que le
      // pregunten qué pasó un martes del que no hay ni una prueba.
      onlyWithSignal: true,
    });
  }, [teacher, myAssignments, classJoinLogs, classRecords, classAnalyses, requests, monthYear, todayIso, nowMinutes]);

  const sinDeclarar = pendingToDeclare(clases);

  // ── Selección múltiple y paginado ──────────────────────────────────────────
  //
  // Solo entran al envío en bloque las que YA tienen transcript: ahí no hay nada
  // que decidir (la clase se dio y está la prueba). Las faltas y las ausencias se
  // eligen una por una a propósito — consecuencias distintas, y la falta consume
  // cupo del alumno.
  const seleccionables = useMemo(
    () => clases.filter(c => !c.request && c.signal === 'transcript' && c.analysisId),
    [clases],
  );
  const seleccionableIds = useMemo(() => new Set(seleccionables.map(c => c.key)), [seleccionables]);
  const visibles = clases.slice(0, verHasta);
  const seleccionadas = clases.filter(c => selected.has(c.key));
  // "Seleccionar todas" opera sobre lo VISIBLE: marcar 44 filas que no se ven es
  // justo el tipo de acción que después nadie sabe qué hizo.
  const visiblesSeleccionables = visibles.filter(c => seleccionableIds.has(c.key));
  const todasVisiblesMarcadas = visiblesSeleccionables.length > 0
    && visiblesSeleccionables.every(c => selected.has(c.key));

  function toggleSel(key: string) {
    setSelected(prev => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  }
  function toggleTodasVisibles() {
    setSelected(prev => {
      const n = new Set(prev);
      if (todasVisiblesMarcadas) visiblesSeleccionables.forEach(c => n.delete(c.key));
      else visiblesSeleccionables.forEach(c => n.add(c.key));
      return n;
    });
  }

  /**
   * Envía en bloque las seleccionadas como "Clase normal".
   *
   * Secuencial y tolerante a fallos parciales: si una falla (por ejemplo porque
   * ya tenía solicitud), las demás se envían igual y se informa el recuento. Con
   * 44 clases, cortar en la primera que falle sería lo peor que podría pasar.
   */
  async function enviarBloque() {
    if (!teacher || seleccionadas.length === 0) return;
    setBulkSaving(true); setError('');
    let ok = 0;
    const fallos: string[] = [];
    for (const c of seleccionadas) {
      try {
        await enviarConTranscriptExistente(c);
        ok++;
      } catch (e) {
        fallos.push(`${c.studentName} ${fmtDate(c.date)}: ${e instanceof Error ? e.message : 'error'}`);
      }
    }
    setSelected(new Set());
    setBulkSaving(false);
    setConfirmBulk(false);
    await refreshRequests();
    showToast(fallos.length === 0
      ? `${ok} solicitud${ok === 1 ? '' : 'es'} enviada${ok === 1 ? '' : 's'}. El equipo las va a revisar.`
      : `${ok} enviadas, ${fallos.length} con problemas: ${fallos[0]}`);
  }

  /** Faltas sin aviso que ya tiene ese alumno en el mes de esa clase. */
  function absenceCountFor(c: MissingJoinClass): number {
    if (!teacher) return 0;
    return canMarkStudentAbsence(classRecords, teacher.id, c.studentName, c.date.slice(0, 7)).count;
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(''), 3500);
  }

  /** Envía UNA clase como 'normal' enganchada al transcript que ya tiene. */
  async function enviarConTranscriptExistente(c: MissingJoinClass, comment = '') {
    if (!teacher) return;
    await dbCreateReviewRequest({
      teacherId: teacher.id, teacherName: teacher.name,
      studentName: c.studentName,
      classDate: c.date, classTime: c.hour,
      durationHours: c.durationHours,
      requestedType: 'normal',
      analysisId: c.analysisId,
      comment,
    });
  }

  /** Paso 1: el profesor eligió el tipo. */
  async function handleChoose(tipo: ReviewRequestType, comment: string) {
    if (!chooser || !teacher) return;
    if (tipo === 'normal') {
      // Si la clase YA tiene transcript, no hay nada que pedirle: la solicitud se
      // engancha a ese análisis. Volver a abrir el modal le haría pegar un texto
      // que ya está guardado y chocaría con el detector de duplicados contra su
      // propia clase.
      if (chooser.analysisId) {
        setSaving(true); setError('');
        try {
          await enviarConTranscriptExistente(chooser, comment);
          setChooser(null);
          await refreshRequests();
          showToast('Solicitud enviada con el transcript que ya tenías subido.');
        } catch (e) {
          setError(e instanceof Error ? e.message : 'No se pudo enviar la solicitud.');
        } finally {
          setSaving(false);
        }
        return;
      }
      // Sin transcript: se lo pedimos en el paso 2.
      setTranscriptFor(chooser);
      setChooser(null);
      return;
    }
    setSaving(true); setError('');
    try {
      await dbCreateReviewRequest({
        teacherId: teacher.id, teacherName: teacher.name,
        studentName: chooser.studentName,
        classDate: chooser.date, classTime: chooser.hour,
        durationHours: chooser.durationHours,
        requestedType: tipo, comment,
      });
      setChooser(null);
      await refreshRequests();
      showToast('Solicitud enviada. El equipo la va a revisar.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo enviar la solicitud.');
    } finally {
      setSaving(false);
    }
  }

  /**
   * Paso 2 (solo 'normal'): guarda el TRANSCRIPT por la vía de siempre y crea la
   * solicitud apuntando a él. Sin ingreso, ese transcript no cobra: lo habilita
   * la validación del admin.
   */
  async function handleTranscript(
    studentName: string, date: string, _time: string | undefined, transcript: string,
    _classType: string, comment: string, hash: string, replaceId: string | null,
  ) {
    if (!transcriptFor || !teacher) return;
    const clase = transcriptFor;
    const asgn = myAssignments.find(a => a.studentName === studentName);
    const { analysisId } = await registerClassWithTranscript({
      transcript: transcript.trim(),
      studentName,
      teacherName: teacher.name,
      studentId: asgn?.studentId ?? null,
      teacherId: teacher.id,
      plan: asgn?.plan ?? null,
      level: asgn?.studentLevel ?? null,
      classDate: date,
      transcriptHash: hash || null,
      replaceId,
      joinLogId: null,
      durationMinutes: clase.durationHours > 1 ? clase.durationHours * 60 : null,
    });
    await dbCreateReviewRequest({
      teacherId: teacher.id, teacherName: teacher.name,
      studentName: clase.studentName,
      classDate: clase.date, classTime: clase.hour,
      durationHours: clase.durationHours,
      requestedType: 'normal',
      analysisId,
      comment,
    });
    setTranscriptFor(null);
    await refreshRequests();
    showToast('Solicitud enviada con el transcript. El equipo la va a revisar.');
  }

  if (!teacher) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#8b8e88' }}>Cargando…</div>;
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f4f5f2' }}>
      <NavBar />
      <PullToRefresh onRefresh={async () => { await reloadAll(); await loadFinanceData(); await refreshRequests(); }}>
        <div style={{ maxWidth: 980, margin: '0 auto', padding: '20px 16px 48px' }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, color: '#8b8e88' }}>
              <span style={{ width: 7, height: 7, borderRadius: 999, background: '#16a34a' }} />
              <LastUpdated />
            </span>
          </div>

          {/* Cabecera */}
          <div style={{ background: '#fff', border: '1px solid #e4e5e1', borderRadius: 14, padding: '20px 22px', marginBottom: 14 }}>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: '#1a1c1a', margin: '0 0 6px' }}>
              Clases sin ingreso detectado
            </h1>
            <p style={{ fontSize: 13.5, color: '#5f6360', lineHeight: 1.6, margin: 0 }}>
              Estas clases están en tu calendario pero no quedó registro de que entraras con
              el botón <b>Ingresar a clase</b>, así que <b>no aparecen en Finanzas</b>. Contanos qué pasó
              en cada una y el equipo las revisa.
              {mesesDisponibles.length > 1 && (
                <> Si se te escapó alguna de meses anteriores, cambiá el mes en el desplegable.</>
              )}
            </p>
          </div>

          {/* Mes a revisar. Con un solo mes disponible no se pinta el desplegable:
              un select de una opción es un botón que no hace nada. */}
          <div style={{ background: '#fff', border: '1px solid #e4e5e1', borderRadius: 14, padding: '12px 18px', marginBottom: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              {mesesDisponibles.length > 1 ? (
                <select
                  value={monthYear}
                  onChange={e => cambiarMes(e.target.value)}
                  aria-label="Mes que estás revisando"
                  style={{
                    padding: '7px 10px', borderRadius: 9, border: '1.5px solid #e4e5e1',
                    background: '#F7F7F5', color: '#1a1c1a', fontSize: 14.5, fontWeight: 700,
                    fontFamily: 'inherit', cursor: 'pointer',
                  }}
                >
                  {mesesDisponibles.map(m => (
                    <option key={m} value={m}>
                      {monthLabel(m)}{m === mesActual ? ' · en curso' : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <div style={{ fontSize: 14.5, fontWeight: 700, color: '#1a1c1a' }}>
                  {monthLabel(monthYear)}
                </div>
              )}
              {mesPagado && (
                <span
                  title="Este mes ya se pagó. La solicitud se envía igual y la revisa el equipo."
                  style={{ padding: '4px 10px', borderRadius: 999, background: 'rgba(255,196,0,0.16)', border: '1px solid rgba(255,196,0,0.55)', color: '#8a6100', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}
                >
                  Mes ya pagado
                </span>
              )}
            </div>
            <div style={{ fontSize: 13, color: '#5f6360' }}>
              {sinDeclarar.length > 0
                ? <><b style={{ color: '#b45309' }}>{sinDeclarar.length}</b> sin declarar</>
                : <span style={{ color: '#1f7a3d', fontWeight: 600 }}>Nada pendiente</span>}
              {clases.length - sinDeclarar.length > 0 && (
                <> · {clases.length - sinDeclarar.length} ya enviada{clases.length - sinDeclarar.length === 1 ? '' : 's'}</>
              )}
            </div>
          </div>

          {toast && (
            <div style={{ background: '#ecfdf3', border: '1px solid #a6f4c5', color: '#067647', borderRadius: 11, padding: '11px 15px', marginBottom: 14, fontSize: 13.5, fontWeight: 600 }}>
              {toast}
            </div>
          )}

          {/* Barra de selección múltiple. Solo aparece cuando hay algo que
              seleccionar: las clases con el transcript ya subido. */}
          {!loading && seleccionables.length > 0 && (
            <div style={{
              background: seleccionadas.length > 0 ? 'rgba(30,158,58,0.07)' : '#fff',
              border: `1px solid ${seleccionadas.length > 0 ? 'rgba(30,158,58,0.35)' : '#e4e5e1'}`,
              borderRadius: 12, padding: '11px 16px', marginBottom: 12,
              display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
            }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#5f6360', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={todasVisiblesMarcadas}
                  onChange={toggleTodasVisibles}
                  disabled={visiblesSeleccionables.length === 0}
                  style={{ width: 15, height: 15, accentColor: '#1E9E3A', cursor: 'pointer' }}
                />
                Seleccionar las {visiblesSeleccionables.length} con transcript de esta tanda
              </label>
              <span style={{ flex: 1 }} />
              {seleccionadas.length > 0 && (
                <>
                  <span style={{ fontSize: 13, color: '#1f7a3d', fontWeight: 600 }}>
                    {seleccionadas.length} seleccionada{seleccionadas.length === 1 ? '' : 's'}
                  </span>
                  <button onClick={() => setSelected(new Set())} disabled={bulkSaving}
                    style={{ padding: '7px 12px', borderRadius: 8, border: '1px solid #e4e5e1', background: 'transparent', color: '#6b7280', cursor: 'pointer', fontSize: 12.5, fontFamily: 'inherit' }}>
                    Quitar selección
                  </button>
                  <button onClick={() => setConfirmBulk(true)} disabled={bulkSaving}
                    style={{ padding: '7px 15px', borderRadius: 8, border: 'none', background: '#1E9E3A', color: '#fff', cursor: bulkSaving ? 'not-allowed' : 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit' }}>
                    Enviar {seleccionadas.length} como clase normal
                  </button>
                </>
              )}
            </div>
          )}

          {/* Lista */}
          <div style={{ background: '#fff', border: '1px solid #e4e5e1', borderRadius: 14, overflow: 'hidden' }}>
            {loading ? (
              <div style={{ padding: '40px 0', textAlign: 'center', color: '#8b8e88', fontSize: 13.5 }}>Cargando tus clases…</div>
            ) : clases.length === 0 ? (
              <div style={{ padding: '40px 20px', textAlign: 'center', color: '#8b8e88', fontSize: 13.5, lineHeight: 1.6 }}>
                No hay clases sin ingreso en {monthLabel(monthYear)}.<br />
                <span style={{ fontSize: 12.5 }}>Todas tus clases del mes tienen su registro de acceso.</span>
              </div>
            ) : (
              visibles.map((c, i) => {
                const dur = durationBadge(c.durationHours);
                const puedeSeleccionar = seleccionableIds.has(c.key);
                return (
                  <div key={c.key} style={{
                    display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', flexWrap: 'wrap',
                    borderTop: i === 0 ? 'none' : '1px solid #f0f1ee',
                    background: selected.has(c.key) ? 'rgba(30,158,58,0.05)' : c.request ? '#fbfbfa' : '#fff',
                  }}>
                    {/* Hueco fijo aunque la fila no se pueda seleccionar: si no,
                        las columnas bailan de fila en fila. */}
                    <div style={{ width: 15, flexShrink: 0 }}>
                      {puedeSeleccionar && (
                        <input
                          type="checkbox"
                          checked={selected.has(c.key)}
                          onChange={() => toggleSel(c.key)}
                          aria-label={`Seleccionar la clase de ${c.studentName} del ${fmtDate(c.date)}`}
                          style={{ width: 15, height: 15, accentColor: '#1E9E3A', cursor: 'pointer' }}
                        />
                      )}
                    </div>
                    <div style={{ minWidth: 86 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 700, color: '#1a1c1a' }}>{fmtDate(c.date)}</div>
                      <div style={{ fontSize: 11.5, color: '#8b8e88' }}>{fmtDayName(c.date)}</div>
                    </div>
                    <div style={{ minWidth: 108, fontSize: 13, color: '#5f6360', display: 'flex', alignItems: 'center', gap: 7 }}>
                      {c.hoursLabel}
                      {dur && (
                        <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 6px', borderRadius: 5, color: dur.color, background: dur.bg }}>
                          {dur.label}
                        </span>
                      )}
                    </div>
                    <div style={{ flex: 1, minWidth: 150 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600, color: '#1a1c1a' }}>{c.studentName}</div>
                      {/* Por qué esta clase está en la lista: es el rastro que
                          demuestra que existió, y lo primero que el profesor
                          necesita para recordarla. */}
                      <div style={{ fontSize: 11.5, color: c.signal === 'transcript' ? '#1f7a3d' : '#8b8e88', marginTop: 2 }}>
                        {signalLabel(c.signal)}
                      </div>
                    </div>
                    <div style={{ flexShrink: 0 }}>
                      {c.request ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                          <span style={{ fontSize: 12, color: '#8b8e88' }}>
                            {reviewTypeLabel(c.request.resolvedType ?? c.request.requestedType)}
                          </span>
                          <RequestPill r={c.request} />
                        </div>
                      ) : (
                        <button
                          onClick={() => { setError(''); setChooser(c); }}
                          style={{ padding: '8px 14px', borderRadius: 8, border: 'none', background: '#1E9E3A', color: '#fff', cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', whiteSpace: 'nowrap' }}
                        >
                          Solicitar revisión
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}

            {/* Paginado: tandas de 20, en orden de fecha. */}
            {!loading && clases.length > visibles.length && (
              <button
                onClick={() => setVerHasta(v => v + PAGINA)}
                style={{ width: '100%', padding: '13px', border: 'none', borderTop: '1px solid #f0f1ee', background: '#fbfbfa', color: '#1f7a3d', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}
              >
                Ver {Math.min(PAGINA, clases.length - visibles.length)} más
                <span style={{ color: '#8b8e88', fontWeight: 500 }}> · {visibles.length} de {clases.length}</span>
              </button>
            )}
          </div>
        </div>
      </PullToRefresh>

      {/* Confirmación del envío en bloque. Es una acción que manda N solicitudes
          de una vez: se dice exactamente cuántas y de qué alumnos antes. */}
      {confirmBulk && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget && !bulkSaving) setConfirmBulk(false); }}
          role="alertdialog" aria-modal="true"
        >
          <div style={{ background: '#F7F7F5', border: '1px solid #e4e5e1', borderRadius: 14, padding: 24, width: '100%', maxWidth: 460, maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: '#1a1c1a', marginBottom: 10 }}>
              Enviar {seleccionadas.length} clase{seleccionadas.length === 1 ? '' : 's'} como clase normal
            </div>
            <p style={{ fontSize: 13.5, color: '#5f6360', lineHeight: 1.65, margin: '0 0 14px' }}>
              Todas tienen el transcript subido, así que se envían con él. Quedan <b>pendientes</b> hasta
              que el equipo las valide; ninguna se paga sola.
            </p>
            <div style={{ maxHeight: 200, overflowY: 'auto', background: '#fff', border: '1px solid #e4e5e1', borderRadius: 9, padding: '9px 12px', marginBottom: 16 }}>
              {seleccionadas.map(c => (
                <div key={c.key} style={{ fontSize: 12.5, color: '#5f6360', padding: '3px 0' }}>
                  {fmtDate(c.date)} · {c.hoursLabel} · <b style={{ color: '#1a1c1a' }}>{c.studentName}</b>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setConfirmBulk(false)} disabled={bulkSaving}
                style={{ flex: 1, padding: '11px', borderRadius: 8, border: '1px solid #e4e5e1', background: 'transparent', color: '#6b7280', cursor: bulkSaving ? 'not-allowed' : 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
                Cancelar
              </button>
              <button onClick={enviarBloque} disabled={bulkSaving}
                style={{ flex: 2, padding: '11px', borderRadius: 8, border: 'none', background: bulkSaving ? '#d1d5db' : '#1E9E3A', color: 'white', cursor: bulkSaving ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
                {bulkSaving ? `Enviando…` : `Enviar ${seleccionadas.length}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {chooser && (
        <TypeChooser
          clase={chooser}
          absenceCount={absenceCountFor(chooser)}
          saving={saving}
          error={error}
          onCancel={() => { if (!saving) { setChooser(null); setError(''); } }}
          onConfirm={handleChoose}
        />
      )}

      {transcriptFor && (
        <AddClassModal
          teacher={teacher}
          myAssignments={myAssignments}
          classRecords={classRecords}
          title="Transcript de la clase"
          lockClass
          lockType
          submitLabel="Enviar solicitud"
          initial={{
            studentName: transcriptFor.studentName,
            date: transcriptFor.date,
            classType: 'normal',
            time: transcriptFor.hour,
          }}
          contextNote={
            <>Clase de <b>{transcriptFor.studentName}</b> del <b>{fmtDate(transcriptFor.date)}</b>, {transcriptFor.hoursLabel}.
            {transcriptFor.durationHours > 1 && <> Es una sesión de <b>{transcriptFor.durationHours}h</b>: un solo transcript la cierra entera.</>}
            {' '}Al enviarla queda <b>pendiente de validación</b> del equipo; no se paga hasta que la aprueben.</>
          }
          durationHours={transcriptFor.durationHours}
          onClose={() => setTranscriptFor(null)}
          onSaved={handleTranscript}
        />
      )}
    </div>
  );
}

export default function RevisionesPage() {
  return (
    <AuthGuard allowedRoles={['teacher']}>
      <RevisionesContent />
    </AuthGuard>
  );
}
