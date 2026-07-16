'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/AuthContext';
import { UserRole } from '@/types';

interface AuthGuardProps {
  children: React.ReactNode;
  allowedRoles: UserRole[];
}

export function AuthGuard({ children, allowedRoles }: AuthGuardProps) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    // La sesión vive en sessionStorage y AuthProvider la lee en un effect, así que
    // en el primer render `user` siempre es null. Como los effects de los hijos
    // corren ANTES que los del padre, sin esta guarda expulsábamos al login en toda
    // navegación dura (F5, bookmark, link directo) aunque la sesión fuera válida.
    if (loading) return;
    if (!user) {
      router.push('/login');
      return;
    }
    if (!allowedRoles.includes(user.role)) {
      // Redirect to their own area
      const redirects: Record<UserRole, string> = {
        admin: '/admin',
        setter: '/setter',
        teacher: '/teacher',
      };
      router.push(redirects[user.role]);
    }
  }, [user, loading, allowedRoles, router]);

  if (loading || !user) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--bg-base)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>Verificando sesión...</div>
      </div>
    );
  }

  if (!allowedRoles.includes(user.role)) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--bg-base)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>Redirigiendo...</div>
      </div>
    );
  }

  return <>{children}</>;
}
