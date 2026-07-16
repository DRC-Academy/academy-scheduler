'use client';

// Panel expandible "📋 Ver ficha IA" bajo cada alumno de Mis Alumnos.
// Muestra el diagnóstico y permite generar la primera clase y subir la
// transcripción de una clase.
//
// Sólo aparece si el alumno tiene ficha: si no hay nada que mostrar, no
// ensuciamos la tarjeta con un botón que lleva a un panel vacío.

import { useEffect, useState, type CSSProperties } from 'react';
import { fetchStudentProfile, asObject, riskOf, type StudentProfileRow } from '@/lib/aiClient';
import type { FichaIA, FirstClassIA } from '@/lib/aiTypes';
import { Field, RiskBadge, panelBox } from '@/components/ai/FichaView';
import FirstClassModal from '@/components/ai/FirstClassModal';
import TranscriptModal from '@/components/ai/TranscriptModal';

interface Props {
  studentName: string;
  studentId?: string | null;
  teacherId?: string | null;
  teacherName: string;
  plan?: string | null;
  level?: string | null;
  classNumber?: number | null;
}

export default function AiStudentPanel({
  studentName, studentId, teacherId, teacherName, plan, level, classNumber,
}: Props) {
  const [profile, setProfile] = useState<StudentProfileRow | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [firstClassOpen, setFirstClassOpen] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const row = await fetchStudentProfile({ studentId, studentName });
      if (!cancelled) { setProfile(row); setLoaded(true); }
    })();
    return () => { cancelled = true; };
  }, [studentId, studentName]);

  const ficha      = asObject<FichaIA>(profile?.ai_ficha_json);
  const firstClass = asObject<FirstClassIA>(profile?.ai_first_class);
  const risk       = riskOf(profile);

  // Sin ficha todavía: no mostramos nada hasta que el alumno complete el formulario.
  if (!loaded || !profile) return null;

  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px dashed var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button onClick={() => setOpen(o => !o)} style={toggleBtn} aria-expanded={open}>
          📋 {open ? 'Ocultar ficha IA' : 'Ver ficha IA'}
        </button>
        {risk && <RiskBadge risk={risk} compact />}
        {!ficha && profile.ai_status !== 'ready' && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Ficha automática no disponible</span>
        )}
      </div>

      {open && (
        <div style={{ marginTop: 10 }}>
          {ficha ? (
            <div style={panelBox}>
              <Field label="Diagnóstico inicial" value={ficha.initialDiagnosis} />
              <Field label="Puntos fuertes" value={ficha.strongPoints} />
              <Field label="Áreas a trabajar" value={ficha.weakPoints} />
              <Field label="Estilo de aprendizaje" value={ficha.learningStyle} />
              <Field label="Objetivo personal" value={ficha.personalObjective} />
            </div>
          ) : (
            <div style={warn}>
              {profile.ai_status === 'skipped'
                ? 'La ficha automática no está disponible (falta configurar la IA).'
                : profile.ai_ficha
                  ? 'Este alumno tiene una ficha en el formato anterior. Ábrela desde el badge del formulario.'
                  : 'Todavía no hay ficha generada para este alumno.'}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            {ficha && (
              <button onClick={() => setFirstClassOpen(true)} style={actionBtn}>
                ✨ {firstClass ? 'Ver primera clase generada' : 'Generar primera clase'}
              </button>
            )}
            <button onClick={() => setTranscriptOpen(true)} style={actionBtn}>📝 Subir transcripción</button>
          </div>
        </div>
      )}

      {firstClassOpen && ficha && (
        <FirstClassModal
          profileId={profile.id}
          studentName={studentName}
          teacherName={teacherName}
          plan={plan}
          level={level}
          ficha={ficha}
          cached={firstClass}
          onSaved={fc => setProfile(p => (p ? { ...p, ai_first_class: fc } : p))}
          onClose={() => setFirstClassOpen(false)}
        />
      )}

      {transcriptOpen && (
        <TranscriptModal
          studentName={studentName}
          studentId={studentId ?? profile.student_id}
          teacherId={teacherId}
          teacherName={teacherName}
          profileId={profile.id}
          plan={plan}
          level={level}
          classNumber={classNumber}
          ficha={ficha}
          onAnalyzed={a => setProfile(p => (p ? { ...p, risk_signal: a.riskSignal } : p))}
          onClose={() => setTranscriptOpen(false)}
        />
      )}
    </div>
  );
}

const toggleBtn: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 7,
  border: '1px solid rgba(30,158,58,0.4)', background: 'rgba(30,158,58,0.08)', color: '#1E9E3A',
  cursor: 'pointer', fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
};
const actionBtn: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 7,
  border: '1.5px solid #1E9E3A', background: 'white', color: '#1E9E3A',
  cursor: 'pointer', fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
};
const warn: CSSProperties = {
  fontSize: 12.5, color: '#92400E', background: 'rgba(255,196,0,0.14)',
  border: '1px solid rgba(255,196,0,0.45)', borderRadius: 8, padding: '10px 12px',
};
