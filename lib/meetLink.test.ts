import { describe, expect, it } from 'vitest';
import { MEET_LINK_ERROR, validateMeetLink } from './meetLink';

describe('validateMeetLink', () => {
  it('acepta un Meet sin esquema y le añade https://', () => {
    expect(validateMeetLink('  meet.google.com/abc-defg-hij ')).toEqual({ ok: true, url: 'https://meet.google.com/abc-defg-hij' });
  });

  it('acepta Zoom con subdominio, Teams, Whereby y Jitsi', () => {
    for (const u of [
      'https://us02web.zoom.us/j/123456789?pwd=abc',
      'https://zoom.us/j/1',
      'https://teams.microsoft.com/l/meetup-join/xyz',
      'https://teams.live.com/meet/123',
      'https://whereby.com/sala',
      'https://meet.jit.si/SalaDRC',
    ]) {
      expect(validateMeetLink(u).ok, u).toBe(true);
    }
  });

  it('rechaza lo que no es una videollamada', () => {
    for (const u of ['hola', 'meet.com', 'https://evilzoom.us/j/1', 'https://meet.google.com.evil.io/x', 'ftp://meet.google.com/x', 'Unirse a Zoom https://zoom.us/j/1']) {
      expect(validateMeetLink(u), u).toEqual({ ok: false, error: MEET_LINK_ERROR });
    }
  });

  it('vacío pide el enlace', () => {
    expect(validateMeetLink('   ').ok).toBe(false);
  });
});
