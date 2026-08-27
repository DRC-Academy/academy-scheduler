'use client';
import { TeacherStatus } from '@/types';
import { Badge, type Tone } from '@/components/ui';

// Estado de ocupación del profesor. Se dibuja con el Badge del sistema
// (components/ui/Badge) en vez de con un pill propio: antes esta era una de las
// CUATRO implementaciones de pill que convivían en la tabla del admin, cada una
// con su padding y su tamaño de letra, y por eso las filas quedaban desparejas.
//
// El color sale del tono SEMÁNTICO, no de una paleta propia. `vacation` es
// neutral a propósito: estar de vacaciones no es ni bueno ni malo, y el violeta
// que usaba antes no existe en los tokens de la app.
const statusConfig: Record<TeacherStatus, { label: string; short: string; tone: Tone }> = {
  available:       { label: 'Disponible',         short: 'Disponible', tone: 'ok' },
  almost_full:     { label: 'Casi lleno',         short: 'Casi lleno', tone: 'warn' },
  busy:            { label: 'Completo',           short: 'Completo',   tone: 'danger' },
  vacation:        { label: 'Vacaciones',         short: 'Vacaciones', tone: 'neutral' },
  no_availability: { label: 'Sin disponibilidad', short: 'Sin disp.',  tone: 'neutral' },
};

export function StatusBadge({ status, compact = false }: {
  status: TeacherStatus;
  /** Etiqueta corta para columnas estrechas. El texto completo queda en el tooltip. */
  compact?: boolean;
}) {
  const cfg = statusConfig[status];
  const short = compact && cfg.short !== cfg.label;
  return (
    <Badge tone={cfg.tone} dot title={short ? cfg.label : undefined}>
      {compact ? cfg.short : cfg.label}
    </Badge>
  );
}

export function getStatusLabel(status: TeacherStatus) {
  return statusConfig[status].label;
}
