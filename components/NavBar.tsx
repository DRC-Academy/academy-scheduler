'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/AuthContext';

const navItems = [
  { href: '/setter',   label: 'Buscar',   icon: '🔍', roles: ['setter', 'admin'] },
  { href: '/students', label: 'Alumnos',  icon: '👤', roles: ['setter', 'admin'] },
  { href: '/teacher',  label: 'Calendario', icon: '📅', roles: ['teacher'] },
  { href: '/admin',    label: 'Admin',    icon: '⚙️', roles: ['admin'] },
];

export function NavBar() {
  const path = usePathname();
  const { user, logout } = useAuth();
  const router = useRouter();

  function handleLogout() { logout(); router.push('/login'); }

  const visible = navItems.filter(item => !user || item.roles.includes(user.role));

  return (
    <nav style={{ background: 'var(--bg-surface)', borderBottom: '1px solid var(--border)', padding: '0 20px', display: 'flex', alignItems: 'center', gap: 4, height: 54, position: 'sticky', top: 0, zIndex: 40 }}>
      <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: 7, marginRight: 16, textDecoration: 'none', flexShrink: 0 }}>
        <span style={{ fontSize: 18 }}>📅</span>
        <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>Academy</span>
      </Link>

      <div style={{ display: 'flex', gap: 2, flex: 1, overflow: 'auto' }}>
        {visible.map(item => (
          <Link key={item.href} href={item.href} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 7, fontSize: 13, fontWeight: 500, textDecoration: 'none', whiteSpace: 'nowrap', background: path === item.href ? 'var(--bg-surface-3)' : 'transparent', color: path === item.href ? 'var(--text-primary)' : 'var(--text-secondary)', transition: 'all 0.12s' }}>
            {item.icon} {item.label}
          </Link>
        ))}
      </div>

      {user && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <div style={{ width: 28, height: 28, borderRadius: '50%', background: user.role === 'admin' ? 'rgba(167,139,250,0.2)' : user.role === 'setter' ? 'rgba(59,130,246,0.2)' : 'rgba(34,197,94,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: user.role === 'admin' ? '#a78bfa' : user.role === 'setter' ? '#93c5fd' : '#4ade80' }}>
              {user.displayName[0].toUpperCase()}
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1 }}>{user.displayName}</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'capitalize' }}>{user.role}</div>
            </div>
          </div>
          <button onClick={handleLogout} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text-muted)', padding: '4px 9px', cursor: 'pointer', fontSize: 11 }}>Salir</button>
        </div>
      )}
    </nav>
  );
}
