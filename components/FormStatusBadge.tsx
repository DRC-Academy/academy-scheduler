'use client';

// Indicador de estado del formulario inicial, junto al nombre del alumno.
// El ENVÍO del formulario ya no vive acá: el link viaja dentro del correo de
// presentación del profesor. Este componente solo muestra el estado y, cuando
// está completado, permite ver la ficha.
//
//   · sin token    → no muestra nada
//   · pendiente    → badge gris "⏳ Formulario enviado — pendiente"
//   · completado   → badge verde "✅ completado" + "📋 Ver ficha"
//   · expirado     → badge naranja "⚠️ link expirado"

import { useState, type CSSProperties } from 'react';
import { formStateOf, type FormTokenInfo } from '@/lib/formClient';
import FichaModal from '@/components/FichaModal';

interface Props {
  student: { id?: string | null; name: string; email?: string | null };
  info?: FormTokenInfo | null;
  compact?: boolean;
  // Aceptados por compatibilidad con los llamadores; ya no se usan para enviar.
  teacher?: { id: string; name: string };
  assignment?: { id?: string | null; plan?: string | null; level?: string | null };
  onRefresh?: () => void;
}

export default function FormStatusBadge({ student, info, compact }: Props) {
  const [fichaOpen, setFichaOpen] = useState(false);
  const state = formStateOf(info);
  if (state === 'none') return null;

  const btn: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 5, padding: compact ? '4px 9px' : '6px 12px',
    borderRadius: 8, cursor: 'pointer', fontSize: compact ? 11.5 : 12.5, fontFamily: 'inherit', fontWeight: 700,
    border: '1.5px solid #1E9E3A', background: 'white', color: '#1E9E3A', whiteSpace: 'nowrap',
  };
  const badge: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 9px', borderRadius: 10,
    fontSize: compact ? 10.5 : 11.5, fontWeight: 700, whiteSpace: 'nowrap',
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {state === 'pending' && (
        <span style={{ ...badge, background: 'rgba(120,120,120,0.12)', border: '1px solid rgba(120,120,120,0.3)', color: '#4b5563' }}>
          ⏳ Formulario enviado — pendiente
        </span>
      )}

      {state === 'completed' && (
        <>
          <span style={{ ...badge, background: 'rgba(30,158,58,0.14)', border: '1px solid rgba(30,158,58,0.4)', color: '#166534' }}>
            ✅ Formulario completado
          </span>
          <button onClick={() => setFichaOpen(true)} style={btn}>📋 Ver ficha</button>
        </>
      )}

      {state === 'expired' && (
        <span style={{ ...badge, background: 'rgba(249,115,22,0.12)', border: '1px solid rgba(249,115,22,0.4)', color: '#c2410c' }}>
          ⚠️ Link expirado
        </span>
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
