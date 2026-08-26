'use client';
import { useState, useCallback, useEffect } from 'react';
import { Grid, Cell, CellState } from '@/types';
import { Button } from '@/components/ui';
import { isPuntualState, baseCellOf, baseStudentOf, isAssignableCell } from '@/lib/cells';
import { getSpainParts } from '@/lib/spainTime';
import { hourNum, nkName, sessionRangeLabel } from '@/lib/sessions';

export const DAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

// ── Rango de horas del calendario ────────────────────────────────────────────
// El profesor puede ampliarlo hacia atrás o hacia adelante desde su calendario
// (botones "+ Añadir horario más temprano / más tarde"); su preferencia se guarda
// en teachers.calendar_start_hour / calendar_end_hour. Estos son los topes duros
// de la app: fuera de ellos no se puede ampliar.
export const CAL_MIN_HOUR = 6;
export const CAL_MAX_HOUR = 23;
export const CAL_DEFAULT_START = 9;
export const CAL_DEFAULT_END = 22;

export const hourLabel = (h: number): string => `${h.toString().padStart(2, '0')}:00`;

/** Lista de horas 'HH:00' de `start` a `end`, ambas incluidas. */
export function hourRange(start: number, end: number): string[] {
  const from = clampHour(start), to = Math.max(clampHour(end), clampHour(start));
  return Array.from({ length: to - from + 1 }, (_, i) => hourLabel(from + i));
}

export const clampHour = (h: number): number =>
  Math.min(CAL_MAX_HOUR, Math.max(CAL_MIN_HOUR, Math.round(Number.isFinite(h) ? h : CAL_DEFAULT_START)));

// TODAS las horas seleccionables de la app (06:00–23:00). La usan los buscadores
// del setter: si un profesor abre las 08:00, esa hora tiene que poder filtrarse.
export const HOURS_ES = hourRange(CAL_MIN_HOUR, CAL_MAX_HOUR);

const MONTH_NAMES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const MONTH_NAMES_SHORT = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

export function toAR(hourES: string): string {
  const h = parseInt(hourES);
  let ar = h - 5;
  if (ar < 0) ar += 24;
  return `${ar.toString().padStart(2, '0')}:00`;
}

function toISODateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

export function cellKey(day: string, hour: string) {
  return `${day}_${hour}`;
}

// La conversión de zona horaria vive en lib/spainTime.ts (lib no puede depender de
// components). Se re-exporta acá porque media app importa getSpainParts de este
// módulo desde antes de que existiera el lib.
export { getSpainParts, spainWallClockToEpoch } from '@/lib/spainTime';

export type { Grid, Cell, CellState };

// Fuente ÚNICA del color de los 4 estados del calendario. La leyenda, los
// contadores, el menú de celda y los stats del profe salen de acá
// (CAL_STATE_META) y no se repintan a mano: antes había CINCO fuentes que se
// contradecían — la leyenda decía que Ocupado era azul, la grilla lo pintaba
// rojo y el menú de celda, verde.
//
// Los colores viven en los tokens --cal-* de globals.css.
export function stateColor(state: CellState) {
  switch (state) {
    case 'libre':     return { bg: 'var(--cal-free-bg)',      border: 'var(--cal-free-border)',     text: 'var(--cal-free-text)' };
    case 'ocupado':   return { bg: 'var(--cal-busy-bg)',      border: 'var(--cal-busy-border)',     text: 'var(--cal-busy-text)' };
    case 'bloqueado': return { bg: 'var(--cal-recovery-bg)',  border: 'var(--cal-recovery-border)', text: 'var(--cal-recovery-text)' };
    case 'no_work':   return { bg: 'var(--cal-nowork-bg)',    border: 'var(--cal-nowork-border)',   text: 'var(--cal-nowork-text)' };
    case 'reprogramada': return { bg: 'var(--cal-resched-bg)', border: 'var(--cal-resched-border)', text: 'var(--cal-resched-text)' };
  }
}

