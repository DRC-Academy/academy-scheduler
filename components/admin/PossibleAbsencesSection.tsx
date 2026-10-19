'use client';

// "Posibles ausencias" del profesor, arriba de la pestaña Recuperaciones.
//
// Las anota el chequeo de cada 5 minutos (/api/cron/ausencias): clase que tocaba
// y, a los 30 minutos del inicio, el profesor no había pulsado "Ingresar a
// clase". Sin multa. Si el profesor ingresa después, pasa sola a "Llegó tarde".
//
// Profesores de la beta de recuperación automática (lib/teacherAbsences): cada
// ausencia trae su recuperación (opciones, elegida…). "Anular" pide un motivo,
// anula la ausencia y su recuperación. "Revisar" marca las que el profesor
// entró pasada la mitad con la recuperación viva: la clase original se podría
// pagar además de la recuperación.
//
// Las "descartadas" (alumno en pausa o con la suscripción inactiva) no son
// ausencias: se ocultan, con un botón para verlas si hace falta revisar algo.
//
// Usa las clases rt-* de RecoveriesTab, que la monta dentro de su contenedor.

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { fechaLarga } from '@/lib/classRecoveries';

interface Absence {
  id: string;
  teacherId: string;
  teacherName: string;
  studentName: string;
  classDate: string;
  classHour: string;
  durationHours: number;
  isRecovery: boolean;
  status: 'posible_ausencia' | 'llego_tarde' | 'no_verificado' | 'descartada' | 'anulada';
  statusReason: string | null;
  detectedAt: string;
  lateJoinedAt: string | null;
  zapierStatus: 'pendiente' | 'enviado' | 'sin_webhook' | 'error' | 'no_enviado';
  zapierSentAt: string | null;
  zapierError: string | null;
  recovery: {
    id: string; status: string;
    options: Array<{ date: string; hour: string }>;
    chosenDate: string | null; chosenHour: string | null;
  } | null;
  lateAfterHalf: boolean;
  revisar: boolean;
}

const ESTADO: Record<Absence['status'], { label: string; tono: string }> = {
  posible_ausencia: { label: 'Posible ausencia', tono: 'rojo' },
  no_verificado:    { label: 'No verificado',    tono: 'ambar' },
  llego_tarde:      { label: 'Llegó tarde',      tono: 'verde' },
  descartada:       { label: 'Descartada',       tono: 'gris' },
  anulada:          { label: 'Anulada',          tono: 'gris' },
};

const RECUPERACION: Record<string, string> = {
  esperando_alumno: 'Esperando que el alumno elija',
  alumno_propuso:   'El alumno propuso horarios',
  confirmada:       'Confirmada',
  recuperada:       'Recuperada',
  sin_acuerdo:      'Sin acuerdo',
  anulada:          'Anulada',
};

const corta = (s: { date: string; hour: string }) => `${s.date.slice(8, 10)}/${s.date.slice(5, 7)} ${s.hour}`;

function recuperacionTexto(r: NonNullable<Absence['recovery']>): string {
  const estado = RECUPERACION[r.status] ?? r.status;
  if (r.chosenDate) return `${estado} · ${corta({ date: r.chosenDate, hour: r.chosenHour ?? '' })}`;
  if (r.status === 'esperando_alumno') {
    return r.options.length ? `${estado}: ${r.options.map(corta).join(' · ')}` : `${estado} (sin horas libres: propone él)`;
  }
  return estado;
}

const ZAPIER: Record<Absence['zapierStatus'], { label: string; tono: string }> = {
  enviado:     { label: 'Avisado a Zapier',            tono: 'verde' },
  sin_webhook: { label: 'Sin webhook: no se avisó',    tono: 'ambar' },
  error:       { label: 'Error al avisar a Zapier',    tono: 'rojo' },
  pendiente:   { label: 'Enviando…',                   tono: 'ambar' },
  no_enviado:  { label: 'No se avisó a Zapier',        tono: 'gris' },
};

const hora = (iso: string | null) => (iso
  ? new Date(iso).toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' })
  : '');

