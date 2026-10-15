// ── Webhook a Zapier de "Posible ausencia del profesor" ──────────────────────
//
// Un POST por clase a ZAPIER_AUSENCIAS_WEBHOOK_URL. Zapier manda el WhatsApp al
// alumno (Respond) y el aviso a Slack. Lo dispara /api/cron/ausencias a través
// de lib/teacherAbsenceStore.
//
// Mismo patrón que lib/endingPlansWebhook:
//   1. Sin la variable no hace nada y devuelve 'skipped'. No es un error.
//   2. No lanza: red, timeout o un 500 de Zapier vuelven como motivo.
// El anti-duplicado NO vive acá: la fila de teacher_absence_alerts (id fijo por
// clase) se reserva ANTES de llamar, y solo se reintenta si Zapier falló.

import type { AbsenceWebhookPayload } from '@/lib/teacherAbsences';

const TIMEOUT_MS = 10_000;

export type AbsenceWebhookResult =
  | { status: 'skipped' }
  | { status: 'sent' }
  | { status: 'error'; reason: string };

export function absenceWebhookUrl(): string {
  return process.env.ZAPIER_AUSENCIAS_WEBHOOK_URL?.trim() ?? '';
}

export async function sendAbsenceToZapier(payload: AbsenceWebhookPayload): Promise<AbsenceWebhookResult> {
  const url = absenceWebhookUrl();
  if (!url) return { status: 'skipped' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) return { status: 'error', reason: `HTTP ${res.status}` };
    return { status: 'sent' };
  } catch (e) {
    const err = e as { name?: string; message?: string };
    return { status: 'error', reason: err?.name === 'AbortError' ? `timeout tras ${TIMEOUT_MS}ms` : String(err?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}
