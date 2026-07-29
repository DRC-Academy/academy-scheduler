'use client';
// ── Sección "Asistencias" del profesor (rediseño hi-fi) ───────────────────────
// Vista SEMANAL navegable de sus accesos a clase: quién no ingresó, la puntualidad
// de la semana y el estado de suscripción de cada alumno. Cableada a datos reales
// (lib/attendance.buildAttendanceRows), misma fuente que el panel del admin.
// Responsive: tabla ≥900px, tarjetas <900px (clases .asis-* en globals.css).
import { useState, useEffect, useMemo } from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { PullToRefresh } from '@/components/PullToRefresh';
import { getSpainParts } from '@/components/VisualCalendar';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import { buildAttendanceRows, isoDate, type LogRow } from '@/lib/attendance';
import { getTeacherAssignments } from '@/lib/db';
import type { Assignment } from '@/types';
import { checkSubscription, subBadge, resolveSubscriptionEmail, type SubscriptionInfo } from '@/lib/useSubscriptionStatus';
import { HelpTooltip } from '@/components/ui';
import type { HelpTooltipKey } from '@/lib/help-tooltips';

// ── Modelo de la pantalla ─────────────────────────────────────────────────────
type Estado = 'no' | 'proxima' | 'ingreso';
interface ClassRow {
  id: string; date: string; time: string; alumno: string;
  sinEnlace: boolean; estado: Estado; horaIngreso: string;
}

const nkName = (s: string) => (s ?? '').trim().toLowerCase();

// Semáforo de estados (pills redondas: punto + texto).
const ESTADO_PILL: Record<Estado, { text: string; bg: string; border: string; dot: string; label: string }> = {
  no:      { text: '#b42318', bg: '#fef3f2', border: '#fecdca', dot: '#f04438', label: 'No ingresó' },
  proxima: { text: '#175cd3', bg: '#eff4ff', border: '#b2ccff', dot: '#2e90fa', label: 'Próxima' },
  ingreso: { text: '#067647', bg: '#ecfdf3', border: '#a6f4c5', dot: '#12b76a', label: 'Ingresó' },
};

// LogRow (attendance) → estado de acceso de la pantalla.
function toEstado(s: LogRow['status']): Estado {
  if (s === 'missed') return 'no';
  if (s === 'pending' || s === 'upcoming') return 'proxima';
  return 'ingreso';   // on_time | late | very_late
}

// ── Helpers de fecha/formato ──────────────────────────────────────────────────
function mondayOf(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1);
  const js = dt.getDay();
  dt.setDate(dt.getDate() + (js === 0 ? -6 : 1 - js));
  return dt;
}
const addDays = (base: Date, n: number): Date => { const d = new Date(base); d.setDate(d.getDate() + n); return d; };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const shortMonth = (d: Date) => d.toLocaleDateString('es-ES', { month: 'short' }).replace('.', '');

function fmtWeekLabel(a: Date, b: Date): string {
  const yr = b.getFullYear();
  return a.getMonth() === b.getMonth()
    ? `${a.getDate()} — ${b.getDate()} ${shortMonth(b)} ${yr}`
    : `${a.getDate()} ${shortMonth(a)} — ${b.getDate()} ${shortMonth(b)} ${yr}`;
}
function fmtDayStrip(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  return `${cap(d.toLocaleDateString('es-ES', { weekday: 'short' }).replace('.', ''))} ${d.getDate()}`;
}
function fmtHour(h: string): string {
  return /^\d{1,2}$/.test(h) ? `${h.padStart(2, '0')}:00` : h;
}

