'use client';

// Pestaña "Recuperaciones" del admin: todas las filas de class_recoveries
// ("No puedo dar esta clase" y reclasificaciones del admin), con filtros por
// estado, profesor y mes. Arriba, lo que necesita a alguien del equipo:
//   · 'sin_acuerdo' (el alumno conserva la clase y hay que coordinar la fecha;
//     más adelante se avisará a Hugo);
//   · 'confirmada' con la fecha ya pasada (el chequeo nocturno no encontró
//     ingreso: o la clase no se dio o falta el ingreso).
// "Anular" pide un motivo obligatorio y queda guardado con quién y cuándo.
//
// Tarjetas y no tabla: sin scroll lateral en el teléfono (como Registro de clases).

import { useState } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { fechaLarga } from '@/lib/classRecoveries';
import { useAdminRecoveries, type AdminRecovery } from '@/lib/useTeacherRecoveries';

const AMARILLO = '#FFC400';
const SUAVE = '#F7F7F5';

const ESTADOS: Array<{ id: AdminRecovery['status']; label: string; tono: string }> = [
  { id: 'sin_acuerdo',      label: 'Sin acuerdo',            tono: 'rojo' },
  { id: 'alumno_propuso',   label: 'Responde el profesor',   tono: 'ambar' },
  { id: 'esperando_alumno', label: 'Elige el alumno',        tono: 'ambar' },
  { id: 'confirmada',       label: 'Confirmada',             tono: 'verde' },
  { id: 'recuperada',       label: 'Recuperada',             tono: 'gris' },
  { id: 'anulada',          label: 'Anulada',                tono: 'gris' },
];
const ESTADO_DE = Object.fromEntries(ESTADOS.map(e => [e.id, e]));

