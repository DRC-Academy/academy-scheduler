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
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 380 }}>
        <div style={{ textAlign: 'center', marginBottom: 40 }}>
          <div style={{ fontSize: 42, marginBottom: 12 }}>📅</div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 6px' }}>Academy Scheduler</h1>
          <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: 0 }}>DRC Academy · Plataforma interna</p>
        </div>

        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 16, padding: '32px 28px' }}>
          <div style={{ fontWeight: 700, fontSize: 18, color: 'var(--text-primary)', marginBottom: 24 }}>Iniciar sesión</div>
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
              <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#f87171' }}>{error}</div>
            )}
            <button type="submit" disabled={loading || !username || !password} style={{ marginTop: 8, padding: '12px 16px', borderRadius: 8, border: 'none', background: loading || !username || !password ? 'var(--bg-surface-3)' : 'var(--accent-blue)', color: loading || !username || !password ? 'var(--text-muted)' : 'white', fontWeight: 700, fontSize: 15, cursor: loading || !username || !password ? 'not-allowed' : 'pointer' }}>
              {loading ? 'Verificando...' : 'Ingresar'}
            </button>
          </form>
        </div>

        <div style={{ marginTop: 20, background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.15)', borderRadius: 10, padding: '12px 16px', fontSize: 12, color: 'var(--text-muted)' }}>
          <div style={{ fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>💡 Accesos</div>
          <div>Admin: <code style={{ color: '#93c5fd' }}>admin</code> / <code style={{ color: '#93c5fd' }}>admin123</code></div>
          <div>Setter: <code style={{ color: '#93c5fd' }}>setter</code> / <code style={{ color: '#93c5fd' }}>setter123</code></div>
          <div>Profe: <code style={{ color: '#93c5fd' }}>sebastian</code> / <code style={{ color: '#93c5fd' }}>profe123</code></div>
        </div>
      </div>
    </div>
  );
}
