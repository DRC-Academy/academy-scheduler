import { Resend } from 'resend';

// Cliente de Resend para el envío de correos transaccionales.
// La API key vive solo en el servidor (RESEND_API_KEY, sin prefijo NEXT_PUBLIC),
// por lo que este módulo SOLO debe usarse desde código server-side (API routes,
// webhooks), nunca desde componentes cliente.
//
// El fallback evita que el constructor lance "Missing API key" al cargar el
// módulo durante `next build` (cuando la env var no está disponible). En Vercel
// RESEND_API_KEY está configurada, así que se usa la clave real; si faltara, el
// envío simplemente fallaría y queda capturado en sendCancellationEmail.
export const resend = new Resend(process.env.RESEND_API_KEY ?? 're_missing_api_key');