// ── Pills ─────────────────────────────────────────────────────────────────────
function EstadoPill({ e }: { e: Estado }) {
  const p = ESTADO_PILL[e];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 999, background: p.bg, border: `1px solid ${p.border}`, color: p.text, fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap' }}>
      <span style={{ width: 7, height: 7, borderRadius: 999, background: p.dot }} />
      {p.label}
    </span>
  );
}
// Pill de suscripción con el ESTADO REAL del alumno. Fuente única: subBadge (misma
// que "Alumnos" y "Próximas clases"), así nunca inventa un estado ("vencida") que
// no es el real y muestra el que corresponda ("Sin verificar", "Pendiente cancelar",
// etc.). `info` undefined = aún verificando (subBadge muestra '...'). Se muestra
// SIEMPRE, aunque el profe no haya ingresado a la clase.
function SubBadgePill({ info }: { info?: SubscriptionInfo }) {
  const b = subBadge(info);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', padding: '3px 9px', borderRadius: 7, background: b.bg, color: b.color, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {b.label}
    </span>
  );
}
const SinEnlaceTag = () => (
  <span style={{ fontSize: 11, fontWeight: 600, color: '#b54708', background: '#fffaeb', border: '1px solid #fedf89', borderRadius: 6, padding: '2px 7px', whiteSpace: 'nowrap' }}>sin enlace</span>
);

