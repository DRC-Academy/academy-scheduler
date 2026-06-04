'use client';
import { useState, useCallback } from 'react';
import { Grid, Cell, CellState } from '@/types';

export const DAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
export const HOURS_ES = Array.from({ length: 14 }, (_, i) => `${(i + 9).toString().padStart(2, '0')}:00`);

export function toAR(hourES: string): string {
  const h = parseInt(hourES);
  let ar = h - 4;
  if (ar < 0) ar += 24;
  return `${ar.toString().padStart(2, '0')}:00`;
}

export function cellKey(day: string, hour: string) {
  return `${day}_${hour}`;
}

export type { Grid, Cell, CellState };

export function stateColor(state: CellState) {
  switch (state) {
    case 'libre':     return { bg: 'rgba(30,158,58,0.12)',  border: 'rgba(30,158,58,0.4)',   text: '#167a2d' };
    case 'ocupado':   return { bg: 'rgba(30,158,58,0.25)',  border: 'rgba(30,158,58,0.6)',   text: '#0f5a20' };
    case 'bloqueado': return { bg: 'rgba(255,196,0,0.15)',  border: 'rgba(255,196,0,0.5)',   text: '#b38600' };
    case 'no_work':   return { bg: 'transparent',           border: 'rgba(200,200,195,0.6)', text: 'var(--text-muted)' };
  }
}

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

// ── MODES ────────────────────────────────────────────────────────────────────
// 'teacher' : profe edita su propio calendario (clic → ciclo de estados, con modal para nombre alumno)
// 'setter'  : setter ve calendario de profe, clic en libre → callback para asignar
// 'readonly': solo lectura (admin viendo)

type Mode = 'teacher' | 'setter' | 'readonly';

interface BaseProps {
  grid: Grid;
  mode: Mode;
  highlightSlots?: Array<{ day: string; hour: string }>;
}

