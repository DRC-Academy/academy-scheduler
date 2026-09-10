// La firma del enlace a /progreso-cuenta.
//
// Lo que fijan estos tests es el contrato con WordPress: la cadena que se firma es
// `<email en minúsculas>|<ts>` y nada más. Si alguien cambia el separador, la
// normalización o el orden, estos tests se rompen — y tienen que romperse, porque
// el enlace dejaría de validar en producción y el alumno solo vería "caducado".

import { describe, expect, it } from 'vitest';
import {
  verifyProgresoLink, signProgreso, progresoSignedPayload, normalizeProgresoEmail,
  MAX_AGE_SECONDS, MAX_SKEW_SECONDS,
} from './progresoSignature';

const SECRET = 'ejemplo_no_usar_en_produccion_0123456789abcdef0123456789abcdef';
const EMAIL = 'alumno@ejemplo.com';
const NOW = 1_800_000_000;   // un "ahora" fijo, para no depender del reloj

const link = (o: Partial<Parameters<typeof verifyProgresoLink>[0]> = {}) => verifyProgresoLink({
  email: EMAIL, ts: String(NOW), sig: signProgreso(EMAIL, String(NOW), SECRET),
  secret: SECRET, nowSeconds: NOW, ...o,
});

describe('la cadena firmada', () => {
  it('es exactamente email|ts, con el email normalizado', () => {
    expect(progresoSignedPayload('  Alumno@Ejemplo.COM ', 1700000000))
      .toBe('alumno@ejemplo.com|1700000000');
  });

  it('normalizeProgresoEmail baja a minúsculas y quita espacios', () => {
    expect(normalizeProgresoEmail('  BEYTAK@HOTMAIL.COM ')).toBe('beytak@hotmail.com');
    expect(normalizeProgresoEmail(null)).toBe('');
  });

  it('la firma es hexadecimal en minúsculas de 64 caracteres', () => {
    const sig = signProgreso(EMAIL, NOW, SECRET);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('el mismo email con otras mayúsculas da la MISMA firma', () => {
    expect(signProgreso('Alumno@Ejemplo.com', NOW, SECRET)).toBe(signProgreso(EMAIL, NOW, SECRET));
  });

  it('otro email da otra firma', () => {
    expect(signProgreso('otro@ejemplo.com', NOW, SECRET)).not.toBe(signProgreso(EMAIL, NOW, SECRET));
  });
});

describe('verifyProgresoLink — acepta', () => {
  it('un enlace recién firmado', () => {
    expect(link()).toEqual({ ok: true, email: EMAIL });
  });

  it('devuelve el email ya normalizado, para buscar con él', () => {
    const raw = '  Alumno@Ejemplo.COM ';
    const v = link({ email: raw, sig: signProgreso(raw, String(NOW), SECRET) });
    expect(v).toEqual({ ok: true, email: EMAIL });
  });

  it('un enlace de hace 9 minutos (dentro del margen)', () => {
    const ts = String(NOW - 9 * 60);
    expect(link({ ts, sig: signProgreso(EMAIL, ts, SECRET) }).ok).toBe(true);
  });

  it('un reloj de WordPress un minuto adelantado', () => {
    const ts = String(NOW + 60);
    expect(link({ ts, sig: signProgreso(EMAIL, ts, SECRET) }).ok).toBe(true);
  });
});

describe('verifyProgresoLink — rechaza', () => {
  it('sin PROGRESO_SECRET, siempre (nunca abre por falta de configuración)', () => {
    expect(verifyProgresoLink({
      email: EMAIL, ts: String(NOW), sig: signProgreso(EMAIL, String(NOW), SECRET),
      secret: '', nowSeconds: NOW,
    })).toEqual({ ok: false, reason: 'sin_configurar' });
  });

  it('sin email, sin ts o sin firma', () => {
    expect(link({ email: '' }).ok).toBe(false);
    expect(link({ ts: '' })).toEqual({ ok: false, reason: 'faltan_datos' });
    expect(link({ sig: '' })).toEqual({ ok: false, reason: 'faltan_datos' });
  });

  it('un ts que no es un entero en dígitos', () => {
    expect(link({ ts: '1e12' })).toEqual({ ok: false, reason: 'ts_invalido' });
    expect(link({ ts: '1700000000.5' })).toEqual({ ok: false, reason: 'ts_invalido' });
    expect(link({ ts: 'ayer' })).toEqual({ ok: false, reason: 'ts_invalido' });
  });

  it('un enlace de hace más de 10 minutos', () => {
    const ts = String(NOW - MAX_AGE_SECONDS - 1);
    expect(link({ ts, sig: signProgreso(EMAIL, ts, SECRET) }))
      .toEqual({ ok: false, reason: 'caducado' });
  });

  it('un ts más de 2 minutos en el futuro', () => {
    const ts = String(NOW + MAX_SKEW_SECONDS + 1);
    expect(link({ ts, sig: signProgreso(EMAIL, ts, SECRET) }))
      .toEqual({ ok: false, reason: 'futuro' });
  });

  it('una firma de OTRO email (el ataque que esto existe para parar)', () => {
    // Alguien con un enlace válido cambia el email por el de otro alumno.
    expect(link({ email: 'otro@ejemplo.com' })).toEqual({ ok: false, reason: 'firma' });
  });

  it('una firma hecha con otro secreto', () => {
    expect(link({ sig: signProgreso(EMAIL, String(NOW), 'otro_secreto') }))
      .toEqual({ ok: false, reason: 'firma' });
  });

  it('una firma con el ts cambiado para estirar la caducidad', () => {
    // Firma buena de hace rato, ts reescrito a ahora: la firma ya no cuadra.
    expect(link({ sig: signProgreso(EMAIL, String(NOW - 3600), SECRET) }))
      .toEqual({ ok: false, reason: 'firma' });
  });

  it('una firma vacía o de longitud distinta', () => {
    expect(link({ sig: 'abc' })).toEqual({ ok: false, reason: 'firma' });
  });

  it('el ts se firma como TEXTO: un cero delante ya es otra cadena', () => {
    // Evita que WordPress mande '01800000000' y acá se compare el número.
    const conCero = `0${NOW}`;
    expect(link({ ts: conCero, sig: signProgreso(EMAIL, String(NOW), SECRET) }))
      .toEqual({ ok: false, reason: 'firma' });
  });
});

describe('la firma en mayúsculas también vale', () => {
  it('WordPress da minúsculas, pero un proxy podría cambiarlas', () => {
    const sig = signProgreso(EMAIL, String(NOW), SECRET).toUpperCase();
    expect(link({ sig }).ok).toBe(true);
  });
});
