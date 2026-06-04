'use client';
import { TeacherStatus } from '@/types';

const statusConfig: Record<TeacherStatus, { label: string; dot: string; bg: string; color: string }> = {
  available:       { label: 'Disponible',       dot: '#1E9E3A', bg: 'rgba(30,158,58,0.1)',   color: '#167a2d' },
  almost_full:     { label: 'Casi lleno',        dot: '#FFC400', bg: 'rgba(255,196,0,0.15)',  color: '#b38600' },
  busy:            { label: 'Completo',           dot: '#ef4444', bg: 'rgba(239,68,68,0.1)',   color: '#dc2626' },
  vacation:        { label: 'Vacaciones',         dot: '#8b5cf6', bg: 'rgba(139,92,246,0.1)', color: '#7c3aed' },
  no_availability: { label: 'Sin disponibilidad', dot: '#9ca3af', bg: 'rgba(156,163,175,0.1)',color: '#6b7280' },
};

export function StatusBadge({ status }: { status: TeacherStatus }) {
  const cfg = statusConfig[status];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600,
      background: cfg.bg, color: cfg.color,
      border: `1px solid ${cfg.dot}33`,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: cfg.dot, display: 'inline-block', flexShrink: 0 }} />
      {cfg.label}
    </span>
  );
}

export function getStatusLabel(status: TeacherStatus) {
  return statusConfig[status].label;
}
