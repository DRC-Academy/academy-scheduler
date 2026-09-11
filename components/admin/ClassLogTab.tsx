'use client';

// Pestaña admin "Registro de clases": quién entró a cada clase y a qué hora.
//
// Rediseño de septiembre de 2026 (lienzo aprobado por Facundo). Antes era una
// tabla de siete columnas con 30 días cargados de golpe (1.900 filas) que en el
// teléfono obligaba a deslizar de costado. Ahora:
//   · La lista va AGRUPADA POR DÍA. En escritorio son filas con una franja por
//     día; en el teléfono cada clase es una tarjeta (hora · alumno · estado;
//     debajo profesor, "2 h", hora de entrada). Nada se desliza en horizontal.
//   · El período son tres botones (Hoy · 7 días · 30 días); "Otro período" en
//     escritorio abre las dos fechas. Por defecto 7 días, y "Mostrar 50 más"
//     para seguir hacia atrás.
//   · Las cuatro cifras de arriba (puntualidad, no ingresó, registradas, sin
//     enlace) pasan a ser LAS DEL PROFESOR cuando se elige uno: sustituyen al
//     "Resumen del profesor" que aparecía abajo al tocar su nombre.
//   · Una sola etiqueta por clase, con los minutos cuando importa ("Tarde ·
//     11 min"). La suscripción solo se muestra en el teléfono cuando es un
//     problema (entró sin suscripción activa); en escritorio sigue la columna.
//   · La hora de entrada se muestra en HORA DE ESPAÑA, la misma que la clase.
//     Antes salía en la hora del navegador y "22:00 → entró 17:01" no se podía
//     leer desde Argentina.
//
// Las filas las arma lib/attendance.buildAttendanceRows (fuente única, la misma
// que la sección "Asistencias" del profesor). Un solo DOM para los dos tamaños:
// la fila de escritorio se vuelve tarjeta por debajo de 768 px solo con CSS.

import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, CheckCircle2, Link2, Search, X } from 'lucide-react';
import { useTeachers } from '@/lib/TeachersContext';
import { getSpainParts } from '@/lib/spainTime';
import { buildAttendanceRows, attendanceSubBadge, minutesLate, isoDate, type LogRow, type AttendanceStatus } from '@/lib/attendance';
import { periodIndex, dbGetStudentDropouts, type StudentDropout } from '@/lib/studentPeriod';
import { gridOccupancyOfTeacher, applyGridSlots } from '@/lib/teacherClasses';
import { HelpTooltip } from '@/components/ui';
import type { HelpTooltipKey } from '@/lib/help-tooltips';

type Periodo = 'hoy' | '7' | '30' | 'otro';
type Filtro = 'all' | 'missed' | 'late' | 'on_time' | 'no_link' | 'no_sub';

const PERIODOS: Array<{ id: Periodo; label: string }> = [
  { id: 'hoy', label: 'Hoy' }, { id: '7', label: '7 días' }, { id: '30', label: '30 días' }, { id: 'otro', label: 'Otro período' },
];

const FILTROS: Array<{ id: Filtro; label: string; tono?: 'rojo' | 'naranja' }> = [
  { id: 'all',     label: 'Todos' },
  { id: 'missed',  label: 'No ingresó', tono: 'rojo' },
  { id: 'late',    label: 'Tarde' },
  { id: 'on_time', label: 'A tiempo' },
  { id: 'no_link', label: 'Sin enlace', tono: 'naranja' },
  { id: 'no_sub',  label: 'Sin suscripción', tono: 'naranja' },
];

/** Cuántas filas se pintan de entrada y cuántas suma cada "Mostrar más". */
const PAGINA = 50;

function pasaFiltro(r: LogRow, f: Filtro): boolean {
  switch (f) {
    case 'all':     return true;
    case 'missed':  return r.status === 'missed';
    case 'late':    return r.status === 'late' || r.status === 'very_late';
    case 'on_time': return r.status === 'on_time';
    case 'no_link': return !r.hasLink;
    case 'no_sub':  return r.enteredWithoutActive === true;
  }
}

