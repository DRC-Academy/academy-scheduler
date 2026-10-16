import { describe, it, expect } from 'vitest';
import {
  normalizeIban, formatIban, isValidIban, normalizeRecipient, isValidRecipient,
  validatePaymentDetails, IBAN_ERROR, RECIPIENT_ERROR,
} from './iban';

// IBAN de ejemplo publicados por los propios bancos/registros: válidos de verdad.
const VALIDOS = [
  'ES9121000418450200051332',
  'DE89370400440532013000',
  'GB82WEST12345698765432',
  'BE68539007547034',
  'NL91ABNA0417164300',
  'FR1420041010050500013M02606',
  'MT84MALT011000012345MTLCAST001S',
  'NO9386011117947',
  'PT50000201231234567890154',
];

describe('normalizeIban / formatIban', () => {
  it('quita espacios y guiones y pasa a mayúsculas', () => {
    expect(normalizeIban(' es91 2100-0418 4502 0005 1332 ')).toBe('ES9121000418450200051332');
  });
  it('agrupa de a 4, con el último grupo corto si toca', () => {
    expect(formatIban('ES9121000418450200051332')).toBe('ES91 2100 0418 4502 0005 1332');
    expect(formatIban('be68 5390 0754 7034')).toBe('BE68 5390 0754 7034');
    expect(formatIban('NO9386011117947')).toBe('NO93 8601 1117 947');
  });
});

describe('isValidIban', () => {
  it.each(VALIDOS)('acepta %s', iban => expect(isValidIban(iban)).toBe(true));

  it('acepta el IBAN escrito en minúsculas y con espacios', () => {
    expect(isValidIban('es91 2100 0418 4502 0005 1332')).toBe(true);
  });

  it('rechaza un dígito mal copiado (falla el mod-97)', () => {
    expect(isValidIban('ES9121000418450200051333')).toBe(false);
  });

  it('rechaza dos cifras intercambiadas', () => {
    expect(isValidIban('ES9121000418450200053132')).toBe(false);
  });

  it('rechaza un IBAN incompleto o con la longitud de otro país', () => {
    expect(isValidIban('ES912100041845020005133')).toBe(false);
    expect(isValidIban('ES91210004184502')).toBe(false);
  });

  it('rechaza basura, vacío y caracteres raros', () => {
    expect(isValidIban('')).toBe(false);
    expect(isValidIban('hola')).toBe(false);
    expect(isValidIban('ES91 2100 0418 4502 0005 133!')).toBe(false);
    expect(isValidIban('1291210004184502000513')).toBe(false);
  });
});

describe('titular', () => {
  it('colapsa espacios', () => {
    expect(normalizeRecipient('  María   José  Pérez ')).toBe('María José Pérez');
  });
  it('exige al menos 3 caracteres', () => {
    expect(isValidRecipient('Al')).toBe(false);
    expect(isValidRecipient('  A  l ')).toBe(true); // "A l" son 3
    expect(isValidRecipient('Ana')).toBe(true);
  });
});

describe('validatePaymentDetails', () => {
  it('devuelve los valores normalizados si todo está bien', () => {
    expect(validatePaymentDetails({ iban: 'es91 2100 0418 4502 0005 1332', recipientName: ' Ana  López ' }))
      .toEqual({ ok: true, iban: 'ES9121000418450200051332', recipientName: 'Ana López' });
  });
  it('un mensaje por campo cuando fallan los dos', () => {
    expect(validatePaymentDetails({ iban: 'ES00', recipientName: 'A' }))
      .toEqual({ ok: false, errors: { iban: IBAN_ERROR, recipientName: RECIPIENT_ERROR } });
  });
});
