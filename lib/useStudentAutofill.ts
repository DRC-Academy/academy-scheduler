'use client';

// Hook compartido de autocompletado del alumno a partir del email, usado por los
// formularios de asignación (setter, teacher). Al escribir un email válido:
//   1) Busca en la tabla `students` (dbGetStudentByEmail) — alumno ya existente.
//   2) Consulta WooCommerce vía /api/check-subscription?...&full=1.
// Devuelve los datos detectados (nombre, nivel, plan, fecha de inicio de
// suscripción, horas, clasificación) para que el formulario los precargue.

import { useEffect, useState } from 'react';
import { dbGetStudentByEmail } from '@/lib/db';
import { classifyPlan, detectWeeklyHours, type PlanClassification, type DetectionResult } from '@/lib/productUtils';
import { catalogProduct, type CatalogProduct } from '@/lib/productCatalog';
import type { Student } from '@/types';

export interface WooAutofill {
  productFullName: string | null;
  productType: 'subscription' | 'one_time' | null;
  billingName: string | null;
  detectedLevel: string | null;          // nivel A1–C2 detectado, o null
  subscriptionStartDate: string | null;  // 'YYYY-MM-DD'
  status: string | null;
  active: boolean | null;
  hoursFromApi: number | null;
  /** Producto del último pedido (para lib/productCatalog) y el pedido mismo. */
  wooProductId: number | null;
  wooVariationId: number | null;
  orderId: number | null;
  orderPaidDate: string | null;          // 'YYYY-MM-DD' — fecha de pago del pedido
  /** Fraccionado: fin del programa y próxima cuota de la suscripción. */
  programEndDate: string | null;
  nextPaymentDate: string | null;
}

export interface StudentAutofill {
  loading: boolean;
  existing: Student | null;              // alumno ya en la tabla students
  woo: WooAutofill | null;               // datos de WooCommerce (si hay producto)
  classification: PlanClassification | null;
  detection: DetectionResult | null;     // horas semanales sugeridas
  /** Producto de la oferta nueva (lib/productCatalog) del último pedido, o null. */
  catalog: CatalogProduct | null;
  // Valores resueltos listos para precargar (existing tiene prioridad sobre woo).
  name: string | null;
  level: string | null;
  plan: string | null;
  startDate: string | null;
}

const EMPTY: StudentAutofill = {
  loading: false, existing: null, woo: null, classification: null, detection: null, catalog: null,
  name: null, level: null, plan: null, startDate: null,
};

export function useStudentAutofill(email: string, enabled = true): StudentAutofill {
  const [state, setState] = useState<StudentAutofill>(EMPTY);
  const norm = email.trim().toLowerCase();

  useEffect(() => {
    if (!enabled || !norm.includes('@')) { setState(EMPTY); return; }
    let cancelled = false;
    setState(s => ({ ...s, loading: true }));

    const timer = setTimeout(async () => {
      try {
        const [existing, res] = await Promise.all([
          dbGetStudentByEmail(norm).catch(() => null),
          fetch(`/api/check-subscription?email=${encodeURIComponent(norm)}&full=1`).then(r => r.json()).catch(() => null),
        ]);
        if (cancelled) return;

        let woo: WooAutofill | null = null;
        let detection: DetectionResult | null = null;
        if (res) {
          woo = {
            productFullName:       res.productFullName ?? res.productName ?? null,
            productType:           res.productType ?? null,
            billingName:           res.billingName ?? null,
            detectedLevel:         res.detectedLevel ?? null,
            subscriptionStartDate: res.subscriptionStartDate ?? null,
            status:                res.status ?? null,
            active:                res.active ?? null,
            hoursFromApi:          res.hoursFromApi ?? null,
            wooProductId:          res.wooProductId ?? null,
            wooVariationId:        res.wooVariationId ?? null,
            orderId:               res.orderId ?? null,
            orderPaidDate:         res.orderPaidDate ?? null,
            programEndDate:        res.programEndDate ?? null,
            nextPaymentDate:       res.nextPaymentDate ?? null,
          };
          detection = await detectWeeklyHours(res.productName ?? '', res.productVariation ?? null, res.metaData ?? null, res.hoursFromApi ?? null);
        }

        // Plan/clasificación: producto real de Woo (principal) → plan local.
        const planText = woo?.productFullName ?? existing?.plan ?? null;
        const classification = (planText || existing)
          ? classifyPlan({ studentPlan: existing?.plan ?? null, productName: woo?.productFullName ?? null })
          : null;

        // Programa de pago único: el inicio por defecto es la fecha de PAGO del
        // pedido (la misma que usa la activación automática), no la de "completado".
        const catalog = woo ? catalogProduct(woo.wooProductId, woo.wooVariationId) : null;
        const startDate = catalog?.kind === 'pago_unico'
          ? (woo?.orderPaidDate ?? woo?.subscriptionStartDate ?? null)
          : (woo?.subscriptionStartDate ?? null);

        setState({
          loading: false,
          existing,
          woo,
          classification,
          detection,
          catalog,
          // existing tiene prioridad (dato ya confirmado en la academia).
          name:      existing?.name ?? woo?.billingName ?? null,
          level:     existing?.level ?? woo?.detectedLevel ?? null,
          plan:      planText,
          startDate,
        });
      } catch {
        if (!cancelled) setState(EMPTY);
      }
    }, 450);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [norm, enabled]);

  return state;
}

/** ¿El último pedido es un programa de pago único del catálogo? */
export function isOneTimeProgram(a: StudentAutofill): boolean {
  return a.catalog?.kind === 'pago_unico';
}

/**
 * Texto bajo "Fecha de inicio" para un programa de pago único: de dónde sale la
 * fecha, solo si sigue siendo la del pedido. null = no se muestra nada (un pago
 * único no tiene "inicio de suscripción").
 */
export function orderPaidLabel(a: StudentAutofill, startDate: string): string | null {
  const w = a.woo;
  if (!isOneTimeProgram(a) || !w?.orderId || !w.orderPaidDate || startDate !== w.orderPaidDate) return null;
  return `Fecha de pago del pedido #${w.orderId}`;
}