/** Hora de entrada en hora de España (HH:MM), la misma en la que está la clase. */
function horaEntrada(iso: string): string {
  const p = getSpainParts(new Date(iso));
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

function fechaDia(iso: string, todayIso: string): { nombre: string; hoy: boolean } {
  const d = new Date(iso + 'T00:00:00');
  const s = d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'short' }).replace('.', '').replace(',', '');
  return { nombre: s.charAt(0).toUpperCase() + s.slice(1), hoy: iso === todayIso };
}

const ETIQUETA: Record<AttendanceStatus, { label: string; cls: string }> = {
  on_time:   { label: 'A tiempo',  cls: 'ok' },
  late:      { label: 'Tarde',     cls: 'tarde' },
  very_late: { label: 'Muy tarde', cls: 'muy' },
  missed:    { label: 'No ingresó', cls: 'no' },
  pending:   { label: 'Pendiente', cls: 'pend' },
  upcoming:  { label: 'Próxima',   cls: 'pend' },
};

function Etiqueta({ r }: { r: LogRow }) {
  const e = ETIQUETA[r.status] ?? { label: 'Sin dato', cls: 'pend' };
  const min = (r.status === 'late' || r.status === 'very_late') && r.joinedAt
    ? Math.max(0, Math.round(minutesLate(r.date, r.hour, r.joinedAt))) : 0;
  return <span className={`rc-tag ${e.cls}`}>{e.label}{min > 0 ? ` · ${min} min` : ''}</span>;
}

