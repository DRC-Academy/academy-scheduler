// POST: manda un aviso de PRUEBA de "IA sin crédito" (campanita + email a
// AI_ALERT_EMAIL) sin necesidad de quedarse sin saldo de verdad. Lo dispara el
// botón de la pestaña "Uso de IA" del admin.
//
// Usa un id propio (notif_ai_credit_test_…), así que NO gasta el aviso real del
// día: si mañana se acaba el saldo, el aviso de verdad sale igual.
//
// Tope anti-abuso: la ruta es pública (auth del panel en el cliente, igual que
// el resto de /api/admin), así que se admite una prueba cada 5 minutos.

import { notifyAiCreditExhausted } from '@/lib/aiCreditAlert';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const PAUSA_MS = 5 * 60_000;

export async function POST(): Promise<Response> {
  const { data: ultima } = await supabase
    .from('notifications').select('created_at')
    .like('id', 'notif_ai_credit_test_%')
    .order('created_at', { ascending: false }).limit(1);
  const last = ultima?.[0]?.created_at;
  if (last && Date.now() - new Date(last).getTime() < PAUSA_MS) {
    return Response.json({ error: 'Ya se mandó una prueba hace menos de 5 minutos.' }, { status: 429 });
  }

  const res = await notifyAiCreditExhausted({
    label: 'prueba-desde-admin',
    error: 'PRUEBA: Your credit balance is too low to access the Anthropic API (simulado, el saldo real no se ha tocado).',
    test: true,
  });
  return Response.json(res);
}
