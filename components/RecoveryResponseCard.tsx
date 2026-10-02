'use client';

// "No puedo dar esta clase", bloque B: el alumno dijo "Ninguna me viene bien" y
// propuso sus horarios (estado 'alumno_propuso'). Le toca al profesor:
//   · "Aceptar" junto a cada horario → queda confirmada en un solo paso
//     (/api/recuperaciones/[id]/aceptar, que comprueba que el hueco sigue libre);
//   · "Proponer otras 2 fechas" → el mismo selector del modal, ronda 2
//     (/api/recuperaciones/[id]/proponer).
// Se muestra arriba de "Mis clases" y encima del calendario del profesor. Solo
// profesores beta: quien lo monta pasa las recuperaciones de useTeacherRecoveries,
// que para el resto viene vacío.

import { useEffect, useRef, useState } from 'react';
import { fechaLarga } from '@/lib/classRecoveries';
import type { TeacherRecovery } from '@/lib/useTeacherRecoveries';
import { SlotPicker, NPD_CSS, cuando, type SlotInput } from '@/components/NoPuedoDarClaseModal';

const VERDE = '#1E9E3A';
const AMARILLO = '#FFC400';
const SUAVE = '#F7F7F5';

/** Las tarjetas de todas las recuperaciones que esperan respuesta del profesor. */
export function PendingRecoveriesPanel({ teacherId, recoveries, onChanged }: {
  teacherId: string;
  recoveries: TeacherRecovery[];
  /** Tras aceptar o proponer: recargar recuperaciones y calendario. */
  onChanged: (msg: string) => void | Promise<void>;
}) {
  const pendientes = recoveries.filter(r => r.status === 'alumno_propuso');
  if (pendientes.length === 0) return null;
  return (
    <div className="rc-wrap" role="region" aria-label="Recuperaciones que esperan tu respuesta">
      <style>{NPD_CSS + RC_CSS}</style>
      {pendientes.map(r => <RecoveryResponseCard key={r.id} teacherId={teacherId} recovery={r} onChanged={onChanged} />)}
    </div>
  );
}

function RecoveryResponseCard({ teacherId, recovery: r, onChanged }: {
  teacherId: string; recovery: TeacherRecovery; onChanged: (msg: string) => void | Promise<void>;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proponer, setProponer] = useState(false);

  async function aceptar(index: number) {
    if (busy !== null) return;
    setBusy(index); setError(null);
    try {
      const res = await fetch(`/api/recuperaciones/${encodeURIComponent(r.id)}/aceptar`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ teacherId, index }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.mensaje ?? 'No se pudo confirmar.'); return; }
      await onChanged(`✅ Recuperación confirmada con ${r.studentName} — le avisamos por email`);
    } catch {
      setError('No se pudo conectar con el servidor.');
    } finally {
      setBusy(null);
    }
  }

  const parte = r.parts > 1 ? ` · ${r.part}.ª hora` : r.hours > 1 ? ` · ${r.hours} h` : '';
  return (
    <div className="rc-card">
      <div className="rc-title">{r.studentName} no puede en las fechas que propusiste</div>
      <div className="rc-sub">Recuperación de la clase del {fechaLarga(r.originalDate)} · {r.originalHour}{parte}</div>
      {r.studentNote && <div className="rc-note">“{r.studentNote}”</div>}

      <div className="rc-label">Te propone:</div>
      <ul className="rc-list">
        {r.studentProposals.map((p, i) => (
          <li key={`${p.date}|${p.hour}`} className="rc-item">
            <span className="rc-when">{cuando(p)}</span>
            <button type="button" className="rc-accept" disabled={busy !== null} onClick={() => aceptar(i)}>
              {busy === i ? 'Guardando…' : 'Aceptar'}
            </button>
          </li>
        ))}
      </ul>
      {error && <div className="npd-warn">⚠️ {error}</div>}

      <button type="button" className="rc-other" disabled={busy !== null} onClick={() => { setError(null); setProponer(true); }}>
        Proponer otras 2 fechas
      </button>

      {proponer && (
        <ReproposeModal teacherId={teacherId} recovery={r}
          onClose={() => setProponer(false)}
          onDone={async msg => { setProponer(false); await onChanged(msg); }} />
      )}
    </div>
  );
}

