'use client';

// Filas de la bandeja de riesgo. Cada una es una línea que NUNCA se parte, con
// la evidencia y las acciones dentro de un desplegable.
//
// El motivo del rediseño está en el desplegable: antes las tres acciones
// (ver detalle / marcar atendida / registrar incidencia) se repetían en las 34
// filas a la vez. Ahora solo existen en la fila que el admin abrió.
//
// Accesibilidad: la fila es un <button> con aria-expanded/aria-controls; el
// checkbox es un <input> real con aria-label y detiene la propagación para que
// marcarlo no despliegue. Las columnas están en globals.css (.rk-row) porque
// necesitan media queries.

import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import {
  CONF_STYLE, SEV, cut, formatRowDate, unattendedLabel,
  type HistoryEvent, type RiskRow,
} from '@/lib/riskInbox';
import { RiskActionDetail } from '@/components/ai/FichaView';

/**
 * La fila es un `div role="button"`, no un `<button>`: dentro lleva un checkbox y
 * un botón de acción, y anidar controles dentro de un <button> es HTML inválido
 * (el navegador no entrega el clic al hijo). Con role+tabIndex se conserva el
 * comportamiento de teclado sin romper el marcado.
 */
function rowKeyDown(onToggle: () => void) {
  return (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;      // el hijo gestiona su propia tecla
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onToggle();
  };
}

// ── Piezas compartidas ───────────────────────────────────────────────────────

export function SevBadge({ sev }: { sev: 'riesgo' | 'atencion' }) {
  const s = SEV[sev];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, justifySelf: 'start',
      fontSize: 11.5, fontWeight: 800, color: s.fg, background: s.bg,
      border: `1px solid ${s.bd}`, borderRadius: 999, padding: '3px 10px', whiteSpace: 'nowrap',
    }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: s.accent, flex: 'none' }} />
      {s.label}
    </span>
  );
}

export function ConfBadge({ value }: { value: string | null }) {
  if (!value) return <span style={{ fontSize: 12.5, color: '#9aa79f', justifySelf: 'start' }}>—</span>;
  const c = CONF_STYLE[value] ?? CONF_STYLE.baja;
  return (
    <span style={{
      justifySelf: 'start', fontSize: 11.5, fontWeight: 800, color: c.fg,
      background: c.bg, border: `1px solid ${c.bd}`, borderRadius: 999, padding: '3px 10px',
    }}>
      {value}
    </span>
  );
}

