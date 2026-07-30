'use client';
// ── "Mis clases" del profesor (/clases) ───────────────────────────────────────
//
// Vista OPERATIVA de la semana: lunes a sábado de un vistazo, con las clases ya
// dadas incluidas. Es lo que la agenda del panel (/teacher → pestaña "Mis
// clases") no hacía: mostraba UN día, plegaba las clases pasadas de hoy y en los
// días anteriores las pintaba como futuras, así que el profesor no tenía dónde
// ver lo que ya dio ni dónde cerrarlo con el transcript.
//
// Son seis días y no siete porque el grid del calendario no tiene domingo: una
// séptima columna solo podría salir vacía.
//
// Todo lo que escribe viene de fuentes compartidas con el resto de la app:
//   · las clases, de lib/teacherClasses (misma expansión que usa el panel);
//   · "Ingresar a clase", de components/JoinClass (mismo flujo que el panel);
//   · el transcript, de components/AddClassModal (mismo modal y guardado que
//     Finanzas: guardar primero, analizar después).
import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { PullToRefresh } from '@/components/PullToRefresh';
import { getSpainParts } from '@/components/VisualCalendar';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import { getTeacherAssignments, dbGetTeacherGrid } from '@/lib/db';
import {
  buildTeacherWeek, mondayIsoOfIso, addDaysIso, weekRangeLabel, shortDateLabel,
  hourRangeLabel, hourLabel, cancellationLabel, transcriptForClass,
  type WeekClass, type WeekDay,
} from '@/lib/teacherClasses';
import { AddClassModal, saveTeacherClass, ANALYSIS_FAILED_NOTICE } from '@/components/AddClassModal';
import { useClassJoin, type ClassJoinApi } from '@/components/JoinClass';
import type { Assignment, Grid, ClassRecordType } from '@/types';

// Lunes → sábado: el grid del calendario no tiene domingo.
const WEEK_DAYS = 6;

// Nombre corto del día para la cabecera de cada columna.
const SHORT_DAY: Record<string, string> = {
  Lunes: 'Lun', Martes: 'Mar', Miércoles: 'Mié', Jueves: 'Jue',
  Viernes: 'Vie', Sábado: 'Sáb', Domingo: 'Dom',
};

