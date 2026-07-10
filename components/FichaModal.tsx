'use client';

// Muestra la ficha del alumno: la ficha + primera clase generada por IA y las
// respuestas crudas del formulario. Lee de student_profiles.

import { useEffect, useState, type CSSProperties } from 'react';
import { supabase } from '@/lib/supabase';
import { FORM_QUESTIONS } from '@/lib/formQuestions';

interface Props {
  studentName: string;
  studentId?: string | null;
  formTokenId?: string | null;      // respaldo si el alumno no tiene id
  onClose: () => void;
}

interface Profile {
  ai_ficha: string | null;
  ai_status: string | null;
  form_responses: Record<string, unknown> | null;
}

export default function FichaModal({ studentName, studentId, formTokenId, onClose }: Props) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cols = 'ai_ficha, ai_status, form_responses';
      // Preferimos por student_id; si no aparece, caemos al token que completó el
      // formulario (cubre fichas guardadas sin vincular al alumno).
      let data: Profile | null = null;
      if (studentId) {
        const r = await supabase.from('student_profiles').select(cols)
          .eq('student_id', studentId).order('updated_at', { ascending: false }).limit(1).maybeSingle();
        data = (r.data as Profile) ?? null;
      }
      if (!data && formTokenId) {
        const r = await supabase.from('student_profiles').select(cols)
          .eq('form_token_id', formTokenId).limit(1).maybeSingle();
        data = (r.data as Profile) ?? null;
      }
      if (!cancelled) { setProfile(data); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [studentId, formTokenId]);

  return (
    <div style={overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={modal}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
          <div style={{ fontWeight: 800, fontSize: 17, color: '#1E9E3A' }}>📋 Ficha de {studentName}</div>
          <button onClick={onClose} style={{ border: 'none', background: 'transparent', fontSize: 22, cursor: 'pointer', color: '#6b7280', lineHeight: 1 }}>×</button>
        </div>
        <div style={{ height: 3, width: 48, background: '#FFC400', borderRadius: 2, marginBottom: 16 }} />

        {loading ? (
          <div style={{ padding: '24px 0', textAlign: 'center', color: '#6b7280', fontSize: 14 }}>Cargando ficha…</div>
        ) : !profile ? (
          <div style={{ padding: '14px 16px', borderRadius: 10, background: '#f3f4f6', color: '#6b7280', fontSize: 14 }}>
            Todavía no hay ficha guardada para este alumno.
          </div>
        ) : (
          <>
            {profile.ai_status === 'ready' && profile.ai_ficha ? (
              <FichaText text={profile.ai_ficha} />
            ) : (
              <div style={{ fontSize: 12.5, color: '#92400E', background: 'rgba(255,196,0,0.14)', border: '1px solid rgba(255,196,0,0.45)', borderRadius: 8, padding: '10px 12px', marginBottom: 16 }}>
                {profile.ai_status === 'skipped'
                  ? 'La ficha automática no está disponible (falta configurar la IA). Abajo están las respuestas del alumno.'
                  : 'No se pudo generar la ficha automática. Abajo están las respuestas del alumno.'}
              </div>
            )}

            <div style={{ fontWeight: 700, fontSize: 14, color: '#374151', margin: '18px 0 10px' }}>📝 Respuestas del alumno</div>
            <RawResponses responses={profile.form_responses ?? {}} />
          </>
        )}
      </div>
    </div>
  );
}

// Render muy simple de markdown: ## → subtítulo, - → viñeta, resto párrafo.
function FichaText({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <div style={{ background: 'white', border: '1px solid #d1d5db', borderRadius: 10, padding: '14px 16px' }}>
      {lines.map((raw, i) => {
        const line = raw.trimEnd();
        if (!line.trim()) return <div key={i} style={{ height: 8 }} />;
        if (line.startsWith('## ')) {
          return <div key={i} style={{ fontSize: 15, fontWeight: 800, color: '#1E9E3A', margin: '10px 0 6px' }}>{line.slice(3)}</div>;
        }
        if (line.startsWith('# ')) {
          return <div key={i} style={{ fontSize: 16, fontWeight: 800, color: '#111827', margin: '10px 0 6px' }}>{line.slice(2)}</div>;
        }
        if (/^\s*[-*]\s+/.test(line)) {
          return <div key={i} style={{ fontSize: 13.5, color: '#374151', lineHeight: 1.5, paddingLeft: 14, position: 'relative' }}>
            <span style={{ position: 'absolute', left: 0, color: '#1E9E3A' }}>•</span>{line.replace(/^\s*[-*]\s+/, '')}
          </div>;
        }
        return <div key={i} style={{ fontSize: 13.5, color: '#374151', lineHeight: 1.5, margin: '2px 0' }}>{line}</div>;
      })}
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