async function fetchAbsences(): Promise<{ absences: Absence[]; noConfigurado: boolean } | { error: string }> {
  try {
    const res = await fetch('/api/admin/posibles-ausencias', { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error ?? 'No se pudieron cargar las posibles ausencias.' };
    return { absences: Array.isArray(data.absences) ? data.absences : [], noConfigurado: !!data.noConfigurado };
  } catch {
    return { error: 'No se pudo conectar con el servidor.' };
  }
}

export function PossibleAbsencesSection() {
  const { user } = useAuth();
  const by = user?.displayName || user?.username || 'admin';
  const [rows, setRows] = useState<Absence[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [noConfigurado, setNoConfigurado] = useState(false);
  const [verDescartadas, setVerDescartadas] = useState(false);

  const apply = useCallback((r: Awaited<ReturnType<typeof fetchAbsences>>) => {
    if ('error' in r) { setError(r.error); }
    else { setRows(r.absences); setNoConfigurado(r.noConfigurado); setError(null); }
    setLoading(false);
  }, []);

  const load = useCallback(async () => { apply(await fetchAbsences()); }, [apply]);

  useEffect(() => {
    let cancelled = false;
    fetchAbsences().then(r => { if (!cancelled) apply(r); });
    return () => { cancelled = true; };
  }, [apply]);

  const descartadas = rows.filter(r => r.status === 'descartada');
  const visibles = verDescartadas ? rows : rows.filter(r => r.status !== 'descartada');
  const abiertas = rows.filter(r => r.status === 'posible_ausencia' || r.revisar).length;

  return (
    <section className="rt-seccion">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div className="rt-seccion-title">
          Posibles ausencias del profesor{abiertas > 0 ? ` (${abiertas})` : ''}
        </div>
        <button type="button" className="rt-btn-sec" onClick={() => { setLoading(true); load(); }}>Actualizar</button>
      </div>
      <div className="rt-muted">
        Clases en las que, a los 30 minutos del inicio, el profesor no había pulsado «Ingresar a clase». Últimos 30 días.
      </div>

      {loading && <div className="rt-muted">Cargando…</div>}
      {error && <div className="rt-error">{error}</div>}
      {!loading && noConfigurado && (
        <div className="rt-error">Falta correr supabase-teacher-absences.sql en Supabase: todavía no se detecta nada.</div>
      )}
      {!loading && !error && !noConfigurado && visibles.length === 0 && (
        <div className="rt-muted">No hubo posibles ausencias.</div>
      )}

      {visibles.map(r => <Fila key={r.id} r={r} by={by} onChanged={load} />)}

      {descartadas.length > 0 && (
        <button type="button" className="rt-btn-sec" style={{ alignSelf: 'flex-start' }} onClick={() => setVerDescartadas(v => !v)}>
          {verDescartadas ? 'Ocultar descartadas' : `Ver descartadas (${descartadas.length}): alumnos en pausa o inactivos`}
        </button>
      )}
    </section>
  );
}

function Fila({ r, by, onChanged }: { r: Absence; by: string; onChanged: () => Promise<void> }) {
  const [anulando, setAnulando] = useState(false);
  const [motivo, setMotivo] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const est = ESTADO[r.status] ?? { label: r.status, tono: 'gris' };
  const zap = ZAPIER[r.zapierStatus] ?? { label: r.zapierStatus, tono: 'gris' };
  const anulable = r.status === 'posible_ausencia' || r.status === 'no_verificado' || r.status === 'llego_tarde';

  async function anular() {
    if (motivo.trim().length < 3 || saving) return;
    setSaving(true); setErr(null);
    try {
      const res = await fetch(`/api/admin/posibles-ausencias/${encodeURIComponent(r.id)}/anular`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ by, reason: motivo.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(data.mensaje ?? 'No se pudo anular.'); return; }
      setAnulando(false); setMotivo(''); setAviso(data.aviso ?? null);
      await onChanged();
    } catch {
      setErr('No se pudo conectar con el servidor.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className={`rt-card${r.status === 'posible_ausencia' || r.revisar ? ' is-alerta' : ''}`}>
      <div className="rt-card-top">
        <div className="rt-who">
          <b>{r.teacherName}</b> <span className="rt-muted">con {r.studentName}</span>
        </div>
        <span className={`rt-badge is-${est.tono}`}>
          {est.label}{r.status === 'llego_tarde' && r.lateJoinedAt ? ` · ${hora(r.lateJoinedAt)}` : ''}
        </span>
      </div>
      <div className="rt-grid">
        <div><span className="rt-k">Clase</span>
          {fechaLarga(r.classDate)} · {r.classHour}{r.durationHours > 1 ? ` · ${r.durationHours} h` : ''}{r.isRecovery ? ' · recuperación' : ''}
        </div>
        <div><span className="rt-k">Detectada</span>{hora(r.detectedAt)}</div>
        <div><span className="rt-k">Aviso</span>
          <span className={`rt-tx is-${zap.tono}`}>{zap.label}</span>
          {r.zapierStatus === 'enviado' && r.zapierSentAt ? ` · ${hora(r.zapierSentAt)}` : ''}
          {r.zapierError && <span className="rt-nota">{r.zapierError}</span>}
        </div>
        {r.recovery && <div><span className="rt-k">Recuperación</span>{recuperacionTexto(r.recovery)}</div>}
        {r.statusReason && <div><span className="rt-k">Motivo</span>{r.statusReason}</div>}
      </div>

      {r.revisar && (
        <div className="rt-error" style={{ marginTop: 10 }}>
          Revisar: entró pasada la mitad de la clase y la recuperación sigue viva. Si sube el transcript, Finanzas pagará
          también la clase original. Si la clase se dio, anula la posible ausencia (se anula la recuperación).
        </div>
      )}
      {aviso && <div className="rt-error" style={{ marginTop: 10 }}>{aviso}</div>}

      {anulable && !anulando && (
        <button type="button" className="rt-btn-sec rt-anular" onClick={() => setAnulando(true)}>Anular posible ausencia</button>
      )}
      {anulando && (
        <div className="rt-anular-form">
          <label className="rt-k" htmlFor={`aus-${r.id}`}>Motivo de la anulación (obligatorio)</label>
          <textarea id={`aus-${r.id}`} rows={2} value={motivo} onChange={e => setMotivo(e.target.value)}
            placeholder="Por ejemplo: la clase se dio por otro enlace, fallo técnico…" />
          <div className="rt-muted">Si tiene recuperación, también se anula y se libera la hora elegida.</div>
          {err && <div className="rt-error">{err}</div>}
          <div className="rt-anular-acc">
            <button type="button" className="rt-btn-sec" onClick={() => { setAnulando(false); setErr(null); }} disabled={saving}>Volver</button>
            <button type="button" className="rt-btn-pri" onClick={anular} disabled={saving || motivo.trim().length < 3}>
              {saving ? 'Anulando…' : 'Anular'}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