/** Ronda 2: dos fechas nuevas con el mismo selector de días y horas libres. */
function ReproposeModal({ teacherId, recovery: r, onClose, onDone }: {
  teacherId: string; recovery: TeacherRecovery; onClose: () => void; onDone: (msg: string) => void | Promise<void>;
}) {
  const [freeSlots, setFreeSlots] = useState<Array<{ date: string; hours: string[] }> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [slots, setSlots] = useState<SlotInput[]>([{ date: '', hour: '' }, { date: '', hour: '' }]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    (async () => {
      try {
        const res = await fetch(`/api/recuperaciones/${encodeURIComponent(r.id)}/proponer?teacherId=${encodeURIComponent(teacherId)}`, { cache: 'no-store' });
        const data = await res.json();
        if (!res.ok) { setLoadError(data.mensaje ?? 'No se pudieron cargar tus horas libres.'); return; }
        setFreeSlots(data.freeSlots ?? []);
      } catch {
        setLoadError('No se pudo conectar con el servidor.');
      }
    })();
  }, [r.id, teacherId]);

  const completo = slots.every(s => s.date && s.hour);
  const falta = slots.findIndex(s => !s.date) >= 0
    ? `Elige el día de la opción ${slots.findIndex(s => !s.date) + 1}`
    : slots.findIndex(s => !s.hour) >= 0 ? `Elige la hora de la opción ${slots.findIndex(s => !s.hour) + 1}` : null;
  const taken = (i: number) => new Set(slots.filter((s, j) => j !== i && s.date && s.hour).map(s => `${s.date}|${s.hour}`));

  async function enviar() {
    if (!completo || saving) return;
    setSaving(true); setSaveError(null);
    try {
      const res = await fetch(`/api/recuperaciones/${encodeURIComponent(r.id)}/proponer`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ teacherId, proposals: slots }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setSaveError(data.mensaje ?? 'No se pudieron enviar las fechas.'); return; }
      await onDone(`✅ Fechas enviadas a ${r.studentName}: elegirá una por email`);
    } catch {
      setSaveError('No se pudo conectar con el servidor.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="npd-overlay" onClick={e => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div className="npd-modal" role="dialog" aria-modal="true" aria-labelledby="rc-title">
        <div id="rc-title" className="npd-title">Proponer otras 2 fechas</div>
        <div className="npd-sub">
          Recuperación de la clase con {r.studentName} del {fechaLarga(r.originalDate)} · {r.originalHour}{r.hours > 1 ? ` · ${r.hours} h` : ''}
        </div>
        <div className="npd-muted npd-help">
          {r.studentName} elegirá una de las dos por email. Es la última ronda: si tampoco puede, el equipo coordinará la fecha.
        </div>

        {!freeSlots && !loadError && <div className="npd-muted">Cargando tus horas libres…</div>}
        {loadError && <div className="npd-box npd-box-rojo">{loadError}</div>}
        {freeSlots && slots.map((s, i) => (
          <SlotPicker key={i} label={`Opción ${i + 1}`} showZone={i === 0} value={s} freeSlots={freeSlots}
            taken={taken(i)} problems={[]}
            onChange={patch => setSlots(prev => prev.map((x, j) => (j === i ? { ...x, ...patch } : x)))} />
        ))}

        {completo && (
          <div className="npd-box npd-box-suave">
            {r.studentName} recibirá un email para elegir: <b>{cuando(slots[0])}</b> o <b>{cuando(slots[1])}</b>{r.hours > 1 ? ' (2 h)' : ''}
          </div>
        )}
        {saveError && <div className="npd-box npd-box-rojo">{saveError}</div>}

        {freeSlots && !saving && <div className="npd-falta" aria-live="polite">{falta ?? ''}</div>}
        <div className="npd-actions">
          <button type="button" className="npd-btn npd-btn-sec" onClick={onClose} disabled={saving}>Volver</button>
          <button type="button" className="npd-btn npd-btn-pri" onClick={enviar} disabled={!completo || saving || !freeSlots}>
            {saving ? 'Enviando…' : 'Enviar fechas al alumno'}
          </button>
        </div>
      </div>
    </div>
  );
}

const RC_CSS = `
.rc-wrap { display: flex; flex-direction: column; gap: 10px; margin: 0 0 14px; font-family: var(--font-app); }
.rc-card { background: ${SUAVE}; border: 1px solid var(--border); border-left: 4px solid ${AMARILLO}; border-radius: 12px;
  padding: 14px 16px; color: var(--text-primary); }
.rc-title { font-weight: 700; font-size: 15px; line-height: 1.3; }
.rc-sub { font-size: 12.5px; color: var(--text-secondary); margin-top: 2px; }
.rc-note { font-size: 13px; font-style: italic; color: var(--text-secondary); margin-top: 8px; padding-left: 10px;
  border-left: 2px solid var(--border-light); line-height: 1.4; }
.rc-label { font-size: 12.5px; font-weight: 700; color: var(--text-secondary); margin: 10px 0 6px; }
.rc-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.rc-item { display: flex; align-items: center; justify-content: space-between; gap: 10px; background: var(--bg-surface);
  border: 1px solid var(--border); border-radius: 9px; padding: 6px 6px 6px 12px; }
.rc-when { font-size: 14px; font-weight: 600; }
.rc-accept { flex: 0 0 auto; min-height: 38px; padding: 6px 16px; border-radius: 8px; border: none; background: ${VERDE};
  color: #fff; font: inherit; font-size: 13.5px; font-weight: 700; cursor: pointer; }
.rc-accept:disabled { opacity: 0.6; cursor: not-allowed; }
.rc-other { margin-top: 10px; min-height: 40px; padding: 8px 14px; border-radius: 9px; border: 1.5px solid ${VERDE};
  background: transparent; color: ${VERDE}; font: inherit; font-size: 13.5px; font-weight: 700; cursor: pointer; }
.rc-other:disabled { opacity: 0.6; cursor: not-allowed; }
@media (max-width: 480px) {
  .rc-item { flex-wrap: wrap; }
  .rc-accept { min-height: 44px; }
  .rc-other { width: 100%; min-height: 44px; }
}
`;