interface TeacherProps extends BaseProps {
  mode: 'teacher';
  onGridChange: (grid: Grid) => void;
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
        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <button onClick={onCancel} style={{ flex: 1, padding: '9px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13 }}>Cancelar</button>
          <button onClick={() => name.trim() && onConfirm(name.trim())} disabled={!name.trim()}
            style={{ flex: 2, padding: '9px', borderRadius: 8, border: 'none', background: name.trim() ? '#3b82f6' : 'var(--bg-surface-3)', color: name.trim() ? 'white' : 'var(--text-muted)', cursor: name.trim() ? 'pointer' : 'not-allowed', fontSize: 13, fontWeight: 700 }}>
            Marcar como Ocupado
          </button>
        </div>
      </div>
    </div>
  );
}

// Context menu for teacher clicking a cell
function CellMenu({
  day, hour, current, onSelect, onClose
}: {
  day: string; hour: string; current: CellState;
  onSelect: (state: CellState, student?: string) => void;
  onClose: () => void;
}) {
  const [askStudent, setAskStudent] = useState(false);

  if (askStudent) {
    return <StudentNameModal
      onConfirm={name => { onSelect('ocupado', name); onClose(); }}
      onCancel={() => { setAskStudent(false); onClose(); }}
    />;
  }

  const options: Array<{ state: CellState; label: string; color: string; icon: string }> = [
    { state: 'libre',     label: 'Libre',     color: '#4ade80', icon: '🟢' },
    { state: 'ocupado',   label: 'Ocupado',   color: '#93c5fd', icon: '🔵' },
    { state: 'bloqueado', label: 'Bloqueado', color: '#fbbf24', icon: '🟡' },
    { state: 'no_work',   label: 'No work',   color: 'var(--text-muted)', icon: '⬜' },
  ];

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid #35405a', borderRadius: 12, padding: 8, minWidth: 200, boxShadow: '0 16px 48px rgba(0,0,0,0.5)' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', padding: '4px 10px 8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {day} · {hour} 🇪🇸 / {toAR(hour)} 🇦🇷
        </div>
        {options.map(opt => (
          <button key={opt.state} onClick={() => {
            if (opt.state === 'ocupado') { setAskStudent(true); return; }
            onSelect(opt.state);
            onClose();
          }} style={{
            display: 'flex', alignItems: 'center', gap: 10, width: '100%',
            padding: '9px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
            background: current === opt.state ? 'var(--bg-surface-3)' : 'transparent',
            color: current === opt.state ? opt.color : 'var(--text-secondary)',
            fontSize: 13, fontWeight: current === opt.state ? 700 : 400,
            textAlign: 'left',
          }}>
            <span>{opt.icon}</span>
            <span>{opt.label}</span>
            {current === opt.state && <span style={{ marginLeft: 'auto', fontSize: 11, color: opt.color }}>actual</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

export function VisualCalendar(props: Props) {
  const [menu, setMenu] = useState<{ day: string; hour: string } | null>(null);

  function getCell(day: string, hour: string): Cell {
    return props.grid[cellKey(day, hour)] ?? { state: 'no_work' };
  }

  function handleCellClick(day: string, hour: string) {
    const cell = getCell(day, hour);
    if (props.mode === 'teacher') {
      setMenu({ day, hour });
    } else if (props.mode === 'setter') {
      if (cell.state === 'libre') props.onCellClick(day, hour);
    }
  }

  function handleMenuSelect(day: string, hour: string, state: CellState, student?: string) {
    if (props.mode !== 'teacher') return;
    const key = cellKey(day, hour);
    const updated = { ...props.grid, [key]: { state, student } };
    props.onGridChange(updated);
  }

  // Stats
  const cells = Object.values(props.grid);
  const libre    = cells.filter(c => c.state === 'libre').length;
  const ocupado  = cells.filter(c => c.state === 'ocupado').length;
  const bloqueado= cells.filter(c => c.state === 'bloqueado').length;
  const noWork   = cells.filter(c => c.state === 'no_work').length;

  const isHighlighted = (day: string, hour: string) =>
    props.highlightSlots?.some(s => s.day === day && s.hour === hour) ?? false;

  const highlightDays = props.highlightSlots?.map(s => s.day) ?? [];

  return (
    <div style={{ userSelect: 'none' }}>
      {/* Stats */}
      <div style={{ display: 'flex', gap: 14, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        {[
          { label: 'Libre',     count: libre,     color: '#4ade80' },
          { label: 'Ocupado',   count: ocupado,   color: '#93c5fd' },
          { label: 'Bloqueado', count: bloqueado, color: '#fbbf24' },
          { label: 'No work',   count: noWork,    color: 'var(--text-muted)' },
        ].map(s => (
          <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 9, height: 9, borderRadius: 2, background: s.color, flexShrink: 0 }} />
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {s.label}: <b style={{ color: s.color }}>{s.count}</b>
            </span>
          </div>
        ))}
        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
          {props.mode === 'teacher' && '✏️ Hacé clic en una celda para cambiar su estado'}
          {props.mode === 'setter'  && '🟢 Hacé clic en una celda libre para asignar'}
          {props.mode === 'readonly'&& '👁 Solo lectura'}
        </span>
      </div>

      {/* Grid */}
      <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid var(--border)' }}>
        <table style={{ borderCollapse: 'collapse', minWidth: 600, width: '100%' }}>
          <thead>
            <tr>
              <th style={{
                padding: '8px 10px', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
                background: 'var(--bg-surface-2)', borderBottom: '1px solid var(--border)',
                textAlign: 'left', position: 'sticky', left: 0, zIndex: 2, minWidth: 84,
              }}>🇪🇸 / 🇦🇷</th>
              {DAYS.map(day => {
                const hl = highlightDays.includes(day);
                return (
                  <th key={day} style={{
                    padding: '8px 6px', fontSize: 12, fontWeight: 700,
                    color: hl ? '#93c5fd' : 'var(--text-primary)',
                    background: hl ? 'rgba(59,130,246,0.1)' : 'var(--bg-surface-2)',
                    borderBottom: `2px solid ${hl ? 'rgba(59,130,246,0.5)' : 'var(--border)'}`,
                    textAlign: 'center', minWidth: 86,
                  }}>{day}</th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {HOURS_ES.map(hour => (
              <tr key={hour} style={{ borderBottom: '1px solid rgba(42,51,71,0.4)' }}>
                <td style={{
                  padding: '4px 10px', fontSize: 11, lineHeight: 1.4,
                  background: 'var(--bg-surface-2)', position: 'sticky', left: 0, zIndex: 1,
                  borderRight: '1px solid var(--border)', whiteSpace: 'nowrap',
                  color: 'var(--text-secondary)',
                }}>
                  <div style={{ fontWeight: 600 }}>{hour}</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>{toAR(hour)}</div>
                </td>
                {DAYS.map(day => {
                  const cell = getCell(day, hour);
                  const colors = stateColor(cell.state);
                  const hlCell = isHighlighted(day, hour);

                  let cursor = 'default';
                  if (props.mode === 'teacher') cursor = 'pointer';
                  if (props.mode === 'setter' && cell.state === 'libre') cursor = 'pointer';

                  let bg = colors.bg;
                  let border = `1px solid ${colors.border}`;
                  if (hlCell) {
                    bg = 'rgba(59,130,246,0.3)';
                    border = '2px solid rgba(59,130,246,0.8)';
                  }

                  return (
                    <td key={day}
                      onClick={() => handleCellClick(day, hour)}
                      title={cell.state === 'ocupado' && cell.student ? cell.student : cell.state}
                      style={{
                        height: 40, padding: '2px 3px',
                        background: bg, border, cursor,
                        transition: 'background 0.08s',
                        textAlign: 'center', verticalAlign: 'middle',
                      }}>
                      {cell.state !== 'no_work' && (
                        <div style={{
                          fontSize: 9, fontWeight: 600, color: colors.text,
                          lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap', maxWidth: 82, margin: '0 auto',
                        }}
                          title={cell.state === 'ocupado' && cell.student ? cell.student : undefined}>
                          {cell.state === 'ocupado'
                            ? (cell.student || 'Ocupado')
                            : cell.state === 'libre'
                              ? (props.mode === 'setter' ? '+ Asignar' : 'Libre')
                              : 'Bloqueado'}
                        </div>
                      )}
                      {cell.state === 'no_work' && props.mode === 'teacher' && (
                        <div style={{ fontSize: 9, color: 'var(--text-muted)', opacity: 0.5 }}>No work</div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Teacher mode legend */}
      {props.mode === 'teacher' && (
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)' }}>
          ✏️ Clic en cualquier celda para elegir: Libre · Ocupado · Bloqueado · No work
        </div>
      )}

      {/* Menus */}
      {menu && props.mode === 'teacher' && (
        <CellMenu
          day={menu.day}
          hour={menu.hour}
          current={getCell(menu.day, menu.hour).state}
          onSelect={(state, student) => handleMenuSelect(menu.day, menu.hour, state, student)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
