'use client';

// Ficha del alumno: diagnóstico generado por IA, primera clase y análisis de
// clases, más las respuestas crudas del formulario. Lee de student_profiles.
//
// Soporta los dos formatos de ficha: ai_ficha_json (actual) y ai_ficha
// (markdown, formato anterior). Si hay JSON, se prefiere.

import { useEffect, useState, type CSSProperties } from 'react';
import { FORM_QUESTIONS } from '@/lib/formQuestions';
import { fetchStudentProfile, asObject, riskOf, type StudentProfileRow } from '@/lib/aiClient';
import type { FichaIA, FirstClassIA } from '@/lib/aiTypes';
import { FichaFields, FichaMarkdown, RiskBadge } from '@/components/ai/FichaView';
import FirstClassModal from '@/components/ai/FirstClassModal';
import TranscriptModal from '@/components/ai/TranscriptModal';

interface Props {
  studentName: string;
  studentId?: string | null;
  formTokenId?: string | null;      // respaldo si el alumno no tiene id
  teacher?: { id?: string | null; name?: string | null };
  plan?: string | null;
  level?: string | null;
  classNumber?: number | null;
  onClose: () => void;
}

export default function FichaModal({
  studentName, studentId, formTokenId, teacher, plan, level, classNumber, onClose,
}: Props) {
  const [profile, setProfile] = useState<StudentProfileRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [firstClassOpen, setFirstClassOpen] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const row = await fetchStudentProfile({ studentId, formTokenId, studentName });
      if (!cancelled) { setProfile(row); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [studentId, formTokenId, studentName]);

  const ficha      = asObject<FichaIA>(profile?.ai_ficha_json);
  const firstClass = asObject<FirstClassIA>(profile?.ai_first_class);
  const risk       = riskOf(profile);

  return (
    <div style={overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={modal}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ fontWeight: 800, fontSize: 17, color: '#1E9E3A' }}>📋 Ficha de {studentName}</div>
            {risk && <RiskBadge risk={risk} compact />}
          </div>
          <button onClick={onClose} style={closeBtn} aria-label="Cerrar">×</button>
        </div>
        <div style={{ height: 3, width: 48, background: '#FFC400', borderRadius: 2, marginBottom: 16 }} />

        {loading ? (
          <div style={{ padding: '24px 0', textAlign: 'center', color: '#6b7280', fontSize: 14 }}>Cargando ficha…</div>
        ) : !profile ? (
          <div style={notice}>Todavía no hay ficha guardada para este alumno.</div>
        ) : (
          <>
            {ficha ? (
              <FichaFields ficha={ficha} />
            ) : profile.ai_status === 'ready' && profile.ai_ficha ? (
              <FichaMarkdown text={profile.ai_ficha} />
            ) : (
              <div style={warn}>
                {profile.ai_status === 'skipped'
                  ? 'La ficha automática no está disponible (falta configurar la IA). Abajo están las respuestas del alumno.'
                  : 'No se pudo generar la ficha automática. Abajo están las respuestas del alumno.'}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              {ficha && (
                <button onClick={() => setFirstClassOpen(true)} style={actionBtn}>
                  ✨ {firstClass ? 'Ver primera clase generada' : 'Generar primera clase'}
                </button>
              )}
              <button onClick={() => setTranscriptOpen(true)} style={actionBtn}>📝 Subir transcripción</button>
            </div>

            <div style={{ fontWeight: 700, fontSize: 14, color: '#374151', margin: '20px 0 10px' }}>📝 Respuestas del alumno</div>
            <RawResponses responses={asObject<Record<string, unknown>>(profile.form_responses) ?? {}} />
          </>
        )}

        {firstClassOpen && profile && ficha && (
          <FirstClassModal
            profileId={profile.id}
            studentName={studentName}
            teacherName={teacher?.name ?? ''}
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
            studentId={studentId ?? profile?.student_id ?? null}
            teacherId={teacher?.id ?? null}
            teacherName={teacher?.name ?? ''}
            profileId={profile?.id ?? null}
            plan={plan}
            level={level}
            classNumber={classNumber}
            ficha={ficha}
            onAnalyzed={a => setProfile(p => (p ? { ...p, risk_signal: a.riskSignal } : p))}
            onClose={() => setTranscriptOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

function RawResponses({ responses }: { responses: Record<string, unknown> }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {FORM_QUESTIONS.map(q => {
        const v = responses[q.id];
        let text: string;
        if (q.type === 'checkbox' && Array.isArray(v)) text = v.length ? (v as string[]).join(', ') : '—';
        else if (q.type === 'matrix' && v && typeof v === 'object') {
          const obj = v as Record<string, string>;
          text = (q.rows ?? []).map(r => `${r}: ${obj[r] ?? '—'}`).join(' · ');
        } else text = v != null && String(v).trim() ? String(v) : '—';
        return (
          <div key={q.id}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: '#111827', marginBottom: 3 }}>{q.title}</div>
            <div style={{ fontSize: 13, color: '#4b5563', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{text}</div>
          </div>
        );
      })}
    </div>
  );
}

const overlay: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
  zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
};
const modal: CSSProperties = {
  background: '#F7F7F5', border: '2px solid #1E9E3A', borderRadius: 16, padding: 24,
  width: '100%', maxWidth: 620, maxHeight: '90vh', overflowY: 'auto',
};
const closeBtn: CSSProperties = {
  border: 'none', background: 'transparent', fontSize: 22, cursor: 'pointer', color: '#6b7280', lineHeight: 1,
};
const notice: CSSProperties = {
  padding: '14px 16px', borderRadius: 10, background: '#f3f4f6', color: '#6b7280', fontSize: 14,
};
const warn: CSSProperties = {
  fontSize: 12.5, color: '#92400E', background: 'rgba(255,196,0,0.14)',
  border: '1px solid rgba(255,196,0,0.45)', borderRadius: 8, padding: '10px 12px',
};
const actionBtn: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 13px', borderRadius: 8,
  border: '1.5px solid #1E9E3A', background: 'white', color: '#1E9E3A',
  cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
};