function ClasesContent() {
  const { user } = useAuth();
  const {
    teachers, students, classRecords, classAnalyses,
    registerClassRecord, logClassJoin, updateMeetLink, loadFinanceData, reloadAll,
  } = useTeachers();

  const teacher = teachers.find(t => t.id === user?.teacherId) ?? teachers[0];

  // Reloj propio: se fija al montar (evita el desajuste de hidratación de leer la
  // hora en el render del servidor) y se refresca cada minuto para que "en curso"
  // y "ya pasó" cambien solos sin recargar.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const [weekOffset, setWeekOffset] = useState(0);
  const [myAssignments, setMyAssignments] = useState<Assignment[]>([]);
  const [grid, setGrid] = useState<Grid>({});
  const [loadingWeek, setLoadingWeek] = useState(true);
  // Clase para la que se está subiendo el transcript.
  const [transcriptFor, setTranscriptFor] = useState<WeekClass | null>(null);
  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  function showToast(msg: string, ms = 2500) {
    setToast(msg);
    setTimeout(() => setToast(null), ms);
  }

  // Los alumnos salen del GRID (getTeacherAssignments), nunca de filtrar
  // `assignments` por teacherId: esa es la única función que decide qué alumnos
  // son de este profesor. El grid además aporta las recuperaciones puntuales.
  useEffect(() => {
    if (!teacher) return;
    let cancelled = false;
    Promise.all([getTeacherAssignments(teacher), dbGetTeacherGrid(teacher.id)])
      .then(([rows, g]) => {
        if (cancelled) return;
        setMyAssignments(rows);
        setGrid(g);
      })
      .catch(err => console.error('[clases] No se pudo cargar la semana:', err))
      .finally(() => { if (!cancelled) setLoadingWeek(false); });
    return () => { cancelled = true; };
  // Por ID, no por el objeto `teacher`: la lista se recarga cada 60 s y su
  // identidad cambia en cada recarga, lo que relanzaría la lectura en bucle.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teacher?.id]);

  // classRecords (cancelaciones/reprogramaciones) y classAnalyses (transcripts)
  // llegan por el contexto de finanzas: se refrescan al entrar y tras cada subida.
  useEffect(() => {
    loadFinanceData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const spain = now ? getSpainParts(now) : null;
  const todayIso = spain?.dateStr ?? '';
  const nowDecimal = spain ? spain.hour + spain.minute / 60 : -1;

  const mondayIso = todayIso ? addDaysIso(mondayIsoOfIso(todayIso), weekOffset * 7) : '';
  const isThisWeek = weekOffset === 0;

  const days = useMemo<WeekDay[]>(() => {
    if (!teacher || !mondayIso || !todayIso) return [];
    return buildTeacherWeek({
      assignments: myAssignments, grid, mondayIso, classRecords,
      teacherId: teacher.id, todayIso, nowDecimal, dayCount: WEEK_DAYS,
    });
  }, [teacher, myAssignments, grid, mondayIso, classRecords, todayIso, nowDecimal]);

  // "Ingresar a clase": mismo flujo que el Calendario (enlace de Meet →
  // disclaimer de hito → verificación de suscripción → registro del acceso).
  const join = useClassJoin({
    teacher, students, classRecords, todayIso,
    logClassJoin, updateMeetLink,
    onToast: (msg, ms) => showToast(msg, ms),
  });

  // ¿Esta clase ya tiene su transcript guardado?
  const hasTranscript = (c: WeekClass): boolean =>
    !!teacher && !!transcriptForClass(classAnalyses, teacher.id, c.studentName, c.date);

  const allClasses = useMemo(() => days.flatMap(d => d.classes), [days]);
  const givenClasses = allClasses.filter(c => c.timing === 'past' && c.counts);
  const pendingTranscripts = givenClasses.filter(c => !hasTranscript(c)).length;
  const weekTotal = allClasses.filter(c => c.counts).length;

  // En móvil la semana se apila; en la semana en curso se rota para que HOY quede
  // arriba y los días ya pasados al final. Se pasa como custom property porque
  // `order` en escritorio reordenaría también las columnas.
  const todayIndex = days.findIndex(d => d.isToday);
  const mobileOrder = (i: number) =>
    todayIndex >= 0 && days.length > 0 ? (i - todayIndex + days.length) % days.length : i;

  async function handleSaved(
    studentName: string, date: string, time: string | undefined, transcript: string,
    classType: ClassRecordType, comment: string, hash: string, replaceId: string | null,
  ) {
    if (!teacher) return;
    const result = await saveTeacherClass({
      teacher, myAssignments, studentName, date, time, transcript, classType, comment,
      transcriptHash: hash, replaceId, registerClassRecord,
    });
    if (result.notice) setNotice(result.notice);
    // Solo se vuelve a avisar si el informe de IA falla: la clase ya está guardada.
    result.analysis?.then(({ analyzed }) => {
      if (!analyzed) setNotice(ANALYSIS_FAILED_NOTICE);
    });
    await loadFinanceData();
  }

  const showSkeleton = !teacher || !now || loadingWeek;

  return (
    <div className="mc7-page">
      <NavBar />
      <PullToRefresh onRefresh={async () => { await reloadAll(); await loadFinanceData(); }}>
        <div className="mc7-wrap">

          {/* Cabecera + navegador de semana */}
          <div className="mc7-head">
            <div>
              <h1 className="mc7-title">Mis clases</h1>
              <p className="mc7-sub">
                {mondayIso ? <>Semana del <b>{weekRangeLabel(mondayIso)}</b></> : 'Tu semana completa, clase por clase'}
              </p>
            </div>
            <div className="mc7-weeknav">
              <button className="mc7-weekbtn" onClick={() => setWeekOffset(o => o - 1)} aria-label="Semana anterior">
                <ChevronLeft size={18} strokeWidth={2.25} />
                <span className="mc7-weekbtn-txt">Semana anterior</span>
              </button>
              <button className="mc7-weekbtn" onClick={() => setWeekOffset(o => o + 1)} aria-label="Semana siguiente">
                <span className="mc7-weekbtn-txt">Semana siguiente</span>
                <ChevronRight size={18} strokeWidth={2.25} />
              </button>
              <button
                className={`mc7-todaybtn${isThisWeek ? ' is-current' : ''}`}
                onClick={() => setWeekOffset(0)}
                title={isThisWeek ? 'Ya estás en la semana actual' : 'Volver a la semana actual'}>
                Hoy
              </button>
            </div>
          </div>

          {/* Aviso tras guardar un transcript */}
          {notice && (
            <div className="mc7-notice">
              <span aria-hidden>⏳</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="mc7-notice-title">{notice.title}</div>
                <div className="mc7-notice-body">{notice.body}</div>
              </div>
              <button className="mc7-notice-x" onClick={() => setNotice(null)} aria-label="Cerrar aviso">✕</button>
            </div>
          )}

          {showSkeleton ? (
            <WeekSkeleton />
          ) : (
            <>
              {/* Resumen de la semana + recordatorio de transcripts pendientes */}
              <div className="mc7-summary">
                <span className="mc7-stat"><b>{weekTotal}</b> clase{weekTotal === 1 ? '' : 's'} esta semana</span>
                <span className="mc7-sep" aria-hidden />
                <span className="mc7-stat"><b>{givenClasses.length}</b> ya dada{givenClasses.length === 1 ? '' : 's'}</span>
                {pendingTranscripts > 0 && (
                  <>
                    <span className="mc7-sep" aria-hidden />
                    <span className="mc7-stat is-warn">
                      <b>{pendingTranscripts}</b> sin transcript
                    </span>
                  </>
                )}
              </div>

              {/* Semana: 7 columnas en escritorio, apilada en móvil */}
              <div className="mc7-week">
                {days.map((day, i) => (
                  <section
                    key={day.iso}
                    className={`mc7-day${day.isToday ? ' is-today' : ''}${day.isPast ? ' is-past' : ''}`}
                    style={{ ['--mc7-order' as string]: mobileOrder(i) }}
                  >
                    <header className="mc7-dayhead">
                      <span className="mc7-dayname">
                        <span className="mc7-dayname-full">{day.dayName}</span>
                        <span className="mc7-dayname-short">{SHORT_DAY[day.dayName] ?? day.dayName}</span>
                        {' '}{day.dayNumber}
                      </span>
                      {day.isToday && <span className="mc7-hoy">Hoy</span>}
                      <span className="mc7-daycount">{day.activeCount || '—'}</span>
                    </header>

                    {day.classes.length === 0 ? (
                      <div className="mc7-dayempty">Sin clases</div>
                    ) : (
                      <div className="mc7-cards">
                        {day.classes.map(c => (
                          <ClassCard
                            key={c.key}
                            c={c}
                            isToday={day.isToday}
                            hasTranscript={hasTranscript(c)}
                            join={join}
                            onAddTranscript={() => setTranscriptFor(c)}
                          />
                        ))}
                      </div>
                    )}
                  </section>
                ))}
              </div>

              <p className="mc7-foot">
                Una clase cuenta para tu pago con dos factores: el <b>ingreso</b> por el botón &quot;Ingresar a clase&quot;
                (solo se registra en vivo, no se puede cargar después) y el <b>transcript</b> de la sesión. El botón de
                ingreso aparece únicamente en las clases de hoy que todavía no terminaron.
              </p>
            </>
          )}
        </div>
      </PullToRefresh>

      {transcriptFor && teacher && (
        <AddClassModal
          teacher={teacher}
          myAssignments={myAssignments}
          classRecords={classRecords}
          title="Añadir transcript"
          lockClass
          initial={{
            studentName: transcriptFor.studentName,
            date: transcriptFor.date,
            classType: transcriptFor.isRecovery ? 'recuperacion' : 'normal',
            time: hourLabel(transcriptFor.hour),
          }}
          contextNote={
            <>Clase de <b>{transcriptFor.studentName}</b> del <b>{shortDateLabel(transcriptFor.date)}</b> a
            las <b>{hourLabel(transcriptFor.hour)}</b>. Pegá el transcript de Fathom para cerrarla.</>
          }
          onClose={() => setTranscriptFor(null)}
          onSaved={handleSaved}
        />
      )}

      {/* Diálogos del flujo "Ingresar a clase" (components/JoinClass). */}
      {join.dialogs}

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: '#1E9E3A', color: 'white', padding: '10px 22px', borderRadius: 24, fontSize: 14, fontWeight: 700, zIndex: 90, boxShadow: '0 4px 16px rgba(0,0,0,0.25)' }}>
          {toast}
        </div>
      )}
    </div>
  );
}

