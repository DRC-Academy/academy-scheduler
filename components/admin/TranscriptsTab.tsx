'use client';

// Pestaña admin "Transcripts": quién subió el transcript de cada clase, cuándo, y
// si llegó dentro del plazo de 24 h.
//
// El "Registro de clases" responde ¿entró el profesor? Esta responde ¿cerró la
// clase? Son las dos mitades de la misma pregunta —una clase se paga cuando tiene
// las dos— y por eso comparten origen de datos y función de estado:
//   · filas: lib/attendance.buildAttendanceRows (las mismas del Registro),
//   · estado: lib/transcriptDeadline.getTranscriptStatus, vía attachTranscriptStatus.
// No hay un criterio propio de esta pantalla. Si algún día cambia la regla de las
// 24 h, cambia en lib/transcriptDeadline y acá se entera sola.
//
// SOLO CLASES CON INGRESO. Una clase a la que el profesor no entró no existe para
// el sistema: no se paga y no se le puede reclamar un transcript. Listarlas acá
// sería ruido, así que el Registro de clases las muestra con su "—" y esta
// pestaña no las trae.
//
// EGRESS: el listado NUNCA trae el texto de una transcripción. `classAnalyses`
// llega con `has_transcript` (booleano) y `analyzed_at`, nada más. El texto se
// pide de a uno, por id, solo cuando el admin abre una fila
// (dbGetTranscriptForReview). Ver el comentario de dbGetClassTranscripts: traer el
// texto en los listados era la mayor fuente de egress del proyecto.

import { useEffect, useMemo, useState } from 'react';
import { FileText, Search, X } from 'lucide-react';
import { useTeachers } from '@/lib/TeachersContext';
import { getSpainParts } from '@/lib/spainTime';
import { buildAttendanceRows, attachTranscriptStatus, type LogRow } from '@/lib/attendance';
import { periodIndex, dbGetStudentDropouts, type StudentDropout } from '@/lib/studentPeriod';
import { gridOccupancyOfTeacher, applyGridSlots } from '@/lib/teacherClasses';
import { transcriptCell, uploadDelayLabel, uploadedAtLabel } from '@/lib/transcriptDeadline';
import { dbGetTranscriptForReview, type TranscriptForReview } from '@/lib/db';

/** Estado del transcript, con el matiz validado / en revisión que el admin necesita. */
type Estado = 'all' | 'validado' | 'revision' | 'pendiente' | 'vencido' | 'no_aplica';
/** ¿La subida entró en el plazo? Las clases sin plazo (anteriores al 22/09) no se juzgan. */
type Plazo = 'all' | 'dentro' | 'fuera';

const ESTADOS: Array<{ id: Estado; label: string }> = [
  { id: 'all',       label: 'Todos' },
  { id: 'validado',  label: 'Subido y validado' },
  { id: 'revision',  label: 'Subido, en revisión' },
  { id: 'pendiente', label: 'Pendiente' },
  { id: 'vencido',   label: 'Vencido' },
  { id: 'no_aplica', label: 'No aplica (falta sin aviso)' },
];

const PLAZOS: Array<{ id: Plazo; label: string }> = [
  { id: 'all',    label: 'Todos' },
  { id: 'dentro', label: 'Dentro de 24 h' },
  { id: 'fuera',  label: 'Fuera de 24 h' },
];

/** Cuántas filas se pintan de entrada y cuántas suma cada "Mostrar más". */
const PAGINA = 50;

function estadoDe(r: LogRow): Estado {
  const t = r.transcript;
  if (!t) return 'no_aplica';
  switch (t.status) {
    case 'subido':    return t.transcriptState === 'review' ? 'revision' : 'validado';
    case 'pendiente': return 'pendiente';
    case 'vencido':   return 'vencido';
    default:          return 'no_aplica';
  }
}

function pasaEstado(r: LogRow, f: Estado): boolean {
  return f === 'all' || estadoDe(r) === f;
}

