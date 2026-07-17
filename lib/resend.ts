import { Resend } from 'resend';

// Cliente de Resend para el envío de correos transaccionales.
// La API key vive solo en el servidor (RESEND_API_KEY, sin prefijo NEXT_PUBLIC),
// por lo que este módulo SOLO debe usarse desde código server-side (API routes,
// webhooks), nunca desde componentes cliente.
//
// El fallback evita que el constructor lance "Missing API key" al cargar el
// módulo durante `next build` (cuando la env var no está disponible). En Vercel
// RESEND_API_KEY está configurada, así que se usa la clave real; si faltara, el
// envío simplemente fallaría y queda capturado en quien llama.

export const RESEND_PLACEHOLDER_KEY = 're_missing_api_key';

const apiKey = process.env.RESEND_API_KEY;

// Aviso al arrancar: sin esto, el fallback deja un cliente roto en silencio y
// los envíos fallan con "API key is invalid" sin explicar por qué.
if (!apiKey && process.env.NEXT_PHASE !== 'phase-production-build') {
  console.warn(
    '[resend] RESEND_API_KEY no está definida: los emails NO se enviarán. ' +
    'Revisá Settings → Environment Variables en Vercel y redesplegá.',
  );
}

export const resend = new Resend(apiKey ?? RESEND_PLACEHOLDER_KEY);

/** true si hay una clave real (no el placeholder del build). */
export function hasResendKey(): boolean {
  return Boolean(apiKey) && apiKey !== RESEND_PLACEHOLDER_KEY;
}
