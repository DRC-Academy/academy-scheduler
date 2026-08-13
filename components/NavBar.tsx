'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/AuthContext';
import { NotificationBell } from '@/components/NotificationBell';
import { Search, Users, Calendar, CalendarDays, Wallet, Settings, Menu, X, GraduationCap, CalendarCheck, CalendarClock, LifeBuoy } from 'lucide-react';
import { Button } from '@/components/ui';
import { PresentationEmailReminder } from '@/components/PresentationEmailReminder';
import { useOnboarding } from '@/lib/OnboardingContext';

// Íconos lucide en vez de emojis: /mis-clases y /finanzas usaban los dos el mismo
// 💰, así que el ícono no distinguía nada.
const navItems = [
  { href: '/setter',            label: 'Buscar',            icon: Search,      roles: ['setter', 'admin'] },
  { href: '/students',          label: 'Alumnos',           icon: Users,       roles: ['setter', 'admin'] },
  // Retención: alumnos a los que se les acaba el plan. Ventas y admin, no el
  // profesor — la lista es comercial y cruza alumnos de todos los profesores.
  { href: '/proximos-cancelar', label: 'Próximos a cancelar', icon: CalendarClock, roles: ['setter', 'admin'] },
  { href: '/teacher',           label: 'Calendario',        icon: Calendar,    roles: ['teacher'] },
  // Vista OPERATIVA de la semana (clases del día a día, subida de transcripts).
  // No confundir con /mis-clases, que es la de pago y se muestra como "Finanzas".
  { href: '/clases',            label: 'Mis clases',        icon: CalendarDays, roles: ['teacher'] },
  { href: '/mis-alumnos',       label: 'Alumnos',           icon: GraduationCap, roles: ['teacher'] },
  // /mis-clases conserva su URL (para no romper enlaces), pero se muestra como "Finanzas".
  { href: '/mis-clases',        label: 'Finanzas',          icon: Wallet,      roles: ['teacher'] },
  { href: '/asistencias',       label: 'Asistencias',       icon: CalendarCheck, roles: ['teacher'] },
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
  // Tutorial a demanda. Se ofrece a CUALQUIER profesor, sin mirar si está en
  // onboarding automático ni cuántas clases lleva: es un repaso, no una formación.
  const { openManual } = useOnboarding();
  const showTutorial = user?.role === 'teacher';

  // Cerrar el menú al navegar a otra ruta.
  useEffect(() => { setMenuOpen(false); }, [path]);

  function handleLogout() { setMenuOpen(false); logout(); router.push('/login'); }

  const visible = navItems.filter(item => !user || item.roles.includes(user.role));
  const roleLabel = user ? (roleLabels[user.role] ?? 'Usuario') : '';

  // Menú desplegable de móvil — idéntico en ambas variantes de barra.
  const mobileMenu = user && menuOpen ? (
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

        {/* Tutorial: misma fila que los enlaces, pero abre el recorrido en vez de
            navegar. Va acá también para que en móvil no dependa del ícono suelto. */}
        {showTutorial && (
          <button
            onClick={() => { setMenuOpen(false); openManual(); }}
            style={{
              display: 'flex', alignItems: 'center', gap: 'var(--space-3)', width: '100%',
              padding: 'var(--space-4) var(--space-5)', border: 'none', background: 'transparent',
              fontFamily: 'inherit', fontSize: 'var(--fs-body)', color: 'var(--text-primary)',
              borderBottom: '1px solid var(--border)', cursor: 'pointer', textAlign: 'left',
            }}>
            <LifeBuoy size={18} strokeWidth={2} />
            Tutorial
          </button>
        )}

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
  ) : null;

  // ── Barra en tarjeta: enlaces como pills, sin iconos. Es la MISMA para los
  // tres roles; lo único que cambia son los ítems visibles (ya filtrados por
  // `visible`) y el nombre/rol del usuario. El logo DRC se conserva tal cual.
  if (user) {
    const initials = user.displayName.trim().split(/\s+/).map(p => p[0]).join('').toUpperCase().slice(0, 2);
    return (
      <nav className="tnav">
        <div className="tnav-inner">
          <Link href="/" className="tnav-brand">
            <img className="tnav-logo" src="/drc-logo.png" alt="DRC Academy" />
          </Link>

          <div className="tnav-links">
            {visible.map(item => (
              <Link key={item.href} href={item.href}
                // El tutorial resalta la pestaña de destino antes de saltar a ella,
                // para que el profesor aprenda DÓNDE está la sección y no solo la
                // vea aparecer. Ancla estable por ruta, no por posición en la barra.
                data-onboarding={`nav:${item.href}`}
                className={`tnav-link${path === item.href ? ' is-active' : ''}`}>
                {item.label}
              </Link>
            ))}
          </div>

          <div className="tnav-right">
            {showTutorial && (
              <button className="tnav-tutorial" onClick={openManual}
                title="Repasar el proceso de una clase paso a paso"
                aria-label="Abrir el tutorial">
                <LifeBuoy size={15} strokeWidth={2} />
                <span className="tnav-tutorial-label">Tutorial</span>
              </button>
            )}
            <Link href="/ayuda" className="tnav-help" title="Centro de ayuda" aria-label="Centro de ayuda">?</Link>
            <NotificationBell compact />
            <span className="tnav-sep" aria-hidden />
            <div className="tnav-user">
              <div className="tnav-avatar">{initials}</div>
              <div>
                <div className="tnav-uname">{user.displayName}</div>
                <div className="tnav-urole">{roleLabel}</div>
              </div>
              <button className="tnav-logout" onClick={handleLogout}>Salir</button>
            </div>
            <button
              className="tnav-burger"
              onClick={() => setMenuOpen(o => !o)}
              aria-label={menuOpen ? 'Cerrar menú' : 'Abrir menú'}
              aria-expanded={menuOpen}>
              {menuOpen ? <X size={22} strokeWidth={1.75} /> : <Menu size={22} strokeWidth={1.75} />}
            </button>
          </div>
        </div>
        {mobileMenu}
        {/* Popup recordatorio de emails de presentación pendientes (solo rol teacher).
            Se monta acá para que aparezca en toda la app del profesor sin duplicar. */}
        <PresentationEmailReminder />
      </nav>
    );
  }

  // Sin sesión (p. ej. antes de que AuthGuard resuelva): solo la marca. No se
  // duplica el diseño de la barra — es el mismo contenedor .tnav.
  return (
    <nav className="tnav">
      <div className="tnav-inner">
        <Link href="/" className="tnav-brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="tnav-logo" src="/drc-logo.png" alt="DRC Academy" />
        </Link>
      </div>
    </nav>
  );
}
