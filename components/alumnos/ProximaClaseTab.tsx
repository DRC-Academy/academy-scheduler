'use client';

// Tab "Próxima clase" — concentra el ciclo completo del profesor:
//   A: sin clase generada       → generar
//   B: clase lista              → verla, copiarla, registrar que la dio
//   C: registrando              → formulario inline (fecha/hora/transcripción)
//   D: analizando               → carga sobria
//   E: análisis + nueva clase   → guardar todo / regenerar
//
// La clase generada se persiste sola en el endpoint, así que salir de aquí no
// pierde nada.

import { useState } from 'react';
import { analyzeTranscriptOnly, saveAnalysis, generateNextClassClient, analysisFromRow } from '@/lib/aiClient';
import type { ClassAnalysisRow, FichaIA, GeneratedClassIA, TranscriptIA, StudentProfileRow } from '@/lib/aiTypes';
import { isRiskSignal } from '@/lib/aiTypes';
import { ClassCard, classToText, copyText } from '@/components/alumnos/ClassContent';
import { isConversacionGuiada } from '@/lib/aiTypes';
import { printClassPdf } from '@/lib/classDoc';
import {
  Collapsible, RiskDot, btnPrimary, btnSecondary, bodyTextStyle,
  cardStyle, fieldLabelStyle, DRC_GREEN,
} from '@/components/alumnos/ui';
import type { Assignment } from '@/types';

export type Stage = 'idle' | 'registering' | 'analyzing' | 'reviewing';

interface Props {
  assignment: Assignment;
  profile: StudentProfileRow | null;
  ficha: FichaIA | null;
  analyses: ClassAnalysisRow[];
  nextClass: GeneratedClassIA | null;
  teacherName: string;
  nextNumber: number;
  onToast: (m: string) => void;
  onRefresh: () => Promise<void>;
  onNextClass: (nc: GeneratedClassIA) => void;
}

