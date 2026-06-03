'use client';
import { AuthProvider } from '@/lib/AuthContext';
import { TeachersProvider } from '@/lib/TeachersContext';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <TeachersProvider>
        {children}
      </TeachersProvider>
    </AuthProvider>
  );
}
