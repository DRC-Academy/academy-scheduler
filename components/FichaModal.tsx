'use client';

// Ficha del alumno en modal (se abre desde el badge del formulario).
// El contenido es el mismo panel que se ve en Mis Alumnos, más las respuestas
// crudas del formulario.

import { useEffect, useState, type CSSProperties } from 'react';
import { FORM_QUESTIONS } from '@/lib/formQuestions';
import { fetchStudentProfile } from '@/lib/aiClient';
import { asObject } from '@/lib/aiTypes';
import AiStudentPanel from '@/components/ai/AiStudentPanel';
import { Section } from '@/components/ai/FichaView';
import { Modal, ModalHeader } from '@/components/ai/modalUi';

interface Props {
  studentName: string;
  studentId?: string | null;
  formTokenId?: string | null;
  teacher?: { id?: string | null; name?: string | null };
  plan?: string | null;
  level?: string | null;
  classNumber?: number | null;
  onClose: () => void;
}

export default function FichaModal({
  studentName, studentId, formTokenId, teacher, plan, level, classNumber, onClose,
}: Props) {
  const [responses, setResponses] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const row = await fetchStudentProfile({ studentId, formTokenId, studentName });
      if (!cancelled) setResponses(asObject<Record<string, unknown>>(row?.form_responses) ?? {});
    })();
    return () => { cancelled = true; };
  }, [studentId, formTokenId, studentName]);

  return (
    <Modal onClose={onClose} maxWidth={720}>
      <ModalHeader title={`📋 Ficha de ${studentName}`} onClose={onClose} />

      <AiStudentPanel
        studentName={studentName}
        studentId={studentId}
        formTokenId={formTokenId}
        teacherId={teacher?.id}
        teacherName={teacher?.name ?? ''}
        plan={plan}
        level={level}
        classNumber={classNumber}
        alwaysOpen
      />

      {responses && Object.keys(responses).length > 0 && (
        <div style={{ marginTop: 18 }}>
          <Section icon="📝" title="Respuestas del formulario" defaultOpen={false}>
            <RawResponses responses={responses} />
          </Section>
        </div>
      )}
    </Modal>
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
            <div style={qTitle}>{q.title}</div>
            <div style={qBody}>{text}</div>
          </div>
        );
      })}
    </div>
  );
}

const qTitle: CSSProperties = { fontSize: 12.5, fontWeight: 700, color: '#111827', marginBottom: 3 };
const qBody: CSSProperties = { fontSize: 13, color: '#4b5563', lineHeight: 1.5, whiteSpace: 'pre-wrap' };