function Chevron({ open }: { open: boolean }) {
  // aria-hidden: el estado ya lo anuncia aria-expanded del botón.
  return (
    <span aria-hidden className="rk-chev" style={{ fontSize: 12, color: '#9aa79f', fontWeight: 800, textAlign: 'right' }}>
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

/** El texto de la IA, literal. `pre-wrap` porque varias evidencias traen saltos. */
function EvidenceBox({ text, bg, bd }: { text: string; bg: string; bd: string }) {
  return (
    <div style={{
      marginTop: 8, background: bg, border: `1px solid ${bd}`, borderRadius: 11,
      padding: '13px 15px', fontSize: 13.5, lineHeight: 1.6, color: '#3f4c45',
      whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
    }}>
      {text}
    </div>
  );
}

// ── Fila de la cola de riesgo ────────────────────────────────────────────────

export interface ColaRowProps {
  row: RiskRow;
  open: boolean;
  selected: boolean;
  busy: boolean;
  history: HistoryEvent[];
  attendance: string | null;
  onToggle: () => void;
  onSelect: () => void;
  onIntervene: () => void;
  onDone: () => void;
  onIncident: () => void;
}

export function ColaRow(p: ColaRowProps) {
  const { row } = p;
  const sev = row.sev === 'riesgo' ? 'riesgo' : 'atencion';
  const s = SEV[sev];
  const panelId = `rk-panel-${row.id}`;

  return (
    <div style={{ borderLeft: `3px solid ${s.accent}` }}>
      <div
        role="button"
        tabIndex={0}
        className={`rk-row${p.selected ? ' is-sel' : ''}`}
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

        {/* 2 · alumno */}
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
            Prof. {row.teacherName} · {formatRowDate(row.date)}
          </span>
        </span>

        {/* 3 · severidad */}
        <span className="rk-span"><SevBadge sev={sev} /></span>

        {/* 4 · vista previa — es la columna que cede al estrechar */}
        <span className="rk-preview" style={{
          fontSize: 13, color: '#5c6a62', lineHeight: 1.45,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {cut(row.evidence, 130)}
        </span>

        {/* 5 · pendientes */}
        <span className="rk-span" style={{ fontSize: 12, fontWeight: 700, color: '#6b7a70' }}>
          {unattendedLabel(row.unattended)}
        </span>

        {/* 6 · intervenir — no despliega */}
        <button
          type="button"
          className="rk-span"
          onClick={e => { e.stopPropagation(); p.onIntervene(); }}
          style={{
            background: '#fff', border: `1px solid ${s.bd}`, color: s.fg,
            borderRadius: 9, padding: '7px 12px', fontSize: 12.5, fontWeight: 800,
            fontFamily: 'inherit', textAlign: 'center', cursor: 'pointer', whiteSpace: 'nowrap',
          }}
        >
          Intervenir
        </button>

        <Chevron open={p.open} />
      </div>

      {p.open && (
        <div id={panelId} className="rk-detail" style={{ padding: '4px 20px 20px 40px' }}>
          <div>
            <Label>Evidencia de la IA</Label>
            {row.evidence
              ? <EvidenceBox text={row.evidence} bg={s.bg} bd={s.bd} />
              : <div style={{ marginTop: 8, fontSize: 13, color: '#8a9790' }}>
                  La IA no dejó explicación para esta alerta.
                </div>}

            {/* Qué se propuso hacer, con la causa y el motivo actualizado. La
                evidencia de arriba dice qué pasa; esto dice qué hacer, que es lo
                que le faltaba al admin para decidir sin abrir la ficha. */}
            {row.active && (
              <div style={{ marginTop: 18 }}>
                <RiskActionDetail
                  cause={row.active.cause}
                  stillOpenReason={row.active.stillOpenReason}
                  intervention={row.active}
                  risk={row.active.risk}
                />
              </div>
            )}

            {p.history.length > 0 && (
              <>
                <div style={{ marginTop: 18 }}><Label>Historial</Label></div>
                <div style={{ display: 'grid', gap: 9, marginTop: 9 }}>
                  {p.history.map(h => (
                    <div key={`${h.at}-${h.text}`} style={{
                      display: 'flex', alignItems: 'flex-start', gap: 9,
                      fontSize: 12.5, color: '#5c6a62', lineHeight: 1.45,
                    }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#c9d2cc', marginTop: 6, flex: 'none' }} />
                      <span>{h.text}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <div>
            <div style={{ border: '1px solid #e7e9e4', borderRadius: 12, padding: 14, background: '#fcfdfb' }}>
              <div style={{ display: 'grid', gap: 9, fontSize: 12.5 }}>
                <Pair k="Confianza IA" v={row.confidence ?? '—'} color={row.confidence ? s.fg : '#9aa79f'} />
                <Pair k="Última clase" v={formatRowDate(row.date)} />
                <Pair k="Asistencia 30 d" v={p.attendance ?? 'sin registros'} />
                <Pair k="Profesor" v={row.teacherName} />
              </div>
            </div>

            <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
              <button type="button" onClick={p.onIntervene} style={btnPrimary}>
                Abrir intervención
              </button>
              <button
                type="button"
                onClick={p.onDone}
                disabled={p.busy || !row.hasProfile}
                title={row.hasProfile
                  ? 'Cierra la alerta en la ficha del alumno'
                  : 'El alumno todavía no tiene ficha: se creará al analizar su próxima clase'}
                style={{ ...btnGhost, opacity: p.busy || !row.hasProfile ? 0.5 : 1 }}
              >
                {p.busy ? 'Cerrando…' : 'Marcar como atendida'}
              </button>
              <button
                type="button"
                onClick={p.onIncident}
                disabled={!row.teacherId}
                title={row.teacherId ? 'Solo si hubo negligencia real' : 'El alumno no tiene profesor asignado'}
                style={{ ...btnDanger, opacity: row.teacherId ? 1 : 0.5 }}
              >
                Registrar incidencia
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Pair({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
      <span style={{ color: '#8a9790', fontWeight: 600 }}>{k}</span>
      <span style={{ fontWeight: color ? 800 : 700, color: color ?? '#3f4c45', textAlign: 'right' }}>{v}</span>
    </div>
  );
}

// ── Fila de verificación de intervenciones ───────────────────────────────────

export interface VerifRowProps {
  row: RiskRow;
  open: boolean;
  selected: boolean;
  busy: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onDone: () => void;
  onDetail: () => void;
  onIncident: () => void;
}

export function VerifRow(p: VerifRowProps) {
  const { row } = p;
  const sev = row.sev === 'riesgo' ? 'riesgo' : 'atencion';
  const s = SEV[sev];
  const panelId = `rk-vpanel-${row.id}`;
  // La evidencia de esta pestaña es la de la AUDITORÍA (qué observó la IA sobre
  // si el profesor actuó), no la de la alerta.
  const evidence = row.audits[0]?.evidence ?? '';

  return (
    <div style={{ borderBottom: '1px solid #f1f3ef' }}>
      <div
        role="button"
        tabIndex={0}
        className={`rk-verif-row${p.selected ? ' is-sel' : ''}`}
        onClick={p.onToggle}
        onKeyDown={rowKeyDown(p.onToggle)}
        aria-expanded={p.open}
        aria-controls={panelId}
      >
        <input
          type="checkbox"
          checked={p.selected}
          onChange={p.onSelect}
          onClick={e => e.stopPropagation()}
          aria-label={`Seleccionar ${row.studentName}`}
          style={{ width: 15, height: 15, accentColor: '#12a04b', margin: 0, cursor: 'pointer' }}
        />

        <span style={{ minWidth: 0, display: 'block' }}>
          <span style={{
            display: 'block', fontSize: 14, fontWeight: 800, color: '#1d2622',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {row.studentName}
          </span>
          {row.active && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: s.accent, flex: 'none' }} />
              <span style={{ fontSize: 11.5, color: '#8a9790', fontWeight: 700 }}>intervención abierta</span>
            </span>
          )}
        </span>

        <span className="rk-span" style={{
          fontSize: 13, fontWeight: 700, color: '#3f4c45',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {row.teacherName}
        </span>

        <span className="rk-span" style={{ fontSize: 12.5, fontWeight: 800, color: row.unattended > 0 ? s.fg : '#9aa79f' }}>
          {row.unattended === 0 ? '—' : row.unattended}
        </span>

        <span className="rk-preview" style={{
          fontSize: 13, color: '#5c6a62', lineHeight: 1.45,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {cut(evidence, 120) || '—'}
        </span>

        <span className="rk-span"><ConfBadge value={row.confidence} /></span>

        <button
          type="button"
          className="rk-span"
          disabled={p.busy || !row.hasProfile}
          title={row.hasProfile ? 'Cierra la alerta en la ficha del alumno' : 'El alumno todavía no tiene ficha'}
          onClick={e => { e.stopPropagation(); p.onDone(); }}
          style={{
            background: '#fff', border: '1px solid #cfe8d8', color: '#0d7a39',
            borderRadius: 9, padding: '7px 11px', fontSize: 12.5, fontWeight: 800,
            fontFamily: 'inherit', textAlign: 'center',
            cursor: p.busy || !row.hasProfile ? 'not-allowed' : 'pointer',
            opacity: p.busy || !row.hasProfile ? 0.5 : 1, whiteSpace: 'nowrap',
          }}
        >
          {p.busy ? '…' : 'Atendida'}
        </button>

        <Chevron open={p.open} />
      </div>

      {p.open && (
        <div id={panelId} className="rk-detail" style={{ padding: '2px 20px 20px 52px' }}>
          <div>
            <Label>Qué observó la IA</Label>
            {evidence
              ? <EvidenceBox text={evidence} bg="#fbfcfa" bd="#e7e9e4" />
              : <div style={{ marginTop: 8, fontSize: 13, color: '#8a9790' }}>
                  Todavía no hay auditoría registrada de este alumno.
                </div>}
          </div>
          <div style={{ display: 'grid', gap: 8, alignContent: 'start' }}>
            <button type="button" onClick={p.onDetail} style={btnGhost}>Ver detalle de la clase</button>
            <button
              type="button"
              onClick={p.onDone}
              disabled={p.busy || !row.hasProfile}
              title={row.hasProfile ? undefined : 'El alumno todavía no tiene ficha'}
              style={{ ...btnPrimary, opacity: p.busy || !row.hasProfile ? 0.5 : 1 }}
            >
              {p.busy ? 'Cerrando…' : 'Marcar como atendida'}
            </button>
            <button
              type="button"
              onClick={p.onIncident}
              disabled={!row.teacherId}
              style={{ ...btnDanger, opacity: row.teacherId ? 1 : 0.5 }}
            >
              Registrar incidencia
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Botones del desplegable ──────────────────────────────────────────────────
export const btnPrimary: CSSProperties = {
  background: '#12a04b', color: '#fff', border: 'none', borderRadius: 9,
  padding: '9px 13px', fontSize: 13, fontWeight: 800, fontFamily: 'inherit',
  textAlign: 'center', cursor: 'pointer', width: '100%',
};
export const btnGhost: CSSProperties = {
  background: '#fff', border: '1px solid #e2e5df', color: '#3f4c45', borderRadius: 9,
  padding: '9px 13px', fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
  textAlign: 'center', cursor: 'pointer', width: '100%',
};
export const btnDanger: CSSProperties = {
  background: '#fff', border: '1px solid #f3cfca', color: '#a52b23', borderRadius: 9,
  padding: '9px 13px', fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
  textAlign: 'center', cursor: 'pointer', width: '100%',
};
