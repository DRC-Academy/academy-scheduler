'use client';

// Flujo "➕ Registrar clase dada" en 3 pasos:
//   1. Datos de la clase (fecha, hora, número)
//   2. Transcripción (con contador de palabras)
//   3. Resultado del análisis → guardar / regenerar / editar
//
// El análisis y el guardado están separados: la IA analiza, el profesor revisa,
// y sólo al pulsar "Guardar" se escribe en class_analyses.

import { useEffect, useState, type CSSProperties } from 'react';
import { analyzeTranscriptOnly, saveAnalysis, type AnalyzeArgs } from '@/lib/aiClient';
import type { FichaIA, TranscriptIA, RiskSignal } from '@/lib/aiTypes';
import { isRiskSignal } from '@/lib/aiTypes';
import { TranscriptAnalysisView, DRC } from '@/components/ai/FichaView';
import { Modal, ModalHeader, primaryBtn, ghostBtn, errBox, okBox, inputStyle, labelStyle } from '@/components/ai/modalUi';

interface Props {
  studentName: string;
  studentId?: string | null;
  teacherId?: string | null;
  teacherName: string;
  profileId?: string | null;
  plan?: string | null;
  level?: string | null;
  suggestedClassNumber: number;
  ficha?: FichaIA | null;
  classHistory?: unknown[] | null;
  onSaved: (a: TranscriptIA) => void;
  onGenerateNext: (a: TranscriptIA) => void;
  onClose: () => void;
}

const SPINNER_MSGS = [
  'Analizando la transcripción...',
  'Identificando patrones de aprendizaje...',
  'Detectando áreas de mejora...',
  'Preparando la siguiente clase...',
];

