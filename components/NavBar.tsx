'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/AuthContext';
import { NotificationBell } from '@/components/NotificationBell';

const navItems = [
  { href: '/setter',     label: 'Buscar',     icon: '🔍', roles: ['setter', 'admin'] },
  { href: '/students',   label: 'Alumnos',    icon: '👤', roles: ['setter', 'admin'] },
  { href: '/teacher',           label: 'Calendario',        icon: '📅', roles: ['teacher'] },
  { href: '/mis-clases',        label: 'Mis clases',        icon: '💰', roles: ['teacher'] },
  { href: '/conteo-automatico', label: 'Conteo automático', icon: '📊', roles: ['teacher'] },
  { href: '/admin',             label: 'Admin',             icon: '⚙️', roles: ['admin'] },
  { href: '/finanzas',   label: 'Finanzas',   icon: '💰', roles: ['admin'] },
];

const roleColors: Record<string, { bg: string; color: string; label: string }> = {
  admin:   { bg: 'rgba(139,92,246,0.15)',  color: '#7c3aed', label: 'Admin' },
  setter:  { bg: 'rgba(30,158,58,0.15)',   color: '#1E9E3A', label: 'Setter' },
  teacher: { bg: 'rgba(255,196,0,0.2)',    color: '#b38600', label: 'Profesor' },
};

export function NavBar() {
  const path = usePathname();
  const { user, logout } = useAuth();
  const router = useRouter();

  function handleLogout() { logout(); router.push('/login'); }

  const visible = navItems.filter(item => !user || item.roles.includes(user.role));
  const rc = user ? (roleColors[user.role] ?? roleColors.setter) : roleColors.setter;

  return (
    <nav className="app-navbar" style={{
      background: 'var(--bg-surface)',
      borderBottom: '1.5px solid var(--border)',
      padding: '0 24px',
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      height: 58,
      position: 'sticky',
      top: 0,
      zIndex: 40,
      boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
    }}>
      {/* Logo */}
      <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: 10, marginRight: 20, textDecoration: 'none', flexShrink: 0 }}>
        <img className="nav-logo" src="/drc-logo.png" alt="DRC Academy" style={{ height: 36, width: 'auto', objectFit: 'contain' }} />
      </Link>

      {/* Nav links */}
      <div style={{ display: 'flex', gap: 2, flex: 1, overflow: 'auto' }}>
        {visible.map(item => {
          const isActive = path === item.href;
          return (
            <Link key={item.href} href={item.href} className="nav-link" style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 14px', borderRadius: 8,
              fontSize: 13, fontWeight: 600, textDecoration: 'none', whiteSpace: 'nowrap',
              background: isActive ? 'var(--green-light)' : 'transparent',
              color: isActive ? 'var(--green)' : 'var(--text-secondary)',
              borderBottom: isActive ? '2px solid var(--green)' : '2px solid transparent',
              transition: 'all 0.12s',
            }}>
              {item.icon}
              <span className="nav-link-label">{item.label}</span>
            </Link>
          );
        })}
      </div>

      {/* User info */}
      {user && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <NotificationBell />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 32, height: 32, borderRadius: '50%',
              background: rc.bg,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 700, color: rc.color,
              flexShrink: 0,
            }}>
              {user.displayName[0].toUpperCase()}
            </div>
            <div className="nav-user-text">
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1 }}>{user.displayName}</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'capitalize' }}>{rc.label}</div>
            </div>
          </div>
          <button onClick={handleLogout} style={{
            background: 'none', border: '1.5px solid var(--border)',
            borderRadius: 7, color: 'var(--text-muted)',
            padding: '4px 10px', cursor: 'pointer', fontSize: 12,
            fontFamily: 'inherit',
          }}>Salir</button>
        </div>
      )}
    </nav>
  );
}
