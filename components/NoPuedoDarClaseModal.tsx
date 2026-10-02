'use client';

// Modal "No puedo dar esta clase" (profesores beta, ver RECOVERY_BETA_TEACHERS).
//
// El profesor propone 2 fechas para recuperarla (o 1 si ya lo acordó con el
// alumno). TODO lo que decide —antelación, comodines, multa, si las fechas
// valen, qué horas están libres— lo calcula el SERVIDOR
// (/api/recuperaciones/preview); esta pantalla solo lo muestra y manda lo que
// el profesor eligió a /api/recuperaciones/cancelar.
//
// Pensado para el teléfono: una sola columna, días y horas como botones que
// pasan de línea, sin campos de fecha nativos. Estilos en línea + un <style>
// con prefijo npd- para lo que necesita media query o :hover.

import { useEffect, useRef, useState } from 'react';
import { fechaLarga } from '@/lib/classRecoveries';
import { fmtDateDMY } from '@/lib/teacherClasses';

interface Preview {
  noticeMinutes: number;
  late: boolean;
  sessionHours: number;
  canSplit: boolean;
  wildcard: { position: number | null; usedWildcard: boolean; wildcardsLeft: number; penaltyApplies: boolean; chargeNow: boolean; wouldHavePenalty: boolean };
  wildcardsTotal: number;
  penaltyStartDate: string;
  penaltyEuros: number;
  noShowPenaltyEuros: number;
  alreadyCancelled: string | null;
  proposalProblems?: Array<{ general: string[]; perSlot: string[][] }>;
  freeSlots?: Array<{ date: string; hours: string[] }>;
}

export type SlotInput = { date: string; hour: string };
const empty = (): SlotInput => ({ date: '', hour: '' });

