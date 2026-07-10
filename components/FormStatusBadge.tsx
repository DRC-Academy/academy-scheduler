'use client';

// Indicador de estado del formulario inicial + botón de acción, para usar junto
// al nombre del alumno (en la ficha, en "Próximas clases", en avisos, etc.).
//
//   · sin token    → botón "📋 Enviar formulario"
//   · pendiente    → badge gris "⏳ enviado — pendiente" + "🔗 Reenviar link"
//   · completado   → badge verde "✅ completado" + "📋 Ver ficha"
//   · expirado     → badge naranja "⚠️ link expirado" + "🔄 Generar nuevo link"

import { useState, type CSSProperties } from 'react';
import { formStateOf, type FormTokenInfo } from '@/lib/formClient';
import FormLinkModal from '@/components/FormLinkModal';
import FichaModal from '@/components/FichaModal';

interface Props {
  student: { id?: string | null; name: string; email?: string | null };
  teacher: { id: string; name: string };
  assignment?: { id?: string | null; plan?: string | null; level?: string | null };
  info?: FormTokenInfo | null;      // token conocido del índice del padre
  onRefresh?: () => void;           // refrescar el índice tras generar
  compact?: boolean;                // versión más chica
}

export default function FormStatusBadge({ student, teacher, assignment, info, onRefresh, compact }: Props) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [fichaOpen, setFichaOpen] = useState(false);
  const state = formStateOf(info);

  const btn: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 5, padding: compact ? '4px 9px' : '6px 12px',
    borderRadius: 8, cursor: 'pointer', fontSize: compact ? 11.5 : 12.5, fontFamily: 'inherit', fontWeight: 700,
    border: 'none', whiteSpace: 'nowrap',
  };
  const badge: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 9px', borderRadius: 10,
    fontSize: compact ? 10.5 : 11.5, fontWeight: 700, whiteSpace: 'nowrap',
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {state === 'none' && (
        <button onClick={() => setLinkOpen(true)} style={{ ...btn, background: '#1E9E3A', color: 'white' }}>
          📋 Enviar formulario
        </button>
      )}

      {state === 'pending' && (
        <>
          <span style={{ ...badge, background: 'rgba(120,120,120,0.12)', border: '1px solid rgba(120,120,120,0.3)', color: '#4b5563' }}>
            ⏳ Formulario enviado — pendiente
          </span>
          <button onClick={() => setLinkOpen(true)} style={{ ...btn, background: 'white', border: '1.5px solid #1E9E3A', color: '#1E9E3A' }}>
            🔗 Reenviar link
          </button>
        </>
      )}

      {state === 'completed' && (
        <>
          <span style={{ ...badge, background: 'rgba(30,158,58,0.14)', border: '1px solid rgba(30,158,58,0.4)', color: '#166534' }}>
            ✅ Formulario completado
          </span>
          <button onClick={() => setFichaOpen(true)} style={{ ...btn, background: 'white', border: '1.5px solid #1E9E3A', color: '#1E9E3A' }}>
            📋 Ver ficha
          </button>
        </>
      )}

      {state === 'expired' && (
        <>
          <span style={{ ...badge, background: 'rgba(249,115,22,0.12)', border: '1px solid rgba(249,115,22,0.4)', color: '#c2410c' }}>
            ⚠️ Link expirado
          </span>
          <button onClick={() => setLinkOpen(true)} style={{ ...btn, background: '#1E9E3A', color: 'white' }}>
            🔄 Generar nuevo link
          </button>
        </>
      )}

      {linkOpen && (
        <FormLinkModal
          student={student}
          teacher={teacher}
          assignment={assignment}
          existing={info}
          onClose={() => setLinkOpen(false)}
          onGenerated={onRefresh}
        />
      )}
      {fichaOpen && (
        <FichaModal
          studentName={student.name}
          studentId={student.id}
          formTokenId={info?.id}
          onClose={() => setFichaOpen(false)}
        />
      )}
    </span>
  );
}