export default function RegisterClassModal(props: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [time, setTime] = useState('');
  const [classNumber, setClassNumber] = useState(String(props.suggestedClassNumber));
  const [transcript, setTranscript] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<TranscriptIA | null>(null);
  const [editing, setEditing] = useState(false);
  const [savedOk, setSavedOk] = useState(false);

  const words = transcript.trim() ? transcript.trim().split(/\s+/).length : 0;
  const numClase = Number(classNumber) || props.suggestedClassNumber;

  const args = (): AnalyzeArgs => ({
    transcript: transcript.trim(),
    studentName: props.studentName,
    teacherName: props.teacherName,
    studentId: props.studentId,
    teacherId: props.teacherId,
    profileId: props.profileId,
    plan: props.plan,
    level: props.level,
    classNumber: numClase,
    classDate: date || null,
    studentProfile: props.ficha ?? null,
    classHistory: props.classHistory ?? null,
  });

  async function analyze() {
    setLoading(true);
    setError(null);
    setStep(3);
    try {
      setAnalysis(await analyzeTranscriptOnly(args()));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo analizar la transcripción.');
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!analysis) return;
    setSaving(true);
    setError(null);
    try {
      await saveAnalysis({ ...args(), analysis });
      setSavedOk(true);
      props.onSaved(analysis);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar el análisis.');
    } finally {
      setSaving(false);
    }
  }

  const locked = loading || saving;

  return (
    <Modal onClose={props.onClose} locked={locked} maxWidth={720}>
      <ModalHeader
        title={`➕ Registrar clase dada — ${props.studentName}`}
        subtitle={`Paso ${step} de 3`}
        onClose={props.onClose}
        locked={locked}
      />
      <StepBar step={step} />

      {step === 1 && (
        <>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#111827', margin: '4px 0 14px' }}>¿Cuándo fue la clase?</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
            <div>
              <label style={labelStyle} htmlFor="rc-date">Fecha</label>
              <input id="rc-date" type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle} htmlFor="rc-time">Hora</label>
              <input id="rc-time" type="time" value={time} onChange={e => setTime(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle} htmlFor="rc-num">Número de clase</label>
              <input id="rc-num" type="number" min={1} value={classNumber} onChange={e => setClassNumber(e.target.value)} style={inputStyle} />
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>Calculado automáticamente. Puedes cambiarlo.</div>
            </div>
          </div>
          <div style={navRow}>
            <span />
            <button onClick={() => setStep(2)} style={primaryBtn}>Siguiente →</button>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#111827', margin: '4px 0 10px' }}>Pega aquí la transcripción de Fathom:</div>
          <textarea
            value={transcript}
            onChange={e => { setTranscript(e.target.value); setError(null); }}
            placeholder="Copia y pega el texto completo de la transcripción de Fathom aquí..."
            style={{ ...inputStyle, minHeight: 300, resize: 'vertical', fontSize: 13, lineHeight: 1.5 }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, flexWrap: 'wrap', gap: 6 }}>
            <span style={{ fontSize: 11.5, color: '#9ca3af' }}>
              Cuanto más completa sea la transcripción, mejor será el análisis.
            </span>
            <span style={{ fontSize: 12, fontWeight: 700, color: words > 0 ? DRC.green : '#9ca3af', fontVariantNumeric: 'tabular-nums' }}>
              {words} palabras
            </span>
          </div>
          {error && <div style={{ ...errBox, marginTop: 10 }}>⚠️ {error}</div>}
          <div style={navRow}>
            <button onClick={() => setStep(1)} style={ghostBtn}>← Anterior</button>
            <button
              onClick={() => {
                if (words < 30) { setError('La transcripción es demasiado corta. Pega el texto completo de la clase.'); return; }
                analyze();
              }}
              style={primaryBtn}
            >
              🤖 Analizar con IA →
            </button>
          </div>
        </>
      )}

      {step === 3 && (
        <>
          {loading ? (
            <RotatingSpinner />
          ) : error && !analysis ? (
            <>
              <div style={errBox}>⚠️ {error}</div>
              <div style={navRow}>
                <button onClick={() => { setError(null); setStep(2); }} style={ghostBtn}>← Volver a la transcripción</button>
                <button onClick={analyze} style={primaryBtn}>🔄 Reintentar</button>
              </div>
            </>
          ) : analysis ? (
            <>
              <div style={okBox}>
                ✅ Análisis completado — Clase {numClase} con {props.studentName}
              </div>

              {savedOk ? (
                <>
                  <div style={{ ...okBox, marginTop: 12 }}>💾 Guardado en el historial del alumno.</div>
                  <div style={{ marginTop: 14 }}>
                    <TranscriptAnalysisView a={analysis} />
                  </div>
                  <div style={{ ...navRow, justifyContent: 'flex-end' }}>
                    <button onClick={props.onClose} style={ghostBtn}>Cerrar</button>
                    <button onClick={() => props.onGenerateNext(analysis)} style={primaryBtn}>
                      ✨ Generar siguiente clase
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ marginTop: 14 }}>
                    {editing
                      ? <AnalysisEditor a={analysis} onChange={setAnalysis} />
                      : <TranscriptAnalysisView a={analysis} />}
                  </div>
                  {error && <div style={{ ...errBox, marginTop: 12 }}>⚠️ {error}</div>}
                  <div style={{ ...navRow, flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button onClick={analyze} disabled={saving} style={ghostBtn}>🔄 Regenerar</button>
                      <button onClick={() => setEditing(e => !e)} disabled={saving} style={ghostBtn}>
                        {editing ? '👁️ Ver como quedará' : '✏️ Editar antes de guardar'}
                      </button>
                    </div>
                    <button onClick={save} disabled={saving} style={{ ...primaryBtn, opacity: saving ? 0.7 : 1 }}>
                      {saving ? 'Guardando…' : '✅ Guardar análisis'}
                    </button>
                  </div>
                </>
              )}
            </>
          ) : null}
        </>
      )}
    </Modal>
  );
}

// ── Spinner con mensajes rotativos ────────────────────────────────────────────
function RotatingSpinner() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI(n => (n + 1) % SPINNER_MSGS.length), 2600);
    return () => clearInterval(t);
  }, []);
  return (
    <div style={{ padding: '44px 0', textAlign: 'center' }}>
      <style dangerouslySetInnerHTML={{ __html: `@keyframes drc-spin{to{transform:rotate(360deg)}}` }} />
      <div style={{
        width: 34, height: 34, margin: '0 auto 16px', borderRadius: '50%',
        border: '3px solid #e5e7eb', borderTopColor: DRC.green, animation: 'drc-spin 0.8s linear infinite',
      }} />
      <div style={{ fontSize: 14, fontWeight: 600, color: '#374151' }}>{SPINNER_MSGS[i]}</div>
      <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 6 }}>Puede tardar hasta un minuto.</div>
    </div>
  );
}

