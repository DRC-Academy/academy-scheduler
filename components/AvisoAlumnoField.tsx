'use client';
// ── Campo "¿Cuándo te avisó?" ─────────────────────────────────────────────────
//
// Fecha y hora (de España) en que el alumno avisó de que no iba a la clase. Lo
// usan el "Reprogramar" de Mis clases, la cancelación sobre la hora de "Añadir
// clase" y la falta con aviso que se registra al marcar una recuperación. La
// regla (antelación, 24 h, no futuro) vive en lib/avisoAlumno; acá solo se pinta.

import { useState, type CSSProperties } from 'react';
import { avisoAhoraEnEspana, problemaDelAviso, type AvisoEnEspana } from '@/lib/avisoAlumno';

/**
 * Estado del campo: el aviso (por defecto, ahora) y el "ahora" contra el que se
 * comprueba que no sea futuro. El reloj se lee al abrir y en cada cambio —en el
 * manejador, no en el render—, que es cuando la comprobación significa algo.
 */
export function useAvisoEnEspana() {
  const [estado, setEstado] = useState(() => {
    const ahoraMs = Date.now();
    return { aviso: avisoAhoraEnEspana(ahoraMs), ahoraMs };
  });
  return {
    aviso: estado.aviso,
    setAviso: (aviso: AvisoEnEspana) => setEstado({ aviso, ahoraMs: Date.now() }),
    /** Por qué no vale, o null. */
    problema: problemaDelAviso(estado.aviso, estado.ahoraMs),
    /** Hoy en España: tope del selector de fecha. */
    hoy: avisoAhoraEnEspana(estado.ahoraMs).fecha,
  };
}

export function AvisoAlumnoField({ label = '¿Cuándo te avisó?', value, onChange, maxFecha, problema, disabled, inputStyle, labelStyle }: {
  label?: string;
  value: AvisoEnEspana;
  onChange: (v: AvisoEnEspana) => void;
  /** Hoy en España: el navegador no deja elegir un día futuro. La hora se comprueba aparte. */
  maxFecha?: string;
  /** Por qué el aviso no vale (lib/avisoAlumno.problemaDelAviso), o null. */
  problema?: string | null;
  disabled?: boolean;
  inputStyle?: CSSProperties;
  labelStyle?: CSSProperties;
}) {
  return (
    <div>
      <label style={labelStyle ?? { fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
        {label} <span style={{ color: '#ef4444' }}>*</span> <span style={{ fontWeight: 400 }}>🇪🇸</span>
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <input type="date" value={value.fecha} max={maxFecha} disabled={disabled}
          onChange={e => onChange({ ...value, fecha: e.target.value })} style={inputStyle ?? { width: '100%' }} />
        <input type="time" value={value.hora} disabled={disabled}
          onChange={e => onChange({ ...value, hora: e.target.value })} style={inputStyle ?? { width: '100%' }} />
      </div>
      {problema && (
        <div style={{ fontSize: 11.5, color: '#b45309', marginTop: 6, lineHeight: 1.5 }}>⚠️ {problema}</div>
      )}
    </div>
  );
}

export default AvisoAlumnoField;
