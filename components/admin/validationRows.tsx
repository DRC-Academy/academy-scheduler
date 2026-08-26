'use client';

// Filas de la bandeja de validación. Cada una es una línea que NUNCA se parte,
// con el porqué de la alerta y las acciones dentro de un desplegable.
//
// El motivo del rediseño está en el desplegable: antes cada fila repetía
// "Ver / Aprobar / Rechazar" (24 botones en pantalla con 8 clases pendientes) y
// "Ver" además sacaba al admin de la cola para poder decidir. Ahora la fila
// tiene UN botón —Aprobar, el caso mayoritario— y el resto vive en la fila que
// el admin abrió.
//
// Accesibilidad: la fila es un div role="button" con aria-expanded/aria-controls
// (no un <button>: dentro lleva un checkbox y otro botón, y anidar controles es
// marcado inválido). Las columnas están en globals.css (.vl-row) porque
// necesitan media queries.

import type { KeyboardEvent, ReactNode } from 'react';
import { btnDanger, btnGhost, btnPrimary } from '@/components/ai/riskRows';
import {
  MOTIVO, classDataOf, formatRowDate, scoreColor, type ValRow,
} from '@/lib/validationInbox';

function rowKeyDown(onToggle: () => void) {
  return (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;      // el hijo gestiona su propia tecla
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onToggle();
  };
}

function Chevron({ open }: { open: boolean }) {
  // aria-hidden: el estado ya lo anuncia aria-expanded de la fila.
  return (
    <span aria-hidden className="vl-chev" style={{ fontSize: 12, color: '#9aa79f', fontWeight: 800, textAlign: 'right' }}>
      {open ? '▾' : '▸'}
    </span>
  );
}

function Label({ children }: { children: ReactNode }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 800, letterSpacing: '.7px',
      color: '#8a9790', textTransform: 'uppercase',
    }}>
      {children}
    </div>
  );
}

/** Chip del motivo. El texto va SIEMPRE, no solo el color: el motivo no puede
 *  quedar codificado únicamente en el tinte del chip. */
export function MotivoChip({ motivo }: { motivo: ValRow['motivo'] }) {
  const m = MOTIVO[motivo];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none',
      fontSize: 11.5, fontWeight: 800, color: m.fg, background: m.bg,
      border: `1px solid ${m.bd}`, borderRadius: 999, padding: '3px 10px', whiteSpace: 'nowrap',
    }}>
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: m.accent, flex: 'none' }} />
      {m.chip}
    </span>
  );
}

/**
 * Score como medidor. El número va siempre al lado de la barra: un color y una
 * longitud no son un dato, y el score es justo lo que el admin compara.
 */
export function ScoreMeter({ score }: { score: number | null }) {
  const color = scoreColor(score);
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span aria-hidden style={{ width: 52, height: 5, borderRadius: 3, background: '#eef0ec', flex: 'none', overflow: 'hidden' }}>
        <span style={{ display: 'block', width: `${score ?? 0}%`, height: '100%', background: color }} />
      </span>
      <span style={{ fontSize: 13.5, fontWeight: 800, color, fontVariantNumeric: 'tabular-nums' }}>
        {score ?? '—'}
      </span>
    </span>
  );
}

// ── Fila de la cola ──────────────────────────────────────────────────────────

export interface ValRowProps {
  row: ValRow;
  open: boolean;
  selected: boolean;
  busy: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onApprove: () => void;
  onReject: () => void;
  onViewFull: () => void;
  onFilterTeacher: () => void;
}

