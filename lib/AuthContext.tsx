'use client';
import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { AppUser, UserRole } from '@/types';
import { dbAuthenticate } from '@/lib/db';

interface AuthContextType {
  user: AppUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => void;
  isRole: (...roles: UserRole[]) => boolean;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  login: async () => false,
  logout: () => {},
  isRole: () => false,
});

const SESSION_KEY = 'academy_user';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(SESSION_KEY);
      if (saved) setUser(JSON.parse(saved));
    } catch {}
    setLoading(false);
  }, []);

  async function login(username: string, password: string): Promise<boolean> {
    const u = await dbAuthenticate(username, password);
    if (u) {
      setUser(u);
      try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(u)); } catch {}
      return true;
    }
    return false;
  }

  function logout() {
    setUser(null);
    try { sessionStorage.removeItem(SESSION_KEY); } catch {}
  }

  function isRole(...roles: UserRole[]) {
    return !!user && roles.includes(user.role);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, isRole }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
