// ── Firma del enlace a la ficha de progreso dentro de "Mi cuenta" ─────────────
//
// EL PROBLEMA. /progreso-cuenta identifica al alumno por su EMAIL, que viaja en la
// URL. Sin nada más, cualquiera cambiaría el email por otro y vería la ficha de un
// desconocido. No sirve confiar en que el alumno está logueado en WooCommerce: esa
// sesión es de otro dominio y este servidor no la ve.
//
// LA SOLUCIÓN. WordPress y este software comparten un secreto (PROGRESO_SECRET) y
// WordPress firma cada enlace: manda el email, un sello de tiempo y un HMAC-SHA256
// de los dos. Acá se recalcula la firma y se compara. Quien no tenga el secreto no
// puede fabricar una firma válida para otro email, y el sello de tiempo hace que
// un enlace copiado sirva solo unos minutos.
//
// LA CADENA QUE SE FIRMA es exactamente `<email>|<ts>`, con el email en minúsculas
// y sin espacios. En WordPress: hash_hmac('sha256', $email . '|' . $ts, SECRETO).
// Cualquier diferencia acá —un espacio, una mayúscula, otro separador— da firmas
// distintas y el alumno ve "enlace caducado" sin más pista, así que la
// normalización es la MISMA función que usa el resto del sistema (`normEmail`).
//
// SIN SECRETO NO SE ABRE. Si falta PROGRESO_SECRET se rechaza todo, igual que
// lib/externalAuth: un endpoint que se abre porque falta una variable de entorno es
// la forma habitual de publicar datos sin enterarse.

import { createHmac } from 'node:crypto';
import { secretsMatch } from '@/lib/externalAuth';

/** Antigüedad máxima del enlace. Pasado esto, caducado. */
export const MAX_AGE_SECONDS = 10 * 60;

/**
 * Margen hacia el futuro. Existe porque el reloj de WordPress y el de Vercel no
 * son el mismo: unos segundos de desfase son normales y no deben caducar nada.
 */
export const MAX_SKEW_SECONDS = 2 * 60;

/**
 * Email normalizado para firmar y para buscar. Misma regla que `normEmail` en
 * lib/useSubscriptionStatus: minúsculas y sin espacios alrededor. Está duplicada a
 * propósito en una línea en vez de importada, porque ese módulo es de cliente
 * ('use client' arriba) y esto corre en el servidor.
 */
export function normalizeProgresoEmail(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase();
}

/** La cadena exacta que se firma. Una sola definición, para los dos lados. */
export function progresoSignedPayload(email: string, ts: string | number): string {
  return `${normalizeProgresoEmail(email)}|${ts}`;
}

/** HMAC-SHA256 en hexadecimal minúsculas de `<email>|<ts>`. */
export function signProgreso(email: string, ts: string | number, secret: string): string {
  return createHmac('sha256', secret).update(progresoSignedPayload(email, ts)).digest('hex');
}

export type ProgresoRejectReason =
  | 'sin_configurar'   // falta PROGRESO_SECRET en el entorno
  | 'faltan_datos'     // no vienen email, ts o sig
  | 'ts_invalido'      // ts no es un número
  | 'caducado'         // más de 10 minutos
  | 'futuro'           // más de 2 minutos en el futuro
  | 'firma';           // no coincide

export type ProgresoVerdict =
  | { ok: true; email: string }
  | { ok: false; reason: ProgresoRejectReason };

/**
 * ¿Este enlace es válido? Todo entra por parámetro salvo el secreto y el reloj, que
 * se pueden pasar para poder testear sin tocar el entorno.
 *
 * NO devuelve ningún dato del alumno ni distingue "email desconocido" de "firma
 * mala": quien llama solo se entera de si puede seguir. Contar de más acá sería
 * decirle a quien prueba emails al azar cuáles existen.
 */
export function verifyProgresoLink(params: {
  email?: string | null;
  ts?: string | null;
  sig?: string | null;
  /** Por defecto, PROGRESO_SECRET del entorno. */
  secret?: string;
  /** Ahora, en segundos unix. Por defecto, el reloj del servidor. */
  nowSeconds?: number;
}): ProgresoVerdict {
  const secret = params.secret ?? process.env.PROGRESO_SECRET;
  if (!secret) {
    console.error('[progreso-cuenta] Falta PROGRESO_SECRET: la ruta queda cerrada.');
    return { ok: false, reason: 'sin_configurar' };
  }

  const email = normalizeProgresoEmail(params.email);
  const ts = (params.ts ?? '').trim();
  const sig = (params.sig ?? '').trim().toLowerCase();
  if (!email || !ts || !sig) return { ok: false, reason: 'faltan_datos' };

  // Solo dígitos: un ts como '1e12' o '12.5' lo aceptaría Number() y cambiaría la
  // cadena firmada respecto de lo que mandó WordPress.
  if (!/^\d+$/.test(ts)) return { ok: false, reason: 'ts_invalido' };
  const tsNum = Number(ts);
  if (!Number.isSafeInteger(tsNum)) return { ok: false, reason: 'ts_invalido' };

  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (now - tsNum > MAX_AGE_SECONDS) return { ok: false, reason: 'caducado' };
  if (tsNum - now > MAX_SKEW_SECONDS) return { ok: false, reason: 'futuro' };

  // El ts se firma TAL COMO VINO (texto), no el número: '0001700000000' y
  // '1700000000' son el mismo número y cadenas distintas.
  const esperada = signProgreso(email, ts, secret);
  if (!secretsMatch(sig, esperada)) return { ok: false, reason: 'firma' };

  return { ok: true, email };
}
