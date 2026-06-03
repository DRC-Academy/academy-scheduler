'use client';
import { TeacherStatus } from '@/types';

const statusConfig: Record<TeacherStatus, { label: string; dot: string; className: string }> = {
  available: { label: 'Disponible', dot: '#22c55e', className: 'status-available' },
  almost_full: { label: 'Casi lleno', dot: '#f59e0b', className: 'status-almost' },
  busy: { label: 'Ocupado', dot: '#ef4444', className: 'status-busy' },
  vacation: { label: 'Vacaciones', dot: '#a78bfa', className: 'status-vacation' },
  no_availability: { label: 'Sin disponibilidad', dot: '#6b7280', className: 'status-none' },
};

export function StatusBadge({ status }: { status: TeacherStatus }) {
  const cfg = statusConfig[status];
  return (
    <span className={cfg.className} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 500,
      background: status === 'available' ? 'rgba(20,83,45,0.3)' :
        status === 'almost_full' ? 'rgba(120,53,15,0.3)' :
        status === 'busy' ? 'rgba(127,29,29,0.3)' :
        status === 'vacation' ? 'rgba(76,29,149,0.3)' : 'rgba(17,24,39,0.5)',
      color: cfg.dot,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: cfg.dot, display: 'inline-block' }} />
      {cfg.label}
    </span>
  );
}

export function getStatusLabel(status: TeacherStatus) {
  return statusConfig[status].label;
}
