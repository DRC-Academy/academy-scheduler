// ── Tarea diaria de RENOVACIÓN DE PROGRAMAS ──────────────────────────────────
//
// 1) Sincroniza `student_programs` desde WooCommerce (lib/programSync).
// 2) Avisa en Slack de cada programa al que le quedan 28 días o menos y del que
//    todavía no se avisó por esa fecha de fin (lib/programRenewal).
// 3) Marca como avisado SOLO lo que se envió bien (lib/renewalNotice).
//
// NO TIENE CRON PROPIO (plan Hobby, sin crons nuevos en vercel.json): la lanza
// cada día el cron followups-nivel (08:00 UTC = 09:00 de Madrid en invierno,
// 10:00 en verano). Aunque corriera dos veces, el aviso no se repite: cada
// programa se marca por su fecha de fin. /api/cron/renovaciones la expone a
// mano (con CRON_SECRET) para la primera carga y las pruebas.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { madridToday } from '@/lib/subscriptionAccess';
import { wooCreds, syncPrograms, loadAllPrograms, type SyncSummary } from '@/lib/programSync';
import {
  loadRenewalContext, runRenewalNotices, buildRenewalPayload, dueRenewals, renewalWebhook,
  type RenewalPayload, type RenewalRunResult,
} from '@/lib/renewalNotice';
import type { RenewalSkipReason, EndDateOrigin } from '@/lib/programRenewal';

export interface RenewalJobOptions {
  /** Solo sincroniza, no avisa (primera carga tras el deploy). */
  soloSync?: boolean;
  /** Sincroniza y devuelve a quién avisaría, sin enviar ni marcar. */
  dry?: boolean;
}

export type DryItem = RenewalPayload & { fecha_fin_segun: EndDateOrigin | null };

export type RenewalJobResult =
  | { ok: false; status: number; error: string; today: string; sync?: SyncSummary }
  | { ok: true; today: string; sync: SyncSummary; soloSync: true }
  | {
      ok: true; today: string; sync: SyncSummary; dry: true;
      /** ¿Saldría de verdad? (variable de Slack presente y válida). */
      webhook: string;
      avisaria: DryItem[];
      descartados: Partial<Record<RenewalSkipReason, number>>;
    }
  | ({ ok: boolean; today: string; sync: SyncSummary } & RenewalRunResult);

export async function runRenewalJob(admin: SupabaseClient, opts: RenewalJobOptions = {}): Promise<RenewalJobResult> {
  const today = madridToday();
  const creds = wooCreds();
  if (!creds) return { ok: false, status: 500, today, error: 'Faltan WOOCOMMERCE_URL / _CONSUMER_KEY / _CONSUMER_SECRET' };

  let sync: SyncSummary;
  try {
    sync = await syncPrograms(admin, creds);
  } catch (e) {
    // Sin sincronización no se avisa: con estados de pedido viejos se podría
    // avisar de un pedido que ya se reembolsó.
    return { ok: false, status: 500, today, error: `Sincronización: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (sync.errors.length) console.error('[renovaciones] Errores de sincronización:', sync.errors);
  if (opts.soloSync) return { ok: true, today, sync, soloSync: true };

  // Si un producto entero, el refresco o el guardado fallaron, un pedido
  // reembolsado podría seguir figurando como pagado: mejor no avisar hoy.
  if (sync.errors.some(e => e.startsWith('producto ') || e.startsWith('refresco de') || e.startsWith('guardado'))) {
    return { ok: false, status: 502, today, sync, error: 'No se avisa: la sincronización quedó incompleta' };
  }

  const programs = await loadAllPrograms(admin);
  const ctx = await loadRenewalContext(admin, programs);

  if (opts.dry) {
    const { due, skipped } = dueRenewals(programs, today);
    const hook = renewalWebhook();
    return {
      ok: true, today, sync, dry: true,
      webhook: hook.ok ? 'configurado (Slack)' : hook.reason,
      avisaria: due.map(r => ({ ...buildRenewalPayload(r, ctx, today), fecha_fin_segun: sync.endOrigin[Number(r.order_id)] ?? null })),
      descartados: skipped,
    };
  }

  const result = await runRenewalNotices(admin, ctx, today);
  console.log(`[renovaciones] ${result.sent.length} aviso(s) enviados, ${result.failed.length} fallido(s)${result.sinWebhook ? ` — ${result.sinWebhook}` : ''}.`);
  if (result.failed.length) console.error('[renovaciones] Fallidos:', result.failed);
  return { ok: result.failed.length === 0 && !result.sinWebhook, today, sync, ...result };
}
