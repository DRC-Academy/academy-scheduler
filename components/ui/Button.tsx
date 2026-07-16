'use client';
import { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';
import { T } from './tokens';

// Jerarquía de acción. UNA sola `primary` por vista: si todo es primario, nada
// lo es. El resto va en secondary/ghost.
//   primary   → la acción de la vista (relleno con el acento)
//   secondary → acciones de apoyo (borde, fondo de superficie)
//   ghost     → acciones terciarias / de fila (sin peso hasta el hover)
//   danger    → destructivas
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const VARIANT: Record<ButtonVariant, CSSProperties> = {
  primary:   { background: T.accent.base,  color: T.text.onFilled,  borderColor: T.accent.base },
  secondary: { background: T.bg.surface,   color: T.text.secondary, borderColor: T.border.base },
  ghost:     { background: 'transparent',  color: T.text.secondary, borderColor: 'transparent' },
  danger:    { background: 'var(--danger)', color: T.text.onFilled, borderColor: 'var(--danger)' },
};

const SIZE: Record<ButtonSize, CSSProperties> = {
  sm: { padding: '5px 10px', fontSize: T.fs.caption, borderRadius: T.radius.sm },
  md: { padding: '9px 16px', fontSize: T.fs.body,    borderRadius: T.radius.md },
};

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'style'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Ícono lucide a la izquierda del label. */
  icon?: React.ComponentType<{ size?: number | string; strokeWidth?: number }>;
  fullWidth?: boolean;
  children?: ReactNode;
  style?: CSSProperties;
}

export function Button({
  variant = 'secondary', size = 'md', loading = false, icon: Icon,
  fullWidth = false, children, disabled, style, ...rest
}: Props) {
  const off = disabled || loading;
  return (
    <button
      {...rest}
      disabled={off}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        gap: T.space(2),
        borderWidth: 1, borderStyle: 'solid',
        fontFamily: 'inherit',
        fontWeight: T.fw.medium,
        lineHeight: 1,
        cursor: off ? 'not-allowed' : 'pointer',
        opacity: off ? 0.55 : 1,
        transition: 'background 0.12s, border-color 0.12s',
        width: fullWidth ? '100%' : undefined,
        whiteSpace: 'nowrap',
        ...SIZE[size],
        ...VARIANT[variant],
        ...style,
      }}
    >
      {loading
        ? <span className={variant === 'primary' || variant === 'danger' ? 'drc-spinner' : 'drc-spinner-xs'} />
        : Icon && <Icon size={size === 'sm' ? 13 : 15} strokeWidth={2} />}
      {children}
    </button>
  );
}
