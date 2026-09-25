'use client';

// Botón "Reevaluar redacciones sin evaluar" de la pestaña Tests de nivel.
// Solo aparece si hay alguna (la IA no pudo evaluarlas: p. ej. el saldo agotado
// del 14–16/09/2026). Llama a /api/admin/reevaluate-writing por tandas hasta
// terminar y enseña cuántas se arreglaron y cuántas siguen fallando.
// Ver lib/levelTest/reevaluate: al alumno no se le avisa de nada; al profesor,
// por la campanita, solo si el nivel cambia.

import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ReevalItem } from '@/lib/levelTest/reevaluate';

/** Tope de vueltas: con 3 por tanda cubre 60 redacciones; más sería raro y mejor verlo. */
const MAX_TANDAS = 20;

export default function ReevaluarRedacciones({ onTerminado }: { onTerminado?: () => void }) {
  const [pendientes, setPendientes] = useState<number | null>(null);
  const [corriendo, setCorriendo] = useState(false);
  const [hechos, setHechos] = useState<ReevalItem[]>([]);
  const [fallo, setFallo] = useState('');

  async function contar() {
    try {
      const res = await fetch('/api/admin/reevaluate-writing', { cache: 'no-store' });
      const data = await res.json();
      setPendientes(typeof data.pendientes === 'number' ? data.pendientes : 0);
    } catch { setPendientes(0); }
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { contar(); }, []);

  async function lanzar() {
    if (corriendo) return;
    const total = pendientes ?? 0;
    if (!window.confirm(
      `Se van a reevaluar ${total} redacción${total === 1 ? '' : 'es'} con la IA y a recalcular el nivel final de esas pruebas.\n\n` +
      '· Al alumno NO se le envía nada.\n· Al profesor solo le llega un aviso en la campanita si el nivel cambia.\n\n¿Seguimos?',
    )) return;

    setCorriendo(true);
    setFallo('');
    setHechos([]);
    const acumulado: ReevalItem[] = [];
    try {
      for (let i = 0; i < MAX_TANDAS; i++) {
        const skip = acumulado.filter(x => x.resultado === 'sigue_fallando').map(x => x.answerId);
        const res = await fetch('/api/admin/reevaluate-writing', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ skip }),
        });
        const data = await res.json().catch(() => null) as { items?: ReevalItem[]; remaining?: number } | null;
        if (!res.ok || !data) throw new Error(`El servidor respondió ${res.status}.`);
        acumulado.push(...(data.items ?? []));
        setHechos([...acumulado]);
        if (!data.items?.length || !data.remaining) break;
      }
    } catch (err) {
      setFallo(err instanceof Error ? err.message : 'Se cortó la reevaluación.');
    } finally {
      setCorriendo(false);
      await contar();
      onTerminado?.();
    }
  }

  const arregladas = hechos.filter(h => h.resultado === 'arreglada');
  const noValidas = hechos.filter(h => h.resultado === 'no_valida');
  const siguen = hechos.filter(h => h.resultado === 'sigue_fallando');

  if (!pendientes && hechos.length === 0 && !fallo) return null;

  return (
    <div className="adm-card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Redacciones sin evaluar: {pendientes ?? '…'}</div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>
            La IA no pudo evaluarlas y esos alumnos tienen un nivel provisional (solo lectura). Al reevaluar no se avisa al alumno.
          </div>
        </div>
        <button type="button" className="adm-btn adm-btn-primary" disabled={corriendo || !pendientes} onClick={lanzar}>
          <RefreshCw size={16} aria-hidden />
          {corriendo ? `Reevaluando… (${hechos.length})` : 'Reevaluar redacciones sin evaluar'}
        </button>
      </div>

      {hechos.length > 0 && (
        <div style={{ fontSize: 13, lineHeight: 1.55 }}>
          <div>
            <b style={{ color: '#067647' }}>Arregladas: {arregladas.length}</b>
            {noValidas.length > 0 && <> · <b>Evaluadas pero no válidas: {noValidas.length}</b></>}
            {' · '}<b style={{ color: siguen.length ? '#B42318' : undefined }}>Siguen fallando: {siguen.length}</b>
          </div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {hechos.map(h => (
              <li key={h.answerId}>
                {h.alumno}:{' '}
                {h.resultado === 'sigue_fallando'
                  ? <span style={{ color: '#B42318' }}>sigue sin evaluar ({h.error})</span>
                  : <>
                      {h.resultado === 'no_valida' ? 'la IA la marcó como no válida' : 'evaluada'}
                      {h.nivelDespues && <> · nivel {h.nivelAntes ?? '—'} → <b>{h.nivelDespues}</b>{h.nivelAntes === h.nivelDespues ? ' (sin cambio, nadie avisado)' : h.profesorAvisado ? ' (profesor avisado)' : ' (sin profesor al que avisar)'}</>}
                      {h.error && <span style={{ color: '#B42318' }}> · {h.error}</span>}
                    </>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {fallo && <div style={{ fontSize: 13, color: '#B42318' }}>{fallo}</div>}
    </div>
  );
}
