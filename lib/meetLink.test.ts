import { describe, expect, it } from 'vitest';
import { MEET_LINK_ERROR, extractMeetLink, validateMeetLink } from './meetLink';

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
    for (const u of ['hola', 'meet.com', 'https://evilzoom.us/j/1', 'https://meet.google.com.evil.io/x', 'ftp://meet.google.com/x', 'Mi sala es meet.com/abc, gracias']) {
      expect(validateMeetLink(u), u).toEqual({ ok: false, error: MEET_LINK_ERROR });
    }
  });

  it('vacío pide el enlace', () => {
    expect(validateMeetLink('   ').ok).toBe(false);
  });
});

describe('extraer el enlace de una invitación pegada entera', () => {
  it('invitación de Zoom: se queda con el enlace de la reunión', () => {
    const zoom = `Ana Pérez te está invitando a una reunión de Zoom programada.

Tema: Clase de inglés
Unirse a la reunión Zoom
https://us06web.zoom.us/j/83012345678?pwd=AbCdEf123.1

ID de reunión: 830 1234 5678
Código de acceso: 123456`;
    expect(validateMeetLink(zoom)).toEqual({ ok: true, url: 'https://us06web.zoom.us/j/83012345678?pwd=AbCdEf123.1' });
  });

  it('invitación de Meet sin esquema y con un enlace de Calendar delante', () => {
    const meet = `Clase de inglés
Ver en Calendar: https://calendar.google.com/calendar/event?eid=xyz
Enlace de videollamada: meet.google.com/abc-defg-hij.
O marca: (ES) +34 911 23 45 67`;
    expect(extractMeetLink(meet)).toBe('https://meet.google.com/abc-defg-hij');
    expect(validateMeetLink(meet)).toEqual({ ok: true, url: 'https://meet.google.com/abc-defg-hij' });
  });

  it('un texto sin enlace de videollamada mantiene el error', () => {
    expect(validateMeetLink('Hola, la clase es en https://calendar.google.com/x mañana')).toEqual({ ok: false, error: MEET_LINK_ERROR });
  });
});
