'use client';
import { CSSProperties, ReactNode } from 'react';
import { T } from './tokens';

// Título de sección. La jerarquía la da el espacio y UN peso fuerte, no el color.
// `subtitle` es opcional a propósito: si no explica algo que el título no dice,
// se omite en vez de rellenar.
interface Props {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Ícono lucide a la izquierda del título. */
  icon?: React.ComponentType<{ size?: number | string; strokeWidth?: number }>;
  /** Slot a la derecha: normalmente la acción primaria de la sección. */
  action?: ReactNode;
  /** `page` para el título de la pantalla; `section` dentro de ella. */
  level?: 'page' | 'section';
  style?: CSSProperties;
}

export function SectionHeader({ title, subtitle, icon: Icon, action, level = 'section', style }: Props) {
  const isPage = level === 'page';
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
      gap: T.space(4),
      marginBottom: isPage ? T.space(5) : T.space(4),
      flexWrap: 'wrap',
      ...style,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: T.space(2),
          fontSize: isPage ? T.fs.display : T.fs.title,
          lineHeight: isPage ? T.lh.display : T.lh.title,
          fontWeight: T.fw.semibold,
          color: T.text.primary,
        }}>
          {Icon && <Icon size={isPage ? 22 : 17} strokeWidth={2} />}
          {title}
        </div>
        {subtitle && (
          <div style={{
            fontSize: T.fs.caption, lineHeight: T.lh.caption,
            color: T.text.muted, marginTop: T.space(1),
          }}>
            {subtitle}
          </div>
        )}
      </div>
      {action}
    </div>
  );
}