const VERDE = '#1E9E3A';
const AMARILLO = '#FFC400';
const SUAVE = '#F7F7F5';
const DIAS_CORTOS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function dow(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
/** '2026-10-06' → 'Mar 6' (botón). */
const diaBoton = (iso: string) => `${DIAS_CORTOS[dow(iso)]} ${Number(iso.slice(8, 10))}`;
/** '2026-10-06' → 'martes 6' (frases). */
const diaFrase = (iso: string) => `${DIAS[dow(iso)]} ${Number(iso.slice(8, 10))}`;
export const cuando = (s: SlotInput) => `${diaFrase(s.date)} a las ${s.hour}`;
const keyOf = (s: SlotInput) => `${s.date}|${s.hour}`;

function antelacion(min: number): string {
  const h = Math.floor(min / 60);
  if (h >= 48) return `${Math.floor(h / 24)} días`;
  if (h >= 1) return `${h} h`;
  return `${min} min`;
}

export default function NoPuedoDarClaseModal({ teacherId, assignmentId, studentName, date, hour, onClose, onDone }: {
  teacherId: string; assignmentId: string; studentName: string; date: string; hour: string;
  /** Se conserva por compatibilidad: los días posibles los decide el servidor. */
  todayIso?: string;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [split, setSplit] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonOpen, setReasonOpen] = useState(false);
  // Una lista por trozo (1 o 2), cada una con 2 fechas (o 1 si "ya lo acordé").
  const [parts, setParts] = useState<SlotInput[][]>([[empty(), empty()], [empty(), empty()]]);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const nParts = split && preview?.canSplit ? 2 : 1;
  const perPart = agreed ? 1 : 2;
  // Horas libres por día, según el servidor. Una hora elegida que deja de estar
  // libre (p. ej. al partir una clase de 2 h) cuenta como no elegida.
  const freeByDate = new Map((preview?.freeSlots ?? []).map(d => [d.date, d.hours]));
  const vigente = (s: SlotInput): SlotInput =>
    s.hour && preview?.freeSlots && !(freeByDate.get(s.date) ?? []).includes(s.hour) ? { ...s, hour: '' } : s;
  const vista = parts.map(p => p.map(vigente));
  const usados = vista.slice(0, nParts).map(p => p.slice(0, perPart));
  const completo = usados.every(p => p.every(s => s.date && s.hour));
  // Como texto: la vista previa solo se vuelve a pedir cuando cambia lo elegido.
  const payloadJson = JSON.stringify({
    teacherId, assignmentId, date, hour, agreedDirectly: agreed, split: nParts === 2,
    proposals: completo ? usados : undefined,
  });

  // Vista previa del servidor: al abrir y cada vez que cambian las fechas.
  const seq = useRef(0);
  const hayPreview = !!preview;
  useEffect(() => {
    const n = ++seq.current;
    const t = setTimeout(async () => {
      setChecking(true);
      try {
        const res = await fetch('/api/recuperaciones/preview', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payloadJson,
        });
        const data = await res.json();
        if (n !== seq.current) return;
        if (!res.ok) { setLoadError(data.mensaje ?? 'No se pudo calcular.'); return; }
        setPreview(data); setLoadError(null);
      } catch {
        if (n === seq.current) setLoadError('No se pudo conectar con el servidor.');
      } finally {
        if (n === seq.current) setChecking(false);
      }
    }, hayPreview ? 350 : 0);
    return () => clearTimeout(t);
  }, [payloadJson]); // eslint-disable-line react-hooks/exhaustive-deps

  const problems = preview?.proposalProblems;
  const sinProblemas = !!problems && problems.every(p => p.general.length === 0 && p.perSlot.every(s => s.length === 0));
  const canConfirm = !!preview && !preview.alreadyCancelled && completo && sinProblemas && !checking && !saving;

  function setSlot(pi: number, si: number, patch: Partial<SlotInput>) {
    setParts(prev => prev.map((p, i) => i !== pi ? p : p.map((s, j) => (j === si ? { ...s, ...patch } : s))));
  }

  async function confirmar() {
    if (!canConfirm) return;
    setSaving(true); setSaveError(null);
    try {
      const res = await fetch('/api/recuperaciones/cancelar', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...JSON.parse(payloadJson), proposals: usados, reason }),
      });
      const data = await res.json();
      if (!res.ok) { setSaveError(data.mensaje ?? 'No se pudo cancelar la clase.'); return; }
      onDone(agreed
        ? '✅ Clase cancelada y recuperación confirmada'
        : `✅ Clase cancelada — ${studentName} elegirá la fecha${data.emailSent ? ' (le avisamos por email)' : ''}`);
    } catch {
      setSaveError('No se pudo conectar con el servidor.');
    } finally {
      setSaving(false);
    }
  }

  // ── Textos ────────────────────────────────────────────────────────────────
  const nombreParte = (pi: number) => (pi === 0 ? 'primera hora' : 'segunda hora');
  const nombreOpcion = (pi: number, si: number) => {
    const op = agreed ? '' : `opción ${si + 1}`;
    if (nParts === 2) return agreed ? `la ${nombreParte(pi)}` : `la ${nombreParte(pi)} · ${op}`;
    return agreed ? 'la fecha acordada' : `la ${op}`;
  };
  /** Qué falta, de a una cosa y en orden. null si está todo. */
  const falta = (() => {
    for (let pi = 0; pi < nParts; pi++) {
      for (let si = 0; si < perPart; si++) {
        const s = vista[pi][si];
        if (!s.date) return `Elige el día de ${nombreOpcion(pi, si)}`;
        if (!s.hour) return `Elige la hora de ${nombreOpcion(pi, si)}`;
      }
    }
    return null;
  })();
  const dosHorasJuntas = preview?.sessionHours === 2 && nParts === 1;
  const sufijo = dosHorasJuntas ? ' (2 h)' : '';

  const w = preview?.wildcard;
  const listo = !!preview && !preview.alreadyCancelled;
  const ocupados = (pi: number, si: number) =>
    new Set(usados.flatMap((p, i) => p.filter((_, j) => !(i === pi && j === si)).filter(s => s.date && s.hour).map(keyOf)));

  return (
    <div className="npd-overlay" onClick={e => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <style>{NPD_CSS}</style>
      <div className="npd-modal" role="dialog" aria-modal="true" aria-labelledby="npd-title">
        {/* 1. Cabecera */}
        <div id="npd-title" className="npd-title">No puedo dar esta clase</div>
        <div className="npd-sub">
          Clase con {studentName} · {fechaLarga(date)} · {hour}{preview && preview.sessionHours > 1 ? ` · ${preview.sessionHours} h` : ''}
        </div>

        {!preview && !loadError && <div className="npd-muted">Calculando…</div>}
        {loadError && <div className="npd-box npd-box-rojo">{loadError}</div>}
        {preview?.alreadyCancelled && <div className="npd-box npd-box-rojo">{preview.alreadyCancelled}</div>}

        {/* 2. Coste, calculado por el servidor */}
        {listo && w && (
          !preview.late ? (
            <div className="npd-box npd-box-verde"><b>Sin coste:</b> avisas con {antelacion(preview.noticeMinutes)} de antelación.</div>
          ) : !w.penaltyApplies ? (
            <div className="npd-box npd-box-amarillo">
              <b>Usa 1 comodín</b> · {w.wildcardsLeft === 0 ? 'no te queda ninguno' : w.wildcardsLeft === 1 ? 'te queda 1' : `te quedan ${w.wildcardsLeft}`} este mes
              <div className="npd-box-nota">Avisas con menos de 24 h ({antelacion(preview.noticeMinutes)}).</div>
            </div>
          ) : w.chargeNow ? (
            <div className="npd-box npd-box-rojo">
              <b>Esta cancelación cuesta {preview.penaltyEuros} €</b>
              <div className="npd-box-nota">Menos de 24 h y ya usaste tus {preview.wildcardsTotal} comodines de este mes.</div>
            </div>
          ) : (
            <div className="npd-box npd-box-rojo">
              <b>Te costaría {preview.penaltyEuros} € a partir del {fmtDateDMY(preview.penaltyStartDate).slice(0, 5)}</b>
              <div className="npd-box-nota">Menos de 24 h y ya usaste tus {preview.wildcardsTotal} comodines de este mes. Hasta esa fecha no se cobra.</div>
            </div>
          )
        )}

        {listo && (
          <>
            {/* 3. Modo */}
            <div className="npd-tabs" role="tablist" aria-label="Cómo recuperarla">
              <button type="button" role="tab" aria-selected={!agreed} className={`npd-tab${!agreed ? ' is-on' : ''}`} onClick={() => setAgreed(false)}>Proponer 2 fechas</button>
              <button type="button" role="tab" aria-selected={agreed} className={`npd-tab${agreed ? ' is-on' : ''}`} onClick={() => setAgreed(true)}>Ya lo acordé con el alumno</button>
            </div>
            <div className="npd-muted npd-help">
              {agreed
                ? 'Queda confirmada directamente, sin que el alumno elija.'
                : `${studentName} elegirá una de las dos por email. Cualquier día de los próximos 7 días, de lunes a sábado.`}
            </div>

            {/* 5. Sesión de 2 h */}
            {preview.canSplit && (
              <label className="npd-check">
                <input type="checkbox" checked={split} onChange={e => setSplit(e.target.checked)} />
                <span>
                  <b>Recuperar en dos días diferentes</b>
                  <span className="npd-check-sub">Es una clase de 2 h: se recupera en dos clases de 1 h, con su transcript cada una.</span>
                </span>
              </label>
            )}

            {/* 4. Fechas */}
            {Array.from({ length: nParts }, (_, pi) => (
              <div key={pi} className="npd-part">
                {nParts === 2 && <div className="npd-part-title">{pi === 0 ? 'Primera hora' : 'Segunda hora'}</div>}
                {Array.from({ length: perPart }, (_, si) => (
                  <SlotPicker key={si}
                    label={agreed ? 'Fecha acordada' : `Opción ${si + 1}`}
                    showZone={pi === 0 && si === 0}
                    value={vista[pi][si]}
                    freeSlots={preview.freeSlots ?? []}
                    taken={ocupados(pi, si)}
                    problems={completo ? (problems?.[pi]?.perSlot?.[si] ?? []) : []}
                    onChange={patch => setSlot(pi, si, patch)}
                  />
                ))}
                {completo && (problems?.[pi]?.general ?? []).map((e, i) => <div key={i} className="npd-warn">⚠️ {e}</div>)}
              </div>
            ))}

            {/* 6. Vista previa */}
            {completo && (
              <div className="npd-box npd-box-suave">
                {agreed ? (
                  nParts === 1
                    ? <>Quedará confirmada: <b>{cuando(usados[0][0])}{sufijo}</b></>
                    : <>Quedarán confirmadas: <b>{cuando(usados[0][0])}</b> y <b>{cuando(usados[1][0])}</b></>
                ) : nParts === 1 ? (
                  <>{studentName} recibirá un email para elegir: <b>{cuando(usados[0][0])}</b> o <b>{cuando(usados[0][1])}</b>{sufijo}</>
                ) : (
                  <>
                    {studentName} recibirá un email para elegir:
                    <div className="npd-preview-line">1.ª hora: <b>{cuando(usados[0][0])}</b> o <b>{cuando(usados[0][1])}</b></div>
                    <div className="npd-preview-line">2.ª hora: <b>{cuando(usados[1][0])}</b> o <b>{cuando(usados[1][1])}</b></div>
                  </>
                )}
              </div>
            )}

            {/* 7. Motivo, plegado */}
            <button type="button" className="npd-link" aria-expanded={reasonOpen} onClick={() => setReasonOpen(v => !v)}>
              {reasonOpen ? '▾' : '▸'} Añadir motivo <span className="npd-link-sub">(opcional, solo lo ve el equipo)</span>
            </button>
            {reasonOpen && (
              <textarea className="npd-textarea" value={reason} onChange={e => setReason(e.target.value)} rows={2} placeholder="Por ejemplo: médico, corte de luz…" aria-label="Motivo" />
            )}
          </>
        )}

        {saveError && <div className="npd-box npd-box-rojo">{saveError}</div>}

        {/* 8. Botones */}
        {listo && !saving && (
          <div className="npd-falta" aria-live="polite">
            {falta ?? (checking ? 'Comprobando las fechas…' : !sinProblemas ? 'Revisa las fechas marcadas.' : '')}
          </div>
        )}
        <div className="npd-actions">
          <button type="button" className="npd-btn npd-btn-sec" onClick={onClose} disabled={saving}>Volver</button>
          {listo && (
            <button type="button" className="npd-btn npd-btn-pri" onClick={confirmar} disabled={!canConfirm}>
              {saving ? 'Guardando…' : agreed ? 'Confirmar recuperación' : 'Enviar fechas al alumno'}
            </button>
          )}
        </div>

        {listo && (
          <div className="npd-pie">Si no cancelas la clase y no te presentas, la penalización es de {preview.noShowPenaltyEuros} €.</div>
        )}
      </div>
    </div>
  );
}