// ── Editor del análisis antes de guardar ──────────────────────────────────────
function AnalysisEditor({ a, onChange }: { a: TranscriptIA; onChange: (a: TranscriptIA) => void }) {
  const set = (k: keyof TranscriptIA, v: unknown) => onChange({ ...a, [k]: v });
  const setGuide = (k: keyof TranscriptIA['nextClassGuide'], v: string) =>
    onChange({ ...a, nextClassGuide: { ...a.nextClassGuide, [k]: v } });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Edit label="Título de la clase" value={a.classTitle} onChange={v => set('classTitle', v)} />
      <Edit label="Resumen de la clase" value={a.classSummary} onChange={v => set('classSummary', v)} rows={4} />
      <Edit label="Errores y patrones" value={a.errorsDetected} onChange={v => set('errorsDetected', v)} rows={4} />
      <Edit label="Progreso" value={a.progressNotes} onChange={v => set('progressNotes', v)} rows={3} />
      <Edit label="Contenidos trabajados" value={a.topicsCovered} onChange={v => set('topicsCovered', v)} rows={3} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
        <div>
          <label style={labelStyle}>Señal de riesgo</label>
          <select
            value={a.riskSignal}
            onChange={e => set('riskSignal', isRiskSignal(e.target.value) ? (e.target.value as RiskSignal) : 'verde')}
            style={inputStyle}
          >
            <option value="verde">🟢 Verde — en buen camino</option>
            <option value="amarillo">🟡 Amarillo — atención</option>
            <option value="rojo">🔴 Rojo — riesgo de baja</option>
          </select>
        </div>
        <div>
          <label style={labelStyle}>Progreso (1-10)</label>
          <input
            type="number" min={1} max={10} value={a.progressScore}
            onChange={e => set('progressScore', Math.min(10, Math.max(1, Number(e.target.value) || 5)))}
            style={inputStyle}
          />
        </div>
      </div>

      <Edit label="Motivo del riesgo" value={a.riskExplanation} onChange={v => set('riskExplanation', v)} rows={3} />

      <div style={{ fontSize: 12.5, fontWeight: 800, color: '#111827', marginTop: 4 }}>✨ Guía para la siguiente clase</div>
      <Edit label="Prioridad" value={a.nextClassGuide.priority} onChange={v => setGuide('priority', v)} rows={2} />
      <Edit label="Warm-up" value={a.nextClassGuide.warmUp} onChange={v => setGuide('warmUp', v)} rows={2} />
      <Edit label="Foco principal" value={a.nextClassGuide.mainFocus} onChange={v => setGuide('mainFocus', v)} rows={2} />
      <Edit label="Actividad" value={a.nextClassGuide.activity} onChange={v => setGuide('activity', v)} rows={2} />
      <Edit label="Notas" value={a.nextClassGuide.notes} onChange={v => setGuide('notes', v)} rows={2} />
    </div>
  );
}

function Edit({ label, value, onChange, rows = 1 }: {
  label: string; value: string; onChange: (v: string) => void; rows?: number;
}) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      {rows > 1 ? (
        <textarea value={value} onChange={e => onChange(e.target.value)} rows={rows}
          style={{ ...inputStyle, fontSize: 13, lineHeight: 1.5, resize: 'vertical' }} />
      ) : (
        <input value={value} onChange={e => onChange(e.target.value)} style={{ ...inputStyle, fontSize: 13 }} />
      )}
    </div>
  );
}

// ── Barra de pasos ────────────────────────────────────────────────────────────
function StepBar({ step }: { step: 1 | 2 | 3 }) {
  const labels = ['Datos', 'Transcripción', 'Análisis'];
  return (
    <div style={{ display: 'flex', gap: 6, marginBottom: 18 }}>
      {labels.map((l, i) => {
        const n = (i + 1) as 1 | 2 | 3;
        const done = n < step, active = n === step;
        return (
          <div key={l} style={{ flex: 1 }}>
            <div style={{
              height: 5, borderRadius: 3,
              background: done ? DRC.green : active ? DRC.yellow : '#e5e7eb',
              transition: 'background 0.25s',
            }} />
            <div style={{
              fontSize: 10.5, fontWeight: active ? 800 : 600, marginTop: 5,
              color: active ? '#111827' : done ? DRC.green : '#9ca3af',
            }}>
              {done ? '✓ ' : ''}{l}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const navRow: CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  gap: 8, marginTop: 18, paddingTop: 14, borderTop: '1px solid #e5e7eb',
};
