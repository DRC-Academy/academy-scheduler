'use client';

// Pestaña "Penalizaciones" del admin: las multas del sistema único del mes
// (faltas de 10 € y cancelaciones tardías de 5 €), por profesor y en detalle,
// con el cuadre contra lo que resta Finanzas.
//
// SOLO LECTURA de lo que ya existe (eventos de scoring, recuperaciones y
// posibles ausencias), salvo los botones: "Anular" (solo devuelve el dinero,
// /api/admin/penalizaciones/anular) y, en las "sin cobrar: revisar", los
// "Cobrar falta" y "Anular" de siempre de Posibles ausencias.
// Las filas y el resumen los arma lib/penaltiesView (puro, con tests).

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import { useAdminRecoveries } from '@/lib/useTeacherRecoveries';
import { fechaLarga } from '@/lib/classRecoveries';
import { spainMonthOfInstant } from '@/lib/teacherPenalties';
import {
  buildPenaltyRows, summarizePenalties, KIND_LABEL, ORIGIN_LABEL,
  type PenaltyAbsence, type PenaltyRow, type PenaltyKind, type PenaltyState,
} from '@/lib/penaltiesView';

const AMARILLO = '#FFC400';

const ESTADO: Record<PenaltyState, { label: string; tono: string }> = {
  cobrada:   { label: 'Cobrada',              tono: 'rojo' },
  revertida: { label: 'Revertida',            tono: 'gris' },
  revisar:   { label: 'Sin cobrar: revisar',  tono: 'ambar' },
};

const eur = (n: number) => `${n.toLocaleString('es-ES', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} €`;
const instante = (iso: string | null) => (iso
  ? new Date(iso).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  : '—');