/** 'YYYY-MM-DD' de hoy en España. */
function hoyEspana(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

const corta = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const cuando = (s: { date: string; hour: string }) => `${corta(s.date)} ${s.hour}`;
const instante = (iso: string | null) => (iso ? new Date(iso).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

function antelacion(min: number): string {
  if (min <= 0) return 'sin aviso';
  const h = Math.floor(min / 60);
  if (h >= 48) return `${Math.floor(h / 24)} días`;
  return h >= 1 ? `${h} h` : `${min} min`;
}

function coste(r: AdminRecovery): { texto: string; tono: string } {
  if (r.origin === 'admin_reclasificacion') {
    return r.penaltyEuros < 0 ? { texto: `Multa fija ${Math.abs(r.penaltyEuros)} € (reclasificada)`, tono: 'rojo' }
      : { texto: 'Multa fija: habría costado 5 € (antes del 15/10)', tono: 'ambar' };
  }
  if (!r.late) return { texto: 'Con antelación: sin coste', tono: 'verde' };
  if (r.penaltyEuros < 0) return { texto: `Multa ${Math.abs(r.penaltyEuros)} €`, tono: 'rojo' };
  if (r.wouldHavePenalty) return { texto: 'Habría costado 5 € (antes del 15/10)', tono: 'ambar' };
  if (r.usedWildcard) return { texto: 'Usó comodín', tono: 'ambar' };
  return { texto: 'Sin antelación', tono: 'ambar' };
}

export default function RecoveriesTab() {
  const { user } = useAuth();
  const { rows, error, loading, reload } = useAdminRecoveries();
  const [estado, setEstado] = useState<string>('todos');
  const [profe, setProfe] = useState<string>('todos');
  const [mes, setMes] = useState<string>('todos');
  const hoy = hoyEspana();

  const profes = [...new Map(rows.map(r => [r.teacherId, r.teacherName ?? r.teacherId])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1], 'es'));
  const meses = [...new Set(rows.map(r => r.cancelMonth))].sort().reverse();

  const filtradas = rows.filter(r =>
    (estado === 'todos' || r.status === estado) &&
    (profe === 'todos' || r.teacherId === profe) &&
    (mes === 'todos' || r.cancelMonth === mes));
  const atencion = (r: AdminRecovery) =>
    r.status === 'sin_acuerdo' || (r.status === 'confirmada' && !!r.chosenDate && r.chosenDate < hoy);
  const arriba = filtradas.filter(atencion);
  const resto = filtradas.filter(r => !atencion(r));

  return (
    <div className="rt">
      <style>{CSS}</style>
      <div className="rt-head">
        <div>
          <div className="rt-title">Recuperaciones</div>
          <div className="rt-sub">Clases que el profesor no pudo dar («No puedo dar esta clase» y reclasificaciones). Solo profesores beta.</div>
        </div>
        <button type="button" className="rt-btn-sec" onClick={() => reload()}>Actualizar</button>
      </div>

      <div className="rt-filtros">
        <label>Estado
          <select value={estado} onChange={e => setEstado(e.target.value)}>
            <option value="todos">Todos ({rows.length})</option>
            {ESTADOS.map(e => <option key={e.id} value={e.id}>{e.label} ({rows.filter(r => r.status === e.id).length})</option>)}
          </select>
        </label>
        <label>Profesor
          <select value={profe} onChange={e => setProfe(e.target.value)}>
            <option value="todos">Todos</option>
            {profes.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <label>Mes
          <select value={mes} onChange={e => setMes(e.target.value)}>
            <option value="todos">Todos</option>
            {meses.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
      </div>

      {loading && <div className="rt-muted">Cargando…</div>}
      {error && <div className="rt-error">{error}</div>}
      {!loading && !error && filtradas.length === 0 && <div className="rt-muted">No hay recuperaciones con estos filtros.</div>}

      {arriba.length > 0 && (
        <section className="rt-seccion">
          <div className="rt-seccion-title">Necesitan al equipo ({arriba.length})</div>
          {arriba.map(r => <Fila key={r.id} r={r} hoy={hoy} by={user?.displayName || user?.username || 'admin'} onChanged={reload} />)}
        </section>
      )}
      {resto.length > 0 && (
        <section className="rt-seccion">
          {arriba.length > 0 && <div className="rt-seccion-title is-plain">El resto ({resto.length})</div>}
          {resto.map(r => <Fila key={r.id} r={r} hoy={hoy} by={user?.displayName || user?.username || 'admin'} onChanged={reload} />)}
        </section>
      )}
    </div>
  );
}

function Fila({ r, hoy, by, onChanged }: { r: AdminRecovery; hoy: string; by: string; onChanged: () => Promise<void> }) {
  const [anulando, setAnulando] = useState(false);
  const [motivo, setMotivo] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const est = ESTADO_DE[r.status];
  const c = coste(r);
  const vencida = r.status === 'confirmada' && !!r.chosenDate && r.chosenDate < hoy;
  const anulable = r.status !== 'anulada' && r.status !== 'recuperada';

  async function anular() {
    if (motivo.trim().length < 3 || saving) return;
    setSaving(true); setErr(null);
    try {
      const res = await fetch(`/api/recuperaciones/${encodeURIComponent(r.id)}/anular`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ by, reason: motivo.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(data.mensaje ?? 'No se pudo anular.'); return; }
      setAnulando(false); setMotivo('');
      await onChanged();
    } catch {
      setErr('No se pudo conectar con el servidor.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className={`rt-card${r.status === 'sin_acuerdo' || vencida ? ' is-alerta' : ''}`}>
      <div className="rt-card-top">
        <div className="rt-who">
          <b>{r.studentName}</b> <span className="rt-muted">con {r.teacherName ?? r.teacherId}</span>
        </div>
        <span className={`rt-badge is-${est?.tono ?? 'gris'}`}>{est?.label ?? r.status}</span>
      </div>

      <div className="rt-grid">
        <div><span className="rt-k">Clase cancelada</span>
          {fechaLarga(r.originalDate)} · {r.originalHour}{r.parts > 1 ? ` · ${r.part}.ª hora de 2` : r.hours > 1 ? ` · ${r.hours} h` : ''}
        </div>
        <div><span className="rt-k">Antelación</span>{antelacion(r.noticeMinutes)}{r.late ? ' · menos de 24 h' : ''}</div>
        <div><span className="rt-k">Comodín / multa</span><span className={`rt-tx is-${c.tono}`}>{c.texto}</span></div>
        <div><span className="rt-k">Fechas del profesor{r.round > 1 ? ` (ronda ${r.round})` : ''}</span>
          {r.teacherProposals.length ? r.teacherProposals.map(cuando).join(' · ') : '—'}
        </div>
        <div><span className="rt-k">Horarios del alumno</span>
          {r.studentProposals.length ? r.studentProposals.map(cuando).join(' · ') : '—'}
          {r.studentNote && <span className="rt-nota">“{r.studentNote}”</span>}
        </div>
        <div><span className="rt-k">Fecha de recuperación</span>
          {r.chosenDate ? `${cuando({ date: r.chosenDate, hour: r.chosenHour ?? '' })}${r.chosenBy ? ` (${r.chosenBy})` : ''}` : '—'}
          {vencida && <span className="rt-tx is-rojo"> · pasó sin ingreso</span>}
        </div>
        <div><span className="rt-k">Fechas</span>
          Cancelada {instante(r.cancelledAt)} · último cambio {instante(r.statusChangedAt)}
        </div>
        {(r.reason || r.annulReason) && (
          <div><span className="rt-k">{r.annulReason ? 'Anulación' : 'Motivo'}</span>
            {r.annulReason ? `${r.annulReason} — ${r.annulledBy ?? ''} ${instante(r.annulledAt)}` : r.reason}
          </div>
        )}
      </div>

      {anulable && !anulando && (
        <button type="button" className="rt-btn-sec rt-anular" onClick={() => setAnulando(true)}>Anular</button>
      )}
      {anulando && (
        <div className="rt-anular-form">
          <label className="rt-k" htmlFor={`mot-${r.id}`}>Motivo de la anulación (obligatorio)</label>
          <textarea id={`mot-${r.id}`} rows={2} value={motivo} onChange={e => setMotivo(e.target.value)}
            placeholder="Por ejemplo: se acordó por WhatsApp, error al cancelar…" />
          {err && <div className="rt-error">{err}</div>}
          <div className="rt-anular-acc">
            <button type="button" className="rt-btn-sec" onClick={() => { setAnulando(false); setErr(null); }} disabled={saving}>Volver</button>
            <button type="button" className="rt-btn-pri" onClick={anular} disabled={saving || motivo.trim().length < 3}>
              {saving ? 'Anulando…' : 'Anular recuperación'}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

const CSS = `
.rt { font-family: var(--font-app); color: var(--text-primary); }
.rt-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 14px; }
.rt-title { font-size: 18px; font-weight: 700; }
.rt-sub { font-size: 13px; color: var(--text-secondary); margin-top: 2px; }
.rt-muted { font-size: 13px; color: var(--text-muted); }
.rt-error { font-size: 13px; color: #b42318; background: rgba(200,30,30,0.06); border: 1px solid rgba(200,30,30,0.3); border-radius: 8px; padding: 8px 10px; margin: 8px 0; }
.rt-filtros { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; }
.rt-filtros label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 600; color: var(--text-secondary); margin: 0; min-width: 160px; flex: 1 1 160px; max-width: 240px; }
.rt-seccion { display: flex; flex-direction: column; gap: 10px; margin-bottom: 20px; }
.rt-seccion-title { font-size: 13px; font-weight: 700; color: #8a5a00; }
.rt-seccion-title.is-plain { color: var(--text-secondary); }
.rt-card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
.rt-card.is-alerta { border-left: 4px solid ${AMARILLO}; background: ${SUAVE}; }
.rt-card-top { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
.rt-who { font-size: 15px; }
.rt-badge { font-size: 12px; font-weight: 700; border-radius: 999px; padding: 3px 10px; white-space: nowrap; }
.rt-badge.is-rojo { background: rgba(200,30,30,0.1); color: #b42318; }
.rt-badge.is-ambar { background: rgba(255,196,0,0.2); color: #6b4a00; }
.rt-badge.is-verde { background: rgba(30,158,58,0.12); color: #17692b; }
.rt-badge.is-gris { background: var(--bg-surface-2); color: var(--text-secondary); }
.rt-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 8px 16px; font-size: 13px; line-height: 1.4; }
.rt-k { display: block; font-size: 11.5px; font-weight: 600; color: var(--text-muted); margin-bottom: 1px; }
.rt-nota { display: block; font-style: italic; color: var(--text-secondary); margin-top: 2px; }
.rt-tx.is-rojo { color: #b42318; font-weight: 600; }
.rt-tx.is-ambar { color: #8a5a00; font-weight: 600; }
.rt-tx.is-verde { color: #17692b; font-weight: 600; }
.rt-btn-sec { min-height: 36px; padding: 6px 14px; border-radius: 8px; border: 1px solid var(--border); background: transparent;
  color: var(--text-secondary); font: inherit; font-size: 13px; cursor: pointer; }
.rt-btn-pri { min-height: 36px; padding: 6px 14px; border-radius: 8px; border: none; background: #b42318; color: #fff;
  font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; }
.rt-btn-pri:disabled, .rt-btn-sec:disabled { opacity: 0.5; cursor: not-allowed; }
.rt-anular { margin-top: 12px; }
.rt-anular-form { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
.rt-anular-form textarea { width: 100%; box-sizing: border-box; font: inherit; font-size: 13px; resize: vertical; }
.rt-anular-acc { display: flex; gap: 8px; justify-content: flex-end; }
/* En el teléfono el título ya lo pone la barra del admin (AdminNavMovil). */
@media (max-width: 768px) { .rt-title { display: none; } }
@media (max-width: 600px) {
  .rt-head { flex-direction: column; }
  .rt-filtros label { max-width: none; }
  .rt-grid { grid-template-columns: 1fr; }
  .rt-anular-acc { flex-direction: column-reverse; }
  .rt-anular-acc button, .rt-anular { width: 100%; min-height: 44px; }
}
`;