// Metadatos de cada estado para leyendas y contadores. `dotColor` es el color del
// punto; `outline` marca la categoría vacía (No work), que se dibuja sin relleno.
export const CAL_STATE_META: Record<CellState, { label: string; desc: string; dotColor: string; outline?: boolean }> = {
  libre:     { label: 'Libre',           desc: 'Disponible para clases',        dotColor: 'var(--cal-free-dot)' },
  ocupado:   { label: 'Ocupado',         desc: 'Clase con alumno',              dotColor: 'var(--cal-busy-dot)' },
  bloqueado: { label: 'En recuperación', desc: 'Clase de recuperación o ajuste', dotColor: 'var(--cal-recovery-dot)' },
  no_work:   { label: 'No work',         desc: 'No trabajás ese horario',       dotColor: 'var(--cal-nowork-dot)' },
  reprogramada: { label: 'Reprogramada', desc: 'Clase movida a otra fecha',     dotColor: 'var(--cal-resched-dot)' },
};

export function buildGridFromTeacher(
  timeSlots: Array<{ day: string; from: string; to: string }>,
  upcomingClasses: Array<{ day: string; time: string; studentName: string }>,
): Grid {
  const grid: Grid = {};
  for (const slot of timeSlots) {
    const fromH = parseInt(slot.from);
    const toH = parseInt(slot.to);
    for (let h = fromH; h < toH; h++) {
      const hour = `${h.toString().padStart(2, '0')}:00`;
      grid[cellKey(slot.day, hour)] = { state: 'libre' };
    }
  }
  for (const cls of upcomingClasses) {
    grid[cellKey(cls.day, cls.time)] = { state: 'ocupado', student: cls.studentName };
  }
  return grid;
}

// ── Week date helpers ─────────────────────────────────────────────────────────

