'use client';

/**
 * Reemplaza al calendario cuando no se pudo leer (o guardar) de la base. Existe
 * para NO mostrar un calendario vacío editable: antes un fallo de lectura se
 * tomaba como "sin casillas" y el siguiente clic guardaba ese vacío encima.
 */
export default function CalendarLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" style={{
      border: '1px solid #f0c2c2', background: '#fdf3f3', color: '#8a1f1f',
      borderRadius: 12, padding: '16px 18px', fontSize: 14, lineHeight: 1.5,
    }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>No se pudo cargar el calendario</div>
      <div style={{ marginBottom: 12 }}>{message}</div>
      <button type="button" onClick={onRetry} style={{
        background: '#8a1f1f', color: '#fff', border: 'none', borderRadius: 8,
        padding: '8px 14px', fontSize: 13.5, fontWeight: 600, cursor: 'pointer',
      }}>
        Reintentar
      </button>
    </div>
  );
}