export function ValidationRow(p: ValRowProps) {
  const { row } = p;
  const m = MOTIVO[row.motivo];
  const panelId = `vl-panel-${row.id}`;

  return (
    <div style={{ borderLeft: `3px solid ${m.accent}`, borderTop: '1px solid #f1f3ef' }}>
      <div
        role="button"
        tabIndex={0}
        className={`vl-row${p.selected ? ' is-sel' : ''}`}
        onClick={p.onToggle}
        onKeyDown={rowKeyDown(p.onToggle)}
        aria-expanded={p.open}
        aria-controls={panelId}
      >
        {/* 1 · selección — no despliega */}
        <input
          type="checkbox"
          checked={p.selected}
          onChange={p.onSelect}
          onClick={e => e.stopPropagation()}
          aria-label={`Seleccionar ${row.studentName}`}
          style={{ width: 15, height: 15, accentColor: '#12a04b', margin: 0, cursor: 'pointer' }}
        />

        {/* 2 · alumno (el profesor deja de ser columna propia) */}
        <span style={{ minWidth: 0, display: 'block' }}>
          <span style={{
            display: 'block', fontSize: 14, fontWeight: 800, color: '#1d2622',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {row.studentName}
          </span>
          <span style={{
            display: 'block', fontSize: 11.5, color: '#8a9790', fontWeight: 600, marginTop: 2,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            Prof. {row.teacherName}
          </span>
        </span>

        {/* 3 · detalle de la alerta — es la columna que cede al estrechar */}
        <span className="vl-alert" style={{
          fontSize: 13, color: '#5c6a62', lineHeight: 1.45,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {/* La clase ya está aprobada y cobrando: la verificación tardía
              encontró algo DESPUÉS. Se marca fuerte porque es el único sitio
              donde este hallazgo se ve; si no, solo existía en la campanita. */}
          {row.lateFinding && (
            <span
              title="La clase ya estaba aprobada y sigue contando para el pago. La verificación posterior encontró estas señales."
              style={{
                display: 'inline-block', marginRight: 7, padding: '1px 7px', borderRadius: 999,
                fontSize: 10.5, fontWeight: 800, letterSpacing: '0.02em',
                background: 'rgba(255,196,0,0.22)', color: '#8a6d00', border: '1px solid rgba(255,196,0,0.55)',
              }}
            >
              HALLAZGO POSTERIOR
            </span>
          )}
          {row.alertText}
        </span>

        {/* 4 · score */}
        <span className="vl-span"><ScoreMeter score={row.score} /></span>

        {/* 5 · fecha */}
        <span className="vl-span" style={{ fontSize: 12.5, fontWeight: 600, color: '#6b7a70', whiteSpace: 'nowrap' }}>
          {formatRowDate(row.date)}
        </span>

        {/* 6 · aprobar — no despliega */}
        <button
          type="button"
          className="vl-span"
          disabled={p.busy}
          onClick={e => { e.stopPropagation(); p.onApprove(); }}
          style={{
            background: '#fff', border: '1px solid #cfe8d8', color: '#0d7a39',
            borderRadius: 9, padding: '7px 12px', fontSize: 12.5, fontWeight: 800,
            fontFamily: 'inherit', textAlign: 'center', whiteSpace: 'nowrap',
            cursor: p.busy ? 'not-allowed' : 'pointer', opacity: p.busy ? 0.5 : 1,
          }}
        >
          {p.busy ? '…' : 'Aprobar'}
        </button>

        <Chevron open={p.open} />
      </div>

      {p.open && (
        <div id={panelId} className="vl-detail" style={{ padding: '4px 20px 20px 40px' }}>
          <div>
            <Label>Por qué está marcada</Label>
            <div style={{
              marginTop: 8, background: m.bg, border: `1px solid ${m.bd}`, borderRadius: 11,
              padding: '13px 15px',
            }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: m.fg, lineHeight: 1.45 }}>
                {row.alertText}
              </div>
              <div style={{ fontSize: 12.5, color: '#6b7a70', lineHeight: 1.55, marginTop: 6 }}>
                {m.explicacion}
              </div>
            </div>

            <div style={{ marginTop: 18 }}><Label>Datos de la clase</Label></div>
            <div className="vl-data">
              {classDataOf(row.src).map(d => (
                <div key={d.k} style={{
                  display: 'flex', justifyContent: 'space-between', gap: 10,
                  borderBottom: '1px dashed #edefea', padding: '7px 0', fontSize: 12.5,
                }}>
                  <span style={{ color: '#8a9790', fontWeight: 600, flex: 'none' }}>{d.k}</span>
                  <span style={{
                    fontWeight: 700, color: d.muted ? '#9aa79f' : '#3f4c45', textAlign: 'right',
                    minWidth: 0, overflowWrap: 'anywhere',
                  }}>
                    {d.v}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: 'grid', gap: 8, alignContent: 'start' }}>
            <button type="button" onClick={p.onApprove} disabled={p.busy} style={{ ...btnPrimary, opacity: p.busy ? 0.5 : 1 }}>
              {p.busy ? 'Guardando…' : 'Aprobar clase'}
            </button>
            <button type="button" onClick={p.onReject} disabled={p.busy} style={{ ...btnDanger, opacity: p.busy ? 0.5 : 1 }}>
              Rechazar
            </button>
            <button type="button" onClick={p.onViewFull} style={btnGhost}>Ver clase completa</button>
            <button
              type="button"
              onClick={p.onFilterTeacher}
              style={{
                background: 'none', border: 'none', padding: '2px 0', fontFamily: 'inherit',
                fontSize: 12.5, fontWeight: 700, color: '#0d7a39', cursor: 'pointer', textAlign: 'center',
              }}
            >
              Ver todas las clases de {row.teacherName}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Fila del historial (plana, sin acciones) ─────────────────────────────────

const ESTADO: Record<string, { label: string; bg: string; bd: string; fg: string }> = {
  approved:      { label: 'Aprobada',  bg: '#eaf5ee', bd: '#cfe8d8', fg: '#136b34' },
  auto_approved: { label: 'Aprobada',  bg: '#eaf5ee', bd: '#cfe8d8', fg: '#136b34' },
  rejected:      { label: 'Rechazada', bg: '#fdeeec', bd: '#f3cfca', fg: '#a52b23' },
};

export function HistoryRow({ row }: { row: ValRow }) {
  const e = ESTADO[row.status] ?? ESTADO.approved;
  // "automática" solo cuando de verdad lo fue: auto_approved es la única que
  // nadie decidió. El resto lleva el nombre de quien la resolvió.
  const quien = row.status === 'auto_approved'
    ? 'automática'
    : row.reviewedBy ? `por ${row.reviewedBy}` : 'sin registrar quién';

  return (
    <div className="vl-hist-row">
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: 13.5, fontWeight: 700, color: '#3f4c45',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {row.studentName}
        </div>
        <div style={{
          fontSize: 11.5, color: '#9aa79f', marginTop: 2,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          Prof. {row.teacherName}
        </div>
      </div>
      <div className="vl-alert" style={{
        fontSize: 12.5, color: '#8a9790',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {row.alertText}
      </div>
      <div className="vl-span" style={{ fontSize: 13, fontWeight: 700, color: '#8a9790', fontVariantNumeric: 'tabular-nums' }}>
        {row.score ?? '—'}
      </div>
      <div className="vl-span" style={{ fontSize: 12.5, color: '#9aa79f', whiteSpace: 'nowrap' }}>
        {formatRowDate(row.date)}
      </div>
      <div className="vl-span" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{
          fontSize: 11.5, fontWeight: 800, color: e.fg, background: e.bg,
          border: `1px solid ${e.bd}`, borderRadius: 999, padding: '3px 10px', whiteSpace: 'nowrap',
        }}>
          {e.label}
        </span>
        <span style={{ fontSize: 11.5, color: '#9aa79f' }}>{quien}</span>
      </div>
    </div>
  );
}
