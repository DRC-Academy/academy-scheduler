'use client';
import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { AppUser, UserRole } from '@/types';
import { dbAuthenticate } from '@/lib/db';

interface AuthContextType {
  user: AppUser | null;
  loading: boolean;
  /** Devuelve el usuario autenticado, o null si las credenciales no son válidas.
   *  Devolver el usuario (y no un boolean) evita que quien llama tenga que releer
   *  la sesión del storage para saber a dónde redirigir. */
  login: (username: string, password: string) => Promise<AppUser | null>;
  logout: () => void;
  isRole: (...roles: UserRole[]) => boolean;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  login: async () => null,
  logout: () => {},
  isRole: () => false,
});

const SESSION_KEY = 'academy_user';

// La sesión vive en localStorage, NO en sessionStorage.
//
// Motivo: sessionStorage está aislado por pestaña y solo se clona a una pestaña
// nueva si ésta conserva el `opener`. Los enlaces con rel="noopener" (los de
// "Ver ficha", por ejemplo) lo cortan a propósito, así que la pestaña nueva
// arrancaba con storage vacío y AuthGuard expulsaba al login aunque la sesión
// fuera válida. localStorage se comparte entre pestañas del mismo origen.
//
// Contrapartida: la sesión sobrevive al cierre del navegador. En un equipo
// compartido hay que pulsar "Salir" para cerrarla de verdad.

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    try {
      let saved = localStorage.getItem(SESSION_KEY);
      // Migración: quien ya tenía sesión en sessionStorage no debe perderla.
      if (!saved) {
        const legacy = sessionStorage.getItem(SESSION_KEY);
        if (legacy) {
          localStorage.setItem(SESSION_KEY, legacy);
          sessionStorage.removeItem(SESSION_KEY);
          saved = legacy;
        }
      }
      if (saved) setUser(JSON.parse(saved));
    } catch {}
    setLoading(false);
  }, []);

  // Sincroniza las pestañas abiertas: al salir en una, las demás se enteran.
  // El evento `storage` solo lo reciben las OTRAS pestañas, nunca la que escribe.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== SESSION_KEY) return;
      try {
        setUser(e.newValue ? JSON.parse(e.newValue) : null);
      } catch {
        setUser(null);
      }
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  async function login(username: string, password: string): Promise<AppUser | null> {
    const u = await dbAuthenticate(username, password);
    if (!u) return null;
    setUser(u);
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(u)); } catch {}
    return u;
  }

  function logout() {
    setUser(null);
    try {
      localStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(SESSION_KEY);   // por si quedaba la sesión vieja
    } catch {}
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
