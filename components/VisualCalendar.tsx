'use client';
import { useState, useCallback, useEffect } from 'react';
import { Grid, Cell, CellState } from '@/types';
import { Button } from '@/components/ui';

export const DAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
export const HOURS_ES = Array.from({ length: 14 }, (_, i) => `${(i + 9).toString().padStart(2, '0')}:00`);

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

// Current time in Europe/Madrid (Spain) — the calendar's reference timezone — no
// matter where the user's browser actually is. Returns the Spain wall-clock hour,
// minute and the Spain calendar date as YYYY-MM-DD.
export function getSpainParts(now: Date): { hour: number; minute: number; dateStr: string } {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00';
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0; // some runtimes emit '24' for midnight
  return {
    hour,
    minute: parseInt(get('minute'), 10),
    dateStr: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

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
  }
}

// Metadatos de cada estado para leyendas y contadores. `dotColor` es el color del
// punto; `outline` marca la categoría vacía (No work), que se dibuja sin relleno.
export const CAL_STATE_META: Record<CellState, { label: string; desc: string; dotColor: string; outline?: boolean }> = {
  libre:     { label: 'Libre',           desc: 'Disponible para clases',        dotColor: 'var(--cal-free-dot)' },
  ocupado:   { label: 'Ocupado',         desc: 'Clase con alumno',              dotColor: 'var(--cal-busy-dot)' },
  bloqueado: { label: 'En recuperación', desc: 'Clase de recuperación o ajuste', dotColor: 'var(--cal-recovery-dot)' },
  no_work:   { label: 'No work',         desc: 'No trabajás ese horario',       dotColor: 'var(--cal-nowork-dot)' },
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
}

export interface RecuperacionData { student: string; recoveryFor: string; note?: string }

interface TeacherProps extends BaseProps {
  mode: 'teacher';
  onGridChange: (grid: Grid) => void;
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
    if (cell.state === 'bloqueado' && cell.weekDate) {
      const currentMonday = toISODateStr(weekDates[0]);
      if (cell.weekDate !== currentMonday) {
        return { state: cell.baseState ?? 'libre' };
      }
    }
    return cell;
  }

  function handleCellClick(day: string, hour: string) {
    const cell = getCell(day, hour);
    if (props.mode === 'teacher') {
      setMenu({ day, hour });
    } else if (props.mode === 'setter') {
      if (cell.state === 'libre') props.onCellClick(day, hour);
    }
  }

  function handleMenuSelect(day: string, hour: string, state: CellState, student?: string, recovery?: { recoveryFor: string; note?: string }) {
    if (props.mode !== 'teacher') return;
    const key = cellKey(day, hour);
    let newCell: Cell;
    if (state === 'bloqueado') {
      const prevCell = props.grid[key] ?? { state: 'no_work' };
      const baseState = prevCell.state === 'bloqueado' ? (prevCell.baseState ?? 'libre') : prevCell.state;
      newCell = { state, student, weekDate: toISODateStr(weekDates[0]), baseState, recoveryFor: recovery?.recoveryFor, recoveryNote: recovery?.note };
    } else {
      newCell = { state, student };
    }
    props.onGridChange({ ...props.grid, [key]: newCell });
  }

  const cells = Object.values(props.grid);
  const libre    = cells.filter(c => c.state === 'libre').length;
  const ocupado  = cells.filter(c => c.state === 'ocupado').length;
  const bloqueado= cells.filter(c => c.state === 'bloqueado').length;
  const noWork   = cells.filter(c => c.state === 'no_work').length;

  const isHighlighted = (day: string, hour: string) =>
    props.highlightSlots?.some(s => s.day === day && s.hour === hour) ?? false;

  const highlightDays = props.highlightSlots?.map(s => s.day) ?? [];

  const activeDay = dayPicked ?? (todayColIndex >= 0 ? todayColIndex : 0);

  // Contenido visual de una celda, compartido por la grilla y la agenda móvil.
  function blockContent(cell: Cell) {
    if (cell.state === 'no_work') {
      return props.mode === 'teacher' ? <div className="vc-b-name">No work</div> : null;
    }
    if (cell.state === 'ocupado') {
      return (
        <>
          <div className="vc-b-name">{cell.student || 'Ocupado'}</div>
          <div className="vc-b-sub">Semanal</div>
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
    return <div className="vc-b-name">{props.mode === 'setter' ? '+ Asignar' : 'Libre'}</div>;
  }

  function cellTitle(cell: Cell) {
    if (cell.state === 'ocupado' && cell.student) return `${cell.student} · Semanal`;
    if (cell.state === 'bloqueado') {
      return `En recuperación${cell.student ? ` · ${cell.student}` : ''}` +
        `${cell.recoveryFor ? ` · de la clase del ${cell.recoveryFor}` : ''}` +
        `${cell.recoveryNote ? ` · ${cell.recoveryNote}` : ''}`;
    }
    return cell.state;
  }

  function blockStyle(cell: Cell) {
    const colors = stateColor(cell.state);
    return { background: colors.bg, border: `1px solid ${colors.border}`, color: colors.text };
  }

  function isClickable(cell: Cell) {
    return props.mode === 'teacher' || (props.mode === 'setter' && cell.state === 'libre');
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
        {HOURS_ES.map(hour => {
          const day  = DAYS[activeDay];
          const cell = getCell(day, hour);
          const isTodayCol = activeDay === todayColIndex;
          const dimPast = isTodayCol && currentHour >= 0 && parseInt(hour) < currentHour;
          return (
            <div key={hour} className="vc-arow">
              <div className="vc-hcell" style={{ position: 'static', border: 'none', padding: 0 }}>
                <div className="vc-h-es">{hour}</div>
                <div className="vc-h-ar">{toAR(hour)}</div>
              </div>
              <div
                className={`vc-block${isClickable(cell) ? ' is-clickable' : ''}${dimPast ? ' is-past' : ''}`}
                style={blockStyle(cell)}
                title={cellTitle(cell)}
                onClick={() => handleCellClick(day, hour)}
              >
                {blockContent(cell)}
              </div>
            </div>
          );
        })}
      </div>

      {/* Grilla semanal (escritorio siempre; móvil solo en vista "Semana") */}
      <div className={`vc-grid${mobileView === 'day' ? ' vc-hide-mobile' : ''}`}>
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
            {HOURS_ES.map(hour => (
              <tr key={hour}>
                <td className="vc-hcell">
                  <div className="vc-h-es">{hour}</div>
                  <div className="vc-h-ar">{toAR(hour)}</div>
                </td>
                {DAYS.map((day, colIdx) => {
                  const cell = getCell(day, hour);
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
                        className={`vc-block${isClickable(cell) ? ' is-clickable' : ''}${dimPast ? ' is-past' : ''}${hlCell ? ' is-highlight' : ''}`}
                        style={blockStyle(cell)}
                        title={cellTitle(cell)}
                      >
                        {blockContent(cell)}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {props.mode === 'teacher' && (
        <div className="vc-hint">Clic en cualquier celda para cambiar su estado.</div>
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
