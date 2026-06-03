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
  const { user } = useAuth();
  const router = useRouter();

  useEffect(() => {
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
  }, [user, allowedRoles, router]);

  if (!user) {
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
