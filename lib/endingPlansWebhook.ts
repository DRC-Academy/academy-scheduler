// ── Webhook a Zapier de "Próximos a cancelar" ────────────────────────────────
//
// Manda a Zapier (que lo reenvía a Slack) un POST por cada alumno que entra en la
// ventana de aviso de 7 días. Lo dispara el cron /api/cron/check-ending-plans.
//
// ES ADITIVO Y NUNCA ROMPE EL CRON. Tres decisiones que lo garantizan:
//
//   1. Sin `ZAPIER_ENDING_PLAN_WEBHOOK_URL` no hace nada y devuelve `skipped`.
//      No es un error: el webhook es opcional.
//   2. Ninguna función de acá lanza. Todo lo que puede fallar (red, timeout,
//      Zapier caído, respuesta 500) se captura y se cuenta.
//   3. El cron lo llama DESPUÉS del email y del marcado. El aviso interno por
//      email es el canal crítico; Zapier es una comodidad. Si se invirtiera el
//      orden, un Zapier lento retrasaría el email de ventas.
//
// ANTI-DUPLICADO: no tiene marca propia. Recibe exactamente la lista
// `pendientes` del cron, que ya pasó por `noticeSentForCycle` — o sea, un envío
// por alumno y por ciclo de plan, el mismo criterio que el email. Corolario: si
// Zapier falla para un alumno, ese alumno NO se reintenta mañana (el ciclo ya
// quedó marcado). Se acepta a propósito: el equipo ya recibió el email, y añadir
// una segunda columna de marcado para una notificación secundaria complicaría el
// anti-duplicado del canal que sí importa.

import type { EndingPlan } from '@/lib/endingPlans';

const TIMEOUT_MS = 10_000;

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') || 'https://academy-scheduler-aqpt.vercel.app';

/**
 * Lo que recibe Zapier. Nombres en snake_case porque es el formato que espera el
 * Zap y porque Zapier los mapea a campos de Slack por nombre exacto: renombrar
 * una clave acá rompe el Zap del otro lado sin ningún error visible.
 */
export interface EndingPlanWebhookPayload {
  student_name: string;
  /** '' si el alumno no tiene teléfono cargado. */
  phone: string;
  email: string;
  /** Días hasta el fin del plan. 0 = termina hoy. */
  days_remaining: number;
  /** 'YYYY-MM-DD' — último día de acceso incluido. */
  end_date: string;
  /**
   * 'oritalk' está en el contrato porque el Zap lo contempla, pero HOY no puede
   * ocurrir: lib/endingPlans excluye a los alumnos de Oritalk a propósito
   * (decisión del 07/08/2026, "solo los activados manualmente"). Si algún día
   * entran, este campo ya lo soporta y el Zap no hay que tocarlo.
   */
  plan_type: 'intensivo' | 'manual' | 'oritalk' | 'empresa';
  /** Plan legible tal cual lo ve ventas: "Empresas Ingles General · 6 meses". */
  origin: string;
  progress_score: number | null;
  risk_signal: 'verde' | 'amarillo' | 'rojo' | 'sin_datos';
  /** Ficha del alumno en el panel. Mismo enlace que usa la pestaña. */
  student_ficha_url: string;
}

/**
 * Enlace a la ficha. Es el MISMO que arma `fichaHref` en /proximos-cancelar
 * (`/students?q=…`): admin y setter no pueden abrir /mis-alumnos/[id], que es del
 * profesor, así que la ficha que pueden ver es la del panel de alumnos.
 */
function fichaUrl(p: EndingPlan): string {
  return `${APP_URL}/students?q=${encodeURIComponent(p.studentEmail || p.studentName)}`;
}

export function buildEndingPlanPayload(p: EndingPlan): EndingPlanWebhookPayload {
  return {
    student_name:      p.studentName,
    phone:             p.studentPhone,
    email:             p.studentEmail,
    days_remaining:    p.daysLeft,
    end_date:          p.endDate,
    plan_type:         p.planKind,
    origin:            p.planLabel,
    progress_score:    p.progressScore,
    risk_signal:       p.riskSignal ?? 'sin_datos',
    student_ficha_url: fichaUrl(p),
  };
}

export interface WebhookResult {
  /** true = no hay URL configurada; no se intentó nada. */
  skipped: boolean;
  sent: number;
  failed: number;
  /** Motivo por alumno de cada fallo, para diagnosticar desde los logs de Vercel. */
  errors: Array<{ student: string; reason: string }>;
}

/** POST único con timeout. Nunca lanza: devuelve el motivo del fallo. */
async function postOne(url: string, payload: EndingPlanWebhookPayload): Promise<string | null> {
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
    if (!res.ok) return `HTTP ${res.status}`;
    return null;
  } catch (e) {
    const err = e as { name?: string; message?: string };
    return err?.name === 'AbortError' ? `timeout tras ${TIMEOUT_MS}ms` : String(err?.message ?? e);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Manda un POST por alumno. Secuencial a propósito: son 0–5 alumnos por día y así
 * un Zapier con rate limit no recibe una ráfaga.
 */
export async function sendEndingPlansToZapier(plans: EndingPlan[]): Promise<WebhookResult> {
  const url = process.env.ZAPIER_ENDING_PLAN_WEBHOOK_URL?.trim();
  if (!url) {
    console.log('[zapier ending-plans] Sin ZAPIER_ENDING_PLAN_WEBHOOK_URL: no se envía nada (el webhook es opcional).');
    return { skipped: true, sent: 0, failed: 0, errors: [] };
  }

  const result: WebhookResult = { skipped: false, sent: 0, failed: 0, errors: [] };

  for (const p of plans) {
    const reason = await postOne(url, buildEndingPlanPayload(p));
    if (reason) {
      result.failed++;
      result.errors.push({ student: p.studentName, reason });
    } else {
      result.sent++;
    }
  }

  if (result.failed > 0) {
    console.error(
      `[zapier ending-plans] ${result.sent} enviado(s), ${result.failed} fallido(s): ` +
      result.errors.map(e => `${e.student} (${e.reason})`).join(', '),
    );
  } else {
    console.log(`[zapier ending-plans] ${result.sent} alumno(s) enviados a Zapier.`);
  }
  return result;
}

/**
 * Alumno de ejemplo para la prueba manual (?test=1) cuando no hay nadie real en
 * la ventana. Va marcado como prueba en el nombre para que quien lo vea en Slack
 * no llame a nadie.
 */
export function samplePlan(): EndingPlan {
  const hoy = new Date();
  const fin = new Date(hoy.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
  return {
    studentId: 'test', studentName: '[PRUEBA] Alumno de ejemplo',
    studentEmail: 'prueba@drcacademy.test', studentPhone: '+34600000000',
    endDate: fin, daysLeft: 7,
    planKind: 'empresa', planLabel: 'Empresas Ingles General · 6 meses',
    hours: 2, progressScore: 7, riskSignal: 'amarillo', noticeSent: false,
  };
}
