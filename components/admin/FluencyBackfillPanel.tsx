'use client';

// "Analizar clases pasadas" (pestaña Testimoniales). El navegador pide una tanda
// tras otra a /api/admin/fluency-backfill y pinta el progreso; el servidor hace
// el trabajo (lib/fluencyBackfill). Pausar = no pedir la siguiente tanda. Como el
// estado vive en la base, volver a pulsar sigue donde se quedó.

import { useEffect, useRef, useState } from 'react';
import { Pause, Play, RotateCcw } from 'lucide-react';

interface Status {
  total: number; ready: number; skipped: number; failed: number; failedRetryable: number;
  pending: number; missing: number; candidates: number | null; reviewsPending: number | null;
}
interface BatchResponse { claimed: number; newPairs: number; status: Status; error?: string }

async function post<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch('/api/admin/fluency-backfill', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `Error ${res.status} del servidor.` }));
  if (!res.ok || data.error) throw new Error(data.error ?? `Error ${res.status} del servidor.`);
  return data as T;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const fmt = (n: number) => n.toLocaleString('es-ES');

function duracion(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'menos de 1 min';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

export default function FluencyBackfillPanel({ onPairs }: { onPairs: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [running, setRunning] = useState<false | 'normal' | 'errores'>(false);
  const [pausing, setPausing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msPorTanda, setMsPorTanda] = useState<number | null>(null);
  const parar = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await post<{ status: Status }>({ action: 'estado' });
        if (!cancelled) setStatus(r.status);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function correr(modo: 'normal' | 'errores') {
    parar.current = false;
    setRunning(modo); setPausing(false); setError(null); setMsg(null);
    try {
      if (modo === 'normal') setStatus((await post<{ status: Status }>({ action: 'preparar' })).status);
      let fallosSeguidos = 0;
      const tiempos: number[] = [];
      while (!parar.current) {
        const t0 = Date.now();
        let r: BatchResponse;
        try {
          r = await post<BatchResponse>({ action: 'tanda', retryFailed: modo === 'errores' });
          fallosSeguidos = 0;
        } catch (e) {
          // Un corte de red o un 500 suelto no para el proceso: se reintenta.
          if (++fallosSeguidos >= 3) throw e;
          await sleep(3000);
          continue;
        }
        setStatus(r.status);
        if (r.newPairs > 0) onPairs();
        if (r.claimed === 0) {
          const enCurso = modo === 'normal' ? r.status.pending : 0;
          setMsg(enCurso > 0
            ? `Quedan ${fmt(enCurso)} en curso en otra pestaña o subida reciente. Vuelve a pulsar en unos minutos.`
            : modo === 'errores' ? 'Reintentos terminados.' : 'Terminado: no quedan clases por analizar.');
          break;
        }
        tiempos.push(Date.now() - t0);
        const ultimos = tiempos.slice(-10);
        setMsPorTanda(ultimos.reduce((a, b) => a + b, 0) / ultimos.length);
      }
      if (parar.current) setMsg('En pausa. Pulsa Continuar para seguir donde se quedó.');
    } catch (e) {
      setError(`Se detuvo: ${e instanceof Error ? e.message : String(e)}. Lo ya analizado está guardado; vuelve a pulsar para seguir.`);
    } finally {
      setRunning(false); setPausing(false);
      onPairs();
    }
  }

  const s = status;
  const hechas = s ? s.ready + s.skipped + s.failed : 0;
  const quedan = s ? s.pending + s.missing : 0;
  const pct = s && s.total > 0 ? Math.min(100, (hechas / s.total) * 100) : 0;
  const eta = msPorTanda && quedan > 0 ? duracion((quedan / 5) * msPorTanda) : null;

  return (
    <div className="adm-card fb">
      <div className="fb-top">
        <div>
          <h3 className="fb-t">Analizar clases pasadas</h3>
          <p className="fb-d">Calcula la nota de fluidez de los transcripts que aún no la tienen, de 5 en 5. Deja esta pestaña abierta mientras trabaja.</p>
        </div>
        <div className="fb-acc">
          {running ? (
            <button type="button" className="adm-btn adm-btn-ghost" disabled={pausing}
              onClick={() => { parar.current = true; setPausing(true); }}>
              <Pause size={15} aria-hidden /> {pausing ? 'Pausando…' : 'Pausar'}
            </button>
          ) : (
            <>
              {s && s.failedRetryable > 0 && (
                <button type="button" className="adm-btn adm-btn-ghost" onClick={() => correr('errores')}>
                  <RotateCcw size={15} aria-hidden /> Reintentar errores ({fmt(s.failedRetryable)})
                </button>
              )}
              <button type="button" className="adm-btn adm-btn-primary fb-go" onClick={() => correr('normal')} disabled={!!s && quedan === 0 && s.total > 0}>
                <Play size={15} aria-hidden /> {hechas > 0 && quedan > 0 ? 'Continuar' : 'Analizar clases pasadas'}
              </button>
            </>
          )}
        </div>
      </div>

      {s && (
        <>
          <div className="fb-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
            <div className="fb-fill" style={{ width: `${pct}%` }} />
          </div>
          <p className="fb-n">
            Analizadas <b>{fmt(s.ready)}</b> de <b>{fmt(s.total)}</b>
            {' · '}Descartadas <b>{fmt(s.skipped)}</b>
            {' · '}Con error <b className={s.failed > 0 ? 'fb-err' : ''}>{fmt(s.failed)}</b>
            {quedan > 0 && <> · Quedan <b>{fmt(quedan)}</b>{running && eta && <> · unos {eta}</>}</>}
          </p>
        </>
      )}
      {msg && <p className="fb-msg">{msg}</p>}
      {error && <p className="fb-msg fb-msg-err">{error}</p>}

      <style>{`
.fb { padding: 16px 18px; margin-bottom: 16px; }
.fb-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
.fb-t { margin: 0; font-size: 15px; font-weight: 700; }
.fb-d { margin: 3px 0 0; font-size: 13px; color: var(--text-muted); max-width: 560px; }
.fb-acc { display: flex; gap: 8px; flex-wrap: wrap; }
.fb-acc .adm-btn { display: inline-flex; align-items: center; gap: 6px; }
.fb-go { background: #1E9E3A; border-color: #1E9E3A; }
.fb-bar { height: 10px; border-radius: 999px; background: #ECECE8; overflow: hidden; margin-top: 14px; }
.fb-fill { height: 100%; background: #1E9E3A; border-radius: 999px; transition: width .4s ease; }
.fb-n { margin: 8px 0 0; font-size: 13px; color: #4A4A4A; }
.fb-n b { color: #1a1c1a; }
.fb-n b.fb-err { color: #C81E1E; }
.fb-msg { margin: 8px 0 0; font-size: 13px; color: #157347; }
.fb-msg-err { color: #C81E1E; }
`}</style>
    </div>
  );
}