const mesLargo = (m: string) => {
  const [y, mm] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mm - 1, 15)).toLocaleDateString('es-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};
const moverMes = (m: string, d: number) => {
  const [y, mm] = m.split('-').map(Number);
  const t = new Date(Date.UTC(y, mm - 1 + d, 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
};

async function fetchAbsences(month: string): Promise<{ absences: PenaltyAbsence[] } | { error: string }> {
  try {
    const res = await fetch(`/api/admin/posibles-ausencias?mes=${encodeURIComponent(month)}`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error ?? 'No se pudieron cargar las posibles ausencias.' };
    return { absences: Array.isArray(data.absences) ? data.absences : [] };
  } catch {
    return { error: 'No se pudo conectar con el servidor.' };
  }
}

export default function PenaltiesTab() {
  const { user } = useAuth();
  const by = user?.displayName || user?.username || 'admin';
  const { teachers, scoringEvents, loadScoringEvents } = useTeachers();
  const { rows: recRows, error: recError, reload: reloadRecs } = useAdminRecoveries();

  const actual = spainMonthOfInstant(new Date().toISOString());
  const [month, setMonth] = useState(actual);
  const [teacherId, setTeacherId] = useState('');
  const [tipo, setTipo] = useState<'todos' | PenaltyKind>('todos');
  const [estado, setEstado] = useState<'todos' | PenaltyState>('todos');
  const [verPrueba, setVerPrueba] = useState(false);
  const [absences, setAbsences] = useState<PenaltyAbsence[]>([]);
  const [absError, setAbsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadAbsences = useCallback(async (m: string) => {
    const r = await fetchAbsences(m);
    if ('error' in r) setAbsError(r.error); else { setAbsences(r.absences); setAbsError(null); }
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchAbsences(month).then(r => {
      if (cancelled) return;
      if ('error' in r) setAbsError(r.error); else { setAbsences(r.absences); setAbsError(null); }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [month]);

  const refrescar = useCallback(async () => {
    await Promise.all([loadScoringEvents(), reloadRecs(), loadAbsences(month)]);
  }, [loadScoringEvents, reloadRecs, loadAbsences, month]);

  const testIds = new Set(teachers.filter(t => t.isTest).map(t => t.id));
  const nombre = (id: string) => teachers.find(t => t.id === id)?.name ?? id;
  const recoveries = recRows.map(r => ({ ...r, penaltyEventId: r.penaltyEventId ?? null }));

  const todas = buildPenaltyRows({ events: scoringEvents, recoveries, absences, teacherName: nombre });
  // El resumen usa mes + profesor + interruptores; el tipo y el estado solo filtran el detalle.
  const base = todas.filter(r => r.month === month
    && (verPrueba || !testIds.has(r.teacherId))
    && (!teacherId || r.teacherId === teacherId));
  const visiblesIds = new Set(teachers.filter(t => (verPrueba || !t.isTest) && (!teacherId || t.id === teacherId)).map(t => t.id));
  const resumen = summarizePenalties({ rows: base, month, events: scoringEvents, recoveries, teacherIds: visiblesIds, teacherName: nombre });
  const detalle = base.filter(r => (tipo === 'todos' || r.kind === tipo) && (estado === 'todos' || r.state === estado));
  const descuadres = resumen.filter(s => !s.cuadra);
  const profesEnMes = [...new Set(todas.filter(r => r.month === month).map(r => r.teacherId))]
    .filter(id => verPrueba || !testIds.has(id))
    .sort((a, b) => nombre(a).localeCompare(nombre(b), 'es'));

  return (
    <div className="pz">
      <div className="pz-head">
        <div>
          <div className="pz-title">Penalizaciones</div>
          <div className="pz-sub">Faltas (10 €) y cancelaciones con menos de 24 h (5 €, desde la 3.ª del mes). El mes es el de cada multa, en hora de España.</div>
        </div>
        <button type="button" className="pz-btn-sec" onClick={() => { setLoading(true); refrescar(); }}>Actualizar</button>
      </div>

      <div className="pz-mes">
        <button type="button" className="pz-mes-b" aria-label="Mes anterior" onClick={() => setMonth(m => moverMes(m, -1))}>‹</button>
        <span className="pz-mes-l">{mesLargo(month)}</span>
        <button type="button" className="pz-mes-b" aria-label="Mes siguiente" disabled={month >= actual} onClick={() => setMonth(m => moverMes(m, 1))}>›</button>
      </div>

      <div className="pz-filtros">
        <label>Profesor
          <select value={teacherId} onChange={e => setTeacherId(e.target.value)}>
            <option value="">Todos</option>
            {profesEnMes.map(id => <option key={id} value={id}>{nombre(id)}</option>)}
          </select>
        </label>
        <label>Tipo
          <select value={tipo} onChange={e => setTipo(e.target.value as typeof tipo)}>
            <option value="todos">Todos</option>
            <option value="falta">{KIND_LABEL.falta}</option>
            <option value="cancelacion">{KIND_LABEL.cancelacion}</option>
          </select>
        </label>
        <label>Estado
          <select value={estado} onChange={e => setEstado(e.target.value as typeof estado)}>
            <option value="todos">Todos</option>
            <option value="cobrada">Cobrada</option>
            <option value="revertida">Revertida</option>
            <option value="revisar">Sin cobrar: revisar</option>
          </select>
        </label>
        <div className="pz-toggles">
          <label className="pz-check"><input type="checkbox" checked={verPrueba} onChange={e => setVerPrueba(e.target.checked)} /> Ver cuentas de prueba</label>
        </div>
      </div>

      {(absError || recError) && <div className="pz-error">{absError ?? recError}</div>}
      {loading && <div className="pz-muted">Cargando…</div>}

      {/* ── Resumen por profesor ── */}
      <section className="pz-seccion">
        <div className="pz-seccion-title">Por profesor</div>
        {descuadres.length > 0 && (
          <div className="pz-aviso">
            <b>No cuadra con Finanzas</b> en {descuadres.length === 1 ? '1 profesor' : `${descuadres.length} profesores`}:
            Finanzas resta por faltas y cancelaciones un importe distinto al de aquí.
          </div>
        )}
        {resumen.length === 0 && !loading && <div className="pz-muted">Sin penalizaciones en {mesLargo(month)}.</div>}
        <div className="pz-resumen">
          {resumen.map(s => (
            <button type="button" key={s.teacherId} className={`pz-prof${!s.cuadra ? ' is-descuadre' : ''}${teacherId === s.teacherId ? ' is-on' : ''}`}
              onClick={() => setTeacherId(teacherId === s.teacherId ? '' : s.teacherId)}>
              <span className="pz-prof-n">{s.teacherName}</span>
              <span className="pz-prof-total">{eur(s.total)}</span>
              <span className="pz-prof-d">
                {s.faltas} falta{s.faltas !== 1 ? 's' : ''} · {s.cancelaciones} cancelaci{s.cancelaciones !== 1 ? 'ones' : 'ón'} con multa · comodines {s.comodines} de 2
              </span>
              {!s.cuadra && <span className="pz-prof-w">Finanzas resta {eur(s.finanzas)} (diferencia {eur(Math.abs(s.finanzas - s.total))})</span>}
            </button>
          ))}
        </div>
      </section>

      {/* ── Detalle ── */}
      <section className="pz-seccion">
        <div className="pz-seccion-title">Detalle ({detalle.length})</div>
        {detalle.length === 0 && !loading && <div className="pz-muted">No hay multas con estos filtros.</div>}
        {detalle.map(r => <Fila key={r.key} r={r} by={by} onChanged={refrescar} />)}
      </section>

      <style>{CSS}</style>
    </div>
  );
}

function Fila({ r, by, onChanged }: { r: PenaltyRow; by: string; onChanged: () => Promise<void> }) {
  const [anulando, setAnulando] = useState(false);
  const [motivo, setMotivo] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const est = ESTADO[r.state];
  const anulable = r.state === 'cobrada' || r.state === 'revisar';

  async function post(url: string, body: object, fallo: string): Promise<boolean> {
    setSaving(true); setErr(null);
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(data.mensaje ?? fallo); return false; }
      await onChanged();
      return true;
    } catch {
      setErr('No se pudo conectar con el servidor.');
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function anular() {
    if (motivo.trim().length < 3 || saving) return;
    const ok = r.state === 'revisar' && r.absenceId
      // "Sin cobrar: revisar": la anulación de siempre de Posibles ausencias.
      ? await post(`/api/admin/posibles-ausencias/${encodeURIComponent(r.absenceId)}/anular`, { by, reason: motivo.trim() }, 'No se pudo anular.')
      // Cobrada: solo se devuelve el dinero.
      : await post('/api/admin/penalizaciones/anular', { eventId: r.eventId, by, reason: motivo.trim() }, 'No se pudo anular la multa.');
    if (ok) { setAnulando(false); setMotivo(''); }
  }

  return (
    <article className={`pz-card${r.state === 'revisar' ? ' is-alerta' : ''}`}>
      <div className="pz-card-top">
        <div className="pz-who"><b>{r.teacherName}</b> <span className="pz-muted">con {r.studentName}</span></div>
        <span className={`pz-badge is-${est.tono}`}>{est.label}</span>
      </div>
      <div className="pz-grid">
        <div><span className="pz-k">Tipo</span>{KIND_LABEL[r.kind]}</div>
        <div><span className="pz-k">Clase</span>{r.classDate ? `${fechaLarga(r.classDate)}${r.classHour ? ` · ${r.classHour}` : ''}` : '—'}</div>
        <div><span className="pz-k">{r.kind === 'cancelacion' ? 'Cancelada' : r.state === 'revisar' ? 'Detectada' : 'Cobrada'}</span>{instante(r.at)}</div>
        <div><span className="pz-k">Importe</span>
          <span className={r.state === 'cobrada' ? 'pz-tx is-rojo' : 'pz-tx is-tachado'}>−{eur(r.euros)}</span>
        </div>
        <div><span className="pz-k">Origen</span>{ORIGIN_LABEL[r.origin]}</div>
        {r.state === 'revertida' && (
          <div><span className="pz-k">Revertida</span>
            {r.revertedBy ? `por ${r.revertedBy}` : '—'}{r.revertedAt ? ` · ${instante(r.revertedAt)}` : ''}
            {r.revertReason && <span className="pz-nota">{r.revertReason}</span>}
          </div>
        )}
        {r.state === 'revisar' && r.revertReason && <div><span className="pz-k">Motivo</span>{r.revertReason}</div>}
      </div>

      {err && !anulando && <div className="pz-error">{err}</div>}
      {anulable && !anulando && (
        <div className="pz-acc">
          {r.state === 'revisar' && r.absenceId && r.chargeable && (
            <button type="button" className="pz-btn-pri" disabled={saving}
              onClick={() => post(`/api/admin/posibles-ausencias/${encodeURIComponent(r.absenceId!)}/cobrar`, { by }, 'No se pudo cobrar la falta.')}>
              {saving ? 'Cobrando…' : 'Cobrar falta (−10 €)'}
            </button>
          )}
          <button type="button" className="pz-btn-sec" onClick={() => setAnulando(true)} disabled={saving}>Anular</button>
        </div>
      )}
      {anulando && (
        <div className="pz-anular">
          <label className="pz-k" htmlFor={`pz-${r.key}`}>Motivo de la anulación (obligatorio)</label>
          <textarea id={`pz-${r.key}`} rows={2} value={motivo} onChange={e => setMotivo(e.target.value)}
            placeholder="Por ejemplo: fallo técnico comprobado, el alumno confirmó que la clase se dio…" />
          <div className="pz-muted">
            {r.state === 'revisar'
              ? 'Se anula la posible ausencia (sin multa) y su recuperación automática, como en Posibles ausencias.'
              : `Se devuelven ${eur(r.euros)} al profesor. La recuperación del alumno sigue en pie${r.kind === 'cancelacion' ? ' y el comodín sigue gastado' : ''}.`}
          </div>
          {err && <div className="pz-error">{err}</div>}
          <div className="pz-anular-acc">
            <button type="button" className="pz-btn-sec" onClick={() => { setAnulando(false); setErr(null); }} disabled={saving}>Volver</button>
            <button type="button" className="pz-btn-pri" onClick={anular} disabled={saving || motivo.trim().length < 3}>
              {saving ? 'Anulando…' : 'Anular'}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

const CSS = `
.pz { font-family: var(--font-app); color: var(--text-primary); }
.pz-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 12px; }
.pz-title { font-size: 18px; font-weight: 700; }
.pz-sub { font-size: 13px; color: var(--text-secondary); margin-top: 2px; }
.pz-muted { font-size: 13px; color: var(--text-muted); }
.pz-error { font-size: 13px; color: #b42318; background: rgba(200,30,30,0.06); border: 1px solid rgba(200,30,30,0.3); border-radius: 8px; padding: 8px 10px; margin: 8px 0; }
.pz-aviso { font-size: 13px; color: #6b4a00; background: rgba(255,196,0,0.14); border: 1px solid rgba(255,196,0,0.5); border-radius: 8px; padding: 8px 10px; }
.pz-mes { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.pz-mes-l { font-size: 15px; font-weight: 700; min-width: 150px; text-align: center; text-transform: capitalize; }
.pz-mes-b { min-height: 36px; min-width: 36px; border-radius: 8px; border: 1px solid var(--border); background: transparent; font-size: 18px; cursor: pointer; color: var(--text-primary); }
.pz-mes-b:disabled { opacity: 0.4; cursor: not-allowed; }
.pz-filtros { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; align-items: flex-end; }
.pz-filtros > label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 600; color: var(--text-secondary); margin: 0; min-width: 160px; flex: 1 1 160px; max-width: 240px; }
.pz-toggles { display: flex; flex-wrap: wrap; gap: 6px 16px; }
.pz-check { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-secondary); cursor: pointer; }
.pz-seccion { display: flex; flex-direction: column; gap: 10px; margin-bottom: 22px; }
.pz-seccion-title { font-size: 13px; font-weight: 700; color: var(--text-secondary); }
.pz-resumen { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
.pz-prof { text-align: left; display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; background: var(--bg-surface); border: 1px solid var(--border);
  border-radius: 12px; padding: 12px 14px; font: inherit; color: inherit; cursor: pointer; }
.pz-prof.is-on { border-color: #1E9E3A; box-shadow: 0 0 0 1px #1E9E3A; }
.pz-prof.is-descuadre { border-left: 4px solid ${AMARILLO}; }
.pz-prof-n { font-weight: 700; font-size: 14px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pz-prof-total { font-weight: 800; font-size: 15px; color: #b42318; }
.pz-prof-d { grid-column: 1 / -1; font-size: 12.5px; color: var(--text-secondary); }
.pz-prof-w { grid-column: 1 / -1; font-size: 12px; color: #8a5a00; font-weight: 600; }
.pz-card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
.pz-card.is-alerta { border-left: 4px solid ${AMARILLO}; }
.pz-card-top { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
.pz-who { font-size: 15px; }
.pz-badge { font-size: 12px; font-weight: 700; border-radius: 999px; padding: 3px 10px; white-space: nowrap; }
.pz-badge.is-rojo { background: rgba(200,30,30,0.1); color: #b42318; }
.pz-badge.is-ambar { background: rgba(255,196,0,0.2); color: #6b4a00; }
.pz-badge.is-gris { background: var(--bg-surface-2); color: var(--text-secondary); }
.pz-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px 16px; font-size: 13px; line-height: 1.4; }
.pz-k { display: block; font-size: 11.5px; font-weight: 600; color: var(--text-muted); margin-bottom: 1px; }
.pz-nota { display: block; font-style: italic; color: var(--text-secondary); margin-top: 2px; }
.pz-tx.is-rojo { color: #b42318; font-weight: 700; }
.pz-tx.is-tachado { color: var(--text-muted); text-decoration: line-through; }
.pz-acc { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.pz-btn-sec { min-height: 36px; padding: 6px 14px; border-radius: 8px; border: 1px solid var(--border); background: transparent;
  color: var(--text-secondary); font: inherit; font-size: 13px; cursor: pointer; }
.pz-btn-pri { min-height: 36px; padding: 6px 14px; border-radius: 8px; border: none; background: #b42318; color: #fff;
  font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; }
.pz-btn-pri:disabled, .pz-btn-sec:disabled { opacity: 0.5; cursor: not-allowed; }
.pz-anular { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
.pz-anular textarea { width: 100%; box-sizing: border-box; font: inherit; font-size: 13px; resize: vertical; }
.pz-anular-acc { display: flex; gap: 8px; justify-content: flex-end; }
@media (max-width: 768px) { .pz-title { display: none; } }
@media (max-width: 600px) {
  .pz-head { flex-direction: column; }
  .pz-filtros > label { max-width: none; }
  .pz-grid, .pz-resumen { grid-template-columns: 1fr; }
  .pz-anular-acc { flex-direction: column-reverse; }
  .pz-anular-acc button, .pz-acc button { width: 100%; min-height: 44px; }
}
`;