/** Una clase sin plazo (anterior al 22/09) no está ni dentro ni fuera: se cae de los dos filtros. */
function pasaPlazo(r: LogRow, f: Plazo): boolean {
  if (f === 'all') return true;
  const dentro = r.transcript?.uploadedWithinDeadline;
  return f === 'dentro' ? dentro === true : dentro === false;
}

/** "mar 22/09" — la fecha de la clase, corta. */
function fechaCorta(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return iso;
  const s = d.toLocaleDateString('es-ES', { weekday: 'short', day: '2-digit', month: '2-digit' }).replace('.', '').replace(',', '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ═════════════════════════════════════════════════════════════════════════════
export default function TranscriptsTab() {
  const { teachers, assignments, classJoinLogs, classRecords, classAnalyses, loadClassJoinLogs } = useTeachers();

  // Todo se mide en hora de España, incluido el corte de mes: el mes del admin
  // (esté donde esté) no decide qué clases entran en "este mes".
  const nowSpain = getSpainParts(new Date());
  const todayIso = nowSpain.dateStr;
  const nowMinutes = nowSpain.hour * 60 + nowSpain.minute;
  const inicioDeMes = `${todayIso.slice(0, 7)}-01`;

  const [fromDate, setFromDate] = useState(inicioDeMes);
  const [toDate, setToDate] = useState(todayIso);
  const [teacherFilter, setTeacherFilter] = useState('');
  const [estado, setEstado] = useState<Estado>('all');
  const [plazo, setPlazo] = useState<Plazo>('all');
  const [query, setQuery] = useState('');
  const [limite, setLimite] = useState(PAGINA);
  const [abierta, setAbierta] = useState<LogRow | null>(null);
  // El reloj que decide si un plazo venció se fija al montar: sin cuenta
  // regresiva viva, la pantalla se recarga al navegar.
  const [nowMs] = useState(() => Date.now());

  useEffect(() => {
    loadClassJoinLogs();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const occupancyByTeacher = useMemo(
    () => Object.fromEntries(teachers.map(t => [t.id, gridOccupancyOfTeacher(t)])),
    [teachers],
  );

  const [dropouts, setDropouts] = useState<StudentDropout[]>([]);
  useEffect(() => { dbGetStudentDropouts().then(setDropouts).catch(() => {}); }, []);
  const periodsByTeacher = useMemo(
    () => Object.fromEntries(teachers.map(t => [t.id, periodIndex(assignments, dropouts, t.id)])),
    [teachers, assignments, dropouts],
  );

  // Las clases del rango, con su estado de transcript. Una sesión de 2 h es UNA
  // fila (buildAttendanceRows encadena las horas contiguas del calendario) y
  // lleva UN transcript, así que aparece una sola vez.
  const rows = useMemo<LogRow[]>(() => {
    const filas = buildAttendanceRows({
      assignments: applyGridSlots(assignments, occupancyByTeacher),
      joinLogs: classJoinLogs,
      teacherId: teacherFilter || undefined,
      fromDate, toDate, todayIso, nowMinutes,
      includeFuture: false,
      gridOccupancyByTeacher: occupancyByTeacher,
      periodsByTeacher,
    });
    return attachTranscriptStatus(filas, {
      joinLogs: classJoinLogs, analyses: classAnalyses, classRecords, now: nowMs,
    })
      // Sin ingreso no hay clase que cerrar (ver la cabecera del archivo).
      .filter(r => !!r.joinedAt)
      .sort((x, y) => y.date.localeCompare(x.date) || (parseInt(y.hour) - parseInt(x.hour)));
  }, [assignments, classJoinLogs, classAnalyses, classRecords, nowMs, teacherFilter,
      fromDate, toDate, todayIso, nowMinutes, occupancyByTeacher, periodsByTeacher]);

  // ── Cifras ────────────────────────────────────────────────────────────────
  // Responden al PERÍODO, al profesor y al alumno buscado, no al filtro de
  // estado: si respondieran también a ese, pedir "solo vencidos" dejaría las
  // otras cinco cifras en cero y no habría con qué comparar.
  const q = query.trim().toLowerCase();
  const enAlcance = useMemo(
    () => rows.filter(r => !q || r.studentName.toLowerCase().includes(q) || r.teacherName.toLowerCase().includes(q)),
    [rows, q],
  );
  const cifras = useMemo(() => {
    let validados = 0, revision = 0, pendientes = 0, vencidos = 0, dentro = 0, juzgables = 0;
    for (const r of enAlcance) {
      switch (estadoDe(r)) {
        case 'validado':  validados++; break;
        case 'revision':  revision++; break;
        case 'pendiente': pendientes++; break;
        case 'vencido':   vencidos++; break;
        default: break;   // 'no_aplica': la falta sin aviso no entra en ninguna cifra
      }
      // El porcentaje se mide SOLO sobre las subidas que tienen plazo: las clases
      // anteriores al 22/09 no llegaron ni a tiempo ni tarde, no existía el plazo.
      const d = r.transcript?.uploadedWithinDeadline;
      if (d != null) { juzgables++; if (d) dentro++; }
    }
    return {
      total: enAlcance.length, validados, revision, pendientes, vencidos, dentro, juzgables,
      pct: juzgables > 0 ? Math.round((dentro / juzgables) * 100) : null,
    };
  }, [enAlcance]);

  const visibles = enAlcance.filter(r => pasaEstado(r, estado) && pasaPlazo(r, plazo));
  const mostradas = visibles.slice(0, limite);

  const cambiar = <T,>(setter: (v: T) => void) => (v: T) => { setter(v); setLimite(PAGINA); };

  return (
    <div className="tx">
      {/* ── Cabecera ── */}
      <div className="tx-head">
        <div className="tx-titulo">
          <h2 className="tx-title">Transcripts</h2>
          <p className="tx-sub">
            Clases a las que el profesor entró y en qué quedó su transcript. Todas las horas, en hora de España.
          </p>
        </div>
        <div className="tx-ctl">
          <div className="tx-fechas">
            <input type="date" value={fromDate} max={toDate} onChange={e => cambiar(setFromDate)(e.target.value)} aria-label="Desde" />
            <span>→</span>
            <input type="date" value={toDate} min={fromDate} max={todayIso} onChange={e => cambiar(setToDate)(e.target.value)} aria-label="Hasta" />
          </div>
          <label className="tx-sel">
            <span className="tx-sel-l">Profesor</span>
            <select value={teacherFilter} onChange={e => cambiar(setTeacherFilter)(e.target.value)}>
              <option value="">Todos</option>
              {teachers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            {teacherFilter && (
              <button type="button" className="tx-sel-x" onClick={() => cambiar(setTeacherFilter)('')} aria-label="Quitar el profesor"><X size={14} strokeWidth={2.5} /></button>
            )}
          </label>
          <label className="tx-sel">
            <span className="tx-sel-l">Estado</span>
            <select value={estado} onChange={e => cambiar(setEstado)(e.target.value as Estado)}>
              {ESTADOS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </label>
          <label className="tx-sel">
            <span className="tx-sel-l">Plazo</span>
            <select value={plazo} onChange={e => cambiar(setPlazo)(e.target.value as Plazo)}>
              {PLAZOS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </label>
          <label className="tx-search">
            <Search size={17} strokeWidth={2} aria-hidden />
            <input value={query} onChange={e => cambiar(setQuery)(e.target.value)} placeholder="Buscar alumno o profesor…" aria-label="Buscar" />
          </label>
        </div>
      </div>

      {/* ── Cifras del período ── */}
      <div className="tx-kpis">
        <Kpi label="Clases" value={cifras.total} sub="con ingreso" />
        <Kpi label="Validados" value={cifras.validados} color="#1E9E3A" />
        <Kpi label="En revisión" value={cifras.revision} color={cifras.revision > 0 ? '#2563eb' : undefined} />
        <Kpi
          label="Dentro de 24 h"
          value={cifras.pct == null ? '—' : `${cifras.pct} %`}
          color={cifras.pct == null ? undefined : cifras.pct >= 80 ? '#1E9E3A' : cifras.pct >= 60 ? '#b45309' : '#dc2626'}
          // "con plazo", no "subidos": las clases anteriores al 22/09 están
          // subidas pero no tienen plazo, así que no entran en el porcentaje.
          sub={cifras.pct == null ? 'sin clases con plazo' : `${cifras.dentro} de ${cifras.juzgables} con plazo`}
        />
        <Kpi label="Pendientes" value={cifras.pendientes} color={cifras.pendientes > 0 ? '#8a6d00' : '#1E9E3A'} />
        <Kpi label="Vencidos" value={cifras.vencidos} color={cifras.vencidos > 0 ? '#dc2626' : '#1E9E3A'} />
      </div>

      {/* ── Lista ── */}
      <div className="adm-card tx-lista">
        {rows.length === 0 ? (
          <div className="tx-vacio"><div className="tx-vacio-s">Sin clases con ingreso en este período.</div></div>
        ) : visibles.length === 0 ? (
          <div className="tx-vacio"><div className="tx-vacio-s">Sin clases para estos filtros.</div></div>
        ) : (
          <>
            <div className="tx-row head" aria-hidden>
              <span>Clase</span><span>Alumno</span><span>Profesor</span><span>Estado</span>
              <span>Subido el</span><span>Demora</span><span>En 24 h</span>
            </div>
            {mostradas.map(r => <Fila key={r.id} r={r} onAbrir={() => setAbierta(r)} />)}
            {visibles.length > mostradas.length && (
              <div className="tx-mas">
                <button type="button" className="adm-btn adm-btn-ghost" onClick={() => setLimite(l => l + PAGINA)}>
                  Mostrar {Math.min(PAGINA, visibles.length - mostradas.length)} más · quedan {visibles.length - mostradas.length}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {abierta && <TranscriptModal r={abierta} onClose={() => setAbierta(null)} />}
      <style>{ESTILOS}</style>
    </div>
  );
}

function Kpi({ label, value, color, sub }: { label: string; value: string | number; color?: string; sub?: string }) {
  return (
    <div className="adm-card tx-kpi">
      <div className="tx-kpi-v" style={{ color }}>{value}</div>
      <div className="tx-kpi-l">{label}</div>
      {sub && <div className="tx-kpi-s">{sub}</div>}
    </div>
  );
}

// ── Una fila (escritorio) / una tarjeta (teléfono) ───────────────────────────
function Fila({ r, onAbrir }: { r: LogRow; onAbrir: () => void }) {
  const t = r.transcript;
  const cell = transcriptCell(t);
  const demora = uploadDelayLabel(t?.endsAt ?? null, t?.uploadedAt);
  const dentro = t?.uploadedWithinDeadline;
  // Solo se puede leer lo que existe: sin análisis no hay texto que pedir.
  const legible = !!t?.analysisId;

  const contenido = (
    <>
      <span className="tx-clase">
        <span className="tx-fecha">{fechaCorta(r.date)}</span>
        <span className="tx-hora">{r.hoursLabel || r.hour}{r.durationHours > 1 && <span className="tx-2h">{r.durationHours}h</span>}</span>
      </span>
      <span className="tx-nom">{r.studentName}</span>
      <span className="tx-prof">{r.teacherName}</span>
      <span className="tx-est" title={cell.title}>
        <span className="tx-est-p" style={{ color: cell.color, background: cell.bg }}>
          <span aria-hidden>{cell.icon}</span> {cell.label}
        </span>
      </span>
      <span className="tx-sub-el">
        <span className="tx-lbl">Subido</span>
        {t?.uploadedAt ? uploadedAtLabel(t.uploadedAt) : <span className="tx-guion">—</span>}
      </span>
      <span className="tx-dem">
        <span className="tx-lbl">Demora</span>
        {demora || <span className="tx-guion">—</span>}
      </span>
      <span className="tx-24">
        <span className="tx-lbl">En 24 h</span>
        {dentro == null
          // Clase anterior al 22/09 (sin plazo) o sin subida: no se juzga.
          ? <span className="tx-guion" title="Esta clase no tiene plazo de 24 h (es anterior al 22/09/2026) o todavía no tiene transcript">—</span>
          : <span style={{ color: dentro ? '#1E9E3A' : '#dc2626', fontWeight: 700 }}>{dentro ? '✓' : '✗'}</span>}
      </span>
      {legible && <FileText size={15} strokeWidth={2} aria-hidden className="tx-leer" />}
    </>
  );

  return legible
    ? <button type="button" className="tx-row is-click" onClick={onAbrir} title="Leer el transcript de esta clase">{contenido}</button>
    : <div className="tx-row">{contenido}</div>;
}

// ── Modal: el TEXTO, pedido en el momento ────────────────────────────────────
//
// Una fila, una llamada, solo al abrir. El listado nunca lo trajo.
function TranscriptModal({ r, onClose }: { r: LogRow; onClose: () => void }) {
  const [data, setData] = useState<TranscriptForReview | null>(null);
  const [fallo, setFallo] = useState(false);
  const t = r.transcript;
  // La fila solo es pulsable si hay análisis, así que esto no debería pasar; si
  // pasara, se muestra el error sin pedir nada (derivado, no un setState en el
  // efecto: eso encadena renders).
  const analysisId = t?.analysisId ?? null;
  const error = fallo || !analysisId;

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [onClose]);

  useEffect(() => {
    if (!analysisId) return;
    let vivo = true;
    dbGetTranscriptForReview(analysisId)
      .then(d => { if (vivo) setData(d); })
      .catch(() => { if (vivo) setFallo(true); });
    return () => { vivo = false; };
  }, [analysisId]);

  const cell = transcriptCell(t);
  const demora = uploadDelayLabel(t?.endsAt ?? null, t?.uploadedAt);

  return (
    <div className="tx-scrim" onClick={onClose} role="presentation">
      <div className="tx-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`Transcript de ${r.studentName}`}>
        <div className="tx-modal-h">
          <div>
            <h3 className="tx-modal-t">{r.studentName}</h3>
            <p className="tx-modal-s">
              {fechaCorta(r.date)} · {r.hoursLabel || r.hour} · {r.teacherName}
            </p>
          </div>
          <button type="button" className="tx-modal-x" onClick={onClose} aria-label="Cerrar"><X size={20} strokeWidth={2} /></button>
        </div>

        <div className="tx-modal-meta">
          <span className="tx-est-p" style={{ color: cell.color, background: cell.bg }}>
            <span aria-hidden>{cell.icon}</span> {cell.label}
          </span>
          {t?.uploadedAt && <span>Subido el <b>{uploadedAtLabel(t.uploadedAt)}</b> (hora de España)</span>}
          {demora && <span>Demora: <b>{demora}</b></span>}
          {t?.uploadedWithinDeadline != null && (
            <span style={{ color: t.uploadedWithinDeadline ? '#1E9E3A' : '#dc2626', fontWeight: 600 }}>
              {t.uploadedWithinDeadline ? 'Dentro de las 24 h' : 'Fuera de las 24 h'}
            </span>
          )}
        </div>

        {error ? (
          <p className="tx-modal-err">No se pudo leer el transcript de esta clase.</p>
        ) : data == null ? (
          <p className="tx-modal-cargando">Cargando el transcript…</p>
        ) : (
          <>
            {data.flags.length > 0 && (
              <p className="tx-modal-flags">
                Validación: {data.validationStatus ?? 'sin estado'}
                {data.score != null && ` · ${data.score}/100`} · {data.flags.join(' · ')}
              </p>
            )}
            <pre className="tx-texto">{data.transcript || 'La fila existe pero no tiene texto guardado.'}</pre>
          </>
        )}
      </div>
    </div>
  );
}

// ── Estilos ──────────────────────────────────────────────────────────────────
const ESTILOS = `
.tx { font-family: var(--font-app); color: #1a1c1a; }
.tx-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 14px; flex-wrap: wrap; margin-bottom: 14px; }
.tx-title { font-size: 18px; font-weight: 700; letter-spacing: -0.01em; margin: 0; }
.tx-sub { font-size: 13px; color: var(--text-muted); margin: 3px 0 0; max-width: 460px; }
.tx-ctl { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.tx-fechas { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-muted); }
.tx-fechas input { height: 38px; padding: 0 10px; border-radius: 10px; border: 1px solid #e6e7e2; background: #fff; font-family: inherit; font-size: 13px; color: var(--text-primary); }
.tx-sel { position: relative; display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 10px 0 12px; border: 1px solid #e6e7e2; border-radius: 10px; background: #fff; min-width: 170px; }
.tx-sel-l { font-size: 13px; font-weight: 600; color: var(--text-muted); white-space: nowrap; }
.tx-sel select { flex: 1; min-width: 0; height: 100%; border: 0; background: transparent; font-family: inherit; font-size: 13.5px; font-weight: 600; color: var(--text-primary); padding: 0; cursor: pointer; }
.tx-sel select:focus { outline: none; }
.tx-sel-x { width: 26px; height: 26px; border-radius: 999px; border: 0; background: #eef6ef; color: #15803d; display: grid; place-items: center; cursor: pointer; padding: 0; flex-shrink: 0; }
.tx-search { position: relative; display: block; width: 240px; }
.tx-search input { width: 100%; height: 38px; padding: 0 12px 0 34px; border-radius: 10px; border: 1px solid #e6e7e2; background: #fff; font-size: 13.5px; font-family: inherit; color: var(--text-primary); box-sizing: border-box; }
.tx-search svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--text-muted); pointer-events: none; }

.tx-kpis { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
.tx-kpi { padding: 14px 16px; }
.tx-kpi-v { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.15; }
.tx-kpi-l { font-size: 12.5px; font-weight: 600; color: var(--text-secondary); margin-top: 4px; }
.tx-kpi-s { font-size: 12px; color: #a4a7a1; margin-top: 2px; }

.tx-lista { overflow: clip; }
.tx-row { display: grid; grid-template-columns: 150px minmax(0, 1fr) 130px 168px 108px 96px 64px 20px; align-items: center; gap: 12px; width: 100%; box-sizing: border-box; min-height: 48px; padding: 6px 16px; border-top: 1px solid #ECECE8; font-size: 13.5px; text-align: left; background: transparent; border-left: 0; border-right: 0; border-bottom: 0; font-family: inherit; color: inherit; }
.tx-row.head { min-height: 36px; font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: #6E6E66; background: #FAFAF8; border-top: 0; }
.tx-row.is-click { cursor: pointer; }
.tx-row.is-click:hover { background: #F5F7F4; }
.tx-clase { display: flex; flex-direction: column; gap: 1px; white-space: nowrap; }
.tx-fecha { font-weight: 700; color: #157347; }
.tx-hora { font-size: 12.5px; color: #6E6E66; }
.tx-2h { font-size: 10.5px; font-weight: 700; padding: 1px 6px; border-radius: 999px; background: rgba(30,158,58,0.12); color: #1E9E3A; margin-left: 4px; }
.tx-nom { font-weight: 600; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tx-prof { color: #167A2D; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tx-est-p { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 10px; border-radius: 999px; font-size: 12px; font-weight: 700; white-space: nowrap; }
.tx-sub-el, .tx-dem, .tx-24 { color: var(--text-secondary); white-space: nowrap; }
.tx-guion { color: #a4a7a1; }
.tx-lbl { display: none; }
.tx-leer { color: #a4a7a1; flex-shrink: 0; }
.tx-row.is-click:hover .tx-leer { color: #2563eb; }
.tx-mas { display: flex; justify-content: center; padding: 12px; border-top: 1px solid #ECECE8; }
.tx-vacio { padding: 40px 16px; text-align: center; }
.tx-vacio-s { font-size: 14px; color: #6E6E66; }

/* ── Modal ── */
.tx-scrim { position: fixed; inset: 0; background: rgba(16,24,16,0.45); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 16px; }
.tx-modal { background: #fff; border-radius: 16px; width: min(760px, 100%); max-height: min(86vh, 900px); display: flex; flex-direction: column; box-shadow: 0 20px 60px rgba(16,24,16,0.25); font-family: var(--font-app); }
.tx-modal-h { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 18px 20px 10px; }
.tx-modal-t { font-size: 17px; font-weight: 700; margin: 0; }
.tx-modal-s { font-size: 13px; color: var(--text-muted); margin: 3px 0 0; }
.tx-modal-x { width: 34px; height: 34px; border-radius: 999px; border: 0; background: #f4f5f2; color: #4A4A4A; display: grid; place-items: center; cursor: pointer; flex-shrink: 0; padding: 0; }
.tx-modal-meta { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 0 20px 12px; font-size: 13px; color: var(--text-secondary); border-bottom: 1px solid #ECECE8; }
.tx-modal-flags { margin: 12px 20px 0; padding: 8px 12px; border-radius: 10px; background: #FFF4BF; color: #8a6d00; font-size: 12.5px; }
.tx-modal-cargando, .tx-modal-err { padding: 28px 20px; text-align: center; font-size: 14px; color: #6E6E66; }
.tx-modal-err { color: #dc2626; }
.tx-texto { flex: 1; overflow: auto; margin: 0; padding: 16px 20px 20px; white-space: pre-wrap; word-break: break-word; font-family: var(--font-app); font-size: 13.5px; line-height: 1.6; color: #1a1c1a; }

@media (max-width: 1100px) {
  .tx-row { grid-template-columns: 130px minmax(0, 1fr) 110px 150px 96px 88px 56px 20px; gap: 10px; }
  .tx-kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}

/* Teléfono: el título lo pone la barra de Admin; la fila se vuelve tarjeta. */
@media (max-width: 767px) {
  .tx-titulo { display: none; }
  .tx-ctl { width: 100%; flex-direction: column; align-items: stretch; gap: 10px; }
  .tx-fechas { justify-content: space-between; }
  .tx-fechas input { flex: 1; min-width: 0; height: 44px; }
  .tx-sel { height: 44px; min-width: 0; }
  .tx-sel select { font-size: 14px; }
  .tx-search { width: 100%; }
  .tx-search input { height: 44px; }
  .tx-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px; }
  .tx-kpi { padding: 12px 14px; }
  .tx-kpi-v { font-size: 22px; }
  .tx-kpi-l { font-weight: 500; color: #6E6E66; }
  .tx-lista { background: transparent; border: 0; box-shadow: none; overflow: visible; }
  .tx-row.head { display: none; }
  .tx-row { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "clase est" "nom est" "prof prof" "subido demora" "v24 v24"; gap: 4px 10px; min-height: 0; padding: 12px 14px; background: #fff; border: 1px solid #e6e7e2; border-radius: 14px; box-shadow: 0 1px 2px rgba(16,24,16,0.04); margin-bottom: 8px; }
  .tx-clase { grid-area: clase; flex-direction: row; align-items: baseline; gap: 8px; }
  .tx-nom { grid-area: nom; font-size: 14.5px; }
  .tx-prof { grid-area: prof; font-size: 13px; }
  .tx-est { grid-area: est; align-self: start; }
  .tx-sub-el { grid-area: subido; }
  .tx-dem { grid-area: demora; }
  .tx-24 { grid-area: v24; }
  .tx-sub-el, .tx-dem, .tx-24 { font-size: 12.5px; }
  .tx-lbl { display: inline; color: #a4a7a1; margin-right: 4px; }
  .tx-leer { display: none; }
  .tx-mas { padding: 6px 0 12px; border: 0; }
  .tx-mas .adm-btn { width: 100%; min-height: 44px; border: 1px solid #e6e7e2; }
  .tx-vacio { background: #fff; border: 1px solid #e6e7e2; border-radius: 14px; }
  /* El global "button { min-height: 44px }" no debe estirar la tarjeta-fila. */
  .tx-row.is-click { min-height: 0; }
  .tx-modal { max-height: 92vh; width: 100%; }
  .tx-scrim { padding: 8px; align-items: flex-end; }
}
`;
