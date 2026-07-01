'use client';

// Resumen visual del autocompletado del alumno (WooCommerce + tabla students).
// Se muestra debajo del campo email en los formularios de asignación.

import type { ReactNode } from 'react';
import { planBadgeStyle } from '@/lib/productUtils';
import type { StudentAutofill } from '@/lib/useStudentAutofill';

const GREEN = '#1E9E3A';

// 'YYYY-MM-DD' → 'DD/MM/YYYY'.
function fmt(d?: string | null): string | null {
  if (!d) return null;
  const [y, m, day] = d.split('-');
  if (!y || !m || !day) return d;
  return `${day}/${m}/${y}`;
}

// Fila del resumen (definida a nivel de módulo para no recrearla en cada render).
function Row({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>{children}</div>;
}

// Etiqueta legible del estado de suscripción.
const STATUS_LABEL: Record<string, string> = {
  active: 'Activa', manual_active: 'Activa (manual)', manual_override: 'Activa (manual)',
  cancelled: 'Cancelada', 'pending-cancel': 'Cancelación pendiente', 'on-hold': 'En pausa',
  expired: 'Expirada', 'one_time_no_access': 'Pago único — sin acceso',
  not_found: 'No encontrada', error: 'No verificable',
};

export function StudentAutofillCard({ data, currentLevel }: { data: StudentAutofill; currentLevel?: string }) {
  const { loading, existing, woo, classification, detection } = data;

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-muted)', padding: '10px 4px' }}>
        <span className="drc-spinner-xs" /> Buscando datos del alumno...
      </div>
    );
  }

  const hasWoo = !!woo?.productFullName;
  if (!existing && !hasWoo) return null;

  const name = existing?.name || woo?.billingName || null;
  const level = currentLevel || existing?.level || woo?.detectedLevel || null;
  const levelDetected = !!(existing?.level || woo?.detectedLevel);
  const startDate = fmt(woo?.subscriptionStartDate);
  const statusLabel = woo?.status ? (STATUS_LABEL[woo.status] ?? woo.status) : null;
  const badge = classification ? planBadgeStyle(classification.type) : null;

  return (
    <div style={{
      background: 'rgba(30,158,58,0.07)', border: `1px solid ${GREEN}55`,
      borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 3,
    }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: GREEN, marginBottom: 3 }}>
        {existing ? '✅ Alumno existente encontrado' : '✅ Datos detectados de WooCommerce'}
      </div>

      {name && <Row>👤 <b style={{ color: 'var(--text-primary)' }}>{name}</b></Row>}
      {hasWoo && <Row>📦 {woo!.productFullName}</Row>}

      {classification && badge && (
        <Row>
          📝 Clasificación:{' '}
          <span style={{ fontSize: 11, fontWeight: 700, padding: '1px 8px', borderRadius: 10, background: badge.bg, color: badge.color }}>
            {classification.badge}
          </span>
        </Row>
      )}

      {detection?.hours != null && (
        <Row>🕐 Horas semanales: <b style={{ color: 'var(--text-primary)' }}>{detection.hours}</b> {detection.confidence === 'high' ? '(detectadas)' : ''}</Row>
      )}

      {startDate && <Row>📅 Inicio de suscripción: {startDate}</Row>}
      {statusLabel && <Row>{woo?.active ? '✅' : '⚠️'} Suscripción: {statusLabel}</Row>}

      <Row>
        📊 Nivel:{' '}
        {levelDetected
          ? <><b style={{ color: 'var(--text-primary)' }}>{level}</b> (detectado)</>
          : <span style={{ color: '#ea580c', fontWeight: 600 }}>⚠️ No detectado — completá manualmente</span>}
      </Row>
    </div>
  );
}