export default function ProximaClaseTab(p: Props) {
  const [stage, setStage] = useState<Stage>('idle');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Registro
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [time, setTime] = useState('');
  const [transcript, setTranscript] = useState('');

  // Resultado
  const [analysis, setAnalysis] = useState<TranscriptIA | null>(null);
  const [newClass, setNewClass] = useState<GeneratedClassIA | null>(null);
  const [saving, setSaving] = useState(false);

  const history = p.analyses.slice(0, 3).map(h => ({
    clase: h.class_number, fecha: h.class_date ?? h.analyzed_at, titulo: h.class_title,
    resumen: h.class_summary, errores: h.errors_detected, riesgo: h.risk_signal,
  }));

  // El análisis de la última clase dada: es lo que hace que la clase generada
  // retome los errores anteriores en vez de salir de la nada.
  const lastAnalysis = p.analyses[0] ? analysisFromRow(p.analyses[0]) : null;

  const baseArgs = {
    studentName: p.assignment.studentName,
    teacherName: p.teacherName,
    studentId: p.assignment.studentId || p.profile?.student_id || null,
    teacherId: p.assignment.teacherId,
    profileId: p.profile?.id ?? null,
    plan: p.assignment.plan,
    level: p.assignment.studentLevel,
  };

  // ── Generar clase (estado A, o regenerar) ──
  async function generate(classNumber: number, basedOn: TranscriptIA | null) {
    if (!p.ficha) return;
    setGenerating(true);
    setError(null);
    try {
      const nc = await generateNextClassClient({
        ...baseArgs,
        profileId: p.profile?.id ?? '',
        classNumber,
        studentProfile: p.ficha,
        lastAnalysis: basedOn,
        classHistory: history,
      });
      p.onNextClass(nc);
      p.onToast('Clase generada y guardada');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo generar la clase.');
    } finally {
      setGenerating(false);
    }
  }

  // ── Analizar (estado C → D → E) ──
  async function analyze() {
    if (transcript.trim().split(/\s+/).length < 30) {
      setError('La transcripción es demasiado corta. Pega el texto completo de la clase.');
      return;
    }
    setStage('analyzing');
    setError(null);
    try {
      const claseDada = p.nextClass?.classNumber ?? p.nextNumber;
      const a = await analyzeTranscriptOnly({
        ...baseArgs,
        transcript: transcript.trim(),
        classNumber: claseDada,
        classDate: date || null,
        studentProfile: p.ficha,
        classHistory: history,
      });
      setAnalysis(a);

      // Y encadenamos la siguiente clase: el endpoint ya la persiste.
      if (p.ficha) {
        try {
          const nc = await generateNextClassClient({
            ...baseArgs,
            profileId: p.profile?.id ?? '',
            classNumber: claseDada + 1,
            studentProfile: p.ficha,
            lastAnalysis: a,
            classHistory: [{ clase: claseDada, fecha: date, resumen: a.classSummary, errores: a.errorsDetected }, ...history],
          });
          setNewClass(nc);
        } catch (err) {
          // El análisis sí lo tenemos: no lo perdemos por fallar la generación.
          setError(`El análisis salió bien, pero no se pudo generar la siguiente clase: ${err instanceof Error ? err.message : ''}`);
        }
      }
      setStage('reviewing');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo analizar la clase.');
      setStage('registering');
    }
  }

  // ── Guardar todo (estado E) ──
  async function saveAll() {
    if (!analysis) return;
    setSaving(true);
    setError(null);
    try {
      await saveAnalysis({
        ...baseArgs,
        transcript: transcript.trim(),
        classNumber: p.nextClass?.classNumber ?? p.nextNumber,
        classDate: date || null,
        analysis,
      });
      await p.onRefresh();
      p.onToast('Clase guardada correctamente');
      setStage('idle');
      setAnalysis(null);
      setNewClass(null);
      setTranscript('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar.');
    } finally {
      setSaving(false);
    }
  }

  async function handleCopy() {
    if (!p.nextClass) return;
    await copyText(classToText(p.nextClass, p.assignment.studentName));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handlePdf(nc: GeneratedClassIA) {
    printClassPdf(nc, {
      studentName: p.assignment.studentName,
      teacherName: p.teacherName,
      level: p.assignment.studentLevel,
      classTypeLabel: isConversacionGuiada(nc) ? 'Conversación guiada' : 'Metodología aplicada',
    });
  }

  // ═══ ESTADO D — analizando ═══
  if (stage === 'analyzing') {
    return (
      <div style={{ ...cardStyle, textAlign: 'center', padding: '48px 20px' }}>
        <style dangerouslySetInnerHTML={{ __html: '@keyframes alu-bar{0%{left:-40%}100%{left:100%}}' }} />
        <div style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 16 }}>Analizando la clase...</div>
        <div style={{ position: 'relative', height: 3, borderRadius: 2, background: 'var(--border)', overflow: 'hidden', maxWidth: 260, margin: '0 auto' }}>
          <div style={{ position: 'absolute', top: 0, height: '100%', width: '40%', background: DRC_GREEN, animation: 'alu-bar 1.1s ease-in-out infinite' }} />
        </div>
      </div>
    );
  }

  // ═══ ESTADO E — análisis completado ═══
  if (stage === 'reviewing' && analysis) {
    const risk = isRiskSignal(analysis.riskSignal) ? analysis.riskSignal : 'verde';
    return (
      <div>
        <div style={cardStyle}>
          <Collapsible title="Resumen de la clase" defaultOpen>
            <div style={bodyTextStyle}>{analysis.classSummary}</div>
          </Collapsible>
          <Collapsible title="Errores detectados">
            <div style={bodyTextStyle}>{analysis.errorsDetected}</div>
          </Collapsible>
          <Collapsible title="Progreso">
            <div style={bodyTextStyle}>{analysis.progressNotes}</div>
          </Collapsible>
          <div style={{ paddingTop: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Señal de riesgo:</span>
              <RiskDot risk={risk} />
            </div>
            <div style={bodyTextStyle}>{analysis.riskExplanation}</div>
          </div>
        </div>

        {newClass && (
          <div style={{ marginTop: 24 }}>
            <ClassCard nc={newClass} level={p.assignment.studentLevel} />
            <div style={{ marginTop: 10 }}>
              <button onClick={() => handlePdf(newClass)} style={btnSecondary}>PDF</button>
            </div>
          </div>
        )}

        {error && <div style={errStyle}>{error}</div>}

        <div className="alu-btn-row" style={{ display: 'flex', gap: 10, marginTop: 24 }}>
          <button onClick={saveAll} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }}>
            {saving ? 'Guardando...' : 'Guardar todo'}
          </button>
          <button onClick={analyze} disabled={saving} style={btnSecondary}>Regenerar</button>
        </div>
      </div>
    );
  }

  // ═══ ESTADO C — registrando ═══
  if (stage === 'registering') {
    const claseDada = p.nextClass?.classNumber ?? p.nextNumber;
    const words = transcript.trim() ? transcript.trim().split(/\s+/).length : 0;
    return (
      <div style={cardStyle}>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16 }}>
          Registrar clase {claseDada}
        </div>

        <div className="alu-two-col" style={{ marginBottom: 16 }}>
          <div>
            <label style={fieldLabelStyle} htmlFor="alu-date">Fecha</label>
            <input id="alu-date" type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={fieldLabelStyle} htmlFor="alu-time">Hora</label>
            <input id="alu-time" type="time" value={time} onChange={e => setTime(e.target.value)} style={inputStyle} />
          </div>
        </div>

        <label style={fieldLabelStyle} htmlFor="alu-tr">Transcripción de la clase</label>
        <textarea
          id="alu-tr"
          value={transcript}
          onChange={e => { setTranscript(e.target.value); setError(null); }}
          placeholder="Pega aquí la transcripción de Fathom..."
          className="alu-textarea"
          style={{ ...inputStyle, minHeight: 200, resize: 'vertical', lineHeight: 1.5 }}
        />
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 5 }}>{words} palabras</div>

        {error && <div style={errStyle}>{error}</div>}

        <div className="alu-btn-row" style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button onClick={analyze} style={btnPrimary}>Analizar y generar siguiente clase</button>
          <button onClick={() => { setStage('idle'); setError(null); }} style={btnSecondary}>Cancelar</button>
        </div>
      </div>
    );
  }

  // ═══ ESTADO B — clase generada ═══
  if (p.nextClass) {
    return (
      <div>
        <ClassCard nc={p.nextClass} level={p.assignment.studentLevel} />
        {error && <div style={errStyle}>{error}</div>}
        <div className="alu-btn-row" style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button onClick={() => setStage('registering')} style={btnPrimary}>Registrar clase dada</button>
          <button onClick={handleCopy} style={btnSecondary}>{copied ? 'Copiada' : 'Copiar clase completa'}</button>
          <button onClick={() => handlePdf(p.nextClass!)} style={btnSecondary}>PDF</button>
          <button
            onClick={() => generate(p.nextClass!.classNumber, lastAnalysis)}
            disabled={generating}
            style={{ ...btnSecondary, opacity: generating ? 0.6 : 1 }}
          >
            {generating ? 'Generando...' : 'Regenerar'}
          </button>
        </div>
      </div>
    );
  }

  // ═══ ESTADO A — sin clase ═══
  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: p.ficha ? 16 : 6 }}>
        No hay clase preparada para este alumno.
      </div>
      {p.ficha ? (
        <>
          <button
            onClick={() => generate(p.nextNumber, lastAnalysis)}
            disabled={generating}
            style={{ ...btnPrimary, opacity: generating ? 0.6 : 1 }}
          >
            {generating ? 'Generando...' : p.analyses.length > 0 ? `Generar clase ${p.nextNumber}` : 'Generar primera clase'}
          </button>
          {error && <div style={errStyle}>{error}</div>}
        </>
      ) : (
        <div style={{ fontSize: 14, color: 'var(--text-muted)' }}>Genera la ficha del alumno primero.</div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', borderRadius: 8, border: '1px solid var(--border)', padding: '9px 12px',
  fontFamily: 'inherit', fontSize: 14, color: 'var(--text-primary)', background: 'var(--bg-surface)',
};
const errStyle: React.CSSProperties = {
  marginTop: 14, padding: '10px 13px', borderRadius: 8, background: 'rgba(220,38,38,0.07)',
  border: '1px solid rgba(220,38,38,0.3)', color: '#B91C1C', fontSize: 13, lineHeight: 1.5,
};
