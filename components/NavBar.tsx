'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/AuthContext';
import { NotificationBell } from '@/components/NotificationBell';
import { Search, Users, Calendar, Wallet, ChartColumn, Settings, Menu, X } from 'lucide-react';
import { Button } from '@/components/ui';

// Íconos lucide en vez de emojis: /mis-clases y /finanzas usaban los dos el mismo
// 💰, así que el ícono no distinguía nada.
const navItems = [
  { href: '/setter',            label: 'Buscar',            icon: Search,      roles: ['setter', 'admin'] },
  { href: '/students',          label: 'Alumnos',           icon: Users,       roles: ['setter', 'admin'] },
  { href: '/teacher',           label: 'Calendario',        icon: Calendar,    roles: ['teacher'] },
  { href: '/mis-clases',        label: 'Mis clases',        icon: Wallet,      roles: ['teacher'] },
  { href: '/conteo-automatico', label: 'Conteo automático', icon: ChartColumn, roles: ['teacher'] },
  { href: '/admin',             label: 'Admin',             icon: Settings,    roles: ['admin'] },
  { href: '/finanzas',          label: 'Finanzas',          icon: Wallet,      roles: ['admin'] },
];

// El rol es una categoría, no un estado: no lleva color propio. Antes admin era
// violeta, setter verde y profe amarillo, sin que eso comunicara nada.
const roleLabels: Record<string, string> = {
  admin: 'Admin', setter: 'Setter', teacher: 'Profesor',
};

export function NavBar() {
  const path = usePathname();
  const { user, logout } = useAuth();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);

  // Cerrar el menú al navegar a otra ruta.
  useEffect(() => { setMenuOpen(false); }, [path]);

  function handleLogout() { setMenuOpen(false); logout(); router.push('/login'); }

  const visible = navItems.filter(item => !user || item.roles.includes(user.role));
  const roleLabel = user ? (roleLabels[user.role] ?? 'Usuario') : '';

  return (
    <nav className="app-navbar" style={{
      background: 'var(--bg-surface)',
      borderBottom: `1px solid var(--border)`,
      padding: '0 var(--space-5)',
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      height: 58,
      position: 'sticky',
      top: 0,
      zIndex: 40,
    }}>
      {/* Logo */}
      <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: 10, marginRight: 20, textDecoration: 'none', flexShrink: 0 }}>
        <img className="nav-logo" src="/drc-logo.png" alt="DRC Academy" style={{ height: 36, width: 'auto', objectFit: 'contain' }} />
      </Link>

      {/* Nav links (desktop) */}
      <div className="nav-links-row" style={{ display: 'flex', gap: 2, flex: 1, overflow: 'auto' }}>
        {visible.map(item => {
          const isActive = path === item.href;
          const Icon = item.icon;
          return (
            <Link key={item.href} href={item.href} className="nav-link" style={{
              display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
              padding: '6px 14px', borderRadius: 'var(--radius-sm)',
              fontSize: 'var(--fs-sm)',
              fontWeight: isActive ? 'var(--fw-semibold)' : 'var(--fw-regular)',
              textDecoration: 'none', whiteSpace: 'nowrap',
              background: isActive ? 'var(--accent-soft)' : 'transparent',
              color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
              transition: 'background 0.12s, color 0.12s',
            }}>
              <Icon size={15} strokeWidth={2} />
              <span className="nav-link-label">{item.label}</span>
            </Link>
          );
        })}
      </div>

      {/* Right side */}
      {user && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, marginLeft: 'auto' }}>
          <NotificationBell />

          {/* User info (desktop) */}
          <div className="nav-user-desktop" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <div style={{
              width: 32, height: 32, borderRadius: '50%',
              background: 'var(--bg-surface-2)',
              border: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-semibold)', color: 'var(--text-secondary)',
              flexShrink: 0,
            }}>
              {user.displayName[0].toUpperCase()}
            </div>
            <div className="nav-user-text">
              <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-medium)', color: 'var(--text-primary)', lineHeight: 1.3 }}>{user.displayName}</div>
              <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--text-muted)' }}>{roleLabel}</div>
            </div>
            <Button variant="secondary" size="sm" onClick={handleLogout}>Salir</Button>
          </div>

          {/* Hamburguesa (mobile) */}
          <button
            className="nav-hamburger"
            onClick={() => setMenuOpen(o => !o)}
            aria-label={menuOpen ? 'Cerrar menú' : 'Abrir menú'}
            aria-expanded={menuOpen}
            style={{
              display: 'none', width: 40, height: 40, alignItems: 'center', justifyContent: 'center',
              background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', flexShrink: 0, padding: 0,
            }}>
            {menuOpen ? <X size={22} strokeWidth={2} /> : <Menu size={22} strokeWidth={2} />}
          </button>
        </div>
      )}

      {/* Menú desplegable (mobile) */}
      {user && menuOpen && (
        <>
          {/* Backdrop — click fuera cierra. Queda por debajo del navbar (z 40). */}
          <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 38, background: 'transparent' }} />

          <div style={{
            position: 'fixed',
            top: 'calc(52px + env(safe-area-inset-top))',
            left: 0, right: 0, zIndex: 41,
            background: 'var(--bg-surface)',
            borderBottom: '1px solid var(--border)',
            boxShadow: 'var(--shadow-overlay)',
            animation: 'nav-slide-down 0.18s ease-out',
          }}>
            {visible.map(item => {
              const isActive = path === item.href;
              const Icon = item.icon;
              return (
                <Link key={item.href} href={item.href} onClick={() => setMenuOpen(false)} style={{
                  display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
                  padding: 'var(--space-4) var(--space-5)', textDecoration: 'none',
                  fontSize: 'var(--fs-body)',
                  fontWeight: isActive ? 'var(--fw-semibold)' : 'var(--fw-regular)',
                  color: isActive ? 'var(--accent)' : 'var(--text-primary)',
                  background: isActive ? 'var(--accent-soft)' : 'transparent',
                  borderBottom: '1px solid var(--border)',
                }}>
                  <Icon size={18} strokeWidth={2} />
                  {item.label}
                </Link>
              );
            })}

            {/* Usuario + Salir */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: 'var(--space-4) var(--space-5)' }}>
              <div style={{
                width: 38, height: 38, borderRadius: '50%',
                background: 'var(--bg-surface-2)', border: '1px solid var(--border)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-semibold)', color: 'var(--text-secondary)', flexShrink: 0,
              }}>
                {user.displayName[0].toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-medium)', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.displayName}</div>
                <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-muted)' }}>{roleLabel}</div>
              </div>
              <Button variant="secondary" onClick={handleLogout} style={{ flexShrink: 0 }}>Salir</Button>
            </div>
          </div>
        </>
      )}
    </nav>
  );
}
