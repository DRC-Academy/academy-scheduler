import { describe, expect, it } from 'vitest';
import { getMeetLinkStatus, isMeetLinkDefined } from './meetLinkStatus';

const H = 3_600_000;
const now = Date.parse('2026-09-26T12:00:00Z');
const created = (hoursAgo: number) => new Date(now - hoursAgo * H).toISOString();

describe('getMeetLinkStatus — "hecho" = meet_link_set_at no nulo', () => {
  it('con meetLinkSetAt está definido, aunque hayan pasado días', () => {
    const st = getMeetLinkStatus({ createdAt: created(200), meetLinkSetAt: created(1) }, now);
    expect(st.status).toBe('defined');
    expect(st.badgeText).toBe('✅ Enlace definido');
  });

  it('los plazos de siempre: 4 / 12 / 24 h', () => {
    expect(getMeetLinkStatus({ createdAt: created(1) }, now).status).toBe('on_time');
    expect(getMeetLinkStatus({ createdAt: created(5) }, now).status).toBe('warning');
    expect(getMeetLinkStatus({ createdAt: created(13) }, now).status).toBe('at_risk');
    expect(getMeetLinkStatus({ createdAt: created(24) }, now).status).toBe('overdue');
  });

  it('textos del enlace, no del email', () => {
    expect(getMeetLinkStatus({ createdAt: created(1.5) }, now).badgeText).toBe('🔗 Enlace pendiente · Hace 1h 30min');
    const vencido = getMeetLinkStatus({ createdAt: created(30) }, now);
    expect(vencido.badgeText).toContain('🔴 Enlace sin definir · Hace 30h');
    expect(vencido.blink).toBe(true);
  });

  it('isMeetLinkDefined solo mira meetLinkSetAt', () => {
    expect(isMeetLinkDefined({ meetLinkSetAt: undefined })).toBe(false);
    expect(isMeetLinkDefined({ meetLinkSetAt: null })).toBe(false);
    expect(isMeetLinkDefined({ meetLinkSetAt: '2026-09-25T10:00:00Z' })).toBe(true);
  });
});
