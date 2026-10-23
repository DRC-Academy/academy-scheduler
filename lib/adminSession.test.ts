import { describe, expect, it } from 'vitest';
import { createAdminTokenWith, verifyAdminTokenWith, cookieOf, ADMIN_SESSION_HOURS, ADMIN_SESSION_COOKIE } from '@/lib/adminSession';

const KEY = Buffer.from('clave-de-prueba');
const NOW = Date.UTC(2026, 9, 22, 10);

describe('token de sesión de admin', () => {
  it('se verifica con la misma clave y antes de caducar', () => {
    const t = createAdminTokenWith(KEY, 'u_admin', NOW);
    expect(verifyAdminTokenWith(KEY, t, NOW + 1000)).toEqual({ userId: 'u_admin' });
    expect(verifyAdminTokenWith(KEY, t, NOW + ADMIN_SESSION_HOURS * 3_600_000 + 1)).toBeNull();
  });
  it('rechaza otra clave, una firma tocada o un payload cambiado', () => {
    const t = createAdminTokenWith(KEY, 'u_admin', NOW);
    expect(verifyAdminTokenWith(Buffer.from('otra'), t, NOW)).toBeNull();
    expect(verifyAdminTokenWith(KEY, `${t}x`, NOW)).toBeNull();
    const [, firma] = t.split('.');
    const falso = Buffer.from(JSON.stringify({ sub: 'otro', role: 'admin', exp: NOW + 1e9 })).toString('base64url');
    expect(verifyAdminTokenWith(KEY, `${falso}.${firma}`, NOW)).toBeNull();
    expect(verifyAdminTokenWith(KEY, '', NOW)).toBeNull();
    expect(verifyAdminTokenWith(KEY, 'a.b.c', NOW)).toBeNull();
  });
  it('lee la cookie de la petición', () => {
    const req = new Request('https://x.test/api', { headers: { cookie: `otra=1; ${ADMIN_SESSION_COOKIE}=abc.def; y=2` } });
    expect(cookieOf(req, ADMIN_SESSION_COOKIE)).toBe('abc.def');
    expect(cookieOf(new Request('https://x.test'), ADMIN_SESSION_COOKIE)).toBeNull();
  });
});
