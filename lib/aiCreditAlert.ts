// Aviso de "Anthropic sin saldo". SOLO SERVIDOR.
//
// Por qué existe: del 14/09/2026 al 16/09/2026 la cuenta de Anthropic se quedó
// sin crédito y TODA la IA falló tres días sin que nadie se enterara: 170
// análisis de transcripts en 'failed' y 6 pruebas de nivel con la redacción sin
// evaluar. El error estaba en los logs, pero nadie mira los logs.
//
// Lo dispara askClaudeJson (lib/anthropic.ts) cuando la API contesta que no hay
// saldo, así cubre todas las funciones de IA sin tocar ninguna.
//
// UNO AL DÍA COMO MÁXIMO, sin tabla nueva: la marca es una fila de
// `notifications` con id fijo por día de España (`notif_ai_credit_AAAA-MM-DD`).
// La base garantiza que el id es único, así que de todas las llamadas que fallen
// ese día solo la primera consigue insertarla, y solo esa manda el email. De
// paso el aviso queda en la campanita del admin.
//
// Destinatario: AI_ALERT_EMAIL, una variable SOLO para este aviso, para no mover
// a dónde llegan los avisos de pagos (ADMIN_NOTIFICATION_EMAIL). Sin la variable
// no sale email; la campanita sí.

import 'server-only';

import { supabase } from '@/lib/supabase';
import { resend, hasResendKey } from '@/lib/resend';

const FROM = 'DRC Academy <notificaciones@drcacademy.com>';

/** ¿Este error de la API es "no queda saldo"? */
export function isCreditExhaustedError(message: string | null | undefined): boolean {
  return /credit balance is too low|billing_error|insufficient[_ ]credit/i.test(message ?? '');
}

/** Fecha de hoy en España, AAAA-MM-DD: el "día" del tope de un aviso diario. */
function madridDay(now = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
}

/**
 * Deja el aviso en la campanita y manda el email, una vez al día.
 * Best-effort: nunca lanza. Devuelve qué hizo, para la ruta de prueba.
 */
export async function notifyAiCreditExhausted(opts: {
  label: string;
  error: string;
  /** Solo la ruta de prueba: usa un id distinto para no gastar el aviso real del día. */
  test?: boolean;
}): Promise<{ notified: boolean; emailed: boolean; reason?: string }> {
  try {
    const day = madridDay();
    const id = opts.test ? `notif_ai_credit_test_${Date.now()}` : `notif_ai_credit_${day}`;
    const title = opts.test
      ? '🧪 PRUEBA · Aviso de IA sin crédito'
      : '🚨 La IA se ha quedado sin crédito';
    const body =
      `Anthropic ha rechazado una petición por falta de saldo (función: ${opts.label}). ` +
      'Mientras no se recargue, fallan la evaluación de la redacción de la prueba de nivel, ' +
      'el análisis de transcripts y la generación de clases. Recarga en console.anthropic.com → Billing.' +
      `\n\nError: ${opts.error.slice(0, 300)}`;

    const { error: insErr } = await supabase.from('notifications').insert({
      id,
      target_user: null,
      target_role: 'admin',
      title,
      body,
      type: 'ai_credit_exhausted',
      read_by: [],
      created_at: new Date().toISOString(),
      created_by: 'ia',
    });
    // 23505 = ya existe la del día: otra llamada llegó antes y ya avisó.
    if (insErr?.code === '23505') return { notified: false, emailed: false, reason: 'ya avisado hoy' };
    if (insErr) console.error('[ai-credit] No se pudo crear la notificación:', insErr);

    const to = process.env.AI_ALERT_EMAIL?.trim();
    if (!to) {
      console.warn('[ai-credit] Sin AI_ALERT_EMAIL en Vercel: el aviso queda solo en la campanita.');
      return { notified: !insErr, emailed: false, reason: 'falta AI_ALERT_EMAIL' };
    }
    if (!hasResendKey()) return { notified: !insErr, emailed: false, reason: 'falta RESEND_API_KEY' };

    const html = `
      <div style="font-family:Arial,sans-serif;font-size:15px;color:#1a1a1a;line-height:1.5">
        <h2 style="color:#C81E1E;margin:0 0 12px">${title}</h2>
        <p>Anthropic ha rechazado una petición de la plataforma por <b>falta de saldo</b>
        (función: <code>${escapeHtml(opts.label)}</code>).</p>
        <p>Mientras no se recargue dejan de funcionar:</p>
        <ul>
          <li>la evaluación de la redacción de la prueba de nivel (el alumno recibe un nivel provisional);</li>
          <li>el análisis de los transcripts de clase;</li>
          <li>la generación de la próxima clase y la ficha del formulario.</li>
        </ul>
        <p><b>Qué hacer:</b> entra en <a href="https://console.anthropic.com/settings/billing">console.anthropic.com → Billing</a>
        y recarga saldo. Lo que haya fallado se puede reprocesar después desde el admin.</p>
        <p style="color:#666;font-size:13px">Este aviso sale como mucho una vez al día.<br>
        Error exacto: ${escapeHtml(opts.error.slice(0, 300))}</p>
      </div>`;
    const { error: mailErr } = await resend.emails.send({ from: FROM, to, subject: title, html });
    if (mailErr) {
      console.error('[ai-credit] Resend devolvió error:', mailErr.message);
      return { notified: !insErr, emailed: false, reason: mailErr.message };
    }
    return { notified: !insErr, emailed: true };
  } catch (err) {
    console.error('[ai-credit] Falló el aviso de saldo:', err);
    return { notified: false, emailed: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}