// ── Tarjeta de una clase ──────────────────────────────────────────────────────
function ClassCard({ c, isToday, hasTranscript, join, onAddTranscript }: {
  c: WeekClass; isToday: boolean; hasTranscript: boolean;
  join: ClassJoinApi; onAddTranscript: () => void;
}) {
  const off = !c.counts;                       // cancelada o reprogramada
  const past = c.timing === 'past';
  const live = c.timing === 'live';
  const isNext = c.timing === 'next';
  const fichaHref = `/mis-alumnos/${encodeURIComponent(c.assignment.studentId || c.assignment.id)}`;

  // "Ingresar a clase" SOLO en las clases de hoy que aún no terminaron: el acceso
  // se registra con la fecha de hoy, así que ofrecerlo en otro día registraría la
  // clase equivocada.
  const canJoin = isToday && !off && !past;
  const joined = join.joinedKeys.has(c.key);
  const checking = join.checkingKey === c.key;

  const cls = ['mc7-card'];
  if (off) cls.push('is-off');
  else if (live) cls.push('is-live');
  else if (isNext) cls.push('is-next');
  else if (past) cls.push('is-donepast');

  return (
    <article className={cls.join(' ')}>
      <div className="mc7-cardtop">
        <span className="mc7-hour">{hourRangeLabel(c.hour)}</span>
        {live && <span className="mc7-live"><span className="mc7-dot" />En curso</span>}
        {isNext && <span className="mc7-nextpill">Próxima</span>}
      </div>

      <div className={`mc7-name${off ? ' is-struck' : ''}`}>{c.studentName}</div>

      {(c.isRecovery || off) && (
        <div className="mc7-badges">
          {c.isRecovery && <span className="mc7-badge is-recovery">Recuperación</span>}
          {c.mark === 'rescheduled' && (
            <span className="mc7-badge is-muted">Reprogramada → {shortDateLabel(c.rescheduledTo ?? '')}</span>
          )}
          {c.mark === 'cancelled' && (
            <span className="mc7-badge is-muted">{cancellationLabel(c.cancelledType ?? null)}</span>
          )}
        </div>
      )}

      {/* Ingreso a la clase (registra el acceso: primer factor del pago). */}
      {canJoin && (
        joined ? (
          <div className="mc7-joined">✓ Ingreso registrado</div>
        ) : (
          <button className="mc7-jbtn" onClick={() => join.join(c)} disabled={checking}>
            {checking
              ? <><span className="drc-spinner" />Verificando…</>
              : c.meetLink ? '🎥 Ingresar a clase' : '🔗 Definir enlace'}
          </button>
        )
      )}

      {/* Transcript: solo tiene sentido en clases que YA se dieron. */}
      {past && !off && (
        hasTranscript ? (
          <div className="mc7-tdone">
            <span className="mc7-badge is-ok">✓ Transcript subido</span>
            <span className="mc7-tlinks">
              <Link href={fichaHref} className="mc7-link">Ver</Link>
              <span aria-hidden> · </span>
              <button className="mc7-linkbtn" onClick={onAddTranscript}>Reemplazar</button>
            </span>
          </div>
        ) : (
          <button className="mc7-tbtn" onClick={onAddTranscript}>📝 Añadir transcript</button>
        )
      )}
    </article>
  );
}

function WeekSkeleton() {
  return (
    <div className="mc7-week" aria-hidden="true">
      {Array.from({ length: WEEK_DAYS }, (_, i) => i).map(i => (
        <section key={i} className="mc7-day">
          <header className="mc7-dayhead"><span className="mc7-skel" style={{ width: 78, height: 14 }} /></header>
          <div className="mc7-cards">
            <div className="mc7-skel" style={{ height: 74, borderRadius: 12 }} />
            <div className="mc7-skel" style={{ height: 74, borderRadius: 12 }} />
          </div>
        </section>
      ))}
    </div>
  );
}

export default function ClasesPage() {
  return (
    <AuthGuard allowedRoles={['teacher']}>
      <ClasesContent />
    </AuthGuard>
  );
}