// ── Página ────────────────────────────────────────────────────────────────────
function AsistenciasContent() {
  const { user } = useAuth();
  const { teachers, students, classJoinLogs, loadClassJoinLogs, reloadAll } = useTeachers();

  const teacher = teachers.find(t => t.id === user?.teacherId) ?? teachers[0];

  const nowSpain = getSpainParts(new Date());
  const todayIso = nowSpain.dateStr;
  const nowMinutes = nowSpain.hour * 60 + nowSpain.minute;

  const [weekOffset, setWeekOffset] = useState(0);
  const [filter, setFilter] = useState<'todas' | 'no' | 'proxima'>('todas');
  const [query, setQuery] = useState('');
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let alive = true;
    loadClassJoinLogs()
      .then(() => { if (alive) setLoadState('ready'); })
      .catch(() => { if (alive) setLoadState('error'); });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const weekStart = useMemo(() => addDays(mondayOf(todayIso), weekOffset * 7), [todayIso, weekOffset]);
  const weekEnd   = useMemo(() => addDays(weekStart, 6), [weekStart]);
  const fromDate  = isoDate(weekStart);
  const toDate    = isoDate(weekEnd);
  const isThisWeek = weekOffset === 0;

  // Los alumnos salen del GRID, no de `assignments`. Filtrar por teacherId metía
  // acá a alumnos sin ninguna celda en el calendario del profesor, y como cada
  // clase esperada sin ingreso cuenta como "🔴 No ingresó", le falseaba la
  // asistencia hacia abajo. La pertenencia la decide getTeacherAssignments.
  const [myAssignments, setMyAssignments] = useState<Assignment[]>([]);
  useEffect(() => {
    if (!teacher) return;
    let cancelled = false;
    getTeacherAssignments(teacher)
      .then(rows => { if (!cancelled) setMyAssignments(rows); })
      .catch(err => console.error('[asistencias] No se pudieron leer los alumnos del grid:', err));
    return () => { cancelled = true; };
  // Por ID, no por el objeto `teacher`: la lista se recarga cada 60 s y su
  // identidad cambia en cada recarga, lo que relanzaría la lectura en bucle.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teacher?.id]);

  // Filas de asistencia de la semana (datos reales), ordenadas por día y hora.
  const rows = useMemo<LogRow[]>(() => {
    if (!teacher) return [];
    return buildAttendanceRows({
      assignments: myAssignments, joinLogs: classJoinLogs, teacherId: teacher.id,
      fromDate, toDate, todayIso, nowMinutes, includeFuture: true,
    }).sort((x, y) => x.date.localeCompare(y.date) || (parseInt(x.hour) - parseInt(y.hour)));
  }, [teacher, myAssignments, classJoinLogs, fromDate, toDate, todayIso, nowMinutes]);

  const allClasses = useMemo<ClassRow[]>(() => rows.map(r => ({
    id: r.id, date: r.date, time: fmtHour(r.hour), alumno: r.studentName,
    sinEnlace: !r.hasLink, estado: toEstado(r.status),
    horaIngreso: r.joinedAt ? new Date(r.joinedAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : '',
  })), [rows]);

  // ── Suscripción por alumno (estado REAL, fuente única useSubscriptionStatus) ──
  // Se consulta por alumno (no por join log), así el estado se muestra SIEMPRE,
  // aunque el profe no haya ingresado a la clase, y es el mismo que ve en "Alumnos".
  // checkSubscription cachea 5 min por email y comparte caché con el resto de la app.
  const emailForStudent = (name: string): string => {
    const n = nkName(name);
    const stu = students.find(s => nkName(s.name) === n);
    const asg = myAssignments.find(a => nkName(a.studentName) === n);
    return resolveSubscriptionEmail(stu?.email, asg?.studentEmail);
  };
  const [subByStudent, setSubByStudent] = useState<Record<string, SubscriptionInfo>>({});
  const weekStudents = useMemo(() => Array.from(new Set(allClasses.map(c => c.alumno))), [allClasses]);
  useEffect(() => {
    let alive = true;
    (async () => {
      for (const name of weekStudents) {
        try {
          // Sin email resoluble, checkSubscription devuelve 'no_email' → subBadge
          // muestra "Sin verificar" (no un spinner infinito).
          const info = await checkSubscription(emailForStudent(name));
          if (!alive) return;
          setSubByStudent(prev => ({ ...prev, [nkName(name)]: info }));
        } catch { /* best-effort: la pantalla no se rompe si falla la verificación */ }
      }
    })();
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStudents.join('|')]);
  const subFor = (name: string): SubscriptionInfo | undefined => subByStudent[nkName(name)];

  // Métricas: SIEMPRE sobre el total de la semana (no sobre el set filtrado).
  const ingresoCount = allClasses.filter(c => c.estado === 'ingreso').length;
  const noCount      = allClasses.filter(c => c.estado === 'no').length;
  const proxCount    = allClasses.filter(c => c.estado === 'proxima').length;
  const onTimeCount  = rows.filter(r => r.status === 'on_time').length;
  const punct        = ingresoCount > 0 ? Math.round((onTimeCount / ingresoCount) * 100) : 0;
  const total        = allClasses.length || 1;

  // Filtro + búsqueda combinados (AND). Días sin clases tras filtrar se ocultan.
  const q = query.trim().toLowerCase();
  const filtered = allClasses.filter(c =>
    (filter === 'todas' || c.estado === filter) && (!q || c.alumno.toLowerCase().includes(q)),
  );
  const days = useMemo(() => {
    const out: Array<{ iso: string; label: string; today: boolean; classes: ClassRow[] }> = [];
    for (const c of filtered) {
      let g = out.find(d => d.iso === c.date);
      if (!g) { g = { iso: c.date, label: fmtDayStrip(c.date), today: c.date === todayIso, classes: [] }; out.push(g); }
      g.classes.push(c);
    }
    return out;
  }, [filtered, todayIso]);

  const metrics: Array<{ num: string | number; color: string; label: string; sub: string; help: HelpTooltipKey }> = [
    { num: ingresoCount, color: '#067647', label: 'Clases con ingreso', sub: 'clases con acceso registrado', help: 'asistencias.conIngreso' },
    { num: `${punct}%`,  color: '#b54708', label: 'Puntualidad',        sub: 'ingresos a tiempo',            help: 'asistencias.puntualidad' },
    { num: noCount,      color: '#b42318', label: 'No ingresó',          sub: 'sin registro de acceso',       help: 'asistencias.noIngreso' },
    { num: proxCount,    color: '#175cd3', label: 'Próximas',            sub: 'aún por darse esta semana',    help: 'asistencias.proximas' },
  ];

  const chips: Array<{ id: typeof filter; label: string }> = [
    { id: 'todas', label: 'Todas' }, { id: 'no', label: 'No ingresó' }, { id: 'proxima', label: 'Próximas' },
  ];

  const showSkeleton = loadState === 'loading' || !teacher;

  return (
    <div className="asis-page">
      <NavBar />
      <PullToRefresh onRefresh={async () => { await reloadAll(); await loadClassJoinLogs(); }}>
        <div className="asis-wrap">
          {/* Encabezado + navegador de semana */}
          <div className="asis-head">
            <div>
              <h1 className="asis-title">Asistencias</h1>
              <p className="asis-sub">Quién no ingresó, la puntualidad de la semana y la suscripción de cada alumno.</p>
            </div>
            <div className="asis-weeknav">
              <button className="asis-weekbtn" aria-label="Semana anterior" onClick={() => setWeekOffset(o => o - 1)}>
                <ChevronLeft size={18} strokeWidth={2.25} />
              </button>
              <span className="asis-weeklabel">{fmtWeekLabel(weekStart, weekEnd)}</span>
              <button className="asis-weekbtn" aria-label="Semana siguiente" onClick={() => setWeekOffset(o => o + 1)}>
                <ChevronRight size={18} strokeWidth={2.25} />
              </button>
              <button className="asis-weekpill" onClick={() => setWeekOffset(0)} aria-disabled={isThisWeek}
                title={isThisWeek ? 'Estás en la semana actual' : 'Ir a la semana actual'}>
                Esta semana
              </button>
            </div>
          </div>

          {loadState === 'error' ? (
            <div className="asis-card asis-empty">No se pudieron cargar las asistencias. Deslizá para reintentar.</div>
          ) : showSkeleton ? (
            <Skeleton />
          ) : (
            <>
              {/* Métricas */}
              <div className="asis-metrics">
                {metrics.map(m => (
                  <div key={m.label} className="asis-metric">
                    <div className="asis-metric-num" style={{ color: m.color }}>{m.num}</div>
                    <div className="asis-metric-lab">
                      <span className="asis-dot" style={{ background: m.color }} />
                      {m.label}
                      <HelpTooltip tooltipKey={m.help} />
                    </div>
                    <div className="asis-metric-sub">{m.sub}</div>
                  </div>
                ))}
              </div>

              {/* Resumen de la semana: barra apilada + leyenda */}
              <div className="asis-summary">
                <div className="asis-bar" role="img" aria-label={`Ingresó ${ingresoCount}, No ingresó ${noCount}, Próximas ${proxCount}`}>
                  <span style={{ width: `${(noCount / total) * 100}%`, background: '#f04438' }} />
                  <span style={{ width: `${(proxCount / total) * 100}%`, background: '#2e90fa' }} />
                  <span style={{ width: `${(ingresoCount / total) * 100}%`, background: '#12b76a' }} />
                </div>
                <div className="asis-legend">
                  <span><span className="asis-dot" style={{ background: '#12b76a' }} />Ingresó · <b>{ingresoCount}</b></span>
                  <span><span className="asis-dot" style={{ background: '#f04438' }} />No ingresó · <b>{noCount}</b></span>
                  <span><span className="asis-dot" style={{ background: '#2e90fa' }} />Próximas · <b>{proxCount}</b></span>
                </div>
              </div>

              {/* Filtros + búsqueda */}
              <div className="asis-filters">
                <div className="asis-chips">
                  {chips.map(c => (
                    <button key={c.id} className={`asis-chip${filter === c.id ? ' is-active' : ''}`} onClick={() => setFilter(c.id)}>
                      {c.label}
                    </button>
                  ))}
                </div>
                <div className="asis-search">
                  <span className="asis-search-ic"><Search size={16} strokeWidth={2.25} /></span>
                  <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Buscar alumno…" aria-label="Buscar alumno" />
                </div>
              </div>

              {days.length === 0 ? (
                <div className="asis-card asis-empty">Sin clases para este filtro.</div>
              ) : (
                <>
                  {/* ── Tabla agrupada por día (desktop ≥900px) ── */}
                  <div className="asis-card asis-desktop">
                    <table className="asis-tbl">
                      <thead>
                        <tr>
                          {([
                            { h: 'Hora' }, { h: 'Alumno' },
                            { h: 'Hora ingreso', help: 'asistencias.horaIngreso' },
                            { h: 'Estado', help: 'asistencias.estado' },
                            { h: 'Suscripción', help: 'finanzas.suscripcion' },
                          ] as Array<{ h: string; help?: HelpTooltipKey }>).map((col, i) => (
                            <th key={col.h} style={i === 0 ? { width: 110 } : i === 2 ? { width: 140 } : i === 3 ? { width: 150 } : i === 4 ? { width: 130 } : undefined}>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                {col.h}
                                {col.help && <HelpTooltip tooltipKey={col.help} />}
                              </span>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {days.map(day => (
                          <DayGroupRows key={day.iso} day={day} subFor={subFor} />
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* ── Agenda en tarjetas por día (mobile <900px) ── */}
                  <div className="asis-mobile">
                    {days.map(day => (
                      <div key={day.iso}>
                        <div className="asis-day-h">
                          <span className="asis-day-name">{day.label}</span>
                          {day.today && <span className="asis-hoy">Hoy</span>}
                          <span className="asis-day-count">{day.classes.length} clase{day.classes.length === 1 ? '' : 's'}</span>
                        </div>
                        {day.classes.map(c => (
                          <div key={c.id} className="asis-mcard">
                            <div className="asis-mcard-top">
                              <span className="asis-mcard-time">{c.time}</span>
                              <span className="asis-mcard-name">{c.alumno}</span>
                              <EstadoPill e={c.estado} />
                            </div>
                            <div className="asis-mcard-bot">
                              <span>Ingreso: {c.horaIngreso || '—'}</span>
                              {c.sinEnlace && <SinEnlaceTag />}
                              <SubBadgePill info={subFor(c.alumno)} />
                            </div>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </>
              )}

              <div className="asis-foot">
                El ingreso se registra automáticamente al usar el botón <b>“Ingresar a clase”</b> desde el Calendario. No se puede cargar después: las clases sin registro figuran como <b>No ingresó</b>.
              </div>
            </>
          )}
        </div>
      </PullToRefresh>
    </div>
  );
}

// Franja de día + sus filas dentro de la tabla (desktop).
function DayGroupRows({ day, subFor }: {
  day: { iso: string; label: string; today: boolean; classes: ClassRow[] };
  subFor: (name: string) => SubscriptionInfo | undefined;
}) {
  return (
    <>
      <tr className="asis-daystrip">
        <td colSpan={5}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
            <span className="asis-day-name">{day.label}</span>
            {day.today && <span className="asis-hoy">Hoy</span>}
            <span className="asis-day-count">{day.classes.length} clase{day.classes.length === 1 ? '' : 's'}</span>
          </span>
        </td>
      </tr>
      {day.classes.map(c => (
        <tr key={c.id}>
          <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{c.time}</td>
          <td>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {c.alumno}
              {c.sinEnlace && <SinEnlaceTag />}
            </span>
          </td>
          <td style={{ color: c.horaIngreso ? 'var(--text-secondary)' : 'var(--text-muted)', whiteSpace: 'nowrap' }}>{c.horaIngreso || '—'}</td>
          <td><EstadoPill e={c.estado} /></td>
          <td><SubBadgePill info={subFor(c.alumno)} /></td>
        </tr>
      ))}
    </>
  );
}

function Skeleton() {
  return (
    <div aria-hidden="true">
      <div className="asis-metrics">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="asis-metric">
            <div className="asis-skel" style={{ width: 56, height: 34 }} />
            <div className="asis-skel" style={{ width: '70%', height: 13, marginTop: 12 }} />
            <div className="asis-skel" style={{ width: '50%', height: 11, marginTop: 8 }} />
          </div>
        ))}
      </div>
      <div className="asis-summary">
        <div className="asis-skel" style={{ width: '100%', height: 12, borderRadius: 999 }} />
        <div className="asis-skel" style={{ width: '60%', height: 13, marginTop: 14 }} />
      </div>
      <div className="asis-card" style={{ padding: 18 }}>
        {[0, 1, 2, 3, 4].map(i => (
          <div key={i} className="asis-skel" style={{ width: '100%', height: 20, marginBottom: 14 }} />
        ))}
      </div>
    </div>
  );
}

export default function AsistenciasPage() {
  return (
    <AuthGuard allowedRoles={['teacher']}>
      <AsistenciasContent />
    </AuthGuard>
  );
}
