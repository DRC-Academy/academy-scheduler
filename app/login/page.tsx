'use client';
import { useState } from 'react';

import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/AuthContext';
import { UserRole } from '@/types';

const ROLE_REDIRECTS: Record<UserRole, string> = {
  admin: '/admin', setter: '/setter', teacher: '/teacher',
};

export default function LoginPage() {
  const { login } = useAuth();
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const ok = await login(username, password);
    setLoading(false);
    if (!ok) { setError('Usuario o contraseña incorrectos.'); return; }
    try {
      const saved = sessionStorage.getItem('academy_user');
      if (saved) {
        const u = JSON.parse(saved);
        router.push(ROLE_REDIRECTS[u.role as UserRole] ?? '/');
      }
    } catch { router.push('/'); }
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--bg-base)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    }}>
      <div style={{ width: '100%', maxWidth: 400 }}>

        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 36 }}>
          <img src="/drc-logo.png" alt="DRC Academy" style={{ height: 50, width: 'auto', objectFit: 'contain' }} />
          <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: '10px 0 0' }}>
            Plataforma interna de gestión
          </p>
        </div>

        {/* Card */}
        <div style={{
          background: 'var(--bg-surface)',
          border: '1.5px solid var(--border)',
          borderRadius: 16,
          padding: '32px 28px',
          boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
        }}>
          <div style={{ fontWeight: 700, fontSize: 20, color: 'var(--text-primary)', marginBottom: 22 }}>
            Iniciar sesión
          </div>
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label>Usuario</label>
              <input type="text" value={username} onChange={e => setUsername(e.target.value)} placeholder="ej: sebastian" autoFocus />
            </div>
            <div>
              <label>Contraseña</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" />
            </div>
            {error && (
              <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#dc2626' }}>
                {error}
              </div>
            )}
            <button type="submit" disabled={loading || !username || !password} style={{
              marginTop: 8, padding: '12px 16px', borderRadius: 9, border: 'none',
              background: loading || !username || !password ? 'var(--bg-surface-3)' : 'var(--green)',
              color: loading || !username || !password ? 'var(--text-muted)' : 'white',
              fontWeight: 700, fontSize: 15,
              cursor: loading || !username || !password ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
              transition: 'background 0.15s',
            }}>
              {loading ? 'Verificando...' : 'Ingresar'}
            </button>
          </form>
        </div>

        {/* Hint */}
        <div style={{ marginTop: 18, background: 'var(--bg-surface)', border: '1.5px solid var(--border)', borderRadius: 10, padding: '12px 16px', fontSize: 12, color: 'var(--text-muted)' }}>
          <div style={{ fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>💡 Accesos de prueba</div>
          <div>Admin: <code style={{ color: 'var(--green)', fontWeight: 600 }}>admin</code> / <code style={{ color: 'var(--green)', fontWeight: 600 }}>admin123</code></div>
          <div>Setter: <code style={{ color: 'var(--green)', fontWeight: 600 }}>setter</code> / <code style={{ color: 'var(--green)', fontWeight: 600 }}>setter123</code></div>
          <div>Profe: <code style={{ color: 'var(--green)', fontWeight: 600 }}>sebastian</code> / <code style={{ color: 'var(--green)', fontWeight: 600 }}>profe123</code></div>
        </div>
      </div>
    </div>
  );
}