// ═════════════════════════════════════════════════════════════════════════════
export default function ClassLogTab() {
  const { teachers, assignments, classJoinLogs, loadClassJoinLogs } = useTeachers();

  // "Ahora" se calcula SIEMPRE en hora de España (Europe/Madrid), igual que el
  // indicador de hora actual del calendario, no importa dónde esté el admin.
  const nowSpain = getSpainParts(new Date());
  const todayIso = nowSpain.dateStr;
  const nowMinutes = nowSpain.hour * 60 + nowSpain.minute;

  const [sy, sm, sd] = todayIso.split('-').map(Number);
  const spainToday = new Date(sy, (sm ?? 1) - 1, sd ?? 1);
  const haceDias = (n: number) => { const d = new Date(spainToday); d.setDate(spainToday.getDate() - n); return isoDate(d); };

  const [periodo, setPeriodo] = useState<Periodo>('7');
  const [fromDate, setFromDate] = useState(haceDias(29));
  const [toDate, setToDate] = useState(todayIso);
  const [teacherFilter, setTeacherFilter] = useState('');
  const [filtro, setFiltro] = useState<Filtro>('all');
  const [query, setQuery] = useState('');
  const [limite, setLimite] = useState(PAGINA);

  useEffect(() => {
    loadClassJoinLogs();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rango = periodo === 'hoy' ? { desde: todayIso, hasta: todayIso }
    : periodo === '7' ? { desde: haceDias(6), hasta: todayIso }
    : periodo === '30' ? { desde: haceDias(29), hasta: todayIso }
    : { desde: fromDate, hasta: toDate };

  // Ocupación del calendario de cada profesor: decide el horario real de cada
  // alumno y qué horas seguidas son UNA clase de 2h. Sale de `teacher.upcomingClasses`,
  // que ya viene cargado, no cuesta ninguna consulta.
  const occupancyByTeacher = useMemo(
    () => Object.fromEntries(teachers.map(t => [t.id, gridOccupancyOfTeacher(t)])),
    [teachers],
  );

  // Período de cada alumno con cada profesor (inicio de clases → baja). Ver el
  // contrato en lib/studentPeriod: filtra lo PROYECTADO, nunca los hechos.
  const [dropouts, setDropouts] = useState<StudentDropout[]>([]);
  useEffect(() => { dbGetStudentDropouts().then(setDropouts).catch(() => {}); }, []);
  const periodsByTeacher = useMemo(
    () => Object.fromEntries(teachers.map(t => [t.id, periodIndex(assignments, dropouts, t.id)])),
    [teachers, assignments, dropouts],
  );

  // Filas de asistencia (fuente única: lib/attendance). Todos los profes (o el
  // filtrado), sin clases futuras, de la más reciente a la más antigua.
  const baseRows = useMemo<LogRow[]>(() =>
    buildAttendanceRows({
      // Horarios del CALENDARIO: un alumno sacado del calendario deja de generar
      // filas de asistencia.
      assignments: applyGridSlots(assignments, occupancyByTeacher),
      joinLogs: classJoinLogs,
      teacherId: teacherFilter || undefined,
      fromDate: rango.desde, toDate: rango.hasta, todayIso, nowMinutes,
      includeFuture: false,
      gridOccupancyByTeacher: occupancyByTeacher,
      // Su PERÍODO decide desde cuándo existen: sin esto un alumno que empieza
      // el mes que viene ya acumula "no ingresó" hacia atrás.
      periodsByTeacher,
    }).sort((x, y) => y.date.localeCompare(x.date) || (parseInt(y.hour) - parseInt(x.hour))),
  [assignments, classJoinLogs, teacherFilter, rango.desde, rango.hasta, todayIso, nowMinutes, occupancyByTeacher, periodsByTeacher]);

  // Cifras. Las "Pendiente" (hoy, aún sin pasar) no cuentan como registradas ni
  // como perdidas.
  const registradas = baseRows.filter(r => r.status !== 'missed' && r.status !== 'pending');
  const aTiempo = baseRows.filter(r => r.status === 'on_time').length;
  const tarde = baseRows.filter(r => r.status === 'late' || r.status === 'very_late').length;
  const perdidas = baseRows.filter(r => r.status === 'missed').length;
  const pct = (n: number) => registradas.length > 0 ? Math.round((n / registradas.length) * 100) : 0;
  const sinEnlace = assignments.filter(a => (!teacherFilter || a.teacherId === teacherFilter) && !a.meetLink).length;
  const profe = teacherFilter ? teachers.find(t => t.id === teacherFilter) : undefined;
  const atrasoMedio = useMemo(() => {
    if (!teacherFilter) return 0;
    const logs = classJoinLogs.filter(l => l.teacherId === teacherFilter && l.scheduledDate >= rango.desde && l.scheduledDate <= rango.hasta);
    return logs.length ? Math.round(logs.reduce((s, l) => s + Math.max(0, minutesLate(l.scheduledDate, l.scheduledTime, l.clickedAt)), 0) / logs.length) : 0;
  }, [classJoinLogs, teacherFilter, rango.desde, rango.hasta]);

  const conteo = useMemo(() => {
    const c = {} as Record<Filtro, number>;
    for (const f of FILTROS) c[f.id] = baseRows.filter(r => pasaFiltro(r, f.id)).length;
    return c;
  }, [baseRows]);

  const q = query.trim().toLowerCase();
  const visibles = baseRows.filter(r => pasaFiltro(r, filtro) && (!q || r.studentName.toLowerCase().includes(q) || r.teacherName.toLowerCase().includes(q)));
  const mostradas = visibles.slice(0, limite);
  const porDia: Array<{ date: string; filas: LogRow[] }> = [];
  for (const r of mostradas) {
    const ultimo = porDia[porDia.length - 1];
    if (ultimo && ultimo.date === r.date) ultimo.filas.push(r); else porDia.push({ date: r.date, filas: [r] });
  }
  // Para el contador de la franja se cuenta el día ENTERO, no solo lo paginado.
  const totalDelDia = (date: string) => visibles.filter(r => r.date === date);

  const cambiar = <T,>(setter: (v: T) => void) => (v: T) => { setter(v); setLimite(PAGINA); };
  const periodoTexto = periodo === 'hoy' ? 'hoy' : periodo === '7' ? 'en los últimos 7 días' : periodo === '30' ? 'en los últimos 30 días' : 'en este período';

  return (
    <div className="rc">
      {/* ── Cabecera (el título en el teléfono lo pone la barra de Admin) ── */}
      <div className="rc-head">
        <div className="rc-titulo">
          <h2 className="rc-title">Registro de clases</h2>
          <p className="rc-sub">Quién entró a cada clase y a qué hora. Todas las horas en hora de España.</p>
        </div>
        <div className="rc-ctl">
          <div className="rc-seg" role="group" aria-label="Período">
            {PERIODOS.map(p => (
              <button key={p.id} type="button" className={`rc-segb${p.id === 'otro' ? ' otro' : ''}`} aria-pressed={periodo === p.id} onClick={() => cambiar(setPeriodo)(p.id)}>
                {p.id === 'otro' && <CalendarDays size={15} aria-hidden />}{p.label}
              </button>
            ))}
          </div>
          {periodo === 'otro' && (
            <div className="rc-fechas">
              <input type="date" value={fromDate} max={toDate} onChange={e => cambiar(setFromDate)(e.target.value)} aria-label="Desde" />
              <span>→</span>
              <input type="date" value={toDate} min={fromDate} max={todayIso} onChange={e => cambiar(setToDate)(e.target.value)} aria-label="Hasta" />
            </div>
          )}
          <label className="rc-sel">
            <span className="rc-sel-l">Profesor</span>
            <select value={teacherFilter} onChange={e => cambiar(setTeacherFilter)(e.target.value)}>
              <option value="">Todos</option>
              {teachers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            {teacherFilter && (
              <button type="button" className="rc-sel-x" onClick={() => cambiar(setTeacherFilter)('')} aria-label="Quitar el profesor"><X size={14} strokeWidth={2.5} /></button>
            )}
          </label>
          <label className="rc-search">
            <Search size={17} strokeWidth={2} aria-hidden />
            <input value={query} onChange={e => cambiar(setQuery)(e.target.value)} placeholder="Buscar alumno…" aria-label="Buscar alumno" />
          </label>
        </div>
      </div>

      {/* ── Cifras: las del período o, con un profesor elegido, las suyas ── */}
      {profe ? (
        <div className="rc-kpis cinco">
          <Kpi label="A tiempo" value={`${pct(aTiempo)} %`} color="#1E9E3A" />
          {/* En el teléfono son cuatro cifras (2×2): el % tarde se deduce del % a tiempo. */}
          <Kpi label="Tarde" value={`${pct(tarde)} %`} color="#b45309" soloEscritorio />
          <Kpi label="No ingresó" value={perdidas} color={perdidas > 0 ? '#dc2626' : '#1E9E3A'} />
          <Kpi label="Clases" value={baseRows.length} sub={periodoTexto} />
          <Kpi label="Atraso medio" value={`${atrasoMedio} min`} />
        </div>
      ) : (
        <div className="rc-kpis">
          <Kpi label="Puntualidad" value={`${pct(aTiempo)} %`} color={pct(aTiempo) >= 80 ? '#1E9E3A' : pct(aTiempo) >= 60 ? '#b45309' : '#dc2626'} sub="de las clases con ingreso" help="asistencias.puntualidad" />
          <Kpi label="No ingresó" value={perdidas} color={perdidas > 0 ? '#dc2626' : '#1E9E3A'} sub="clases pasadas sin acceso" help="profesores.clasesPerdidas" />
          <Kpi label="Clases registradas" value={registradas.length} sub={periodoTexto} help="profesores.clasesRegistradas" />
          <Kpi label="Sin enlace" value={sinEnlace} color={sinEnlace > 0 ? '#ea580c' : '#1E9E3A'} sub="alumnos sin link de Meet" help="profesores.sinEnlace" />
        </div>
      )}

      {/* ── Lista ── */}
      <div className="adm-card rc-lista">
        <div className="rc-chips" role="group" aria-label="Filtrar por estado">
          {FILTROS.map(f => (
            <button key={f.id} type="button" className="rc-chip" aria-pressed={filtro === f.id} onClick={() => cambiar(setFiltro)(f.id)}>
              {f.label}<span className={`n${f.tono && conteo[f.id] > 0 && filtro !== f.id ? ` ${f.tono}` : ''}`}>{conteo[f.id]}</span>
            </button>
          ))}
        </div>

        {baseRows.length === 0 ? (
          <div className="rc-vacio"><div className="rc-vacio-s">Sin clases {periodoTexto}{profe ? ` de ${profe.name}` : ''}.</div></div>
        ) : visibles.length === 0 && filtro === 'missed' && !q ? (
          <div className="rc-vacio">
            <span style={{ color: '#1E9E3A' }}><CheckCircle2 size={40} strokeWidth={1.75} aria-hidden /></span>
            <div className="rc-vacio-t">{periodo === 'hoy' ? 'Nadie faltó hoy' : 'Nadie faltó'}</div>
            <div className="rc-vacio-s">Todas las clases {periodoTexto} que ya pasaron tuvieron ingreso.</div>
          </div>
        ) : visibles.length === 0 ? (
          <div className="rc-vacio"><div className="rc-vacio-s">Sin clases para estos filtros.</div></div>
        ) : (
          <>
            <div className="rc-row head" aria-hidden>
              <span>Hora</span><span>Alumno</span><span>Profesor</span><span>Entró</span><span>Puntualidad</span><span>Suscripción</span>
            </div>
            {porDia.map(d => {
              const { nombre, hoy } = fechaDia(d.date, todayIso);
              const todas = totalDelDia(d.date);
              const sinIngreso = todas.filter(r => r.status === 'missed').length;
              return (
                <div key={d.date} className="rc-dia">
                  <div className="rc-strip">
                    <span className="rc-dia-n">{nombre}</span>
                    {hoy && <span className="rc-hoy">Hoy</span>}
                    <span className="rc-dia-c">{todas.length} clase{todas.length === 1 ? '' : 's'}{sinIngreso > 0 && <> · <b>{sinIngreso} sin ingreso</b></>}</span>
                  </div>
                  {d.filas.map(r => (
                    <Fila key={r.id} r={r} sinProfe={!!teacherFilter} onProfe={() => cambiar(setTeacherFilter)(r.teacherId)} />
                  ))}
                </div>
              );
            })}
            {visibles.length > mostradas.length && (
              <div className="rc-mas">
                <button type="button" className="adm-btn adm-btn-ghost" onClick={() => setLimite(l => l + PAGINA)}>
                  Mostrar {Math.min(PAGINA, visibles.length - mostradas.length)} más · quedan {visibles.length - mostradas.length}
                </button>
              </div>
            )}
          </>
        )}
      </div>
      <style>{ESTILOS}</style>
    </div>
  );
}

function Kpi({ label, value, color, sub, help, soloEscritorio }: { label: string; value: string | number; color?: string; sub?: string; help?: HelpTooltipKey; soloEscritorio?: boolean }) {
  return (
    <div className={`adm-card rc-kpi${soloEscritorio ? ' solo-desk' : ''}`}>
      <div className="rc-kpi-v" style={{ color }}>{value}</div>
      <div className="rc-kpi-l">{label}{help && <HelpTooltip tooltipKey={help} />}</div>
      {sub && <div className="rc-kpi-s">{sub}</div>}
    </div>
  );
}

// ── Una fila (escritorio) / una tarjeta (teléfono) ───────────────────────────
function Fila({ r, sinProfe, onProfe }: { r: LogRow; sinProfe: boolean; onProfe: () => void }) {
  const sub = attendanceSubBadge(r);
  const problema = r.enteredWithoutActive === true;
  return (
    <div className={`rc-row${r.status === 'missed' ? ' no' : ''}`}>
      <span className="rc-hora">
        {r.hour}
        {r.durationHours > 1 && <span className="rc-rango"> – {r.hoursLabel.split(' - ')[1] ?? ''} <span className="rc-2h">{r.durationHours}h</span></span>}
      </span>
      <span className="rc-nom">
        <span className="rc-nom-t">{r.studentName}</span>
        {!r.hasLink && <span className="rc-tag warn rc-link-d"><Link2 size={12} aria-hidden /> Sin enlace</span>}
      </span>
      <div className="rc-meta">
        <button type="button" className={`rc-prof${sinProfe ? ' sin' : ''}`} onClick={onProfe} title={`Ver solo las clases de ${r.teacherName}`}>{r.teacherName}</button>
        {r.durationHours > 1 && <span className="rc-dur">{r.durationHours} h</span>}
        <span className={`rc-ing${r.joinedAt ? '' : ' vacio'}`}>{r.joinedAt ? <><span className="rc-ing-l">entró</span>{horaEntrada(r.joinedAt)}</> : <span className="rc-ing-no">—</span>}</span>
        {!r.hasLink && <span className="rc-tag warn rc-link-m"><Link2 size={12} aria-hidden /> Sin enlace</span>}
        <span className={`rc-sub${problema ? ' problema' : ''}`}>
          {sub
            ? <span className="rc-tag" style={{ background: sub.bg, color: sub.color }}>{problema ? `Sin suscripción · entró igual${r.subscriptionDaysRemaining ? ` · ${r.subscriptionDaysRemaining} d` : ''}` : sub.label.replace(/^\S+\s/, '')}</span>
            : <span className="rc-ing-no">—</span>}
        </span>
      </div>
      <span className="rc-est"><Etiqueta r={r} /></span>
    </div>
  );
}

// ── Estilos ──────────────────────────────────────────────────────────────────
const ESTILOS = `
.rc { font-family: var(--font-app); color: #1a1c1a; }
.rc-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 14px; flex-wrap: wrap; margin-bottom: 14px; }
.rc-title { font-size: 18px; font-weight: 700; letter-spacing: -0.01em; margin: 0; }
.rc-sub { font-size: 13px; color: var(--text-muted); margin: 3px 0 0; }
.rc-ctl { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.rc-seg { display: flex; gap: 6px; flex-wrap: wrap; }
.rc-segb { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 36px; padding: 0 12px; border-radius: 999px; border: 1.5px solid #e6e7e2; background: #fff; font-family: inherit; font-size: 13px; font-weight: 600; color: #4A4A4A; cursor: pointer; }
.rc-segb:hover { background: #f4f5f2; }
.rc-segb[aria-pressed="true"] { border-color: #1E9E3A; background: rgba(30,158,58,0.1); color: #15803d; }
.rc-fechas { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-muted); }
.rc-fechas input { height: 38px; padding: 0 10px; border-radius: 10px; border: 1px solid #e6e7e2; background: #fff; font-family: inherit; font-size: 13px; color: var(--text-primary); }
.rc-sel { position: relative; display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 10px 0 12px; border: 1px solid #e6e7e2; border-radius: 10px; background: #fff; min-width: 200px; }
.rc-sel-l { font-size: 13px; font-weight: 600; color: var(--text-muted); white-space: nowrap; }
.rc-sel select { flex: 1; min-width: 0; height: 100%; border: 0; background: transparent; font-family: inherit; font-size: 13.5px; font-weight: 600; color: var(--text-primary); padding: 0; cursor: pointer; }
.rc-sel select:focus { outline: none; }
.rc-sel-x { width: 26px; height: 26px; border-radius: 999px; border: 0; background: #eef6ef; color: #15803d; display: grid; place-items: center; cursor: pointer; padding: 0; flex-shrink: 0; }
.rc-search { position: relative; display: block; width: 220px; }
.rc-search input { width: 100%; height: 38px; padding: 0 12px 0 34px; border-radius: 10px; border: 1px solid #e6e7e2; background: #fff; font-size: 13.5px; font-family: inherit; color: var(--text-primary); box-sizing: border-box; }
.rc-search svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--text-muted); pointer-events: none; }
.rc-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
.rc-kpis.cinco { grid-template-columns: repeat(5, minmax(0, 1fr)); }
.rc-kpi { padding: 14px 16px; }
.rc-kpi-v { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.15; }
.rc-kpi-l { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; font-weight: 600; color: var(--text-secondary); margin-top: 4px; }
.rc-kpi-s { font-size: 12px; color: #a4a7a1; margin-top: 2px; }
.rc-lista { overflow: clip; }
.rc-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 12px 14px; border-bottom: 1px solid #ECECE8; }
.rc-chip { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 12px; border-radius: 999px; border: 1.5px solid #e6e7e2; background: transparent; font-family: inherit; font-size: 13px; font-weight: 500; color: #4A4A4A; cursor: pointer; }
.rc-chip:hover { background: #f4f5f2; }
.rc-chip[aria-pressed="true"] { border-color: #1E9E3A; background: rgba(30,158,58,0.1); color: #1E9E3A; font-weight: 700; }
.rc-chip .n { font-size: 12px; font-weight: 700; color: #6E6E66; }
.rc-chip[aria-pressed="true"] .n { color: #1E9E3A; }
.rc-chip .n.rojo { color: #C81E1E; }
.rc-chip .n.naranja { color: #ea580c; }
.rc-row { display: grid; grid-template-columns: 118px minmax(0, 1fr) 120px 76px 150px 190px; grid-template-areas: "hora nom prof ing est sub"; align-items: center; gap: 12px; min-height: 46px; padding: 4px 16px; border-top: 1px solid #ECECE8; font-size: 13.5px; }
.rc-row.head { min-height: 36px; font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: #6E6E66; background: #FAFAF8; border-top: 0; }
.rc-row.head span:nth-child(1) { grid-area: hora; } .rc-row.head span:nth-child(2) { grid-area: nom; } .rc-row.head span:nth-child(3) { grid-area: prof; }
.rc-row.head span:nth-child(4) { grid-area: ing; } .rc-row.head span:nth-child(5) { grid-area: est; } .rc-row.head span:nth-child(6) { grid-area: sub; }
.rc-row.no { background: #FFFBFA; }
.rc-hora { grid-area: hora; font-weight: 700; color: #157347; white-space: nowrap; }
.rc-2h { font-size: 10.5px; font-weight: 700; padding: 1px 6px; border-radius: 999px; background: rgba(30,158,58,0.12); color: #1E9E3A; margin-left: 2px; }
.rc-nom { grid-area: nom; display: flex; align-items: center; gap: 8px; min-width: 0; }
.rc-nom-t { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rc-meta { display: contents; }
.rc-prof { grid-area: prof; background: none; border: 0; padding: 0; font-family: inherit; font-size: 13.5px; font-weight: 600; color: #167A2D; cursor: pointer; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rc-prof:hover { text-decoration: underline; }
.rc-dur, .rc-link-m { display: none; }
.rc-ing { grid-area: ing; color: var(--text-muted); white-space: nowrap; }
.rc-ing-l { display: none; }
.rc-ing-no { color: #a4a7a1; }
.rc-est { grid-area: est; }
.rc-sub { grid-area: sub; min-width: 0; }
.rc-tag { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.rc-tag.ok { background: rgba(30,158,58,0.1); color: #1E9E3A; }
.rc-tag.tarde { background: rgba(245,158,11,0.12); color: #b45309; }
.rc-tag.muy { background: rgba(249,115,22,0.12); color: #ea580c; }
.rc-tag.no { background: rgba(239,68,68,0.1); color: #dc2626; }
.rc-tag.pend { background: #E8E8E4; color: #6E6E66; }
.rc-tag.warn { background: rgba(249,115,22,0.12); color: #ea580c; }
.rc-strip { display: flex; align-items: baseline; gap: 8px; padding: 9px 16px; background: #F5F7F4; border-top: 1px solid #ECECE8; }
.rc-dia-n { font-size: 13.5px; font-weight: 700; }
.rc-dia-c { font-size: 12.5px; color: #6E6E66; }
.rc-dia-c b { color: #dc2626; font-weight: 600; }
.rc-hoy { font-size: 10px; font-weight: 700; color: #15803d; background: #e6f4ec; border-radius: 999px; padding: 2px 8px; text-transform: uppercase; letter-spacing: 0.03em; }
.rc-mas { display: flex; justify-content: center; padding: 12px; border-top: 1px solid #ECECE8; }
.rc-vacio { padding: 40px 16px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 6px; }
.rc-vacio-t { font-size: 18px; font-weight: 700; }
.rc-vacio-s { font-size: 14px; color: #6E6E66; max-width: 340px; line-height: 1.5; }

@media (max-width: 1100px) {
  .rc-row { grid-template-columns: 110px minmax(0, 1fr) 100px 70px 140px 150px; gap: 10px; }
}

/* Teléfono: el título lo pone la barra de Admin; la fila se vuelve tarjeta. */
@media (max-width: 767px) {
  .rc-titulo { display: none; }
  .rc-head { margin-bottom: 12px; }
  .rc-ctl { width: 100%; flex-direction: column; align-items: stretch; gap: 10px; }
  .rc-seg { gap: 6px; flex-wrap: nowrap; }
  .rc-segb { flex: 1; min-height: 44px; border-radius: 10px; font-size: 14px; padding: 0 6px; }
  .rc-segb.otro { display: none; }
  .rc-fechas { display: none; }
  .rc-sel { height: 44px; min-width: 0; }
  .rc-sel select { font-size: 14px; }
  .rc-search { display: none; }
  .rc-kpis, .rc-kpis.cinco { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px; }
  .rc-kpi { padding: 12px 14px; }
  .rc-kpi-v { font-size: 24px; }
  .rc-kpi-l { font-weight: 500; color: #6E6E66; }
  .rc-kpi-s, .rc-kpi.solo-desk { display: none; }
  .rc-lista { background: transparent; border: 0; box-shadow: none; overflow: visible; }
  .rc-chips { padding: 0 0 4px; border: 0; }
  .rc-row.head { display: none; }
  .rc-strip { padding: 14px 2px 6px; background: transparent; border: 0; }
  .rc-row { grid-template-columns: auto minmax(0, 1fr) auto; grid-template-areas: "hora nom est" "meta meta meta"; gap: 6px 10px; padding: 11px 14px; min-height: 0; background: #fff; border: 1px solid #e6e7e2; border-radius: 14px; box-shadow: 0 1px 2px rgba(16,24,16,0.04); margin-bottom: 8px; }
  .rc-row.no { border-color: rgba(220,74,56,0.35); background: #FFFBFA; }
  .rc-hora { font-size: 15px; }
  .rc-rango { display: none; }
  .rc-nom-t { font-size: 14.5px; }
  .rc-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; grid-area: meta; font-size: 13px; color: #6E6E66; }
  .rc-prof { font-size: 13px; }
  .rc-prof.sin, .rc-link-d, .rc-ing.vacio, .rc-sub { display: none; }
  /* El global "button { min-height: 44px }" del teléfono estiraría el nombre
     del profesor y el "?" de ayuda: el profesor se elige con el selector de
     arriba y la ayuda es cosa de escritorio. */
  .rc-prof { min-height: 0; pointer-events: none; }
  .rc-kpi-l button { display: none !important; }
  .rc-sel-x { min-height: 26px; }
  .rc-dur, .rc-link-m, .rc-sub.problema { display: inline-flex; }
  .rc-ing-l { display: inline; margin-right: 4px; }
  .rc-mas { padding: 6px 0 12px; border: 0; }
  .rc-mas .adm-btn { width: 100%; min-height: 44px; border: 1px solid #e6e7e2; }
  .rc-vacio { background: #fff; border: 1px solid #e6e7e2; border-radius: 14px; }
}
`;
