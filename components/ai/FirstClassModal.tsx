'use client';

// Primera clase generada por IA. Si ya está cacheada en student_profiles la
// muestra directamente; si no, la genera y la guarda.

import { useEffect, useState, type CSSProperties } from 'react';
import { generateAndSaveFirstClass } from '@/lib/aiClient';
import type { FichaIA, FirstClassIA } from '@/lib/aiTypes';
import { FirstClassView, Field, panelBox } from '@/components/ai/FichaView';

interface Props {
  profileId: string;
  studentName: string;
  teacherName: string;
  plan?: string | null;
  level?: string | null;
  ficha: FichaIA;
  cached?: FirstClassIA | null;
  onSaved: (fc: FirstClassIA) => void;
  onClose: () => void;
}

export default function FirstClassModal({
  profileId, studentName, teacherName, plan, level, ficha, cached, onSaved, onClose,
}: Props) {
  const [firstClass, setFirstClass] = useState<FirstClassIA | null>(cached ?? null);
  // Si no hay clase cacheada arrancamos ya en "cargando": la generación se
  // dispara al montar y así evitamos un setState síncrono dentro del efecto.
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);

  const params = { profileId, studentName, teacherName, plan, level, studentProfile: ficha };

  // Generación automática al abrir, sólo si no hay clase cacheada.
  useEffect(() => {
    if (cached) return;
    let cancelled = false;
    (async () => {
      try {
        const fc = await generateAndSaveFirstClass(params);
        if (cancelled) return;
        setFirstClass(fc);
        onSaved(fc);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'No se pudo generar la primera clase.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reintento manual (handler de evento: acá sí podemos setear estado directo).
  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const fc = await generateAndSaveFirstClass(params);
      setFirstClass(fc);
      onSaved(fc);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo generar la primera clase.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={modal}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div style={{ fontWeight: 800, fontSize: 17, color: '#1E9E3A' }}>✨ Primera clase — {studentName}</div>
          <button onClick={onClose} style={closeBtn} aria-label="Cerrar">×</button>
        </div>

        {loading ? (
          <div style={{ padding: '30px 0', textAlign: 'center', color: '#6b7280', fontSize: 14 }}>
            🤖 Generando la primera clase…
            <div style={{ fontSize: 12, marginTop: 6, color: '#9ca3af' }}>Puede tardar hasta un minuto.</div>
          </div>
        ) : error ? (
          <>
            <div style={errBox}>⚠️ {error}</div>
            <button onClick={generate} style={retryBtn}>Reintentar</button>
            {/* Aunque falle la clase completa, la ficha ya trae una idea concreta. */}
            <div style={{ marginTop: 18 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 8 }}>Sugerencia de la ficha inicial</div>
              <div style={panelBox}>
                <Field label="Idea para la primera clase" value={ficha.firstClassSuggestion} />
              </div>
            </div>
          </>
        ) : firstClass ? (
          <FirstClassView fc={firstClass} />
        ) : null}
      </div>
    </div>
  );
}

const overlay: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)',
  zIndex: 110, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
};
const modal: CSSProperties = {
  background: '#F7F7F5', border: '2px solid #1E9E3A', borderRadius: 16, padding: 24,
  width: '100%', maxWidth: 640, maxHeight: '90vh', overflowY: 'auto',
};
const closeBtn: CSSProperties = {
  border: 'none', background: 'transparent', fontSize: 22, cursor: 'pointer', color: '#6b7280', lineHeight: 1,
};
const errBox: CSSProperties = {
  padding: '11px 14px', borderRadius: 9, background: 'rgba(192,57,43,0.08)',
  border: '1px solid rgba(192,57,43,0.35)', color: '#C0392B', fontSize: 13, fontWeight: 600,
};
const retryBtn: CSSProperties = {
  marginTop: 10, padding: '7px 14px', borderRadius: 8, border: '1.5px solid #1E9E3A',
  background: 'white', color: '#1E9E3A', cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
};
