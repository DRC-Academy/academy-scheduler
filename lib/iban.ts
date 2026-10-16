// ── Datos de pago del profesor: IBAN y titular (lógica PURA) ──────────────────
//
// La usan las dos puntas: el formulario (para avisar antes de enviar) y las
// rutas /api/payment-details y /api/admin/payment-details (que vuelven a validar
// antes de guardar: el navegador no es de fiar).
//
// Qué se comprueba del IBAN:
//   1. Forma: dos letras de país, dos dígitos de control y de 11 a 30
//      caracteres alfanuméricos más (15–34 en total).
//   2. Longitud exacta del país, si el país está en la tabla de abajo. Un país
//      que no está en la tabla no se rechaza por eso: lo filtra el paso 3.
//   3. Dígito de control oficial (ISO 13616, mod-97): las cuatro primeras
//      posiciones pasan al final, cada letra se vuelve número (A=10 … Z=35) y el
//      resultado módulo 97 tiene que dar 1. Atrapa un dígito mal copiado y casi
//      todas las transposiciones.

/** Mensaje único para cualquier IBAN que no pasa. */
export const IBAN_ERROR = 'El IBAN no es válido, revisa que esté completo y bien escrito';
export const RECIPIENT_MIN = 3;
export const RECIPIENT_MAX = 120;
export const RECIPIENT_ERROR = `Escribe el nombre del titular de la cuenta (mínimo ${RECIPIENT_MIN} caracteres)`;

// Longitud total por país, del registro oficial de SWIFT.
const IBAN_LENGTHS: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BI: 27,
  BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28,
  EE: 20, EG: 29, ES: 24, FI: 18, FK: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23,
  GL: 18, GR: 27, GT: 28, HN: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26,
  IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21,
  LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MN: 20, MR: 27, MT: 31, MU: 30, NI: 28,
  NL: 18, NO: 15, OM: 23, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22,
  RU: 33, SA: 24, SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25,
  SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20, YE: 30,
};

/** Sin espacios (ni guiones, que a veces trae lo copiado de la web del banco) y en mayúsculas. */
export function normalizeIban(raw: string): string {
  return (raw ?? '').replace(/[\s-]+/g, '').toUpperCase();
}

/** Agrupado de a 4 para leerlo: "ES12 3456 7890 …". Acepta el IBAN con o sin espacios. */
export function formatIban(raw: string): string {
  return normalizeIban(raw).replace(/(.{4})(?=.)/g, '$1 ');
}

/** mod-97 por tramos: el número entero tiene hasta ~70 cifras y no cabe en un Number. */
function mod97(iban: string): number {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const ch of rearranged) {
    const digits = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest;
}

/** ¿Es un IBAN válido? Normaliza antes de mirar. */
export function isValidIban(raw: string): boolean {
  const iban = normalizeIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const expected = IBAN_LENGTHS[iban.slice(0, 2)];
  if (expected !== undefined && iban.length !== expected) return false;
  return mod97(iban) === 1;
}

/** El nombre tal como se guarda: sin espacios de sobra. */
export function normalizeRecipient(raw: string): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim();
}

export function isValidRecipient(raw: string): boolean {
  const name = normalizeRecipient(raw);
  return name.length >= RECIPIENT_MIN && name.length <= RECIPIENT_MAX;
}

export interface PaymentDetailsErrors { iban?: string; recipientName?: string }

/**
 * Valida y normaliza los dos campos juntos. `ok` trae lo que se guarda; si no,
 * `errors` trae un mensaje por campo para pintarlo debajo de cada uno.
 */
export function validatePaymentDetails(input: { iban: string; recipientName: string }):
  | { ok: true; iban: string; recipientName: string }
  | { ok: false; errors: PaymentDetailsErrors } {
  const errors: PaymentDetailsErrors = {};
  if (!isValidIban(input.iban)) errors.iban = IBAN_ERROR;
  if (!isValidRecipient(input.recipientName)) errors.recipientName = RECIPIENT_ERROR;
  if (errors.iban || errors.recipientName) return { ok: false, errors };
  return { ok: true, iban: normalizeIban(input.iban), recipientName: normalizeRecipient(input.recipientName) };
}