/**
 * Un hueco: botones de día y, al elegir el día, sus horas libres. Lo usa
 * también la tarjeta "Proponer otras 2 fechas" (RecoveryResponseCard); necesita
 * el CSS de este archivo (NPD_CSS) en la página.
 */
export function SlotPicker({ label, showZone, value, freeSlots, taken, problems, onChange }: {
  label: string;
  showZone: boolean;
  value: SlotInput;
  freeSlots: Array<{ date: string; hours: string[] }>;
  /** Fecha|hora ya elegidas en las otras opciones: no se pueden repetir. */
  taken: Set<string>;
  problems: string[];
  onChange: (patch: Partial<SlotInput>) => void;
}) {
  const horas = freeSlots.find(d => d.date === value.date)?.hours ?? [];
  return (
    <div className="npd-slot">
      <div className="npd-slot-label">{label}{showZone && <span className="npd-zone"> · hora de España 🇪🇸</span>}</div>
      <div className="npd-chips" role="group" aria-label={`${label}: día`}>
        {freeSlots.map(d => {
          const sinHuecos = d.hours.length === 0;
          const on = value.date === d.date;
          return (
            <button key={d.date} type="button" disabled={sinHuecos} aria-pressed={on}
              className={`npd-chip${on ? ' is-on' : ''}`}
              onClick={() => onChange({ date: d.date, hour: value.date === d.date ? value.hour : '' })}>
              {diaBoton(d.date)}
              {sinHuecos && <span className="npd-chip-sub">sin huecos</span>}
            </button>
          );
        })}
      </div>
      {value.date && (
        horas.length === 0
          ? <div className="npd-muted">Ese día no te quedan horas libres.</div>
          : (
            <div className="npd-chips npd-chips-horas" role="group" aria-label={`${label}: hora`}>
              {horas.map(h => {
                const usada = taken.has(`${value.date}|${h}`);
                const on = value.hour === h;
                return (
                  <button key={h} type="button" disabled={usada} aria-pressed={on}
                    title={usada ? 'Ya la elegiste en otra opción' : undefined}
                    className={`npd-chip npd-chip-hora${on ? ' is-on' : ''}`}
                    onClick={() => onChange({ hour: h })}>
                    {h}
                  </button>
                );
              })}
            </div>
          )
      )}
      {problems.map((e, i) => <div key={i} className="npd-warn">⚠️ {e}</div>)}
    </div>
  );
}

