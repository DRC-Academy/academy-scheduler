'use client';
import { CSSProperties } from 'react';
import { T } from './tokens';

// Estado vacío discreto. "No hay nada" es una no-noticia: se dice en una línea,
// en tono apagado, y se sale del paso. Nada de emojis gigantes ni bloques que
// griten. `description` solo si aporta algo que el título no dice.
interface Props {
  title: string;
  description?: string;
  /** Ícono lucide, chico y apagado. */
  icon?: React.ComponentType<{ size?: number | string; strokeWidth?: number }>;
  /** Slot para una acción, si el vacío es accionable. */
  action?: React.ReactNode;
  style?: CSSProperties;
}

export function EmptyState({ title, description, icon: Icon, action, style }: Props) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      gap: T.space(2),
      padding: `${T.space(6)} ${T.space(4)}`,
      textAlign: 'center',
      color: T.text.muted,
      ...style,
    }}>
      {Icon && <Icon size={20} strokeWidth={1.75} />}
      <div style={{ fontSize: T.fs.sm, lineHeight: T.lh.sm, color: T.text.secondary }}>{title}</div>
      {description && (
        <div style={{ fontSize: T.fs.caption, lineHeight: T.lh.caption, maxWidth: 380 }}>{description}</div>
      )}
      {action}
    </div>
  );
}
