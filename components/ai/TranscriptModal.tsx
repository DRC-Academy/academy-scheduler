'use client';

// Subida y análisis de la transcripción de una clase (p. ej. exportada de Fathom).
// El endpoint guarda el análisis en class_analyses, actualiza la señal de riesgo
// del alumno y avisa al admin si el riesgo es amarillo o rojo.

import { useEffect, useState, type CSSProperties } from 'react';
import { analyzeTranscriptAndSave, fetchClassAnalyses, type ClassAnalysisRow } from '@/lib/aiClient';
import type { FichaIA, TranscriptIA } from '@/lib/aiTypes';
import { TranscriptAnalysisView, RiskBadge } from '@/components/ai/FichaView';
import { isRiskSignal } from '@/lib/aiTypes';

interface Props {
  studentName: string;
  studentId?: string | null;
  teacherId?: string | null;
  teacherName: string;
  profileId?: string | null;
  plan?: string | null;
  level?: string | null;
  classNumber?: number | null;
  ficha?: FichaIA | null;
  onAnalyzed: (a: TranscriptIA) => void;
  onClose: () => void;
}

export default function TranscriptModal({
  studentName, studentId, teacherId, teacherName, profileId,
  plan, level, classNumber, ficha, onAnalyzed, onClose,
}: Props) {
  const [transcript, setTranscript] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TranscriptIA | null>(null);
  const [history, setHistory] = useState<ClassAnalysisRow[]>([]);

  // Historial: se lo pasamos a la IA como contexto y lo mostramos abajo.
  useEffect(() => {
    let cancelled = false;
    fetchClassAnalyses({ studentId, studentName, limit: 5 }).then(rows => {
      if (!cancelled) setHistory(rows);
    });
    return () => { cancelled = true; };
  }, [studentId, studentName]);

  async function analyze() {
    if (transcript.trim().length < 50) {
      setError('Pega la transcripción completa de la clase (es demasiado corta).');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const analysis = await analyzeTranscriptAndSave({
        transcript: transcript.trim(),
        studentName, studentId, teacherId, teacherName, profileId, plan, level, classNumber,
        studentProfile: ficha ?? null,
        classHistory: history.map(h => ({
          clase: h.class_number,
          fecha: h.created_at,
          resumen: h.class_summary,
          errores: h.errors_detected,
          riesgo: h.risk_signal,
        })),
      });
      setResult(analysis);
      onAnalyzed(analysis);
      // Refrescamos el historial para incluir el análisis recién guardado.
      fetchClassAnalyses({ studentId, studentName, limit: 5 }).then(setHistory);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo analizar la transcripción.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={overlay} onClick={e => { if (e.target === e.currentTarget && !loading) onClose(); }}>
      <div style={modal}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div style={{ fontWeight: 800, fontSize: 17, color: '#1E9E3A' }}>📝 Transcripción — {studentName}</div>
          <button onClick={onClose} style={closeBtn} aria-label="Cerrar" disabled={loading}>×</button>
        </div>

        {result ? (
          <>
            <div style={okBox}>✅ Análisis guardado{classNumber ? ` para la clase ${classNumber}` : ''}.</div>
            <div style={{ marginTop: 14 }}><TranscriptAnalysisView a={result} /></div>
            <button onClick={() => { setResult(null); setTranscript(''); }} style={ghostBtn}>
              Analizar otra transcripción
            </button>
          </>
        ) : (
          <>
            <div style={{ fontSize: 13, color: '#4b5563', marginBottom: 10, lineHeight: 1.5 }}>
              Pega aquí la transcripción de la clase (por ejemplo, la que exporta Fathom).
              La IA generará el informe y detectará señales de riesgo de baja.
            </div>
            <textarea
              value={transcript}
              onChange={e => { setTranscript(e.target.value); setError(null); }}
              placeholder="Pega la transcripción completa…"
              rows={10}
              disabled={loading}
              style={textarea}
            />
            {error && <div style={errBox}>⚠️ {error}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <button onClick={analyze} disabled={loading} style={{ ...primaryBtn, opacity: loading ? 0.7 : 1 }}>
                {loading ? '🤖 Analizando…' : '🤖 Analizar con IA'}
              </button>
              {loading && <span style={{ fontSize: 12, color: '#9ca3af' }}>Puede tardar hasta un minuto.</span>}
            </div>
          </>
        )}

        {history.length > 0 && (
          <div style={{ marginTop: 22, paddingTop: 16, borderTop: '1px solid #e5e7eb' }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: '#374151', marginBottom: 10 }}>
              🗂 Clases analizadas ({history.length})
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {history.map(h => (
                <div key={h.id} style={histRow}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: '#111827' }}>
                      {h.class_number ? `Clase ${h.class_number}` : 'Clase'}
                    </span>
                    <span style={{ fontSize: 11, color: '#9ca3af' }}>
                      {new Date(h.created_at).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </span>
                    {isRiskSignal(h.risk_signal) && <RiskBadge risk={h.risk_signal} compact />}
                  </div>
                  {h.class_summary && (
                    <div style={{ fontSize: 12.5, color: '#4b5563', lineHeight: 1.5 }}>{h.class_summary}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
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
const textarea: CSSProperties = {
  width: '100%', borderRadius: 10, border: '1.5px solid #d1d5db', padding: '11px 13px',
  fontFamily: 'inherit', fontSize: 13, lineHeight: 1.5, resize: 'vertical', color: '#111827', background: 'white',
};
const primaryBtn: CSSProperties = {
  padding: '9px 16px', borderRadius: 9, border: '1.5px solid #1E9E3A', background: '#1E9E3A',
  color: 'white', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
};
const ghostBtn: CSSProperties = {
  marginTop: 12, padding: '7px 14px', borderRadius: 8, border: '1.5px solid #d1d5db',
  background: 'white', color: '#4b5563', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
};
const errBox: CSSProperties = {
  marginTop: 10, padding: '11px 14px', borderRadius: 9, background: 'rgba(192,57,43,0.08)',
  border: '1px solid rgba(192,57,43,0.35)', color: '#C0392B', fontSize: 13, fontWeight: 600,
};
const okBox: CSSProperties = {
  padding: '11px 14px', borderRadius: 9, background: 'rgba(30,158,58,0.1)',
  border: '1px solid rgba(30,158,58,0.4)', color: '#166534', fontSize: 13, fontWeight: 600,
};
const histRow: CSSProperties = {
  background: 'white', border: '1px solid #e5e7eb', borderRadius: 9, padding: '10px 12px',
};