export function getWeekDates(offset: number = 0): Date[] {
  const today = new Date();
  const dow = today.getDay();
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(today);
  monday.setDate(today.getDate() + diffToMonday + offset * 7);
  return Array.from({ length: 6 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

export function formatWeekRange(dates: Date[]): string {
  const first = dates[0];
  const last  = dates[dates.length - 1];
  if (first.getMonth() === last.getMonth()) {
    return `Semana del ${first.getDate()} al ${last.getDate()} de ${MONTH_NAMES[first.getMonth()].charAt(0).toUpperCase() + MONTH_NAMES[first.getMonth()].slice(1)} ${first.getFullYear()}`;
  }
  return `${first.getDate()} ${MONTH_NAMES_SHORT[first.getMonth()]} — ${last.getDate()} ${MONTH_NAMES_SHORT[last.getMonth()]} ${last.getFullYear()}`;
}

// ── MODES ────────────────────────────────────────────────────────────────────

type Mode = 'teacher' | 'setter' | 'readonly';

interface BaseProps {
  grid: Grid;
  mode: Mode;
  highlightSlots?: Array<{ day: string; hour: string }>;
  weekOffset?: number;
  onWeekChange?: (offset: number) => void;
  /** Rango de horas preferido del profesor (teachers.calendar_*_hour). */
  startHour?: number;
  endHour?: number;
  /**
   * Alumnos SIN suscripción activa (nombres normalizados), resueltos en vivo
   * contra WooCommerce por el consumidor.
   *
   * Se MARCAN, nunca se filtran: que una suscripción venza no significa que el
   * alumno dejó de venir —renovaciones tardías, pending-cancel, planes
   * extendidos— y esconder su clase le borraría al profesor una clase real y
   * cobrable. El aviso está para que se vea y alguien pregunte.
   */
  inactiveStudents?: Set<string>;
}

export interface RecuperacionData { student: string; recoveryFor: string; note?: string }

interface TeacherProps extends BaseProps {
  mode: 'teacher';
  onGridChange: (grid: Grid) => void;
  /** Si se provee, aparecen los botones para ampliar el rango de horas. */
  onRangeChange?: (startHour: number, endHour: number) => void;
  onOcupadoNeed?: (day: string, hour: string, resolve: (name: string) => void, cancel: () => void) => void;
  // "En recuperación" (bloqueado): si se provee, el consumidor abre un mini modal
  // para elegir el alumno + fecha original; si no, se aplica sin datos (setter).
  onRecuperacionNeed?: (day: string, hour: string, resolve: (data: RecuperacionData) => void, cancel: () => void) => void;
}

interface SetterProps extends BaseProps {
  mode: 'setter';
  onCellClick: (day: string, hour: string) => void;
}

interface ReadonlyProps extends BaseProps {
  mode: 'readonly';
}

type Props = TeacherProps | SetterProps | ReadonlyProps;

// Small modal to enter student name when teacher marks a cell as "ocupado"
function StudentNameModal({ onConfirm, onCancel }: { onConfirm: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid #35405a', borderRadius: 14, padding: 24, width: '100%', maxWidth: 360 }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 14 }}>¿Quién ocupa este horario?</div>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Nombre del alumno..."
          autoFocus
          onKeyDown={e => { if (e.key === 'Enter' && name.trim()) onConfirm(name.trim()); }}
        />
        <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
          <Button variant="secondary" onClick={onCancel} style={{ flex: 1 }}>Cancelar</Button>
          <Button variant="primary" onClick={() => name.trim() && onConfirm(name.trim())} disabled={!name.trim()} style={{ flex: 2 }}>
            Marcar como Ocupado
          </Button>
        </div>
      </div>
    </div>
  );
}

// Context menu for teacher clicking a cell
function CellMenu({
  day, hour, current, onSelect, onClose, onOcupadoNeed, onRecuperacionNeed,
}: {
  day: string; hour: string; current: CellState;
  onSelect: (state: CellState, student?: string, recovery?: { recoveryFor: string; note?: string }) => void;
  onClose: () => void;
  onOcupadoNeed?: (day: string, hour: string, resolve: (name: string) => void, cancel: () => void) => void;
  onRecuperacionNeed?: (day: string, hour: string, resolve: (data: RecuperacionData) => void, cancel: () => void) => void;
}) {
  const [askStudent, setAskStudent] = useState(false);

  if (askStudent) {
    return <StudentNameModal
      onConfirm={name => { onSelect('ocupado', name); onClose(); }}
      onCancel={() => { setAskStudent(false); onClose(); }}
    />;
  }

  const options: Array<{ state: CellState; sub?: string }> = [
    { state: 'libre' },
    { state: 'ocupado' },
    { state: 'bloqueado', sub: CAL_STATE_META.bloqueado.desc },
    { state: 'no_work' },
  ];

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 'var(--space-2)', minWidth: 210, boxShadow: 'var(--shadow-overlay)' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', color: 'var(--text-muted)', padding: '4px 10px 8px' }}>
          {day} · {hour} ES / {toAR(hour)} AR
        </div>
        {options.map(opt => (
          <button key={opt.state} onClick={() => {
            if (opt.state === 'ocupado') {
              if (onOcupadoNeed) {
                onClose();
                onOcupadoNeed(day, hour, name => { onSelect('ocupado', name); }, onClose);
              } else {
                setAskStudent(true);
              }
              return;
            }
            if (opt.state === 'bloqueado' && onRecuperacionNeed) {
              onClose();
              onRecuperacionNeed(day, hour, data => { onSelect('bloqueado', data.student, { recoveryFor: data.recoveryFor, note: data.note }); }, onClose);
              return;
            }
            onSelect(opt.state);
            onClose();
          }} style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-3)', width: '100%',
            padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: 'none', cursor: 'pointer',
            background: current === opt.state ? 'var(--bg-surface-2)' : 'transparent',
            color: 'var(--text-primary)',
            fontSize: 'var(--fs-sm)',
            fontWeight: current === opt.state ? 'var(--fw-semibold)' : 'var(--fw-regular)',
            textAlign: 'left', fontFamily: 'inherit',
          }}>
            {/* Punto del mismo color que va a tomar la celda. */}
            <span aria-hidden style={{
              display: 'inline-block', flexShrink: 0, width: 9, height: 9, borderRadius: '50%',
              background: CAL_STATE_META[opt.state].outline ? 'transparent' : CAL_STATE_META[opt.state].dotColor,
              border: CAL_STATE_META[opt.state].outline ? '1.5px solid var(--border-light)' : 'none',
            }} />
            <div>
              <div>{CAL_STATE_META[opt.state].label}</div>
              {opt.sub && <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--text-muted)', fontWeight: 'var(--fw-regular)' }}>{opt.sub}</div>}
            </div>
            {current === opt.state && <span style={{ marginLeft: 'auto', fontSize: 'var(--fs-micro)', color: 'var(--text-muted)' }}>actual</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

// Rango compacto para el navegador: "20 – 25 Jul 2026". `formatWeekRange` (la
// versión larga) se sigue exportando tal cual porque la usa el setter.
function formatWeekRangeShort(dates: Date[]): string {
  const first = dates[0];
  const last  = dates[dates.length - 1];
  const m1 = MONTH_NAMES_SHORT[first.getMonth()];
  const m2 = MONTH_NAMES_SHORT[last.getMonth()];
  return first.getMonth() === last.getMonth()
    ? `${first.getDate()} – ${last.getDate()} ${m1} ${last.getFullYear()}`
    : `${first.getDate()} ${m1} – ${last.getDate()} ${m2} ${last.getFullYear()}`;
}

/**
 * Horas que se dibujan: el rango preferido del profesor MÁS cualquier hora fuera
 * de él que ya tenga una celda con contenido. Así el setter y el admin ven los
 * horarios ampliados sin necesidad de conocer la preferencia del profesor, y una
 * clase de las 08:00 nunca queda invisible por un rango mal guardado.
 */
export function visibleHours(grid: Grid, startHour: number, endHour: number): string[] {
  let from = clampHour(startHour);
  let to = Math.max(clampHour(endHour), from);
  for (const [key, cell] of Object.entries(grid)) {
    if (!cell || cell.state === 'no_work') continue;
    const h = parseInt(key.split('_')[1] ?? '', 10);
    if (!Number.isFinite(h) || h < CAL_MIN_HOUR || h > CAL_MAX_HOUR) continue;
    if (h < from) from = h;
    if (h > to) to = h;
  }
  return hourRange(from, to);
}

// Botón para ampliar el calendario. Se repite arriba y abajo de la columna de
// horas (y en las dos vistas, agenda móvil y grilla), por eso vive suelto.
function AddHourButton({ label, onClick, disabled, title }: {
  label: string; onClick: () => void; disabled: boolean; title: string;
}) {
  return (
    <button
      type="button"
      className="vc-addhour"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? 'Límite del calendario' : title}
    >
      + {label}
    </button>
  );
}

export function VisualCalendar(props: Props) {
  const [menu, setMenu] = useState<{ day: string; hour: string } | null>(null);
  const [internalOffset, setInternalOffset] = useState(props.weekOffset ?? 0);
  // Vista de móvil: agenda de un día o grilla semanal completa. Ambas se
  // renderizan siempre y se alternan por CSS (evita medir el viewport en JS y
  // el consiguiente desajuste de hidratación).
  const [mobileView, setMobileView] = useState<'day' | 'week'>('day');
  // null = todavía no eligió día → se muestra el de hoy si está en la semana.
  const [dayPicked, setDayPicked] = useState<number | null>(null);

  // Live "now" — set on mount (avoids SSR hydration mismatch) and refreshed every
  // minute so the current-time line and dimming recalculate without a page reload.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(id);
  }, []);

  const offset = props.weekOffset ?? internalOffset;
  const weekDates = getWeekDates(offset);
  const weekLabel = formatWeekRange(weekDates);

  // Spain-referenced "now" → which visible column is today, current hour/minute.
  const spain = now ? getSpainParts(now) : null;
  const todayColIndex = spain ? weekDates.findIndex(d => toISODateStr(d) === spain.dateStr) : -1;
  const currentHour   = spain ? spain.hour : -1;
  const currentMinute = spain ? spain.minute : 0;
  const nowLabel      = spain ? `${String(spain.hour).padStart(2, '0')}:${String(spain.minute).padStart(2, '0')}` : '';

  function handleOffsetChange(newOffset: number) {
    if (props.onWeekChange) {
      props.onWeekChange(newOffset);
    } else {
      setInternalOffset(newOffset);
    }
  }

  function getCell(day: string, hour: string): Cell {
    const cell = props.grid[cellKey(day, hour)] ?? { state: 'no_work' };
    // 'bloqueado' (recuperación) y 'reprogramada' son marcas puntuales de UNA semana:
    // en el resto de semanas la celda revierte a su estado base (normalmente el slot).
    if (isPuntualState(cell.state) && cell.weekDate) {
      const currentMonday = toISODateStr(weekDates[0]);
      if (cell.weekDate !== currentMonday) return baseCellOf(cell);
    }
    return cell;
  }

  function handleCellClick(day: string, hour: string) {
    const cell = getCell(day, hour);
    if (props.mode === 'teacher') {
      setMenu({ day, hour });
    } else if (props.mode === 'setter') {
      // Se puede asignar un alumno recurrente sobre una recuperación puntual: la
      // marca solo ocupa esa semana, el horario de fondo está libre.
      if (isAssignableCell(cell)) props.onCellClick(day, hour);
    }
  }

  function handleMenuSelect(day: string, hour: string, state: CellState, student?: string, recovery?: { recoveryFor: string; note?: string }) {
    if (props.mode !== 'teacher') return;
    const key = cellKey(day, hour);
    let newCell: Cell;
    if (state === 'bloqueado') {
      const prevCell = props.grid[key] ?? { state: 'no_work' };
      // El fondo que se recupera al salir de esta semana: nunca otra marca puntual.
      // `baseStudent` conserva al alumno recurrente, distinto del que recupera.
      const base = baseCellOf(prevCell);
      newCell = {
        state, student, weekDate: toISODateStr(weekDates[0]),
        baseState: base.state, baseStudent: base.student,
        recoveryFor: recovery?.recoveryFor, recoveryNote: recovery?.note,
      };
    } else {
      // libre / ocupado / no_work desde el menú reemplazan la celda entera: es la
      // vía manual para limpiar una recuperación vieja del calendario.
      newCell = { state, student };
    }
    props.onGridChange({ ...props.grid, [key]: newCell });
  }

  // ── Rango de horas visible + ampliación ───────────────────────────────────
  const rangeStart = clampHour(props.startHour ?? CAL_DEFAULT_START);
  const rangeEnd   = Math.max(clampHour(props.endHour ?? CAL_DEFAULT_END), rangeStart);
  const hours      = visibleHours(props.grid, rangeStart, rangeEnd);
  const firstHour  = parseInt(hours[0]);
  const lastHour   = parseInt(hours[hours.length - 1]);

  const canExtend = props.mode === 'teacher' && !!props.onRangeChange;
  const canEarlier = canExtend && firstHour > CAL_MIN_HOUR;
  const canLater   = canExtend && lastHour  < CAL_MAX_HOUR;

  /**
   * Amplía el calendario una hora. Las celdas nuevas nacen 'libre' (el profesor
   * amplió justamente para ofrecer ese horario) y se guardan en el grid como el
   * resto: puede pasarlas a "No work" con un clic si no las quiere ofrecer.
   */
  function extend(direction: 'earlier' | 'later') {
    if (props.mode !== 'teacher' || !props.onRangeChange) return;
    const newHour = direction === 'earlier' ? firstHour - 1 : lastHour + 1;
    if (newHour < CAL_MIN_HOUR || newHour > CAL_MAX_HOUR) return;

    const nextGrid: Grid = { ...props.grid };
    for (const day of DAYS) {
      const key = cellKey(day, hourLabel(newHour));
      if (!nextGrid[key]) nextGrid[key] = { state: 'libre' };
    }
    props.onGridChange(nextGrid);
    // Se guarda el rango REALMENTE visible (incluye las horas que ya tenían clase
    // fuera del rango guardado), para que no "encoja" al recargar.
    props.onRangeChange(
      direction === 'earlier' ? newHour : Math.min(rangeStart, firstHour),
      direction === 'later'   ? newHour : Math.max(rangeEnd, lastHour),
    );
  }

  const earlierBtn = canExtend ? (
    <AddHourButton
      label="Añadir horario más temprano"
      title={canEarlier ? `Añadir las ${hourLabel(firstHour - 1)}` : ''}
      disabled={!canEarlier}
      onClick={() => extend('earlier')}
    />
  ) : null;
  const laterBtn = canExtend ? (
    <AddHourButton
      label="Añadir horario más tarde"
      title={canLater ? `Añadir las ${hourLabel(lastHour + 1)}` : ''}
      disabled={!canLater}
      onClick={() => extend('later')}
    />
  ) : null;

  const cells = Object.values(props.grid);
  const libre    = cells.filter(c => c.state === 'libre').length;
  const ocupado  = cells.filter(c => c.state === 'ocupado').length;
  const bloqueado= cells.filter(c => c.state === 'bloqueado').length;
  const noWork   = cells.filter(c => c.state === 'no_work').length;

  const isHighlighted = (day: string, hour: string) =>
    props.highlightSlots?.some(s => s.day === day && s.hour === hour) ?? false;

  const highlightDays = props.highlightSlots?.map(s => s.day) ?? [];

  const activeDay = dayPicked ?? (todayColIndex >= 0 ? todayColIndex : 0);

  // ── Sesiones de varias horas ────────────────────────────────────────────────
  // Dos o más celdas contiguas del MISMO alumno son UNA clase de N horas (misma
  // regla que lib/sessions, que es la que usan la agenda y finanzas). Se calcula
  // sobre las celdas YA RESUELTAS de la semana a la vista (`getCell`), no sobre el
  // grid crudo: una recuperación puntual tapa el horario de fondo solo esa semana
  // y no debe fabricar ni romper una sesión en las demás.
  type RunInfo = { length: number; index: number; label: string };
  const sessionRuns = new Map<string, RunInfo>();
  for (const day of DAYS) {
    let run: string[] = [];
    const flush = () => {
      if (run.length >= 2) {
        const label = sessionRangeLabel(run[0], run.length);
        run.forEach((h, i) => sessionRuns.set(cellKey(day, h), { length: run.length, index: i, label }));
      }
      run = [];
    };
    for (const hour of hours) {
      const cell = getCell(day, hour);
      const student = cell.state === 'ocupado' ? nkName(cell.student) : '';
      const prev = run[run.length - 1];
      const chains = !!student && !!prev
        && nkName(getCell(day, prev).student) === student
        && hourNum(hour) === hourNum(prev) + 1;
      if (chains) {
        run.push(hour);
      } else {
        flush();
        if (student) run = [hour];
      }
    }
    flush();
  }
  const runFor = (day: string, hour: string): RunInfo | undefined => sessionRuns.get(cellKey(day, hour));

  /** Clases del bloque para que las celdas de una sesión se vean unidas. */
  function runClass(run: RunInfo | undefined): string {
    if (!run) return '';
    if (run.index === 0) return ' is-run is-run-start';
    if (run.index === run.length - 1) return ' is-run is-run-end';
    return ' is-run is-run-mid';
  }

  // Contenido visual de una celda, compartido por la grilla y la agenda móvil.
  /** ¿Este alumno figura sin suscripción activa? Solo marca, nunca oculta. */
  function sinSuscripcion(student?: string): boolean {
    return !!student && !!props.inactiveStudents?.has(nkName(student));
  }

  function blockContent(cell: Cell, run?: RunInfo) {
    if (cell.state === 'no_work') {
      return props.mode === 'teacher' ? <div className="vc-b-name">No work</div> : null;
    }
    if (cell.state === 'ocupado') {
      return (
        <>
          {/* Badge "2h"/"3h" en la esquina, solo en la primera celda de la sesión. */}
          {run && run.index === 0 && <span className="vc-hours-badge">{run.length}h</span>}
          <div className="vc-b-name">
            {cell.student || 'Ocupado'}
            {sinSuscripcion(cell.student) && (
              <span
                title="Este alumno figura sin suscripción activa. La clase se sigue mostrando y contando: verificá con el equipo."
                style={{ marginLeft: 4, color: '#ea580c', fontWeight: 700 }}
              >⚠</span>
            )}
          </div>
          <div className="vc-b-sub">{run ? (run.index === 0 ? run.label : 'continúa') : 'Semanal'}</div>
        </>
      );
    }
    if (cell.state === 'bloqueado') {
      return (
        <>
          <div className="vc-b-name">{cell.student || 'En recuperación'}</div>
          <div className="vc-b-sub">{cell.student ? 'Recuperación' : 'Puntual'}</div>
        </>
      );
    }
    if (cell.state === 'reprogramada') {
      return (
        <>
          <div className="vc-b-name" style={{ textDecoration: 'line-through' }}>{cell.student || 'Reprogramada'}</div>
          <div className="vc-b-sub">Repr.</div>
        </>
      );
    }
    return <div className="vc-b-name">{props.mode === 'setter' ? '+ Asignar' : 'Libre'}</div>;
  }

  function cellTitle(cell: Cell, run?: RunInfo) {
    if (cell.state === 'ocupado' && cell.student) {
      return run
        ? `${cell.student} · Sesión de ${run.length}h (${run.label}) · cuenta como ${run.length} clases`
        : `${cell.student} · Semanal`;
    }
    if (cell.state === 'bloqueado') {
      // baseStudent: el horario ya tiene un alumno fijo; la recuperación ocupa solo
      // esta semana y en las demás la celda vuelve a ser suya.
      return `En recuperación${cell.student ? ` · ${cell.student}` : ''}` +
        `${cell.recoveryFor ? ` · de la clase del ${cell.recoveryFor}` : ''}` +
        `${cell.recoveryNote ? ` · ${cell.recoveryNote}` : ''}` +
        `${baseStudentOf(cell) ? ` · solo esta semana (horario de ${baseStudentOf(cell)})` : ''}`;
    }
    if (cell.state === 'reprogramada') {
      return `Reprogramada${cell.student ? ` · ${cell.student}` : ''}` +
        `${cell.rescheduledTo ? ` · al ${cell.rescheduledTo}` : ''}`;
    }
    return cell.state;
  }

  function blockStyle(cell: Cell) {
    const colors = stateColor(cell.state);
    return { background: colors.bg, border: `1px solid ${colors.border}`, color: colors.text };
  }

  function isClickable(cell: Cell) {
    return props.mode === 'teacher' || (props.mode === 'setter' && isAssignableCell(cell));
  }

  return (
    <div className="visual-calendar" style={{ userSelect: 'none' }}>
      {/* Chips (leyenda + contadores fusionados) · navegador de semana */}
      <div className="vc-top">
        <div className="vc-chips">
          {([
            { state: 'libre'     as const, count: libre },
            { state: 'ocupado'   as const, count: ocupado },
            { state: 'bloqueado' as const, count: bloqueado },
            { state: 'no_work'   as const, count: noWork },
          ]).map(s => (
            <span key={s.state} className="vc-chip" title={CAL_STATE_META[s.state].desc}>
              <span aria-hidden className="vc-dot" style={{ background: CAL_STATE_META[s.state].dotColor }} />
              {CAL_STATE_META[s.state].label} <b>{s.count}</b>
            </span>
          ))}
        </div>

        <div className="vc-week">
          <button className="vc-week-btn" aria-label="Semana anterior" onClick={() => handleOffsetChange(offset - 1)}>‹</button>
          <div className="vc-week-label">
            <div className="vc-week-range" title={weekLabel}>{formatWeekRangeShort(weekDates)}</div>
            {offset === 0
              ? <div className="vc-week-sub">Semana actual</div>
              : <div className="vc-week-sub"><button onClick={() => handleOffsetChange(0)}>Volver a hoy</button></div>}
          </div>
          <button className="vc-week-btn" aria-label="Semana siguiente" onClick={() => handleOffsetChange(offset + 1)}>›</button>
        </div>
      </div>

      {/* Conmutador Día / Semana + pestañas de día (solo móvil) */}
      <div className="vc-mobile">
        <div className="vc-switch" role="group" aria-label="Vista del calendario">
          <button aria-pressed={mobileView === 'day'} onClick={() => setMobileView('day')}>Día</button>
          <button aria-pressed={mobileView === 'week'} onClick={() => setMobileView('week')}>Semana</button>
        </div>
        {mobileView === 'day' && (
          <div className="vc-daytabs" role="group" aria-label="Día de la semana">
            {DAYS.map((day, i) => (
              <button key={day} className="vc-daytab" aria-pressed={i === activeDay} onClick={() => setDayPicked(i)}>
                <div className="vc-daytab-name">{day.slice(0, 3)}</div>
                <div className="vc-daytab-num">{weekDates[i].getDate()}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Agenda del día (móvil, vista "Día") */}
      <div className={`vc-agenda${mobileView === 'week' ? ' vc-hide-mobile' : ''}`}>
        {earlierBtn}
        {hours.map(hour => {
          const day  = DAYS[activeDay];
          const cell = getCell(day, hour);
          const run  = runFor(day, hour);
          const isTodayCol = activeDay === todayColIndex;
          const dimPast = isTodayCol && currentHour >= 0 && parseInt(hour) < currentHour;
          return (
            <div key={hour} className="vc-arow">
              <div className="vc-hcell" style={{ position: 'static', border: 'none', padding: 0 }}>
                <div className="vc-h-es">{hour}</div>
                <div className="vc-h-ar">{toAR(hour)}</div>
              </div>
              <div
                className={`vc-block${isClickable(cell) ? ' is-clickable' : ''}${dimPast ? ' is-past' : ''}${runClass(run)}`}
                style={blockStyle(cell)}
                title={cellTitle(cell, run)}
                onClick={() => handleCellClick(day, hour)}
              >
                {blockContent(cell, run)}
              </div>
            </div>
          );
        })}
        {laterBtn}
      </div>

      {/* Grilla semanal (escritorio siempre; móvil solo en vista "Semana") */}
      <div className={`vc-grid${mobileView === 'day' ? ' vc-hide-mobile' : ''}`}>
        {earlierBtn}
        <table className="vc-table">
          <thead>
            <tr>
              <th className="vc-th-hours">ES / AR</th>
              {DAYS.map((day, i) => {
                const date = weekDates[i];
                const hl = highlightDays.includes(day);
                const isToday = i === todayColIndex;
                return (
                  <th key={day} className={hl ? 'is-highlight' : isToday ? 'is-today' : undefined}>
                    <div>{day}</div>
                    <div className="vc-th-date">{date.getDate()} {MONTH_NAMES_SHORT[date.getMonth()]}</div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {hours.map(hour => (
              <tr key={hour}>
                <td className="vc-hcell">
                  <div className="vc-h-es">{hour}</div>
                  <div className="vc-h-ar">{toAR(hour)}</div>
                </td>
                {DAYS.map((day, colIdx) => {
                  const cell = getCell(day, hour);
                  const run  = runFor(day, hour);
                  const hlCell = isHighlighted(day, hour);

                  const isTodayCol = colIdx === todayColIndex;
                  const hourInt    = parseInt(hour);
                  // Past cells: only in today's column, only hours strictly before now.
                  const dimPast    = isTodayCol && currentHour >= 0 && hourInt < currentHour;
                  // "Now" line sits inside today's current-hour cell, at the right minute.
                  const showNowLine = isTodayCol && hourInt === currentHour;

                  return (
                    <td key={day} className="vc-cell" onClick={() => handleCellClick(day, hour)}>
                      {showNowLine && (
                        <div className="vc-now" style={{ top: `${(currentMinute / 60) * 100}%` }}>
                          <span className="vc-now-label">{nowLabel}</span>
                        </div>
                      )}
                      <div
                        className={`vc-block${isClickable(cell) ? ' is-clickable' : ''}${dimPast ? ' is-past' : ''}${hlCell ? ' is-highlight' : ''}${runClass(run)}`}
                        style={blockStyle(cell)}
                        title={cellTitle(cell, run)}
                      >
                        {blockContent(cell, run)}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {laterBtn}
      </div>

      {props.mode === 'teacher' && (
        <div className="vc-hint">
          Clic en cualquier celda para cambiar su estado.
          {canExtend && ' Con los botones de arriba y abajo ampliás tu calendario una hora (de 06:00 a 23:00).'}
        </div>
      )}
      {props.mode === 'setter' && (
        <div className="vc-hint">
          Clic en una celda libre para asignar. El horario asignado se repetirá{' '}
          <strong style={{ fontWeight: 600 }}>todas las semanas</strong> de forma automática.
        </div>
      )}

      {menu && props.mode === 'teacher' && (
        <CellMenu
          day={menu.day}
          hour={menu.hour}
          current={getCell(menu.day, menu.hour).state}
          onSelect={(state, student, recovery) => handleMenuSelect(menu.day, menu.hour, state, student, recovery)}
          onClose={() => setMenu(null)}
          onOcupadoNeed={props.onOcupadoNeed}
          onRecuperacionNeed={props.onRecuperacionNeed}
        />
      )}
    </div>
  );
}
