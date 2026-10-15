'use client';

// "Posibles ausencias" del profesor, arriba de la pestaña Recuperaciones.
//
// Las anota el chequeo de cada 5 minutos (/api/cron/ausencias): clase que tocaba
// y, a los 30 minutos del inicio, el profesor no había pulsado "Ingresar a
// clase". Por ahora es SOLO un registro: sin multa ni botones. Si el profesor
// ingresa después, pasa sola a "Llegó tarde".
//
// Las "descartadas" (alumno en pausa o con la suscripción inactiva) no son
// ausencias: se ocultan, con un botón para verlas si hace falta revisar algo.
//
// Usa las clases rt-* de RecoveriesTab, que la monta dentro de su contenedor.

import { useCallback, useEffect, useState } from 'react';
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
  status: 'posible_ausencia' | 'llego_tarde' | 'no_verificado' | 'descartada';
  statusReason: string | null;
  detectedAt: string;
  lateJoinedAt: string | null;
  zapierStatus: 'pendiente' | 'enviado' | 'sin_webhook' | 'error' | 'no_enviado';
  zapierSentAt: string | null;
  zapierError: string | null;
}

const ESTADO: Record<Absence['status'], { label: string; tono: string }> = {
  posible_ausencia: { label: 'Posible ausencia', tono: 'rojo' },
  no_verificado:    { label: 'No verificado',    tono: 'ambar' },
  llego_tarde:      { label: 'Llegó tarde',      tono: 'verde' },
  descartada:       { label: 'Descartada',       tono: 'gris' },
};

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
  const abiertas = rows.filter(r => r.status === 'posible_ausencia').length;

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

      {visibles.map(r => {
        const est = ESTADO[r.status] ?? { label: r.status, tono: 'gris' };
        const zap = ZAPIER[r.zapierStatus] ?? { label: r.zapierStatus, tono: 'gris' };
        return (
          <article key={r.id} className={`rt-card${r.status === 'posible_ausencia' ? ' is-alerta' : ''}`}>
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
              {r.statusReason && <div><span className="rt-k">Motivo</span>{r.statusReason}</div>}
            </div>
          </article>
        );
      })}

      {descartadas.length > 0 && (
        <button type="button" className="rt-btn-sec" style={{ alignSelf: 'flex-start' }} onClick={() => setVerDescartadas(v => !v)}>
          {verDescartadas ? 'Ocultar descartadas' : `Ver descartadas (${descartadas.length}): alumnos en pausa o inactivos`}
        </button>
      )}
    </section>
  );
}
