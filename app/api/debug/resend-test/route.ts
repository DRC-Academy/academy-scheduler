// ⚠️ ENDPOINT TEMPORAL DE DIAGNÓSTICO — BORRAR cuando Resend esté confirmado.
//
// Uso:
//   GET /api/debug/resend-test            → sólo informa (NO envía nada)
//   GET /api/debug/resend-test?send=1     → envía un email de prueba
//
// El envío exige ?send=1 a propósito: es una ruta pública y sin ese requisito
// cualquier bot que la rastree dispararía correos y quemaría la cuota de Resend.

import { Resend } from 'resend';

const TEST_TO = 'facupezzu@gmail.com';
const FROM = 'DRC Academy <notificaciones@drcacademy.com>';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const apiKey = process.env.RESEND_API_KEY;

  // Radiografía del entorno: es lo que responde "¿está la variable en Vercel?".
  const diag = {
    resendKeyExists: Boolean(apiKey),
    resendKeyPrefix: apiKey ? `${apiKey.slice(0, 10)}...` : null,
    resendKeyLength: apiKey?.length ?? 0,
    // La clave real empieza por 're_'. El fallback de lib/resend.ts es una pista
    // de que la variable NO llegó al proceso.
    looksLikeRealKey: Boolean(apiKey && apiKey.startsWith('re_') && apiKey !== 're_missing_api_key'),
    isPlaceholder: apiKey === 're_missing_api_key',
    from: FROM,
    nodeEnv: process.env.NODE_ENV,
    vercelEnv: process.env.VERCEL_ENV ?? '(no es Vercel)',
  };

  if (!apiKey) {
    return Response.json({
      ...diag,
      error: 'RESEND_API_KEY no está configurada en este entorno.',
      pista: 'En Vercel: Settings → Environment Variables. Comprobá que esté marcada para el entorno correcto (Production/Preview) y REDESPLEGÁ: las variables sólo se aplican a builds posteriores.',
    }, { status: 200 });
  }

  const url = new URL(request.url);
  if (url.searchParams.get('send') !== '1') {
    return Response.json({
      ...diag,
      sent: false,
      nota: `La clave está presente. Para enviar un email real a ${TEST_TO}, añadí ?send=1 a la URL.`,
    });
  }

  try {
    const resend = new Resend(apiKey);
    const result = await resend.emails.send({
      from: FROM,
      to: TEST_TO,
      subject: 'Test de Resend — DRC Gestión',
      html: '<p>Si recibes este email, Resend funciona correctamente.</p>',
    });

    // El SDK de Resend NO lanza en errores de API: los devuelve en `error`.
    // Un try/catch por sí solo no los ve — por eso hay que mirar result.error.
    if (result.error) {
      console.error('[EMAIL] Resend devolvió error:', result.error);
      return Response.json({
        ...diag,
        success: false,
        sent: false,
        error: result.error.message,
        errorName: result.error.name,
        errorDetails: result.error,
      });
    }

    console.log('[EMAIL] Test enviado correctamente:', result.data);
    return Response.json({ ...diag, success: true, sent: true, result: result.data });
  } catch (err: unknown) {
    const e = err as { message?: string; name?: string };
    console.error('[EMAIL] Excepción al enviar:', err);
    return Response.json({
      ...diag,
      success: false,
      sent: false,
      error: e?.message ?? String(err),
      errorName: e?.name,
    });
  }
}
