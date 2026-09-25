import { describe, expect, it } from 'vitest';
import { getMeetLinkStatus, isMeetLinkDefined, shouldPenalizeLateLink } from './meetLinkStatus';

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

describe('shouldPenalizeLateLink — enlace_tardio', () => {
  const later = Date.parse('2026-10-10T12:00:00Z');
  const at = (hoursAgo: number) => new Date(later - hoursAgo * H).toISOString();

  it('primera definición pasadas 24 h, asignación posterior al corte → penaliza', () => {
    expect(shouldPenalizeLateLink({ createdAt: at(30), previousSetAt: null, now: later })).toBe(true);
  });
  it('a tiempo (24 h justas o menos) no penaliza', () => {
    expect(shouldPenalizeLateLink({ createdAt: at(24), previousSetAt: null, now: later })).toBe(false);
    expect(shouldPenalizeLateLink({ createdAt: at(3), previousSetAt: null, now: later })).toBe(false);
  });
  it('cambiar un enlace ya definido no penaliza', () => {
    expect(shouldPenalizeLateLink({ createdAt: at(100), previousSetAt: at(90), now: later })).toBe(false);
  });
  it('asignación anterior al corte (25/09/2026, Madrid) nunca penaliza', () => {
    expect(shouldPenalizeLateLink({ createdAt: '2026-09-24T21:59:00Z', previousSetAt: null, now: later })).toBe(false);
    expect(shouldPenalizeLateLink({ createdAt: '2026-08-01T10:00:00Z', previousSetAt: null, now: later })).toBe(false);
  });
});