export const NPD_CSS = `
.npd-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px); z-index: 85;
  display: flex; align-items: center; justify-content: center; padding: 16px; font-family: var(--font-app); }
.npd-modal { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 14px; padding: 22px;
  width: 100%; max-width: 480px; max-height: 92vh; overflow-y: auto; box-sizing: border-box; color: var(--text-primary); }
.npd-title { font-weight: 700; font-size: 18px; line-height: 1.25; }
.npd-sub { font-size: 13.5px; color: var(--text-secondary); margin: 4px 0 14px; line-height: 1.4; }
.npd-muted { font-size: 12.5px; color: var(--text-muted); line-height: 1.45; }
.npd-help { margin: 8px 0 12px; }

.npd-box { font-size: 13.5px; line-height: 1.45; border-radius: 10px; padding: 11px 13px; margin-bottom: 14px; border: 1px solid; }
.npd-box-nota { font-size: 12px; margin-top: 2px; opacity: 0.85; }
.npd-box-verde { background: rgba(30,158,58,0.08); border-color: rgba(30,158,58,0.35); color: #17692b; }
.npd-box-amarillo { background: rgba(255,196,0,0.16); border-color: ${AMARILLO}; color: #6b4a00; }
.npd-box-rojo { background: rgba(200,30,30,0.06); border-color: rgba(200,30,30,0.35); color: #b42318; }
.npd-box-suave { background: ${SUAVE}; border-color: var(--border); color: var(--text-primary); }
.npd-preview-line { margin-top: 3px; }

.npd-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; padding: 4px; background: ${SUAVE};
  border: 1px solid var(--border); border-radius: 10px; }
.npd-tab { border: none; background: transparent; border-radius: 7px; padding: 9px 8px; font: inherit; font-size: 13px;
  font-weight: 600; color: var(--text-secondary); cursor: pointer; line-height: 1.25; }
.npd-tab.is-on { background: var(--bg-surface); color: ${VERDE}; box-shadow: 0 1px 3px rgba(0,0,0,0.12); }

.npd-check { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; margin: 0 0 14px; cursor: pointer;
  border: 1px solid var(--border); border-radius: 10px; background: ${SUAVE};
  font-size: 13.5px; font-weight: 400; color: var(--text-primary); line-height: 1.35; }
.npd-check input { flex: 0 0 auto; width: 18px; height: 18px; margin: 1px 0 0; padding: 0; accent-color: ${VERDE}; cursor: pointer; }
.npd-check-sub { display: block; font-size: 12px; color: var(--text-muted); margin-top: 2px; }

.npd-part { margin-bottom: 4px; }
.npd-part-title { font-size: 13px; font-weight: 700; color: var(--text-primary); margin: 4px 0 8px;
  padding-bottom: 4px; border-bottom: 1px solid var(--border); }
.npd-slot { margin-bottom: 14px; }
.npd-slot-label { font-size: 12.5px; font-weight: 700; color: var(--text-secondary); margin-bottom: 7px; }
.npd-zone { font-weight: 500; color: var(--text-muted); }
.npd-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.npd-chips-horas { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--border); }
.npd-chip { display: inline-flex; flex-direction: column; align-items: center; justify-content: center; min-width: 58px;
  min-height: 40px; padding: 6px 10px; border-radius: 9px; border: 1.5px solid var(--border); background: var(--bg-surface);
  color: var(--text-primary); font: inherit; font-size: 13.5px; font-weight: 600; cursor: pointer; line-height: 1.1; }
.npd-chip:hover:not(:disabled) { border-color: ${VERDE}; }
.npd-chip.is-on { border-color: ${VERDE}; background: rgba(30,158,58,0.1); color: ${VERDE}; }
.npd-chip:disabled { opacity: 0.45; cursor: not-allowed; background: ${SUAVE}; }
.npd-chip-hora:disabled { text-decoration: line-through; }
.npd-chip-sub { font-size: 10px; font-weight: 500; color: var(--text-muted); margin-top: 2px; }
.npd-warn { font-size: 12px; color: #8a5a00; background: rgba(255,196,0,0.14); border-left: 3px solid ${AMARILLO};
  padding: 5px 8px; border-radius: 4px; margin-top: 6px; line-height: 1.4; }

.npd-link { display: block; border: none; background: none; padding: 4px 0; margin: 2px 0 8px; font: inherit; font-size: 13px;
  font-weight: 600; color: var(--text-secondary); cursor: pointer; text-align: left; }
.npd-link-sub { font-weight: 400; color: var(--text-muted); }
.npd-textarea { width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 8px; border: 1.5px solid var(--border);
  background: ${SUAVE}; color: var(--text-primary); font: inherit; font-size: 13px; resize: vertical; margin-bottom: 10px; }

.npd-falta { min-height: 18px; font-size: 12.5px; color: var(--text-muted); text-align: right; margin: 6px 0 8px; }
.npd-actions { display: flex; gap: 10px; }
.npd-btn { min-height: 44px; padding: 10px 14px; border-radius: 9px; font: inherit; font-size: 14px; cursor: pointer; }
.npd-btn-sec { flex: 1; border: 1px solid var(--border); background: transparent; color: var(--text-secondary); }
.npd-btn-pri { flex: 2; border: none; background: ${VERDE}; color: #fff; font-weight: 700; }
.npd-btn:disabled { cursor: not-allowed; }
.npd-btn-pri:disabled { background: var(--bg-surface-3); color: var(--text-muted); }
.npd-pie { font-size: 11.5px; color: var(--text-muted); text-align: center; margin-top: 14px; line-height: 1.4; }

@media (max-width: 480px) {
  .npd-overlay { padding: 8px; align-items: flex-end; }
  .npd-modal { padding: 18px 16px; max-height: 94vh; border-radius: 16px 16px 12px 12px; }
  .npd-falta { text-align: left; }
  .npd-actions { flex-direction: column-reverse; }
  .npd-btn-sec, .npd-btn-pri { flex: none; width: 100%; }
  .npd-chip { min-width: 0; flex: 0 0 calc((100% - 18px) / 4); min-height: 44px; }
}
`;
