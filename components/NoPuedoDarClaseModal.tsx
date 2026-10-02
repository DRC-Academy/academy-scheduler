'use client';

// Modal "No puedo dar esta clase" (profesores beta, ver RECOVERY_BETA_TEACHERS).
//
// El profesor propone 2 fechas para recuperarla (o 1 si ya lo acordó con el
// alumno). TODO lo que decide —antelación, comodines, multa, si las fechas
// valen— lo calcula el SERVIDOR (/api/recuperaciones/preview); esta pantalla
// solo lo muestra y manda lo que el profesor eligió a /api/recuperaciones/cancelar.

import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtDateDMY, addDaysIso } from '@/lib/teacherClasses';

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
}

type SlotInput = { date: string; hour: string };
const HOURS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);
const empty = (): SlotInput => ({ date: '', hour: '' });

function horasYMinutos(min: number): string {
  const h = Math.floor(min / 60);
  if (h >= 48) return `${Math.floor(h / 24)} días`;
  return h >= 1 ? `${h} h ${min % 60} min` : `${min} min`;
}

export default function NoPuedoDarClaseModal({ teacherId, assignmentId, studentName, date, hour, todayIso, onClose, onDone }: {
  teacherId: string; assignmentId: string; studentName: string; date: string; hour: string; todayIso: string;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [split, setSplit] = useState(false);
  const [reason, setReason] = useState('');
  // Una lista por trozo (1 o 2), cada una con 2 fechas (o 1 si "ya lo acordé").
  const [parts, setParts] = useState<SlotInput[][]>([[empty(), empty()], [empty(), empty()]]);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const nParts = split && preview?.canSplit ? 2 : 1;
  const perPart = agreed ? 1 : 2;
  const usados = parts.slice(0, nParts).map(p => p.slice(0, perPart));
  const completo = usados.every(p => p.every(s => s.date && s.hour));
  // Las fechas como texto: el payload solo cambia cuando cambia lo que se eligió.
  const usadosKey = JSON.stringify(usados);
  const payload = useMemo(() => ({
    teacherId, assignmentId, date, hour, agreedDirectly: agreed, split: nParts === 2,
    proposals: completo ? (JSON.parse(usadosKey) as SlotInput[][]) : undefined,
  }), [teacherId, assignmentId, date, hour, agreed, nParts, completo, usadosKey]);

  // Vista previa del servidor: al abrir y cada vez que cambian las fechas.
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    const t = setTimeout(async () => {
      setChecking(true);
      try {
        const res = await fetch('/api/recuperaciones/preview', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
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
    }, preview ? 350 : 0);
    return () => clearTimeout(t);
  }, [payload]); // eslint-disable-line react-hooks/exhaustive-deps

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
        body: JSON.stringify({ ...payload, proposals: usados, reason }),
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

  const w = preview?.wildcard;
  const maxDate = addDaysIso(todayIso, 7);
  const box = (bg: string, border: string, color: string) => ({
    fontSize: 12.5, color, background: bg, border: `1px solid ${border}`, borderRadius: 8, padding: '10px 12px', marginBottom: 12, lineHeight: 1.5,
  });
  const fechaInicio = preview ? fmtDateDMY(preview.penaltyStartDate) : '';

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 85, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 22, width: '100%', maxWidth: 460, maxHeight: '92vh', overflowY: 'auto' }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', marginBottom: 4 }}>No puedo dar esta clase</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 14 }}>{studentName} — {fmtDateDMY(date)} {hour}{preview && preview.sessionHours > 1 ? ` · ${preview.sessionHours} h` : ''}</div>

        {!preview && !loadError && <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>Calculando…</div>}
        {loadError && <div style={box('rgba(200,30,30,0.06)', 'rgba(200,30,30,0.35)', '#b42318')}>{loadError}</div>}
        {preview?.alreadyCancelled && <div style={box('rgba(200,30,30,0.06)', 'rgba(200,30,30,0.35)', '#b42318')}>{preview.alreadyCancelled}</div>}

        {/* Lo que cuesta, calculado por el servidor. */}
        {preview && w && !preview.alreadyCancelled && (
          !preview.late ? (
            <div style={box('rgba(30,158,58,0.08)', 'rgba(30,158,58,0.3)', '#1f7a3d')}>
              <b>Con antelación: sin coste.</b> Faltan {horasYMinutos(preview.noticeMinutes)} para la clase, así que no gasta comodín.
            </div>
          ) : !w.penaltyApplies ? (
            <div style={box('rgba(255,196,0,0.14)', 'rgba(255,196,0,0.5)', '#8a5a00')}>
              <b>Menos de 24 h: gastas un comodín.</b> Faltan {horasYMinutos(preview.noticeMinutes)}. Te {w.wildcardsLeft === 1 ? 'queda 1 comodín' : `quedan ${w.wildcardsLeft} comodines`} de {preview.wildcardsTotal} este mes.
            </div>
          ) : w.chargeNow ? (
            <div style={box('rgba(200,30,30,0.06)', 'rgba(200,30,30,0.35)', '#b42318')}>
              <b>Menos de 24 h y sin comodines: esta cancelación cuesta {preview.penaltyEuros} €.</b> Ya usaste tus {preview.wildcardsTotal} comodines de este mes.
            </div>
          ) : (
            <div style={box('rgba(255,196,0,0.14)', 'rgba(255,196,0,0.5)', '#8a5a00')}>
              <b>Esta cancelación te costaría {preview.penaltyEuros} €.</b> Ya usaste tus {preview.wildcardsTotal} comodines de este mes. Hasta el {fechaInicio} no se cobra; desde esa fecha, sí.
            </div>
          )
        )}

        {preview && !preview.alreadyCancelled && (
          <div style={{ ...box('var(--bg-surface-2)', 'var(--border)', 'var(--text-secondary)'), fontSize: 12 }}>
            ⚠️ Si no cancelas la clase y simplemente no te presentas, la penalización es el doble: {preview.noShowPenaltyEuros} euros.
          </div>
        )}

        {preview && !preview.alreadyCancelled && (
          <>
            <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', fontSize: 13, color: 'var(--text-primary)', marginBottom: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} style={{ marginTop: 2 }} />
              <span><b>Ya lo acordé con el alumno</b><span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-muted)' }}>Pones una sola fecha y queda confirmada, sin que el alumno elija.</span></span>
            </label>
            {preview.canSplit && (
              <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', fontSize: 13, color: 'var(--text-primary)', marginBottom: 12, cursor: 'pointer' }}>
                <input type="checkbox" checked={split} onChange={e => setSplit(e.target.checked)} style={{ marginTop: 2 }} />
                <span><b>Recuperar en dos días diferentes</b><span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-muted)' }}>Es una clase de 2 h: se recupera en dos clases de 1 h, con su transcript cada una.</span></span>
              </label>
            )}

            {Array.from({ length: nParts }, (_, pi) => (
              <div key={pi} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6 }}>
                  {nParts === 2 ? (pi === 0 ? 'Primera hora' : 'Segunda hora') : agreed ? 'Fecha acordada' : 'Propón dos fechas (hora de España 🇪🇸)'}
                  {nParts === 2 && !agreed ? ' — dos opciones' : ''}
                </div>
                {Array.from({ length: perPart }, (_, si) => {
                  const s = parts[pi][si];
                  const errs = problems?.[pi]?.perSlot?.[si] ?? [];
                  return (
                    <div key={si} style={{ marginBottom: 8 }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px', gap: 8 }}>
                        <input type="date" value={s.date} min={todayIso} max={maxDate} onChange={e => setSlot(pi, si, { date: e.target.value })} style={{ width: '100%' }} aria-label={`Fecha ${si + 1}`} />
                        <select value={s.hour} onChange={e => setSlot(pi, si, { hour: e.target.value })} aria-label={`Hora ${si + 1}`}>
                          <option value="">Hora</option>
                          {HOURS.map(h => <option key={h} value={h}>{h}</option>)}
                        </select>
                      </div>
                      {completo && errs.map((e, i) => <div key={i} style={{ fontSize: 11.5, color: '#b45309', marginTop: 4 }}>⚠️ {e}</div>)}
                    </div>
                  );
                })}
                {completo && (problems?.[pi]?.general ?? []).map((e, i) => <div key={i} style={{ fontSize: 11.5, color: '#b45309' }}>⚠️ {e}</div>)}
              </div>
            ))}
            {!completo && (
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 12 }}>
                {agreed ? 'Indica la fecha acordada.' : 'Las dos fechas son obligatorias: el alumno elegirá una. Pueden ser cualquier día de los próximos 7 (de lunes a sábado).'}
              </div>
            )}

            <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Motivo (opcional, solo lo ve el equipo)</label>
            <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2}
              style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1.5px solid var(--border)', background: 'var(--bg-surface-2)', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', resize: 'vertical', marginBottom: 14 }} />
          </>
        )}

        {saveError && <div style={box('rgba(200,30,30,0.06)', 'rgba(200,30,30,0.35)', '#b42318')}>{saveError}</div>}

        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose} disabled={saving} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: saving ? 'not-allowed' : 'pointer', fontSize: 13, fontFamily: 'inherit' }}>Cerrar</button>
          <button onClick={confirmar} disabled={!canConfirm}
            style={{ flex: 2, padding: '10px', borderRadius: 8, border: 'none', background: canConfirm ? '#1E9E3A' : 'var(--bg-surface-3)', color: canConfirm ? 'white' : 'var(--text-muted)', cursor: canConfirm ? 'pointer' : 'not-allowed', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
            {saving ? 'Guardando…' : checking && completo ? 'Comprobando…' : agreed ? 'Cancelar y confirmar la fecha' : 'Cancelar y enviar las fechas'}
          </button>
        </div>
      </div>
    </div>
  );
}
