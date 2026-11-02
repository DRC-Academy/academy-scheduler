// ── Estado del plan del alumno HOY, para la ficha de Finanzas ────────────────
//
// Antes la ficha decía "Suscripción: X · visto el DD/MM", con el estado que se
// grabó en el ÚLTIMO INGRESO. Eso es historia, no el estado de hoy, y para dos
// grupos era falso desde el principio (ver lib/finance.effectiveSubStatus): los
// pagos únicos de la oferta anterior salían "No encontrada" y el intensivo 5h,
// que es una suscripción, "Pago único sin activar".
//
// Regla PURA. Entradas: la fila del alumno (lo que tenemos en la base), la
// verificación de HOY si ya llegó (/api/check-subscription) y, como último
// recurso, el estado del último ingreso.
//
// Decisiones de Facundo (02/11/2026):
//   · pago único vigente → "Activa · pago único · hasta DD/MM/AAAA";
//   · suscripción cancelada → "Cancelada" (gris) con la explicación del cupo:
//     el cupo de cada mes sale del plan que el alumno tenía ESE mes;
//   · clase dada DESPUÉS del fin de la suscripción → aviso rojo en la fila
//     ("Clase dada sin plan vigente"): el admin decide si la paga.

import { accessOverrideOf, isActiveWooStatus, wooStatusMeta } from '@/lib/subscriptionAccess';
import { catalogProduct } from '@/lib/productCatalog';

export type PlanTone = 'ok' | 'gris' | 'rojo' | 'ambar' | 'azul';

export interface PlanState {
  /** Texto del badge. */
  label: string;
  tone: PlanTone;
  /** Texto pequeño debajo del badge. */
  detail?: string;
  /** De dónde sale: la verificación de hoy / la base / el último ingreso. */
  source: 'hoy' | 'base' | 'ingreso';
  /**
   * Suscripción terminada: último día con plan ('YYYY-MM-DD'). Las clases
   * POSTERIORES se dieron sin plan vigente.
   */
  endedAt?: string | null;
}

export interface PlanStudentRef {
  productType?: string | null;
  manualActiveUntil?: string | null;
  isOritalk?: boolean | null;
  oritalkUntil?: string | null;
  wooProductId?: number | null;
  productName?: string | null;
}

export interface PlanLiveRef {
  status: string;
  productType?: string | null;
  manualActiveUntil?: string | null;
  subscriptionEndedAt?: string | null;
}

export interface PlanStateInput {
  today: string;
  /** Mes que se está mirando, 'YYYY-MM'. */
  monthYear: string;
  student?: PlanStudentRef | null;
  live?: PlanLiveRef | null;
  lastSeen?: { status?: string; date: string } | null;
  /** Para el texto del cancelado: nombre del plan, horas semanales y cupo del mes. */
  planName?: string | null;
  planHours?: number | null;
  quotaLimit?: number | null;
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const mesDe = (ym: string) => MESES[Number(ym.slice(5, 7)) - 1] ?? ym;

export function planStateOf(i: PlanStateInput): PlanState {
  const s = i.student ?? null;
  const cat = catalogProduct(s?.wooProductId);
  const ov = accessOverrideOf(
    { manual_active_until: i.live?.manualActiveUntil ?? s?.manualActiveUntil, is_oritalk: s?.isOritalk, oritalk_until: s?.oritalkUntil },
    i.today,
  );

  if (ov?.kind === 'oritalk') return { label: `Oritalk · hasta ${dmy(ov.until)}`, tone: 'azul', source: 'base' };

  // Con producto del catálogo manda el catálogo (el tipo guardado puede estar
  // mal: el intensivo 5h se guardaba 'one_time' siendo una suscripción).
  const oneTime = cat && cat.kind !== 'sin_datos'
    ? cat.kind === 'pago_unico'
    : (s?.productType === 'one_time' || i.live?.productType === 'one_time');
  if (ov?.kind === 'manual') {
    return oneTime
      ? { label: `Activa · pago único · hasta ${dmy(ov.until)}`, tone: 'ok', source: i.live ? 'hoy' : 'base' }
      : { label: `Activa (manual) · hasta ${dmy(ov.until)}`, tone: 'ok', source: i.live ? 'hoy' : 'base' };
  }

  // Pago único SIN fecha vigente: no hace falta preguntarle a Woo, no hay
  // suscripción que mirar.
  if (oneTime && !i.live) {
    const until = (s?.manualActiveUntil ?? '').slice(0, 10);
    return until
      ? { label: `Pago único vencido el ${dmy(until)}`, tone: 'rojo', source: 'base' }
      : { label: 'Pago único sin activar', tone: 'rojo', source: 'base' };
  }

  if (i.live) {
    const st = i.live.status;
    if (st === 'cancelled' || st === 'expired') {
      const ended = i.live.subscriptionEndedAt ?? null;
      const plan = (i.planName ?? '').trim() || 'su plan';
      const partes = [
        i.planHours ? `${i.planHours}h semanales` : null,
        i.quotaLimit != null ? `cupo ${i.quotaLimit}` : null,
      ].filter(Boolean).join(', ');
      return {
        label: st === 'expired' ? 'Vencida' : 'Cancelada', tone: 'gris', source: 'hoy', endedAt: ended,
        detail: `Suscripción ${st === 'expired' ? 'vencida' : 'cancelada'}${ended ? ` el ${dmy(ended)}` : ''} · el cupo de ${mesDe(i.monthYear)} se calcula con el plan que tenía: ${plan}${partes ? ` (${partes})` : ''}`,
      };
    }
    if (st === 'one_time_no_access') return { label: 'Pago único sin acceso', tone: 'rojo', source: 'hoy' };
    if (st === 'pending-cancel') return { label: 'Activa · pendiente de cancelación', tone: 'ok', source: 'hoy' };
    if (isActiveWooStatus(st)) return { label: 'Activa', tone: 'ok', source: 'hoy' };
    if (st === 'error') {
      // Woo no contestó: mejor el último dato conocido que un "error".
      if (i.lastSeen) return fromLastSeen(i.lastSeen);
      return { label: 'No verificable', tone: 'gris', source: 'hoy' };
    }
    const m = wooStatusMeta(st);
    return { label: m.label, tone: st === 'on-hold' || st === 'pending' ? 'ambar' : st === 'scheduled' ? 'azul' : 'rojo', source: 'hoy' };
  }

  if (i.lastSeen) return fromLastSeen(i.lastSeen);
  return { label: 'Sin verificar', tone: 'gris', source: 'base' };
}

function fromLastSeen(l: { status?: string; date: string }): PlanState {
  const m = wooStatusMeta(l.status);
  const ok = isActiveWooStatus(l.status) || l.status === 'manual_active' || l.status === 'manual_override' || l.status === 'oritalk';
  const label = l.status === 'manual_active' || l.status === 'manual_override' ? 'Activa (manual)' : m.label;
  return { label: `${label} · visto el ${dmy(l.date)}`, tone: ok ? 'ok' : 'gris', source: 'ingreso' };
}

/**
 * ¿Esta clase se dio SIN plan vigente? Después del fin de la suscripción y sin
 * otra cosa que le diera acceso ese día (activación manual que la cubra).
 */
export function isClassWithoutPlan(
  date: string, state: Pick<PlanState, 'endedAt'>, manualActiveUntil?: string | null,
): boolean {
  const ended = state.endedAt;
  if (!ended || date <= ended) return false;
  const manual = (manualActiveUntil ?? '').slice(0, 10);
  return !(manual && date <= manual);
}

export const PLAN_TONE_STYLE: Record<PlanTone, { color: string; bg: string }> = {
  ok:    { color: '#167A2D', bg: 'rgba(30,158,58,0.12)' },
  gris:  { color: '#5f6360', bg: '#ECECE8' },
  rojo:  { color: '#C81E1E', bg: 'rgba(239,68,68,0.10)' },
  ambar: { color: '#92400e', bg: 'rgba(146,64,14,0.12)' },
  azul:  { color: '#2563eb', bg: 'rgba(37,99,235,0.10)' },
};
